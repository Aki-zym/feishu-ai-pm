import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { startPmServer } = createRequire(import.meta.url)('./pm-runtime.cjs');
const runtimeAuth = {
  token: 'test-token',
  accountAnchor: 'test-account-anchor',
  receiptSecret: 'test-receipt-secret-0123456789abcdef0123456789abcdef',
};

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
    ...runtimeAuth,
  });
  assert.deepEqual(Object.keys(runtime), ['url', 'port', 'alreadyRunning', 'foreign']);
  assert.equal(typeof runtime.stop, 'function');
  assert.equal(typeof runtime.restart, 'function');
  assert.equal((await fetch(`${runtime.url}/`)).status, 200);
  assert.deepEqual(await runtime.stop(), { stopped: true });
  await assert.rejects(fetch(`${runtime.url}/`));
  assert.deepEqual(await runtime.stop(), { stopped: false, alreadyStopped: true });
});

test('status bar skips non-darwin and stop kills the spawned child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-status-bar-'));
  const previousPlatform = process.env.CINDY_PM_STATUS_PLATFORM;
  const previousBinary = process.env.CINDY_PM_STATUS_BINARY;
  const previousSpawn = globalThis.__CINDY_PM_STATUS_SPAWN;
  const spawnCalls = [];
  const statusProcesses = [];
  const killed = [];
  process.env.CINDY_PM_STATUS_BINARY = join(import.meta.dirname, 'pm-runtime.cjs');
  globalThis.__CINDY_PM_STATUS_SPAWN = (...args) => {
    spawnCalls.push(args);
    const child = {
      exited: false,
      once() {},
      unref() {},
      kill() {
        this.exited = true;
        killed.push(args[0]);
      },
    };
    statusProcesses.push(child);
    return child;
  };
  try {
    process.env.CINDY_PM_STATUS_PLATFORM = 'linux';
    const linuxRuntime = await startPmServer({
      port: 0,
      sqlitePath: join(root, 'linux.sqlite'),
      ...runtimeAuth,
    });
    assert.equal(spawnCalls.length, 0);
    await linuxRuntime.stop();

    process.env.CINDY_PM_STATUS_PLATFORM = 'darwin';
    process.env.CINDY_PM_STATUS_BINARY = join(root, 'missing-status-binary');
    const missingBinaryRuntime = await startPmServer({
      port: 0,
      sqlitePath: join(root, 'missing-binary.sqlite'),
      ...runtimeAuth,
    });
    assert.equal(spawnCalls.length, 0);
    await missingBinaryRuntime.stop();

    process.env.CINDY_PM_STATUS_BINARY = join(import.meta.dirname, 'pm-runtime.cjs');
    const macRuntime = await startPmServer({
      port: 0,
      sqlitePath: join(root, 'mac.sqlite'),
      ...runtimeAuth,
    });
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0][1], [macRuntime.url]);
    const restarted = await macRuntime.restart();
    assert.equal(spawnCalls.length, 2);
    assert.deepEqual(killed, [spawnCalls[0][0]]);
    assert.equal(statusProcesses[0].exited, true);
    const shutdown = await fetch(`${restarted.url}/api/runtime/shutdown`, { method: 'POST' });
    assert.equal(shutdown.status, 200);
    await delay(100);
    assert.deepEqual(killed, [spawnCalls[0][0], spawnCalls[1][0]]);
    assert.equal(statusProcesses[1].exited, true);
    await restarted.stop();
  } finally {
    if (previousPlatform === undefined) delete process.env.CINDY_PM_STATUS_PLATFORM;
    else process.env.CINDY_PM_STATUS_PLATFORM = previousPlatform;
    if (previousBinary === undefined) delete process.env.CINDY_PM_STATUS_BINARY;
    else process.env.CINDY_PM_STATUS_BINARY = previousBinary;
    if (previousSpawn === undefined) delete globalThis.__CINDY_PM_STATUS_SPAWN;
    else globalThis.__CINDY_PM_STATUS_SPAWN = previousSpawn;
  }
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
      ...runtimeAuth,
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
    ...runtimeAuth,
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
      ...runtimeAuth,
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

test('restart can rotate the Bearer while preserving receipts under the stable account secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-token-rotation-'));
  const initial = await startPmServer({
    port: 0,
    sqlitePath: join(root, 'pm.sqlite'),
    ...runtimeAuth,
  });
  const sourcePayload = {
    save_request_id: 'runtime-save-before-rotation',
    sources: [{
      client_ref: 'source',
      provider: 'synthetic',
      source_kind: 'synthetic_message',
      stable_message_id: 'runtime-message-before-rotation',
      occurred_at: '2026-08-24T00:01:00.000Z',
      sender_id: 'runtime-sender',
      display_name: '运行时需求方',
      chat_id: 'runtime-chat',
      mentioned_owner: true,
      sender_is_owner: false,
      message_type: 'text',
      text: '轮换前保存的来源。',
      revision: { sequence: 1 },
    }],
  };
  const saved = await fetch(`${initial.url}/api/integrations/cindy/sources`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(sourcePayload),
  });
  assert.equal(saved.status, 200);
  const receipt = (await saved.json()).sources[0].source_receipt;

  const rotated = await initial.restart({
    token: 'rotated-test-token',
    accountAnchor: runtimeAuth.accountAnchor,
    receiptSecret: runtimeAuth.receiptSecret,
  });
  try {
    assert.equal((await fetch(`${rotated.url}/api/integrations/cindy/tasks`, {
      headers: { authorization: 'Bearer test-token' },
    })).status, 401);
    const replay = await fetch(`${rotated.url}/api/integrations/cindy/sources`, {
      method: 'POST',
      headers: { authorization: 'Bearer rotated-test-token', 'content-type': 'application/json' },
      body: JSON.stringify(sourcePayload),
    });
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.duplicate, true);
    assert.equal(replayBody.sources[0].source_receipt, receipt);
    const decision = await fetch(`${rotated.url}/api/integrations/cindy/decisions`, {
      method: 'POST',
      headers: { authorization: 'Bearer rotated-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        decision_request_id: 'runtime-decision-after-rotation',
        batch_id: 'runtime-batch-after-rotation',
        window_id: 'runtime-window-after-rotation',
        window_start: '2026-08-24T00:00:00.000Z',
        window_end: '2026-08-24T00:05:00.000Z',
        snapshot_receipts: [receipt],
        groups: [],
        primary_dispositions: [{ disposition_ref: 'skip', source_receipt: receipt, disposition: 'skip', reason: '合成验证。' }],
      }),
    });
    assert.equal(decision.status, 200);
  } finally {
    await rotated.stop();
  }
});

test('auto-scan switch is available through the bundled runtime and persists in SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-auto-scan-'));
  const runtime = await startPmServer({
    port: 0,
    sqlitePath: join(root, 'pm.sqlite'),
    ...runtimeAuth,
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

test('resident runtime does not start the classifier recovery chain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-no-classifier-'));
  const sqlitePath = join(root, 'pm.sqlite');
  const initial = await startPmServer({
    port: 0,
    sqlitePath,
    ...runtimeAuth,
  });
  await initial.stop();

  const seeded = new DatabaseSync(sqlitePath);
  const now = new Date().toISOString();
  seeded.prepare(
    `INSERT INTO job
      (id, job_type, payload_json, status, attempts, available_at, locked_until, lease_owner,
       max_attempts, retryable, backoff_seconds, cancel_requested_at, idempotency_key,
       source_event_id, thread_id, task_id, trace_id, last_error, result_json, created_at, updated_at)
     VALUES (?, 'classify_source', '{}', 'queued', 0, ?, NULL, NULL, 3, 1, 30, NULL, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
  ).run('classifier-chain-fixture', new Date(Date.now() - 60_000).toISOString(), now, now);
  seeded.close();

  const runtime = await startPmServer({
    port: 0,
    sqlitePath,
    ...runtimeAuth,
  });
  try {
    const check = new DatabaseSync(sqlitePath);
    const row = check.prepare('SELECT status, attempts FROM job WHERE id = ?').get('classifier-chain-fixture');
    check.close();
    assert.deepEqual({ ...row }, { status: 'queued', attempts: 0 });
  } finally {
    await runtime.stop();
  }
});

test('resident runtime exposes two-step Cindy intake and omits all raw-source write routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-cindy-routes-'));
  const runtime = await startPmServer({
    port: 0,
    sqlitePath: join(root, 'pm.sqlite'),
    ...runtimeAuth,
  });
  try {
    assert.equal((await fetch(`${runtime.url}/api/health`)).status, 200);
    assert.equal((await fetch(`${runtime.url}/api/dashboard`)).status, 200);
    for (const path of [
      '/api/integrations/feishu/listener/start',
      '/api/integrations/feishu/listener/stop',
      '/api/integrations/feishu/sync',
      '/api/integrations/feishu/sources/calendar/sync',
      '/api/dev/simulate-message',
      '/api/dev/seed-intake',
    ]) {
      assert.equal((await fetch(`${runtime.url}${path}`, { method: 'POST' })).status, 404, path);
    }
    assert.equal((await fetch(`${runtime.url}/api/integrations/cindy/tasks`)).status, 401);
    assert.equal((await fetch(`${runtime.url}/api/integrations/cindy/sources`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${runtime.url}/api/integrations/cindy/decisions`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${runtime.url}/api/integrations/cindy/intake`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${runtime.url}/api/integrations/cindy/intake`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: '{}',
    })).status, 404);
  } finally {
    await runtime.stop();
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
    ...runtimeAuth,
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
