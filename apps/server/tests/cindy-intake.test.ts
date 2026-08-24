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
});
