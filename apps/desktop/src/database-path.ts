import { join } from 'node:path';

/**
 * Issue #80 deliberately starts a fresh schema database when the pre-v1 file
 * exists. The legacy file is never opened by the desktop bootstrap.
 */
export const DESKTOP_DATABASE_FILE = 'ai-pm-v1.sqlite';
export const LEGACY_DATABASE_FILE = 'ai-pm.sqlite';

export function resolveDesktopDatabasePaths(userData: string) {
  const dataDirectory = join(userData, 'data');
  return {
    dataDirectory,
    databasePath: join(dataDirectory, DESKTOP_DATABASE_FILE),
    legacyDatabasePath: join(dataDirectory, LEGACY_DATABASE_FILE),
  } as const;
}
