import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const workerPath = path.resolve(import.meta.dirname, 'worker.cjs');
const tokenRoot = mkdtempSync(path.join(os.tmpdir(), 'toomanytasks-token-'));
writeFileSync(path.join(tokenRoot, 'cindy-integration-token'), 'test-token\n', { mode: 0o600 });
process.on('exit', () => rmSync(tokenRoot, { recursive: true, force: true }));

function createCindyFixture({ source = 'desktop', orcaRole = null, sessionId = 'session-a' } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cindy-pm-worker-'));
  const database = new DatabaseSync(path.join(directory, 'cindy-test.db'));
  database.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, orca_role TEXT); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, agent_meta TEXT, rewind_at INTEGER);');
  database.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(sessionId, source, orcaRole);
  return {
    directory,
    insert(id, role, content, createdAt, agentMeta = null) {
      database.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, NULL)').run(id, sessionId, role, content, createdAt, agentMeta);
    },
    close() { database.close(); },
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

function callWorkerWithDataDir(request, userDataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CINDY_PM_TEST_USER_DATA_DIR: userDataDir,
        TOOMANYTASKS_CONFIG_ROOT: tokenRoot,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      child.kill();
      try { resolve(JSON.parse(stdout.slice(0, newline))); } catch (error) { reject(error); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => { if (!stdout) reject(new Error(stderr || `worker exited ${code}`)); });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function callWorker(request, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], {
      env: { ...process.env, TOOMANYTASKS_CONFIG_ROOT: tokenRoot, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      child.kill();
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!stdout && code !== 0) reject(new Error(stderr || `worker exited ${code}`));
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function callWorkerWithAilySdk(request, { status = 'Completed', text = 'Aily 摘要结果。', throwError = null } = {}) {
  return new Promise((resolve, reject) => {
    const bootstrap = `
      const Module = require('node:module');
      const workerPath = ${JSON.stringify(workerPath)};
      const originalLoad = Module._load;
      Module._load = function load(requestName, parent, isMain) {
        if (parent && parent.filename === workerPath && requestName === './aily-sdk.cjs') {
          return {
            sdk: {
              AppType: { SelfBuild: 'self-build' },
              Domain: { Feishu: 'feishu' },
              withUserAccessToken(token) { return { token }; },
              Client: class {
                async request() {
                  ${throwError ? `const error = new Error(${JSON.stringify(throwError.message)}); error.status = ${Number(throwError.status || 403)}; throw error;` : `
                  return (async function* stream() {
                    yield Buffer.from('event: start\\ndata: {"agent_chat_id":"chat-12345678","session_id":"session-1"}\\n\\n');
                    yield Buffer.from('event: message_delta\\ndata: ' + JSON.stringify({ delta: { type: 'content', text: ${JSON.stringify(text)} } }) + '\\n\\n');
                    yield Buffer.from('event: done\\ndata: ' + JSON.stringify({ status: ${JSON.stringify(status)}, finish_reason: 'stop' }));
                  })();
                  `}
                }
              },
            },
          };
        }
        return originalLoad.call(this, requestName, parent, isMain);
      };
      require(workerPath);
    `;
    const child = spawn(process.execPath, ['-e', bootstrap], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      child.kill();
      try { resolve(JSON.parse(stdout.slice(0, newline))); } catch (error) { reject(error); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => { if (!stdout) reject(new Error(stderr || `worker exited ${code}`)); });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function callWorkerLines(requests, { foreign = false } = {}) {
  return new Promise((resolve, reject) => {
    const bootstrap = `
      const Module = require('node:module');
      const workerPath = ${JSON.stringify(workerPath)};
      const originalLoad = Module._load;
      let starts = 0;
      Module._load = function load(request, parent, isMain) {
        if (parent && parent.filename === workerPath && request === './pm-runtime.cjs') {
          const createHandle = (startCount, restartCount = 0) => ({
            url: 'http://127.0.0.1:4310',
            port: 4310,
            alreadyRunning: false,
            foreign: ${foreign ? 'true' : 'false'},
            startCount,
            restartCount,
            stop: async () => ({ stopped: true, stopCount: startCount }),
            restart: async () => {
              starts += 1;
              return createHandle(starts, restartCount + 1);
            },
          });
          return {
            startPmServer(options) {
              starts += 1;
              return createHandle(starts, 0);
            },
          };
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      require(workerPath);
    `;
    const child = spawn(process.execPath, ['-e', bootstrap], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const results = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (line) {
          try {
            results.push(JSON.parse(line));
          } catch (error) {
            child.kill();
            reject(error);
            return;
          }
        }
        newline = stdout.indexOf('\n');
      }
      if (results.length === requests.length) {
        child.kill();
        resolve(results);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (results.length < requests.length && code !== 0) reject(new Error(stderr || `worker exited ${code}`));
    });
    let nextRequest = 0;
    const sendNext = () => {
      if (nextRequest >= requests.length) {
        child.stdin.end();
        return;
      }
      child.stdin.write(`${JSON.stringify(requests[nextRequest])}\n`);
      nextRequest += 1;
    };
    const originalDataHandler = child.stdout.listeners('data')[0];
    child.stdout.removeListener('data', originalDataHandler);
    child.stdout.on('data', (chunk) => {
      originalDataHandler(chunk);
      if (results.length === nextRequest && nextRequest < requests.length) sendNext();
    });
    sendNext();
  });
}

test('legacy embedded runtime and Aily RPC methods are unavailable', async () => {
  for (const method of ['pm/ensure', 'pm/stop', 'pm/restart', 'aily/summarize']) {
    const result = await callWorker({ jsonrpc: '2.0', id: method, method });
    assert.equal(result.error.code, -32601);
  }
});

test('GET tasks uses the bearer token and Cindy-only loopback path', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ items: [{ id: 'task-1', version: 3 }] }));
  });
  const port = await listen(server);
  try {
    const result = await callWorker({
      jsonrpc: '2.0',
      id: 1,
      method: 'pm/request',
      params: { baseUrl: `http://127.0.0.1:${port}`, method: 'GET', path: '/api/integrations/cindy/tasks' },
      cindy: { secrets: { pm_token: 'test-token' } },
    });
    assert.deepEqual(result.result.items, [{ id: 'task-1', version: 3 }]);
    assert.deepEqual(requests, [{
      method: 'GET',
      url: '/api/integrations/cindy/tasks',
      authorization: 'Bearer test-token',
    }]);
  } finally {
    await close(server);
  }
});

test('legacy CONFIG_ROOT still resolves the same integration token when TOOMANYTASKS_CONFIG_ROOT is empty', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.authorization);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ items: [] }));
  });
  const port = await listen(server);
  try {
    const result = await callWorker({
      jsonrpc: '2.0',
      id: 7,
      method: 'pm/request',
      params: { baseUrl: `http://127.0.0.1:${port}`, method: 'GET', path: '/api/integrations/cindy/tasks' },
    }, {
      TOOMANYTASKS_CONFIG_ROOT: '',
      CONFIG_ROOT: tokenRoot,
    });
    assert.deepEqual(result.result, { items: [] });
    assert.deepEqual(requests, ['Bearer test-token']);
  } finally {
    await close(server);
  }
});

test('POST intake forwards the exact JSON body', async () => {
  let receivedBody = '';
  const server = createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', (chunk) => { receivedBody += chunk; });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ intake_id: 'intake-1', accepted: true }));
    });
  });
  const port = await listen(server);
  const body = {
    window_id: 'window-1',
    window_start: '2026-08-24T01:00:00.000Z',
    window_end: '2026-08-24T01:10:00.000Z',
    sources: [{ source_key: 's1', occurred_at: '2026-08-24T01:05:00.000Z', text: '需要补充任务。' }],
    proposals: [{ action: 'needs_owner', source_keys: ['s1'], expected_version: 1, reason: '需要确认负责人。' }],
  };
  try {
    const result = await callWorker({
      jsonrpc: '2.0',
      id: 2,
      method: 'pm/request',
      params: { baseUrl: `http://127.0.0.1:${port}`, method: 'POST', path: '/api/integrations/cindy/intake', body },
      cindy: { secrets: { pm_token: 'test-token' } },
    });
    assert.deepEqual(result.result, { intake_id: 'intake-1', accepted: true });
    assert.deepEqual(JSON.parse(receivedBody), body);
  } finally {
    await close(server);
  }
});

test('PUT auto-scan forwards the enabled JSON body', async () => {
  let receivedBody = '';
  const server = createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', (chunk) => { receivedBody += chunk; });
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ enabled: true }));
    });
  });
  const port = await listen(server);
  try {
    const result = await callWorker({
      jsonrpc: '2.0',
      id: 6,
      method: 'pm/request',
      params: { baseUrl: `http://127.0.0.1:${port}`, method: 'PUT', path: '/api/runtime/auto-scan', body: { enabled: true } },
      cindy: { secrets: { pm_token: 'test-token' } },
    });
    assert.deepEqual(result.result, { enabled: true });
    assert.deepEqual(JSON.parse(receivedBody), { enabled: true });
  } finally {
    await close(server);
  }
});

test('cindy/read-completed-turn only returns the current turn final reply', async () => {
  const fixture = createCindyFixture();
  try {
    fixture.insert('m1', 'user', '{"text":"执行本轮测试。"}', 2000);
    fixture.insert('m2', 'assistant', '过程更新', 2100);
    fixture.insert('m3', 'assistant', '本轮最终回复', 2300, '{"turnCompleted":true}');
    fixture.close();
    const response = await callWorkerWithDataDir({
      jsonrpc: '2.0', id: 50, method: 'cindy/read-completed-turn',
      params: { sessionId: 'session-a', startedAt: 2000, expectedUserMessage: '执行本轮测试。', waitMs: 200 },
    }, fixture.directory);
    assert.equal(response.result.userMessage, '执行本轮测试。');
    assert.equal(response.result.assistantReply, '本轮最终回复');
  } finally {
    fixture.cleanup();
  }
});

test('source=plugin 自动进度读取明确跳过', async () => {
  const fixture = createCindyFixture({ source: 'plugin' });
  try {
    fixture.insert('m1', 'user', '{"text":"插件来源回合。"}', 2000);
    fixture.insert('m2', 'assistant', '插件回复', 2300, '{"turnCompleted":true}');
    fixture.close();
    const response = await callWorkerWithDataDir({
      jsonrpc: '2.0', id: 51, method: 'cindy/read-completed-turn',
      params: { sessionId: 'session-a', startedAt: 2000, expectedUserMessage: '插件来源回合。', waitMs: 200 },
    }, fixture.directory);
    assert.match(response.error.message, /source=plugin/);
  } finally {
    fixture.cleanup();
  }
});

test('rejects non-loopback hosts and paths outside the Cindy integration prefix', async () => {
  const hostResult = await callWorker({
    jsonrpc: '2.0',
    id: 3,
    method: 'pm/request',
    params: { baseUrl: 'http://example.com', method: 'GET', path: '/api/integrations/cindy/tasks' },
    cindy: { secrets: { pm_token: 'test-token' } },
  });
  assert.match(hostResult.error.message, /本机 HTTP 回环地址/);

  const pathResult = await callWorker({
    jsonrpc: '2.0',
    id: 4,
    method: 'pm/request',
    params: { baseUrl: 'http://127.0.0.1:4310', method: 'GET', path: '/api/tasks' },
    cindy: { secrets: { pm_token: 'test-token' } },
  });
  assert.match(pathResult.error.message, /Cindy 专用本机任务库接口/);
});

test('rejects HTTP redirects instead of following them', async () => {
  let redirectTargetHits = 0;
  const server = createServer((request, response) => {
    if (request.url === '/api/integrations/cindy/tasks') {
      response.statusCode = 302;
      response.setHeader('location', '/api/integrations/cindy/tasks-final');
      response.end();
      return;
    }
    redirectTargetHits += 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ items: [] }));
  });
  const port = await listen(server);
  try {
    const result = await callWorker({
      jsonrpc: '2.0',
      id: 5,
      method: 'pm/request',
      params: { baseUrl: `http://127.0.0.1:${port}`, method: 'GET', path: '/api/integrations/cindy/tasks' },
      cindy: { secrets: { pm_token: 'test-token' } },
    });
    assert.equal(result.result, undefined);
    assert.ok(result.error);
    assert.equal(redirectTargetHits, 0);
  } finally {
    await close(server);
  }
});
