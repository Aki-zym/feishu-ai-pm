const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { join } = path;
let pmServerHandle = null;

function pmRuntime() {
  try {
    const runtime = require('./pm-runtime.cjs');
    if (!runtime || typeof runtime.startPmServer !== 'function') {
      throw new Error('模块未导出 startPmServer(options)');
    }
    return runtime;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`本机任务库运行时不可用：请提供 node/pm-runtime.cjs 并导出 startPmServer(options)；${detail}`);
  }
}

async function ensurePm(request) {
  const token = request.cindy && request.cindy.secrets && request.cindy.secrets.pm_token;
  if (!token) throw new Error('本机任务库令牌尚未配置');

  const sqlitePath = join(os.homedir(), 'Library/Application Support/ai-pm-intake', 'ai-pm.sqlite');
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const webRoot = join(__dirname, '..', 'web-dist');
  const server = await pmRuntime().startPmServer({
    port: 4310,
    host: '127.0.0.1',
    sqlitePath,
    token,
    webRoot,
  });
  if (!server || typeof server.stop !== 'function') {
    throw new Error('本机任务库启动结果缺少 stop()');
  }
  pmServerHandle = server;
  return server;
}

async function stopPm() {
  if (!pmServerHandle) return { stopped: false, reason: '本机任务库尚未由当前 worker 拉起' };
  const server = pmServerHandle;
  const result = await server.stop();
  pmServerHandle = null;
  return result === undefined ? { stopped: true } : result;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '::1'].includes(host)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && (url.pathname === '' || url.pathname === '/');
  } catch {
    return false;
  }
}

function isAllowedPath(value) {
  return typeof value === 'string'
    && /^\/api\/integrations\/cindy\/[A-Za-z0-9._/-]+$/.test(value)
    && !value.includes('..');
}

async function requestPm(request) {
  const params = request.params || {};
  const baseUrl = String(params.baseUrl || 'http://127.0.0.1:4310').replace(/\/+$/, '');
  const requestPath = String(params.path || '');
  const method = String(params.method || 'GET').toUpperCase();
  const token = request.cindy && request.cindy.secrets && request.cindy.secrets.pm_token;
  if (!token) throw new Error('本机任务库令牌尚未配置');
  if (!isLoopbackUrl(baseUrl)) throw new Error('本机任务库地址必须是本机 HTTP 回环地址');
  if (!isAllowedPath(requestPath)) throw new Error('只允许调用 Cindy 专用本机任务库接口');
  if (!['GET', 'POST'].includes(method)) throw new Error('只允许 GET 或 POST');

  const response = await fetch(baseUrl + requestPath, {
    method,
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(params.body ?? {}) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  const responseText = await response.text();
  let body = null;
  try {
    body = responseText ? JSON.parse(responseText) : null;
  } catch {
    body = { error: responseText.slice(0, 500) };
  }
  if (!response.ok) throw new Error(body && body.error ? body.error : `本机任务库 HTTP ${response.status}`);
  return body;
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === 'pm/ensure') {
      const result = await ensurePm(request);
      send({ jsonrpc: '2.0', id: request.id, result });
      return;
    }
    if (request.method === 'pm/stop') {
      const result = await stopPm();
      send({ jsonrpc: '2.0', id: request.id, result });
      return;
    }
    if (request.method !== 'pm/request') {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    const result = await requestPm(request);
    send({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id: request && request.id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    });
  }
});
