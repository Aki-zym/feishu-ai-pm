import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { shanghaiDayWindow } from './shanghai-time.js';

export const CURRENT_SCHEMA_VERSION = 8;

function registerData04SqlFunctions(database: DatabaseSync) {
  database.function('sha256', { deterministic: true }, (value: unknown) => createHash('sha256').update(String(value ?? '')).digest('hex'));
}

export const DATABASE_BACKUP_RETENTION = 3;
export type DatabaseUpgradeStage =
  | 'backup'
  | 'downgrade_gate'
  | 'ledger'
  | 'migration'
  | 'restore';

export class DatabaseUpgradeError extends Error {
  constructor(readonly stage: DatabaseUpgradeStage, message: string) {
    // Provider/OS errors can contain local paths or record details. Keep only
    // the controlled stage and message on the error that may reach desktop logs.
    super(message);
    this.name = 'DatabaseUpgradeError';
    this.stack = `${this.name}: ${message}`;
  }

  toJSON() {
    return { name: this.name, stage: this.stage, message: this.message };
  }
}

export interface DatabaseOptions {
  now?: () => Date;
  migrationDescriptorForTest?: MigrationDescriptor;
  transactionFaults?: {
    beforeCommit?: () => void;
  };
  privacyBackupFaults?: {
    beforeDiscard?: (fileName: string) => void;
    beforeStageRename?: (fileName: string) => void;
    beforeFinalizeManifestRemove?: (fileName: string) => void;
    beforeFinalizeSqliteRemove?: (fileName: string) => void;
  };
}

export interface DatabaseRestoreFaults {
  beforeStat?: () => void;
  beforeCandidateOpen?: () => void;
  beforeCandidateQuery?: () => void;
  beforeCopy?: () => void;
  beforeStagingInspect?: (path: string) => void;
  beforeStagingOpen?: () => void;
  beforeStagingQuery?: () => void;
  beforeMoveOriginal?: () => void;
  beforeInstall?: () => void;
  beforeFinalInspect?: (path: string) => void;
  beforeFinalOpen?: () => void;
  beforeFinalQuery?: () => void;
  beforeRemove?: () => void;
}

interface DatabaseRestoreOptions {
  faults?: DatabaseRestoreFaults;
  expectedDatabaseInstanceId?: string;
}

function integrityResult(database: DatabaseSync) {
  return database.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
}

function assertDatabaseIntegrity(database: DatabaseSync, stage: DatabaseUpgradeStage) {
  const rows = integrityResult(database);
  if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== 'ok') {
    throw new DatabaseUpgradeError(stage, 'SQLite 完整性检查失败；已停止数据库升级。');
  }
}

function assertForeignKeyIntegrity(database: DatabaseSync, stage: DatabaseUpgradeStage) {
  const rows = database.prepare('PRAGMA foreign_key_check').all() as Array<Record<string, unknown>>;
  if (rows.length > 0) {
    throw new DatabaseUpgradeError(stage, 'SQLite 外键完整性检查失败；已停止数据库升级。');
  }
}

function formatBackupTimestamp(date: Date) {
  return date.toISOString().replace(/[-:.]/gu, '');
}

const DATABASE_INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const DATABASE_METADATA_TABLE = 'database_metadata';
const DATABASE_METADATA_SQL = `CREATE TABLE IF NOT EXISTS database_metadata (
  singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
  database_instance_id TEXT NOT NULL UNIQUE CHECK (length(database_instance_id) = 32),
  created_at TEXT NOT NULL
);`;

function newDatabaseInstanceId() {
  return randomUUID().replaceAll('-', '');
}

function backupDirectory(databasePath: string) {
  return join(dirname(databasePath), 'backups');
}

function backupManifestPath(backupPath: string) {
  return `${backupPath}.manifest.json`;
}

function backupRecoveryMarkerPath(backupPath: string) {
  return `${backupPath}.pending-cleanup.json`;
}

function sha256File(path: string) {
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function plainSingleLinkFileStats(path: string) {
  try {
    const stats = lstatSync(path);
    return !stats.isSymbolicLink() && stats.isFile() && stats.nlink === 1 ? stats : undefined;
  } catch {
    return undefined;
  }
}

function pathExistsControlled(path: string, stage: DatabaseUpgradeStage) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false;
    throw new DatabaseUpgradeError(stage, '数据库文件状态无法安全确认；已拒绝继续。');
  }
}

function backupCompensationError(message: string, failures: unknown[]) {
  const errors = failures.filter((failure): failure is Error => failure instanceof Error);
  if (errors.length === 1) return errors[0]!;
  return new AggregateError(errors.length ? errors : failures, message);
}

function isPlainBackupDirectory(path: string) {
  try {
    const stats = lstatSync(path);
    return !stats.isSymbolicLink() && stats.isDirectory();
  } catch {
    return false;
  }
}

function assertPlainBackupDirectory(path: string, stage: DatabaseUpgradeStage) {
  if (!isPlainBackupDirectory(path)) {
    throw new DatabaseUpgradeError(stage, '数据库备份目录不符合受控目录要求；已拒绝继续。');
  }
}

function assertPlainSingleLinkFile(path: string, stage: DatabaseUpgradeStage) {
  if (!plainSingleLinkFileStats(path)) {
    throw new DatabaseUpgradeError(stage, '数据库文件必须是普通单链接文件；已拒绝继续。');
  }
}

interface ManagedBackupName {
  fileName: string;
  fromVersion: number;
  toVersion: number;
  timestamp: string;
  createdAt: string;
}

function parseManagedBackupName(databasePath: string, backupPath: string): ManagedBackupName | undefined {
  const escapedName = basename(databasePath).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(
    `^${escapedName}\\.backup-v(0|[1-9]\\d*)-to-v(0|[1-9]\\d*)-(\\d{8}T\\d{9}Z)-[a-f0-9]{32}\\.sqlite$`,
    'u',
  ).exec(basename(backupPath));
  if (!match) return undefined;
  const createdAt = canonicalBackupTimestamp(match[3]!);
  if (!createdAt) return undefined;
  return {
    fileName: basename(backupPath),
    fromVersion: Number(match[1]),
    toVersion: Number(match[2]),
    timestamp: match[3]!,
    createdAt,
  };
}

interface ManagedBackupManifest {
  schema_version: 2;
  created_by: 'feishu-ai-pm';
  database_name: string;
  database_instance_id: string;
  backup_file: string;
  from_version: number;
  to_version: number;
  created_at: string;
  sha256: string;
}

function canonicalBackupTimestamp(timestamp: string) {
  if (!/^\d{8}T\d{9}Z$/u.test(timestamp)) return undefined;
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`
    + `T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}.${timestamp.slice(15, 18)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) || formatBackupTimestamp(date) !== timestamp ? undefined : iso;
}

function assertManagedBackupManifest(
  databasePath: string,
  backupPath: string,
  details: ManagedBackupName,
  expectedInstanceId: string,
  stage: DatabaseUpgradeStage,
) {
  const manifestPath = backupManifestPath(backupPath);
  assertPlainSingleLinkFile(manifestPath, stage);
  let manifest: Record<string, unknown>;
  try {
    const stats = plainSingleLinkFileStats(manifestPath);
    if (!stats || stats.size > 8 * 1024) throw new Error('invalid manifest size');
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new DatabaseUpgradeError(stage, '数据库备份 manifest 无法读取；已拒绝继续。');
  }
  const keys = Object.keys(manifest).sort();
  const expectedKeys = [
    'backup_file', 'created_at', 'created_by', 'database_instance_id', 'database_name',
    'from_version', 'schema_version', 'sha256', 'to_version',
  ].sort();
  if (details.toVersion > CURRENT_SCHEMA_VERSION) {
    throw new DatabaseUpgradeError('downgrade_gate', '备份 schema 高于当前应用支持版本；已拒绝恢复。');
  }
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || manifest.schema_version !== 2
    || manifest.created_by !== 'feishu-ai-pm'
    || manifest.database_name !== basename(databasePath)
    || manifest.database_instance_id !== expectedInstanceId
    || !DATABASE_INSTANCE_ID_PATTERN.test(expectedInstanceId)
    || manifest.backup_file !== details.fileName
    || manifest.from_version !== details.fromVersion
    || manifest.to_version !== details.toVersion
    || !Number.isInteger(details.fromVersion)
    || details.fromVersion < 0
    || details.fromVersion > details.toVersion
    || details.toVersion !== CURRENT_SCHEMA_VERSION
    || manifest.created_at !== details.createdAt
    || typeof manifest.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(manifest.sha256)
    || manifest.sha256 !== sha256File(backupPath)
  ) {
    throw new DatabaseUpgradeError(stage, '数据库备份 manifest 校验失败；已拒绝继续。');
  }
  return manifest as unknown as ManagedBackupManifest;
}

function assertFileMatchesManifest(path: string, manifest: ManagedBackupManifest, stage: DatabaseUpgradeStage) {
  if (sha256File(path) !== manifest.sha256) {
    throw new DatabaseUpgradeError(stage, '数据库备份内容与受控 manifest 不一致；已拒绝继续。');
  }
}

function assertManagedBackupLocation(databasePath: string, backupPath: string, stage: DatabaseUpgradeStage) {
  const resolvedDatabasePath = resolve(databasePath);
  const resolvedBackupPath = resolve(backupPath);
  const expectedDirectory = resolve(backupDirectory(resolvedDatabasePath));
  if (
    dirname(resolvedBackupPath) !== expectedDirectory
    || !parseManagedBackupName(resolvedDatabasePath, resolvedBackupPath)
  ) {
    throw new DatabaseUpgradeError(stage, '只允许使用当前数据库的受管升级备份。');
  }
  try {
    assertPlainSingleLinkFile(resolvedDatabasePath, stage);
    assertPlainBackupDirectory(expectedDirectory, stage);
    assertPlainSingleLinkFile(resolvedBackupPath, stage);
    assertPlainSingleLinkFile(backupManifestPath(resolvedBackupPath), stage);
    const realDatabaseParent = realpathSync(dirname(resolvedDatabasePath));
    const realDatabase = realpathSync(resolvedDatabasePath);
    const realDirectory = realpathSync(expectedDirectory);
    const realBackup = realpathSync(resolvedBackupPath);
    const realManifest = realpathSync(backupManifestPath(resolvedBackupPath));
    if (
      normalizedComparablePath(realDatabaseParent) !== normalizedComparablePath(dirname(resolvedDatabasePath))
      || !managedPathIsContained(realDatabaseParent, realDatabase, basename(resolvedDatabasePath))
      || normalizedComparablePath(realDirectory) !== normalizedComparablePath(expectedDirectory)
      || normalizedComparablePath(realDirectory) !== normalizedComparablePath(join(realDatabaseParent, 'backups'))
      || !managedPathIsContained(realDirectory, realBackup, basename(resolvedBackupPath))
      || !managedPathIsContained(realDirectory, realManifest, basename(backupManifestPath(resolvedBackupPath)))
    ) {
      throw new DatabaseUpgradeError(stage, '数据库备份真实路径不在受控目录内；已拒绝继续。');
    }
    return {
      databasePath: resolvedDatabasePath,
      backupPath: resolvedBackupPath,
      directory: expectedDirectory,
      details: parseManagedBackupName(resolvedDatabasePath, resolvedBackupPath)!,
    };
  } catch (error) {
    if (error instanceof DatabaseUpgradeError) throw error;
    throw new DatabaseUpgradeError(stage, '数据库备份路径无法安全验证；已拒绝继续。');
  }
}

function verifyManagedBackup(
  databasePath: string,
  backupPath: string,
  expectedInstanceId: string,
  stage: DatabaseUpgradeStage,
  faults?: DatabaseRestoreFaults,
) {
  try {
    const location = assertManagedBackupLocation(databasePath, backupPath, stage);
    const manifest = assertManagedBackupManifest(
      location.databasePath,
      location.backupPath,
      location.details,
      expectedInstanceId,
      stage,
    );
    assertFileMatchesManifest(location.backupPath, manifest, stage);
    const identity = inspectDatabaseFile(location.backupPath, stage, faults, 'candidate');
    if (identity.version !== manifest.from_version || identity.instanceId !== expectedInstanceId) {
      throw new DatabaseUpgradeError(stage, '数据库备份版本与受控 manifest 不一致；已拒绝继续。');
    }
    return { ...location, manifest, identity };
  } catch (error) {
    if (error instanceof DatabaseUpgradeError) throw error;
    throw new DatabaseUpgradeError(stage, '数据库备份无法安全验证；已拒绝继续。');
  }
}

function cleanupManagedBackups(
  databasePath: string,
  expectedInstanceId: string,
  retain = DATABASE_BACKUP_RETENTION,
  protectedBackupPath?: string,
) {
  const directory = backupDirectory(databasePath);
  if (!isPlainBackupDirectory(directory)) return;
  try {
    const backups = readdirSync(directory)
      .flatMap((name) => {
        const backupPath = join(directory, name);
        if (!parseManagedBackupName(databasePath, backupPath)) return [];
        try {
          // Retention only needs to decide whether an old file is a verified
          // managed backup before removing it. Opening every SQLite file and
          // running full schema/integrity inspection here made the migration
          // gate exceed Vitest's 5s task budget on a modest backup set. The
          // manifest is already bound to the instance, name, version and file
          // hash; full SQLite inspection remains mandatory for restore and
          // privacy purge paths.
          const location = assertManagedBackupLocation(databasePath, backupPath, 'backup');
          const manifest = assertManagedBackupManifest(
            location.databasePath,
            location.backupPath,
            location.details,
            expectedInstanceId,
            'backup',
          );
          assertFileMatchesManifest(location.backupPath, manifest, 'backup');
          return [{
            name,
            backupPath: location.backupPath,
            manifestPath: backupManifestPath(location.backupPath),
            createdAt: location.details.createdAt,
          }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.name.localeCompare(left.name));
    const retained = new Set<string>();
    const protectedBackup = protectedBackupPath
      ? backups.find((backup) => normalizedComparablePath(backup.backupPath) === normalizedComparablePath(protectedBackupPath))
      : undefined;
    if (protectedBackup) retained.add(protectedBackup.name);
    for (const backup of backups) {
      if (retained.size >= retain) break;
      retained.add(backup.name);
    }
    for (const backup of backups) {
      if (retained.has(backup.name)) continue;
      // The metadata/hash verification above is the same proof used to build
      // this candidate list; do not reopen every old SQLite file a second
      // time while the migration gate is holding the database transaction.
      rmSync(backup.backupPath);
      rmSync(backup.manifestPath);
    }
  } catch {
    throw new DatabaseUpgradeError('backup', '无法完成受控备份保留清理；已拒绝继续启动。');
  }
}

interface TableColumnIdentity {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface TableIndexIdentity {
  table: string;
  name: string | null;
  unique: number;
  origin: string;
  partial: number;
  sql: string | null;
  columns: readonly {
    seqno: number;
    name: string | null;
    desc: number;
    coll: string;
    key: number;
  }[];
}

interface TableForeignKeyIdentity {
  table: string;
  referencedTable: string;
  columns: readonly {
    sequence: number;
    from: string;
    to: string;
  }[];
  onUpdate: string;
  onDelete: string;
  match: string;
}

interface CurrentSchemaIdentity {
  columns: ReadonlyMap<string, readonly TableColumnIdentity[]>;
  createSql: ReadonlyMap<string, string>;
  normalizedCreateSql: ReadonlyMap<string, string>;
  indexes: readonly TableIndexIdentity[];
  foreignKeys: readonly TableForeignKeyIdentity[];
}

interface LegacySchemaVariant {
  /** The only historical constraint omissions accepted by this variant. */
  readonly omittedChecks: readonly {
    table: string;
    column: string;
    expression: string;
  }[];
}

let canonicalRawLegacySchemaIdentityCache: CurrentSchemaIdentity | undefined;
let canonicalManagedLegacySchemaIdentityCache: CurrentSchemaIdentity | undefined;
let canonicalRawPreCandidateUniqueLegacySchemaIdentityCache: CurrentSchemaIdentity | undefined;
let canonicalManagedPreCandidateUniqueLegacySchemaIdentityCache: CurrentSchemaIdentity | undefined;

const VERSIONED_SCHEMA_IDENTITIES = deepFreeze({
  rawLegacyV0: {
    version: 0,
    name: 'release-0.2.0-raw-v0',
    sourceCommit: '8b6869b89323a79a31636a1290b9712e2127f0c6',
    checksum: 'dbfe4b0a5de4f446ccf061dd261df823e7e686136063cb235bbc0e355689f833',
  },
  // Commit 8b6869b created every table/index in the raw-v0 descriptor, then
  // added this partial UNIQUE index as a later startup step. A process stop at
  // that exact boundary can therefore leave this second complete checkpoint.
  rawPreCandidateUniqueLegacyV0: {
    version: 0,
    name: 'release-0.2.0-pre-candidate-current-unique-checkpoint',
    sourceCommit: '8b6869b89323a79a31636a1290b9712e2127f0c6',
    checksum: '1a9731598b599829ddaab8054bb6e8f5dc294c35cca64df9ed40c86f7f166a35',
  },
  managedLegacyV0: {
    version: 0,
    name: 'issue-35-managed-backup-v0',
    sourceCommit: 'issue-35-migration-v1',
    checksum: '75c19a2b77ef8694ce5fb300f3987cf41c63fde049ccf0d5ff98556d7e296803',
  },
  managedPreCandidateUniqueLegacyV0: {
    version: 0,
    name: 'issue-35-managed-pre-candidate-current-unique-v0',
    sourceCommit: 'issue-35-migration-v1',
    checksum: 'a5e246d4ab2c6a02a4cda13abf46c1228a3a8c00ef5710bce2be0b88e4e10796',
  },
  currentV1: {
    version: 1,
    name: 'issue-35-current-v1',
    sourceCommit: 'issue-35-migration-v1',
    checksum: '8d9353953adb60853067035823e949af4531384718adee181a7a63e01114f6ba',
  },
} as const);

function normalizedComparablePath(path: string) {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function managedPathIsContained(realDirectory: string, realFile: string, expectedName: string) {
  return normalizedComparablePath(dirname(realFile)) === normalizedComparablePath(realDirectory)
    && normalizedComparablePath(realFile) === normalizedComparablePath(join(realDirectory, expectedName));
}

function tableColumnIdentities(database: DatabaseSync) {
  return new Map(applicationTableNames(database).map((table) => [
    table,
    (database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as unknown as TableColumnIdentity[])
      .map(({ name, type, notnull, dflt_value, pk }) => ({
        name,
        type: type.toUpperCase(),
        notnull,
        dflt_value: normalizedSchemaSql(dflt_value),
        pk,
      })),
  ]));
}

function normalizedSchemaSql(sql: unknown) {
  return typeof sql === 'string' ? sql.replace(/\s+/gu, ' ').trim() : null;
}

function normalizedTableSchemaSql(sql: unknown) {
  const normalized = normalizedSchemaSql(sql);
  if (!normalized) return null;
  return normalized.replace(
    /^CREATE TABLE(?: IF NOT EXISTS)?\s+(?:"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)/iu,
    'CREATE TABLE __application_table__',
  );
}

function splitCreateTableParts(sql: string) {
  const start = sql.indexOf('(');
  const end = sql.lastIndexOf(')');
  if (start < 0 || end <= start) return [];
  const body = sql.slice(start + 1, end);
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let begin = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quote) {
      if (char === quote) {
        if (body[index + 1] === quote) index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(begin, index).trim());
      begin = index + 1;
    }
  }
  parts.push(body.slice(begin).trim());
  return parts.filter(Boolean);
}

function canonicalCreateTableParts(
  sql: string,
  table: string,
  omissions: LegacySchemaVariant['omittedChecks'] = [],
) {
  const normalized = normalizedTableSchemaSql(sql);
  if (!normalized) return undefined;
  const parts = splitCreateTableParts(normalized);
  const canonical = parts.map((part) => {
    let value = normalizedSchemaSql(part) ?? '';
    for (const omission of omissions.filter((candidate) => candidate.table === table)) {
      if (!value.startsWith(`\"${omission.column}\" `) && !value.startsWith(`${omission.column} `)) continue;
      const check = ` CHECK (${omission.expression})`;
      value = value.replace(check, '').replace(check.replace(' ', ''), '');
    }
    return value;
  });
  const columns = canonical.filter((part) => !/^(?:CONSTRAINT\s+[^ ]+\s+)?(?:PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/iu.test(part));
  const constraints = canonical.filter((part) => !columns.includes(part));
  return [...columns.sort((left, right) => left.localeCompare(right)), ...constraints];
}

function tableCreateSqlIdentities(database: DatabaseSync, tables: readonly string[]) {
  const createSql = new Map<string, string>();
  const normalizedCreateSql = new Map<string, string>();
  for (const table of tables) {
    const row = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { sql: string | null } | undefined;
    const normalized = normalizedTableSchemaSql(row?.sql);
    if (!row?.sql || !normalized) throw new Error('canonical application table SQL is missing');
    createSql.set(table, row.sql);
    normalizedCreateSql.set(table, normalized);
  }
  return { createSql, normalizedCreateSql };
}

function tableIndexIdentities(database: DatabaseSync, tables: readonly string[]) {
  const identities: TableIndexIdentity[] = [];
  for (const table of tables) {
    const indexes = database.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    for (const index of indexes) {
      const row = database.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      ).get(index.name) as { sql: string | null } | undefined;
      const columns = database.prepare(`PRAGMA index_xinfo(${JSON.stringify(index.name)})`).all() as Array<{
        seqno: number;
        name: string | null;
        desc: number;
        coll: string;
        key: number;
      }>;
      identities.push({
        table,
        name: index.origin === 'c' ? index.name : null,
        unique: index.unique,
        origin: index.origin,
        partial: index.partial,
        sql: index.origin === 'c' ? normalizedSchemaSql(row?.sql) : null,
        columns: columns.map(({ seqno, name, desc, coll, key }) => ({
          seqno,
          name,
          desc,
          coll,
          key,
        })),
      });
    }
  }
  return identities.sort((left, right) => (
    left.table.localeCompare(right.table)
    || JSON.stringify(left).localeCompare(JSON.stringify(right))
  ));
}

function tableForeignKeyIdentities(database: DatabaseSync, tables: readonly string[]) {
  const identities: TableForeignKeyIdentity[] = [];
  for (const table of tables) {
    const rows = database.prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }>;
    const groups = new Map<number, typeof rows>();
    for (const row of rows) {
      const group = groups.get(row.id) ?? [];
      group.push(row);
      groups.set(row.id, group);
    }
    for (const group of groups.values()) {
      const ordered = [...group].sort((left, right) => left.seq - right.seq);
      const first = ordered[0]!;
      identities.push({
        table,
        referencedTable: first.table,
        columns: ordered.map((row) => ({ sequence: row.seq, from: row.from, to: row.to })),
        onUpdate: first.on_update,
        onDelete: first.on_delete,
        match: first.match,
      });
    }
  }
  return identities.sort((left, right) => (
    left.table.localeCompare(right.table)
    || JSON.stringify(left).localeCompare(JSON.stringify(right))
  ));
}

function captureSchemaIdentity(database: DatabaseSync): CurrentSchemaIdentity {
  const columns = tableColumnIdentities(database);
  const tables = [...columns.keys()];
  return {
    columns,
    ...tableCreateSqlIdentities(database, tables),
    indexes: tableIndexIdentities(database, tables),
    foreignKeys: tableForeignKeyIdentities(database, tables),
  };
}

function schemaIdentityChecksum(identity: CurrentSchemaIdentity) {
  const payload = {
    columns: [...identity.columns].map(([table, columns]) => [table, columns]),
    createSql: [...identity.normalizedCreateSql],
    indexes: identity.indexes,
    foreignKeys: identity.foreignKeys,
  };
  return createHash('sha256').update(JSON.stringify(canonicalizeMigrationValue(payload))).digest('hex');
}

function schemaIdentityWithoutNamedIndexes(
  identity: CurrentSchemaIdentity,
  indexNames: ReadonlySet<string>,
): CurrentSchemaIdentity {
  return {
    columns: identity.columns,
    createSql: identity.createSql,
    normalizedCreateSql: identity.normalizedCreateSql,
    indexes: identity.indexes.filter((index) => !index.name || !indexNames.has(index.name)),
    foreignKeys: identity.foreignKeys,
  };
}

function canonicalLegacySchemaIdentity(managed: boolean) {
  const cached = managed ? canonicalManagedLegacySchemaIdentityCache : canonicalRawLegacySchemaIdentityCache;
  if (cached) return cached;
  const canonical = new DatabaseSync(':memory:');
  try {
    const descriptor = { ...BASELINE_MIGRATION_DESCRIPTOR, checksum: BASELINE_MIGRATION_CHECKSUM };
    executeMigrationOperations(canonical, descriptor, {
      databaseInstanceId: '00000000000000000000000000000000',
      instanceCreatedAt: '2026-08-15T00:00:00.000Z',
      appliedAt: '2026-08-15T00:00:00.000Z',
      preexistingTables: [],
    }, descriptor.orderedOperations.filter((operation) => (
      'legacyIdentity' in operation && operation.legacyIdentity === true
    )));
    if (!managed) canonical.exec(`DROP TABLE ${DATABASE_METADATA_TABLE};`);
    const identity = captureSchemaIdentity(canonical);
    const expected = managed ? VERSIONED_SCHEMA_IDENTITIES.managedLegacyV0 : VERSIONED_SCHEMA_IDENTITIES.rawLegacyV0;
    if (schemaIdentityChecksum(identity) !== expected.checksum) {
      throw new Error(`frozen schema identity drift: ${expected.name}`);
    }
    if (managed) canonicalManagedLegacySchemaIdentityCache = identity;
    else canonicalRawLegacySchemaIdentityCache = identity;
    return identity;
  } finally {
    canonical.close();
  }
}

function canonicalPreCandidateUniqueLegacySchemaIdentity(managed: boolean) {
  const cached = managed
    ? canonicalManagedPreCandidateUniqueLegacySchemaIdentityCache
    : canonicalRawPreCandidateUniqueLegacySchemaIdentityCache;
  if (cached) return cached;
  const identity = schemaIdentityWithoutNamedIndexes(
    canonicalLegacySchemaIdentity(managed),
    new Set([
      'idx_candidate_revision_current',
      'idx_task_update_auto',
      'idx_owner_decision_source',
      'idx_owner_decision_state',
    ]),
  );
  const expected = managed
    ? VERSIONED_SCHEMA_IDENTITIES.managedPreCandidateUniqueLegacyV0
    : VERSIONED_SCHEMA_IDENTITIES.rawPreCandidateUniqueLegacyV0;
  const actualChecksum = schemaIdentityChecksum(identity);
  if (actualChecksum !== expected.checksum) {
    throw new Error(`frozen schema identity drift: ${expected.name}:${actualChecksum}`);
  }
  if (managed) canonicalManagedPreCandidateUniqueLegacySchemaIdentityCache = identity;
  else canonicalRawPreCandidateUniqueLegacySchemaIdentityCache = identity;
  return identity;
}

function tableMatchesColumnIdentity(
  database: DatabaseSync,
  table: string,
  expectedColumns: readonly TableColumnIdentity[],
  options: { allowAdditional: boolean; compareDefaults: boolean },
) {
  const actualColumns = database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as unknown as TableColumnIdentity[];
  if (!options.allowAdditional && actualColumns.length !== expectedColumns.length) return false;
  const actualByName = new Map(actualColumns.map((column) => [column.name, column]));
  return expectedColumns.every((expected) => {
    const actual = actualByName.get(expected.name);
    return actual?.type.toUpperCase() === expected.type
      && actual.notnull === expected.notnull
      && (!options.compareDefaults || normalizedSchemaSql(actual.dflt_value) === expected.dflt_value)
      && actual.pk === expected.pk;
  });
}

function tableMatchesExactIdentity(
  database: DatabaseSync,
  table: string,
  expectedColumns: readonly TableColumnIdentity[],
) {
  return tableMatchesColumnIdentity(database, table, expectedColumns, {
    allowAdditional: false,
    compareDefaults: true,
  });
}

function controlledIdentifier(identifier: string) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new DatabaseUpgradeError('migration', '数据库迁移描述符包含无效表身份；已拒绝继续。');
  }
  return `"${identifier}"`;
}

function controlledSchemaIdentifier(identifier: string) {
  controlledIdentifier(identifier);
  return identifier;
}

function rewriteCreateTableName(sql: string, replacement: string) {
  const rewritten = sql.replace(
    /^CREATE TABLE(?: IF NOT EXISTS)?\s+(?:"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)/iu,
    `CREATE TABLE ${controlledIdentifier(replacement)}`,
  );
  if (rewritten === sql) {
    throw new DatabaseUpgradeError('migration', '数据库迁移描述符缺少受控建表定义；已拒绝继续。');
  }
  return rewritten;
}

function currentSchemaTableNames() {
  return [...schema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)/gu)]
    .map((match) => match[1]!);
}

function applicationTableNames(database: DatabaseSync) {
  return (database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((table) => table.name);
}

function assertNoUnknownSchemaObjects(database: DatabaseSync, stage: DatabaseUpgradeStage) {
  const unknown = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type IN ('view', 'trigger') AND name NOT LIKE 'sqlite_%' LIMIT 1",
  ).get();
  if (unknown) {
    throw new DatabaseUpgradeError(stage, '数据库包含不受支持的视图或触发器；已拒绝继续。');
  }
}

function schemaMatchesIdentity(
  database: DatabaseSync,
  expectedIdentity: CurrentSchemaIdentity,
  options: { legacy?: LegacySchemaVariant } = {},
) {
  const tables = applicationTableNames(database);
  const expectedTables = new Set(expectedIdentity.columns.keys());
  if (tables.length !== expectedTables.size || tables.some((table) => !expectedTables.has(table))) return false;
  for (const [table, expectedColumns] of expectedIdentity.columns) {
    if (!tableMatchesExactIdentity(database, table, expectedColumns)) return false;
  }
  const actualIndexes = tableIndexIdentities(database, tables);
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIdentity.indexes)) return false;
  for (const table of tables) {
    const row = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { sql: string | null } | undefined;
    if (options.legacy) {
      const expectedSql = expectedIdentity.createSql.get(table);
      const actualParts = canonicalCreateTableParts(row?.sql ?? '', table, options.legacy.omittedChecks);
      const expectedParts = canonicalCreateTableParts(expectedSql ?? '', table, options.legacy.omittedChecks);
      if (!actualParts || !expectedParts || JSON.stringify(actualParts) !== JSON.stringify(expectedParts)) return false;
    } else if (normalizedTableSchemaSql(row?.sql) !== expectedIdentity.normalizedCreateSql.get(table)) return false;
  }
  const actualForeignKeys = tableForeignKeyIdentities(database, tables);
  if (JSON.stringify(actualForeignKeys) !== JSON.stringify(expectedIdentity.foreignKeys)) return false;
  return true;
}

function readDatabaseInstanceIdentity(database: DatabaseSync, stage: DatabaseUpgradeStage, required: boolean) {
  const tables = applicationTableNames(database);
  if (!tables.includes(DATABASE_METADATA_TABLE)) {
    if (!required) return undefined;
    throw new DatabaseUpgradeError(stage, '数据库缺少受控实例身份；已拒绝继续。');
  }
  const rows = database.prepare(
    'SELECT singleton_key, database_instance_id, created_at FROM database_metadata',
  ).all() as Array<{ singleton_key: number; database_instance_id: string; created_at: string }>;
  if (!required && rows.length === 0) return undefined;
  const row = rows[0];
  if (
    rows.length !== 1
    || row?.singleton_key !== 1
    || !DATABASE_INSTANCE_ID_PATTERN.test(row.database_instance_id)
    || Number.isNaN(Date.parse(row.created_at))
  ) {
    throw new DatabaseUpgradeError(stage, '数据库实例身份校验失败；已拒绝继续。');
  }
  return { instanceId: row.database_instance_id, createdAt: row.created_at };
}

function bindDatabaseInstanceIdentity(database: DatabaseSync, instanceId: string, createdAt: string) {
  if (!DATABASE_INSTANCE_ID_PATTERN.test(instanceId) || Number.isNaN(Date.parse(createdAt))) {
    throw new DatabaseUpgradeError('migration', '数据库实例身份参数无效；已拒绝继续。');
  }
  database.exec(DATABASE_METADATA_SQL);
  const existing = readDatabaseInstanceIdentity(database, 'migration', false);
  if (existing && existing.instanceId !== instanceId) {
    throw new DatabaseUpgradeError('migration', '数据库实例身份冲突；已拒绝继续。');
  }
  if (!existing) {
    database.prepare(
      'INSERT INTO database_metadata (singleton_key, database_instance_id, created_at) VALUES (1, ?, ?)',
    ).run(instanceId, createdAt);
  }
}

function assertKnownLegacyIdentity(database: DatabaseSync, stage: DatabaseUpgradeStage) {
  const legacy = (): LegacySchemaVariant => ({
    omittedChecks: [
      { table: 'notification', column: 'notification_type', expression: "notification_type IN ('immediate','daily')" },
      { table: 'source_event', column: 'completeness', expression: "completeness IN ('complete','partial','limited')" },
      { table: 'task', column: 'record_state', expression: "record_state IN ('active','invalidated')" },
    ],
  });
  const raw = canonicalLegacySchemaIdentity(false);
  if (schemaMatchesIdentity(database, raw, { legacy: legacy() })) {
    return { managed: false, instanceId: undefined, createdAt: undefined };
  }
  const rawPreCandidateUnique = canonicalPreCandidateUniqueLegacySchemaIdentity(false);
  if (schemaMatchesIdentity(database, rawPreCandidateUnique, { legacy: legacy() })) {
    return { managed: false, instanceId: undefined, createdAt: undefined };
  }
  const managed = canonicalLegacySchemaIdentity(true);
  if (schemaMatchesIdentity(database, managed, { legacy: legacy() })) {
    const identity = readDatabaseInstanceIdentity(database, stage, true)!;
    return { managed: true, instanceId: identity.instanceId, createdAt: identity.createdAt };
  }
  const managedPreCandidateUnique = canonicalPreCandidateUniqueLegacySchemaIdentity(true);
  if (schemaMatchesIdentity(database, managedPreCandidateUnique, { legacy: legacy() })) {
    const identity = readDatabaseInstanceIdentity(database, stage, true)!;
    return { managed: true, instanceId: identity.instanceId, createdAt: identity.createdAt };
  }
  throw new DatabaseUpgradeError(stage, '数据库不符合受支持的完整历史 schema；已拒绝升级或恢复。');
}

function assertCurrentSchemaIdentity(
  database: DatabaseSync,
  stage: DatabaseUpgradeStage,
  descriptor: MigrationDescriptor = BASELINE_MIGRATION_DESCRIPTOR,
) {
  const assertion = descriptor.orderedOperations.find((operation) => operation.kind === 'assert_database');
  if (
    assertion?.kind !== 'assert_database'
    || schemaIdentityChecksum(captureSchemaIdentity(database)) !== assertion.expectedSchemaIdentityChecksum
  ) {
    throw new DatabaseUpgradeError(stage, '数据库当前版本的完整 schema 身份不一致；已拒绝继续。');
  }
  return readDatabaseInstanceIdentity(database, stage, true)!;
}

function inspectDatabaseIdentity(
  database: DatabaseSync,
  stage: DatabaseUpgradeStage,
  migrations: readonly (MigrationDescriptor & { checksum: string })[] = MIGRATIONS,
) {
  try {
    const userVersion = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (userVersion > CURRENT_SCHEMA_VERSION) {
      throw new DatabaseUpgradeError('downgrade_gate', '数据库 schema 高于当前应用支持版本；已拒绝继续。');
    }
    assertNoUnknownSchemaObjects(database, stage);
    const tables = applicationTableNames(database);
    const hasLedger = tables.includes('schema_migration');
    if (!hasLedger) {
      if (userVersion !== 0) {
        throw new DatabaseUpgradeError('downgrade_gate', '数据库缺少可验证的迁移账本；已拒绝继续。');
      }
      if (tables.length === 0) {
        throw new DatabaseUpgradeError(stage, '已存在的空 SQLite 不会被当作新数据库初始化。');
      }
      const legacy = assertKnownLegacyIdentity(database, stage);
      return {
        kind: 'known_legacy' as const,
        version: 0,
        instanceId: legacy.instanceId,
        instanceCreatedAt: legacy.createdAt,
      };
    }
    const rows = database.prepare(
      'SELECT version, name, checksum FROM schema_migration ORDER BY version',
    ).all() as Array<{ version: number; name: string; checksum: string }>;
    for (const [index, row] of rows.entries()) {
      const expected = migrations[index];
      if (!expected || row.version !== expected.version) {
        throw new DatabaseUpgradeError('downgrade_gate', '数据库包含当前应用无法识别的迁移版本；已拒绝继续。');
      }
      if (row.name !== expected.name || row.checksum !== expected.checksum) {
        throw new DatabaseUpgradeError('ledger', '数据库迁移账本校验失败；已拒绝继续。');
      }
    }
    if (rows.length === 0 || rows.at(-1)?.version !== userVersion) {
      throw new DatabaseUpgradeError('ledger', '数据库版本号与迁移账本不一致；已拒绝继续。');
    }
    if (userVersion < 0 || userVersion > CURRENT_SCHEMA_VERSION) {
      throw new DatabaseUpgradeError('downgrade_gate', '数据库 schema 版本不受当前应用支持；已拒绝继续。');
    }
    const descriptor = migrations.find((migration) => migration.version === userVersion);
    if (!descriptor) {
      throw new DatabaseUpgradeError('downgrade_gate', '数据库 schema 版本没有对应的受控迁移描述符；已拒绝继续。');
    }
    const identity = assertCurrentSchemaIdentity(database, stage, descriptor);
    return {
      kind: 'current' as const,
      version: userVersion,
      instanceId: identity.instanceId,
      instanceCreatedAt: identity.createdAt,
    };
  } catch (error) {
    if (error instanceof DatabaseUpgradeError) throw error;
    throw new DatabaseUpgradeError(stage, '数据库身份检查失败；已拒绝继续。');
  }
}

function inspectDatabaseFile(
  path: string,
  stage: DatabaseUpgradeStage,
  faults?: DatabaseRestoreFaults,
  phase: 'candidate' | 'staging' | 'final' = 'candidate',
) {
  let database: DatabaseSync | undefined;
  try {
    if (phase === 'candidate') faults?.beforeCandidateOpen?.();
    if (phase === 'staging') faults?.beforeStagingOpen?.();
    if (phase === 'final') faults?.beforeFinalOpen?.();
    database = new DatabaseSync(path, { readOnly: true });
    if (phase === 'candidate') faults?.beforeCandidateQuery?.();
    if (phase === 'staging') faults?.beforeStagingQuery?.();
    if (phase === 'final') faults?.beforeFinalQuery?.();
    assertDatabaseIntegrity(database, stage);
    assertForeignKeyIntegrity(database, stage);
    return inspectDatabaseIdentity(database, stage);
  } catch (error) {
    if (error instanceof DatabaseUpgradeError) throw error;
    throw new DatabaseUpgradeError(stage, '数据库文件无法安全检查；已拒绝继续。');
  } finally {
    try { database?.close(); } catch {}
  }
}

export function restoreDatabaseBackup(
  databasePath: string,
  backupPath: string,
  options: DatabaseRestoreOptions = {},
) {
  const resolvedDatabasePath = resolve(databasePath);
  const nonce = randomUUID().replaceAll('-', '');
  const stagingPath = `${resolvedDatabasePath}.restore-${nonce}.sqlite`;
  const rollbackPath = `${resolvedDatabasePath}.restore-rollback-${nonce}.sqlite`;
  const failedPath = `${resolvedDatabasePath}.restore-failed-${nonce}.sqlite`;
  let originalMoved = false;
  let replacementInstalled = false;
  try {
    options.faults?.beforeStat?.();
    assertManagedBackupLocation(resolvedDatabasePath, backupPath, 'restore');
    const currentIdentity = inspectDatabaseFile(resolvedDatabasePath, 'restore');
    const expectedInstanceId = options.expectedDatabaseInstanceId ?? currentIdentity.instanceId;
    if (
      !expectedInstanceId
      || !DATABASE_INSTANCE_ID_PATTERN.test(expectedInstanceId)
      || (currentIdentity.instanceId && currentIdentity.instanceId !== expectedInstanceId)
    ) {
      throw new DatabaseUpgradeError('restore', '当前数据库实例身份无法与备份安全绑定；已拒绝恢复。');
    }
    const verified = verifyManagedBackup(
      resolvedDatabasePath,
      backupPath,
      expectedInstanceId,
      'restore',
      options.faults,
    );
    if (
      pathExistsControlled(`${resolvedDatabasePath}-wal`, 'restore')
      || pathExistsControlled(`${resolvedDatabasePath}-shm`, 'restore')
      || pathExistsControlled(`${verified.backupPath}-wal`, 'restore')
      || pathExistsControlled(`${verified.backupPath}-shm`, 'restore')
    ) {
      throw new DatabaseUpgradeError('restore', '数据库仍可能被占用；已拒绝恢复以避免覆盖活动写入。');
    }
    options.faults?.beforeCopy?.();
    copyFileSync(verified.backupPath, stagingPath);
    assertPlainSingleLinkFile(stagingPath, 'restore');
    assertFileMatchesManifest(stagingPath, verified.manifest, 'restore');
    options.faults?.beforeStagingInspect?.(stagingPath);
    const stagingIdentity = inspectDatabaseFile(stagingPath, 'restore', options.faults, 'staging');
    if (stagingIdentity.version !== verified.identity.version || stagingIdentity.instanceId !== expectedInstanceId) {
      throw new DatabaseUpgradeError('restore', '数据库恢复副本身份校验失败；已拒绝继续。');
    }
    if (pathExistsControlled(resolvedDatabasePath, 'restore')) {
      options.faults?.beforeMoveOriginal?.();
      renameSync(resolvedDatabasePath, rollbackPath);
      originalMoved = true;
    }
    options.faults?.beforeInstall?.();
    renameSync(stagingPath, resolvedDatabasePath);
    replacementInstalled = true;
    assertFileMatchesManifest(resolvedDatabasePath, verified.manifest, 'restore');
    options.faults?.beforeFinalInspect?.(resolvedDatabasePath);
    const finalIdentity = inspectDatabaseFile(resolvedDatabasePath, 'restore', options.faults, 'final');
    if (finalIdentity.version !== verified.identity.version || finalIdentity.instanceId !== expectedInstanceId) {
      throw new DatabaseUpgradeError('restore', '数据库恢复结果身份校验失败；已拒绝继续。');
    }
    if (originalMoved) {
      options.faults?.beforeRemove?.();
      rmSync(rollbackPath);
      originalMoved = false;
    }
  } catch (error) {
    let rollbackFailed = false;
    try {
      if (pathExistsControlled(stagingPath, 'restore')) rmSync(stagingPath);
      if (originalMoved) {
        if (replacementInstalled && pathExistsControlled(resolvedDatabasePath, 'restore')) {
          renameSync(resolvedDatabasePath, failedPath);
        }
        if (pathExistsControlled(rollbackPath, 'restore')) renameSync(rollbackPath, resolvedDatabasePath);
        if (pathExistsControlled(failedPath, 'restore')) rmSync(failedPath);
      } else if (replacementInstalled && pathExistsControlled(resolvedDatabasePath, 'restore')) {
        rmSync(resolvedDatabasePath);
      }
    } catch {
      rollbackFailed = true;
    }
    if (rollbackFailed) {
      throw new DatabaseUpgradeError('restore', '数据库恢复失败且回滚未完成；已保留受控文件并拒绝启动。');
    }
    if (error instanceof DatabaseUpgradeError) throw error;
    throw new DatabaseUpgradeError('restore', '数据库恢复失败；原库和升级备份均未静默删除。');
  }
}

// MIGRATION_V1_SCHEMA_START
const schema = [
  `CREATE TABLE IF NOT EXISTS source_event (
    id TEXT PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    content TEXT NOT NULL,
    owner_mentioned INTEGER NOT NULL DEFAULT 0,
    source_url TEXT,
    completeness TEXT NOT NULL DEFAULT 'partial' CHECK (completeness IN ('complete','partial','limited')),
    discovery_reason TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    captured_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS source_context (
    id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
    context_type TEXT NOT NULL DEFAULT 'feishu_document',
    source_url TEXT NOT NULL,
    external_id TEXT NOT NULL,
    document_type TEXT NOT NULL,
    title TEXT,
    source_version TEXT,
    content_excerpt TEXT,
    content_hash TEXT,
    status TEXT NOT NULL CHECK (status IN ('ready','partial','unauthorized','unsupported','not_found','error')),
    freshness TEXT NOT NULL DEFAULT 'fresh' CHECK (freshness IN ('fresh','stale')),
    completeness TEXT NOT NULL DEFAULT 'limited' CHECK (completeness IN ('complete','partial','limited')),
    truncated INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_success_at TEXT,
    checked_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_event_id, source_url)
  );`,
  `CREATE TABLE IF NOT EXISTS source_demand_unit (
    id TEXT PRIMARY KEY,
    anchor_source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
    unit_key TEXT NOT NULL,
    unit_kind TEXT NOT NULL CHECK (unit_kind IN ('demand','context_only')),
    state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('provisional','ready','needs_confirmation','incomplete_context','superseded','failed_visible')),
    classification_revision TEXT,
    ai_decision_id TEXT,
    analysis_json TEXT NOT NULL DEFAULT '{}',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(anchor_source_event_id, unit_key)
  );`,
  `CREATE TABLE IF NOT EXISTS source_demand_unit_source (
    demand_unit_id TEXT NOT NULL REFERENCES source_demand_unit(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    source_role TEXT NOT NULL DEFAULT 'evidence' CHECK (source_role IN ('anchor','evidence','context')),
    sequence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (demand_unit_id, source_event_id),
    UNIQUE(demand_unit_id, source_key)
  );`,
  `CREATE TABLE IF NOT EXISTS candidate_request (
    id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
    demand_unit_id TEXT UNIQUE REFERENCES source_demand_unit(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    proposer_name TEXT NOT NULL,
    background TEXT NOT NULL,
    validation_question TEXT NOT NULL,
    describe TEXT NOT NULL,
    analysis_json TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','snoozed','ignored','accepted')),
    snoozed_until TEXT,
    accepted_task_id TEXT,
    merged_into_candidate_id TEXT REFERENCES candidate_request(id) ON DELETE SET NULL,
    merged_at TEXT,
    deleted_at TEXT,
    processing_state TEXT NOT NULL DEFAULT 'ready' CHECK (processing_state IN ('organizing','retry_waiting','ready','incomplete_context','recovered','failed_visible')),
    processing_job_id TEXT,
    processing_error TEXT,
    context_state TEXT NOT NULL DEFAULT 'complete' CHECK (context_state IN ('complete','possibly_incomplete')),
    context_reason TEXT,
    recovered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS candidate_merge_exclusion (
    candidate_a_id TEXT NOT NULL REFERENCES candidate_request(id) ON DELETE CASCADE,
    candidate_b_id TEXT NOT NULL REFERENCES candidate_request(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (candidate_a_id, candidate_b_id),
    CHECK (candidate_a_id < candidate_b_id)
  );`,
  `CREATE TABLE IF NOT EXISTS task (
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
    record_state TEXT NOT NULL DEFAULT 'active' CHECK (record_state IN ('active','invalidated')),
    merged_into_task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
    thread_id TEXT,
    auto_update_paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS task_source_link (
    task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL DEFAULT 'origin',
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, source_event_id)
  );`,
  `CREATE TABLE IF NOT EXISTS task_event (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('private','awaiting_approval','external')),
    summary TEXT NOT NULL,
    source_event_id TEXT REFERENCES source_event(id) ON DELETE SET NULL,
    before_json TEXT,
    after_json TEXT,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    version INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS correction_event (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
    candidate_id TEXT REFERENCES candidate_request(id) ON DELETE SET NULL,
    correction_type TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS notification (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES task(id) ON DELETE CASCADE,
    task_event_id TEXT REFERENCES task_event(id) ON DELETE CASCADE,
    candidate_id TEXT REFERENCES candidate_request(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL DEFAULT 'immediate' CHECK (notification_type IN ('immediate','daily')),
    dedupe_key TEXT,
    reason TEXT NOT NULL,
    read_at TEXT,
    snoozed_until TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS reminder (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    remind_at TEXT NOT NULL,
    relative_to TEXT,
    state TEXT NOT NULL DEFAULT 'scheduled',
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS reference_binding (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    reference_path TEXT NOT NULL,
    access_mode TEXT NOT NULL DEFAULT 'reference_only',
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS approval (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES task(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('awaiting_approval','approved','rejected')),
    created_at TEXT NOT NULL,
    decided_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    approval_id TEXT NOT NULL REFERENCES approval(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('awaiting_approval','ready','sent','failed')),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS job (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    locked_until TEXT,
    lease_owner TEXT,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    retryable INTEGER NOT NULL DEFAULT 1,
    backoff_seconds INTEGER NOT NULL DEFAULT 30,
    cancel_requested_at TEXT,
    idempotency_key TEXT,
    source_event_id TEXT REFERENCES source_event(id) ON DELETE SET NULL,
    thread_id TEXT,
    task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
    trace_id TEXT,
    last_error TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS owner_decision (
    id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
    source_revision TEXT NOT NULL,
    candidate_id TEXT REFERENCES candidate_request(id) ON DELETE SET NULL,
    thread_id TEXT REFERENCES requirement_thread(id) ON DELETE SET NULL,
    task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN ('continue','confirm_schedule','request_context','decline','delegate','uncertain')),
    disposition TEXT NOT NULL CHECK (disposition IN ('apply_task_patch','accept_candidate','decline_candidate','delegate_candidate','review','noop')),
    confidence REAL NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    delegate_to TEXT,
    schedule_text TEXT,
    patch_json TEXT NOT NULL DEFAULT '{}',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    runtime_job_id TEXT REFERENCES job(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','applied','review','failed','stale','noop')),
    target_snapshot_json TEXT NOT NULL DEFAULT '{}',
    applied_task_version INTEGER,
    applied_thread_version INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    applied_at TEXT,
    UNIQUE(source_event_id, source_revision)
  );`,
  `CREATE TABLE IF NOT EXISTS runtime_checkpoint (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
    step TEXT NOT NULL,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS runtime_tool_call (
    id TEXT PRIMARY KEY,
    job_id TEXT REFERENCES job(id) ON DELETE SET NULL,
    tool_name TEXT NOT NULL,
    policy TEXT NOT NULL CHECK (policy IN ('readonly','controlled_internal_write','approval_required','forbidden')),
    status TEXT NOT NULL CHECK (status IN ('allowed','blocked','completed','failed')),
    input_hash TEXT,
    result_json TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS requirement_thread (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','needs_confirmation','closed')),
    title TEXT NOT NULL,
    background TEXT NOT NULL DEFAULT '',
    validation_question TEXT NOT NULL DEFAULT '',
    describe TEXT NOT NULL DEFAULT '',
    analysis_json TEXT NOT NULL DEFAULT '{}',
    conversation_id TEXT,
    participant_ids_json TEXT NOT NULL DEFAULT '[]',
    ambiguity_json TEXT NOT NULL DEFAULT '[]',
    active_task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
    primary_source_event_id TEXT REFERENCES source_event(id) ON DELETE SET NULL,
    primary_reason TEXT NOT NULL DEFAULT '',
    primary_confidence REAL,
    version INTEGER NOT NULL DEFAULT 1,
    last_activity_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS requirement_thread_source (
    thread_id TEXT NOT NULL REFERENCES requirement_thread(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL DEFAULT 'primary',
    confidence REAL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    root_id TEXT,
    parent_id TEXT,
    session_id TEXT,
    conversation_id TEXT,
    participant_ids_json TEXT NOT NULL DEFAULT '[]',
    source_revision TEXT,
    source_role TEXT NOT NULL DEFAULT 'unknown',
    role_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, source_event_id)
  );`,
  `CREATE TABLE IF NOT EXISTS requirement_thread_unit (
    thread_id TEXT NOT NULL REFERENCES requirement_thread(id) ON DELETE CASCADE,
    demand_unit_id TEXT NOT NULL REFERENCES source_demand_unit(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL DEFAULT 'primary',
    confidence REAL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, demand_unit_id)
  );`,
  `CREATE TABLE IF NOT EXISTS requirement_thread_revision (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES requirement_thread(id) ON DELETE CASCADE,
    source_event_id TEXT REFERENCES source_event(id) ON DELETE SET NULL,
    demand_unit_id TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL,
    base_thread_version INTEGER NOT NULL,
    patch_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','accepted','rejected','stale')),
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS candidate_revision (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate_request(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
    demand_unit_id TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL,
    ai_decision_id TEXT REFERENCES ai_decision_log(id) ON DELETE SET NULL,
    source_revision TEXT NOT NULL,
    title TEXT NOT NULL,
    proposer_name TEXT NOT NULL,
    background TEXT NOT NULL,
    validation_question TEXT NOT NULL,
    describe TEXT NOT NULL,
    analysis_json TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'current' CHECK (state IN ('current','proposed','superseded','rejected')),
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS task_update_proposal (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    thread_id TEXT REFERENCES requirement_thread(id) ON DELETE SET NULL,
    source_event_id TEXT REFERENCES source_event(id) ON DELETE SET NULL,
    demand_unit_id TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL,
    candidate_revision_id TEXT REFERENCES candidate_revision(id) ON DELETE SET NULL,
    thread_revision_id TEXT REFERENCES requirement_thread_revision(id) ON DELETE SET NULL,
    base_thread_version INTEGER,
    base_task_version INTEGER NOT NULL,
    patch_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK (state IN ('awaiting_approval','approved','rejected','stale')),
    origin TEXT NOT NULL DEFAULT 'follow_up',
    association_confidence REAL,
    update_confidence REAL,
    used_fallback INTEGER NOT NULL DEFAULT 0,
    decision_mode TEXT NOT NULL DEFAULT 'pending',
    policy_version TEXT NOT NULL DEFAULT '',
    policy_reason TEXT NOT NULL DEFAULT '',
    applied_task_version INTEGER,
    applied_thread_version INTEGER,
    applied_task_event_id TEXT,
    before_snapshot_json TEXT NOT NULL DEFAULT '{}',
    after_snapshot_json TEXT NOT NULL DEFAULT '{}',
    reverted_at TEXT,
    reverted_task_event_id TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS app_setting (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS memory_projection (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE REFERENCES task(id) ON DELETE CASCADE,
    projection_version INTEGER NOT NULL DEFAULT 0,
    root_path TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','error')),
    checksum TEXT,
    managed_files_json TEXT NOT NULL DEFAULT '[]',
    last_error TEXT,
    last_projected_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS app_log (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    context_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS ai_decision_log (
    id TEXT PRIMARY KEY,
    source_event_id TEXT REFERENCES source_event(id) ON DELETE SET NULL,
    demand_unit_id TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL,
    candidate_id TEXT REFERENCES candidate_request(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    is_data_request INTEGER NOT NULL,
    confidence REAL,
    reason TEXT NOT NULL,
    output_json TEXT NOT NULL,
    used_fallback INTEGER NOT NULL DEFAULT 0,
    http_status INTEGER,
    provider_request_id TEXT,
    attempts INTEGER,
    structured_mode TEXT,
    input_hash TEXT,
    input_char_count INTEGER,
    fallback_mode TEXT,
    latency_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS job_source_link (
    job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (job_id, source_event_id)
  );`,
  `CREATE TABLE IF NOT EXISTS integration_health (
    id TEXT PRIMARY KEY,
    integration TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    details_json TEXT NOT NULL,
    latency_ms INTEGER,
    checked_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS reference_snapshot (
    id TEXT PRIMARY KEY,
    reference_binding_id TEXT NOT NULL REFERENCES reference_binding(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    entry_count INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    entries_json TEXT NOT NULL,
    error TEXT,
    inspected_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS sync_cursor (
    integration TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    cursor TEXT,
    last_success_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (integration, scope_key)
  );`,
  `CREATE TABLE IF NOT EXISTS owner_profile (
    id TEXT PRIMARY KEY,
    open_id TEXT NOT NULL,
    union_id TEXT,
    user_id TEXT,
    name TEXT NOT NULL,
    tenant_key TEXT,
    oauth_status TEXT NOT NULL CHECK (oauth_status IN ('mock','authorized','expired','revoked','unknown')),
    granted_scopes_json TEXT NOT NULL DEFAULT '[]',
    last_synced_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS information_source_state (
    source_kind TEXT PRIMARY KEY CHECK (source_kind IN ('owner_dm','owner_mentions','calendar','minutes','bot_supplement')),
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN ('mock_ready','ready','unauthorized','admin_required','partial','unsupported','error')),
    scope_summary TEXT NOT NULL,
    requires_admin INTEGER NOT NULL DEFAULT 0,
    requires_bot_in_chat INTEGER NOT NULL DEFAULT 0,
    sync_mode TEXT NOT NULL CHECK (sync_mode IN ('realtime','periodic','manual','mixed')),
    last_success_at TEXT,
    last_error TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS feishu_monitor_target (
    id TEXT PRIMARY KEY,
    owner_open_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('person','group')),
    target_key TEXT NOT NULL,
    resolved_chat_id TEXT,
    display_name TEXT NOT NULL,
    secondary_label TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    manual_excluded INTEGER NOT NULL DEFAULT 0,
    discovery_rank INTEGER,
    selection_version INTEGER NOT NULL DEFAULT 0,
    read_policy TEXT NOT NULL CHECK (read_policy IN ('incoming_only','owner_mentions')),
    selection_source TEXT NOT NULL CHECK (selection_source IN ('chat_list','contact_search')),
    access_status TEXT NOT NULL DEFAULT 'unknown' CHECK (access_status IN ('unknown','readable','restricted','not_found','error')),
    last_discovered_at TEXT,
    last_resolved_at TEXT,
    last_success_at TEXT,
    last_error TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner_open_id, target_kind, target_key)
  );`,
  DATABASE_METADATA_SQL,
  'CREATE INDEX IF NOT EXISTS idx_candidate_state ON candidate_request(state, created_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_candidate_merge_exclusion_b ON candidate_merge_exclusion(candidate_b_id, candidate_a_id);',
  'CREATE INDEX IF NOT EXISTS idx_task_status ON task(status, schedule_at);',
  'CREATE INDEX IF NOT EXISTS idx_task_event_task ON task_event(task_id, occurred_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_app_log_created ON app_log(created_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_ai_decision_created ON ai_decision_log(created_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_health_checked ON integration_health(checked_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_reference_snapshot_binding ON reference_snapshot(reference_binding_id, inspected_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_sync_cursor_updated ON sync_cursor(updated_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_source_event_occurred ON source_event(occurred_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_source_context_event ON source_context(source_event_id, updated_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_demand_unit_anchor ON source_demand_unit(anchor_source_event_id, state, updated_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_demand_unit_source_event ON source_demand_unit_source(source_event_id, demand_unit_id);',
  'CREATE INDEX IF NOT EXISTS idx_feishu_monitor_target_owner ON feishu_monitor_target(owner_open_id, target_kind, enabled, updated_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_runtime_job_status ON job(status, available_at, updated_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_runtime_checkpoint_job ON runtime_checkpoint(job_id, created_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_runtime_tool_job ON runtime_tool_call(job_id, started_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_requirement_thread_activity ON requirement_thread(status, last_activity_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_requirement_thread_source_event ON requirement_thread_source(source_event_id);',
  'CREATE INDEX IF NOT EXISTS idx_requirement_thread_unit ON requirement_thread_unit(demand_unit_id, thread_id);',
  'CREATE INDEX IF NOT EXISTS idx_thread_revision_state ON requirement_thread_revision(thread_id, state, created_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_candidate_revision_candidate ON candidate_revision(candidate_id, created_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_task_update_state ON task_update_proposal(state, created_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_memory_projection_state ON memory_projection(state, updated_at DESC);',
].join('\n');
// MIGRATION_V1_SCHEMA_END

// MIGRATION_V1_LOGIC_START
type MigrationColumn = readonly [table: string, column: string, definition: string];

type MigrationCopyMode = 'insert_select';
type MigrationConflictMode = 'abort';

interface MigrationTableRebuild {
  table: string;
  temporaryTable: string;
  createSql: string;
  targetColumns: readonly string[];
  sourceColumns: readonly string[];
  copyMode: MigrationCopyMode;
  conflictMode: MigrationConflictMode;
  indexSql: readonly string[];
}

type MigrationCondition =
  | Readonly<{ kind: 'table_sql_missing'; table: string; marker: string }>
  | Readonly<{ kind: 'unique_index_columns'; table: string; columns: readonly string[] }>;

export type MigrationOperation =
  | Readonly<{ id: string; kind: 'sql_batch'; statements: readonly string[]; legacyIdentity?: true }>
  | Readonly<{ id: string; kind: 'add_columns'; columns: readonly MigrationColumn[]; legacyIdentity?: true }>
  | Readonly<{ id: string; kind: 'assert_no_rows'; queries: readonly string[] }>
  | Readonly<{
    id: string;
    kind: 'conditional_rebuild';
    condition: MigrationCondition;
    rebuild: Readonly<MigrationTableRebuild>;
  }>
  | Readonly<{
    id: string;
    kind: 'rebuild_tables';
    tables: readonly Readonly<MigrationTableRebuild>[];
  }>
  | Readonly<{
    id: string;
    kind: 'bind_database_instance';
    createTableSql: string;
  }>
  | Readonly<{
    id: string;
    kind: 'assert_database';
    expectedSchemaIdentityChecksum: string;
    checks: readonly ('schema' | 'foreign_keys' | 'integrity')[];
  }>
  | Readonly<{
    id: string;
    kind: 'record_migration';
    ledgerTable: 'schema_migration';
    userVersion: number;
  }>;

export interface MigrationDescriptor {
  version: number;
  name: string;
  expectedPostSchemaIdentity: 'current-schema-v1' | 'current-schema-v2' | 'current-schema-v3' | 'current-schema-v4' | 'current-schema-v5' | 'current-schema-v6' | 'current-schema-v7' | 'current-schema-v8';
  orderedOperations: readonly MigrationOperation[];
}

function canonicalizeMigrationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeMigrationValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalizeMigrationValue(child)]));
  }
  return typeof value === 'string' ? value.replaceAll('\r\n', '\n') : value;
}

export function migrationDescriptorChecksum(descriptor: MigrationDescriptor) {
  const canonicalPayload = JSON.stringify(canonicalizeMigrationValue(descriptor));
  return createHash('sha256').update(canonicalPayload).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const BASELINE_MIGRATION_PAYLOAD = deepFreeze(Object.freeze({
  version: 1,
  name: 'baseline-current-sqlite-schema',
  schemaSql: schema,
  legacyColumns: Object.freeze([
    ['correction_event', 'idempotency_key', "TEXT NOT NULL DEFAULT ''"],
    ['correction_event', 'source_event_id', 'TEXT REFERENCES source_event(id) ON DELETE SET NULL'],
    ['correction_event', 'ai_decision_id', 'TEXT REFERENCES ai_decision_log(id) ON DELETE SET NULL'],
    ['correction_event', 'note', "TEXT NOT NULL DEFAULT ''"],
    ['correction_event', 'visibility', "TEXT NOT NULL DEFAULT 'private'"],
    ['correction_event', 'operation', "TEXT NOT NULL DEFAULT 'apply'"],
    ['task', 'record_state', "TEXT NOT NULL DEFAULT 'active'"],
    ['task', 'merged_into_task_id', 'TEXT REFERENCES task(id) ON DELETE SET NULL'],
    ['task', 'planned_start_at', 'TEXT'],
    ['task', 'planned_due_at', 'TEXT'],
    ['task', 'deleted_at', 'TEXT'],
    ['task', 'thread_id', 'TEXT'],
    ['task', 'auto_update_paused', 'INTEGER NOT NULL DEFAULT 0'],
    ['source_event', 'owner_mentioned', 'INTEGER NOT NULL DEFAULT 0'],
    ['source_event', 'source_url', 'TEXT'],
    ['source_event', 'completeness', "TEXT NOT NULL DEFAULT 'partial'"],
    ['source_event', 'discovery_reason', "TEXT NOT NULL DEFAULT ''"],
    ['feishu_monitor_target', 'manual_excluded', 'INTEGER NOT NULL DEFAULT 0'],
    ['feishu_monitor_target', 'discovery_rank', 'INTEGER'],
    ['feishu_monitor_target', 'selection_version', 'INTEGER NOT NULL DEFAULT 0'],
    ['source_event', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['candidate_request', 'analysis_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['candidate_request', 'deleted_at', 'TEXT'],
    ['candidate_request', 'merged_into_candidate_id', 'TEXT REFERENCES candidate_request(id) ON DELETE SET NULL'],
    ['candidate_request', 'merged_at', 'TEXT'],
    ['candidate_request', 'processing_state', "TEXT NOT NULL DEFAULT 'ready'"],
    ['candidate_request', 'processing_job_id', 'TEXT'],
    ['candidate_request', 'processing_error', 'TEXT'],
    ['candidate_request', 'context_state', "TEXT NOT NULL DEFAULT 'complete'"],
    ['candidate_request', 'context_reason', 'TEXT'],
    ['candidate_request', 'recovered_at', 'TEXT'],
    ['candidate_request', 'demand_unit_id', 'TEXT REFERENCES source_demand_unit(id) ON DELETE CASCADE'],
    ['source_context', 'freshness', "TEXT NOT NULL DEFAULT 'fresh'"],
    ['source_context', 'last_success_at', 'TEXT'],
    ['ai_decision_log', 'http_status', 'INTEGER'],
    ['ai_decision_log', 'provider_request_id', 'TEXT'],
    ['ai_decision_log', 'attempts', 'INTEGER'],
    ['ai_decision_log', 'structured_mode', 'TEXT'],
    ['ai_decision_log', 'input_hash', 'TEXT'],
    ['ai_decision_log', 'input_char_count', 'INTEGER'],
    ['ai_decision_log', 'fallback_mode', 'TEXT'],
    ['ai_decision_log', 'demand_unit_id', 'TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL'],
    ['notification', 'candidate_id', 'TEXT REFERENCES candidate_request(id) ON DELETE CASCADE'],
    ['notification', 'notification_type', "TEXT NOT NULL DEFAULT 'immediate'"],
    ['notification', 'dedupe_key', 'TEXT'],
    ['job', 'locked_until', 'TEXT'],
    ['job', 'lease_owner', 'TEXT'],
    ['job', 'max_attempts', 'INTEGER NOT NULL DEFAULT 3'],
    ['job', 'retryable', 'INTEGER NOT NULL DEFAULT 1'],
    ['job', 'backoff_seconds', 'INTEGER NOT NULL DEFAULT 30'],
    ['job', 'cancel_requested_at', 'TEXT'],
    ['job', 'idempotency_key', 'TEXT'],
    ['job', 'source_event_id', 'TEXT REFERENCES source_event(id) ON DELETE SET NULL'],
    ['job', 'thread_id', 'TEXT'],
    ['job', 'task_id', 'TEXT REFERENCES task(id) ON DELETE SET NULL'],
    ['job', 'trace_id', 'TEXT'],
    ['job', 'last_error', 'TEXT'],
    ['job', 'result_json', 'TEXT'],
    ['requirement_thread', 'conversation_id', 'TEXT'],
    ['requirement_thread', 'participant_ids_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['requirement_thread', 'ambiguity_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['requirement_thread', 'primary_source_event_id', 'TEXT REFERENCES source_event(id) ON DELETE SET NULL'],
    ['requirement_thread', 'primary_reason', "TEXT NOT NULL DEFAULT ''"],
    ['requirement_thread', 'primary_confidence', 'REAL'],
    ['requirement_thread_revision', 'demand_unit_id', 'TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL'],
    ['candidate_revision', 'demand_unit_id', 'TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL'],
    ['requirement_thread_source', 'session_id', 'TEXT'],
    ['requirement_thread_source', 'conversation_id', 'TEXT'],
    ['requirement_thread_source', 'participant_ids_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['requirement_thread_source', 'source_revision', 'TEXT'],
    ['requirement_thread_source', 'source_role', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['requirement_thread_source', 'role_reason', "TEXT NOT NULL DEFAULT ''"],
    ['task_update_proposal', 'provider', "TEXT NOT NULL DEFAULT ''"],
    ['task_update_proposal', 'model', "TEXT NOT NULL DEFAULT ''"],
    ['task_update_proposal', 'prompt_version', "TEXT NOT NULL DEFAULT ''"],
    ['task_update_proposal', 'candidate_revision_id', 'TEXT REFERENCES candidate_revision(id) ON DELETE SET NULL'],
    ['task_update_proposal', 'demand_unit_id', 'TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL'],
    ['task_update_proposal', 'thread_revision_id', 'TEXT REFERENCES requirement_thread_revision(id) ON DELETE SET NULL'],
    ['task_update_proposal', 'base_thread_version', 'INTEGER'],
    ['task_update_proposal', 'origin', "TEXT NOT NULL DEFAULT 'follow_up'"],
    ['task_update_proposal', 'association_confidence', 'REAL'],
    ['task_update_proposal', 'update_confidence', 'REAL'],
    ['task_update_proposal', 'used_fallback', 'INTEGER NOT NULL DEFAULT 0'],
    ['task_update_proposal', 'decision_mode', "TEXT NOT NULL DEFAULT 'pending'"],
    ['task_update_proposal', 'policy_version', "TEXT NOT NULL DEFAULT ''"],
    ['task_update_proposal', 'policy_reason', "TEXT NOT NULL DEFAULT ''"],
    ['task_update_proposal', 'applied_task_version', 'INTEGER'],
    ['task_update_proposal', 'applied_thread_version', 'INTEGER'],
    ['task_update_proposal', 'applied_task_event_id', 'TEXT'],
    ['task_update_proposal', 'before_snapshot_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['task_update_proposal', 'after_snapshot_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['task_update_proposal', 'reverted_at', 'TEXT'],
    ['task_update_proposal', 'reverted_task_event_id', 'TEXT'],
    ['memory_projection', 'managed_files_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['owner_decision', 'source_revision', "TEXT NOT NULL DEFAULT ''"],
    ['owner_decision', 'candidate_id', 'TEXT REFERENCES candidate_request(id) ON DELETE SET NULL'],
    ['owner_decision', 'thread_id', 'TEXT REFERENCES requirement_thread(id) ON DELETE SET NULL'],
    ['owner_decision', 'task_id', 'TEXT REFERENCES task(id) ON DELETE SET NULL'],
    ['owner_decision', 'action', "TEXT NOT NULL DEFAULT 'uncertain'"],
    ['owner_decision', 'disposition', "TEXT NOT NULL DEFAULT 'review'"],
    ['owner_decision', 'confidence', 'REAL NOT NULL DEFAULT 0'],
    ['owner_decision', 'summary', "TEXT NOT NULL DEFAULT ''"],
    ['owner_decision', 'delegate_to', 'TEXT'],
    ['owner_decision', 'schedule_text', 'TEXT'],
    ['owner_decision', 'patch_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['owner_decision', 'evidence_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['owner_decision', 'reason', "TEXT NOT NULL DEFAULT ''"],
    ['owner_decision', 'provider', "TEXT NOT NULL DEFAULT ''"],
    ['owner_decision', 'model', "TEXT NOT NULL DEFAULT ''"],
    ['owner_decision', 'prompt_version', "TEXT NOT NULL DEFAULT ''"],
    ['owner_decision', 'runtime_job_id', 'TEXT REFERENCES job(id) ON DELETE SET NULL'],
    ['owner_decision', 'state', "TEXT NOT NULL DEFAULT 'queued'"],
    ['owner_decision', 'target_snapshot_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['owner_decision', 'applied_task_version', 'INTEGER'],
    ['owner_decision', 'applied_thread_version', 'INTEGER'],
    ['owner_decision', 'error', 'TEXT'],
    ['owner_decision', 'created_at', "TEXT NOT NULL DEFAULT ''"],
    ['owner_decision', 'applied_at', 'TEXT'],
  ] as const),
  runtimeToolPolicyMarker: 'controlled_internal_write',
  runtimeToolCreateSql: `CREATE TABLE runtime_tool_call (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES job(id) ON DELETE SET NULL,
      tool_name TEXT NOT NULL,
      policy TEXT NOT NULL CHECK (policy IN ('readonly','controlled_internal_write','approval_required','forbidden')),
      status TEXT NOT NULL CHECK (status IN ('allowed','blocked','completed','failed')),
      input_hash TEXT,
      result_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );`,
  runtimeToolColumns: Object.freeze([
    'id', 'job_id', 'tool_name', 'policy', 'status', 'input_hash', 'result_json', 'error', 'started_at', 'finished_at',
  ]),
  monitorResetSql: `UPDATE feishu_monitor_target
    SET enabled = 0
    WHERE target_kind = 'person' AND enabled = 1
      AND manual_excluded = 0 AND selection_version = 0;`,
  candidateCreateSql: `CREATE TABLE candidate_request (
      id TEXT PRIMARY KEY,
      source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
      demand_unit_id TEXT UNIQUE REFERENCES source_demand_unit(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      proposer_name TEXT NOT NULL,
      background TEXT NOT NULL,
      validation_question TEXT NOT NULL,
      describe TEXT NOT NULL,
      analysis_json TEXT NOT NULL DEFAULT '{}',
      confidence REAL NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','snoozed','ignored','accepted')),
      snoozed_until TEXT,
      accepted_task_id TEXT,
      merged_into_candidate_id TEXT REFERENCES candidate_request(id) ON DELETE SET NULL,
      merged_at TEXT,
      deleted_at TEXT,
      processing_state TEXT NOT NULL DEFAULT 'ready' CHECK (processing_state IN ('organizing','retry_waiting','ready','incomplete_context','recovered','failed_visible')),
      processing_job_id TEXT,
      processing_error TEXT,
      context_state TEXT NOT NULL DEFAULT 'complete' CHECK (context_state IN ('complete','possibly_incomplete')),
      context_reason TEXT,
      recovered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  candidateColumns: Object.freeze([
    'id', 'source_event_id', 'demand_unit_id', 'title', 'proposer_name', 'background', 'validation_question',
    'describe', 'analysis_json', 'confidence', 'state', 'snoozed_until', 'accepted_task_id',
    'merged_into_candidate_id', 'merged_at', 'deleted_at', 'processing_state', 'processing_job_id',
    'processing_error', 'context_state', 'context_reason', 'recovered_at', 'created_at', 'updated_at',
  ]),
  candidateConflictQueries: Object.freeze([
    `SELECT 1
       FROM candidate_revision
       JOIN candidate_request ON candidate_request.id = candidate_revision.candidate_id
      WHERE candidate_revision.demand_unit_id IS NOT NULL
        AND candidate_request.demand_unit_id IS NOT NULL
        AND candidate_revision.demand_unit_id <> candidate_request.demand_unit_id
      LIMIT 1`,
    `SELECT 1
       FROM ai_decision_log
       JOIN candidate_request ON candidate_request.id = ai_decision_log.candidate_id
      WHERE ai_decision_log.demand_unit_id IS NOT NULL
        AND candidate_request.demand_unit_id IS NOT NULL
        AND ai_decision_log.demand_unit_id <> candidate_request.demand_unit_id
      LIMIT 1`,
  ]),
  candidateBackfillSql: `CREATE TEMP TABLE __migration_v1_candidate_unit_map (
      candidate_id TEXT PRIMARY KEY,
      demand_unit_id TEXT NOT NULL UNIQUE,
      anchor_source_event_id TEXT NOT NULL,
      unit_key TEXT NOT NULL,
      state TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

      INSERT INTO __migration_v1_candidate_unit_map
        (candidate_id, demand_unit_id, anchor_source_event_id, unit_key, state, analysis_json, created_at, updated_at)
      SELECT candidate_request.id,
             'unit_legacy_' || candidate_request.id,
             candidate_request.source_event_id,
             'legacy:' || candidate_request.id,
             CASE candidate_request.processing_state
               WHEN 'organizing' THEN 'provisional'
               WHEN 'retry_waiting' THEN 'provisional'
               WHEN 'failed_visible' THEN 'failed_visible'
               WHEN 'incomplete_context' THEN 'incomplete_context'
               ELSE 'ready'
             END,
             candidate_request.analysis_json,
             candidate_request.created_at,
             candidate_request.updated_at
      FROM candidate_request
      JOIN source_event ON source_event.id = candidate_request.source_event_id
      WHERE candidate_request.demand_unit_id IS NULL;

      INSERT INTO source_demand_unit
      (id, anchor_source_event_id, unit_key, unit_kind, state, classification_revision,
       ai_decision_id, analysis_json, reason, created_at, updated_at)
      SELECT demand_unit_id,
             anchor_source_event_id,
             unit_key,
             'demand',
             state,
             NULL,
             NULL,
             analysis_json,
             '由旧候选安全迁移为独立需求单元。',
             created_at,
             updated_at
      FROM __migration_v1_candidate_unit_map;

      INSERT INTO source_demand_unit_source
        (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
      SELECT demand_unit_id, anchor_source_event_id, 's1', 'anchor', 0, created_at
      FROM __migration_v1_candidate_unit_map;

      UPDATE candidate_request
      SET demand_unit_id = (
        SELECT demand_unit_id FROM __migration_v1_candidate_unit_map
        WHERE candidate_id = candidate_request.id
      )
      WHERE demand_unit_id IS NULL
        AND EXISTS (
          SELECT 1 FROM __migration_v1_candidate_unit_map
          WHERE candidate_id = candidate_request.id
        );

      INSERT INTO requirement_thread_unit
        (thread_id, demand_unit_id, relation_type, confidence, evidence_json, created_at)
      SELECT requirement_thread_source.thread_id,
             unique_source_candidate_unit.demand_unit_id,
             requirement_thread_source.relation_type,
             requirement_thread_source.confidence,
             requirement_thread_source.evidence_json,
             requirement_thread_source.created_at
      FROM (
        SELECT candidate_request.source_event_id, candidate_request.demand_unit_id
        FROM candidate_request
        WHERE candidate_request.demand_unit_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM candidate_request AS other_candidate
            WHERE other_candidate.source_event_id = candidate_request.source_event_id
              AND other_candidate.id <> candidate_request.id
          )
      ) AS unique_source_candidate_unit
      JOIN requirement_thread_source
        ON requirement_thread_source.source_event_id = unique_source_candidate_unit.source_event_id;

      UPDATE candidate_revision
      SET demand_unit_id = (
        SELECT candidate_request.demand_unit_id FROM candidate_request
        WHERE candidate_request.id = candidate_revision.candidate_id
      )
      WHERE demand_unit_id IS NULL;

      UPDATE ai_decision_log
      SET demand_unit_id = (
        SELECT candidate_request.demand_unit_id FROM candidate_request
        WHERE candidate_request.id = ai_decision_log.candidate_id
      )
      WHERE demand_unit_id IS NULL AND candidate_id IS NOT NULL;

      UPDATE requirement_thread_revision
      SET demand_unit_id = (
        WITH unique_source_candidate_unit AS (
          SELECT candidate_request.source_event_id, candidate_request.demand_unit_id
          FROM candidate_request
          WHERE candidate_request.demand_unit_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM candidate_request AS other_candidate
              WHERE other_candidate.source_event_id = candidate_request.source_event_id
                AND other_candidate.id <> candidate_request.id
            )
        )
        SELECT unique_source_candidate_unit.demand_unit_id
        FROM unique_source_candidate_unit
        WHERE unique_source_candidate_unit.source_event_id = requirement_thread_revision.source_event_id
      )
      WHERE demand_unit_id IS NULL AND source_event_id IS NOT NULL;

      UPDATE task_update_proposal
      SET demand_unit_id = (
        WITH unique_source_candidate_unit AS (
          SELECT candidate_request.source_event_id, candidate_request.demand_unit_id
          FROM candidate_request
          WHERE candidate_request.demand_unit_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM candidate_request AS other_candidate
              WHERE other_candidate.source_event_id = candidate_request.source_event_id
                AND other_candidate.id <> candidate_request.id
            )
        ),
        candidate_revision_unit AS (
          SELECT candidate_revision.id AS revision_id,
                 CASE
                   WHEN candidate_revision.demand_unit_id IS NOT NULL
                     AND (candidate_request.demand_unit_id IS NULL
                       OR candidate_request.demand_unit_id = candidate_revision.demand_unit_id)
                   THEN candidate_revision.demand_unit_id
                   ELSE NULL
                 END AS demand_unit_id,
                 CASE
                   WHEN candidate_revision.demand_unit_id IS NOT NULL
                     AND candidate_request.demand_unit_id IS NOT NULL
                     AND candidate_request.demand_unit_id <> candidate_revision.demand_unit_id
                   THEN 1
                   ELSE 0
                 END AS has_conflict
          FROM candidate_revision
          LEFT JOIN candidate_request
            ON candidate_request.id = candidate_revision.candidate_id
        )
        SELECT CASE
                 WHEN proposal.candidate_revision_id IS NOT NULL
                   THEN CASE
                     WHEN candidate_revision_unit.has_conflict = 1 THEN NULL
                     ELSE candidate_revision_unit.demand_unit_id
                   END
                 ELSE unique_source_candidate_unit.demand_unit_id
               END
        FROM task_update_proposal AS proposal
        LEFT JOIN candidate_revision_unit
          ON candidate_revision_unit.revision_id = proposal.candidate_revision_id
        LEFT JOIN unique_source_candidate_unit
          ON unique_source_candidate_unit.source_event_id = proposal.source_event_id
        WHERE proposal.id = task_update_proposal.id
      )
      WHERE demand_unit_id IS NULL;

      DROP TABLE __migration_v1_candidate_unit_map;`,
  candidateIndexSql: Object.freeze([
    'CREATE INDEX IF NOT EXISTS idx_candidate_state ON candidate_request(state, created_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_candidate_deleted ON candidate_request(deleted_at, state, created_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_candidate_merge ON candidate_request(merged_into_candidate_id, state, deleted_at);',
    'CREATE INDEX IF NOT EXISTS idx_candidate_source ON candidate_request(source_event_id, created_at ASC);',
  ]),
  indexAndConstraintSql: Object.freeze([
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_correction_idempotency ON correction_event(idempotency_key) WHERE idempotency_key <> '';",
    'CREATE INDEX IF NOT EXISTS idx_correction_created ON correction_event(created_at DESC);',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_dedupe ON notification(dedupe_key) WHERE dedupe_key IS NOT NULL;',
    'CREATE INDEX IF NOT EXISTS idx_feishu_monitor_target_scan ON feishu_monitor_target(owner_open_id, target_kind, enabled, discovery_rank);',
    'CREATE INDEX IF NOT EXISTS idx_candidate_deleted ON candidate_request(deleted_at, state, created_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_candidate_merge ON candidate_request(merged_into_candidate_id, state, deleted_at);',
    'CREATE INDEX IF NOT EXISTS idx_task_plan ON task(deleted_at, status, planned_start_at, planned_due_at, schedule_at);',
    'CREATE INDEX IF NOT EXISTS idx_source_context_event ON source_context(source_event_id, updated_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_runtime_job_status ON job(status, available_at, updated_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_job_source_source ON job_source_link(source_event_id, job_id);',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_job_idempotency ON job(idempotency_key) WHERE idempotency_key IS NOT NULL;',
    'CREATE INDEX IF NOT EXISTS idx_runtime_checkpoint_job ON runtime_checkpoint(job_id, created_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_runtime_tool_job ON runtime_tool_call(job_id, started_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_requirement_thread_activity ON requirement_thread(status, last_activity_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_requirement_thread_source_event ON requirement_thread_source(source_event_id);',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_requirement_thread_unit_unique ON requirement_thread_unit(demand_unit_id);',
    'CREATE INDEX IF NOT EXISTS idx_thread_revision_state ON requirement_thread_revision(thread_id, state, created_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_candidate_revision_candidate ON candidate_revision(candidate_id, created_at DESC);',
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_revision_current ON candidate_revision(candidate_id) WHERE state = 'current';",
    'CREATE INDEX IF NOT EXISTS idx_task_update_state ON task_update_proposal(state, created_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_task_update_auto ON task_update_proposal(task_id, decision_mode, decided_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_memory_projection_state ON memory_projection(state, updated_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_owner_decision_source ON owner_decision(source_event_id, created_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_owner_decision_state ON owner_decision(state, created_at DESC);',
  ]),
  ledgerSql: `CREATE TABLE IF NOT EXISTS schema_migration (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`,
}));

function canonicalRebuildPayload() {
  const canonical = new DatabaseSync(':memory:');
  try {
    canonical.exec(BASELINE_MIGRATION_PAYLOAD.schemaSql);
    for (const [table, column, definition] of BASELINE_MIGRATION_PAYLOAD.legacyColumns) {
      const columns = canonical.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>;
      if (!columns.some((item) => item.name === column)) {
        canonical.exec(`ALTER TABLE ${controlledSchemaIdentifier(table)} ADD COLUMN ${controlledSchemaIdentifier(column)} ${definition}`);
      }
    }
    for (const statement of BASELINE_MIGRATION_PAYLOAD.candidateIndexSql) canonical.exec(statement);
    for (const statement of BASELINE_MIGRATION_PAYLOAD.indexAndConstraintSql) canonical.exec(statement);
    const identity = captureSchemaIdentity(canonical);
    return currentSchemaTableNames().map((table) => {
      const columns = identity.columns.get(table);
      const createSql = identity.createSql.get(table);
      if (!columns || !createSql) throw new Error('canonical rebuild payload is incomplete');
      return deepFreeze({
        table,
        temporaryTable: `__migration_v1_${table}`,
        createSql,
        targetColumns: columns.map((column) => column.name),
        sourceColumns: columns.map((column) => column.name),
        copyMode: 'insert_select' as const,
        conflictMode: 'abort' as const,
        indexSql: identity.indexes
          .filter((index) => index.table === table && index.origin === 'c' && index.sql)
          .map((index) => index.sql!),
      });
    });
  } finally {
    canonical.close();
  }
}

const CANONICAL_REBUILD_PAYLOAD = deepFreeze(canonicalRebuildPayload());

export const BASELINE_MIGRATION_DESCRIPTOR = deepFreeze(Object.freeze({
  version: 1,
  name: 'baseline-current-sqlite-schema',
  expectedPostSchemaIdentity: 'current-schema-v1' as const,
  orderedOperations: Object.freeze([
    Object.freeze({ id: 'create-ledger' as const, kind: 'sql_batch' as const, statements: Object.freeze([BASELINE_MIGRATION_PAYLOAD.ledgerSql]) }),
    Object.freeze({ id: 'apply-schema' as const, kind: 'sql_batch' as const, statements: Object.freeze([BASELINE_MIGRATION_PAYLOAD.schemaSql]), legacyIdentity: true as const }),
    Object.freeze({
      id: 'runtime-tool-policy' as const,
      kind: 'conditional_rebuild' as const,
      condition: Object.freeze({
        kind: 'table_sql_missing' as const,
        table: 'runtime_tool_call',
        marker: BASELINE_MIGRATION_PAYLOAD.runtimeToolPolicyMarker,
      }),
      rebuild: Object.freeze({
        table: 'runtime_tool_call',
        temporaryTable: '__migration_v1_runtime_tool_call_policy',
        createSql: BASELINE_MIGRATION_PAYLOAD.runtimeToolCreateSql,
        targetColumns: BASELINE_MIGRATION_PAYLOAD.runtimeToolColumns,
        sourceColumns: BASELINE_MIGRATION_PAYLOAD.runtimeToolColumns,
        copyMode: 'insert_select' as const,
        conflictMode: 'abort' as const,
        indexSql: Object.freeze([]),
      }),
    }),
    Object.freeze({
      id: 'add-legacy-columns' as const,
      kind: 'add_columns' as const,
      columns: BASELINE_MIGRATION_PAYLOAD.legacyColumns,
      legacyIdentity: true as const,
    }),
    Object.freeze({ id: 'monitor-reset' as const, kind: 'sql_batch' as const, statements: Object.freeze([BASELINE_MIGRATION_PAYLOAD.monitorResetSql]) }),
    Object.freeze({
      id: 'reject-ambiguous-legacy-associations' as const,
      kind: 'assert_no_rows' as const,
      queries: BASELINE_MIGRATION_PAYLOAD.candidateConflictQueries,
    }),
    Object.freeze({
      id: 'candidate-demand-units' as const,
      kind: 'conditional_rebuild' as const,
      condition: Object.freeze({
        kind: 'unique_index_columns' as const,
        table: 'candidate_request',
        columns: Object.freeze(['source_event_id']),
      }),
      rebuild: Object.freeze({
        table: 'candidate_request',
        temporaryTable: '__migration_v1_candidate_request',
        createSql: BASELINE_MIGRATION_PAYLOAD.candidateCreateSql,
        targetColumns: BASELINE_MIGRATION_PAYLOAD.candidateColumns,
        sourceColumns: BASELINE_MIGRATION_PAYLOAD.candidateColumns,
        copyMode: 'insert_select' as const,
        conflictMode: 'abort' as const,
        indexSql: BASELINE_MIGRATION_PAYLOAD.candidateIndexSql,
      }),
    }),
    Object.freeze({ id: 'candidate-demand-unit-data' as const, kind: 'sql_batch' as const, statements: Object.freeze([BASELINE_MIGRATION_PAYLOAD.candidateBackfillSql]) }),
    Object.freeze({ id: 'candidate-indexes' as const, kind: 'sql_batch' as const, statements: BASELINE_MIGRATION_PAYLOAD.candidateIndexSql, legacyIdentity: true as const }),
    Object.freeze({ id: 'create-indexes-and-constraints' as const, kind: 'sql_batch' as const, statements: BASELINE_MIGRATION_PAYLOAD.indexAndConstraintSql, legacyIdentity: true as const }),
    Object.freeze({
      id: 'rebuild-canonical-schema' as const,
      kind: 'rebuild_tables' as const,
      tables: CANONICAL_REBUILD_PAYLOAD,
    }),
    Object.freeze({
      id: 'bind-database-instance' as const,
      kind: 'bind_database_instance' as const,
      createTableSql: DATABASE_METADATA_SQL,
    }),
    Object.freeze({
      id: 'verify-post-schema' as const,
      kind: 'assert_database' as const,
      expectedSchemaIdentityChecksum: VERSIONED_SCHEMA_IDENTITIES.currentV1.checksum,
      checks: Object.freeze(['schema', 'foreign_keys', 'integrity'] as const),
    }),
    Object.freeze({
      id: 'record-migration' as const,
      kind: 'record_migration' as const,
      ledgerTable: 'schema_migration' as const,
      userVersion: 1,
    }),
  ]),
}) satisfies MigrationDescriptor);

export const BASELINE_MIGRATION_CHECKSUM = migrationDescriptorChecksum(BASELINE_MIGRATION_DESCRIPTOR);

/**
 * DATA-02 adds the missing demand-unit edge to audit records. The upgrade is
 * fail-closed: exact relationships are backfilled, ambiguous legacy rows are
 * preserved as nullable edges, and every gap is durable in its own table.
 */
const RELATION_CONSTRAINT_MIGRATION_SQL = Object.freeze([
  // A task/source edge may remain a nullable legacy edge while its demand
  // unit is ambiguous. Once explicit, however, the unit and source must be
  // an existing pair in source_demand_unit_source; NO ACTION keeps deletes
  // fail-closed instead of silently downgrading an explicit edge to NULL.
  'ALTER TABLE task_source_link ADD COLUMN demand_unit_id TEXT REFERENCES source_demand_unit(id) ON DELETE NO ACTION;',
  'ALTER TABLE task_event ADD COLUMN demand_unit_id TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL;',
  'ALTER TABLE correction_event ADD COLUMN demand_unit_id TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL;',
  'ALTER TABLE requirement_thread_source ADD COLUMN demand_unit_id TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL;',
  'ALTER TABLE owner_decision ADD COLUMN demand_unit_id TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL;',
  'ALTER TABLE ai_decision_log ADD COLUMN source_revision TEXT;',
  `UPDATE candidate_revision
   SET demand_unit_id = (
     SELECT candidate_request.demand_unit_id
     FROM candidate_request
     WHERE candidate_request.id = candidate_revision.candidate_id
   )
   WHERE demand_unit_id IS NULL
     AND EXISTS (
       SELECT 1 FROM candidate_request
       WHERE candidate_request.id = candidate_revision.candidate_id
         AND candidate_request.demand_unit_id IS NOT NULL
     );`,
  `UPDATE ai_decision_log
   SET demand_unit_id = (
     SELECT candidate_request.demand_unit_id
     FROM candidate_request
     WHERE candidate_request.id = ai_decision_log.candidate_id
   )
   WHERE demand_unit_id IS NULL
     AND candidate_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM candidate_request
       WHERE candidate_request.id = ai_decision_log.candidate_id
         AND candidate_request.demand_unit_id IS NOT NULL
     );`,
  `UPDATE requirement_thread_revision
   SET demand_unit_id = (
     SELECT requirement_thread_unit.demand_unit_id
     FROM requirement_thread_unit
     JOIN requirement_thread_source
       ON requirement_thread_source.thread_id = requirement_thread_unit.thread_id
      AND requirement_thread_source.source_event_id = requirement_thread_revision.source_event_id
     WHERE requirement_thread_unit.thread_id = requirement_thread_revision.thread_id
       AND requirement_thread_revision.source_event_id IS NOT NULL
     GROUP BY requirement_thread_unit.demand_unit_id
     HAVING COUNT(DISTINCT requirement_thread_unit.demand_unit_id) = 1
   )
   WHERE demand_unit_id IS NULL
     AND source_event_id IS NOT NULL
     AND (
       SELECT COUNT(DISTINCT requirement_thread_unit.demand_unit_id)
       FROM requirement_thread_unit
       JOIN requirement_thread_source
         ON requirement_thread_source.thread_id = requirement_thread_unit.thread_id
        AND requirement_thread_source.source_event_id = requirement_thread_revision.source_event_id
       WHERE requirement_thread_unit.thread_id = requirement_thread_revision.thread_id
     ) = 1;`,
  `UPDATE task_update_proposal
   SET demand_unit_id = (
     SELECT candidate_revision.demand_unit_id
     FROM candidate_revision
     WHERE candidate_revision.id = task_update_proposal.candidate_revision_id
       AND candidate_revision.demand_unit_id IS NOT NULL
   )
   WHERE demand_unit_id IS NULL
     AND candidate_revision_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM candidate_revision
       WHERE candidate_revision.id = task_update_proposal.candidate_revision_id
         AND candidate_revision.demand_unit_id IS NOT NULL
     );`,
  `WITH unique_task_source_unit AS (
     SELECT task_source_link.task_id,
            task_source_link.source_event_id,
            MIN(candidate_request.demand_unit_id) AS demand_unit_id
     FROM task_source_link
     JOIN candidate_request
       ON candidate_request.accepted_task_id = task_source_link.task_id
     JOIN source_demand_unit_source
       ON source_demand_unit_source.demand_unit_id = candidate_request.demand_unit_id
      AND source_demand_unit_source.source_event_id = task_source_link.source_event_id
     WHERE task_source_link.demand_unit_id IS NULL
       AND candidate_request.demand_unit_id IS NOT NULL
     GROUP BY task_source_link.task_id, task_source_link.source_event_id
     HAVING COUNT(DISTINCT candidate_request.demand_unit_id) = 1
   )
   UPDATE task_source_link
      SET demand_unit_id = (
        SELECT unique_task_source_unit.demand_unit_id
        FROM unique_task_source_unit
        WHERE unique_task_source_unit.task_id = task_source_link.task_id
          AND unique_task_source_unit.source_event_id = task_source_link.source_event_id
      )
    WHERE EXISTS (
      SELECT 1
      FROM unique_task_source_unit
      WHERE unique_task_source_unit.task_id = task_source_link.task_id
        AND unique_task_source_unit.source_event_id = task_source_link.source_event_id
    );`,
  `UPDATE task_event
   SET demand_unit_id = (
     SELECT task_source_link.demand_unit_id
     FROM task_source_link
     WHERE task_source_link.task_id = task_event.task_id
       AND task_source_link.source_event_id = task_event.source_event_id
       AND task_source_link.demand_unit_id IS NOT NULL
   )
   WHERE demand_unit_id IS NULL
     AND source_event_id IS NOT NULL
     AND (
       SELECT COUNT(DISTINCT task_source_link.demand_unit_id)
       FROM task_source_link
       WHERE task_source_link.task_id = task_event.task_id
         AND task_source_link.source_event_id = task_event.source_event_id
         AND task_source_link.demand_unit_id IS NOT NULL
     ) = 1;`,
  `UPDATE task_event
   SET demand_unit_id = (
     SELECT source_demand_unit_source.demand_unit_id
     FROM source_demand_unit_source
     WHERE source_demand_unit_source.source_event_id = task_event.source_event_id
     GROUP BY source_demand_unit_source.demand_unit_id
     HAVING COUNT(DISTINCT source_demand_unit_source.demand_unit_id) = 1
   )
   WHERE demand_unit_id IS NULL
     AND source_event_id IS NOT NULL
     AND (
       SELECT COUNT(DISTINCT source_demand_unit_source.demand_unit_id)
       FROM source_demand_unit_source
       WHERE source_demand_unit_source.source_event_id = task_event.source_event_id
     ) = 1;`,
  `UPDATE correction_event
   SET demand_unit_id = (
     SELECT candidate_request.demand_unit_id
     FROM candidate_request
     WHERE candidate_request.id = correction_event.candidate_id
       AND candidate_request.demand_unit_id IS NOT NULL
   )
   WHERE demand_unit_id IS NULL
     AND candidate_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM candidate_request
       WHERE candidate_request.id = correction_event.candidate_id
         AND candidate_request.demand_unit_id IS NOT NULL
     );`,
  `UPDATE requirement_thread_source
   SET demand_unit_id = (
     SELECT requirement_thread_unit.demand_unit_id
     FROM requirement_thread_unit
     WHERE requirement_thread_unit.thread_id = requirement_thread_source.thread_id
     GROUP BY requirement_thread_unit.demand_unit_id
     HAVING COUNT(DISTINCT requirement_thread_unit.demand_unit_id) = 1
   )
   WHERE demand_unit_id IS NULL
     AND (
       SELECT COUNT(DISTINCT requirement_thread_unit.demand_unit_id)
       FROM requirement_thread_unit
       WHERE requirement_thread_unit.thread_id = requirement_thread_source.thread_id
     ) = 1;`,
  `UPDATE owner_decision
   SET demand_unit_id = (
     SELECT candidate_request.demand_unit_id
     FROM candidate_request
     WHERE candidate_request.id = owner_decision.candidate_id
       AND candidate_request.demand_unit_id IS NOT NULL
   )
   WHERE demand_unit_id IS NULL
     AND candidate_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM candidate_request
       WHERE candidate_request.id = owner_decision.candidate_id
         AND candidate_request.demand_unit_id IS NOT NULL
      );`,
  `CREATE TABLE IF NOT EXISTS data_integrity_gap (
     id TEXT PRIMARY KEY,
     source_event_id TEXT REFERENCES source_event(id) ON DELETE SET NULL,
     demand_unit_id TEXT REFERENCES source_demand_unit(id) ON DELETE SET NULL,
     candidate_id TEXT REFERENCES candidate_request(id) ON DELETE SET NULL,
     thread_id TEXT REFERENCES requirement_thread(id) ON DELETE SET NULL,
     task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
     record_table TEXT NOT NULL,
     record_id TEXT NOT NULL,
     reason TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','corrected','dismissed')),
     correction_event_id TEXT REFERENCES correction_event(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE(record_table, record_id, reason)
   );`,
  `CREATE TABLE __migration_v2_task_source_link (
     task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
     source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
     demand_unit_id TEXT REFERENCES source_demand_unit(id) ON DELETE NO ACTION,
     relation_type TEXT NOT NULL DEFAULT 'origin',
     created_at TEXT NOT NULL,
     UNIQUE(task_id, source_event_id, demand_unit_id),
     FOREIGN KEY (demand_unit_id, source_event_id)
       REFERENCES source_demand_unit_source(demand_unit_id, source_event_id)
       ON DELETE NO ACTION
       ON UPDATE NO ACTION
   );`,
  `INSERT INTO __migration_v2_task_source_link
     (task_id, source_event_id, demand_unit_id, relation_type, created_at)
   SELECT task_id, source_event_id, demand_unit_id, relation_type, created_at
   FROM task_source_link;`,
  'DROP TABLE task_source_link;',
  'ALTER TABLE __migration_v2_task_source_link RENAME TO task_source_link;',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_task_source_link_explicit ON task_source_link(task_id, source_event_id, demand_unit_id) WHERE demand_unit_id IS NOT NULL;',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_task_source_link_ambiguous ON task_source_link(task_id, source_event_id) WHERE demand_unit_id IS NULL;',
  'CREATE INDEX IF NOT EXISTS idx_task_source_link_unit ON task_source_link(task_id, demand_unit_id, source_event_id);',
  'CREATE INDEX IF NOT EXISTS idx_task_source_link_source_unit ON task_source_link(source_event_id, demand_unit_id, task_id);',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_decision_source_revision ON ai_decision_log(source_event_id, demand_unit_id, source_revision) WHERE source_event_id IS NOT NULL AND demand_unit_id IS NOT NULL AND source_revision IS NOT NULL;',
  'CREATE INDEX IF NOT EXISTS idx_audit_demand_unit ON task_event(demand_unit_id, recorded_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_correction_demand_unit ON correction_event(demand_unit_id, created_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_thread_source_unit ON requirement_thread_source(demand_unit_id, thread_id, source_event_id);',
  'CREATE INDEX IF NOT EXISTS idx_owner_decision_unit ON owner_decision(demand_unit_id, created_at DESC);',
  `INSERT INTO data_integrity_gap
    (id, source_event_id, demand_unit_id, candidate_id, record_table, record_id, reason, status, created_at, updated_at)
    SELECT 'data-integrity-gap:candidate-revision:' || candidate_revision.id,
           candidate_revision.source_event_id,
           candidate_revision.demand_unit_id,
           candidate_revision.candidate_id,
           'candidate_revision', candidate_revision.id,
           'missing_or_conflicting_demand_unit', 'open',
           candidate_revision.created_at, candidate_revision.created_at
    FROM candidate_revision
   WHERE candidate_revision.demand_unit_id IS NULL
      OR EXISTS (
        SELECT 1 FROM candidate_request
        WHERE candidate_request.id = candidate_revision.candidate_id
          AND candidate_request.demand_unit_id IS NOT NULL
          AND candidate_request.demand_unit_id <> candidate_revision.demand_unit_id
        )
        ON CONFLICT(record_table, record_id, reason) DO NOTHING;`,
  `INSERT INTO data_integrity_gap
    (id, source_event_id, demand_unit_id, candidate_id, record_table, record_id, reason, status, created_at, updated_at)
    SELECT 'data-integrity-gap:ai-decision:' || ai_decision_log.id,
           ai_decision_log.source_event_id,
           ai_decision_log.demand_unit_id,
           ai_decision_log.candidate_id,
           'ai_decision_log', ai_decision_log.id,
           'missing_or_conflicting_demand_unit', 'open',
           ai_decision_log.created_at, ai_decision_log.created_at
    FROM ai_decision_log
   WHERE ai_decision_log.candidate_id IS NOT NULL
     AND (ai_decision_log.demand_unit_id IS NULL OR EXISTS (
       SELECT 1 FROM candidate_request
       WHERE candidate_request.id = ai_decision_log.candidate_id
         AND candidate_request.demand_unit_id IS NOT NULL
         AND candidate_request.demand_unit_id <> ai_decision_log.demand_unit_id
       ))
        ON CONFLICT(record_table, record_id, reason) DO NOTHING;`,
  `INSERT INTO data_integrity_gap
    (id, source_event_id, task_id, record_table, record_id, reason, status, created_at, updated_at)
    SELECT 'data-integrity-gap:task-source-link:' || task_source_link.task_id || ':' || task_source_link.source_event_id,
           task_source_link.source_event_id,
           task_source_link.task_id,
           'task_source_link', task_source_link.task_id || ':' || task_source_link.source_event_id,
           'missing_or_ambiguous_demand_unit', 'open',
           task_source_link.created_at, task_source_link.created_at
    FROM task_source_link
     WHERE task_source_link.demand_unit_id IS NULL
     ON CONFLICT(record_table, record_id, reason) DO NOTHING;`,
  `INSERT INTO data_integrity_gap
    (id, source_event_id, demand_unit_id, thread_id, record_table, record_id, reason, status, created_at, updated_at)
    SELECT 'data-integrity-gap:thread-revision:' || requirement_thread_revision.id,
           requirement_thread_revision.source_event_id,
           requirement_thread_revision.demand_unit_id,
           requirement_thread_revision.thread_id,
           'requirement_thread_revision', requirement_thread_revision.id,
           'missing_or_ambiguous_demand_unit', 'open',
           requirement_thread_revision.created_at, requirement_thread_revision.created_at
      FROM requirement_thread_revision
     WHERE requirement_thread_revision.source_event_id IS NOT NULL
       AND requirement_thread_revision.demand_unit_id IS NULL
     ON CONFLICT(record_table, record_id, reason) DO NOTHING;`,
  `INSERT INTO data_integrity_gap
    (id, source_event_id, demand_unit_id, task_id, record_table, record_id, reason, status, created_at, updated_at)
    SELECT 'data-integrity-gap:task-update:' || task_update_proposal.id,
           task_update_proposal.source_event_id,
           task_update_proposal.demand_unit_id,
           task_update_proposal.task_id,
           'task_update_proposal', task_update_proposal.id,
           'missing_or_ambiguous_demand_unit', 'open',
           task_update_proposal.created_at, task_update_proposal.created_at
      FROM task_update_proposal
     WHERE task_update_proposal.source_event_id IS NOT NULL
       AND task_update_proposal.demand_unit_id IS NULL
     ON CONFLICT(record_table, record_id, reason) DO NOTHING;`,
  `INSERT INTO data_integrity_gap
    (id, source_event_id, demand_unit_id, task_id, record_table, record_id, reason, status, created_at, updated_at)
    SELECT 'data-integrity-gap:task-event:' || task_event.id,
           task_event.source_event_id,
           task_event.demand_unit_id,
           task_event.task_id,
           'task_event', task_event.id,
           'missing_or_ambiguous_demand_unit', 'open',
           task_event.recorded_at, task_event.recorded_at
      FROM task_event
     WHERE task_event.source_event_id IS NOT NULL
       AND task_event.demand_unit_id IS NULL
     ON CONFLICT(record_table, record_id, reason) DO NOTHING;`,
  `INSERT INTO data_integrity_gap
    (id, source_event_id, demand_unit_id, task_id, candidate_id, record_table, record_id, reason, status, created_at, updated_at)
    SELECT 'data-integrity-gap:correction:' || correction_event.id,
           correction_event.source_event_id,
           correction_event.demand_unit_id,
           correction_event.task_id,
           correction_event.candidate_id,
           'correction_event', correction_event.id,
           'missing_or_ambiguous_demand_unit', 'open',
           correction_event.created_at, correction_event.created_at
      FROM correction_event
     WHERE correction_event.source_event_id IS NOT NULL
       AND correction_event.demand_unit_id IS NULL
     ON CONFLICT(record_table, record_id, reason) DO NOTHING;`,
  `INSERT INTO data_integrity_gap
    (id, source_event_id, demand_unit_id, thread_id, record_table, record_id, reason, status, created_at, updated_at)
    SELECT 'data-integrity-gap:thread-source:' || requirement_thread_source.thread_id || ':' || requirement_thread_source.source_event_id,
           requirement_thread_source.source_event_id,
           requirement_thread_source.demand_unit_id,
           requirement_thread_source.thread_id,
           'requirement_thread_source', requirement_thread_source.thread_id || ':' || requirement_thread_source.source_event_id,
           'missing_or_ambiguous_demand_unit', 'open',
           requirement_thread_source.created_at, requirement_thread_source.created_at
      FROM requirement_thread_source
     WHERE requirement_thread_source.demand_unit_id IS NULL
     ON CONFLICT(record_table, record_id, reason) DO NOTHING;`,
  `INSERT INTO data_integrity_gap
    (id, source_event_id, demand_unit_id, task_id, candidate_id, thread_id, record_table, record_id, reason, status, created_at, updated_at)
    SELECT 'data-integrity-gap:owner-decision:' || owner_decision.id,
           owner_decision.source_event_id,
           owner_decision.demand_unit_id,
           owner_decision.task_id,
           owner_decision.candidate_id,
           owner_decision.thread_id,
           'owner_decision', owner_decision.id,
           'missing_or_ambiguous_demand_unit', 'open',
           owner_decision.created_at, owner_decision.created_at
      FROM owner_decision
     WHERE owner_decision.demand_unit_id IS NULL
     ON CONFLICT(record_table, record_id, reason) DO NOTHING;`,
  `CREATE INDEX IF NOT EXISTS idx_data_integrity_gap_source ON data_integrity_gap(source_event_id, status, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_data_integrity_gap_unit ON data_integrity_gap(demand_unit_id, status, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_data_integrity_gap_candidate ON data_integrity_gap(candidate_id, status, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_data_integrity_gap_thread ON data_integrity_gap(thread_id, status, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_data_integrity_gap_task ON data_integrity_gap(task_id, status, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_data_integrity_gap_status ON data_integrity_gap(status, created_at DESC);`,
] as const);

function relationConstraintSchemaChecksum() {
  const canonical = new DatabaseSync(':memory:');
  try {
    executeMigrationOperations(canonical, { ...BASELINE_MIGRATION_DESCRIPTOR, checksum: BASELINE_MIGRATION_CHECKSUM }, {
      databaseInstanceId: '00000000000000000000000000000000',
      instanceCreatedAt: '2026-08-15T00:00:00.000Z',
      appliedAt: '2026-08-15T00:00:00.000Z',
      preexistingTables: [],
    });
    for (const statement of RELATION_CONSTRAINT_MIGRATION_SQL) {
      if (!statement.startsWith('UPDATE ') && !statement.startsWith('INSERT ')) canonical.exec(statement);
    }
    return schemaIdentityChecksum(captureSchemaIdentity(canonical));
  } finally {
    canonical.close();
  }
}

const RELATION_CONSTRAINT_SCHEMA_CHECKSUM = relationConstraintSchemaChecksum();
export const RELATION_CONSTRAINT_MIGRATION_DESCRIPTOR = deepFreeze(Object.freeze({
  version: 2,
  name: 'data-02-four-layer-audit-links',
  expectedPostSchemaIdentity: 'current-schema-v2' as const,
  orderedOperations: Object.freeze([
    Object.freeze({ id: 'relation-constraints' as const, kind: 'sql_batch' as const, statements: RELATION_CONSTRAINT_MIGRATION_SQL }),
    Object.freeze({
      id: 'verify-post-schema' as const,
      kind: 'assert_database' as const,
      expectedSchemaIdentityChecksum: RELATION_CONSTRAINT_SCHEMA_CHECKSUM,
      checks: Object.freeze(['schema', 'foreign_keys', 'integrity'] as const),
    }),
    Object.freeze({
      id: 'record-migration' as const,
      kind: 'record_migration' as const,
      ledgerTable: 'schema_migration' as const,
      userVersion: 2,
    }),
  ]),
}) satisfies MigrationDescriptor);

export const RELATION_CONSTRAINT_MIGRATION_CHECKSUM = migrationDescriptorChecksum(RELATION_CONSTRAINT_MIGRATION_DESCRIPTOR);

/**
 * PRIV-001 keeps lifecycle state, export/deletion requests, backup metadata and
 * deletion proof outside the user-data graph.  These tables intentionally hold
 * only bounded codes, counts, hashes and timestamps; hard deletion can remove
 * every content-bearing table while retaining the minimum non-content proof.
 */
const PRIVACY_MIGRATION_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS privacy_control (
    singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
    collection_status TEXT NOT NULL CHECK (collection_status IN ('running','stopped')),
    oauth_status TEXT NOT NULL CHECK (oauth_status IN ('unknown','authorized','expired','revoked','not_configured')),
    retention_status TEXT NOT NULL CHECK (retention_status IN ('active','paused')),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS privacy_retention_policy (
    singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
    source_days INTEGER NOT NULL CHECK (source_days BETWEEN 1 AND 3650),
    derived_days INTEGER NOT NULL CHECK (derived_days BETWEEN 1 AND 3650),
    diagnostics_days INTEGER NOT NULL CHECK (diagnostics_days BETWEEN 1 AND 365),
    backup_count INTEGER NOT NULL CHECK (backup_count BETWEEN 1 AND 32),
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS privacy_export (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL CHECK (scope IN ('all','sources','tasks','audit')),
    format TEXT NOT NULL CHECK (format IN ('json')),
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
    payload_json TEXT,
    payload_hash TEXT,
    record_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS privacy_deletion (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    confirmation_hash TEXT NOT NULL,
    owner_open_id TEXT NOT NULL,
    capability_token_hash TEXT NOT NULL CHECK (length(capability_token_hash) = 64),
    capability_csrf_hash TEXT NOT NULL CHECK (length(capability_csrf_hash) = 64),
    capability_origin TEXT NOT NULL CHECK (capability_origin = 'app://local'),
    intent TEXT NOT NULL CHECK (intent = 'privacy.deletion.hard-delete.v1'),
    expected_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending_confirmation','running','completed','failed')),
    proof_hash TEXT,
    deleted_record_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    requested_at TEXT NOT NULL,
    confirmed_at TEXT,
    completed_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS privacy_backup (
    id TEXT PRIMARY KEY,
    backup_file TEXT NOT NULL UNIQUE,
    schema_version INTEGER NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    status TEXT NOT NULL CHECK (status IN ('created','restored','rejected')),
    created_at TEXT NOT NULL,
    restored_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS privacy_audit_event (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL CHECK (event_type IN ('collection_stopped','collection_started','authorization_revoked','export_completed','backup_created','backup_restored','deletion_requested','deletion_completed','deletion_failed')),
    operation_id TEXT,
    export_id TEXT REFERENCES privacy_export(id) ON DELETE SET NULL,
    deletion_id TEXT REFERENCES privacy_deletion(id) ON DELETE SET NULL,
    backup_id TEXT REFERENCES privacy_backup(id) ON DELETE SET NULL,
    record_count INTEGER NOT NULL DEFAULT 0,
    proof_hash TEXT,
    created_at TEXT NOT NULL
  );`,
  'CREATE INDEX IF NOT EXISTS idx_privacy_audit_created ON privacy_audit_event(created_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_privacy_deletion_status ON privacy_deletion(status, requested_at DESC);',
  'INSERT INTO privacy_control (singleton_key, collection_status, oauth_status, retention_status, version, updated_at, created_at) VALUES (1, \'running\', \'unknown\', \'active\', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(singleton_key) DO NOTHING;',
  'INSERT INTO privacy_retention_policy (singleton_key, source_days, derived_days, diagnostics_days, backup_count, updated_at) VALUES (1, 3650, 3650, 30, 3, CURRENT_TIMESTAMP) ON CONFLICT(singleton_key) DO NOTHING;',
]);

/**
 * RUN-01 is deliberately a new continuous schema version. DATA-02 owns v2;
 * this migration adds only the durable Runtime external-action claim field
 * and its database-level active/success uniqueness fence.
 */
const RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_SQL = Object.freeze([
  'ALTER TABLE runtime_tool_call ADD COLUMN idempotency_key TEXT;',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_tool_idempotency_active ON runtime_tool_call(idempotency_key) WHERE idempotency_key IS NOT NULL AND status IN ('allowed','completed');",
] as const);

function privacySchemaChecksum() {
  const canonical = new DatabaseSync(':memory:');
  try {
    executeMigrationOperations(canonical, { ...BASELINE_MIGRATION_DESCRIPTOR, checksum: BASELINE_MIGRATION_CHECKSUM }, {
      databaseInstanceId: '00000000000000000000000000000000',
      instanceCreatedAt: '2026-08-15T00:00:00.000Z',
      appliedAt: '2026-08-15T00:00:00.000Z',
      preexistingTables: [],
    });
    for (const statement of RELATION_CONSTRAINT_MIGRATION_SQL) {
      if (!statement.startsWith('UPDATE ') && !statement.startsWith('INSERT ')) canonical.exec(statement);
    }
    for (const statement of RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_SQL) canonical.exec(statement);
    // DATA-03 owns v4 and must be part of the v5 post-schema identity.
    canonical.exec('ALTER TABLE candidate_request ADD COLUMN version INTEGER NOT NULL DEFAULT 1;');
    for (const statement of PRIVACY_MIGRATION_SQL) {
      if (!statement.startsWith('INSERT ')) canonical.exec(statement);
    }
    return schemaIdentityChecksum(captureSchemaIdentity(canonical));
  } finally {
    canonical.close();
  }
}

function runtimeToolIdempotencySchemaChecksum() {
  const canonical = new DatabaseSync(':memory:');
  try {
    executeMigrationOperations(canonical, { ...BASELINE_MIGRATION_DESCRIPTOR, checksum: BASELINE_MIGRATION_CHECKSUM }, {
      databaseInstanceId: '00000000000000000000000000000000',
      instanceCreatedAt: '2026-08-15T00:00:00.000Z',
      appliedAt: '2026-08-15T00:00:00.000Z',
      preexistingTables: [],
    });
    for (const statement of RELATION_CONSTRAINT_MIGRATION_SQL) {
      if (!statement.startsWith('UPDATE ') && !statement.startsWith('INSERT ')) canonical.exec(statement);
    }
    for (const statement of RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_SQL) canonical.exec(statement);
    return schemaIdentityChecksum(captureSchemaIdentity(canonical));
  } finally {
    canonical.close();
  }
}

const RUNTIME_TOOL_IDEMPOTENCY_SCHEMA_CHECKSUM = runtimeToolIdempotencySchemaChecksum();
export const RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_DESCRIPTOR = deepFreeze(Object.freeze({
  version: 3,
  name: 'run-01-runtime-tool-idempotency',
  expectedPostSchemaIdentity: 'current-schema-v3' as const,
  orderedOperations: Object.freeze([
    Object.freeze({
      id: 'runtime-tool-idempotency' as const,
      kind: 'sql_batch' as const,
      statements: RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_SQL,
    }),
    Object.freeze({
      id: 'verify-post-schema' as const,
      kind: 'assert_database' as const,
      expectedSchemaIdentityChecksum: RUNTIME_TOOL_IDEMPOTENCY_SCHEMA_CHECKSUM,
      checks: Object.freeze(['schema', 'foreign_keys', 'integrity'] as const),
    }),
    Object.freeze({
      id: 'record-migration' as const,
      kind: 'record_migration' as const,
      ledgerTable: 'schema_migration' as const,
      userVersion: 3,
    }),
  ]),
}) satisfies MigrationDescriptor);

export const RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_CHECKSUM = migrationDescriptorChecksum(RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_DESCRIPTOR);

/** DATA-03 owns v4: candidate mutations use this durable revision for CAS. */
const CANDIDATE_VERSION_MIGRATION_SQL = Object.freeze([
  'ALTER TABLE candidate_request ADD COLUMN version INTEGER NOT NULL DEFAULT 1;',
] as const);

function candidateVersionSchemaChecksum() {
  const canonical = new DatabaseSync(':memory:');
  try {
    executeMigrationOperations(canonical, { ...BASELINE_MIGRATION_DESCRIPTOR, checksum: BASELINE_MIGRATION_CHECKSUM }, {
      databaseInstanceId: '00000000000000000000000000000000',
      instanceCreatedAt: '2026-08-15T00:00:00.000Z',
      appliedAt: '2026-08-15T00:00:00.000Z',
      preexistingTables: [],
    });
    for (const statement of RELATION_CONSTRAINT_MIGRATION_SQL) {
      if (!statement.startsWith('UPDATE ') && !statement.startsWith('INSERT ')) canonical.exec(statement);
    }
    for (const statement of RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_SQL) canonical.exec(statement);
    for (const statement of CANDIDATE_VERSION_MIGRATION_SQL) canonical.exec(statement);
    return schemaIdentityChecksum(captureSchemaIdentity(canonical));
  } finally {
    canonical.close();
  }
}

export const CANDIDATE_VERSION_SCHEMA_CHECKSUM = candidateVersionSchemaChecksum();
export const CANDIDATE_VERSION_MIGRATION_DESCRIPTOR = deepFreeze(Object.freeze({
  version: 4,
  name: 'data-03-candidate-version-cas',
  expectedPostSchemaIdentity: 'current-schema-v4' as const,
  orderedOperations: Object.freeze([
    Object.freeze({ id: 'candidate-version' as const, kind: 'sql_batch' as const, statements: CANDIDATE_VERSION_MIGRATION_SQL }),
    Object.freeze({
      id: 'verify-post-schema' as const,
      kind: 'assert_database' as const,
      expectedSchemaIdentityChecksum: CANDIDATE_VERSION_SCHEMA_CHECKSUM,
      checks: Object.freeze(['schema', 'foreign_keys', 'integrity'] as const),
    }),
    Object.freeze({
      id: 'record-migration' as const,
      kind: 'record_migration' as const,
      ledgerTable: 'schema_migration' as const,
      userVersion: 4,
    }),
  ]),
}) satisfies MigrationDescriptor);

export const CANDIDATE_VERSION_MIGRATION_CHECKSUM = migrationDescriptorChecksum(CANDIDATE_VERSION_MIGRATION_DESCRIPTOR);
const PRIVACY_SCHEMA_CHECKSUM = privacySchemaChecksum();
export const PRIVACY_MIGRATION_DESCRIPTOR = deepFreeze(Object.freeze({
  version: 5,
  name: 'priv-001-lifecycle-export-deletion',
  expectedPostSchemaIdentity: 'current-schema-v5' as const,
  orderedOperations: Object.freeze([
    Object.freeze({ id: 'privacy-lifecycle-schema' as const, kind: 'sql_batch' as const, statements: PRIVACY_MIGRATION_SQL }),
    Object.freeze({
      id: 'verify-post-schema' as const,
      kind: 'assert_database' as const,
      expectedSchemaIdentityChecksum: PRIVACY_SCHEMA_CHECKSUM,
      checks: Object.freeze(['schema', 'foreign_keys', 'integrity'] as const),
    }),
    Object.freeze({
      id: 'record-migration' as const,
      kind: 'record_migration' as const,
      ledgerTable: 'schema_migration' as const,
      userVersion: 5,
    }),
  ]),
}) satisfies MigrationDescriptor);

export const PRIVACY_MIGRATION_CHECKSUM = migrationDescriptorChecksum(PRIVACY_MIGRATION_DESCRIPTOR);

/**
 * PRIV-001 v6 adds only cross-process fencing and backup cleanup intent. The
 * v5 descriptor above is intentionally left byte-for-byte unchanged so its
 * historical identity/checksum remains verifiable during upgrade.
 */
const PRIVACY_FENCING_MIGRATION_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS privacy_lifecycle_claim (
    operation_id TEXT PRIMARY KEY,
    operation_token TEXT NOT NULL UNIQUE CHECK (length(operation_token) BETWEEN 32 AND 128),
    operation_type TEXT NOT NULL CHECK (operation_type IN ('collection_start','collection_stop','authorization_revoke','hard_delete')),
    owner_open_id TEXT NOT NULL,
    capability_token_hash TEXT NOT NULL CHECK (length(capability_token_hash) = 64),
    capability_csrf_hash TEXT NOT NULL CHECK (length(capability_csrf_hash) = 64),
    capability_origin TEXT NOT NULL CHECK (capability_origin = 'app://local'),
    intent TEXT NOT NULL CHECK (intent IN ('privacy.owner-action.v1','privacy.deletion.hard-delete.v1')),
    expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
    claimed_version INTEGER NOT NULL CHECK (claimed_version = expected_version + 1),
    final_version INTEGER CHECK (final_version IS NULL OR final_version >= claimed_version),
    status TEXT NOT NULL CHECK (status IN ('claimed','committed','compensating','compensated','recovery_required','failed','expired')),
    expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK (length(snapshot_json) > 0),
    recovery_code TEXT,
    last_error TEXT,
    reclaimed_from_operation_id TEXT,
    reclaimed_from_operation_token TEXT,
    reclaimed_from_expected_version INTEGER,
    reclaimed_from_claimed_version INTEGER,
    reclaim_count INTEGER NOT NULL DEFAULT 0 CHECK (reclaim_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_claim_active_type
   ON privacy_lifecycle_claim(operation_type)
   WHERE status IN ('claimed','compensating');`,
  'CREATE INDEX IF NOT EXISTS idx_privacy_claim_recovery ON privacy_lifecycle_claim(status, updated_at DESC);',
  `CREATE TABLE IF NOT EXISTS privacy_backup_cleanup_intent (
    intent_id TEXT PRIMARY KEY,
    operation_token TEXT NOT NULL UNIQUE CHECK (length(operation_token) BETWEEN 32 AND 128),
    database_instance_id TEXT NOT NULL CHECK (length(database_instance_id) = 32),
    backup_file TEXT NOT NULL UNIQUE CHECK (backup_file NOT LIKE '%/%' AND backup_file NOT LIKE '%\\%'),
    manifest_file TEXT NOT NULL CHECK (manifest_file = backup_file || '.manifest.json'),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    status TEXT NOT NULL CHECK (status IN ('pending','staged','manifest_removed','sqlite_removed','completed','recovery_required','failed')),
    recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
    staged_backup_file TEXT CHECK (staged_backup_file IS NULL OR (staged_backup_file NOT LIKE '%/%' AND staged_backup_file NOT LIKE '%\\%')),
    staged_manifest_file TEXT CHECK (staged_manifest_file IS NULL OR (staged_manifest_file NOT LIKE '%/%' AND staged_manifest_file NOT LIKE '%\\%')),
    staged_marker_file TEXT CHECK (staged_marker_file IS NULL OR (staged_marker_file NOT LIKE '%/%' AND staged_marker_file NOT LIKE '%\\%')),
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_privacy_backup_cleanup_status
   ON privacy_backup_cleanup_intent(status, updated_at DESC);`,
] as const);

function privacyFencingSchemaChecksum() {
  const canonical = new DatabaseSync(':memory:');
  try {
    executeMigrationOperations(canonical, { ...BASELINE_MIGRATION_DESCRIPTOR, checksum: BASELINE_MIGRATION_CHECKSUM }, {
      databaseInstanceId: '00000000000000000000000000000000',
      instanceCreatedAt: '2026-08-15T00:00:00.000Z',
      appliedAt: '2026-08-15T00:00:00.000Z',
      preexistingTables: [],
    });
    for (const statement of RELATION_CONSTRAINT_MIGRATION_SQL) {
      if (!statement.startsWith('UPDATE ') && !statement.startsWith('INSERT ')) canonical.exec(statement);
    }
    for (const statement of RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_SQL) canonical.exec(statement);
    for (const statement of CANDIDATE_VERSION_MIGRATION_SQL) canonical.exec(statement);
    for (const statement of PRIVACY_MIGRATION_SQL) {
      if (!statement.startsWith('INSERT ')) canonical.exec(statement);
    }
    for (const statement of PRIVACY_FENCING_MIGRATION_SQL) canonical.exec(statement);
    return schemaIdentityChecksum(captureSchemaIdentity(canonical));
  } finally {
    canonical.close();
  }
}

export const PRIVACY_FENCING_SCHEMA_CHECKSUM = privacyFencingSchemaChecksum();
export const PRIVACY_FENCING_MIGRATION_DESCRIPTOR = deepFreeze(Object.freeze({
  version: 6,
  name: 'priv-001-cross-process-fencing',
  expectedPostSchemaIdentity: 'current-schema-v6' as const,
  orderedOperations: Object.freeze([
    Object.freeze({ id: 'privacy-fencing-schema' as const, kind: 'sql_batch' as const, statements: PRIVACY_FENCING_MIGRATION_SQL }),
    Object.freeze({
      id: 'verify-post-schema' as const,
      kind: 'assert_database' as const,
      expectedSchemaIdentityChecksum: PRIVACY_FENCING_SCHEMA_CHECKSUM,
      checks: Object.freeze(['schema', 'foreign_keys', 'integrity'] as const),
    }),
    Object.freeze({
      id: 'record-migration' as const,
      kind: 'record_migration' as const,
      ledgerTable: 'schema_migration' as const,
      userVersion: 6,
    }),
  ]),
}) satisfies MigrationDescriptor);

export const PRIVACY_FENCING_MIGRATION_CHECKSUM = migrationDescriptorChecksum(PRIVACY_FENCING_MIGRATION_DESCRIPTOR);

/** DATA-04 owns v7: append-only source revisions and exact AI replay references. */
const SOURCE_REVISION_MIGRATION_SQL = Object.freeze([
  'ALTER TABLE source_event ADD COLUMN owner_scope TEXT NOT NULL DEFAULT \'primary\';',
  'ALTER TABLE source_event ADD COLUMN revision_generation INTEGER NOT NULL DEFAULT 0;',
  'ALTER TABLE source_event ADD COLUMN current_revision_id TEXT;',
  `CREATE TABLE IF NOT EXISTS source_event_revision (
    id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    revision_kind TEXT NOT NULL CHECK (revision_kind IN ('ingest','edit','recall','migration')),
    external_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    content TEXT NOT NULL,
    owner_mentioned INTEGER NOT NULL DEFAULT 0 CHECK (owner_mentioned IN (0,1)),
    source_url TEXT,
    completeness TEXT NOT NULL CHECK (completeness IN ('complete','partial','limited')),
    discovery_reason TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    owner_scope TEXT NOT NULL DEFAULT 'primary',
    revision_hash TEXT NOT NULL CHECK (length(revision_hash) = 64),
    created_at TEXT NOT NULL,
    UNIQUE(source_event_id, revision_number),
    UNIQUE(source_event_id, revision_hash)
  );`,
  'CREATE INDEX IF NOT EXISTS idx_source_event_revision_event ON source_event_revision(source_event_id, revision_number);',
  'CREATE INDEX IF NOT EXISTS idx_source_event_revision_hash ON source_event_revision(source_event_id, revision_hash);',
  `INSERT INTO source_event_revision
    (id, source_event_id, revision_number, revision_kind, external_id, source_type, conversation_id,
     sender_id, sender_name, content, owner_mentioned, source_url, completeness, discovery_reason,
     metadata_json, occurred_at, captured_at, owner_scope, revision_hash, created_at)
   SELECT 'source-revision-migration:' || id, id, 1, 'migration', external_id, source_type, conversation_id,
          sender_id, sender_name, content, owner_mentioned, source_url, completeness, discovery_reason,
          metadata_json, occurred_at, captured_at, owner_scope,
          sha256(json_object(
            'ownerScope', owner_scope,
            'sourceEventId', id,
            'revisionNumber', 1,
            'revisionKind', 'migration',
            'externalId', external_id,
            'sourceType', source_type,
            'conversationId', conversation_id,
            'senderId', sender_id,
            'senderName', sender_name,
            'content', content,
            'ownerMentioned', owner_mentioned,
            'sourceUrl', source_url,
            'completeness', completeness,
            'discoveryReason', discovery_reason,
            'metadataJson', metadata_json,
            'occurredAt', occurred_at,
            'capturedAt', captured_at
          )), captured_at
     FROM source_event
    WHERE 1
    ON CONFLICT(source_event_id, revision_number) DO NOTHING;`,
  `UPDATE source_event
      SET current_revision_id = 'source-revision-migration:' || id
    WHERE current_revision_id IS NULL
      AND EXISTS (SELECT 1 FROM source_event_revision WHERE source_event_revision.id = 'source-revision-migration:' || source_event.id);`,
  `CREATE TABLE IF NOT EXISTS ai_decision_source_revision (
    ai_decision_id TEXT NOT NULL REFERENCES ai_decision_log(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL REFERENCES source_event(id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL REFERENCES source_event_revision(id) ON DELETE CASCADE,
    source_order INTEGER NOT NULL CHECK (source_order >= 0),
    revision_hash TEXT,
    owner_scope TEXT NOT NULL DEFAULT 'primary',
    PRIMARY KEY (ai_decision_id, source_event_id),
    UNIQUE (ai_decision_id, revision_id)
  );`,
  'CREATE INDEX IF NOT EXISTS idx_ai_decision_source_revision_revision ON ai_decision_source_revision(revision_id, ai_decision_id);',
  'ALTER TABLE ai_decision_log ADD COLUMN revision_set_hash TEXT;',
  'ALTER TABLE ai_decision_log ADD COLUMN prompt_hash TEXT;',
  'ALTER TABLE ai_decision_log ADD COLUMN model_config_hash TEXT;',
  'ALTER TABLE ai_decision_log ADD COLUMN replay_state TEXT NOT NULL DEFAULT \'unreplayable_legacy\' CHECK (replay_state IN (\'replayable\',\'unreplayable_legacy\'));',
  'ALTER TABLE ai_decision_log ADD COLUMN replay_state_reason TEXT NOT NULL DEFAULT \'legacy decision lacks exact DATA-04 replay inputs\';',
  'ALTER TABLE ai_decision_log ADD COLUMN owner_scope TEXT NOT NULL DEFAULT \'primary\';',
  `CREATE TABLE IF NOT EXISTS audit_replay_capability (
    id TEXT PRIMARY KEY,
    owner_scope TEXT NOT NULL DEFAULT 'primary' CHECK (owner_scope = 'primary'),
    capability_token_hash TEXT NOT NULL CHECK (length(capability_token_hash) = 64),
    capability_csrf_hash TEXT NOT NULL CHECK (length(capability_csrf_hash) = 64),
    capability_origin TEXT NOT NULL CHECK (capability_origin = 'app://local'),
    intent TEXT NOT NULL CHECK (intent = 'audit.ai-decision.replay.v1'),
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','revoked','consumed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    consumed_at TEXT,
    revoked_at TEXT,
    UNIQUE(owner_scope, intent)
  );`,
  'CREATE INDEX IF NOT EXISTS idx_audit_replay_capability_state ON audit_replay_capability(owner_scope, intent, status, expires_at);',
] as const);

function sourceRevisionSchemaChecksum() {
  const canonical = new DatabaseSync(':memory:');
  try {
    registerData04SqlFunctions(canonical);
    executeMigrationOperations(canonical, { ...BASELINE_MIGRATION_DESCRIPTOR, checksum: BASELINE_MIGRATION_CHECKSUM }, {
      databaseInstanceId: '00000000000000000000000000000000',
      instanceCreatedAt: '2026-08-15T00:00:00.000Z',
      appliedAt: '2026-08-15T00:00:00.000Z',
      preexistingTables: [],
    });
    for (const statement of RELATION_CONSTRAINT_MIGRATION_SQL) {
      if (!statement.startsWith('UPDATE ') && !statement.startsWith('INSERT ')) canonical.exec(statement);
    }
    for (const statement of RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_SQL) canonical.exec(statement);
    for (const statement of CANDIDATE_VERSION_MIGRATION_SQL) canonical.exec(statement);
    for (const statement of PRIVACY_MIGRATION_SQL) {
      if (!statement.startsWith('INSERT ')) canonical.exec(statement);
    }
    for (const statement of PRIVACY_FENCING_MIGRATION_SQL) canonical.exec(statement);
    for (const statement of SOURCE_REVISION_MIGRATION_SQL) {
      if (!statement.startsWith('INSERT ') && !statement.startsWith('UPDATE ')) canonical.exec(statement);
    }
    return schemaIdentityChecksum(captureSchemaIdentity(canonical));
  } finally {
    canonical.close();
  }
}

export const SOURCE_REVISION_SCHEMA_CHECKSUM = sourceRevisionSchemaChecksum();
export const SOURCE_REVISION_MIGRATION_DESCRIPTOR = deepFreeze(Object.freeze({
  version: 7,
  name: 'data-04-source-revisions-replay',
  expectedPostSchemaIdentity: 'current-schema-v7' as const,
  orderedOperations: Object.freeze([
    Object.freeze({ id: 'source-revision-replay' as const, kind: 'sql_batch' as const, statements: SOURCE_REVISION_MIGRATION_SQL }),
    Object.freeze({
      id: 'verify-post-schema' as const,
      kind: 'assert_database' as const,
      expectedSchemaIdentityChecksum: SOURCE_REVISION_SCHEMA_CHECKSUM,
      checks: Object.freeze(['schema', 'foreign_keys', 'integrity'] as const),
    }),
    Object.freeze({
      id: 'record-migration' as const,
      kind: 'record_migration' as const,
      ledgerTable: 'schema_migration' as const,
      userVersion: 7,
    }),
  ]),
}) satisfies MigrationDescriptor);

export const SOURCE_REVISION_MIGRATION_CHECKSUM = migrationDescriptorChecksum(SOURCE_REVISION_MIGRATION_DESCRIPTOR);

/** RUN-02 owns v8: provider retry cooldown must survive process restarts. */
const PROVIDER_RETRY_COOLDOWN_MIGRATION_SQL = Object.freeze([
  `CREATE TABLE provider_retry_cooldown (
    provider_key TEXT PRIMARY KEY,
    retry_at_ms INTEGER NOT NULL CHECK (retry_at_ms >= 0),
    updated_at TEXT NOT NULL
  );`,
  'CREATE INDEX idx_provider_retry_cooldown_retry_at ON provider_retry_cooldown(retry_at_ms);',
] as const);

function providerRetryCooldownSchemaChecksum() {
  const canonical = new DatabaseSync(':memory:');
  try {
    registerData04SqlFunctions(canonical);
    executeMigrationOperations(canonical, { ...BASELINE_MIGRATION_DESCRIPTOR, checksum: BASELINE_MIGRATION_CHECKSUM }, {
      databaseInstanceId: '00000000000000000000000000000000',
      instanceCreatedAt: '2026-08-15T00:00:00.000Z',
      appliedAt: '2026-08-15T00:00:00.000Z',
      preexistingTables: [],
    });
    for (const statement of RELATION_CONSTRAINT_MIGRATION_SQL) {
      if (!statement.startsWith('UPDATE ') && !statement.startsWith('INSERT ')) canonical.exec(statement);
    }
    for (const statement of RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_SQL) canonical.exec(statement);
    for (const statement of CANDIDATE_VERSION_MIGRATION_SQL) canonical.exec(statement);
    for (const statement of PRIVACY_MIGRATION_SQL) {
      if (!statement.startsWith('INSERT ')) canonical.exec(statement);
    }
    for (const statement of PRIVACY_FENCING_MIGRATION_SQL) canonical.exec(statement);
    for (const statement of SOURCE_REVISION_MIGRATION_SQL) {
      if (!statement.startsWith('INSERT ') && !statement.startsWith('UPDATE ')) canonical.exec(statement);
    }
    for (const statement of PROVIDER_RETRY_COOLDOWN_MIGRATION_SQL) canonical.exec(statement);
    return schemaIdentityChecksum(captureSchemaIdentity(canonical));
  } finally {
    canonical.close();
  }
}

export const PROVIDER_RETRY_COOLDOWN_SCHEMA_CHECKSUM = providerRetryCooldownSchemaChecksum();
export const PROVIDER_RETRY_COOLDOWN_MIGRATION_DESCRIPTOR = deepFreeze(Object.freeze({
  version: 8,
  name: 'run-02-provider-retry-cooldown',
  expectedPostSchemaIdentity: 'current-schema-v8' as const,
  orderedOperations: Object.freeze([
    Object.freeze({ id: 'provider-retry-cooldown' as const, kind: 'sql_batch' as const, statements: PROVIDER_RETRY_COOLDOWN_MIGRATION_SQL }),
    Object.freeze({
      id: 'verify-post-schema' as const,
      kind: 'assert_database' as const,
      expectedSchemaIdentityChecksum: PROVIDER_RETRY_COOLDOWN_SCHEMA_CHECKSUM,
      checks: Object.freeze(['schema', 'foreign_keys', 'integrity'] as const),
    }),
    Object.freeze({
      id: 'record-migration' as const,
      kind: 'record_migration' as const,
      ledgerTable: 'schema_migration' as const,
      userVersion: 8,
    }),
  ]),
}) satisfies MigrationDescriptor);

export const PROVIDER_RETRY_COOLDOWN_MIGRATION_CHECKSUM = migrationDescriptorChecksum(PROVIDER_RETRY_COOLDOWN_MIGRATION_DESCRIPTOR);
const MIGRATIONS = [
  {
    ...BASELINE_MIGRATION_DESCRIPTOR,
    checksum: BASELINE_MIGRATION_CHECKSUM,
  },
  {
    ...RELATION_CONSTRAINT_MIGRATION_DESCRIPTOR,
    checksum: RELATION_CONSTRAINT_MIGRATION_CHECKSUM,
  },
  {
    ...RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_DESCRIPTOR,
    checksum: RUNTIME_TOOL_IDEMPOTENCY_MIGRATION_CHECKSUM,
  },
  {
    ...CANDIDATE_VERSION_MIGRATION_DESCRIPTOR,
    checksum: CANDIDATE_VERSION_MIGRATION_CHECKSUM,
  },
  {
    ...PRIVACY_MIGRATION_DESCRIPTOR,
    checksum: PRIVACY_MIGRATION_CHECKSUM,
  },
  {
    ...PRIVACY_FENCING_MIGRATION_DESCRIPTOR,
    checksum: PRIVACY_FENCING_MIGRATION_CHECKSUM,
  },
  {
    ...SOURCE_REVISION_MIGRATION_DESCRIPTOR,
    checksum: SOURCE_REVISION_MIGRATION_CHECKSUM,
  },
  {
    ...PROVIDER_RETRY_COOLDOWN_MIGRATION_DESCRIPTOR,
    checksum: PROVIDER_RETRY_COOLDOWN_MIGRATION_CHECKSUM,
  },
] as const;

function assertExecutableMigrationDescriptor(descriptor: MigrationDescriptor) {
  if (
    !Number.isInteger(descriptor.version)
    || descriptor.version < 1
    || !['current-schema-v1', 'current-schema-v2', 'current-schema-v3', 'current-schema-v4', 'current-schema-v5', 'current-schema-v6', 'current-schema-v7', 'current-schema-v8'].includes(descriptor.expectedPostSchemaIdentity)
    || descriptor.orderedOperations.length === 0
  ) {
    throw new DatabaseUpgradeError('migration', '数据库迁移描述符版本或负载无效；已拒绝推进版本。');
  }
  const operationIds = new Set<string>();
  let assertionCount = 0;
  let recordCount = 0;
  for (const operation of descriptor.orderedOperations) {
    if (!/^[a-z][a-z0-9-]*$/u.test(operation.id) || operationIds.has(operation.id)) {
      throw new DatabaseUpgradeError('migration', '数据库迁移操作身份无效或重复；已拒绝推进版本。');
    }
    operationIds.add(operation.id);
    if (operation.kind === 'conditional_rebuild') {
      if (operation.rebuild.copyMode !== 'insert_select' || operation.rebuild.conflictMode !== 'abort') {
        throw new DatabaseUpgradeError('migration', '数据库迁移只允许严格复制模式；已拒绝推进版本。');
      }
      if (operation.rebuild.targetColumns.length !== operation.rebuild.sourceColumns.length) {
        throw new DatabaseUpgradeError('migration', '数据库迁移重建列映射不完整；已拒绝推进版本。');
      }
    } else if (operation.kind === 'rebuild_tables') {
      if (operation.tables.some((table) => (
        table.copyMode !== 'insert_select'
        || table.conflictMode !== 'abort'
        || table.targetColumns.length !== table.sourceColumns.length
      ))) {
        throw new DatabaseUpgradeError('migration', '数据库迁移 canonical 重建负载无效；已拒绝推进版本。');
      }
    } else if (operation.kind === 'assert_database') {
      assertionCount += 1;
      if (!/^[0-9a-f]{64}$/u.test(operation.expectedSchemaIdentityChecksum)) {
        throw new DatabaseUpgradeError('migration', '数据库迁移 post-schema 身份无效；已拒绝推进版本。');
      }
    } else if (operation.kind === 'record_migration') {
      recordCount += 1;
      if (operation.userVersion !== descriptor.version || operation.ledgerTable !== 'schema_migration') {
        throw new DatabaseUpgradeError('migration', '数据库迁移账本推进负载无效；已拒绝推进版本。');
      }
    } else if (operation.kind === 'assert_no_rows') {
      if (operation.queries.length === 0) {
        throw new DatabaseUpgradeError('migration', '数据库迁移冲突检查负载为空；已拒绝推进版本。');
      }
    } else if (!['sql_batch', 'add_columns', 'bind_database_instance'].includes(operation.kind)) {
      throw new DatabaseUpgradeError('migration', '数据库迁移描述符包含未知执行类型；已拒绝推进版本。');
    }
  }
  const lastOperation = descriptor.orderedOperations.at(-1);
  const penultimateOperation = descriptor.orderedOperations.at(-2);
  if (
    assertionCount !== 1
    || recordCount !== 1
    || penultimateOperation?.kind !== 'assert_database'
    || lastOperation?.kind !== 'record_migration'
  ) {
    throw new DatabaseUpgradeError('migration', '数据库迁移校验与账本顺序无效；已拒绝推进版本。');
  }
}

interface MigrationExecutionContext {
  databaseInstanceId: string;
  instanceCreatedAt: string;
  appliedAt: string;
  preexistingTables: readonly string[];
}

function migrationConditionMatches(database: DatabaseSync, condition: MigrationCondition) {
  if (condition.kind === 'table_sql_missing') {
    const tableSql = (database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(condition.table) as { sql?: string } | undefined)?.sql ?? '';
    return !tableSql.includes(condition.marker);
  }
  if (condition.kind === 'unique_index_columns') {
    const indexes = database.prepare(`PRAGMA index_list(${JSON.stringify(condition.table)})`).all() as Array<{
      name: string;
      unique: number;
    }>;
    return indexes.some((index) => {
      if (!index.unique) return false;
      const columns = database.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>;
      return JSON.stringify(columns.map((column) => column.name)) === JSON.stringify(condition.columns);
    });
  }
  throw new DatabaseUpgradeError('migration', '数据库迁移包含未知条件；已拒绝推进版本。');
}

function executeTableRebuild(database: DatabaseSync, rebuild: Readonly<MigrationTableRebuild>) {
  if (
    rebuild.copyMode !== 'insert_select'
    || rebuild.conflictMode !== 'abort'
    || rebuild.targetColumns.length !== rebuild.sourceColumns.length
  ) {
    throw new DatabaseUpgradeError('migration', '数据库迁移重建映射无效；已拒绝继续。');
  }
  const existingTemporary = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(rebuild.temporaryTable);
  if (existingTemporary) {
    throw new DatabaseUpgradeError('migration', '数据库迁移临时表发生冲突；已拒绝继续。');
  }
  const actualColumns = (database.prepare(`PRAGMA table_info(${JSON.stringify(rebuild.table)})`).all() as Array<{ name: string }> )
    .map((column) => column.name);
  if (
    actualColumns.length !== rebuild.sourceColumns.length
    || JSON.stringify([...actualColumns].sort()) !== JSON.stringify([...rebuild.sourceColumns].sort())
  ) {
    throw new DatabaseUpgradeError('migration', '数据库迁移源列与声明式负载不一致；已拒绝继续。');
  }
  database.exec(rewriteCreateTableName(rebuild.createSql, rebuild.temporaryTable));
  const targetColumns = rebuild.targetColumns.map(controlledIdentifier).join(', ');
  const sourceColumns = rebuild.sourceColumns.map(controlledIdentifier).join(', ');
  database.exec(
    `INSERT INTO ${controlledIdentifier(rebuild.temporaryTable)} (${targetColumns}) `
    + `SELECT ${sourceColumns} FROM ${controlledIdentifier(rebuild.table)};`,
  );
  database.exec(`DROP TABLE ${controlledIdentifier(rebuild.table)};`);
  database.exec(
    `ALTER TABLE ${controlledIdentifier(rebuild.temporaryTable)} RENAME TO ${controlledIdentifier(rebuild.table)};`,
  );
  for (const statement of rebuild.indexSql) database.exec(statement);
}

function executeMigrationOperations(
  database: DatabaseSync,
  descriptor: MigrationDescriptor & { checksum: string },
  context: MigrationExecutionContext,
  operations: readonly MigrationOperation[] = descriptor.orderedOperations,
) {
  for (const operation of operations) {
    switch (operation.kind) {
      case 'sql_batch':
        for (const statement of operation.statements) database.exec(statement);
        break;
      case 'add_columns':
        for (const [table, column, definition] of operation.columns) {
          const columns = database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>;
          if (!columns.some((item) => item.name === column)) {
            database.exec(
              `ALTER TABLE ${controlledSchemaIdentifier(table)} ADD COLUMN ${controlledSchemaIdentifier(column)} ${definition}`,
            );
          }
        }
        break;
      case 'assert_no_rows':
        for (const query of operation.queries) {
          if (database.prepare(query).get()) {
            throw new DatabaseUpgradeError('migration', '旧数据库存在无法安全关联的冲突数据；已回滚并拒绝升级。');
          }
        }
        break;
      case 'conditional_rebuild':
        if (migrationConditionMatches(database, operation.condition)) executeTableRebuild(database, operation.rebuild);
        break;
      case 'rebuild_tables': {
        const rebuilds = new Map(operation.tables.map((table) => [table.table, table]));
        for (const table of context.preexistingTables) {
          const rebuild = rebuilds.get(table);
          if (!rebuild) {
            throw new DatabaseUpgradeError('migration', '数据库旧版表身份不在受控迁移负载中；已拒绝继续。');
          }
          executeTableRebuild(database, rebuild);
        }
        break;
      }
      case 'bind_database_instance':
        database.exec(operation.createTableSql);
        bindDatabaseInstanceIdentity(database, context.databaseInstanceId, context.instanceCreatedAt);
        break;
      case 'assert_database':
        for (const check of operation.checks) {
          if (check === 'schema') {
            const actualSchemaIdentityChecksum = schemaIdentityChecksum(captureSchemaIdentity(database));
            if (actualSchemaIdentityChecksum !== operation.expectedSchemaIdentityChecksum) {
              throw new DatabaseUpgradeError('migration', '数据库当前版本的完整 schema 身份不一致；已拒绝继续。');
            }
          } else if (check === 'foreign_keys') assertForeignKeyIntegrity(database, 'migration');
          else if (check === 'integrity') assertDatabaseIntegrity(database, 'migration');
          else throw new DatabaseUpgradeError('migration', '数据库迁移包含未知校验；已拒绝推进版本。');
        }
        break;
      case 'record_migration':
        database.prepare(
          `INSERT INTO ${controlledIdentifier(operation.ledgerTable)}
            (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
        ).run(descriptor.version, descriptor.name, descriptor.checksum, context.appliedAt);
        database.exec(`PRAGMA user_version = ${operation.userVersion};`);
        break;
      default:
        throw new DatabaseUpgradeError('migration', '数据库迁移包含未知执行类型；已拒绝推进版本。');
    }
  }
}
// MIGRATION_V1_LOGIC_END

function openAppDatabase(path: string) {
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    return new DatabaseSync(path);
  } catch {
    throw new DatabaseUpgradeError('ledger', '无法打开本地 SQLite；已拒绝启动。');
  }
}

export class AppDatabase {
  readonly raw: DatabaseSync;
  private readonly databasePath: string;
  private readonly transactionFaults: DatabaseOptions['transactionFaults'];
  private readonly privacyBackupFaults: DatabaseOptions['privacyBackupFaults'];
  private databaseInstanceId: string | undefined;

  constructor(path: string, seedDemoData = true, options: DatabaseOptions = {}) {
    this.databasePath = path;
    this.transactionFaults = options.transactionFaults;
    this.privacyBackupFaults = options.privacyBackupFaults;
    const isFileDatabase = path !== ':memory:';
    const databaseExisted = isFileDatabase && pathExistsControlled(path, 'ledger');
    this.raw = openAppDatabase(path);
    let upgradeBackupPath: string | undefined;
    let upgradeDatabaseInstanceId: string | undefined;
    const migrations = options.migrationDescriptorForTest
      ? (() => {
        const descriptor = {
          ...options.migrationDescriptorForTest,
          checksum: migrationDescriptorChecksum(options.migrationDescriptorForTest),
        };
        // Test-only fault injection replaces exactly one continuous version;
        // all other published descriptors remain byte-for-byte authoritative.
        return MIGRATIONS.map((migration) => migration.version === descriptor.version ? descriptor : migration);
      })()
      : MIGRATIONS;
    try {
      this.raw.exec('PRAGMA foreign_keys = ON;');
      registerData04SqlFunctions(this.raw);
      this.runMigrations(path, databaseExisted, options.now ?? (() => new Date()), migrations, (backupPath, instanceId) => {
        upgradeBackupPath = backupPath;
        upgradeDatabaseInstanceId = instanceId;
      });
      this.databaseInstanceId = readDatabaseInstanceIdentity(this.raw, 'ledger', true)?.instanceId;
    } catch (error) {
      try { this.raw.close(); } catch {}
      if (isFileDatabase && upgradeBackupPath) {
        try {
          restoreDatabaseBackup(path, upgradeBackupPath, { expectedDatabaseInstanceId: upgradeDatabaseInstanceId });
        } catch {
          throw new DatabaseUpgradeError(
            'restore',
            'SQLite 升级失败且自动恢复未完成；已保留升级前备份并拒绝启动。',
          );
        }
        throw new DatabaseUpgradeError(
          'migration',
          'SQLite 升级失败；已从校验通过的升级前备份恢复并拒绝本次启动。',
        );
      }
      if (error instanceof DatabaseUpgradeError) throw error;
      throw new DatabaseUpgradeError('ledger', 'SQLite 启动校验失败；已拒绝启动。');
    }
    if (seedDemoData) {
      this.seed();
    }
  }

  private runMigrations(
    path: string,
    databaseExisted: boolean,
    now: () => Date,
    migrations: readonly (MigrationDescriptor & { checksum: string })[],
    onBackupCreated: (path: string, instanceId: string) => void,
  ) {
    for (const migration of migrations) assertExecutableMigrationDescriptor(migration);
    if (
      migrations.at(-1)?.version !== CURRENT_SCHEMA_VERSION
      || migrations.some((migration, index) => migration.version !== index + 1 || !/^[0-9a-f]{64}$/u.test(migration.checksum))
    ) {
      throw new Error('数据库迁移定义必须连续递增并包含 SHA-256 checksum。');
    }
    const applicationTables = applicationTableNames(this.raw);
    const isEmptyDatabase = applicationTables.length === 0;
    const inspected = databaseExisted ? inspectDatabaseIdentity(this.raw, 'ledger', migrations) : undefined;
    const currentVersion = inspected?.version ?? 0;
    if (!databaseExisted && !isEmptyDatabase) {
      throw new DatabaseUpgradeError('ledger', '新数据库初始化前状态异常；已拒绝继续。');
    }
    const pendingMigrations = migrations.filter((migration) => migration.version > currentVersion);
    if (pendingMigrations.length === 0) {
      assertDatabaseIntegrity(this.raw, 'ledger');
      assertForeignKeyIntegrity(this.raw, 'ledger');
      return;
    }

    const instanceCreatedAt = inspected?.instanceCreatedAt ?? now().toISOString();
    const databaseInstanceId = inspected?.instanceId ?? newDatabaseInstanceId();
    let createdBackupPath: string | undefined;
    if (path !== ':memory:' && !isEmptyDatabase) {
      assertDatabaseIntegrity(this.raw, 'backup');
      createdBackupPath = this.createUpgradeBackup(
        path,
        currentVersion,
        pendingMigrations.at(-1)!.version,
        now(),
        databaseInstanceId,
        instanceCreatedAt,
      );
      onBackupCreated(createdBackupPath, databaseInstanceId);
    }

    this.raw.exec('PRAGMA foreign_keys = OFF;');
    try {
      this.raw.exec('BEGIN IMMEDIATE;');
      for (const migration of pendingMigrations) {
        executeMigrationOperations(
          this.raw,
          migration,
          {
            databaseInstanceId,
            instanceCreatedAt,
            appliedAt: now().toISOString(),
            preexistingTables: applicationTables,
          },
        );
      }
      this.raw.exec('COMMIT;');
    } catch (error) {
      try { this.raw.exec('ROLLBACK;'); } catch {}
      if (error instanceof DatabaseUpgradeError) throw error;
      throw new DatabaseUpgradeError('migration', 'SQLite 迁移未完成；已回滚本次事务。');
    } finally {
      this.raw.exec('PRAGMA foreign_keys = ON;');
    }

    assertDatabaseIntegrity(this.raw, 'migration');
    if (path !== ':memory:') cleanupManagedBackups(path, databaseInstanceId, DATABASE_BACKUP_RETENTION, createdBackupPath);
  }

  private createUpgradeBackup(
    path: string,
    fromVersion: number,
    toVersion: number,
    now: Date,
    databaseInstanceId: string,
    instanceCreatedAt: string,
  ) {
    const directory = backupDirectory(path);
    const fileName = `${basename(path)}.backup-v${fromVersion}-to-v${toVersion}-${formatBackupTimestamp(now)}-${randomUUID().replaceAll('-', '')}.sqlite`;
    const backupPath = join(directory, fileName);
    const temporaryPath = `${backupPath}.tmp`;
    const manifestPath = backupManifestPath(backupPath);
    const temporaryManifestPath = `${manifestPath}.tmp`;
    let backupCreated = false;
    let manifestCreated = false;
    const temporaryExisted = pathExistsControlled(temporaryPath, 'backup');
    const backupExisted = pathExistsControlled(backupPath, 'backup');
    const temporaryManifestExisted = pathExistsControlled(temporaryManifestPath, 'backup');
    const manifestExisted = pathExistsControlled(manifestPath, 'backup');
    try {
      mkdirSync(directory, { recursive: true });
      assertPlainBackupDirectory(directory, 'backup');
      if (temporaryExisted || backupExisted || temporaryManifestExisted || manifestExisted) {
        throw new DatabaseUpgradeError('backup', '升级备份文件名发生冲突；数据库未迁移。');
      }
      this.raw.prepare('VACUUM INTO ?').run(temporaryPath);
      const temporaryDatabase = new DatabaseSync(temporaryPath);
      try {
        bindDatabaseInstanceIdentity(temporaryDatabase, databaseInstanceId, instanceCreatedAt);
      } finally {
        temporaryDatabase.close();
      }
      inspectDatabaseFile(temporaryPath, 'backup');
      renameSync(temporaryPath, backupPath);
      backupCreated = true;
      assertPlainSingleLinkFile(backupPath, 'backup');
      inspectDatabaseFile(backupPath, 'backup');
      writeFileSync(temporaryManifestPath, `${JSON.stringify({
        // Manifest format version is independent from the SQLite schema
        // version. Keep the established v2 manifest contract while the
        // database itself advances to schema v3.
        schema_version: 2,
        created_by: 'feishu-ai-pm',
        database_name: basename(path),
        database_instance_id: databaseInstanceId,
        backup_file: basename(backupPath),
        from_version: fromVersion,
        to_version: toVersion,
        created_at: parseManagedBackupName(path, backupPath)!.createdAt,
        sha256: sha256File(backupPath),
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      renameSync(temporaryManifestPath, manifestPath);
      manifestCreated = true;
      verifyManagedBackup(path, backupPath, databaseInstanceId, 'backup');
      return backupPath;
    } catch (error) {
      try {
        if (!temporaryExisted && pathExistsControlled(temporaryPath, 'backup')) rmSync(temporaryPath);
        if (!temporaryManifestExisted && pathExistsControlled(temporaryManifestPath, 'backup')) rmSync(temporaryManifestPath);
        if (!manifestExisted && manifestCreated && pathExistsControlled(manifestPath, 'backup')) rmSync(manifestPath);
        if (!backupExisted && backupCreated && pathExistsControlled(backupPath, 'backup')) rmSync(backupPath);
      } catch {
        throw new DatabaseUpgradeError('backup', '升级备份失败且受控清理未完成；已拒绝继续启动。');
      }
      if (error instanceof DatabaseUpgradeError) throw error;
      throw new DatabaseUpgradeError('backup', '无法创建并校验升级前备份；数据库未迁移。');
    }
  }

  transaction<T>(work: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.transactionFaults?.beforeCommit?.();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  createPrivacyBackup(now = new Date()) {
    if (this.databasePath === ':memory:') {
      throw new DatabaseUpgradeError('backup', '内存数据库不能创建持久备份。');
    }
    const identity = readDatabaseInstanceIdentity(this.raw, 'backup', true);
    if (!identity?.instanceId) throw new DatabaseUpgradeError('backup', '数据库实例身份缺失；已拒绝创建备份。');
    const backupPath = this.createUpgradeBackup(
      this.databasePath,
      CURRENT_SCHEMA_VERSION,
      CURRENT_SCHEMA_VERSION,
      now,
      identity.instanceId,
      identity.createdAt,
    );
    const parsed = parseManagedBackupName(this.databasePath, backupPath);
    if (!parsed) throw new DatabaseUpgradeError('backup', '备份文件名未通过受控校验。');
    return {
      fileName: parsed.fileName,
      sha256: sha256File(backupPath),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: parsed.createdAt,
    };
  }

  verifyPrivacyBackup(fileName: string) {
    if (this.databasePath === ':memory:' || basename(fileName) !== fileName) {
      throw new DatabaseUpgradeError('restore', '备份文件名不受支持；已拒绝恢复。');
    }
    const backupPath = join(backupDirectory(this.databasePath), fileName);
    const identity = readDatabaseInstanceIdentity(this.raw, 'restore', true);
    if (!identity?.instanceId) throw new DatabaseUpgradeError('restore', '数据库实例身份缺失；已拒绝恢复。');
    const verified = verifyManagedBackup(this.databasePath, backupPath, identity.instanceId, 'restore');
    return {
      fileName: basename(verified.backupPath),
      sha256: verified.manifest.sha256,
      schemaVersion: verified.manifest.to_version,
      createdAt: verified.manifest.created_at,
      requiresRestart: true,
    };
  }

  private privacyBackupCleanupIntent(fileName: string) {
    return this.raw.prepare(
      `SELECT intent_id, operation_token, database_instance_id, backup_file, manifest_file,
              schema_version, sha256, status, recovery_count,
              staged_backup_file, staged_manifest_file, staged_marker_file,
              last_error, created_at, updated_at
       FROM privacy_backup_cleanup_intent WHERE backup_file = ?`,
    ).get(fileName) as {
      intent_id: string;
      operation_token: string;
      database_instance_id: string;
      backup_file: string;
      manifest_file: string;
      schema_version: number;
      sha256: string;
      status: 'pending' | 'staged' | 'manifest_removed' | 'sqlite_removed' | 'completed' | 'recovery_required' | 'failed';
      recovery_count: number;
      staged_backup_file: string | null;
      staged_manifest_file: string | null;
      staged_marker_file: string | null;
      last_error: string | null;
      created_at: string;
      updated_at: string;
    } | undefined;
  }

  /** Persist cleanup identity before deleting either member of a backup pair. */
  beginPrivacyBackupCleanup(fileName: string) {
    if (this.databasePath === ':memory:' || basename(fileName) !== fileName) {
      throw new DatabaseUpgradeError('backup', '备份清理意图路径不受支持；已拒绝继续。');
    }
    const existing = this.privacyBackupCleanupIntent(fileName);
    if (existing) return existing;
    const backupPath = join(backupDirectory(this.databasePath), fileName);
    const identity = readDatabaseInstanceIdentity(this.raw, 'backup', true);
    if (!identity?.instanceId) throw new DatabaseUpgradeError('backup', '数据库实例身份缺失；已拒绝登记备份清理意图。');
    const verified = verifyManagedBackup(this.databasePath, backupPath, identity.instanceId, 'backup');
    const now = new Date().toISOString();
    const intent = {
      intentId: `privacy-cleanup-${randomUUID()}`,
      operationToken: randomUUID().replaceAll('-', ''),
      databaseInstanceId: identity.instanceId,
      backupFile: basename(verified.backupPath),
      manifestFile: basename(backupManifestPath(verified.backupPath)),
      schemaVersion: verified.manifest.to_version,
      sha256: verified.manifest.sha256,
    };
    this.transaction(() => {
      this.raw.prepare(
        `INSERT INTO privacy_backup_cleanup_intent
         (intent_id, operation_token, database_instance_id, backup_file, manifest_file,
          schema_version, sha256, status, recovery_count,
          staged_backup_file, staged_manifest_file, staged_marker_file,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
      ).run(
        intent.intentId,
        intent.operationToken,
        intent.databaseInstanceId,
        intent.backupFile,
        intent.manifestFile,
        intent.schemaVersion,
        intent.sha256,
        now,
        now,
      );
    });
    return this.privacyBackupCleanupIntent(fileName)!;
  }

  private updatePrivacyBackupCleanupIntent(
    fileName: string,
    status: 'pending' | 'staged' | 'manifest_removed' | 'sqlite_removed' | 'completed' | 'recovery_required' | 'failed',
    error?: unknown,
    staged?: { backupFile: string | null; manifestFile: string | null; markerFile: string | null },
  ) {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.name : error ? 'UNKNOWN' : null;
    this.transaction(() => {
      const existing = this.privacyBackupCleanupIntent(fileName);
      if (!existing) throw new DatabaseUpgradeError('backup', '备份清理意图不存在；已拒绝状态推进。');
      if (existing.status === 'completed') return;
      const updated = this.raw.prepare(
        `UPDATE privacy_backup_cleanup_intent
         SET status = ?, recovery_count = recovery_count + ?,
             staged_backup_file = ?, staged_manifest_file = ?, staged_marker_file = ?,
             last_error = ?, updated_at = ?
         WHERE backup_file = ? AND status NOT IN ('completed','failed')`,
      ).run(
        status,
        status === 'recovery_required' ? 1 : 0,
        staged?.backupFile ?? existing.staged_backup_file,
        staged?.manifestFile ?? existing.staged_manifest_file,
        staged?.markerFile ?? existing.staged_marker_file,
        message,
        now,
        fileName,
      );
      if (updated.changes !== 1) throw new DatabaseUpgradeError('backup', '备份清理意图状态无法安全推进。');
    });
  }

  /** Reconcile a pending cleanup even when its manifest was already removed. */
  recoverPrivacyBackupCleanup(fileName: string) {
    if (this.databasePath === ':memory:' || basename(fileName) !== fileName) {
      throw new DatabaseUpgradeError('backup', '备份清理恢复路径不受支持；已拒绝继续。');
    }
    const intent = this.privacyBackupCleanupIntent(fileName);
    if (!intent) throw new DatabaseUpgradeError('backup', '备份清理意图不存在；已拒绝恢复未知文件。');
    const identity = readDatabaseInstanceIdentity(this.raw, 'backup', true);
    if (!identity?.instanceId || identity.instanceId !== intent.database_instance_id) {
      throw new DatabaseUpgradeError('backup', '备份清理意图数据库身份不匹配；已拒绝恢复。');
    }
    const directory = backupDirectory(this.databasePath);
    assertPlainBackupDirectory(directory, 'backup');
    try {
      const resolvedDatabase = resolve(this.databasePath);
      const realDatabaseParent = realpathSync(dirname(resolvedDatabase));
      const realBackupDirectory = realpathSync(directory);
      if (normalizedComparablePath(realBackupDirectory) !== normalizedComparablePath(join(realDatabaseParent, 'backups'))) {
        throw new DatabaseUpgradeError('backup', '数据库备份目录真实路径不在当前数据库旁；已拒绝恢复清理。');
      }
    } catch (error) {
      if (error instanceof DatabaseUpgradeError) throw error;
      throw new DatabaseUpgradeError('backup', '数据库备份目录真实路径无法安全确认；已拒绝恢复清理。');
    }
    const backupPath = join(directory, intent.backup_file);
    const manifestPath = join(directory, intent.manifest_file);
    const stagedBackupPath = intent.staged_backup_file ? join(directory, intent.staged_backup_file) : undefined;
    const stagedManifestPath = intent.staged_manifest_file ? join(directory, intent.staged_manifest_file) : undefined;
    const stagedMarkerPath = intent.staged_marker_file ? join(directory, intent.staged_marker_file) : undefined;
    const stagedMarkerExists = () => Boolean(stagedMarkerPath && pathExistsControlled(stagedMarkerPath, 'backup'));
    const validateManagedArtifact = (path: string) => {
      assertPlainSingleLinkFile(path, 'backup');
      const inspected = inspectDatabaseFile(path, 'backup');
      if (inspected.instanceId !== intent.database_instance_id || sha256File(path) !== intent.sha256) {
        throw new DatabaseUpgradeError('backup', '备份清理意图与受管 SQLite 身份不一致；已拒绝恢复。');
      }
    };
    const stagedBackupExists = Boolean(stagedBackupPath && pathExistsControlled(stagedBackupPath, 'backup'));
    const backupExists = pathExistsControlled(backupPath, 'backup');
    if (stagedBackupExists && backupExists) {
      throw new DatabaseUpgradeError('backup', '备份清理意图同时发现原路径与暂存路径；已拒绝恢复。');
    }
    if (stagedBackupExists) validateManagedArtifact(stagedBackupPath!);
    else if (backupExists) validateManagedArtifact(backupPath);
    const manifestExists = pathExistsControlled(manifestPath, 'backup');
    const stagedManifestExists = Boolean(stagedManifestPath && pathExistsControlled(stagedManifestPath, 'backup'));
    if (manifestExists && stagedManifestExists) {
      throw new DatabaseUpgradeError('backup', '备份清理意图同时发现原 manifest 与暂存 manifest；已拒绝恢复。');
    }
    try {
      if (stagedMarkerExists()) rmSync(stagedMarkerPath!, { force: false });
      if (stagedManifestExists) rmSync(stagedManifestPath!, { force: false });
      if (manifestExists) {
        if (!backupExists) throw new DatabaseUpgradeError('backup', 'manifest 存在但受管 SQLite 缺失；已拒绝恢复。');
        const verified = verifyManagedBackup(this.databasePath, backupPath, identity.instanceId, 'backup');
        if (verified.manifest.sha256 !== intent.sha256 || verified.manifest.to_version !== intent.schema_version) {
          throw new DatabaseUpgradeError('backup', '备份清理意图与 manifest 身份不一致；已拒绝恢复。');
        }
        rmSync(manifestPath, { force: false });
      }
      if (stagedBackupExists) rmSync(stagedBackupPath!, { force: false });
      else if (backupExists) rmSync(backupPath, { force: false });
      this.updatePrivacyBackupCleanupIntent(intent.backup_file, 'completed', undefined, { backupFile: null, manifestFile: null, markerFile: null });
      return { fileName: intent.backup_file, status: 'completed' as const, recovered: true };
    } catch (error) {
      try {
        this.updatePrivacyBackupCleanupIntent(intent.backup_file, 'recovery_required', error);
      } catch (stateError) {
        throw backupCompensationError('备份清理恢复失败且状态未能持久化。', [error, stateError]);
      }
      throw error;
    }
  }

  /** Remove a newly-created managed backup during a failed metadata/audit transaction. */
  discardPrivacyBackup(fileName: string) {
    if (this.databasePath === ':memory:' || basename(fileName) !== fileName) return;
    const backupPath = join(backupDirectory(this.databasePath), fileName);
    const manifestPath = backupManifestPath(backupPath);
    const identity = readDatabaseInstanceIdentity(this.raw, 'backup', true);
    if (!identity?.instanceId) throw new DatabaseUpgradeError('backup', '数据库实例身份缺失；已拒绝清理备份。');
    const intent = this.beginPrivacyBackupCleanup(fileName);
    if (!intent || intent.database_instance_id !== identity.instanceId) throw new DatabaseUpgradeError('backup', '备份清理意图身份无效；已拒绝继续。');
    this.privacyBackupFaults?.beforeDiscard?.(fileName);
    try {
      if (pathExistsControlled(manifestPath, 'backup')) {
        rmSync(manifestPath, { force: false });
        this.updatePrivacyBackupCleanupIntent(fileName, 'manifest_removed');
      }
      if (pathExistsControlled(backupPath, 'backup')) {
        rmSync(backupPath, { force: false });
      }
      this.updatePrivacyBackupCleanupIntent(fileName, 'completed');
    } catch (error) {
      const failures: unknown[] = [error];
      try { this.updatePrivacyBackupCleanupIntent(fileName, 'recovery_required', error); } catch (stateError) { failures.push(stateError); }
      if (failures.length > 1) throw backupCompensationError('备份 discard 失败且清理状态未能持久化。', failures);
      throw error;
    }
  }

  /** Record a content-free, durable marker when publication cleanup cannot finish. */
  markPrivacyBackupCleanupRequired(fileName: string, failure: unknown) {
    if (this.databasePath === ':memory:' || basename(fileName) !== fileName) {
      throw new DatabaseUpgradeError('backup', '备份清理标记路径不受支持；已拒绝继续。');
    }
    const intent = this.privacyBackupCleanupIntent(fileName) ?? this.beginPrivacyBackupCleanup(fileName);
    const backupPath = join(backupDirectory(this.databasePath), fileName);
    const markerPath = backupRecoveryMarkerPath(backupPath);
    writeFileSync(markerPath, `${JSON.stringify({
      version: 1,
      kind: 'privacy-backup-pending-cleanup',
      fileName: intent.backup_file,
      manifestFileName: basename(backupManifestPath(backupPath)),
      sha256: intent.sha256,
      createdAt: new Date().toISOString(),
      failureCode: failure instanceof Error ? failure.name : 'UNKNOWN',
    })}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      this.updatePrivacyBackupCleanupIntent(fileName, 'recovery_required', failure);
    } catch (stateError) {
      throw backupCompensationError('备份待清理 marker 已写入但 durable 状态未能持久化。', [failure, stateError]);
    }
    return basename(markerPath);
  }

  /**
   * Stage all verified managed backups for privacy hard deletion. Files are
   * renamed out of the managed namespace first and can be restored if the
   * enclosing SQLite transaction rolls back. Finalization is called only
   * after the SQLite commit is proven; a cleanup failure becomes durable
   * recovery state instead of being hidden as a successful deletion.
   */
  stagePrivacyBackupPurge() {
    if (this.databasePath === ':memory:') {
      return {
        count: 0,
        finalize() {},
        rollback() {},
      };
    }
    const directory = backupDirectory(this.databasePath);
    // A first-run database may not have produced a backup yet. Missing the
    // directory is an empty, safe set; malformed entries in an existing
    // directory are handled fail-closed below.
    try {
      lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return {
          count: 0,
          finalize() {},
          rollback() {},
        };
      }
      throw new DatabaseUpgradeError('backup', '数据库备份目录状态无法安全确认；已拒绝硬删除。');
    }
    const identity = readDatabaseInstanceIdentity(this.raw, 'backup', true);
    if (!identity?.instanceId) throw new DatabaseUpgradeError('backup', '数据库实例身份缺失；已拒绝清理备份。');
    if (!isPlainBackupDirectory(directory)) {
      throw new DatabaseUpgradeError('backup', '数据库备份目录不符合受控目录要求；已拒绝清理备份。');
    }
    try {
      const resolvedDatabase = resolve(this.databasePath);
      const realDatabaseParent = realpathSync(dirname(resolvedDatabase));
      const realBackupDirectory = realpathSync(directory);
      if (normalizedComparablePath(realBackupDirectory) !== normalizedComparablePath(join(realDatabaseParent, 'backups'))) {
        throw new DatabaseUpgradeError('backup', '数据库备份目录真实路径不在当前数据库旁；已拒绝硬删除。');
      }
    } catch (error) {
      if (error instanceof DatabaseUpgradeError) throw error;
      throw new DatabaseUpgradeError('backup', '数据库备份目录真实路径无法安全确认；已拒绝硬删除。');
    }
    const entries = readdirSync(directory).sort();
    const managedNames = entries.filter((name) => name.endsWith('.sqlite'));
    const cleanupIntents = new Map(
      (this.raw.prepare(
        `SELECT intent_id, operation_token, database_instance_id, backup_file, manifest_file,
                schema_version, sha256, status, recovery_count, last_error, created_at, updated_at
         FROM privacy_backup_cleanup_intent WHERE status <> 'completed'`,
      ).all() as Array<{
        intent_id: string; operation_token: string; database_instance_id: string; backup_file: string;
        manifest_file: string; schema_version: number; sha256: string;
        status: 'pending' | 'staged' | 'manifest_removed' | 'sqlite_removed' | 'completed' | 'recovery_required' | 'failed';
        recovery_count: number; last_error: string | null; created_at: string; updated_at: string;
      }>).map((intent) => [intent.backup_file, intent] as const),
    );
    const managed = managedNames.map((name) => {
      const backupPath = join(directory, name);
      if (!parseManagedBackupName(this.databasePath, backupPath)) {
        throw new DatabaseUpgradeError('backup', '备份目录包含未知 SQLite 文件；已拒绝硬删除。');
      }
      const manifestPath = backupManifestPath(backupPath);
      const intent = cleanupIntents.get(name);
      if (!pathExistsControlled(manifestPath, 'backup')) {
        if (!intent || intent.database_instance_id !== identity.instanceId) {
          throw new DatabaseUpgradeError('backup', '缺少 manifest 的 SQLite 没有匹配持久清理意图；已拒绝硬删除。');
        }
        assertPlainSingleLinkFile(backupPath, 'backup');
        if (sha256File(backupPath) !== intent.sha256) {
          throw new DatabaseUpgradeError('backup', '缺少 manifest 的 SQLite hash 与持久清理意图不一致；已拒绝硬删除。');
        }
        const inspected = inspectDatabaseFile(backupPath, 'backup');
        if (inspected.instanceId !== identity.instanceId) throw new DatabaseUpgradeError('backup', '缺少 manifest 的 SQLite 数据库身份不匹配；已拒绝硬删除。');
      }
      return name;
    });
    const managedSet = new Set(managed);
    for (const name of entries) {
      const entryPath = join(directory, name);
      const stats = lstatSync(entryPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw new DatabaseUpgradeError('backup', '备份目录包含非受管普通文件；已拒绝硬删除。');
      }
      if (name.endsWith('.sqlite')) continue;
      if (name.endsWith('.sqlite.pending-cleanup.json')) {
        const backupName = name.slice(0, -'.pending-cleanup.json'.length);
        if (!managedSet.has(backupName)) {
          throw new DatabaseUpgradeError('backup', '备份清理标记没有对应受管 SQLite 文件；已拒绝硬删除。');
        }
        let marker: unknown;
        try { marker = JSON.parse(readFileSync(entryPath, 'utf8')) as unknown; } catch { throw new DatabaseUpgradeError('backup', '备份清理标记无法读取；已拒绝硬删除。'); }
        if (!marker || typeof marker !== 'object' || (marker as { kind?: unknown }).kind !== 'privacy-backup-pending-cleanup'
          || (marker as { fileName?: unknown }).fileName !== backupName
          || (marker as { manifestFileName?: unknown }).manifestFileName !== `${backupName}.manifest.json`
          || !/^[a-f0-9]{64}$/u.test(String((marker as { sha256?: unknown }).sha256 ?? ''))) {
          throw new DatabaseUpgradeError('backup', '备份清理标记内容不符合受控合同；已拒绝硬删除。');
        }
        const markerIntent = cleanupIntents.get(backupName);
        const markerSha = (marker as { sha256: string }).sha256;
        if (pathExistsControlled(join(directory, `${backupName}.manifest.json`), 'backup')) {
          const verifiedMarker = verifyManagedBackup(this.databasePath, join(directory, backupName), identity.instanceId, 'backup');
          if (markerSha !== verifiedMarker.manifest.sha256) {
            throw new DatabaseUpgradeError('backup', '备份清理标记与受管备份 hash 不一致；已拒绝硬删除。');
          }
        } else if (!markerIntent || markerIntent.database_instance_id !== identity.instanceId || markerIntent.sha256 !== markerSha) {
          throw new DatabaseUpgradeError('backup', '备份清理标记与受管备份 hash 不一致；已拒绝硬删除。');
        }
        continue;
      }
      if (!name.endsWith('.sqlite.manifest.json') || !managedSet.has(name.slice(0, -'.manifest.json'.length))) {
        // This deliberately rejects -wal/-shm, temporary files, orphan
        // manifests and arbitrary sidecars before any business write.
        throw new DatabaseUpgradeError('backup', '备份目录包含未知文件或不成对 sidecar；已拒绝硬删除。');
      }
    }
    for (const name of managed) {
      const manifestName = `${name}.manifest.json`;
      if (!entries.includes(manifestName)) {
        const intent = cleanupIntents.get(name);
        if (!intent || intent.database_instance_id !== identity.instanceId) {
          throw new DatabaseUpgradeError('backup', '受管备份缺少成对 manifest 且无持久清理意图；已拒绝硬删除。');
        }
      }
    }
    for (const name of managed) {
      const intent = cleanupIntents.get(name) ?? this.beginPrivacyBackupCleanup(name);
      if (intent.database_instance_id !== identity.instanceId) throw new DatabaseUpgradeError('backup', '备份清理意图数据库身份不匹配；已拒绝硬删除。');
      cleanupIntents.set(name, intent);
    }
    const staged: Array<{ original: string; temporary: string; originalManifest: string; temporaryManifest: string; hasManifest: boolean; originalMarker?: string; temporaryMarker?: string }> = [];
    try {
      for (const name of managed) {
        const original = join(directory, name);
        const originalManifest = backupManifestPath(original);
        const hasManifest = pathExistsControlled(originalManifest, 'backup');
        const intent = cleanupIntents.get(name)!;
        if (hasManifest) {
          const verified = verifyManagedBackup(this.databasePath, original, identity.instanceId, 'backup');
          if (verified.manifest.sha256 !== intent.sha256) throw new DatabaseUpgradeError('backup', '备份清理意图与 manifest hash 不一致；已拒绝硬删除。');
        } else {
          assertPlainSingleLinkFile(original, 'backup');
          const inspected = inspectDatabaseFile(original, 'backup');
          if (inspected.instanceId !== identity.instanceId || sha256File(original) !== intent.sha256) throw new DatabaseUpgradeError('backup', '缺少 manifest 的 SQLite 无法通过清理意图校验；已拒绝硬删除。');
        }
        const suffix = `.privacy-delete-${randomUUID().replaceAll('-', '')}.tmp`;
        const temporary = `${original}${suffix}`;
        const temporaryManifest = `${originalManifest}${suffix}`;
        const originalMarker = backupRecoveryMarkerPath(original);
        const temporaryMarker = `${originalMarker}${suffix}`;
        this.updatePrivacyBackupCleanupIntent(name, 'staged', undefined, {
          backupFile: basename(temporary),
          manifestFile: hasManifest ? basename(temporaryManifest) : null,
          markerFile: pathExistsControlled(originalMarker, 'backup') ? basename(temporaryMarker) : null,
        });
        this.privacyBackupFaults?.beforeStageRename?.(name);
        renameSync(original, temporary);
        try {
          if (hasManifest) renameSync(originalManifest, temporaryManifest);
          if (pathExistsControlled(originalMarker, 'backup')) renameSync(originalMarker, temporaryMarker);
        } catch (error) {
          if (pathExistsControlled(temporaryMarker, 'backup')) renameSync(temporaryMarker, originalMarker);
          if (pathExistsControlled(temporaryManifest, 'backup')) renameSync(temporaryManifest, originalManifest);
          renameSync(temporary, original);
          throw error;
        }
        staged.push({ original, temporary, originalManifest, temporaryManifest, hasManifest, originalMarker, temporaryMarker });
      }
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      for (const item of [...staged].reverse()) {
        try {
          if (item.temporaryMarker && pathExistsControlled(item.temporaryMarker, 'backup')) {
            if (pathExistsControlled(item.originalMarker!, 'backup')) throw new Error('备份清理标记原路径在补偿期间重新出现。');
            renameSync(item.temporaryMarker, item.originalMarker!);
          }
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
        try {
          if (item.hasManifest && pathExistsControlled(item.temporaryManifest, 'backup')) {
            if (pathExistsControlled(item.originalManifest, 'backup')) throw new Error('受管备份 manifest 原路径在补偿期间重新出现。');
            renameSync(item.temporaryManifest, item.originalManifest);
          }
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
        try {
          if (pathExistsControlled(item.temporary, 'backup')) {
            if (pathExistsControlled(item.original, 'backup')) throw new Error('受管备份原路径在补偿期间重新出现。');
            renameSync(item.temporary, item.original);
          }
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      for (const item of staged) {
        try {
          this.updatePrivacyBackupCleanupIntent(basename(item.original), 'pending', undefined, { backupFile: null, manifestFile: null, markerFile: null });
        } catch (stateError) {
          rollbackFailures.push(stateError);
        }
      }
      if (rollbackFailures.length) throw backupCompensationError('隐私备份暂存失败且补偿未完成；需要恢复受管备份。', [error, ...rollbackFailures]);
      if (error instanceof DatabaseUpgradeError) throw error;
      throw new DatabaseUpgradeError('backup', '隐私备份无法安全暂存；已拒绝硬删除。');
    }
    let finalized = false;
    return {
      count: staged.length,
      finalize: () => {
        if (finalized) return;
        for (const item of staged) {
          if (item.temporaryMarker && pathExistsControlled(item.temporaryMarker, 'backup')) rmSync(item.temporaryMarker, { force: false });
          if (item.hasManifest && pathExistsControlled(item.temporaryManifest, 'backup')) {
            this.privacyBackupFaults?.beforeFinalizeManifestRemove?.(basename(item.original));
            rmSync(item.temporaryManifest, { force: false });
            this.updatePrivacyBackupCleanupIntent(basename(item.original), 'manifest_removed');
          }
          if (pathExistsControlled(item.temporary, 'backup')) {
            this.privacyBackupFaults?.beforeFinalizeSqliteRemove?.(basename(item.original));
            rmSync(item.temporary, { force: false });
          }
          this.updatePrivacyBackupCleanupIntent(basename(item.original), 'completed', undefined, { backupFile: null, manifestFile: null, markerFile: null });
        }
        finalized = true;
      },
      rollback: () => {
        if (finalized) return;
        const failures: unknown[] = [];
        for (const item of [...staged].reverse()) {
          try {
            if (item.temporaryMarker && pathExistsControlled(item.temporaryMarker, 'restore')) {
              if (pathExistsControlled(item.originalMarker!, 'restore')) throw new Error('备份清理标记原路径已被其他文件占用。');
              renameSync(item.temporaryMarker, item.originalMarker!);
            }
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
          try {
            if (item.hasManifest && pathExistsControlled(item.temporaryManifest, 'restore')) {
              if (pathExistsControlled(item.originalManifest, 'restore')) throw new Error('受管备份 manifest 原路径已被其他文件占用。');
              renameSync(item.temporaryManifest, item.originalManifest);
            }
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
          try {
            if (pathExistsControlled(item.temporary, 'restore')) {
              if (pathExistsControlled(item.original, 'restore')) throw new Error('受管备份原路径已被其他文件占用。');
              renameSync(item.temporary, item.original);
            }
          } catch (rollbackError) {
            failures.push(rollbackError);
          }
        }
        for (const item of staged) {
          try {
            this.updatePrivacyBackupCleanupIntent(basename(item.original), 'pending', undefined, { backupFile: null, manifestFile: null, markerFile: null });
          } catch (stateError) {
            failures.push(stateError);
          }
        }
        if (failures.length) throw backupCompensationError('受管备份补偿未完成；需要恢复受管备份。', failures);
      },
    };
  }

  /** Cindy keeps one durable replay watermark per conversation. */
  listCindyConversationCursors() {
    return this.raw.prepare(
      `SELECT scope_key AS conversation_key, cursor AS last_occurred_at
         FROM sync_cursor
        WHERE integration = 'cindy_conversation'
          AND cursor IS NOT NULL
          AND cursor <> ''
        ORDER BY scope_key ASC`,
    ).all() as Array<{ conversation_key: string; last_occurred_at: string }>;
  }

  advanceCindyConversationCursor(conversationKey: string, occurredAt: string, updatedAt: string) {
    const normalizedConversationKey = conversationKey.trim();
    const nextOccurredAt = new Date(occurredAt);
    if (!normalizedConversationKey || !Number.isFinite(nextOccurredAt.getTime())) return;
    const nextCursor = nextOccurredAt.toISOString();
    const current = this.raw.prepare(
      `SELECT cursor
         FROM sync_cursor
        WHERE integration = 'cindy_conversation' AND scope_key = ?`,
    ).get(normalizedConversationKey) as { cursor: string | null } | undefined;
    const currentTime = current?.cursor ? Date.parse(current.cursor) : Number.NaN;
    if (Number.isFinite(currentTime) && currentTime >= nextOccurredAt.getTime()) return;
    this.raw.prepare(
      `INSERT INTO sync_cursor
        (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES ('cindy_conversation', ?, ?, ?, NULL, ?)
       ON CONFLICT (integration, scope_key) DO UPDATE SET
         cursor = excluded.cursor,
         last_success_at = excluded.last_success_at,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    ).run(normalizedConversationKey, nextCursor, updatedAt, updatedAt);
  }

  close() {
    this.raw.close();
  }

  private seed() {
    const row = this.raw.prepare('SELECT COUNT(*) AS count FROM task').get() as { count: number };
    if (row.count > 0) {
      return;
    }

    const now = new Date();
    const shanghaiStartAt = Date.parse(shanghaiDayWindow(now).startAt);
    const isoAt = (days: number, hour: number) => {
      return new Date(shanghaiStartAt + ((days * 24) + hour) * 60 * 60 * 1_000).toISOString();
    };
    const capturedAt = now.toISOString();

    this.transaction(() => {
      const source = this.raw.prepare(
        `INSERT INTO source_event
          (id, external_id, source_type, conversation_id, sender_id, sender_name, content, occurred_at, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      source.run(
        'src_party_value',
        'demo-message-party-value',
        'owner_dm',
        'demo-chat-xuyang',
        'demo-user-xuyang',
        '旭阳',
        '下一阶段想建立派对玩法选型的价值判断，希望先用数据评估不同玩法对参与度、留存和付费的影响。',
        capturedAt,
        capturedAt,
      );
      source.run(
        'src_metric_definition',
        'demo-message-metric-definition',
        'group',
        'demo-demand-group',
        'demo-user-wanwan',
        '婉婷',
        '各团队对活跃用户的口径不一致，能不能统一数据定义并说明差异？',
        capturedAt,
        capturedAt,
      );

      const candidate = this.raw.prepare(
        `INSERT INTO candidate_request
          (id, source_event_id, title, proposer_name, background, validation_question, describe, confidence, state, snoozed_until, accepted_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      candidate.run(
        'cand_party_value',
        'src_party_value',
        '派对玩法选型价值判断',
        '旭阳',
        '后续派对玩法将围绕团队认为有价值的方向先做单人 Demo，再决定资源投入。',
        '不同玩法对参与、留存与付费分别有怎样的影响，哪些指标可以支持选型？',
        '需要评估不同派对玩法对参与度、留存和付费的影响，为下一阶段玩法投入提供数据依据。',
        0.91,
        'pending',
        null,
        null,
        capturedAt,
        capturedAt,
      );
      candidate.run(
        'cand_metric_definition',
        'src_metric_definition',
        '活跃用户口径统一',
        '婉婷',
        '多个团队正在使用不同口径讨论同一批用户。',
        '需要确认适用业务范围和最终口径负责人。',
        '需要统一各团队对活跃用户的定义，并说明新旧口径差异。',
        0.82,
        'snoozed',
        isoAt(2, 9),
        null,
        capturedAt,
        capturedAt,
      );

      const task = this.raw.prepare(
        `INSERT INTO task
          (id, title, proposer_name, describe, status, schedule_at, next_step, risk, waiting_reason, version, completed_at, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      task.run(
        'task_retention_review',
        '活动引流渠道效果复盘',
        '林一',
        '复盘各渠道新增、转化和留存表现，帮助下一轮活动调整投放重点。',
        'in_progress',
        isoAt(0, 16),
        '完成渠道口径核对并整理首版结果。',
        'medium',
        null,
        2,
        null,
        null,
        capturedAt,
        capturedAt,
      );
      task.run(
        'task_payment_anomaly',
        '付费转化漏斗异常排查',
        '林一',
        '本周付费转化率下降，需要定位发生变化的环节和人群。',
        'in_progress',
        isoAt(0, 18),
        '拆解新老用户与支付渠道的转化变化。',
        'high',
        null,
        3,
        null,
        null,
        capturedAt,
        capturedAt,
      );
      task.run(
        'task_cost_detail',
        '活动成本数据补充',
        '市场-雪晴',
        '补齐各渠道成本明细后，才能完成活动投入产出评估。',
        'waiting',
        isoAt(1, 12),
        '收到市场成本表后更新结论。',
        'medium',
        '等待市场提供成本表',
        1,
        null,
        null,
        capturedAt,
        capturedAt,
      );
      task.run(
        'task_dashboard_review',
        '数据看板需求评审',
        '产品团队',
        '评审新版用户看板的指标、筛选方式和使用边界。',
        'review',
        isoAt(1, 15),
        '与产品确认必须保留的核心指标。',
        'low',
        null,
        1,
        null,
        null,
        capturedAt,
        capturedAt,
      );
      task.run(
        'task_archive_demo',
        '上月版本复盘',
        '运营团队',
        '整理版本核心指标、关键变化和后续建议。',
        'archived',
        isoAt(-8, 17),
        '已完成并归档。',
        'low',
        null,
        4,
        isoAt(-7, 17),
        isoAt(-5, 10),
        capturedAt,
        capturedAt,
      );

      const event = this.raw.prepare(
        `INSERT INTO task_event
          (id, task_id, event_type, actor_type, visibility, summary, source_event_id, before_json, after_json, occurred_at, recorded_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      event.run(
        'evt_retention_created',
        'task_retention_review',
        'task_created',
        'user',
        'private',
        '人工确认后建立正式任务。',
        null,
        null,
        '{}',
        capturedAt,
        capturedAt,
        1,
      );
      event.run(
        'evt_retention_scope',
        'task_retention_review',
        'scope_updated',
        'user',
        'private',
        '范围收敛为新增、转化和留存三段。',
        null,
        '{}',
        '{}',
        capturedAt,
        capturedAt,
        2,
      );

      this.raw
        .prepare(
          `INSERT INTO reference_binding
            (id, task_id, label, reference_path, access_mode, created_at)
           VALUES (?, ?, ?, ?, 'reference_only', ?)`,
        )
        .run(
          'ref_retention_workspace',
          'task_retention_review',
          '实际分析目录',
          'workspace://analysis/activity-channel-review',
          capturedAt,
        );
    });
  }
}
