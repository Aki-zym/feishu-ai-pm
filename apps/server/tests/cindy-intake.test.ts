import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

describe('Cindy 对话入库接口', () => {
  const databases: AppDatabase[] = [];
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  const token = 'test-cindy-intake-token';

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const database of databases.splice(0)) database.close();
  });

  function makeTask(database: AppDatabase, id = 'task-cindy-intake-1') {
    const timestamp = '2026-08-24T00:00:00.000Z';
    database.raw.prepare(`INSERT INTO task
      (id, title, proposer_name, describe, status, schedule_at, planned_start_at, planned_due_at,
       next_step, risk, waiting_reason, version, completed_at, archived_at, deleted_at, record_state,
       merged_into_task_id, thread_id, auto_update_paused, created_at, updated_at)
      VALUES (?, '活动留存分析', '需求方', '验证活动留存是否值得继续投入。', 'planned', NULL, NULL, NULL,
       '补充分区口径', 'low', NULL, 1, NULL, NULL, NULL, 'active', NULL, NULL, 0, ?, ?)`).run(id, timestamp, timestamp);
  }

  async function makeApp() {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createAdapters(config), config);
    const app = await buildApp(service, { serveWeb: false, cindyIntegrationToken: token });
    apps.push(app);
    return { app, database };
  }

  const source = {
    source_key: 's1',
    occurred_at: '2026-08-24T00:01:00.000Z',
    conversation_key: 'conversation-1',
    sender_role: '策划',
    text: '请补充活动留存数据，确认分区口径。',
  };
  const source2 = {
    source_key: 's2',
    occurred_at: '2026-08-24T00:02:00.000Z',
    conversation_key: 'conversation-1',
    sender_role: '策划',
    text: '同时核对活动版本和区服范围。',
  };

  it('Cindy 任务接口要求 Bearer，并且只返回活动未归档任务', async () => {
    const { app, database } = await makeApp();
    makeTask(database);
    makeTask(database, 'task-cindy-intake-archived');
    database.raw.prepare("UPDATE task SET status = 'archived', archived_at = ? WHERE id = ?")
      .run('2026-08-24T00:02:00.000Z', 'task-cindy-intake-archived');

    expect((await app.inject({ method: 'GET', url: '/api/integrations/cindy/tasks' })).statusCode).toBe(401);
    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/cindy/tasks',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      expect.objectContaining({ id: 'task-cindy-intake-1', status: 'planned', version: 1 }),
    ]);
    expect(response.json().items.some((item: { id: string }) => item.id === 'task-cindy-intake-archived')).toBe(false);
  });

  it('自动扫描开关只接受本机请求，默认关闭并持久化 enabled 状态', async () => {
    const { app, database } = await makeApp();
    const initial = await app.inject({ method: 'GET', url: '/api/runtime/auto-scan', remoteAddress: '127.0.0.1' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ enabled: false });

    const enabled = await app.inject({
      method: 'PUT',
      url: '/api/runtime/auto-scan',
      remoteAddress: '127.0.0.1',
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({ enabled: true });
    expect(database.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'auto_scan_enabled'").get()).toEqual({ value_json: '{"enabled":true}' });

    const remote = await app.inject({ method: 'GET', url: '/api/runtime/auto-scan', remoteAddress: '203.0.113.10' });
    expect(remote.statusCode).toBe(403);
    const remotePut = await app.inject({
      method: 'PUT',
      url: '/api/runtime/auto-scan',
      remoteAddress: '203.0.113.10',
      payload: { enabled: false },
    });
    expect(remotePut.statusCode).toBe(403);

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/runtime/auto-scan',
      remoteAddress: '127.0.0.1',
      payload: { enabled: 'true' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('入库窗口游标默认为空，仅允许 loopback，并且 PUT 只保留最晚时间', async () => {
    const { app, database } = await makeApp();
    const initial = await app.inject({ method: 'GET', url: '/api/runtime/intake-cursor', remoteAddress: '127.0.0.1' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ window_end: null });

    const first = await app.inject({
      method: 'PUT',
      url: '/api/runtime/intake-cursor',
      remoteAddress: '127.0.0.1',
      payload: { window_end: '2026-08-24T00:10:00.000Z' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ window_end: '2026-08-24T00:10:00.000Z' });

    const same = await app.inject({
      method: 'PUT',
      url: '/api/runtime/intake-cursor',
      remoteAddress: '127.0.0.1',
      payload: { window_end: '2026-08-24T00:10:00.000Z' },
    });
    expect(same.statusCode).toBe(409);
    expect(same.json()).toMatchObject({ error: '入库窗口游标只允许向前推进。' });
    const earlier = await app.inject({
      method: 'PUT',
      url: '/api/runtime/intake-cursor',
      remoteAddress: '127.0.0.1',
      payload: { window_end: '2026-08-24T00:09:00.000Z' },
    });
    expect(earlier.statusCode).toBe(409);
    expect(earlier.json()).toMatchObject({ error: '入库窗口游标只允许向前推进。' });

    const remoteGet = await app.inject({ method: 'GET', url: '/api/runtime/intake-cursor', remoteAddress: '203.0.113.10' });
    expect(remoteGet.statusCode).toBe(403);
    const remotePut = await app.inject({
      method: 'PUT',
      url: '/api/runtime/intake-cursor',
      remoteAddress: '203.0.113.10',
      payload: { window_end: '2026-08-24T00:11:00.000Z' },
    });
    expect(remotePut.statusCode).toBe(403);
    expect(database.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'intake_window_end'").get())
      .toEqual({ value_json: '{"window_end":"2026-08-24T00:10:00.000Z"}' });
  });

  it('任务快照包含 pending 候选和会话游标，无会话来源不生成 source 或游标', async () => {
    const { app, database } = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        window_id: 'window-20260824-snapshot',
        window_start: '2026-08-24T00:00:00.000Z',
        window_end: '2026-08-24T00:10:00.000Z',
        sources: [
          source,
          source2,
          {
            source_key: 's-no-conversation',
            occurred_at: '2026-08-24T00:09:00.000Z',
            text: '无会话来源的候选。',
          },
        ],
        proposals: [
          { action: 'create_candidate', source_keys: ['s1'], title: '会话候选', describe: '带会话来源。' },
          { action: 'create_candidate', source_keys: ['s-no-conversation'], title: '无会话候选', describe: '不带会话来源。' },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(database.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'intake_window_end'").get())
      .toEqual({ value_json: '{"window_end":"2026-08-24T00:10:00.000Z"}' });

    const snapshot = await app.inject({
      method: 'GET',
      url: '/api/integrations/cindy/tasks',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(snapshot.statusCode).toBe(200);
    const body = snapshot.json() as {
      items: Array<Record<string, unknown>>;
      candidates: Array<Record<string, unknown>>;
      cursors: Array<Record<string, unknown>>;
    };
    expect(body.items.find((item) => item.title === '会话候选')).toBeUndefined();
    expect(body.candidates.find((item) => item.title === '会话候选')).toMatchObject({
      title: '会话候选',
      describe: '带会话来源。',
      status: 'pending',
      source: { conversation_key: 'conversation-1' },
      version: 1,
    });
    const noConversation = body.candidates.find((item) => item.title === '无会话候选');
    expect(noConversation).toMatchObject({ title: '无会话候选', status: 'pending', version: 1 });
    expect(noConversation).not.toHaveProperty('source');
    expect(body.cursors).toEqual([{ conversation_key: 'conversation-1', last_occurred_at: source2.occurred_at }]);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM sync_cursor WHERE integration = 'cindy_conversation'").get()).toEqual({ count: 1 });
  });

  it('窗口幂等、跨窗来源去重，多来源候选只建立一张候选且挂上全部来源', async () => {
    const { app, database } = await makeApp();
    const payload = {
      window_id: 'window-20260824-1',
      window_start: '2026-08-24T00:00:00.000Z',
      window_end: '2026-08-24T00:05:00.000Z',
      sources: [source, source2],
      proposals: [{
        action: 'create_candidate' as const,
        source_keys: ['s1', 's2'],
        title: '活动留存数据',
        describe: '补充活动留存数据并确认分区口径。',
      }],
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().duplicate).toBe(false);
    expect(first.json().proposals[0]).toMatchObject({ action: 'create_candidate' });
    const candidateId = first.json().proposals[0].candidate_id as string;
    const candidate = database.raw.prepare('SELECT demand_unit_id FROM candidate_request WHERE id = ?').get(candidateId) as { demand_unit_id: string };
    expect(database.raw.prepare('SELECT source_key FROM source_demand_unit_source WHERE demand_unit_id = ? ORDER BY sequence').all(candidate.demand_unit_id))
      .toEqual([{ source_key: 's1' }, { source_key: 's2' }]);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ window_id: payload.window_id, duplicate: true });
    const crossWindow = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...payload,
        window_id: 'window-20260824-2',
        window_start: '2026-08-24T00:05:00.000Z',
        window_end: '2026-08-24T00:10:00.000Z',
      },
    });
    expect(crossWindow.statusCode).toBe(200);
    expect(crossWindow.json()).toMatchObject({ window_id: 'window-20260824-2', duplicate: false });
    expect(crossWindow.json().proposals[0]).toMatchObject({ candidate_id: candidateId });
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(2);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number }).count).toBe(1);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM task').get() as { count: number }).count).toBe(0);
  });

  it('skip 只记录来源处理结果，不建立候选或任务', async () => {
    const { app, database } = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        window_id: 'window-20260824-skip',
        window_start: '2026-08-24T00:00:00.000Z',
        window_end: '2026-08-24T00:05:00.000Z',
        sources: [source],
        proposals: [{ action: 'skip', source_keys: ['s1'], reason: '仅供上下文参考。' }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM task').get() as { count: number }).count).toBe(0);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number }).count).toBe(0);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get() as { count: number }).count).toBe(1);
  });

  it('成功提交空窗口时也推进 intake_window_end', async () => {
    const { app, database } = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        window_id: 'window-20260824-empty',
        window_start: '2026-08-24T00:00:00.000Z',
        window_end: '2026-08-24T00:10:00.000Z',
        sources: [],
        proposals: [],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(database.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'intake_window_end'").get())
      .toEqual({ value_json: '{"window_end":"2026-08-24T00:10:00.000Z"}' });
  });

  it('update_task 使用 expected_version CAS，冲突时不写入来源或任务', async () => {
    const { app, database } = await makeApp();
    makeTask(database);
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        window_id: 'window-20260824-conflict',
        window_start: '2026-08-24T00:00:00.000Z',
        window_end: '2026-08-24T00:05:00.000Z',
        sources: [source],
        proposals: [{
          action: 'update_task',
          source_keys: ['s1'],
          task_key: 'task-cindy-intake-1',
          expected_version: 2,
          next_step: '改用最新分区口径',
        }],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error_code: 'CONFLICT', current_version: 1 });
    expect((database.raw.prepare('SELECT title, version, next_step FROM task WHERE id = ?').get('task-cindy-intake-1') as { title: string; version: number; next_step: string }))
      .toEqual({ title: '活动留存分析', version: 1, next_step: '补充分区口径' });
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(0);
  });

  it('成功 update_task 使用 CAS 更新版本，并在窗口重放时保持幂等', async () => {
    const { app, database } = await makeApp();
    makeTask(database);
    const payload = {
      window_id: 'window-20260824-update',
      window_start: '2026-08-24T00:00:00.000Z',
      window_end: '2026-08-24T00:05:00.000Z',
      sources: [source],
      proposals: [{
        action: 'update_task' as const,
        source_keys: ['s1'],
        task_key: 'task-cindy-intake-1',
        expected_version: 1,
        next_step: '改用最新分区口径',
      }],
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().proposals[0]).toMatchObject({ action: 'update_task', version: 2 });
    expect((database.raw.prepare('SELECT version, next_step FROM task WHERE id = ?').get('task-cindy-intake-1') as { version: number; next_step: string }))
      .toEqual({ version: 2, next_step: '改用最新分区口径' });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ window_id: payload.window_id, duplicate: true });
    expect((database.raw.prepare('SELECT version FROM task WHERE id = ?').get('task-cindy-intake-1') as { version: number }).version).toBe(2);
  });

  it('进度接口支持会话绑定、重复轮次幂等和服务端待确认安全门', async () => {
    const { app, database } = await makeApp();
    makeTask(database);
    const noAuth = await app.inject({ method: 'GET', url: '/api/integrations/cindy/bindings/session-progress-1' });
    expect(noAuth.statusCode).toBe(401);
    const removedConfirmRoute = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/bindings/session-progress-1/confirm',
      headers: { authorization: `Bearer ${token}` },
      payload: { taskId: 'task-cindy-intake-1' },
    });
    expect(removedConfirmRoute.statusCode).toBe(404);
    const first = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/turn-evaluations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        sessionId: 'session-progress-1',
        turnId: 'turn-1',
        candidateTaskIds: ['task-cindy-intake-1'],
        decision: 'bind',
        taskId: 'task-cindy-intake-1',
        associationConfidence: 0.95,
        updateConfidence: 0.9,
        reason: '当前会话目标与候选任务唯一匹配。',
        evidence: ['本轮围绕活动留存分析推进。'],
        provider: 'codex',
        model: 'gpt-5.6-luna',
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ duplicate: false, binding: { sessionId: 'session-progress-1', task: { id: 'task-cindy-intake-1' } } });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/turn-evaluations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        sessionId: 'session-progress-1',
        turnId: 'turn-1',
        decision: 'bind',
        taskId: 'task-cindy-intake-1',
        associationConfidence: 0.95,
        reason: '重复提交。',
      },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ duplicate: true });

    const progress = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/turn-evaluations',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        sessionId: 'session-progress-1',
        turnId: 'turn-2',
        candidateTaskIds: ['task-cindy-intake-1'],
        decision: 'progress_update',
        taskId: 'task-cindy-intake-1',
        associationConfidence: 1,
        updateConfidence: 0.9,
        patch: { nextStep: '补充实验分组并复核结论。' },
        reason: '本轮完成数据核验，下一步已明确。',
        evidence: ['已确认数据口径。'],
      },
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({ duplicate: false, proposal: { state: 'awaiting_approval' } });
    expect(database.raw.prepare('SELECT next_step, version FROM task WHERE id = ?').get('task-cindy-intake-1'))
      .toEqual({ next_step: '补充分区口径', version: 1 });
  });
});
