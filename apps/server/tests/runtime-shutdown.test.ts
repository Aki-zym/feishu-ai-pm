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

  beforeEach(async () => {
    database = new AppDatabase(':memory:', false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createAdapters(config), config);
    shutdown.mockReset();
    app = await buildApp(service, { serveWeb: false, runtimeShutdown: shutdown });
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
});
