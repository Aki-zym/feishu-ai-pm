import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyE2eBuildProvenance } from '../../scripts/e2e-build-provenance.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const controllerPath = join(repoRoot, 'scripts', 'start-e2e-servers.mjs');

function e2ePort(name, fallback) {
  const port = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a valid TCP port.`);
  return port;
}

function runCommand(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit', windowsHide: true });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} failed (${code ?? signal ?? 'unknown'}).`));
    });
  });
}

function createExitRecord(child, lifecycle) {
  const record = { result: undefined, promise: undefined };
  record.promise = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      record.result = { code, signal, phase: lifecycle.phase };
      resolveExit(record.result);
    });
  });
  return record;
}

function exitValue(result) {
  return result.code ?? result.signal ?? 'unknown';
}

const lifecycleTransitions = {
  starting: new Set(['ready', 'failed', 'forcing']),
  ready: new Set(['shutdown-requested', 'failed', 'forcing']),
  'shutdown-requested': new Set(['shutdown-accepted', 'failed', 'forcing']),
  'shutdown-accepted': new Set(['exited', 'forcing']),
  failed: new Set(['forcing', 'exited']),
  forcing: new Set(['exited']),
  exited: new Set(),
};

function transitionLifecycle(lifecycle, nextPhase) {
  if (lifecycle.phase === nextPhase) return;
  if (!lifecycleTransitions[lifecycle.phase]?.has(nextPhase)) {
    throw new Error(`Invalid Playwright E2E lifecycle transition ${lifecycle.phase} -> ${nextPhase}.`);
  }
  lifecycle.phase = nextPhase;
}

function waitForExit(record, timeoutMs) {
  if (record.result) return Promise.resolve(record.result);
  return new Promise((resolveWait) => {
    const timeout = setTimeout(() => resolveWait(null), timeoutMs);
    void record.promise.then((result) => {
      clearTimeout(timeout);
      resolveWait(result);
    });
  });
}

function waitUntilReady(child, lifecycle, ports) {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('error', onError);
      if (error) rejectReady(error);
      else resolveReady();
    };
    const onMessage = (message) => {
      if (message && typeof message === 'object' && message.type === 'ready'
        && message.runToken === lifecycle.runToken
        && Array.isArray(message.ports) && ports.every((port) => message.ports.includes(port))) {
        transitionLifecycle(lifecycle, 'ready');
        finish();
      }
    };
    const onError = (error) => finish(error);
    const timeout = setTimeout(() => finish(new Error('E2E server controller did not report both browser fixtures ready within 30000 ms.')), 30_000);
    child.on('message', onMessage);
    child.once('error', onError);
    void lifecycle.exit.promise.then((result) => {
      finish(new Error(`E2E server controller exited before readiness (${exitValue(result)}).`));
    });
  });
}

function requestShutdown(child, lifecycle, shutdownToken) {
  return new Promise((resolveRequest) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('message', onMessage);
      resolveRequest(outcome);
    };
    const onMessage = (message) => {
      if (message && typeof message === 'object' && message.type === 'shutdown-accepted'
        && message.runToken === lifecycle.runToken && message.shutdownToken === shutdownToken) {
        transitionLifecycle(lifecycle, 'shutdown-accepted');
        finish({ kind: 'accepted' });
      }
    };
    const timeout = setTimeout(() => finish({ kind: 'timeout' }), 5_000);
    child.on('message', onMessage);
    void lifecycle.exit.promise.then((result) => finish({ kind: 'exit', result }));
    try {
      child.send({ type: 'shutdown', runToken: lifecycle.runToken, shutdownToken }, (error) => {
        if (error) finish({ kind: 'send-error', error });
      });
    } catch (error) {
      finish({ kind: 'send-error', error });
    }
  });
}

async function forceStopController(child, lifecycle) {
  if (lifecycle.exit.result) return lifecycle.exit.result;
  if (lifecycle.phase !== 'forcing') transitionLifecycle(lifecycle, 'forcing');
  if (process.platform === 'win32') {
    await new Promise((resolveKill) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => resolveKill());
      killer.once('exit', () => resolveKill());
    });
  } else {
    child.kill('SIGKILL');
  }
  const result = await waitForExit(lifecycle.exit, 5_000);
  if (!result) throw new Error('E2E server controller did not exit after forced termination.');
  return result;
}

async function stopController(child, lifecycle) {
  if (!child.pid) throw new Error('E2E server controller never received a process id.');
  if (lifecycle.phase !== 'ready') {
    if (lifecycle.exit.result) {
      throw new Error(`E2E server controller exited before Playwright requested shutdown (${exitValue(lifecycle.exit.result)}).`);
    }
    throw new Error(`E2E server controller cannot begin shutdown from lifecycle phase ${lifecycle.phase}.`);
  }
  if (lifecycle.exit.result) {
    throw new Error(`E2E server controller exited before Playwright requested shutdown (${exitValue(lifecycle.exit.result)}).`);
  }
  const shutdownToken = randomUUID();
  transitionLifecycle(lifecycle, 'shutdown-requested');
  const outcome = await requestShutdown(child, lifecycle, shutdownToken);
  if (outcome.kind === 'exit') {
    transitionLifecycle(lifecycle, 'failed');
    throw new Error(`E2E server controller exited before accepting Playwright shutdown (${exitValue(outcome.result)}).`);
  }
  if (outcome.kind !== 'accepted') {
    await forceStopController(child, lifecycle);
    const detail = outcome.kind === 'send-error' && outcome.error instanceof Error ? `: ${outcome.error.message}` : '';
    throw new Error(`E2E server controller did not accept Playwright shutdown (${outcome.kind})${detail}.`);
  }
  const result = await waitForExit(lifecycle.exit, 15_000);
  if (!result) {
    await forceStopController(child, lifecycle);
    throw new Error('E2E server controller did not exit within 15000 ms after accepting Playwright shutdown.');
  }
  if (result.code !== 0) {
    throw new Error(`E2E server controller exited during requested shutdown (${exitValue(result)}).`);
  }
  transitionLifecycle(lifecycle, 'exited');
}

export async function launchE2eController({ build = true, captureOutput = false, ports: requestedPorts, controllerEnv = {} } = {}) {
  const mobilePort = requestedPorts?.mobile ?? e2ePort('E2E_MOBILE_PORT', 4412);
  const desktopPort = requestedPorts?.desktop ?? e2ePort('E2E_DESKTOP_PORT', 4410);
  if (mobilePort === desktopPort) throw new Error('E2E desktop and mobile ports must be different.');
  const ports = [mobilePort, desktopPort];
  const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('Unable to locate the npm CLI for E2E builds.');
  if (build) {
    await runCommand(process.execPath, [npmCli, 'run', 'build', '-w', '@ai-pm/web']);
    await runCommand(process.execPath, [npmCli, 'run', 'build', '-w', '@ai-pm/server']);
  }

  const runToken = randomUUID();
  const output = { stdout: '', stderr: '' };
  const controller = spawn(process.execPath, [controllerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...controllerEnv,
      NODE_ENV: 'test',
      E2E_RUN_TOKEN: runToken,
      E2E_MOBILE_PORT: String(mobilePort),
      E2E_DESKTOP_PORT: String(desktopPort),
    },
    stdio: captureOutput ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  if (captureOutput) {
    controller.stdout?.on('data', (chunk) => { output.stdout += String(chunk); });
    controller.stderr?.on('data', (chunk) => { output.stderr += String(chunk); });
  }
  const lifecycle = { runToken, phase: 'starting', exit: undefined };
  lifecycle.exit = createExitRecord(controller, lifecycle);
  const closed = new Promise((resolveClose) => controller.once('close', (code, signal) => resolveClose({ code, signal })));

  try {
    await waitUntilReady(controller, lifecycle, ports);
  } catch (error) {
    if (lifecycle.phase !== 'failed' && lifecycle.phase !== 'forcing' && lifecycle.phase !== 'exited') {
      transitionLifecycle(lifecycle, 'failed');
    }
    await forceStopController(controller, lifecycle).catch(() => undefined);
    throw error;
  }

  return {
    closed,
    exit: lifecycle.exit.promise,
    output,
    teardown: async () => stopController(controller, lifecycle),
  };
}

export default async function globalSetup() {
  const reuseBuild = process.env.E2E_REUSE_BUILD === '1';
  if (reuseBuild) verifyE2eBuildProvenance();
  const launched = await launchE2eController({ build: !reuseBuild });
  return launched.teardown;
}
