import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createCindyAdapters } from '../src/integrations.js';
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
    const service = new PmService(database, createCindyAdapters(config), config);
    const app = await buildApp(service, { serveWeb: false, cindyIntegrationToken: token });
    apps.push(app);
    return { app, database, service };
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
      expect.objectContaining({ id: 'task-cindy-intake-1', status: 'planned', version: 1, auto_update_paused: false }),
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
    expect(same.json()).toMatchObject({ error: 'Aily 扫描窗口游标只允许向前推进。' });
    const earlier = await app.inject({
      method: 'PUT',
      url: '/api/runtime/intake-cursor',
      remoteAddress: '127.0.0.1',
      payload: { window_end: '2026-08-24T00:09:00.000Z' },
    });
    expect(earlier.statusCode).toBe(409);
    expect(earlier.json()).toMatchObject({ error: 'Aily 扫描窗口游标只允许向前推进。' });

    const remoteGet = await app.inject({ method: 'GET', url: '/api/runtime/intake-cursor', remoteAddress: '203.0.113.10' });
    expect(remoteGet.statusCode).toBe(403);
    const remotePut = await app.inject({
      method: 'PUT',
      url: '/api/runtime/intake-cursor',
      remoteAddress: '203.0.113.10',
      payload: { window_end: '2026-08-24T00:11:00.000Z' },
    });
    expect(remotePut.statusCode).toBe(403);
    expect(database.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'aily_scan_window_end'").get())
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
        result_kind: 'intake',
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
    expect(database.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'aily_scan_window_end'").get())
      .toBeUndefined();

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
      result_kind: 'intake' as const,
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
        result_kind: 'intake' as const,
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
        result_kind: 'intake',
        sources: [source],
        proposals: [{ action: 'skip', source_keys: ['s1'], reason: '仅供上下文参考。' }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM task').get() as { count: number }).count).toBe(0);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number }).count).toBe(0);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get() as { count: number }).count).toBe(1);
  });

  it('aily_summary 来源保存为派生证据，并按窗口键稳定幂等', async () => {
    const { app, database } = await makeApp();
    const payload = {
      window_id: 'window-20260826-aily',
      window_start: '2026-08-26T00:00:00.000Z',
      window_end: '2026-08-26T00:10:00.000Z',
      result_kind: 'intake' as const,
      sources: [{
        source_key: 'aily-summary:window-20260826-aily',
        source_kind: 'aily_summary' as const,
        occurred_at: '2026-08-26T00:10:00.000Z',
        conversation_key: 'aily:agent_4kx9t1gjymdxf0w',
        sender_role: 'Aily 摘要（派生来源）',
        agent_id: 'agent_4kx9t1gjymdxf0w',
        generated_at: '2026-08-26T00:10:01.000Z',
        text: 'Aily 总结：需要补充活动留存数据。',
      }],
      proposals: [{
        action: 'create_candidate' as const,
        source_keys: ['aily-summary:window-20260826-aily'],
        title: '活动留存数据补充',
        describe: '根据 Aily 派生摘要整理的待确认候选。',
      }],
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(response.statusCode).toBe(200);
    const sourceRow = database.raw.prepare(
      'SELECT source_type, content, discovery_reason, metadata_json FROM source_event',
    ).get() as { source_type: string; content: string; discovery_reason: string; metadata_json: string };
    expect(sourceRow.source_type).toBe('manual');
    expect(sourceRow.content).toBe(payload.sources[0]!.text);
    expect(sourceRow.discovery_reason).toMatch(/派生摘要/);
    expect(JSON.parse(sourceRow.metadata_json)).toMatchObject({
      sourceKind: 'aily_summary',
      derivedEvidence: true,
      ailyAgentId: 'agent_4kx9t1gjymdxf0w',
      ailyGeneratedAt: '2026-08-26T00:10:01.000Z',
      ailySummaryWindowStart: payload.window_start,
      ailySummaryWindowEnd: payload.window_end,
    });
    expect(database.raw.prepare('SELECT completeness FROM source_event').get()).toEqual({ completeness: 'limited' });
    expect(database.raw.prepare('SELECT confidence FROM candidate_request').get()).toEqual({ confidence: 0.75 });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ duplicate: true, window_id: payload.window_id });
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(1);
  });

  it('aily_summary source_key 不稳定或窗口内重复时拒绝写入', async () => {
    const { app, database } = await makeApp();
    const base = {
        window_id: 'window-20260826-aily-invalid',
        window_start: '2026-08-26T00:00:00.000Z',
        window_end: '2026-08-26T00:10:00.000Z',
        result_kind: 'intake',
      proposals: [],
    };
    const invalidKey = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...base,
        sources: [{
          source_key: 'aily-summary:other-window',
          source_kind: 'aily_summary',
          occurred_at: base.window_end,
          agent_id: 'agent_1',
          generated_at: base.window_end,
          text: '摘要。',
        }],
      },
    });
    expect(invalidKey.statusCode).toBe(400);
    const duplicateSources = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...base,
        sources: [
          {
            source_key: 'aily-summary:window-20260826-aily-invalid',
            source_kind: 'aily_summary',
            occurred_at: base.window_end,
            agent_id: 'agent_1',
            generated_at: base.window_end,
            text: '摘要一。',
          },
          {
            source_key: 'aily-summary:window-20260826-aily-invalid-2',
            source_kind: 'aily_summary',
            occurred_at: base.window_end,
            agent_id: 'agent_1',
            generated_at: base.window_end,
            text: '摘要二。',
          },
        ],
      },
    });
    expect(duplicateSources.statusCode).toBe(400);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(0);
  });

  it('直接提交空 intake 不推进独立 Aily 扫描游标', async () => {
    const { app, database } = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        window_id: 'window-20260824-empty',
        window_start: '2026-08-24T00:00:00.000Z',
        window_end: '2026-08-24T00:10:00.000Z',
        result_kind: 'empty_window',
        sources: [],
        proposals: [],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(database.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'aily_scan_window_end'").get())
      .toBeUndefined();
  });

  it('同一窗口的提交内容变化返回冲突，不静默复用旧结果', async () => {
    const { app, database } = await makeApp();
    const payload = {
      window_id: 'window-20260824-fingerprint',
      window_start: '2026-08-24T00:00:00.000Z',
      window_end: '2026-08-24T00:05:00.000Z',
      result_kind: 'intake' as const,
      sources: [source],
      proposals: [{ action: 'skip' as const, source_keys: ['s1'], reason: '第一次判断。' }],
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...payload,
        proposals: [{ action: 'skip' as const, source_keys: ['s1'], reason: '第二次判断。' }],
      },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toMatch(/内容发生变化/);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(1);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get() as { count: number }).count).toBe(1);
  });

  it('Aily 摘要持久化后推进独立游标并清除 pending window', async () => {
    const { app, database, service } = await makeApp();
    const first = await app.inject({
      method: 'POST',
      url: '/api/runtime/intake-window',
      remoteAddress: '127.0.0.1',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().reused).toBe(false);
    const second = await app.inject({
      method: 'POST',
      url: '/api/runtime/intake-window',
      remoteAddress: '127.0.0.1',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ...first.json(), reused: true });
    const window = first.json();
    service.persistAilySummaryWindow({
      window,
      agent_id: 'agent_test',
      generated_at: window.window_end,
      text: '',
      empty: true,
    });
    expect(database.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'aily_scan_pending_window'").get()).toBeUndefined();
    expect(database.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'aily_scan_window_end'").get())
      .toEqual({ value_json: JSON.stringify({ window_end: window.window_end }) });
    expect(database.raw.prepare('SELECT result_kind, status FROM aily_summary_inbox WHERE window_id = ?').get(window.window_id))
      .toEqual({ result_kind: 'empty', status: 'completed' });
  });

  it('入库状态查询要求 Cindy Bearer 授权', async () => {
    const { app } = await makeApp();
    const windowId = 'window-20260824-status-auth';
    const withoutAuth = await app.inject({
      method: 'GET',
      url: `/api/integrations/cindy/intake/${encodeURIComponent(windowId)}/status`,
    });
    expect(withoutAuth.statusCode).toBe(401);
    const withAuth = await app.inject({
      method: 'GET',
      url: `/api/integrations/cindy/intake/${encodeURIComponent(windowId)}/status`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(withAuth.statusCode).toBe(200);
    expect(withAuth.json()).toMatchObject({ window_id: windowId, completed: false });
  });

  it('Aily inbox 使用 Bearer 原子领取，submit_intake 成功后在同一事务标记 completed', async () => {
    const { app, database, service } = await makeApp();
    const window = {
      window_id: 'intake-async-1',
      window_start: '2026-08-27T08:00:00.000Z',
      window_end: '2026-08-27T08:20:00.000Z',
      reused: false,
    };
    service.persistAilySummaryWindow({
      window,
      agent_id: 'agent_test',
      generated_at: '2026-08-27T08:20:01.000Z',
      text: '窗口内新增一项需要确认的任务。',
      empty: false,
    });

    expect((await app.inject({
      method: 'GET',
      url: '/api/integrations/cindy/summary-inbox/next',
    })).statusCode).toBe(401);
    const claimed = await app.inject({
      method: 'GET',
      url: '/api/integrations/cindy/summary-inbox/next',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({
      status: 'ready',
      inbox_id: expect.stringMatching(/^aily-inbox:/u),
      attempt: 1,
      window: {
        window_id: window.window_id,
        window_start: window.window_start,
        window_end: window.window_end,
      },
      source: {
        source_key: `aily-summary:${window.window_id}`,
        source_kind: 'aily_summary',
        agent_id: 'agent_test',
        text: '窗口内新增一项需要确认的任务。',
      },
    });

    const body = claimed.json();
    const completed = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...body.window,
        inbox_id: body.inbox_id,
        claim_token: body.claim_token,
        result_kind: 'intake',
        sources: [body.source],
        proposals: [{ action: 'skip', source_keys: [body.source.source_key], reason: '暂不入库。' }],
      },
    });
    expect(completed.statusCode).toBe(200);
    expect(database.raw.prepare('SELECT status, claim_token_hash, lease_until FROM aily_summary_inbox WHERE id = ?').get(body.inbox_id))
      .toEqual({ status: 'completed', claim_token_hash: null, lease_until: null });
    const stored = database.raw.prepare(
      "SELECT cursor FROM sync_cursor WHERE integration = 'cindy_intake' AND scope_key = ?",
    ).get(window.window_id) as { cursor: string };
    expect(stored.cursor).not.toContain(body.claim_token);
    const empty = await app.inject({
      method: 'GET',
      url: '/api/integrations/cindy/summary-inbox/next',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(empty.json()).toEqual({ status: 'empty' });
  });

  it('Aily inbox 失败进入退避，过期租约可重新领取且旧 token 失效', async () => {
    const { app, database, service } = await makeApp();
    service.persistAilySummaryWindow({
      window: {
        window_id: 'intake-async-retry',
        window_start: '2026-08-27T08:20:00.000Z',
        window_end: '2026-08-27T08:40:00.000Z',
        reused: false,
      },
      agent_id: 'agent_test',
      generated_at: '2026-08-27T08:40:01.000Z',
      text: '需要重试的摘要。',
      empty: false,
    });
    const first = (await app.inject({
      method: 'GET',
      url: '/api/integrations/cindy/summary-inbox/next',
      headers: { authorization: `Bearer ${token}` },
    })).json();
    const retried = await app.inject({
      method: 'POST',
      url: `/api/integrations/cindy/summary-inbox/${encodeURIComponent(first.inbox_id)}/retry`,
      headers: { authorization: `Bearer ${token}` },
      payload: { claim_token: first.claim_token, error_code: 'CINDY_ERRAND_FAILED' },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ status: 'retry_waiting', attempts: 1 });
    expect(database.raw.prepare('SELECT status, claim_token_hash, lease_until FROM aily_summary_inbox WHERE id = ?').get(first.inbox_id))
      .toEqual({ status: 'retry_waiting', claim_token_hash: null, lease_until: null });

    database.raw.prepare("UPDATE aily_summary_inbox SET status = 'claimed', available_at = ?, lease_until = ?, claim_token_hash = ? WHERE id = ?")
      .run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '0'.repeat(64), first.inbox_id);
    const reclaimed = (await app.inject({
      method: 'GET',
      url: '/api/integrations/cindy/summary-inbox/next',
      headers: { authorization: `Bearer ${token}` },
    })).json();
    expect(reclaimed).toMatchObject({ status: 'ready', inbox_id: first.inbox_id, attempt: 2 });
    expect(reclaimed.claim_token).not.toBe(first.claim_token);
    const stale = await app.inject({
      method: 'POST',
      url: `/api/integrations/cindy/summary-inbox/${encodeURIComponent(first.inbox_id)}/retry`,
      headers: { authorization: `Bearer ${token}` },
      payload: { claim_token: first.claim_token, error_code: 'CINDY_ERRAND_FAILED' },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('Aily inbox 连续五次失败后进入 failed，完成和失败正文按 30 天清理', async () => {
    const { database, service } = await makeApp();
    service.persistAilySummaryWindow({
      window: {
        window_id: 'intake-async-exhausted',
        window_start: '2026-08-27T09:00:00.000Z',
        window_end: '2026-08-27T09:20:00.000Z',
        reused: false,
      },
      agent_id: 'agent_test',
      generated_at: '2026-08-27T09:20:01.000Z',
      text: '将连续失败的摘要。',
      empty: false,
    });
    let finalStatus = '';
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      database.raw.prepare("UPDATE aily_summary_inbox SET available_at = '2020-01-01T00:00:00.000Z' WHERE window_id = 'intake-async-exhausted'").run();
      const claim = service.claimNextAilySummaryInbox();
      if (claim.status !== 'ready') throw new Error('测试摘要未能领取。');
      const retried = service.retryAilySummaryInbox(claim.inbox_id, claim.claim_token, 'CINDY_ERRAND_FAILED');
      finalStatus = retried.status;
    }
    expect(finalStatus).toBe('failed');
    expect(database.raw.prepare(
      "SELECT status, attempts, claim_token_hash, lease_until FROM aily_summary_inbox WHERE window_id = 'intake-async-exhausted'",
    ).get()).toEqual({ status: 'failed', attempts: 5, claim_token_hash: null, lease_until: null });

    database.raw.prepare(
      "UPDATE aily_summary_inbox SET completed_at = '2026-07-01T00:00:00.000Z', updated_at = '2026-07-01T00:00:00.000Z' WHERE window_id = 'intake-async-exhausted'",
    ).run();
    expect(service.cleanupAilySummaryInbox()).toEqual({ removed: 1, retentionDays: 30 });
    expect(database.raw.prepare(
      "SELECT COUNT(*) AS count FROM aily_summary_inbox WHERE window_id = 'intake-async-exhausted'",
    ).get()).toEqual({ count: 0 });
  });

  it('inbox 绑定的 update_task CAS 失败时来源、任务和 completed 状态全部零推进', async () => {
    const { app, database, service } = await makeApp();
    makeTask(database);
    service.persistAilySummaryWindow({
      window: {
        window_id: 'intake-async-cas',
        window_start: '2026-08-27T09:20:00.000Z',
        window_end: '2026-08-27T09:40:00.000Z',
        reused: false,
      },
      agent_id: 'agent_test',
      generated_at: '2026-08-27T09:40:01.000Z',
      text: '活动留存分析已有新进展。',
      empty: false,
    });
    const claim = service.claimNextAilySummaryInbox();
    if (claim.status !== 'ready') throw new Error('测试摘要未能领取。');
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...claim.window,
        inbox_id: claim.inbox_id,
        claim_token: claim.claim_token,
        result_kind: 'intake',
        sources: [claim.source],
        proposals: [{
          action: 'update_task',
          source_keys: [claim.source.source_key],
          task_key: 'task-cindy-intake-1',
          expected_version: 2,
          next_step: '错误版本不应写入。',
        }],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(database.raw.prepare("SELECT version, next_step FROM task WHERE id = 'task-cindy-intake-1'").get())
      .toEqual({ version: 1, next_step: '补充分区口径' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT status FROM aily_summary_inbox WHERE id = ?').get(claim.inbox_id))
      .toEqual({ status: 'claimed' });
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
        result_kind: 'intake',
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

  it('暂停 AI 自动维护的任务拒绝 update_task，且任务和来源保持不变', async () => {
    const { app, database } = await makeApp();
    makeTask(database);
    database.raw.prepare('UPDATE task SET auto_update_paused = 1 WHERE id = ?').run('task-cindy-intake-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        window_id: 'window-20260824-paused',
        window_start: '2026-08-24T00:00:00.000Z',
        window_end: '2026-08-24T00:05:00.000Z',
        result_kind: 'intake',
        sources: [source],
        proposals: [{
          action: 'update_task',
          source_keys: ['s1'],
          task_key: 'task-cindy-intake-1',
          expected_version: 1,
          next_step: '暂停任务不应被自动改写',
        }],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error_code: 'CONFLICT', current_version: 1 });
    expect(response.json().error).toMatch(/暂停 AI 自动维护/);
    expect(database.raw.prepare('SELECT title, version, next_step, auto_update_paused FROM task WHERE id = ?').get('task-cindy-intake-1'))
      .toEqual({ title: '活动留存分析', version: 1, next_step: '补充分区口径', auto_update_paused: 1 });
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(0);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM task_source_link').get() as { count: number }).count).toBe(0);
  });

  it('成功 update_task 使用 CAS 更新版本，并在窗口重放时保持幂等', async () => {
    const { app, database } = await makeApp();
    makeTask(database);
    const payload = {
        window_id: 'window-20260824-update',
        window_start: '2026-08-24T00:00:00.000Z',
        window_end: '2026-08-24T00:05:00.000Z',
        result_kind: 'intake',
      sources: [source, source2],
      proposals: [{
        action: 'update_task' as const,
        source_keys: ['s1', 's2'],
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
    const link = database.raw.prepare(
      `SELECT source_event_id, demand_unit_id, relation_type
         FROM task_source_link
        WHERE task_id = ?
        ORDER BY source_event_id`,
    ).all('task-cindy-intake-1') as Array<{
      source_event_id: string;
      demand_unit_id: string;
      relation_type: string;
    }>;
    expect(link).toHaveLength(2);
    expect(link.every((item) => item.demand_unit_id && item.relation_type === 'cindy_update')).toBe(true);
    const event = database.raw.prepare(
      `SELECT source_event_id, demand_unit_id
         FROM task_event
        WHERE task_id = ? AND event_type = 'task_cindy_intake_update'`,
    ).get('task-cindy-intake-1') as { source_event_id: string; demand_unit_id: string };
    expect(link.map((item) => item.source_event_id)).toContain(event.source_event_id);
    expect(event.demand_unit_id).toBe(link[0]!.demand_unit_id);
    expect(database.raw.prepare(
      `SELECT 1 AS present
         FROM source_demand_unit_source
        WHERE demand_unit_id = ? AND source_event_id IN (?, ?)
        GROUP BY demand_unit_id`,
    ).get(link[0]!.demand_unit_id, link[0]!.source_event_id, link[1]!.source_event_id)).toEqual({ present: 1 });

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
