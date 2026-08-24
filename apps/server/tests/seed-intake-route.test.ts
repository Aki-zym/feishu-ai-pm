import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createCindyAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';
import { registerSeedIntakeRoute } from './support/seed-intake-route.js';

describe('浏览器测试模拟需求入口', () => {
  let database: AppDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    database = new AppDatabase(':memory:', false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createCindyAdapters(config), config);
    app = await buildApp(service, { serveWeb: false });
    registerSeedIntakeRoute(app, service, {
      testOnly: true,
      nodeEnv: config.nodeEnv,
      databaseProvider: config.database.provider,
      databaseUrl: config.database.url,
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('只接受 127.0.0.1，并创建 pending candidate 且不创建 task', async () => {
    const remote = await app.inject({
      method: 'POST',
      url: '/api/dev/seed-intake',
      remoteAddress: '203.0.113.10',
      payload: { title: '远端不应写入' },
    });
    expect(remote.statusCode).toBe(403);

    const local = await app.inject({
      method: 'POST',
      url: '/api/dev/seed-intake',
      remoteAddress: '127.0.0.1',
      payload: {
        title: 'HTML 验收候选',
        describe: '用于检查候选卡片的标题和描述。',
        background: '浏览器测试需要一条可复现的 pending 候选。',
      },
    });
    expect(local.statusCode).toBe(200);
    const candidateId = local.json().candidate_id as string;
    expect(candidateId).toMatch(/^cand_/u);
    const candidate = database.raw.prepare('SELECT title, describe, background, state, accepted_task_id FROM candidate_request WHERE id = ?').get(candidateId) as Record<string, unknown>;
    expect(candidate).toEqual({
      title: 'HTML 验收候选',
      describe: '用于检查候选卡片的标题和描述。',
      background: '浏览器测试需要一条可复现的 pending 候选。',
      state: 'pending',
      accepted_task_id: null,
    });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
  });

  it('生产 buildApp + loopback 可写入 pending 候选且不创建 task', async () => {
    const guardedDatabase = new AppDatabase(':memory:', false);
    const config = loadConfig({ NODE_ENV: 'production', DATABASE_URL: ':memory:' });
    const guardedService = new PmService(guardedDatabase, createCindyAdapters(config), config);
    const guardedApp = await buildApp(guardedService, { serveWeb: false, logger: false });
    try {
      const remote = await guardedApp.inject({
        method: 'POST',
        url: '/api/dev/seed-intake',
        remoteAddress: '203.0.113.10',
        payload: { title: '远端不应写入' },
      });
      expect(remote.statusCode).toBe(403);

      const local = await guardedApp.inject({
        method: 'POST',
        url: '/api/dev/seed-intake',
        remoteAddress: '127.0.0.1',
        payload: {
          title: '生产浏览器测试候选',
          describe: '用于正式 4310 页面验收。',
          background: '插件 resident runtime 需要本机 seed 数据。',
        },
      });
      expect(local.statusCode).toBe(200);
      const candidateId = local.json().candidate_id as string;
      const candidate = guardedDatabase.raw.prepare('SELECT title, describe, background, state, accepted_task_id FROM candidate_request WHERE id = ?').get(candidateId) as Record<string, unknown>;
      expect(candidate).toEqual({
        title: '生产浏览器测试候选',
        describe: '用于正式 4310 页面验收。',
        background: '插件 resident runtime 需要本机 seed 数据。',
        state: 'pending',
        accepted_task_id: null,
      });
      expect(guardedDatabase.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
    } finally {
      await guardedApp.close();
      guardedDatabase.close();
    }
  });

  it('测试装配 guard 拒绝非 test 或持久化配置', async () => {
    const guardedDatabase = new AppDatabase(':memory:', false);
    const config = loadConfig({ NODE_ENV: 'production', DATABASE_URL: ':memory:' });
    const guardedService = new PmService(guardedDatabase, createCindyAdapters(config), config);
    const guardedApp = await buildApp(guardedService, { serveWeb: false, logger: false });
    try {
      expect(() => registerSeedIntakeRoute(guardedApp, guardedService, {
        testOnly: true,
        nodeEnv: config.nodeEnv,
        databaseProvider: config.database.provider,
        databaseUrl: config.database.url,
      })).toThrow('只允许在 test + sqlite :memory: 装配中注册');
      expect(() => registerSeedIntakeRoute(guardedApp, guardedService, {
        testOnly: true,
        nodeEnv: 'test',
        databaseProvider: 'sqlite',
        databaseUrl: 'file:./var/persistent.sqlite',
      })).toThrow('只允许在 test + sqlite :memory: 装配中注册');
    } finally {
      await guardedApp.close();
      guardedDatabase.close();
    }
  });
});
