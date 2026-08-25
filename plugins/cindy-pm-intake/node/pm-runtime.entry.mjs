import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

import { buildApp } from '../../../apps/server/src/app.ts';
import { loadConfig } from '../../../apps/server/src/config.ts';
import { AppDatabase } from '../../../apps/server/src/database.ts';
import { createCindyAdapters } from '../../../apps/server/src/integrations/cindy.ts';
import { PmService } from '../../../apps/server/src/service.ts';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4310;
const INTEGRATION_PATH = '/api/integrations/cindy/tasks';
const DEFAULT_WEB_ROOT = resolve(__dirname, '..', 'web-dist');
const DEFAULT_STATUS_BAR_BINARY = resolve(__dirname, 'macos-status', 'TooManyTasksStatus');
let ownedRuntime = null;

function normalizePort(value) {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('本机任务库端口必须是 0 到 65535 的整数。');
  }
  return port;
}

function normalizeHost(value) {
  const host = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_HOST;
  return host;
}

function formatHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function serverUrl(host, port) {
  return `http://${formatHost(host)}:${port}`;
}

function normalizeSqlitePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('sqlitePath 必须是本机 SQLite 文件路径。');
  }
  return value === ':memory:' ? value : resolve(value);
}

function runtimeConfig({ host, port, sqlitePath, token }) {
  const databaseUrl = sqlitePath === ':memory:' ? sqlitePath : `file:${sqlitePath}`;
  return loadConfig({
    NODE_ENV: 'production',
    PORT: String(port || DEFAULT_PORT),
    WEB_ORIGIN: serverUrl(host, port),
    DATABASE_URL: databaseUrl,
    DATABASE_PROVIDER: 'sqlite',
    FEISHU_EXTERNAL_ENABLED: 'false',
    FEISHU_SCAN_ENABLED: 'false',
    LLM_PROVIDER: 'rule_mock',
    WORKSPACE_MODE: 'reference_only',
    WORKSPACE_READ_ENABLED: 'false',
    WORKSPACE_WRITE_ENABLED: 'false',
    CINDY_INTEGRATION_TOKEN: token,
  });
}

async function canReachPmEndpoint(url, token) {
  try {
    const response = await fetch(`${url}${INTEGRATION_PATH}`, {
      method: 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(1_500),
    });
    // Only HTTP 200 proves that the current Cindy token owns the local service.
    // Any other response keeps the port in the foreign/mismatched state.
    return response.status === 200;
  } catch {
    return false;
  }
}

async function closeOwnedResources(app, database) {
  const failures = [];
  const server = app?.server;
  try {
    if (app) await app.close();
  } catch {
    failures.push('fastify');
  }
  if (server?.listening) {
    try {
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    } catch {
      failures.push('fastify_server');
    }
  }
  if (server?.listening !== false) failures.push('fastify_listening');
  try {
    database?.close();
  } catch {
    failures.push('sqlite');
  }
  return failures;
}

function resultWithLifecycle(payload, stop, restart) {
  Object.defineProperty(payload, 'stop', {
    value: stop,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(payload, 'restart', {
    value: restart,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return payload;
}

function noOpStop(errorCode, message) {
  return async () => ({
    stopped: false,
    error_code: errorCode,
    error: message,
  });
}

function noOpRestart(errorCode, message) {
  return async () => ({
    restarted: false,
    error_code: errorCode,
    error: message,
  });
}

function statusBarBinaryPath() {
  return typeof process.env.CINDY_PM_STATUS_BINARY === 'string' && process.env.CINDY_PM_STATUS_BINARY.trim()
    ? resolve(process.env.CINDY_PM_STATUS_BINARY)
    : DEFAULT_STATUS_BAR_BINARY;
}

function killExistingStatusBars(binaryPath) {
  const binaryName = basename(binaryPath);
  if (process.env.NODE_ENV === 'test' && typeof globalThis.__CINDY_PM_STATUS_KILL_EXISTING === 'function') {
    globalThis.__CINDY_PM_STATUS_KILL_EXISTING(binaryName);
    return;
  }
  if (process.platform !== 'darwin' || binaryName !== 'TooManyTasksStatus' || typeof process.getuid !== 'function') return;

  let output = '';
  try {
    output = execFileSync(
      'pgrep',
      ['-x', '-u', String(process.getuid()), binaryName],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return;
  }

  for (const value of output.split(/\s+/)) {
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The old status item may have exited between pgrep and kill.
    }
  }
}

function startStatusBar(url) {
  const binaryPath = statusBarBinaryPath();
  const runtimePlatform = process.env.NODE_ENV === 'test'
    ? process.env.CINDY_PM_STATUS_PLATFORM || process.platform
    : process.platform;
  if (runtimePlatform !== 'darwin' || !existsSync(binaryPath)) return null;
  try {
    killExistingStatusBars(binaryPath);
    const spawnProcess = process.env.NODE_ENV === 'test' && typeof globalThis.__CINDY_PM_STATUS_SPAWN === 'function'
      ? globalThis.__CINDY_PM_STATUS_SPAWN
      : spawn;
    const child = spawnProcess(binaryPath, [url], { stdio: 'ignore' });
    child.once?.('error', () => undefined);
    child.unref?.();
    return child;
  } catch {
    return null;
  }
}

function stopStatusBar(child) {
  if (!child) return;
  try {
    child.kill();
  } catch {
    // The status item may have already exited during runtime shutdown.
  }
}

function scheduleProcessExit() {
  if (process.env.NODE_ENV === 'test') return;
  setTimeout(() => process.exit(0), 150);
}

/**
 * Start the bundled local task service for the Cindy resident worker.
 *
 * The runtime intentionally does not start Feishu polling or classifier
 * scans. Cindy submits already-reviewed intake proposals through the guarded
 * integration routes; external collection remains outside this resident worker.
 */
export async function startPmServer({
  port: requestedPort,
  host: requestedHost,
  sqlitePath: requestedSqlitePath,
  token: requestedToken,
  webRoot: requestedWebRoot,
} = {}) {
  const host = normalizeHost(requestedHost);
  const port = normalizePort(requestedPort);
  const sqlitePath = normalizeSqlitePath(requestedSqlitePath);
  const token = typeof requestedToken === 'string' ? requestedToken : '';
  const webRoot = resolve(
    typeof requestedWebRoot === 'string' && requestedWebRoot.trim()
      ? requestedWebRoot
      : DEFAULT_WEB_ROOT,
  );

  if (!existsSync(resolve(webRoot, 'index.html'))) {
    throw new Error(`本机任务库网页资源缺少 index.html：${webRoot}`);
  }

  if (ownedRuntime && ownedRuntime.host === host && ownedRuntime.requestedPort === port) {
    return resultWithLifecycle({
      url: ownedRuntime.url,
      port: ownedRuntime.port,
      alreadyRunning: true,
      foreign: false,
    }, ownedRuntime.stop, ownedRuntime.restart);
  }

  // Avoid opening or mutating SQLite when the resident server is already up.
  // This also makes repeated worker initialization idempotent.
  if (port !== 0) {
    const url = serverUrl(host, port);
    if (await canReachPmEndpoint(url, token)) {
      return resultWithLifecycle(
        { url, port, alreadyRunning: true, foreign: false },
        noOpStop('PM_ALREADY_RUNNING', '本机任务库由其他进程持有，未执行停止。'),
        noOpRestart('PM_ALREADY_RUNNING', '本机任务库由其他进程持有，未执行重启。'),
      );
    }
  }

  if (sqlitePath !== ':memory:') await mkdir(dirname(sqlitePath), { recursive: true });

  let database;
  let app;
  let statusBarProcess = null;
  let stopOwnedRuntime;
  try {
    const config = runtimeConfig({ host, port, sqlitePath, token });
    database = new AppDatabase(config.database.sqlitePath);
    // The resident worker receives Cindy proposals. It deliberately does not
    // construct a legacy semantic adapter or any Feishu scanning adapter.
    const service = new PmService(database, createCindyAdapters(config), config);
    let stopInFlight = null;
    let stopResult = null;
    let restartInFlight = null;
    let restartOwnedRuntime;
    stopOwnedRuntime = async ({ scheduleExit = true } = {}) => {
      if (stopResult?.stopped) return { stopped: false, alreadyStopped: true };
      if (stopInFlight) return stopInFlight;
      stopInFlight = (async () => {
        stopStatusBar(statusBarProcess);
        statusBarProcess = null;
        const failures = await closeOwnedResources(app, database);
        if (failures.length) {
          stopResult = {
            stopped: false,
            error_code: 'PM_STOP_FAILED',
            error: `本机任务库停止未完全完成：${failures.join('、')}。`,
          };
          stopInFlight = null;
          return stopResult;
        }
        if (ownedRuntime?.app === app) ownedRuntime = null;
        stopResult = { stopped: true };
        if (scheduleExit) scheduleProcessExit();
        return stopResult;
      })();
      return stopInFlight;
    };
    const runtimeOptions = { port, host, sqlitePath, token, webRoot };
    restartOwnedRuntime = async () => {
      if (restartInFlight) return restartInFlight;
      restartInFlight = (async () => {
        const stopped = await stopOwnedRuntime({ scheduleExit: false });
        if (!stopped.stopped) return stopped;
        return startPmServer(runtimeOptions);
      })();
      try {
        return await restartInFlight;
      } finally {
        restartInFlight = null;
      }
    };
    app = await buildApp(service, {
      cindyRuntime: true,
      webOrigin: serverUrl(host, port),
      webRoot,
      cindyIntegrationToken: token,
      logger: false,
      runtimeShutdown: async () => {
        const result = await stopOwnedRuntime();
        if (!result.stopped && !result.alreadyStopped) throw new Error(result.error || '本机任务库停止失败。');
      },
      runtimeRestart: async () => {
        const result = await restartOwnedRuntime();
        if (!result?.url || result.foreign) throw new Error(result?.error || '本机任务库重启失败。');
      },
    });
    await app.listen({ port, host });

    const address = app.server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    const payload = {
      url: serverUrl(host, actualPort),
      port: actualPort,
      alreadyRunning: false,
      foreign: false,
    };
    statusBarProcess = startStatusBar(payload.url);
    ownedRuntime = {
      host,
      requestedPort: port,
      url: payload.url,
      port: actualPort,
      app,
      database,
      statusBarProcess,
      stop: stopOwnedRuntime,
      restart: restartOwnedRuntime,
    };
    return resultWithLifecycle(payload, stopOwnedRuntime, restartOwnedRuntime);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
      const url = serverUrl(host, port);
      if (await canReachPmEndpoint(url, token)) {
        await closeOwnedResources(app, database);
        return resultWithLifecycle(
          { url, port, alreadyRunning: true, foreign: false },
          noOpStop('PM_ALREADY_RUNNING', '本机任务库由其他进程持有，未执行停止。'),
          noOpRestart('PM_ALREADY_RUNNING', '本机任务库由其他进程持有，未执行重启。'),
        );
      }
      await closeOwnedResources(app, database);
      console.warn(`本机任务库端口 ${url} 已被其他进程占用；插件不会抢占该端口。`);
      return resultWithLifecycle(
        { url, port, alreadyRunning: false, foreign: true },
        noOpStop('PM_FOREIGN_PROCESS', '本机任务库端口由外来进程占用，未执行停止。'),
        noOpRestart('PM_FOREIGN_PROCESS', '本机任务库端口由外来进程占用，未执行重启。'),
      );
    }
    stopStatusBar(statusBarProcess);
    statusBarProcess = null;
    await closeOwnedResources(app, database);
    throw error;
  }
}
