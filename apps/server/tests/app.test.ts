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

  it('看板通知接口保持可用', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/notifications?unreadOnly=true&limit=20' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it('日志与诊断路由复用服务层实现', async () => {
    const { app } = await makeApp();

    const logs = await app.inject({ method: 'GET', url: '/api/logs?level=info&limit=5' });
    expect(logs.statusCode).toBe(200);
    expect(logs.json()).toEqual(expect.objectContaining({
      logs: expect.any(Array),
      decisions: expect.any(Array),
      health: expect.any(Array),
      corrections: expect.any(Array),
    }));

    const invalidLogs = await app.inject({ method: 'GET', url: '/api/logs?level=invalid' });
    expect(invalidLogs.statusCode).toBe(400);

    const diagnostics = await app.inject({ method: 'GET', url: '/api/diagnostics' });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toEqual(expect.objectContaining({
      diagnosticBundleVersion: expect.any(String),
      health: expect.any(Object),
      counts: expect.any(Object),
    }));

    const cleanup = await app.inject({ method: 'POST', url: '/api/diagnostics/cleanup' });
    expect(cleanup.statusCode).toBe(200);
    expect(cleanup.json()).toEqual(expect.objectContaining({
      logs: expect.any(Number),
      decisions: expect.any(Number),
      health: expect.any(Number),
    }));

    const cleared = await app.inject({ method: 'DELETE', url: '/api/logs?includeCorrections=false' });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual(expect.objectContaining({
      logs: expect.any(Number),
      decisions: expect.any(Number),
      health: expect.any(Number),
      corrections: 0,
    }));
  });

  it('生产装配保留 loopback seed，旧 simulate-message 与 Feishu sync 均无路由', async () => {
    const { app, database } = await makeApp();
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
    expect(seeded.statusCode).toBe(200);
    expect(seeded.json().candidate_id).toEqual(expect.any(String));
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM candidate_request WHERE state = 'pending'").get()).toEqual({ count: 1 });
  });
});
