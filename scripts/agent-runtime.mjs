import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_PORT = 4310;
export const DEFAULT_OAUTH_SCOPES = [
  'aily:agent_chat:write',
  'auth:user.id:read',
  'im:chat:read',
  'im:message:readonly',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
  'search:message',
  'search:docs:read',
  'calendar:calendar.event:read',
  'offline_access',
];
export const REQUIRED_OAUTH_SCOPES = [...DEFAULT_OAUTH_SCOPES];
const MAX_STDIN_BYTES = 32 * 1024;

function platformConfigRoot(env = process.env) {
  const explicit = env.TOOMANYTASKS_CONFIG_ROOT?.trim() || env.CONFIG_ROOT?.trim();
  if (explicit) return resolve(explicit);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ai-pm-intake');
  if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'ai-pm-intake');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ai-pm-intake');
}

function commandName(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function ensureNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`TooManyTasks 需要 Node.js 24 或更高版本，当前为 ${process.versions.node}。`);
  }
}

export function runtimePaths(env = process.env) {
  const configRoot = platformConfigRoot(env);
  const runtimeRoot = join(configRoot, '.agent-runtime');
  const pluginManifest = JSON.parse(readFileSync(resolve(root, 'plugins', 'cindy-pm-intake', 'ghost.json'), 'utf8'));
  return {
    configRoot,
    runtimeRoot,
    pidFile: join(runtimeRoot, 'server.pid'),
    logFile: join(runtimeRoot, 'server.log'),
    baseUrl: `http://127.0.0.1:${Number(env.PORT) || DEFAULT_PORT}`,
    pluginPackage: resolve(root, 'plugins', 'cindy-pm-intake', `${pluginManifest.id}-${pluginManifest.version}.cindy`),
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(paths) {
  try {
    const pid = Number((await readFile(paths.pidFile, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function fetchJson(paths, method, pathname, body, timeoutMs = 10_000, authorization = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${paths.baseUrl}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const error = new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`);
      error.code = data?.error_code || `HTTP_${response.status}`;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function portResponds(paths, timeoutMs = 1_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${paths.baseUrl}/api/health`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function readIntegrationToken(paths = runtimePaths()) {
  try {
    const token = (await readFile(join(paths.configRoot, 'cindy-integration-token'), 'utf8')).trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch {
    throw new Error('TooManyTasks 尚未生成本机 Cindy 集成令牌，请先启动服务。');
  }
}

export async function waitForHealth(paths = runtimePaths(), timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(paths, 'GET', '/api/health');
      return health;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw new Error(`TooManyTasks 健康检查超时：${lastError instanceof Error ? lastError.message : '服务未响应'}`);
}

export async function startServer({ paths = runtimePaths(), waitMs = 30_000 } = {}) {
  ensureNodeVersion();
  if (!existsSync(resolve(root, 'apps/server/dist/index.js'))) {
    throw new Error('TooManyTasks 尚未构建，请先运行 npm run agent:install。');
  }
  const existingPid = await readPid(paths);
  // A custom config root can coexist with another TooManyTasks installation.
  // Probe the port before spawning so a health response from that other
  // process cannot be mistaken for this child becoming ready.
  if (await portResponds(paths)) {
    if (existingPid && isPidAlive(existingPid)) {
      return { status: 'already_running', pid: existingPid, health: await waitForHealth(paths, waitMs) };
    }
    throw new Error(`TooManyTasks 端口 ${new URL(paths.baseUrl).port} 已被其它进程占用，请先停止占用该端口的服务。`);
  }
  if (existingPid && isPidAlive(existingPid)) {
    return { status: 'already_running', pid: existingPid, health: await waitForHealth(paths, waitMs) };
  }
  await mkdir(paths.runtimeRoot, { recursive: true });
  const logFd = openSync(paths.logFile, 'a', 0o600);
  const child = spawn(process.execPath, [resolve(root, 'apps/server/dist/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(new URL(paths.baseUrl).port || DEFAULT_PORT),
      AILY_OAUTH_REDIRECT_URI: process.env.AILY_OAUTH_REDIRECT_URI?.trim()
        || `http://127.0.0.1:${new URL(paths.baseUrl).port || DEFAULT_PORT}/oauth/aily/callback`,
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  if (!child.pid) throw new Error('TooManyTasks 后台进程未取得 PID。');
  await writeFile(paths.pidFile, `${child.pid}\n`, { mode: 0o600 });
  child.unref();
  try {
    const health = await waitForHealth(paths, waitMs);
    // The child may have failed to bind while an unrelated process answered
    // the health probe. Require the PID we just launched to remain alive.
    await new Promise((resolveReady) => setImmediate(resolveReady));
    if (!isPidAlive(child.pid)) throw new Error('TooManyTasks 后台进程启动后立即退出，可能是端口冲突。');
    return { status: 'started', pid: child.pid, health };
  } catch (error) {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* process may have exited */ }
    await rm(paths.pidFile, { force: true });
    throw error;
  }
}

export async function stopServer({ paths = runtimePaths(), waitMs = 15_000 } = {}) {
  const pid = await readPid(paths);
  if (pid && isPidAlive(pid)) {
    try {
      await fetchJson(paths, 'POST', '/api/runtime/shutdown', {}, 3_000);
    } catch {
      try { process.kill(pid, 'SIGTERM'); } catch { /* process may have exited */ }
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && isPidAlive(pid)) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (isPidAlive(pid)) throw new Error('TooManyTasks 后台进程未在规定时间内退出。');
  }
  await rm(paths.pidFile, { force: true });
  return { status: 'stopped' };
}

export function parseAilyConfig(input, env = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Aily 配置必须是 JSON object。');
  const clean = (value, name, max = 8192) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Aily ${name} 缺失或格式不正确。`);
    return value.trim();
  };
  const appId = clean(input.appId, 'App ID', 200);
  const appSecret = clean(input.appSecret, 'App Secret');
  const agentId = clean(input.agentId, 'Agent ID', 160);
  if (!/^[A-Za-z0-9._:-]+$/u.test(agentId)) throw new Error('Aily Agent ID 格式不正确。');
  const domain = input.domain === undefined ? 'feishu' : input.domain;
  if (domain !== 'feishu' && domain !== 'lark') throw new Error('Aily domain 只能是 feishu 或 lark。');
  const port = Number(env.PORT) || DEFAULT_PORT;
  const oauthRedirectUri = typeof input.oauthRedirectUri === 'string' && input.oauthRedirectUri.trim()
    ? input.oauthRedirectUri.trim()
    : `http://127.0.0.1:${port}/oauth/aily/callback`;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/oauth\/aily\/callback$/u.test(oauthRedirectUri)) {
    throw new Error('OAuth 回调地址必须是本机 /oauth/aily/callback。');
  }
  const oauthScopes = Array.isArray(input.oauthScopes) && input.oauthScopes.length
    ? [...new Set(input.oauthScopes.map((value) => clean(value, 'scope', 200)))]
    : [...DEFAULT_OAUTH_SCOPES];
  const missingScopes = REQUIRED_OAUTH_SCOPES.filter((scope) => !oauthScopes.includes(scope));
  if (missingScopes.length) throw new Error(`Aily scope 配置不完整，缺少：${missingScopes.join(', ')}`);
  return { appId, appSecret, agentId, domain, oauthRedirectUri, oauthScopes };
}

async function readStdinJson() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += Buffer.byteLength(chunk);
    if (total > MAX_STDIN_BYTES) throw new Error('配置输入超过大小上限。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(chunks.join(''));
  } catch {
    throw new Error('配置输入不是有效 JSON。');
  }
}

export function redactAilyStatus(status) {
  return {
    authStatus: status?.authStatus || 'unknown',
    connected: status?.connected === true,
    refreshAvailable: status?.refreshAvailable === true,
    grantedScopeCount: Array.isArray(status?.grantedScopes) ? status.grantedScopes.length : 0,
    missingScopes: Array.isArray(status?.grantedScopes)
      ? DEFAULT_OAUTH_SCOPES.filter((scope) => !status.grantedScopes.includes(scope))
      : DEFAULT_OAUTH_SCOPES,
    agentConfigured: Boolean(status?.agentId),
    appConfigured: Boolean(status?.appId && status?.appSecretSaved),
  };
}

export async function configureAilyFromStdin(paths = runtimePaths()) {
  const config = parseAilyConfig(await readStdinJson(), { ...process.env, PORT: new URL(paths.baseUrl).port });
  await fetchJson(paths, 'PUT', '/api/integrations/aily/config', config);
  return { status: 'configured', appConfigured: true, agentConfigured: true };
}

export async function prepareAilyApplication(paths = runtimePaths()) {
  return fetchJson(paths, 'POST', '/api/integrations/aily/application/prepare', {}, 30_000);
}

export async function getOAuthUrl(paths = runtimePaths()) {
  const result = await fetchJson(paths, 'GET', '/api/integrations/aily/oauth/url');
  if (!result?.url || typeof result.url !== 'string') throw new Error('TooManyTasks 没有返回 OAuth 地址。');
  return result.url;
}

export async function waitForOAuth(paths = runtimePaths(), timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    status = await fetchJson(paths, 'GET', '/api/integrations/aily/status');
    const redacted = redactAilyStatus(status);
    if (redacted.authStatus === 'connected') return redacted;
    if (redacted.authStatus === 'expired') throw new Error('Aily 授权已过期，请重新连接。');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  throw new Error(`等待 Aily OAuth 超时：${JSON.stringify(redactAilyStatus(status))}`);
}

export async function enableScan(paths = runtimePaths()) {
  const autoScan = await fetchJson(paths, 'PUT', '/api/runtime/auto-scan', { enabled: true });
  const scan = await fetchJson(
    paths,
    'POST',
    '/api/integrations/cindy/scan',
    { trigger: 'manual' },
    10_000,
    await readIntegrationToken(paths),
  );
  return {
    status: scan.status === 'accepted' || scan.status === 'already_running' ? 'accepted' : scan.status,
    autoScanEnabled: autoScan.enabled === true,
    scanStatus: scan.status,
  };
}

export async function verifyFirstRun(paths = runtimePaths()) {
  const health = await waitForHealth(paths, 10_000);
  const aily = await fetchJson(paths, 'GET', '/api/integrations/aily/status');
  return {
    status: ['ok', 'ready'].includes(health?.status) && aily?.authStatus === 'connected' ? 'ready' : 'incomplete',
    health: health?.status || 'unknown',
    aily: redactAilyStatus(aily),
    pluginPackagePresent: existsSync(paths.pluginPackage),
    pluginPackage: paths.pluginPackage,
  };
}

export async function main(command = process.argv[2] || 'install') {
  ensureNodeVersion();
  const paths = runtimePaths();
  if (command === 'install') {
    execFileSync(commandName('npm'), ['ci'], { cwd: root, stdio: 'inherit' });
    execFileSync(commandName('npm'), ['run', 'build'], { cwd: root, stdio: 'inherit' });
    execFileSync(commandName('npm'), ['run', 'build:plugin'], { cwd: root, stdio: 'inherit' });
    const started = await startServer({ paths });
    console.log(JSON.stringify({
      status: 'installed_and_started',
      server: started,
      settingsUrl: `${paths.baseUrl}/settings`,
      oauthRedirectUri: `http://127.0.0.1:${new URL(paths.baseUrl).port || DEFAULT_PORT}/oauth/aily/callback`,
      pluginPackage: paths.pluginPackage,
      next: ['仅用浏览器创建用户自己的自建应用和 Aily Agent，并读取首次 App ID、App Secret、Agent ID。', '调用 configure-aily 和 prepare-aily-app，由 CLI 配置、发布并申请应用权限，再调用 oauth-url 和 wait-oauth。', '通过 Cindy 宿主安装插件包后调用 enable-scan。'],
    }, null, 2));
    return;
  }
  if (command === 'start') {
    console.log(JSON.stringify(await startServer({ paths }), null, 2));
    return;
  }
  if (command === 'stop') {
    console.log(JSON.stringify(await stopServer({ paths }), null, 2));
    return;
  }
  if (command === 'status') {
    let health = null;
    let aily = null;
    try { health = await fetchJson(paths, 'GET', '/api/health'); } catch { /* report unavailable */ }
    try { aily = await fetchJson(paths, 'GET', '/api/integrations/aily/status'); } catch { /* report unavailable */ }
    console.log(JSON.stringify({
      status: health ? 'running' : 'stopped',
      health: health?.status || 'unavailable',
      aily: aily ? redactAilyStatus(aily) : { authStatus: 'unavailable' },
      pluginPackagePresent: existsSync(paths.pluginPackage),
      pluginPackage: paths.pluginPackage,
      pidFile: paths.pidFile,
      logFile: paths.logFile,
    }, null, 2));
    return;
  }
  if (command === 'configure-aily') {
    console.log(JSON.stringify(await configureAilyFromStdin(paths), null, 2));
    return;
  }
  if (command === 'prepare-aily-app') {
    console.log(JSON.stringify(await prepareAilyApplication(paths), null, 2));
    return;
  }
  if (command === 'oauth-url') {
    console.log(await getOAuthUrl(paths));
    return;
  }
  if (command === 'wait-oauth') {
    console.log(JSON.stringify(await waitForOAuth(paths), null, 2));
    return;
  }
  if (command === 'enable-scan') {
    console.log(JSON.stringify(await enableScan(paths), null, 2));
    return;
  }
  if (command === 'verify') {
    console.log(JSON.stringify(await verifyFirstRun(paths), null, 2));
    return;
  }
  if (command === 'update') {
    const dirty = execFileSync(commandName('git'), ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
    if (dirty) throw new Error('拒绝更新：仓库存在未提交改动，请先由主人确认如何处理。');
    await stopServer({ paths });
    execFileSync(commandName('git'), ['pull', '--ff-only'], { cwd: root, stdio: 'inherit' });
    execFileSync(commandName('npm'), ['ci'], { cwd: root, stdio: 'inherit' });
    execFileSync(commandName('npm'), ['run', 'build'], { cwd: root, stdio: 'inherit' });
    execFileSync(commandName('npm'), ['run', 'build:plugin'], { cwd: root, stdio: 'inherit' });
    console.log(JSON.stringify(await startServer({ paths }), null, 2));
    return;
  }
  throw new Error(`未知 Agent 命令：${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Agent 安装失败。');
    process.exitCode = 1;
  });
}
