import { buildApp } from './app.js';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { AppDatabase } from './database.js';
import { createCindyAdapters } from './integrations.js';
import { PmService } from './service.js';

const config = loadConfig();

if (config.database.provider !== 'sqlite') {
  throw new Error('当前 Windows 桌面版使用 SQLite；PostgreSQL 仍属于未来部署选项。');
}

const database = new AppDatabase(config.database.sqlitePath);
const adapters = createCindyAdapters(config);
const service = new PmService(database, adapters, config);
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
let app: Awaited<ReturnType<typeof buildApp>>;
let shutdownInProgress: Promise<void> | null = null;
let restartInProgress: Promise<void> | null = null;
const listenOptions = { port: config.port, host: '127.0.0.1' } as const;
const shutdown = async () => {
  if (shutdownInProgress) return shutdownInProgress;
  shutdownInProgress = (async () => {
    await app.close();
    database.close();
  })();
  return shutdownInProgress;
};
const shutdownAndExit = async () => {
  await shutdown();
  if (config.nodeEnv !== 'test') process.exit(0);
};

const buildRuntimeApp = () => buildApp(service, {
  webOrigin: config.webOrigin,
  webRoot,
  cindyIntegrationToken: config.cindyIntegrationToken,
  cindyIntegrationAccountAnchor: config.cindyAccountAnchor,
  cindyReceiptSecret: config.cindyReceiptSecret,
  runtimeShutdown: shutdownAndExit,
  runtimeRestart: restart,
});

const restart = async () => {
  if (restartInProgress) return restartInProgress;
  restartInProgress = (async () => {
    await app.close();
    app = await buildRuntimeApp();
    await app.listen(listenOptions);
  })();
  try {
    await restartInProgress;
  } finally {
    restartInProgress = null;
  }
};

app = await buildRuntimeApp();

await app.listen(listenOptions);

process.on('SIGINT', () => { void shutdownAndExit(); });
process.on('SIGTERM', () => { void shutdownAndExit(); });
