import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    FEISHU_APP_ID: 'test-app',
    FEISHU_APP_SECRET: 'test-secret',
    FEISHU_SCAN_ENABLED: 'false',
    FEISHU_GROUP_IDS: '',
    FEISHU_SCAN_INTERVAL_SECONDS: '60',
  });
}

class LifecycleFeishuAdapter extends LiveFeishuAdapter {
  startCalls = 0;
  stopCalls = 0;
  failedStarts = 0;

  constructor(config = liveConfig()) {
    super(config.feishu, { client: {} as never });
  }

  override async start() {
    this.startCalls += 1;
    if (this.failedStarts > 0) {
      this.failedStarts -= 1;
      throw new Error('websocket unavailable');
    }
  }

  override async stop() {
    this.stopCalls += 1;
  }
}

describe('PmService 飞书自动启动生命周期', () => {
  const databases: AppDatabase[] = [];

  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    vi.useRealTimers();
  });

  it('未配置真实飞书时安全跳过，不创建后台定时器', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const service = new PmService(database, createAdapters(config), config);

    await expect(service.startFeishu()).resolves.toMatchObject({ ok: false, skipped: true, reason: 'not_configured' });
    await expect(service.stopFeishu()).resolves.toMatchObject({ ok: true, stopped: true, alreadyStopped: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('五类来源都有安全的独立入口，未授权时个人私聊与 @我 都安全跳过', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const adapter = new LifecycleFeishuAdapter(config);
    const service = new PmService(
      database,
      { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter },
      config,
    );

    await expect(service.syncFeishuSource('owner_dm')).resolves.toMatchObject({
      outcome: 'skipped',
      sources: [{ source: 'owner_dm', status: 'skipped', error_code: 'FEISHU_OAUTH_REQUIRED' }],
    });
    await expect(service.syncFeishuSource('owner_mentions')).resolves.toMatchObject({
      outcome: 'skipped',
      sources: [{ source: 'owner_mentions', status: 'skipped', error_code: 'FEISHU_OAUTH_REQUIRED' }],
    });
    await expect(service.syncFeishuSource('bot_supplement')).resolves.toMatchObject({
      outcome: 'skipped',
      sources: [{ source: 'bot_supplement', status: 'skipped' }],
    });
    await expect(service.syncFeishuSource('calendar')).resolves.toMatchObject({
      outcome: 'skipped',
      sources: [{ source: 'calendar', status: 'skipped', error_code: 'FEISHU_OAUTH_REQUIRED' }],
    });
    await expect(service.syncFeishuSource('minutes')).resolves.toMatchObject({
      outcome: 'skipped',
      sources: [{ source: 'minutes', status: 'skipped', error_code: 'FEISHU_OAUTH_REQUIRED' }],
    });
  });

  it('重复或并发启动只建立一套个人信息流 Runner，并发停止只关闭一次', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const adapter = new LifecycleFeishuAdapter(config);
    const service = new PmService(
      database,
      { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter },
      config,
    );

    const [first, second] = await Promise.all([
      service.startFeishu({ refreshOwner: false }),
      service.startFeishu({ refreshOwner: false }),
    ]);

    expect(first).toMatchObject({ ok: true, started: true });
    expect(second).toMatchObject({ ok: true, alreadyStarted: true });
    expect(adapter.startCalls).toBe(1);
    // 机器人补充群扫描关闭时，主人私聊、@我/新群、日历、妙记和文档背景仍有四套周期 Runner。
    expect(vi.getTimerCount()).toBe(4);

    const stopped = await Promise.all([service.stopFeishu(), service.stopFeishu()]);
    expect(stopped.some((item) => 'alreadyStopped' in item && item.alreadyStopped)).toBe(true);
    expect(adapter.stopCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('机器人长连接失败不阻断主人信息流，后续启动可单独重试补充入口', async () => {
    const config = liveConfig();
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const adapter = new LifecycleFeishuAdapter(config);
    adapter.failedStarts = 1;
    const service = new PmService(
      database,
      { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter },
      config,
    );

    await expect(service.startFeishu({ refreshOwner: false })).resolves.toMatchObject({ ok: true, started: true, botSupplementStarted: false });
    expect(adapter.startCalls).toBe(1);
    expect(adapter.stopCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(4);
    expect(service.ownerInformation().sources.find((source) => source.kind === 'bot_supplement')).toMatchObject({ status: 'error' });

    await expect(service.startFeishu({ refreshOwner: false })).resolves.toMatchObject({ ok: true, alreadyStarted: true, botSupplementStarted: true });
    expect(adapter.startCalls).toBe(2);
    expect(vi.getTimerCount()).toBe(4);
    expect(service.ownerInformation().sources.find((source) => source.kind === 'bot_supplement')).toMatchObject({
      status: 'partial',
      issue: { code: 'partial_access' },
    });

    await service.stopFeishu();
    expect(adapter.stopCalls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
