import { buildApp } from './app.js';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { AppDatabase } from './database.js';
import { createAdapters } from './integrations.js';
import { PmService } from './service.js';

const config = loadConfig();

if (config.database.provider !== 'sqlite') {
  throw new Error('当前 Windows 桌面版使用 SQLite；PostgreSQL 仍属于未来部署选项。');
}

const database = new AppDatabase(config.database.sqlitePath);
const adapters = createAdapters(config);
const service = new PmService(database, adapters, config);
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const app = await buildApp(service, { webOrigin: config.webOrigin, webRoot });
service.startRuntimeRecovery();

await app.listen({ port: config.port, host: '127.0.0.1' });

const shutdown = async () => {
  await service.stopRuntimeRecovery();
  await app.close();
  database.close();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
