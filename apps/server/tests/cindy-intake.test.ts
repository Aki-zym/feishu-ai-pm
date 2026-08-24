import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createCindyAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';
import { minimalSourceDtoSchema, privateSourceDtoSchema } from '../src/source-privacy.js';

describe('Cindy 对话入库接口', () => {
  const databases: AppDatabase[] = [];
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  const token = 'test-cindy-intake-token';
  const accountAnchor = 'test-connected-account-anchor';
  const receiptSecret = 'test-receipt-secret-0123456789abcdef0123456789abcdef';

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

  async function makeApp(
    integrationToken = token,
    existingDatabase?: AppDatabase,
    integrationAccountAnchor = accountAnchor,
    integrationReceiptSecret = receiptSecret,
  ) {
    const database = existingDatabase ?? new AppDatabase(':memory:', false);
    if (!existingDatabase) databases.push(database);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createCindyAdapters(config), config);
    const app = await buildApp(service, {
      serveWeb: false,
      cindyIntegrationToken: integrationToken,
      cindyIntegrationAccountAnchor: integrationAccountAnchor,
      cindyReceiptSecret: integrationReceiptSecret,
    });
    apps.push(app);
    return { app, database };
  }

  const trustedSource = (overrides: Record<string, unknown> = {}) => ({
    client_ref: 's1',
    provider: 'synthetic',
    source_kind: 'synthetic_message',
    stable_message_id: 'message-1',
    occurred_at: '2026-08-24T00:01:00.000Z',
    sender_id: 'ou_requester_1',
    display_name: '策划',
    chat_id: 'oc_conversation_1',
    mentioned_owner: true,
    sender_is_owner: false,
    message_type: 'text',
    text: '请补充活动留存数据，确认分区口径。',
    revision: { sequence: 1 },
    ...overrides,
  });

  async function saveSources(app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>, integrationToken = token) {
    return app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/sources',
      headers: { authorization: `Bearer ${integrationToken}` },
      payload,
    });
  }

  async function submitDecisions(app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>, integrationToken = token) {
    return app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/decisions',
      headers: { authorization: `Bearer ${integrationToken}` },
      payload,
    });
  }

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

  it('配置 Bearer 时缺少稳定账号锚点或独立 receipt 密钥会拒绝启动', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createCindyAdapters(config), config);
    await expect(buildApp(service, { serveWeb: false, cindyIntegrationToken: token })).rejects.toThrow(
      '缺少稳定账号锚点或独立 receipt 密钥',
    );
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

  it('先保存来源后即使 errand 中断，SQLite 仍保留 pending_decision 且请求重放返回同一 receipt', async () => {
    const { app, database } = await makeApp();
    const payload = { save_request_id: 'save-interrupt-1', sources: [trustedSource()] };
    const first = await saveSources(app, payload);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ duplicate: false, sources: [{ client_ref: 's1', source_status: 'pending_decision' }] });
    const receipt = first.json().sources[0].source_receipt as string;
    expect(receipt).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(database.raw.prepare('SELECT processing_status, receipt_digest, receipt_nonce FROM source_event_revision WHERE processing_status = \'pending_decision\'').get())
      .toMatchObject({ processing_status: 'pending_decision', receipt_digest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(JSON.stringify(database.raw.prepare('SELECT * FROM source_event_revision').get())).not.toContain(receipt);

    const replay = await saveSources(app, payload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ duplicate: true });
    expect(replay.json().sources[0].source_receipt).toBe(receipt);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(1);
  });

  it('同一稳定账号下轮换 Bearer 后旧 receipt、来源与保存/决策幂等仍可用', async () => {
    const { app, database } = await makeApp();
    const savePayload = { save_request_id: 'save-before-token-rotation', sources: [trustedSource()] };
    const first = await saveSources(app, savePayload);
    expect(first.statusCode).toBe(200);
    const receipt = first.json().sources[0].source_receipt as string;

    const rotatedToken = 'rotated-cindy-bearer-token';
    const { app: rotatedApp } = await makeApp(rotatedToken, database);
    const requestReplay = await saveSources(rotatedApp, savePayload, rotatedToken);
    expect(requestReplay.statusCode).toBe(200);
    expect(requestReplay.json()).toMatchObject({ duplicate: true });
    expect(requestReplay.json().sources[0].source_receipt).toBe(receipt);

    const identityReplay = await saveSources(rotatedApp, {
      save_request_id: 'save-after-token-rotation',
      sources: [trustedSource()],
    }, rotatedToken);
    expect(identityReplay.statusCode).toBe(200);
    expect(identityReplay.json().sources[0].source_receipt).toBe(receipt);

    const decisionPayload = {
      decision_request_id: 'decision-after-token-rotation',
      window_id: 'window-after-token-rotation',
      window_start: '2026-08-24T00:00:00.000Z',
      window_end: '2026-08-24T00:05:00.000Z',
      decisions: [{ decision_ref: 'skip', action: 'skip', source_receipts: [receipt], reason: '合成来源无需任务。' }],
    };
    const decision = await submitDecisions(rotatedApp, decisionPayload, rotatedToken);
    expect(decision.statusCode).toBe(200);
    const decisionReplay = await submitDecisions(rotatedApp, decisionPayload, rotatedToken);
    expect(decisionReplay.statusCode).toBe(200);
    expect(decisionReplay.json()).toMatchObject({ duplicate: true });
  });

  it('保存请求的幂等 hash 使用规范化后的白名单字段', async () => {
    const { app, database } = await makeApp();
    const first = await saveSources(app, {
      save_request_id: 'save-canonical-replay',
      sources: [trustedSource({
        occurred_at: '2026-08-24T08:01:00+08:00',
        stable_message_id: ' message-canonical ',
        text: ' 需要补充任务。 ',
      })],
    });
    expect(first.statusCode).toBe(200);
    const replay = await saveSources(app, {
      save_request_id: 'save-canonical-replay',
      sources: [trustedSource({
        occurred_at: '2026-08-24T00:01:00.000Z',
        stable_message_id: 'message-canonical',
        text: '需要补充任务。',
      })],
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ duplicate: true });
    expect(replay.json().sources[0].source_receipt).toBe(first.json().sources[0].source_receipt);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(1);
  });

  it('同 request id 异 payload、同 revision 异 hash 和无 revision 异内容均零写入拒绝', async () => {
    const { app, database } = await makeApp();
    const first = await saveSources(app, { save_request_id: 'save-conflict-1', sources: [trustedSource()] });
    expect(first.statusCode).toBe(200);
    const before = (database.raw.prepare('SELECT COUNT(*) AS count FROM source_event_revision').get() as { count: number }).count;

    const requestConflict = await saveSources(app, {
      save_request_id: 'save-conflict-1',
      sources: [trustedSource({ text: '不同正文。' })],
    });
    expect(requestConflict.statusCode).toBe(409);
    const revisionConflict = await saveSources(app, {
      save_request_id: 'save-conflict-2',
      sources: [trustedSource({ text: '不同正文。' })],
    });
    expect(revisionConflict.statusCode).toBe(409);
    expect(revisionConflict.json()).toMatchObject({ error_code: 'CONFLICT' });

    const noRevision = await saveSources(app, {
      save_request_id: 'save-no-revision-1',
      sources: [trustedSource({ stable_message_id: 'message-no-revision', revision: undefined })],
    });
    expect(noRevision.statusCode).toBe(200);
    const ambiguous = await saveSources(app, {
      save_request_id: 'save-no-revision-2',
      sources: [trustedSource({ stable_message_id: 'message-no-revision', revision: undefined, text: '无法比较的新正文。' })],
    });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json()).toMatchObject({ error_code: 'SOURCE_REVISION_AMBIGUOUS' });
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event_revision').get() as { count: number }).count).toBe(before + 1);
  });

  it('可比较 revision 支持 A→B→A 防回退，并发 A/B 最终只保留更高 revision 为 current', async () => {
    const { app, database } = await makeApp();
    const a = await saveSources(app, { save_request_id: 'save-order-a', sources: [trustedSource({ revision: { sequence: 1 } })] });
    expect(a.statusCode).toBe(200);
    const receiptA = a.json().sources[0].source_receipt as string;
    const b = await saveSources(app, { save_request_id: 'save-order-b', sources: [trustedSource({ revision: { sequence: 2 }, text: '第二版正文。' })] });
    expect(b.statusCode).toBe(200);
    expect(b.json().sources[0].source_receipt).not.toBe(receiptA);
    const originalRequestReplay = await saveSources(app, { save_request_id: 'save-order-a', sources: [trustedSource({ revision: { sequence: 1 } })] });
    expect(originalRequestReplay.statusCode).toBe(200);
    expect(originalRequestReplay.json().sources[0]).toMatchObject({ source_receipt: receiptA, source_status: 'superseded' });
    const oldReplay = await saveSources(app, { save_request_id: 'save-order-a-again', sources: [trustedSource({ revision: { sequence: 1 } })] });
    expect(oldReplay.statusCode).toBe(200);
    expect(oldReplay.json().sources[0]).toMatchObject({ source_receipt: receiptA, source_status: 'superseded' });
    const staleUnknown = await saveSources(app, { save_request_id: 'save-order-stale', sources: [trustedSource({ revision: { sequence: 0 }, text: '未知旧版。' })] });
    expect(staleUnknown.statusCode).toBe(409);
    expect(staleUnknown.json()).toMatchObject({ error_code: 'STALE_REVISION' });

    const concurrent = await Promise.all([
      saveSources(app, { save_request_id: 'save-concurrent-3', sources: [trustedSource({ stable_message_id: 'message-concurrent', revision: { sequence: 3 }, text: '版本三。' })] }),
      saveSources(app, { save_request_id: 'save-concurrent-4', sources: [trustedSource({ stable_message_id: 'message-concurrent', revision: { sequence: 4 }, text: '版本四。' })] }),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 200]);
    const current = database.raw.prepare(
      `SELECT revision.provider_revision_sequence
         FROM cindy_source_identity AS identity
         JOIN source_event_revision AS revision ON revision.id = identity.current_revision_id
        WHERE identity.stable_id_hash <> (SELECT stable_id_hash FROM cindy_source_identity ORDER BY created_at LIMIT 1)
        ORDER BY revision.provider_revision_sequence DESC LIMIT 1`,
    ).get() as { provider_revision_sequence: number };
    expect(current.provider_revision_sequence).toBe(4);
  });

  it('批内关系图先完整校验：合法 reply 保存，未知、重复和成环关系整批零写入', async () => {
    const { app, database } = await makeApp();
    const valid = await saveSources(app, {
      save_request_id: 'save-relations-valid',
      sources: [
        trustedSource({ client_ref: 'root', stable_message_id: 'relation-root' }),
        trustedSource({ client_ref: 'reply', stable_message_id: 'relation-reply', relations: [{ kind: 'reply_to', client_ref: 'root' }] }),
      ],
    });
    expect(valid.statusCode).toBe(200);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_source_relation').get() as { count: number }).count).toBe(1);
    const before = (database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count;
    const crossBatch = await saveSources(app, {
      save_request_id: 'save-relations-cross-batch',
      sources: [trustedSource({
        stable_message_id: 'cross-batch-relation',
        relations: [{ kind: 'thread_parent', source_receipt: valid.json().sources[0].source_receipt }],
      })],
    });
    expect(crossBatch.statusCode).toBe(200);
    const cyclic = await saveSources(app, {
      save_request_id: 'save-relations-cycle',
      sources: [
        trustedSource({ client_ref: 'a', stable_message_id: 'cycle-a', relations: [{ kind: 'reply_to', client_ref: 'b' }] }),
        trustedSource({ client_ref: 'b', stable_message_id: 'cycle-b', relations: [{ kind: 'reply_to', client_ref: 'a' }] }),
      ],
    });
    expect(cyclic.statusCode).toBe(400);
    const duplicate = await saveSources(app, {
      save_request_id: 'save-relations-duplicate',
      sources: [trustedSource({
        stable_message_id: 'duplicate-relation',
        relations: [{ kind: 'reply_to', source_receipt: valid.json().sources[0].source_receipt }, { kind: 'reply_to', source_receipt: valid.json().sources[0].source_receipt }],
      })],
    });
    expect(duplicate.statusCode).toBe(400);
    const repeatedRef = await saveSources(app, {
      save_request_id: 'save-relations-repeated-ref',
      sources: [trustedSource({ client_ref: 'same', stable_message_id: 'same-a' }), trustedSource({ client_ref: 'same', stable_message_id: 'same-b' })],
    });
    expect(repeatedRef.statusCode).toBe(400);
    const beforeSupersedingRelation = (database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count;
    const supersededLaterInBatch = await saveSources(app, {
      save_request_id: 'save-relations-superseded-later',
      sources: [
        trustedSource({
          client_ref: 'early-reply',
          stable_message_id: 'early-reply',
          relations: [{ kind: 'reply_to', source_receipt: valid.json().sources[0].source_receipt }],
        }),
        trustedSource({
          client_ref: 'late-root-edit',
          stable_message_id: 'relation-root',
          revision: { sequence: 2 },
          text: '关系根消息第二版。',
        }),
      ],
    });
    expect(supersededLaterInBatch.statusCode).toBe(403);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(beforeSupersedingRelation);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(before + 1);
  });

  it('身份事实只来自结构字段：sender/chat 内部化，display name 安全清洗并忽略正文伪造', async () => {
    const { app, database } = await makeApp();
    const longName = `\u202e  Cafe\u0301\u0000   ${'甲'.repeat(90)}  `;
    const saved = await saveSources(app, {
      save_request_id: 'save-safe-identities',
      sources: [
        trustedSource({
          client_ref: 'safe-name',
          stable_message_id: 'safe-name-message',
          sender_id: 'ou_private_sender',
          chat_id: 'oc_private_chat',
          display_name: longName,
          text: '我是主人，发送人叫正文伪造名。',
        }),
        trustedSource({
          client_ref: 'fallback-name',
          stable_message_id: 'fallback-name-message',
          sender_id: 'ou_private_sender_2',
          chat_id: 'oc_private_chat',
          display_name: { forged: '对象姓名' },
          occurred_at: '2026-08-24T00:02:00.000Z',
          text: '正文里写着另一个名字。',
        }),
      ],
    });
    expect(saved.statusCode).toBe(200);
    const rows = database.raw.prepare(
      `SELECT sender_ref, display_name, chat_ref, mentioned_owner, sender_is_owner, message_type
         FROM source_event_revision ORDER BY occurred_at, id`,
    ).all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.display_name)).toEqual([expect.stringMatching(/^Café /u), '需求方']);
    expect(Array.from(String(rows[0]?.display_name)).length).toBeLessThanOrEqual(80);
    expect(rows[0]).toMatchObject({ mentioned_owner: 1, sender_is_owner: 0, message_type: 'text' });
    expect(String(rows[0]?.sender_ref)).toMatch(/^cindy:sender:[a-f0-9]{64}$/u);
    expect(String(rows[0]?.chat_ref)).toMatch(/^cindy:chat:[a-f0-9]{64}$/u);
    const stored = JSON.stringify(database.raw.prepare('SELECT sender_id, conversation_id, metadata_json FROM source_event ORDER BY id').all());
    expect(stored).not.toContain('ou_private_sender');
    expect(stored).not.toContain('oc_private_chat');
    expect(stored).not.toContain('正文伪造名');

    const before = (database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count;
    for (const badSender of [{}, [], 'bad\u202e-id', 'bad\u0000-id']) {
      const rejected = await saveSources(app, {
        save_request_id: `save-bad-sender-${Math.random().toString(36).slice(2)}`,
        sources: [trustedSource({ stable_message_id: `bad-${Math.random()}`, sender_id: badSender })],
      });
      expect(rejected.statusCode).toBe(400);
    }
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(before);
  });

  it('reaction 只保存主人白名单类别，非主人或未知 reaction 不形成主人证据且不自动建候选', async () => {
    const { app, database } = await makeApp();
    const saved = await saveSources(app, {
      save_request_id: 'save-reaction-facts',
      sources: [
        trustedSource({
          client_ref: 'non-owner', stable_message_id: 'reaction-non-owner', thread_id: 'thread-reactions',
          occurred_at: '2026-08-24T00:01:00.000Z',
          mentioned_owner: false, sender_is_owner: false, reactions: [{ type: 'DONE', actor_is_owner: false }],
        }),
        trustedSource({
          client_ref: 'unknown-owner', stable_message_id: 'reaction-unknown-owner', thread_id: 'thread-reactions',
          occurred_at: '2026-08-24T00:02:00.000Z',
          mentioned_owner: false, sender_is_owner: false, reactions: [{ type: 'PARTY', actor_is_owner: true }],
        }),
        trustedSource({
          client_ref: 'owner', stable_message_id: 'reaction-owner', thread_id: 'thread-reactions',
          occurred_at: '2026-08-24T00:03:00.000Z',
          mentioned_owner: false, sender_is_owner: false, reactions: [{ type: 'THUMBSUP', actor_is_owner: true }],
        }),
      ],
    });
    expect(saved.statusCode).toBe(200);
    expect(database.raw.prepare(
      'SELECT owner_reacted, owner_reaction_category FROM source_event_revision ORDER BY occurred_at, id',
    ).all()).toEqual([
      { owner_reacted: 0, owner_reaction_category: null },
      { owner_reacted: 0, owner_reaction_category: null },
      { owner_reacted: 1, owner_reaction_category: 'acknowledge' },
    ]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
  });

  it('关系必须同账号、同 chat 和兼容 thread；技术 ID 注入、跨账号和失效 receipt 整批零写入', async () => {
    const { app, database } = await makeApp();
    const root = await saveSources(app, {
      save_request_id: 'save-context-root',
      sources: [trustedSource({ stable_message_id: 'context-root', thread_id: 'thread-1' })],
    });
    const receipt = root.json().sources[0].source_receipt as string;
    const before = (database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count;
    const wrongChat = await saveSources(app, {
      save_request_id: 'save-wrong-chat-relation',
      sources: [trustedSource({ stable_message_id: 'wrong-chat', chat_id: 'other-chat', thread_id: 'thread-1', relations: [{ kind: 'reply_to', source_receipt: receipt }] })],
    });
    expect(wrongChat.statusCode).toBe(403);
    const wrongThread = await saveSources(app, {
      save_request_id: 'save-wrong-thread-relation',
      sources: [trustedSource({ stable_message_id: 'wrong-thread', thread_id: 'thread-2', relations: [{ kind: 'reply_to', source_receipt: receipt }] })],
    });
    expect(wrongThread.statusCode).toBe(403);
    const injected = await saveSources(app, {
      save_request_id: 'save-injected-relation',
      sources: [trustedSource({ stable_message_id: 'injected', relations: [{ kind: 'reply_to', open_id: 'ou_fake' }] })],
    });
    expect(injected.statusCode).toBe(400);
    const foreignToken = 'foreign-context-token';
    const { app: foreignApp } = await makeApp(foreignToken, database, 'foreign-context-anchor');
    const foreign = await saveSources(foreignApp, {
      save_request_id: 'save-foreign-relation',
      sources: [trustedSource({ stable_message_id: 'foreign-reply', thread_id: 'thread-1', relations: [{ kind: 'reply_to', source_receipt: receipt }] })],
    }, foreignToken);
    expect(foreign.statusCode).toBe(403);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(before);
  });

  it('服务端执行 20/60 分钟与 100/4 小时上下文硬边界，越界整批零写入', async () => {
    const { app, database } = await makeApp();
    const unthreaded = Array.from({ length: 21 }, (_, index) => trustedSource({
      client_ref: `plain-${index}`,
      stable_message_id: `plain-message-${index}`,
      occurred_at: `2026-08-24T00:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    expect((await saveSources(app, { save_request_id: 'save-plain-too-many', sources: unthreaded })).statusCode).toBe(400);
    expect((await saveSources(app, {
      save_request_id: 'save-thread-does-not-upgrade-plain',
      sources: [
        trustedSource({ client_ref: 'one-thread', stable_message_id: 'one-thread', thread_id: 'separate-thread' }),
        ...unthreaded.map((item, index) => ({ ...item, client_ref: `mixed-${index}`, stable_message_id: `mixed-message-${index}` })),
      ],
    })).statusCode).toBe(400);
    expect((await saveSources(app, {
      save_request_id: 'save-plain-no-owner-evidence',
      sources: [trustedSource({ stable_message_id: 'plain-no-evidence', mentioned_owner: false, sender_is_owner: false, reactions: [] })],
    })).statusCode).toBe(400);
    expect((await saveSources(app, {
      save_request_id: 'save-plain-context-around-owner-evidence',
      sources: [
        trustedSource({ client_ref: 'before-evidence', stable_message_id: 'before-evidence', occurred_at: '2026-08-24T00:00:00.000Z', mentioned_owner: false, sender_is_owner: false, reactions: [] }),
        trustedSource({ client_ref: 'owner-evidence', stable_message_id: 'owner-evidence', occurred_at: '2026-08-24T00:01:00.000Z' }),
      ],
    })).statusCode).toBe(200);
    expect((await saveSources(app, {
      save_request_id: 'save-plain-too-old',
      sources: [
        trustedSource({ client_ref: 'plain-now', stable_message_id: 'plain-now', occurred_at: '2026-08-24T00:00:00.000Z' }),
        trustedSource({ client_ref: 'plain-late', stable_message_id: 'plain-late', occurred_at: '2026-08-24T01:00:00.001Z' }),
      ],
    })).statusCode).toBe(400);
    const threaded = Array.from({ length: 101 }, (_, index) => trustedSource({
      client_ref: `thread-${index}`,
      stable_message_id: `thread-message-${index}`,
      thread_id: 'bounded-thread',
      occurred_at: `2026-08-24T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    }));
    expect((await saveSources(app, { save_request_id: 'save-thread-too-many', sources: threaded })).statusCode).toBe(400);
    const separateThreads = Array.from({ length: 120 }, (_, index) => trustedSource({
      client_ref: `separate-${index}`,
      stable_message_id: `separate-message-${index}`,
      thread_id: index < 60 ? 'thread-a' : 'thread-b',
      occurred_at: `2026-08-24T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    }));
    expect((await saveSources(app, { save_request_id: 'save-separate-threads', sources: separateThreads })).statusCode).toBe(200);
    const crossBatchRoot = await saveSources(app, {
      save_request_id: 'save-cross-batch-time-root',
      sources: [trustedSource({ stable_message_id: 'cross-batch-time-root', thread_id: 'cross-batch-time', occurred_at: '2026-08-24T00:00:00.000Z' })],
    });
    expect(crossBatchRoot.statusCode).toBe(200);
    expect((await saveSources(app, {
      save_request_id: 'save-cross-batch-time-reply',
      sources: [trustedSource({
        stable_message_id: 'cross-batch-time-reply', thread_id: 'cross-batch-time', occurred_at: '2026-08-24T04:00:00.001Z',
        relations: [{ kind: 'reply_to', source_receipt: crossBatchRoot.json().sources[0].source_receipt }],
      })],
    })).statusCode).toBe(400);
    expect((await saveSources(app, {
      save_request_id: 'save-thread-too-old',
      sources: [
        trustedSource({ client_ref: 'thread-now', stable_message_id: 'thread-now', thread_id: 'old-thread', occurred_at: '2026-08-24T00:00:00.000Z' }),
        trustedSource({ client_ref: 'thread-late', stable_message_id: 'thread-late', thread_id: 'old-thread', occurred_at: '2026-08-24T04:00:00.001Z' }),
      ],
    })).statusCode).toBe(400);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 123 });
  });

  it('主人私人候选和任务来源显示安全 display name，响应不泄露技术 ID、receipt 或正文', async () => {
    const { app, database } = await makeApp();
    const saved = await saveSources(app, {
      save_request_id: 'save-private-display',
      sources: [trustedSource({ stable_message_id: 'private-display', display_name: '  \u202eAlice\u0000 需求  ' })],
    });
    const receipt = saved.json().sources[0].source_receipt as string;
    const decision = await submitDecisions(app, {
      decision_request_id: 'decision-private-display',
      window_id: 'window-private-display',
      window_start: '2026-08-24T00:00:00.000Z',
      window_end: '2026-08-24T00:05:00.000Z',
      decisions: [{ decision_ref: 'create', action: 'create_candidate', source_receipts: [receipt], title: '安全姓名候选' }],
    });
    expect(decision.statusCode).toBe(200);
    const candidateId = decision.json().decisions[0].candidate_id as string;
    const candidates = await app.inject({ method: 'GET', url: '/api/candidates' });
    expect(candidates.json().items[0]).toMatchObject({ id: candidateId, proposer_name: 'Alice 需求' });
    expect(JSON.stringify(candidates.json())).not.toMatch(/ou_requester_1|oc_conversation_1|private-display|请补充活动留存数据/u);
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidateId}/action`,
      payload: { action: 'accept', expectedVersion: 1 },
    });
    expect(accepted.statusCode).toBe(200);
    const taskId = accepted.json().task.id as string;
    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().sources[0]).toMatchObject({ display_name: 'Alice 需求' });
    expect(JSON.stringify(detail.json())).not.toContain(receipt);
    expect(JSON.stringify(detail.json())).not.toMatch(/ou_requester_1|oc_conversation_1|请补充活动留存数据/u);
    const safeSource = detail.json().sources[0];
    expect(privateSourceDtoSchema.parse(safeSource).display_name).toBe('Alice 需求');
    expect(() => minimalSourceDtoSchema.parse(safeSource)).toThrow();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
  });

  it('display name 以完整 grapheme 满足持久化边界，并让对象占位与飞书技术 ID 在私人投影回退', async () => {
    const { app, database } = await makeApp();
    const combiningHeavyName = Array.from({ length: 80 }, () => `a${'\u0301'.repeat(5)}`).join('');
    const displayNames = [combiningHeavyName, '  [OBJECT   object]  ', ' OU_Technical_Display_123 ', 'oc_technical_chat_456'];
    const saved = await saveSources(app, {
      save_request_id: 'save-display-name-boundaries',
      sources: displayNames.map((displayName, index) => trustedSource({
        client_ref: `display-${index}`,
        stable_message_id: `display-message-${index}`,
        display_name: displayName,
        occurred_at: `2026-08-24T00:0${index + 1}:00.000Z`,
      })),
    });
    expect(saved.statusCode).toBe(200);

    const stored = database.raw.prepare(
      'SELECT display_name, length(display_name) AS sqlite_length FROM source_event_revision ORDER BY occurred_at, id',
    ).all() as Array<{ display_name: string; sqlite_length: number }>;
    const expectedHeavyName = [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(combiningHeavyName.normalize('NFC'))]
      .slice(0, 32)
      .map((part) => part.segment)
      .join('');
    expect(stored).toHaveLength(4);
    const firstStored = stored[0]!;
    expect(firstStored).toEqual({ display_name: expectedHeavyName, sqlite_length: 160 });
    expect(firstStored.display_name.length).toBe(160);
    expect([...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(firstStored.display_name)]).toHaveLength(32);
    expect(stored.slice(1)).toEqual([
      { display_name: '需求方', sqlite_length: 3 },
      { display_name: '需求方', sqlite_length: 3 },
      { display_name: '需求方', sqlite_length: 3 },
    ]);

    const receipts = saved.json().sources.map((source: { source_receipt: string }) => source.source_receipt);
    const decision = await submitDecisions(app, {
      decision_request_id: 'decision-display-name-boundaries',
      window_id: 'window-display-name-boundaries',
      window_start: '2026-08-24T00:00:00.000Z',
      window_end: '2026-08-24T00:10:00.000Z',
      decisions: receipts.map((receipt: string, index: number) => ({
        decision_ref: `display-${index}`,
        action: 'create_candidate',
        source_receipts: [receipt],
        title: `显示名边界 ${index}`,
      })),
    });
    expect(decision.statusCode).toBe(200);
    const candidateIds = decision.json().decisions.map((item: { candidate_id: string }) => item.candidate_id);
    const candidates = await app.inject({ method: 'GET', url: '/api/candidates' });
    expect(candidates.statusCode).toBe(200);
    const candidateById = new Map(candidates.json().items.map((item: { id: string; proposer_name: string }) => [item.id, item]));
    const expectedNames = [expectedHeavyName, '需求方', '需求方', '需求方'];
    for (const [index, candidateId] of candidateIds.entries()) {
      expect(candidateById.get(candidateId)).toMatchObject({ proposer_name: expectedNames[index] });
      const accepted = await app.inject({
        method: 'POST',
        url: `/api/candidates/${candidateId}/action`,
        payload: { action: 'accept', expectedVersion: 1 },
      });
      expect(accepted.statusCode).toBe(200);
      const detail = await app.inject({ method: 'GET', url: `/api/tasks/${accepted.json().task.id}` });
      expect(detail.statusCode).toBe(200);
      expect(privateSourceDtoSchema.parse(detail.json().sources[0]).display_name).toBe(expectedNames[index]);
      expect(JSON.stringify(detail.json())).not.toMatch(/\[OBJECT\s+object\]|OU_Technical_Display_123|oc_technical_chat_456/iu);
    }
    const privateJson = JSON.stringify(candidates.json());
    expect(privateJson).not.toMatch(/\[OBJECT\s+object\]|OU_Technical_Display_123|oc_technical_chat_456/iu);
  });

  it('retry_later 只能通过 Cindy 决策入口有限推进，第三次后 receipt 失效', async () => {
    const { app, database } = await makeApp();
    const saved = await saveSources(app, { save_request_id: 'save-retry-limit', sources: [trustedSource()] });
    const receipt = saved.json().sources[0].source_receipt as string;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await submitDecisions(app, {
        decision_request_id: `decision-retry-${attempt}`,
        window_id: `window-retry-${attempt}`,
        window_start: '2026-08-24T00:00:00.000Z',
        window_end: `2026-08-24T00:0${attempt}:00.000Z`,
        decisions: [{ decision_ref: 'retry', action: 'retry_later', source_receipts: [receipt], reason: '临时中断。' }],
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().decisions[0].source_status).toBe(attempt === 3 ? 'invalid' : 'retryable');
    }
    expect(database.raw.prepare('SELECT processing_status, retry_count FROM source_event_revision WHERE receipt_digest IS NOT NULL').get())
      .toEqual({ processing_status: 'invalid', retry_count: 3 });
    const denied = await submitDecisions(app, {
      decision_request_id: 'decision-after-retry-limit', window_id: 'window-after-retry-limit',
      window_start: '2026-08-24T00:00:00.000Z', window_end: '2026-08-24T00:10:00.000Z',
      decisions: [{ decision_ref: 'd1', action: 'skip', source_receipts: [receipt] }],
    });
    expect(denied.statusCode).toBe(403);
    const reread = await saveSources(app, {
      save_request_id: 'save-retry-limit-reread',
      sources: [trustedSource({ revision: { sequence: 2 }, text: '重新读取后的当前版本。' })],
    });
    expect(reread.statusCode).toBe(200);
    expect(reread.json().sources[0]).toMatchObject({ source_status: 'pending_decision', revision: { generation: 2, sequence: 2 } });
  });

  it('receipt 决策只接受当前同 owner 来源；伪造、跨 owner、旧 revision 和 invalid 均零业务写入', async () => {
    const { app, database } = await makeApp();
    const saved = await saveSources(app, { save_request_id: 'save-receipt-gates', sources: [trustedSource()] });
    const receipt = saved.json().sources[0].source_receipt as string;
    const higher = await saveSources(app, { save_request_id: 'save-receipt-gates-v2', sources: [trustedSource({ revision: { sequence: 2 }, text: '第二版。' })] });
    const receipt2 = higher.json().sources[0].source_receipt as string;
    const foreignToken = 'different-cindy-owner-token';
    const { app: foreignApp } = await makeApp(foreignToken, database, 'different-connected-account-anchor');
    const baseDecision = (sourceReceipt: string, id: string) => ({
      decision_request_id: id,
      window_id: id,
      window_start: '2026-08-24T00:00:00.000Z',
      window_end: '2026-08-24T00:05:00.000Z',
      decisions: [{ decision_ref: 'd1', action: 'create_candidate', source_receipts: [sourceReceipt], title: '可信候选' }],
    });
    expect((await submitDecisions(app, baseDecision('forged_receipt_value_that_is_long_enough_123', 'decision-forged'))).statusCode).toBe(403);
    expect((await submitDecisions(foreignApp, baseDecision(receipt2, 'decision-foreign'), foreignToken)).statusCode).toBe(403);
    expect((await submitDecisions(app, baseDecision(receipt, 'decision-old'))).statusCode).toBe(403);
    database.raw.prepare("UPDATE source_event_revision SET processing_status = 'invalid' WHERE receipt_digest IS NOT NULL AND processing_status = 'pending_decision'").run();
    expect((await submitDecisions(app, baseDecision(receipt2, 'decision-invalid'))).statusCode).toBe(403);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number }).count).toBe(0);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_decision_request').get() as { count: number }).count).toBe(0);
  });

  it('决策成功只消费 receipts；CAS 失败保留已保存来源，成功重放不重复写入', async () => {
    const { app, database } = await makeApp();
    makeTask(database);
    const saved = await saveSources(app, { save_request_id: 'save-update-task', sources: [trustedSource()] });
    const receipt = saved.json().sources[0].source_receipt as string;
    const conflictPayload = {
      decision_request_id: 'decision-update-conflict', window_id: 'window-update-conflict',
      window_start: '2026-08-24T00:00:00.000Z', window_end: '2026-08-24T00:05:00.000Z',
      decisions: [{ decision_ref: 'd1', action: 'update_task', source_receipts: [receipt], task_key: 'task-cindy-intake-1', expected_version: 2, next_step: '新口径' }],
    };
    const conflict = await submitDecisions(app, conflictPayload);
    expect(conflict.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT processing_status FROM source_event_revision WHERE receipt_digest IS NOT NULL ORDER BY revision_number DESC LIMIT 1').get())
      .toEqual({ processing_status: 'pending_decision' });
    expect(database.raw.prepare('SELECT version, next_step FROM task WHERE id = ?').get('task-cindy-intake-1')).toEqual({ version: 1, next_step: '补充分区口径' });

    const successPayload = { ...conflictPayload, decision_request_id: 'decision-update-success', window_id: 'window-update-success', decisions: [{ ...conflictPayload.decisions[0], expected_version: 1 }] };
    const success = await submitDecisions(app, successPayload);
    expect(success.statusCode).toBe(200);
    expect(success.json().decisions[0]).toMatchObject({ action: 'update_task', source_status: 'processed', version: 2 });
    const replay = await submitDecisions(app, successPayload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ duplicate: true });
    expect(database.raw.prepare('SELECT version, next_step FROM task WHERE id = ?').get('task-cindy-intake-1')).toEqual({ version: 2, next_step: '新口径' });
    const foreignToken = 'different-cindy-account-token';
    const { app: foreignApp } = await makeApp(foreignToken, database, 'different-connected-account-anchor');
    const foreignReplay = await submitDecisions(foreignApp, successPayload, foreignToken);
    expect(foreignReplay.statusCode).toBe(403);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_event WHERE event_type = ?').get('task_cindy_intake_update'))
      .toEqual({ count: 1 });
  });

  it('认证上下文由服务端派生，body 自报 owner/account 被拒；空 decisions 仍推进窗口', async () => {
    const { app, database } = await makeApp();
    const rejected = await saveSources(app, { save_request_id: 'save-auth-body', owner_scope: 'forged', sources: [trustedSource()] });
    expect(rejected.statusCode).toBe(400);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(0);
    const empty = await submitDecisions(app, {
      decision_request_id: 'decision-empty-window',
      window_id: 'window-empty',
      window_start: '2026-08-24T00:00:00.000Z',
      window_end: '2026-08-24T00:10:00.000Z',
      decisions: [],
    });
    expect(empty.statusCode).toBe(200);
    expect(database.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'intake_window_end'").get())
      .toEqual({ value_json: '{"window_end":"2026-08-24T00:10:00.000Z"}' });
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
