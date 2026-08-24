import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const workerPath = path.resolve(import.meta.dirname, 'worker.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function callWorker(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
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

function callWorkerLines(requests) {
  return new Promise((resolve, reject) => {
    const bootstrap = `
      const Module = require('node:module');
      const workerPath = ${JSON.stringify(workerPath)};
      const originalLoad = Module._load;
      let starts = 0;
      Module._load = function load(request, parent, isMain) {
        if (parent && parent.filename === workerPath && request === './pm-runtime.cjs') {
          return {
            startPmServer(options) {
              starts += 1;
              return {
                url: 'http://127.0.0.1:4310',
                port: options.port,
                alreadyRunning: starts > 1,
                foreign: false,
                startCount: starts,
                stop: async () => ({ stopped: true, stopCount: starts }),
              };
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

test('pm/stop invokes the current server stop handle and a later pm/ensure starts again', async () => {
  const results = await callWorkerLines([
    {
      jsonrpc: '2.0',
      id: 10,
      method: 'pm/ensure',
      cindy: { secrets: { pm_token: 'test-token' } },
    },
    { jsonrpc: '2.0', id: 11, method: 'pm/stop' },
    {
      jsonrpc: '2.0',
      id: 12,
      method: 'pm/ensure',
      cindy: { secrets: { pm_token: 'test-token' } },
    },
    { jsonrpc: '2.0', id: 13, method: 'pm/stop' },
  ]);
  assert.equal(results[0].result.startCount, 1);
  assert.deepEqual(results[1].result, { stopped: true, stopCount: 1 });
  assert.equal(results[2].result.startCount, 2);
  assert.deepEqual(results[3].result, { stopped: true, stopCount: 2 });
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
