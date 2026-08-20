import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from './database.js';
import { redactDiagnosticText } from './redaction.js';
import { classifyRetryFailure, computeRetryDelay, DEFAULT_RETRY_MAX_MS, normalizeRetryFailureMetadata, RetryCoordinator, SqliteRetryCooldownStore, type RetryFailureMetadata, type RetryPolicyOptions } from './retry-policy.js';

export type RuntimeJobStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export type RuntimeToolPolicy = 'readonly' | 'controlled_internal_write' | 'approval_required' | 'forbidden';

export type RuntimeJobRow = {
  id: string;
  job_type: string;
  payload_json: string;
  status: RuntimeJobStatus;
  attempts: number;
  available_at: string;
  locked_until: string | null;
  lease_owner: string | null;
  max_attempts: number;
  retryable: number;
  backoff_seconds: number;
  cancel_requested_at: string | null;
  idempotency_key: string | null;
  source_event_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  trace_id: string | null;
  last_error: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
};

export type RuntimeJobHandle = RuntimeJobRow & { acquired: boolean };

export type RuntimeClock = {
  now(): number;
};

export type RuntimeRetrySleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

export type RuntimeExecutionOptions = {
  /** A caller-owned cancellation signal, usually the service shutdown signal. */
  signal?: AbortSignal;
  /** The lease owner fencing this operation to one worker generation. */
  leaseOwner?: string;
  /** Lease duration used by the bounded heartbeat while the operation is in flight. */
  leaseMs?: number;
  /** Disable the bounded heartbeat when a caller intentionally owns renewal. */
  autoRenewLease?: boolean;
  /** Provider key used to bridge durable retries to shared cooldown. */
  cooldownKey?: string;
};

type ActiveToolCall = {
  /** Audit row's job association. External sends without a caller job use their claim job. */
  jobId: string | null;
  leaseOwner: string | null;
  /** Durable idempotency claim for external.send, when present. */
  externalClaimJobId: string | null;
};

type RuntimeLeaseFence = {
  jobId: string;
  leaseOwner: string;
};

export type RuntimeToolDefinition = {
  name: string;
  policy: RuntimeToolPolicy;
  timeoutMs: number;
  maxRetries: number;
  audit: boolean;
  description: string;
};

const systemClock: RuntimeClock = { now: () => Date.now() };
const newId = (prefix: string) => `${prefix}_${randomUUID()}`;

class RuntimeLeaseLostError extends Error {
  constructor() {
    super('Runtime 工作项已取消或租约已失效。');
    this.name = 'RuntimeLeaseLostError';
  }
}

class RuntimeShutdownError extends Error {
  constructor() {
    super('Runtime 正在关闭，已拒绝迟到回调。');
    this.name = 'RuntimeShutdownError';
  }
}

class RuntimeToolTimeoutError extends Error {
  constructor(toolName: string) {
    super(`Runtime 工具 ${toolName} 执行超时。`);
    this.name = 'RuntimeToolTimeoutError';
  }
}

class RuntimeRetryFailureError extends Error {
  readonly retryMetadata: RetryFailureMetadata;

  constructor(cause: unknown, retryMetadata: RetryFailureMetadata) {
    super(cause instanceof Error ? cause.message : 'Runtime 工具执行失败。', { cause });
    this.name = cause instanceof Error ? cause.name : 'RuntimeRetryFailureError';
    this.retryMetadata = retryMetadata;
  }
}

/**
 * A durable job was not allowed to call a provider while its shared cooldown
 * was active. The job is re-queued with its lease released; the recovery
 * worker will claim it once available_at is due.
 */
export class RuntimeCooldownDeferredError extends Error {
  constructor() {
    super('Runtime provider 冷却中，工作项已延后。');
    this.name = 'RuntimeCooldownDeferredError';
  }
}

export function sanitizeRuntimeError(error: unknown, maxLength = 500) {
  return redactDiagnosticText(error instanceof Error ? error : error ?? '运行失败', maxLength);
}

const defaultTools: RuntimeToolDefinition[] = [
  { name: 'source.read', policy: 'readonly', timeoutMs: 10_000, maxRetries: 2, audit: true, description: '读取已经进入耐久 inbox 的来源。' },
  { name: 'reference.inspect', policy: 'readonly', timeoutMs: 15_000, maxRetries: 1, audit: true, description: '只读扫描主人明确授权的工作目录元数据。' },
  { name: 'task.propose_update', policy: 'readonly', timeoutMs: 120_000, maxRetries: 0, audit: true, description: '只创建待主人确认的结构化更新提案。' },
  { name: 'task.auto_apply_update', policy: 'controlled_internal_write', timeoutMs: 5_000, maxRetries: 0, audit: true, description: '在双重置信度、版本和暂停策略全部通过时，自动更新私人 PM 内部记录。' },
  { name: 'task.apply_update', policy: 'approval_required', timeoutMs: 5_000, maxRetries: 0, audit: true, description: '主人确认后更新正式任务。' },
  { name: 'memory.project', policy: 'approval_required', timeoutMs: 15_000, maxRetries: 2, audit: true, description: '把已确认状态投影到系统自有任务记忆目录。' },
  { name: 'external.send', policy: 'forbidden', timeoutMs: 0, maxRetries: 0, audit: true, description: 'M1 永久 draft-only：仅保留 approval/outbox 历史结构，禁止 provider 或对外发送。' },
  { name: 'shell.execute', policy: 'forbidden', timeoutMs: 0, maxRetries: 0, audit: true, description: 'Runtime 不允许执行任意 Shell。' },
  { name: 'sql.execute', policy: 'forbidden', timeoutMs: 0, maxRetries: 0, audit: true, description: 'Runtime 不允许执行任意业务 SQL。' },
  { name: 'workspace.write', policy: 'forbidden', timeoutMs: 0, maxRetries: 0, audit: true, description: 'Runtime 不允许修改真实工作目录。' },
];

export class RuntimeToolRegistry {
  private readonly tools = new Map(defaultTools.map((tool) => [tool.name, tool]));

  list() {
    return [...this.tools.values()];
  }

  get(name: string) {
    return this.tools.get(name) ?? null;
  }

  authorize(name: string, approved = false) {
    const definition = this.get(name);
    if (!definition) return { allowed: false, reason: 'unknown_tool', definition: null } as const;
    if (definition.policy === 'forbidden') return { allowed: false, reason: 'forbidden', definition } as const;
    if (definition.policy === 'approval_required' && !approved) return { allowed: false, reason: 'approval_required', definition } as const;
    return { allowed: true, reason: 'allowed', definition } as const;
  }
}

/**
 * Thin, SQLite-backed runtime boundary for bounded PM work.
 *
 * It does not execute arbitrary tools. It owns durable identity, leases,
 * retries, checkpoints and auditable tool policy decisions so a later worker
 * can safely resume after a process restart.
 */
export class PmRuntime {
  readonly tools = new RuntimeToolRegistry();
  readonly generation = randomUUID();
  private readonly clock: RuntimeClock;
  private lifecycle: 'running' | 'stopping' | 'stopped' = 'running';
  private readonly activeControllers = new Map<string, Set<AbortController>>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly activeToolCalls = new Map<string, ActiveToolCall>();
  /** Exact current lease fence per job. Owner text alone is not unique. */
  private readonly ownedLeases = new Map<string, string>();
  private readonly retryCoordinator: RetryCoordinator;
  private readonly retrySleep: RuntimeRetrySleep;
  private shutdownPromise: Promise<{ stopped: boolean; timedOut: boolean; generation: string }> | null = null;

  constructor(
    private readonly database: AppDatabase,
    options: {
      clock?: RuntimeClock | (() => number);
      now?: () => number;
      retryCoordinator?: RetryCoordinator;
      retryPolicy?: RetryPolicyOptions;
      retrySleep?: RuntimeRetrySleep;
    } = {},
  ) {
    this.clock = typeof options.clock === 'function'
      ? { now: options.clock }
      : options.clock ?? (options.now ? { now: options.now } : systemClock);
    this.retryCoordinator = options.retryCoordinator ?? new RetryCoordinator({
      ...(options.retryPolicy ?? {}),
      now: () => this.now(),
      // Runtime jobs must share provider cooldown across instances and
      // restarts. A process-local map is only suitable for isolated adapter
      // tests, never for the durable Runtime boundary.
      store: options.retryPolicy?.store ?? new SqliteRetryCooldownStore(database.raw),
    });
    this.retrySleep = options.retrySleep ?? ((delayMs, signal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new RuntimeShutdownError());
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, delayMs);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(signal.reason instanceof Error ? signal.reason : new RuntimeShutdownError());
      };
      signal.addEventListener('abort', abort, { once: true });
    }));
  }

  private now() {
    return this.clock.now();
  }

  private nowIso() {
    return new Date(this.now()).toISOString();
  }

  private leaseDeadline(leaseMs: number) {
    return new Date(this.now() + Math.max(1_000, leaseMs)).toISOString();
  }

  private deferToolCallForCooldown(callId: string, jobId: string, leaseOwner: string, delayMs: number) {
    const timestamp = this.nowIso();
    const availableAt = new Date(this.now() + Math.max(0, delayMs)).toISOString();
    this.database.transaction(() => {
      const job = this.database.raw.prepare(
        `UPDATE job
         SET status = 'queued', retryable = 1, available_at = CASE WHEN available_at > ? THEN available_at ELSE ? END,
             locked_until = NULL, lease_owner = NULL, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND cancel_requested_at IS NULL AND locked_until > ?`,
      ).run(availableAt, availableAt, timestamp, jobId, leaseOwner, timestamp);
      if (job.changes !== 1) throw new RuntimeLeaseLostError();
      const audit = this.database.raw.prepare(
        `UPDATE runtime_tool_call
         SET status = 'blocked', error = 'Runtime provider cooldown active', finished_at = ?
         WHERE id = ? AND job_id = ? AND status = 'allowed'`,
      ).run(timestamp, callId, jobId);
      if (audit.changes !== 1) throw new RuntimeLeaseLostError();
    });
    this.activeToolCalls.delete(callId);
  }

  private isRunning() {
    return this.lifecycle === 'running';
  }

  private assertRunning() {
    if (!this.isRunning()) throw new RuntimeShutdownError();
  }

  private operationAbort(jobId: string | null, options: RuntimeExecutionOptions = {}) {
    const controller = new AbortController();
    const controllerKey = jobId ?? '__runtime_global__';
    const controllers = this.activeControllers.get(controllerKey) ?? new Set<AbortController>();
    if (!this.activeControllers.has(controllerKey)) this.activeControllers.set(controllerKey, controllers);
    controllers.add(controller);
    const abortFrom = (signal: AbortSignal | undefined) => {
      if (!signal) return undefined;
      if (signal.aborted) controller.abort(signal.reason);
      const listener = () => controller.abort(signal.reason);
      signal.addEventListener('abort', listener, { once: true });
      return () => signal.removeEventListener('abort', listener);
    };
    const removeExternalListener = abortFrom(options.signal);
    const cleanup = () => {
      removeExternalListener?.();
      controllers.delete(controller);
      if (!controllers.size) this.activeControllers.delete(controllerKey);
    };
    return { controller, cleanup };
  }

  private abortJob(jobId: string, reason: unknown) {
    for (const controller of this.activeControllers.get(jobId) ?? []) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }

  /**
   * Stop accepting Runtime writes, abort in-flight provider/tool calls, and
   * wait only a bounded amount of time. Late callbacks are fenced by the
   * generation/lifecycle check and cannot touch a closed database.
   */
  shutdown(timeoutMs = 5_000) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.lifecycle = 'stopping';
    for (const jobId of this.activeControllers.keys()) this.abortJob(jobId, new RuntimeShutdownError());
    // A local desktop instance owns the running leases it created. Release
    // them immediately so a config reload/new process can resume from the
    // durable checkpoint instead of waiting for the old lease TTL to elapse.
    const timestamp = this.nowIso();
    const ownedLeases = [...this.ownedLeases.entries()];
    // Finalize in-flight audit rows before releasing the exact lease fence.
    // Provider callbacks are already being aborted and are rejected by the
    // lifecycle gate, so they cannot turn this terminal state back into a
    // completed call after shutdown starts.
    const activeToolCalls = [...this.activeToolCalls.entries()];
    this.database.transaction(() => {
      const terminalError = 'Runtime 在关闭时中止工具调用。';
      for (const [callId, call] of activeToolCalls) {
        if (call.externalClaimJobId && call.jobId === call.externalClaimJobId && !call.leaseOwner) {
          const finalized = this.database.raw.prepare(
            `UPDATE runtime_tool_call
             SET status = 'failed', error = COALESCE(error, ?), finished_at = ?
             WHERE id = ? AND status = 'allowed' AND job_id = ?`,
          ).run(terminalError, timestamp, callId, call.externalClaimJobId);
          if (finalized.changes === 1) this.failExternalClaim(call.externalClaimJobId, terminalError, timestamp);
          continue;
        }
        if (call.jobId === null) {
          this.database.raw.prepare(
            `UPDATE runtime_tool_call
             SET status = 'failed', error = COALESCE(error, ?), finished_at = ?
             WHERE id = ? AND status = 'allowed'`,
          ).run(terminalError, timestamp, callId);
          continue;
        }
        const leaseOwner = call.leaseOwner ?? ownedLeases.find(([jobId]) => jobId === call.jobId)?.[1] ?? null;
        if (!leaseOwner) continue;
        this.database.raw.prepare(
          `UPDATE runtime_tool_call
           SET status = 'failed', error = COALESCE(error, ?), finished_at = ?
           WHERE id = ? AND status = 'allowed' AND job_id = ?
             AND EXISTS (
               SELECT 1 FROM job
               WHERE job.id = runtime_tool_call.job_id
                 AND job.status = 'running' AND job.lease_owner = ?
             )`,
        ).run(terminalError, timestamp, callId, call.jobId, leaseOwner);
        if (call.externalClaimJobId) this.failExternalClaim(call.externalClaimJobId, terminalError, timestamp);
      }
      for (const [jobId, leaseOwner] of ownedLeases) {
        this.database.raw.prepare(
          `UPDATE job
           SET status = 'queued', available_at = ?, locked_until = NULL, lease_owner = NULL, updated_at = ?
           WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL AND lease_owner = ?`,
        ).run(timestamp, timestamp, jobId, leaseOwner);
      }
    });
    const bounded = Math.max(0, timeoutMs);
    this.shutdownPromise = (async () => {
      const pending = [...this.activeOperations];
      let timedOut = false;
      if (pending.length) {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        try {
          await Promise.race([
            Promise.allSettled(pending).then(() => undefined),
            new Promise<void>((resolve) => { timeout = setTimeout(() => { timedOut = true; resolve(); }, bounded); }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      this.lifecycle = 'stopped';
      return { stopped: true, timedOut, generation: this.generation };
    })();
    return this.shutdownPromise;
  }

  enqueue(input: {
    jobType: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
    sourceEventId?: string | null;
    threadId?: string | null;
    taskId?: string | null;
    traceId?: string | null;
    availableAt?: string;
    maxAttempts?: number;
    backoffSeconds?: number;
  }) {
    this.assertRunning();
    if (input.idempotencyKey) {
      const existing = this.byIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;
    }
    const timestamp = this.nowIso();
    const jobId = newId('run');
    const inserted = this.database.raw.prepare(
      `INSERT OR IGNORE INTO job
        (id, job_type, payload_json, status, attempts, available_at, locked_until, lease_owner, max_attempts, retryable,
         backoff_seconds, cancel_requested_at, idempotency_key, source_event_id, thread_id, task_id, trace_id,
         last_error, result_json, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, NULL, NULL, ?, 1, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      jobId,
      input.jobType,
      JSON.stringify(input.payload ?? {}),
      input.availableAt ?? timestamp,
      Math.max(1, input.maxAttempts ?? 3),
      Math.max(1, input.backoffSeconds ?? 30),
      input.idempotencyKey ?? null,
      input.sourceEventId ?? null,
      input.threadId ?? null,
      input.taskId ?? null,
      input.traceId ?? null,
      timestamp,
      timestamp,
    );
    if (inserted.changes !== 1) {
      const existing = input.idempotencyKey ? this.byIdempotencyKey(input.idempotencyKey) : null;
      if (existing) return existing;
      throw new Error('Runtime 工作项未能安全写入，请稍后重试。');
    }
    return this.get(jobId)!;
  }

  begin(input: Parameters<PmRuntime['enqueue']>[0] & { leaseOwner?: string; leaseMs?: number; wakeRetry?: boolean }): RuntimeJobHandle {
    this.assertRunning();
    const row = this.enqueue(input);
    // A repeated durable source event is an explicit wake-up signal. It may
    // re-open a queued retry immediately, while the normal background worker
    // still observes exponential backoff when no new signal arrives.
    if (input.wakeRetry && row.attempts > 0 && row.status === 'queued' && row.available_at > this.nowIso()) {
      this.wakeRetry(row.id);
    }
    const ready = this.get(row.id)!;
    if (ready.status === 'completed' || ready.status === 'cancelled' || ready.status === 'waiting_approval') {
      return { ...ready, acquired: false };
    }
    return this.claim(ready.id, input.leaseOwner ?? newId('worker'), input.leaseMs ?? 5 * 60 * 1000);
  }

  wakeRetry(jobId: string) {
    this.assertRunning();
    const timestamp = this.nowIso();
    this.database.raw.prepare(
      "UPDATE job SET available_at = ?, retryable = 1, updated_at = ? WHERE id = ? AND status = 'queued' AND attempts > 0 AND retryable = 1 AND cancel_requested_at IS NULL",
    ).run(timestamp, timestamp, jobId);
    return this.get(jobId);
  }

  claim(jobId: string, leaseOwner: string, leaseMs = 5 * 60 * 1000): RuntimeJobHandle {
    this.assertRunning();
    return this.database.transaction(() => {
      const current = this.get(jobId);
      if (!current) throw new Error('Runtime 工作项不存在。');
      const now = this.nowIso();
      if (current.cancel_requested_at || current.status === 'cancelled') {
        this.database.raw.prepare("UPDATE job SET status = 'cancelled', locked_until = NULL, lease_owner = NULL, updated_at = ? WHERE id = ?")
          .run(now, jobId);
        return { ...this.get(jobId)!, acquired: false };
      }
      const leaseActive = current.status === 'running' && current.locked_until && current.locked_until > now;
      const available = current.available_at <= now;
      const retryableState = current.status === 'queued'
        || (current.status === 'failed' && current.retryable !== 0)
        || (current.status === 'running' && !leaseActive);
      if (!retryableState || !available || current.attempts >= current.max_attempts || leaseActive) {
        return { ...current, acquired: false };
      }
      const updated = this.database.raw.prepare(
        `UPDATE job SET status = 'running', attempts = attempts + 1, locked_until = ?, lease_owner = ?, retryable = 1,
           last_error = NULL, updated_at = ? WHERE id = ? AND attempts = ? AND (status = 'queued' OR status = 'failed' OR (status = 'running' AND locked_until <= ?))`,
      ).run(this.leaseDeadline(leaseMs), leaseOwner, now, jobId, current.attempts, now);
      if (updated.changes !== 1) return { ...this.get(jobId)!, acquired: false };
      // A reclaimed lease closes every old in-flight audit before exposing the
      // new generation. Both mutations are in this transaction, so a stale
      // callback can never observe a new owner while its allowed audit remains
      // open.
      this.database.raw.prepare(
        `UPDATE runtime_tool_call
         SET status = 'failed', error = COALESCE(error, 'Runtime lease was reclaimed before tool completion'), finished_at = ?
         WHERE job_id = ? AND status = 'allowed'`,
      ).run(now, jobId);
      this.ownedLeases.set(jobId, leaseOwner);
      return { ...this.get(jobId)!, acquired: true };
    });
  }

  renewLease(jobId: string, leaseOwner: string, leaseMs = 5 * 60 * 1000) {
    this.assertRunning();
    const timestamp = this.nowIso();
    const result = this.database.raw.prepare(
      "UPDATE job SET locked_until = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ? AND cancel_requested_at IS NULL AND locked_until > ?",
    ).run(this.leaseDeadline(leaseMs), timestamp, jobId, leaseOwner, timestamp);
    return result.changes === 1 ? this.get(jobId) : null;
  }

  /** Conditional fence used while a business transaction is committing. */
  assertLease(jobId: string, leaseOwner: string) {
    if (!this.isRunning()) return false;
    const timestamp = this.nowIso();
    return Boolean(this.database.raw.prepare(
      "SELECT 1 AS present FROM job WHERE id = ? AND status = 'running' AND lease_owner = ? AND cancel_requested_at IS NULL AND locked_until > ?",
    ).get(jobId, leaseOwner, timestamp));
  }

  private hasCurrentLease(jobId: string, leaseOwner: string) {
    if (!this.isRunning()) return false;
    const timestamp = this.nowIso();
    return Boolean(this.database.raw.prepare(
      "SELECT 1 AS present FROM job WHERE id = ? AND status = 'running' AND lease_owner = ? AND cancel_requested_at IS NULL AND locked_until > ?",
    ).get(jobId, leaseOwner, timestamp));
  }

  /**
   * The durable external-send claim remains the job-level fence. v3 also
   * records the caller key on each audit row and enforces active/success
   * uniqueness at the database level while allowing blocked duplicate rows.
   */
  private externalClaimKey(idempotencyKey: string) {
    return `runtime-external:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
  }

  private claimExternalSend(idempotencyKey: string, toolName: string, inputHash: string, timeoutMs: number, timestamp: string) {
    const claimJobId = newId('external-claim');
    const claimKey = this.externalClaimKey(idempotencyKey);
    const lockedUntil = new Date(this.now() + Math.max(1_000, timeoutMs)).toISOString();
    const inserted = this.database.raw.prepare(
        `INSERT OR IGNORE INTO job
          (id, job_type, payload_json, status, attempts, available_at, locked_until, lease_owner,
           max_attempts, retryable, backoff_seconds, cancel_requested_at, idempotency_key,
           source_event_id, thread_id, task_id, trace_id, last_error, result_json, created_at, updated_at)
         VALUES (?, 'runtime_external_send', ?, 'running', 1, ?, ?, ?, 1, 0, 0, NULL, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)`
    ).run(
        claimJobId,
        JSON.stringify({ toolName, inputHash }),
        timestamp,
        lockedUntil,
        this.generation,
        claimKey,
        claimJobId,
        timestamp,
        timestamp,
    );
    if (inserted.changes === 1) return { claimJobId, duplicate: false, resultJson: null } as const;
    const existing = this.database.raw.prepare(
        `SELECT id, status, result_json FROM job
         WHERE idempotency_key = ? AND job_type = 'runtime_external_send'
         LIMIT 1`,
    ).get(claimKey) as { id: string; status: RuntimeJobStatus; result_json: string | null } | undefined;
    if (!existing) throw new Error('Runtime 外部动作幂等声明无法安全确认，请稍后重试。');
    return {
      claimJobId: existing.id,
      duplicate: true,
      resultJson: existing.status === 'completed' ? existing.result_json : null,
    } as const;
  }

  private completeExternalClaim(claimJobId: string, result: Record<string, unknown>, timestamp: string) {
    return this.database.raw.prepare(
      `UPDATE job
       SET status = 'completed', locked_until = NULL, lease_owner = NULL, retryable = 0,
           result_json = ?, last_error = NULL, updated_at = ?
       WHERE id = ? AND job_type = 'runtime_external_send' AND status = 'running' AND lease_owner = ?
         AND cancel_requested_at IS NULL AND locked_until > ?`,
    ).run(JSON.stringify(result), timestamp, claimJobId, this.generation, timestamp).changes === 1;
  }

  private failExternalClaim(claimJobId: string, error: unknown, timestamp: string) {
    return this.database.raw.prepare(
      `UPDATE job
       SET status = 'failed', locked_until = NULL, lease_owner = NULL, retryable = 0,
           last_error = ?, updated_at = ?
       WHERE id = ? AND job_type = 'runtime_external_send' AND status = 'running' AND lease_owner = ?
         AND cancel_requested_at IS NULL AND locked_until > ?`,
    ).run(sanitizeRuntimeError(error), timestamp, claimJobId, this.generation, timestamp).changes === 1;
  }

  private insertCheckpointIfFenced(jobId: string, step: string, stateJson: string, timestamp: string, leaseOwner: string) {
    return this.database.raw.prepare(
      `INSERT INTO runtime_checkpoint (id, job_id, step, state_json, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM job
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND cancel_requested_at IS NULL AND locked_until > ?
       )`,
    ).run(newId('checkpoint'), jobId, step, stateJson, timestamp, jobId, leaseOwner, timestamp);
  }

  checkpoint(jobId: string, step: string, state: Record<string, unknown> = {}, leaseOwner?: string) {
    this.assertRunning();
    const timestamp = this.nowIso();
    if (!leaseOwner) return false;
    const stateJson = JSON.stringify(state);
    return this.database.transaction(() => {
      const inserted = this.insertCheckpointIfFenced(jobId, step, stateJson, timestamp, leaseOwner);
      return inserted.changes === 1;
    });
  }

  latestCheckpoint(jobId: string) {
    return this.database.raw.prepare('SELECT * FROM runtime_checkpoint WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(jobId) ?? null;
  }

  waitForApproval(jobId: string, context: Record<string, unknown> = {}, leaseOwner?: string) {
    this.assertRunning();
    const timestamp = this.nowIso();
    if (!leaseOwner) return this.get(jobId);
    const stateJson = JSON.stringify(context);
    return this.database.transaction(() => {
      const inserted = this.insertCheckpointIfFenced(jobId, 'waiting_approval', stateJson, timestamp, leaseOwner);
      if (inserted.changes !== 1) return this.get(jobId);
      const updated = this.database.raw.prepare(
        "UPDATE job SET status = 'waiting_approval', locked_until = NULL, lease_owner = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ? AND cancel_requested_at IS NULL AND locked_until > ?",
      ).run(timestamp, jobId, leaseOwner, timestamp);
      if (updated.changes !== 1) throw new RuntimeLeaseLostError();
      return this.get(jobId);
    });
  }

  resumeAfterApproval(jobId: string) {
    this.assertRunning();
    const timestamp = this.nowIso();
    this.database.raw.prepare(
      "UPDATE job SET status = 'queued', available_at = ?, locked_until = NULL, lease_owner = NULL, updated_at = ? WHERE id = ? AND status = 'waiting_approval' AND cancel_requested_at IS NULL",
    ).run(timestamp, timestamp, jobId);
    return this.get(jobId);
  }

  complete(jobId: string, result: Record<string, unknown> = {}, leaseOwner?: string) {
    this.assertRunning();
    const timestamp = this.nowIso();
    const current = this.get(jobId);
    if (!current) return null;
    if (current.status !== 'running' || !leaseOwner || current.lease_owner !== leaseOwner || current.cancel_requested_at || !current.locked_until || current.locked_until <= timestamp) return current;
    const resultRow = this.database.raw.prepare(
        "UPDATE job SET status = 'completed', locked_until = NULL, lease_owner = NULL, retryable = 0, result_json = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ? AND cancel_requested_at IS NULL AND locked_until > ?",
      ).run(JSON.stringify(result), timestamp, jobId, leaseOwner, timestamp);
    if (resultRow.changes !== 1) return this.get(jobId);
    return this.get(jobId);
  }

  fail(jobId: string, error: unknown, options: {
    retryable?: boolean;
    retryAt?: string | null;
    retry?: RetryFailureMetadata | null;
    retryAfterMs?: number | null;
    cooldownMs?: number | null;
    cooldownKey?: string;
    leaseOwner?: string;
  } = {}) {
    this.assertRunning();
    const timestamp = this.nowIso();
    const current = this.get(jobId);
    if (!current) return null;
    const message = sanitizeRuntimeError(error);
    if (current.status === 'cancelled' || current.cancel_requested_at) return current;
    if (current.status !== 'running' || !options.leaseOwner || current.lease_owner !== options.leaseOwner || !current.locked_until || current.locked_until <= timestamp) return current;
    const retryMetadata = options.retry
      ? normalizeRetryFailureMetadata(options.retry, undefined, this.now())
      : classifyRetryFailure(error);
    const invalidRetryMetadata = options.retry !== undefined && options.retry !== null && !retryMetadata;
    const retryable = !invalidRetryMetadata
      && retryMetadata?.retryable !== false
      && options.retryable !== false
      && current.attempts < current.max_attempts;
    const retryDelay = retryMetadata?.retryable
      ? this.retryCoordinator.nextDelay(
        retryMetadata.providerKey,
        current.attempts,
        retryMetadata.retryAfterMs,
        retryMetadata.retryAt,
        false,
      )
      : options.cooldownKey
      ? this.retryCoordinator.nextDelay(options.cooldownKey, current.attempts, options.retryAfterMs)
      : computeRetryDelay({
        attempt: current.attempts,
        retryAfterMs: options.retryAfterMs,
        cooldownMs: options.cooldownMs,
        options: { baseMs: current.backoff_seconds * 1_000 },
      });
    const computedRetryAt = new Date(this.now() + retryDelay).toISOString();
    const nowMs = this.now();
    const retryAtCandidates = [options.retryAt, retryMetadata?.retryAt, computedRetryAt]
      .filter((value): value is string => {
        if (typeof value !== 'string') return false;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed >= nowMs && parsed - nowMs <= DEFAULT_RETRY_MAX_MS;
      });
    const availableAt = retryAtCandidates.length
      ? new Date(Math.max(...retryAtCandidates.map((value) => Date.parse(value)))).toISOString()
      : computedRetryAt;
    const result = this.database.transaction(() => {
      const update = this.database.raw.prepare(
        `UPDATE job SET status = ?, retryable = ?, locked_until = NULL, lease_owner = NULL, last_error = ?, available_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ? AND cancel_requested_at IS NULL AND locked_until > ?`,
      ).run(retryable ? 'queued' : 'failed', retryable ? 1 : 0, message, availableAt, timestamp, jobId, options.leaseOwner!, timestamp);
      if (update.changes === 1 && retryMetadata?.retryable) this.retryCoordinator.setCooldownAt(retryMetadata.providerKey, availableAt);
      return update;
    });
    if (result.changes !== 1) return this.get(jobId);
    return this.get(jobId);
  }

  cancel(jobId: string) {
    this.assertRunning();
    const timestamp = this.nowIso();
    this.abortJob(jobId, new RuntimeLeaseLostError());
    this.database.raw.prepare(
      "UPDATE job SET status = 'cancelled', cancel_requested_at = COALESCE(cancel_requested_at, ?), locked_until = NULL, lease_owner = NULL, updated_at = ? WHERE id = ? AND status NOT IN ('completed','cancelled')",
    ).run(timestamp, timestamp, jobId);
    return this.get(jobId);
  }

  retry(jobId: string) {
    this.assertRunning();
    const timestamp = this.nowIso();
    return this.database.transaction(() => {
      const current = this.get(jobId);
      if (!current) throw new Error('Runtime 工作项不存在。');
      if (current.status !== 'failed' && current.status !== 'cancelled') {
        throw new Error('只有失败或已取消的 Runtime 工作项可以手动重试。');
      }
      this.database.raw.prepare(
        'INSERT INTO runtime_checkpoint (id, job_id, step, state_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(
        newId('checkpoint'),
        jobId,
        'manual_retry_requested',
        JSON.stringify({ previousStatus: current.status, previousAttempts: current.attempts, previousError: current.last_error }),
        timestamp,
      );
      const updated = this.database.raw.prepare(
        `UPDATE job
         SET status = 'queued', attempts = 0, available_at = ?, locked_until = NULL, lease_owner = NULL,
             retryable = 1, cancel_requested_at = NULL, last_error = NULL, result_json = NULL, updated_at = ?
         WHERE id = ? AND status IN ('failed','cancelled')`,
      ).run(timestamp, timestamp, jobId);
      if (updated.changes !== 1) throw new Error('Runtime 工作项状态已经变化，请刷新后重试。');
      return this.get(jobId)!;
    });
  }

  isCancellationRequested(jobId: string) {
    const row = this.get(jobId);
    return Boolean(row?.cancel_requested_at || row?.status === 'cancelled');
  }

  recoverExpired() {
    this.assertRunning();
    const timestamp = this.nowIso();
    const expired = this.database.raw.prepare(
      "SELECT * FROM job WHERE status = 'running' AND locked_until IS NOT NULL AND locked_until <= ?",
    ).all(timestamp) as unknown as RuntimeJobRow[];
    let recovered = 0;
    for (const row of expired) {
      const nextStatus: RuntimeJobStatus = row.job_type === 'runtime_external_send'
        ? 'failed'
        : row.cancel_requested_at
        ? 'cancelled'
        : row.attempts >= row.max_attempts
          ? 'failed'
          : 'queued';
      this.database.transaction(() => {
        this.abortJob(row.id, new RuntimeLeaseLostError());
        const update = this.database.raw.prepare(
          `UPDATE job
           SET status = ?, retryable = ?, available_at = ?, locked_until = NULL, lease_owner = NULL, updated_at = ?
           WHERE id = ? AND status = 'running' AND attempts = ? AND locked_until = ? AND lease_owner IS ? AND locked_until <= ?`,
        ).run(
          nextStatus,
          nextStatus === 'queued' && row.job_type !== 'runtime_external_send' ? 1 : 0,
          timestamp,
          timestamp,
          row.id,
          row.attempts,
          row.locked_until,
          row.lease_owner,
          timestamp,
        );
        if (update.changes !== 1) return;
        recovered += 1;
        this.database.raw.prepare(
          "UPDATE runtime_tool_call SET status = 'failed', error = COALESCE(error, 'Runtime lease expired before tool completion'), finished_at = ? WHERE job_id = ? AND status = 'allowed'",
        ).run(timestamp, row.id);
      });
    }
    return recovered;
  }

  authorizeTool(jobId: string | null, toolName: string, input: unknown, approved = false, idempotencyKey?: string, leaseOwner?: string) {
    this.assertRunning();
    const jobFenceRequired = jobId !== null;
    if (jobFenceRequired && !leaseOwner) throw new RuntimeLeaseLostError();
    const normalizedIdempotencyKey = idempotencyKey?.trim() || null;
    let decision: { allowed: boolean; reason: string; definition: RuntimeToolDefinition | null } = this.tools.authorize(toolName, approved);
    if (toolName === 'external.send' && decision.allowed && !normalizedIdempotencyKey) {
      decision = { ...decision, allowed: false, reason: 'idempotency_required' };
    }
    const callId = newId('tool');
    const timestamp = this.nowIso();
    const inputHash = createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex');
    let externalClaim: ReturnType<PmRuntime['claimExternalSend']> | null = null;
    const insertAudit = (claim: ReturnType<PmRuntime['claimExternalSend']> | null) => {
      const duplicate = claim?.duplicate ?? false;
      const auditJobId = jobId ?? claim?.claimJobId ?? null;
      const blockedReason = duplicate ? 'duplicate_idempotency_key' : decision.allowed ? null : decision.reason;
      const insert = jobFenceRequired
        ? this.database.raw.prepare(
          `INSERT INTO runtime_tool_call
            (id, job_id, tool_name, policy, status, idempotency_key, input_hash, result_json, error, started_at, finished_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM job
             WHERE id = ? AND status = 'running' AND lease_owner = ?
               AND cancel_requested_at IS NULL AND locked_until > ?
           )`,
        )
        : this.database.raw.prepare(
          `INSERT INTO runtime_tool_call
            (id, job_id, tool_name, policy, status, idempotency_key, input_hash, result_json, error, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        );
      const inserted = jobFenceRequired
        ? insert.run(
          callId,
          auditJobId,
          toolName,
          decision.definition?.policy ?? 'forbidden',
          duplicate || !decision.allowed ? 'blocked' : 'allowed',
          normalizedIdempotencyKey,
          inputHash,
          blockedReason,
          timestamp,
          duplicate || !decision.allowed ? timestamp : null,
          jobId!,
          leaseOwner!,
          timestamp,
        )
        : insert.run(
          callId,
          auditJobId,
          toolName,
          decision.definition?.policy ?? 'forbidden',
          duplicate || !decision.allowed ? 'blocked' : 'allowed',
          normalizedIdempotencyKey,
          inputHash,
          blockedReason,
          timestamp,
          duplicate || !decision.allowed ? timestamp : null,
        );
      if (jobFenceRequired && inserted.changes !== 1) throw new RuntimeLeaseLostError();
    };
    externalClaim = this.database.transaction(() => {
      if (decision.allowed && toolName === 'external.send' && normalizedIdempotencyKey) {
        const claim = this.claimExternalSend(normalizedIdempotencyKey, toolName, inputHash, decision.definition?.timeoutMs ?? 15_000, timestamp);
        insertAudit(claim);
        return claim;
      } else {
        insertAudit(null);
        return null;
      }
    });
    const duplicate = externalClaim?.duplicate ?? false;
    const auditJobId = jobId ?? externalClaim?.claimJobId ?? null;
    if (decision.allowed && !duplicate) {
      this.activeToolCalls.set(callId, {
        jobId: auditJobId,
        leaseOwner: leaseOwner ?? null,
        externalClaimJobId: externalClaim?.claimJobId ?? null,
      });
    }
    return {
      callId,
      ...decision,
      allowed: decision.allowed && !duplicate,
      reason: duplicate ? 'duplicate_idempotency_key' : decision.reason,
      duplicateOf: duplicate ? 'external_send_claim' : null,
      duplicateResult: externalClaim?.resultJson ?? null,
    } as const;
  }

  async executeTool<T>(input: {
    jobId: string | null;
    toolName: string;
    toolInput?: unknown;
    approved?: boolean;
    idempotencyKey?: string;
    cooldownKey?: string;
    signal?: AbortSignal;
    leaseOwner?: string;
    leaseMs?: number;
    autoRenewLease?: boolean;
    checkpoint?: { step: string; state: (result: T) => Record<string, unknown> };
    run: (attempt: number, signal: AbortSignal) => Promise<T> | T;
    auditResult?: (result: T, attempts: number) => Record<string, unknown>;
  }) {
    this.assertRunning();
    if (input.jobId !== null && (!input.leaseOwner || !this.hasCurrentLease(input.jobId, input.leaseOwner))) {
      throw new RuntimeLeaseLostError();
    }
    const decision = this.authorizeTool(input.jobId, input.toolName, input.toolInput, input.approved === true, input.idempotencyKey, input.leaseOwner);
    const activeCall = this.activeToolCalls.get(decision.callId);
    if (activeCall) activeCall.leaseOwner = input.leaseOwner ?? null;
    if (decision.duplicateOf) {
      if (decision.duplicateResult) return JSON.parse(decision.duplicateResult) as T;
      throw new Error('Runtime 工具重复调用已拒绝。');
    }
    if (!decision.allowed || !decision.definition) throw new Error(`Runtime 工具不可用：${decision.reason}`);
    const operation = this.operationAbort(input.jobId, input);
    const leaseDuration = Math.max(1_000, input.leaseMs ?? 5 * 60 * 1_000);
    let leaseTimer: ReturnType<typeof setInterval> | null = null;
    const heartbeat = input.jobId !== null && input.leaseOwner && input.autoRenewLease !== false
      ? () => {
          if (!this.isRunning() || operation.controller.signal.aborted) return;
          const current = this.get(input.jobId!);
          const lockedUntil = current?.locked_until ? Date.parse(current.locked_until) : Number.NaN;
          if (!current || current.status !== 'running' || current.lease_owner !== input.leaseOwner || !Number.isFinite(lockedUntil) || lockedUntil <= this.now()) {
            operation.controller.abort(new RuntimeLeaseLostError());
            return;
          }
          if (lockedUntil - this.now() <= Math.max(1_000, Math.floor(leaseDuration / 3))) {
            this.renewLease(input.jobId!, input.leaseOwner!, leaseDuration);
          }
        }
      : null;
    if (heartbeat) leaseTimer = setInterval(heartbeat, Math.max(25, Math.min(1_000, Math.floor(leaseDuration / 3))));
    let lastError: unknown = new Error('Runtime 工具执行失败。');
    const totalAttempts = decision.definition.maxRetries + 1;
    const run = (async () => {
      try {
        for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
          let finalizationStarted = false;
          try {
            if (operation.controller.signal.aborted) throw operation.controller.signal.reason ?? new RuntimeShutdownError();
            const retryKey = input.cooldownKey?.trim() || input.toolName;
            const cooldownMs = this.retryCoordinator.cooldownMs(retryKey);
            if (cooldownMs > 0) {
              if (input.jobId !== null && input.leaseOwner) {
                this.deferToolCallForCooldown(decision.callId, input.jobId, input.leaseOwner, cooldownMs);
                throw new RuntimeCooldownDeferredError();
              }
              await this.retrySleep(cooldownMs, operation.controller.signal);
            }
            // A provider failure may race with cancellation, lease expiry, or
            // replacement after the previous catch-path check. Re-read the
            // durable exact fence immediately before every new attempt so a
            // stale callback can never invoke the provider again.
            if (input.jobId !== null && input.leaseOwner && !this.hasCurrentLease(input.jobId, input.leaseOwner)) {
              throw new RuntimeLeaseLostError();
            }
            const result = await new Promise<T>((resolve, reject) => {
              let settled = false;
              const abort = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(operation.controller.signal.reason ?? new RuntimeShutdownError());
              };
              const timeout = setTimeout(() => {
                const error = new RuntimeToolTimeoutError(input.toolName);
                operation.controller.abort(error);
                if (settled) return;
                settled = true;
                reject(error);
              }, decision.definition!.timeoutMs);
              operation.controller.signal.addEventListener('abort', abort, { once: true });
              Promise.resolve()
                .then(() => input.run(attempt, operation.controller.signal))
                .then(
                  (value) => { if (!settled) { settled = true; clearTimeout(timeout); resolve(value); } },
                  (error) => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } },
                );
            });
            finalizationStarted = true;
            const auditResult = input.auditResult?.(result, attempt) ?? { attempts: attempt };
            const fence = input.jobId !== null && input.leaseOwner
              ? { jobId: input.jobId, leaseOwner: input.leaseOwner }
              : undefined;
            if (input.checkpoint && input.jobId !== null && input.leaseOwner) {
              this.completeToolCallAndCheckpoint(decision.callId, auditResult, input.jobId, input.leaseOwner, input.checkpoint.step, input.checkpoint.state(result));
            } else {
              this.completeToolCall(decision.callId, auditResult, fence);
            }
            return result;
          } catch (error) {
            const terminalError = error instanceof RuntimeToolTimeoutError
              || error instanceof RuntimeLeaseLostError
              || error instanceof RuntimeShutdownError
              || error instanceof RuntimeCooldownDeferredError;
            const retryMetadata = terminalError
              ? null
              : classifyRetryFailure(error, input.toolName, true);
            lastError = retryMetadata ? new RuntimeRetryFailureError(error, retryMetadata) : error;
            if (operation.controller.signal.aborted) {
              const reason = operation.controller.signal.reason;
              if (reason instanceof Error) lastError = reason;
              break;
            }
            if (error instanceof RuntimeCooldownDeferredError) {
              lastError = error;
              break;
            }
            if (input.jobId !== null && input.leaseOwner && !this.hasCurrentLease(input.jobId, input.leaseOwner)) {
              lastError = new RuntimeLeaseLostError();
              break;
            }
            if (
              finalizationStarted
              || error instanceof RuntimeToolTimeoutError
              || error instanceof RuntimeLeaseLostError
              || error instanceof RuntimeShutdownError
              || error instanceof RuntimeCooldownDeferredError
            ) break;
            if (retryMetadata?.retryable) {
              const retryDelay = this.retryCoordinator.nextDelay(
                retryMetadata.providerKey,
                attempt,
                retryMetadata.retryAfterMs,
                retryMetadata.retryAt,
                true,
                input.jobId !== null && input.leaseOwner
                  ? () => this.hasCurrentLease(input.jobId!, input.leaseOwner!)
                  : undefined,
              );
              if (attempt < totalAttempts) {
                await this.retrySleep(retryDelay, operation.controller.signal);
              } else {
                break;
              }
            }
          }
        }
        if (this.isRunning() && !(lastError instanceof RuntimeCooldownDeferredError)) {
          const fence = input.jobId !== null && input.leaseOwner
            ? { jobId: input.jobId, leaseOwner: input.leaseOwner }
            : undefined;
          this.failToolCall(decision.callId, lastError, fence);
        }
        throw lastError;
      } finally {
        if (leaseTimer) clearInterval(leaseTimer);
        operation.cleanup();
        this.activeToolCalls.delete(decision.callId);
      }
    })();
    this.activeOperations.add(run);
    try {
      return await run;
    } finally {
      this.activeOperations.delete(run);
    }
  }

  executeToolSync<T>(input: {
    jobId: string | null;
    toolName: string;
    toolInput?: unknown;
    approved?: boolean;
    idempotencyKey?: string;
    leaseOwner?: string;
    run: () => T;
    auditResult?: (result: T) => Record<string, unknown>;
  }) {
    this.assertRunning();
    if (input.jobId !== null && (!input.leaseOwner || !this.hasCurrentLease(input.jobId, input.leaseOwner))) {
      throw new RuntimeLeaseLostError();
    }
    const decision = this.authorizeTool(input.jobId, input.toolName, input.toolInput, input.approved === true, input.idempotencyKey, input.leaseOwner);
    const activeCall = this.activeToolCalls.get(decision.callId);
    if (activeCall) activeCall.leaseOwner = input.leaseOwner ?? null;
    if (decision.duplicateOf && decision.duplicateResult) return JSON.parse(decision.duplicateResult) as T;
    if (!decision.allowed || !decision.definition) throw new Error(`Runtime 工具不可用：${decision.reason}`);
    try {
      const result = input.run();
      this.completeToolCall(
        decision.callId,
        input.auditResult?.(result) ?? {},
        input.jobId !== null && input.leaseOwner ? { jobId: input.jobId, leaseOwner: input.leaseOwner } : undefined,
      );
      return result;
    } catch (error) {
      if (this.isRunning()) {
        this.failToolCall(
          decision.callId,
          error,
          input.jobId !== null && input.leaseOwner ? { jobId: input.jobId, leaseOwner: input.leaseOwner } : undefined,
        );
      }
      throw error;
    }
  }

  private toolCallFence(callId: string, fence?: RuntimeLeaseFence) {
    const activeCall = this.activeToolCalls.get(callId);
    if (fence) return fence;
    if (activeCall?.externalClaimJobId && activeCall.jobId === activeCall.externalClaimJobId) {
      return { jobId: activeCall.jobId, leaseOwner: this.generation };
    }
    if (activeCall && activeCall.jobId !== null && activeCall.leaseOwner) return { jobId: activeCall.jobId, leaseOwner: activeCall.leaseOwner };
    const persisted = this.database.raw.prepare(
      "SELECT job_id FROM runtime_tool_call WHERE id = ? AND status = 'allowed'",
    ).get(callId) as { job_id: string | null } | undefined;
    if (persisted && persisted.job_id !== null) throw new RuntimeLeaseLostError();
    return undefined;
  }

  private updateToolCall(callId: string, status: 'completed' | 'failed', timestamp: string, resultJson: string | null, error: string | null, fence?: RuntimeLeaseFence) {
    if (fence) {
      return this.database.raw.prepare(
        `UPDATE runtime_tool_call
         SET status = ?, result_json = ?, error = ?, finished_at = ?
         WHERE id = ? AND status = 'allowed' AND job_id = ?
           AND EXISTS (
             SELECT 1 FROM job
             WHERE job.id = runtime_tool_call.job_id
               AND job.status = 'running' AND job.lease_owner = ?
               AND job.cancel_requested_at IS NULL AND job.locked_until > ?
           )`,
      ).run(status, resultJson, error, timestamp, callId, fence.jobId, fence.leaseOwner, timestamp);
    }
    return this.database.raw.prepare(
      "UPDATE runtime_tool_call SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'allowed'",
    ).run(status, resultJson, error, timestamp, callId);
  }

  completeToolCall(callId: string, result: Record<string, unknown> = {}, fence?: RuntimeLeaseFence) {
    this.assertRunning();
    const timestamp = this.nowIso();
    this.database.transaction(() => {
      const effectiveFence = this.toolCallFence(callId, fence);
      const completed = this.updateToolCall(callId, 'completed', timestamp, JSON.stringify(result), null, effectiveFence);
      if (completed.changes !== 1) throw new RuntimeLeaseLostError();
      const activeCall = this.activeToolCalls.get(callId);
      if (activeCall?.externalClaimJobId && !this.completeExternalClaim(activeCall.externalClaimJobId, result, timestamp)) throw new RuntimeLeaseLostError();
    });
    this.activeToolCalls.delete(callId);
  }

  failToolCall(callId: string, error: unknown, fence?: RuntimeLeaseFence) {
    this.assertRunning();
    const timestamp = this.nowIso();
    const message = sanitizeRuntimeError(error);
    this.database.transaction(() => {
      const effectiveFence = this.toolCallFence(callId, fence);
      const failed = this.updateToolCall(callId, 'failed', timestamp, null, message, effectiveFence);
      if (failed.changes !== 1) throw new RuntimeLeaseLostError();
      const activeCall = this.activeToolCalls.get(callId);
      if (activeCall?.externalClaimJobId && !this.failExternalClaim(activeCall.externalClaimJobId, error, timestamp)) throw new RuntimeLeaseLostError();
    });
    this.activeToolCalls.delete(callId);
  }

  private completeToolCallAndCheckpoint(
    callId: string,
    result: Record<string, unknown>,
    jobId: string,
    leaseOwner: string,
    step: string,
    state: Record<string, unknown>,
  ) {
    if (!this.isRunning()) throw new RuntimeShutdownError();
    const timestamp = this.nowIso();
    this.database.transaction(() => {
      const completed = this.updateToolCall(callId, 'completed', timestamp, JSON.stringify(result), null, { jobId, leaseOwner });
      if (completed.changes !== 1) throw new RuntimeLeaseLostError();
      const activeCall = this.activeToolCalls.get(callId);
      if (activeCall?.externalClaimJobId && !this.completeExternalClaim(activeCall.externalClaimJobId, result, timestamp)) {
        throw new RuntimeLeaseLostError();
      }
      const checkpoint = this.insertCheckpointIfFenced(jobId, step, JSON.stringify(state), timestamp, leaseOwner);
      if (checkpoint.changes !== 1) throw new RuntimeLeaseLostError();
    });
    this.activeToolCalls.delete(callId);
  }

  get(jobId: string) {
    if (!this.isRunning()) return null;
    return (this.database.raw.prepare('SELECT * FROM job WHERE id = ?').get(jobId) as unknown as RuntimeJobRow | undefined) ?? null;
  }

  byIdempotencyKey(key: string) {
    return (this.database.raw.prepare('SELECT * FROM job WHERE idempotency_key = ?').get(key) as unknown as RuntimeJobRow | undefined) ?? null;
  }

  list(limit = 100) {
    return this.database.raw.prepare('SELECT * FROM job ORDER BY updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 500))) as unknown as RuntimeJobRow[];
  }

  listDueRecoverable(jobTypes: string[], limit = 100) {
    if (!jobTypes.length) return [];
    const placeholders = jobTypes.map(() => '?').join(',');
    return this.database.raw.prepare(
      `SELECT * FROM job
       WHERE status IN ('queued','failed')
         AND retryable <> 0
         AND cancel_requested_at IS NULL
         AND attempts < max_attempts
         AND available_at <= ?
         AND job_type IN (${placeholders})
       ORDER BY available_at ASC, created_at ASC
       LIMIT ?`,
    ).all(this.nowIso(), ...jobTypes, Math.max(1, Math.min(limit, 500))) as unknown as RuntimeJobRow[];
  }

  checkpoints(jobId: string) {
    return this.database.raw.prepare('SELECT * FROM runtime_checkpoint WHERE job_id = ? ORDER BY created_at ASC, rowid ASC').all(jobId);
  }

  toolCalls(jobId: string) {
    return this.database.raw.prepare('SELECT * FROM runtime_tool_call WHERE job_id = ? ORDER BY started_at ASC, rowid ASC').all(jobId);
  }
}
