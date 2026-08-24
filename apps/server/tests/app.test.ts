import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createCindyAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

describe('本机服务入口', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  const databases: AppDatabase[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const database of databases.splice(0)) database.close();
  });

  async function makeApp(options: Parameters<typeof buildApp>[1] = { serveWeb: false }) {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const config = loadConfig({ NODE_ENV: 'production', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createCindyAdapters(config), config);
    const app = await buildApp(service, options);
    apps.push(app);
    return { app, database };
  }

  it('健康接口返回本地模式', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', mode: 'local-shell', externalConnections: false });
  });

  it('生产装配不暴露 raw-source intake 或 seed 路由且保持零写入', async () => {
    const { app, database } = await makeApp({
      serveWeb: false,
      cindyIntegrationToken: 'production-route-test-token',
      cindyIntegrationAccountAnchor: 'production-route-test-account',
      cindyReceiptSecret: 'production-route-test-receipt-secret-0123456789abcdef',
    });
    const oldRoute = await app.inject({ method: 'POST', url: '/api/dev/simulate-message', payload: { content: 'old' } });
    expect(oldRoute.statusCode).toBe(404);
    const syncRoute = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sync' });
    expect(syncRoute.statusCode).toBe(404);
    const seeded = await app.inject({
      method: 'POST',
      url: '/api/dev/seed-intake',
      remoteAddress: '127.0.0.1',
      payload: { title: '测试候选', describe: '用于 app 合同测试。' },
    });
    expect(seeded.statusCode).toBe(404);
    const rawIntake = await app.inject({
      method: 'POST',
      url: '/api/integrations/cindy/intake',
      headers: { authorization: 'Bearer production-route-test-token' },
      payload: { sources: [{ text: 'raw source should not be accepted' }] },
    });
    expect(rawIntake.statusCode).toBe(404);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
  });
});
