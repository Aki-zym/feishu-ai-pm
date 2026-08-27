import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AilyService } from '../src/aily.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createCindyAdapters } from '../src/integrations.js';
import { LocalCredentialStore } from '../src/local-credential-store.js';
import { PmService } from '../src/service.js';
import { registerSimulatedMessageRoute } from './support/simulated-message-route.js';
import { registerSeedIntakeRoute } from './support/seed-intake-route.js';

// Keep the browser fixture isolated from user configuration and persistent data.
const databaseUrl = process.env.DATABASE_URL ?? ':memory:';
const taskMemoryRoot = process.env.TASK_MEMORY_ROOT;
const runToken = process.env.E2E_RUN_TOKEN;
if (databaseUrl !== ':memory:') throw new Error('E2E fixture requires an in-memory SQLite database.');
if (!taskMemoryRoot) throw new Error('E2E fixture requires an explicit TASK_MEMORY_ROOT.');
if (!runToken || !/^[0-9a-f-]{36}$/i.test(runToken)) throw new Error('E2E fixture requires a valid E2E_RUN_TOKEN.');
const configRoot = resolve(taskMemoryRoot, '..', 'config');

const config = loadConfig({
  NODE_ENV: 'test',
  PORT: process.env.PORT ?? '4310',
  DATABASE_URL: databaseUrl,
  DATABASE_PROVIDER: 'sqlite',
  POSTGRES_URL: '',
  TOOMANYTASKS_CONFIG_ROOT: configRoot,
  CONFIG_ROOT: configRoot,
  TASK_MEMORY_ROOT: taskMemoryRoot,
  FEISHU_EXTERNAL_ENABLED: 'false',
  FEISHU_SCAN_ENABLED: 'false',
  FEISHU_APP_ID: '',
  FEISHU_APP_SECRET: '',
  FEISHU_OAUTH_REDIRECT_URI: '',
  FEISHU_OAUTH_SCOPES: '',
  FEISHU_ENCRYPT_KEY: '',
  FEISHU_VERIFICATION_TOKEN: '',
  TOKEN_ENCRYPTION_KEY: '',
  LLM_PROVIDER: 'rule_mock',
  LLM_MODEL: '',
  LLM_API_BASE: '',
  LLM_API_KEY: '',
  WORKSPACE_READ_ENABLED: 'false',
  WORKSPACE_WRITE_ENABLED: 'false',
  WORKSPACE_ALLOWED_PATHS: '[]',
});
const database = new AppDatabase(config.database.sqlitePath);
const service = new PmService(database, createCindyAdapters(config), config);
const credentials = new LocalCredentialStore(config);
await credentials.load();
const ailyService = new AilyService(credentials);
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const app = await buildApp(service, { webOrigin: config.webOrigin, webRoot, ailyService });
registerSimulatedMessageRoute(app, service, {
  testOnly: true,
  nodeEnv: config.nodeEnv,
  databaseProvider: config.database.provider,
  databaseUrl: config.database.url,
});
registerSeedIntakeRoute(app, service, {
  testOnly: true,
  nodeEnv: config.nodeEnv,
  databaseProvider: config.database.provider,
  databaseUrl: config.database.url,
});
let shuttingDown = false;

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  database.close();
};

const handleShutdownRequest = () => {
  void shutdown().then(() => {
    if (process.connected) process.disconnect();
  }).catch((error) => {
    process.stderr.write(`E2E fixture shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
};
process.once('SIGINT', handleShutdownRequest);
process.once('SIGTERM', handleShutdownRequest);
process.once('disconnect', handleShutdownRequest);
process.on('message', (message) => {
  if (!message || typeof message !== 'object' || !('type' in message) || !('runToken' in message) || message.runToken !== runToken) return;
  if (message.type === 'shutdown') {
    handleShutdownRequest();
  } else if (message.type === 'fault-exit-zero' && process.env.E2E_ALLOW_FAULT_EXIT_ZERO === 'true') {
    process.exit(0);
  }
});

try {
  if (process.env.E2E_FAIL_STARTUP === 'true') throw new Error('Injected E2E fixture startup failure.');
  await app.listen({ port: config.port, host: '127.0.0.1' });
  if (process.send) process.send({ type: 'ready', runToken, port: config.port });
} catch (error) {
  await shutdown();
  throw error;
}
