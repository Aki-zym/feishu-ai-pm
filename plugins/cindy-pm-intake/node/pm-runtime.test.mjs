import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { startPmServer } = createRequire(import.meta.url)('./pm-runtime.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

test('stop closes the owned Fastify listener and SQLite handle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-stop-'));
  const runtime = await startPmServer({
    port: 0,
    sqlitePath: join(root, 'pm.sqlite'),
    token: 'test-token',
  });
  assert.deepEqual(Object.keys(runtime), ['url', 'port', 'alreadyRunning', 'foreign']);
  assert.equal(typeof runtime.stop, 'function');
  assert.equal(typeof runtime.restart, 'function');
  assert.equal((await fetch(`${runtime.url}/`)).status, 200);
  assert.deepEqual(await runtime.stop(), { stopped: true });
  await assert.rejects(fetch(`${runtime.url}/`));
  assert.deepEqual(await runtime.stop(), { stopped: false, alreadyStopped: true });
});

test('foreign stop returns an explicit error and leaves the foreign listener alive', async () => {
  const foreign = createServer((request, response) => {
    response.statusCode = request.url === '/api/integrations/cindy/tasks' ? 404 : 200;
    response.end('foreign');
  });
  const port = await listen(foreign);
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-foreign-'));
  try {
    const runtime = await startPmServer({
      port,
      sqlitePath: join(root, 'pm.sqlite'),
      token: 'test-token',
    });
    assert.equal(runtime.foreign, true);
    assert.deepEqual(await runtime.stop(), {
      stopped: false,
      error_code: 'PM_FOREIGN_PROCESS',
      error: '本机任务库端口由外来进程占用，未执行停止。',
    });
    assert.deepEqual(await runtime.restart(), {
      restarted: false,
      error_code: 'PM_FOREIGN_PROCESS',
      error: '本机任务库端口由外来进程占用，未执行重启。',
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  } finally {
    await close(foreign);
  }
});

test('restart reopens the same listener without scheduling process exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-restart-'));
  const port = await reservePort();
  const previousNodeEnv = process.env.NODE_ENV;
  const previousExit = process.exit;
  const exitCodes = [];
  process.env.NODE_ENV = 'production';
  process.exit = (code) => exitCodes.push(code);
  const runtime = await startPmServer({
    port,
    sqlitePath: join(root, 'pm.sqlite'),
    token: 'test-token',
  });
  try {
    const restarted = await runtime.restart();
    assert.equal(restarted.alreadyRunning, false);
    assert.equal(restarted.foreign, false);
    assert.equal(restarted.port > 0, true);
    assert.equal((await fetch(restarted.url + '/')).status, 200);
    await delay(200);
    assert.deepEqual(exitCodes, []);

    const response = await fetch(`${restarted.url}/api/runtime/restart`, { method: 'POST' });
    assert.equal(response.status, 200);
    await delay(200);
    assert.equal((await fetch(restarted.url + '/')).status, 200);
    assert.deepEqual(exitCodes, []);

    process.env.NODE_ENV = 'test';
    const current = await startPmServer({
      port,
      sqlitePath: join(root, 'pm.sqlite'),
      token: 'test-token',
    });
    assert.equal(current.alreadyRunning, true);
    await current.stop();
    await assert.rejects(fetch(`${restarted.url}/`));
  } finally {
    process.exit = previousExit;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('auto-scan switch is available through the bundled runtime and persists in SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-auto-scan-'));
  const runtime = await startPmServer({
    port: 0,
    sqlitePath: join(root, 'pm.sqlite'),
    token: 'test-token',
  });
  try {
    const initial = await fetch(`${runtime.url}/api/runtime/auto-scan`);
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { enabled: false });

    const enabled = await fetch(`${runtime.url}/api/runtime/auto-scan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), { enabled: true });

    const persisted = await runtime.restart();
    const afterRestart = await fetch(`${persisted.url}/api/runtime/auto-scan`);
    assert.deepEqual(await afterRestart.json(), { enabled: true });
    await persisted.stop();
  } catch (error) {
    await runtime.stop();
    throw error;
  }
});

test('shutdown still schedules process exit outside the test environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-exit-'));
  const previousNodeEnv = process.env.NODE_ENV;
  const previousExit = process.exit;
  const exitCodes = [];
  process.env.NODE_ENV = 'production';
  process.exit = (code) => exitCodes.push(code);
  const runtime = await startPmServer({
    port: 0,
    sqlitePath: join(root, 'pm.sqlite'),
    token: 'test-token',
  });
  try {
    const response = await fetch(`${runtime.url}/api/runtime/shutdown`, { method: 'POST' });
    assert.equal(response.status, 200);
    await delay(240);
    assert.deepEqual(exitCodes, [0]);
  } finally {
    await runtime.stop();
    process.exit = previousExit;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
