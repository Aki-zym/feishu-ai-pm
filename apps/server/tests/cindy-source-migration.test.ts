import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { deriveCindyAuthContext, saveCindySources } from '../src/cindy-source.js';
import { loadConfig } from '../src/config.js';
import {
  AppDatabase,
  CINDY_CANDIDATE_APPEND_MIGRATION_DESCRIPTOR,
  CINDY_GROUPED_BATCH_MIGRATION_DESCRIPTOR,
  CINDY_OWNER_CONTEXT_MIGRATION_DESCRIPTOR,
  CINDY_TRUSTED_SOURCE_MIGRATION_DESCRIPTOR,
  CURRENT_SCHEMA_VERSION,
  DatabaseUpgradeError,
  type MigrationDescriptor,
} from '../src/database.js';
import { createCindyAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

const migrationAccountAnchorMaterial = 'migration-test-account-anchor';
const migrationReceiptSecret = 'migration-test-receipt-secret-0123456789abcdef0123456789abcdef';
const migrationAuth = deriveCindyAuthContext({
  accountAnchor: migrationAccountAnchorMaterial,
  receiptSecret: migrationReceiptSecret,
});

function seedLegacyV8Source(database: AppDatabase) {
  const timestamp = '2026-08-24T00:01:00.000Z';
  const sourceId = 'legacy-source';
  const revisionId = 'legacy-source-revision';
  const metadata = JSON.stringify({
    provider: 'synthetic',
    sourceKind: 'synthetic_message',
    stableMessageId: 'legacy-message-1',
  });
  database.raw.prepare(
    `INSERT INTO source_event
      (id, external_id, source_type, conversation_id, sender_id, sender_name, content, owner_mentioned,
       source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at,
       owner_scope, revision_generation, current_revision_id)
     VALUES (?, ?, 'manual', 'legacy-conversation', 'legacy-sender', '旧来源', '旧来源正文。', 0,
             NULL, 'complete', 'v8 migration fixture', ?, ?, ?, 'primary', 1, ?)`,
  ).run(sourceId, 'legacy-external-id', metadata, timestamp, timestamp, revisionId);
  database.raw.prepare(
    `INSERT INTO source_event_revision
      (id, source_event_id, revision_number, revision_kind, external_id, source_type, conversation_id,
       sender_id, sender_name, content, owner_mentioned, source_url, completeness, discovery_reason,
       metadata_json, occurred_at, captured_at, owner_scope, revision_hash, created_at)
     VALUES (?, ?, 1, 'migration', ?, 'manual', 'legacy-conversation', 'legacy-sender', '旧来源',
             '旧来源正文。', 0, NULL, 'complete', 'v8 migration fixture', ?, ?, ?, 'primary', ?, ?)`,
  ).run(revisionId, sourceId, 'legacy-external-id', metadata, timestamp, timestamp, 'a'.repeat(64), timestamp);
  return { sourceId, revisionId };
}

async function buildAppFromDisk(
  path: string,
  migrationDescriptorForTest: MigrationDescriptor,
) {
  const database = new AppDatabase(path, false, { migrationDescriptorForTest });
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: `file:${path}` });
  const service = new PmService(database, createCindyAdapters(config), config);
  return buildApp(service, { serveWeb: false });
}

async function buildCurrentCindyApp(path: string) {
  const database = new AppDatabase(path, false);
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: `file:${path}` });
  const app = await buildApp(new PmService(database, createCindyAdapters(config), config), {
    serveWeb: false,
    cindyIntegrationToken: migrationToken,
    cindyIntegrationAccountAnchor: migrationAccountAnchorMaterial,
    cindyReceiptSecret: migrationReceiptSecret,
  });
  return { app, database };
}

describe('Cindy trusted source migrations', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('旧 v8 source_event 前向迁移为 legacy_read_only，重新读取稳定身份才签发新 receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-source-v9-'));
    roots.push(root);
    const path = join(root, 'pm.sqlite');
    const oldDatabase = new AppDatabase(path, false, { targetSchemaVersionForTest: 8 });
    const legacy = seedLegacyV8Source(oldDatabase);
    oldDatabase.close();

    const database = new AppDatabase(path, false);
    expect((database.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(database.raw.prepare('SELECT ingest_state FROM source_event WHERE id = ?').get(legacy.sourceId)).toEqual({ ingest_state: 'legacy_read_only' });
    expect(database.raw.prepare('SELECT processing_status, receipt_digest FROM source_event_revision WHERE id = ?').get(legacy.revisionId))
      .toEqual({ processing_status: 'legacy_read_only', receipt_digest: null });
    expect(database.raw.prepare('SELECT state, current_revision_id FROM cindy_source_identity WHERE source_event_id = ?').get(legacy.sourceId))
      .toEqual({ state: 'legacy_read_only', current_revision_id: legacy.revisionId });

    const result = saveCindySources(database, migrationAuth, {
      save_request_id: 'save-legacy-reread',
      sources: [{
        client_ref: 'legacy',
        provider: 'synthetic',
        source_kind: 'synthetic_message',
        stable_message_id: 'legacy-message-1',
        occurred_at: '2026-08-24T00:01:00.000Z',
        sender_id: 'synthetic-requester-1',
        display_name: '旧需求方',
        chat_id: 'synthetic-chat-1',
        mentioned_owner: true,
        sender_is_owner: false,
        message_type: 'text',
        text: '重新读取后的可信来源。',
        revision: { sequence: 1 },
      }],
    });
    expect(result.sources[0]).toMatchObject({ source_status: 'pending_decision', revision: { generation: 2 } });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE id = ?').get(legacy.sourceId)).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT ingest_state, revision_generation FROM source_event WHERE id = ?').get(legacy.sourceId))
      .toEqual({ ingest_state: 'trusted_current', revision_generation: 2 });
    database.close();
  });

  it('v8→v9 migration 失败会阻止 AppDatabase/buildApp 启动、恢复完整 v8，修复后可完整迁移', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-source-v9-failure-'));
    roots.push(root);
    const path = join(root, 'pm.sqlite');
    const oldDatabase = new AppDatabase(path, false, { targetSchemaVersionForTest: 8 });
    const legacy = seedLegacyV8Source(oldDatabase);
    oldDatabase.close();

    const [schemaOperation, ...remainingOperations] = CINDY_TRUSTED_SOURCE_MIGRATION_DESCRIPTOR.orderedOperations;
    if (schemaOperation?.kind !== 'sql_batch') throw new Error('v9 migration fixture expects sql_batch first');
    const failingDescriptor = {
      ...CINDY_TRUSTED_SOURCE_MIGRATION_DESCRIPTOR,
      orderedOperations: [
        { ...schemaOperation, statements: [...schemaOperation.statements, 'INSERT INTO missing_v9_fault_table(value) VALUES (1);'] },
        ...remainingOperations,
      ],
    };
    expect(() => {
      new AppDatabase(path, false, { migrationDescriptorForTest: failingDescriptor });
    }).toThrow(DatabaseUpgradeError);
    await expect(buildAppFromDisk(path, failingDescriptor)).rejects.toThrow(DatabaseUpgradeError);

    const raw = new DatabaseSync(path);
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(8);
    expect(raw.prepare('SELECT id, current_revision_id FROM source_event WHERE id = ?').get(legacy.sourceId))
      .toEqual({ id: legacy.sourceId, current_revision_id: legacy.revisionId });
    expect(raw.prepare("SELECT name FROM pragma_table_info('source_event_revision') WHERE name = 'processing_status'").get()).toBeUndefined();
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cindy_source_identity'").get()).toBeUndefined();
    raw.close();

    const recovered = new AppDatabase(path, false);
    expect((recovered.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(recovered.raw.prepare('SELECT ingest_state FROM source_event WHERE id = ?').get(legacy.sourceId))
      .toEqual({ ingest_state: 'legacy_read_only' });
    expect(recovered.raw.prepare('SELECT processing_status FROM source_event_revision WHERE id = ?').get(legacy.revisionId))
      .toEqual({ processing_status: 'legacy_read_only' });
    expect(recovered.raw.prepare('SELECT state FROM cindy_source_identity WHERE source_event_id = ?').get(legacy.sourceId))
      .toEqual({ state: 'legacy_read_only' });
    recovered.close();
  });

  it('v9→v10 context migration 失败会阻止启动、保持完整 v9，修复后原子迁移', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-source-v10-failure-'));
    roots.push(root);
    const path = join(root, 'pm.sqlite');
    const v9 = new AppDatabase(path, false, { targetSchemaVersionForTest: 9 });
    const timestamp = '2026-08-24T00:02:00.000Z';
    v9.raw.prepare(
      `INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content, owner_mentioned,
         source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at, owner_scope,
         revision_generation, current_revision_id, ingest_state)
       VALUES ('v9-source', 'v9-external', 'manual', 'v9-chat-ref', 'v9-sender-ref', '迁移需求方', 'v9 来源。', 1,
               NULL, 'complete', 'v9 fixture', '{}', ?, ?, 'primary', 1, 'v9-revision', 'trusted_current')`,
    ).run(timestamp, timestamp);
    v9.raw.prepare(
      `INSERT INTO source_event_revision
        (id, source_event_id, revision_number, revision_kind, external_id, source_type, conversation_id,
         sender_id, sender_name, content, owner_mentioned, source_url, completeness, discovery_reason,
         metadata_json, occurred_at, captured_at, owner_scope, revision_hash, created_at, processing_status,
         trusted_payload_hash, provider_revision_modified_at_ms, provider_revision_sequence, receipt_nonce,
         receipt_digest, retry_count)
       VALUES ('v9-revision', 'v9-source', 1, 'ingest', 'v9-external', 'manual', 'v9-chat-ref',
               'v9-sender-ref', '迁移需求方', 'v9 来源。', 1, NULL, 'complete', 'v9 fixture', '{}', ?, ?,
               'primary', ?, ?, 'pending_decision', ?, NULL, 1, 'nonce', ?, 0)`,
    ).run(timestamp, timestamp, 'a'.repeat(64), timestamp, 'b'.repeat(64), 'c'.repeat(64));
    v9.raw.prepare(
      `INSERT INTO cindy_source_identity
        (id, owner_scope, account_anchor, provider, source_kind, stable_id_hash, source_event_id,
         current_revision_id, state, created_at, updated_at)
       VALUES ('v9-identity', 'primary', ?, 'synthetic', 'synthetic_message', ?, 'v9-source',
               'v9-revision', 'active', ?, ?)`,
    ).run(migrationAuth.accountAnchor, 'd'.repeat(64), timestamp, timestamp);
    v9.close();

    const [schemaOperation, ...remainingOperations] = CINDY_OWNER_CONTEXT_MIGRATION_DESCRIPTOR.orderedOperations;
    if (schemaOperation?.kind !== 'sql_batch') throw new Error('v10 migration fixture expects sql_batch first');
    const failingDescriptor = {
      ...CINDY_OWNER_CONTEXT_MIGRATION_DESCRIPTOR,
      orderedOperations: [
        { ...schemaOperation, statements: [...schemaOperation.statements, 'INSERT INTO missing_v10_fault_table(value) VALUES (1);'] },
        ...remainingOperations,
      ],
    };
    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: failingDescriptor })).toThrow(DatabaseUpgradeError);
    await expect(buildAppFromDisk(path, failingDescriptor)).rejects.toThrow(DatabaseUpgradeError);

    const raw = new DatabaseSync(path);
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(9);
    expect(raw.prepare("SELECT name FROM pragma_table_info('source_event_revision') WHERE name = 'sender_ref'").get()).toBeUndefined();
    expect(raw.prepare('SELECT COUNT(*) AS count FROM source_event_revision').get()).toEqual({ count: 1 });
    raw.close();

    const recovered = new AppDatabase(path, false);
    expect((recovered.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(recovered.raw.prepare(
      'SELECT sender_ref, display_name, chat_ref, thread_ref, mentioned_owner, sender_is_owner, message_type, owner_reacted FROM source_event_revision',
    ).get()).toMatchObject({
      display_name: '需求方',
      thread_ref: null,
      mentioned_owner: 1,
      sender_is_owner: 0,
      message_type: 'unknown',
      owner_reacted: 0,
    });
    recovered.close();
  });

  it('无法形成稳定身份的旧来源继续只读隔离', () => {
    const database = new AppDatabase(':memory:', false);
    const timestamp = '2026-08-24T00:00:00.000Z';
    database.raw.prepare(
      `INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content, owner_mentioned,
         source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at,
         owner_scope, revision_generation, current_revision_id)
       VALUES ('legacy-unmapped', 'legacy-unmapped', 'manual', 'legacy', 'legacy', 'legacy', 'legacy', 0,
               NULL, 'complete', '', '{}', ?, ?, 'primary', 0, NULL)`,
    ).run(timestamp, timestamp);
    expect(database.raw.prepare('SELECT ingest_state FROM source_event WHERE id = ?').get('legacy-unmapped')).toEqual({ ingest_state: 'legacy_read_only' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_source_identity WHERE source_event_id = ?').get('legacy-unmapped')).toEqual({ count: 0 });
    database.close();
  });

  it('v10→v11 grouped batch migration 失败会阻止启动、保持完整 v10，修复后原子迁移', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-source-v11-failure-'));
    roots.push(root);
    const path = join(root, 'pm.sqlite');
    const v10 = new AppDatabase(path, false, { targetSchemaVersionForTest: 10 });
    v10.raw.prepare("INSERT INTO app_setting(key, value_json, updated_at) VALUES ('v10-marker', '{\"ok\":true}', '2026-08-24T00:00:00.000Z')").run();
    v10.close();

    const [schemaOperation, ...remainingOperations] = CINDY_GROUPED_BATCH_MIGRATION_DESCRIPTOR.orderedOperations;
    if (schemaOperation?.kind !== 'sql_batch') throw new Error('v11 migration fixture expects sql_batch first');
    const failingDescriptor = {
      ...CINDY_GROUPED_BATCH_MIGRATION_DESCRIPTOR,
      orderedOperations: [
        { ...schemaOperation, statements: [...schemaOperation.statements, 'INSERT INTO missing_v11_fault_table(value) VALUES (1);'] },
        ...remainingOperations,
      ],
    };
    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: failingDescriptor })).toThrow(DatabaseUpgradeError);
    await expect(buildAppFromDisk(path, failingDescriptor)).rejects.toThrow(DatabaseUpgradeError);

    const raw = new DatabaseSync(path);
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(10);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cindy_batch'").get()).toBeUndefined();
    expect(raw.prepare("SELECT value_json FROM app_setting WHERE key = 'v10-marker'").get()).toEqual({ value_json: '{"ok":true}' });
    raw.close();

    const recovered = new AppDatabase(path, false);
    expect((recovered.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(recovered.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cindy_batch'").get())
      .toEqual({ name: 'cindy_batch' });
    expect(recovered.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'v10-marker'").get()).toEqual({ value_json: '{"ok":true}' });
    recovered.close();
  });

  it('v11→v12 append migration 失败会阻止启动、保持完整 v11，修复后原子迁移并回填 consumption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-source-v12-failure-'));
    roots.push(root);
    const path = join(root, 'pm.sqlite');
    const v11 = new AppDatabase(path, false, { targetSchemaVersionForTest: 11 });
    v11.raw.prepare("INSERT INTO app_setting(key, value_json, updated_at) VALUES ('v11-marker', '{\"ok\":true}', '2026-08-24T00:00:00.000Z')").run();
    v11.close();

    const [schemaOperation, ...remainingOperations] = CINDY_CANDIDATE_APPEND_MIGRATION_DESCRIPTOR.orderedOperations;
    if (schemaOperation?.kind !== 'sql_batch') throw new Error('v12 migration fixture expects sql_batch first');
    const failingDescriptor = {
      ...CINDY_CANDIDATE_APPEND_MIGRATION_DESCRIPTOR,
      orderedOperations: [
        { ...schemaOperation, statements: [...schemaOperation.statements, 'INSERT INTO missing_v12_fault_table(value) VALUES (1);'] },
        ...remainingOperations,
      ],
    };
    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: failingDescriptor })).toThrow(DatabaseUpgradeError);
    await expect(buildAppFromDisk(path, failingDescriptor)).rejects.toThrow(DatabaseUpgradeError);

    const raw = new DatabaseSync(path);
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(11);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cindy_append_request'").get()).toBeUndefined();
    expect(raw.prepare("SELECT value_json FROM app_setting WHERE key = 'v11-marker'").get()).toEqual({ value_json: '{"ok":true}' });
    raw.close();

    const recovered = new AppDatabase(path, false);
    expect((recovered.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(recovered.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cindy_append_request'").get())
      .toEqual({ name: 'cindy_append_request' });
    expect(recovered.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'v11-marker'").get()).toEqual({ value_json: '{"ok":true}' });
    recovered.close();
  });

  it('真实 v11 pending append 冲突 key 迁移为稳定 legacy key，并以显式 evidence 原子恢复', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-v11-append-recovery-'));
    roots.push(root);
    const path = join(root, 'pm.sqlite');
    const v11 = new AppDatabase(path, false, { targetSchemaVersionForTest: 11 });
    const fixture = seedV11PendingAppend(v11, 1, { conflictingGroup: true });
    v11.close();

    const { app, database } = await buildCurrentCindyApp(path);
    const migrated = database.raw.prepare(
      'SELECT group_key, options_json FROM cindy_owner_decision WHERE id = ?',
    ).get(fixture.decisionId) as { group_key: string; options_json: string };
    expect(migrated.group_key).toBe('legacy:00000000-0000-0000-0000-000000000001');
    expect(migrated.group_key).not.toBe(fixture.decisionKey);
    expect(JSON.parse(migrated.options_json)[0]).toMatchObject({
      candidateKey: fixture.candidateId,
      candidateVersion: 1,
      fieldEvidenceSourceIndexes: { title: [0] },
    });
    expect(database.raw.prepare(
      `SELECT revision.processing_status, identity.id AS identity_id
         FROM cindy_owner_decision_source AS decision_source
         JOIN source_event_revision AS revision ON revision.id = decision_source.source_revision_id
         LEFT JOIN cindy_source_identity AS identity ON identity.current_revision_id = revision.id
          AND identity.owner_scope = ? AND identity.account_anchor = ? AND identity.state = 'active'
        WHERE decision_source.decision_id = ?`,
    ).get(migrationAuth.ownerScope, migrationAuth.accountAnchor, fixture.decisionId)).toEqual({
      processing_status: 'pending_decision', identity_id: expect.any(String),
    });
    const listed = await app.inject({
      method: 'GET', url: '/api/owner-decisions?status=pending',
      headers: { authorization: `Bearer ${migrationToken}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items[0].options[0]).toMatchObject({ action: 'append_candidate', available: true });
    expect(JSON.stringify(listed.json())).not.toContain(fixture.candidateId);
    const resolved = await app.inject({
      method: 'POST', url: `/api/owner-decisions/${fixture.decisionId}/resolve`,
      headers: { authorization: `Bearer ${migrationToken}` },
      payload: {
        decision_request_id: 'resolve-v11-append-01', expected_version: 1,
        action: 'append_candidate', option_key: 'append', append_request_id: 'append-v11-01',
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ status: 'resolved', resolution_action: 'append_candidate', version: 2 });
    expect(database.raw.prepare('SELECT title, version FROM candidate_request WHERE id = ?').get(fixture.candidateId))
      .toEqual({ title: '迁移后候选 01', version: 2 });
    expect(database.raw.prepare(
      "SELECT field_name, source_revision_id FROM cindy_append_field_evidence WHERE append_request_id = 'append-v11-01'",
    ).all()).toEqual([{ field_name: 'title', source_revision_id: fixture.pendingRevisionId }]);
    await app.close();
    database.close();
  });

  it('真实 v11 pending append 对跨 owner、旧 revision 和候选版本变化保持 fail closed', async () => {
    const foreignAuth = deriveCindyAuthContext({
      accountAnchor: 'migration-foreign-account-anchor',
      receiptSecret: 'migration-foreign-receipt-secret-0123456789abcdef',
    });
    const scenarios: Array<{
      index: number;
      seedOptions?: Parameters<typeof seedV11PendingAppend>[2];
      mutate?: (database: AppDatabase, fixture: ReturnType<typeof seedV11PendingAppend>) => void;
      expectedStatus: 'pending' | 'superseded';
      expectedCode: number;
    }> = [
      { index: 2, seedOptions: { candidateAuth: foreignAuth }, expectedStatus: 'pending', expectedCode: 409 },
      {
        index: 3,
        mutate: (database, fixture) => {
          saveCindySources(database, migrationAuth, {
            save_request_id: 'save-v11-pending-03-revision-2',
            sources: [{
              client_ref: 'pending-03-new', provider: 'synthetic', source_kind: 'synthetic_message',
              stable_message_id: fixture.pendingStableId, occurred_at: '2026-08-24T03:03:00.000Z',
              sender_id: 'pending-sender-03', display_name: '迁移需求方', chat_id: 'v11-chat-03',
              thread_id: 'v11-thread-03', mentioned_owner: true, sender_is_owner: false,
              message_type: 'text', text: '迁移追加 03 已编辑', revision: { sequence: 2 },
            }],
          });
        },
        expectedStatus: 'superseded', expectedCode: 409,
      },
      {
        index: 4,
        mutate: (database, fixture) => {
          database.raw.prepare('UPDATE candidate_request SET version = version + 1 WHERE id = ?').run(fixture.candidateId);
        },
        expectedStatus: 'pending', expectedCode: 409,
      },
    ];

    for (const scenario of scenarios) {
      const root = mkdtempSync(join(tmpdir(), `cindy-v11-append-reject-${scenario.index}-`));
      roots.push(root);
      const path = join(root, 'pm.sqlite');
      const v11 = new AppDatabase(path, false, { targetSchemaVersionForTest: 11 });
      const fixture = seedV11PendingAppend(v11, scenario.index, scenario.seedOptions);
      v11.close();
      const migrated = new AppDatabase(path, false);
      scenario.mutate?.(migrated, fixture);
      migrated.close();
      const { app, database } = await buildCurrentCindyApp(path);
      const rejected = await app.inject({
        method: 'POST', url: `/api/owner-decisions/${fixture.decisionId}/resolve`,
        headers: { authorization: `Bearer ${migrationToken}` },
        payload: {
          decision_request_id: `resolve-v11-append-${scenario.index}`, expected_version: 1,
          action: 'append_candidate', option_key: 'append', append_request_id: `append-v11-${scenario.index}`,
        },
      });
      expect(rejected.statusCode).toBe(scenario.expectedCode);
      expect(database.raw.prepare('SELECT status FROM cindy_owner_decision WHERE id = ?').get(fixture.decisionId))
        .toEqual({ status: scenario.expectedStatus });
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_append_request WHERE owner_decision_id = ?').get(fixture.decisionId))
        .toEqual({ count: 0 });
      expect(database.raw.prepare('SELECT processing_status FROM source_event_revision WHERE id = ?').get(fixture.pendingRevisionId))
        .toMatchObject({ processing_status: scenario.expectedStatus === 'superseded' ? 'superseded' : 'pending_decision' });
      await app.close();
      database.close();
    }
  });
});
const migrationToken = 'migration-test-bearer-token';

function seedV11PendingAppend(database: AppDatabase, index: number, options: {
  candidateAuth?: typeof migrationAuth;
  conflictingGroup?: boolean;
} = {}) {
  const candidateAuth = options.candidateAuth ?? migrationAuth;
  const suffix = String(index).padStart(2, '0');
  const timestamp = `2026-08-24T03:${suffix}:00.000Z`;
  saveCindySources(database, candidateAuth, {
    save_request_id: `save-v11-candidate-${suffix}`,
    sources: [{
      client_ref: `candidate-${suffix}`, provider: 'synthetic', source_kind: 'synthetic_message',
      stable_message_id: `v11-candidate-message-${suffix}`, occurred_at: timestamp,
      sender_id: `candidate-sender-${suffix}`, display_name: '迁移需求方', chat_id: `v11-chat-${suffix}`,
      thread_id: `v11-thread-${suffix}`, mentioned_owner: true, sender_is_owner: false,
      message_type: 'text', text: `旧候选 ${suffix}`, revision: { sequence: 1 },
    }],
  });
  const candidateRevisionRow = database.raw.prepare(
    `SELECT revision.id, revision.source_event_id, revision.revision_hash
       FROM source_event_revision AS revision
       JOIN source_event AS source ON source.id = revision.source_event_id
      WHERE source.content = ?`,
  ).get(`旧候选 ${suffix}`) as { id: string; source_event_id: string; revision_hash: string };
  const candidateId = `cand_00000000-0000-0000-0000-0000000000${suffix}`;
  const unitId = `unit-v11-${suffix}`;
  database.raw.prepare(
    `INSERT INTO source_demand_unit
      (id, anchor_source_event_id, unit_key, unit_kind, state, classification_revision, ai_decision_id,
       analysis_json, reason, created_at, updated_at)
     VALUES (?, ?, ?, 'demand', 'ready', 'v11-fixture', NULL, '{}', 'v11 fixture', ?, ?)`,
  ).run(unitId, candidateRevisionRow.source_event_id, `v11-unit-${suffix}`, timestamp, timestamp);
  database.raw.prepare(
    `INSERT INTO candidate_request
      (id, source_event_id, demand_unit_id, title, proposer_name, background, validation_question, describe,
       analysis_json, confidence, state, snoozed_until, accepted_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, '迁移需求方', '旧摘要', '继续确认', '旧摘要', '{}', 1, 'pending', NULL, NULL, ?, ?)`,
  ).run(candidateId, candidateRevisionRow.source_event_id, unitId, `旧候选 ${suffix}`, timestamp, timestamp);
  database.raw.prepare(
    `INSERT INTO source_demand_unit_source
      (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
     VALUES (?, ?, 'v11-anchor', 'anchor', 0, ?)`,
  ).run(unitId, candidateRevisionRow.source_event_id, timestamp);
  const createBatchId = `v11-create-${suffix}`;
  database.raw.prepare(
    `INSERT INTO cindy_batch
      (owner_scope, account_anchor, batch_id, decision_request_id, payload_hash, snapshot_hash,
       window_start, window_end, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
  ).run(candidateAuth.ownerScope, candidateAuth.accountAnchor, createBatchId, `v11-create-request-${suffix}`,
    'a'.repeat(64), 'b'.repeat(64), timestamp, timestamp, timestamp);
  database.raw.prepare(
    `INSERT INTO cindy_batch_group
      (owner_scope, account_anchor, batch_id, group_key, action, anchor_revision_id, candidate_id, created_at)
     VALUES (?, ?, ?, 'create', 'create_candidate', ?, ?, ?)`,
  ).run(candidateAuth.ownerScope, candidateAuth.accountAnchor, createBatchId, candidateRevisionRow.id, candidateId, timestamp);
  database.raw.prepare(
    `INSERT INTO cindy_batch_snapshot
      (owner_scope, account_anchor, batch_id, source_revision_id, revision_hash, disposition_ref,
       primary_disposition, primary_group_key, created_at)
     VALUES (?, ?, ?, ?, ?, 'create', 'group', 'create', ?)`,
  ).run(candidateAuth.ownerScope, candidateAuth.accountAnchor, createBatchId, candidateRevisionRow.id, candidateRevisionRow.revision_hash, timestamp);
  database.raw.prepare("UPDATE source_event_revision SET processing_status = 'processed' WHERE id = ?").run(candidateRevisionRow.id);

  saveCindySources(database, migrationAuth, {
    save_request_id: `save-v11-pending-${suffix}`,
    sources: [{
      client_ref: `pending-${suffix}`, provider: 'synthetic', source_kind: 'synthetic_message',
      stable_message_id: `v11-pending-message-${suffix}`, occurred_at: timestamp,
      sender_id: `pending-sender-${suffix}`, display_name: '迁移需求方', chat_id: `v11-chat-${suffix}`,
      thread_id: `v11-thread-${suffix}`, mentioned_owner: true, sender_is_owner: false,
      message_type: 'text', text: `迁移追加 ${suffix}`, revision: { sequence: 1 },
    }],
  });
  const pendingRevision = database.raw.prepare(
    `SELECT revision.id, revision.source_event_id, revision.revision_hash
       FROM source_event_revision AS revision
       JOIN source_event AS source ON source.id = revision.source_event_id
      WHERE source.content = ?`,
  ).get(`迁移追加 ${suffix}`) as { id: string; source_event_id: string; revision_hash: string };
  const decisionBatchId = `v11-owner-${suffix}`;
  const decisionKey = `owner-${suffix}`;
  database.raw.prepare(
    `INSERT INTO cindy_batch
      (owner_scope, account_anchor, batch_id, decision_request_id, payload_hash, snapshot_hash,
       window_start, window_end, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
  ).run(migrationAuth.ownerScope, migrationAuth.accountAnchor, decisionBatchId, `v11-owner-request-${suffix}`,
    'c'.repeat(64), 'd'.repeat(64), timestamp, timestamp, timestamp);
  if (options.conflictingGroup) {
    database.raw.prepare(
      `INSERT INTO cindy_batch_group
        (owner_scope, account_anchor, batch_id, group_key, action, anchor_revision_id, created_at)
       VALUES (?, ?, ?, ?, 'create_candidate', ?, ?)`,
    ).run(migrationAuth.ownerScope, migrationAuth.accountAnchor, decisionBatchId, decisionKey, pendingRevision.id, timestamp);
  }
  database.raw.prepare(
    `INSERT INTO cindy_batch_snapshot
      (owner_scope, account_anchor, batch_id, source_revision_id, revision_hash, disposition_ref,
       primary_disposition, primary_group_key, created_at)
     VALUES (?, ?, ?, ?, ?, 'owner', 'needs_owner', NULL, ?)`,
  ).run(migrationAuth.ownerScope, migrationAuth.accountAnchor, decisionBatchId, pendingRevision.id, pendingRevision.revision_hash, timestamp);
  const decisionId = `cindy_owner_decision_00000000-0000-0000-0000-0000000000${suffix}`;
  database.raw.prepare(
    `INSERT INTO cindy_owner_decision
      (id, owner_scope, account_anchor, batch_id, decision_key, reason_summary, options_json,
       status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '迁移 append 需要主人确认。', ?, 'pending', 1, ?, ?)`,
  ).run(decisionId, migrationAuth.ownerScope, migrationAuth.accountAnchor, decisionBatchId, decisionKey,
    JSON.stringify([{
      optionKey: 'append', action: 'append_candidate', title: `迁移后候选 ${suffix}`,
      describe: null, nextStep: null, candidateKey: candidateId,
    }]), timestamp, timestamp);
  database.raw.prepare(
    `INSERT INTO cindy_owner_decision_source
      (decision_id, source_revision_id, source_order, source_role) VALUES (?, ?, 0, 'anchor')`,
  ).run(decisionId, pendingRevision.id);
  return { candidateId, decisionId, decisionKey, pendingRevisionId: pendingRevision.id, pendingStableId: `v11-pending-message-${suffix}` };
}
