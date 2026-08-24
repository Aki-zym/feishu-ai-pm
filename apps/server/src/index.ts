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
let app: Awaited<ReturnType<typeof buildApp>>;
let shutdownInProgress: Promise<void> | null = null;
const shutdown = async () => {
  if (shutdownInProgress) return shutdownInProgress;
  shutdownInProgress = (async () => {
    await service.stopRuntimeRecovery();
    await app.close();
    database.close();
  })();
  return shutdownInProgress;
};
const shutdownAndExit = async () => {
  await shutdown();
  if (config.nodeEnv !== 'test') process.exit(0);
};

app = await buildApp(service, {
  webOrigin: config.webOrigin,
  webRoot,
  cindyIntegrationToken: config.cindyIntegrationToken,
  runtimeShutdown: shutdownAndExit,
});
service.startRuntimeRecovery();

await app.listen({ port: config.port, host: '127.0.0.1' });

process.on('SIGINT', () => { void shutdownAndExit(); });
process.on('SIGTERM', () => { void shutdownAndExit(); });
