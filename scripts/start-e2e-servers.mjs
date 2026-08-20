import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const serverEntry = join(repoRoot, 'apps', 'server', 'tests', 'e2e-server.ts');
const e2eRoot = join(repoRoot, 'tmp', 'e2e');
const runRoot = join(e2eRoot, `run-${Date.now().toString(36)}-${process.pid}-${randomUUID()}`);
const runToken = process.env.E2E_RUN_TOKEN;
if (!runToken || !/^[0-9a-f-]{36}$/i.test(runToken)) throw new Error('E2E controller requires a valid E2E_RUN_TOKEN.');
const servers = [];
const lifecycle = { phase: 'starting', exitCode: undefined };
let resolveStop;
const stopRequested = new Promise((resolveStopRequest) => { resolveStop = resolveStopRequest; });

const lifecycleTransitions = {
  starting: new Set(['ready', 'failed']),
  ready: new Set(['shutdown-requested', 'failed']),
  'shutdown-requested': new Set(['shutdown-accepted', 'failed']),
  'shutdown-accepted': new Set(['failed', 'cleaning']),
  failed: new Set(['cleaning']),
  cleaning: new Set(['stopped']),
  stopped: new Set(),
};

function transitionLifecycle(nextPhase) {
  if (lifecycle.phase === nextPhase) return;
  if (!lifecycleTransitions[lifecycle.phase]?.has(nextPhase)) {
    throw new Error(`Invalid E2E controller lifecycle transition ${lifecycle.phase} -> ${nextPhase}.`);
  }
  lifecycle.phase = nextPhase;
}

function e2ePort(name, fallback) {
  const port = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a valid TCP port.`);
  return port;
}

const targets = [
  { name: 'browser-mobile', port: e2ePort('E2E_MOBILE_PORT', 4412) },
  { name: 'browser-desktop', port: e2ePort('E2E_DESKTOP_PORT', 4410) },
];
if (targets[0].port === targets[1].port) throw new Error('E2E desktop and mobile ports must be different.');

function requestStop(exitCode, message) {
  if (lifecycle.exitCode !== undefined) return;
  if (message) process.stderr.write(`${message}\n`);
  if (exitCode !== 0 && lifecycle.phase !== 'failed') transitionLifecycle('failed');
  lifecycle.exitCode = exitCode;
  resolveStop(exitCode);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function waitUntilReady(target, child) {
  return new Promise((resolveReady, rejectReady) => {
    const finish = (error) => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) rejectReady(error);
      else resolveReady();
    };
    const onMessage = (message) => {
      if (message && typeof message === 'object' && message.type === 'ready'
        && message.runToken === runToken && message.port === target.port) finish();
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
      finish(new Error(`E2E server ${target.name} on ${target.port} exited before readiness (${code ?? signal ?? 'unknown'}).`));
    };
    const timeout = setTimeout(() => {
      finish(new Error(`E2E server ${target.name} on ${target.port} did not report readiness within 30000 ms.`));
    }, 30_000);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function startServer(target) {
  const taskMemoryRoot = join(runRoot, target.name, 'task-memory');
  const child = spawn(process.execPath, [tsxCli, serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(target.port),
      DATABASE_URL: ':memory:',
      DATABASE_PROVIDER: 'sqlite',
      POSTGRES_URL: '',
      TASK_MEMORY_ROOT: taskMemoryRoot,
      FEISHU_EXTERNAL_ENABLED: 'false',
      FEISHU_SCAN_ENABLED: 'false',
      FEISHU_APP_ID: '',
      FEISHU_APP_SECRET: '',
      FEISHU_OAUTH_REDIRECT_URI: '',
      FEISHU_OAUTH_SCOPES: '',
      FEISHU_ENCRYPT_KEY: '',
      FEISHU_VERIFICATION_TOKEN: '',
      TOKEN_ENCRYPTION_KEY: '',
      LLM_PROVIDER: 'rule_mock',
      LLM_MODEL: '',
      LLM_API_BASE: '',
      LLM_API_KEY: '',
      WORKSPACE_READ_ENABLED: 'false',
      WORKSPACE_WRITE_ENABLED: 'false',
      WORKSPACE_ALLOWED_PATHS: '[]',
      E2E_RUN_TOKEN: runToken,
      E2E_ALLOW_FAULT_EXIT_ZERO: [
        process.env.E2E_FAULT_EXIT_AFTER_READY,
        process.env.E2E_FAULT_EXIT_BEFORE_SHUTDOWN_ACK,
      ].includes(target.name) ? 'true' : 'false',
      E2E_FAIL_STARTUP: process.env.E2E_FAULT_FAIL_STARTUP === target.name ? 'true' : 'false',
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  servers.push({ child, target });
  child.once('error', (error) => {
    if (lifecycle.phase === 'starting' || lifecycle.phase === 'ready' || lifecycle.phase === 'shutdown-requested') {
      requestStop(1, `E2E server ${target.name} failed to launch: ${describeError(error)}`);
    }
  });
  child.once('exit', (code, signal) => {
    if (lifecycle.phase === 'starting' || lifecycle.phase === 'ready' || lifecycle.phase === 'shutdown-requested') {
      requestStop(1, `E2E server ${target.name} exited unexpectedly (${code ?? signal ?? 'unknown'}).`);
    }
  });
  await waitUntilReady(target, child);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveWait(true);
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolveWait(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopServer({ child, target }) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) {
    await Promise.race([
      new Promise((resolveSend) => {
        try {
          child.send({ type: 'shutdown', runToken }, () => resolveSend());
        } catch {
          resolveSend();
        }
      }),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
  }
  if (await waitForExit(child, 5_000)) return;
  if (process.platform === 'win32') {
    await new Promise((resolveKill) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => resolveKill());
      killer.once('exit', () => resolveKill());
    });
  } else {
    child.kill('SIGKILL');
  }
  if (!(await waitForExit(child, 5_000))) {
    throw new Error(`E2E server ${target.name} did not exit after forced termination.`);
  }
}

async function cleanup() {
  if (lifecycle.phase !== 'cleaning') transitionLifecycle('cleaning');
  const errors = [];
  for (const server of [...servers].reverse()) {
    try {
      await stopServer(server);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 0) {
    const normalizedRunRoot = resolve(runRoot);
    const normalizedE2eRoot = resolve(e2eRoot);
    if (!normalizedRunRoot.startsWith(`${normalizedE2eRoot}${sep}`)) {
      errors.push(new Error('Refusing to clean a path outside the E2E root.'));
    } else {
      try {
        await rm(normalizedRunRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'E2E server cleanup failed.');
  transitionLifecycle('stopped');
}

process.once('SIGINT', () => { requestStop(130); });
process.once('SIGTERM', () => { requestStop(143); });
process.once('disconnect', () => { requestStop(1, 'E2E server controller lost its Playwright parent.'); });
process.on('message', (message) => {
  if (!message || typeof message !== 'object' || message.runToken !== runToken) return;
  if (message.type === 'shutdown' && typeof message.shutdownToken === 'string'
    && lifecycle.phase === 'ready' && lifecycle.exitCode === undefined) {
    if (!process.send) {
      requestStop(1, 'E2E server controller cannot acknowledge Playwright shutdown.');
      return;
    }
    transitionLifecycle('shutdown-requested');
    const faultTarget = process.env.E2E_FAULT_EXIT_BEFORE_SHUTDOWN_ACK;
    if (faultTarget) {
      const server = servers.find(({ target }) => target.name === faultTarget);
      if (!server) {
        requestStop(1, `Unknown E2E_FAULT_EXIT_BEFORE_SHUTDOWN_ACK target: ${faultTarget}.`);
      } else {
        server.child.send({ type: 'fault-exit-zero', runToken });
      }
      return;
    }
    process.send({ type: 'shutdown-accepted', runToken, shutdownToken: message.shutdownToken }, (error) => {
      if (error) requestStop(1, `E2E server controller failed to acknowledge shutdown: ${describeError(error)}`);
      else if (lifecycle.phase === 'shutdown-requested') {
        transitionLifecycle('shutdown-accepted');
        requestStop(0);
      }
    });
  }
});

let exitCode = 0;
try {
  // Start mobile first; Playwright global setup waits for both isolated test fixtures.
  for (const target of targets) {
    await startServer(target);
    if (lifecycle.exitCode !== undefined) throw new Error('E2E server startup was interrupted.');
  }
  if (!process.send) throw new Error('E2E server controller requires an IPC parent.');
  transitionLifecycle('ready');
  await new Promise((resolveReady, rejectReady) => {
    process.send({ type: 'ready', runToken, ports: targets.map(({ port }) => port) }, (error) => {
      if (error) rejectReady(error);
      else resolveReady();
    });
  });
  const faultTarget = process.env.E2E_FAULT_EXIT_AFTER_READY;
  if (faultTarget) {
    const server = servers.find(({ target }) => target.name === faultTarget);
    if (!server) throw new Error(`Unknown E2E_FAULT_EXIT_AFTER_READY target: ${faultTarget}.`);
    server.child.send({ type: 'fault-exit-zero', runToken });
  }
  exitCode = await stopRequested;
} catch (error) {
  process.stderr.write(`E2E server startup failed: ${describeError(error)}\n`);
  if (lifecycle.phase !== 'failed') transitionLifecycle('failed');
  exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    exitCode = 1;
  }
  if (process.connected) process.disconnect();
  process.exitCode = exitCode;
}
