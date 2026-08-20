import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  AppDatabase,
  RELATION_CONSTRAINT_MIGRATION_DESCRIPTOR,
  type MigrationOperation,
} from '../src/database.js';
import { loadConfig } from '../src/config.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

const now = '2026-08-16T00:00:00.000Z';
const roots: string[] = [];

function root(label: string) {
  const value = mkdtempSync(join(tmpdir(), `ai-pm-data02-${label}-`));
  roots.push(value);
  return value;
}

function downgradeV2ToV1(path: string) {
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
      DROP TABLE IF EXISTS provider_retry_cooldown;
      DROP INDEX IF EXISTS idx_task_source_link_explicit;
      DROP INDEX IF EXISTS idx_task_source_link_ambiguous;
      DROP INDEX IF EXISTS idx_task_source_link_unit;
      DROP INDEX IF EXISTS idx_task_source_link_source_unit;
      DROP INDEX IF EXISTS idx_ai_decision_source_revision;
      DROP INDEX IF EXISTS idx_audit_demand_unit;
      DROP INDEX IF EXISTS idx_correction_demand_unit;
      DROP INDEX IF EXISTS idx_thread_source_unit;
      DROP INDEX IF EXISTS idx_owner_decision_unit;
      ALTER TABLE candidate_request DROP COLUMN version;
      DROP TABLE data_integrity_gap;
      CREATE TABLE task_source_link_v1 (
        task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
        source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL DEFAULT 'origin',
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, source_event_id)
      );
      INSERT INTO task_source_link_v1 (task_id, source_event_id, relation_type, created_at)
        SELECT task_id, source_event_id, relation_type, created_at FROM task_source_link;
      DROP TABLE task_source_link;
      ALTER TABLE task_source_link_v1 RENAME TO task_source_link;
      ALTER TABLE task_event DROP COLUMN demand_unit_id;
      ALTER TABLE correction_event DROP COLUMN demand_unit_id;
      ALTER TABLE requirement_thread_source DROP COLUMN demand_unit_id;
      ALTER TABLE owner_decision DROP COLUMN demand_unit_id;
      ALTER TABLE ai_decision_log DROP COLUMN source_revision;
      DELETE FROM schema_migration WHERE version IN (2, 3, 4, 5, 6, 7, 8);
      PRAGMA user_version = 1;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    raw.close();
  }
}

function v1Database(label: string) {
  const path = join(root(label), 'data.sqlite');
  downgradeV2ToV1(path);
  return path;
}

function insertSource(raw: import('node:sqlite').DatabaseSync, id = 'source-shared') {
  raw.prepare(`INSERT INTO source_event
    (id, external_id, source_type, conversation_id, sender_id, sender_name, content, owner_mentioned,
     source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
    VALUES (?, ?, 'owner_dm', 'conversation', 'sender', '需求方', '受控测试来源', 0, NULL, 'complete', '', '{}', ?, ?)`)
    .run(id, `${id}-external`, now, now);
}

function insertUnit(raw: import('node:sqlite').DatabaseSync, id: string, sourceId: string, key: string) {
  raw.prepare(`INSERT INTO source_demand_unit
    (id, anchor_source_event_id, unit_key, unit_kind, state, created_at, updated_at)
    VALUES (?, ?, ?, 'demand', 'ready', ?, ?)`)
    .run(id, sourceId, key, now, now);
  raw.prepare(`INSERT INTO source_demand_unit_source
    (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
    VALUES (?, ?, ?, 'anchor', 0, ?)`)
    .run(id, sourceId, key, now);
}

function insertTask(raw: import('node:sqlite').DatabaseSync, id = 'task-shared') {
  raw.prepare(`INSERT INTO task
    (id, title, proposer_name, describe, status, next_step, risk, created_at, updated_at)
    VALUES (?, '共享任务', '需求方', '受控任务摘要', 'in_progress', '继续处理', 'low', ?, ?)`)
    .run(id, now, now);
}

function insertCandidate(raw: import('node:sqlite').DatabaseSync, id: string, sourceId: string, unitId: string, taskId: string) {
  raw.prepare(`INSERT INTO candidate_request
    (id, source_event_id, demand_unit_id, title, proposer_name, background, validation_question, describe,
     confidence, state, accepted_task_id, created_at, updated_at)
    VALUES (?, ?, ?, '候选摘要', '需求方', '背景', '问题', '摘要', 0.98, 'accepted', ?, ?, ?)`)
    .run(id, sourceId, unitId, taskId, now, now);
}

function hash(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function logicalSnapshot(path: string) {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = raw.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string; sql: string }>;
    return JSON.stringify({
      userVersion: raw.prepare('PRAGMA user_version').get(),
      tables: tables.map(({ name, sql }) => ({
        name,
        sql,
        rows: raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      })),
    });
  } finally {
    raw.close();
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('DATA-02 四层关系迁移与审计约束', () => {
  it('v1→v2 唯一关系精确回填，并保留可追踪任务来源边', () => {
    const path = v1Database('unique');
    const v1 = new DatabaseSync(path);
    insertSource(v1);
    insertUnit(v1, 'unit-a', 'source-shared', 'u1');
    insertTask(v1);
    insertCandidate(v1, 'candidate-a', 'source-shared', 'unit-a', 'task-shared');
    v1.prepare(`INSERT INTO task_source_link (task_id, source_event_id, relation_type, created_at)
      VALUES ('task-shared', 'source-shared', 'origin', ?)`).run(now);
    v1.close();

    const upgraded = new AppDatabase(path, false);
    expect(upgraded.raw.prepare('SELECT demand_unit_id FROM task_source_link').get()).toEqual({ demand_unit_id: 'unit-a' });
    expect(upgraded.raw.prepare('SELECT COUNT(*) AS count FROM data_integrity_gap').get()).toEqual({ count: 0 });
    upgraded.close();
  });

  it('v1→v2 复合边重建保留每条 legacy 行并在重启后保持同一关系哈希', () => {
    const path = v1Database('edge-rebuild');
    const v1 = new DatabaseSync(path);
    insertSource(v1, 'source-one');
    insertSource(v1, 'source-two');
    insertUnit(v1, 'unit-one', 'source-one', 'u1');
    insertUnit(v1, 'unit-two', 'source-two', 'u2');
    insertTask(v1);
    insertCandidate(v1, 'candidate-one', 'source-one', 'unit-one', 'task-shared');
    insertCandidate(v1, 'candidate-two', 'source-two', 'unit-two', 'task-shared');
    v1.prepare(`INSERT INTO task_source_link (task_id, source_event_id, relation_type, created_at)
      VALUES ('task-shared', 'source-one', 'origin-one', ?),
             ('task-shared', 'source-two', 'origin-two', ?)`).run(now, now);
    v1.close();

    const expected = [
      { task_id: 'task-shared', source_event_id: 'source-one', demand_unit_id: 'unit-one', relation_type: 'origin-one' },
      { task_id: 'task-shared', source_event_id: 'source-two', demand_unit_id: 'unit-two', relation_type: 'origin-two' },
    ];
    const upgraded = new AppDatabase(path, false);
    const rows = upgraded.raw.prepare(`SELECT task_id, source_event_id, demand_unit_id, relation_type
      FROM task_source_link ORDER BY source_event_id`).all();
    expect(rows).toEqual(expected);
    const firstHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    upgraded.close();

    const reopened = new AppDatabase(path, false);
    const reopenedRows = reopened.raw.prepare(`SELECT task_id, source_event_id, demand_unit_id, relation_type
      FROM task_source_link ORDER BY source_event_id`).all();
    expect(createHash('sha256').update(JSON.stringify(reopenedRows)).digest('hex')).toBe(firstHash);
    reopened.close();
  });

  it('共享来源的两个需求单元保持 nullable 旧边并写入持久 gap，清理 app_log 不会擦掉报告', () => {
    const path = v1Database('ambiguous');
    const v1 = new DatabaseSync(path);
    insertSource(v1);
    insertUnit(v1, 'unit-a', 'source-shared', 'u1');
    insertUnit(v1, 'unit-b', 'source-shared', 'u2');
    insertTask(v1);
    insertCandidate(v1, 'candidate-a', 'source-shared', 'unit-a', 'task-shared');
    insertCandidate(v1, 'candidate-b', 'source-shared', 'unit-b', 'task-shared');
    v1.prepare(`INSERT INTO task_source_link (task_id, source_event_id, relation_type, created_at)
      VALUES ('task-shared', 'source-shared', 'origin', ?)`).run(now);
    v1.close();

    const upgraded = new AppDatabase(path, false);
    expect(upgraded.raw.prepare('SELECT demand_unit_id FROM task_source_link').get()).toEqual({ demand_unit_id: null });
    expect(upgraded.raw.prepare(`SELECT source_event_id, task_id, record_table, record_id, reason, status
      FROM data_integrity_gap WHERE record_table = 'task_source_link'`).get()).toEqual({
      source_event_id: 'source-shared', task_id: 'task-shared', record_table: 'task_source_link',
      record_id: 'task-shared:source-shared', reason: 'missing_or_ambiguous_demand_unit', status: 'open',
    });
    upgraded.raw.prepare(`INSERT INTO app_log (id, category, level, event_type, summary, context_json, created_at)
      VALUES ('log-1', 'runtime', 'warn', 'data_integrity_gap', '短期日志', '{}', ?)`).run(now);
    upgraded.raw.prepare('DELETE FROM app_log').run();
    expect(upgraded.raw.prepare(`SELECT COUNT(*) AS count FROM data_integrity_gap
      WHERE record_table = 'task_source_link' AND status = 'open'`).get()).toEqual({ count: 1 });
    upgraded.close();
  });

  it('重建后允许同任务同来源的两条显式需求边，重复边和外键错配均 fail-closed', () => {
    const database = new AppDatabase(':memory:', false);
    const foreignKeys = database.raw.prepare(`PRAGMA foreign_key_list('task_source_link')`).all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    expect(foreignKeys.filter((foreignKey) => foreignKey.table === 'source_demand_unit_source')
      .map((foreignKey) => `${foreignKey.from}->${foreignKey.to}`).sort())
      .toEqual(['demand_unit_id->demand_unit_id', 'source_event_id->source_event_id']);
    expect(foreignKeys.filter((foreignKey) => foreignKey.table === 'source_demand_unit_source')
      .every((foreignKey) => foreignKey.on_delete === 'NO ACTION')).toBe(true);
    insertSource(database.raw);
    insertSource(database.raw, 'source-b');
    insertUnit(database.raw, 'unit-a', 'source-shared', 'u1');
    insertUnit(database.raw, 'unit-b', 'source-shared', 'u2');
    insertTask(database.raw);
    database.raw.prepare(`INSERT INTO task_source_link (task_id, source_event_id, demand_unit_id, relation_type, created_at)
      VALUES ('task-shared', 'source-shared', 'unit-a', 'origin', ?),
             ('task-shared', 'source-shared', 'unit-b', 'origin', ?)`).run(now, now);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_source_link WHERE task_id = ? AND source_event_id = ?')
      .get('task-shared', 'source-shared')).toEqual({ count: 2 });
    expect(() => database.raw.prepare(`INSERT INTO task_source_link
      (task_id, source_event_id, demand_unit_id, relation_type, created_at)
      VALUES ('task-shared', 'source-shared', 'unit-a', 'origin', ?)`).run(now)).toThrow();
    expect(() => database.raw.prepare(`INSERT INTO task_source_link
      (task_id, source_event_id, demand_unit_id, relation_type, created_at)
      VALUES ('task-shared', 'source-shared', 'missing-unit', 'origin', ?)`).run(now)).toThrow();
    // Both IDs exist, but source-b is not a member of unit-a. The composite
    // relationship FK must reject this cross-chain edge.
    expect(() => database.raw.prepare(`INSERT INTO task_source_link
      (task_id, source_event_id, demand_unit_id, relation_type, created_at)
      VALUES ('task-shared', 'source-b', 'unit-a', 'origin', ?)`).run(now)).toThrow();
    // A legacy edge remains representable without selecting a demand unit.
    database.raw.prepare(`INSERT INTO task_source_link
      (task_id, source_event_id, demand_unit_id, relation_type, created_at)
      VALUES ('task-shared', 'source-shared', NULL, 'legacy', ?)`).run(now);
    expect(database.raw.prepare(`SELECT COUNT(*) AS count FROM task_source_link
      WHERE task_id = 'task-shared' AND source_event_id = 'source-shared' AND demand_unit_id IS NULL`).get())
      .toEqual({ count: 1 });
    database.close();
  });

  it('显式边删除和更新保持 fail-closed，不静默降级为 NULL 或留下孤儿', () => {
    const database = new AppDatabase(':memory:', false);
    insertSource(database.raw);
    insertUnit(database.raw, 'unit-a', 'source-shared', 'u1');
    insertTask(database.raw);
    database.raw.prepare(`INSERT INTO task_source_link
      (task_id, source_event_id, demand_unit_id, relation_type, created_at)
      VALUES ('task-shared', 'source-shared', 'unit-a', 'origin', ?)`).run(now);

    expect(() => database.raw.prepare(`DELETE FROM source_demand_unit_source
      WHERE demand_unit_id = 'unit-a' AND source_event_id = 'source-shared'`).run()).toThrow();
    expect(() => database.raw.prepare(`UPDATE source_demand_unit_source
      SET source_event_id = 'missing-source'
      WHERE demand_unit_id = 'unit-a' AND source_event_id = 'source-shared'`).run()).toThrow();
    expect(() => database.raw.prepare(`DELETE FROM source_demand_unit WHERE id = 'unit-a'`).run()).toThrow();
    expect(database.raw.prepare(`SELECT demand_unit_id FROM task_source_link
      WHERE task_id = 'task-shared' AND source_event_id = 'source-shared'`).get())
      .toEqual({ demand_unit_id: 'unit-a' });

    // Existing task/source CASCADE semantics remain explicit: deleting the
    // source removes the edge, never leaving an orphan or a NULL downgrade.
    database.raw.prepare(`DELETE FROM source_event WHERE id = 'source-shared'`).run();
    expect(database.raw.prepare(`SELECT COUNT(*) AS count FROM task_source_link
      WHERE task_id = 'task-shared' AND source_event_id = 'source-shared'`).get()).toEqual({ count: 0 });
    expect(database.raw.prepare(`SELECT COUNT(*) AS count FROM task WHERE id = 'task-shared'`).get()).toEqual({ count: 1 });
    database.close();
  });

  it('v2 重启保持同一 schema/ledger，未知 partial v2 在任何改写前拒绝', () => {
    const path = v1Database('partial');
    const first = new AppDatabase(path, false);
    first.close();
    const before = hash(path);
    const partial = new DatabaseSync(path);
    partial.exec('ALTER TABLE task_source_link ADD COLUMN partial_v2_marker TEXT;');
    partial.close();
    const partialHash = hash(path);
    expect(() => new AppDatabase(path, false)).toThrow();
    expect(hash(path)).toBe(partialHash);
    expect(hash(path)).not.toBe(before);

    const reopened = new AppDatabase(':memory:', false);
    const version = reopened.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(8);
    reopened.close();
  });

  it('DATA-02 唯一索引失败时整库回滚并从升级前备份恢复，不留下 partial gap', () => {
    const path = v1Database('unique-index-failure');
    const raw = new DatabaseSync(path);
    try {
      insertSource(raw);
      insertTask(raw);
      raw.prepare(`INSERT INTO task_source_link (task_id, source_event_id, relation_type, created_at)
        VALUES ('task-shared', 'source-shared', 'origin', ?)`).run(now);
    } finally {
      raw.close();
    }
    const relationBatch = RELATION_CONSTRAINT_MIGRATION_DESCRIPTOR.orderedOperations[0]!;
    const ambiguousIndex = relationBatch.kind === 'sql_batch'
      ? relationBatch.statements.findIndex((statement) => statement.includes('idx_task_source_link_ambiguous'))
      : -1;
    expect(ambiguousIndex).toBeGreaterThan(0);
    const injected: MigrationOperation = {
      id: 'data-02-duplicate-ambiguous-edge',
      kind: 'sql_batch',
      statements: [
        `INSERT INTO task_source_link (task_id, source_event_id, demand_unit_id, relation_type, created_at)
         VALUES ('task-shared', 'source-shared', NULL, 'duplicate', '${now}')`,
      ],
    };
    const descriptor = {
      ...RELATION_CONSTRAINT_MIGRATION_DESCRIPTOR,
      orderedOperations: [
        { ...relationBatch, statements: relationBatch.kind === 'sql_batch' ? relationBatch.statements.slice(0, ambiguousIndex) : [] },
        injected,
        { ...relationBatch, statements: relationBatch.kind === 'sql_batch' ? relationBatch.statements.slice(ambiguousIndex) : [] },
        ...RELATION_CONSTRAINT_MIGRATION_DESCRIPTOR.orderedOperations.slice(1),
      ],
    };
    const before = logicalSnapshot(path);
    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: descriptor })).toThrow();
    expect(logicalSnapshot(path)).toBe(before);
    const restored = new DatabaseSync(path, { readOnly: true });
    try {
      expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(restored.prepare("SELECT name FROM sqlite_master WHERE name = 'data_integrity_gap'").get()).toBeUndefined();
      expect(restored.prepare('SELECT COUNT(*) AS count FROM task_source_link').get()).toEqual({ count: 1 });
    } finally {
      restored.close();
    }
  });

  it('DATA-02 注入中途失败时整库回滚并恢复，gap 表与 schema 版本不推进', () => {
    const path = v1Database('mid-migration-failure');
    const raw = new DatabaseSync(path);
    try {
      insertSource(raw);
      insertUnit(raw, 'unit-a', 'source-shared', 'u1');
      insertTask(raw);
      raw.prepare(`INSERT INTO task_source_link (task_id, source_event_id, relation_type, created_at)
        VALUES ('task-shared', 'source-shared', 'origin', ?)`).run(now);
    } finally {
      raw.close();
    }
    const before = logicalSnapshot(path);
    const relationBatch = RELATION_CONSTRAINT_MIGRATION_DESCRIPTOR.orderedOperations[0]!;
    const injected: MigrationOperation = {
      id: 'data-02-injected-mid-migration-failure',
      kind: 'sql_batch',
      statements: ["INSERT INTO __missing_data02_table VALUES ('synthetic-data02-failure')"],
    };
    const descriptor = {
      ...RELATION_CONSTRAINT_MIGRATION_DESCRIPTOR,
      orderedOperations: [relationBatch, injected, ...RELATION_CONSTRAINT_MIGRATION_DESCRIPTOR.orderedOperations.slice(1)],
    };
    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: descriptor })).toThrow();
    expect(logicalSnapshot(path)).toBe(before);
    const restored = new DatabaseSync(path, { readOnly: true });
    try {
      expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(restored.prepare("SELECT name FROM sqlite_master WHERE name = 'data_integrity_gap'").get()).toBeUndefined();
    } finally {
      restored.close();
    }
  });

  it('缺口查询只按结构化列精确匹配，不把前缀、子串或通配符当成关联', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      TASK_MEMORY_ROOT: root('gap-lookup-memory'),
    });
    const database = new AppDatabase(':memory:', false);
    const service = new PmService(database, createAdapters(config), config);
    insertSource(database.raw, 'source-shared');
    insertSource(database.raw, 'source-shared-extra');
    database.raw.prepare(`INSERT INTO data_integrity_gap
      (id, source_event_id, record_table, record_id, reason, status, created_at, updated_at)
      VALUES ('gap-exact', 'source-shared', 'source_event', 'source-shared', 'exact', 'open', ?, ?),
             ('gap-prefix', 'source-shared-extra', 'source_event', 'source-shared-extra', 'prefix', 'open', ?, ?),
             ('gap-percent', 'source-shared-extra', 'source_event', '100%match', 'wildcard', 'open', ?, ?)`)
      .run(now, now, now, now, now, now);
    const chain = service.getAuditChain({ sourceEventId: 'source-shared' });
    expect(chain.integrity_gaps).toEqual([
      expect.objectContaining({ id: 'gap-exact', source_event_id: 'source-shared', gap_code: 'unknown' }),
    ]);
    database.close();
  });
});
