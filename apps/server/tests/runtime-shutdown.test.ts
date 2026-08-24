import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

describe('本机后台退出接口', () => {
  let database: AppDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const shutdown = vi.fn();
  const restart = vi.fn();

  beforeEach(async () => {
    database = new AppDatabase(':memory:', false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createAdapters(config), config);
    shutdown.mockReset();
    restart.mockReset();
    app = await buildApp(service, { serveWeb: false, runtimeShutdown: shutdown, runtimeRestart: restart });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('只允许回环地址，并在成功响应后调度后台关闭', async () => {
    const remote = await app.inject({
      method: 'POST',
      url: '/api/runtime/shutdown',
      remoteAddress: '203.0.113.10',
    });
    expect(remote.statusCode).toBe(403);
    expect(shutdown).not.toHaveBeenCalled();

    const local = await app.inject({
      method: 'POST',
      url: '/api/runtime/shutdown',
      remoteAddress: '127.0.0.1',
    });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({ message: expect.stringContaining('4310') });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('只允许回环地址，并在成功响应后调度后台重启', async () => {
    const remote = await app.inject({
      method: 'POST',
      url: '/api/runtime/restart',
      remoteAddress: '203.0.113.10',
    });
    expect(remote.statusCode).toBe(403);
    expect(restart).not.toHaveBeenCalled();

    const local = await app.inject({
      method: 'POST',
      url: '/api/runtime/restart',
      remoteAddress: '127.0.0.1',
    });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({ message: expect.stringContaining('4310') });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe('本机后台重启接口', () => {
  let database: AppDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const restart = vi.fn();

  beforeEach(async () => {
    database = new AppDatabase(':memory:', false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createAdapters(config), config);
    restart.mockReset();
    app = await buildApp(service, { serveWeb: false, runtimeRestart: restart });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('只允许回环地址，响应后调度重启并拒绝重复请求', async () => {
    const remote = await app.inject({
      method: 'POST',
      url: '/api/runtime/restart',
      remoteAddress: '203.0.113.10',
    });
    expect(remote.statusCode).toBe(403);
    expect(restart).not.toHaveBeenCalled();

    const local = await app.inject({
      method: 'POST',
      url: '/api/runtime/restart',
      remoteAddress: '127.0.0.1',
    });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({ message: expect.stringContaining('4310') });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/runtime/restart',
      remoteAddress: '127.0.0.1',
    });
    expect(duplicate.statusCode).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe('本机后台重启 listener', () => {
  it('重新监听相同端口并保持 SQLite 连接可用', async () => {
    const database = new AppDatabase(':memory:', false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createAdapters(config), config);
    let activeApp: Awaited<ReturnType<typeof buildApp>>;
    let restartInProgress: Promise<void> | null = null;
    const restart = async () => {
      if (restartInProgress) return restartInProgress;
      restartInProgress = (async () => {
        const current = activeApp;
        const address = current.server.address();
        if (!address || typeof address === 'string') throw new Error('测试 listener 地址不可用。');
        await current.close();
        activeApp = await buildApp(service, { serveWeb: false, logger: false, runtimeRestart: restart });
        await activeApp.listen({ host: '127.0.0.1', port: address.port });
      })();
      try {
        await restartInProgress;
      } finally {
        restartInProgress = null;
      }
    };
    activeApp = await buildApp(service, { serveWeb: false, logger: false, runtimeRestart: restart });
    await activeApp.listen({ host: '127.0.0.1', port: 0 });
    const initialAddress = activeApp.server.address();
    if (!initialAddress || typeof initialAddress === 'string') throw new Error('测试 listener 地址不可用。');
    const port = initialAddress.port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runtime/restart`, { method: 'POST' });
      expect(response.status).toBe(200);
      let healthStatus = 0;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        try {
          healthStatus = (await fetch(`http://127.0.0.1:${port}/api/health`)).status;
          if (healthStatus === 200) break;
        } catch {
          // The old listener is expected to be briefly unavailable while it is replaced.
        }
      }
      expect(healthStatus).toBe(200);
      const restartedAddress = activeApp.server.address();
      expect(restartedAddress && typeof restartedAddress !== 'string' ? restartedAddress.port : null).toBe(port);
      expect(database.raw.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
    } finally {
      await activeApp.close();
      database.close();
    }
  });
});
