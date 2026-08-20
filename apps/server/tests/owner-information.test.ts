import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { LiveFeishuAdapter } from '../src/integrations/feishu.js';
import type { OwnerIdentity } from '../src/domain.js';
import { PmService } from '../src/service.js';
import { registerSimulatedMessageRoute } from './support/simulated-message-route.js';

class Vault {
  values = new Map<string, string>();
  generation = 0;
  leases = new Map<string, { status: 'active' | 'completed' | 'failed'; leaseId: string; ownerId: string; fencingToken: number; generation: number; tokenFingerprint: string | null; resultExpiresAt: string | null }>();
  private fingerprint(value: string | null) { return value === null ? null : createHash('sha256').update(value, 'utf8').digest('hex'); }
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); this.generation += 1; }
  async setMany(values: Record<string, string>) { for (const [key, value] of Object.entries(values)) this.values.set(key, value); this.generation += 1; }
  async readSnapshot() {
    return {
      generation: this.generation,
      accessToken: this.values.get('FEISHU_USER_ACCESS_TOKEN') ?? null,
      refreshToken: this.values.get('FEISHU_REFRESH_TOKEN') ?? null,
      expiresAt: this.values.get('FEISHU_TOKEN_EXPIRES_AT') ?? null,
      grantedScopes: this.values.get('FEISHU_GRANTED_SCOPES') ?? null,
    };
  }
  async setManyAtomic(values: Record<string, string | null>, expectedGeneration: number, refreshFence?: { identityKey: string; leaseId: string; fencingToken: number; tokenFingerprint: string | null }) {
    if (expectedGeneration !== this.generation) return { accepted: false, generation: this.generation };
    if (refreshFence) {
      const lease = this.leases.get(refreshFence.identityKey);
      if (!lease || lease.status !== 'active' || lease.leaseId !== refreshFence.leaseId || lease.fencingToken !== refreshFence.fencingToken || lease.generation !== expectedGeneration || lease.tokenFingerprint !== refreshFence.tokenFingerprint || this.fingerprint(this.values.get('FEISHU_REFRESH_TOKEN') ?? null) !== refreshFence.tokenFingerprint) return { accepted: false, generation: this.generation };
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === null) this.values.delete(key);
      else this.values.set(key, value);
    }
    this.generation += 1;
    return { accepted: true, generation: this.generation };
  }
  async acquireRefreshLease(identityKey: string, waitForResult = false) {
    const snapshot = await this.readSnapshot();
    const previous = this.leases.get(identityKey);
    if (previous?.status === 'active') return { status: 'busy' as const, generation: this.generation, snapshot };
    if (previous && waitForResult) return { status: previous.status, generation: this.generation, snapshot, resultExpiresAt: previous.resultExpiresAt } as const;
    this.leases.delete(identityKey);
    const leaseId = `lease-${Math.random().toString(16).slice(2)}`;
    const ownerId = `owner-${Math.random().toString(16).slice(2)}`;
    const fencingToken = (previous?.fencingToken ?? 0) + 1;
    const tokenFingerprint = this.fingerprint(snapshot.refreshToken);
    this.leases.set(identityKey, { status: 'active', leaseId, ownerId, fencingToken, generation: this.generation, tokenFingerprint, resultExpiresAt: null });
    return { status: 'acquired' as const, generation: this.generation, snapshot, leaseId, ownerId, fencingToken, tokenFingerprint };
  }
  async renewRefreshLease(identityKey: string, leaseId: string, fencingToken?: number) {
    const lease = this.leases.get(identityKey);
    return Boolean(lease?.status === 'active' && lease.leaseId === leaseId && (fencingToken === undefined || lease.fencingToken === fencingToken));
  }
  async releaseRefreshLease(identityKey: string, leaseId: string, result: { status: 'completed' | 'failed'; generation: number; expiresAt?: string | null }, fencingToken?: number) {
    const lease = this.leases.get(identityKey);
    if (!lease || lease.status !== 'active' || lease.leaseId !== leaseId || (fencingToken !== undefined && lease.fencingToken !== fencingToken)) throw new Error('lease lost');
    this.leases.set(identityKey, { ...lease, status: result.status, generation: result.generation, resultExpiresAt: result.expiresAt ?? null });
  }
}

describe('系统主人个人信息流基础能力', () => {
  const databases: AppDatabase[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('安全模拟模式明确展示五类信息源，而不是把机器人作为唯一入口', () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const service = new PmService(database, createAdapters(config), config);
    const state = service.ownerInformation();
    expect(state.owner).toBeNull();
    expect(state.sources.map((item) => item.kind)).toEqual(['owner_dm', 'owner_mentions', 'calendar', 'minutes', 'bot_supplement']);
    expect(state.sources.every((item) => item.status === 'mock_ready')).toBe(true);
  });

  it('读取用户身份后保存 owner profile，并把真实来源标记为待租户验收', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'user-token');
    await vault.set('FEISHU_GRANTED_SCOPES', 'im:message calendar:calendar offline_access');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      FEISHU_EXTERNAL_ENABLED: 'true',
      FEISHU_APP_ID: 'app-test',
      FEISHU_APP_SECRET: 'secret-test',
      FEISHU_OAUTH_SCOPES: 'im:message calendar:calendar',
    });
    const fakeClient = {
      authen: { v1: { userInfo: { get: async () => ({ data: { open_id: 'owner-open', union_id: 'owner-union', user_id: 'owner-user', name: '系统主人', tenant_key: 'tenant-1' } }) } } },
    };
    const feishu = new LiveFeishuAdapter(config.feishu, { tokenVault: vault, client: fakeClient as never });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const adapters = { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu };
    const service = new PmService(database, adapters, config);
    const result = await service.refreshOwnerIdentity();
    expect(result.owner).toMatchObject({ openId: 'owner-open', name: '系统主人', oauthStatus: 'authorized' });
    expect(result.owner!.configuredScopes).toEqual(['im:message', 'calendar:calendar', 'offline_access']);
    expect(result.sources.filter((item) => ['owner_dm', 'owner_mentions', 'calendar', 'minutes'].includes(item.kind)).every((item) => item.status === 'partial')).toBe(true);
    expect(result.sources.find((item) => item.kind === 'owner_dm')?.requiresBotInChat).toBe(false);
  });

  it('同一数据库从 Mock 切换到真实适配器时不会残留 mock_ready', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      FEISHU_EXTERNAL_ENABLED: 'true',
      FEISHU_APP_ID: 'app-test',
      FEISHU_APP_SECRET: 'secret-test',
    });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);

    const mockConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    new PmService(database, createAdapters(mockConfig), mockConfig);
    expect((database.raw.prepare('SELECT status FROM information_source_state WHERE source_kind = ?').get('owner_dm') as { status: string }).status).toBe('mock_ready');

    const live = new LiveFeishuAdapter(config.feishu, {
      tokenVault: new Vault(),
      client: { authen: { v1: { userInfo: { get: async () => ({ data: { open_id: 'owner-open' } }) } } } } as never,
    });
    new PmService(database, { ...createAdapters(mockConfig), feishu: live }, config);
    const statuses = database.raw.prepare('SELECT source_kind, status FROM information_source_state ORDER BY source_kind').all() as Array<{ source_kind: string; status: string }>;
    expect(statuses.filter((item) => ['owner_dm', 'owner_mentions', 'calendar', 'minutes'].includes(item.source_kind)).every((item) => item.status === 'unauthorized')).toBe(true);
    expect(statuses.find((item) => item.source_kind === 'bot_supplement')?.status).toBe('partial');
    expect(statuses.some((item) => item.status === 'mock_ready')).toBe(false);
  });

  it('刷新主人身份未返回 scope 时保留数据库中已批准的 scope', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      FEISHU_EXTERNAL_ENABLED: 'true',
      FEISHU_APP_ID: 'app-test',
      FEISHU_APP_SECRET: 'secret-test',
    });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const timestamp = new Date().toISOString();
    database.raw.prepare(
      `INSERT INTO owner_profile
        (id, open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json, last_synced_at, created_at, updated_at)
       VALUES ('primary', 'owner-open', NULL, NULL, '系统主人', 'tenant-1', 'authorized', ?, ?, ?, ?)`,
    ).run(JSON.stringify(['im:chat:read', 'im:message:readonly']), timestamp, timestamp, timestamp);
    class IdentityOnlyAdapter extends LiveFeishuAdapter {
      override async getCurrentUser() {
        return { openId: 'owner-open', unionId: null, userId: null, name: '系统主人', tenantKey: 'tenant-1' };
      }

      override async getGrantedScopes(): Promise<string[] | undefined> {
        return undefined;
      }
    }
    const adapter = new IdentityOnlyAdapter(config.feishu, { client: {} as never });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, config);

    const result = await service.refreshOwnerIdentity();

    expect(result.owner?.configuredScopes).toEqual(['im:chat:read', 'im:message:readonly']);
    expect(database.raw.prepare("SELECT granted_scopes_json FROM owner_profile WHERE id = 'primary'").get()).toEqual({ granted_scopes_json: JSON.stringify(['im:chat:read', 'im:message:readonly']) });
  });

  it('授权代际变化后丢弃迟到身份响应，不覆盖旧主人或同步状态', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      FEISHU_EXTERNAL_ENABLED: 'true',
      FEISHU_APP_ID: 'app-test',
      FEISHU_APP_SECRET: 'secret-test',
    });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const timestamp = new Date().toISOString();
    database.raw.prepare(
      `INSERT INTO owner_profile
        (id, open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json, last_synced_at, created_at, updated_at)
       VALUES ('primary', 'owner-old', NULL, NULL, '旧主人', 'tenant-old', 'authorized', '["old:scope"]', ?, ?, ?)`,
    ).run(timestamp, timestamp, timestamp);
    database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES ('feishu_owner', 'messages:owner_dm:target-old', '{"watermark":"old"}', ?, NULL, ?)`,
    ).run(timestamp, timestamp);
    let generation = 7;
    let resolveOwner!: (owner: OwnerIdentity) => void;
    const ownerPending = new Promise<OwnerIdentity>((resolve) => { resolveOwner = resolve; });
    const adapter = {
      kind: 'live' as const,
      readAuthGeneration: async () => generation,
      getCurrentUser: async () => ownerPending,
      getGrantedScopeUpdate: async () => ({ kind: 'set' as const, scopes: ['new:scope'] }),
    };
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter as never }, config);
    const refresh = service.refreshOwnerIdentity();
    await Promise.resolve();
    generation = 8;
    resolveOwner({ openId: 'owner-new', unionId: null, userId: null, name: '新主人', tenantKey: 'tenant-new' });
    await expect(refresh).rejects.toThrow('授权状态已更新');
    expect(database.raw.prepare("SELECT open_id, granted_scopes_json FROM owner_profile WHERE id = 'primary'").get()).toEqual({ open_id: 'owner-old', granted_scopes_json: '["old:scope"]' });
    expect(database.raw.prepare("SELECT cursor FROM sync_cursor WHERE scope_key = 'messages:owner_dm:target-old'").get()).toEqual({ cursor: '{"watermark":"old"}' });
  });

  it('群内 @主人生成即时私人提醒，并保留来源解释但不产生 Outbox', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const service = new PmService(database, createAdapters(config), config);
    const app = await buildApp(service, { serveWeb: false });
    registerSimulatedMessageRoute(app, service, {
      testOnly: true,
      nodeEnv: config.nodeEnv,
      databaseProvider: config.database.provider,
      databaseUrl: config.database.url,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/dev/simulate-message',
        payload: {
          externalId: 'owner-mention-mock-1',
          sourceType: 'group',
          conversationId: 'new-group-1',
          senderId: 'requester-1',
          senderName: '需求方',
          content: '@系统主人 请分析一下活动留存，验证是否继续投入。',
          ownerMentioned: true,
          completeness: 'partial',
          discoveryReason: '群聊中提及系统主人',
          metadata: { mentionCount: 1 },
          occurredAt: new Date().toISOString(),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().candidate).toBeTruthy();
      const source = database.raw.prepare('SELECT owner_mentioned, discovery_reason, metadata_json FROM source_event WHERE external_id = ?').get('owner-mention-mock-1') as { owner_mentioned: number; discovery_reason: string; metadata_json: string };
      expect(source.owner_mentioned).toBe(1);
      expect(source.discovery_reason).toBe('群聊中提及系统主人');
      expect(JSON.parse(source.metadata_json)).toMatchObject({ mentionCount: 1 });
      const notifications = await app.inject({ method: 'GET', url: '/api/notifications?unreadOnly=true' });
      expect(notifications.json().items[0].reason).toContain('@你');
      expect((database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('临时网络错误只标记同步异常，不把主人 OAuth 误判为过期', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      FEISHU_EXTERNAL_ENABLED: 'true',
      FEISHU_APP_ID: 'app-test',
      FEISHU_APP_SECRET: 'secret-test',
    });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const timestamp = new Date().toISOString();
    database.raw.prepare(
      `INSERT INTO owner_profile
        (id, open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json, last_synced_at, created_at, updated_at)
       VALUES ('primary', 'owner-open', NULL, NULL, '系统主人', 'tenant-1', 'authorized', '[]', ?, ?, ?)`,
    ).run(timestamp, timestamp, timestamp);
    database.raw.prepare("UPDATE information_source_state SET status = 'partial', last_error = NULL WHERE source_kind IN ('owner_dm','owner_mentions','calendar','minutes')").run();
    const vault = new Vault();
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'user-token');
    const feishu = new LiveFeishuAdapter(config.feishu, {
      tokenVault: vault,
      client: { authen: { v1: { userInfo: { get: async () => { throw new Error('network failed'); } } } } } as never,
    });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu }, config);

    await expect(service.refreshOwnerIdentity()).rejects.toThrow('network failed');
    expect(database.raw.prepare('SELECT oauth_status FROM owner_profile WHERE id = ?').get('primary')).toEqual({ oauth_status: 'authorized' });
    const sources = database.raw.prepare("SELECT status, last_error FROM information_source_state WHERE source_kind IN ('owner_dm','owner_mentions','calendar','minutes')").all() as Array<{ status: string; last_error: string }>;
    expect(sources.every((item) => item.status === 'error' && item.last_error.includes('network failed'))).toBe(true);
  });

  it('SDK 只返回结构化鉴权错误码时也会标记主人授权失效', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      FEISHU_EXTERNAL_ENABLED: 'true',
      FEISHU_APP_ID: 'app-test',
      FEISHU_APP_SECRET: 'secret-test',
    });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const timestamp = new Date().toISOString();
    database.raw.prepare(
      `INSERT INTO owner_profile
        (id, open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json, last_synced_at, created_at, updated_at)
       VALUES ('primary', 'owner-open', NULL, NULL, '系统主人', 'tenant-1', 'authorized', '[]', ?, ?, ?)`,
    ).run(timestamp, timestamp, timestamp);
    const vault = new Vault();
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'user-token');
    const authError = Object.assign(new Error('request failed'), { code: 99991663 });
    const feishu = new LiveFeishuAdapter(config.feishu, {
      tokenVault: vault,
      client: { authen: { v1: { userInfo: { get: async () => { throw authError; } } } } } as never,
    });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu }, config);

    await expect(service.refreshOwnerIdentity()).rejects.toThrow('官方 code：99991663');
    expect(database.raw.prepare('SELECT oauth_status FROM owner_profile WHERE id = ?').get('primary')).toEqual({ oauth_status: 'expired' });
    const sources = database.raw.prepare("SELECT status FROM information_source_state WHERE source_kind IN ('owner_dm','owner_mentions','calendar','minutes')").all() as Array<{ status: string }>;
    expect(sources.every((item) => item.status === 'unauthorized')).toBe(true);
  });

  it('OAuth 换 Token 成功但身份读取失败时，不把已保存令牌误报成授权失败', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      FEISHU_EXTERNAL_ENABLED: 'true',
      FEISHU_APP_ID: 'app-test',
      FEISHU_APP_SECRET: 'secret-test',
    });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const vault = new Vault();
    const feishu = new LiveFeishuAdapter(config.feishu, {
      tokenVault: vault,
      client: {
        accessToken: {
          retrieveByAuthorizationCode: async () => ({ accessToken: 'access-token', refreshToken: 'refresh-token', expiresIn: 3600 }),
          refresh: async () => ({ accessToken: 'access-token-2', refreshToken: 'refresh-token-2', expiresIn: 3600 }),
        },
        authen: { v1: { userInfo: { get: async () => { throw Object.assign(new Error('scope denied'), { code: 99991663 }); } } } },
      } as never,
    });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu }, config);
    const state = '33333333-3333-4333-8333-333333333333';
    await feishu.buildAuthorizationUrl(state);

    const result = await service.completeFeishuOAuth('code-1', state);
    expect(result).toMatchObject({ ok: true, tokenSaved: true, owner: null });
    expect(result.ownerError).toContain('官方 code：99991663');
    expect(await vault.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-token-2');
    expect(database.raw.prepare("SELECT event_type FROM app_log WHERE event_type = 'feishu.oauth.owner_identity_failed'").get()).toBeTruthy();
  });
});
