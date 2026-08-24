const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { join } = path;
let pmServerHandle = null;

function pmAuthSecrets(request) {
  const secrets = request.cindy && request.cindy.secrets;
  const token = secrets && secrets.pm_token;
  const accountAnchor = secrets && secrets.pm_account_anchor;
  const receiptSecret = secrets && secrets.pm_receipt_secret;
  if (!token) throw new Error('本机任务库令牌尚未配置');
  if (!accountAnchor || !receiptSecret) throw new Error('本机可信来源账号锚点或 receipt 密钥尚未配置');
  return { token, accountAnchor, receiptSecret };
}

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
  const { token, accountAnchor, receiptSecret } = pmAuthSecrets(request);

  const sqlitePath = join(os.homedir(), 'Library/Application Support/ai-pm-intake', 'ai-pm.sqlite');
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const webRoot = join(__dirname, '..', 'web-dist');
  const server = await pmRuntime().startPmServer({
    port: 4310,
    host: '127.0.0.1',
    sqlitePath,
    token,
    accountAnchor,
    receiptSecret,
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

async function restartPm(request) {
  if (!pmServerHandle) return ensurePm(request);
  if (typeof pmServerHandle.restart !== 'function') {
    throw new Error('本机任务库运行时结果缺少 restart()');
  }
  const restarted = await pmServerHandle.restart(pmAuthSecrets(request));
  if (!restarted || typeof restarted.stop !== 'function' || typeof restarted.restart !== 'function') {
    throw new Error('本机任务库重启结果缺少 stop()/restart()');
  }
  pmServerHandle = restarted;
  return restarted;
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
    && !value.includes('..')
    && (/^\/api\/runtime\/[A-Za-z0-9._/-]+$/.test(value) || /^\/api\/integrations\/cindy\/[A-Za-z0-9._/-]+$/.test(value));
}

function cindyUserDataDirs() {
  if (process.env.NODE_ENV === 'test' && process.env.CINDY_PM_TEST_USER_DATA_DIR) {
    return [process.env.CINDY_PM_TEST_USER_DATA_DIR];
  }
  if (process.platform === 'darwin') {
    return [path.join(os.homedir(), 'Library', 'Application Support', 'Cindy')];
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA ? [path.join(process.env.APPDATA, 'Cindy')] : [];
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return [path.join(configHome, 'Cindy')];
}

function candidateDatabases() {
  const files = [];
  for (const directory of cindyUserDataDirs()) {
    let names = [];
    try { names = fs.readdirSync(directory); } catch { continue; }
    for (const name of names) {
      if (/^cindy-[A-Za-z0-9_-]+\.db$/.test(name)) files.push(path.join(directory, name));
    }
  }
  return files;
}

function parseMessageText(content) {
  if (typeof content !== 'string') return '';
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') return parsed.text;
  } catch {
    // 助手最终正文通常是纯文本。
  }
  return content;
}

function normalizedMessageText(content) {
  return parseMessageText(content).trim();
}

function parseAgentMeta(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function readFinalizedTurn(sessionId, startedAt, expectedUserMessages) {
  const { DatabaseSync } = require('node:sqlite');
  const lowerBound = Math.max(0, startedAt - 5000);
  for (const databasePath of candidateDatabases()) {
    let database;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true, timeout: 1000 });
      const session = database.prepare('SELECT source, orca_role FROM sessions WHERE id = ?').get(sessionId);
      if (!session) continue;
      const source = String(session.source || '');
      const orcaRole = String(session.orca_role || '');
      if (source === 'plugin') {
        return { terminalError: 'source=plugin 会话不执行自动进度维护' };
      }
      if (!['desktop', 'shared'].includes(source)) {
        return { terminalError: '当前会话不属于可自动维护的用户主会话' };
      }
      if (orcaRole && orcaRole !== 'lead') {
        return { terminalError: 'Orca Worker 会话不执行自动进度维护；请由主会话或 Orca Lead 维护' };
      }
      const rows = database.prepare(`
        SELECT id, role, content, created_at, agent_meta
        FROM messages
        WHERE session_id = ? AND role IN ('user', 'assistant')
          AND rewind_at IS NULL AND created_at >= ?
        ORDER BY created_at ASC, id ASC
        LIMIT 128
      `).all(sessionId, lowerBound);
      const firstExpected = expectedUserMessages[0] || '';
      let anchorIndex = -1;
      if (firstExpected) {
        anchorIndex = rows.findIndex((row) => row.role === 'user'
          && Number(row.created_at) >= startedAt
          && normalizedMessageText(row.content) === firstExpected);
        if (anchorIndex < 0) {
          anchorIndex = rows.findIndex((row) => row.role === 'user'
            && normalizedMessageText(row.content) === firstExpected);
        }
      } else {
        anchorIndex = rows.findIndex((row) => row.role === 'user' && Number(row.created_at) >= startedAt);
      }
      if (anchorIndex < 0) return null;
      const turnUsers = [];
      for (let index = anchorIndex; index < rows.length; index += 1) {
        const row = rows[index];
        if (row.role === 'user') {
          const delivery = String(parseAgentMeta(row.agent_meta)?.delivery || '');
          if (turnUsers.length > 0 && delivery !== 'steer') return null;
          turnUsers.push(row);
          continue;
        }
        const assistantReply = normalizedMessageText(row.content);
        if (!assistantReply) continue;
        const meta = parseAgentMeta(row.agent_meta);
        if (meta && meta.turnCompleted === true) {
          return {
            userMessage: normalizedMessageText(turnUsers[0].content),
            userMessages: turnUsers.map((user) => normalizedMessageText(user.content)),
            assistantReply,
            userMessageId: turnUsers[0].id,
            userMessageIds: turnUsers.map((user) => user.id),
            assistantMessageId: row.id,
            completedAt: Number(row.created_at) || 0,
          };
        }
      }
    } catch {
      // 数据库可能正被宿主切换或短暂占用；下一次轮询继续读取。
    } finally {
      try { database?.close(); } catch { /* ignore */ }
    }
  }
  return null;
}

async function readCompletedTurn(params) {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  const startedAt = Number(params.startedAt);
  const expectedUserMessages = Array.isArray(params.expectedUserMessages)
    ? params.expectedUserMessages.filter((item) => typeof item === 'string').slice(0, 16).map((item) => item.trim())
    : typeof params.expectedUserMessage === 'string' ? [params.expectedUserMessage.trim()] : [];
  const waitMs = Math.max(100, Math.min(20000, Number(params.waitMs) || 15000));
  if (!sessionId || !Number.isFinite(startedAt) || startedAt <= 0) throw new Error('sessionId 或 startedAt 不合法');
  const deadline = Date.now() + waitMs;
  do {
    const result = readFinalizedTurn(sessionId, startedAt, expectedUserMessages);
    if (result && result.terminalError) throw new Error(result.terminalError);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error('等待 Cindy 本轮最终回复落库超时');
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
  if (!['GET', 'POST', 'PUT'].includes(method)) throw new Error('只允许 GET、POST 或 PUT');

  const response = await fetch(baseUrl + requestPath, {
    method,
    redirect: 'error',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(method === 'POST' || method === 'PUT' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' || method === 'PUT' ? { body: JSON.stringify(params.body ?? {}) } : {}),
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
    if (request.method === 'cindy/read-completed-turn') {
      const result = await readCompletedTurn(request.params || {});
      send({ jsonrpc: '2.0', id: request.id, result });
      return;
    }
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
    if (request.method === 'pm/restart') {
      const result = await restartPm(request);
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
