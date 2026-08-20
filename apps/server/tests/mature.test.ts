import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';
import { registerSimulatedMessageRoute } from './support/simulated-message-route.js';

describe('M1 日志、纠错和只读工作区闭环', () => {
  let database: AppDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let service: PmService;
  let tempWorkspace: string;

  beforeEach(async () => {
    tempWorkspace = join(tmpdir(), `ai-pm-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(join(tempWorkspace, 'reports'), { recursive: true });
    await writeFile(join(tempWorkspace, 'reports', 'summary.md'), '# mock report\n', 'utf8');
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', WORKSPACE_READ_ENABLED: 'true', WORKSPACE_ALLOWED_PATHS: JSON.stringify([tempWorkspace]) });
    database = new AppDatabase(':memory:', false);
    service = new PmService(database, createAdapters(config), config);
    app = await buildApp(service, { serveWeb: false });
    registerSimulatedMessageRoute(app, service, {
      testOnly: true,
      nodeEnv: config.nodeEnv,
      databaseProvider: config.database.provider,
      databaseUrl: config.database.url,
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
    await rm(tempWorkspace, { recursive: true, force: true });
  });

  const simulate = async (externalId: string, content = '请分析新活动的留存数据，验证是否值得继续投入。') => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/dev/simulate-message',
      payload: {
        externalId,
        sourceType: 'owner_dm',
        conversationId: 'mock-chat',
        senderId: 'mock-user',
        senderName: '测试需求方',
        content,
        occurredAt: new Date().toISOString(),
      },
    });
    return response.json() as { candidate: { id: string; source_event_id: string; version: number } | null };
  };

  it('写入 AI 审计和运行日志，但诊断包不包含原文、密钥或绝对路径', async () => {
    await simulate('mature-log-1', '这是绝对路径 C:\\private\\secret.txt，请分析数据。');
    const diagnostics = await app.inject({ method: 'GET', url: '/api/diagnostics' });
    expect(diagnostics.statusCode).toBe(200);
    const text = diagnostics.body;
    expect(text).not.toContain('private');
    expect(text).not.toContain('secret.txt');
    expect(diagnostics.json().privacy).toEqual({ rawMessagesIncluded: false, secretsIncluded: false, absolutePathsIncluded: false });
    const logs = await app.inject({ method: 'GET', url: '/api/logs' });
    expect(logs.json().decisions).toHaveLength(1);
    expect(logs.json().logs.length).toBeGreaterThanOrEqual(2);
  });

  it('同一合成敏感夹具在落库、日志接口和诊断导出中都保持脱敏', async () => {
    const canaries = [
      'synthetic-summary-bearer-32',
      'synthetic-nested-secret-32',
      'synthetic-array-body-32',
      'synthetic-query-value-32',
      'SyntheticProfile32',
    ];
    const writeLog = service as unknown as {
      log: (category: string, level: 'error', eventType: string, summary: string, context: Record<string, unknown>) => void;
    };
    writeLog.log(
      'runtime',
      'error',
      'redaction.synthetic_fixture',
      'provider failed Bearer synthetic-summary-bearer-32',
      {
        details: {
          clientSecret: 'synthetic-nested-secret-32',
          errors: [{ responseBody: 'synthetic-array-body-32' }],
          message: 'callback https://example.invalid/cb?code=synthetic-query-value-32',
          filePath: 'C:\\SyntheticProfile32\\private\\fixture.txt',
        },
      },
    );

    const stored = database.raw.prepare("SELECT summary, context_json FROM app_log WHERE event_type = 'redaction.synthetic_fixture'").get() as Record<string, unknown>;
    const logs = await app.inject({ method: 'GET', url: '/api/logs?level=error' });
    const diagnostics = await app.inject({ method: 'GET', url: '/api/diagnostics' });
    const surfaces = [JSON.stringify(stored), logs.body, diagnostics.body];
    for (const surface of surfaces) {
      for (const canary of canaries) expect(surface).not.toContain(canary);
    }
    expect(JSON.parse(String(stored.context_json)).redactionSchemaVersion).toBe('1');
    expect(logs.json().redactionSchemaVersion).toBe('1');
    expect(() => JSON.parse(logs.json().logs[0].context_json)).not.toThrow();
    expect(diagnostics.json().redactionSchemaVersion).toBe('1');
  });

  it('读取历史旁路日志和健康记录时再次脱敏且不增加诊断采集字段', async () => {
    database.raw.prepare('INSERT INTO app_log (id, category, level, event_type, summary, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-redaction-fixture', 'runtime', 'error', 'legacy.fixture', 'Bearer synthetic-legacy-summary-32', JSON.stringify({ details: { accessToken: 'synthetic-legacy-context-32' } }), new Date().toISOString());
    database.raw.prepare('INSERT INTO integration_health (id, integration, status, message, details_json, latency_ms, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('legacy-health-fixture', 'llm', 'unavailable', 'Authorization: Bearer synthetic-legacy-health-32', JSON.stringify({ responseBody: 'synthetic-legacy-details-32' }), 1, new Date().toISOString());

    const logs = await app.inject({ method: 'GET', url: '/api/logs' });
    const health = await app.inject({ method: 'GET', url: '/api/integrations/health' });
    const diagnostics = await app.inject({ method: 'GET', url: '/api/diagnostics' });
    const combined = `${logs.body}\n${health.body}\n${diagnostics.body}`;
    for (const canary of [
      'synthetic-legacy-summary-32',
      'synthetic-legacy-context-32',
      'synthetic-legacy-health-32',
      'synthetic-legacy-details-32',
    ]) expect(combined).not.toContain(canary);
    expect(Object.keys(diagnostics.json()).sort()).toEqual([
      'configuration', 'counts', 'diagnosticBundleVersion', 'generatedAt', 'health', 'limits', 'operation_id', 'privacy', 'readiness', 'recentErrors',
      'recentEvents', 'redactionSchemaVersion', 'release', 'request_id', 'summaries', 'trace_id',
    ]);
  });

  it('诊断导出对 plain Error 和未知运行字段使用固定受控占位', async () => {
    database.raw.prepare('INSERT INTO app_log (id, category, level, event_type, summary, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('plain-error-export-fixture', 'unknown-category', 'error', 'unknown-event-type', 'plain-error-export-canary-58', JSON.stringify({ unknownField: 'refresh_token app_secret client_secret Bearer' }), 'not-a-timestamp');
    const diagnostics = await app.inject({ method: 'GET', url: '/api/diagnostics' });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.body).not.toMatch(/plain-error-export-canary-58|refresh_token|app_secret|client_secret|Bearer|unknown-event-type/u);
    expect(diagnostics.json().recentErrors[0]).toMatchObject({ category: 'unknown', level: 'error', summary: '已记录一条受控运行错误。' });
  });

  it('合成供应商连接错误在返回和写入健康表前即完成脱敏', async () => {
    const localDatabase = new AppDatabase(':memory:', false);
    const localConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const adapters = createAdapters(localConfig);
    Object.assign(adapters.classifier, {
      testConnection: async () => ({
        ok: false,
        status: 'unavailable' as const,
        message: 'Authorization: Bearer synthetic-provider-message-32',
        checkedAt: new Date().toISOString(),
        details: {
          headers: { authorization: 'Bearer synthetic-provider-header-32' },
          responseBody: 'synthetic-provider-body-32',
        },
      }),
    });
    const localService = new PmService(localDatabase, adapters, localConfig);
    const result = await localService.testIntegration('llm');
    const health = localDatabase.raw.prepare('SELECT message, details_json FROM integration_health WHERE integration = ?').get('llm');
    const log = localDatabase.raw.prepare("SELECT summary, context_json FROM app_log WHERE event_type = 'integration.checked'").get();
    const surface = JSON.stringify({ result, health, log });
    for (const canary of [
      'synthetic-provider-message-32',
      'synthetic-provider-header-32',
      'synthetic-provider-body-32',
    ]) expect(surface).not.toContain(canary);
    expect(result.details?.redactionSchemaVersion).toBe('1');
    localDatabase.close();
  });

  it('日志 API 为 decisions/corrections 保留不同内部 key，同时丢弃外部 ID 和自由备注', async () => {
    const insertDecision = database.raw.prepare(
      `INSERT INTO ai_decision_log
       (id, provider, model, prompt_version, is_data_request, confidence, reason, output_json,
        used_fallback, http_status, provider_request_id, attempts, structured_mode, input_hash,
        input_char_count, fallback_mode, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertDecision.run('decision-log-32-a', 'provider-a', 'model-a', 'prompt-v1', 1, 0.9, 'synthetic reason', '{}', 0, 200, 'synthetic-provider-request-32-a', 1, 'json_schema', 'a'.repeat(64), 120, 'llm', 10, '2026-08-14T10:00:00.000Z');
    insertDecision.run('decision-log-32-b', 'provider-b', 'model-b', 'prompt-v2', 0, 0.8, 'synthetic reason', '{}', 1, 429, 'synthetic-provider-request-32-b', 2, 'json_object', 'b'.repeat(64), 80, 'rule_fallback', 20, '2026-08-14T10:01:00.000Z');
    const insertCorrection = database.raw.prepare(
      `INSERT INTO correction_event
       (id, correction_type, after_json, created_at, idempotency_key, note, visibility, operation)
       VALUES (?, ?, '{}', ?, ?, ?, 'private', 'apply')`,
    );
    insertCorrection.run('correction-log-32-a', 'wrong_fields', '2026-08-14T10:02:00.000Z', 'synthetic-idempotency-32-a', 'synthetic-sensitive-note-32-a');
    insertCorrection.run('correction-log-32-b', 'describe_incomplete', '2026-08-14T10:03:00.000Z', 'synthetic-idempotency-32-b', 'synthetic-sensitive-note-32-b');

    const response = await app.inject({ method: 'GET', url: '/api/logs' });
    const payload = response.json();
    expect(response.statusCode).toBe(200);
    expect(payload.decisions.map((row: { id: string }) => row.id)).toEqual(['decision-log-32-b', 'decision-log-32-a']);
    expect(new Set(payload.decisions.map((row: { id: string }) => row.id)).size).toBe(2);
    expect(payload.decisions[0]).toMatchObject({ provider: 'provider-b', model: 'model-b', prompt_version: 'prompt-v2', used_fallback: true, input_char_count: 80 });
    expect(payload.decisions[0].provider_request_id).toBeUndefined();
    expect(payload.corrections.map((row: { id: string }) => row.id)).toEqual(['correction-log-32-b', 'correction-log-32-a']);
    expect(new Set(payload.corrections.map((row: { id: string }) => row.id)).size).toBe(2);
    expect(payload.corrections[0]).toMatchObject({ correction_type: 'describe_incomplete', note: '<redacted>' });
    expect(payload.corrections[0].idempotency_key).toBeUndefined();
    const text = response.body;
    for (const canary of [
      'synthetic-provider-request-32-a',
      'synthetic-provider-request-32-b',
      'synthetic-idempotency-32-a',
      'synthetic-idempotency-32-b',
      'synthetic-sensitive-note-32-a',
      'synthetic-sensitive-note-32-b',
    ]) expect(text).not.toContain(canary);
  });

  it('日志支持时间筛选、配置保留期限和一键删除诊断记录', async () => {
    await simulate('mature-log-filter-1');
    const recentFrom = new Date(Date.now() - 60_000).toISOString();
    const recent = await app.inject({ method: 'GET', url: `/api/logs?from=${encodeURIComponent(recentFrom)}` });
    expect(recent.statusCode).toBe(200);
    expect(recent.json().decisions.length).toBeGreaterThanOrEqual(1);
    const futureFrom = new Date(Date.now() + 60_000).toISOString();
    const future = await app.inject({ method: 'GET', url: `/api/logs?from=${encodeURIComponent(futureFrom)}` });
    expect(future.json().logs).toHaveLength(0);
    expect(future.json().decisions).toHaveLength(0);
    expect(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', LOG_RETENTION_DAYS: '45' }).logging.retentionDays).toBe(45);
    const cleared = await app.inject({ method: 'DELETE', url: '/api/logs?includeCorrections=false' });
    expect(cleared.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/logs' });
    expect(after.json().logs).toHaveLength(0);
    expect(after.json().decisions).toHaveLength(0);
    expect(after.json().health).toHaveLength(0);
  });

  it('服务启动时按保留天数自动轮转过期运行日志', () => {
    const localDatabase = new AppDatabase(':memory:', false);
    localDatabase.raw.prepare('INSERT INTO app_log (id, category, level, event_type, summary, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('old-log', 'runtime', 'info', 'old.event', '过期日志', '{}', '2020-01-01T00:00:00.000Z');
    const localConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', LOG_RETENTION_DAYS: '7' });
    new PmService(localDatabase, createAdapters(localConfig), localConfig);
    expect(localDatabase.raw.prepare('SELECT id FROM app_log WHERE id = ?').get('old-log')).toBeUndefined();
    localDatabase.close();
  });

  it('只读 reference path 可以扫描元数据，且不会把任务改成完成', async () => {
    const created = await simulate('mature-reference-1');
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${created.candidate!.id}/action`, payload: { action: 'accept', expectedVersion: created.candidate!.version } });
    const taskId = accepted.json().task.id as string;
    const reference = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/references`, payload: { label: '测试工作目录', referencePath: tempWorkspace, accessMode: 'readonly' } });
    const referenceId = reference.json().id as string;
    const inspected = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/references/${referenceId}/inspect` });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().entries.some((entry: { relativePath: string }) => entry.relativePath.endsWith('summary.md'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json().status).toBe('unplanned');
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM reference_snapshot').get() as { count: number }).count).toBe(1);
  });

  it('纠错只改变私人 PM 记录，不新增任何外发 outbox', async () => {
    const created = await simulate('mature-correction-1');
    const beforeOutbox = (database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count;
    const correction = await app.inject({ method: 'POST', url: '/api/corrections', payload: { correctionType: 'describe_incomplete', candidateId: created.candidate!.id, expectedCandidateVersion: created.candidate!.version, replacementValue: '补充后的简洁需求描述。', note: '人工确认背景后修正。' } });
    expect(correction.statusCode).toBe(200);
    expect(correction.json().candidate.describe).toBe('补充后的简洁需求描述。');
    const afterOutbox = (database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count;
    expect(afterOutbox).toBe(beforeOutbox);
    expect((await app.inject({ method: 'GET', url: '/api/corrections' })).json().items).toHaveLength(1);
  });

  it('漏掉的需求可以人工补录，重复提交幂等且不伪造原始来源', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: {
        correctionType: 'missed_request',
        idempotencyKey: 'manual-missed-1',
        manualContent: '请补一份活动留存分析，确认是否值得继续投入。',
        manualSenderName: '人工补录需求方',
        manualSourceType: 'owner_dm',
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().candidate.proposer_name).toBe('需求方');
    const second = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: {
        correctionType: 'missed_request',
        idempotencyKey: 'manual-missed-1',
        manualContent: '不应重复创建。',
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    const source = database.raw.prepare('SELECT source_type, conversation_id FROM source_event WHERE external_id = ?').get('manual-correction:manual-missed-1') as { source_type: string; conversation_id: string };
    expect(source).toEqual({ source_type: 'manual', conversation_id: 'manual-entry' });
  });

  it('任务关联纠错只移动来源链，不发送任何外部动作', async () => {
    const first = await simulate('association-source-1');
    const second = await simulate('association-source-2');
    const firstTaskResponse = await app.inject({ method: 'POST', url: `/api/candidates/${first.candidate!.id}/action`, payload: { action: 'accept', expectedVersion: first.candidate!.version } });
    const secondTaskResponse = await app.inject({ method: 'POST', url: `/api/candidates/${second.candidate!.id}/action`, payload: { action: 'accept', expectedVersion: second.candidate!.version } });
    const firstTask = firstTaskResponse.json().task.id as string;
    const secondTask = secondTaskResponse.json().task.id as string;
    const missingSource = await app.inject({ method: 'POST', url: '/api/corrections', payload: { correctionType: 'wrong_association', taskId: firstTask, targetTaskId: secondTask } });
    expect(missingSource.statusCode).toBe(400);
    const result = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: {
        correctionType: 'wrong_association',
        taskId: firstTask,
        targetTaskId: secondTask,
        sourceEventId: first.candidate!.source_event_id,
        expectedTaskVersion: firstTaskResponse.json().task.version,
        expectedTargetTaskVersion: secondTaskResponse.json().task.version,
        idempotencyKey: 'association-fix-1',
      },
    });
    expect(result.statusCode).toBe(200);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM task_source_link WHERE task_id = ?').get(firstTask) as { count: number }).count).toBe(0);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM task_source_link WHERE task_id = ?').get(secondTask) as { count: number }).count).toBe(2);
    expect((database.raw.prepare('SELECT accepted_task_id FROM candidate_request WHERE id = ?').get(first.candidate!.id) as { accepted_task_id: string }).accepted_task_id).toBe(secondTask);
    expect((database.raw.prepare("SELECT COUNT(*) AS count FROM task_event WHERE event_type = 'correction_recorded' AND task_id IN (?, ?)").get(firstTask, secondTask) as { count: number }).count).toBe(2);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count).toBe(0);
  });

  it('已接受候选可以安全标记为无效记录并保留完整审计来源', async () => {
    const created = await simulate('accepted-false-positive');
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${created.candidate!.id}/action`, payload: { action: 'accept', expectedVersion: created.candidate!.version } });
    const taskId = accepted.json().task.id as string;
    const draft = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/external-actions`, payload: { actionType: 'draft_status_update', payload: { note: '仅本地草稿' } } });
    const ignored = await app.inject({ method: 'POST', url: `/api/candidates/${created.candidate!.id}/action`, payload: { action: 'ignore', expectedVersion: accepted.json().candidate.version } });
    expect(ignored.statusCode).toBe(409);
    const result = await app.inject({ method: 'POST', url: '/api/corrections', payload: { correctionType: 'false_positive', candidateId: created.candidate!.id, expectedCandidateVersion: accepted.json().candidate.version, expectedTaskVersion: accepted.json().task.version } });
    expect(result.statusCode).toBe(200);
    expect(result.json().task.record_state).toBe('invalidated');
    expect(result.json().task.status).toBe('archived');
    expect((database.raw.prepare('SELECT state, accepted_task_id FROM candidate_request WHERE id = ?').get(created.candidate!.id) as { state: string; accepted_task_id: string }).state).toBe('ignored');
    expect((database.raw.prepare('SELECT record_state, archived_at FROM task WHERE id = ?').get(taskId) as { record_state: string; archived_at: string | null }).record_state).toBe('invalidated');
    expect(database.raw.prepare('SELECT task_id FROM task_source_link WHERE task_id = ? AND source_event_id = ?').get(taskId, created.candidate!.source_event_id)).toBeTruthy();
    expect((database.raw.prepare("SELECT COUNT(*) AS count FROM task_event WHERE task_id = ? AND event_type = 'correction_recorded'").get(taskId) as { count: number }).count).toBe(1);
    expect((database.raw.prepare('SELECT status FROM approval WHERE id = ?').get(draft.json().approvalId) as { status: string }).status).toBe('rejected');
    expect((database.raw.prepare('SELECT status FROM outbox WHERE id = ?').get(draft.json().outboxId) as { status: string }).status).toBe('failed');
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard' })).json().today.some((item: { id: string }) => item.id === taskId)).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/calendar' })).json().days
      .flatMap((day: { items: Array<{ id: string }> }) => day.items)
      .some((item: { id: string }) => item.id === taskId)).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/tasks?recordState=active' })).json().items.some((item: { id: string }) => item.id === taskId)).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/tasks?recordState=invalidated' })).json().items.some((item: { id: string }) => item.id === taskId)).toBe(true);
    const external = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/external-actions`, payload: { actionType: 'draft_status_update' } });
    expect(external.statusCode).toBe(404);
    const repeated = await app.inject({ method: 'POST', url: '/api/corrections', payload: { correctionType: 'false_positive', taskId, expectedTaskVersion: result.json().task.version } });
    expect(repeated.statusCode).toBe(409);
  });

  it('状态排期纠错维护终态时间、拒绝空操作并检查版本', async () => {
    const created = await simulate('status-correction');
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${created.candidate!.id}/action`, payload: { action: 'accept', expectedVersion: created.candidate!.version } });
    const task = accepted.json().task as { id: string; version: number; status: string };
    const completed = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: { correctionType: 'status_or_schedule_wrong', taskId: task.id, expectedTaskVersion: task.version, replacementStatus: 'completed' },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().task.completed_at).toBeTruthy();
    const completedVersion = completed.json().task.version as number;
    const reopened = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: { correctionType: 'status_or_schedule_wrong', taskId: task.id, expectedTaskVersion: completedVersion, replacementStatus: 'in_progress' },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().task.completed_at).toBeNull();
    expect(reopened.json().task.archived_at).toBeNull();
    const noChange = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: { correctionType: 'status_or_schedule_wrong', taskId: task.id, expectedTaskVersion: reopened.json().task.version, replacementStatus: 'in_progress' },
    });
    expect(noChange.statusCode).toBe(409);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: { correctionType: 'status_or_schedule_wrong', taskId: task.id, expectedTaskVersion: task.version, replacementStatus: 'waiting' },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('排期纠错复用上海跨度边界，拒绝时保持任务和审计零写入', async () => {
    const acceptTask = async (externalId: string) => {
      const created = await simulate(externalId);
      const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${created.candidate!.id}/action`, payload: { action: 'accept', expectedVersion: created.candidate!.version } });
      return accepted.json().task as { id: string; version: number };
    };
    const setHistoricalPlan = (taskId: string, startAt: string, dueAt: string | null = null) => {
      database.raw.prepare('UPDATE task SET planned_start_at = ?, planned_due_at = ?, schedule_at = ? WHERE id = ?')
        .run(startAt, dueAt, dueAt, taskId);
    };
    const writeSnapshot = (taskId: string) => ({
      task: database.raw.prepare('SELECT status, schedule_at, planned_start_at, planned_due_at, next_step, version FROM task WHERE id = ?').get(taskId),
      correctionEvents: database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get(),
      taskEvents: database.raw.prepare('SELECT COUNT(*) AS count FROM task_event').get(),
    });
    const expectRejectedWithoutWrites = async (task: { id: string; version: number }, replacementScheduleAt: string, error: string) => {
      const before = writeSnapshot(task.id);
      const response = await app.inject({
        method: 'POST',
        url: '/api/corrections',
        payload: {
          correctionType: 'status_or_schedule_wrong',
          taskId: task.id,
          expectedTaskVersion: task.version,
          replacementScheduleAt,
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error, outcome: 'failure' });
      expect(writeSnapshot(task.id)).toEqual(before);
    };

    const atLimit = await acceptTask('correction-calendar-limit');
    setHistoricalPlan(atLimit.id, '2023-12-31T16:00:00.000Z');
    const atLimitResponse = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: {
        correctionType: 'status_or_schedule_wrong',
        taskId: atLimit.id,
        expectedTaskVersion: atLimit.version,
        replacementScheduleAt: '2024-12-31T16:00:00.000Z',
      },
    });
    expect(atLimitResponse.statusCode).toBe(200);
    expect(atLimitResponse.json().task).toMatchObject({
      planned_start_at: '2023-12-31T16:00:00.000Z',
      planned_due_at: '2024-12-31T16:00:00.000Z',
      schedule_at: '2024-12-31T16:00:00.000Z',
    });

    const point = await acceptTask('correction-calendar-point');
    setHistoricalPlan(point.id, '2026-08-14T16:00:00.000Z');
    const pointResponse = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: {
        correctionType: 'status_or_schedule_wrong',
        taskId: point.id,
        expectedTaskVersion: point.version,
        replacementScheduleAt: '2026-08-14T16:00:00.000Z',
      },
    });
    expect(pointResponse.statusCode).toBe(200);
    expect(pointResponse.json().task.planned_due_at).toBe('2026-08-14T16:00:00.000Z');

    const overLimit = await acceptTask('correction-calendar-over-limit');
    setHistoricalPlan(overLimit.id, '2023-12-31T16:00:00.000Z');
    await expectRejectedWithoutWrites(
      overLimit,
      '2025-01-01T16:00:00.000Z',
      '计划时间跨度不能超过 366 个上海自然日。',
    );

    const reversed = await acceptTask('correction-calendar-reversed');
    setHistoricalPlan(reversed.id, '2026-08-15T16:00:00.000Z');
    await expectRejectedWithoutWrites(
      reversed,
      '2026-08-14T16:00:00.000Z',
      '计划完成时间不能早于计划开始时间。',
    );

    const legacyBadPlan = await acceptTask('correction-calendar-legacy-bad-plan');
    setHistoricalPlan(legacyBadPlan.id, 'legacy-bad-start-canary', '2026-08-15T03:00:00.000Z');
    const unrelatedCorrection = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: {
        correctionType: 'status_or_schedule_wrong',
        taskId: legacyBadPlan.id,
        expectedTaskVersion: legacyBadPlan.version,
        replacementStatus: 'in_progress',
        replacementValue: '仅纠正状态和下一步，不改历史排期。',
      },
    });
    expect(unrelatedCorrection.statusCode).toBe(200);
    expect(unrelatedCorrection.json().task).toMatchObject({
      status: 'in_progress',
      next_step: '仅纠正状态和下一步，不改历史排期。',
      planned_start_at: null,
      planned_due_at: '2026-08-15T03:00:00.000Z',
    });
    expect(JSON.stringify(unrelatedCorrection.json())).not.toContain('legacy-bad-start-canary');
  });

  it('任务级提出人纠错使用版本检查并写入完整私人时间线', async () => {
    const created = await simulate('task-proposer-correction');
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${created.candidate!.id}/action`, payload: { action: 'accept', expectedVersion: created.candidate!.version } });
    const task = accepted.json().task as { id: string; version: number };
    const result = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: { correctionType: 'wrong_fields', taskId: task.id, expectedTaskVersion: task.version, replacementValue: '正确提出人' },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().task.proposer_name).toBe('需求方');
    expect(result.json().task.version).toBe(task.version + 1);
    const event = database.raw.prepare("SELECT before_json, after_json, visibility FROM task_event WHERE task_id = ? AND event_type = 'correction_recorded' ORDER BY recorded_at DESC LIMIT 1").get(task.id) as { before_json: string; after_json: string; visibility: string };
    expect(JSON.parse(event.before_json).proposer_name).toBe('测试需求方');
    expect(JSON.parse(event.after_json).proposer_name).toBe('正确提出人');
    expect(event.visibility).toBe('private');
  });

  it('重新处理会新增 AI 判断和私人纠错审计', async () => {
    const created = await simulate('reprocess-audit-1');
    const before = (database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count;
    const response = await app.inject({ method: 'POST', url: `/api/candidates/${created.candidate!.id}/reprocess`, payload: { guidance: '请把背景写得更完整，但不要新增事实。', expectedVersion: created.candidate!.version } });
    expect(response.statusCode).toBe(200);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count).toBe(before + 1);
    expect((database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'reprocess'").get() as { count: number }).count).toBe(1);
  });
});
