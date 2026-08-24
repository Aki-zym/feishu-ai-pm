import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createCindyAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

describe('Cindy grouped batch contract', () => {
  const databases: AppDatabase[] = [];
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  const token = 'test-cindy-batch-token';
  const accountAnchor = 'test-cindy-batch-account';
  const receiptSecret = 'test-cindy-batch-receipt-secret-0123456789abcdef';

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const database of databases.splice(0)) database.close();
  });

  async function makeApp(existingDatabase?: AppDatabase, bearer = token, anchor = accountAnchor) {
    const database = existingDatabase ?? new AppDatabase(':memory:', false);
    if (!existingDatabase) databases.push(database);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const app = await buildApp(new PmService(database, createCindyAdapters(config), config), {
      serveWeb: false,
      cindyIntegrationToken: bearer,
      cindyIntegrationAccountAnchor: anchor,
      cindyReceiptSecret: receiptSecret,
    });
    apps.push(app);
    return { app, database };
  }

  function source(index: number, text = `合成消息 ${index}`) {
    return {
      client_ref: `s${index}`,
      provider: 'synthetic',
      source_kind: 'synthetic_message',
      stable_message_id: `batch-message-${index}`,
      occurred_at: `2026-08-24T00:${String(index).padStart(2, '0')}:00.000Z`,
      sender_id: `synthetic-sender-${index}`,
      display_name: `需求方 ${index}`,
      chat_id: 'synthetic-batch-chat',
      thread_id: 'synthetic-batch-thread',
      mentioned_owner: index === 1,
      sender_is_owner: false,
      message_type: 'text',
      text,
      revision: { sequence: 1 },
    };
  }

  async function save(app: Awaited<ReturnType<typeof buildApp>>, sources: Array<Record<string, unknown>>, requestId = 'save-batch') {
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/sources',
      headers: { authorization: `Bearer ${token}` },
      payload: { save_request_id: requestId, sources },
    });
    expect(response.statusCode).toBe(200);
    return response.json().sources.map((item: { source_receipt: string }) => item.source_receipt) as string[];
  }

  function batch(receipts: string[], overrides: Record<string, unknown> = {}) {
    return {
      decision_request_id: 'decision-batch-1',
      batch_id: 'batch-1',
      window_id: 'window-1',
      window_start: '2026-08-24T00:00:00.000Z',
      window_end: '2026-08-24T00:20:00.000Z',
      snapshot_receipts: receipts,
      groups: [],
      primary_dispositions: receipts.map((receipt, index) => ({
        disposition_ref: `d${index + 1}`,
        source_receipt: receipt,
        disposition: 'skip',
      })),
      ...overrides,
    };
  }

  async function submit(app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>, bearer = token) {
    return app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/decisions',
      headers: { authorization: `Bearer ${bearer}` },
      payload,
    });
  }

  function seedTask(database: AppDatabase) {
    const timestamp = '2026-08-24T00:00:00.000Z';
    database.raw.prepare(`INSERT INTO task
      (id, title, proposer_name, describe, status, schedule_at, planned_start_at, planned_due_at,
       next_step, risk, waiting_reason, version, completed_at, archived_at, deleted_at, record_state,
       merged_into_task_id, thread_id, auto_update_paused, created_at, updated_at)
      VALUES ('task-batch-cas', '旧任务', '需求方', '旧描述', 'planned', NULL, NULL, NULL,
       '旧下一步', 'low', NULL, 1, NULL, NULL, NULL, 'active', NULL, NULL, 0, ?, ?)`).run(timestamp, timestamp);
  }

  it('可控 Agent 替身能把三条延续消息归为一个目标，同时把另一个目标和闲聊分开', async () => {
    const { app, database } = await makeApp();
    const receipts = await save(app, [
      source(1, '登录报错。'),
      source(2, '主要是扫码登录。'),
      source(3, '小王下周处理。'),
      source(4, '另一个目标：补充销售周报。'),
      source(5, '周报需要按区域拆分。'),
      source(6, '谢谢，收到。'),
    ]);
    const response = await submit(app, batch(receipts, {
      groups: [
        {
          group_key: 'login-fix', action: 'create_candidate', anchor_receipt: receipts[0],
          field_evidence_receipts: [receipts[1], receipts[2]], title: '修复扫码登录报错',
          describe: '确认扫码登录故障范围并由小王跟进。', next_step: '下周给出修复结论。',
        },
        {
          group_key: 'sales-report', action: 'create_candidate', anchor_receipt: receipts[3],
          field_evidence_receipts: [receipts[4]], title: '补充区域销售周报',
          describe: '按区域补齐销售周报。', next_step: '确认区域拆分口径。',
        },
      ],
      primary_dispositions: [
        ...receipts.slice(0, 3).map((sourceReceipt, index) => ({ disposition_ref: `login-${index}`, source_receipt: sourceReceipt, disposition: 'group', primary_group_key: 'login-fix' })),
        ...receipts.slice(3, 5).map((sourceReceipt, index) => ({ disposition_ref: `report-${index}`, source_receipt: sourceReceipt, disposition: 'group', primary_group_key: 'sales-report' })),
        { disposition_ref: 'chat-skip', source_receipt: receipts[5], disposition: 'skip', reason: '礼貌确认，不形成交付物。' },
      ],
    }));
    expect(response.statusCode).toBe(200);
    expect(response.json().groups).toHaveLength(2);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_demand_unit_source').get()).toEqual({ count: 5 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM source_event_revision WHERE processing_status = 'skipped'").get()).toEqual({ count: 1 });
  });

  it('shared_context 只记录批次关系，不进入 secondary 候选来源；规范化重放不重复', async () => {
    const { app, database } = await makeApp();
    const receipts = await save(app, [source(1), source(2), source(3)]);
    const payload = batch(receipts, {
      groups: [
        { group_key: 'a', action: 'create_candidate', anchor_receipt: receipts[0], field_evidence_receipts: [], title: '目标 A' },
        { group_key: 'b', action: 'create_candidate', anchor_receipt: receipts[1], field_evidence_receipts: [receipts[2]], title: '目标 B' },
      ],
      primary_dispositions: [
        { disposition_ref: 'a1', source_receipt: receipts[0], disposition: 'group', primary_group_key: 'a' },
        { disposition_ref: 'b1', source_receipt: receipts[1], disposition: 'group', primary_group_key: 'b' },
        { disposition_ref: 'b2', source_receipt: receipts[2], disposition: 'group', primary_group_key: 'b' },
      ],
      shared_context: [{ source_receipt: receipts[0], shared_group_key: 'b' }],
    });
    const first = await submit(app, payload);
    expect(first.statusCode).toBe(200);
    const reordered = {
      ...payload,
      snapshot_receipts: [...receipts].reverse(),
      groups: [...(payload.groups as unknown[])].reverse(),
      primary_dispositions: [...(payload.primary_dispositions as unknown[])].reverse(),
    };
    const replay = await submit(app, reordered);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().duplicate).toBe(true);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_batch_shared_context').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 2 });
    const groupB = first.json().groups.find((item: { group_key: string }) => item.group_key === 'b');
    expect(database.raw.prepare(`SELECT COUNT(*) AS count FROM source_demand_unit_source
      WHERE demand_unit_id = (SELECT demand_unit_id FROM candidate_request WHERE id = ?)`)
      .get(groupB.candidate_id)).toEqual({ count: 2 });
    const conflict = await submit(app, { ...payload, groups: [{ ...(payload.groups as Record<string, unknown>[])[0], title: '变更后的标题' }, (payload.groups as Record<string, unknown>[])[1]] });
    expect(conflict.statusCode).toBe(409);
  });

  it('漏覆盖、重复 primary、重复 anchor 与 secondary evidence 均整批零写入', async () => {
    const invalidCases = [
      (receipts: string[]) => batch(receipts, {
        groups: [{ group_key: 'g', action: 'create_candidate', anchor_receipt: receipts[0], field_evidence_receipts: [], title: '目标' }],
        primary_dispositions: [{ disposition_ref: 'only-one', source_receipt: receipts[0], disposition: 'group', primary_group_key: 'g' }],
      }),
      (receipts: string[]) => batch(receipts, {
        groups: [{ group_key: 'g', action: 'create_candidate', anchor_receipt: receipts[0], field_evidence_receipts: [receipts[1]], title: '目标' }],
        primary_dispositions: [
          { disposition_ref: 'one', source_receipt: receipts[0], disposition: 'group', primary_group_key: 'g' },
          { disposition_ref: 'two', source_receipt: receipts[0], disposition: 'group', primary_group_key: 'g' },
        ],
      }),
      (receipts: string[]) => batch(receipts, {
        groups: [
          { group_key: 'a', action: 'create_candidate', anchor_receipt: receipts[0], field_evidence_receipts: [], title: 'A' },
          { group_key: 'b', action: 'create_candidate', anchor_receipt: receipts[0], field_evidence_receipts: [receipts[1]], title: 'B' },
        ],
        primary_dispositions: [
          { disposition_ref: 'a', source_receipt: receipts[0], disposition: 'group', primary_group_key: 'a' },
          { disposition_ref: 'b', source_receipt: receipts[1], disposition: 'group', primary_group_key: 'b' },
        ],
      }),
      (receipts: string[]) => batch(receipts, {
        groups: [
          { group_key: 'a', action: 'create_candidate', anchor_receipt: receipts[0], field_evidence_receipts: [], title: 'A' },
          { group_key: 'b', action: 'create_candidate', anchor_receipt: receipts[1], field_evidence_receipts: [receipts[0]], title: 'B' },
        ],
        primary_dispositions: [
          { disposition_ref: 'a', source_receipt: receipts[0], disposition: 'group', primary_group_key: 'a' },
          { disposition_ref: 'b', source_receipt: receipts[1], disposition: 'group', primary_group_key: 'b' },
        ],
        shared_context: [{ source_receipt: receipts[0], shared_group_key: 'b' }],
      }),
    ];
    for (const [index, makePayload] of invalidCases.entries()) {
      const { app, database } = await makeApp();
      const receipts = await save(app, [source(1), source(2)], `save-invalid-${index}`);
      const response = await submit(app, { ...makePayload(receipts), decision_request_id: `invalid-${index}`, batch_id: `invalid-${index}` });
      expect(response.statusCode).toBe(400);
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_batch').get()).toEqual({ count: 0 });
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
      expect(database.raw.prepare("SELECT COUNT(*) AS count FROM source_event_revision WHERE processing_status = 'pending_decision'").get())
        .toEqual({ count: 2 });
    }
  });

  it('候选与 update_task CAS 在同一批次失败时全部回滚，并发提交只允许一个 CAS 胜出', async () => {
    const { app, database } = await makeApp();
    seedTask(database);
    const receipts = await save(app, [source(1), source(2)], 'save-cas-rollback');
    const failed = await submit(app, batch(receipts, {
      groups: [
        { group_key: 'create', action: 'create_candidate', anchor_receipt: receipts[0], field_evidence_receipts: [], title: '不会留下的候选' },
        { group_key: 'update', action: 'update_task', anchor_receipt: receipts[1], field_evidence_receipts: [], task_key: 'task-batch-cas', expected_version: 2, next_step: '不会留下' },
      ],
      primary_dispositions: [
        { disposition_ref: 'create', source_receipt: receipts[0], disposition: 'group', primary_group_key: 'create' },
        { disposition_ref: 'update', source_receipt: receipts[1], disposition: 'group', primary_group_key: 'update' },
      ],
    }));
    expect(failed.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_batch').get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM source_event_revision WHERE processing_status = 'pending_decision'").get())
      .toEqual({ count: 2 });

    const more = await save(app, [source(3), source(4)], 'save-cas-race');
    const updatePayload = (receipt: string, key: string, nextStep: string) => batch([receipt], {
      decision_request_id: `decision-${key}`,
      batch_id: `batch-${key}`,
      groups: [{ group_key: key, action: 'update_task', anchor_receipt: receipt, field_evidence_receipts: [], task_key: 'task-batch-cas', expected_version: 1, next_step: nextStep }],
      primary_dispositions: [{ disposition_ref: key, source_receipt: receipt, disposition: 'group', primary_group_key: key }],
    });
    const results = await Promise.all([
      submit(app, updatePayload(more[0]!, 'race-a', '并发 A')),
      submit(app, updatePayload(more[1]!, 'race-b', '并发 B')),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM source_event_revision WHERE processing_status = 'processed'").get())
      .toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT version FROM task WHERE id = ?').get('task-batch-cas')).toEqual({ version: 2 });
  });

  it('needs_owner 私有投影可安全解决、取消、失效和重试，append 意图保持 pending', async () => {
    const { app, database } = await makeApp();
    const seedReceipt = (await save(app, [source(1)], 'save-owner-seed'))[0]!;
    const seeded = await submit(app, batch([seedReceipt], {
      decision_request_id: 'decision-owner-seed', batch_id: 'batch-owner-seed',
      groups: [{ group_key: 'seed', action: 'create_candidate', anchor_receipt: seedReceipt, field_evidence_receipts: [], title: '已有候选' }],
      primary_dispositions: [{ disposition_ref: 'seed', source_receipt: seedReceipt, disposition: 'group', primary_group_key: 'seed' }],
    }));
    const candidateId = seeded.json().groups[0].candidate_id as string;
    const receipts = await save(app, [source(2, '需要主人判断 A'), source(3, '需要主人判断 B'), source(4, '可能追加'), source(5, '暂不处理')], 'save-owner-decisions');
    const submitted = await submit(app, batch(receipts, {
      decision_request_id: 'decision-owner-options', batch_id: 'batch-owner-options',
      primary_dispositions: [
        { disposition_ref: 'owner-create', source_receipt: receipts[0], disposition: 'needs_owner', owner_decision_key: 'owner-create' },
        { disposition_ref: 'owner-skip', source_receipt: receipts[1], disposition: 'needs_owner', owner_decision_key: 'owner-skip' },
        { disposition_ref: 'owner-append', source_receipt: receipts[2], disposition: 'needs_owner', owner_decision_key: 'owner-append' },
        { disposition_ref: 'owner-cancel', source_receipt: receipts[3], disposition: 'needs_owner', owner_decision_key: 'owner-cancel' },
      ],
      owner_decisions: [
        { decision_key: 'owner-create', reason: '是否建立新候选？', options: [{ option_key: 'create', action: 'create_candidate', title: '主人确认的新候选' }] },
        { decision_key: 'owner-skip', reason: '是否跳过？', options: [{ option_key: 'skip', action: 'skip' }] },
        { decision_key: 'owner-append', reason: '是否追加？', options: [{ option_key: 'append', action: 'append_candidate', candidate_key: candidateId }] },
        { decision_key: 'owner-cancel', reason: '是否暂不处理？', options: [{ option_key: 'skip', action: 'skip' }] },
      ],
    }));
    expect(submitted.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/owner-decisions?status=all' });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toMatch(/source_receipt|synthetic-sender|batch-message|可能追加/u);
    const byReason = new Map(list.json().items.map((item: { reason_summary: string }) => [item.reason_summary, item]));
    const createDecision = byReason.get('是否建立新候选？') as { decision_id: string; version: number };
    const skipDecision = byReason.get('是否跳过？') as { decision_id: string; version: number };
    const appendDecision = byReason.get('是否追加？') as { decision_id: string; version: number; options: Array<{ available: boolean }> };
    const cancelDecision = byReason.get('是否暂不处理？') as { decision_id: string; version: number };
    expect(appendDecision.options[0]!.available).toBe(false);
    const appendDenied = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${appendDecision.decision_id}/resolve`,
      payload: { decision_request_id: 'resolve-append', expected_version: 1, action: 'skip', option_key: 'append' },
    });
    expect(appendDenied.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${createDecision.decision_id}/resolve`,
      payload: { decision_request_id: 'resolve-create', expected_version: createDecision.version, action: 'create_candidate', option_key: 'create' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ status: 'resolved', version: 2, resolution_action: 'create_candidate' });
    const replay = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${createDecision.decision_id}/resolve`,
      payload: { decision_request_id: 'resolve-create', expected_version: createDecision.version, action: 'create_candidate', option_key: 'create' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(created.json());
    const reusedRequest = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${skipDecision.decision_id}/resolve`,
      payload: { decision_request_id: 'resolve-create', expected_version: skipDecision.version, action: 'skip', option_key: 'skip' },
    });
    expect(reusedRequest.statusCode).toBe(409);
    const skipped = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${skipDecision.decision_id}/resolve`,
      payload: { decision_request_id: 'resolve-skip', expected_version: skipDecision.version, action: 'skip', option_key: 'skip' },
    });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json()).toMatchObject({ status: 'resolved', version: 2, resolution_action: 'skip' });
    expect(database.raw.prepare("SELECT processing_status FROM source_event_revision WHERE id = (SELECT source_revision_id FROM cindy_owner_decision_source WHERE decision_id = ?)")
      .get(skipDecision.decision_id)).toEqual({ processing_status: 'skipped' });
    const cancelled = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${cancelDecision.decision_id}/cancel`,
      payload: { decision_request_id: 'cancel-owner', expected_version: cancelDecision.version },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', version: 2 });
    expect(database.raw.prepare("SELECT processing_status FROM source_event_revision WHERE id = (SELECT source_revision_id FROM cindy_owner_decision_source WHERE decision_id = ?)")
      .get(cancelDecision.decision_id)).toEqual({ processing_status: 'pending_decision' });

    const foreignToken = 'foreign-owner-decision-token';
    const { app: foreignApp } = await makeApp(database, foreignToken, 'foreign-owner-decision-account');
    const foreignList = await foreignApp.inject({ method: 'GET', url: '/api/owner-decisions?status=all' });
    expect(foreignList.statusCode).toBe(200);
    expect(foreignList.json().items).toEqual([]);

    const supersedeReceipt = (await save(app, [source(6, '即将被编辑')], 'save-owner-supersede'))[0]!;
    const supersedeBatch = await submit(app, batch([supersedeReceipt], {
      decision_request_id: 'decision-owner-supersede', batch_id: 'batch-owner-supersede',
      primary_dispositions: [{ disposition_ref: 'supersede', source_receipt: supersedeReceipt, disposition: 'needs_owner', owner_decision_key: 'supersede' }],
      owner_decisions: [{ decision_key: 'supersede', reason: '等待编辑', options: [{ option_key: 'skip', action: 'skip' }] }],
    }));
    const supersedeDecisionId = supersedeBatch.json().owner_decisions[0].decision_id as string;
    const edited = source(6, '编辑后的当前版本');
    edited.revision = { sequence: 2 };
    await save(app, [edited], 'save-owner-supersede-v2');
    expect(database.raw.prepare('SELECT status, version FROM cindy_owner_decision WHERE id = ?').get(supersedeDecisionId))
      .toEqual({ status: 'superseded', version: 2 });

    const retryReceipt = (await save(app, [source(7, '可恢复失败')], 'save-owner-retry'))[0]!;
    const retryBatch = await submit(app, batch([retryReceipt], {
      decision_request_id: 'decision-owner-retry', batch_id: 'batch-owner-retry',
      primary_dispositions: [{ disposition_ref: 'retry', source_receipt: retryReceipt, disposition: 'needs_owner', owner_decision_key: 'retry' }],
      owner_decisions: [{ decision_key: 'retry', reason: '可恢复失败', options: [{ option_key: 'create', action: 'create_candidate', title: '重试候选' }] }],
    }));
    const retryDecisionId = retryBatch.json().owner_decisions[0].decision_id as string;
    database.raw.exec(`CREATE TRIGGER fail_owner_candidate BEFORE INSERT ON candidate_request
      WHEN NEW.analysis_json LIKE '%cindy_owner_decision%'
      BEGIN SELECT RAISE(ABORT, 'synthetic owner resolution failure'); END;`);
    const failed = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${retryDecisionId}/resolve`,
      payload: { decision_request_id: 'resolve-retry-failed', expected_version: 1, action: 'create_candidate', option_key: 'create' },
    });
    expect(failed.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT status, version, last_error FROM cindy_owner_decision WHERE id = ?').get(retryDecisionId))
      .toMatchObject({ status: 'pending', version: 1, last_error: expect.any(String) });
    database.raw.exec('DROP TRIGGER fail_owner_candidate;');
    const retried = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${retryDecisionId}/resolve`,
      payload: { decision_request_id: 'resolve-retry-success', expected_version: 1, action: 'create_candidate', option_key: 'create' },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().status).toBe('resolved');
    expect(database.raw.prepare('SELECT status FROM cindy_owner_decision WHERE id = ?').get(appendDecision.decision_id))
      .toEqual({ status: 'pending' });
  });

  it('旧 revision、伪造 receipt、跨 account 和同来源重复快照均 fail closed', async () => {
    const { app, database } = await makeApp();
    const oldReceipt = (await save(app, [source(1)], 'save-old-revision'))[0]!;
    const edited = source(1, '新 revision');
    edited.revision = { sequence: 2 };
    const currentReceipt = (await save(app, [edited], 'save-current-revision'))[0]!;
    const foreignToken = 'foreign-cindy-batch-token';
    const { app: foreignApp } = await makeApp(database, foreignToken, 'foreign-cindy-batch-account');
    const invalidReceipts = [oldReceipt, 'forged_receipt_value_that_is_long_enough_123456789'];
    for (const [index, receipt] of invalidReceipts.entries()) {
      const response = await submit(app, batch([receipt], { decision_request_id: `invalid-receipt-${index}`, batch_id: `invalid-receipt-${index}` }));
      expect(response.statusCode).toBe(403);
    }
    const foreign = await submit(foreignApp, batch([currentReceipt], { decision_request_id: 'foreign', batch_id: 'foreign' }), foreignToken);
    expect(foreign.statusCode).toBe(403);
    const duplicateRevision = await submit(app, batch([currentReceipt, currentReceipt], { decision_request_id: 'duplicate-revision', batch_id: 'duplicate-revision' }));
    expect(duplicateRevision.statusCode).toBe(400);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_batch').get()).toEqual({ count: 0 });
  });
});
