import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppDatabase,
  RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_DESCRIPTOR,
  type MigrationDescriptor,
  type MigrationOperation,
} from '../src/database.js';

const roots: string[] = [];

function root(label: string) {
  const value = mkdtempSync(join(tmpdir(), `ai-pm-run01-v3-${label}-`));
  roots.push(value);
  return value;
}

function downgradeV4ToV2(path: string) {
  const database = new AppDatabase(path, false);
  database.close();
  const raw = new DatabaseSync(path);
  try {
    raw.exec(`
      PRAGMA foreign_keys = OFF;
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
      DROP TABLE IF EXISTS privacy_audit_event;
      DROP TABLE IF EXISTS privacy_backup;
      DROP TABLE IF EXISTS privacy_deletion;
      DROP TABLE IF EXISTS privacy_export;
      DROP TABLE IF EXISTS privacy_retention_policy;
      DROP TABLE IF EXISTS privacy_control;
      DROP TABLE IF EXISTS privacy_lifecycle_claim;
      DROP TABLE IF EXISTS privacy_backup_cleanup_intent;
      DROP INDEX IF EXISTS idx_runtime_tool_idempotency_active;
      ALTER TABLE runtime_tool_call DROP COLUMN idempotency_key;
      DROP INDEX IF EXISTS idx_provider_retry_cooldown_retry_at;
      DROP TABLE IF EXISTS provider_retry_cooldown;
      ALTER TABLE candidate_request DROP COLUMN version;
      DELETE FROM schema_migration WHERE version IN (3, 4, 5, 6, 7, 8);
      PRAGMA user_version = 2;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    raw.close();
  }
}

function hash(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string; sql: string }>;
    const indexes = database.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all();
    return createHash('sha256').update(JSON.stringify({
      userVersion: database.prepare('PRAGMA user_version').get(),
      tables: tables.map(({ name, sql }) => ({ name, sql, rows: database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() })),
      indexes,
    })).digest('hex');
  } finally {
    database.close();
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Issue #42 RUN-01 v3 migration', () => {
  it('从 DATA-02 v2 连续升级到 v3，保留关系并建立 Runtime 幂等唯一 fence', () => {
    const directory = root('upgrade');
    const path = join(directory, 'data.sqlite');
    const initial = new AppDatabase(path, false);
    initial.raw.prepare(`INSERT INTO source_event
      (id, external_id, source_type, conversation_id, sender_id, sender_name, content,
       owner_mentioned, source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
      VALUES ('source-1', 'external-1', 'owner_dm', 'conversation-1', 'sender-1', '发送者', '合成来源',
              0, NULL, 'complete', '', '{}', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`).run();
    initial.raw.prepare(`INSERT INTO task
      (id, title, proposer_name, describe, status, next_step, risk, created_at, updated_at)
      VALUES ('task-1', '任务', '发送者', '摘要', 'planned', '继续', 'low', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`).run();
    initial.raw.prepare(`INSERT INTO task_source_link
      (task_id, source_event_id, relation_type, created_at)
      VALUES ('task-1', 'source-1', 'origin', '2026-08-16T00:00:00.000Z')`).run();
    initial.close();
    downgradeV4ToV2(path);

    const upgraded = new AppDatabase(path, false);
    expect(upgraded.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    expect(upgraded.raw.prepare('SELECT version, name FROM schema_migration WHERE version = 3').get()).toEqual({
      version: 3,
      name: 'run-01-runtime-tool-idempotency',
    });
    expect(upgraded.raw.prepare('SELECT relation_type FROM task_source_link WHERE task_id = ?').get('task-1'))
      .toEqual({ relation_type: 'origin' });
    expect(upgraded.raw.prepare('PRAGMA table_info(runtime_tool_call)').all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'idempotency_key' })]));
    const index = upgraded.raw.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_runtime_tool_idempotency_active'",
    ).get() as { name: string; sql: string } | undefined;
    expect(index?.sql).toContain("status IN ('allowed','completed')");
    upgraded.close();

    const reopened = new AppDatabase(path, false);
    expect(reopened.raw.prepare('SELECT COUNT(*) AS count FROM schema_migration').get()).toEqual({ count: 8 });
    expect(reopened.raw.prepare('SELECT relation_type FROM task_source_link WHERE task_id = ?').get('task-1'))
      .toEqual({ relation_type: 'origin' });
    reopened.close();
  });

  it('v2→v3 迁移在 schema 操作失败时回滚，未留下 idempotency column 或 v3 账本', () => {
    const directory = root('rollback');
    const path = join(directory, 'data.sqlite');
    const initial = new AppDatabase(path, false);
    initial.close();
    downgradeV4ToV2(path);
    const before = hash(path);
    const first = RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_DESCRIPTOR.orderedOperations[0]!;
    if (first.kind !== 'sql_batch') throw new Error('v3 SQL operation missing');
    const injected: MigrationOperation = {
      id: 'synthetic-v3-failure',
      kind: 'sql_batch',
      statements: ["INSERT INTO __missing_run01_table VALUES ('synthetic')"],
    };
    const descriptor: MigrationDescriptor = {
      ...RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_DESCRIPTOR,
      orderedOperations: [first, injected, ...RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_DESCRIPTOR.orderedOperations.slice(1)],
    };
    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: descriptor })).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'migration',
    }));
    expect(hash(path)).toBe(before);
    const restored = new DatabaseSync(path, { readOnly: true });
    try {
      expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
      expect(restored.prepare('SELECT version FROM schema_migration ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 2 });
      expect(restored.prepare('PRAGMA table_info(runtime_tool_call)').all())
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'idempotency_key' })]));
    } finally {
      restored.close();
    }
  });

  it('v2 的未记账 partial runtime schema 在 backup 前拒绝，保持原 bytes 且不产生受管备份', () => {
    const directory = root('partial');
    const path = join(directory, 'data.sqlite');
    const initial = new AppDatabase(path, false);
    initial.close();
    downgradeV4ToV2(path);
    const partial = new DatabaseSync(path);
    partial.exec('ALTER TABLE runtime_tool_call ADD COLUMN idempotency_key TEXT;');
    partial.close();
    const before = hash(path);
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({
      name: 'DatabaseUpgradeError',
      stage: 'ledger',
    }));
    expect(hash(path)).toBe(before);
    expect(() => readdirSync(join(directory, 'backups'))).toThrow();
  });
});
