import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ailySecretKeys, LocalCredentialStore } from '../src/local-credential-store.js';

describe('TooManyTasks 本地凭证库', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function makeStore() {
    const root = await mkdtemp(join(tmpdir(), 'toomanytasks-credentials-'));
    roots.push(root);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      CONFIG_ROOT: root,
      AILY_APP_ID: 'cli_test',
      AILY_AGENT_ID: 'agent_test',
      AILY_OAUTH_REDIRECT_URI: 'http://127.0.0.1:4310/oauth/aily/callback',
    });
    const store = new LocalCredentialStore(config);
    await store.load();
    return { root, config, store };
  }

  it('加密保存 Aily 凭证，并在重启后读取同一份配置和集成令牌', async () => {
    const { root, config, store } = await makeStore();
    await store.saveConfig({
      appId: 'cli_test',
      agentId: 'agent_test',
      domain: 'feishu',
      oauthRedirectUri: 'http://127.0.0.1:4310/oauth/aily/callback',
      oauthScopes: ['aily:agent_chat:write', 'offline_access'],
      appSecret: 'private-app-secret',
    });
    await store.setMany({
      [ailySecretKeys.accessToken]: 'private-user-access-token',
      [ailySecretKeys.refreshToken]: 'private-refresh-token',
      [ailySecretKeys.expiresAt]: '2026-08-27T12:00:00.000Z',
    });
    const firstIntegrationToken = await store.ensureIntegrationToken();

    const encrypted = await readFile(join(root, 'aily-secrets.bin'), 'utf8');
    expect(encrypted).not.toContain('private-app-secret');
    expect(encrypted).not.toContain('private-user-access-token');
    expect(encrypted).not.toContain('private-refresh-token');
    expect((await stat(join(root, 'aily-secrets.bin'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'cindy-integration-token'))).mode & 0o777).toBe(0o600);

    const reloaded = new LocalCredentialStore(config);
    await reloaded.load();
    expect(reloaded.current().appSecret).toBe('private-app-secret');
    expect(await reloaded.get(ailySecretKeys.accessToken)).toBe('private-user-access-token');
    expect(reloaded.publicConfig()).toMatchObject({
      appSecretSaved: true,
      connected: true,
    });
    expect(JSON.stringify(reloaded.publicConfig())).not.toContain('private-');
    expect(await reloaded.ensureIntegrationToken()).toBe(firstIntegrationToken);
  });

  it('更换应用身份或 App Secret 时清除旧用户授权', async () => {
    const { store } = await makeStore();
    await store.saveConfig({
      appId: 'cli_test',
      agentId: 'agent_test',
      domain: 'feishu',
      oauthRedirectUri: 'http://127.0.0.1:4310/oauth/aily/callback',
      oauthScopes: ['aily:agent_chat:write', 'offline_access'],
      appSecret: 'first-secret',
    });
    await store.setMany({
      [ailySecretKeys.accessToken]: 'old-access',
      [ailySecretKeys.refreshToken]: 'old-refresh',
    });

    await store.saveConfig({
      appId: 'cli_test',
      agentId: 'agent_test',
      domain: 'feishu',
      oauthRedirectUri: 'http://127.0.0.1:4310/oauth/aily/callback',
      oauthScopes: ['aily:agent_chat:write', 'offline_access'],
      appSecret: 'second-secret',
    });

    expect(store.current().appSecret).toBe('second-secret');
    expect(await store.get(ailySecretKeys.accessToken)).toBeNull();
    expect(await store.get(ailySecretKeys.refreshToken)).toBeNull();
    expect(store.publicConfig().connected).toBe(false);
  });

  it('服务端和 Cindy Worker 共用 TOOMANYTASKS_CONFIG_ROOT，且优先于旧 CONFIG_ROOT', async () => {
    const preferredRoot = await mkdtemp(join(tmpdir(), 'toomanytasks-preferred-root-'));
    const legacyRoot = await mkdtemp(join(tmpdir(), 'toomanytasks-legacy-root-'));
    roots.push(preferredRoot, legacyRoot);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      TOOMANYTASKS_CONFIG_ROOT: preferredRoot,
      CONFIG_ROOT: legacyRoot,
    });
    expect(config.configRoot).toBe(preferredRoot);
  });

  it('新安装不继承开发时的 Aily 应用或 Agent 标识', async () => {
    const root = await mkdtemp(join(tmpdir(), 'toomanytasks-empty-aily-config-'));
    roots.push(root);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      TOOMANYTASKS_CONFIG_ROOT: root,
    });
    const store = new LocalCredentialStore(config);
    await store.load();

    expect(config.aily.appId).toBe('');
    expect(config.aily.agentId).toBe('');
    expect(store.publicConfig()).toMatchObject({
      appId: '',
      agentId: '',
      appSecretSaved: false,
      connected: false,
    });
  });

  it('拒绝把 OAuth 授权码回调配置到非本机或错误路径', async () => {
    const { store } = await makeStore();
    await expect(store.saveConfig({
      appId: 'cli_test',
      agentId: 'agent_test',
      domain: 'feishu',
      oauthRedirectUri: 'https://example.com/oauth/aily/callback',
      oauthScopes: ['aily:agent_chat:write', 'offline_access'],
      appSecret: 'private-app-secret',
    })).rejects.toThrow(/本机 HTTP 回环地址/);
    expect(() => loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      AILY_OAUTH_REDIRECT_URI: 'http://127.0.0.1:4310/wrong-path',
    })).toThrow(/本机 HTTP 回环地址/);
  });
});
