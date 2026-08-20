import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/database.js';
import { PmRuntime } from '../src/runtime.js';

function syntheticRetryCooldownDatabase() {
  return new AppDatabase(':memory:', false);
}

describe('Issue #42 RUN-01 Runtime 边界合同', () => {
  const databases: AppDatabase[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const database of databases.splice(0)) database.close();
  });

  it('工具超时会 AbortSignal 传到在途调用，且不在进程内重试', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    let attempts = 0;
    let aborted = false;
    vi.useFakeTimers();

    const pending = runtime.executeTool({
      jobId: null,
      toolName: 'source.read',
      run: (_attempt, signal) => {
        attempts += 1;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
    });
    const assertion = expect(pending).rejects.toThrow('执行超时');
    await vi.advanceTimersByTimeAsync(10_001);
    await assertion;
    expect({ attempts, aborted }).toEqual({ attempts: 1, aborted: true });
  });

  it('checkpoint 与工具完成在同一事务内落库，恢复可读取最后安全阶段', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const job = runtime.begin({ jobType: 'checkpoint-test', idempotencyKey: 'checkpoint-test', leaseOwner: 'worker-a' });
    const result = await runtime.executeTool({
      jobId: job.id,
      leaseOwner: job.lease_owner!,
      toolName: 'source.read',
      run: async () => ({ sourceEventIds: ['source-1'], revision: 'rev-1' }),
      checkpoint: {
        step: 'provider_completed',
        state: (value) => ({ reusable: true, ...value }),
      },
      auditResult: (value) => value,
    });
    expect(result).toEqual({ sourceEventIds: ['source-1'], revision: 'rev-1' });
    expect(runtime.latestCheckpoint(job.id)).toMatchObject({ step: 'provider_completed' });
    expect(JSON.parse(String(runtime.latestCheckpoint(job.id)?.state_json))).toMatchObject({ reusable: true, revision: 'rev-1' });
  });

  it('租约过期后旧 worker 不能开始或提交工具结果', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const job = runtime.begin({ jobType: 'lease-test', idempotencyKey: 'run01-lease-test', leaseOwner: 'old-worker', leaseMs: 1_000 });
    database.raw.prepare('UPDATE job SET locked_until = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id);
    let calls = 0;
    await expect(runtime.executeTool({
      jobId: job.id,
      leaseOwner: 'old-worker',
      toolName: 'source.read',
      run: async () => { calls += 1; return { ok: true }; },
    })).rejects.toThrow('租约已失效');
    expect(calls).toBe(0);
  });

  it('RUN-02 接管过期 lease 与关闭旧 allowed tool_call 在同一事务内完成', () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const job = runtime.begin({ jobType: 'run02-reclaim', idempotencyKey: 'run02-reclaim', leaseOwner: 'old-worker', leaseMs: 1_000 });
    const decision = runtime.authorizeTool(job.id, 'source.read', { sourceId: 'synthetic' }, false, undefined, 'old-worker');
    expect(decision.allowed).toBe(true);
    database.raw.prepare('UPDATE job SET locked_until = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id);

    const reclaimed = runtime.claim(job.id, 'new-worker', 60_000);
    expect(reclaimed.acquired).toBe(true);
    expect(database.raw.prepare('SELECT status, error FROM runtime_tool_call WHERE id = ?').get(decision.callId)).toEqual({
      status: 'failed',
      error: 'Runtime lease was reclaimed before tool completion',
    });
    expect(database.raw.prepare('SELECT status, lease_owner FROM job WHERE id = ?').get(job.id)).toEqual({
      status: 'running',
      lease_owner: 'new-worker',
    });
  });

  it('关闭会 Abort 在途调用，迟到结果不能写入已停止 Runtime', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const job = runtime.begin({ jobType: 'shutdown-test', idempotencyKey: 'run01-shutdown-test', leaseOwner: 'shutdown-worker' });
    let aborted = false;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const pending = runtime.executeTool({
      jobId: job.id,
      leaseOwner: job.lease_owner!,
      toolName: 'source.read',
      run: (_attempt, signal) => new Promise<{ late: boolean }>((resolve, reject) => {
        startedResolve();
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
        setTimeout(() => resolve({ late: true }), 50);
      }),
    });
    await started;
    const shutdown = await runtime.shutdown(100);
    await expect(pending).rejects.toThrow('Runtime');
    expect(aborted).toBe(true);
    expect(shutdown).toMatchObject({ stopped: true, timedOut: false, generation: expect.any(String) });
    expect(database.raw.prepare('SELECT status, lease_owner FROM job WHERE id = ?').get(job.id)).toEqual({ status: 'queued', lease_owner: null });
    expect(database.raw.prepare('SELECT status, error FROM runtime_tool_call WHERE job_id = ?').get(job.id)).toEqual({
      status: 'failed',
      error: 'Runtime 在关闭时中止工具调用。',
    });
    expect(() => runtime.complete(job.id, { late: true }, job.lease_owner!)).toThrow('Runtime 正在关闭');
  });

  it('关闭只释放当前 Runtime 持有的精确 job+lease fence，不误伤同名并行 worker', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtimeA = new PmRuntime(database);
    const runtimeB = new PmRuntime(database);
    const jobA = runtimeA.begin({ jobType: 'shutdown-owner-a', idempotencyKey: 'run01-shutdown-owner-a', leaseOwner: 'same-worker-generation' });
    const jobB = runtimeB.begin({ jobType: 'shutdown-owner-b', idempotencyKey: 'run01-shutdown-owner-b', leaseOwner: 'same-worker-generation' });

    await runtimeA.shutdown(100);

    expect(database.raw.prepare('SELECT status, lease_owner FROM job WHERE id = ?').get(jobA.id)).toEqual({ status: 'queued', lease_owner: null });
    expect(database.raw.prepare('SELECT status, lease_owner FROM job WHERE id = ?').get(jobB.id)).toEqual({ status: 'running', lease_owner: 'same-worker-generation' });
  });

  it('停止后所有 Runtime mutation 入口在数据库写入前拒绝，不能产生迟到 job/audit/checkpoint', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const before = {
      jobs: (database.raw.prepare('SELECT COUNT(*) AS count FROM job').get() as { count: number }).count,
      audits: (database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_tool_call').get() as { count: number }).count,
      checkpoints: (database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_checkpoint').get() as { count: number }).count,
    };
    await runtime.shutdown(100);

    expect(() => runtime.enqueue({ jobType: 'late', idempotencyKey: 'late' })).toThrow('Runtime 正在关闭');
    expect(() => runtime.begin({ jobType: 'late-begin', idempotencyKey: 'late-begin' })).toThrow('Runtime 正在关闭');
    expect(() => runtime.claim('missing', 'late-worker')).toThrow('Runtime 正在关闭');
    expect(() => runtime.wakeRetry('missing')).toThrow('Runtime 正在关闭');
    expect(() => runtime.retry('missing')).toThrow('Runtime 正在关闭');
    expect(() => runtime.resumeAfterApproval('missing')).toThrow('Runtime 正在关闭');
    expect(() => runtime.authorizeTool(null, 'source.read', {})).toThrow('Runtime 正在关闭');
    expect(() => runtime.executeToolSync({ jobId: null, toolName: 'source.read', run: () => ({ late: true }) })).toThrow('Runtime 正在关闭');
    await expect(runtime.executeTool({ jobId: null, toolName: 'source.read', run: async () => ({ late: true }) })).rejects.toThrow('Runtime 正在关闭');

    expect({
      jobs: (database.raw.prepare('SELECT COUNT(*) AS count FROM job').get() as { count: number }).count,
      audits: (database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_tool_call').get() as { count: number }).count,
      checkpoints: (database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_checkpoint').get() as { count: number }).count,
    }).toEqual(before);
  });

  it('异步和同步工具在 stale/invalid lease 时先拒绝，绝不写入 allowed 审计行', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const asyncJob = runtime.begin({ jobType: 'stale-async', idempotencyKey: 'stale-async', leaseOwner: 'old-owner' });
    const expired = new Date(Date.now() - 1_000).toISOString();
    database.raw.prepare('UPDATE job SET locked_until = ? WHERE id = ?').run(expired, asyncJob.id);
    await expect(runtime.executeTool({
      jobId: asyncJob.id,
      leaseOwner: 'old-owner',
      toolName: 'source.read',
      run: async () => ({ ok: true }),
    })).rejects.toThrow('租约已失效');

    const syncJob = runtime.begin({ jobType: 'stale-sync', idempotencyKey: 'stale-sync', leaseOwner: 'old-owner-sync' });
    database.raw.prepare('UPDATE job SET locked_until = ? WHERE id = ?').run(expired, syncJob.id);
    expect(() => runtime.executeToolSync({
      jobId: syncJob.id,
      leaseOwner: 'old-owner-sync',
      toolName: 'source.read',
      run: () => ({ ok: true }),
    })).toThrow('租约已失效');
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_tool_call WHERE status = 'allowed'").get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_tool_call').get()).toEqual({ count: 0 });
  });

  it('checkpoint state builder 或 JSON 失败不会留下 completed audit 或 checkpoint', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const job = runtime.begin({ jobType: 'checkpoint-builder-failure', idempotencyKey: 'checkpoint-builder-failure', leaseOwner: 'worker' });
    await expect(runtime.executeTool({
      jobId: job.id,
      leaseOwner: 'worker',
      toolName: 'source.read',
      run: async () => ({ ok: true }),
      checkpoint: {
        step: 'provider_completed',
        state: () => { throw new Error('state builder failure'); },
      },
    })).rejects.toThrow('state builder failure');
    expect(database.raw.prepare('SELECT status FROM runtime_tool_call WHERE job_id = ?').get(job.id)).toEqual({ status: 'failed' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_checkpoint WHERE job_id = ?').get(job.id)).toEqual({ count: 0 });
  });

  it('M1 永久 draft-only：approved=true 的 external.send 仍拒绝且不调用 provider', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    let calls = 0;
    await expect(runtime.executeTool({
      jobId: null,
      toolName: 'external.send',
      approved: true,
      idempotencyKey: 'outbox:approval-1',
      run: async () => { calls += 1; return { externalId: 'must-not-send' }; },
    })).rejects.toThrow('Runtime 工具不可用：forbidden');
    expect(calls).toBe(0);
    expect(database.raw.prepare("SELECT policy, status, error FROM runtime_tool_call WHERE tool_name = 'external.send'").get()).toEqual({
      policy: 'forbidden', status: 'blocked', error: 'forbidden',
    });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM job WHERE job_type = 'runtime_external_send'").get()).toEqual({ count: 0 });
    expect(() => runtime.executeToolSync({
      jobId: null,
      toolName: 'external.send',
      approved: true,
      idempotencyKey: 'outbox:approval-sync',
      run: () => ({ externalId: 'missing-key' }),
    })).toThrow('Runtime 工具不可用：forbidden');
  });

  it('旧 approved/ready 草稿只作历史展示，不能重新变为可执行 external.send', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const timestamp = new Date().toISOString();
    database.raw.prepare(
      "INSERT INTO approval (id, task_id, action_type, payload_json, status, created_at, decided_at) VALUES (?, NULL, ?, ?, 'approved', ?, ?)",
    ).run('legacy-approved', 'send_message', '{}', timestamp, timestamp);
    database.raw.prepare(
      "INSERT INTO outbox (id, approval_id, action_type, payload_json, status, idempotency_key, created_at, sent_at) VALUES (?, ?, ?, ?, 'ready', ?, ?, NULL)",
    ).run('legacy-ready', 'legacy-approved', 'send_message', '{}', 'legacy-outbox-key', timestamp);
    const runtime = new PmRuntime(database);
    let providerCalls = 0;
    await expect(runtime.executeTool({
      jobId: null,
      toolName: 'external.send',
      approved: true,
      idempotencyKey: 'legacy-outbox-key',
      run: async () => {
        providerCalls += 1;
        return { externalId: 'must-not-resend' };
      },
    })).rejects.toThrow('Runtime 工具不可用：forbidden');
    expect(providerCalls).toBe(0);
    expect(database.raw.prepare('SELECT status FROM approval WHERE id = ?').get('legacy-approved')).toEqual({ status: 'approved' });
    expect(database.raw.prepare('SELECT status FROM outbox WHERE id = ?').get('legacy-ready')).toEqual({ status: 'ready' });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM job WHERE job_type = 'runtime_external_send'").get()).toEqual({ count: 0 });
  });

  it('异步完成竞态：precheck 后取消或替换租约时不写 completed、checkpoint 或业务结果', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const job = runtime.begin({ jobType: 'race-async', idempotencyKey: 'race-async', leaseOwner: 'old-owner' });
    const oldOwner = job.lease_owner!;
    await expect(runtime.executeTool({
      jobId: job.id,
      leaseOwner: oldOwner,
      toolName: 'source.read',
      autoRenewLease: false,
      run: async () => {
        database.raw.prepare(
          "UPDATE job SET status = 'cancelled', cancel_requested_at = ?, locked_until = NULL, lease_owner = NULL WHERE id = ?",
        ).run(new Date().toISOString(), job.id);
        return { ok: true };
      },
      checkpoint: { step: 'provider_completed', state: () => ({ reusable: true }) },
    })).rejects.toThrow('租约已失效');
    expect(database.raw.prepare('SELECT status FROM runtime_tool_call WHERE job_id = ?').get(job.id)).toEqual({ status: 'allowed' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_checkpoint WHERE job_id = ?').get(job.id)).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT result_json, last_error FROM job WHERE id = ?').get(job.id)).toEqual({ result_json: null, last_error: null });

    const replacement = runtime.begin({ jobType: 'race-async-replaced', idempotencyKey: 'race-async-replaced', leaseOwner: 'old-owner-2' });
    await expect(runtime.executeTool({
      jobId: replacement.id,
      leaseOwner: 'old-owner-2',
      toolName: 'source.read',
      autoRenewLease: false,
      run: async () => {
        database.raw.prepare(
          "UPDATE job SET lease_owner = ?, locked_until = ? WHERE id = ? AND status = 'running'",
        ).run('new-owner-2', new Date(Date.now() + 60_000).toISOString(), replacement.id);
        return { ok: true };
      },
    })).rejects.toThrow('租约已失效');
    expect(database.raw.prepare('SELECT status FROM runtime_tool_call WHERE job_id = ?').get(replacement.id)).toEqual({ status: 'allowed' });

    const failed = runtime.begin({ jobType: 'race-async-failed', idempotencyKey: 'race-async-failed', leaseOwner: 'old-owner-3' });
    let providerAttempts = 0;
    await expect(runtime.executeTool({
      jobId: failed.id,
      leaseOwner: 'old-owner-3',
      toolName: 'source.read',
      autoRenewLease: false,
      run: async () => {
        providerAttempts += 1;
        database.raw.prepare(
          "UPDATE job SET status = 'cancelled', cancel_requested_at = ?, locked_until = NULL, lease_owner = NULL WHERE id = ?",
        ).run(new Date().toISOString(), failed.id);
        throw new Error('synthetic provider failure');
      },
    })).rejects.toThrow('租约已失效');
    expect(providerAttempts).toBe(1);
    expect(database.raw.prepare('SELECT status, error FROM runtime_tool_call WHERE job_id = ?').get(failed.id)).toEqual({ status: 'allowed', error: null });
  });

  it('同步完成竞态：precheck 后租约过期或 provider 失败时不写 completed/failed', () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const expired = runtime.begin({ jobType: 'race-sync-expired', idempotencyKey: 'race-sync-expired', leaseOwner: 'sync-old' });
    expect(() => runtime.executeToolSync({
      jobId: expired.id,
      leaseOwner: 'sync-old',
      toolName: 'source.read',
      run: () => {
        database.raw.prepare(
          "UPDATE job SET locked_until = ? WHERE id = ?",
        ).run(new Date(Date.now() - 1_000).toISOString(), expired.id);
        return { ok: true };
      },
    })).toThrow('租约已失效');
    expect(database.raw.prepare('SELECT status FROM runtime_tool_call WHERE job_id = ?').get(expired.id)).toEqual({ status: 'allowed' });

    const failed = runtime.begin({ jobType: 'race-sync-failed', idempotencyKey: 'race-sync-failed', leaseOwner: 'sync-failed' });
    expect(() => runtime.executeToolSync({
      jobId: failed.id,
      leaseOwner: 'sync-failed',
      toolName: 'source.read',
      run: () => {
        database.raw.prepare(
          "UPDATE job SET status = 'cancelled', cancel_requested_at = ?, locked_until = NULL, lease_owner = NULL WHERE id = ?",
        ).run(new Date().toISOString(), failed.id);
        throw new Error('synthetic provider failure');
      },
    })).toThrow('租约已失效');
    expect(database.raw.prepare('SELECT status, error FROM runtime_tool_call WHERE job_id = ?').get(failed.id)).toEqual({ status: 'allowed', error: null });
  });

  it('同步完成前的取消触发器不能制造 cancelled+completed 矛盾状态', () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const job = runtime.begin({ jobType: 'race-trigger', idempotencyKey: 'race-trigger', leaseOwner: 'trigger-owner' });
    database.raw.exec(`
      CREATE TRIGGER run01_cancel_before_finalize
      AFTER UPDATE OF updated_at ON job
      WHEN NEW.id = '${job.id}'
      BEGIN
        UPDATE job SET status = 'cancelled', cancel_requested_at = '2026-08-16T00:00:00.000Z', locked_until = NULL, lease_owner = NULL WHERE id = NEW.id;
      END;
    `);
    expect(() => runtime.executeToolSync({
      jobId: job.id,
      leaseOwner: 'trigger-owner',
      toolName: 'source.read',
      run: () => {
        database.raw.prepare('UPDATE job SET updated_at = updated_at WHERE id = ?').run(job.id);
        return { ok: true };
      },
    })).toThrow('租约已失效');
    expect(database.raw.prepare('SELECT status, lease_owner FROM job WHERE id = ?').get(job.id)).toEqual({ status: 'cancelled', lease_owner: null });
    expect(database.raw.prepare('SELECT status, result_json, error FROM runtime_tool_call WHERE job_id = ?').get(job.id)).toEqual({ status: 'allowed', result_json: null, error: null });
  });

  it('重试边界每次重新校验 exact lease，第一次失败后取消不会再次调用 provider', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const job = runtime.begin({ jobType: 'race-retry-boundary', idempotencyKey: 'race-retry-boundary', leaseOwner: 'retry-owner' });
    const originalHasCurrentLease = (runtime as unknown as {
      hasCurrentLease: (jobId: string, leaseOwner: string) => boolean;
    }).hasCurrentLease.bind(runtime);
    let leaseChecks = 0;
    (runtime as unknown as {
      hasCurrentLease: (jobId: string, leaseOwner: string) => boolean;
    }).hasCurrentLease = (jobId, leaseOwner) => {
      const result = originalHasCurrentLease(jobId, leaseOwner);
      leaseChecks += 1;
      // Initial precheck, first-attempt boundary, and first failure check all
      // observe the old lease. The next-attempt boundary must observe this
      // deterministic cancellation before invoking the provider again.
      if (leaseChecks === 3) {
        database.raw.prepare(
          "UPDATE job SET status = 'cancelled', cancel_requested_at = ?, locked_until = NULL, lease_owner = NULL WHERE id = ?",
        ).run(new Date().toISOString(), job.id);
      }
      return result;
    };
    let providerAttempts = 0;
    await expect(runtime.executeTool({
      jobId: job.id,
      leaseOwner: 'retry-owner',
      toolName: 'source.read',
      autoRenewLease: false,
      run: async () => {
        providerAttempts += 1;
        throw new Error('synthetic first-attempt failure');
      },
    })).rejects.toThrow('租约已失效');
    expect(providerAttempts).toBe(1);
    expect(database.raw.prepare('SELECT status, result_json, error FROM runtime_tool_call WHERE job_id = ?').get(job.id)).toEqual({ status: 'allowed', result_json: null, error: null });
  });

  it('同一 Runtime 的多个工具 job 在无 Retry-After 失败后共享受控 cooldown', async () => {
    const database = syntheticRetryCooldownDatabase();
    databases.push(database);
    let now = 1_000;
    const runtime = new PmRuntime(database, {
      now: () => now,
      retryPolicy: { baseMs: 100, jitterRatio: 0, random: () => 0.5 },
    });
    const first = runtime.begin({ jobType: 'shared-cooldown-first', idempotencyKey: 'shared-cooldown-first', leaseOwner: 'worker-a' });
    runtime.fail(first.id, new Error('synthetic transport failure'), {
      leaseOwner: first.lease_owner!,
      retry: {
        category: 'transport',
        providerKey: 'source.read',
        cooldownKey: 'source.read',
        retryable: true,
        retryAt: null,
        retryAfterMs: null,
        status: null,
        code: 'ECONNRESET',
      },
    });
    const second = runtime.begin({ jobType: 'shared-cooldown-second', idempotencyKey: 'shared-cooldown-second', leaseOwner: 'worker-b' });
    let calls = 0;
    await expect(runtime.executeTool({
      jobId: second.id,
      leaseOwner: second.lease_owner!,
      toolName: 'source.read',
      autoRenewLease: false,
      run: async () => { calls += 1; return { ok: true }; },
    })).rejects.toThrow('冷却');
    expect(calls).toBe(0);
    const deferred = runtime.get(second.id)!;
    expect(deferred).toMatchObject({ status: 'queued', lease_owner: null });
    expect(Date.parse(deferred.available_at) - now).toBe(100);
    now += 100;
    const reclaimed = runtime.begin({ jobType: 'shared-cooldown-second', idempotencyKey: 'shared-cooldown-second', leaseOwner: 'worker-b' });
    await expect(runtime.executeTool({
      jobId: second.id,
      leaseOwner: reclaimed.lease_owner!,
      toolName: 'source.read',
      autoRenewLease: false,
      run: async () => { calls += 1; return { ok: true }; },
    })).resolves.toEqual({ ok: true });
    expect(calls).toBe(1);
    const coordinator = (runtime as unknown as { retryCoordinator: { cooldownMs: (key: string) => number } }).retryCoordinator;
    expect(coordinator.cooldownMs('source.read')).toBe(0);
  });

  it.each([
    { label: '429', category: 'rate_limit' as const, status: 429, code: 'rate_limit' },
    { label: '503', category: 'server_error' as const, status: 503, code: 'server_error' },
    { label: 'transport', category: 'transport' as const, status: null, code: 'ECONNRESET' },
  ])('两个 Runtime 实例在 $label 无 Retry-After 后共享 durable cooldown，重建实例前不得调用 provider', async ({ category, status, code }) => {
    const database = syntheticRetryCooldownDatabase();
    databases.push(database);
    let now = 1_000;
    const options = {
      now: () => now,
      retryPolicy: { baseMs: 100, jitterRatio: 0, random: () => 0.5 },
    } as const;
    const firstRuntime = new PmRuntime(database, options);
    const secondRuntime = new PmRuntime(database, options);
    const first = firstRuntime.begin({ jobType: `durable-${category}-first`, idempotencyKey: `durable-${category}-first`, leaseOwner: 'worker-a' });
    firstRuntime.fail(first.id, new Error(`synthetic ${category}`), {
      leaseOwner: first.lease_owner!,
      retry: {
        category,
        providerKey: 'provider.synthetic',
        cooldownKey: 'provider.synthetic',
        retryable: true,
        retryAt: null,
        retryAfterMs: null,
        status,
        code,
      },
    });
    expect(database.raw.prepare('SELECT provider_key, retry_at_ms FROM provider_retry_cooldown').get()).toMatchObject({
      provider_key: 'provider.synthetic',
      retry_at_ms: 1_100,
    });
    const second = secondRuntime.begin({ jobType: `durable-${category}-second`, idempotencyKey: `durable-${category}-second`, leaseOwner: 'worker-b' });
    let calls = 0;
    await expect(secondRuntime.executeTool({
      jobId: second.id,
      leaseOwner: second.lease_owner!,
      toolName: 'source.read',
      cooldownKey: 'provider.synthetic',
      autoRenewLease: false,
      run: async () => { calls += 1; return { ok: true }; },
    })).rejects.toThrow('冷却');
    expect(calls).toBe(0);
    expect(secondRuntime.get(second.id)).toMatchObject({ status: 'queued', lease_owner: null });

    now = 1_100;
    const restartedRuntime = new PmRuntime(database, options);
    const reclaimed = restartedRuntime.begin({ jobType: `durable-${category}-second`, idempotencyKey: `durable-${category}-second`, leaseOwner: 'worker-c' });
    await expect(restartedRuntime.executeTool({
      jobId: second.id,
      leaseOwner: reclaimed.lease_owner!,
      toolName: 'source.read',
      cooldownKey: 'provider.synthetic',
      autoRenewLease: false,
      run: async () => { calls += 1; return { ok: true }; },
    })).resolves.toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  it.each([
    { label: '429', category: 'rate_limit' as const, status: 429, code: 'rate_limit' },
    { label: '503', category: 'server_error' as const, status: 503, code: 'server_error' },
    { label: 'transport', category: 'transport' as const, status: null, code: 'ECONNRESET' },
  ])('Runtime fail 的 $label typed metadata 会阻止第二 job 在 cooldown 内调用工具', async ({ category, status, code }) => {
    const database = syntheticRetryCooldownDatabase();
    databases.push(database);
    let now = 1_000;
    const sleeps: number[] = [];
    const resolvers: Array<() => void> = [];
    const runtime = new PmRuntime(database, {
      now: () => now,
      retryPolicy: { baseMs: 100, jitterRatio: 0, random: () => 0.5 },
      retrySleep: async (delayMs) => {
        sleeps.push(delayMs);
        await new Promise<void>((resolve) => resolvers.push(resolve));
      },
    });
    const first = runtime.begin({ jobType: `typed-retry-${category}-first`, idempotencyKey: `typed-retry-${category}-first`, leaseOwner: 'worker-a' });
    const retry = {
      category,
      providerKey: 'source.read',
      cooldownKey: 'source.read',
      retryable: true,
      retryAt: null,
      retryAfterMs: null,
      status,
      code,
    } as const;
    runtime.fail(first.id, new Error(`synthetic ${category}`), { leaseOwner: first.lease_owner!, retry });
    expect((runtime as unknown as { retryCoordinator: { cooldownMs: (key: string) => number } }).retryCoordinator.cooldownMs('source.read')).toBe(100);
    expect(Date.parse((database.raw.prepare('SELECT available_at FROM job WHERE id = ?').get(first.id) as { available_at: string }).available_at) - now).toBe(100);

    const second = runtime.begin({ jobType: `typed-retry-${category}-second`, idempotencyKey: `typed-retry-${category}-second`, leaseOwner: 'worker-b' });
    let calls = 0;
    const pending = runtime.executeTool({
      jobId: second.id,
      leaseOwner: second.lease_owner!,
      toolName: 'source.read',
      autoRenewLease: false,
      run: async () => { calls += 1; return { ok: true }; },
    });
    await expect(pending).rejects.toThrow('冷却');
    expect({ calls, sleeps }).toEqual({ calls: 0, sleeps: [] });
    expect(runtime.get(second.id)).toMatchObject({ status: 'queued', lease_owner: null });
    now += 100;
    const reclaimed = runtime.begin({ jobType: `typed-retry-${category}-second`, idempotencyKey: `typed-retry-${category}-second`, leaseOwner: 'worker-b' });
    await expect(runtime.executeTool({
      jobId: second.id,
      leaseOwner: reclaimed.lease_owner!,
      toolName: 'source.read',
      autoRenewLease: false,
      run: async () => { calls += 1; return { ok: true }; },
    })).resolves.toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  it.each([
    {
      label: 'invalid Retry-After',
      retry: {
        category: 'rate_limit' as const,
        providerKey: 'provider.invalid-retry-after',
        cooldownKey: 'provider.invalid-retry-after',
        retryable: false,
        retryAt: null,
        retryAfterMs: null,
        status: 429,
        code: 'invalid_retry_after',
      },
    },
    {
      label: 'permission denial',
      retry: {
        category: 'non_retryable' as const,
        providerKey: 'provider.permission',
        cooldownKey: 'provider.permission',
        retryable: false,
        retryAt: null,
        retryAfterMs: null,
        status: 403,
        code: 'http_error',
      },
    },
  ])('Runtime fail 的 $label typed signal 终止 job 且不建立 cooldown', ({ retry }) => {
    const database = syntheticRetryCooldownDatabase();
    databases.push(database);
    let now = 1_000;
    const runtime = new PmRuntime(database, {
      now: () => now,
      retryPolicy: { baseMs: 100, jitterRatio: 0, random: () => 0.5 },
    });
    const job = runtime.begin({ jobType: 'non-retryable-provider-failure', idempotencyKey: `non-retryable-${retry.status}`, leaseOwner: 'worker-a' });
    const failed = runtime.fail(job.id, new Error('synthetic provider failure'), { leaseOwner: job.lease_owner!, retry });
    expect(failed).toMatchObject({ status: 'failed', retryable: 0, lease_owner: null });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM provider_retry_cooldown').get()).toEqual({ count: 0 });
    expect(Date.parse(failed!.available_at)).toBeGreaterThanOrEqual(now);
  });

  it('损坏的 retry metadata fail-closed，不按默认退避重新排队或建立 cooldown', () => {
    const database = syntheticRetryCooldownDatabase();
    databases.push(database);
    const runtime = new PmRuntime(database, { retryPolicy: { baseMs: 100, jitterRatio: 0, random: () => 0.5 } });
    const job = runtime.begin({ jobType: 'malformed-retry-metadata', idempotencyKey: 'malformed-retry-metadata', leaseOwner: 'worker-a' });
    const failed = runtime.fail(job.id, new Error('synthetic malformed signal'), {
      leaseOwner: job.lease_owner!,
      retry: {
        category: 'rate_limit',
        providerKey: 'provider-a',
        cooldownKey: 'provider-b',
        retryable: true,
        retryAt: null,
        retryAfterMs: null,
        status: 429,
        code: 'rate_limit',
      },
    });
    expect(failed).toMatchObject({ status: 'failed', retryable: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM provider_retry_cooldown').get()).toEqual({ count: 0 });
  });

  it('同步成功在租约被替换或过期后不会写 completed/result，失败也不会写 failed', () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const replaced = runtime.begin({ jobType: 'race-sync-replaced', idempotencyKey: 'race-sync-replaced', leaseOwner: 'sync-old-owner' });
    expect(() => runtime.executeToolSync({
      jobId: replaced.id,
      leaseOwner: 'sync-old-owner',
      toolName: 'source.read',
      run: () => {
        database.raw.prepare('UPDATE job SET lease_owner = ?, locked_until = ? WHERE id = ?').run('sync-new-owner', new Date(Date.now() + 60_000).toISOString(), replaced.id);
        return { replaced: true };
      },
    })).toThrow('租约已失效');
    expect(database.raw.prepare('SELECT status, result_json, error FROM runtime_tool_call WHERE job_id = ?').get(replaced.id)).toEqual({ status: 'allowed', result_json: null, error: null });

    const expiredFailure = runtime.begin({ jobType: 'race-sync-expired-failure', idempotencyKey: 'race-sync-expired-failure', leaseOwner: 'sync-expiring-owner' });
    expect(() => runtime.executeToolSync({
      jobId: expiredFailure.id,
      leaseOwner: 'sync-expiring-owner',
      toolName: 'source.read',
      run: () => {
        database.raw.prepare('UPDATE job SET locked_until = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), expiredFailure.id);
        throw new Error('synthetic provider failure after expiry');
      },
    })).toThrow('租约已失效');
    expect(database.raw.prepare('SELECT status, result_json, error FROM runtime_tool_call WHERE job_id = ?').get(expiredFailure.id)).toEqual({ status: 'allowed', result_json: null, error: null });
  });

  it('异步 provider 失败在租约被替换或过期后不重试，也不写 failed 审计', async () => {
    const database = syntheticRetryCooldownDatabase();
    databases.push(database);
    const runtime = new PmRuntime(database);
    const replaced = runtime.begin({ jobType: 'race-async-replaced-failure', idempotencyKey: 'race-async-replaced-failure', leaseOwner: 'async-old-owner' });
    let replacedAttempts = 0;
    await expect(runtime.executeTool({
      jobId: replaced.id,
      leaseOwner: 'async-old-owner',
      toolName: 'source.read',
      autoRenewLease: false,
      run: async () => {
        replacedAttempts += 1;
        database.raw.prepare('UPDATE job SET lease_owner = ?, locked_until = ? WHERE id = ?').run('async-new-owner', new Date(Date.now() + 60_000).toISOString(), replaced.id);
        throw Object.assign(new Error('synthetic provider failure after replacement'), {
          retryMetadata: {
            category: 'rate_limit', providerKey: 'source.read', cooldownKey: 'source.read', retryable: true,
            retryAt: null, retryAfterMs: null, status: 429, code: 'rate_limit',
          },
        });
      },
    })).rejects.toThrow('租约已失效');
    expect(replacedAttempts).toBe(1);
    expect(database.raw.prepare('SELECT status, result_json, error FROM runtime_tool_call WHERE job_id = ?').get(replaced.id)).toEqual({ status: 'allowed', result_json: null, error: null });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM provider_retry_cooldown WHERE provider_key = ?').get('source.read')).toEqual({ count: 0 });

    const expired = runtime.begin({ jobType: 'race-async-expired-failure', idempotencyKey: 'race-async-expired-failure', leaseOwner: 'async-expiring-owner' });
    let expiredAttempts = 0;
    await expect(runtime.executeTool({
      jobId: expired.id,
      leaseOwner: 'async-expiring-owner',
      toolName: 'source.read',
      autoRenewLease: false,
      run: async () => {
        expiredAttempts += 1;
        database.raw.prepare('UPDATE job SET locked_until = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), expired.id);
        throw new Error('synthetic provider failure after expiry');
      },
    })).rejects.toThrow('租约已失效');
    expect(expiredAttempts).toBe(1);
    expect(database.raw.prepare('SELECT status, result_json, error FROM runtime_tool_call WHERE job_id = ?').get(expired.id)).toEqual({ status: 'allowed', result_json: null, error: null });
  });

  it('绑定 job 的 external.send 在批准后仍在回调前被禁止', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    let providerCalls = 0;
    await expect(runtime.executeTool({
      jobId: null,
      toolName: 'external.send',
      approved: true,
      idempotencyKey: 'external-race-key',
      run: async () => {
        providerCalls += 1;
        return { externalId: 'must-not-send' };
      },
    })).rejects.toThrow('Runtime 工具不可用：forbidden');
    expect(providerCalls).toBe(0);
    expect(database.raw.prepare("SELECT status FROM runtime_tool_call WHERE tool_name = 'external.send'").get()).toEqual({ status: 'blocked' });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_tool_call WHERE status = 'allowed'").get()).toEqual({ count: 0 });
  });

  it('job 关联工具必须携带 exact lease，且不能把缺失内存 fence 的旧审计写成终态', () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const runtime = new PmRuntime(database);
    const job = runtime.begin({ jobType: 'lease-required', idempotencyKey: 'lease-required', leaseOwner: 'lease-owner' });

    expect(() => runtime.authorizeTool(job.id, 'source.read', { sourceId: 'missing-lease' })).toThrow('租约已失效');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_tool_call WHERE job_id = ?').get(job.id)).toEqual({ count: 0 });

    const completed = runtime.authorizeTool(job.id, 'source.read', { sourceId: 'exact-lease' }, false, undefined, job.lease_owner!);
    runtime.completeToolCall(completed.callId, { ok: true });
    expect(database.raw.prepare('SELECT status FROM runtime_tool_call WHERE id = ?').get(completed.callId)).toEqual({ status: 'completed' });

    const legacyComplete = runtime.authorizeTool(job.id, 'source.read', { sourceId: 'legacy-complete' }, false, undefined, job.lease_owner!);
    const legacyFail = runtime.authorizeTool(job.id, 'source.read', { sourceId: 'legacy-fail' }, false, undefined, job.lease_owner!);
    (runtime as unknown as { activeToolCalls: Map<string, unknown> }).activeToolCalls.clear();
    expect(() => runtime.completeToolCall(legacyComplete.callId, { stale: true })).toThrow('租约已失效');
    expect(() => runtime.failToolCall(legacyFail.callId, new Error('stale'))).toThrow('租约已失效');
    expect(database.raw.prepare('SELECT status FROM runtime_tool_call WHERE id = ?').get(legacyComplete.callId)).toEqual({ status: 'allowed' });
    expect(database.raw.prepare('SELECT status FROM runtime_tool_call WHERE id = ?').get(legacyFail.callId)).toEqual({ status: 'allowed' });

    const cancelled = runtime.begin({ jobType: 'lease-required-cancelled', idempotencyKey: 'lease-required-cancelled', leaseOwner: 'cancel-owner' });
    const cancelledComplete = runtime.authorizeTool(cancelled.id, 'source.read', { sourceId: 'cancelled-complete' }, false, undefined, cancelled.lease_owner!);
    const cancelledFail = runtime.authorizeTool(cancelled.id, 'source.read', { sourceId: 'cancelled-fail' }, false, undefined, cancelled.lease_owner!);
    database.raw.prepare(
      "UPDATE job SET status = 'cancelled', cancel_requested_at = ?, locked_until = NULL, lease_owner = NULL WHERE id = ?",
    ).run(new Date().toISOString(), cancelled.id);
    (runtime as unknown as { activeToolCalls: Map<string, unknown> }).activeToolCalls.clear();
    expect(() => runtime.completeToolCall(cancelledComplete.callId, { stale: true })).toThrow('租约已失效');
    expect(() => runtime.failToolCall(cancelledFail.callId, new Error('stale'))).toThrow('租约已失效');
    expect(database.raw.prepare('SELECT status, result_json, error FROM runtime_tool_call WHERE id IN (?, ?) ORDER BY id').all(cancelledComplete.callId, cancelledFail.callId)).toEqual([
      { status: 'allowed', result_json: null, error: null },
      { status: 'allowed', result_json: null, error: null },
    ]);

    const emptyJobCallId = 'legacy-empty-job-call';
    database.raw.prepare(
      `INSERT INTO job (id, job_type, payload_json, status, available_at, created_at, updated_at)
       VALUES ('', 'legacy-empty-job', '{}', 'running', ?, ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    database.raw.prepare(
      `INSERT INTO runtime_tool_call
        (id, job_id, tool_name, policy, status, input_hash, result_json, error, started_at, finished_at)
       VALUES (?, ?, 'source.read', 'readonly', 'allowed', 'hash', NULL, NULL, ?, NULL)`,
    ).run(emptyJobCallId, '', new Date().toISOString());
    expect(() => runtime.completeToolCall(emptyJobCallId, { stale: true })).toThrow('租约已失效');
    expect(() => runtime.failToolCall(emptyJobCallId, new Error('stale'))).toThrow('租约已失效');
    expect(database.raw.prepare('SELECT status, result_json, error FROM runtime_tool_call WHERE id = ?').get(emptyJobCallId)).toEqual({
      status: 'allowed', result_json: null, error: null,
    });

    const auditCountBeforeEmptyJob = (database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_tool_call').get() as { count: number }).count;
    expect(() => runtime.authorizeTool('', 'source.read', { sourceId: 'empty-job-id' })).toThrow('租约已失效');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_tool_call').get()).toEqual({ count: auditCountBeforeEmptyJob });
  });
});
