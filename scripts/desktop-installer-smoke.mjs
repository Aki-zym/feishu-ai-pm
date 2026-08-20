import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = resolve(repoRoot, 'tmp');
const installerArgIndex = process.argv.indexOf('--installer');
const installerArg = installerArgIndex >= 0 ? process.argv[installerArgIndex + 1] : 'release/Feishu-AI-PM-0.2.0-x64-Setup.exe';
const productNameArgIndex = process.argv.indexOf('--product-name');
const productName = productNameArgIndex >= 0 ? process.argv[productNameArgIndex + 1] : '数据 PM';
const installerPath = resolve(repoRoot, installerArg);

if (!existsSync(installerPath)) {
  throw new Error(`找不到安装包：${installerArg}`);
}

mkdirSync(tmpRoot, { recursive: true });
const smokeRoot = mkdtempSync(join(tmpRoot, 'installer-smoke-'));
const installDir = join(smokeRoot, 'installed');
const userDataDir = join(smokeRoot, 'user-data');
const secondInstanceUserDataDir = join(smokeRoot, 'second-instance-user-data');
const windowCloseUserDataDir = join(smokeRoot, 'window-close-user-data');
const trayExitUserDataDir = join(smokeRoot, 'tray-exit-user-data');
const startupFaultUserDataDir = join(smokeRoot, 'startup-fault-user-data');
const reloadFaultUserDataDir = join(smokeRoot, 'reload-fault-user-data');
const oauthFaultUserDataDir = join(smokeRoot, 'oauth-fault-user-data');
const legacyUserDataDir = join(smokeRoot, 'legacy-user-data');
const failureUserDataDir = join(smokeRoot, 'failure-user-data');
mkdirSync(installDir, { recursive: true });
mkdirSync(userDataDir, { recursive: true });
mkdirSync(secondInstanceUserDataDir, { recursive: true });
mkdirSync(windowCloseUserDataDir, { recursive: true });
mkdirSync(trayExitUserDataDir, { recursive: true });
mkdirSync(startupFaultUserDataDir, { recursive: true });
mkdirSync(reloadFaultUserDataDir, { recursive: true });
mkdirSync(oauthFaultUserDataDir, { recursive: true });
mkdirSync(join(legacyUserDataDir, 'data'), { recursive: true });
mkdirSync(join(legacyUserDataDir, 'config'), { recursive: true });
mkdirSync(join(failureUserDataDir, 'data'), { recursive: true });
const legacyDatabasePath = join(legacyUserDataDir, 'data', 'ai-pm.sqlite');
const newDatabasePath = join(legacyUserDataDir, 'data', 'ai-pm-v1.sqlite');
const settingsPath = join(legacyUserDataDir, 'config', 'settings.json');
writeFileSync(legacyDatabasePath, Buffer.from('synthetic legacy database sentinel', 'utf8'));
writeFileSync(settingsPath, JSON.stringify({
  setupComplete: true,
  launchAtLogin: false,
  logRetentionDays: 17,
  feishu: { appId: 'synthetic-app', externalEnabled: false, domain: 'feishu', eventMode: 'websocket', oauthRedirectUri: 'http://127.0.0.1:4311/oauth/feishu/callback', oauthScopes: '', scanEnabled: false, scanIntervalSeconds: 60, groupIds: [] },
  llm: { provider: 'rule_mock', model: '', apiBase: '', timeoutMs: 30000, maxRetries: 2 },
  workspace: { readEnabled: false, allowedPaths: [] },
}, null, 2));
writeFileSync(join(legacyUserDataDir, 'config', 'config-generation.json'), JSON.stringify({ generation: 0 }));
const legacyDatabaseHash = createHash('sha256').update(readFileSync(legacyDatabasePath)).digest('hex');
writeFileSync(join(failureUserDataDir, 'data', 'ai-pm-v1.sqlite'), Buffer.alloc(0));

function shortcutSnapshot() {
  const roots = [
    join(process.env.USERPROFILE ?? '', 'Desktop'),
    join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const snapshot = {};
  const visit = (directory) => {
    if (!directory || !existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.lnk') && /数据\s*PM|Feishu[- ]?AI[- ]?PM/i.test(entry.name)) {
        try {
          snapshot[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
    }
  };
  for (const root of roots) visit(root);
  return snapshot;
}

function run(command, args, env = process.env, timeoutMs = 120_000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      terminateProcessTree(child.pid);
      reject(new Error(`${command} 运行超过 ${timeoutMs} ms。`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', async (code, signal) => {
      clearTimeout(timer);
      try {
        await assertProcessExited(child.pid);
        resolveRun({ code: code ?? -1, signal, stdout, stderr, processExited: true });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
}

function processExists(pid) {
  if (!pid) return Promise.resolve(false);
  if (process.platform === 'win32') {
    return new Promise((resolveExists) => {
      const probe = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
      let output = '';
      probe.stdout?.on('data', (chunk) => { output += String(chunk); });
      probe.once('error', () => resolveExists(false));
      probe.once('close', () => resolveExists(new RegExp(`"${pid}"`, 'u').test(output)));
    });
  }
  try {
    process.kill(pid, 0);
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

async function assertProcessExited(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processExists(pid))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`桌面进程未在冒烟退出后清理：PID ${pid}`);
}

function queryWindowsProcessesUnder(directory) {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const escapedRoot = resolve(directory).replace(/'/g, "''");
  const script = `
$root = [System.IO.Path]::GetFullPath('${escapedRoot}')
$prefix = $root.TrimEnd('\\') + '\\'
Get-CimInstance Win32_Process | ForEach-Object {
  if ($_.ExecutablePath) {
    try {
      $full = [System.IO.Path]::GetFullPath($_.ExecutablePath)
      if ($full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        "$($_.ProcessId)|$full"
      }
    } catch {}
  }
}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolveProcesses, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`无法查询安装目录进程（退出码 ${code}）：${stderr.slice(-200)}`));
        return;
      }
      const processes = stdout.split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => /^\d+\|/u.test(line))
        .map((line) => {
          const [pid, executablePath] = line.split('|', 2);
          return { pid: Number(pid), executablePath };
        });
      resolveProcesses(processes);
    });
  });
}

async function terminateInstalledProcesses(directory) {
  if (process.platform !== 'win32') return;
  for (const process of await queryWindowsProcessesUnder(directory)) {
    if (process.pid > 0) spawnSync('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
}

async function assertInstalledProcessTreeExited(directory, timeoutMs = 10_000) {
  if (process.platform !== 'win32') return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await queryWindowsProcessesUnder(directory)).length === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  await terminateInstalledProcesses(directory);
  throw new Error('安装目录内仍有 Electron 进程，进程树清理合同失败。');
}

async function runDesktopSmoke(executable, args, env, timeoutMs) {
  const result = await run(executable, args, env, timeoutMs);
  try {
    await assertInstalledProcessTreeExited(installDir);
  } catch (error) {
    await terminateInstalledProcesses(installDir).catch(() => undefined);
    throw error;
  }
  return result;
}

async function runInteractiveScenario(executable, scenario, userData) {
  return runDesktopSmoke(executable, ['--smoke-test'], {
    ...process.env,
    AI_PM_SMOKE_USER_DATA: userData,
    AI_PM_SMOKE_SCENARIO: scenario,
  }, 60_000);
}

async function runSecondInstanceScenario(executable, userData) {
  const releaseFile = join(smokeRoot, 'second-instance.release');
  const first = startSmokeProcess(executable, ['--smoke-test'], {
    ...process.env,
    AI_PM_SMOKE_USER_DATA: userData,
    AI_PM_SMOKE_SCENARIO: 'second_instance',
    AI_PM_SMOKE_WAIT_FILE: releaseFile,
  }, 60_000);
  let second;
  let firstResult;
  try {
    await first.ready;
    second = await run(executable, ['--smoke-test'], {
      ...process.env,
      AI_PM_SMOKE_USER_DATA: userData,
      AI_PM_SMOKE_SCENARIO: 'second_instance',
    }, 30_000);
    if (second.code !== 0 || !second.processExited || !second.stdout.includes('DESKTOP_SINGLE_INSTANCE_REJECTED:{"clean":true}')) {
      throw new Error(`第二实例未被单实例锁干净拒绝（退出码 ${second.code}）。${second.stdout.slice(-500)}${second.stderr.slice(-500)}`);
    }
  } finally {
    writeFileSync(releaseFile, 'release', 'utf8');
    firstResult = await first.closed;
  }
  if (firstResult.code !== 0 || !firstResult.processExited || !firstResult.stdout.includes('DESKTOP_SHUTDOWN:')) {
    throw new Error(`第二实例主进程未干净关闭（退出码 ${firstResult.code}）。${firstResult.stderr.slice(-500)}`);
  }
  await assertInstalledProcessTreeExited(installDir);
  return { first: firstResult, second };
}

function markerPayload(output, prefix, label) {
  const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`${label} 未输出受控标记。`);
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    throw new Error(`${label} 标记不是合法 JSON。`);
  }
}

function assertStopped(output, label) {
  const shutdown = markerPayload(output, 'DESKTOP_SHUTDOWN:', `${label} shutdown`);
  if (shutdown.phase !== 'stopped' || shutdown.clean !== true) {
    throw new Error(`${label} 未以 phase=stopped/clean=true 关闭。`);
  }
}

async function assertShortcutsUnchanged(expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (JSON.stringify(expected) === JSON.stringify(shortcutSnapshot())) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('安装冒烟改变了现有“数据 PM”桌面或开始菜单快捷方式。');
}

function startSmokeProcess(command, args, env = process.env, timeoutMs = 120_000) {
  const child = spawn(command, args, { cwd: repoRoot, env, windowsHide: true });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  let closedResolve;
  let closedReject;
  let readySeen = false;
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const closed = new Promise((resolveClosed, rejectClosed) => {
    closedResolve = resolveClosed;
    closedReject = rejectClosed;
  });
  const timer = setTimeout(() => {
    terminateProcessTree(child.pid);
    const error = new Error(`${command} 场景冒烟超过 ${timeoutMs} ms。`);
    readyReject(error);
    closedReject(error);
  }, timeoutMs);
  const observe = (chunk, stream) => {
    const text = String(chunk);
    if (stream === 'stdout') stdout += text;
    else stderr += text;
    if (!readySeen && stdout.includes('DESKTOP_SMOKE:')) {
      readySeen = true;
      readyResolve();
    }
  };
  child.stdout?.on('data', (chunk) => observe(chunk, 'stdout'));
  child.stderr?.on('data', (chunk) => observe(chunk, 'stderr'));
  child.once('error', (error) => {
    clearTimeout(timer);
    readyReject(error);
    closedReject(error);
  });
  child.once('close', async (code, signal) => {
    clearTimeout(timer);
    try {
      await assertProcessExited(child.pid);
      if (!readySeen) readyReject(new Error(`场景冒烟未输出 DESKTOP_SMOKE 标记。${stderr.slice(-500)}`));
      closedResolve({ code: code ?? -1, signal, stdout, stderr, processExited: true });
    } catch (error) {
      readyReject(error);
      closedReject(error);
    }
  });
  return { child, ready, closed };
}

async function assertPathAbsent(path, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${label} 未完成清理。`);
}

const beforeShortcuts = shortcutSnapshot();
const installedExecutable = join(installDir, `${productName}.exe`);
let installSucceeded = false;
let uninstallExitCode = null;
let smokeSummary = null;
let smokeFailure = null;
let scenarioEvidence = null;
try {
  const installer = await run(installerPath, ['/S', `/D=${installDir}`]);
  if (installer.code !== 0) throw new Error(`安装程序退出码为 ${installer.code}。${installer.stderr.slice(-500)}`);

  if (!existsSync(installedExecutable)) throw new Error(`安装完成后没有找到 ${productName}.exe。`);
  installSucceeded = true;
  const smoke = await runDesktopSmoke(installedExecutable, ['--smoke-test'], { ...process.env, AI_PM_SMOKE_USER_DATA: userDataDir }, 90_000);
  const output = `${smoke.stdout}\n${smoke.stderr}`;
  if (smoke.code !== 0 || !smoke.processExited || !output.includes('DESKTOP_SMOKE:') || !output.includes('DESKTOP_SHUTDOWN:')) {
    throw new Error(`已安装 EXE 冒烟失败（退出码 ${smoke.code}）。${output.slice(-1000)}`);
  }
  assertStopped(output, '正常启动与重载');

  const secondInstance = await runSecondInstanceScenario(installedExecutable, secondInstanceUserDataDir);
  const windowClose = await runInteractiveScenario(installedExecutable, 'window_close', windowCloseUserDataDir);
  const windowCloseOutput = `${windowClose.stdout}\n${windowClose.stderr}`;
  const windowCloseEvidence = markerPayload(windowCloseOutput, 'DESKTOP_WINDOW_CLOSE:', '窗口关闭冒烟');
  if (windowClose.code !== 0 || !windowClose.processExited || windowCloseEvidence?.requested !== true || windowCloseEvidence?.prevented !== true || windowCloseEvidence?.hidden !== true || !windowCloseOutput.includes('DESKTOP_SHUTDOWN:')) {
    throw new Error(`窗口关闭冒烟未产生完整证据（退出码 ${windowClose.code}）。`);
  }

  const trayExit = await runInteractiveScenario(installedExecutable, 'tray_exit', trayExitUserDataDir);
  const trayExitOutput = `${trayExit.stdout}\n${trayExit.stderr}`;
  const trayExitEvidence = markerPayload(trayExitOutput, 'DESKTOP_TRAY_EXIT:', '托盘退出冒烟');
  if (trayExit.code !== 0 || !trayExit.processExited || trayExitEvidence?.requested !== true || !trayExitOutput.includes('DESKTOP_SHUTDOWN:')) {
    throw new Error(`托盘退出冒烟未产生完整证据（退出码 ${trayExit.code}）。`);
  }

  scenarioEvidence = {
    install: { executed: true, exit_code: installer.code, evidence_id: 'L5-62-install' },
    startup: { executed: true, exit_code: smoke.code, evidence_id: 'L5-62-startup' },
    second_instance: { executed: true, exit_code: secondInstance.first.code, secondary_exit_code: secondInstance.second.code, evidence_id: 'L5-62-second-instance' },
    window_close: { executed: true, exit_code: windowClose.code, evidence_id: 'L5-62-window-close' },
    tray_exit: { executed: true, exit_code: trayExit.code, evidence_id: 'L5-62-tray-exit' },
  };

  const startupFailure = await runDesktopSmoke(installedExecutable, ['--smoke-test'], {
    ...process.env,
    AI_PM_SMOKE_USER_DATA: startupFaultUserDataDir,
    AI_PM_DESKTOP_FAULT: 'startup-core',
  }, 30_000);
  const startupOutput = `${startupFailure.stdout}\n${startupFailure.stderr}`;
  if (startupFailure.code !== 1 || !startupFailure.processExited || !startupOutput.includes('DESKTOP_BOOTSTRAP_FAILURE:')) {
    throw new Error(`startup-core 故障未按受控合同退出（退出码 ${startupFailure.code}）。`);
  }
  assertStopped(startupOutput, 'startup-core 故障');
  if (!startupOutput.includes('"to":"failed"') || !startupOutput.includes('"to":"stopped"')) {
    throw new Error('startup-core 故障缺少 failed→stopped 生命周期标记。');
  }

  const reloadFailure = await runDesktopSmoke(installedExecutable, ['--smoke-test'], {
    ...process.env,
    AI_PM_SMOKE_USER_DATA: reloadFaultUserDataDir,
    AI_PM_DESKTOP_FAULT: 'reload',
  }, 30_000);
  const reloadOutput = `${reloadFailure.stdout}\n${reloadFailure.stderr}`;
  if (reloadFailure.code !== 1 || !reloadFailure.processExited || !reloadOutput.includes('DESKTOP_SHUTDOWN:') || !reloadOutput.includes('"to":"failed"')) {
    throw new Error(`配置重载故障未按受控生命周期退出（退出码 ${reloadFailure.code}）。`);
  }
  assertStopped(reloadOutput, '配置重载故障');

  const oauthFailure = await runDesktopSmoke(installedExecutable, ['--smoke-test'], {
    ...process.env,
    AI_PM_SMOKE_USER_DATA: oauthFaultUserDataDir,
    AI_PM_DESKTOP_FAULT: 'oauth',
  }, 30_000);
  const oauthOutput = `${oauthFailure.stdout}\n${oauthFailure.stderr}`;
  const oauthSmoke = markerPayload(oauthOutput, 'DESKTOP_SMOKE:', 'OAuth 故障降级 Smoke');
  if (oauthFailure.code !== 0
    || !oauthFailure.processExited
    || oauthSmoke?.hasDesktopBridge !== true
    || oauthSmoke?.runtimeReload?.firstStatus !== 200
    || oauthSmoke?.runtimeReload?.secondStatus !== 200
    || oauthOutput.includes('"to":"failed"')) {
    throw new Error(`OAuth callback 故障未按受控降级合同运行（退出码 ${oauthFailure.code}）。`);
  }
  assertStopped(oauthOutput, 'OAuth callback 故障降级');

  const legacySmoke = await runDesktopSmoke(installedExecutable, ['--smoke-test'], {
    ...process.env,
    AI_PM_SMOKE_USER_DATA: legacyUserDataDir,
  }, 30_000);
  const legacyOutput = `${legacySmoke.stdout}\n${legacySmoke.stderr}`;
  const legacyMarker = legacyOutput.split(/\r?\n/u).find((line) => line.startsWith('DESKTOP_LEGACY_DATABASE_RETAINED:'));
  if (legacySmoke.code !== 0 || !legacySmoke.processExited || !legacyMarker || !legacyOutput.includes('DESKTOP_SMOKE:')) {
    throw new Error(`检测到旧数据库后新库启动冒烟失败（退出码 ${legacySmoke.code}）。`);
  }
  let legacyPayload;
  try {
    legacyPayload = JSON.parse(legacyMarker.slice('DESKTOP_LEGACY_DATABASE_RETAINED:'.length));
  } catch {
    throw new Error('旧数据库保留冒烟未输出合法受控提示标记。');
  }
  if (legacyOutput.includes(legacyUserDataDir)
    || legacyPayload?.message !== '旧数据已保留，当前已使用新数据库。'
    || !existsSync(newDatabasePath)
    || createHash('sha256').update(readFileSync(legacyDatabasePath)).digest('hex') !== legacyDatabaseHash) {
    throw new Error('旧数据库未保持原样或新数据库未建立。');
  }
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (settings?.feishu?.appId !== 'synthetic-app') {
    throw new Error('旧数据库切换时配置未保留。');
  }

  const restartSmoke = await runDesktopSmoke(installedExecutable, ['--smoke-test'], {
    ...process.env,
    AI_PM_SMOKE_USER_DATA: legacyUserDataDir,
  }, 30_000);
  const restartOutput = `${restartSmoke.stdout}\n${restartSmoke.stderr}`;
  if (restartSmoke.code !== 0 || !restartSmoke.processExited || !restartOutput.includes('DESKTOP_SMOKE:')) {
    throw new Error(`新数据库重启冒烟失败（退出码 ${restartSmoke.code}）。`);
  }
  if (createHash('sha256').update(readFileSync(legacyDatabasePath)).digest('hex') !== legacyDatabaseHash) {
    throw new Error('新数据库重启后旧数据库字节发生变化。');
  }

  const failureSmoke = await runDesktopSmoke(installedExecutable, ['--smoke-test'], {
    ...process.env,
    AI_PM_SMOKE_USER_DATA: failureUserDataDir,
  }, 30_000);
  const failureOutput = `${failureSmoke.stdout}\n${failureSmoke.stderr}`;
  const failureMarker = failureOutput.split(/\r?\n/u).find((line) => line.startsWith('DESKTOP_BOOTSTRAP_FAILURE:'));
  if (failureSmoke.code !== 1 || !failureSmoke.processExited || !failureMarker) {
    throw new Error(`未知数据库启动错误未按受控合同退出（退出码 ${failureSmoke.code}）。`);
  }
  let failurePayload;
  try {
    failurePayload = JSON.parse(failureMarker.slice('DESKTOP_BOOTSTRAP_FAILURE:'.length));
  } catch {
    throw new Error('未知数据库启动错误未输出合法受控错误标记。');
  }
  if (failureOutput.includes(failureUserDataDir)
    || /SQLITE_[A-Z_]+|[A-Za-z]:\\\\|Error:|at [^\n]+/u.test(String(failurePayload?.message ?? ''))) {
    throw new Error('未知数据库启动错误输出了路径、SQLite 原文或堆栈。');
  }

  smokeSummary = {
    installerExitCode: installer.code,
    appExitCode: smoke.code,
    startupFaultExitCode: startupFailure.code,
    reloadFailureExitCode: reloadFailure.code,
    oauthFaultExitCode: oauthFailure.code,
    legacyDatabaseExitCode: legacySmoke.code,
    restartExitCode: restartSmoke.code,
    bootstrapFailureExitCode: failureSmoke.code,
    legacyDatabaseRetained: true,
    newDatabaseCreated: true,
    configPreserved: true,
    shortcutsUnchanged: true,
    scenarioEvidence,
  };
} catch (error) {
  smokeFailure = error instanceof Error ? error : new Error(String(error));
} finally {
  let cleanupFailure = null;
  try {
    const uninstaller = join(installDir, `Uninstall ${productName}.exe`);
    if (installSucceeded) {
      if (!existsSync(uninstaller)) throw new Error('安装成功后未找到卸载程序。');
      const uninstall = await run(uninstaller, ['/S', '/currentuser'], process.env, 120_000);
      uninstallExitCode = uninstall.code;
      if (uninstall.code !== 0) throw new Error(`测试应用卸载失败（退出码 ${uninstall.code}）。`);
      await assertInstalledProcessTreeExited(installDir);
      await assertPathAbsent(installedExecutable, '卸载后的应用文件');
      await assertPathAbsent(uninstaller, '卸载程序');
      if (!scenarioEvidence) scenarioEvidence = {};
      scenarioEvidence.uninstall = { executed: true, exit_code: uninstall.code, evidence_id: 'L5-62-uninstall', installed_files_removed: true };
    }

    const normalizedRoot = resolve(smokeRoot);
    const allowedRoot = `${tmpRoot}${process.platform === 'win32' ? '\\' : '/'}`;
    if (!normalizedRoot.startsWith(allowedRoot)) throw new Error('临时目录不在仓库 tmp 范围内。');
    rmSync(normalizedRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    if (existsSync(normalizedRoot)) throw new Error('安装冒烟临时目录清理失败。');
    await assertShortcutsUnchanged(beforeShortcuts);
    if (smokeSummary) {
      const requiredScenarioEvidence = ['install', 'startup', 'second_instance', 'window_close', 'tray_exit', 'uninstall'];
      for (const scenario of requiredScenarioEvidence) {
        const evidence = scenarioEvidence?.[scenario];
        if (evidence?.executed !== true || !Number.isInteger(evidence.exit_code) || typeof evidence.evidence_id !== 'string' || evidence.evidence_id.trim() === '') {
          throw new Error(`场景 ${scenario} 缺少 executed、退出码或证据 ID，拒绝生成成功摘要。`);
        }
      }
    }
  } catch (error) {
    cleanupFailure = error instanceof Error ? error : new Error(String(error));
  }

  if (smokeSummary) smokeSummary.uninstallExitCode = uninstallExitCode;
  if (smokeFailure && cleanupFailure) {
    throw new Error(`${smokeFailure.message}；清理阶段也失败：${cleanupFailure.message}`);
  }
  if (cleanupFailure) throw cleanupFailure;
  if (smokeFailure) throw smokeFailure;
  if (smokeSummary) process.stdout.write(`DESKTOP_INSTALLER_SMOKE:${JSON.stringify(smokeSummary)}\n`);
}
