import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { safeStorage } from 'electron';
import { z } from 'zod';
import type { DesktopConfigInput, PublicDesktopConfig } from './contracts.js';

const publicSchema = z.object({
  setupComplete: z.boolean().default(false),
  launchAtLogin: z.boolean().default(false),
  logRetentionDays: z.number().int().min(1).max(365).default(30),
  feishu: z.object({
    appId: z.string().max(256).default(''),
    externalEnabled: z.boolean().default(false),
    domain: z.enum(['feishu', 'lark']).default('feishu'),
    eventMode: z.enum(['websocket', 'webhook']).default('websocket'),
    oauthRedirectUri: z.string().max(2048).default('http://127.0.0.1:4311/oauth/feishu/callback'),
    oauthScopes: z.string().max(4096).default(''),
    scanEnabled: z.boolean().default(false),
    scanIntervalSeconds: z.number().int().min(30).max(86400).default(60),
    groupIds: z.array(z.string().max(256)).max(200).default([]),
  }),
  llm: z.object({
    provider: z.string().max(100).default('rule_mock'),
    model: z.string().max(256).default(''),
    apiBase: z.string().max(2048).default(''),
    timeoutMs: z.number().int().min(1000).max(300000).default(30000),
    maxRetries: z.number().int().min(0).max(5).default(2),
  }),
  workspace: z.object({ readEnabled: z.boolean().default(false), allowedPaths: z.array(z.string().max(2000)).max(20).default([]) }),
});

type SecretMap = Record<string, string>;

type ConfigJournal = {
  generation: number;
  previousGeneration: number;
  settingsExisted: boolean;
  secretsExisted: boolean;
  refreshLease?: {
    identityKey: string;
    leaseId: string;
    fencingToken: number;
  };
};

type TokenVaultSnapshot = {
  generation: number;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  grantedScopes: string | null;
};

type RefreshLeaseResult = {
  status: 'completed' | 'failed';
  generation: number;
  expiresAt?: string | null;
  phase?: 'retryable_failed' | 'recovery_required';
};

type RefreshLeasePhase = 'claimed' | 'provider_started' | 'response_pending' | 'retryable_failed' | 'recovery_required' | 'completed';

type RefreshLeaseRecord = {
  status: 'active' | 'completed' | 'failed';
  phase: RefreshLeasePhase;
  identityKey: string;
  leaseId: string;
  ownerId: string;
  ownerPid: number;
  fencingToken: number;
  generation: number;
  tokenFingerprint: string | null;
  lockedUntil: number;
  updatedAt: number;
  resultExpiresAt: string | null;
};

type LockIdentity = {
  ownerId: string;
  pid: number;
  acquiredAt: number;
};

type OperationGateHandle = {
  identity: LockIdentity;
  stopHeartbeat: () => void;
  release: (moved?: boolean) => Promise<void>;
};

type RenameIdentityGuard = () => Promise<boolean>;

export type DesktopConfigStoreCrashPoint =
  | 'lock-candidate-ready'
  | 'operation-candidate-ready'
  | 'release-gate-acquired';

export type DesktopConfigStoreOptions = {
  /** Test-only deterministic crash injection; production leaves this unset. */
  crashAt?: DesktopConfigStoreCrashPoint;
};

class InjectedConfigStoreCrash extends Error {
  constructor(readonly point: DesktopConfigStoreCrashPoint) {
    super(`injected config-store crash at ${point}`);
    this.name = 'InjectedConfigStoreCrash';
  }
}

const configJournalSchema = z.object({
  generation: z.number().int().nonnegative(),
  previousGeneration: z.number().int().nonnegative(),
  settingsExisted: z.boolean(),
  secretsExisted: z.boolean(),
  refreshLease: z.object({
    identityKey: z.string().min(1).max(256),
    leaseId: z.string().uuid(),
    fencingToken: z.number().int().positive(),
  }).optional(),
}).strict();

const refreshLeaseSchema = z.object({
  status: z.enum(['active', 'completed', 'failed']),
  phase: z.enum(['claimed', 'provider_started', 'response_pending', 'retryable_failed', 'recovery_required', 'completed']),
  identityKey: z.string().min(1).max(256),
  leaseId: z.string().uuid(),
  ownerId: z.string().uuid(),
  ownerPid: z.number().int().positive(),
  fencingToken: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  tokenFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  lockedUntil: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  resultExpiresAt: z.string().datetime({ offset: true }).nullable(),
}).strict().superRefine((record, context) => {
  const valid = record.status === 'active'
    ? ['claimed', 'provider_started', 'response_pending'].includes(record.phase)
    : record.status === 'completed'
      ? record.phase === 'completed'
      : ['retryable_failed', 'recovery_required'].includes(record.phase);
  if (!valid) context.addIssue({ code: 'custom', path: ['phase'], message: 'invalid refresh lease status/phase' });
  if (record.phase === 'recovery_required' && record.tokenFingerprint === null) {
    context.addIssue({ code: 'custom', path: ['tokenFingerprint'], message: 'recovery lease must retain the failed credential fingerprint' });
  }
});

const defaults = publicSchema.parse({
  feishu: {},
  llm: {},
  workspace: {},
});

export class DesktopConfigStore {
  private readonly publicPath: string;
  private readonly secretPath: string;
  private readonly generationPath: string;
  private readonly journalPath: string;
  private readonly settingsLkgPath: string;
  private readonly secretsLkgPath: string;
  private readonly lockPath: string;
  private writeTail: Promise<void> = Promise.resolve();
  private crashAt?: DesktopConfigStoreCrashPoint;
  private static readonly lockStaleMs = 30_000;
  private static readonly refreshLeaseMs = 30_000;
  private static readonly refreshResultMs = 60_000;

  constructor(private readonly root: string, options: DesktopConfigStoreOptions = {}) {
    this.crashAt = options.crashAt;
    this.publicPath = resolve(root, 'settings.json');
    this.secretPath = resolve(root, 'secrets.bin');
    this.generationPath = resolve(root, 'config-generation.json');
    this.journalPath = resolve(root, 'config-transaction.json');
    this.settingsLkgPath = resolve(root, 'settings.json.lkg');
    this.secretsLkgPath = resolve(root, 'secrets.bin.lkg');
    this.lockPath = resolve(root, 'config.lock');
  }

  async readPublic(): Promise<PublicDesktopConfig> {
    return this.lock(async () => {
      await this.recoverInterrupted();
      const publicValues = await this.readPublicValues();
      const secrets = await this.readSecretsUnsafe();
      return {
        ...publicValues,
        secretState: {
          feishuAppSecret: Boolean(secrets.FEISHU_APP_SECRET),
          feishuUserAccessToken: Boolean(secrets.FEISHU_USER_ACCESS_TOKEN),
          feishuRefreshToken: Boolean(secrets.FEISHU_REFRESH_TOKEN),
          llmApiKey: Boolean(secrets.LLM_API_KEY),
          feishuUserToken: Boolean(secrets.FEISHU_USER_TOKEN),
        },
      };
    });
  }

  async save(input: DesktopConfigInput): Promise<PublicDesktopConfig> {
    const parsed = publicSchema.parse(input);
    return this.lock(async () => {
      await this.recoverInterrupted();
      await this.readPublicValues();
      const currentSecrets = await this.readSecretsUnsafe();
      const nextSecrets: SecretMap = { ...currentSecrets };
      if (input.secrets?.clearFeishuAppSecret) delete nextSecrets.FEISHU_APP_SECRET;
      if (input.secrets?.clearLlmApiKey) delete nextSecrets.LLM_API_KEY;
      if (input.secrets?.feishuAppSecret) nextSecrets.FEISHU_APP_SECRET = input.secrets.feishuAppSecret;
      if (input.secrets?.llmApiKey) nextSecrets.LLM_API_KEY = input.secrets.llmApiKey;

      await this.commit(JSON.stringify(parsed, null, 2), nextSecrets);
      return this.readPublicUnsafe();
    });
  }

  async getRuntimeEnvironment(databasePath: string): Promise<NodeJS.ProcessEnv> {
    return this.lock(async () => {
      await this.recoverInterrupted();
      const values = await this.readPublicValues();
      const secrets = await this.readSecretsUnsafe();
      return {
      NODE_ENV: 'production',
      DATABASE_PROVIDER: 'sqlite',
      DATABASE_URL: `file:${databasePath}`,
      LOG_RETENTION_DAYS: String(values.logRetentionDays),
      FEISHU_APP_ID: values.feishu.appId,
      FEISHU_APP_SECRET: secrets.FEISHU_APP_SECRET ?? '',
      FEISHU_EXTERNAL_ENABLED: String(values.feishu.externalEnabled),
      FEISHU_DOMAIN: values.feishu.domain,
      FEISHU_EVENT_MODE: values.feishu.eventMode,
      FEISHU_OAUTH_REDIRECT_URI: values.feishu.oauthRedirectUri,
      FEISHU_OAUTH_SCOPES: values.feishu.oauthScopes,
      FEISHU_SCAN_ENABLED: String(values.feishu.scanEnabled),
      FEISHU_SCAN_INTERVAL_SECONDS: String(values.feishu.scanIntervalSeconds),
      FEISHU_GROUP_IDS: values.feishu.groupIds.join(','),
      LLM_PROVIDER: values.llm.provider,
      LLM_MODEL: values.llm.model,
      LLM_API_BASE: values.llm.apiBase,
      LLM_API_KEY: secrets.LLM_API_KEY ?? '',
      LLM_TIMEOUT_MS: String(values.llm.timeoutMs),
      LLM_MAX_RETRIES: String(values.llm.maxRetries),
      WORKSPACE_MODE: values.workspace.readEnabled ? 'readonly_bridge' : 'reference_only',
      WORKSPACE_READ_ENABLED: String(values.workspace.readEnabled),
      WORKSPACE_WRITE_ENABLED: 'false',
      WORKSPACE_ALLOWED_PATHS: JSON.stringify(values.workspace.allowedPaths),
      TASK_MEMORY_ROOT: resolve(dirname(databasePath), 'task-memory'),
      };
    });
  }

  async getSecret(key: string): Promise<string | null> {
    return this.lock(async () => {
      await this.recoverInterrupted();
      await this.readPublicValues();
      return (await this.readSecretsUnsafe())[key] ?? null;
    });
  }

  /** TokenVault compatibility aliases keep the durable store directly usable by adapters. */
  async get(key: string): Promise<string | null> {
    return this.getSecret(key);
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.lock(async () => {
      await this.recoverInterrupted();
      await this.readPublicValues();
      const secrets = await this.readSecretsUnsafe();
      if (value) secrets[key] = value;
      else delete secrets[key];
      await this.commitSecrets(secrets);
    });
  }

  async set(key: string, value: string): Promise<void> {
    return this.setSecret(key, value);
  }

  async setMany(values: Record<string, string>): Promise<void> {
    await this.lock(async () => {
      await this.recoverInterrupted();
      await this.readPublicValues();
      const secrets = await this.readSecretsUnsafe();
      for (const [key, value] of Object.entries(values)) secrets[key] = value;
      await this.commitSecrets(secrets);
    });
  }

  /** Snapshot used by the Feishu token generation/CAS contract. */
  async readSnapshot(): Promise<TokenVaultSnapshot> {
    return this.lock(async () => {
      await this.recoverInterrupted();
      await this.readPublicValues();
      return this.readTokenSnapshotUnsafe();
    });
  }

  /**
   * Acquire a durable per-identity refresh lease. The lease record lives
   * beside the encrypted vault and is created while the same cross-process
   * lock protects the complete token snapshot, so no caller can pair an old
   * generation with a newer rotating refresh token.
   */
  async acquireRefreshLease(identityKey: string, waitForResult = false, reuseCurrentResult = false) {
    return this.lock(async () => {
      await this.recoverInterrupted();
      await this.readPublicValues();
      const snapshot = await this.readTokenSnapshotUnsafe();
      const leasePath = this.refreshLeasePath(identityKey);
      const now = Date.now();
      if (existsSync(leasePath)) {
        const record = await this.readRefreshLease(leasePath);
        if (record.identityKey !== identityKey) throw new Error('飞书 refresh lease 身份不匹配，已拒绝刷新授权。');
        const currentFingerprint = this.refreshTokenFingerprint(snapshot.refreshToken);
        const recoveryCredentialReplaced = this.isRecoveryCredentialReplaced(record, identityKey, snapshot);
        if (record.status === 'active') {
          if (record.lockedUntil > now) return { status: 'busy' as const, generation: snapshot.generation, snapshot, phase: record.phase };
          // Once the provider call has started, an expired lease is not safe
          // to replay: the provider may already have consumed the rotating
          // refresh token. Only a pre-provider claim can be taken over.
          if (record.phase === 'provider_started' || record.phase === 'response_pending') {
            const recovery = { ...record, status: 'failed' as const, phase: 'recovery_required' as const, lockedUntil: now + DesktopConfigStore.refreshResultMs, updatedAt: now };
            await this.atomicWrite(leasePath, JSON.stringify(recovery));
            return { status: 'failed' as const, generation: snapshot.generation, snapshot, phase: recovery.phase, resultExpiresAt: null };
          }
          // A timed-out claim may still belong to a stalled live process. Do
          // not risk a second rotating-token exchange in that case. A dead
          // owner can be fenced out by replacing the record below.
          if (this.isProcessAlive(record.ownerPid)) return { status: 'busy' as const, generation: snapshot.generation, snapshot, phase: record.phase };
        }
        const resultMatchesSnapshot = record.generation === snapshot.generation && record.tokenFingerprint === currentFingerprint;
        if (record.status === 'completed' && reuseCurrentResult && resultMatchesSnapshot && now - record.updatedAt <= DesktopConfigStore.refreshResultMs) {
          return {
            status: record.status,
            generation: snapshot.generation,
            snapshot,
            phase: record.phase,
            ownerId: record.ownerId,
            fencingToken: record.fencingToken,
            tokenFingerprint: record.tokenFingerprint,
            resultExpiresAt: record.resultExpiresAt,
          } as const;
        }
        if (record.status !== 'active' && waitForResult && now - record.updatedAt <= DesktopConfigStore.refreshResultMs) {
          if (record.status === 'completed' && !resultMatchesSnapshot) {
            // A later config write superseded the published result. Do not
            // let a waiter reuse an old expiry/token generation.
          } else if (recoveryCredentialReplaced) {
            // A new generation with a different refresh-token fingerprint is
            // a fresh authorization. Replace the old recovery marker under
            // this lock instead of returning its permanent failure state.
          } else {
            return {
              status: record.status,
              generation: snapshot.generation,
              snapshot,
              phase: record.phase,
              ownerId: record.ownerId,
              fencingToken: record.fencingToken,
              tokenFingerprint: record.tokenFingerprint,
              resultExpiresAt: record.resultExpiresAt,
            } as const;
          }
        }
        if (record.status === 'failed' && record.phase === 'recovery_required' && !recoveryCredentialReplaced) {
          return {
            status: 'failed' as const,
            generation: snapshot.generation,
            snapshot,
            phase: record.phase,
            ownerId: record.ownerId,
            fencingToken: record.fencingToken,
            tokenFingerprint: record.tokenFingerprint,
            resultExpiresAt: null,
          } as const;
        }
      }
      const previous = existsSync(leasePath) ? await this.readRefreshLease(leasePath) : null;
      const leaseId = randomUUID();
      const ownerId = randomUUID();
      const record: RefreshLeaseRecord = {
        status: 'active',
        phase: 'claimed',
        identityKey,
        leaseId,
        ownerId,
        ownerPid: process.pid,
        fencingToken: (previous?.fencingToken ?? 0) + 1,
        generation: snapshot.generation,
        tokenFingerprint: this.refreshTokenFingerprint(snapshot.refreshToken),
        lockedUntil: now + DesktopConfigStore.refreshLeaseMs,
        updatedAt: now,
        resultExpiresAt: null,
      };
      await this.atomicWrite(leasePath, JSON.stringify(record));
      return {
        status: 'acquired' as const,
        generation: snapshot.generation,
        snapshot,
        phase: record.phase,
        leaseId,
        ownerId,
        fencingToken: record.fencingToken,
        tokenFingerprint: record.tokenFingerprint,
      };
    });
  }

  async renewRefreshLease(identityKey: string, leaseId: string, fencingToken?: number, phase: 'claimed' | 'provider_started' | 'response_pending' = 'claimed'): Promise<boolean> {
    return this.lock(async () => {
      await this.recoverInterrupted();
      await this.readPublicValues();
      const leasePath = this.refreshLeasePath(identityKey);
      if (!existsSync(leasePath)) return false;
      const record = await this.readRefreshLease(leasePath);
      if (record.identityKey !== identityKey) throw new Error('飞书 refresh lease 身份不匹配，已拒绝续租。');
      const now = Date.now();
      if (record.status !== 'active' || record.leaseId !== leaseId || (fencingToken !== undefined && record.fencingToken !== fencingToken) || record.lockedUntil <= now) return false;
      await this.atomicWrite(leasePath, JSON.stringify({ ...record, phase, lockedUntil: now + DesktopConfigStore.refreshLeaseMs, updatedAt: now }));
      return true;
    });
  }

  async releaseRefreshLease(identityKey: string, leaseId: string, result: RefreshLeaseResult, fencingToken?: number): Promise<void> {
    await this.lock(async () => {
      await this.recoverInterrupted();
      await this.readPublicValues();
      const leasePath = this.refreshLeasePath(identityKey);
      if (!existsSync(leasePath)) throw new Error('飞书 refresh lease 已丢失，已拒绝释放。');
      const record = await this.readRefreshLease(leasePath);
      if (record.identityKey !== identityKey) throw new Error('飞书 refresh lease 身份不匹配，已拒绝释放。');
      if (record.status !== 'active' || record.leaseId !== leaseId || (fencingToken !== undefined && record.fencingToken !== fencingToken)) throw new Error('飞书 refresh lease 所有权已变化，已拒绝释放。');
      const now = Date.now();
      const currentSnapshot = await this.readTokenSnapshotUnsafe();
      const next: RefreshLeaseRecord = {
        ...record,
        status: result.status,
        phase: result.status === 'completed' ? 'completed' : (result.phase ?? 'retryable_failed'),
        generation: result.generation,
        tokenFingerprint: result.status === 'completed' ? this.refreshTokenFingerprint(currentSnapshot.refreshToken) : record.tokenFingerprint,
        lockedUntil: now + DesktopConfigStore.refreshResultMs,
        updatedAt: now,
        resultExpiresAt: result.expiresAt ?? null,
      };
      await this.atomicWrite(leasePath, JSON.stringify(next));
    });
  }

  /** Apply token values only when no newer settings/vault generation exists. */
  async setManyAtomic(
    values: Record<string, string | null>,
    expectedGeneration: number,
    refreshFence?: { identityKey: string; leaseId: string; fencingToken: number; tokenFingerprint: string | null; resultExpiresAt?: string | null },
  ): Promise<{ accepted: boolean; generation: number }> {
    return this.lock(async () => {
      await this.recoverInterrupted();
      await this.readPublicValues();
      const currentGeneration = await this.readGeneration();
      if (currentGeneration !== expectedGeneration) return { accepted: false, generation: currentGeneration };
      if (refreshFence) {
        const leasePath = this.refreshLeasePath(refreshFence.identityKey);
        if (!existsSync(leasePath)) return { accepted: false, generation: currentGeneration };
        const lease = await this.readRefreshLease(leasePath);
        if (lease.identityKey !== refreshFence.identityKey) return { accepted: false, generation: currentGeneration };
        const currentSnapshot = await this.readTokenSnapshotUnsafe();
        if (
          lease.status !== 'active' ||
          lease.leaseId !== refreshFence.leaseId ||
          lease.fencingToken !== refreshFence.fencingToken ||
          lease.generation !== expectedGeneration ||
          lease.tokenFingerprint !== refreshFence.tokenFingerprint ||
          this.refreshTokenFingerprint(currentSnapshot.refreshToken) !== refreshFence.tokenFingerprint ||
          (refreshFence.resultExpiresAt !== undefined && lease.phase !== 'response_pending')
        ) return { accepted: false, generation: currentGeneration };
      }
      const secrets = await this.readSecretsUnsafe();
      for (const [key, value] of Object.entries(values)) {
        if (value === null) delete secrets[key];
        else secrets[key] = value;
      }
      const completion = refreshFence?.resultExpiresAt !== undefined ? async (generation: number) => {
        const leasePath = this.refreshLeasePath(refreshFence.identityKey);
        if (!existsSync(leasePath)) throw new Error('飞书 refresh lease 已丢失，已拒绝提交完成状态。');
        const lease = await this.readRefreshLease(leasePath);
        if (lease.identityKey !== refreshFence.identityKey || lease.status !== 'active' || lease.leaseId !== refreshFence.leaseId || lease.fencingToken !== refreshFence.fencingToken || lease.phase !== 'response_pending') {
          throw new Error('飞书 refresh lease 所有权已变化，已拒绝提交完成状态。');
        }
        await this.atomicWrite(leasePath, JSON.stringify({
          ...lease,
          status: 'completed',
          phase: 'completed',
          generation,
          tokenFingerprint: this.refreshTokenFingerprint(secrets.FEISHU_REFRESH_TOKEN ?? null),
          lockedUntil: Date.now() + DesktopConfigStore.refreshResultMs,
          updatedAt: Date.now(),
          resultExpiresAt: refreshFence.resultExpiresAt ?? null,
        } satisfies RefreshLeaseRecord));
      } : undefined;
      await this.commit(null, secrets, completion, refreshFence?.resultExpiresAt !== undefined ? {
        identityKey: refreshFence.identityKey,
        leaseId: refreshFence.leaseId,
        fencingToken: refreshFence.fencingToken,
      } : undefined);
      return { accepted: true, generation: await this.readGeneration() };
    });
  }

  private async readPublicValues() {
    await this.readGeneration();
    if (!existsSync(this.publicPath)) {
      if (existsSync(this.secretPath) || existsSync(this.generationPath)) throw new Error('配置 settings.json 缺失，已拒绝与旧 secrets 混合读取。');
      return defaults;
    }
    try {
      const parsed = publicSchema.safeParse(JSON.parse(await readFile(this.publicPath, 'utf8')));
      if (!parsed.success) throw new Error('invalid');
      return parsed.data;
    } catch {
      throw new Error('配置 settings.json 损坏，已拒绝读取。');
    }
  }

  private async readPublicUnsafe(): Promise<PublicDesktopConfig> {
    const publicValues = await this.readPublicValues();
    const secrets = await this.readSecretsUnsafe();
    return {
      ...publicValues,
      secretState: {
        feishuAppSecret: Boolean(secrets.FEISHU_APP_SECRET),
        feishuUserAccessToken: Boolean(secrets.FEISHU_USER_ACCESS_TOKEN),
        feishuRefreshToken: Boolean(secrets.FEISHU_REFRESH_TOKEN),
        llmApiKey: Boolean(secrets.LLM_API_KEY),
        feishuUserToken: Boolean(secrets.FEISHU_USER_TOKEN),
      },
    };
  }

  private async readSecretsUnsafe(): Promise<SecretMap> {
    if (!existsSync(this.secretPath)) return {};
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全凭证存储当前不可用，系统不会读取或保存明文密钥。');
    }
    try {
      const encrypted = await readFile(this.secretPath);
      const parsed = JSON.parse(safeStorage.decryptString(encrypted));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      return parsed as SecretMap;
    } catch {
      throw new Error('配置 secrets.bin 损坏，已拒绝读取。');
    }
  }

  private async commitSecrets(secrets: SecretMap) {
    await this.commit(null, secrets);
  }

  private async readTokenSnapshotUnsafe(): Promise<TokenVaultSnapshot> {
    const secrets = await this.readSecretsUnsafe();
    return {
      generation: await this.readGeneration(),
      accessToken: secrets.FEISHU_USER_ACCESS_TOKEN ?? null,
      refreshToken: secrets.FEISHU_REFRESH_TOKEN ?? null,
      expiresAt: secrets.FEISHU_TOKEN_EXPIRES_AT ?? null,
      grantedScopes: secrets.FEISHU_GRANTED_SCOPES ?? null,
    };
  }

  private refreshLeasePath(identityKey: string) {
    const digest = createHash('sha256').update(identityKey, 'utf8').digest('hex');
    return resolve(this.root, `feishu-refresh-lease-${digest}.json`);
  }

  private refreshTokenFingerprint(refreshToken: string | null) {
    return refreshToken === null ? null : createHash('sha256').update(refreshToken, 'utf8').digest('hex');
  }

  /**
   * A recovery marker can only be crossed by a provably new credential for
   * the exact identity that failed.  Access/scope/expiry changes, an empty
   * token, a reused fingerprint, or a generation that did not advance must
   * remain blocked so an uncertain rotating-token exchange is never replayed.
   */
  private hasUsableRefreshToken(refreshToken: string | null): refreshToken is string {
    return typeof refreshToken === 'string' && refreshToken.trim().length > 0;
  }

  private isRecoveryCredentialReplaced(
    record: RefreshLeaseRecord,
    identityKey: string,
    snapshot: TokenVaultSnapshot,
  ) {
    if (
      record.status !== 'failed'
      || record.phase !== 'recovery_required'
      || record.identityKey !== identityKey
      || record.tokenFingerprint === null
      || snapshot.generation <= record.generation
      || !this.hasUsableRefreshToken(snapshot.refreshToken)
    ) return false;
    const currentFingerprint = this.refreshTokenFingerprint(snapshot.refreshToken);
    return currentFingerprint !== null && currentFingerprint !== record.tokenFingerprint;
  }

  private isProcessAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private async readRefreshLease(path: string): Promise<RefreshLeaseRecord> {
    try {
      const parsed = refreshLeaseSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (!parsed.success) throw new Error('invalid');
      return parsed.data;
    } catch {
      throw new Error('飞书 refresh lease 损坏，已拒绝刷新授权。');
    }
  }

  /** Commit settings and secrets with journaled LKG recovery. */
  private async commit(
    settingsContent: string | null,
    secrets: SecretMap,
    afterGenerationWritten?: (generation: number) => Promise<void>,
    refreshLease?: ConfigJournal['refreshLease'],
  ) {
    await mkdir(this.root, { recursive: true });
    const previousGeneration = await this.readGeneration();
    const nextGeneration = previousGeneration + 1;
    const settingsExisted = existsSync(this.publicPath);
    const secretsExisted = existsSync(this.secretPath);
    await this.removeIfPresent(this.journalPath);
    await this.removeIfPresent(this.settingsLkgPath);
    await this.removeIfPresent(this.secretsLkgPath);
    if (settingsExisted) await copyFile(this.publicPath, this.settingsLkgPath);
    if (secretsExisted) await copyFile(this.secretPath, this.secretsLkgPath);
    const journal: ConfigJournal = { generation: nextGeneration, previousGeneration, settingsExisted, secretsExisted, ...(refreshLease ? { refreshLease } : {}) };
    await this.atomicWrite(this.journalPath, JSON.stringify(journal));

    if (settingsContent !== null) await this.atomicWrite(this.publicPath, settingsContent);
    if (!Object.keys(secrets).length) {
      await this.removeIfPresent(this.secretPath);
    } else {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Windows 安全凭证存储当前不可用，系统不会保存或保存明文密钥。');
      }
      const encrypted = safeStorage.encryptString(JSON.stringify(secrets));
      await this.atomicWriteBytes(this.secretPath, encrypted);
    }
    await this.atomicWrite(this.generationPath, JSON.stringify({ generation: nextGeneration }));
    if (afterGenerationWritten) await afterGenerationWritten(nextGeneration);
    await this.removeIfPresent(this.journalPath);
    await this.removeIfPresent(this.settingsLkgPath);
    await this.removeIfPresent(this.secretsLkgPath);
  }

  private async recoverInterrupted() {
    if (!existsSync(this.journalPath)) {
      await this.removeIfPresent(this.settingsLkgPath);
      await this.removeIfPresent(this.secretsLkgPath);
      await this.removeIfPresent(this.publicPath + '.tmp');
      await this.removeIfPresent(this.secretPath + '.tmp');
      return;
    }
    let journal: ConfigJournal;
    try {
      const parsed = configJournalSchema.safeParse(JSON.parse(await readFile(this.journalPath, 'utf8')));
      if (!parsed.success || parsed.data.generation <= parsed.data.previousGeneration) throw new Error('invalid');
      journal = parsed.data;
    } catch {
      throw new Error('配置事务日志损坏，已拒绝读取或更新。');
    }
    if (journal.settingsExisted && !existsSync(this.settingsLkgPath)) throw new Error('配置 settings LKG 缺失，已拒绝恢复。');
    if (journal.secretsExisted && !existsSync(this.secretsLkgPath)) throw new Error('配置 secrets LKG 缺失，已拒绝恢复。');
    if (journal.refreshLease) await this.markRefreshRecovery(journal.refreshLease);
    if (journal.settingsExisted && existsSync(this.settingsLkgPath)) await copyFile(this.settingsLkgPath, this.publicPath);
    else if (!journal.settingsExisted) await this.removeIfPresent(this.publicPath);
    if (journal.secretsExisted && existsSync(this.secretsLkgPath)) await copyFile(this.secretsLkgPath, this.secretPath);
    else if (!journal.secretsExisted) await this.removeIfPresent(this.secretPath);
    if (journal.previousGeneration > 0) await this.atomicWrite(this.generationPath, JSON.stringify({ generation: journal.previousGeneration }));
    else await this.removeIfPresent(this.generationPath);
    await this.removeIfPresent(this.journalPath);
    await this.removeIfPresent(this.settingsLkgPath);
    await this.removeIfPresent(this.secretsLkgPath);
    await this.removeIfPresent(this.publicPath + '.tmp');
    await this.removeIfPresent(this.secretPath + '.tmp');
  }

  private async markRefreshRecovery(refreshLease: NonNullable<ConfigJournal['refreshLease']>) {
    const leasePath = this.refreshLeasePath(refreshLease.identityKey);
    if (!existsSync(leasePath)) throw new Error('配置事务日志引用的 refresh lease 缺失，已拒绝恢复或刷新授权。');
    const record = await this.readRefreshLease(leasePath);
    if (record.identityKey !== refreshLease.identityKey || record.leaseId !== refreshLease.leaseId || record.fencingToken !== refreshLease.fencingToken) return;
    await this.atomicWrite(leasePath, JSON.stringify({
      ...record,
      status: 'failed',
      phase: 'recovery_required',
      lockedUntil: Date.now() + DesktopConfigStore.refreshResultMs,
      updatedAt: Date.now(),
      resultExpiresAt: null,
    } satisfies RefreshLeaseRecord));
  }

  private async readGeneration() {
    if (!existsSync(this.generationPath)) {
      if (existsSync(this.publicPath) || existsSync(this.secretPath)) throw new Error('配置 generation 缺失，已拒绝读取或更新。');
      return 0;
    }
    try {
      const parsed = JSON.parse(await readFile(this.generationPath, 'utf8')) as { generation?: unknown };
      if (typeof parsed.generation !== 'number' || !Number.isSafeInteger(parsed.generation) || parsed.generation < 0) throw new Error('invalid');
      return parsed.generation;
    } catch {
      throw new Error('配置 generation 损坏，已拒绝读取或更新。');
    }
  }

  private async removeIfPresent(path: string) {
    if (existsSync(path)) await unlink(path);
  }

  private async atomicWrite(path: string, content: string) {
    await mkdir(dirname(path), { recursive: true });
    const temp = path + '.tmp';
    await this.writeDurable(temp, content);
    await rename(temp, path);
    await this.syncDirectory(dirname(path));
  }

  private async atomicWriteBytes(path: string, content: Buffer) {
    await mkdir(dirname(path), { recursive: true });
    const temp = path + '.tmp';
    await this.writeDurable(temp, content);
    await rename(temp, path);
    await this.syncDirectory(dirname(path));
  }

  private async writeDurable(path: string, content: string | Buffer) {
    const handle = await open(path, 'w');
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Directory fsync is not available on every supported Windows runtime. */
  private async syncDirectory(path: string) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, 'r');
      await handle.sync();
    } catch {
      // Atomic rename and complete, closed marker files remain the safety
      // boundary on platforms that reject opening directories for fsync.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private nextIdentity(): LockIdentity {
    return { ownerId: randomUUID(), pid: process.pid, acquiredAt: Date.now() };
  }

  private identityFromValue(value: unknown): LockIdentity | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 3) return null;
    if (
      typeof record.ownerId !== 'string' || !record.ownerId
      || typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0
      || typeof record.acquiredAt !== 'number' || !Number.isSafeInteger(record.acquiredAt)
    ) return null;
    return { ownerId: record.ownerId, pid: record.pid, acquiredAt: record.acquiredAt };
  }

  private sameIdentity(left: LockIdentity, right: LockIdentity) {
    return left.ownerId === right.ownerId && left.pid === right.pid && left.acquiredAt === right.acquiredAt;
  }

  private async readIdentityPair(ownerPath: string, heartbeatPath: string, allowOperationCandidates = false) {
    try {
      const parentPath = dirname(ownerPath);
      if (dirname(heartbeatPath) !== parentPath) return null;
      const entries = await readdir(parentPath, { withFileTypes: true });
      const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
      for (const entry of entries) {
        const isOperationCandidate = allowOperationCandidates
          && /^operation\.candidate\.[0-9a-f-]{36}$/i.test(entry.name);
        if (!isOperationCandidate && entry.name !== 'owner.json' && entry.name !== 'heartbeat' && entry.name !== 'operation') return null;
      }
      const ownerEntry = entryByName.get('owner.json');
      const heartbeatEntry = entryByName.get('heartbeat');
      if (!ownerEntry?.isFile() || !heartbeatEntry?.isFile()) return null;
      const heartbeatStat = await stat(heartbeatPath);
      const owner = this.identityFromValue(JSON.parse(await readFile(ownerPath, 'utf8')));
      const heartbeat = this.identityFromValue(JSON.parse(await readFile(heartbeatPath, 'utf8')));
      if (!owner || !heartbeat || !this.sameIdentity(owner, heartbeat)) return null;
      return { identity: owner, heartbeatStat };
    } catch {
      return null;
    }
  }

  private consumeCrash(point: DesktopConfigStoreCrashPoint) {
    if (this.crashAt !== point) return false;
    this.crashAt = undefined;
    return true;
  }

  /** Windows can transiently report EPERM while a competing directory rename closes. */
  private async renameDirectoryIfFree(
    sourcePath: string,
    targetPath: string,
    beforeRename?: RenameIdentityGuard,
  ) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        // The caller's identity/CAS predicate is deliberately evaluated in
        // this low-level helper, immediately before the platform rename.
        // Keeping it here prevents a caller from accidentally doing one
        // final read and then yielding before the no-replace quarantine move.
        if (beforeRename && !await beforeRename()) return false;
        await rename(sourcePath, targetPath);
        // Windows may report success to a concurrent second rename of the
        // same source even though only one destination was created.  Verify
        // the postcondition so exactly one contender owns the move.
        return existsSync(targetPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOENT') return false;
        if (code !== 'EPERM') throw error;
        if (existsSync(targetPath)) return false;
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
      }
    }
    return false;
  }

  private async identityMatches(
    ownerPath: string,
    heartbeatPath: string,
    expected: LockIdentity,
    allowOperationCandidates = false,
  ) {
    const current = await this.readIdentityPair(ownerPath, heartbeatPath, allowOperationCandidates);
    return Boolean(current && this.sameIdentity(current.identity, expected));
  }

  /**
   * Move a lock directory only after the fencing owner has re-read the whole
   * durable identity immediately before the quarantine rename.  The
   * quarantine destination is unique, so the rename is no-replace.  The
   * postcondition check is also required: a test or competing process can
   * replace the source after the final read but before the platform rename
   * executes.  In that case, put the replacement back and leave it intact.
   *
   * Callers hold the operation gate (and operation reclaimers additionally
   * hold the durable hard-link claim) while invoking this helper.  Legitimate
   * replacements therefore cannot pass the same fence during this window;
   * the postcondition is the fail-closed guard for platform/interposition
   * races that bypass that protocol.
   */
  private async quarantineDirectoryIfIdentity(
    sourcePath: string,
    targetPath: string,
    ownerPath: string,
    heartbeatPath: string,
    expected: LockIdentity,
    allowOperationCandidates = false,
  ) {
    const initial = await this.readIdentityPair(ownerPath, heartbeatPath, allowOperationCandidates);
    if (!initial || !this.sameIdentity(initial.identity, expected)) return false;
    // Keep the second full owner/heartbeat read inside the low-level rename
    // helper. Callers cannot accidentally move a replacement after doing a
    // check and then yielding to the platform rename implementation.
    const finalIdentityCheck: RenameIdentityGuard = () => this.identityMatches(
      ownerPath,
      heartbeatPath,
      expected,
      allowOperationCandidates,
    );
    if (!await this.renameDirectoryIfFree(sourcePath, targetPath, finalIdentityCheck)) return false;

    const quarantined = await this.readIdentityPair(
      resolve(targetPath, 'owner.json'),
      resolve(targetPath, 'heartbeat'),
      allowOperationCandidates,
    );
    if (quarantined && this.sameIdentity(quarantined.identity, expected)) return true;

    // The source was replaced between the final read and rename.  Never
    // delete the quarantined replacement; restore it while the exclusive
    // operation fence is still held whenever the source path is free.
    if (!existsSync(sourcePath) && existsSync(targetPath)) {
      await rename(targetPath, sourcePath).catch(() => undefined);
    }
    return false;
  }

  /**
   * Publish a complete owner/heartbeat directory with one atomic rename.
   * A crash before the rename leaves only a uniquely named candidate, never
   * a path that future readers interpret as the live lock or operation gate.
   */
  private async publishDirectory(
    targetPath: string,
    candidatePrefix: string,
    identity: LockIdentity,
    crashPoint?: DesktopConfigStoreCrashPoint,
  ) {
    const candidatePath = `${candidatePrefix}.${randomUUID()}`;
    let candidateCreated = false;
    try {
      await mkdir(candidatePath);
      candidateCreated = true;
      const marker = JSON.stringify(identity);
      await this.writeDurable(resolve(candidatePath, 'owner.json'), marker);
      await this.writeDurable(resolve(candidatePath, 'heartbeat'), marker);
      await this.syncDirectory(candidatePath);
      if (crashPoint && this.consumeCrash(crashPoint)) throw new InjectedConfigStoreCrash(crashPoint);
      if (!await this.renameDirectoryIfFree(candidatePath, targetPath)) {
        if (candidateCreated) await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
        return false;
      }
      const published = await this.readIdentityPair(
        resolve(targetPath, 'owner.json'),
        resolve(targetPath, 'heartbeat'),
        targetPath === this.lockPath,
      );
      if (!published || !this.sameIdentity(published.identity, identity)) return false;
      await this.syncDirectory(dirname(targetPath));
      return true;
    } catch (error) {
      // Preserve the candidate so tests can model an actual process crash.
      // A real process exit also bypasses this cleanup path.
      if (error instanceof InjectedConfigStoreCrash) throw error;
      if (candidateCreated) await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async lock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    await previous;
    try {
      return await this.withFileLock(work);
    } finally {
      release();
    }
  }

  /**
   * Promise chaining only protects calls in one renderer/process.  The lock
   * directory is the cross-process fence used by every settings/vault read,
   * recovery and CAS operation.  A dead owner can be reclaimed only after
   * its heartbeat is stale and its recorded pid is no longer alive.
   */
  private async withFileLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const identity = await this.acquireFileLock(randomUUID());
    const heartbeatPath = resolve(this.lockPath, 'heartbeat');
    const heartbeatTimer = setInterval(() => {
      void utimes(heartbeatPath, new Date(), new Date()).catch(() => undefined);
    }, 5_000);
    heartbeatTimer.unref?.();
    try {
      return await work();
    } finally {
      clearInterval(heartbeatTimer);
      await this.releaseFileLock(identity);
    }
  }

  private async acquireFileLock(ownerId: string): Promise<LockIdentity> {
    const identity = { ownerId, pid: process.pid, acquiredAt: Date.now() } satisfies LockIdentity;
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      if (await this.publishDirectory(this.lockPath, `${this.lockPath}.candidate`, identity, 'lock-candidate-ready')) return identity;
      if (await this.canReclaimFileLock()) continue;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    throw new Error('配置文件正在被其他进程更新，已拒绝并发写入。');
  }

  private operationGateHandle(identity: LockIdentity): OperationGateHandle {
    const heartbeatPath = resolve(this.lockPath, 'operation', 'heartbeat');
    let stopped = false;
    const heartbeatTimer = setInterval(() => {
      void utimes(heartbeatPath, new Date(), new Date()).catch(() => undefined);
    }, 5_000);
    heartbeatTimer.unref?.();
    return {
      identity,
      stopHeartbeat: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(heartbeatTimer);
      },
      release: async (moved = false) => {
        if (!stopped) {
          stopped = true;
          clearInterval(heartbeatTimer);
        }
        if (!moved) await this.releaseOperationGate(identity);
      },
    };
  }

  private async tryAcquireOperationGate(): Promise<OperationGateHandle | null> {
    if (!existsSync(this.lockPath)) return null;
    const operationPath = resolve(this.lockPath, 'operation');
    const firstIdentity = this.nextIdentity();
    if (await this.publishDirectory(operationPath, `${operationPath}.candidate`, firstIdentity, 'operation-candidate-ready')) {
      return this.operationGateHandle(firstIdentity);
    }
    if (!await this.canReclaimOperationGate()) return null;
    if (!existsSync(this.lockPath)) return null;
    const retryIdentity = this.nextIdentity();
    if (!await this.publishDirectory(operationPath, `${operationPath}.candidate`, retryIdentity, 'operation-candidate-ready')) return null;
    return this.operationGateHandle(retryIdentity);
  }

  /**
   * Windows can report success for two concurrent renames of the same
   * directory.  A durable hard-link claim makes stale operation reclamation
   * single-writer even when that platform quirk occurs.  The candidate is
   * fully written and synced before the no-replace link publishes it, so a
   * crash can leave only a complete claim marker.  A dead stale claim can be
   * unlinked and reacquired; an invalid claim fails closed.
   */
  private async readOperationReclamationClaim(claimPath: string) {
    try {
      const claimStat = await stat(claimPath);
      if (!claimStat.isFile()) return { kind: 'invalid' as const };
      const identity = this.identityFromValue(JSON.parse(await readFile(claimPath, 'utf8')));
      if (!identity) return { kind: 'invalid' as const };
      return { kind: 'valid' as const, identity, heartbeatStat: claimStat };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' as const };
      return { kind: 'invalid' as const };
    }
  }

  private async claimOperationReclamation(identity: LockIdentity) {
    const claimPath = resolve(this.root, 'config.lock.operation.reclaim.claim');
    const candidatePath = `${claimPath}.candidate.${randomUUID()}`;
    const marker = JSON.stringify(identity);
    await this.writeDurable(candidatePath, marker);
    try {
      try {
        await link(candidatePath, claimPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.readOperationReclamationClaim(claimPath);
        if (existing.kind === 'invalid') return null;
        if (existing.kind === 'valid') {
          if (Date.now() - existing.heartbeatStat.mtimeMs < DesktopConfigStore.lockStaleMs || this.isProcessAlive(existing.identity.pid)) return null;
          await unlink(claimPath).catch((unlinkError) => {
            if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
          });
          try {
            await link(candidatePath, claimPath);
          } catch (retryError) {
            if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') return null;
            throw retryError;
          }
        } else {
          // Another contender may have completed its stale-claim cleanup
          // between EEXIST and the read; retrying the no-replace link is safe.
          try {
            await link(candidatePath, claimPath);
          } catch (retryError) {
            if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') return null;
            throw retryError;
          }
        }
      }
      const published = await this.readOperationReclamationClaim(claimPath);
      return published.kind === 'valid' && this.sameIdentity(published.identity, identity) ? claimPath : null;
    } finally {
      await unlink(candidatePath).catch(() => undefined);
    }
  }

  private async canReclaimOperationGate() {
    const operationPath = resolve(this.lockPath, 'operation');
    const first = await this.readIdentityPair(resolve(operationPath, 'owner.json'), resolve(operationPath, 'heartbeat'));
    if (!first || Date.now() - first.heartbeatStat.mtimeMs < DesktopConfigStore.lockStaleMs || this.isProcessAlive(first.identity.pid)) return false;
    const current = await this.readIdentityPair(resolve(operationPath, 'owner.json'), resolve(operationPath, 'heartbeat'));
    if (!current || !this.sameIdentity(current.identity, first.identity) || Date.now() - current.heartbeatStat.mtimeMs < DesktopConfigStore.lockStaleMs || this.isProcessAlive(current.identity.pid)) return false;
    const claimPath = await this.claimOperationReclamation(first.identity);
    if (!claimPath) return false;
    try {
      const fencedPath = resolve(this.root, `config.lock.operation.reclaim.${randomUUID()}`);
      if (!await this.quarantineDirectoryIfIdentity(
        operationPath,
        fencedPath,
        resolve(operationPath, 'owner.json'),
        resolve(operationPath, 'heartbeat'),
        first.identity,
      )) return false;
      await rm(fencedPath, { recursive: true, force: true }).catch(() => undefined);
      return true;
    } finally {
      await unlink(claimPath).catch(() => undefined);
    }
  }

  private async releaseOperationGate(identity: LockIdentity) {
    const operationPath = resolve(this.lockPath, 'operation');
    const claimPath = await this.claimOperationReclamation(identity);
    if (!claimPath) return;
    try {
      const fencedPath = resolve(this.root, `config.lock.operation.release.${randomUUID()}`);
      if (!await this.quarantineDirectoryIfIdentity(
        operationPath,
        fencedPath,
        resolve(operationPath, 'owner.json'),
        resolve(operationPath, 'heartbeat'),
        identity,
      )) return;
      await rm(fencedPath, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      await unlink(claimPath).catch(() => undefined);
    }
  }

  private async canReclaimFileLock() {
    const heartbeatPath = resolve(this.lockPath, 'heartbeat');
    const ownerPath = resolve(this.lockPath, 'owner.json');
    const first = await this.readIdentityPair(ownerPath, heartbeatPath, true);
    if (!first || Date.now() - first.heartbeatStat.mtimeMs < DesktopConfigStore.lockStaleMs || this.isProcessAlive(first.identity.pid)) return false;
    const gate = await this.tryAcquireOperationGate();
    if (!gate) return false;
    let moved = false;
    try {
      const current = await this.readIdentityPair(ownerPath, heartbeatPath, true);
      if (!current || !this.sameIdentity(current.identity, first.identity) || Date.now() - current.heartbeatStat.mtimeMs < DesktopConfigStore.lockStaleMs || this.isProcessAlive(current.identity.pid)) return false;
      gate.stopHeartbeat();
      const fencedPath = resolve(this.root, `config.lock.reclaim.${randomUUID()}`);
      if (!await this.quarantineDirectoryIfIdentity(
        this.lockPath,
        fencedPath,
        ownerPath,
        heartbeatPath,
        first.identity,
        true,
      )) return false;
      moved = true;
      await rm(fencedPath, { recursive: true, force: true }).catch(() => undefined);
      return true;
    } finally {
      await gate.release(moved);
    }
  }

  private async releaseFileLock(expectedOwner: string | LockIdentity) {
    const ownerPath = resolve(this.lockPath, 'owner.json');
    const gate = await this.tryAcquireOperationGate();
    if (!gate) return;
    let moved = false;
    let crashed = false;
    try {
      if (this.consumeCrash('release-gate-acquired')) {
        gate.stopHeartbeat();
        crashed = true;
        throw new InjectedConfigStoreCrash('release-gate-acquired');
      }
      const current = await this.readIdentityPair(ownerPath, resolve(this.lockPath, 'heartbeat'), true);
      if (!current || current.identity.ownerId !== (typeof expectedOwner === 'string' ? expectedOwner : expectedOwner.ownerId)) return;
      if (typeof expectedOwner !== 'string' && !this.sameIdentity(current.identity, expectedOwner)) return;
      gate.stopHeartbeat();
      const fencedPath = resolve(this.root, `config.lock.release.${randomUUID()}`);
      if (!await this.quarantineDirectoryIfIdentity(
        this.lockPath,
        fencedPath,
        ownerPath,
        resolve(this.lockPath, 'heartbeat'),
        current.identity,
        true,
      )) return;
      moved = true;
      await rm(fencedPath, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      if (!crashed) await gate.release(moved);
    }
  }
}
