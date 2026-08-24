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

const migrationAuth = deriveCindyAuthContext({
  accountAnchor: 'migration-test-account-anchor',
  receiptSecret: 'migration-test-receipt-secret-0123456789abcdef0123456789abcdef',
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
});
