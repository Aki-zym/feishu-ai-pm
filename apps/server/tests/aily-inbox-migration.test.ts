import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AILY_SUMMARY_INBOX_MIGRATION_CHECKSUM,
  CURRENT_SCHEMA_VERSION,
  AppDatabase,
} from '../src/database.js';

describe('Aily summary inbox schema v9', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('fresh database records the v9 descriptor and creates the controlled inbox indexes', () => {
    const database = new AppDatabase(':memory:', false);
    try {
      expect((database.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
        .toBe(CURRENT_SCHEMA_VERSION);
      expect(database.raw.prepare(
        'SELECT name, checksum FROM schema_migration WHERE version = 9',
      ).get()).toEqual({
        name: 'aily-summary-inbox',
        checksum: AILY_SUMMARY_INBOX_MIGRATION_CHECKSUM,
      });
      expect(database.raw.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'aily_summary_inbox'",
      ).get()).toEqual({ name: 'aily_summary_inbox' });
      expect(database.raw.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_aily_summary_inbox_%'",
      ).get()).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it('upgrades an exact v8 database to v9 without changing existing task data', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'toomanytasks-v8-v9-'));
    roots.push(temporaryRoot);
    const root = await realpath(temporaryRoot);
    const path = join(root, 'ai-pm.sqlite');
    const created = new AppDatabase(path, true);
    const taskCount = (created.raw.prepare('SELECT COUNT(*) AS count FROM task').get() as { count: number }).count;
    created.close();

    const v8 = new DatabaseSync(path);
    v8.exec(`
      DROP TABLE aily_summary_inbox;
      DELETE FROM schema_migration WHERE version = 9;
      PRAGMA user_version = 8;
    `);
    v8.close();

    const upgraded = new AppDatabase(path, false);
    try {
      expect((upgraded.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(9);
      expect(upgraded.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: taskCount });
      expect(upgraded.raw.prepare('SELECT COUNT(*) AS count FROM aily_summary_inbox').get()).toEqual({ count: 0 });
      expect(upgraded.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(upgraded.raw.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      upgraded.close();
    }
  });
});
