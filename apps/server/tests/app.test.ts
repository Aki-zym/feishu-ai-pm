import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';
import { registerSimulatedMessageRoute } from './support/simulated-message-route.js';

describe('本地 AI PM 闭环', () => {
  let database: AppDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adapters: ReturnType<typeof createAdapters>;

  beforeEach(async () => {
    database = new AppDatabase(':memory:', false);
    adapters = createAdapters();
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, adapters, config);
    app = await buildApp(service, { serveWeb: false });
    registerSimulatedMessageRoute(app, service, {
      testOnly: true,
      nodeEnv: config.nodeEnv,
      databaseProvider: config.database.provider,
      databaseUrl: config.database.url,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    database.close();
  });

  const simulate = async (externalId: string, content = '想看一下新活动的留存数据，验证是否值得继续投入。') =>
    app.inject({
      method: 'POST',
      url: '/api/dev/simulate-message',
      payload: {
        externalId,
        sourceType: 'owner_dm',
        conversationId: 'chat-1',
        senderId: 'user-1',
        senderName: '测试需求方',
        content,
        occurredAt: new Date().toISOString(),
      },
    });

  it('健康接口明确处于无外部连接的本地模式', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', mode: 'local-shell', externalConnections: false });
  });

  it('默认装配不注册模拟消息路由，人工补录仍走正式纠错接口', async () => {
    const productionDatabase = new AppDatabase(':memory:', false);
    const productionConfig = loadConfig({ NODE_ENV: 'production', DATABASE_URL: ':memory:' });
    const productionApp = await buildApp(
      new PmService(productionDatabase, createAdapters(productionConfig), productionConfig),
      { serveWeb: false },
    );
    try {
      const simulated = await productionApp.inject({
        method: 'POST',
        url: '/api/dev/simulate-message',
        payload: { content: '仅用于确认默认装配不会接收模拟来源。' },
      });
      expect(simulated.statusCode).toBe(404);
      expect(productionDatabase.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
      expect(productionDatabase.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });

      const manual = await productionApp.inject({
        method: 'POST',
        url: '/api/corrections',
        payload: {
          correctionType: 'missed_request',
          idempotencyKey: 'issue-31-manual-entry',
          manualContent: '请补录一条用于本地合同验证的需求。',
          manualSenderName: '人工补录',
        },
      });
      expect(manual.statusCode).toBe(200);
      expect(manual.json()).toMatchObject({ candidate: { state: 'pending' } });
      expect(productionDatabase.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
    } finally {
      await productionApp.close();
      productionDatabase.close();
    }
  });

  it('只有显式开启的测试装配才注册模拟消息路由', async () => {
    const response = await simulate('issue-31-explicit-test-route');
    expect(response.statusCode).toBe(200);
    expect(response.json().candidate).toBeTruthy();
  });

  it('模拟消息入口对非测试或持久化装配 fail-closed', async () => {
    const guardedDatabase = new AppDatabase(':memory:', false);
    const guardedConfig = loadConfig({ NODE_ENV: 'production', DATABASE_URL: ':memory:' });
    const guardedService = new PmService(guardedDatabase, createAdapters(guardedConfig), guardedConfig);
    const guardedApp = await buildApp(guardedService, { serveWeb: false });
    try {
      expect(() => registerSimulatedMessageRoute(guardedApp, guardedService, {
        testOnly: true,
        nodeEnv: guardedConfig.nodeEnv,
        databaseProvider: guardedConfig.database.provider,
        databaseUrl: guardedConfig.database.url,
      })).toThrow('只允许在 test + sqlite :memory: 装配中注册');
      expect(() => registerSimulatedMessageRoute(guardedApp, guardedService, {
        testOnly: true,
        nodeEnv: 'test',
        databaseProvider: 'sqlite',
        databaseUrl: 'file:./var/issue31-persistent.sqlite',
      })).toThrow('只允许在 test + sqlite :memory: 装配中注册');
      const response = await guardedApp.inject({
        method: 'POST',
        url: '/api/dev/simulate-message',
        payload: { content: '不应进入事实来源。' },
      });
      expect(response.statusCode).toBe(404);
      expect(guardedDatabase.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
    } finally {
      await guardedApp.close();
      guardedDatabase.close();
    }
  });

  it('只有 task 表的残缺旧 SQLite 会 fail-closed 且保留原任务', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-pm-migrate-'));
    const path = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE task (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      proposer_name TEXT NOT NULL,
      describe TEXT NOT NULL,
      status TEXT NOT NULL,
      schedule_at TEXT,
      next_step TEXT NOT NULL,
      risk TEXT NOT NULL,
      waiting_reason TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      completed_at TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    legacy.prepare("INSERT INTO task (id, title, proposer_name, describe, status, schedule_at, next_step, risk, waiting_reason, version, completed_at, archived_at, created_at, updated_at) VALUES ('legacy-task', '旧任务', '需求方', '保留内容', 'planned', '2026-08-12T10:00:00.000Z', '继续', 'low', NULL, 1, NULL, NULL, '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')").run();
    legacy.close();

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = new DatabaseSync(path, { readOnly: true });
    expect(preserved.prepare('SELECT title, schedule_at FROM task WHERE id = ?').get('legacy-task'))
      .toEqual({ title: '旧任务', schedule_at: '2026-08-12T10:00:00.000Z' });
    preserved.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('只有监控目标表的残缺旧 SQLite 会 fail-closed 且保留原记录', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-pm-monitor-migrate-'));
    const path = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE feishu_monitor_target (
      id TEXT PRIMARY KEY,
      owner_open_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_key TEXT NOT NULL,
      resolved_chat_id TEXT,
      display_name TEXT NOT NULL,
      secondary_label TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      read_policy TEXT NOT NULL,
      selection_source TEXT NOT NULL,
      access_status TEXT NOT NULL DEFAULT 'unknown',
      last_discovered_at TEXT,
      last_resolved_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_open_id, target_kind, target_key)
    );`);
    legacy.prepare(`INSERT INTO feishu_monitor_target
      (id, owner_open_id, target_kind, target_key, resolved_chat_id, display_name, secondary_label, enabled,
       read_policy, selection_source, access_status, metadata_json, created_at, updated_at)
      VALUES ('legacy-monitor', 'owner-open', 'person', 'person-open', 'p2p-chat', '旧联系人', NULL, 1,
              'incoming_only', 'chat_list', 'readable', '{}', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')`).run();
    legacy.close();

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = new DatabaseSync(path, { readOnly: true });
    expect(preserved.prepare('SELECT display_name, enabled FROM feishu_monitor_target WHERE id = ?').get('legacy-monitor'))
      .toEqual({ display_name: '旧联系人', enabled: 1 });
    preserved.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('Issue #11 的残缺三表旧库会 fail-closed 且不改写数据', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-pm-issue11-migrate-'));
    const path = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`CREATE TABLE task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        proposer_name TEXT NOT NULL,
        describe TEXT NOT NULL,
        status TEXT NOT NULL,
        schedule_at TEXT,
        next_step TEXT NOT NULL,
        risk TEXT NOT NULL,
        waiting_reason TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        completed_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_update_proposal (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        thread_id TEXT,
        source_event_id TEXT,
        candidate_revision_id TEXT,
        thread_revision_id TEXT,
        base_thread_version INTEGER,
        base_task_version INTEGER NOT NULL,
        patch_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        prompt_version TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'awaiting_approval',
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE memory_projection (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        projection_version INTEGER NOT NULL DEFAULT 0,
        root_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        checksum TEXT,
        last_error TEXT,
        last_projected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`);
      const timestamp = '2026-08-11T00:00:00.000Z';
      legacy.prepare(`INSERT INTO task
        (id, title, proposer_name, describe, status, schedule_at, next_step, risk, waiting_reason, version,
         completed_at, archived_at, created_at, updated_at)
        VALUES ('legacy-task', '旧任务', '需求方', '保留内容', 'planned', NULL, '继续', 'low', NULL, 1,
                NULL, NULL, ?, ?)`)
        .run(timestamp, timestamp);
      legacy.prepare(`INSERT INTO task_update_proposal
        (id, task_id, thread_id, source_event_id, candidate_revision_id, thread_revision_id, base_thread_version,
         base_task_version, patch_json, reason, evidence_json, provider, model, prompt_version, state,
         idempotency_key, created_at, decided_at)
        VALUES ('legacy-proposal', 'legacy-task', NULL, NULL, NULL, NULL, NULL, 1, '{}', '保留原因', '[]',
                'legacy-provider', 'legacy-model', 'legacy-prompt', 'awaiting_approval', 'legacy-proposal-key', ?, NULL)`)
        .run(timestamp);
      legacy.prepare(`INSERT INTO memory_projection
        (id, task_id, projection_version, root_path, relative_path, state, checksum, last_error,
         last_projected_at, created_at, updated_at)
        VALUES ('legacy-memory', 'legacy-task', 1, 'D:/legacy-memory', 'tasks/legacy-task', 'ready',
                'legacy-checksum', NULL, ?, ?, ?)`)
        .run(timestamp, timestamp, timestamp);
    } finally {
      legacy.close();
    }

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = new DatabaseSync(path, { readOnly: true });
    try {
      expect(preserved.prepare('SELECT title FROM task WHERE id = ?').get('legacy-task')).toEqual({ title: '旧任务' });
      expect(preserved.prepare('SELECT checksum FROM memory_projection WHERE id = ?').get('legacy-memory'))
        .toEqual({ checksum: 'legacy-checksum' });
    } finally {
      preserved.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('只有 Runtime job 表的残缺旧库会 fail-closed 且保留排队任务', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-pm-runtime-migrate-'));
    const path = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE job (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    legacy.prepare(`INSERT INTO job
      (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at)
      VALUES ('legacy-job', 'classify_source', '{}', 'queued', 1,
              '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')`).run();
    legacy.close();

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = new DatabaseSync(path, { readOnly: true });
    expect(preserved.prepare('SELECT job_type, status, attempts FROM job WHERE id = ?').get('legacy-job')).toEqual({
      job_type: 'classify_source',
      status: 'queued',
      attempts: 1,
    });
    preserved.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('只有 Runtime 两表的残缺旧库会 fail-closed 且保留审计行', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-pm-runtime-tool-migrate-'));
    const path = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE job (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE runtime_tool_call (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES job(id) ON DELETE SET NULL,
      tool_name TEXT NOT NULL,
      policy TEXT NOT NULL CHECK (policy IN ('readonly','approval_required','forbidden')),
      status TEXT NOT NULL CHECK (status IN ('allowed','blocked','completed','failed')),
      input_hash TEXT,
      result_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX idx_runtime_tool_job ON runtime_tool_call(job_id, started_at DESC);`);
    legacy.prepare(`INSERT INTO runtime_tool_call
      (id, job_id, tool_name, policy, status, input_hash, result_json, error, started_at, finished_at)
      VALUES ('legacy-tool', NULL, 'source.read', 'readonly', 'completed', 'hash', '{}', NULL, ?, ?)`)
      .run('2026-08-11T00:00:00.000Z', '2026-08-11T00:00:01.000Z');
    legacy.close();

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = new DatabaseSync(path, { readOnly: true });
    try {
      expect(preserved.prepare('SELECT tool_name, policy, status FROM runtime_tool_call WHERE id = ?').get('legacy-tool'))
        .toEqual({ tool_name: 'source.read', policy: 'readonly', status: 'completed' });
    } finally {
      preserved.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('v0 Runtime 带未记账 idempotency 列和索引的 partial schema 会原子 fail-closed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-pm-runtime-partial-schema-'));
    const path = join(directory, 'partial.sqlite');
    const current = new AppDatabase(path, false);
    current.close();

    // Derive a frozen v0-shaped file from the current synthetic schema, then
    // add the runtime idempotency column/index without its declared migration
    // ledger. This is an unknown partial schema, not an accepted legacy form.
    const partial = new DatabaseSync(path);
    partial.exec(`
      DROP TABLE schema_migration;
      DROP TABLE database_metadata;
      PRAGMA user_version = 0;
      DROP INDEX idx_runtime_tool_idempotency_active;
      ALTER TABLE runtime_tool_call DROP COLUMN idempotency_key;
      ALTER TABLE runtime_tool_call ADD COLUMN idempotency_key TEXT;
      CREATE INDEX idx_runtime_tool_idempotency ON runtime_tool_call(idempotency_key, started_at DESC);
    `);
    partial.prepare(
      `INSERT INTO runtime_tool_call
        (id, job_id, tool_name, policy, status, idempotency_key, input_hash, started_at)
       VALUES ('partial-tool', NULL, 'source.read', 'readonly', 'completed', 'unledgered-key', 'hash', '2026-08-15T00:00:00.000Z')`,
    ).run();
    partial.close();

    const beforeBytes = readFileSync(path);
    const beforeHash = createHash('sha256').update(beforeBytes).digest('hex');
    const beforeRows = new DatabaseSync(path, { readOnly: true });
    const beforeShape = {
      tool: beforeRows.prepare('SELECT id, status, idempotency_key FROM runtime_tool_call WHERE id = ?').get('partial-tool'),
      tables: beforeRows.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name").all(),
    };
    beforeRows.close();

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(beforeHash);
    const afterRows = new DatabaseSync(path, { readOnly: true });
    expect({
      tool: afterRows.prepare('SELECT id, status, idempotency_key FROM runtime_tool_call WHERE id = ?').get('partial-tool'),
      tables: afterRows.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name").all(),
    }).toEqual(beforeShape);
    afterRows.close();
    expect(() => readdirSync(join(directory, 'backups'))).toThrow();
    rmSync(directory, { recursive: true, force: true });
  });

  it('未配置真实飞书时拒绝生成伪授权链接', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/integrations/feishu/oauth/url' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: '请先开启“允许真实飞书连接”，填写 App ID 和 App Secret，并保存配置后再授权。',
    });
  });

  it('重复 message_id 不会重复建立来源或候选', async () => {
    const first = await simulate('message-duplicate');
    const second = await simulate('message-duplicate');
    expect(first.json().deduplicated).toBe(false);
    expect(second.json().deduplicated).toBe(true);
    const sourceCount = database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number };
    const candidateCount = database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number };
    expect(sourceCount.count).toBe(1);
    expect(candidateCount.count).toBe(1);
  });

  it('候选接口固定返回时间、字段依据和文档状态，但不会自动写入私人排期', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/dev/simulate-message',
      payload: {
        externalId: 'message-candidate-analysis',
        sourceType: 'owner_dm',
        conversationId: 'chat-1',
        senderId: 'user-1',
        senderName: '测试需求方',
        content: '请在下周三前分析活动留存，背景在 https://example.feishu.cn/docx/doc-1',
        occurredAt: '2026-08-11T04:00:00.000Z',
      },
    });
    const listed = await app.inject({ method: 'GET', url: '/api/candidates?state=pending' });
    const candidate = listed.json().items[0];
    expect(candidate.analysis).toMatchObject({
      timeRange: { status: 'relative_resolved', sourceText: null, needsConfirmation: false },
      fieldBasis: { background: 'fact', validationQuestion: 'unknown', describe: 'fact' },
      linkedDocuments: [{ status: 'unauthorized', documentType: 'docx' }],
    });
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${candidate.id}/action`, payload: { action: 'accept', expectedVersion: candidate.version } });
    expect(accepted.json().task).toMatchObject({ planned_start_at: null, planned_due_at: null, schedule_at: null });
  });

  it('接受候选后建立正式任务并保留来源链', async () => {
    const created = (await simulate('message-accept')).json();
    const response = await app.inject({
      method: 'POST',
      url: `/api/candidates/${created.candidate.id}/action`,
      payload: { action: 'accept', expectedVersion: created.candidate.version },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.candidate.state).toBe('accepted');
    expect(body.task.status).toBe('unplanned');
    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${body.task.id}` });
    expect(detail.json().sources).toHaveLength(1);
    expect(detail.json().events[0].event_type).toBe('task_created');
  });

  it('候选可以暂存或忽略', async () => {
    const snoozeCandidate = (await simulate('message-snooze')).json().candidate;
    const ignoreCandidate = (await simulate('message-ignore')).json().candidate;
    const snoozed = await app.inject({
      method: 'POST',
      url: `/api/candidates/${snoozeCandidate.id}/action`,
      payload: { action: 'snooze', expectedVersion: snoozeCandidate.version },
    });
    const ignored = await app.inject({
      method: 'POST',
      url: `/api/candidates/${ignoreCandidate.id}/action`,
      payload: { action: 'ignore', expectedVersion: ignoreCandidate.version },
    });
    expect(snoozed.json().candidate.state).toBe('snoozed');
    expect(ignored.json().candidate.state).toBe('ignored');
  });

  it('工作台不会把旧版 AI 整理失败的空占位候选显示为需要确认', async () => {
    const created = (await simulate('dashboard-empty-retry-placeholder')).json().candidate as { id: string };
    database.raw.prepare(
      `UPDATE candidate_request
       SET title = 'AI 整理待重试', confidence = 0, background = '', validation_question = '', describe = '',
           processing_state = 'failed_visible', processing_error = 'AI 整理暂未完成。'
       WHERE id = ?`,
    ).run(created.id);

    const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({ candidates: [], counts: { candidates: 0 } });
    expect(database.raw.prepare('SELECT state, deleted_at FROM candidate_request WHERE id = ?').get(created.id))
      .toEqual({ state: 'pending', deleted_at: null });
  });

  it('工作台按上海自然日取数，并让列表上限与各指标总数相互独立', async () => {
    for (let index = 0; index < 9; index += 1) {
      const response = await simulate(`dashboard-candidate-${index}`, `合成候选需求 ${index}：请验证独立统计。`);
      expect(response.statusCode).toBe(200);
    }
    vi.useFakeTimers({ now: new Date('2026-08-15T00:30:00.000Z') });
    const insertTask = database.raw.prepare(
      `INSERT INTO task (
         id, title, proposer_name, describe, status, schedule_at, planned_start_at, planned_due_at,
         next_step, risk, waiting_reason, version, completed_at, archived_at, deleted_at,
         record_state, merged_into_task_id, thread_id, auto_update_paused, created_at, updated_at
       ) VALUES (?, ?, '合成需求方', '合成工作台任务', ?, ?, ?, ?, '继续验证', 'medium', NULL, 1, NULL, NULL, NULL, 'active', NULL, NULL, 0, ?, ?)`,
    );
    const timestamp = '2026-08-14T08:00:00.000Z';
    for (let index = 0; index < 10; index += 1) {
      const plan = index === 0
        ? '2026-08-14T16:00:00.000Z'
        : index === 9
          ? '2026-08-15T15:59:59.999Z'
          : new Date(Date.parse('2026-08-15T08:00:00.000Z') + index * 60_000).toISOString();
      insertTask.run(`dashboard-today-${index}`, `今日任务 ${index}`, 'planned', plan, plan, plan, timestamp, timestamp);
    }
    insertTask.run('dashboard-yesterday', '上海昨日任务', 'planned', '2026-08-14T15:59:59.999Z', null, '2026-08-14T15:59:59.999Z', timestamp, timestamp);
    insertTask.run('dashboard-tomorrow', '上海明日任务', 'planned', '2026-08-15T16:00:00.000Z', null, '2026-08-15T16:00:00.000Z', timestamp, timestamp);
    insertTask.run('dashboard-spanning', '覆盖上海今天的跨日任务', 'planned', '2026-08-15T12:00:00.000Z', '2026-08-14T12:00:00.000Z', '2026-08-15T12:00:00.000Z', timestamp, timestamp);
    insertTask.run('dashboard-completed', '今天已完成任务', 'completed', '2026-08-14T16:10:00.000Z', null, '2026-08-14T16:10:00.000Z', timestamp, timestamp);
    insertTask.run('dashboard-archived', '今天已归档任务', 'archived', '2026-08-14T16:20:00.000Z', null, '2026-08-14T16:20:00.000Z', timestamp, timestamp);
    insertTask.run('dashboard-invalidated', '今天已作废任务', 'planned', '2026-08-14T16:30:00.000Z', null, '2026-08-14T16:30:00.000Z', timestamp, timestamp);
    database.raw.prepare("UPDATE task SET record_state = 'invalidated' WHERE id = 'dashboard-invalidated'").run();
    insertTask.run('dashboard-deleted', '今天已移入回收站任务', 'planned', '2026-08-14T16:40:00.000Z', null, '2026-08-14T16:40:00.000Z', timestamp, timestamp);
    database.raw.prepare("UPDATE task SET deleted_at = ? WHERE id = 'dashboard-deleted'").run(timestamp);
    insertTask.run('dashboard-progress', '独立进行中', 'in_progress', null, null, null, timestamp, timestamp);
    insertTask.run('dashboard-waiting-overdue', '逾期等待任务', 'waiting', '2026-08-14T12:00:00.000Z', null, '2026-08-14T12:00:00.000Z', timestamp, timestamp);
    for (let index = 0; index < 9; index += 1) {
      insertTask.run(`dashboard-waiting-${index}`, `等待任务 ${index}`, 'waiting', null, null, null, timestamp, timestamp);
    }

    const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(dashboard.statusCode).toBe(200);
    const body = dashboard.json();
    expect(body).toMatchObject({
      timezone: 'Asia/Shanghai',
      todayDate: '2026-08-15',
      asOf: '2026-08-15T00:30:00.000Z',
      dataMode: 'local_mock',
      counts: { candidates: 9, today: 11, waiting: 10, inProgress: 1, overdue: 3 },
    });
    expect(body.candidates).toHaveLength(6);
    expect(body.today).toHaveLength(8);
    expect(body.waiting).toHaveLength(8);
    expect(body.today.map((task: { id: string }) => task.id)).toContain('dashboard-spanning');
    expect(body.today.map((task: { id: string }) => task.id)).not.toContain('dashboard-yesterday');
    expect(body.today.map((task: { id: string }) => task.id)).not.toContain('dashboard-tomorrow');
    expect(body.today.map((task: { id: string }) => task.id)).not.toContain('dashboard-completed');
    expect(body.today.map((task: { id: string }) => task.id)).not.toContain('dashboard-archived');
    expect(body.today.map((task: { id: string }) => task.id)).not.toContain('dashboard-invalidated');
    expect(body.today.map((task: { id: string }) => task.id)).not.toContain('dashboard-deleted');

    Object.defineProperty(adapters.feishu, 'kind', { value: 'live' });
    const configuredDashboard = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(configuredDashboard.json().dataMode).toBe('configured');
  });

  it('排期日历按上海右开区间展开，并保留完成态、隐藏非活动记录', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-15T00:30:00.000Z') });
    const insertTask = database.raw.prepare(
      `INSERT INTO task (
         id, title, proposer_name, describe, status, schedule_at, planned_start_at, planned_due_at,
         next_step, risk, waiting_reason, version, completed_at, archived_at, deleted_at,
         record_state, merged_into_task_id, thread_id, auto_update_paused, created_at, updated_at
       ) VALUES (?, ?, '合成需求方', '合成日历任务', ?, ?, ?, ?, '继续验证', 'medium', NULL, 1, NULL, NULL, NULL, 'active', NULL, NULL, 0, ?, ?)`,
    );
    const timestamp = '2026-08-14T08:00:00.000Z';
    insertTask.run('calendar-midnight-end', '午夜结束不进入右侧日期', 'planned', '2026-08-14T16:00:00.000Z', '2026-08-14T15:00:00.000Z', '2026-08-14T16:00:00.000Z', timestamp, timestamp);
    insertTask.run('calendar-cross-day', '跨两日任务', 'in_progress', '2026-08-15T02:00:00.000Z', '2026-08-14T15:00:00.000Z', '2026-08-15T02:00:00.000Z', timestamp, timestamp);
    insertTask.run('calendar-multi-year', '跨年三日任务', 'planned', '2026-01-01T17:00:00.000Z', '2025-12-31T15:00:00.000Z', '2026-01-01T17:00:00.000Z', timestamp, timestamp);
    insertTask.run('calendar-multi-month', '跨月三日任务', 'planned', '2026-02-02T16:00:00.000Z', '2026-01-30T16:00:00.000Z', '2026-02-02T16:00:00.000Z', timestamp, timestamp);
    insertTask.run('calendar-completed', '已完成历史任务', 'completed', '2026-08-14T17:00:00.000Z', null, '2026-08-14T17:00:00.000Z', timestamp, timestamp);
    insertTask.run('calendar-legacy', '旧版单锚点任务', 'planned', '2026-08-15T15:59:59.999Z', null, null, timestamp, timestamp);
    insertTask.run('calendar-equal-point', '起止相等点事件', 'planned', '2026-08-14T16:00:00.000Z', '2026-08-14T16:00:00.000Z', '2026-08-14T16:00:00.000Z', timestamp, timestamp);
    insertTask.run('calendar-bad-start-good-due', '坏开始好截止', 'planned', '2026-08-15T03:00:00.000Z', 'bad-start', '2026-08-15T03:00:00.000Z', timestamp, timestamp);
    insertTask.run('calendar-bad-start-due-good-schedule', '坏区间好旧锚点', 'planned', '2026-08-15T04:00:00.000Z', 'bad-start', 'bad-due', timestamp, timestamp);
    insertTask.run('calendar-all-bad', '三锚点全坏', 'planned', 'bad-schedule', 'bad-start-secret', 'bad-due-secret', timestamp, timestamp);
    insertTask.run('calendar-reversed', '反向历史区间', 'planned', '2026-08-14T15:00:00.000Z', '2026-08-15T15:00:00.000Z', '2026-08-14T15:00:00.000Z', timestamp, timestamp);
    insertTask.run('calendar-over-limit', '超限历史区间', 'planned', '2025-01-01T16:00:00.000Z', '2023-12-31T16:00:00.000Z', '2025-01-01T16:00:00.000Z', timestamp, timestamp);
    insertTask.run('calendar-archived', '已归档任务', 'archived', '2026-08-14T18:00:00.000Z', null, '2026-08-14T18:00:00.000Z', timestamp, timestamp);
    insertTask.run('calendar-invalidated', '已作废任务', 'planned', '2026-08-14T19:00:00.000Z', null, '2026-08-14T19:00:00.000Z', timestamp, timestamp);
    database.raw.prepare("UPDATE task SET record_state = 'invalidated' WHERE id = 'calendar-invalidated'").run();
    insertTask.run('calendar-deleted', '已删除任务', 'planned', '2026-08-14T20:00:00.000Z', null, '2026-08-14T20:00:00.000Z', timestamp, timestamp);
    database.raw.prepare("UPDATE task SET deleted_at = ? WHERE id = 'calendar-deleted'").run(timestamp);

    const response = await app.inject({ method: 'GET', url: '/api/calendar' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      asOf: string;
      timezone: string;
      warning: string | null;
      omittedCount: number;
      days: Array<{ date: string; items: Array<{
        id: string;
        status: string;
        display_start_at: string | null;
        display_due_at: string | null;
        display_schedule_at: string | null;
        display_anchor_at: string;
      }> }>;
    };
    expect(body).toMatchObject({
      asOf: '2026-08-15T00:30:00.000Z',
      timezone: 'Asia/Shanghai',
      warning: '部分异常排期未显示。',
      omittedCount: 3,
    });
    const idsOn = (date: string) => body.days.find((day) => day.date === date)?.items.map((item) => item.id) ?? [];
    expect(idsOn('2026-08-14')).toEqual(expect.arrayContaining(['calendar-midnight-end', 'calendar-cross-day']));
    expect(idsOn('2026-08-15')).toEqual(expect.arrayContaining([
      'calendar-cross-day',
      'calendar-completed',
      'calendar-legacy',
      'calendar-equal-point',
      'calendar-bad-start-good-due',
      'calendar-bad-start-due-good-schedule',
    ]));
    expect(idsOn('2026-08-15')).not.toContain('calendar-midnight-end');
    expect(idsOn('2026-08-15').filter((id) => id === 'calendar-equal-point')).toHaveLength(1);
    expect(idsOn('2025-12-31')).toContain('calendar-multi-year');
    expect(idsOn('2026-01-01')).toContain('calendar-multi-year');
    expect(idsOn('2026-01-02')).toContain('calendar-multi-year');
    expect(idsOn('2026-01-31')).toContain('calendar-multi-month');
    expect(idsOn('2026-02-01')).toContain('calendar-multi-month');
    expect(idsOn('2026-02-02')).toContain('calendar-multi-month');
    const allIds = body.days.flatMap((day) => day.items.map((item) => item.id));
    expect(allIds).not.toContain('calendar-archived');
    expect(allIds).not.toContain('calendar-invalidated');
    expect(allIds).not.toContain('calendar-deleted');
    expect(allIds).not.toContain('calendar-all-bad');
    expect(allIds).not.toContain('calendar-reversed');
    expect(allIds).not.toContain('calendar-over-limit');
    const badStartGoodDue = body.days.flatMap((day) => day.items).find((item) => item.id === 'calendar-bad-start-good-due');
    expect(badStartGoodDue).toMatchObject({
      display_start_at: null,
      display_due_at: '2026-08-15T03:00:00.000Z',
      display_schedule_at: '2026-08-15T03:00:00.000Z',
      display_anchor_at: '2026-08-15T03:00:00.000Z',
    });
    const badRangeGoodSchedule = body.days.flatMap((day) => day.items).find((item) => item.id === 'calendar-bad-start-due-good-schedule');
    expect(badRangeGoodSchedule).toMatchObject({
      display_start_at: null,
      display_due_at: null,
      display_schedule_at: '2026-08-15T04:00:00.000Z',
      display_anchor_at: '2026-08-15T04:00:00.000Z',
    });
    expect(Object.keys(badRangeGoodSchedule ?? {}).sort()).toEqual([
      'display_anchor_at',
      'display_due_at',
      'display_schedule_at',
      'display_start_at',
      'id',
      'next_step',
      'status',
      'title',
    ]);
    expect(JSON.stringify(body)).not.toContain('bad-start-secret');
    expect(JSON.stringify(body)).not.toContain('bad-due-secret');
  });

  it('任务写入允许 366 个上海自然日并拒绝上限加一和反向区间', async () => {
    const candidate = (await simulate('calendar-write-limit')).json().candidate;
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${candidate.id}/action`, payload: { action: 'accept', expectedVersion: candidate.version } });
    const task = accepted.json().task as { id: string; version: number };
    const atLimit = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: {
        plannedStartAt: '2023-12-31T16:00:00.000Z',
        plannedDueAt: '2024-12-31T16:00:00.000Z',
        expectedVersion: task.version,
      },
    });
    expect(atLimit.statusCode).toBe(200);

    const overLimit = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: {
        plannedStartAt: '2023-12-31T16:00:00.000Z',
        plannedDueAt: '2025-01-01T16:00:00.000Z',
        expectedVersion: atLimit.json().version,
      },
    });
    expect(overLimit.statusCode).toBe(409);
    expect(overLimit.json()).toEqual({ error: '计划时间跨度不能超过 366 个上海自然日。' });

    const reversed = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: {
        plannedStartAt: '2026-08-15T16:00:00.000Z',
        plannedDueAt: '2026-08-14T16:00:00.000Z',
        expectedVersion: atLimit.json().version,
      },
    });
    expect(reversed.statusCode).toBe(409);
    expect(reversed.json()).toEqual({ error: '计划完成时间不能早于计划开始时间。' });
  });

  it('已接受候选移入回收站时正式任务同步删除，恢复候选时同步恢复任务', async () => {
    const created = (await simulate('candidate-trash')).json();
    const candidate = created.candidate as { id: string; version: number };
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${candidate.id}/action`, payload: { action: 'accept', expectedVersion: candidate.version } });
    const taskId = accepted.json().task.id as string;
    const deleted = await app.inject({ method: 'DELETE', url: `/api/candidates/${candidate.id}`, payload: { expectedVersion: accepted.json().candidate.version } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ id: candidate.id, deleted_at: expect.any(String), accepted_task_id: taskId });
    expect((await app.inject({ method: 'GET', url: '/api/candidates' })).json().items.some((item: { id: string }) => item.id === candidate.id)).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/candidates?deleted=only' })).json().items.some((item: { id: string }) => item.id === candidate.id)).toBe(true);
    expect((database.raw.prepare('SELECT archived_at FROM notification WHERE candidate_id = ?').get(candidate.id) as { archived_at: string | null }).archived_at).toBeTruthy();
    expect((await app.inject({ method: 'POST', url: `/api/candidates/${candidate.id}/action`, payload: { action: 'snooze', expectedVersion: deleted.json().version } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json().deleted_at).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: '/api/tasks' })).json().items.some((item: { id: string }) => item.id === taskId)).toBe(false);
    const restored = await app.inject({ method: 'POST', url: `/api/candidates/${candidate.id}/restore`, payload: { expectedVersion: deleted.json().version } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().deleted_at).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/candidates' })).json().items.some((item: { id: string }) => item.id === candidate.id)).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json().deleted_at).toBeNull();
  });

  it('候选表结构残缺的旧 SQLite 会 fail-closed 且保留旧候选', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-pm-candidate-migrate-'));
    const path = join(directory, 'legacy.sqlite');
    const baseline = new AppDatabase(path, false);
    baseline.raw.prepare(`INSERT INTO source_event
      (id, external_id, source_type, conversation_id, sender_id, sender_name, content,
       owner_mentioned, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
      VALUES ('legacy-source', 'legacy-external', 'message', 'legacy-conversation', 'legacy-sender',
              '需求方', '合成旧候选来源', 0, 'complete', 'synthetic', '{}',
              '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')`).run();
    baseline.raw.prepare(`INSERT INTO candidate_request
      (id, source_event_id, title, proposer_name, background, validation_question, describe,
       confidence, state, created_at, updated_at)
      VALUES ('legacy-candidate', 'legacy-source', '旧候选', '需求方', '背景', '验证', '描述',
              0.8, 'pending', '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z')`).run();
    baseline.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`PRAGMA foreign_keys = OFF;
      DROP TABLE schema_migration;
      PRAGMA user_version = 0;
      CREATE TABLE candidate_request_legacy (
      id TEXT PRIMARY KEY,
      source_event_id TEXT NOT NULL,
      title TEXT NOT NULL,
      proposer_name TEXT NOT NULL,
      background TEXT NOT NULL,
      validation_question TEXT NOT NULL,
      describe TEXT NOT NULL,
      confidence REAL NOT NULL,
      state TEXT NOT NULL,
      snoozed_until TEXT,
      accepted_task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO candidate_request_legacy
      (id, source_event_id, title, proposer_name, background, validation_question, describe, confidence, state, snoozed_until, accepted_task_id, created_at, updated_at)
      SELECT id, source_event_id, title, proposer_name, background, validation_question, describe,
             confidence, state, snoozed_until, accepted_task_id, created_at, updated_at
      FROM candidate_request;
    DROP TABLE candidate_request;
    ALTER TABLE candidate_request_legacy RENAME TO candidate_request;`);
    legacy.close();
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = new DatabaseSync(path, { readOnly: true });
    expect(preserved.prepare('SELECT title FROM candidate_request WHERE id = ?').get('legacy-candidate'))
      .toEqual({ title: '旧候选' });
    preserved.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('任何对外动作只进入 awaiting_approval，飞书适配器不发送', async () => {
    const candidate = (await simulate('message-outbox')).json().candidate;
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/action`,
      payload: { action: 'accept', expectedVersion: candidate.version },
    });
    const taskId = accepted.json().task.id;
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/external-actions`,
      payload: { actionType: 'send_message', payload: { text: '预计周五交付' } },
    });
    expect(response.json()).toMatchObject({ status: 'awaiting_approval', externallySent: false, adapterSentCount: 0 });
    expect(adapters.feishu.sentCount).toBe(0);
    const outbox = database.raw.prepare('SELECT status FROM outbox').get() as { status: string };
    expect(outbox.status).toBe('awaiting_approval');
  });

  it('草稿生成按任务版本和 payload 幂等，目标变化会终止旧草稿且仍不发送', async () => {
    const candidate = (await simulate('message-outbox-idempotent')).json().candidate;
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${candidate.id}/action`, payload: { action: 'accept', expectedVersion: candidate.version } });
    const taskId = accepted.json().task.id as string;
    const first = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/external-actions`,
      payload: { actionType: 'draft_status_update', payload: { note: '合成草稿', taskId } },
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/external-actions`,
      payload: { actionType: 'draft_status_update', payload: { taskId, note: '合成草稿' } },
    });
    expect(duplicate.json()).toMatchObject({
      approvalId: first.json().approvalId,
      outboxId: first.json().outboxId,
      state: 'draft',
      sendAvailable: false,
      externallySent: false,
    });
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM approval WHERE task_id = ?').get(taskId) as { count: number }).count).toBe(1);

    const changed = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/external-actions`,
      payload: { actionType: 'draft_status_update', payload: { note: '新的合成草稿', taskId } },
    });
    expect(changed.json().approvalId).not.toBe(first.json().approvalId);
    expect((database.raw.prepare('SELECT status FROM approval WHERE id = ?').get(first.json().approvalId) as { status: string }).status).toBe('rejected');
    expect((database.raw.prepare('SELECT status FROM outbox WHERE id = ?').get(first.json().outboxId) as { status: string }).status).toBe('failed');
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM outbox WHERE status = \'awaiting_approval\'').get() as { count: number }).count).toBe(1);
    const detail = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json();
    expect(detail.approvals[0]).not.toHaveProperty('payload_json');
    expect(detail).not.toHaveProperty('outbox_drafts');
    expect(detail).not.toHaveProperty('provider');
    expect((await app.inject({ method: 'POST', url: `/api/outbox/${changed.json().outboxId}/send` })).statusCode).toBe(404);
    const rejected = await app.inject({ method: 'POST', url: `/api/approvals/${changed.json().approvalId}/reject`, payload: {} });
    expect(rejected.statusCode).toBe(200);
    const rejectedApproval = rejected.json().approvals.find((approval: { id: string }) => approval.id === changed.json().approvalId);
    expect(rejectedApproval).toMatchObject({ status: 'rejected' });
    expect(rejectedApproval).not.toHaveProperty('state');
    expect(rejectedApproval).not.toHaveProperty('externally_sent');
    expect(rejected.json()).not.toHaveProperty('outbox_drafts');
    expect((database.raw.prepare('SELECT status FROM outbox WHERE approval_id = ?').get(changed.json().approvalId) as { status: string }).status).toBe('failed');
    const repeatedReject = await app.inject({ method: 'POST', url: `/api/approvals/${changed.json().approvalId}/reject`, payload: {} });
    expect(repeatedReject.statusCode).toBe(200);
    const repeatedRejectedApproval = repeatedReject.json().approvals.find((approval: { id: string }) => approval.id === changed.json().approvalId);
    expect(repeatedRejectedApproval).toMatchObject({ status: 'rejected' });
    expect(repeatedRejectedApproval).not.toHaveProperty('state');
    expect(repeatedReject.json()).not.toHaveProperty('outbox_drafts');
    expect(adapters.feishu.sentCount).toBe(0);
  });

  it('正式任务可直接设置和清除我的计划时间，并使用版本检查', async () => {
    const candidate = (await simulate('task-private-plan')).json().candidate;
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${candidate.id}/action`, payload: { action: 'accept', expectedVersion: candidate.version } });
    const task = accepted.json().task as { id: string; version: number };
    const startAt = '2026-08-12T01:00:00.000Z';
    const dueAt = '2026-08-13T10:00:00.000Z';

    const planned = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { plannedStartAt: startAt, plannedDueAt: dueAt, status: 'planned', expectedVersion: task.version },
    });
    expect(planned.statusCode).toBe(200);
    expect(planned.json()).toMatchObject({ planned_start_at: startAt, planned_due_at: dueAt, schedule_at: dueAt, status: 'planned' });
    expect((await app.inject({ method: 'GET', url: '/api/calendar' })).json().days
      .flatMap((day: { items: Array<{ id: string }> }) => day.items)
      .some((item: { id: string }) => item.id === task.id)).toBe(true);
    expect((database.raw.prepare("SELECT summary, visibility FROM task_event WHERE task_id = ? AND event_type = 'task_updated' ORDER BY recorded_at DESC LIMIT 1").get(task.id) as { summary: string; visibility: string })).toEqual({
      summary: '系统主人更新了我的计划时间。',
      visibility: 'private',
    });

    const stale = await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { plannedDueAt: null, expectedVersion: task.version } });
    expect(stale.statusCode).toBe(409);
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: { plannedStartAt: null, plannedDueAt: null, status: 'unplanned', expectedVersion: planned.json().version },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ planned_start_at: null, planned_due_at: null, schedule_at: null, status: 'unplanned' });
    expect((await app.inject({ method: 'GET', url: '/api/calendar' })).json().days
      .flatMap((day: { items: Array<{ id: string }> }) => day.items)
      .some((item: { id: string }) => item.id === task.id)).toBe(false);
  });

  it('自动维护策略、完整任务编辑和单任务暂停都通过版本保护 API', async () => {
    const policy = await app.inject({ method: 'GET', url: '/api/automation-policy' });
    expect(policy.statusCode).toBe(200);
    expect(policy.json()).toMatchObject({ mode: 'auto', associationThreshold: 0.9, updateThreshold: 0.92 });
    const suggest = await app.inject({ method: 'PATCH', url: '/api/automation-policy', payload: { mode: 'suggest' } });
    expect(suggest.statusCode).toBe(200);
    expect(suggest.json()).toMatchObject({ mode: 'suggest' });
    expect((await app.inject({ method: 'PATCH', url: '/api/automation-policy', payload: { mode: 'unsafe' } })).statusCode).toBe(400);

    const candidate = (await simulate('task-full-edit')).json().candidate;
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${candidate.id}/action`, payload: { action: 'accept', expectedVersion: candidate.version } });
    const task = accepted.json().task as { id: string; version: number };
    expect((await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { title: '缺少版本号' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}/automation`, payload: { paused: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/restore`, payload: {} })).statusCode).toBe(400);
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}`,
      payload: {
        title: '完整编辑后的标题',
        describe: '完整编辑后的 Describe',
        nextStep: '先复核数据口径',
        risk: 'high',
        waitingReason: '等待策划确认范围',
        status: 'waiting',
        plannedStartAt: '2026-08-12T01:00:00.000Z',
        plannedDueAt: '2026-08-13T10:00:00.000Z',
        expectedVersion: task.version,
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      title: '完整编辑后的标题',
      describe: '完整编辑后的 Describe',
      next_step: '先复核数据口径',
      risk: 'high',
      waiting_reason: '等待策划确认范围',
      status: 'waiting',
    });
    expect(JSON.stringify(edited.json())).toContain('完整编辑后的标题');
    expect(database.raw.prepare(
      'SELECT title, describe, next_step, risk, waiting_reason, status FROM task WHERE id = ?',
    ).get(task.id)).toMatchObject({
      title: '完整编辑后的标题',
      describe: '完整编辑后的 Describe',
      next_step: '先复核数据口径',
      risk: 'high',
      waiting_reason: '等待策划确认范围',
      status: 'waiting',
    });
    const paused = await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}/automation`, payload: { paused: true, expectedVersion: edited.json().version } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ auto_update_paused: true, version: edited.json().version + 1 });
    const stale = await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}/automation`, payload: { paused: false, expectedVersion: edited.json().version } });
    expect(stale.statusCode).toBe(409);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count).toBe(0);
  });

  it('删除任务只移到回收站，保留来源和审计且可以恢复', async () => {
    const candidate = (await simulate('task-recycle-bin')).json().candidate;
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${candidate.id}/action`, payload: { action: 'accept', expectedVersion: candidate.version } });
    const task = accepted.json().task as { id: string; version: number };
    await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/references`, payload: { label: '只读路径', referencePath: 'workspace://reports' } });
    await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/external-actions`, payload: { actionType: 'draft_status_update', payload: { note: '不会发送' } } });
    const beforeOutbox = (database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count;

    const staleDelete = await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}`, payload: { expectedVersion: task.version + 1 } });
    expect(staleDelete.statusCode).toBe(409);
    const deleted = await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}`, payload: { expectedVersion: task.version } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().deleted_at).toBeTruthy();
    expect((database.raw.prepare('SELECT deleted_at FROM candidate_request WHERE id = ?').get(candidate.id) as { deleted_at: string | null }).deleted_at).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: '/api/tasks' })).json().items.some((item: { id: string }) => item.id === task.id)).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/tasks?recordState=all&deleted=only' })).json().items.some((item: { id: string }) => item.id === task.id)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard' })).json().today.some((item: { id: string }) => item.id === task.id)).toBe(false);
    const detail = (await app.inject({ method: 'GET', url: `/api/tasks/${task.id}` })).json();
    expect(detail.sources).toHaveLength(1);
    expect(detail.references).toHaveLength(1);
    expect(detail.events.some((event: { event_type: string }) => event.event_type === 'task_deleted')).toBe(true);
    expect(detail.approvals[0].status).toBe('rejected');
    expect(detail.approvals[0]).not.toHaveProperty('state');
    expect(detail.approvals[0]).not.toHaveProperty('externally_sent');
    expect(detail).not.toHaveProperty('outbox_drafts');
    expect((database.raw.prepare('SELECT status FROM outbox WHERE approval_id = ?').get(detail.approvals[0].id) as { status: string }).status).toBe('failed');
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count).toBe(beforeOutbox);
    const blockedEdit = await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { nextStep: '不应写入', expectedVersion: deleted.json().version } });
    expect(blockedEdit.statusCode).toBe(409);

    const staleRestore = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/restore`, payload: { expectedVersion: task.version } });
    expect(staleRestore.statusCode).toBe(409);
    const restored = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/restore`, payload: { expectedVersion: deleted.json().version } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().deleted_at).toBeNull();
    expect((database.raw.prepare('SELECT deleted_at FROM candidate_request WHERE id = ?').get(candidate.id) as { deleted_at: string | null }).deleted_at).toBeNull();
    expect(restored.json().events.some((event: { event_type: string }) => event.event_type === 'task_restored')).toBe(true);
    expect((database.raw.prepare('SELECT status FROM outbox WHERE approval_id = ?').get(detail.approvals[0].id) as { status: string }).status).toBe('failed');
    expect(restored.json()).not.toHaveProperty('outbox_drafts');
    expect((await app.inject({ method: 'GET', url: '/api/tasks' })).json().items.some((item: { id: string }) => item.id === task.id)).toBe(true);
    expect(adapters.feishu.sentCount).toBe(0);
  });
});
