import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { LiveFeishuAdapter } from '../src/integrations/feishu.js';
import { PmService } from '../src/service.js';

function liveConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    FEISHU_EXTERNAL_ENABLED: 'true',
    FEISHU_APP_ID: 'app-test',
    FEISHU_APP_SECRET: 'secret-test',
    FEISHU_GROUP_IDS: 'bot-supplement-group',
  });
}

function seedOwner(database: AppDatabase, openId = 'owner-open') {
  const timestamp = new Date('2026-08-11T08:00:00.000Z').toISOString();
  database.raw.prepare(
    `INSERT INTO owner_profile
      (id, open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json, last_synced_at, created_at, updated_at)
     VALUES ('primary', ?, NULL, NULL, '系统主人', 'tenant-1', 'authorized', '[]', ?, ?, ?)`,
  ).run(openId, timestamp, timestamp, timestamp);
}

class MonitoringAdapter extends LiveFeishuAdapter {
  chatCalls: string[] = [];
  searchCalls: Array<{ query?: string; hasChatted?: boolean; pageToken?: string; pageSize?: number }> = [];

  constructor(config = liveConfig()) {
    super(config.feishu, { client: {} as never });
  }

  override async listOwnerChats(input: { types?: 'p2p' | 'group' | 'p2p,group'; pageToken?: string; pageSize?: number } = {}): Promise<any> {
    this.chatCalls.push(String(input.types ?? ''));
    if (input.types === 'p2p') {
      return {
        items: [
          { chat_id: 'p2p-a', chat_mode: 'p2p', p2p_target_id: 'person-a', name: '张三' },
          { chat_id: 'p2p-b', chat_mode: 'p2p', p2p_target_id: 'person-b', name: '李四' },
        ],
        has_more: false,
      };
    }
    return {
      items: [
        { chat_id: 'group-a', chat_mode: 'group', name: '数据需求群' },
        { chat_id: 'group-b', chat_mode: 'group', name: '项目同步群' },
      ],
      has_more: false,
    };
  }

  override async searchOwnerUsers(input: { query?: string; hasChatted?: boolean; pageToken?: string; pageSize?: number } = {}): Promise<any> {
    this.searchCalls.push(input);
    return {
      items: [
        { id: 'person-a', display_info: '<h>张三</h>\n数据中心', meta_data: { i18n_names: { zh_cn: '张三' }, enterprise_mail_address: 'a@example.com', chat_id: 'p2p-a' } },
        { id: 'person-c', display_info: '<h>张三</h>\n产品中心', meta_data: { i18n_names: { zh_cn: '张三' }, enterprise_mail_address: 'c@example.com', chat_id: 'p2p-c' } },
      ],
      has_more: false,
    };
  }
}

describe('飞书人员与群聊监控范围', () => {
  const databases: AppDatabase[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('发现现有个人单聊和群聊时默认都不启用，且不混入机器人补充群', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database);
    const adapter = new MonitoringAdapter(config);
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, config);

    const scope = await service.refreshFeishuMonitoringScope();

    expect(adapter.chatCalls).toEqual(['p2p', 'group']);
    expect(scope).toMatchObject({ ownerAuthorized: true, selectedPersonCount: 0, selectedGroupCount: 0 });
    expect(scope.people.map((item) => item.name)).toEqual(expect.arrayContaining(['李四', '张三']));
    expect(scope.groups.map((item) => item.name)).toEqual(expect.arrayContaining(['数据需求群', '项目同步群']));
    expect(scope.people.every((item) => !item.selected)).toBe(true);
    expect(scope.groups.every((item) => !item.selected)).toBe(true);
    expect(scope.people.every((item) => item.accessStatus === 'unknown')).toBe(true);
    expect(scope.groups.every((item) => item.accessStatus === 'unknown')).toBe(true);
    expect(JSON.stringify(scope)).not.toContain('person-a');
    expect(JSON.stringify(scope)).not.toContain('group-a');
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM feishu_monitor_target WHERE target_key = 'bot-supplement-group'").get()).toEqual({ count: 0 });
  });

  it('姓名搜索保留同名候选的部门和邮箱，由主人选择后持久化 opaque target id', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database);
    const adapter = new MonitoringAdapter(config);
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, config);
    await service.refreshFeishuMonitoringScope();

    const search = await service.searchFeishuPeople('张三');
    expect(adapter.searchCalls).toEqual([{ query: '张三', hasChatted: true, pageSize: 30 }]);
    expect(search.items).toHaveLength(2);
    expect(search.items.map((item) => item.secondaryLabel)).toEqual(expect.arrayContaining(['数据中心 · a@example.com', '产品中心 · c@example.com']));
    expect(search.items[0]?.id).toMatch(/^monitor_/);
    expect(search.items.find((item) => item.secondaryLabel?.includes('产品中心'))).toMatchObject({ selected: false });
    expect(service.feishuMonitoringScope()).toMatchObject({ selectedPersonCount: 0 });

    const beforeGroups = service.feishuMonitoringScope().groups;
    const searchedPerson = search.items.find((item) => item.secondaryLabel?.includes('产品中心'))!;
    const selected = service.updateFeishuMonitoringScope({ personChanges: [{ id: searchedPerson.id, selected: true }], groupIds: [beforeGroups[0]!.id] });
    expect(selected).toMatchObject({ selectedPersonCount: 1, selectedGroupCount: 1 });
    expect(service.feishuMonitoringScope()).toMatchObject({ selectedPersonCount: 1, selectedGroupCount: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 });
    expect(() => service.updateFeishuMonitoringScope({ personIds: ['monitor-not-found'], groupIds: [] })).toThrow('未发现');
  });

  it('明确排除后重新发现不会复开；主人重新启用时从当前时间建立硬起点', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database);
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: new MonitoringAdapter(config) }, config);
    const first = await service.refreshFeishuMonitoringScope();
    const person = first.people[0]!;

    service.updateFeishuMonitoringScope({ personChanges: [{ id: person.id, selected: false }], groupIds: [] });
    await service.refreshFeishuMonitoringScope();
    expect(service.feishuMonitoringScope().people.find((item) => item.id === person.id)).toMatchObject({ selected: false });
    expect(database.raw.prepare('SELECT enabled, manual_excluded FROM feishu_monitor_target WHERE id = ?').get(person.id)).toEqual({ enabled: 0, manual_excluded: 1 });

    database.raw.prepare("UPDATE sync_cursor SET cursor = ? WHERE integration = 'feishu_owner' AND scope_key = ?")
      .run(JSON.stringify({ version: 1, watermark: '2026-08-01T00:00:00.000Z', filterMode: 'p2p_selected' }), `messages:owner_dm:${person.id}`);
    service.updateFeishuMonitoringScope({ personChanges: [{ id: person.id, selected: true }], groupIds: [] });
    const cursor = JSON.parse((database.raw.prepare("SELECT cursor FROM sync_cursor WHERE integration = 'feishu_owner' AND scope_key = ?").get(`messages:owner_dm:${person.id}`) as { cursor: string }).cursor);
    expect(cursor).toMatchObject({ version: 1, filterMode: 'p2p_selected' });
    expect(cursor.hardStart).toBe(cursor.watermark);
    expect(cursor.watermark).not.toBe('2026-08-01T00:00:00.000Z');
    expect(database.raw.prepare('SELECT enabled, manual_excluded FROM feishu_monitor_target WHERE id = ?').get(person.id)).toEqual({ enabled: 1, manual_excluded: 0 });
  });

  it('后台新发现的私聊保持默认关闭，差量保存不会误开', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database);
    class GrowingAdapter extends MonitoringAdapter {
      private p2pRound = 0;
      override async listOwnerChats(input: { types?: 'p2p' | 'group' | 'p2p,group'; pageToken?: string; pageSize?: number } = {}): Promise<any> {
        this.chatCalls.push(String(input.types ?? ''));
        if (input.types === 'group') return { items: [], has_more: false };
        this.p2pRound += 1;
        const count = this.p2pRound === 1 ? 2 : 3;
        return {
          items: Array.from({ length: count }, (_, index) => ({
            chat_id: `p2p-${index}`,
            chat_mode: 'p2p',
            p2p_target_id: `person-${index}`,
            name: `联系人${index}`,
          })),
          has_more: false,
        };
      }
    }
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: new GrowingAdapter(config) }, config);
    const first = await service.refreshFeishuMonitoringScope();
    const selectedId = first.people[0]!.id;
    service.updateFeishuMonitoringScope({ personChanges: [{ id: selectedId, selected: true }], groupIds: [] });
    await service.refreshFeishuMonitoringScope();

    const saved = service.updateFeishuMonitoringScope({ personChanges: [{ id: selectedId, selected: false }], groupIds: [] });

    expect(saved).toMatchObject({ selectedPersonCount: 0 });
    expect(saved.people.every((item) => !item.selected)).toBe(true);
  });

  it('旧 personIds 兼容入口只做安全增量启用，不会误排除并发新发现人员', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database);
    class GrowingAdapter extends MonitoringAdapter {
      private p2pRound = 0;
      override async listOwnerChats(input: { types?: 'p2p' | 'group' | 'p2p,group'; pageToken?: string; pageSize?: number } = {}): Promise<any> {
        this.chatCalls.push(String(input.types ?? ''));
        if (input.types === 'group') return { items: [], has_more: false };
        this.p2pRound += 1;
        const count = this.p2pRound === 1 ? 2 : 3;
        return { items: Array.from({ length: count }, (_, index) => ({ chat_id: `p2p-${index}`, chat_mode: 'p2p', p2p_target_id: `person-${index}`, name: `联系人${index}` })), has_more: false };
      }
    }
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: new GrowingAdapter(config) }, config);
    const staleSnapshot = await service.refreshFeishuMonitoringScope();
    await service.refreshFeishuMonitoringScope();

    const saved = service.updateFeishuMonitoringScope({ personIds: staleSnapshot.people.map((item) => item.id) });

    expect(saved).toMatchObject({ selectedPersonCount: 2 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM feishu_monitor_target WHERE target_kind = 'person' AND manual_excluded = 1").get()).toEqual({ count: 0 });
  });

  it('只修改人员排除项不会重写未变化群的选择版本', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database);
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: new MonitoringAdapter(config) }, config);
    const discovered = await service.refreshFeishuMonitoringScope();
    const groupId = discovered.groups[0]!.id;
    const personId = discovered.people[0]!.id;
    service.updateFeishuMonitoringScope({ groupIds: [groupId] });
    const before = database.raw.prepare('SELECT enabled, selection_version FROM feishu_monitor_target WHERE id = ?').get(groupId);

    service.updateFeishuMonitoringScope({ personChanges: [{ id: personId, selected: false }], groupIds: [groupId] });

    expect(database.raw.prepare('SELECT enabled, selection_version FROM feishu_monitor_target WHERE id = ?').get(groupId)).toEqual(before);
  });

  it('HTTP API 支持刷新、搜索和一次保存范围；未授权时明确拒绝发现', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database);
    const adapter = new MonitoringAdapter(config);
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, config);
    const app = await buildApp(service, { serveWeb: false });
    try {
      const refreshed = await app.inject({ method: 'POST', url: '/api/integrations/feishu/monitoring-scope/refresh' });
      expect(refreshed.statusCode).toBe(200);
      const scope = refreshed.json();
      const searched = await app.inject({ method: 'GET', url: '/api/integrations/feishu/people?query=%E5%BC%A0%E4%B8%89' });
      expect(searched.statusCode).toBe(200);
      const saved = await app.inject({
        method: 'PATCH',
        url: '/api/integrations/feishu/monitoring-scope',
        payload: { personChanges: [{ id: scope.people[0].id, selected: true }], groupIds: [scope.groups[0].id] },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ selectedPersonCount: 1, selectedGroupCount: 1 });
    } finally {
      await app.close();
    }

    const noOwnerDatabase = new AppDatabase(':memory:', false);
    databases.push(noOwnerDatabase);
    const noOwnerService = new PmService(noOwnerDatabase, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: new MonitoringAdapter(config) }, config);
    expect(noOwnerService.feishuMonitoringScope()).toMatchObject({ ownerAuthorized: false, people: [], groups: [] });
    await expect(noOwnerService.refreshFeishuMonitoringScope()).rejects.toThrow('先完成系统主人');
  });

  it('切换系统主人后不会继续使用旧主人选择的人员或群', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database);
    const adapter = new MonitoringAdapter(config);
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, config);
    const discovered = await service.refreshFeishuMonitoringScope();
    service.updateFeishuMonitoringScope({ personChanges: [{ id: discovered.people[0]!.id, selected: false }], groupIds: [discovered.groups[0]!.id] });

    database.raw.prepare("UPDATE owner_profile SET open_id = 'owner-other', updated_at = ? WHERE id = 'primary'").run(new Date().toISOString());
    expect(service.feishuMonitoringScope()).toMatchObject({ ownerAuthorized: true, people: [], groups: [], selectedPersonCount: 0, selectedGroupCount: 0 });
  });

  it('刷新会话范围期间切换主人会丢弃旧响应，不写入任何主人', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database, 'owner-old');
    let release!: () => void;
    let startedCalls = 0;
    let markBothStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve; });
    class BlockingRefreshAdapter extends MonitoringAdapter {
      override async listOwnerChats(input: { types?: 'p2p' | 'group' | 'p2p,group'; pageToken?: string; pageSize?: number } = {}) {
        startedCalls += 1;
        if (startedCalls === 2) markBothStarted();
        await gate;
        return super.listOwnerChats(input);
      }
    }
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: new BlockingRefreshAdapter(config) }, config);

    const refresh = service.refreshFeishuMonitoringScope();
    await bothStarted;
    database.raw.prepare("UPDATE owner_profile SET open_id = 'owner-new', updated_at = ? WHERE id = 'primary'").run(new Date().toISOString());
    release();

    await expect(refresh).rejects.toThrow('系统主人身份已变化');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM feishu_monitor_target').get()).toEqual({ count: 0 });
  });

  it('联系人搜索期间切换主人会丢弃旧响应，不写入旧搜索结果', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database, 'owner-old');
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    class BlockingSearchAdapter extends MonitoringAdapter {
      override async searchOwnerUsers(input: { query?: string; hasChatted?: boolean; pageToken?: string; pageSize?: number } = {}) {
        markStarted();
        await gate;
        return super.searchOwnerUsers(input);
      }
    }
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: new BlockingSearchAdapter(config) }, config);

    const search = service.searchFeishuPeople('张三');
    await started;
    database.raw.prepare("UPDATE owner_profile SET open_id = 'owner-new', updated_at = ? WHERE id = 'primary'").run(new Date().toISOString());
    release();

    await expect(search).rejects.toThrow('系统主人身份已变化');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM feishu_monitor_target').get()).toEqual({ count: 0 });
  });

  it('重新 OAuth 时先暂停选择接口，换人完成后旧搜索结果仍会被丢弃', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database, 'owner-old');
    let releaseSearch!: () => void;
    let markSearchStarted!: () => void;
    let releaseExchange!: () => void;
    let markExchangeStarted!: () => void;
    const searchGate = new Promise<void>((resolve) => { releaseSearch = resolve; });
    const searchStarted = new Promise<void>((resolve) => { markSearchStarted = resolve; });
    const exchangeGate = new Promise<void>((resolve) => { releaseExchange = resolve; });
    const exchangeStarted = new Promise<void>((resolve) => { markExchangeStarted = resolve; });
    class OAuthSwitchAdapter extends MonitoringAdapter {
      override async searchOwnerUsers(input: { query?: string; hasChatted?: boolean; pageToken?: string; pageSize?: number } = {}) {
        markSearchStarted();
        await searchGate;
        return super.searchOwnerUsers(input);
      }
      override async exchangeCode() {
        markExchangeStarted();
        await exchangeGate;
        return { expiresAt: '2026-08-11T10:00:00.000Z' };
      }
      override async getCurrentUser() {
        return { openId: 'owner-new', unionId: 'union-new', userId: 'user-new', name: '新主人', tenantKey: 'tenant-1' };
      }
      override async getGrantedScopes() { return ['im:chat:read']; }
    }
    const adapter = new OAuthSwitchAdapter(config);
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, config);

    const staleSearch = service.searchFeishuPeople('张三');
    await searchStarted;
    const oauth = service.completeFeishuOAuth('new-owner-code');
    await exchangeStarted;
    await expect(service.searchFeishuPeople('李四')).rejects.toThrow('先完成系统主人');
    releaseExchange();
    await expect(oauth).resolves.toMatchObject({ ok: true, owner: { openId: 'owner-new' } });
    releaseSearch();
    await expect(staleSearch).rejects.toThrow('系统主人身份已变化');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM feishu_monitor_target').get()).toEqual({ count: 0 });
  });

  it('重新保存选择不会抹掉尚未解决的真实读取错误', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database);
    const adapter = new MonitoringAdapter(config);
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, config);
    const discovered = await service.refreshFeishuMonitoringScope();
    const personId = discovered.people[0]!.id;
    service.updateFeishuMonitoringScope({ personChanges: [{ id: personId, selected: true }], groupIds: [] });
    database.raw.prepare("UPDATE feishu_monitor_target SET access_status = 'restricted', last_error = '403 permission denied' WHERE id = ?").run(personId);
    database.raw.prepare("UPDATE information_source_state SET status = 'admin_required', last_error = '403 permission denied' WHERE source_kind = 'owner_dm'").run();

    const saved = service.updateFeishuMonitoringScope({ personChanges: [{ id: personId, selected: true }], groupIds: [] });

    expect(saved.people.find((item) => item.id === personId)).toMatchObject({ selected: true, accessStatus: 'restricted', lastError: '403 permission denied' });
    expect(service.ownerInformation().sources.find((source) => source.kind === 'owner_dm')).toMatchObject({
      status: 'admin_required',
      issue: { code: 'admin_approval_required', message: '需要飞书管理员批准对应权限。' },
    });
  });

  it('主人身份切换会清空旧来源健康与主人游标', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    seedOwner(database, 'owner-old');
    database.raw.prepare("UPDATE information_source_state SET status = 'ready', last_success_at = '2026-08-11T08:00:00.000Z', last_error = 'old error', details_json = '{\"oldOwner\":true}' WHERE source_kind IN ('owner_dm','owner_mentions','calendar','minutes')").run();
    database.raw.prepare("INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at) VALUES ('feishu_owner','old','{}','2026-08-11T08:00:00.000Z',NULL,'2026-08-11T08:00:00.000Z')").run();
    class OwnerSwitchAdapter extends MonitoringAdapter {
      override async getCurrentUser() {
        return { openId: 'owner-new', unionId: 'union-new', userId: 'user-new', name: '新主人', tenantKey: 'tenant-1' };
      }
      override async getGrantedScopes() { return ['im:chat:read']; }
    }
    const adapter = new OwnerSwitchAdapter(config);
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, config);

    const result = await service.refreshOwnerIdentity();

    expect(result.owner).toMatchObject({ openId: 'owner-new', lastSyncedAt: null });
    expect(result.sources.filter((source) => source.kind !== 'bot_supplement').every((source) => source.status === 'partial' && source.lastSuccessAt === null && source.lastError === null)).toBe(true);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM sync_cursor WHERE integration IN ('feishu_owner','feishu_calendar','feishu_minutes')").get()).toEqual({ count: 0 });
  });
});
