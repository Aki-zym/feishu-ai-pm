import { describe, expect, it } from 'vitest';
import { basename, dirname } from 'node:path';
import { DESKTOP_DATABASE_FILE, LEGACY_DATABASE_FILE, resolveDesktopDatabasePaths } from './database-path.js';

describe('desktop database path contract', () => {
  it('uses a new v1 file and keeps the historical filename distinct', () => {
    const paths = resolveDesktopDatabasePaths('synthetic-user-data');
    expect(basename(dirname(paths.databasePath))).toBe('data');
    expect(basename(dirname(paths.legacyDatabasePath))).toBe('data');
    expect(basename(paths.databasePath)).toBe(DESKTOP_DATABASE_FILE);
    expect(basename(paths.legacyDatabasePath)).toBe(LEGACY_DATABASE_FILE);
    expect(paths.databasePath).not.toBe(paths.legacyDatabasePath);
  });
});
