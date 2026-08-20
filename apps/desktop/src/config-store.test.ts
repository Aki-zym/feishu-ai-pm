import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

import { DesktopConfigStore } from './config-store.js';
import { loadConfig } from '../../server/src/config.js';
import { LiveFeishuAdapter } from '../../server/src/integrations/feishu.js';

const roots: string[] = [];

function configInput() {
  return {
    setupComplete: true,
    launchAtLogin: false,
    logRetentionDays: 30,
    feishu: {
      appId: 'synthetic-app',
      externalEnabled: true,
      domain: 'feishu' as const,
      eventMode: 'websocket' as const,
      oauthRedirectUri: 'http://127.0.0.1:4311/oauth/feishu/callback',
      oauthScopes: 'old:scope',
      scanEnabled: false,
      scanIntervalSeconds: 60,
      groupIds: [],
    },
    llm: { provider: 'rule_mock', model: '', apiBase: '', timeoutMs: 30000, maxRetries: 2 },
    workspace: { readEnabled: false, allowedPaths: [] },
    secretState: { feishuAppSecret: false, feishuUserAccessToken: false, feishuRefreshToken: false, llmApiKey: false, feishuUserToken: false },
    secrets: {},
  };
}

function feishuConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    FEISHU_EXTERNAL_ENABLED: 'true',
    FEISHU_APP_ID: 'app-test',
    FEISHU_APP_SECRET: 'secret-test',
    FEISHU_OAUTH_REDIRECT_URI: 'http://127.0.0.1:4311/oauth/feishu/callback',
  }).feishu;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('DesktopConfigStore generation and recovery', () => {
  it('keeps explicit empty scope as a value while omitted token fields remain untouched', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-config-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await store.setMany({ FEISHU_GRANTED_SCOPES: '' });
    expect(await store.getSecret('FEISHU_GRANTED_SCOPES')).toBe('');
    await store.setMany({ FEISHU_USER_ACCESS_TOKEN: 'synthetic-access' });
    expect(await store.getSecret('FEISHU_GRANTED_SCOPES')).toBe('');
    expect((await store.readSnapshot()).generation).toBeGreaterThan(1);
  });

  it('recovers the last-known-good settings/secrets pair after an interrupted commit', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await store.setMany({ FEISHU_GRANTED_SCOPES: 'stable:scope' });
    const settings = join(root, 'settings.json');
    const secrets = join(root, 'secrets.bin');
    await copyFile(settings, join(root, 'settings.json.lkg'));
    await copyFile(secrets, join(root, 'secrets.bin.lkg'));
    await writeFile(settings, JSON.stringify({ setupComplete: false }));
    await writeFile(join(root, 'config-generation.json'), JSON.stringify({ generation: 999 }));
    await writeFile(join(root, 'config-transaction.json'), JSON.stringify({ generation: 1000, previousGeneration: 2, settingsExisted: true, secretsExisted: true }));

    expect((await store.readPublic()).setupComplete).toBe(true);
    expect(await store.getSecret('FEISHU_GRANTED_SCOPES')).toBe('stable:scope');
    expect(JSON.parse(await readFile(settings, 'utf8')).setupComplete).toBe(true);
  });

  it('rejects a stale generation without overwriting the newer token pair', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-cas-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    const before = await store.readSnapshot();
    await expect(store.setManyAtomic({ FEISHU_USER_ACCESS_TOKEN: 'new-access', FEISHU_REFRESH_TOKEN: 'new-refresh' }, before.generation)).resolves.toMatchObject({ accepted: true });
    await expect(store.setManyAtomic({ FEISHU_USER_ACCESS_TOKEN: 'stale-access', FEISHU_REFRESH_TOKEN: 'stale-refresh' }, before.generation)).resolves.toMatchObject({ accepted: false });
    expect(await store.getSecret('FEISHU_USER_ACCESS_TOKEN')).toBe('new-access');
    expect(await store.getSecret('FEISHU_REFRESH_TOKEN')).toBe('new-refresh');
  });

  it('serializes two independent store instances through the same cross-process lock', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-cross-process-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const first = new DesktopConfigStore(root);
    const second = new DesktopConfigStore(root);
    await first.save(configInput());
    await Promise.all([
      first.setMany({ FEISHU_USER_ACCESS_TOKEN: 'access-a' }),
      second.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-b' }),
    ]);
    const snapshot = await first.readSnapshot();
    expect(snapshot.generation).toBe(3);
    expect(await second.getSecret('FEISHU_USER_ACCESS_TOKEN')).toBe('access-a');
    expect(await first.getSecret('FEISHU_REFRESH_TOKEN')).toBe('refresh-b');
  });

  it('serializes refresh leases across independent vault instances and publishes one winner', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-refresh-lease-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const first = new DesktopConfigStore(root);
    const second = new DesktopConfigStore(root);
    await first.save(configInput());
    await first.setMany({
      FEISHU_USER_ACCESS_TOKEN: 'access-old',
      FEISHU_REFRESH_TOKEN: 'refresh-old',
      FEISHU_TOKEN_EXPIRES_AT: '2026-01-01T00:00:00.000Z',
      FEISHU_GRANTED_SCOPES: 'offline_access',
    });

    const acquired = await first.acquireRefreshLease('owner:primary');
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') throw new Error('lease not acquired');
    const busy = await second.acquireRefreshLease('owner:primary');
    expect(busy.status).toBe('busy');
    await first.setManyAtomic({
      FEISHU_USER_ACCESS_TOKEN: 'access-new',
      FEISHU_REFRESH_TOKEN: 'refresh-rotated',
      FEISHU_TOKEN_EXPIRES_AT: '2026-08-16T00:00:00.000Z',
    }, acquired.generation);
    const afterSave = await first.readSnapshot();
    await first.releaseRefreshLease('owner:primary', acquired.leaseId, { status: 'completed', generation: afterSave.generation, expiresAt: afterSave.expiresAt });

    const reused = await second.acquireRefreshLease('owner:primary', true);
    expect(reused.status).toBe('completed');
    expect(reused.snapshot.refreshToken).toBe('refresh-rotated');
    expect(reused.snapshot.accessToken).toBe('access-new');
    expect(reused.snapshot.grantedScopes).toBe('offline_access');
    const next = await second.acquireRefreshLease('owner:primary');
    expect(next.status).toBe('acquired');
  });

  it('two independent DesktopConfigStore adapters share one durable provider refresh', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-refresh-adapters-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const firstVault = new DesktopConfigStore(root);
    const secondVault = new DesktopConfigStore(root);
    await firstVault.save(configInput());
    await firstVault.setMany({
      FEISHU_USER_ACCESS_TOKEN: 'access-old',
      FEISHU_REFRESH_TOKEN: 'refresh-old',
      FEISHU_TOKEN_EXPIRES_AT: '2026-01-01T00:00:00.000Z',
    });
    let resolveRefresh!: (value: { accessToken: string; refreshToken: string; expiresIn: number }) => void;
    const pending = new Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>((resolve) => { resolveRefresh = resolve; });
    let calls = 0;
    const client = { accessToken: { refresh: async ({ refreshToken }: { refreshToken: string }) => { expect(refreshToken).toBe('refresh-old'); calls += 1; return pending; } } } as never;
    const first = new LiveFeishuAdapter(feishuConfig(), { tokenVault: firstVault, client });
    const second = new LiveFeishuAdapter(feishuConfig(), { tokenVault: secondVault, client });

    const firstRefresh = first.refreshToken();
    await vi.waitFor(() => expect(calls).toBe(1));
    const secondRefresh = second.refreshToken();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    resolveRefresh({ accessToken: 'access-new', refreshToken: 'refresh-rotated', expiresIn: 3600 });
    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toHaveLength(2);
    expect(await firstVault.getSecret('FEISHU_REFRESH_TOKEN')).toBe('refresh-rotated');
    expect((await secondVault.readSnapshot()).accessToken).toBe('access-new');
  });

  it('allows a new owner to take over an expired pre-provider claim without a second stale snapshot', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-pre-provider-takeover-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const firstVault = new DesktopConfigStore(root);
    const secondVault = new DesktopConfigStore(root);
    await firstVault.save(configInput());
    await firstVault.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old' });
    const before = await firstVault.readSnapshot();
    const claimed = await firstVault.acquireRefreshLease('owner:primary');
    expect(claimed.status).toBe('acquired');
    if (claimed.status !== 'acquired') throw new Error('lease not acquired');
    const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
    const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    expect(lease.phase).toBe('claimed');
    await writeFile(leasePath, JSON.stringify({ ...lease, ownerPid: 999999, lockedUntil: Date.now() - 1 }));

    let calls = 0;
    const adapter = new LiveFeishuAdapter(feishuConfig(), { tokenVault: secondVault, client: {
      accessToken: { refresh: async ({ refreshToken }: { refreshToken: string }) => {
        calls += 1;
        expect(refreshToken).toBe('refresh-old');
        return { accessToken: 'access-new', refreshToken: 'refresh-rotated', expiresIn: 3600 };
      } },
    } as never });
    await expect(adapter.refreshToken()).resolves.toBeDefined();
    expect(calls).toBe(1);
    const after = await secondVault.readSnapshot();
    expect(after.generation).toBe(before.generation + 1);
    expect(after.refreshToken).toBe('refresh-rotated');
    expect(after.accessToken).toBe('access-new');
  });

  it('keeps provider_started crash recovery fail-closed with one provider call and no partial write', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-provider-started-crash-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const firstVault = new DesktopConfigStore(root);
    const secondVault = new DesktopConfigStore(root);
    await firstVault.save(configInput());
    await firstVault.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old' });
    const before = await firstVault.readSnapshot();
    let resolveProvider!: (value: { accessToken: string; refreshToken: string; expiresIn: number }) => void;
    const pending = new Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>((resolve) => { resolveProvider = resolve; });
    let calls = 0;
    const client = { accessToken: { refresh: async () => { calls += 1; return pending; } } } as never;
    const first = new LiveFeishuAdapter(feishuConfig(), { tokenVault: firstVault, client });
    const second = new LiveFeishuAdapter(feishuConfig(), { tokenVault: secondVault, client });
    const stale = first.refreshToken();
    await vi.waitFor(() => expect(calls).toBe(1));
    const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
    const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    expect(lease.phase).toBe('provider_started');
    await writeFile(leasePath, JSON.stringify({ ...lease, ownerPid: 999999, lockedUntil: Date.now() - 1 }));

    await expect(second.refreshToken()).rejects.toThrow('状态不确定');
    expect(calls).toBe(1);
    resolveProvider({ accessToken: 'access-stale', refreshToken: 'refresh-stale', expiresIn: 3600 });
    await expect(stale).rejects.toBeInstanceOf(Error);
    expect(await secondVault.readSnapshot()).toEqual(before);
    expect(calls).toBe(1);
  });

  it('keeps omitted scope and explicit empty scope consistent for both durable-lease participants', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-refresh-scopes-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const firstVault = new DesktopConfigStore(root);
    const secondVault = new DesktopConfigStore(root);
    await firstVault.save(configInput());
    await firstVault.setMany({
      FEISHU_REFRESH_TOKEN: 'refresh-old',
      FEISHU_GRANTED_SCOPES: 'old:scope',
    });
    let calls = 0;
    const responses = [
      { accessToken: 'access-empty', refreshToken: 'refresh-empty', expiresIn: 3600, scope: '' },
      { accessToken: 'access-omitted', refreshToken: 'refresh-omitted', expiresIn: 3600 },
    ];
    let releaseProvider!: () => void;
    let providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const client = { accessToken: { refresh: async () => {
      const response = responses[calls++];
      await providerGate;
      return response;
    } } } as never;
    const first = new LiveFeishuAdapter(feishuConfig(), { tokenVault: firstVault, client });
    const second = new LiveFeishuAdapter(feishuConfig(), { tokenVault: secondVault, client });

    const firstRound = Promise.all([first.refreshToken(), second.refreshToken()]);
    await vi.waitFor(() => expect(calls).toBe(1));
    releaseProvider();
    await expect(firstRound).resolves.toHaveLength(2);
    expect(calls).toBe(1);
    expect((await firstVault.readSnapshot()).grantedScopes).toBe('');
    expect((await secondVault.readSnapshot()).grantedScopes).toBe('');

    await firstVault.setMany({ FEISHU_GRANTED_SCOPES: 'restored:scope', FEISHU_REFRESH_TOKEN: 'refresh-empty' });
    providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const secondRound = Promise.all([first.refreshToken(), second.refreshToken()]);
    await vi.waitFor(() => expect(calls).toBe(2));
    releaseProvider();
    await expect(secondRound).resolves.toHaveLength(2);
    expect(calls).toBe(2);
    expect((await firstVault.readSnapshot()).grantedScopes).toBe('restored:scope');
    expect((await secondVault.readSnapshot()).grantedScopes).toBe('restored:scope');
  });

  it('fences a late owner after dead-process lease takeover without writing token state', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-refresh-fence-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const first = new DesktopConfigStore(root);
    const second = new DesktopConfigStore(root);
    await first.save(configInput());
    await first.setMany({ FEISHU_USER_ACCESS_TOKEN: 'access-old', FEISHU_REFRESH_TOKEN: 'refresh-old' });
    const acquired = await first.acquireRefreshLease('owner:primary');
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired' || acquired.leaseId === undefined || acquired.fencingToken === undefined || acquired.tokenFingerprint === undefined) throw new Error('lease not acquired');
    const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
    const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await writeFile(leasePath, JSON.stringify({ ...lease, ownerPid: 999999, lockedUntil: Date.now() - 1 }));
    const takeover = await second.acquireRefreshLease('owner:primary');
    expect(takeover.status).toBe('acquired');
    if (takeover.status !== 'acquired' || takeover.fencingToken === undefined) throw new Error('takeover not acquired');
    expect(takeover.fencingToken).toBeGreaterThan(acquired.fencingToken);
    const late = await first.setManyAtomic(
      { FEISHU_USER_ACCESS_TOKEN: 'access-stale', FEISHU_REFRESH_TOKEN: 'refresh-stale' },
      acquired.generation,
      { identityKey: 'owner:primary', leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, tokenFingerprint: acquired.tokenFingerprint },
    );
    expect(late.accepted).toBe(false);
    expect(await second.getSecret('FEISHU_REFRESH_TOKEN')).toBe('refresh-old');
    expect(await second.getSecret('FEISHU_USER_ACCESS_TOKEN')).toBe('access-old');
  });

  it('rejects a refresh fingerprint mismatch before any token write', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-refresh-fingerprint-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await store.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old', FEISHU_USER_ACCESS_TOKEN: 'access-old' });
    const before = await store.readSnapshot();
    const acquired = await store.acquireRefreshLease('owner:primary');
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired' || !acquired.leaseId || acquired.fencingToken === undefined || acquired.tokenFingerprint === undefined) throw new Error('lease not acquired');
    await store.renewRefreshLease('owner:primary', acquired.leaseId, acquired.fencingToken, 'response_pending');
    await expect(store.setManyAtomic({ FEISHU_USER_ACCESS_TOKEN: 'access-stale', FEISHU_REFRESH_TOKEN: 'refresh-stale' }, acquired.generation, {
      identityKey: 'owner:primary',
      leaseId: acquired.leaseId,
      fencingToken: acquired.fencingToken,
      tokenFingerprint: '0'.repeat(64),
      resultExpiresAt: '2026-08-16T01:00:00.000Z',
    })).resolves.toMatchObject({ accepted: false, generation: before.generation });
    expect(await store.readSnapshot()).toEqual(before);
  });

  it('fails closed after provider_started instead of replaying a possibly consumed refresh token', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-refresh-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const first = new DesktopConfigStore(root);
    const second = new DesktopConfigStore(root);
    await first.save(configInput());
    await first.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old' });
    const acquired = await first.acquireRefreshLease('owner:primary');
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired' || !acquired.leaseId || acquired.fencingToken === undefined) throw new Error('lease not acquired');
    await expect(first.renewRefreshLease('owner:primary', acquired.leaseId, acquired.fencingToken, 'provider_started')).resolves.toBe(true);
    const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
    const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await writeFile(leasePath, JSON.stringify({ ...lease, ownerPid: 999999, lockedUntil: Date.now() - 1 }));

    const takeover = await second.acquireRefreshLease('owner:primary');
    expect(takeover.status).toBe('failed');
    expect(takeover.phase).toBe('recovery_required');
    expect(await second.getSecret('FEISHU_REFRESH_TOKEN')).toBe('refresh-old');
  });

  it('解除 recovery_required 只接受已持久化的新 refresh token，并拒绝旧 owner 迟到写入', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-refresh-reauthorize-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const first = new DesktopConfigStore(root);
    const second = new DesktopConfigStore(root);
    await first.save(configInput());
    await first.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old', FEISHU_USER_ACCESS_TOKEN: 'access-old' });
    const acquired = await first.acquireRefreshLease('owner:primary');
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired' || !acquired.leaseId || acquired.fencingToken === undefined || acquired.tokenFingerprint === undefined) throw new Error('lease not acquired');
    await expect(first.renewRefreshLease('owner:primary', acquired.leaseId, acquired.fencingToken, 'provider_started')).resolves.toBe(true);
    const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
    const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await writeFile(leasePath, JSON.stringify({ ...lease, ownerPid: 999999, lockedUntil: Date.now() - 1 }));

    const recovery = await second.acquireRefreshLease('owner:primary');
    expect(recovery.status).toBe('failed');
    expect(recovery.phase).toBe('recovery_required');
    const oldGeneration = recovery.generation;

    await second.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-new' });
    const reauthorized = await second.acquireRefreshLease('owner:primary', true);
    expect(reauthorized.status).toBe('acquired');
    if (reauthorized.status !== 'acquired' || !reauthorized.leaseId || reauthorized.fencingToken === undefined || reauthorized.tokenFingerprint === undefined) throw new Error('reauthorization lease not acquired');
    expect(reauthorized.snapshot.generation).toBeGreaterThan(oldGeneration);
    expect(reauthorized.snapshot.refreshToken).toBe('refresh-new');
    expect(reauthorized.tokenFingerprint).not.toBe(acquired.tokenFingerprint);
    expect(reauthorized.fencingToken).toBeGreaterThan(acquired.fencingToken);

    const beforeLateWrite = await second.readSnapshot();
    const late = await first.setManyAtomic(
      { FEISHU_USER_ACCESS_TOKEN: 'access-stale', FEISHU_REFRESH_TOKEN: 'refresh-stale' },
      acquired.generation,
      { identityKey: 'owner:primary', leaseId: acquired.leaseId, fencingToken: acquired.fencingToken, tokenFingerprint: acquired.tokenFingerprint },
    );
    expect(late.accepted).toBe(false);
    expect(await second.readSnapshot()).toEqual(beforeLateWrite);
  });

  it('仅更新 access 或 scopes 而未更换 refresh fingerprint 时继续保持 recovery_required', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-refresh-recovery-same-token-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const first = new DesktopConfigStore(root);
    const second = new DesktopConfigStore(root);
    await first.save(configInput());
    await first.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old', FEISHU_USER_ACCESS_TOKEN: 'access-old' });
    const acquired = await first.acquireRefreshLease('owner:primary');
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired' || !acquired.leaseId || acquired.fencingToken === undefined) throw new Error('lease not acquired');
    await expect(first.renewRefreshLease('owner:primary', acquired.leaseId, acquired.fencingToken, 'provider_started')).resolves.toBe(true);
    const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
    const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await writeFile(leasePath, JSON.stringify({ ...lease, ownerPid: 999999, lockedUntil: Date.now() - 1 }));
    await expect(second.acquireRefreshLease('owner:primary')).resolves.toMatchObject({ status: 'failed', phase: 'recovery_required' });

    await second.setMany({
      FEISHU_USER_ACCESS_TOKEN: 'access-reauthorized-but-same-refresh',
      FEISHU_TOKEN_EXPIRES_AT: '2026-08-17T00:00:00.000Z',
      FEISHU_GRANTED_SCOPES: 'scope:changed',
      FEISHU_APP_SECRET: 'app-secret-changed',
    });
    const blocked = await second.acquireRefreshLease('owner:primary', true);
    expect(blocked.status).toBe('failed');
    expect(blocked.phase).toBe('recovery_required');
    expect(blocked.snapshot.refreshToken).toBe('refresh-old');
  });

  it('逐项拒绝空白 refresh token 与无关配置变化，不替换 recovery lease', async () => {
    const scenarios = [
      { name: 'empty refresh token', key: 'FEISHU_REFRESH_TOKEN', value: '' },
      { name: 'space-only refresh token', key: 'FEISHU_REFRESH_TOKEN', value: ' ' },
      { name: 'tab-only refresh token', key: 'FEISHU_REFRESH_TOKEN', value: '\t' },
      { name: 'newline-only refresh token', key: 'FEISHU_REFRESH_TOKEN', value: '\n' },
      { name: 'access token only', key: 'FEISHU_USER_ACCESS_TOKEN', value: 'access-unrelated' },
      { name: 'scope only', key: 'FEISHU_GRANTED_SCOPES', value: 'scope:unrelated' },
      { name: 'expiry only', key: 'FEISHU_TOKEN_EXPIRES_AT', value: '2026-08-18T00:00:00.000Z' },
      { name: 'app secret only', key: 'FEISHU_APP_SECRET', value: 'app-secret-unrelated' },
    ] as const;

    for (const scenario of scenarios) {
      const root = join(process.cwd(), 'tmp', `issue-39-recovery-negative-${scenario.name.replaceAll(' ', '-')}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      roots.push(root);
      const store = new DesktopConfigStore(root);
      await store.save(configInput());
      await store.setMany({
        FEISHU_REFRESH_TOKEN: 'refresh-old',
        FEISHU_USER_ACCESS_TOKEN: 'access-old',
        FEISHU_GRANTED_SCOPES: 'scope:old',
        FEISHU_TOKEN_EXPIRES_AT: '2026-08-17T00:00:00.000Z',
        FEISHU_APP_SECRET: 'app-secret-old',
      });
      const acquired = await store.acquireRefreshLease('owner:primary');
      expect(acquired.status, scenario.name).toBe('acquired');
      if (acquired.status !== 'acquired' || !acquired.leaseId) throw new Error('lease not acquired');
      await expect(store.renewRefreshLease('owner:primary', acquired.leaseId, acquired.fencingToken, 'provider_started')).resolves.toBe(true);
      const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
      const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
      const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
      await writeFile(leasePath, JSON.stringify({ ...lease, ownerPid: 999999, lockedUntil: Date.now() - 1 }));

      const recovery = await store.acquireRefreshLease('owner:primary');
      expect(recovery, scenario.name).toMatchObject({ status: 'failed', phase: 'recovery_required' });
      const before = await store.readSnapshot();
      const beforeLease = await readFile(leasePath);
      const recoveryLease = JSON.parse(beforeLease.toString('utf8')) as Record<string, unknown>;
      await store.setMany({ [scenario.key]: scenario.value });
      const changed = await store.readSnapshot();
      expect(changed.generation, scenario.name).toBeGreaterThan(before.generation);

      const blocked = await store.acquireRefreshLease('owner:primary', true);
      expect(blocked, scenario.name).toMatchObject({ status: 'failed', phase: 'recovery_required' });
      expect(blocked.fencingToken, scenario.name).toBe(lease.fencingToken);
      expect(await readFile(leasePath), scenario.name).toEqual(beforeLease);
      expect(recoveryLease.status, scenario.name).toBe('failed');
      expect(recoveryLease.phase, scenario.name).toBe('recovery_required');
      expect(recoveryLease.tokenFingerprint, scenario.name).toBe(lease.tokenFingerprint);
      expect(await store.getSecret('FEISHU_REFRESH_TOKEN'), scenario.name).toBe(
        scenario.key === 'FEISHU_REFRESH_TOKEN' ? scenario.value : 'refresh-old',
      );
    }
  }, 30_000);

  it('recovery gate rejects empty/reused credentials, stale generations, and mismatched identities', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-recovery-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await store.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old', FEISHU_USER_ACCESS_TOKEN: 'access-old' });
    const acquired = await store.acquireRefreshLease('owner:primary');
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired' || !acquired.leaseId) throw new Error('lease not acquired');
    await expect(store.renewRefreshLease('owner:primary', acquired.leaseId, acquired.fencingToken, 'provider_started')).resolves.toBe(true);
    const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
    const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await writeFile(leasePath, JSON.stringify({ ...lease, ownerPid: 999999, lockedUntil: Date.now() - 1 }));

    const recovery = await store.acquireRefreshLease('owner:primary');
    expect(recovery).toMatchObject({ status: 'failed', phase: 'recovery_required' });
    const recoveryLease = await readFile(leasePath);

    await store.setMany({ FEISHU_REFRESH_TOKEN: '' });
    const emptyToken = await store.acquireRefreshLease('owner:primary', true);
    expect(emptyToken).toMatchObject({ status: 'failed', phase: 'recovery_required' });
    expect(await readFile(leasePath)).toEqual(recoveryLease);

    await store.setMany({ FEISHU_REFRESH_TOKEN: '   ' });
    const whitespaceToken = await store.acquireRefreshLease('owner:primary', true);
    expect(whitespaceToken).toMatchObject({ status: 'failed', phase: 'recovery_required' });
    expect(await readFile(leasePath)).toEqual(recoveryLease);

    await store.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old' });
    const reusedToken = await store.acquireRefreshLease('owner:primary', true);
    expect(reusedToken).toMatchObject({ status: 'failed', phase: 'recovery_required' });
    expect(await readFile(leasePath)).toEqual(recoveryLease);

    await store.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-new' });
    const reauthorizedSnapshot = await store.readSnapshot();
    await writeFile(join(root, 'config-generation.json'), JSON.stringify({ generation: recovery.generation }));
    const staleGeneration = await store.acquireRefreshLease('owner:primary', true);
    expect(staleGeneration).toMatchObject({ status: 'failed', phase: 'recovery_required' });
    await writeFile(join(root, 'config-generation.json'), JSON.stringify({ generation: reauthorizedSnapshot.generation }));

    const current = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await writeFile(leasePath, JSON.stringify({ ...current, identityKey: 'owner:other' }));
    const beforeMismatch = await store.readSnapshot();
    await expect(store.acquireRefreshLease('owner:primary')).rejects.toThrow('refresh lease');
    expect(await store.readSnapshot()).toEqual(beforeMismatch);
  });

  it('fails closed when recovery marker lacks the failed credential fingerprint', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-recovery-missing-fingerprint-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await store.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old' });
    const acquired = await store.acquireRefreshLease('owner:primary');
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired' || !acquired.leaseId) throw new Error('lease not acquired');
    await expect(store.renewRefreshLease('owner:primary', acquired.leaseId, acquired.fencingToken, 'provider_started')).resolves.toBe(true);
    const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
    const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await writeFile(leasePath, JSON.stringify({
      ...lease,
      status: 'failed',
      phase: 'recovery_required',
      ownerPid: 999999,
      lockedUntil: Date.now() - 1,
      tokenFingerprint: null,
    }));
    const before = await store.readSnapshot();
    await expect(store.acquireRefreshLease('owner:primary')).rejects.toThrow('refresh lease');
    expect(await store.readSnapshot()).toEqual(before);
  });

  it('rolls back a completed lease if the journal is still present after a crash window', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-refresh-journal-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await store.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old' });
    const before = await store.readSnapshot();
    const acquired = await store.acquireRefreshLease('owner:primary');
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired' || !acquired.leaseId || acquired.fencingToken === undefined) throw new Error('lease not acquired');
    await store.renewRefreshLease('owner:primary', acquired.leaseId, acquired.fencingToken, 'response_pending');
    const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
    const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await copyFile(join(root, 'settings.json'), join(root, 'settings.json.lkg'));
    await copyFile(join(root, 'secrets.bin'), join(root, 'secrets.bin.lkg'));
    await writeFile(join(root, 'settings.json'), JSON.stringify({ setupComplete: false }));
    await writeFile(join(root, 'config-generation.json'), JSON.stringify({ generation: before.generation + 1 }));
    await writeFile(join(root, 'config-transaction.json'), JSON.stringify({
      generation: before.generation + 1,
      previousGeneration: before.generation,
      settingsExisted: true,
      secretsExisted: true,
      refreshLease: { identityKey: 'owner:primary', leaseId: acquired.leaseId, fencingToken: acquired.fencingToken },
    }));
    await writeFile(leasePath, JSON.stringify({ ...lease, status: 'completed', phase: 'completed', generation: before.generation + 1, resultExpiresAt: '2026-08-16T01:00:00.000Z' }));

    expect((await store.readPublic()).setupComplete).toBe(true);
    expect((await store.readSnapshot()).generation).toBe(before.generation);
    expect(await store.getSecret('FEISHU_REFRESH_TOKEN')).toBe('refresh-old');
    const recovery = await store.acquireRefreshLease('owner:primary');
    expect(recovery.status).toBe('failed');
    expect(recovery.phase).toBe('recovery_required');
  });

  it('restores the complete old pair at journal, token, and lease publish crash windows', async () => {
    for (const stage of ['journal', 'token', 'lease'] as const) {
      const root = join(process.cwd(), 'tmp', `issue-39-publish-crash-${stage}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      roots.push(root);
      const store = new DesktopConfigStore(root);
      await store.save(configInput());
      await store.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old', FEISHU_USER_ACCESS_TOKEN: 'access-old' });
      const before = await store.readSnapshot();
      const beforeSecrets = await readFile(join(root, 'secrets.bin'));
      const acquired = await store.acquireRefreshLease('owner:primary');
      expect(acquired.status).toBe('acquired');
      if (acquired.status !== 'acquired' || !acquired.leaseId || acquired.fencingToken === undefined) throw new Error('lease not acquired');
      await store.renewRefreshLease('owner:primary', acquired.leaseId, acquired.fencingToken, 'response_pending');
      const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
      const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
      const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
      await copyFile(join(root, 'settings.json'), join(root, 'settings.json.lkg'));
      await copyFile(join(root, 'secrets.bin'), join(root, 'secrets.bin.lkg'));
      await writeFile(join(root, 'config-transaction.json'), JSON.stringify({
        generation: before.generation + 1,
        previousGeneration: before.generation,
        settingsExisted: true,
        secretsExisted: true,
        refreshLease: { identityKey: 'owner:primary', leaseId: acquired.leaseId, fencingToken: acquired.fencingToken },
      }));
      if (stage !== 'journal') {
        await writeFile(join(root, 'secrets.bin'), Buffer.from(JSON.stringify({ FEISHU_REFRESH_TOKEN: 'refresh-new', FEISHU_USER_ACCESS_TOKEN: 'access-new' })));
        await writeFile(join(root, 'config-generation.json'), JSON.stringify({ generation: before.generation + 1 }));
      }
      if (stage === 'lease') {
        await writeFile(leasePath, JSON.stringify({
          ...lease,
          status: 'completed',
          phase: 'completed',
          generation: before.generation + 1,
          tokenFingerprint: createHash('sha256').update('refresh-new', 'utf8').digest('hex'),
          lockedUntil: Date.now() + 60_000,
          resultExpiresAt: '2026-08-16T01:00:00.000Z',
        }));
      }

      await expect(store.readPublic()).resolves.toMatchObject({ setupComplete: true });
      expect(await store.readSnapshot()).toEqual(before);
      expect(await readFile(join(root, 'secrets.bin'))).toEqual(beforeSecrets);
      const recoveredLease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
      expect(recoveredLease.status).toBe('failed');
      expect(recoveredLease.phase).toBe('recovery_required');
    }
  });

  it('reclaims a dead stale lock before recovering the config', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-stale-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    const lock = join(root, 'config.lock');
    await mkdir(lock, { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    const marker = JSON.stringify({ ownerId: 'dead', pid: 999999, acquiredAt: stale.getTime() });
    await writeFile(join(lock, 'owner.json'), marker);
    await writeFile(join(lock, 'heartbeat'), marker);
    await utimes(join(lock, 'heartbeat'), stale, stale);
    expect((await store.readPublic()).setupComplete).toBe(true);
  });

  it('does not reclaim a stale malformed/live owner lock and never lets an old owner remove a replacement lock', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-lock-fence-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    const lock = join(root, 'config.lock');
    await mkdir(lock, { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    await writeFile(join(lock, 'owner.json'), '{malformed');
    await writeFile(join(lock, 'heartbeat'), '{malformed');
    await utimes(join(lock, 'heartbeat'), stale, stale);
    const privateStore = store as unknown as { canReclaimFileLock: () => Promise<boolean>; releaseFileLock: (ownerId: string) => Promise<void> };
    await expect(privateStore.canReclaimFileLock()).resolves.toBe(false);

    const acquiredAt = stale.getTime();
    const marker = JSON.stringify({ ownerId: 'live-owner', pid: process.pid, acquiredAt });
    await writeFile(join(lock, 'owner.json'), marker);
    await writeFile(join(lock, 'heartbeat'), marker);
    await utimes(join(lock, 'heartbeat'), stale, stale);
    await expect(privateStore.canReclaimFileLock()).resolves.toBe(false);

    await writeFile(join(lock, 'unexpected-entry'), 'must fail closed');
    const deadMarker = JSON.stringify({ ownerId: 'dead-owner', pid: 999999, acquiredAt });
    await writeFile(join(lock, 'owner.json'), deadMarker);
    await writeFile(join(lock, 'heartbeat'), deadMarker);
    await utimes(join(lock, 'heartbeat'), stale, stale);
    await expect(privateStore.canReclaimFileLock()).resolves.toBe(false);
    await rm(join(lock, 'unexpected-entry'));

    const replacement = JSON.stringify({ ownerId: 'new-owner', pid: process.pid, acquiredAt: Date.now() });
    await writeFile(join(lock, 'owner.json'), replacement);
    await writeFile(join(lock, 'heartbeat'), replacement);
    await privateStore.releaseFileLock('old-owner');
    await expect(stat(lock)).resolves.toBeTruthy();
    await privateStore.releaseFileLock('new-owner');
    await expect(stat(lock)).rejects.toThrow();
  });

  it('fences two stale reclaimers so exactly one removes the observed dead owner', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-lock-competing-reclaim-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const first = new DesktopConfigStore(root);
    const second = new DesktopConfigStore(root);
    await first.save(configInput());
    const lock = join(root, 'config.lock');
    await mkdir(lock, { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    const marker = JSON.stringify({ ownerId: 'dead-competitor', pid: 999999, acquiredAt: stale.getTime() });
    await writeFile(join(lock, 'owner.json'), marker);
    await writeFile(join(lock, 'heartbeat'), marker);
    await utimes(join(lock, 'heartbeat'), stale, stale);

    const firstPrivate = first as unknown as { canReclaimFileLock: () => Promise<boolean> };
    const secondPrivate = second as unknown as { canReclaimFileLock: () => Promise<boolean> };
    const results = await Promise.all([firstPrivate.canReclaimFileLock(), secondPrivate.canReclaimFileLock()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((value) => !value)).toHaveLength(1);
    await expect(stat(lock)).rejects.toThrow();
  });

  it('keeps an operation replacement when reclaim interposes after the final identity read', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-operation-reclaim-interpose-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    const lock = join(root, 'config.lock');
    const operation = join(lock, 'operation');
    await mkdir(operation, { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    const oldIdentity = { ownerId: 'old-operation', pid: 999999, acquiredAt: stale.getTime() };
    const replacementIdentity = { ownerId: 'replacement-operation', pid: process.pid, acquiredAt: Date.now() };
    const marker = JSON.stringify(oldIdentity);
    await writeFile(join(operation, 'owner.json'), marker);
    await writeFile(join(operation, 'heartbeat'), marker);
    await utimes(join(operation, 'heartbeat'), stale, stale);

    const privateStore = store as unknown as {
      canReclaimOperationGate: () => Promise<boolean>;
      releaseOperationGate: (identity: typeof replacementIdentity) => Promise<void>;
      renameDirectoryIfFree: (source: string, target: string, beforeRename?: () => Promise<boolean>) => Promise<boolean>;
    };
    const originalRename = privateStore.renameDirectoryIfFree.bind(store);
    let interposed = false;
    let finalGuardRan = false;
    privateStore.renameDirectoryIfFree = async (source, target, beforeRename) => {
      const interposedThisCall = !interposed && source === operation;
      if (!interposed && source === operation) {
        interposed = true;
        const replacement = JSON.stringify(replacementIdentity);
        await writeFile(join(operation, 'owner.json'), replacement);
        await writeFile(join(operation, 'heartbeat'), replacement);
      }
      const guarded = beforeRename && (async () => {
        finalGuardRan = true;
        return beforeRename();
      });
      const result = await originalRename(source, target, guarded);
      if (interposedThisCall) expect(existsSync(target)).toBe(false);
      return result;
    };

    await expect(privateStore.canReclaimOperationGate()).resolves.toBe(false);
    expect(interposed).toBe(true);
    expect(finalGuardRan).toBe(true);
    await expect(readFile(join(operation, 'owner.json'), 'utf8')).resolves.toBe(JSON.stringify(replacementIdentity));
    await expect(readFile(join(operation, 'heartbeat'), 'utf8')).resolves.toBe(JSON.stringify(replacementIdentity));
    await privateStore.releaseOperationGate(replacementIdentity);
    await expect(stat(operation)).rejects.toThrow();
  });

  it('keeps an operation replacement when release interposes after the final identity read', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-operation-release-interpose-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    const lock = join(root, 'config.lock');
    const operation = join(lock, 'operation');
    await mkdir(operation, { recursive: true });
    const oldIdentity = { ownerId: 'old-operation', pid: process.pid, acquiredAt: Date.now() - 120_000 };
    const replacementIdentity = { ownerId: 'replacement-operation', pid: process.pid, acquiredAt: Date.now() };
    await writeFile(join(operation, 'owner.json'), JSON.stringify(oldIdentity));
    await writeFile(join(operation, 'heartbeat'), JSON.stringify(oldIdentity));

    const privateStore = store as unknown as {
      releaseOperationGate: (identity: typeof oldIdentity) => Promise<void>;
      renameDirectoryIfFree: (source: string, target: string, beforeRename?: () => Promise<boolean>) => Promise<boolean>;
    };
    const originalRename = privateStore.renameDirectoryIfFree.bind(store);
    let interposed = false;
    let finalGuardRan = false;
    privateStore.renameDirectoryIfFree = async (source, target, beforeRename) => {
      const interposedThisCall = !interposed && source === operation;
      if (!interposed && source === operation) {
        interposed = true;
        const replacement = JSON.stringify(replacementIdentity);
        await writeFile(join(operation, 'owner.json'), replacement);
        await writeFile(join(operation, 'heartbeat'), replacement);
      }
      const guarded = beforeRename && (async () => {
        finalGuardRan = true;
        return beforeRename();
      });
      const result = await originalRename(source, target, guarded);
      if (interposedThisCall) expect(existsSync(target)).toBe(false);
      return result;
    };

    await privateStore.releaseOperationGate(oldIdentity);
    expect(interposed).toBe(true);
    expect(finalGuardRan).toBe(true);
    await expect(readFile(join(operation, 'owner.json'), 'utf8')).resolves.toBe(JSON.stringify(replacementIdentity));
    await expect(readFile(join(operation, 'heartbeat'), 'utf8')).resolves.toBe(JSON.stringify(replacementIdentity));
    await privateStore.releaseOperationGate(replacementIdentity);
    await expect(stat(operation)).rejects.toThrow();
  });

  it('keeps a file-lock replacement when stale reclaim interposes after the final identity read', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-lock-reclaim-interpose-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    const lock = join(root, 'config.lock');
    await mkdir(lock, { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    const oldIdentity = { ownerId: 'old-lock', pid: 999999, acquiredAt: stale.getTime() };
    const replacementIdentity = { ownerId: 'replacement-lock', pid: process.pid, acquiredAt: Date.now() };
    await writeFile(join(lock, 'owner.json'), JSON.stringify(oldIdentity));
    await writeFile(join(lock, 'heartbeat'), JSON.stringify(oldIdentity));
    await utimes(join(lock, 'heartbeat'), stale, stale);

    const privateStore = store as unknown as {
      canReclaimFileLock: () => Promise<boolean>;
      releaseFileLock: (identity: typeof replacementIdentity) => Promise<void>;
      renameDirectoryIfFree: (source: string, target: string, beforeRename?: () => Promise<boolean>) => Promise<boolean>;
    };
    const originalRename = privateStore.renameDirectoryIfFree.bind(store);
    let interposed = false;
    let finalGuardRan = false;
    privateStore.renameDirectoryIfFree = async (source, target, beforeRename) => {
      const interposedThisCall = !interposed && source === lock;
      if (!interposed && source === lock) {
        interposed = true;
        const replacement = JSON.stringify(replacementIdentity);
        await writeFile(join(lock, 'owner.json'), replacement);
        await writeFile(join(lock, 'heartbeat'), replacement);
      }
      const guarded = beforeRename && (async () => {
        finalGuardRan = true;
        return beforeRename();
      });
      const result = await originalRename(source, target, guarded);
      if (interposedThisCall) expect(existsSync(target)).toBe(false);
      return result;
    };

    await expect(privateStore.canReclaimFileLock()).resolves.toBe(false);
    expect(interposed).toBe(true);
    expect(finalGuardRan).toBe(true);
    await expect(readFile(join(lock, 'owner.json'), 'utf8')).resolves.toBe(JSON.stringify(replacementIdentity));
    await expect(readFile(join(lock, 'heartbeat'), 'utf8')).resolves.toBe(JSON.stringify(replacementIdentity));
    await expect(stat(join(lock, 'operation'))).rejects.toThrow();
    await privateStore.releaseFileLock(replacementIdentity);
    await expect(stat(lock)).rejects.toThrow();
  });

  it('keeps a file-lock replacement when release interposes after the final identity read', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-lock-release-interpose-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    const lock = join(root, 'config.lock');
    await mkdir(lock, { recursive: true });
    const oldIdentity = { ownerId: 'old-lock', pid: process.pid, acquiredAt: Date.now() - 120_000 };
    const replacementIdentity = { ownerId: 'replacement-lock', pid: process.pid, acquiredAt: Date.now() };
    await writeFile(join(lock, 'owner.json'), JSON.stringify(oldIdentity));
    await writeFile(join(lock, 'heartbeat'), JSON.stringify(oldIdentity));

    const privateStore = store as unknown as {
      releaseFileLock: (identity: typeof oldIdentity) => Promise<void>;
      renameDirectoryIfFree: (source: string, target: string, beforeRename?: () => Promise<boolean>) => Promise<boolean>;
    };
    const originalRename = privateStore.renameDirectoryIfFree.bind(store);
    let interposed = false;
    let finalGuardRan = false;
    privateStore.renameDirectoryIfFree = async (source, target, beforeRename) => {
      const interposedThisCall = !interposed && source === lock;
      if (!interposed && source === lock) {
        interposed = true;
        const replacement = JSON.stringify(replacementIdentity);
        await writeFile(join(lock, 'owner.json'), replacement);
        await writeFile(join(lock, 'heartbeat'), replacement);
      }
      const guarded = beforeRename && (async () => {
        finalGuardRan = true;
        return beforeRename();
      });
      const result = await originalRename(source, target, guarded);
      if (interposedThisCall) expect(existsSync(target)).toBe(false);
      return result;
    };

    await privateStore.releaseFileLock(oldIdentity);
    expect(interposed).toBe(true);
    expect(finalGuardRan).toBe(true);
    await expect(readFile(join(lock, 'owner.json'), 'utf8')).resolves.toBe(JSON.stringify(replacementIdentity));
    await expect(readFile(join(lock, 'heartbeat'), 'utf8')).resolves.toBe(JSON.stringify(replacementIdentity));
    await expect(stat(join(lock, 'operation'))).rejects.toThrow();
    await privateStore.releaseFileLock(replacementIdentity);
    await expect(stat(lock)).rejects.toThrow();
  });

  it('keeps a replacement lock when concurrent stale-owner releases use the old identity', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-lock-release-replacement-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const first = new DesktopConfigStore(root);
    const second = new DesktopConfigStore(root);
    await first.save(configInput());
    const lock = join(root, 'config.lock');
    await mkdir(lock, { recursive: true });
    const replacement = JSON.stringify({ ownerId: 'replacement-owner', pid: process.pid, acquiredAt: Date.now() });
    await writeFile(join(lock, 'owner.json'), replacement);
    await writeFile(join(lock, 'heartbeat'), replacement);

    const firstPrivate = first as unknown as { releaseFileLock: (ownerId: string) => Promise<void> };
    const secondPrivate = second as unknown as { releaseFileLock: (ownerId: string) => Promise<void> };
    await Promise.all([firstPrivate.releaseFileLock('old-owner'), secondPrivate.releaseFileLock('old-owner')]);
    await expect(stat(lock)).resolves.toBeTruthy();
    await firstPrivate.releaseFileLock('replacement-owner');
    await expect(stat(lock)).rejects.toThrow();
  });

  it('recovers a lock-candidate crash before publishing config.lock', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-crash-lock-candidate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const crashing = new DesktopConfigStore(root, { crashAt: 'lock-candidate-ready' });

    await expect(crashing.readPublic()).rejects.toThrow('lock-candidate-ready');
    await expect(stat(join(root, 'config.lock'))).rejects.toThrow();
    expect((await readdir(root)).some((name) => name.startsWith('config.lock.candidate.'))).toBe(true);

    const recovered = new DesktopConfigStore(root);
    await expect(recovered.save(configInput())).resolves.toMatchObject({ setupComplete: true });
    await expect(recovered.readPublic()).resolves.toMatchObject({ setupComplete: true });
  });

  it('recovers an operation-candidate crash before publishing config.lock/operation', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-crash-operation-candidate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const lock = join(root, 'config.lock');
    await mkdir(lock, { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    const marker = JSON.stringify({ ownerId: 'dead-lock-owner', pid: 999999, acquiredAt: stale.getTime() });
    await writeFile(join(lock, 'owner.json'), marker);
    await writeFile(join(lock, 'heartbeat'), marker);
    await utimes(join(lock, 'heartbeat'), stale, stale);

    const crashing = new DesktopConfigStore(root, { crashAt: 'operation-candidate-ready' });
    const privateStore = crashing as unknown as { canReclaimFileLock: () => Promise<boolean> };
    await expect(privateStore.canReclaimFileLock()).rejects.toThrow('operation-candidate-ready');
    await expect(stat(join(lock, 'operation'))).rejects.toThrow();
    expect((await readdir(lock)).some((name) => name.startsWith('operation.candidate.'))).toBe(true);

    const recovered = new DesktopConfigStore(root);
    await expect(recovered.readPublic()).resolves.toMatchObject({ setupComplete: false });
    await expect(stat(join(root, 'config.lock'))).rejects.toThrow();
  });

  it('recovers a release-gate crash before quarantine rename', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-crash-release-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const lock = join(root, 'config.lock');
    await mkdir(lock, { recursive: true });
    const stale = new Date(Date.now() - 120_000);
    const marker = JSON.stringify({ ownerId: 'old-owner', pid: 999999, acquiredAt: stale.getTime() });
    await writeFile(join(lock, 'owner.json'), marker);
    await writeFile(join(lock, 'heartbeat'), marker);
    await utimes(join(lock, 'heartbeat'), stale, stale);

    const crashing = new DesktopConfigStore(root, { crashAt: 'release-gate-acquired' });
    const privateStore = crashing as unknown as { releaseFileLock: (owner: string) => Promise<void> };
    await expect(privateStore.releaseFileLock('old-owner')).rejects.toThrow('release-gate-acquired');
    const operation = join(lock, 'operation');
    const operationMarker = JSON.parse(await readFile(join(operation, 'owner.json'), 'utf8')) as Record<string, unknown>;
    const deadOperation = JSON.stringify({ ...operationMarker, pid: 999999, acquiredAt: stale.getTime() });
    await writeFile(join(operation, 'owner.json'), deadOperation);
    await writeFile(join(operation, 'heartbeat'), deadOperation);
    await utimes(join(operation, 'heartbeat'), stale, stale);

    const recovered = new DesktopConfigStore(root);
    await expect(recovered.readPublic()).resolves.toMatchObject({ setupComplete: false });
    await expect(stat(join(root, 'config.lock'))).rejects.toThrow();
  });

  it('fails closed on malformed/live operation markers and fences dead competitors/replacement release', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-operation-marker-fence-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    const lock = join(root, 'config.lock');
    const operation = join(lock, 'operation');
    await mkdir(operation, { recursive: true });
    await writeFile(join(operation, 'owner.json'), '{malformed');
    await writeFile(join(operation, 'heartbeat'), '{malformed');
    const privateStore = store as unknown as {
      canReclaimOperationGate: () => Promise<boolean>;
      releaseOperationGate: (identity: { ownerId: string; pid: number; acquiredAt: number }) => Promise<void>;
    };
    await expect(privateStore.canReclaimOperationGate()).resolves.toBe(false);

    const stale = new Date(Date.now() - 120_000);
    const liveMarker = JSON.stringify({ ownerId: 'live-operation', pid: process.pid, acquiredAt: stale.getTime() });
    await writeFile(join(operation, 'owner.json'), liveMarker);
    await writeFile(join(operation, 'heartbeat'), liveMarker);
    await utimes(join(operation, 'heartbeat'), stale, stale);
    await expect(privateStore.canReclaimOperationGate()).resolves.toBe(false);

    const deadMarker = JSON.stringify({ ownerId: 'dead-operation', pid: 999999, acquiredAt: stale.getTime() });
    await writeFile(join(operation, 'owner.json'), deadMarker);
    await writeFile(join(operation, 'heartbeat'), deadMarker);
    await utimes(join(operation, 'heartbeat'), stale, stale);
    await writeFile(join(operation, 'unexpected-entry'), 'must fail closed');
    await expect(privateStore.canReclaimOperationGate()).resolves.toBe(false);
    await rm(join(operation, 'unexpected-entry'));
    const second = new DesktopConfigStore(root) as unknown as { canReclaimOperationGate: () => Promise<boolean> };
    const results = await Promise.all([privateStore.canReclaimOperationGate(), second.canReclaimOperationGate()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(stat(operation)).rejects.toThrow();

    const replacement = JSON.stringify({ ownerId: 'replacement-operation', pid: process.pid, acquiredAt: Date.now() });
    await mkdir(operation, { recursive: true });
    await writeFile(join(operation, 'owner.json'), replacement);
    await writeFile(join(operation, 'heartbeat'), replacement);
    await privateStore.releaseOperationGate({ ownerId: 'old-operation', pid: 999999, acquiredAt: stale.getTime() });
    await expect(stat(operation)).resolves.toBeTruthy();
    await privateStore.releaseOperationGate({ ownerId: 'replacement-operation', pid: process.pid, acquiredAt: JSON.parse(replacement).acquiredAt as number });
    await expect(stat(operation)).rejects.toThrow();
  });

  it('keeps journal, LKG pair, generation and CAS state coherent across concurrent settings and token writes', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-config-transaction-fence-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const first = new DesktopConfigStore(root);
    const second = new DesktopConfigStore(root);
    await first.save(configInput());
    const before = await first.readSnapshot();
    const nextInput = { ...configInput(), feishu: { ...configInput().feishu, appId: 'concurrent-settings' }, secrets: { feishuAppSecret: 'concurrent-secret' } };
    const [saved, cas] = await Promise.all([
      first.save(nextInput),
      second.setManyAtomic({ FEISHU_USER_ACCESS_TOKEN: 'concurrent-access', FEISHU_REFRESH_TOKEN: 'concurrent-refresh' }, before.generation),
    ]);
    expect(saved.feishu.appId).toBe('concurrent-settings');
    expect(cas.generation).toBeGreaterThanOrEqual(before.generation);
    await expect(first.readPublic()).resolves.toMatchObject({ feishu: { appId: 'concurrent-settings' } });
    const snapshot = await second.readSnapshot();
    expect(snapshot.generation).toBeGreaterThan(before.generation);
    await expect(stat(join(root, 'config-transaction.json'))).rejects.toThrow();
    await expect(stat(join(root, 'settings.json.lkg'))).rejects.toThrow();
    await expect(stat(join(root, 'secrets.bin.lkg'))).rejects.toThrow();
    await expect(stat(join(root, 'settings.json.tmp'))).rejects.toThrow();
    await expect(stat(join(root, 'secrets.bin.tmp'))).rejects.toThrow();
  });

  it('rejects malformed or truncated journals without exposing half-written settings/secrets', async () => {
    for (const malformed of ['{', '{"generation":"bad"}', '{"generation":2}']) {
      const root = join(process.cwd(), 'tmp', `issue-39-bad-journal-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      roots.push(root);
      const store = new DesktopConfigStore(root);
      await store.save(configInput());
      await store.setMany({ FEISHU_REFRESH_TOKEN: 'stable-refresh' });
      const settings = join(root, 'settings.json');
      const secrets = join(root, 'secrets.bin');
      const originalSecrets = await readFile(secrets);
      await writeFile(settings, JSON.stringify({ setupComplete: false }));
      await writeFile(join(root, 'settings.json.tmp'), '{"setupComplete":false}');
      await writeFile(join(root, 'config-transaction.json'), malformed);

      await expect(store.readPublic()).rejects.toThrow('事务日志');
      await expect(store.getSecret('FEISHU_REFRESH_TOKEN')).rejects.toThrow('事务日志');
      await expect(store.setManyAtomic({ FEISHU_REFRESH_TOKEN: 'must-not-write' }, 0)).rejects.toThrow('事务日志');
      expect(await readFile(join(root, 'config-transaction.json'), 'utf8')).toBe(malformed);
      expect(await readFile(secrets)).toEqual(originalSecrets);
      expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ setupComplete: false });
    }
  });

  it('rejects a valid journal that cannot prove an LKG pair', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-missing-lkg-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await writeFile(join(root, 'config-transaction.json'), JSON.stringify({ generation: 2, previousGeneration: 1, settingsExisted: true, secretsExisted: true }));
    await expect(store.readPublic()).rejects.toThrow('LKG 缺失');
    await expect(store.setMany({ FEISHU_REFRESH_TOKEN: 'must-not-write' })).rejects.toThrow('LKG 缺失');
  });

  it('keeps a journal with a missing refresh lease fail-closed across recovery and refresh attempts', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-missing-refresh-lease-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await store.setMany({ FEISHU_REFRESH_TOKEN: 'stable-refresh' });
    const beforeSettings = await readFile(join(root, 'settings.json'));
    const beforeSecrets = await readFile(join(root, 'secrets.bin'));
    await copyFile(join(root, 'settings.json'), join(root, 'settings.json.lkg'));
    await copyFile(join(root, 'secrets.bin'), join(root, 'secrets.bin.lkg'));
    await writeFile(join(root, 'settings.json'), JSON.stringify({ setupComplete: false }));
    await writeFile(join(root, 'config-generation.json'), JSON.stringify({ generation: 3 }));
    const journal = JSON.stringify({
      generation: 3,
      previousGeneration: 2,
      settingsExisted: true,
      secretsExisted: true,
      refreshLease: {
        identityKey: 'owner:primary',
        leaseId: '00000000-0000-4000-8000-000000000001',
        fencingToken: 1,
      },
    });
    await writeFile(join(root, 'config-transaction.json'), journal);

    let providerCalls = 0;
    const adapter = new LiveFeishuAdapter(feishuConfig(), {
      tokenVault: store,
      client: { accessToken: { refresh: async () => { providerCalls += 1; return { accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600 }; } } },
    } as never);

    for (const operation of [
      () => store.readPublic(),
      () => store.readSnapshot(),
      () => store.acquireRefreshLease('owner:primary'),
      () => adapter.refreshToken(),
    ]) {
      await expect(operation()).rejects.toThrow('refresh lease 缺失');
    }
    expect(providerCalls).toBe(0);
    expect(await readFile(join(root, 'config-transaction.json'), 'utf8')).toBe(journal);
    expect(await readFile(join(root, 'settings.json'))).not.toEqual(beforeSettings);
    expect(await readFile(join(root, 'secrets.bin'))).toEqual(beforeSecrets);
    expect(await readFile(join(root, 'settings.json.lkg'))).toEqual(beforeSettings);
    expect(await readFile(join(root, 'secrets.bin.lkg'))).toEqual(beforeSecrets);
    await expect(store.readPublic()).rejects.toThrow('refresh lease 缺失');
    expect(providerCalls).toBe(0);
  });

  it('rejects malformed generation instead of treating it as zero/default', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-bad-generation-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    const settings = await readFile(join(root, 'settings.json'));
    await writeFile(join(root, 'config-generation.json'), '{"generation":"not-a-number"}');
    await expect(store.readPublic()).rejects.toThrow('generation');
    await expect(store.readSnapshot()).rejects.toThrow('generation');
    await expect(store.setManyAtomic({ FEISHU_REFRESH_TOKEN: 'must-not-write' }, 0)).rejects.toThrow('generation');
    expect(await readFile(join(root, 'settings.json'))).toEqual(settings);
    expect(await store.getSecret('FEISHU_REFRESH_TOKEN').catch(() => null)).toBeNull();
  });

  it('rejects malformed settings instead of combining defaults with existing secrets', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-bad-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await store.setMany({ FEISHU_REFRESH_TOKEN: 'stable-refresh' });
    const settings = join(root, 'settings.json');
    const secrets = await readFile(join(root, 'secrets.bin'));
    await writeFile(settings, '{"setupComplete":');
    await expect(store.readPublic()).rejects.toThrow('settings.json');
    await expect(store.readSnapshot()).rejects.toThrow('settings.json');
    await expect(store.setManyAtomic({ FEISHU_REFRESH_TOKEN: 'must-not-write' }, 0)).rejects.toThrow('settings.json');
    expect(await readFile(join(root, 'secrets.bin'))).toEqual(secrets);
  });

  it('rejects missing settings or generation instead of treating partial files as defaults/zero', async () => {
    for (const missing of ['settings.json', 'config-generation.json']) {
      const root = join(process.cwd(), 'tmp', `issue-39-missing-${missing.replaceAll('.', '-')}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      roots.push(root);
      const store = new DesktopConfigStore(root);
      await store.save(configInput());
      await store.setMany({ FEISHU_REFRESH_TOKEN: 'stable-refresh' });
      const generation = await readFile(join(root, 'config-generation.json'));
      const settings = await readFile(join(root, 'settings.json'));
      const secrets = await readFile(join(root, 'secrets.bin'));
      await rm(join(root, missing), { force: true });

      await expect(store.readPublic()).rejects.toThrow(missing === 'settings.json' ? 'settings.json' : 'generation');
      await expect(store.readSnapshot()).rejects.toThrow(missing === 'settings.json' ? 'settings.json' : 'generation');
      await expect(store.setManyAtomic({ FEISHU_REFRESH_TOKEN: 'must-not-write' }, 0)).rejects.toThrow(missing === 'settings.json' ? 'settings.json' : 'generation');
      if (missing !== 'config-generation.json') expect(await readFile(join(root, 'config-generation.json'))).toEqual(generation);
      if (missing !== 'settings.json') expect(await readFile(join(root, 'settings.json'))).toEqual(settings);
      expect(await readFile(join(root, 'secrets.bin'))).toEqual(secrets);
    }
  });

  it('rejects a malformed durable refresh lease without exposing token state', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-bad-refresh-lease-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await store.setMany({ FEISHU_REFRESH_TOKEN: 'stable-refresh' });
    const before = await store.readSnapshot();
    const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
    await writeFile(join(root, `feishu-refresh-lease-${digest}.json`), '{"status":"active"}');

    await expect(store.acquireRefreshLease('owner:primary')).rejects.toThrow('refresh lease');
    await expect(store.readSnapshot()).resolves.toEqual(before);
    expect(await store.getSecret('FEISHU_REFRESH_TOKEN')).toBe('stable-refresh');
  });

  it('rejects extra or mismatched durable lease fields without leaking canaries', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-extra-refresh-lease-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await store.setMany({ FEISHU_REFRESH_TOKEN: 'stable-refresh' });
    const before = await store.readSnapshot();
    const acquired = await store.acquireRefreshLease('owner:primary');
    expect(acquired.status).toBe('acquired');
    const digest = createHash('sha256').update('owner:primary', 'utf8').digest('hex');
    const leasePath = join(root, `feishu-refresh-lease-${digest}.json`);
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await writeFile(leasePath, JSON.stringify({ ...lease, identityKey: 'owner:other', canary: 'refresh-token-canary' }));
    await expect(store.acquireRefreshLease('owner:primary')).rejects.toThrow('refresh lease');
    await expect(store.readSnapshot()).resolves.toEqual(before);
    expect(await store.getSecret('FEISHU_REFRESH_TOKEN')).toBe('stable-refresh');
    await expect(store.acquireRefreshLease('owner:primary')).rejects.not.toThrow('refresh-token-canary');
  });

  it('does not reuse a completed result after a newer generation supersedes it', async () => {
    const root = join(process.cwd(), 'tmp', `issue-39-stale-completed-result-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    roots.push(root);
    const store = new DesktopConfigStore(root);
    await store.save(configInput());
    await store.setMany({ FEISHU_REFRESH_TOKEN: 'refresh-old' });
    const acquired = await store.acquireRefreshLease('owner:primary');
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired' || !acquired.leaseId || acquired.fencingToken === undefined || acquired.tokenFingerprint === undefined) throw new Error('lease not acquired');
    await store.renewRefreshLease('owner:primary', acquired.leaseId, acquired.fencingToken, 'response_pending');
    await expect(store.setManyAtomic({ FEISHU_USER_ACCESS_TOKEN: 'access-new', FEISHU_REFRESH_TOKEN: 'refresh-new' }, acquired.generation, {
      identityKey: 'owner:primary',
      leaseId: acquired.leaseId,
      fencingToken: acquired.fencingToken,
      tokenFingerprint: acquired.tokenFingerprint,
      resultExpiresAt: '2026-08-16T01:00:00.000Z',
    })).resolves.toMatchObject({ accepted: true });
    await expect(store.acquireRefreshLease('owner:primary', true)).resolves.toMatchObject({ status: 'completed' });
    await store.setMany({ FEISHU_APP_SECRET: 'new-app-secret' });
    const next = await store.acquireRefreshLease('owner:primary', true);
    expect(next.status).toBe('acquired');
    if (next.status === 'acquired') expect(next.generation).toBeGreaterThan(acquired.generation);
  });
});
