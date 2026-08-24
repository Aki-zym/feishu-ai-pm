import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
  Tray,
} from 'electron';
import { z } from 'zod';
import { buildApp, createLocalActionCapability, type LocalActionCapability } from '../../server/src/app.js';
import { loadConfig } from '../../server/src/config.js';
import { AppDatabase } from '../../server/src/database.js';
import { createAdapters } from '../../server/src/integrations.js';
import { PmService } from '../../server/src/service.js';
import type { DesktopRequest } from './contracts.js';
import { COMPILED_BUILD_IDENTITY } from './build-identity.js';
import { DesktopConfigStore } from './config-store.js';
import { resolveDesktopDatabasePaths } from './database-path.js';
import { createExternalLinkIpcHandler, createExternalLinkOpener, legacyNavigationResult } from './external-links.js';
import { DesktopLifecycle } from './lifecycle.js';
import { formatBootstrapFailure } from './startup-errors.js';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
]);

const smokeTest = process.argv.includes('--smoke-test');
const smokeScenario = process.env.AI_PM_SMOKE_SCENARIO?.trim() || '';
if (smokeTest && process.env.AI_PM_SMOKE_USER_DATA) {
  app.setPath('userData', resolve(process.env.AI_PM_SMOKE_USER_DATA));
}
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  if (smokeTest) process.stdout.write('DESKTOP_SINGLE_INSTANCE_REJECTED:{"clean":true}\n');
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let shutdownRequested = false;
let shutdownComplete = false;
let database: AppDatabase | null = null;
let legacyDatabaseDetected = false;
let localApp: Awaited<ReturnType<typeof buildApp>> | null = null;
let localActionCapability: LocalActionCapability | null = null;
let service: PmService | null = null;
let configStore: DesktopConfigStore | null = null;
let oauthServer: Server | null = null;
let ipcRegistered = false;
let faultConsumed = false;
const lifecycle = new DesktopLifecycle(({ from, to }) => {
  if (smokeTest) process.stdout.write(`DESKTOP_LIFECYCLE:${JSON.stringify({ from, to })}\n`);
});
const openExternalLink = createExternalLinkOpener((url) => shell.openExternal(url));
const handleExternalLinkIpc = createExternalLinkIpcHandler(verifyRenderer, openExternalLink);

const allowedRequest = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']),
  url: z.string().min(1).max(2048).refine((value) => value.startsWith('/api/'), '只允许调用本地服务 API。'),
  body: z.unknown().optional(),
});

function maybeInjectFault(stage: 'startup-core' | 'oauth' | 'reload') {
  const configured = process.env.AI_PM_DESKTOP_FAULT?.trim();
  if (configured !== stage && configured !== `once:${stage}`) return;
  if (configured === `once:${stage}` && faultConsumed) return;
  faultConsumed = true;
  throw new Error(`synthetic desktop lifecycle fault: ${stage}`);
}

function requireConfigStore() {
  if (!configStore) throw new Error('桌面配置尚未加载。');
  return configStore;
}

function requireReadyCore() {
  if (lifecycle.phase !== 'ready' || !localApp || !service) {
    throw new Error('TooManyTasks 本地服务尚未启动。');
  }
  return { app: localApp, service };
}

function smokeMarker(stage: string) {
  if (smokeTest) process.stdout.write(`DESKTOP_SMOKE_STAGE:${JSON.stringify({ stage })}\n`);
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function verifyRenderer(event: Electron.IpcMainInvokeEvent) {
  if (!event.senderFrame || !event.senderFrame.url.startsWith('app://local/')) {
    throw new Error('拒绝来自非受信页面的桌面调用。');
  }
}

async function registerAppProtocol() {
  const webRoot = resolve(app.getAppPath(), 'apps', 'web', 'dist');
  await protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (!extname(relativePath)) relativePath = 'index.html';
    const filePath = normalize(resolve(webRoot, relativePath));
    if (filePath !== webRoot && !filePath.startsWith(webRoot + sep)) {
      return new Response('Invalid path', { status: 400 });
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('Not a file');
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return net.fetch(pathToFileURL(join(webRoot, 'index.html')).toString());
    }
  });
}

async function createCore() {
  smokeMarker('create-core:start');
  const userData = app.getPath('userData');
  const store = new DesktopConfigStore(join(userData, 'config'));
  configStore = store;
  const databasePaths = resolveDesktopDatabasePaths(userData);
  legacyDatabaseDetected = existsSync(databasePaths.legacyDatabasePath);
  const env = await store.getRuntimeEnvironment(databasePaths.databasePath);
  const config = loadConfig({
    ...env,
    APP_VERSION: app.getVersion(),
    BUILD_IDENTITY: COMPILED_BUILD_IDENTITY ?? '',
  });
  database = new AppDatabase(config.database.sqlitePath, config.nodeEnv !== 'production');
  const adapters = createAdapters(config, {
    tokenVault: {
      get: (key) => store.getSecret(key),
      set: (key, value) => store.setSecret(key, value),
      setMany: (values) => store.setMany(values),
      readSnapshot: () => store.readSnapshot(),
      setManyAtomic: (values, expectedGeneration, refreshFence) => store.setManyAtomic(values, expectedGeneration, refreshFence),
      acquireRefreshLease: (identityKey, waitForResult) => store.acquireRefreshLease(identityKey, waitForResult),
      renewRefreshLease: (identityKey, leaseId, fencingToken, phase) => store.renewRefreshLease(identityKey, leaseId, fencingToken, phase),
      releaseRefreshLease: (identityKey, leaseId, result, fencingToken) => store.releaseRefreshLease(identityKey, leaseId, result, fencingToken),
    },
  });
  service = new PmService(database, adapters, config);
  localActionCapability = createLocalActionCapability();
  localApp = await buildApp(service, { webOrigin: 'app://local', serveWeb: false, desktopCapability: localActionCapability });
  service.startRuntimeRecovery();
  maybeInjectFault('startup-core');
  smokeMarker('create-core:ready');
}

async function startConfiguredFeishu() {
  if (!service) return;
  try {
    await service.startFeishu();
  } catch {
    // A temporary network or tenant configuration failure must not prevent
    // the desktop shell from opening. The service records the redacted error
    // and the settings page exposes the source health for retry.
  }
}

async function disposeCore() {
  smokeMarker('dispose-core:start');
  const currentService = service;
  const currentApp = localApp;
  const currentDatabase = database;
  await currentService?.stopRuntimeRecovery().catch(() => undefined);
  await currentService?.awaitRuntimeRecovery().catch(() => undefined);
  await currentService?.stopFeishu().catch(() => undefined);
  if (currentApp) await currentApp.close().catch(() => undefined);
  try {
    currentDatabase?.close();
  } catch {
    // Shutdown must still release every other resource if SQLite close fails.
  }
  localApp = null;
  localActionCapability = null;
  database = null;
  service = null;
  smokeMarker('dispose-core:done');
}

async function stopOAuthCallbackServer() {
  smokeMarker('oauth-stop:start');
  const server = oauthServer;
  oauthServer = null;
  if (!server) {
    smokeMarker('oauth-stop:none');
    return;
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  smokeMarker('oauth-stop:done');
}

async function reloadCore() {
  smokeMarker('reload:start');
  await stopOAuthCallbackServer();
  maybeInjectFault('reload');
  await disposeCore();
  await createCore();
  await startConfiguredFeishu();
  try {
    await startOAuthCallbackServer();
  } catch {
    await stopOAuthCallbackServer().catch(() => undefined);
  }
  smokeMarker('reload:done');
}

async function startOAuthCallbackServer() {
  maybeInjectFault('oauth');
  const redirectUri = (await requireConfigStore().readPublic()).feishu.oauthRedirectUri;
  const parsed = new URL(redirectUri);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') return;
  const port = Number(parsed.port || 80);
  oauthServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${parsed.host}`);
    if (url.pathname !== parsed.pathname) {
      response.writeHead(404).end('Not found');
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    if (!code || !state || error) {
      const providerMessage = url.searchParams.get('error_description');
      const detail = error ? `飞书返回：${error}${providerMessage ? `；${providerMessage}` : ''}` : '回调缺少授权码或状态。';
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(`<h3>飞书授权未完成</h3><p>${escapeHtml(detail)}</p><p>请回到 TooManyTasks 重新发起授权。</p>`);
      return;
    }
    try {
      const result = await localApp?.inject({ method: 'POST', url: '/api/integrations/feishu/oauth/exchange', payload: { code, state } });
      const ok = result?.statusCode && result.statusCode >= 200 && result.statusCode < 300;
      let body: { error?: string; ownerError?: string } = {};
      try { body = result?.json?.() as { error?: string; ownerError?: string }; } catch { /* empty response */ }
      const detail = body.ownerError || body.error || '';
      if (ok) void service?.startFeishu({ refreshOwner: true, syncOnce: true }).catch(() => undefined);
      const html = ok
        ? `<h3>${body.ownerError ? '飞书令牌已保存，但主人身份读取失败' : '飞书授权完成'}</h3>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}<p>可以关闭此页面并回到 TooManyTasks。</p>`
        : `<h3>飞书授权失败</h3><p>${escapeHtml(detail || 'TooManyTasks 未取得可诊断的错误信息。')}</p><p>请回到 TooManyTasks 重新发起授权。</p>`;
      response.writeHead(ok ? 200 : 502, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      if (ok) showWindow();
    } catch {
      response.writeHead(502, { 'content-type': 'text/html; charset=utf-8' }).end('<h3>TooManyTasks 未能完成授权，请查看诊断日志。</h3>');
    }
  });
  await new Promise<void>((resolve, reject) => {
    oauthServer!.once('error', reject);
    oauthServer!.listen(port, '127.0.0.1', resolve);
  });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAO0lEQVR42mNgGAWjYBSMglEwCkbB////Z2BgYGBg+M/AwMDwH4j/MzAwMPxnYGD4z8DAwMDA8J+BgYGBAQBs8Q8fD87b1AAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  tray.setToolTip('TooManyTasks');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 TooManyTasks', click: () => showWindow() },
      { type: 'separator' },
      {
        label: '完全退出',
        click: () => {
          requestTrayExit();
        },
      },
    ]),
  );
  tray.on('double-click', () => showWindow());
}

function requestTrayExit() {
  if (smokeTest) process.stdout.write(`DESKTOP_TRAY_EXIT:${JSON.stringify({ requested: true })}\n`);
  quitting = true;
  app.quit();
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.once('ready-to-show', () => {
    if (!smokeTest || smokeScenario === 'window_close') mainWindow?.show();
  });
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
      if (smokeTest && smokeScenario === 'window_close') {
        process.stdout.write(`DESKTOP_WINDOW_CLOSE:${JSON.stringify({ requested: true, prevented: true, hidden: !mainWindow?.isVisible() })}\n`);
      }
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const result = legacyNavigationResult(url);
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send('external-link:result', result);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('app://local/')) return;
    event.preventDefault();
    const result = legacyNavigationResult(url);
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send('external-link:result', result);
  });
  await mainWindow.loadURL('app://local/index.html');
  smokeMarker('window:loaded');
}

async function runSmokeRuntime() {
  if (!smokeTest || !mainWindow) return;
  smokeMarker('runtime:start');
  const result = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const text = document.body.innerText || '';
      if (text.includes('首次启动') || Date.now() - started > 5000) {
        resolve({ title: document.title, text: text.slice(0, 240), hasDesktopBridge: Boolean(window.aiPmDesktop) });
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  })`);
  const runtimeReload = await mainWindow.webContents.executeJavaScript(`(async () => {
    const bridge = window.aiPmDesktop;
    if (!bridge) throw new Error('Desktop bridge missing');
    const original = await bridge.config.get();
    const first = await bridge.config.save({
      ...original,
      setupComplete: true,
      logRetentionDays: 31,
      feishu: { ...original.feishu, externalEnabled: false, scanEnabled: false },
      llm: { ...original.llm, provider: 'rule_mock', apiBase: '', model: '' },
      workspace: { readEnabled: false, allowedPaths: [] },
      secrets: {},
    });
    const firstConfiguration = await bridge.api.request({ method: 'GET', url: '/api/configuration' });
    const second = await bridge.config.save({ ...first, logRetentionDays: 32, secrets: {} });
    const secondHealth = await bridge.api.request({ method: 'GET', url: '/api/health' });
    let authorizationError = '';
    try {
      await bridge.feishu.authorize();
    } catch (error) {
      authorizationError = error instanceof Error ? error.message : String(error);
    }
    return {
      firstStatus: firstConfiguration.status,
      secondStatus: secondHealth.status,
      firstRetention: first.logRetentionDays,
      secondRetention: second.logRetentionDays,
      integrationMode: secondHealth.body?.integrations,
      authorizationError,
    };
  })()`);
  process.stdout.write(`DESKTOP_SMOKE:${JSON.stringify({ ...result, runtimeReload })}\n`);
}

async function waitForSmokeRelease() {
  const releaseFile = process.env.AI_PM_SMOKE_WAIT_FILE?.trim();
  if (!releaseFile) return;
  const deadline = Date.now() + 30_000;
  while (!existsSync(releaseFile) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (!existsSync(releaseFile)) throw new Error('桌面冒烟等待释放超时。');
}

async function runWindowCloseScenario() {
  if (!smokeTest || smokeScenario !== 'window_close' || !mainWindow) return false;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  mainWindow.close();
  if (mainWindow.isVisible()) throw new Error('窗口关闭冒烟未隐藏窗口。');
  quitting = true;
  await requestShutdown('app-quit');
  app.quit();
  return true;
}

async function requestShutdown(reason: 'app-quit' | 'bootstrap-failure' | 'reload-failure' | 'relaunch') {
  if (shutdownComplete) return;
  try {
    await lifecycle.shutdown(async () => {
      await stopOAuthCallbackServer().catch(() => undefined);
      await disposeCore();
      try {
        tray?.destroy();
      } catch {
        // Tray destruction is best effort; the process must still finish.
      }
      tray = null;
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      } catch {
        // A partially-created BrowserWindow may already be gone.
      }
      mainWindow = null;
    });
  } finally {
    shutdownComplete = true;
    if (smokeTest) {
      process.stdout.write(`DESKTOP_SHUTDOWN:${JSON.stringify({ reason, phase: lifecycle.phase, clean: lifecycle.phase === 'stopped' })}\n`);
    }
  }
}

async function failBootstrap(error: unknown) {
  const message = formatBootstrapFailure(error);
  quitting = true;
  await requestShutdown('bootstrap-failure');
  if (smokeTest) {
    process.stdout.write(`DESKTOP_BOOTSTRAP_FAILURE:${JSON.stringify({ message })}\n`);
    process.exit(1);
  }
  try {
    await dialog.showMessageBox({
      type: 'error',
      title: 'TooManyTasks 启动失败',
      message,
      buttons: ['退出'],
      noLink: true,
    });
  } catch {
    // A missing desktop dialog must not leave a background-only process alive.
  }
  app.quit();
}

async function showLegacyDatabaseNotice() {
  if (!legacyDatabaseDetected) return;
  const message = '旧数据已保留，当前已使用新数据库。';
  if (smokeTest) {
    process.stdout.write(`DESKTOP_LEGACY_DATABASE_RETAINED:${JSON.stringify({ message })}\n`);
    return;
  }
  await dialog.showMessageBox({
    type: 'info',
    title: 'TooManyTasks',
    message,
    buttons: ['知道了'],
    noLink: true,
  });
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle('pm:request', async (event, input: DesktopRequest) => {
    verifyRenderer(event);
    const { app: currentApp } = requireReadyCore();
    const request = allowedRequest.parse(input);
    const inject = currentApp.inject.bind(currentApp) as unknown as (options: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      payload?: unknown;
    }) => Promise<{
      statusCode: number;
      headers: Record<string, string | string[] | undefined>;
      json(): unknown;
      body: string;
    }>;
    const response = await inject({
      method: request.method,
      url: request.url,
      headers: localActionCapability ? {
        'x-ai-pm-desktop-capability': localActionCapability.token,
        'x-csrf-token': localActionCapability.csrfToken,
        origin: 'app://local',
        referer: 'app://local/',
        'x-ai-pm-privacy-intent': request.url.startsWith('/api/privacy/deletion/')
          ? 'privacy.deletion.hard-delete.v1'
          : 'privacy.owner-action.v1',
      } : undefined,
      ...(request.body === undefined ? {} : { payload: request.body }),
    });
    const contentType = response.headers['content-type'] ?? '';
    return {
      status: response.statusCode,
      body: contentType.includes('application/json') ? response.json() : response.body,
    };
  });
  ipcMain.handle('app:info', (event) => {
    verifyRenderer(event);
    return { version: app.getVersion(), platform: process.platform, packaged: app.isPackaged };
  });
  ipcMain.handle('app:relaunch', (event) => {
    verifyRenderer(event);
    return requestShutdown('relaunch').then(() => {
      quitting = true;
      app.relaunch();
      app.quit();
    });
  });
  ipcMain.handle('config:get', async (event) => {
    verifyRenderer(event);
    return requireConfigStore().readPublic();
  });
  ipcMain.handle('config:save', async (event, input) => {
    verifyRenderer(event);
    smokeMarker('config-save:start');
    try {
      return await lifecycle.reload(async () => {
        smokeMarker('config-save:reload-start');
        const saved = await requireConfigStore().save(input);
        smokeMarker('config-save:persisted');
        app.setLoginItemSettings({ openAtLogin: saved.launchAtLogin });
        await reloadCore();
        smokeMarker('config-save:reload-done');
        return saved;
      });
    } catch (error) {
      smokeMarker('config-save:failed');
      await requestShutdown('reload-failure');
      quitting = true;
      if (smokeTest) process.exit(1);
      app.quit();
      throw error;
    }
  });
  ipcMain.handle('feishu:authorize', async (event) => {
    verifyRenderer(event);
    const { app: currentApp } = requireReadyCore();
    const response = await currentApp.inject({ method: 'GET', url: `/api/integrations/feishu/oauth/url?state=${crypto.randomUUID()}` });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const body = response.json() as { error?: string };
      throw new Error(body.error ?? '当前飞书配置不能生成授权地址。');
    }
    const body = response.json() as { url?: string };
    return openExternalLink({ url: body.url ?? '', purpose: 'feishu_oauth' });
  });
  ipcMain.handle('external-link:open', handleExternalLinkIpc);
  ipcMain.handle('workspace:pick-directory', async (event) => {
    verifyRenderer(event);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择要只读关联的工作目录',
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('task-memory:open', async (event, input) => {
    verifyRenderer(event);
    const { service: currentService } = requireReadyCore();
    const taskId = z.string().min(1).max(200).parse(input);
    const directory = currentService.resolveTaskMemoryDirectory(taskId);
    const failure = await shell.openPath(directory);
    if (failure) throw new Error('无法打开任务记忆目录，请确认目录仍然存在。');
    return { opened: true as const };
  });
  ipcMain.handle('diagnostics:export', async (event) => {
    verifyRenderer(event);
    const { app: currentApp } = requireReadyCore();
    const response = await currentApp.inject({ method: 'GET', url: '/api/diagnostics' });
    const target = await dialog.showSaveDialog(mainWindow!, {
      title: '导出脱敏诊断包',
      defaultPath: `toomanytasks-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (target.canceled || !target.filePath) return { saved: false };
    const { writeFile } = await import('node:fs/promises');
    const diagnostics = response.json() as Record<string, unknown>;
    await writeFile(target.filePath, JSON.stringify({
      ...diagnostics,
      desktop: {
        version: app.getVersion(),
        platform: process.platform,
        packaged: app.isPackaged,
      },
    }, null, 2), 'utf8');
    return { saved: true, path: target.filePath };
  });
}

app.on('second-instance', () => showWindow());
app.on('before-quit', (event) => {
  quitting = true;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownRequested) return;
  shutdownRequested = true;
  void requestShutdown('app-quit').finally(() => app.quit());
});
app.on('window-all-closed', () => {
  // 托盘应用由“完全退出”显式结束，不因没有可见窗口而退出。
});

async function bootstrap() {
  if (!singleInstance) return;
  await lifecycle.start(async () => {
    await app.whenReady();
    await registerAppProtocol();
    await createCore();
    await startConfiguredFeishu();
    try {
      await startOAuthCallbackServer();
    } catch {
      await stopOAuthCallbackServer().catch(() => undefined);
    }
    registerIpc();
    if (!smokeTest || smokeScenario === 'tray_exit') createTray();
    await createWindow();
    await showLegacyDatabaseNotice();
  });
  await runSmokeRuntime();
  if (await runWindowCloseScenario()) return;
  if (smokeTest && smokeScenario === 'tray_exit') {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    requestTrayExit();
    return;
  }
  if (smokeTest) {
    await waitForSmokeRelease();
    quitting = true;
    await requestShutdown('app-quit');
    app.quit();
  }
}

void bootstrap().catch((error) => {
  if (lifecycle.phase === 'stopped') {
    process.exitCode = 1;
    return;
  }
  void failBootstrap(error);
});
