import { afterEach, describe, expect, it } from 'vitest';
import type { AilyService } from '../src/aily.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createCindyAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

describe('Aily 与 Cindy 扫描路由', () => {
  const databases: AppDatabase[] = [];
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const database of databases.splice(0)) database.close();
  });

  async function makeApp() {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createCindyAdapters(config), config);
    const calls: Array<{ method: string; input?: unknown }> = [];
    const status = {
      appId: 'cli_test',
      agentId: 'agent_test',
      domain: 'feishu' as const,
      oauthRedirectUri: 'http://127.0.0.1:4310/oauth/aily/callback',
      oauthScopes: ['aily:agent_chat:write', 'offline_access'],
      appSecretSaved: true,
      connected: true,
      refreshAvailable: true,
      expiresAt: '2099-01-01T00:00:00.000Z',
      grantedScopes: ['aily:agent_chat:write', 'offline_access'],
      authStatus: 'connected' as const,
    };
    const fake = {
      status: () => status,
      saveConfig: async (input: unknown) => {
        calls.push({ method: 'saveConfig', input });
        return status;
      },
      authorizationUrl: async () => ({ url: 'https://accounts.feishu.cn/example' }),
      prepareApplication: async () => ({
        status: 'ready',
        configuredScopeCount: 10,
        grantedScopeCount: 10,
        pendingScopeCount: 0,
        pendingScopes: [],
        publishSubmitted: true,
        adminApprovalRequested: true,
      }),
      completeAuthorization: async (code: string, state: string) => {
        calls.push({ method: 'completeAuthorization', input: { code, state } });
        return { ok: true, status };
      },
      disconnect: async () => ({ ok: true, status: { ...status, connected: false } }),
      triggerScan: (_pm: PmService, trigger: 'manual' | 'schedule') => {
        calls.push({ method: 'triggerScan', input: trigger });
        return {
          status: 'accepted',
          job_id: 'aily-scan:test',
        };
      },
    } as unknown as AilyService;
    const app = await buildApp(service, {
      serveWeb: false,
      logger: false,
      cindyIntegrationToken: 'integration-token',
      ailyService: fake,
    });
    apps.push(app);
    return { app, calls };
  }

  it('Aily 配置和授权状态只接受 loopback，响应不回显 App Secret', async () => {
    const { app, calls } = await makeApp();
    const remote = await app.inject({
      method: 'GET',
      url: '/api/integrations/aily/status',
      remoteAddress: '203.0.113.20',
    });
    expect(remote.statusCode).toBe(403);

    const local = await app.inject({
      method: 'GET',
      url: '/api/integrations/aily/status',
      remoteAddress: '127.0.0.1',
    });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({ authStatus: 'connected', appSecretSaved: true });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/integrations/aily/config',
      remoteAddress: '127.0.0.1',
      payload: {
        appId: 'cli_test',
        appSecret: 'private-app-secret',
        agentId: 'agent_test',
        domain: 'feishu',
        oauthRedirectUri: 'http://127.0.0.1:4310/oauth/aily/callback',
        oauthScopes: ['aily:agent_chat:write', 'offline_access'],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(JSON.stringify(saved.json())).not.toContain('private-app-secret');
    expect(calls).toContainEqual(expect.objectContaining({ method: 'saveConfig' }));

    const externalRedirect = await app.inject({
      method: 'PUT',
      url: '/api/integrations/aily/config',
      remoteAddress: '127.0.0.1',
      payload: {
        appId: 'cli_test',
        appSecret: 'private-app-secret',
        agentId: 'agent_test',
        domain: 'feishu',
        oauthRedirectUri: 'https://example.com/oauth/aily/callback',
        oauthScopes: ['aily:agent_chat:write', 'offline_access'],
      },
    });
    expect(externalRedirect.statusCode).toBe(400);
    expect(externalRedirect.json().error).toBe('Aily 应用配置格式不正确。');
  });

  it('Cindy 扫描接口要求自动生成的 Bearer，并只传递 trigger', async () => {
    const { app, calls } = await makeApp();
    expect((await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/scan',
      payload: { trigger: 'manual' },
    })).statusCode).toBe(401);

    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/scan',
      headers: { authorization: 'Bearer integration-token' },
      payload: { trigger: 'schedule' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'accepted', job_id: 'aily-scan:test' });
    expect(calls).toContainEqual({ method: 'triggerScan', input: 'schedule' });
  });

  it('应用后台准备接口只接受 loopback，并返回脱敏权限状态', async () => {
    const { app, calls } = await makeApp();
    const remote = await app.inject({
      method: 'POST',
      url: '/api/integrations/aily/application/prepare',
      remoteAddress: '203.0.113.20',
    });
    expect(remote.statusCode).toBe(403);

    const local = await app.inject({
      method: 'POST',
      url: '/api/integrations/aily/application/prepare',
      remoteAddress: '127.0.0.1',
    });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({
      status: 'ready',
      configuredScopeCount: 10,
      pendingScopeCount: 0,
      publishSubmitted: true,
    });
    expect(JSON.stringify(local.json())).not.toContain('secret');
    expect(calls).toHaveLength(0);
  });

  it('OAuth callback 只回显脱敏结果并通知设置页刷新', async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/oauth/aily/callback?code=private-code&state=private-state',
      remoteAddress: '127.0.0.1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('toomanytasks:aily-oauth');
    expect(response.body).not.toContain('private-code');
    expect(response.body).not.toContain('private-state');
    expect(calls).toContainEqual({
      method: 'completeAuthorization',
      input: { code: 'private-code', state: 'private-state' },
    });
  });
});
