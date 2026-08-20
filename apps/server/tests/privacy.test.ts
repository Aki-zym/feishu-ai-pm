import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, createLocalActionCapability, PRIVACY_DELETION_INTENT, PRIVACY_OWNER_ACTION_INTENT, type LocalActionCapability } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  AppDatabase,
  CANDIDATE_VERSION_MIGRATION_CHECKSUM,
  CURRENT_SCHEMA_VERSION,
  PRIVACY_FENCING_MIGRATION_CHECKSUM,
  PRIVACY_FENCING_MIGRATION_DESCRIPTOR,
  PRIVACY_MIGRATION_CHECKSUM,
  PRIVACY_MIGRATION_DESCRIPTOR,
  type MigrationDescriptor,
} from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

const now = '2026-08-16T00:00:00.000Z';

function insertSyntheticGraph(database: AppDatabase) {
  const raw = database.raw;
  raw.prepare(`INSERT INTO source_event
    (id, external_id, source_type, conversation_id, sender_id, sender_name, content,
     owner_mentioned, source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
    VALUES ('source-privacy', 'external-privacy', 'owner_dm', 'conversation-privacy', 'sender-privacy',
      'sender privacy canary', 'source content canary', 1, 'https://source.invalid/privacy', 'complete',
      'discovery reason canary', '{"provider_secret":"provider raw canary"}', ?, ?)`)
    .run(now, now);
  raw.prepare(`INSERT INTO source_event_revision
    (id, source_event_id, revision_number, revision_kind, external_id, source_type, conversation_id,
     sender_id, sender_name, content, owner_mentioned, source_url, completeness, discovery_reason,
     metadata_json, occurred_at, captured_at, revision_hash, created_at)
    VALUES ('revision-privacy', 'source-privacy', 1, 'ingest', 'external-privacy', 'owner_dm',
      'conversation-privacy', 'sender-privacy', 'sender privacy canary', 'source content canary', 1,
      'https://source.invalid/privacy', 'complete', 'discovery reason canary', '{}', ?, ?, '${'d'.repeat(64)}', ?)`)
    .run(now, now, now);
  raw.prepare('UPDATE source_event SET current_revision_id = ? WHERE id = ?').run('revision-privacy', 'source-privacy');
  raw.prepare(`INSERT INTO source_context
    (id, source_event_id, source_url, external_id, document_type, title, source_version,
     content_excerpt, content_hash, status, freshness, completeness, truncated, last_error,
     last_success_at, checked_at, created_at, updated_at)
    VALUES ('context-privacy', 'source-privacy', 'https://source.invalid/context', 'context-external',
      'document', 'context title canary', 'v1', 'provider context canary', '${'a'.repeat(64)}',
      'ready', 'fresh', 'complete', 0, NULL, ?, ?, ?, ?)`)
    .run(now, now, now, now);
  raw.prepare(`INSERT INTO source_demand_unit
    (id, anchor_source_event_id, unit_key, unit_kind, state, analysis_json, reason, created_at, updated_at)
    VALUES ('unit-privacy', 'source-privacy', 'privacy', 'demand', 'ready',
      '{"raw":"provider analysis canary"}', 'demand reason canary', ?, ?)`)
    .run(now, now);
  raw.prepare(`INSERT INTO source_demand_unit_source
    (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
    VALUES ('unit-privacy', 'source-privacy', 'privacy-source', 'anchor', 0, ?)`)
    .run(now);
  raw.prepare(`INSERT INTO candidate_request
    (id, source_event_id, demand_unit_id, title, proposer_name, background, validation_question,
     describe, analysis_json, confidence, state, accepted_task_id, created_at, updated_at)
    VALUES ('candidate-privacy', 'source-privacy', 'unit-privacy', 'candidate title canary',
      'candidate proposer canary', 'candidate background canary', 'candidate question canary',
      'candidate describe canary', '{"provider":"provider candidate canary"}', 0.9, 'accepted',
      'task-privacy', ?, ?)`)
    .run(now, now);
  raw.prepare(`INSERT INTO requirement_thread
    (id, status, title, background, validation_question, describe, analysis_json, conversation_id,
     primary_source_event_id, primary_reason, version, created_at, updated_at)
    VALUES ('thread-privacy', 'open', 'thread title canary', 'thread background canary',
      'thread question canary', 'thread describe canary', '{"raw":"thread provider canary"}',
      'conversation-privacy', 'source-privacy', 'thread reason canary', 1, ?, ?)`)
    .run(now, now);
  raw.prepare(`INSERT INTO requirement_thread_source
    (thread_id, source_event_id, relation_type, confidence, evidence_json, source_role, role_reason, created_at)
    VALUES ('thread-privacy', 'source-privacy', 'primary', 0.9, '["thread evidence canary"]',
      'primary', 'thread role canary', ?)`)
    .run(now);
  raw.prepare(`INSERT INTO requirement_thread_unit
    (thread_id, demand_unit_id, relation_type, confidence, evidence_json, created_at)
    VALUES ('thread-privacy', 'unit-privacy', 'primary', 0.9, '["unit evidence canary"]', ?)`)
    .run(now);
  raw.prepare(`INSERT INTO task
    (id, title, proposer_name, describe, status, next_step, risk, thread_id, created_at, updated_at)
    VALUES ('task-privacy', 'task title canary', 'task proposer canary', 'task describe canary',
      'planned', 'task next step canary', 'low', 'thread-privacy', ?, ?)`)
    .run(now, now);
  raw.prepare(`INSERT INTO task_source_link
    (task_id, source_event_id, demand_unit_id, relation_type, created_at)
    VALUES ('task-privacy', 'source-privacy', 'unit-privacy', 'origin', ?)`)
    .run(now);
  raw.prepare(`INSERT INTO task_event
    (id, task_id, event_type, actor_type, visibility, summary, source_event_id, demand_unit_id,
     before_json, after_json, occurred_at, recorded_at, version)
    VALUES ('event-privacy', 'task-privacy', 'task_created', 'system', 'private',
      'task event summary canary', 'source-privacy', 'unit-privacy',
      '{"before":"before canary"}', '{"after":"after canary"}', ?, ?, 1)`)
    .run(now, now);
  raw.prepare(`INSERT INTO ai_decision_log
    (id, source_event_id, demand_unit_id, candidate_id, provider, model, prompt_version,
     is_data_request, confidence, reason, output_json, used_fallback, http_status, provider_request_id,
     attempts, structured_mode, input_hash, input_char_count, fallback_mode, latency_ms, created_at)
    VALUES ('ai-privacy', 'source-privacy', 'unit-privacy', 'candidate-privacy', 'provider canary',
      'model canary', 'prompt canary', 1, 0.8, 'ai reason canary', '{"output":"provider payload canary"}',
      0, 200, 'provider request canary', 1, 'json_object', '${'b'.repeat(64)}', 12, 'none', 3, ?)`)
    .run(now);
  raw.prepare(`INSERT INTO ai_decision_source_revision
    (ai_decision_id, source_event_id, revision_id, source_order)
    VALUES ('ai-privacy', 'source-privacy', 'revision-privacy', 0)`).run();
  raw.prepare(`INSERT INTO owner_decision
    (id, source_event_id, source_revision, candidate_id, thread_id, task_id, action, disposition,
     confidence, summary, reason, provider, model, prompt_version, state, created_at)
    VALUES ('owner-privacy', 'source-privacy', '${'c'.repeat(64)}', 'candidate-privacy', 'thread-privacy',
      'task-privacy', 'continue', 'review', 0.8, 'owner summary canary', 'owner reason canary',
      'owner provider canary', 'owner model canary', 'owner prompt canary', 'queued', ?)`)
    .run(now);
  raw.prepare(`INSERT INTO correction_event
    (id, task_id, candidate_id, source_event_id, demand_unit_id, correction_type, before_json,
     after_json, note, visibility, operation, created_at)
    VALUES ('correction-privacy', 'task-privacy', 'candidate-privacy', 'source-privacy', 'unit-privacy',
      'manual', '{"before":"correction before canary"}', '{"after":"correction after canary"}',
      'correction note canary', 'private', 'apply', ?)`)
    .run(now);
  raw.prepare(`INSERT INTO data_integrity_gap
    (id, source_event_id, demand_unit_id, candidate_id, thread_id, task_id, record_table, record_id,
     reason, status, correction_event_id, created_at, updated_at)
    VALUES ('gap-privacy', 'source-privacy', 'unit-privacy', 'candidate-privacy', 'thread-privacy',
      'task-privacy', 'task_source_link', 'task-privacy:source-privacy', 'gap reason canary',
      'open', 'correction-privacy', ?, ?)`)
    .run(now, now);
  raw.prepare(`INSERT INTO reference_binding
    (id, task_id, label, reference_path, access_mode, created_at)
    VALUES ('reference-privacy', 'task-privacy', 'reference label canary', 'C:/synthetic/reference', 'reference_only', ?)`)
    .run(now);
}

function downgradeV5ToV4(path: string) {
  const current = new AppDatabase(path, false);
  current.close();
  const raw = new DatabaseSync(path);
  try {
    raw.exec(`
      DROP TABLE IF EXISTS privacy_audit_event;
      DROP TABLE IF EXISTS privacy_backup;
      DROP TABLE IF EXISTS privacy_deletion;
      DROP TABLE IF EXISTS privacy_export;
      DROP TABLE IF EXISTS privacy_retention_policy;
      DROP TABLE IF EXISTS privacy_control;
      DROP TABLE IF EXISTS privacy_lifecycle_claim;
      DROP TABLE IF EXISTS privacy_backup_cleanup_intent;
      DROP INDEX IF EXISTS idx_provider_retry_cooldown_retry_at;
      DROP TABLE IF EXISTS provider_retry_cooldown;
      DROP TABLE IF EXISTS ai_decision_source_revision;
      DROP TABLE IF EXISTS source_event_revision;
      DROP TABLE IF EXISTS audit_replay_capability;
      ALTER TABLE source_event DROP COLUMN owner_scope;
      ALTER TABLE source_event DROP COLUMN revision_generation;
      ALTER TABLE source_event DROP COLUMN current_revision_id;
      ALTER TABLE ai_decision_log DROP COLUMN revision_set_hash;
      ALTER TABLE ai_decision_log DROP COLUMN prompt_hash;
      ALTER TABLE ai_decision_log DROP COLUMN model_config_hash;
      ALTER TABLE ai_decision_log DROP COLUMN replay_state;
      ALTER TABLE ai_decision_log DROP COLUMN replay_state_reason;
      ALTER TABLE ai_decision_log DROP COLUMN owner_scope;
      DELETE FROM schema_migration WHERE version >= 5;
      PRAGMA user_version = 4;
    `);
  } finally {
    raw.close();
  }
}

function fileHash(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function installSyntheticOwner(database: AppDatabase) {
  database.raw.prepare(
    `INSERT INTO owner_profile (id, open_id, name, oauth_status, created_at, updated_at)
     VALUES ('primary', 'synthetic-owner', 'Synthetic Owner', 'mock', ?, ?)`,
  ).run(now, now);
}

function privacyHeaders(capability: LocalActionCapability, intent = PRIVACY_DELETION_INTENT) {
  return {
    'x-ai-pm-desktop-capability': capability.token,
    'x-csrf-token': capability.csrfToken,
    origin: capability.origin,
    referer: `${capability.origin}/`,
    'x-ai-pm-privacy-intent': intent,
  };
}

function ownerPrivacyHeaders(capability: LocalActionCapability) {
  return privacyHeaders(capability, PRIVACY_OWNER_ACTION_INTENT);
}

type PrivacyTestPurgeStage = {
  count: number;
  proofHash: string;
  finalize(): void;
  rollback(): void;
};

describe('PRIV-001 隐私生命周期闭环', () => {
  let database: AppDatabase;
  let service: PmService;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let capability: LocalActionCapability;
  let privacyMemoryRoot: string;

  beforeEach(async () => {
    database = new AppDatabase(':memory:', false);
    privacyMemoryRoot = mkdtempSync(join(tmpdir(), 'issue34-privacy-memory-default-'));
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', TASK_MEMORY_ROOT: privacyMemoryRoot });
    service = new PmService(database, createAdapters(config), config);
    installSyntheticOwner(database);
    capability = createLocalActionCapability();
    app = await buildApp(service, { serveWeb: false, desktopCapability: capability });
  });

  afterEach(async () => {
    await app.close();
    database.close();
    rmSync(privacyMemoryRoot, { recursive: true, force: true });
  });

  it('连续 v6 migration 从 DATA-03 v4 精确升级，保留 v5 identity/checksum 并可重开幂等', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(8);
    expect(PRIVACY_MIGRATION_DESCRIPTOR.version).toBe(5);
    expect(PRIVACY_MIGRATION_CHECKSUM).toMatch(/^[a-f0-9]{64}$/u);
    expect(PRIVACY_FENCING_MIGRATION_DESCRIPTOR.version).toBe(6);
    expect(PRIVACY_FENCING_MIGRATION_CHECKSUM).toMatch(/^[a-f0-9]{64}$/u);
    expect(CANDIDATE_VERSION_MIGRATION_CHECKSUM).toMatch(/^[a-f0-9]{64}$/u);
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-v5-migration-'));
    const path = join(root, 'data.sqlite');
    try {
      const initial = new AppDatabase(path, false);
      initial.close();
      downgradeV5ToV4(path);
      const upgraded = new AppDatabase(path, false);
      expect(upgraded.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
      expect(upgraded.raw.prepare('SELECT version, name FROM schema_migration ORDER BY version').all())
        .toEqual(expect.arrayContaining([
          { version: 4, name: 'data-03-candidate-version-cas' },
          { version: 5, name: 'priv-001-lifecycle-export-deletion' },
          { version: 6, name: 'priv-001-cross-process-fencing' },
          { version: 7, name: 'data-04-source-revisions-replay' },
          { version: 8, name: 'run-02-provider-retry-cooldown' },
        ]));
      expect(upgraded.raw.prepare('SELECT checksum FROM schema_migration WHERE version = 5').get())
        .toEqual({ checksum: PRIVACY_MIGRATION_CHECKSUM });
      expect(upgraded.raw.prepare('SELECT COUNT(*) AS count FROM privacy_control').get()).toEqual({ count: 1 });
      expect(upgraded.raw.prepare('SELECT COUNT(*) AS count FROM privacy_lifecycle_claim').get()).toEqual({ count: 0 });
      upgraded.close();
      const reopened = new AppDatabase(path, false);
      expect(reopened.raw.prepare('SELECT COUNT(*) AS count FROM schema_migration').get()).toEqual({ count: 8 });
      reopened.close();
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows may release SQLite's final file handle after the test turn;
        // a locked OS temp directory is not product state or test evidence.
      }
    }
  });

  it('v5 partial schema 在任何 mutation 前拒绝，注入迁移失败时恢复 v4 原字节', () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-v5-rollback-'));
    const partialPath = join(root, 'partial.sqlite');
    const rollbackPath = join(root, 'rollback.sqlite');
    try {
      const partial = new AppDatabase(partialPath, false);
      partial.close();
      downgradeV5ToV4(partialPath);
      const partialRaw = new DatabaseSync(partialPath);
      partialRaw.exec('CREATE TABLE privacy_control (singleton_key INTEGER PRIMARY KEY);');
      partialRaw.close();
      const beforePartial = fileHash(partialPath);
      expect(() => new AppDatabase(partialPath, false)).toThrowError(expect.objectContaining({ name: 'DatabaseUpgradeError' }));
      expect(fileHash(partialPath)).toBe(beforePartial);

      const rollback = new AppDatabase(rollbackPath, false);
      rollback.close();
      downgradeV5ToV4(rollbackPath);
      const operations = [...PRIVACY_MIGRATION_DESCRIPTOR.orderedOperations];
      const sqlIndex = operations.findIndex((operation) => operation.id === 'privacy-lifecycle-schema');
      const sqlOperation = operations[sqlIndex]!;
      if (sqlOperation.kind !== 'sql_batch') throw new Error('privacy SQL operation missing');
      operations[sqlIndex] = { ...sqlOperation, statements: [...sqlOperation.statements, 'CREATE TABLE invalid_privacy_injected ('] };
      const injected = { ...PRIVACY_MIGRATION_DESCRIPTOR, orderedOperations: operations } as MigrationDescriptor;
      expect(() => new AppDatabase(rollbackPath, false, { migrationDescriptorForTest: injected }))
        .toThrowError(expect.objectContaining({ name: 'DatabaseUpgradeError', stage: 'migration' }));
      const restored = new DatabaseSync(rollbackPath);
      try {
        expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
        expect(restored.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?').get('privacy_control')).toEqual({ count: 0 });
      } finally {
        restored.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('停止采集、撤权和恢复入口遵守状态边界', async () => {
    const stopped = await app.inject({ method: 'POST', url: '/api/privacy/collection/stop', headers: ownerPrivacyHeaders(capability) });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ collectionStatus: 'stopped' });
    const stoppedSync = await service.syncFeishuOnce();
    expect(stoppedSync.outcome).toBe('skipped');
    expect(stoppedSync.sources.every((source) => source.status === 'skipped')).toBe(true);
    const restarted = await app.inject({ method: 'POST', url: '/api/privacy/collection/start', headers: ownerPrivacyHeaders(capability) });
    expect(restarted.statusCode).toBe(200);
    expect(restarted.json()).toMatchObject({ collectionStatus: 'running' });
    const revoked = await app.inject({ method: 'POST', url: '/api/privacy/revoke', headers: ownerPrivacyHeaders(capability) });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ collectionStatus: 'stopped', oauthStatus: 'revoked', platformRevoked: false });
    const afterRevoke = await app.inject({ method: 'POST', url: '/api/privacy/collection/start', headers: ownerPrivacyHeaders(capability) });
    expect(afterRevoke.statusCode).toBe(409);
    expect(afterRevoke.json().error).toContain('重新授权');
  });

  it('停止采集和撤权拒绝非法 CAS 输入并保持状态逐值不变', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/privacy/status' })).json();
    const stop = await app.inject({
      method: 'POST',
      url: '/api/privacy/collection/stop',
      headers: ownerPrivacyHeaders(capability),
      payload: { expectedVersion: 'not-a-number' },
    });
    expect(stop.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/privacy/status' })).json()).toEqual(before);

    const revoke = await app.inject({
      method: 'POST',
      url: '/api/privacy/revoke',
      headers: ownerPrivacyHeaders(capability),
      payload: { expectedVersion: -1 },
    });
    expect(revoke.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/privacy/status' })).json()).toEqual(before);
  });

  it('停止采集后，迟到的来源回调在持久化入口 fail-closed', async () => {
    const stopped = await app.inject({ method: 'POST', url: '/api/privacy/collection/stop', headers: ownerPrivacyHeaders(capability) });
    expect(stopped.statusCode).toBe(200);
    await expect(service.ingestSource({
      externalId: 'late-privacy-source',
      sourceType: 'owner_dm',
      conversationId: 'late-privacy-conversation',
      senderId: 'late-privacy-sender',
      senderName: 'synthetic sender',
      content: 'late source canary',
      occurredAt: now,
    })).rejects.toThrow('来源未写入');
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM source_event WHERE external_id = 'late-privacy-source'").get())
      .toEqual({ count: 0 });
  });

  it('导出只返回受控范围并对同一幂等键复用 payload/hash/audit', async () => {
    insertSyntheticGraph(database);
    const first = await app.inject({
      method: 'POST',
      url: '/api/privacy/export',
      headers: ownerPrivacyHeaders(capability),
      payload: { scope: 'all', format: 'json', idempotencyKey: 'privacy-export-1' },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.data.sources[0]).toMatchObject({ content: 'source content canary' });
    expect(firstBody.data.sourceRevisions[0]).toMatchObject({ id: 'revision-privacy', revision_hash: 'd'.repeat(64) });
    expect(firstBody.data.aiDecisionSourceRevisions).toEqual(expect.arrayContaining([
      { ai_decision_id: 'ai-privacy', source_event_id: 'source-privacy', revision_id: 'revision-privacy', source_order: 0 },
    ]));
    expect(firstBody.data.sources[0]).not.toHaveProperty('metadata_json');
    expect(firstBody.data.sourceContexts[0]).not.toHaveProperty('content_excerpt');
    expect(firstBody.data.taskEvents[0]).not.toHaveProperty('summary');
    expect(JSON.stringify(firstBody)).not.toContain('provider raw canary');
    expect(JSON.stringify(firstBody)).not.toContain('provider payload canary');
    const auditsBefore = database.raw.prepare("SELECT COUNT(*) AS count FROM privacy_audit_event WHERE event_type = 'export_completed'").get();
    const second = await app.inject({
      method: 'POST',
      url: '/api/privacy/export',
      headers: ownerPrivacyHeaders(capability),
      payload: { scope: 'all', format: 'json', idempotencyKey: 'privacy-export-1' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(firstBody);
    const auditsAfter = database.raw.prepare("SELECT COUNT(*) AS count FROM privacy_audit_event WHERE event_type = 'export_completed'").get();
    expect(auditsAfter).toEqual(auditsBefore);
  });

  it('同一导出幂等键不能静默复用不同范围', async () => {
    const first = await app.inject({
      method: 'POST', url: '/api/privacy/export', headers: ownerPrivacyHeaders(capability),
      payload: { scope: 'sources', format: 'json', idempotencyKey: 'privacy-export-scope-fence' },
    });
    expect(first.statusCode).toBe(200);
    const conflict = await app.inject({
      method: 'POST', url: '/api/privacy/export', headers: ownerPrivacyHeaders(capability),
      payload: { scope: 'tasks', format: 'json', idempotencyKey: 'privacy-export-scope-fence' },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('删除请求需要二次确认、CAS，成功后清理业务图但保留无内容证明', async () => {
    insertSyntheticGraph(database);
    const requested = await app.inject({
      method: 'POST',
      url: '/api/privacy/deletion/request',
      headers: privacyHeaders(capability),
      payload: { idempotencyKey: 'privacy-delete-1' },
    });
    expect(requested.statusCode).toBe(200);
    const request = requested.json();
    expect(database.raw.prepare(
      `SELECT owner_open_id, capability_token_hash, capability_csrf_hash, capability_origin, intent
       FROM privacy_deletion WHERE id = ?`,
    ).get(request.deletionId)).toEqual({
      owner_open_id: 'synthetic-owner',
      capability_token_hash: expect.any(String),
      capability_csrf_hash: expect.any(String),
      capability_origin: 'app://local',
      intent: 'privacy.deletion.hard-delete.v1',
    });
    const beforeWrong = database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get();
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/privacy/deletion/confirm',
      headers: privacyHeaders(capability),
      payload: { deletionId: request.deletionId, confirmationToken: 'wrong-token' },
    });
    expect(wrong.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual(beforeWrong);

    const completed = await app.inject({
      method: 'POST',
      url: '/api/privacy/deletion/confirm',
      headers: privacyHeaders(capability),
      payload: { deletionId: request.deletionId, confirmationToken: request.confirmationToken },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ latestDeletion: { status: 'completed' }, retentionStatus: 'paused' });
    for (const table of [
      'source_event', 'source_context', 'source_demand_unit', 'source_demand_unit_source',
      'candidate_request', 'requirement_thread', 'task', 'task_source_link', 'task_event',
      'ai_decision_log', 'owner_decision', 'correction_event', 'data_integrity_gap',
      'reference_binding', 'source_event_revision', 'ai_decision_source_revision',
    ]) {
      expect(database.raw.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()).toEqual({ count: 0 });
    }
    expect(database.raw.prepare("SELECT status, proof_hash FROM privacy_deletion WHERE id = ?").get(request.deletionId))
      .toMatchObject({ status: 'completed', proof_hash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(database.raw.prepare("SELECT event_type, record_count, proof_hash FROM privacy_audit_event WHERE event_type = 'deletion_completed'").get())
      .toMatchObject({ event_type: 'deletion_completed', proof_hash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });

  it('未知表和 CAS 冲突时 fail-closed，业务行与删除记录不被静默清理', async () => {
    insertSyntheticGraph(database);
    const request = (await app.inject({
      method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability), payload: { idempotencyKey: 'privacy-delete-cas' },
    })).json();
    database.raw.prepare('UPDATE privacy_control SET version = version + 1 WHERE singleton_key = 1').run();
    const cas = await app.inject({
      method: 'POST', url: '/api/privacy/deletion/confirm',
      headers: privacyHeaders(capability),
      payload: { deletionId: request.deletionId, confirmationToken: request.confirmationToken },
    });
    expect(cas.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT status FROM privacy_deletion WHERE id = ?').get(request.deletionId)).toEqual({ status: 'pending_confirmation' });

    database.raw.exec('CREATE TABLE synthetic_unknown_privacy_table (id TEXT PRIMARY KEY);');
    database.raw.prepare('UPDATE privacy_control SET version = version + 1 WHERE singleton_key = 1').run();
    const second = (await app.inject({
      method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability), payload: { idempotencyKey: 'privacy-delete-unknown' },
    })).json();
    const failed = await app.inject({
      method: 'POST', url: '/api/privacy/deletion/confirm',
      headers: privacyHeaders(capability),
      payload: { deletionId: second.deletionId, confirmationToken: second.confirmationToken },
    });
    expect(failed.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT status, error_code FROM privacy_deletion WHERE id = ?').get(second.deletionId))
      .toEqual({ status: 'failed', error_code: 'PRIVACY_DELETE_FAILED' });
  });

  it('文件数据库备份返回 hash 并拒绝损坏或非当前实例文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-backup-'));
    const path = join(root, 'data.sqlite');
    const fileDatabase = new AppDatabase(path, false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path });
    const fileService = new PmService(fileDatabase, createAdapters(config), config);
    installSyntheticOwner(fileDatabase);
    const fileCapability = createLocalActionCapability();
    const fileApp = await buildApp(fileService, { serveWeb: false, desktopCapability: fileCapability });
    try {
      const created = await fileApp.inject({ method: 'POST', url: '/api/privacy/backup', headers: ownerPrivacyHeaders(fileCapability) });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ schemaVersion: 8, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      const verified = await fileApp.inject({
        method: 'POST', url: '/api/privacy/backup/verify', headers: ownerPrivacyHeaders(fileCapability), payload: { fileName: created.json().fileName },
      });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({ requiresRestart: true, sha256: created.json().sha256 });
      const rejected = await fileApp.inject({
        method: 'POST', url: '/api/privacy/backup/verify', headers: ownerPrivacyHeaders(fileCapability), payload: { fileName: '../outside.sqlite' },
      });
      expect(rejected.statusCode).toBe(409);
    } finally {
      await fileApp.close();
      fileDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('硬删除同时清除导出副本与受管备份，回滚时不丢备份', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-delete-backup-'));
    const path = join(root, 'data.sqlite');
    const fileDatabase = new AppDatabase(path, false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path, TASK_MEMORY_ROOT: join(root, 'task-memory') });
    const fileService = new PmService(fileDatabase, createAdapters(config), config);
    installSyntheticOwner(fileDatabase);
    const fileCapability = createLocalActionCapability();
    const fileApp = await buildApp(fileService, { serveWeb: false, desktopCapability: fileCapability });
    try {
      insertSyntheticGraph(fileDatabase);
      const exported = await fileApp.inject({
        method: 'POST', url: '/api/privacy/export', headers: ownerPrivacyHeaders(fileCapability),
        payload: { scope: 'all', format: 'json', idempotencyKey: 'privacy-delete-export-copy' },
      });
      expect(exported.statusCode).toBe(200);
      const backup = await fileApp.inject({ method: 'POST', url: '/api/privacy/backup', headers: ownerPrivacyHeaders(fileCapability) });
      expect(backup.statusCode).toBe(200);
      expect(readdirSync(join(root, 'backups')).some((name) => name.endsWith('.sqlite'))).toBe(true);
      const request = (await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(fileCapability), payload: { idempotencyKey: 'privacy-delete-export-copy' },
      })).json();
      const completed = await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm',
        headers: privacyHeaders(fileCapability),
        payload: { deletionId: request.deletionId, confirmationToken: request.confirmationToken },
      });
      expect(completed.statusCode).toBe(200);
      expect(fileDatabase.raw.prepare('SELECT COUNT(*) AS count FROM privacy_export').get()).toEqual({ count: 0 });
      expect(fileDatabase.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
      expect(readdirSync(join(root, 'backups')).some((name) => name.endsWith('.sqlite'))).toBe(false);
      const preserved = fileDatabase.raw.prepare('SELECT payload_json FROM privacy_export').all();
      expect(JSON.stringify(preserved)).not.toContain('source content canary');
    } finally {
      await fileApp.close();
      fileDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('损坏的受管备份使硬删除 fail-closed 并保留业务行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-corrupt-backup-'));
    const path = join(root, 'data.sqlite');
    const fileDatabase = new AppDatabase(path, false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path, TASK_MEMORY_ROOT: join(root, 'task-memory') });
    const fileService = new PmService(fileDatabase, createAdapters(config), config);
    installSyntheticOwner(fileDatabase);
    const fileCapability = createLocalActionCapability();
    const fileApp = await buildApp(fileService, { serveWeb: false, desktopCapability: fileCapability });
    try {
      insertSyntheticGraph(fileDatabase);
      const backup = (await fileApp.inject({ method: 'POST', url: '/api/privacy/backup', headers: ownerPrivacyHeaders(fileCapability) })).json();
      writeFileSync(join(root, 'backups', backup.fileName), 'corrupt backup canary');
      const request = (await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(fileCapability), payload: { idempotencyKey: 'privacy-corrupt-backup' },
      })).json();
      const failed = await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm',
        headers: privacyHeaders(fileCapability),
        payload: { deletionId: request.deletionId, confirmationToken: request.confirmationToken },
      });
      expect(failed.statusCode).toBe(409);
      expect(fileDatabase.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
      expect(fileDatabase.raw.prepare('SELECT status FROM privacy_deletion WHERE id = ?').get(request.deletionId))
        .toEqual({ status: 'pending_confirmation' });
    } finally {
      await fileApp.close();
      fileDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('硬删除会补偿清理任务记忆投影，持久 SQLite 重开后不留正文', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-memory-success-'));
    const path = join(root, 'data.sqlite');
    const memoryRoot = join(root, 'task-memory');
    const fileDatabase = new AppDatabase(path, false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path, TASK_MEMORY_ROOT: memoryRoot });
    const fileService = new PmService(fileDatabase, createAdapters(config), config);
    installSyntheticOwner(fileDatabase);
    const fileCapability = createLocalActionCapability();
    const fileApp = await buildApp(fileService, { serveWeb: false, desktopCapability: fileCapability });
    try {
      insertSyntheticGraph(fileDatabase);
      const projection = fileService.projectTaskMemory('task-privacy');
      expect(projection?.state).toBe('ready');
      const memoryDir = join(memoryRoot, projection!.relative_path);
      expect(existsSync(join(memoryDir, 'task.json'))).toBe(true);
      const request = (await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(fileCapability),
        payload: { idempotencyKey: 'privacy-memory-success' },
      })).json();
      const completed = await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(fileCapability),
        payload: { deletionId: request.deletionId, confirmationToken: request.confirmationToken },
      });
      expect(completed.statusCode).toBe(200);
      expect(readdirSync(memoryRoot)).toEqual([]);
      await fileApp.close();
      fileDatabase.close();
      const reopened = new AppDatabase(path, false);
      expect(reopened.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
      reopened.close();
    } finally {
      try { await fileApp.close(); } catch {}
      try { fileDatabase.close(); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('任务记忆未知文件或路径逃逸会 fail-closed，业务行与原文件保持不变', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-memory-fail-closed-'));
    const path = join(root, 'data.sqlite');
    const memoryRoot = join(root, 'task-memory');
    const fileDatabase = new AppDatabase(path, false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path, TASK_MEMORY_ROOT: memoryRoot });
    const fileService = new PmService(fileDatabase, createAdapters(config), config);
    installSyntheticOwner(fileDatabase);
    const fileCapability = createLocalActionCapability();
    const fileApp = await buildApp(fileService, { serveWeb: false, desktopCapability: fileCapability });
    try {
      insertSyntheticGraph(fileDatabase);
      const projection = fileService.projectTaskMemory('task-privacy');
      const memoryDir = join(memoryRoot, projection!.relative_path);
      writeFileSync(join(memoryDir, 'unknown.txt'), 'unknown memory canary');
      const request = (await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(fileCapability),
        payload: { idempotencyKey: 'privacy-memory-unknown' },
      })).json();
      const failed = await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(fileCapability),
        payload: { deletionId: request.deletionId, confirmationToken: request.confirmationToken },
      });
      expect(failed.statusCode).toBe(409);
      expect(fileDatabase.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
      expect(existsSync(join(memoryDir, 'task.json'))).toBe(true);
      expect(existsSync(join(memoryDir, 'unknown.txt'))).toBe(true);
      fileDatabase.raw.prepare('UPDATE memory_projection SET managed_files_json = ? WHERE task_id = ?')
        .run(JSON.stringify(['../../escape.md']), 'task-privacy');
      rmSync(join(memoryDir, 'unknown.txt'));
      const second = (await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(fileCapability),
        payload: { idempotencyKey: 'privacy-memory-escape' },
      })).json();
      const escaped = await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(fileCapability),
        payload: { deletionId: second.deletionId, confirmationToken: second.confirmationToken },
      });
      expect(escaped.statusCode).toBe(409);
      expect(fileDatabase.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
      expect(existsSync(join(memoryDir, 'task.json'))).toBe(true);
    } finally {
      await fileApp.close();
      fileDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('任务记忆托管清单损坏时 fail-closed，不删除业务行或正文投影', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-memory-manifest-'));
    const path = join(root, 'data.sqlite');
    const memoryRoot = join(root, 'task-memory');
    const fileDatabase = new AppDatabase(path, false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path, TASK_MEMORY_ROOT: memoryRoot });
    const fileService = new PmService(fileDatabase, createAdapters(config), config);
    installSyntheticOwner(fileDatabase);
    const fileCapability = createLocalActionCapability();
    const fileApp = await buildApp(fileService, { serveWeb: false, desktopCapability: fileCapability });
    try {
      insertSyntheticGraph(fileDatabase);
      const projection = fileService.projectTaskMemory('task-privacy');
      const memoryDir = join(memoryRoot, projection!.relative_path);
      fileDatabase.raw.prepare('UPDATE memory_projection SET managed_files_json = ? WHERE task_id = ?')
        .run('{malformed-json', 'task-privacy');
      const request = (await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(fileCapability),
        payload: { idempotencyKey: 'privacy-memory-manifest' },
      })).json();
      const failed = await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(fileCapability),
        payload: { deletionId: request.deletionId, confirmationToken: request.confirmationToken },
      });
      expect(failed.statusCode).toBe(409);
      expect(fileDatabase.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
      expect(existsSync(join(memoryDir, 'task.json'))).toBe(true);
      expect(readdirSync(memoryRoot).some((name) => name.startsWith('.privacy-delete-'))).toBe(false);
    } finally {
      await fileApp.close();
      fileDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('删除 API 拒绝缺失或伪造 capability、跨来源请求和过期确认，并允许主人二次确认一次', async () => {
    const missing = await app.inject({
      method: 'POST', url: '/api/privacy/deletion/request',
      payload: { idempotencyKey: 'privacy-auth-missing' },
    });
    expect(missing.statusCode).toBe(401);
    const mismatched = await app.inject({
      method: 'POST', url: '/api/privacy/deletion/request',
      headers: { ...privacyHeaders(capability), 'x-csrf-token': 'wrong-csrf' },
      payload: { idempotencyKey: 'privacy-auth-mismatch' },
    });
    expect(mismatched.statusCode).toBe(403);
    const crossOrigin = await app.inject({
      method: 'POST', url: '/api/privacy/deletion/request',
      headers: { ...privacyHeaders(capability), origin: 'http://evil.invalid' },
      payload: { idempotencyKey: 'privacy-auth-origin' },
    });
    expect(crossOrigin.statusCode).toBe(403);
    const expiredCapability = createLocalActionCapability(-1);
    const expiredApp = await buildApp(service, { serveWeb: false, desktopCapability: expiredCapability });
    try {
      const expired = await expiredApp.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(expiredCapability),
        payload: { idempotencyKey: 'privacy-auth-expired-capability' },
      });
      expect(expired.statusCode).toBe(403);
    } finally {
      await expiredApp.close();
    }
    database.raw.prepare("UPDATE owner_profile SET oauth_status = 'unknown' WHERE id = 'primary'").run();
    const ownerRejected = await app.inject({
      method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability),
      payload: { idempotencyKey: 'privacy-auth-owner-rejected' },
    });
    expect(ownerRejected.statusCode).toBe(403);
    database.raw.prepare("UPDATE owner_profile SET oauth_status = 'mock' WHERE id = 'primary'").run();
    const request = (await app.inject({
      method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability),
      payload: { idempotencyKey: 'privacy-auth-expired-token' },
    })).json();
    database.raw.prepare('UPDATE privacy_deletion SET requested_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', request.deletionId);
    const expiredToken = await app.inject({
      method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(capability),
      payload: { deletionId: request.deletionId, confirmationToken: request.confirmationToken },
    });
    expect(expiredToken.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT status FROM privacy_deletion WHERE id = ?').get(request.deletionId)).toEqual({ status: 'pending_confirmation' });

    const validRequest = (await app.inject({
      method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability),
      payload: { idempotencyKey: 'privacy-auth-valid-once' },
    })).json();
    const firstConfirm = await app.inject({
      method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(capability),
      payload: { deletionId: validRequest.deletionId, confirmationToken: validRequest.confirmationToken },
    });
    expect(firstConfirm.statusCode).toBe(200);
    const replay = await app.inject({
      method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(capability),
      payload: { deletionId: validRequest.deletionId, confirmationToken: validRequest.confirmationToken },
    });
    expect([401, 409]).toContain(replay.statusCode);
  });

  it('错误 token、过期、重放和 stale CAS 在 stop/revoke 前零外部副作用', async () => {
    const internals = service as unknown as {
      stopFeishu: () => Promise<unknown>;
      adapters: { feishu: { revokeAuthorization?: () => Promise<{ localTokensCleared: boolean; providerRevoked: boolean }> } };
    };
    let stopCalls = 0;
    let revokeCalls = 0;
    const originalStop = internals.stopFeishu;
    const originalRevoke = internals.adapters.feishu.revokeAuthorization;
    internals.stopFeishu = async () => { stopCalls += 1; };
    internals.adapters.feishu.revokeAuthorization = async () => {
      revokeCalls += 1;
      return { localTokensCleared: false, providerRevoked: false };
    };
    try {
      const wrongRequest = (await app.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability),
        payload: { idempotencyKey: 'privacy-zero-side-effect-wrong' },
      })).json();
      const wrong = await app.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(capability),
        payload: { deletionId: wrongRequest.deletionId, confirmationToken: 'wrong-token' },
      });
      expect(wrong.statusCode).toBe(409);

      const expiredRequest = (await app.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability),
        payload: { idempotencyKey: 'privacy-zero-side-effect-expired' },
      })).json();
      database.raw.prepare('UPDATE privacy_deletion SET requested_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', expiredRequest.deletionId);
      const expired = await app.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(capability),
        payload: { deletionId: expiredRequest.deletionId, confirmationToken: expiredRequest.confirmationToken },
      });
      expect(expired.statusCode).toBe(409);

      const staleRequest = (await app.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability),
        payload: { idempotencyKey: 'privacy-zero-side-effect-stale' },
      })).json();
      database.raw.prepare('UPDATE privacy_control SET version = version + 1 WHERE singleton_key = 1').run();
      const stale = await app.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(capability),
        payload: { deletionId: staleRequest.deletionId, confirmationToken: staleRequest.confirmationToken },
      });
      expect(stale.statusCode).toBe(409);
      expect(stopCalls).toBe(0);
      expect(revokeCalls).toBe(0);
    } finally {
      internals.stopFeishu = originalStop;
      internals.adapters.feishu.revokeAuthorization = originalRevoke;
    }
  });

  it('并发停止采集只允许一个 durable CAS claim 执行外部停止', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/privacy/status' })).json();
    const internals = service as unknown as { stopFeishu: () => Promise<unknown> };
    let stopCalls = 0;
    const originalStop = internals.stopFeishu;
    internals.stopFeishu = async () => { stopCalls += 1; };
    try {
      const results = await Promise.allSettled([
        service.stopPrivacyCollection(before.version),
        service.stopPrivacyCollection(before.version),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(stopCalls).toBe(1);
    } finally {
      internals.stopFeishu = originalStop;
    }
  });

  it('所有主人敏感路由都在 capability/intent 之前拒绝并不暴露导出内容', async () => {
    insertSyntheticGraph(database);
    const unauthorizedExport = await app.inject({
      method: 'POST', url: '/api/privacy/export',
      payload: { scope: 'all', format: 'json', idempotencyKey: 'privacy-unauthorized-export' },
    });
    expect(unauthorizedExport.statusCode).toBe(401);
    expect(unauthorizedExport.body).not.toContain('source content canary');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM privacy_export').get()).toEqual({ count: 0 });

    const wrongIntent = await app.inject({
      method: 'POST', url: '/api/privacy/collection/stop',
      headers: privacyHeaders(capability, 'privacy.deletion.hard-delete.v1'),
      payload: {},
    });
    expect(wrongIntent.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/privacy/status' })).json()).toMatchObject({ collectionStatus: 'running' });

    const unauthorizedBackup = await app.inject({ method: 'POST', url: '/api/privacy/backup', payload: {} });
    expect(unauthorizedBackup.statusCode).toBe(401);

    const unauthorizedListenerStart = await app.inject({ method: 'POST', url: '/api/integrations/feishu/listener/start' });
    expect(unauthorizedListenerStart.statusCode).toBe(401);
    const unauthorizedListenerStop = await app.inject({ method: 'POST', url: '/api/integrations/feishu/listener/stop' });
    expect(unauthorizedListenerStop.statusCode).toBe(401);
  });

  it('不同有效 capability 不能确认另一 capability 签发的 token', async () => {
    const otherCapability = createLocalActionCapability();
    const otherApp = await buildApp(service, { serveWeb: false, desktopCapability: otherCapability });
    const internals = service as unknown as { stopFeishu: () => Promise<unknown> };
    let stopCalls = 0;
    const originalStop = internals.stopFeishu;
    internals.stopFeishu = async () => { stopCalls += 1; };
    try {
      const requested = (await app.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability),
        payload: { idempotencyKey: 'privacy-capability-binding' },
      })).json();
      const rejected = await otherApp.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(otherCapability),
        payload: { deletionId: requested.deletionId, confirmationToken: requested.confirmationToken },
      });
      expect(rejected.statusCode).toBe(409);
      expect(database.raw.prepare('SELECT status FROM privacy_deletion WHERE id = ?').get(requested.deletionId))
        .toEqual({ status: 'pending_confirmation' });
      expect(stopCalls).toBe(0);
    } finally {
      internals.stopFeishu = originalStop;
      await otherApp.close();
    }
  });

  it('SQLite commit fault rolls back business rows and staged files without external residue', async () => {
    let armed = false;
    let armedCommits = 0;
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-commit-fault-'));
    const path = join(root, 'data.sqlite');
    const faultDatabase = new AppDatabase(path, false, {
      transactionFaults: {
        beforeCommit: () => {
          if (!armed) return;
          armedCommits += 1;
          if (armedCommits === 2) {
            armed = false;
            throw new Error('synthetic privacy commit failure');
          }
        },
      },
    });
    const faultConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path, TASK_MEMORY_ROOT: join(root, 'task-memory') });
    const faultService = new PmService(faultDatabase, createAdapters(faultConfig), faultConfig);
    installSyntheticOwner(faultDatabase);
    const faultCapability = createLocalActionCapability();
    const faultApp = await buildApp(faultService, { serveWeb: false, desktopCapability: faultCapability });
    try {
      insertSyntheticGraph(faultDatabase);
      const projection = faultService.projectTaskMemory('task-privacy');
      const memoryDir = join(root, 'task-memory', projection!.relative_path);
      const requested = (await faultApp.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(faultCapability),
        payload: { idempotencyKey: 'privacy-commit-fault' },
      })).json();
      armed = true;
      const failed = await faultApp.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(faultCapability),
        payload: { deletionId: requested.deletionId, confirmationToken: requested.confirmationToken },
      });
      expect(failed.statusCode).toBe(409);
      expect(faultDatabase.raw.prepare("SELECT COUNT(*) AS count FROM source_event WHERE id = 'source-privacy'").get()).toEqual({ count: 1 });
      expect(faultDatabase.raw.prepare('SELECT status FROM privacy_deletion WHERE id = ?').get(requested.deletionId))
        .toEqual({ status: 'pending_confirmation' });
      expect(existsSync(join(memoryDir, 'task.json'))).toBe(true);
    } finally {
      await faultApp.close();
      faultDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('partial finalize becomes durable cleanup recovery instead of silently deleting state', async () => {
    insertSyntheticGraph(database);
    const internals = service as unknown as {
      stagePrivacyTaskMemoryPurge: () => PrivacyTestPurgeStage;
    };
    const originalStage = internals.stagePrivacyTaskMemoryPurge;
    internals.stagePrivacyTaskMemoryPurge = () => ({
      count: 1,
      proofHash: 'a'.repeat(64),
      finalize: () => { throw new Error('synthetic partial finalize failure'); },
      rollback: () => {},
    });
    try {
      const requested = (await app.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability),
        payload: { idempotencyKey: 'privacy-partial-finalize' },
      })).json();
      const failed = await app.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(capability),
        payload: { deletionId: requested.deletionId, confirmationToken: requested.confirmationToken },
      });
      expect(failed.statusCode).toBe(409);
      expect(database.raw.prepare('SELECT status, error_code, deleted_record_count FROM privacy_deletion WHERE id = ?').get(requested.deletionId))
        .toEqual({ status: 'failed', error_code: 'PRIVACY_DELETE_CLEANUP_PENDING', deleted_record_count: expect.any(Number) });
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
    } finally {
      internals.stagePrivacyTaskMemoryPurge = originalStage;
    }
  });

  it('rollback failure is explicit and leaves a durable recovery marker', async () => {
    let armed = false;
    let armedCommits = 0;
    const faultDatabase = new AppDatabase(':memory:', false, {
      transactionFaults: {
        beforeCommit: () => {
          if (!armed) return;
          armedCommits += 1;
          if (armedCommits === 2) {
            armed = false;
            throw new Error('synthetic privacy commit failure');
          }
        },
      },
    });
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-rollback-fault-'));
    const faultConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', TASK_MEMORY_ROOT: root });
    const faultService = new PmService(faultDatabase, createAdapters(faultConfig), faultConfig);
    installSyntheticOwner(faultDatabase);
    const faultCapability = createLocalActionCapability();
    const faultApp = await buildApp(faultService, { serveWeb: false, desktopCapability: faultCapability });
    const internals = faultService as unknown as {
      stagePrivacyTaskMemoryPurge: () => PrivacyTestPurgeStage;
    };
    const originalStage = internals.stagePrivacyTaskMemoryPurge;
    internals.stagePrivacyTaskMemoryPurge = () => ({
      count: 0,
      proofHash: 'b'.repeat(64),
      finalize: () => {},
      rollback: () => { throw new Error('synthetic rollback failure'); },
    });
    try {
      insertSyntheticGraph(faultDatabase);
      const requested = (await faultApp.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(faultCapability),
        payload: { idempotencyKey: 'privacy-rollback-fault' },
      })).json();
      armed = true;
      const failed = await faultApp.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(faultCapability),
        payload: { deletionId: requested.deletionId, confirmationToken: requested.confirmationToken },
      });
      expect(failed.statusCode).toBe(409);
      expect(faultDatabase.raw.prepare('SELECT status, error_code FROM privacy_deletion WHERE id = ?').get(requested.deletionId))
        .toEqual({ status: 'failed', error_code: 'PRIVACY_DELETE_RECOVERY_REQUIRED' });
      expect(faultDatabase.raw.prepare("SELECT COUNT(*) AS count FROM source_event WHERE id = 'source-privacy'").get()).toEqual({ count: 1 });
    } finally {
      internals.stagePrivacyTaskMemoryPurge = originalStage;
      await faultApp.close();
      faultDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('二次确认凭证绑定主人身份与删除意图，主人身份变化时拒绝确认', async () => {
    const request = (await app.inject({
      method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability),
      payload: { idempotencyKey: 'privacy-auth-owner-binding' },
    })).json();
    database.raw.prepare("UPDATE owner_profile SET open_id = 'different-owner' WHERE id = 'primary'").run();
    const rejected = await app.inject({
      method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(capability),
      payload: { deletionId: request.deletionId, confirmationToken: request.confirmationToken },
    });
    expect(rejected.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT status FROM privacy_deletion WHERE id = ?').get(request.deletionId))
      .toEqual({ status: 'pending_confirmation' });
  });

  it('确认阶段校验持久化 capability/intent 绑定而非只信任内存 singleton', async () => {
    const request = (await app.inject({
      method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(capability),
      payload: { idempotencyKey: 'privacy-persisted-binding' },
    })).json();
    database.raw.prepare('UPDATE privacy_deletion SET capability_token_hash = ? WHERE id = ?')
      .run('0'.repeat(64), request.deletionId);
    const rejected = await app.inject({
      method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(capability),
      payload: { deletionId: request.deletionId, confirmationToken: request.confirmationToken },
    });
    expect(rejected.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT status FROM privacy_deletion WHERE id = ?').get(request.deletionId))
      .toEqual({ status: 'pending_confirmation' });
  });

  it('数据库交易失败时任务记忆暂存可回滚并保留原文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-memory-rollback-'));
    const path = join(root, 'data.sqlite');
    const memoryRoot = join(root, 'task-memory');
    const fileDatabase = new AppDatabase(path, false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path, TASK_MEMORY_ROOT: memoryRoot });
    const fileService = new PmService(fileDatabase, createAdapters(config), config);
    installSyntheticOwner(fileDatabase);
    const fileCapability = createLocalActionCapability();
    const fileApp = await buildApp(fileService, { serveWeb: false, desktopCapability: fileCapability });
    try {
      insertSyntheticGraph(fileDatabase);
      const projection = fileService.projectTaskMemory('task-privacy');
      const memoryDir = join(memoryRoot, projection!.relative_path);
      fileDatabase.raw.exec('CREATE TABLE synthetic_unknown_privacy_table (id TEXT PRIMARY KEY);');
      const request = (await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/request', headers: privacyHeaders(fileCapability),
        payload: { idempotencyKey: 'privacy-memory-rollback' },
      })).json();
      const failed = await fileApp.inject({
        method: 'POST', url: '/api/privacy/deletion/confirm', headers: privacyHeaders(fileCapability),
        payload: { deletionId: request.deletionId, confirmationToken: request.confirmationToken },
      });
      expect(failed.statusCode).toBe(409);
      expect(fileDatabase.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
      expect(existsSync(join(memoryDir, 'task.json'))).toBe(true);
      expect(readdirSync(memoryRoot).some((name) => name.startsWith('.privacy-delete-'))).toBe(false);
    } finally {
      await fileApp.close();
      fileDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('恢复入口只登记已验证备份、需要重启并写入一次 backup_restored 审计', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-restore-'));
    const path = join(root, 'data.sqlite');
    const fileDatabase = new AppDatabase(path, false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path });
    const fileService = new PmService(fileDatabase, createAdapters(config), config);
    installSyntheticOwner(fileDatabase);
    const fileCapability = createLocalActionCapability();
    const fileApp = await buildApp(fileService, { serveWeb: false, desktopCapability: fileCapability });
    try {
      const backup = await fileApp.inject({ method: 'POST', url: '/api/privacy/backup', headers: ownerPrivacyHeaders(fileCapability) });
      expect(backup.statusCode).toBe(200);
      const created = backup.json();
      const status = (await fileApp.inject({ method: 'GET', url: '/api/privacy/status' })).json();
      fileDatabase.raw.prepare('UPDATE privacy_control SET version = version + 1 WHERE singleton_key = 1').run();
      const stale = await fileApp.inject({
        method: 'POST',
        url: '/api/privacy/backup/restore',
        headers: ownerPrivacyHeaders(fileCapability),
        payload: { fileName: created.fileName, expectedVersion: status.version },
      });
      expect(stale.statusCode).toBe(409);
      expect(fileDatabase.raw.prepare('SELECT status, restored_at FROM privacy_backup WHERE backup_file = ?').get(created.fileName))
        .toEqual({ status: 'created', restored_at: null });
      expect(fileDatabase.raw.prepare("SELECT COUNT(*) AS count FROM privacy_audit_event WHERE event_type = 'backup_restored'").get())
        .toEqual({ count: 0 });
      const currentStatus = (await fileApp.inject({ method: 'GET', url: '/api/privacy/status' })).json();
      const restored = await fileApp.inject({
        method: 'POST',
        url: '/api/privacy/backup/restore',
        headers: ownerPrivacyHeaders(fileCapability),
        payload: { fileName: created.fileName, expectedVersion: currentStatus.version },
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ status: 'restored', requiresRestart: true, replacementApplied: false });
      expect(fileDatabase.raw.prepare('SELECT status, restored_at FROM privacy_backup WHERE backup_file = ?').get(created.fileName))
        .toMatchObject({ status: 'restored', restored_at: expect.any(String) });
      expect(fileDatabase.raw.prepare("SELECT COUNT(*) AS count FROM privacy_audit_event WHERE event_type = 'backup_restored'").get())
        .toEqual({ count: 1 });
      const repeated = await fileApp.inject({ method: 'POST', url: '/api/privacy/backup/restore', headers: ownerPrivacyHeaders(fileCapability), payload: { fileName: created.fileName } });
      expect(repeated.statusCode).toBe(200);
      expect(fileDatabase.raw.prepare("SELECT COUNT(*) AS count FROM privacy_audit_event WHERE event_type = 'backup_restored'").get())
        .toEqual({ count: 1 });
    } finally {
      await fileApp.close();
      fileDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('留存执行器按 source/derived/diagnostics 策略删除到期行并保留隐私证明', async () => {
    insertSyntheticGraph(database);
    database.raw.prepare(`UPDATE source_event SET captured_at = '2020-01-01T00:00:00.000Z'`).run();
    database.raw.prepare(`UPDATE source_context SET created_at = '2020-01-01T00:00:00.000Z'`).run();
    database.raw.prepare(`UPDATE source_demand_unit SET created_at = '2020-01-01T00:00:00.000Z'`).run();
    database.raw.prepare(`UPDATE candidate_request SET updated_at = '2020-01-01T00:00:00.000Z'`).run();
    database.raw.prepare(`UPDATE app_log SET created_at = '2020-01-01T00:00:00.000Z'`).run();
    const initial = (await app.inject({ method: 'GET', url: '/api/privacy/status' })).json();
    database.raw.prepare('UPDATE privacy_control SET version = version + 1 WHERE singleton_key = 1').run();
    const staleRun = await app.inject({
      method: 'POST',
      url: '/api/privacy/retention/run',
      headers: ownerPrivacyHeaders(capability),
      payload: { expectedVersion: initial.version },
    });
    expect(staleRun.statusCode).toBe(409);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(1);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number }).count).toBe(1);
    const current = (await app.inject({ method: 'GET', url: '/api/privacy/status' })).json();
    const policy = await app.inject({
      method: 'PATCH',
      url: '/api/privacy/retention',
      headers: ownerPrivacyHeaders(capability),
      payload: { expectedVersion: current.version, sourceDays: 1, derivedDays: 1, diagnosticsDays: 1, backupCount: 3 },
    });
    expect(policy.statusCode).toBe(200);
    const run = await app.inject({
      method: 'POST',
      url: '/api/privacy/retention/run',
      headers: ownerPrivacyHeaders(capability),
      payload: { expectedVersion: policy.json().version },
    });
    expect(run.statusCode).toBe(200);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(0);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number }).count).toBe(0);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM privacy_audit_event').get() as { count: number }).count).toBe(0);
    expect(run.json().retentionRun.counts.source).toBeGreaterThan(0);
    expect(run.json().retentionRun.counts.derived).toBeGreaterThan(0);
  });

  it('停止采集的审计写入失败时逐值保留原状态且不留下错误成功状态', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/privacy/status' })).json();
    const sourceBefore = database.raw.prepare('SELECT source_kind, enabled, status FROM information_source_state ORDER BY source_kind').all();
    database.raw.exec('DROP TABLE privacy_audit_event');
    const failed = await app.inject({ method: 'POST', url: '/api/privacy/collection/stop', headers: ownerPrivacyHeaders(capability), payload: {} });
    expect(failed.statusCode).toBe(409);
    expect(await app.inject({ method: 'GET', url: '/api/privacy/status' })).toMatchObject({ statusCode: 200 });
    expect((await app.inject({ method: 'GET', url: '/api/privacy/status' })).json()).toMatchObject({ collectionStatus: before.collectionStatus, version: before.version + 2 });
    expect(database.raw.prepare('SELECT status FROM privacy_lifecycle_claim ORDER BY created_at DESC LIMIT 1').get()).toEqual({ status: 'compensated' });
    expect(database.raw.prepare('SELECT source_kind, enabled, status FROM information_source_state ORDER BY source_kind').all()).toEqual(sourceBefore);
  });

  it('备份元数据或审计写入失败时清理新文件，不留下孤立受管备份', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-backup-orphan-'));
    const path = join(root, 'data.sqlite');
    const fileDatabase = new AppDatabase(path, false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path });
    const fileService = new PmService(fileDatabase, createAdapters(config), config);
    installSyntheticOwner(fileDatabase);
    const fileCapability = createLocalActionCapability();
    const fileApp = await buildApp(fileService, { serveWeb: false, desktopCapability: fileCapability });
    try {
      fileDatabase.raw.exec('DROP TABLE privacy_audit_event');
      const failed = await fileApp.inject({ method: 'POST', url: '/api/privacy/backup', headers: ownerPrivacyHeaders(fileCapability) });
      expect(failed.statusCode).toBe(409);
      expect(readdirSync(join(root, 'backups')).filter((name) => name.endsWith('.sqlite'))).toEqual([]);
      expect(fileDatabase.raw.prepare('SELECT COUNT(*) AS count FROM privacy_backup').get()).toEqual({ count: 0 });
    } finally {
      await fileApp.close();
      fileDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('备份元数据事务失败且 discard 失败时写入可枚举待清理标记，不冒充有效备份', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-backup-pending-'));
    const path = join(root, 'data.sqlite');
    let failCommit = false;
    const fileDatabase = new AppDatabase(path, false, {
      transactionFaults: { beforeCommit: () => { if (failCommit) { failCommit = false; throw new Error('synthetic backup metadata transaction failure'); } } },
      privacyBackupFaults: { beforeDiscard: () => { throw new Error('synthetic backup discard failure'); } },
    });
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path });
    const fileService = new PmService(fileDatabase, createAdapters(config), config);
    installSyntheticOwner(fileDatabase);
    const fileCapability = createLocalActionCapability();
    const fileApp = await buildApp(fileService, { serveWeb: false, desktopCapability: fileCapability });
    failCommit = true;
    try {
      const failed = await fileApp.inject({ method: 'POST', url: '/api/privacy/backup', headers: ownerPrivacyHeaders(fileCapability) });
      expect(failed.statusCode).toBe(409);
      const entries = readdirSync(join(root, 'backups'));
      const sqlite = entries.filter((name) => name.endsWith('.sqlite'));
      const markers = entries.filter((name) => name.endsWith('.sqlite.pending-cleanup.json'));
      expect(sqlite).toHaveLength(1);
      expect(markers).toHaveLength(1);
      const marker = JSON.parse(readFileSync(join(root, 'backups', markers[0]!), 'utf8')) as { fileName: string; kind: string };
      expect(marker.kind).toBe('privacy-backup-pending-cleanup');
      expect(marker.fileName).toBe(sqlite[0]);
      expect(fileDatabase.raw.prepare('SELECT COUNT(*) AS count FROM privacy_backup').get()).toEqual({ count: 0 });
      const verify = await fileApp.inject({ method: 'POST', url: '/api/privacy/backup/verify', headers: ownerPrivacyHeaders(fileCapability), payload: { fileName: sqlite[0] } });
      expect(verify.statusCode).toBe(409);

      const purge = fileDatabase.stagePrivacyBackupPurge();
      purge.finalize();
      expect(readdirSync(join(root, 'backups')).filter((name) => name.endsWith('.sqlite') || name.endsWith('.pending-cleanup.json'))).toEqual([]);
    } finally {
      await fileApp.close();
      fileDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('双进程 lifecycle fencing 阻止 active claim 绕过并在过期接管后拒绝旧 actor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-fencing-process-'));
    const path = join(root, 'data.sqlite');
    const first = new AppDatabase(path, false);
    const second = new AppDatabase(path, false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: path });
    const firstService = new PmService(first, createAdapters(config), config);
    const secondService = new PmService(second, createAdapters(config), config);
    installSyntheticOwner(first);
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const internals = firstService as unknown as { stopFeishu: () => Promise<void> };
    const originalStop = internals.stopFeishu;
    internals.stopFeishu = async () => {
      enteredResolve();
      await release;
    };
    try {
      const oldActor = firstService.stopPrivacyCollection(1);
      await entered;
      await expect(secondService.startPrivacyCollection(2)).rejects.toThrow(/durable claim/u);
      first.raw.prepare(
        `UPDATE privacy_lifecycle_claim
         SET expires_at = ?, heartbeat_at = ?
         WHERE operation_type = 'collection_stop' AND status = 'claimed'`,
      ).run(new Date(Date.now() - 2_000).toISOString(), new Date(Date.now() - 3_000).toISOString());
      first.raw.prepare(
        `UPDATE privacy_lifecycle_claim SET created_at = ?
         WHERE operation_type = 'collection_stop' AND status = 'claimed'`,
      ).run(new Date(Date.now() - 4_000).toISOString());
      const newActor = await secondService.startPrivacyCollection(2);
      expect(newActor).toMatchObject({ collectionStatus: 'running', version: 3 });
      releaseResolve();
      await expect(oldActor).rejects.toThrow(/旧停止操作不再写入|claim 已被其他进程推进/u);
      expect(second.raw.prepare('SELECT collection_status, version FROM privacy_control WHERE singleton_key = 1').get())
        .toEqual({ collection_status: 'running', version: 3 });
      expect(first.raw.prepare('SELECT status, recovery_code FROM privacy_lifecycle_claim WHERE operation_type = \'collection_stop\'').get())
        .toMatchObject({ status: 'expired', recovery_code: 'PRIVACY_LIFECYCLE_EXPIRED_RECLAIMED' });
    } finally {
      internals.stopFeishu = originalStop;
      first.close();
      second.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('backup manifest 删除成功而 sqlite 删除失败时保留 durable cleanup intent 并可恢复', () => {
    const root = mkdtempSync(join(tmpdir(), 'issue34-privacy-backup-fencing-'));
    const path = join(root, 'data.sqlite');
    const fileDatabase = new AppDatabase(path, false, {
      privacyBackupFaults: {
        beforeFinalizeSqliteRemove: () => { throw new Error('synthetic sqlite finalize failure'); },
      },
    });
    try {
      const backup = fileDatabase.createPrivacyBackup();
      const purge = fileDatabase.stagePrivacyBackupPurge();
      expect(purge.count).toBe(1);
      expect(() => purge.finalize()).toThrow('synthetic sqlite finalize failure');
      const intent = fileDatabase.raw.prepare(
        `SELECT status, sha256, staged_backup_file, staged_manifest_file
         FROM privacy_backup_cleanup_intent WHERE backup_file = ?`,
      ).get(backup.fileName) as { status: string; sha256: string; staged_backup_file: string; staged_manifest_file: string | null };
      expect(intent).toMatchObject({ status: 'manifest_removed', sha256: backup.sha256 });
      expect(intent.staged_backup_file).toMatch(/\.privacy-delete-[a-f0-9]+\.tmp$/u);
      expect(existsSync(join(root, 'backups', `${backup.fileName}.manifest.json`))).toBe(false);
      expect(existsSync(join(root, 'backups', intent.staged_backup_file))).toBe(true);
      expect(fileDatabase.recoverPrivacyBackupCleanup(backup.fileName)).toMatchObject({ status: 'completed', recovered: true });
      expect(existsSync(join(root, 'backups', intent.staged_backup_file))).toBe(false);
      expect(fileDatabase.raw.prepare('SELECT status FROM privacy_backup_cleanup_intent WHERE backup_file = ?').get(backup.fileName))
        .toEqual({ status: 'completed' });
    } finally {
      fileDatabase.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('claim lease expiry is reclaimable, while malformed and rolled-back clocks fail closed', () => {
    const tokenHash = createHash('sha256').update('synthetic-claim-token').digest('hex');
    const csrfHash = createHash('sha256').update('synthetic-claim-csrf').digest('hex');
    const insertClaim = (createdAt: string, heartbeatAt: string, expiresAt: string) => {
      database.raw.prepare(
        `INSERT INTO privacy_lifecycle_claim
         (operation_id, operation_token, operation_type, owner_open_id,
          capability_token_hash, capability_csrf_hash, capability_origin, intent,
          expected_version, claimed_version, status, expires_at, heartbeat_at,
          snapshot_json, created_at, updated_at)
         VALUES (?, ?, 'collection_stop', 'synthetic-owner', ?, ?, 'app://local', ?, 1, 2, 'claimed', ?, ?, '{}', ?, ?)`
      ).run(`claim-${createdAt}-${heartbeatAt}`, `${'a'.repeat(32)}${createdAt.slice(-4)}${heartbeatAt.slice(-4)}`, tokenHash, csrfHash, PRIVACY_OWNER_ACTION_INTENT, expiresAt, heartbeatAt, createdAt, createdAt);
    };

    const pastCreated = new Date(Date.now() - 5_000).toISOString();
    const pastHeartbeat = new Date(Date.now() - 4_000).toISOString();
    const pastExpiry = new Date(Date.now() - 3_000).toISOString();
    insertClaim(pastCreated, pastHeartbeat, pastExpiry);
    expect(() => service.updatePrivacyRetention({ sourceDays: 2 })).not.toThrow();
    expect(database.raw.prepare('SELECT status, recovery_code FROM privacy_lifecycle_claim').get())
      .toEqual({ status: 'expired', recovery_code: 'PRIVACY_LIFECYCLE_EXPIRED_RECLAIMED' });

    const malformedCreated = new Date(Date.now() - 5_000).toISOString();
    insertClaim(malformedCreated, 'not-a-timestamp', new Date(Date.now() + 60_000).toISOString());
    expect(() => service.updatePrivacyRetention({ sourceDays: 3 })).toThrow(/时间戳格式无效/u);
    database.raw.prepare('DELETE FROM privacy_lifecycle_claim').run();

    const future = new Date(Date.now() + 60_000).toISOString();
    insertClaim(future, future, new Date(Date.now() + 120_000).toISOString());
    expect(() => service.updatePrivacyRetention({ sourceDays: 4 })).toThrow(/时钟回拨/u);
  });

  it('active durable claim blocks retention/update mutations before any write', () => {
    const tokenHash = createHash('sha256').update('synthetic-active-token').digest('hex');
    const csrfHash = createHash('sha256').update('synthetic-active-csrf').digest('hex');
    const timestamp = new Date(Date.now() - 1_000).toISOString();
    database.raw.prepare(
      `INSERT INTO privacy_lifecycle_claim
       (operation_id, operation_token, operation_type, owner_open_id,
        capability_token_hash, capability_csrf_hash, capability_origin, intent,
        expected_version, claimed_version, status, expires_at, heartbeat_at,
        snapshot_json, created_at, updated_at)
       VALUES ('claim-active-update', ?, 'hard_delete', 'synthetic-owner', ?, ?, 'app://local', ?, 1, 2, 'claimed', ?, ?, '{}', ?, ?)`
    ).run(`${'b'.repeat(32)}`, tokenHash, csrfHash, PRIVACY_DELETION_INTENT, new Date(Date.now() + 60_000).toISOString(), timestamp, timestamp, timestamp);
    const before = database.raw.prepare('SELECT version FROM privacy_control WHERE singleton_key = 1').get() as { version: number };
    const policyBefore = database.raw.prepare('SELECT source_days FROM privacy_retention_policy WHERE singleton_key = 1').get() as { source_days: number };
    expect(() => service.updatePrivacyRetention({ sourceDays: 2 })).toThrow(/durable claim/u);
    expect(database.raw.prepare('SELECT version FROM privacy_control WHERE singleton_key = 1').get()).toEqual(before);
    expect(database.raw.prepare('SELECT source_days FROM privacy_retention_policy WHERE singleton_key = 1').get()).toEqual(policyBefore);
  });

  it('新 actor 接管过期 claim 时持久化完整父身份与 reclaim 代际', () => {
    const tokenHash = createHash('sha256').update('synthetic-reclaim-token').digest('hex');
    const csrfHash = createHash('sha256').update('synthetic-reclaim-csrf').digest('hex');
    const createdAt = new Date(Date.now() - 5_000).toISOString();
    const heartbeatAt = new Date(Date.now() - 4_000).toISOString();
    const expiresAt = new Date(Date.now() - 3_000).toISOString();
    const parentToken = `${'p'.repeat(32)}`;
    database.raw.prepare(
      `INSERT INTO privacy_lifecycle_claim
       (operation_id, operation_token, operation_type, owner_open_id,
        capability_token_hash, capability_csrf_hash, capability_origin, intent,
        expected_version, claimed_version, status, expires_at, heartbeat_at,
        snapshot_json, created_at, updated_at)
       VALUES ('claim-reclaim-parent', ?, 'collection_stop', 'synthetic-owner', ?, ?, 'app://local', ?, 1, 2, 'claimed', ?, ?, '{}', ?, ?)`,
    ).run(parentToken, tokenHash, csrfHash, PRIVACY_OWNER_ACTION_INTENT, expiresAt, heartbeatAt, createdAt, createdAt);
    database.raw.prepare('UPDATE privacy_control SET version = 2 WHERE singleton_key = 1').run();
    const stopped = service.stopPrivacyCollection(2);
    return expect(stopped).resolves.toMatchObject({ collectionStatus: 'stopped', version: 3 }).then(() => {
      const child = database.raw.prepare(
        `SELECT reclaimed_from_operation_id, reclaimed_from_operation_token,
                reclaimed_from_expected_version, reclaimed_from_claimed_version,
                reclaim_count, status
         FROM privacy_lifecycle_claim
         WHERE operation_type = 'collection_stop' AND status = 'committed'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ).get() as Record<string, unknown>;
      expect(child).toMatchObject({
        reclaimed_from_operation_id: 'claim-reclaim-parent',
        reclaimed_from_operation_token: parentToken,
        reclaimed_from_expected_version: 1,
        reclaimed_from_claimed_version: 2,
        reclaim_count: 1,
        status: 'committed',
      });
    });
  });
});
