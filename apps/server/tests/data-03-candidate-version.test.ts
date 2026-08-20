import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppDatabase,
  CANDIDATE_VERSION_MIGRATION_DESCRIPTOR,
  CURRENT_SCHEMA_VERSION,
  type MigrationDescriptor,
  type MigrationOperation,
} from '../src/database.js';

const roots: string[] = [];

function databasePath(label: string) {
  const root = mkdtempSync(join(tmpdir(), `ai-pm-data03-${label}-`));
  roots.push(root);
  return join(root, 'data.sqlite');
}

function downgradeV4ToV3(path: string) {
  const database = new AppDatabase(path, false);
  database.close();
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
      DROP INDEX IF EXISTS idx_provider_retry_cooldown_retry_at;
      DROP TABLE IF EXISTS provider_retry_cooldown;
      ALTER TABLE candidate_request DROP COLUMN version;
      DELETE FROM schema_migration WHERE version IN (4, 5, 6, 7, 8);
      PRAGMA user_version = 3;
    `);
  } finally {
    raw.close();
  }
}

function digest(path: string) {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = raw.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string; sql: string }>;
    return createHash('sha256').update(JSON.stringify({
      userVersion: raw.prepare('PRAGMA user_version').get(),
      tables: tables.map(({ name, sql }) => ({ name, sql, rows: raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() })),
    })).digest('hex');
  } finally {
    raw.close();
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Issue #37 DATA-03 candidate version migration', () => {
  it('v3→v4 adds a deterministic version token and backfills existing candidates to 1', () => {
    const path = databasePath('backfill');
    const initial = new AppDatabase(path, false);
    initial.raw.prepare(`INSERT INTO source_event
      (id, external_id, source_type, conversation_id, sender_id, sender_name, content, owner_mentioned,
       source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
      VALUES ('data03-source', 'data03-external', 'owner_dm', 'data03-conversation', 'data03-sender', '合成发送者', '合成内容', 0,
              NULL, 'complete', '', '{}', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`).run();
    initial.raw.prepare(`INSERT INTO candidate_request
      (id, source_event_id, title, proposer_name, background, validation_question, describe, analysis_json,
       confidence, state, created_at, updated_at)
      VALUES ('data03-candidate', 'data03-source', '合成候选', '合成主人', '', '', '', '{}', 0.8, 'pending',
              '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`).run();
    initial.close();
    downgradeV4ToV3(path);

    const upgraded = new AppDatabase(path, false);
    try {
      expect(upgraded.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      expect(upgraded.raw.prepare('SELECT version FROM candidate_request WHERE id = ?').get('data03-candidate'))
        .toEqual({ version: 1 });
      expect(upgraded.raw.prepare('SELECT version, name FROM schema_migration ORDER BY version DESC LIMIT 1').get())
        .toEqual({ version: 8, name: 'run-02-provider-retry-cooldown' });
      expect(upgraded.raw.prepare('SELECT version, name FROM schema_migration WHERE version = 4').get())
        .toEqual({ version: 4, name: 'data-03-candidate-version-cas' });
    } finally {
      upgraded.close();
    }
  });

  it('reopening v4 is idempotent and preserves the candidate token', () => {
    const path = databasePath('reopen');
    const first = new AppDatabase(path, false);
    first.raw.prepare(`INSERT INTO source_event
      (id, external_id, source_type, conversation_id, sender_id, sender_name, content, owner_mentioned,
       source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
      VALUES ('data03-reopen-source', 'data03-reopen-external', 'owner_dm', 'data03-reopen-conversation', 'data03-sender', '合成发送者', '合成内容', 0,
              NULL, 'complete', '', '{}', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`).run();
    first.raw.prepare(`INSERT INTO candidate_request
      (id, source_event_id, title, proposer_name, background, validation_question, describe, analysis_json,
       confidence, state, version, created_at, updated_at)
      VALUES ('data03-reopen-candidate', 'data03-reopen-source', '合成候选', '合成主人', '', '', '', '{}', 0.8, 'pending', 7,
              '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`).run();
    first.close();
    const before = digest(path);
    const reopened = new AppDatabase(path, false);
    reopened.close();
    expect(digest(path)).toBe(before);
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      expect(raw.prepare('SELECT version FROM candidate_request WHERE id = ?').get('data03-reopen-candidate'))
        .toEqual({ version: 7 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM schema_migration').get()).toEqual({ count: 8 });
    } finally {
      raw.close();
    }
  });

  it('injected v4 failure restores the exact v3 database and leaves no v4 ledger row', () => {
    const path = databasePath('rollback');
    new AppDatabase(path, false).close();
    downgradeV4ToV3(path);
    const before = digest(path);
    const first = CANDIDATE_VERSION_MIGRATION_DESCRIPTOR.orderedOperations[0]!;
    if (first.kind !== 'sql_batch') throw new Error('candidate v4 SQL operation missing');
    const injected: MigrationOperation = {
      id: 'synthetic-data03-failure',
      kind: 'sql_batch',
      statements: ["INSERT INTO __missing_data03_table VALUES ('synthetic')"],
    };
    const descriptor: MigrationDescriptor = {
      ...CANDIDATE_VERSION_MIGRATION_DESCRIPTOR,
      orderedOperations: [first, injected, ...CANDIDATE_VERSION_MIGRATION_DESCRIPTOR.orderedOperations.slice(1)],
    };
    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: descriptor })).toThrowError(expect.objectContaining({ stage: 'migration' }));
    expect(digest(path)).toBe(before);
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM schema_migration').get()).toEqual({ count: 3 });
      expect(raw.prepare('PRAGMA table_info(candidate_request)').all())
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'version' })]));
    } finally {
      raw.close();
    }
  });

  it('unknown partial v4 schema is rejected before mutation', () => {
    const path = databasePath('partial');
    new AppDatabase(path, false).close();
    downgradeV4ToV3(path);
    const partial = new DatabaseSync(path);
    partial.exec('ALTER TABLE candidate_request ADD COLUMN version INTEGER NOT NULL DEFAULT 1;');
    partial.close();
    const before = digest(path);
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ stage: expect.any(String) }));
    expect(digest(path)).toBe(before);
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      expect(raw.prepare('SELECT COUNT(*) AS count FROM schema_migration').get()).toEqual({ count: 3 });
    } finally {
      raw.close();
    }
  });
});
