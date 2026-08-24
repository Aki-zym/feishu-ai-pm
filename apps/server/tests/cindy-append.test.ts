import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createCindyAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

describe('Cindy candidate append contract', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  const databases: AppDatabase[] = [];
  const roots: string[] = [];
  const token = 'test-cindy-append-token';
  const accountAnchor = 'test-cindy-append-account';
  const receiptSecret = 'test-cindy-append-receipt-secret-0123456789abcdef';

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function makeApp(path = ':memory:', auth: { token?: string; accountAnchor?: string; receiptSecret?: string } = {}) {
    const database = new AppDatabase(path, false);
    databases.push(database);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path === ':memory:' ? ':memory:' : `file:${path}` });
    const app = await buildApp(new PmService(database, createCindyAdapters(config), config), {
      serveWeb: false,
      cindyIntegrationToken: auth.token ?? token,
      cindyIntegrationAccountAnchor: auth.accountAnchor ?? accountAnchor,
      cindyReceiptSecret: auth.receiptSecret ?? receiptSecret,
    });
    apps.push(app);
    return { app, database };
  }

  function makeTask(database: AppDatabase, id: string, index: number) {
    const timestamp = '2026-08-24T00:00:00.000Z';
    database.raw.prepare(`INSERT INTO task
      (id, title, proposer_name, describe, status, schedule_at, planned_start_at, planned_due_at,
       next_step, risk, waiting_reason, version, completed_at, archived_at, deleted_at, record_state,
       merged_into_task_id, thread_id, auto_update_paused, created_at, updated_at)
      VALUES (?, ?, '需求方', ?, 'planned', NULL, NULL, NULL,
       '继续确认', 'low', NULL, 1, NULL, NULL, NULL, 'active', NULL, NULL, 0, ?, ?)`)
      .run(id, `正式任务 ${String(index).padStart(2, '0')}`, `任务摘要 ${index}`, timestamp, timestamp);
  }

  function source(index: number, title = `需求 ${index}`, chat = 'append-chat') {
    return {
      client_ref: `s${index}`,
      provider: 'synthetic',
      source_kind: 'synthetic_message',
      stable_message_id: `append-message-${index}`,
      occurred_at: `2026-08-24T01:${String(index % 60).padStart(2, '0')}:00.000Z`,
      sender_id: `sender-${index}`,
      display_name: '合成需求方',
      chat_id: chat,
      thread_id: `${chat}-thread`,
      mentioned_owner: true,
      sender_is_owner: false,
      message_type: 'text',
      text: title,
      revision: { sequence: 1 },
    };
  }

  async function save<const T extends readonly Record<string, unknown>[]>(
    app: Awaited<ReturnType<typeof buildApp>>,
    requestId: string,
    sources: T,
  ): Promise<{ [K in keyof T]: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/sources',
      headers: { authorization: `Bearer ${token}` },
      payload: { save_request_id: requestId, sources },
    });
    expect(response.statusCode).toBe(200);
    return response.json().sources.map((item: { source_receipt: string }) => item.source_receipt) as unknown as { [K in keyof T]: string };
  }

  async function submit(app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/decisions',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  function batchBase(receipts: readonly string[], batchId: string, requestId: string) {
    return {
      decision_request_id: requestId,
      batch_id: batchId,
      window_id: `window-${batchId}`,
      window_start: '2026-08-24T01:00:00.000Z',
      window_end: '2026-08-24T02:00:00.000Z',
      snapshot_receipts: receipts,
    };
  }

  async function createCandidate(app: Awaited<ReturnType<typeof buildApp>>, index = 1) {
    const [receipt] = await save(app, `save-create-${index}`, [source(index, `目标 ${index}`)]);
    const payload = {
      ...batchBase([receipt], `batch-create-${index}`, `decision-create-${index}`),
      groups: [{
        group_key: 'create', action: 'create_candidate', anchor_receipt: receipt,
        field_evidence_receipts: [], title: `候选 ${index}`, describe: `候选摘要 ${index}`, next_step: '继续确认',
      }],
      primary_dispositions: [{ disposition_ref: 'create', source_receipt: receipt, disposition: 'group', primary_group_key: 'create' }],
    };
    const response = await submit(app, payload);
    expect(response.statusCode).toBe(200);
    const internalId = response.json().groups[0].candidate_id as string;
    const context = await app.inject({
      method: 'POST', url: '/api/integrations/cindy/context', headers: { authorization: `Bearer ${token}` }, payload: {},
    });
    expect(context.statusCode).toBe(200);
    const item = context.json().candidates.find((candidate: { title: string }) => candidate.title === `候选 ${index}`);
    expect(item?.candidate_key).toMatch(/^cnd_[A-Za-z0-9_-]{43}$/u);
    return { receipt, internalId, candidateKey: item.candidate_key as string, version: item.version as number };
  }

  function appendBatch(receipts: readonly string[], candidateKey: string, expectedVersion: number, suffix: string, appendRequestId = `append-${suffix}`) {
    return {
      ...batchBase(receipts, `batch-append-${suffix}`, `decision-append-${suffix}`),
      groups: [{
        group_key: 'append', action: 'append_candidate', anchor_receipt: receipts[0],
        field_evidence_receipts: receipts.slice(1), append_request_id: appendRequestId,
        candidate_key: candidateKey, expected_candidate_version: expectedVersion,
        source_receipts: receipts, title: `候选追加 ${suffix}`, describe: `追加摘要 ${suffix}`,
        field_evidence: { title: receipts, describe: receipts },
      }],
      primary_dispositions: receipts.map((receipt, index) => ({
        disposition_ref: `append-${index}`, source_receipt: receipt, disposition: 'group', primary_group_key: 'append',
      })),
    };
  }

  it('第二窗口把新 primary group 原子追加到同一候选，并支持首次结果重放和异 payload 冲突', async () => {
    const { app, database } = await makeApp();
    const candidate = await createCandidate(app);
    const receipts = await save(app, 'save-append-window', [source(2, '同一需求补充一'), source(3, '同一需求补充二')]);
    const payload = appendBatch(receipts, candidate.candidateKey, candidate.version, 'same');
    const appended = await submit(app, payload);
    expect(appended.statusCode).toBe(200);
    expect(appended.json().groups[0]).toMatchObject({ action: 'append_candidate', candidate_key: candidate.candidateKey, version: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT version, title, describe FROM candidate_request WHERE id = ?').get(candidate.internalId))
      .toEqual({ version: 2, title: '候选追加 same', describe: '追加摘要 same' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_demand_unit_source').get()).toEqual({ count: 3 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_candidate_source_consumption').get()).toEqual({ count: 3 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_append_field_evidence').get()).toEqual({ count: 4 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'cindy_append_candidate'").get())
      .toEqual({ count: 1 });

    const replay = await submit(app, payload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...appended.json(), duplicate: true });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_append_request').get()).toEqual({ count: 1 });

    const [differentReceipt] = await save(app, 'save-append-different', [source(4, '不同 payload')]);
    const different = await submit(app, appendBatch([differentReceipt], candidate.candidateKey, 2, 'different', 'append-same'));
    expect(different.statusCode).toBe(409);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM cindy_batch WHERE batch_id = 'batch-append-different'").get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT processing_status FROM source_event_revision WHERE receipt_digest IS NOT NULL ORDER BY created_at DESC LIMIT 1').get())
      .toEqual({ processing_status: 'pending_decision' });
  });

  it('candidate CAS、跨 owner opaque key 和已消费来源均 fail closed 且零业务写入', async () => {
    const { app, database } = await makeApp();
    const candidate = await createCandidate(app, 10);
    const [staleReceipt] = await save(app, 'save-stale-append', [source(11)]);
    const stale = await submit(app, appendBatch([staleReceipt], candidate.candidateKey, candidate.version + 1, 'stale'));
    expect(stale.statusCode).toBe(409);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM cindy_batch WHERE batch_id = 'batch-append-stale'").get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT version FROM candidate_request WHERE id = ?').get(candidate.internalId)).toEqual({ version: 1 });

    const foreign = await makeApp();
    const [foreignReceipt] = await save(foreign.app, 'save-foreign-append', [source(12)]);
    const foreignAttempt = await submit(foreign.app, appendBatch([foreignReceipt], candidate.candidateKey, 1, 'foreign'));
    expect(foreignAttempt.statusCode).toBe(403);
    expect(foreign.database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_append_request').get()).toEqual({ count: 0 });

    const consumed = await submit(app, appendBatch([candidate.receipt], candidate.candidateKey, 1, 'consumed'));
    expect(consumed.statusCode).toBe(403);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_append_request').get()).toEqual({ count: 0 });
  });

  it('候选状态变化、跨 group/shared context 与事务中途失败均零写入', async () => {
    const { app, database } = await makeApp();
    const candidate = await createCandidate(app, 30);

    database.raw.prepare("UPDATE candidate_request SET state = 'accepted' WHERE id = ?").run(candidate.internalId);
    const [stateReceipt] = await save(app, 'save-state-reject', [source(31)]);
    const stateRejected = await submit(app, appendBatch([stateReceipt], candidate.candidateKey, 1, 'state-reject'));
    expect(stateRejected.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT processing_status FROM source_event_revision WHERE receipt_digest IS NOT NULL ORDER BY created_at DESC LIMIT 1').get())
      .toEqual({ processing_status: 'pending_decision' });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM cindy_batch WHERE batch_id = 'batch-append-state-reject'").get()).toEqual({ count: 0 });

    database.raw.prepare("UPDATE candidate_request SET state = 'pending' WHERE id = ?").run(candidate.internalId);
    const [primary, shared] = await save(app, 'save-shared-reject', [source(32), source(33)]);
    const sharedRejected = await submit(app, {
      ...batchBase([primary, shared], 'batch-shared-reject', 'decision-shared-reject'),
      groups: [
        {
          group_key: 'append', action: 'append_candidate', anchor_receipt: primary,
          field_evidence_receipts: [], append_request_id: 'append-shared-reject',
          candidate_key: candidate.candidateKey, expected_candidate_version: 1,
          source_receipts: [primary, shared], title: '不应追加', field_evidence: { title: [primary] },
        },
        { group_key: 'context', action: 'create_candidate', anchor_receipt: shared, field_evidence_receipts: [], title: '独立目标' },
      ],
      primary_dispositions: [
        { disposition_ref: 'primary', source_receipt: primary, disposition: 'group', primary_group_key: 'append' },
        { disposition_ref: 'shared', source_receipt: shared, disposition: 'group', primary_group_key: 'context' },
      ],
      shared_context: [{ source_receipt: shared, shared_group_key: 'append' }],
    });
    expect(sharedRejected.statusCode).toBe(400);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM cindy_batch WHERE batch_id = 'batch-shared-reject'").get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });

    const [faultReceipt] = await save(app, 'save-append-fault', [source(34)]);
    database.raw.exec(`CREATE TRIGGER fail_cindy_append_evidence
      BEFORE INSERT ON cindy_append_field_evidence
      BEGIN SELECT RAISE(ABORT, 'synthetic append evidence failure'); END;`);
    const before = database.raw.prepare('SELECT version, title FROM candidate_request WHERE id = ?').get(candidate.internalId);
    const faulted = await submit(app, appendBatch([faultReceipt], candidate.candidateKey, 1, 'fault'));
    expect(faulted.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT version, title FROM candidate_request WHERE id = ?').get(candidate.internalId)).toEqual(before);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM cindy_batch WHERE batch_id = 'batch-append-fault'").get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM cindy_append_request WHERE append_request_id = 'append-fault'").get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_demand_unit_source WHERE demand_unit_id = (SELECT demand_unit_id FROM candidate_request WHERE id = ?)').get(candidate.internalId))
      .toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT processing_status FROM source_event_revision WHERE receipt_digest IS NOT NULL ORDER BY created_at DESC LIMIT 1').get())
      .toEqual({ processing_status: 'pending_decision' });
  });

  it('歧义保持零消费；主人选择 append option 后用新 request 原子恢复并可重放', async () => {
    const { app, database } = await makeApp();
    const candidate = await createCandidate(app, 20);
    const [titleReceipt, describeReceipt] = await save(app, 'save-owner-append', [
      source(21, '标题证据'), source(22, '摘要证据'),
    ]);
    const pending = await submit(app, {
      ...batchBase([titleReceipt, describeReceipt], 'batch-owner-append', 'decision-owner-append'),
      groups: [],
      primary_dispositions: [
        { disposition_ref: 'owner-a', source_receipt: titleReceipt, disposition: 'needs_owner', owner_decision_key: 'owner-append' },
        { disposition_ref: 'owner-b', source_receipt: describeReceipt, disposition: 'needs_owner', owner_decision_key: 'owner-append' },
      ],
      owner_decisions: [{
        decision_key: 'owner-append', group_key: 'owner-append-group', reason: '两个方向接近，请主人选择。',
        options: [{
          option_key: 'append', action: 'append_candidate', candidate_key: candidate.candidateKey,
          candidate_version: candidate.version, title: '主人确认后的补充标题', describe: '主人确认后的补充摘要',
          field_evidence: { title: [titleReceipt], describe: [describeReceipt] },
        }],
      }],
    });
    expect(pending.statusCode).toBe(200);
    const decision = pending.json().owner_decisions[0];
    expect(decision.options[0]).toMatchObject({ action: 'append_candidate', available: true });
    expect(JSON.stringify(decision)).not.toContain(candidate.candidateKey);
    expect(database.raw.prepare('SELECT processing_status FROM source_event_revision WHERE id = (SELECT source_revision_id FROM cindy_owner_decision_source WHERE decision_id = ?)').get(decision.decision_id))
      .toEqual({ processing_status: 'pending_decision' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_append_request').get()).toEqual({ count: 0 });

    const resolvePayload = {
      decision_request_id: 'resolve-owner-append', expected_version: 1, action: 'append_candidate',
      option_key: 'append', append_request_id: 'append-owner-choice',
    };
    const resolved = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${decision.decision_id}/resolve`,
      headers: { authorization: `Bearer ${token}` }, payload: resolvePayload,
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ status: 'resolved', version: 2, resolution_action: 'append_candidate' });
    expect(database.raw.prepare('SELECT version, title FROM candidate_request WHERE id = ?').get(candidate.internalId))
      .toEqual({ version: 2, title: '主人确认后的补充标题' });
    expect(database.raw.prepare('SELECT processing_status FROM source_event_revision WHERE id = (SELECT source_revision_id FROM cindy_owner_decision_source WHERE decision_id = ?)').get(decision.decision_id))
      .toEqual({ processing_status: 'processed' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_append_request WHERE owner_decision_id = ?').get(decision.decision_id))
      .toEqual({ count: 1 });
    expect(database.raw.prepare(
      `SELECT evidence.field_name, decision_source.source_order
         FROM cindy_append_field_evidence AS evidence
         JOIN cindy_owner_decision_source AS decision_source
           ON decision_source.decision_id = ? AND decision_source.source_revision_id = evidence.source_revision_id
        WHERE evidence.append_request_id = 'append-owner-choice'
        ORDER BY evidence.field_name`,
    ).all(decision.decision_id)).toEqual([
      { field_name: 'describe', source_order: 1 },
      { field_name: 'title', source_order: 0 },
    ]);
    const replay = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${decision.decision_id}/resolve`,
      headers: { authorization: `Bearer ${token}` }, payload: resolvePayload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(resolved.json());
  });

  it('needs_owner append 缺少逐字段 evidence 时整批 400 且来源保持 pending', async () => {
    const { app, database } = await makeApp();
    const candidate = await createCandidate(app, 35);
    const [receipt] = await save(app, 'save-owner-missing-evidence', [source(36)]);
    const batchCount = database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_batch').get();
    const rejected = await submit(app, {
      ...batchBase([receipt], 'batch-owner-missing-evidence', 'decision-owner-missing-evidence'),
      groups: [],
      primary_dispositions: [{
        disposition_ref: 'owner', source_receipt: receipt, disposition: 'needs_owner', owner_decision_key: 'owner-missing',
      }],
      owner_decisions: [{
        decision_key: 'owner-missing', group_key: 'owner-missing-group', reason: '需要主人确认。',
        options: [{
          option_key: 'append', action: 'append_candidate', candidate_key: candidate.candidateKey,
          candidate_version: candidate.version, title: '缺少字段证据',
        }],
      }],
    });
    expect(rejected.statusCode).toBe(400);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_batch').get()).toEqual(batchCount);
    expect(database.raw.prepare('SELECT processing_status FROM source_event_revision WHERE receipt_digest IS NOT NULL ORDER BY created_at DESC LIMIT 1').get())
      .toEqual({ processing_status: 'pending_decision' });
  });

  it('主人选择 append 时若候选版本已变化则 decision 保持 pending 且来源不消费', async () => {
    const { app, database } = await makeApp();
    const candidate = await createCandidate(app, 40);
    const [receipt] = await save(app, 'save-owner-cas', [source(41)]);
    const pending = await submit(app, {
      ...batchBase([receipt], 'batch-owner-cas', 'decision-owner-cas'),
      groups: [],
      primary_dispositions: [{
        disposition_ref: 'owner', source_receipt: receipt, disposition: 'needs_owner', owner_decision_key: 'owner-cas',
      }],
      owner_decisions: [{
        decision_key: 'owner-cas', group_key: 'owner-cas-group', reason: '需要主人确认。',
        options: [{
          option_key: 'append', action: 'append_candidate', candidate_key: candidate.candidateKey,
          candidate_version: candidate.version, title: '主人选择追加', field_evidence: { title: [receipt] },
        }],
      }],
    });
    expect(pending.statusCode).toBe(200);
    const decision = pending.json().owner_decisions[0];
    database.raw.prepare('UPDATE candidate_request SET version = version + 1 WHERE id = ?').run(candidate.internalId);
    const rejected = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${decision.decision_id}/resolve`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        decision_request_id: 'resolve-owner-cas', expected_version: decision.version,
        action: 'append_candidate', option_key: 'append', append_request_id: 'append-owner-cas',
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT status, version FROM cindy_owner_decision WHERE id = ?').get(decision.decision_id))
      .toEqual({ status: 'pending', version: 1 });
    expect(database.raw.prepare('SELECT processing_status FROM source_event_revision WHERE id = (SELECT source_revision_id FROM cindy_owner_decision_source WHERE decision_id = ?)').get(decision.decision_id))
      .toEqual({ processing_status: 'pending_decision' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_append_request WHERE owner_decision_id = ?').get(decision.decision_id))
      .toEqual({ count: 0 });
  });

  it('get_pm_context 使用 owner scope、默认 20、cursor、确定性 query 与 receipts 派生会话过滤', async () => {
    const { app, database } = await makeApp();
    const sources = Array.from({ length: 22 }, (_, index) => source(100 + index, `列表目标 ${String(index).padStart(2, '0')}`, index === 21 ? 'other-chat' : 'list-chat'));
    const receipts = await save(app, 'save-context-list', sources);
    const groups = receipts.map((receipt, index) => ({
      group_key: `g${index}`, action: 'create_candidate', anchor_receipt: receipt,
      field_evidence_receipts: [], title: `列表候选 ${String(index).padStart(2, '0')}`, describe: `安全摘要 ${index}`,
    }));
    const created = await submit(app, {
      ...batchBase(receipts, 'batch-context-list', 'decision-context-list'),
      groups,
      primary_dispositions: receipts.map((receipt, index) => ({
        disposition_ref: `d${index}`, source_receipt: receipt, disposition: 'group', primary_group_key: `g${index}`,
      })),
    });
    expect(created.statusCode).toBe(200);
    const first = await app.inject({
      method: 'POST', url: '/api/integrations/cindy/context', headers: { authorization: `Bearer ${token}` }, payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().candidates).toHaveLength(20);
    expect(first.json().next_candidate_cursor).toEqual(expect.any(String));
    const internalIds = (database.raw.prepare('SELECT id FROM candidate_request').all() as Array<{ id: string }>).map((row) => row.id);
    const serializedContext = JSON.stringify(first.json());
    for (const internalId of internalIds) expect(serializedContext).not.toContain(internalId);
    const cursorBytes = Buffer.from(String(first.json().next_candidate_cursor).slice(5), 'base64url').toString('utf8');
    for (const internalId of internalIds) expect(cursorBytes).not.toContain(internalId);
    const second = await app.inject({
      method: 'POST', url: '/api/integrations/cindy/context', headers: { authorization: `Bearer ${token}` },
      payload: { candidate_cursor: first.json().next_candidate_cursor, candidate_limit: 50 },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().candidates).toHaveLength(2);
    const candidateKeys = [...first.json().candidates, ...second.json().candidates]
      .map((item: { candidate_key: string }) => item.candidate_key);
    expect(new Set(candidateKeys).size).toBe(22);

    const crossKind = await app.inject({
      method: 'POST', url: '/api/integrations/cindy/context', headers: { authorization: `Bearer ${token}` },
      payload: { task_cursor: first.json().next_candidate_cursor },
    });
    expect(crossKind.statusCode).toBe(400);
    const foreign = await makeApp(':memory:', {
      accountAnchor: 'foreign-context-account',
      receiptSecret: 'foreign-context-receipt-secret-0123456789abcdef',
    });
    const crossOwner = await foreign.app.inject({
      method: 'POST', url: '/api/integrations/cindy/context', headers: { authorization: `Bearer ${token}` },
      payload: { candidate_cursor: first.json().next_candidate_cursor },
    });
    expect(crossOwner.statusCode).toBe(400);
    const queried = await app.inject({
      method: 'POST', url: '/api/integrations/cindy/context', headers: { authorization: `Bearer ${token}` }, payload: { query: '候选 07' },
    });
    expect(queried.json().candidates.map((item: { title: string }) => item.title)).toEqual(['列表候选 07']);
    const filtered = await app.inject({
      method: 'POST', url: '/api/integrations/cindy/context', headers: { authorization: `Bearer ${token}` },
      payload: { conversation_receipts: [receipts[21]], candidate_limit: 50 },
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().candidates.map((item: { title: string }) => item.title)).toEqual(['列表候选 21']);
    expect(filtered.json().conversation_key).toMatch(/^cnv_/u);
    const injected = await app.inject({
      method: 'POST', url: '/api/integrations/cindy/context', headers: { authorization: `Bearer ${token}` }, payload: { chat_id: 'oc_technical' },
    });
    expect(injected.statusCode).toBe(400);
  });

  it('get_pm_context 对正式任务执行默认/最大/cursor稳定排序和确定性 query', async () => {
    const { app, database } = await makeApp();
    const count = 22;
    for (let index = 0; index < count; index += 1) makeTask(database, `task-context-${String(index).padStart(2, '0')}`, index);
    const receipts = await save(app, 'save-task-context', Array.from({ length: count }, (_, index) => source(300 + index, `任务来源 ${index}`, 'task-context-chat')));
    const updated = await submit(app, {
      ...batchBase(receipts, 'batch-task-context', 'decision-task-context'),
      groups: receipts.map((receipt, index) => ({
        group_key: `task${index}`, action: 'update_task', anchor_receipt: receipt,
        field_evidence_receipts: [], task_key: `task-context-${String(index).padStart(2, '0')}`,
        expected_version: 1, next_step: `上下文下一步 ${index}`,
      })),
      primary_dispositions: receipts.map((receipt, index) => ({
        disposition_ref: `task${index}`, source_receipt: receipt, disposition: 'group', primary_group_key: `task${index}`,
      })),
    });
    expect(updated.statusCode).toBe(200);
    const first = await app.inject({
      method: 'POST', url: '/api/integrations/cindy/context', headers: { authorization: `Bearer ${token}` }, payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().tasks).toHaveLength(20);
    expect(first.json().tasks[0].task_key).toBe('task-context-00');
    expect(first.json().next_task_cursor).toEqual(expect.any(String));
    const second = await app.inject({
      method: 'POST', url: '/api/integrations/cindy/context', headers: { authorization: `Bearer ${token}` },
      payload: { task_cursor: first.json().next_task_cursor, task_limit: 50 },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().tasks.map((item: { task_key: string }) => item.task_key)).toEqual(['task-context-20', 'task-context-21']);
    const queried = await app.inject({
      method: 'POST', url: '/api/integrations/cindy/context', headers: { authorization: `Bearer ${token}` },
      payload: { task_limit: 50, query: '正式任务 07' },
    });
    expect(queried.statusCode).toBe(200);
    expect(queried.json().tasks.map((item: { task_key: string }) => item.task_key)).toEqual(['task-context-07']);
  });

  it('磁盘 SQLite 双连接 CAS race 只允许一个 append 胜出，失败分支零写入', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-append-race-'));
    roots.push(root);
    const path = join(root, 'pm.sqlite');
    const first = await makeApp(path);
    const candidate = await createCandidate(first.app, 200);
    const second = await makeApp(path);
    const [receiptA, receiptB] = await save(first.app, 'save-race-append', [source(201), source(202)]);
    const [left, right] = await Promise.all([
      submit(first.app, appendBatch([receiptA], candidate.candidateKey, 1, 'race-a')),
      submit(second.app, appendBatch([receiptB], candidate.candidateKey, 1, 'race-b')),
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
    expect(first.database.raw.prepare('SELECT version FROM candidate_request WHERE id = ?').get(candidate.internalId)).toEqual({ version: 2 });
    expect(first.database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_append_request').get()).toEqual({ count: 1 });
    expect(first.database.raw.prepare("SELECT COUNT(*) AS count FROM source_event_revision WHERE processing_status = 'processed'").get())
      .toEqual({ count: 2 });
    expect(first.database.raw.prepare("SELECT COUNT(*) AS count FROM source_event_revision WHERE processing_status = 'pending_decision'").get())
      .toEqual({ count: 1 });
  });
});
