import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppDatabase,
  BASELINE_MIGRATION_DESCRIPTOR,
  BASELINE_MIGRATION_CHECKSUM,
  CURRENT_SCHEMA_VERSION,
  CANDIDATE_VERSION_MIGRATION_CHECKSUM,
  DATABASE_BACKUP_RETENTION,
  DatabaseUpgradeError,
  RELATION_CONSTRAINT_MIGRATION_CHECKSUM,
  PRIVACY_MIGRATION_CHECKSUM,
  PRIVACY_FENCING_MIGRATION_CHECKSUM,
  SOURCE_REVISION_MIGRATION_CHECKSUM,
  RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_CHECKSUM,
  PROVIDER_RETRY_COOLDOWN_MIGRATION_CHECKSUM,
  type MigrationDescriptor,
  type MigrationOperation,
  managedPathIsContained,
  migrationDescriptorChecksum,
  restoreDatabaseBackup,
} from '../src/database.js';

const roots: string[] = [];
const fixedNow = () => new Date('2026-08-15T01:02:03.004Z');

function fixtureRoot(label: string) {
  const root = mkdtempSync(join(tmpdir(), `ai-pm-${label}-`));
  roots.push(root);
  return root;
}

function stripData04(raw: DatabaseSync) {
  raw.exec(`PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS ai_decision_source_revision;
    DROP TABLE IF EXISTS source_event_revision;
    DROP TABLE IF EXISTS audit_replay_capability;
    DROP TABLE IF EXISTS privacy_lifecycle_claim;
    DROP TABLE IF EXISTS privacy_backup_cleanup_intent;
    ALTER TABLE source_event DROP COLUMN owner_scope;
    ALTER TABLE source_event DROP COLUMN revision_generation;
    ALTER TABLE source_event DROP COLUMN current_revision_id;
    ALTER TABLE ai_decision_log DROP COLUMN revision_set_hash;
    ALTER TABLE ai_decision_log DROP COLUMN prompt_hash;
    ALTER TABLE ai_decision_log DROP COLUMN model_config_hash;
    ALTER TABLE ai_decision_log DROP COLUMN replay_state;
    ALTER TABLE ai_decision_log DROP COLUMN replay_state_reason;
    ALTER TABLE ai_decision_log DROP COLUMN owner_scope;
    PRAGMA foreign_keys = ON;`);
}

function createLegacyTaskDatabase(path: string) {
  const current = new AppDatabase(path, false);
  try {
    current.raw.prepare(`INSERT INTO task
      (id, title, proposer_name, describe, status, schedule_at, next_step, risk, waiting_reason,
       version, completed_at, archived_at, created_at, updated_at)
      VALUES ('legacy-task', '旧任务', '需求方', '必须保留的历史内容', 'planned', NULL, '继续处理',
              'low', NULL, 1, NULL, NULL, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z')`).run();
  } finally {
    current.close();
  }
  const legacy = new DatabaseSync(path);
  try {
    stripData04(legacy);
    // AppDatabase now opens the latest schema by default.  Strip the DATA-02
    // additions so this fixture remains a genuine raw v0 database instead of
    // a v2 database with its ledger removed (which must fail closed).
    legacy.exec(`
      DROP TABLE IF EXISTS privacy_audit_event;
      DROP TABLE IF EXISTS privacy_backup;
      DROP TABLE IF EXISTS privacy_deletion;
      DROP TABLE IF EXISTS privacy_export;
      DROP TABLE IF EXISTS privacy_retention_policy;
      DROP TABLE IF EXISTS privacy_control;
      DROP INDEX IF EXISTS idx_runtime_tool_idempotency_active;
      DROP INDEX IF EXISTS idx_provider_retry_cooldown_retry_at;
      DROP TABLE provider_retry_cooldown;
      ALTER TABLE runtime_tool_call DROP COLUMN idempotency_key;
      ALTER TABLE candidate_request DROP COLUMN version;
      CREATE TABLE task_source_link_legacy (
        task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
        source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL DEFAULT 'origin',
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, source_event_id)
      );
      INSERT INTO task_source_link_legacy (task_id, source_event_id, relation_type, created_at)
        SELECT task_id, source_event_id, relation_type, created_at FROM task_source_link;
      DROP TABLE task_source_link;
      ALTER TABLE task_source_link_legacy RENAME TO task_source_link;
      DROP INDEX IF EXISTS idx_audit_demand_unit;
      DROP INDEX IF EXISTS idx_correction_demand_unit;
      DROP INDEX IF EXISTS idx_thread_source_unit;
      DROP INDEX IF EXISTS idx_owner_decision_unit;
      DROP INDEX IF EXISTS idx_ai_decision_source_revision;
      ALTER TABLE task_event DROP COLUMN demand_unit_id;
      ALTER TABLE correction_event DROP COLUMN demand_unit_id;
      ALTER TABLE requirement_thread_source DROP COLUMN demand_unit_id;
      ALTER TABLE owner_decision DROP COLUMN demand_unit_id;
      ALTER TABLE ai_decision_log DROP COLUMN source_revision;
      DROP TABLE schema_migration;
      DROP TABLE database_metadata;
      DROP TABLE data_integrity_gap;
      PRAGMA user_version = 0;
    `);
  } finally {
    legacy.close();
  }
}

function createHistoricalAdditiveLegacyDatabase(path: string) {
  const current = new AppDatabase(path, false);
  try {
    current.raw.prepare(`INSERT INTO source_event
      (id, external_id, source_type, conversation_id, sender_id, sender_name, content,
       completeness, occurred_at, captured_at)
      VALUES ('legacy-source', 'legacy-external', 'message', 'legacy-conversation', 'legacy-sender',
              '合成发送者', '合成历史来源', 'partial', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')`).run();
    current.raw.prepare(`INSERT INTO task
      (id, title, proposer_name, describe, status, next_step, risk, version, created_at, updated_at)
      VALUES ('legacy-task', '合成历史任务', '合成发送者', '保留历史字段', 'planned', '继续处理', 'low', 1,
              '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z')`).run();
    current.raw.prepare(`INSERT INTO notification
      (id, task_id, notification_type, reason, created_at)
      VALUES ('legacy-notification', 'legacy-task', 'immediate', '合成迁移提醒', '2026-08-15T00:00:00.000Z')`).run();
  } finally {
    current.close();
  }
  const legacy = new DatabaseSync(path);
  try {
    stripData04(legacy);
    legacy.exec(`PRAGMA journal_mode = DELETE;
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      DROP TABLE IF EXISTS privacy_audit_event;
      DROP TABLE IF EXISTS privacy_backup;
      DROP TABLE IF EXISTS privacy_deletion;
      DROP TABLE IF EXISTS privacy_export;
      DROP TABLE IF EXISTS privacy_retention_policy;
      DROP TABLE IF EXISTS privacy_control;
      DROP INDEX IF EXISTS idx_runtime_tool_idempotency_active;
      DROP INDEX IF EXISTS idx_provider_retry_cooldown_retry_at;
      DROP TABLE provider_retry_cooldown;
      ALTER TABLE runtime_tool_call DROP COLUMN idempotency_key;
      ALTER TABLE candidate_request DROP COLUMN version;
      DROP TABLE schema_migration;
      DROP INDEX idx_source_event_occurred;
      DROP INDEX idx_task_status;
      ALTER TABLE source_event RENAME TO source_event_current;
      CREATE TABLE source_event (
        captured_at TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        external_id TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        owner_mentioned INTEGER NOT NULL DEFAULT 0,
        source_url TEXT,
        completeness TEXT NOT NULL DEFAULT 'partial',
        discovery_reason TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      );
      INSERT INTO source_event (captured_at, id, external_id, source_type, conversation_id, sender_id,
        sender_name, content, owner_mentioned, source_url, completeness, discovery_reason, metadata_json, occurred_at)
        SELECT captured_at, id, external_id, source_type, conversation_id, sender_id,
          sender_name, content, owner_mentioned, source_url, completeness, discovery_reason, metadata_json, occurred_at
        FROM source_event_current;
      DROP TABLE source_event_current;
      CREATE INDEX idx_source_event_occurred ON source_event(occurred_at DESC);

      ALTER TABLE task RENAME TO task_current;
      CREATE TABLE task (
        updated_at TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        proposer_name TEXT NOT NULL,
        describe TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('unplanned','planned','in_progress','waiting','review','completed','archived')),
        schedule_at TEXT,
        planned_start_at TEXT,
        planned_due_at TEXT,
        next_step TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
        waiting_reason TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        completed_at TEXT,
        archived_at TEXT,
        deleted_at TEXT,
        record_state TEXT NOT NULL DEFAULT 'active',
        merged_into_task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
        thread_id TEXT,
        auto_update_paused INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO task (updated_at, id, title, proposer_name, describe, status, schedule_at, planned_start_at,
        planned_due_at, next_step, risk, waiting_reason, version, completed_at, archived_at, deleted_at,
        record_state, merged_into_task_id, thread_id, auto_update_paused, created_at)
        SELECT updated_at, id, title, proposer_name, describe, status, schedule_at, planned_start_at,
          planned_due_at, next_step, risk, waiting_reason, version, completed_at, archived_at, deleted_at,
          record_state, merged_into_task_id, thread_id, auto_update_paused, created_at
        FROM task_current;
      DROP TABLE task_current;
      CREATE INDEX idx_task_status ON task(status, schedule_at);
      CREATE INDEX idx_task_plan ON task(deleted_at, status, planned_start_at, planned_due_at, schedule_at);

      ALTER TABLE notification RENAME TO notification_current;
      CREATE TABLE notification (
        created_at TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES task(id) ON DELETE CASCADE,
        task_event_id TEXT REFERENCES task_event(id) ON DELETE CASCADE,
        candidate_id TEXT REFERENCES candidate_request(id) ON DELETE CASCADE,
        notification_type TEXT NOT NULL DEFAULT 'immediate',
        dedupe_key TEXT,
        reason TEXT NOT NULL,
        read_at TEXT,
        snoozed_until TEXT,
        archived_at TEXT
      );
      INSERT INTO notification (created_at, id, task_id, task_event_id, candidate_id, notification_type,
        dedupe_key, reason, read_at, snoozed_until, archived_at)
        SELECT created_at, id, task_id, task_event_id, candidate_id, notification_type,
          dedupe_key, reason, read_at, snoozed_until, archived_at
        FROM notification_current;
      DROP TABLE notification_current;
      CREATE UNIQUE INDEX idx_notification_dedupe ON notification(dedupe_key) WHERE dedupe_key IS NOT NULL;
      CREATE TABLE task_source_link_legacy (
        task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
        source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL DEFAULT 'origin',
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, source_event_id)
      );
      INSERT INTO task_source_link_legacy (task_id, source_event_id, relation_type, created_at)
        SELECT task_id, source_event_id, relation_type, created_at FROM task_source_link;
      DROP TABLE task_source_link;
      ALTER TABLE task_source_link_legacy RENAME TO task_source_link;
      DROP INDEX IF EXISTS idx_audit_demand_unit;
      DROP INDEX IF EXISTS idx_correction_demand_unit;
      DROP INDEX IF EXISTS idx_thread_source_unit;
      DROP INDEX IF EXISTS idx_owner_decision_unit;
      DROP INDEX IF EXISTS idx_ai_decision_source_revision;
      DROP INDEX IF EXISTS idx_task_source_link_explicit;
      DROP INDEX IF EXISTS idx_task_source_link_ambiguous;
      DROP INDEX IF EXISTS idx_task_source_link_unit;
      DROP INDEX IF EXISTS idx_task_source_link_source_unit;
      DROP INDEX IF EXISTS idx_data_integrity_gap_source;
      DROP INDEX IF EXISTS idx_data_integrity_gap_unit;
      DROP INDEX IF EXISTS idx_data_integrity_gap_candidate;
      DROP INDEX IF EXISTS idx_data_integrity_gap_thread;
      DROP INDEX IF EXISTS idx_data_integrity_gap_task;
      DROP INDEX IF EXISTS idx_data_integrity_gap_status;
      ALTER TABLE task_event DROP COLUMN demand_unit_id;
      ALTER TABLE correction_event DROP COLUMN demand_unit_id;
      ALTER TABLE requirement_thread_source DROP COLUMN demand_unit_id;
      ALTER TABLE owner_decision DROP COLUMN demand_unit_id;
      ALTER TABLE ai_decision_log DROP COLUMN source_revision;
      DROP TABLE data_integrity_gap;
      DROP TABLE database_metadata;
      PRAGMA user_version = 0;
      VACUUM;`);
  } finally {
    legacy.close();
  }
}

function writeSyntheticBackupManifest(
  databasePath: string,
  backupPath: string,
  fromVersion: number,
  toVersion: number,
) {
  const current = new DatabaseSync(databasePath, { readOnly: true });
  const identity = current.prepare('SELECT database_instance_id FROM database_metadata WHERE singleton_key = 1')
    .get() as { database_instance_id: string };
  current.close();
  try {
    const backup = new DatabaseSync(backupPath);
    try {
      backup.exec(`CREATE TABLE IF NOT EXISTS database_metadata (
        singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
        database_instance_id TEXT NOT NULL UNIQUE CHECK (length(database_instance_id) = 32),
        created_at TEXT NOT NULL
      );`);
      backup.prepare(`INSERT OR REPLACE INTO database_metadata
        (singleton_key, database_instance_id, created_at) VALUES (1, ?, '2026-08-15T00:00:00.000Z')`)
        .run(identity.database_instance_id);
    } finally {
      backup.close();
    }
  } catch {
    // Corrupt-byte fixtures still get a syntactically valid manifest so the
    // public restore boundary must fail closed during database inspection.
  }
  const timestamp = /-(\d{8}T\d{9}Z)-/u.exec(basename(backupPath))?.[1] ?? '20260815T000000000Z';
  const createdAt = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`
    + `T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}.${timestamp.slice(15, 18)}Z`;
  writeFileSync(`${backupPath}.manifest.json`, `${JSON.stringify({
    schema_version: 2,
    created_by: 'feishu-ai-pm',
    database_name: basename(databasePath),
    database_instance_id: identity.database_instance_id,
    backup_file: basename(backupPath),
    from_version: fromVersion,
    to_version: toVersion,
    created_at: createdAt,
    sha256: createHash('sha256').update(readFileSync(backupPath)).digest('hex'),
  }, null, 2)}\n`);
}

function managedBackups(root: string) {
  const directory = join(root, 'backups');
  try {
    return readdirSync(directory).filter((name) => {
      if (!name.endsWith('.sqlite')) return false;
      const stats = lstatSync(join(directory, name));
      return !stats.isSymbolicLink() && stats.isFile() && stats.nlink === 1;
    });
  } catch {
    return [];
  }
}

function openReadOnly(path: string) {
  return new DatabaseSync(path, { readOnly: true });
}

function databaseContentsSnapshot(path: string) {
  const database = openReadOnly(path);
  try {
    const userVersion = database.prepare('PRAGMA user_version').get();
    const tables = (database.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string; sql: string }>).map(({ name, sql }) => {
      const columns = (database.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as Array<{ name: string }>)
        .map((column) => column.name);
      const orderBy = columns.map((column) => `"${column}"`).join(', ');
      const rows = database.prepare(`SELECT * FROM "${name}"${orderBy ? ` ORDER BY ${orderBy}` : ''}`).all();
      return { name, sql, columns, rows };
    });
    return { userVersion, tables };
  } finally {
    database.close();
  }
}

function businessRowHashes(path: string) {
  const excludedTables = new Set([
    'database_metadata',
    'schema_migration',
    'data_integrity_gap',
    'provider_retry_cooldown',
    'source_demand_unit',
    'source_demand_unit_source',
    'requirement_thread_unit',
    'privacy_audit_event',
    'privacy_backup',
    'privacy_control',
    'privacy_deletion',
    'privacy_export',
    'privacy_retention_policy',
    'privacy_lifecycle_claim',
    'privacy_backup_cleanup_intent',
    'audit_replay_capability',
    'source_event_revision',
    'ai_decision_source_revision',
  ]);
  const excludedColumns = new Set([
    'demand_unit_id', 'source_revision', 'version', 'current_revision_id',
    'revision_set_hash', 'prompt_hash', 'model_config_hash', 'owner_scope',
    'revision_generation', 'replay_state', 'replay_state_reason',
  ]);
  const database = openReadOnly(path);
  try {
    const tables = (database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).filter(({ name }) => !excludedTables.has(name));
    return Object.fromEntries(tables.map(({ name }) => {
      const columns = (database.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as Array<{ name: string }>)
        .map(({ name: column }) => column)
        .filter((column) => !excludedColumns.has(column) && !(name === 'candidate_request' && column === 'version'));
      const projection = columns.map((column) => `"${column}"`).join(', ');
      const rows = database.prepare(
        `SELECT ${projection} FROM "${name}" ORDER BY ${projection}`,
      ).all();
      return [name, {
        count: rows.length,
        sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      }];
    }));
  } finally {
    database.close();
  }
}

function copyManagedBackupPair(sourceBackupPath: string, targetBackupPath: string, createdAt: string) {
  copyFileSync(sourceBackupPath, targetBackupPath);
  const manifest = JSON.parse(readFileSync(`${sourceBackupPath}.manifest.json`, 'utf8')) as Record<string, unknown>;
  manifest.backup_file = basename(targetBackupPath);
  manifest.created_at = createdAt;
  manifest.sha256 = createHash('sha256').update(readFileSync(targetBackupPath)).digest('hex');
  writeFileSync(`${targetBackupPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}

function injectForeignKeyDamage(path: string) {
  const database = new DatabaseSync(path);
  try {
    database.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO task_source_link (task_id, source_event_id, relation_type, created_at)
      VALUES ('missing-task', 'missing-source', 'origin', '2026-08-15T00:00:00.000Z');`);
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SQLite 版本化迁移与恢复合同', () => {
  it('迁移 checksum 由实际执行的冻结描述符确定性生成', () => {
    expect(BASELINE_MIGRATION_CHECKSUM).toBe(migrationDescriptorChecksum(BASELINE_MIGRATION_DESCRIPTOR));
    expect(Object.isFrozen(BASELINE_MIGRATION_DESCRIPTOR)).toBe(true);
    expect(Object.isFrozen(BASELINE_MIGRATION_DESCRIPTOR.orderedOperations)).toBe(true);
    expect(BASELINE_MIGRATION_DESCRIPTOR.orderedOperations.every(Object.isFrozen)).toBe(true);
    const addColumns = BASELINE_MIGRATION_DESCRIPTOR.orderedOperations.find(
      (operation) => operation.id === 'add-legacy-columns',
    );
    expect(addColumns?.kind).toBe('add_columns');
    const firstLegacyColumn = addColumns?.kind === 'add_columns'
      ? addColumns.columns[0] as unknown as string[]
      : [];
    expect(() => { firstLegacyColumn[2] = "TEXT DEFAULT 'tampered'"; }).toThrow(TypeError);
    expect(BASELINE_MIGRATION_CHECKSUM).toBe(migrationDescriptorChecksum(BASELINE_MIGRATION_DESCRIPTOR));
    const operations: MigrationOperation[] = [...BASELINE_MIGRATION_DESCRIPTOR.orderedOperations];
    const schemaIndex = operations.findIndex((operation) => operation.id === 'apply-schema');
    const schemaOperation = operations[schemaIndex]!;
    const payloadMutation = [...operations];
    if (schemaOperation.kind === 'sql_batch') {
      payloadMutation[schemaIndex] = { ...schemaOperation, statements: [...schemaOperation.statements, 'SELECT 1;'] };
    }
    const reordered = [...operations];
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    const rebuildIndex = operations.findIndex((operation) => operation.id === 'rebuild-canonical-schema');
    const rebuildOperation = operations[rebuildIndex]!;
    if (rebuildOperation.kind !== 'rebuild_tables') throw new Error('rebuild operation fixture missing');
    const [firstRebuild, ...remainingRebuilds] = rebuildOperation.tables;
    if (!firstRebuild) throw new Error('rebuild table fixture missing');
    const withRebuildMutation = (rebuild: Record<string, unknown>) => {
      const changedOperations = [...operations];
      changedOperations[rebuildIndex] = {
        ...rebuildOperation,
        tables: [{ ...firstRebuild, ...rebuild }, ...remainingRebuilds],
      } as MigrationOperation;
      return { ...BASELINE_MIGRATION_DESCRIPTOR, orderedOperations: changedOperations } as MigrationDescriptor;
    };
    for (const mutation of [
      { ...BASELINE_MIGRATION_DESCRIPTOR, version: 2 },
      { ...BASELINE_MIGRATION_DESCRIPTOR, name: `${BASELINE_MIGRATION_DESCRIPTOR.name}-changed` },
      { ...BASELINE_MIGRATION_DESCRIPTOR, orderedOperations: payloadMutation },
      { ...BASELINE_MIGRATION_DESCRIPTOR, orderedOperations: reordered },
      withRebuildMutation({ copyMode: 'changed-mode' }),
      withRebuildMutation({ conflictMode: 'changed-mode' }),
      withRebuildMutation({ createSql: `${firstRebuild.createSql}\n-- changed` }),
      withRebuildMutation({ targetColumns: [...firstRebuild.targetColumns].reverse() }),
      withRebuildMutation({ sourceColumns: [...firstRebuild.sourceColumns].reverse() }),
    ]) {
      expect(migrationDescriptorChecksum(mutation as MigrationDescriptor)).not.toBe(BASELINE_MIGRATION_CHECKSUM);
    }
  });

  it('支持真实 additive 历史形态的列顺序与三个已知旧 CHECK 缺口，并保留数据关系', () => {
    const root = fixtureRoot('migration-historical-additive-v0');
    const path = join(root, 'ai-pm.sqlite');
    createHistoricalAdditiveLegacyDatabase(path);

    const migrated = new AppDatabase(path, false, { now: fixedNow });
    try {
      expect(migrated.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      expect(migrated.raw.prepare('SELECT title, describe FROM task WHERE id = ?').get('legacy-task')).toEqual({
        title: '合成历史任务',
        describe: '保留历史字段',
      });
      expect(migrated.raw.prepare('SELECT content, completeness FROM source_event WHERE id = ?').get('legacy-source')).toEqual({
        content: '合成历史来源',
        completeness: 'partial',
      });
      expect(migrated.raw.prepare('SELECT task_id, notification_type FROM notification WHERE id = ?').get('legacy-notification')).toEqual({
        task_id: 'legacy-task',
        notification_type: 'immediate',
      });
      expect(migrated.raw.prepare('SELECT version FROM schema_migration').get()).toEqual({ version: 1 });
    } finally {
      migrated.close();
    }
  });

  it('未知迁移操作不会推进 schema、账本或 user_version', () => {
    const root = fixtureRoot('migration-unknown-operation');
    const path = join(root, 'ai-pm.sqlite');
    const descriptor = {
      ...BASELINE_MIGRATION_DESCRIPTOR,
      orderedOperations: [
        ...BASELINE_MIGRATION_DESCRIPTOR.orderedOperations,
        { id: 'unknown-operation', kind: 'unknown_kind', payload: 'synthetic' },
      ],
    } as unknown as MigrationDescriptor;
    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: descriptor }))
      .toThrowError(expect.objectContaining({ stage: 'migration' }));
    const unchanged = openReadOnly(path);
    try {
      expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      unchanged.close();
    }
  });

  it.each([
    ['copyMode', 'replace'],
    ['conflictMode', 'ignore'],
  ] as const)('未知 rebuild %s 在执行前拒绝且不推进版本', (field, value) => {
    const root = fixtureRoot(`migration-invalid-${field}`);
    const path = join(root, 'ai-pm.sqlite');
    const operations: MigrationOperation[] = [...BASELINE_MIGRATION_DESCRIPTOR.orderedOperations];
    const rebuildIndex = operations.findIndex((operation) => operation.kind === 'rebuild_tables');
    const rebuildOperation = operations[rebuildIndex]!;
    if (rebuildOperation.kind !== 'rebuild_tables') throw new Error('rebuild operation fixture missing');
    const [first, ...rest] = rebuildOperation.tables;
    if (!first) throw new Error('rebuild table fixture missing');
    operations[rebuildIndex] = {
      ...rebuildOperation,
      tables: [{ ...first, [field]: value }, ...rest],
    } as MigrationOperation;
    const descriptor = { ...BASELINE_MIGRATION_DESCRIPTOR, orderedOperations: operations } as MigrationDescriptor;

    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: descriptor }))
      .toThrowError(expect.objectContaining({ stage: 'migration' }));
    const unchanged = openReadOnly(path);
    try {
      expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all())
        .toEqual([]);
    } finally {
      unchanged.close();
    }
  });

  it('最终数据库校验与账本推进之间不能插入额外操作', () => {
    const root = fixtureRoot('migration-assert-record-adjacency');
    const path = join(root, 'ai-pm.sqlite');
    const operations: MigrationOperation[] = [...BASELINE_MIGRATION_DESCRIPTOR.orderedOperations];
    operations.splice(-1, 0, { id: 'after-final-assertion', kind: 'sql_batch', statements: ['SELECT 1;'] });
    const descriptor = { ...BASELINE_MIGRATION_DESCRIPTOR, orderedOperations: operations } as MigrationDescriptor;
    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: descriptor }))
      .toThrowError(expect.objectContaining({ stage: 'migration' }));
    const unchanged = openReadOnly(path);
    try {
      expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all())
        .toEqual([]);
    } finally {
      unchanged.close();
    }
  });

  it('canonical schema 身份由传入 payload 驱动，schema 漂移不会推进账本或版本', () => {
    const root = fixtureRoot('migration-descriptor-schema-identity');
    const path = join(root, 'ai-pm.sqlite');
    const operations: MigrationOperation[] = [...BASELINE_MIGRATION_DESCRIPTOR.orderedOperations];
    const schemaIndex = operations.findIndex((operation) => operation.id === 'apply-schema');
    const schemaOperation = operations[schemaIndex]!;
    if (schemaOperation.kind !== 'sql_batch') throw new Error('schema operation fixture missing');
    operations[schemaIndex] = {
      ...schemaOperation,
      statements: [...schemaOperation.statements, 'CREATE TABLE unexpected_payload_table (id TEXT PRIMARY KEY);'],
    };
    const changed = { ...BASELINE_MIGRATION_DESCRIPTOR, orderedOperations: operations } as MigrationDescriptor;

    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: changed }))
      .toThrowError(expect.objectContaining({ stage: 'migration' }));
    const unchanged = openReadOnly(path);
    try {
      expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all())
        .toEqual([]);
    } finally {
      unchanged.close();
    }
  });

  it('同版本同名称的迁移 payload 改变时现有账本 fail-closed', () => {
    const root = fixtureRoot('migration-descriptor-ledger-drift');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();
    const operations: MigrationOperation[] = [...BASELINE_MIGRATION_DESCRIPTOR.orderedOperations];
    const postIndex = operations.findIndex((operation) => operation.id === 'create-indexes-and-constraints');
    const post = operations[postIndex]!;
    if (post.kind !== 'sql_batch') throw new Error('post operation fixture missing');
    operations[postIndex] = { ...post, statements: [...post.statements, 'SELECT 1;'] };
    const changed = { ...BASELINE_MIGRATION_DESCRIPTOR, orderedOperations: operations } as MigrationDescriptor;
    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: changed }))
      .toThrowError(expect.objectContaining({ stage: 'ledger' }));
  });

  it('N-1 旧库升级到当前版本，记录 checksum、创建可校验备份并保留旧数据', () => {
    const root = fixtureRoot('migration-upgrade');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);

    const database = new AppDatabase(path, false, { now: fixedNow });
    try {
      expect(database.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      expect(database.raw.prepare(
        'SELECT version, name, length(checksum) AS checksum_length FROM schema_migration ORDER BY version DESC LIMIT 1',
      ).get()).toEqual({
        version: CURRENT_SCHEMA_VERSION,
        name: 'run-02-provider-retry-cooldown',
        checksum_length: 64,
      });
      expect(database.raw.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_retry_cooldown'",
      ).get()).toEqual({ name: 'provider_retry_cooldown' });
      expect(database.raw.prepare('SELECT title, describe FROM task WHERE id = ?').get('legacy-task')).toEqual({
        title: '旧任务',
        describe: '必须保留的历史内容',
      });
    } finally {
      database.close();
    }

    const backups = managedBackups(root);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^ai-pm\.sqlite\.backup-v0-to-v8-20260815T010203004Z-[a-f0-9]{32}\.sqlite$/u);
    expect(existsSync(join(root, 'backups', `${backups[0]}.manifest.json`))).toBe(true);
    const backup = openReadOnly(join(root, 'backups', backups[0]!));
    try {
      expect(backup.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
      expect(backup.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get()).toEqual({ title: '旧任务' });
      const backupIdentity = backup.prepare(
        'SELECT database_instance_id FROM database_metadata WHERE singleton_key = 1',
      ).get();
      const current = openReadOnly(path);
      try {
        const currentIdentity = current.prepare(
          'SELECT database_instance_id FROM database_metadata WHERE singleton_key = 1',
        ).get();
        const manifest = JSON.parse(readFileSync(join(root, 'backups', `${backups[0]}.manifest.json`), 'utf8')) as {
          database_instance_id: string;
        };
        expect(backupIdentity).toEqual(currentIdentity);
        expect(manifest.database_instance_id).toBe((currentIdentity as { database_instance_id: string }).database_instance_id);
      } finally {
        current.close();
      }
    } finally {
      backup.close();
    }
  });

  it('schema v7 连续升级到 RUN-02 v8 并持久化 provider cooldown 表', () => {
    const root = fixtureRoot('migration-v7-to-v8-cooldown');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();

    const v7 = new DatabaseSync(path);
    try {
      v7.exec(`
        DROP INDEX idx_provider_retry_cooldown_retry_at;
        DROP TABLE provider_retry_cooldown;
        DELETE FROM schema_migration WHERE version = 8;
        PRAGMA user_version = 7;
      `);
    } finally {
      v7.close();
    }

    const migrated = new AppDatabase(path, false, { now: fixedNow });
    try {
      expect(migrated.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
      expect(migrated.raw.prepare(
        'SELECT name, checksum FROM schema_migration WHERE version = 8',
      ).get()).toEqual({
        name: 'run-02-provider-retry-cooldown',
        checksum: PROVIDER_RETRY_COOLDOWN_MIGRATION_CHECKSUM,
      });
      expect(migrated.raw.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_retry_cooldown'",
      ).get()).toEqual({ name: 'provider_retry_cooldown' });
    } finally {
      migrated.close();
    }
  });

  it('重复启动不会重复迁移或创建额外备份', () => {
    const root = fixtureRoot('migration-repeat');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);

    const first = new AppDatabase(path, false, { now: fixedNow });
    first.close();
    const firstBackups = managedBackups(root);
    const second = new AppDatabase(path, false, { now: fixedNow });
    try {
      expect(second.raw.prepare('SELECT COUNT(*) AS count FROM schema_migration').get()).toEqual({ count: CURRENT_SCHEMA_VERSION });
      expect(second.raw.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get()).toEqual({ title: '旧任务' });
    } finally {
      second.close();
    }
    expect(managedBackups(root)).toEqual(firstBackups);
  });

  it('历史 v0 关键约束漂移时在备份和迁移前拒绝，且保留数据', () => {
    const root = fixtureRoot('migration-canonical-rebuild');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.raw.prepare(`INSERT INTO approval
      (id, task_id, action_type, payload_json, status, created_at, decided_at)
      VALUES ('approval-legacy', NULL, 'synthetic', '{}', 'approved', '2026-08-15T00:00:00.000Z', NULL)`).run();
    current.raw.prepare(`INSERT INTO outbox
      (id, approval_id, action_type, payload_json, status, idempotency_key, created_at, sent_at)
      VALUES ('outbox-legacy', 'approval-legacy', 'synthetic', '{}', 'ready', 'legacy-key',
              '2026-08-15T00:00:00.000Z', NULL)`).run();
    current.raw.prepare(`INSERT INTO app_log
      (id, category, level, event_type, summary, context_json, created_at)
      VALUES ('log-legacy', 'synthetic', 'info', 'migration', '合成迁移日志', '{}',
              '2026-08-15T00:00:00.000Z')`).run();
    current.close();

    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`PRAGMA foreign_keys = OFF;
        DROP TABLE schema_migration;
        PRAGMA user_version = 0;
        CREATE TABLE app_log_legacy (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          level TEXT NOT NULL,
          event_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          context_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO app_log_legacy SELECT * FROM app_log;
        DROP TABLE app_log;
        ALTER TABLE app_log_legacy RENAME TO app_log;
        CREATE TABLE outbox_legacy (
          id TEXT PRIMARY KEY,
          approval_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('awaiting_approval','ready','sent','failed')),
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );
        INSERT INTO outbox_legacy SELECT * FROM outbox;
        DROP TABLE outbox;
        ALTER TABLE outbox_legacy RENAME TO outbox;`);
    } finally {
      legacy.close();
    }

    expect(() => new AppDatabase(path, false, { now: fixedNow })).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT level FROM app_log WHERE id = 'log-legacy'").get()).toEqual({ level: 'info' });
      expect(preserved.prepare("SELECT idempotency_key FROM outbox WHERE id = 'outbox-legacy'").get())
        .toEqual({ idempotency_key: 'legacy-key' });
      expect(preserved.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
    } finally {
      preserved.close();
    }
    expect(managedBackups(root)).toHaveLength(0);
  });

  it.each([
    ['app_log CHECK', `PRAGMA foreign_keys = OFF;
      ALTER TABLE app_log RENAME TO app_log_original;
      CREATE TABLE app_log (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        level TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        context_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO app_log SELECT * FROM app_log_original;
      DROP TABLE app_log_original;
      CREATE INDEX idx_app_log_created ON app_log(created_at DESC);`],
    ['outbox idempotency auto UNIQUE', `PRAGMA foreign_keys = OFF;
      ALTER TABLE outbox RENAME TO outbox_original;
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL REFERENCES approval(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('awaiting_approval','ready','sent','failed')),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      INSERT INTO outbox SELECT * FROM outbox_original;
      DROP TABLE outbox_original;`],
  ])('历史 v0 的 %s 单独漂移时 fail-closed', (_label, mutation) => {
    const root = fixtureRoot('migration-legacy-isolated-constraint-drift');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(mutation);
    } finally {
      legacy.close();
    }
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it('旧版约束漂移含非法数据时不删行并恢复升级前数据库', () => {
    const root = fixtureRoot('migration-canonical-rebuild-invalid-data');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`PRAGMA foreign_keys = OFF;
        DROP TABLE schema_migration;
        PRAGMA user_version = 0;
        CREATE TABLE app_log_legacy (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          level TEXT NOT NULL,
          event_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          context_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO app_log_legacy
          (id, category, level, event_type, summary, context_json, created_at)
        VALUES ('log-invalid', 'synthetic', 'debug', 'migration', '合成非法旧值', '{}',
                '2026-08-15T00:00:00.000Z');
        DROP TABLE app_log;
        ALTER TABLE app_log_legacy RENAME TO app_log;`);
    } finally {
      legacy.close();
    }

    expect(() => new AppDatabase(path, false, { now: fixedNow })).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
    const restored = openReadOnly(path);
    try {
      expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(restored.prepare("SELECT level FROM app_log WHERE id = 'log-invalid'").get()).toEqual({ level: 'debug' });
      expect(restored.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      restored.close();
    }
    expect(managedBackups(root)).toHaveLength(0);
  });

  it('迁移冲突不会静默删除关系，并自动恢复升级前数据库', () => {
    const root = fixtureRoot('migration-conflict');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();

    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`PRAGMA foreign_keys = OFF;
        DROP INDEX idx_requirement_thread_unit_unique;
        DROP TABLE schema_migration;
        PRAGMA user_version = 0;
        INSERT INTO source_event
          (id, external_id, source_type, conversation_id, sender_id, sender_name, content,
           owner_mentioned, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
        VALUES
          ('source-conflict', 'external-conflict', 'message', 'conversation', 'sender', '需求方',
           '合成冲突来源', 0, 'complete', 'synthetic', '{}', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO source_demand_unit
          (id, anchor_source_event_id, unit_key, unit_kind, state, created_at, updated_at)
        VALUES
          ('demand-shared', 'source-conflict', 'shared', 'demand', 'ready',
           '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO requirement_thread
          (id, status, title, created_at, updated_at)
        VALUES
          ('thread-a', 'open', '线程 A', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
          ('thread-b', 'open', '线程 B', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO requirement_thread_unit
          (thread_id, demand_unit_id, relation_type, confidence, evidence_json, created_at)
        VALUES
          ('thread-a', 'demand-shared', 'new_demand', 0.9, '[]', '2026-08-10T00:00:00.000Z'),
          ('thread-b', 'demand-shared', 'update_existing', 0.8, '[]', '2026-08-10T00:00:01.000Z');`);
    } finally {
      legacy.close();
    }

    expect(() => new AppDatabase(path, false, { now: fixedNow })).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
    const restored = openReadOnly(path);
    try {
      expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(restored.prepare("SELECT COUNT(*) AS count FROM requirement_thread_unit WHERE demand_unit_id = 'demand-shared'").get())
        .toEqual({ count: 2 });
      expect(restored.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      restored.close();
    }
    expect(managedBackups(root)).toHaveLength(0);
  });

  it('历史 checkpoint 中同一候选的双 current 修订会整事务失败并从备份原样恢复', () => {
    const root = fixtureRoot('migration-candidate-revision-conflict');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`PRAGMA foreign_keys = ON;
        DROP INDEX idx_candidate_revision_current;
        DROP INDEX idx_task_update_auto;
        DROP INDEX idx_owner_decision_source;
        DROP INDEX idx_owner_decision_state;
        INSERT INTO source_event
          (id, external_id, source_type, conversation_id, sender_id, sender_name, content,
           owner_mentioned, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
        VALUES
          ('source-revision-conflict', 'external-revision-conflict', 'message', 'conversation',
           'sender', '需求方', '合成候选修订冲突', 0, 'complete', 'synthetic', '{}',
           '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO candidate_request
          (id, source_event_id, title, proposer_name, background, validation_question, describe,
           confidence, state, created_at, updated_at)
        VALUES
          ('candidate-revision-conflict', 'source-revision-conflict', '冲突候选', '需求方',
           '背景', '验证问题', '描述', 0.8, 'pending',
           '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO candidate_revision
          (id, candidate_id, source_event_id, source_revision, title, proposer_name, background,
           validation_question, describe, confidence, provider, model, prompt_version, state, created_at)
        VALUES
          ('revision-current-a', 'candidate-revision-conflict', 'source-revision-conflict', 'r1',
           '修订 A', '需求方', '背景 A', '验证 A', '描述 A', 0.8, 'synthetic', 'fixture', 'v1',
           'current', '2026-08-10T00:00:00.000Z'),
          ('revision-current-b', 'candidate-revision-conflict', 'source-revision-conflict', 'r2',
           '修订 B', '需求方', '背景 B', '验证 B', '描述 B', 0.9, 'synthetic', 'fixture', 'v1',
           'current', '2026-08-10T00:00:01.000Z');`);
    } finally {
      legacy.close();
    }

    expect(() => new AppDatabase(path, false, { now: fixedNow })).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'migration',
    }));

    const backups = managedBackups(root);
    expect(backups).toHaveLength(1);
    const backupPath = join(root, 'backups', backups[0]!);
    const manifest = JSON.parse(readFileSync(`${backupPath}.manifest.json`, 'utf8')) as {
      database_instance_id: string;
      sha256: string;
    };
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(manifest.sha256);
    const restored = openReadOnly(path);
    try {
      expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(restored.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
      expect(restored.prepare(
        `SELECT id, source_revision, title, describe, state
         FROM candidate_revision WHERE candidate_id = ? ORDER BY id`,
      ).all('candidate-revision-conflict')).toEqual([
        { id: 'revision-current-a', source_revision: 'r1', title: '修订 A', describe: '描述 A', state: 'current' },
        { id: 'revision-current-b', source_revision: 'r2', title: '修订 B', describe: '描述 B', state: 'current' },
      ]);
      expect(restored.prepare(
        'SELECT database_instance_id FROM database_metadata WHERE singleton_key = 1',
      ).get()).toEqual({ database_instance_id: manifest.database_instance_id });
    } finally {
      restored.close();
    }
  });

  it.each([
    ['生成 unit ID', 'id'],
    ['生成 unit_key', 'key'],
  ] as const)('%s 碰撞时迁移失败且不复用既有需求单元', (_label, collisionKind) => {
    const root = fixtureRoot(`migration-demand-unit-${collisionKind}-collision`);
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content,
         owner_mentioned, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
        VALUES
        ('source-collision', 'external-collision', 'message', 'conversation', 'sender', '需求方',
         '合成碰撞候选', 0, 'complete', 'synthetic', '{}',
         '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
        ('source-existing', 'external-existing', 'message', 'conversation', 'sender', '需求方',
         '合成既有需求单元', 0, 'complete', 'synthetic', '{}',
         '2026-08-10T00:00:01.000Z', '2026-08-10T00:00:01.000Z');
        INSERT INTO candidate_request
          (id, source_event_id, title, proposer_name, background, validation_question, describe,
           confidence, state, created_at, updated_at)
        VALUES
          ('candidate-collision', 'source-collision', '碰撞候选', '需求方', '背景', '验证问题', '描述',
           0.8, 'pending', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');`);
      if (collisionKind === 'id') {
        legacy.exec(`INSERT INTO source_demand_unit
          (id, anchor_source_event_id, unit_key, unit_kind, state, analysis_json, reason, created_at, updated_at)
          VALUES ('unit_legacy_candidate-collision', 'source-existing', 'existing-key', 'demand', 'ready',
                  '{"owner":"existing"}', '既有单元不得被复用',
                  '2026-08-10T00:00:01.000Z', '2026-08-10T00:00:01.000Z');
          INSERT INTO source_demand_unit_source
            (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
          VALUES ('unit_legacy_candidate-collision', 'source-existing', 's1', 'anchor', 0,
                  '2026-08-10T00:00:01.000Z');`);
      } else {
        legacy.exec(`INSERT INTO source_demand_unit
          (id, anchor_source_event_id, unit_key, unit_kind, state, analysis_json, reason, created_at, updated_at)
          VALUES ('existing-unit-key', 'source-collision', 'legacy:candidate-collision', 'demand', 'ready',
                  '{"owner":"existing"}', '既有 key 不得被复用',
                  '2026-08-10T00:00:01.000Z', '2026-08-10T00:00:01.000Z');`);
      }
    } finally {
      legacy.close();
    }

    expect(() => new AppDatabase(path, false, { now: fixedNow })).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'migration',
    }));
    expect(managedBackups(root)).toHaveLength(1);
    const restored = openReadOnly(path);
    try {
      expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(restored.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
      expect(restored.prepare(
        "SELECT demand_unit_id FROM candidate_request WHERE id = 'candidate-collision'",
      ).get()).toEqual({ demand_unit_id: null });
      expect(restored.prepare(
        `SELECT id, anchor_source_event_id, unit_key, analysis_json, reason FROM source_demand_unit ORDER BY id`,
      ).all()).toEqual(collisionKind === 'id' ? [{
        id: 'unit_legacy_candidate-collision',
        anchor_source_event_id: 'source-existing',
        unit_key: 'existing-key',
        analysis_json: '{"owner":"existing"}',
        reason: '既有单元不得被复用',
      }] : [{
        id: 'existing-unit-key',
        anchor_source_event_id: 'source-collision',
        unit_key: 'legacy:candidate-collision',
        analysis_json: '{"owner":"existing"}',
        reason: '既有 key 不得被复用',
      }]);
      if (collisionKind === 'id') {
        expect(restored.prepare(
          'SELECT demand_unit_id, source_event_id, source_key FROM source_demand_unit_source',
        ).all()).toEqual([{
          demand_unit_id: 'unit_legacy_candidate-collision',
          source_event_id: 'source-existing',
          source_key: 's1',
        }]);
      }
    } finally {
      restored.close();
    }
  });

  it('既有 requirement_thread_unit 冲突时普通 INSERT 失败且关系逐值保留', () => {
    const root = fixtureRoot('migration-thread-unit-collision');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content,
         owner_mentioned, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
        VALUES ('source-thread-collision', 'external-thread-collision', 'message', 'conversation', 'sender', '需求方',
                '合成线程关系碰撞', 0, 'complete', 'synthetic', '{}',
                '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO source_demand_unit
          (id, anchor_source_event_id, unit_key, unit_kind, state, created_at, updated_at)
        VALUES ('existing-thread-unit', 'source-thread-collision', 'existing', 'demand', 'ready',
                '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO candidate_request
          (id, source_event_id, demand_unit_id, title, proposer_name, background, validation_question, describe,
           confidence, state, created_at, updated_at)
        VALUES ('candidate-thread-collision', 'source-thread-collision', 'existing-thread-unit', '碰撞候选',
                '需求方', '背景', '验证问题', '描述', 0.8, 'pending',
                '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO requirement_thread (id, status, title, created_at, updated_at)
        VALUES ('thread-collision', 'open', '碰撞线程', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO requirement_thread_source
          (thread_id, source_event_id, relation_type, confidence, evidence_json, created_at)
        VALUES ('thread-collision', 'source-thread-collision', 'new_demand', 0.9, '["original"]',
                '2026-08-10T00:00:00.000Z');
        INSERT INTO requirement_thread_unit
          (thread_id, demand_unit_id, relation_type, confidence, evidence_json, created_at)
        VALUES ('thread-collision', 'existing-thread-unit', 'update_existing', 0.7, '["preserve"]',
                '2026-08-10T00:00:01.000Z');`);
    } finally {
      legacy.close();
    }

    expect(() => new AppDatabase(path, false, { now: fixedNow })).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'migration',
    }));
    expect(managedBackups(root)).toHaveLength(1);
    const restored = openReadOnly(path);
    try {
      expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(restored.prepare(
        `SELECT thread_id, demand_unit_id, relation_type, confidence, evidence_json, created_at
         FROM requirement_thread_unit`,
      ).all()).toEqual([{
        thread_id: 'thread-collision',
        demand_unit_id: 'existing-thread-unit',
        relation_type: 'update_existing',
        confidence: 0.7,
        evidence_json: '["preserve"]',
        created_at: '2026-08-10T00:00:01.000Z',
      }]);
    } finally {
      restored.close();
    }
  });

  it('共享 source_event 的多个候选各自生成需求单元且不误关联来源专属记录', () => {
    const root = fixtureRoot('migration-ambiguous-source-candidates');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content,
         owner_mentioned, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
        VALUES ('source-ambiguous', 'external-ambiguous', 'message', 'conversation', 'sender', '需求方',
                '合成多候选来源', 0, 'complete', 'synthetic', '{}',
                '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO candidate_request
          (id, source_event_id, title, proposer_name, background, validation_question, describe,
           confidence, state, created_at, updated_at)
        VALUES
          ('candidate-ambiguous-a', 'source-ambiguous', '候选 A', '需求方', '背景 A', '验证 A', '描述 A',
           0.8, 'pending', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
          ('candidate-ambiguous-b', 'source-ambiguous', '候选 B', '需求方', '背景 B', '验证 B', '描述 B',
           0.7, 'pending', '2026-08-10T00:00:01.000Z', '2026-08-10T00:00:01.000Z');
        INSERT INTO requirement_thread
          (id, status, title, created_at, updated_at)
        VALUES ('thread-ambiguous', 'open', '共享来源线程', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO requirement_thread_source
          (thread_id, source_event_id, relation_type, confidence, evidence_json, created_at)
        VALUES ('thread-ambiguous', 'source-ambiguous', 'new_demand', 0.8, '["shared"]', '2026-08-10T00:00:00.000Z');
        INSERT INTO candidate_revision
          (id, candidate_id, source_event_id, source_revision, title, proposer_name, background,
           validation_question, describe, confidence, provider, model, prompt_version, state, created_at)
        VALUES
          ('revision-ambiguous-a', 'candidate-ambiguous-a', 'source-ambiguous', 'r1', '候选 A 修订', '需求方', '背景 A',
           '验证 A', '描述 A', 0.8, 'synthetic', 'fixture', 'v1', 'current', '2026-08-10T00:00:00.000Z'),
          ('revision-ambiguous-b', 'candidate-ambiguous-b', 'source-ambiguous', 'r1', '候选 B 修订', '需求方', '背景 B',
           '验证 B', '描述 B', 0.7, 'synthetic', 'fixture', 'v1', 'current', '2026-08-10T00:00:00.000Z');
        INSERT INTO ai_decision_log
          (id, source_event_id, candidate_id, provider, model, prompt_version, is_data_request,
           confidence, reason, output_json, latency_ms, created_at)
        VALUES ('decision-ambiguous-a', 'source-ambiguous', 'candidate-ambiguous-a', 'synthetic', 'fixture', 'v1', 1,
                0.8, '合成判断', '{}', 1, '2026-08-10T00:00:00.000Z');
        INSERT INTO requirement_thread_revision
          (id, thread_id, source_event_id, base_thread_version, patch_json, evidence_json,
           idempotency_key, created_at)
        VALUES ('thread-revision-ambiguous', 'thread-ambiguous', 'source-ambiguous', 1, '{}', '[]',
                'thread-revision-ambiguous-key', '2026-08-10T00:00:00.000Z');
        INSERT INTO task_update_proposal
          (id, task_id, thread_id, source_event_id, candidate_revision_id, base_task_version,
           patch_json, reason, evidence_json, idempotency_key, created_at)
        VALUES
          ('proposal-candidate-ambiguous', 'legacy-task', 'thread-ambiguous', 'source-ambiguous',
           'revision-ambiguous-b', 1, '{}', '候选专属提议', '[]', 'proposal-candidate-ambiguous-key', '2026-08-10T00:00:00.000Z'),
          ('proposal-source-ambiguous', 'legacy-task', 'thread-ambiguous', 'source-ambiguous',
           NULL, 1, '{}', '来源专属提议无法唯一归属', '[]', 'proposal-source-ambiguous-key', '2026-08-10T00:00:00.000Z');`);
    } finally {
      legacy.close();
    }

    const before = businessRowHashes(path);
    const migrated = new AppDatabase(path, false, { now: fixedNow });
    expect(managedBackups(root)).toHaveLength(1);
    try {
      expect(migrated.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      expect(migrated.raw.prepare('SELECT version FROM schema_migration').get()).toEqual({ version: 1 });
      expect(migrated.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
      expect(migrated.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(migrated.raw.prepare(
        'SELECT id, demand_unit_id FROM candidate_request WHERE source_event_id = ? ORDER BY id',
      ).all('source-ambiguous')).toEqual([
        { id: 'candidate-ambiguous-a', demand_unit_id: 'unit_legacy_candidate-ambiguous-a' },
        { id: 'candidate-ambiguous-b', demand_unit_id: 'unit_legacy_candidate-ambiguous-b' },
      ]);
      expect(migrated.raw.prepare(
        'SELECT demand_unit_id, source_event_id FROM source_demand_unit_source WHERE source_event_id = ? ORDER BY demand_unit_id',
      ).all('source-ambiguous')).toEqual([
        { demand_unit_id: 'unit_legacy_candidate-ambiguous-a', source_event_id: 'source-ambiguous' },
        { demand_unit_id: 'unit_legacy_candidate-ambiguous-b', source_event_id: 'source-ambiguous' },
      ]);
      expect(migrated.raw.prepare(
        'SELECT candidate_id, demand_unit_id FROM candidate_revision WHERE candidate_id LIKE ? ORDER BY candidate_id',
      ).all('candidate-ambiguous-%')).toEqual([
        { candidate_id: 'candidate-ambiguous-a', demand_unit_id: 'unit_legacy_candidate-ambiguous-a' },
        { candidate_id: 'candidate-ambiguous-b', demand_unit_id: 'unit_legacy_candidate-ambiguous-b' },
      ]);
      expect(migrated.raw.prepare(
        'SELECT candidate_id, demand_unit_id FROM ai_decision_log WHERE candidate_id = ?',
      ).get('candidate-ambiguous-a')).toEqual({
        candidate_id: 'candidate-ambiguous-a',
        demand_unit_id: 'unit_legacy_candidate-ambiguous-a',
      });
      expect(migrated.raw.prepare(
        'SELECT demand_unit_id FROM requirement_thread_revision WHERE id = ?',
      ).get('thread-revision-ambiguous')).toEqual({ demand_unit_id: null });
      expect(migrated.raw.prepare(
        'SELECT id, demand_unit_id FROM task_update_proposal WHERE id LIKE ? ORDER BY id',
      ).all('proposal-%')).toEqual([
        { id: 'proposal-candidate-ambiguous', demand_unit_id: 'unit_legacy_candidate-ambiguous-b' },
        { id: 'proposal-source-ambiguous', demand_unit_id: null },
      ]);
      expect(migrated.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread_unit WHERE thread_id = ?').get('thread-ambiguous'))
        .toEqual({ count: 0 });
      expect(businessRowHashes(path)).toEqual(before);
    } finally {
      migrated.close();
    }
  });

  it('多个共享 source_event 组可完整迁移且每个候选保持独立关联', () => {
    const root = fixtureRoot('migration-many-shared-source-candidates');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      const insertSource = legacy.prepare(`INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content,
         owner_mentioned, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
        VALUES (?, ?, 'message', 'conversation', 'sender', '需求方', ?, 0, 'complete', 'synthetic', '{}', ?, ?)`);
      const insertCandidate = legacy.prepare(`INSERT INTO candidate_request
        (id, source_event_id, title, proposer_name, background, validation_question, describe,
         confidence, state, created_at, updated_at)
        VALUES (?, ?, ?, '需求方', ?, ?, ?, ?, 'pending', ?, ?)`);
      const insertThread = legacy.prepare(`INSERT INTO requirement_thread
        (id, status, title, created_at, updated_at)
        VALUES (?, 'open', ?, ?, ?)`);
      const insertThreadSource = legacy.prepare(`INSERT INTO requirement_thread_source
        (thread_id, source_event_id, relation_type, confidence, evidence_json, created_at)
        VALUES (?, ?, 'new_demand', 0.8, '["shared"]', ?)`);
      const insertRevision = legacy.prepare(`INSERT INTO candidate_revision
        (id, candidate_id, source_event_id, source_revision, title, proposer_name, background,
         validation_question, describe, confidence, provider, model, prompt_version, state, created_at)
        VALUES (?, ?, ?, 'r1', ?, '需求方', ?, ?, ?, ?, 'synthetic', 'fixture', 'v1', 'current', ?)`);
      const insertDecision = legacy.prepare(`INSERT INTO ai_decision_log
        (id, source_event_id, candidate_id, provider, model, prompt_version, is_data_request,
         confidence, reason, output_json, latency_ms, created_at)
        VALUES (?, ?, ?, 'synthetic', 'fixture', 'v1', 1, 0.8, '合成判断', '{}', 1, ?)`);
      const insertThreadRevision = legacy.prepare(`INSERT INTO requirement_thread_revision
        (id, thread_id, source_event_id, base_thread_version, patch_json, evidence_json,
         idempotency_key, created_at)
        VALUES (?, ?, ?, 1, '{}', '[]', ?, ?)`);
      const insertProposal = legacy.prepare(`INSERT INTO task_update_proposal
        (id, task_id, thread_id, source_event_id, candidate_revision_id, base_task_version,
         patch_json, reason, evidence_json, idempotency_key, created_at)
        VALUES (?, 'legacy-task', ?, ?, ?, 1, '{}', ?, '[]', ?, ?)`);

      const groupCount = 6;
      const candidatesPerGroup = 4;
      for (let group = 0; group < groupCount; group += 1) {
        const sourceId = `source-many-${group}`;
        const timestamp = `2026-08-10T00:${String(group).padStart(2, '0')}:00.000Z`;
        insertSource.run(sourceId, `external-many-${group}`, `合成共享来源 ${group}`, timestamp, timestamp);
        const threadId = `thread-many-${group}`;
        insertThread.run(threadId, `共享来源线程 ${group}`, timestamp, timestamp);
        insertThreadSource.run(threadId, sourceId, timestamp);
        insertThreadRevision.run(`thread-revision-many-${group}`, threadId, sourceId, `thread-revision-many-${group}`, timestamp);
        insertProposal.run(
          `proposal-source-many-${group}`,
          threadId,
          sourceId,
          null,
          '来源专属提议保持未分配',
          `proposal-source-many-${group}`,
          timestamp,
        );
        for (let candidateIndex = 0; candidateIndex < candidatesPerGroup; candidateIndex += 1) {
          const candidateId = `candidate-many-${group}-${candidateIndex}`;
          const revisionId = `revision-many-${group}-${candidateIndex}`;
          const createdAt = `2026-08-10T00:${String(group).padStart(2, '0')}:${String(candidateIndex).padStart(2, '0')}.000Z`;
          insertCandidate.run(
            candidateId,
            sourceId,
            `候选 ${group}-${candidateIndex}`,
            `背景 ${group}-${candidateIndex}`,
            `验证 ${group}-${candidateIndex}`,
            `描述 ${group}-${candidateIndex}`,
            0.7 + candidateIndex / 100,
            createdAt,
            createdAt,
          );
          insertRevision.run(
            revisionId,
            candidateId,
            sourceId,
            `候选修订 ${group}-${candidateIndex}`,
            `背景 ${group}-${candidateIndex}`,
            `验证 ${group}-${candidateIndex}`,
            `描述 ${group}-${candidateIndex}`,
            0.7 + candidateIndex / 100,
            createdAt,
          );
          insertDecision.run(`decision-many-${group}-${candidateIndex}`, sourceId, candidateId, createdAt);
          insertProposal.run(
            `proposal-candidate-many-${group}-${candidateIndex}`,
            threadId,
            sourceId,
            revisionId,
            '候选专属提议',
            `proposal-candidate-many-${group}-${candidateIndex}`,
            createdAt,
          );
        }
      }
    } finally {
      legacy.close();
    }

    const before = businessRowHashes(path);
    const migrated = new AppDatabase(path, false, { now: fixedNow });
    try {
      expect(migrated.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 24 });
      expect(migrated.raw.prepare('SELECT COUNT(*) AS count FROM source_demand_unit').get()).toEqual({ count: 24 });
      expect(migrated.raw.prepare('SELECT COUNT(*) AS count FROM source_demand_unit_source').get()).toEqual({ count: 24 });
      expect(migrated.raw.prepare(
        `SELECT COUNT(*) AS count
           FROM candidate_request
           JOIN source_demand_unit_source
             ON source_demand_unit_source.demand_unit_id = candidate_request.demand_unit_id
          WHERE source_demand_unit_source.source_event_id <> candidate_request.source_event_id`,
      ).get()).toEqual({ count: 0 });
      expect(migrated.raw.prepare(
        `SELECT COUNT(*) AS count
           FROM candidate_request
           JOIN candidate_revision ON candidate_revision.candidate_id = candidate_request.id
          WHERE candidate_request.demand_unit_id <> candidate_revision.demand_unit_id`,
      ).get()).toEqual({ count: 0 });
      expect(migrated.raw.prepare(
        `SELECT COUNT(*) AS count
           FROM candidate_request
           JOIN ai_decision_log ON ai_decision_log.candidate_id = candidate_request.id
          WHERE candidate_request.demand_unit_id <> ai_decision_log.demand_unit_id`,
      ).get()).toEqual({ count: 0 });
      expect(migrated.raw.prepare(
        `SELECT COUNT(*) AS count
           FROM requirement_thread_revision
          WHERE demand_unit_id IS NOT NULL`,
      ).get()).toEqual({ count: 0 });
      expect(migrated.raw.prepare(
        `SELECT COUNT(*) AS count
           FROM task_update_proposal
          WHERE reason = '来源专属提议保持未分配' AND demand_unit_id IS NOT NULL`,
      ).get()).toEqual({ count: 0 });
      expect(migrated.raw.prepare('SELECT COUNT(*) AS count FROM task_update_proposal WHERE candidate_revision_id IS NOT NULL AND demand_unit_id IS NOT NULL').get())
        .toEqual({ count: 24 });
      expect(migrated.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      expect(migrated.raw.prepare('SELECT version FROM schema_migration').get()).toEqual({ version: 1 });
      expect(migrated.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
      expect(migrated.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(businessRowHashes(path)).toEqual(before);
    } finally {
      migrated.close();
    }
  }, 20_000);

  it('合法 raw v0 在受管备份建立后发生中途 operation 失败时自动完整恢复', () => {
    const root = fixtureRoot('migration-post-backup-operation-failure');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const operations: MigrationOperation[] = [...BASELINE_MIGRATION_DESCRIPTOR.orderedOperations];
    operations.splice(4, 0, {
      id: 'synthetic-post-backup-failure',
      kind: 'sql_batch',
      statements: ["INSERT INTO table_that_does_not_exist VALUES ('token-secret-canary')"],
    });
    const descriptor = { ...BASELINE_MIGRATION_DESCRIPTOR, orderedOperations: operations } as MigrationDescriptor;

    let caught: unknown;
    try {
      new AppDatabase(path, false, { now: fixedNow, migrationDescriptorForTest: descriptor });
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining({ name: 'DatabaseUpgradeError', stage: 'migration' }));
    expect(JSON.stringify(caught)).not.toContain(root);
    expect(JSON.stringify(caught)).not.toContain('token-secret-canary');
    expect((caught as Error | undefined)?.cause).toBeUndefined();

    const backups = managedBackups(root);
    expect(backups).toHaveLength(1);
    const backupPath = join(root, 'backups', backups[0]!);
    expect(existsSync(`${backupPath}.manifest.json`)).toBe(true);
    expect(databaseContentsSnapshot(path)).toEqual(databaseContentsSnapshot(backupPath));
    const restored = openReadOnly(path);
    try {
      expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(restored.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
      expect(restored.prepare("SELECT title, describe FROM task WHERE id = 'legacy-task'").get()).toEqual({
        title: '旧任务',
        describe: '必须保留的历史内容',
      });
    } finally {
      restored.close();
    }
    expect(readdirSync(root).filter((name) => name.includes('.restore-'))).toEqual([]);
    expect(readdirSync(join(root, 'backups')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('迁移 payload 与 generic interpreter 不包含静默选留写法', () => {
    const source = readFileSync(new URL('../src/database.ts', import.meta.url), 'utf8');
    const migrationLogic = source.split('// MIGRATION_V1_LOGIC_START')[1]?.split('// MIGRATION_V1_LOGIC_END')[0] ?? '';
    expect(migrationLogic).not.toBe('');
    for (const forbidden of [
      /INSERT\s+OR\s+IGNORE/iu,
      /INSERT\s+OR\s+REPLACE/iu,
      /MAX\s*\(\s*rowid\s*\)/iu,
      /MIN\s*\(\s*rowid\s*\)/iu,
      /UPDATE[\s\S]*?superseded[\s\S]*?(?:MAX|MIN)\s*\(/iu,
    ]) {
      expect(migrationLogic).not.toMatch(forbidden);
    }
  });

  it('只有启动前不存在的路径可作为全新数据库初始化', () => {
    const root = fixtureRoot('migration-fresh-path');
    const path = join(root, 'data', 'ai-pm.sqlite');
    expect(existsSync(path)).toBe(false);
    const database = new AppDatabase(path, false);
    try {
      expect(database.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM schema_migration').get()).toEqual({ count: CURRENT_SCHEMA_VERSION });
    } finally {
      database.close();
    }
  });

  it('已存在的零字节文件不会被当作全新数据库初始化', () => {
    const root = fixtureRoot('migration-existing-zero-byte');
    const path = join(root, 'ai-pm.sqlite');
    writeFileSync(path, '');
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
    expect(readFileSync(path)).toHaveLength(0);
  });

  it('不含已知应用表的异构 SQLite 不会被当作历史 v0 启动迁移', () => {
    const root = fixtureRoot('migration-unrelated');
    const path = join(root, 'ai-pm.sqlite');
    const unrelated = new DatabaseSync(path);
    unrelated.exec('CREATE TABLE unrelated_record (id TEXT PRIMARY KEY);');
    unrelated.close();

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'unrelated_record'").get())
        .toEqual({ name: 'unrelated_record' });
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it('只有已知表名但缺少历史必要字段的 SQLite 不写入迁移账本', () => {
    const root = fixtureRoot('migration-incomplete-known-table');
    const path = join(root, 'ai-pm.sqlite');
    const incomplete = new DatabaseSync(path);
    incomplete.exec(`CREATE TABLE task (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    incomplete.close();

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare('PRAGMA table_info(task)').all()).toHaveLength(5);
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it.each([
    ['缺少完整历史表', 'DROP TABLE app_setting;'],
    ['含额外未知表', 'CREATE TABLE unknown_legacy_extension (id TEXT PRIMARY KEY);'],
  ])('完整历史 v0 %s时拒绝且不写入账本', (_label, mutation) => {
    const root = fixtureRoot('migration-versioned-v0-shape');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(mutation);
    } finally {
      legacy.close();
    }
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it('完整历史表集合中任一业务表缺少必要字段都会在写入账本前拒绝', () => {
    const root = fixtureRoot('migration-full-legacy-incomplete-table');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();

    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        DROP TABLE schema_migration;
        PRAGMA user_version = 0;
        ALTER TABLE app_setting RENAME TO app_setting_invalid;
        CREATE TABLE app_setting (key TEXT PRIMARY KEY);
        DROP TABLE app_setting_invalid;`);
    } finally {
      legacy.close();
    }

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare('PRAGMA table_info(app_setting)').all()).toHaveLength(1);
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it('完整历史表集合中必要字段的类型或非空身份漂移也会拒绝', () => {
    const root = fixtureRoot('migration-full-legacy-column-identity-drift');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();

    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        DROP TABLE schema_migration;
        PRAGMA user_version = 0;
        ALTER TABLE app_setting RENAME TO app_setting_invalid;
        CREATE TABLE app_setting (
          key TEXT PRIMARY KEY,
          value_json INTEGER NOT NULL,
          updated_at TEXT
        );
        DROP TABLE app_setting_invalid;`);
    } finally {
      legacy.close();
    }

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare('PRAGMA table_info(app_setting)').all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'value_json', type: 'INTEGER', notnull: 1 }),
        expect.objectContaining({ name: 'updated_at', type: 'TEXT', notnull: 0 }),
      ]));
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it('当前 v1 任一业务表结构漂移都会拒绝重复启动', () => {
    const root = fixtureRoot('migration-current-incomplete-table');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();

    const broken = new DatabaseSync(path);
    try {
      broken.exec(`ALTER TABLE app_setting RENAME TO app_setting_invalid;
        CREATE TABLE app_setting (key TEXT PRIMARY KEY);
        DROP TABLE app_setting_invalid;`);
    } finally {
      broken.close();
    }

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
  });

  it('当前 v1 列类型、非空、默认值和主键属性漂移时拒绝启动', () => {
    const root = fixtureRoot('migration-current-column-properties');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();
    const drifted = new DatabaseSync(path);
    try {
      drifted.exec(`ALTER TABLE app_setting RENAME TO app_setting_original;
        CREATE TABLE app_setting (
          key INTEGER NOT NULL,
          value_json TEXT DEFAULT '{}',
          updated_at TEXT NOT NULL DEFAULT 'synthetic'
        );
        INSERT INTO app_setting (key, value_json, updated_at)
          SELECT key, value_json, updated_at FROM app_setting_original;
        DROP TABLE app_setting_original;`);
    } finally {
      drifted.close();
    }
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
  });

  it('历史 v0 的 approval 外键定义漂移时拒绝且不写入账本', () => {
    const root = fixtureRoot('migration-legacy-approval-foreign-key-drift');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`PRAGMA foreign_keys = OFF;
        ALTER TABLE approval RENAME TO approval_invalid;
        CREATE TABLE approval (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          action_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('awaiting_approval','approved','rejected')),
          created_at TEXT NOT NULL,
          decided_at TEXT
        );
        INSERT INTO approval SELECT * FROM approval_invalid;
        DROP TABLE approval_invalid;`);
    } finally {
      legacy.close();
    }
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it.each([
    ['VIEW', 'CREATE VIEW unknown_legacy_view AS SELECT id FROM task;'],
    ['TRIGGER', `CREATE TRIGGER unknown_legacy_trigger AFTER UPDATE ON task
      BEGIN SELECT NEW.id; END;`],
  ])('历史 v0 出现未知 %s 时拒绝且不写入账本', (_kind, mutation) => {
    const root = fixtureRoot('migration-legacy-unknown-object');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(mutation);
    } finally {
      legacy.close();
    }
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it('旧库缺少 external_id 唯一索引时不写入迁移账本', () => {
    const root = fixtureRoot('migration-legacy-index-drift');
    const path = join(root, 'ai-pm.sqlite');
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`CREATE TABLE source_event (
        id TEXT PRIMARY KEY,
        external_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        content TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        proposer_name TEXT NOT NULL,
        describe TEXT NOT NULL,
        status TEXT NOT NULL,
        next_step TEXT NOT NULL,
        risk TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`);
    } finally {
      legacy.close();
    }
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it('已存在的空 SQLite 不会被当作新数据库初始化', () => {
    const root = fixtureRoot('migration-existing-empty');
    const path = join(root, 'ai-pm.sqlite');
    new DatabaseSync(path).close();

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it.each([
    ['空账本', false],
    ['部分账本', true],
  ])('%s数据库拒绝启动且不推进版本', (_label, insertPartialRow) => {
    const root = fixtureRoot('migration-partial-ledger');
    const path = join(root, 'ai-pm.sqlite');
    const database = new DatabaseSync(path);
    try {
      database.exec(`CREATE TABLE schema_migration (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );`);
      if (insertPartialRow) {
        database.prepare('INSERT INTO schema_migration (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
          .run(CURRENT_SCHEMA_VERSION, 'unknown-partial', BASELINE_MIGRATION_CHECKSUM, '2026-08-15T00:00:00.000Z');
      }
    } finally {
      database.close();
    }
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
    }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
    } finally {
      preserved.close();
    }
  });

  it.each([
    'idx_requirement_thread_unit_unique',
    'idx_candidate_revision_current',
  ])('当前 v1 关键唯一索引 %s 漂移时拒绝启动', (indexName) => {
    const root = fixtureRoot('migration-constraint-drift');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();
    const drifted = new DatabaseSync(path);
    drifted.exec(`DROP INDEX ${indexName};`);
    drifted.close();

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare('SELECT COUNT(*) AS count FROM schema_migration').get()).toEqual({ count: CURRENT_SCHEMA_VERSION });
      expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName))
        .toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it('当前 v1 外键定义漂移时拒绝启动', () => {
    const root = fixtureRoot('migration-foreign-key-schema-drift');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();
    const drifted = new DatabaseSync(path);
    try {
      drifted.exec(`PRAGMA foreign_keys = OFF;
        ALTER TABLE requirement_thread_unit RENAME TO requirement_thread_unit_original;
        CREATE TABLE requirement_thread_unit (
          thread_id TEXT NOT NULL,
          demand_unit_id TEXT NOT NULL,
          relation_type TEXT NOT NULL DEFAULT 'primary',
          confidence REAL,
          evidence_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          PRIMARY KEY (thread_id, demand_unit_id)
        );
        INSERT INTO requirement_thread_unit SELECT * FROM requirement_thread_unit_original;
        DROP TABLE requirement_thread_unit_original;
        CREATE INDEX idx_requirement_thread_unit ON requirement_thread_unit(demand_unit_id, thread_id);
        CREATE UNIQUE INDEX idx_requirement_thread_unit_unique ON requirement_thread_unit(demand_unit_id);`);
    } finally {
      drifted.close();
    }

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
  });

  it('当前 v1 的 CHECK 约束被放宽时拒绝启动', () => {
    const root = fixtureRoot('migration-check-schema-drift');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();
    const drifted = new DatabaseSync(path);
    try {
      drifted.exec(`PRAGMA foreign_keys = OFF;
        ALTER TABLE app_log RENAME TO app_log_original;
        CREATE TABLE app_log (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          level TEXT NOT NULL,
          event_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          context_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO app_log SELECT * FROM app_log_original;
        DROP TABLE app_log_original;`);
    } finally {
      drifted.close();
    }

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
  });

  it('当前 v1 的自动 UNIQUE 约束被移除时拒绝启动', () => {
    const root = fixtureRoot('migration-auto-unique-drift');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();
    const drifted = new DatabaseSync(path);
    try {
      drifted.exec(`PRAGMA foreign_keys = OFF;
        ALTER TABLE outbox RENAME TO outbox_original;
        CREATE TABLE outbox (
          id TEXT PRIMARY KEY,
          approval_id TEXT NOT NULL REFERENCES approval(id) ON DELETE CASCADE,
          action_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('awaiting_approval','ready','sent','failed')),
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );
        INSERT INTO outbox SELECT * FROM outbox_original;
        DROP TABLE outbox_original;`);
    } finally {
      drifted.close();
    }

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
  });

  it('当前 v1 的普通业务外键被移除时拒绝启动', () => {
    const root = fixtureRoot('migration-outbox-foreign-key-drift');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();
    const drifted = new DatabaseSync(path);
    try {
      drifted.exec(`PRAGMA foreign_keys = OFF;
        ALTER TABLE outbox RENAME TO outbox_original;
        CREATE TABLE outbox (
          id TEXT PRIMARY KEY,
          approval_id TEXT NOT NULL,
          action_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('awaiting_approval','ready','sent','failed')),
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );
        INSERT INTO outbox SELECT * FROM outbox_original;
        DROP TABLE outbox_original;`);
    } finally {
      drifted.close();
    }

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
  });

  it('当前 v1 出现未知应用表时拒绝启动', () => {
    const root = fixtureRoot('migration-current-unknown-table');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();
    const drifted = new DatabaseSync(path);
    drifted.exec('CREATE TABLE unknown_extension (id TEXT PRIMARY KEY);');
    drifted.close();
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
  });

  it.each([
    ['VIEW', 'CREATE VIEW unknown_task_view AS SELECT id FROM task;'],
    ['TRIGGER', `CREATE TRIGGER unknown_task_trigger AFTER INSERT ON task
      BEGIN
        SELECT 1;
      END;`],
  ])('当前 v1 出现未知 %s 时拒绝启动', (_kind, sql) => {
    const root = fixtureRoot('migration-current-unknown-schema-object');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();
    const drifted = new DatabaseSync(path);
    drifted.exec(sql);
    drifted.close();

    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
  });

  it('数据库目录不可创建时只返回受控错误且不泄露路径或 cause', () => {
    const root = fixtureRoot('migration-open-failure');
    const blockingFile = join(root, 'not-a-directory');
    writeFileSync(blockingFile, 'synthetic');
    const path = join(blockingFile, 'ai-pm.sqlite');

    let caught: unknown;
    try {
      new AppDatabase(path, false);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseUpgradeError);
    expect(caught).toEqual(expect.objectContaining({ stage: 'ledger' }));
    expect((caught as Error).message).not.toContain(root);
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('升级前备份失败时不开始迁移且不改写旧库', () => {
    const root = fixtureRoot('migration-backup-failure');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    writeFileSync(join(root, 'backups'), 'synthetic collision');

    expect(() => new AppDatabase(path, false, { now: fixedNow })).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'backup',
    }));
    const original = openReadOnly(path);
    try {
      expect(original.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get()).toEqual({ title: '旧任务' });
      expect(original.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
      expect(original.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get())
        .toBeUndefined();
    } finally {
      original.close();
    }
  });

  it('显式恢复只接受同库受管备份，并能恢复后再次安全升级', () => {
    const root = fixtureRoot('migration-restore');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const upgraded = new AppDatabase(path, false, { now: fixedNow });
    upgraded.raw.prepare("UPDATE task SET title = '升级后改写' WHERE id = 'legacy-task'").run();
    upgraded.close();
    const backupPath = join(root, 'backups', managedBackups(root)[0]!);

    restoreDatabaseBackup(path, backupPath);
    const restoredLegacy = openReadOnly(path);
    try {
      expect(restoredLegacy.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get()).toEqual({ title: '旧任务' });
      expect(restoredLegacy.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 });
    } finally {
      restoredLegacy.close();
    }

    const migratedAgain = new AppDatabase(path, false, { now: fixedNow });
    try {
      expect(migratedAgain.raw.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get()).toEqual({ title: '旧任务' });
      expect(migratedAgain.raw.prepare('SELECT COUNT(*) AS count FROM schema_migration').get()).toEqual({ count: CURRENT_SCHEMA_VERSION });
    } finally {
      migratedAgain.close();
    }
    expect(() => restoreDatabaseBackup(path, join(root, 'not-managed.sqlite'))).toThrowError(expect.objectContaining({
      stage: 'restore',
    }));
  });

  it('受管备份 manifest 或内容被篡改时拒绝恢复且保留当前库', () => {
    const root = fixtureRoot('restore-tampered-manifest');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const upgraded = new AppDatabase(path, false, { now: fixedNow });
    upgraded.raw.prepare("UPDATE task SET title = '当前库必须保留' WHERE id = 'legacy-task'").run();
    upgraded.close();
    const backupPath = join(root, 'backups', managedBackups(root)[0]!);
    const manifestPath = `${backupPath}.manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    expect(() => restoreDatabaseBackup(path, backupPath)).toThrowError(expect.objectContaining({ stage: 'restore' }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get())
        .toEqual({ title: '当前库必须保留' });
    } finally {
      preserved.close();
    }
  });

  it('受管命名的损坏文件只返回受控错误且不覆盖当前库', () => {
    const root = fixtureRoot('restore-corrupt-backup');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.raw.prepare("UPDATE task SET title = '当前库必须保留' WHERE id = 'legacy-task'").run();
    current.close();
    const backupPath = join(
      root,
      'backups',
      'ai-pm.sqlite.backup-v0-to-v1-20260815T070000000Z-1234567890abcdef1234567890abcdef.sqlite',
    );
    writeFileSync(backupPath, 'not-sqlite');
    writeSyntheticBackupManifest(path, backupPath, 0, 1);

    let caught: unknown;
    try {
      restoreDatabaseBackup(path, backupPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseUpgradeError);
    expect((caught as Error).message).not.toContain(root);
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get())
        .toEqual({ title: '当前库必须保留' });
    } finally {
      preserved.close();
    }
  });

  it('manifest 中的数据库身份被篡改时拒绝恢复且保留当前库', () => {
    const root = fixtureRoot('restore-tampered-database-identity');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.raw.prepare("UPDATE task SET title = '当前库必须保留' WHERE id = 'legacy-task'").run();
    current.close();
    const backupPath = join(root, 'backups', managedBackups(root)[0]!);
    const manifestPath = `${backupPath}.manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.database_instance_id = '0'.repeat(32);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    expect(() => restoreDatabaseBackup(path, backupPath)).toThrowError(expect.objectContaining({ stage: 'restore' }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get())
        .toEqual({ title: '当前库必须保留' });
    } finally {
      preserved.close();
    }
  });

  it('另一个数据库的备份即使文件名匹配也不能恢复', () => {
    const root = fixtureRoot('restore-other-database');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.raw.prepare("UPDATE task SET title = '当前库必须保留' WHERE id = 'legacy-task'").run();
    current.close();

    const otherRoot = fixtureRoot('restore-other-database-source');
    const otherPath = join(otherRoot, 'ai-pm.sqlite');
    createLegacyTaskDatabase(otherPath);
    const other = new AppDatabase(otherPath, false, { now: fixedNow });
    other.close();
    const otherBackup = join(otherRoot, 'backups', managedBackups(otherRoot)[0]!);
    const forgedBackup = join(root, 'backups', basename(otherBackup));
    copyFileSync(otherBackup, forgedBackup);
    copyFileSync(`${otherBackup}.manifest.json`, `${forgedBackup}.manifest.json`);

    expect(() => restoreDatabaseBackup(path, forgedBackup)).toThrowError(expect.objectContaining({ stage: 'restore' }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get())
        .toEqual({ title: '当前库必须保留' });
    } finally {
      preserved.close();
    }
  });

  it.each([
    ['文件名时间与 created_at 不一致', (manifest: Record<string, unknown>, _backupPath: string) => {
      manifest.created_at = '2026-08-15T09:09:09.009Z';
    }],
    ['非 canonical created_at', (manifest: Record<string, unknown>, _backupPath: string) => {
      manifest.created_at = '2026-08-15T01:02:03.004+00:00';
    }],
    ['实际 user_version 与 from_version 不一致', (manifest: Record<string, unknown>, backupPath: string) => {
      const backup = new DatabaseSync(backupPath);
      backup.exec('PRAGMA user_version = 1;');
      backup.close();
      manifest.sha256 = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
    }],
  ])('manifest 绑定%s时拒绝恢复', (_label, mutate) => {
    const root = fixtureRoot('restore-manifest-binding');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.raw.prepare("UPDATE task SET title = '当前库必须保留' WHERE id = 'legacy-task'").run();
    current.close();
    const backupPath = join(root, 'backups', managedBackups(root)[0]!);
    const manifestPath = `${backupPath}.manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    mutate(manifest, backupPath);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() => restoreDatabaseBackup(path, backupPath)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
    }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get())
        .toEqual({ title: '当前库必须保留' });
    } finally {
      preserved.close();
    }
  });

  it.each([
    '20261315T010203004Z',
    '20260230T010203004Z',
    '20260815T250203004Z',
  ])('受管备份文件名包含无效 UTC 时间 %s 时拒绝恢复', (timestamp) => {
    const root = fixtureRoot('restore-invalid-backup-timestamp');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.close();
    const validBackupPath = join(root, 'backups', managedBackups(root)[0]!);
    const invalidBackupPath = join(
      root,
      'backups',
      `ai-pm.sqlite.backup-v0-to-v1-${timestamp}-1234567890abcdef1234567890abcdef.sqlite`,
    );
    copyFileSync(validBackupPath, invalidBackupPath);
    copyFileSync(`${validBackupPath}.manifest.json`, `${invalidBackupPath}.manifest.json`);
    expect(() => restoreDatabaseBackup(path, invalidBackupPath)).toThrowError(expect.objectContaining({ stage: 'restore' }));
  });

  it('同一路径替换为另一个数据库实例后，旧备份不能恢复', () => {
    const root = fixtureRoot('restore-same-path-new-instance');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const first = new AppDatabase(path, false, { now: fixedNow });
    first.close();
    const oldBackupPath = join(root, 'backups', managedBackups(root)[0]!);
    rmSync(path);
    const replacement = new AppDatabase(path, false);
    replacement.raw.prepare(`INSERT INTO task
      (id, title, proposer_name, describe, status, next_step, risk, created_at, updated_at)
      VALUES ('replacement-task', '替换实例必须保留', '需求方', '当前内容', 'planned', '继续', 'low', ?, ?)`)
      .run('2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
    replacement.close();
    expect(() => restoreDatabaseBackup(path, oldBackupPath)).toThrowError(expect.objectContaining({ stage: 'restore' }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'replacement-task'").get())
        .toEqual({ title: '替换实例必须保留' });
    } finally {
      preserved.close();
    }
  });

  it.each(['-wal', '-shm'])('备份存在 %s 侧车文件时拒绝恢复', (suffix) => {
    const root = fixtureRoot('restore-backup-sidecar');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.close();
    const backupPath = join(root, 'backups', managedBackups(root)[0]!);
    writeFileSync(`${backupPath}${suffix}`, 'synthetic-sidecar');
    expect(() => restoreDatabaseBackup(path, backupPath)).toThrowError(expect.objectContaining({ stage: 'restore' }));
  });

  it('纯 containment 决策拒绝同前缀目录和祖先逃逸', () => {
    const managedRoot = join('C:\\synthetic', 'database', 'backups');
    expect(managedPathIsContained(managedRoot, join(managedRoot, 'backup.sqlite'), 'backup.sqlite')).toBe(true);
    expect(managedPathIsContained(`${managedRoot}-escape`, join(`${managedRoot}-escape`, 'backup.sqlite'), 'backup.sqlite'))
      .toBe(true);
    expect(managedPathIsContained(managedRoot, join(`${managedRoot}-escape`, 'backup.sqlite'), 'backup.sqlite')).toBe(false);
    expect(managedPathIsContained(managedRoot, join(managedRoot, '..', 'outside.sqlite'), 'backup.sqlite')).toBe(false);
  });

  it('备份目录通过 reparse/junction 逃逸时拒绝恢复', () => {
    const root = fixtureRoot('restore-directory-escape');
    const externalRoot = fixtureRoot('restore-directory-escape-target');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.close();
    const originalBackup = join(root, 'backups', managedBackups(root)[0]!);
    const backupName = basename(originalBackup);
    copyFileSync(originalBackup, join(externalRoot, backupName));
    copyFileSync(`${originalBackup}.manifest.json`, join(externalRoot, `${backupName}.manifest.json`));
    rmSync(join(root, 'backups'), { recursive: true });
    symlinkSync(externalRoot, join(root, 'backups'), 'junction');

    expect(() => restoreDatabaseBackup(path, join(root, 'backups', backupName)))
      .toThrowError(expect.objectContaining({ stage: 'restore' }));
  });

  it.each(['-wal', '-shm'])('主库存在 %s 侧车文件时拒绝恢复且保留当前库', (suffix) => {
    const root = fixtureRoot('restore-sidecar');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.raw.prepare("UPDATE task SET title = '当前库必须保留' WHERE id = 'legacy-task'").run();
    current.close();
    const backupPath = join(root, 'backups', managedBackups(root)[0]!);
    writeFileSync(`${path}${suffix}`, 'synthetic-sidecar');

    expect(() => restoreDatabaseBackup(path, backupPath)).toThrowError(expect.objectContaining({ stage: 'restore' }));
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get())
        .toEqual({ title: '当前库必须保留' });
    } finally {
      preserved.close();
    }
  });

  it.each([
    ['状态检查失败', 'beforeStat'],
    ['候选打开失败', 'beforeCandidateOpen'],
    ['候选查询失败', 'beforeCandidateQuery'],
    ['复制失败', 'beforeCopy'],
    ['暂存打开失败', 'beforeStagingOpen'],
    ['暂存查询失败', 'beforeStagingQuery'],
    ['移动原库失败', 'beforeMoveOriginal'],
    ['安装恢复库失败', 'beforeInstall'],
    ['最终打开失败', 'beforeFinalOpen'],
    ['最终查询失败', 'beforeFinalQuery'],
    ['清理旧库失败', 'beforeRemove'],
  ] as const)('恢复%s时只返回受控错误并恢复原主库', (_label, fault) => {
    const root = fixtureRoot('restore-injected-failure');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.raw.prepare("UPDATE task SET title = '当前库必须保留' WHERE id = 'legacy-task'").run();
    current.close();
    const backupPath = join(root, 'backups', managedBackups(root)[0]!);
    const rawMessage = `synthetic failure at ${root}`;
    let caught: unknown;
    try {
      restoreDatabaseBackup(path, backupPath, { faults: { [fault]: () => { throw new Error(rawMessage); } } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseUpgradeError);
    expect((caught as Error).message).not.toContain(root);
    expect((caught as Error).message).not.toContain(rawMessage);
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((caught as Error).stack).toBe(`DatabaseUpgradeError: ${(caught as Error).message}`);
    expect(JSON.stringify(caught)).not.toContain(root);
    expect(JSON.stringify(caught)).not.toContain(rawMessage);
    expect(Object.keys(caught as object).sort()).toEqual(['name', 'stage']);
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get())
        .toEqual({ title: '当前库必须保留' });
    } finally {
      preserved.close();
    }
  });

  it.each([
    ['缺失', (_path: string) => {}],
    ['空库', (path: string) => new DatabaseSync(path).close()],
    ['异构库', (path: string) => {
      const unrelated = new DatabaseSync(path);
      try {
        unrelated.exec('CREATE TABLE unrelated_record (id TEXT PRIMARY KEY);');
      } finally {
        unrelated.close();
      }
    }],
    ['结构兼容但缺少本应用 manifest 的库', (path: string) => createLegacyTaskDatabase(path)],
    ['仅有合法 v1 账本的残缺库', (path: string) => {
      const ledgerOnly = new DatabaseSync(path);
      try {
        ledgerOnly.exec(`CREATE TABLE schema_migration (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};`);
        ledgerOnly.prepare(`INSERT INTO schema_migration (version, name, checksum, applied_at)
          VALUES (?, ?, ?, ?)`).run(
          CURRENT_SCHEMA_VERSION,
          'baseline-current-sqlite-schema',
          BASELINE_MIGRATION_CHECKSUM,
          '2026-08-15T00:00:00.000Z',
        );
      } finally {
        ledgerOnly.close();
      }
    }],
  ])('显式恢复拒绝%s受管命名备份且不覆盖当前库', (_label, createBackup) => {
    const root = fixtureRoot('restore-invalid');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.raw.prepare("UPDATE task SET title = '当前库必须保留' WHERE id = 'legacy-task'").run();
    current.close();

    const backupPath = join(
      root,
      'backups',
      'ai-pm.sqlite.backup-v0-to-v1-20260815T040000000Z-1234567890abcdef1234567890abcdef.sqlite',
    );
    createBackup(backupPath);

    let caught: unknown;
    try {
      restoreDatabaseBackup(path, backupPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseUpgradeError);
    expect(caught).toEqual(expect.objectContaining({ stage: 'restore' }));
    expect((caught as Error).message).not.toContain(root);
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();

    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get())
        .toEqual({ title: '当前库必须保留' });
    } finally {
      preserved.close();
    }
  });

  it('显式恢复拒绝受管文件名下的硬链接且不覆盖当前库', () => {
    const root = fixtureRoot('restore-hard-link');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.raw.prepare("UPDATE task SET title = '当前库必须保留' WHERE id = 'legacy-task'").run();
    current.close();

    const externalRoot = fixtureRoot('restore-hard-link-source');
    const externalPath = join(externalRoot, 'outside.sqlite');
    createLegacyTaskDatabase(externalPath);
    const linkedBackup = join(
      root,
      'backups',
      'ai-pm.sqlite.backup-v0-to-v1-20260815T050000000Z-1234567890abcdef1234567890abcdef.sqlite',
    );
    linkSync(externalPath, linkedBackup);

    expect(() => restoreDatabaseBackup(path, linkedBackup)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'restore',
    }));
    expect(existsSync(externalPath)).toBe(true);
    expect(existsSync(linkedBackup)).toBe(true);
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get())
        .toEqual({ title: '当前库必须保留' });
    } finally {
      preserved.close();
    }
  });

  it('显式恢复拒绝外键损坏的受管 v0 备份且不覆盖当前库', () => {
    const root = fixtureRoot('restore-foreign-key');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.raw.prepare(`INSERT INTO task
      (id, title, proposer_name, describe, status, next_step, risk, created_at, updated_at)
      VALUES ('current-task', '当前库必须保留', '需求方', '当前内容', 'planned', '继续', 'low', ?, ?)`)
      .run('2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
    current.close();

    const invalidBackup = join(
      root,
      'backups',
      'ai-pm.sqlite.backup-v0-to-v8-20260815T060000000Z-1234567890abcdef1234567890abcdef.sqlite',
    );
    mkdirSync(join(root, 'backups'), { recursive: true });
    copyFileSync(path, invalidBackup);
    const broken = new DatabaseSync(invalidBackup);
    try {
      broken.exec(`PRAGMA foreign_keys = OFF;
        DROP TABLE schema_migration;
        PRAGMA user_version = 0;
        INSERT INTO task_source_link (task_id, source_event_id, relation_type, created_at)
        VALUES ('missing-task', 'missing-source', 'origin', '2026-08-15T00:00:00.000Z');`);
    } finally {
      broken.close();
    }
    writeSyntheticBackupManifest(path, invalidBackup, 0, CURRENT_SCHEMA_VERSION);

    let restoreError: unknown;
    try {
      restoreDatabaseBackup(path, invalidBackup);
    } catch (error) {
      restoreError = error;
    }
    expect(restoreError).toEqual(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'restore',
      message: 'SQLite 外键完整性检查失败；已停止数据库升级。',
    }));
    expect(JSON.stringify(restoreError)).not.toContain(root);
    expect((restoreError as Error | undefined)?.cause).toBeUndefined();
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'current-task'").get())
        .toEqual({ title: '当前库必须保留' });
    } finally {
      preserved.close();
    }
  });

  it.each([
    ['staging', 'beforeStagingInspect'],
    ['final', 'beforeFinalInspect'],
  ] as const)('%s 阶段出现外键损坏时恢复原主库', (_phase, fault) => {
    const root = fixtureRoot('restore-fk-stage-token-secret-canary');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const current = new AppDatabase(path, false, { now: fixedNow });
    current.raw.prepare("UPDATE task SET title = '当前库必须保留' WHERE id = 'legacy-task'").run();
    current.close();
    const backupPath = join(root, 'backups', managedBackups(root)[0]!);
    let caught: unknown;
    try {
      restoreDatabaseBackup(path, backupPath, { faults: { [fault]: injectForeignKeyDamage } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'restore',
      message: 'SQLite 外键完整性检查失败；已停止数据库升级。',
    }));
    for (const serialized of [
      (caught as Error).message,
      (caught as Error).stack ?? '',
      JSON.stringify(caught),
      JSON.stringify(Object.fromEntries(Object.entries(caught as object))),
    ]) {
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain('token-secret-canary');
    }
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    const preserved = openReadOnly(path);
    try {
      expect(preserved.prepare("SELECT title FROM task WHERE id = 'legacy-task'").get())
        .toEqual({ title: '当前库必须保留' });
      expect(preserved.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      preserved.close();
    }
  });

  it('备份保留只清理严格匹配的旧备份，不删除未知文件', () => {
    const root = fixtureRoot('migration-retention');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const first = new AppDatabase(path, false, { now: fixedNow });
    first.close();
    let verifiedBackupPath = join(root, 'backups', managedBackups(root)[0]!);
    const backupDirectory = join(root, 'backups');
    const unknownFile = join(backupDirectory, 'keep-me.txt');
    writeFileSync(unknownFile, 'not managed');
    const externalRoot = fixtureRoot('migration-retention-hard-link');
    const externalFile = join(externalRoot, 'outside.txt');
    writeFileSync(externalFile, 'must remain');
    const linkedManagedName = join(
      backupDirectory,
      'ai-pm.sqlite.backup-v0-to-v1-20260815T000000000Z-1234567890abcdef1234567890abcdef.sqlite',
    );
    linkSync(externalFile, linkedManagedName);
    const forgedManagedName = join(
      backupDirectory,
      'ai-pm.sqlite.backup-v0-to-v1-20260815T000000001Z-1234567890abcdef1234567890abcdef.sqlite',
    );
    writeFileSync(forgedManagedName, 'not managed');
    writeFileSync(`${forgedManagedName}.manifest.json`, '{}');

    // The initial migration already created one verified backup. Three more
    // cycles are sufficient to exceed the retention cap without keeping the
    // synchronous SQLite worker busy long enough to trip Vitest RPC timeout.
    for (let index = 0; index < DATABASE_BACKUP_RETENTION; index += 1) {
      restoreDatabaseBackup(path, verifiedBackupPath);
      const migrated = new AppDatabase(path, false, {
        now: () => new Date(Date.parse('2026-08-15T02:00:00.000Z') + index * 1_000),
      });
      migrated.close();
      const latestVerified = managedBackups(root)
        .filter((name) => name !== basename(linkedManagedName) && name !== basename(forgedManagedName))
        .sort()
        .at(-1)!;
      verifiedBackupPath = join(backupDirectory, latestVerified);
    }

    expect(managedBackups(root).filter((name) => name !== basename(forgedManagedName)))
      .toHaveLength(DATABASE_BACKUP_RETENTION);
    expect(readdirSync(backupDirectory)).toContain('keep-me.txt');
    expect(existsSync(linkedManagedName)).toBe(true);
    expect(existsSync(externalFile)).toBe(true);
    expect(existsSync(forgedManagedName)).toBe(true);
    expect(existsSync(`${forgedManagedName}.manifest.json`)).toBe(true);
  }, 10_000);

  it('备份保留只按已验证文件名时间排序，mtime 扰动不改变同时间稳定 tie-break', () => {
    const root = fixtureRoot('migration-retention-canonical-time');
    const path = join(root, 'ai-pm.sqlite');
    createLegacyTaskDatabase(path);
    const first = new AppDatabase(path, false, { now: fixedNow });
    first.close();
    const backupDirectory = join(root, 'backups');
    const originalBackupPath = join(backupDirectory, managedBackups(root)[0]!);
    restoreDatabaseBackup(path, originalBackupPath);

    const timestamp = '20260815T030000000Z';
    const createdAt = '2026-08-15T03:00:00.000Z';
    const cloneNames = Array.from({ length: DATABASE_BACKUP_RETENTION + 1 }, (_item, index) => {
      const nonce = index.toString(16).padStart(32, '0');
      const name = `ai-pm.sqlite.backup-v0-to-v8-${timestamp}-${nonce}.sqlite`;
      const clonePath = join(backupDirectory, name);
      copyManagedBackupPair(originalBackupPath, clonePath, createdAt);
      const reversedMtime = new Date(Date.parse('2026-08-15T12:00:00.000Z') - index * 60_000);
      utimesSync(clonePath, reversedMtime, reversedMtime);
      utimesSync(`${clonePath}.manifest.json`, reversedMtime, reversedMtime);
      return name;
    });

    const migrated = new AppDatabase(path, false, {
      now: () => new Date('2026-08-15T04:00:00.000Z'),
    });
    migrated.close();

    const remaining = managedBackups(root);
    expect(remaining).toHaveLength(DATABASE_BACKUP_RETENTION);
    const sameTimestampRemaining = remaining.filter((name) => name.includes(timestamp)).sort();
    expect(sameTimestampRemaining).toEqual(cloneNames.sort().slice(-(DATABASE_BACKUP_RETENTION - 1)));
  });

  it('未来 schema、账本 checksum 漂移和未来备份都 fail-closed', () => {
    const root = fixtureRoot('migration-downgrade');
    const path = join(root, 'ai-pm.sqlite');
    const current = new AppDatabase(path, false);
    current.close();

    const future = new DatabaseSync(path);
    try {
      future.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1};`);
    } finally {
      future.close();
    }
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'downgrade_gate',
    }));

    const reset = new DatabaseSync(path);
    try {
      reset.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};`);
      reset.prepare('UPDATE schema_migration SET checksum = ? WHERE version = ?').run('0'.repeat(64), CURRENT_SCHEMA_VERSION);
    } finally {
      reset.close();
    }
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));

    const healthy = new DatabaseSync(path);
    try {
      healthy.prepare('UPDATE schema_migration SET checksum = ? WHERE version = ?')
        .run(PROVIDER_RETRY_COOLDOWN_MIGRATION_CHECKSUM, CURRENT_SCHEMA_VERSION);
    } finally {
      healthy.close();
    }
    mkdirSync(join(root, 'backups'), { recursive: true });
    const futureBackup = join(
      root,
      'backups',
      'ai-pm.sqlite.backup-v8-to-v9-20260815T030000000Z-1234567890abcdef1234567890abcdef.sqlite',
    );
    copyFileSync(path, futureBackup);
    const futureBackupDatabase = new DatabaseSync(futureBackup);
    try {
      futureBackupDatabase.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1};`);
    } finally {
      futureBackupDatabase.close();
    }
    writeSyntheticBackupManifest(path, futureBackup, CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION + 1);
    expect(() => restoreDatabaseBackup(path, futureBackup)).toThrowError(expect.objectContaining({
      stage: 'downgrade_gate',
    }));
    const stillCurrent = openReadOnly(path);
    try {
      expect(stillCurrent.prepare('PRAGMA user_version').get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    } finally {
      stillCurrent.close();
    }
  });
});
