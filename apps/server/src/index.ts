import { buildApp } from './app.js';
import { fileURLToPath } from 'node:url';
import { AilyScanScheduler, AilyService } from './aily.js';
import { loadConfig } from './config.js';
import { AppDatabase } from './database.js';
import { createCindyAdapters } from './integrations.js';
import { LocalCredentialStore } from './local-credential-store.js';
import { PmService } from './service.js';

const config = loadConfig();

if (config.database.provider !== 'sqlite') {
  throw new Error('当前本机任务库使用 SQLite；PostgreSQL 仍属于未来部署选项。');
}

const database = new AppDatabase(config.database.sqlitePath);
const adapters = createCindyAdapters(config);
const service = new PmService(database, adapters, config);
const credentials = new LocalCredentialStore(config);
await credentials.load();
const cindyIntegrationToken = await credentials.ensureIntegrationToken(config.cindyIntegrationToken);
const ailyService = new AilyService(credentials);
const ailyScheduler = new AilyScanScheduler(ailyService, service);
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
let app: Awaited<ReturnType<typeof buildApp>>;
let shutdownInProgress: Promise<void> | null = null;
let restartInProgress: Promise<void> | null = null;
const listenOptions = { port: config.port, host: '127.0.0.1' } as const;
const shutdown = async () => {
  if (shutdownInProgress) return shutdownInProgress;
  shutdownInProgress = (async () => {
    await ailyScheduler.stop();
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
  cindyIntegrationToken,
  ailyService,
  runtimeShutdown: shutdownAndExit,
  runtimeRestart: restart,
});

const restart = async () => {
  if (restartInProgress) return restartInProgress;
  restartInProgress = (async () => {
    await ailyScheduler.stop();
    await app.close();
    app = await buildRuntimeApp();
    await app.listen(listenOptions);
    ailyScheduler.start();
  })();
  try {
    await restartInProgress;
  } finally {
    restartInProgress = null;
  }
};

app = await buildRuntimeApp();

await app.listen(listenOptions);
ailyScheduler.start();

process.on('SIGINT', () => { void shutdownAndExit(); });
process.on('SIGTERM', () => { void shutdownAndExit(); });
