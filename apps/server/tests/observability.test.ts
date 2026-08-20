import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { PmRuntime } from '../src/runtime.js';
import {
  createOperationContext,
  failedSourceOutcome,
  operationEnvelope,
  overallOutcome,
  releaseIdentity,
  stableErrorCode,
  syncSourceOutcome,
} from '../src/observability.js';
import { PmService } from '../src/service.js';

describe('OBS-01 最小可观测合同', () => {
  let database: AppDatabase;
  let service: PmService;

  beforeEach(() => {
    database = new AppDatabase(':memory:', false);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      APP_VERSION: '0.2.0',
    });
    config.release.buildIdentity = 'synthetic-build-58';
    service = new PmService(database, createAdapters(config), config);
  });

  afterEach(() => database.close());

  it('稳定区分成功、部分成功、跳过、全失败和混合来源', () => {
    const success = syncSourceOutcome('calendar', { events: 3, failures: 0, skipped: false }, 12);
    const partial = syncSourceOutcome('minutes', { minutes: 2, failures: 1, skipped: false }, 13);
    const skipped = syncSourceOutcome('documents', { skipped: true, reason: 'adapter_unavailable' }, 2);
    const failure = syncSourceOutcome('owner_messages', { failures: 2, skipped: false }, 15);

    expect(success).toMatchObject({ status: 'success', error_code: null, counts: { events: 3 } });
    expect(partial).toMatchObject({ status: 'partial_success', error_code: 'FEISHU_SYNC_PARTIAL' });
    expect(skipped).toMatchObject({ status: 'skipped', error_code: 'OBS_ADAPTER_UNAVAILABLE' });
    expect(failure).toMatchObject({ status: 'failure', error_code: 'FEISHU_SYNC_FAILED' });
    expect(overallOutcome([success])).toBe('success');
    expect(overallOutcome([skipped])).toBe('skipped');
    expect(overallOutcome([failure, skipped])).toBe('failure');
    expect(overallOutcome([success, partial, skipped])).toBe('partial_success');
  });

  it('复用飞书分类并为刷新预算错误返回固定 code 和固定消息', () => {
    const refreshFailure = {
      diagnostic: { stage: 'token_refresh', category: 'authorization' },
      message: 'synthetic-refresh-token-canary-58',
    };
    expect(stableErrorCode(refreshFailure)).toBe('FEISHU_TOKEN_REFRESH_FAILED');
    expect(stableErrorCode({ errorCode: 'FEISHU_API_ERROR', category: 'rate_limit' })).toBe('FEISHU_RATE_LIMITED');
    expect(failedSourceOutcome('owner_dm', refreshFailure, 8)).toMatchObject({
      status: 'failure',
      error_code: 'FEISHU_TOKEN_REFRESH_FAILED',
      message: '飞书授权刷新失败；请由系统主人重新授权后再试。',
    });
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'category', {
      get() {
        getterCalls += 1;
        throw new Error('synthetic-getter-canary-58');
      },
    });
    expect(stableErrorCode(hostile)).toBe('OBS_INTERNAL_FAILURE');
    expect(getterCalls).toBe(0);
    expect(stableErrorCode(new Proxy({ category: 'rate_limit' }, {}))).toBe('OBS_INTERNAL_FAILURE');
  });

  it('fulfilled 来源只读取 own data descriptor，恶意或错形结果固定失败且不触发 trap', () => {
    let getterCalls = 0;
    const getter = Object.defineProperty({}, 'messages', {
      get() {
        getterCalls += 1;
        throw new Error('synthetic-fulfilled-getter-canary-58');
      },
    });
    let proxyCalls = 0;
    const proxy = new Proxy({ messages: 1 }, {
      get() {
        proxyCalls += 1;
        throw new Error('synthetic-proxy-trap-canary-58');
      },
      getOwnPropertyDescriptor() {
        proxyCalls += 1;
        throw new Error('synthetic-proxy-descriptor-canary-58');
      },
    });
    const revoked = Proxy.revocable({ messages: 1 }, {});
    revoked.revoke();
    const invalid = [getter, proxy, revoked.proxy, [], 1, 'bad', null, {}, { unknown: 1 }, { messages: '1', skipped: false }, Object.defineProperty({}, 'skipped', { get: () => true })];
    for (const value of invalid) {
      expect(syncSourceOutcome('calendar', value, 1)).toMatchObject({
        source: 'calendar',
        status: 'failure',
        counts: { failures: 1 },
        error_code: 'OBS_INVALID_SOURCE_RESULT',
        message: '该来源同步失败；已保留安全诊断信息。',
      });
    }
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
  });

  it('fulfilled 合同拒绝矛盾 skipped/count/reason shape，原型键不能绕过固定 error_code', () => {
    const invalid = [
      { skipped: false },
      { skipped: false, reason: 'not_configured' },
      { skipped: false, reason: 'scope_required', messages: 1 },
      { skipped: false, reason: 'adapter_unavailable', failures: 0 },
      { skipped: false, reason: 'sync_failed', messages: 1, failures: 0 },
      { skipped: false, reason: 'sync_token_missing', events: 1, failures: 0 },
      { skipped: true, reason: 'scan_disabled', failures: 1 },
      { skipped: true, reason: 'scan_disabled', messages: 1 },
      { skipped: true, reason: '__proto__' },
      { skipped: true, reason: 'constructor' },
      { skipped: true, reason: 'prototype' },
      { skipped: false, messages: 1.5 },
    ];
    for (const value of invalid) {
      const outcome = syncSourceOutcome('owner_dm', value, 1);
      expect(outcome).toEqual({
        source: 'owner_dm',
        status: 'failure',
        counts: { failures: 1 },
        duration_ms: 1,
        error_code: 'OBS_INVALID_SOURCE_RESULT',
        reason: 'OBS_INVALID_SOURCE_RESULT',
        next_retry_at: expect.stringMatching(/^2026-08-18T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
        stale: true,
        message: '该来源同步失败；已保留安全诊断信息。',
      });
      expect(outcome.error_code === null || typeof outcome.error_code === 'string').toBe(true);
    }
    expect(syncSourceOutcome('owner_dm', { skipped: true, reason: 'scan_disabled', messages: 0, failures: 0 }, 1))
      .toMatchObject({ status: 'skipped', counts: {}, error_code: 'OBS_SYNC_DISABLED', message: '该来源本轮未执行。' });
    expect(syncSourceOutcome('owner_dm', { skipped: false, messages: 0, failures: 0 }, 1))
      .toMatchObject({ status: 'success', counts: {}, error_code: null, message: '该来源同步成功。' });
    expect(syncSourceOutcome('owner_dm', { skipped: false, reason: 'sync_failed', messages: 1, detailFailures: 1 }, 1))
      .toMatchObject({ source: 'owner_dm', status: 'partial_success', counts: { messages: 1, detailFailures: 1 }, duration_ms: 1, error_code: 'FEISHU_SYNC_PARTIAL', reason: 'FEISHU_SYNC_PARTIAL', stale: true, message: '该来源部分成功；失败项已保留供后续重试。' });
    expect(syncSourceOutcome('calendar', { skipped: false, reason: 'sync_token_missing', failures: 1 }, 1))
      .toMatchObject({ source: 'calendar', status: 'failure', counts: { failures: 1 }, duration_ms: 1, error_code: 'FEISHU_SYNC_FAILED', reason: 'FEISHU_SYNC_FAILED', stale: true, message: '该来源同步失败；已保留安全诊断信息。' });
  });

  it('allSettled 一来源拒绝时为部分成功，全部拒绝时为失败且兼容 totals 计数准确', async () => {
    const success = (value: object) => ({ runAfterCurrent: async () => value });
    Object.defineProperties(service, {
      feishuOwnerSync: { configurable: true, value: success({ messages: 2, failures: 0, skipped: false, owner: { openId: 'aggregate-open-canary-58' }, providerBody: 'aggregate-body-canary-58' }) },
      feishuSync: { configurable: true, value: { runAfterCurrent: async () => { throw new Error('synthetic-one-rejected-58'); } } },
      feishuCalendarSync: { configurable: true, value: success({ events: 1, failures: 0, skipped: false }) },
      feishuMinutesSync: { configurable: true, value: success({ minutes: 1, failures: 0, skipped: false }) },
      feishuDocumentSync: { configurable: true, value: success({ changed: 1, failures: 0, skipped: false }) },
    });
    const app = await buildApp(service, { serveWeb: false });
    const partialResponse = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sync' });
    const partial = partialResponse.json();
    expect(partialResponse.statusCode).toBe(200);
    expect(partial).toMatchObject({ outcome: 'partial_success', messages: 4, failures: 1, skipped: false });
    expect(partial.sources.find((item: { source: string }) => item.source === 'bot_supplement')).toMatchObject({ status: 'failure', counts: { failures: 1 } });
    for (const rawField of ['owner', 'supplement', 'calendar', 'minutes', 'documents', 'result', 'ownerInformation']) {
      expect(partial).not.toHaveProperty(rawField);
    }
    expect(partialResponse.body).not.toMatch(/aggregate-(?:open|body)-canary-58/u);

    const reject = { runAfterCurrent: async () => { throw new Error('synthetic-all-rejected-58'); } };
    Object.defineProperties(service, {
      feishuOwnerSync: { configurable: true, value: reject },
      feishuSync: { configurable: true, value: reject },
      feishuCalendarSync: { configurable: true, value: reject },
      feishuMinutesSync: { configurable: true, value: reject },
      feishuDocumentSync: { configurable: true, value: reject },
    });
    const failedResponse = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sync' });
    const failed = failedResponse.json();
    expect(failedResponse.statusCode).toBe(200);
    expect(failed).toMatchObject({ outcome: 'failure', messages: 0, failures: 5, skipped: false });
    expect(failed.sources.every((item: { status: string; counts: { failures: number } }) => item.status === 'failure' && item.counts.failures === 1)).toBe(true);
    await app.close();
  });

  it('operation_id 和 request_id 由后端生成并保持在操作结果中', () => {
    const requestId = randomUUID();
    const result = operationEnvelope({
      requestId,
      startedAt: Date.now(),
      sources: [syncSourceOutcome('calendar', { events: 1, skipped: false }, 1)],
      release: service.releaseIdentity(),
    });
    expect(result.request_id).toBe(requestId);
    expect(result.operation_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.release).toEqual({ app_version: '0.2.0', build_identity: 'synthetic-build-58', redaction_schema_version: '1' });
  });

  it('API 到同步 runner 保持同一 operation/request/trace 链，不在下游生成无关标识', async () => {
    const traceId = '33333333-3333-4333-8333-333333333333';
    const parentSpanId = '44444444-4444-4444-8444-444444444444';
    const contexts: Array<Record<string, unknown>> = [];
    const result = { messages: 1, failures: 0, skipped: false };
    const capture = (...args: unknown[]) => {
      const context = args.at(-1);
      if (context && typeof context === 'object') contexts.push(context as Record<string, unknown>);
      return Promise.resolve(result);
    };
    const app = await buildApp(service, { serveWeb: false });
    Object.defineProperties(service, {
      feishuOwnerSync: { configurable: true, value: { runAfterCurrent: capture } },
      feishuSync: { configurable: true, value: { runAfterCurrent: capture } },
      feishuCalendarSync: { configurable: true, value: { runAfterCurrent: capture } },
      feishuMinutesSync: { configurable: true, value: { runAfterCurrent: capture } },
      feishuDocumentSync: { configurable: true, value: { runAfterCurrent: capture } },
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sync', headers: { 'x-trace-id': traceId, 'x-parent-span-id': parentSpanId } });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { operation_id: string; request_id: string; trace_id: string; span_id: string };
      expect(body.trace_id).toBe(traceId);
      expect(contexts).toHaveLength(5);
      for (const context of contexts) {
        expect(context).toMatchObject({ operation_id: body.operation_id, request_id: body.request_id, trace_id: traceId, parent_span_id: body.span_id });
        expect(context.span_id).not.toBe(body.span_id);
      }
    } finally {
      await app.close();
    }
  });

  it('Runtime/job 持久化 canonical trace，缺失 envelope 时保持 null 而不回退到 jobId', () => {
    const runtime = new PmRuntime(database);
    const traceId = '55555555-5555-4555-8555-555555555555';
    const canonical = createOperationContext({
      requestId: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
      traceId,
      parentSpanId: '88888888-8888-4888-8888-888888888888',
    });
    const bound = runtime.begin({
      jobType: 'classify_source',
      payload: { observability: canonical },
      traceId: canonical.trace_id,
      idempotencyKey: 'observability-canonical-trace-58',
    });
    const boundRow = database.raw.prepare('SELECT id, trace_id, payload_json FROM job WHERE id = ?').get(bound.id) as { id: string; trace_id: string | null; payload_json: string };
    expect(boundRow.trace_id).toBe(traceId);
    expect(JSON.parse(boundRow.payload_json)).toMatchObject({ observability: canonical });

    const noEnvelope = runtime.begin({ jobType: 'classify_source', idempotencyKey: 'observability-null-trace-58' });
    const noEnvelopeRow = database.raw.prepare('SELECT id, trace_id FROM job WHERE id = ?').get(noEnvelope.id) as { id: string; trace_id: string | null };
    expect(noEnvelopeRow.trace_id).toBeNull();
    expect(noEnvelopeRow.trace_id).not.toBe(noEnvelopeRow.id);
  });

  it('直接 ingestion 与 reprocess 都把同一 envelope trace 写入 durable Runtime job', async () => {
    const traceId = '99999999-9999-4999-8999-999999999999';
    const operationContext = createOperationContext({
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      traceId,
    });
    const event = {
      externalId: 'observability-trace-source-58',
      sourceType: 'owner_dm' as const,
      conversationId: 'observability-trace-chat-58',
      senderId: 'observability-requester-58',
      senderName: '测试请求方',
      content: '请分析活动留存数据并给出预算建议。',
      occurredAt: new Date().toISOString(),
      completeness: 'complete' as const,
    };
    const first = await service.ingestSource(event, undefined, {}, operationContext);
    const classifyJob = database.raw.prepare("SELECT trace_id, payload_json FROM job WHERE job_type IN ('classify_source','classify_source_batch') ORDER BY created_at DESC LIMIT 1").get() as { trace_id: string | null; payload_json: string };
    expect(classifyJob.trace_id).toBe(traceId);
    expect(JSON.parse(classifyJob.payload_json)).toMatchObject({ observability: operationContext });
    const candidate = first.candidate ?? first.candidates?.[0];
    expect(candidate).toBeTruthy();
    await service.reprocessCandidate(candidate!.id, '补充同一条操作链路。', undefined, candidate!.version, operationContext);
    const reprocessJob = database.raw.prepare("SELECT trace_id, payload_json FROM job WHERE job_type = 'reprocess_candidate' ORDER BY created_at DESC LIMIT 1").get() as { trace_id: string | null; payload_json: string };
    expect(reprocessJob.trace_id).toBe(traceId);
    expect(JSON.parse(reprocessJob.payload_json)).toMatchObject({ observability: operationContext });
  });

  it('readiness 在正常、来源降级和 Runtime 失败间稳定转换', () => {
    expect(service.readiness()).toEqual({ status: 'ready', reasons: [] });
    database.raw.prepare("UPDATE information_source_state SET status = 'partial' WHERE source_kind = 'calendar'").run();
    expect(service.readiness()).toMatchObject({ status: 'degraded', reasons: [{ code: 'SOURCE_PARTIAL' }] });
    database.raw.prepare("UPDATE information_source_state SET status = 'ready' WHERE source_kind = 'calendar'").run();
    const timestamp = new Date().toISOString();
    database.raw.prepare(`INSERT INTO job
      (id, job_type, payload_json, status, attempts, available_at, max_attempts, retryable, backoff_seconds, created_at, updated_at)
      VALUES ('job-observability-58', 'classify_source', '{}', 'failed', 3, ?, 3, 1, 30, ?, ?)`)
      .run(timestamp, timestamp, timestamp);
    expect(service.readiness()).toMatchObject({ status: 'degraded', reasons: [{ code: 'RUNTIME_FAILED_JOBS' }] });
  });

  it('readiness 对缺表和查询异常统一返回 DATABASE_UNAVAILABLE，API 不泄露底层原因', async () => {
    const app = await buildApp(service, { serveWeb: false });
    const canary = 'C:/private/sqlite-canary-58?token=secret';
    const originalPrepare = database.raw.prepare.bind(database.raw);
    const spy = vi.spyOn(database.raw, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('FROM job')) throw new Error(canary);
      return originalPrepare(sql);
    });
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json().readiness).toEqual({ status: 'not_ready', reasons: [{ code: 'DATABASE_UNAVAILABLE', message: '本地数据库当前不可用。' }] });
      expect(health.body).not.toContain(canary);
    } finally {
      spy.mockRestore();
      await app.close();
    }

    database.raw.exec('DROP TABLE information_source_state');
    expect(service.readiness()).toEqual({ status: 'not_ready', reasons: [{ code: 'DATABASE_UNAVAILABLE', message: '本地数据库当前不可用。' }] });
    const missingTableApp = await buildApp(service, { serveWeb: false });
    try {
      const health = await missingTableApp.inject({ method: 'GET', url: '/api/health' });
      const diagnostics = await missingTableApp.inject({ method: 'GET', url: '/api/diagnostics' });
      expect(health.statusCode).toBe(200);
      expect(diagnostics.statusCode).toBe(200);
      expect(health.json().readiness).toMatchObject({ status: 'not_ready', reasons: [{ code: 'DATABASE_UNAVAILABLE' }] });
      expect(diagnostics.json().readiness).toMatchObject({ status: 'not_ready', reasons: [{ code: 'DATABASE_UNAVAILABLE' }] });
    } finally {
      await missingTableApp.close();
    }
  });

  it('required freshness/backoff query failure is observable and makes readiness not_ready', () => {
    const originalPrepare = database.raw.prepare.bind(database.raw);
    const spy = vi.spyOn(database.raw, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('SELECT source_kind, enabled, status, last_success_at, updated_at FROM information_source_state')) {
        throw new Error('synthetic-freshness-query-failure-58');
      }
      return originalPrepare(sql);
    });
    try {
      const health = service.health('observability-health-freshness-58');
      expect(health.readiness.status).toBe('not_ready');
      expect(health.readiness.reasons).toEqual(expect.arrayContaining([
        { code: 'OBS_DATA_STALE', message: '来源新鲜度当前无法确认。' },
        { code: 'OBS_RETRY_COOLDOWN', message: '来源退避状态当前无法确认。' },
      ]));
      expect(health.dependencies.freshness).toMatchObject({ status: 'unknown', error_code: 'OBS_DATA_STALE' });
      expect(health.dependencies.backoff).toMatchObject({ status: 'unknown', error_code: 'OBS_RETRY_COOLDOWN' });
    } finally {
      spy.mockRestore();
    }
  });

  it('required token query failure or unknown owner state is observable and never reports ready', () => {
    database.raw.prepare(`INSERT INTO owner_profile
      (id, open_id, name, oauth_status, granted_scopes_json, created_at, updated_at)
      VALUES ('primary', 'observability-owner-58', '测试主人', 'unknown', '[]', ?, ?)`)
      .run(new Date().toISOString(), new Date().toISOString());
    const unknownHealth = service.health('observability-health-token-unknown-58');
    expect(unknownHealth.readiness.status).toBe('not_ready');
    expect(unknownHealth.readiness.reasons).toContainEqual({ code: 'OBS_TOKEN_STATE', message: '授权状态当前无法确认。' });
    expect(unknownHealth.dependencies.token).toMatchObject({ status: 'unknown', error_code: 'OBS_TOKEN_STATE' });

    const originalPrepare = database.raw.prepare.bind(database.raw);
    const spy = vi.spyOn(database.raw, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes("SELECT oauth_status FROM owner_profile WHERE id = 'primary'")) throw new Error('synthetic-token-query-failure-58');
      return originalPrepare(sql);
    });
    try {
      const failedHealth = service.health('observability-health-token-failed-58');
      expect(failedHealth.readiness.status).toBe('not_ready');
      expect(failedHealth.readiness.reasons).toContainEqual({ code: 'OBS_TOKEN_STATE', message: '授权状态当前无法确认。' });
      expect(failedHealth.dependencies.token).toMatchObject({ status: 'unknown', error_code: 'OBS_TOKEN_STATE' });
    } finally {
      spy.mockRestore();
    }
  });

  it('required disk query failure is represented by an allowlisted reason and not_ready readiness', () => {
    const spy = vi.spyOn(service as unknown as { availableDiskBytes: () => number }, 'availableDiskBytes')
      .mockImplementation(() => { throw new Error('synthetic-disk-query-failure-58'); });
    try {
      const health = service.health('observability-health-disk-58');
      expect(health.readiness.status).toBe('not_ready');
      expect(health.readiness.reasons).toContainEqual({ code: 'OBS_DISK_UNAVAILABLE', message: '本地诊断存储状态当前无法确认。' });
      expect(health.dependencies.disk).toMatchObject({ status: 'unknown', error_code: 'OBS_DISK_UNAVAILABLE' });
    } finally {
      spy.mockRestore();
    }
  });

  it('关闭数据库后 health 和 diagnostics 仍返回固定 not_ready，不泄露 SQLite 路径或 cause', async () => {
    const closedDatabase = new AppDatabase(':memory:', false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'file:C:/private/closed-canary-58.sqlite' });
    const closedService = new PmService(closedDatabase, createAdapters(config), config);
    const app = await buildApp(closedService, { serveWeb: false });
    closedDatabase.close();
    try {
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      const diagnostics = await app.inject({ method: 'GET', url: '/api/diagnostics' });
      expect(health.statusCode).toBe(200);
      expect(diagnostics.statusCode).toBe(200);
      expect(health.json().readiness).toMatchObject({ status: 'not_ready', reasons: [{ code: 'DATABASE_UNAVAILABLE' }] });
      expect(diagnostics.json()).toMatchObject({ readiness: { status: 'not_ready', reasons: [{ code: 'DATABASE_UNAVAILABLE' }] }, counts: { sources: 0 } });
      expect(`${health.body}${diagnostics.body}`).not.toMatch(/closed-canary|database is not open|cause/iu);
    } finally {
      await app.close();
    }
  });

  it('release identity 拒绝路径、查询串和其他不安全构建标识', () => {
    expect(releaseIdentity({ appVersion: '0.2.0', buildIdentity: 'D:/Users/canary?token=secret' }))
      .toEqual({ app_version: '0.2.0', build_identity: null, redaction_schema_version: '1' });
  });

  it('API、诊断和日志序列化不泄露异常 canary', async () => {
    const canary = 'synthetic-secret-url?token=canary-58';
    database.raw.prepare(`INSERT INTO owner_profile
      (id, open_id, name, oauth_status, granted_scopes_json, created_at, updated_at)
      VALUES ('primary', 'observability-owner-58', '测试主人', 'mock', '[]', ?, ?)`)
      .run(new Date().toISOString(), new Date().toISOString());
    Object.defineProperty(service, 'feishuOwnerSync', {
      configurable: true,
      value: { runAfterCurrent: async () => { throw new Error(canary); } },
    });
    const app = await buildApp(service, { serveWeb: false });
    try {
      const failed = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sources/owner_dm/sync' });
      expect(failed.statusCode).toBe(200);
      expect(failed.json()).toMatchObject({ outcome: 'failure', sources: [{ source: 'owner_dm', error_code: 'OBS_INTERNAL_FAILURE' }] });
      expect(failed.body).not.toContain(canary);

      const diagnostics = await app.inject({ method: 'GET', url: '/api/diagnostics' });
      const health = await app.inject({ method: 'GET', url: '/api/health' });
      const logs = await app.inject({ method: 'GET', url: '/api/logs' });
      expect(`${diagnostics.body}${health.body}${logs.body}`).not.toContain(canary);
      expect(diagnostics.json()).toMatchObject({ release: { app_version: '0.2.0', build_identity: 'synthetic-build-58', redaction_schema_version: '1' } });
      expect(health.json()).toMatchObject({ liveness: { status: 'alive' }, readiness: { status: 'ready' } });
      expect(diagnostics.json().request_id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(health.json().request_id).toMatch(/^[0-9a-f-]{36}$/u);
    } finally {
      await app.close();
    }
  });

  it('同步 safe DTO 与日志不包含外部身份、provider body、raw result 或来源数组', async () => {
    const canaries = ['calendar-canary-58', 'open-canary-58', 'union-canary-58', 'user-canary-58', 'tenant-canary-58', 'provider-body-canary-58'];
    Object.defineProperty(service, 'feishuCalendarSync', {
      configurable: true,
      value: { runAfterCurrent: async () => ({
        events: 1,
        failures: 0,
        skipped: false,
        calendarId: canaries[0],
        openId: canaries[1],
        unionId: canaries[2],
        userId: canaries[3],
        tenantKey: canaries[4],
        body: canaries[5],
      }) },
    });
    const app = await buildApp(service, { serveWeb: false });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sources/calendar/sync' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ outcome: 'success', messages: 1, failures: 0, sources: [{ source: 'calendar', counts: { events: 1 } }] });
      expect(response.json()).not.toHaveProperty('result');
      expect(response.json()).not.toHaveProperty('ownerInformation');
      for (const canary of canaries) expect(response.body).not.toContain(canary);
      expect(response.body).not.toMatch(/calendarId|openId|unionId|userId|tenantKey|provider-body/iu);

      const row = database.raw.prepare("SELECT context_json FROM app_log WHERE event_type = 'feishu.source_sync.completed' ORDER BY created_at DESC LIMIT 1").get() as { context_json: string };
      const context = JSON.parse(row.context_json) as Record<string, unknown>;
      expect(context).toMatchObject({ outcome: 'success', failures: 0 });
      expect(context.sources).toBeUndefined();
      for (const canary of canaries) expect(row.context_json).not.toContain(canary);
    } finally {
      await app.close();
    }
  });

  it('aggregate 与单来源共用入口判断，sync/async null/undefined 均归真实 source failure', async () => {
    const success = (value: object) => ({ runAfterCurrent: async () => value });
    Object.defineProperties(service, {
      feishuOwnerSync: { configurable: true, value: success({ messages: 1, failures: 0, skipped: false }) },
      feishuSync: { configurable: true, value: success({ messages: 1, failures: 0, skipped: false }) },
      feishuMinutesSync: { configurable: true, value: success({ minutes: 1, failures: 0, skipped: false }) },
      feishuDocumentSync: { configurable: true, value: success({ changed: 1, failures: 0, skipped: false }) },
    });
    const app = await buildApp(service, { serveWeb: false });
    try {
      const invalidRunners = [
        ['sync null', { runAfterCurrent: () => null }],
        ['sync undefined', { runAfterCurrent: () => undefined }],
        ['async null', { runAfterCurrent: async () => null }],
        ['async undefined', { runAfterCurrent: async () => undefined }],
      ] as const;
      for (const [_label, runner] of invalidRunners) {
        Object.defineProperty(service, 'feishuCalendarSync', { configurable: true, value: runner });
        const single = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sources/calendar/sync' });
        expect(single.statusCode).toBe(200);
        expect(single.json()).toMatchObject({
          outcome: 'failure',
          failures: 1,
          skipped: false,
          sources: [{ source: 'calendar', status: 'failure', counts: { failures: 1 }, error_code: 'OBS_INVALID_SOURCE_RESULT', message: '该来源同步失败；已保留安全诊断信息。' }],
        });
        const aggregate = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sync' });
        expect(aggregate.statusCode).toBe(200);
        expect(aggregate.json()).toMatchObject({ outcome: 'partial_success', failures: 1, skipped: false });
        expect(aggregate.json().sources.find((item: { source: string }) => item.source === 'calendar')).toMatchObject({
          source: 'calendar', status: 'failure', counts: { failures: 1 }, error_code: 'OBS_INVALID_SOURCE_RESULT', message: '该来源同步失败；已保留安全诊断信息。',
        });
      }

      Object.defineProperty(service, 'feishuCalendarSync', { configurable: true, value: undefined });
      const singleMissing = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sources/calendar/sync' });
      expect(singleMissing.json()).toMatchObject({
        outcome: 'skipped',
        failures: 0,
        skipped: true,
        sources: [{ source: 'calendar', status: 'skipped', error_code: 'OBS_ADAPTER_UNAVAILABLE' }],
      });
      const aggregateMissing = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sync' });
      expect(aggregateMissing.json().sources.find((item: { source: string }) => item.source === 'calendar')).toMatchObject({
        source: 'calendar', status: 'skipped', counts: {}, error_code: 'OBS_ADAPTER_UNAVAILABLE', message: '该来源本轮未执行。',
      });

      const throwCanary = 'synthetic-sync-throw-canary-58';
      Object.defineProperty(service, 'feishuCalendarSync', { configurable: true, value: { runAfterCurrent: () => { throw new Error(throwCanary); } } });
      const singleThrow = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sources/calendar/sync' });
      const aggregateThrow = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sync' });
      for (const response of [singleThrow, aggregateThrow]) {
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain(throwCanary);
        expect(response.json().sources.find((item: { source: string }) => item.source === 'calendar')).toMatchObject({ status: 'failure', counts: { failures: 1 }, error_code: 'OBS_INTERNAL_FAILURE' });
      }
    } finally {
      await app.close();
    }
  });

  it('API 对 hostile fulfilled 结果 fail-closed，日志不执行或泄露 getter/Proxy canary', async () => {
    let getterCalls = 0;
    const getterCanary = 'synthetic-api-getter-canary-58';
    const getter = Object.defineProperty({}, 'events', {
      get() {
        getterCalls += 1;
        throw new Error(getterCanary);
      },
    });
    let proxyCalls = 0;
    const proxyCanary = 'synthetic-api-proxy-canary-58';
    const proxy = new Proxy({ events: 1 }, {
      get(target, property, receiver) {
        if (property === 'then') return undefined;
        proxyCalls += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor() {
        proxyCalls += 1;
        throw new Error(proxyCanary);
      },
    });
    const values: unknown[] = [getter, proxy, [], 1, { events: '1', skipped: false }, Object.defineProperty({}, 'skipped', { get: () => true })];
    Object.defineProperty(service, 'feishuCalendarSync', {
      configurable: true,
      value: { runAfterCurrent: async () => values.shift() },
    });
    const app = await buildApp(service, { serveWeb: false });
    try {
      for (let index = 0; index < 6; index += 1) {
        const response = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sources/calendar/sync' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ outcome: 'failure', failures: 1, sources: [{ source: 'calendar', error_code: 'OBS_INVALID_SOURCE_RESULT' }] });
        expect(response.body).not.toMatch(/synthetic-api-(?:getter|proxy)-canary-58/u);
      }
      expect(getterCalls).toBe(0);
      expect(proxyCalls).toBe(0);
      const logs = await app.inject({ method: 'GET', url: '/api/logs' });
      expect(logs.body).not.toContain(getterCanary);
      expect(logs.body).not.toContain(proxyCanary);
    } finally {
      await app.close();
    }
  });
});
