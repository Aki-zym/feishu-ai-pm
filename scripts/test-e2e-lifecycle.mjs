import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e2eRoot = join(repoRoot, 'tmp', 'e2e');

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await closeServer(server);
  if (!port) throw new Error('Unable to reserve a dynamic E2E lifecycle probe port.');
  return port;
}

async function availablePorts() {
  const mobile = await availablePort();
  let desktop = await availablePort();
  while (desktop === mobile) desktop = await availablePort();
  return { mobile, desktop };
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function runDirectories() {
  try {
    return (await readdir(e2eRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolveWait, rejectWait) => {
    const timeout = setTimeout(() => rejectWait(new Error(message)), timeoutMs);
    void promise.then((value) => {
      clearTimeout(timeout);
      resolveWait(value);
    }, (error) => {
      clearTimeout(timeout);
      rejectWait(error);
    });
  });
}

async function verifyScenario(name, run) {
  const before = await runDirectories();
  await run();
  const deadline = Date.now() + 5_000;
  let after = await runDirectories();
  while ((after.length !== before.length || after.some((entry, index) => entry !== before[index]))
    && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    after = await runDirectories();
  }
  assert.deepEqual(after, before, `${name} leaked E2E run directories.`);
  process.stdout.write(`E2E lifecycle scenario passed: ${name}; run directories ${before.length} -> ${after.length}.\n`);
}

const { launchE2eController } = await import('../tests/e2e/global-setup.mjs');

await verifyScenario('normal shutdown requires matching nonce ACK', async () => {
  const launched = await launchE2eController({ build: false, captureOutput: true, ports: await availablePorts() });
  await launched.teardown();
  const exit = await withTimeout(launched.exit, 5_000, 'Normally stopped E2E controller did not exit within 5000 ms.');
  assert.equal(exit.code, 0, `Normally stopped E2E controller exited with ${exit.code ?? exit.signal}.`);
  assert.equal(exit.phase, 'shutdown-accepted', 'Normal controller exit occurred before the matching shutdown ACK.');
  await withTimeout(launched.closed, 5_000, 'Normally stopped E2E controller stdio did not close within 5000 ms.');
});

await verifyScenario('ready server code 0 before shutdown ACK fails', async () => {
  const launched = await launchE2eController({
    build: false,
    captureOutput: true,
    ports: await availablePorts(),
    controllerEnv: { E2E_FAULT_EXIT_AFTER_READY: 'browser-mobile' },
  });
  const exit = await withTimeout(launched.exit, 30_000, 'Fault-injected E2E controller did not exit within 30000 ms.');
  assert.equal(exit.code, 1, `Fault-injected E2E controller exited with ${exit.code ?? exit.signal} instead of 1.`);
  assert.equal(exit.phase, 'ready', 'Unexpected controller exit was incorrectly classified as requested shutdown.');
  await assert.rejects(launched.teardown, /before Playwright requested shutdown/);
  await withTimeout(launched.closed, 5_000, 'Fault-injected E2E controller stdio did not close within 5000 ms.');
  assert.match(launched.output.stderr, /browser-mobile exited unexpectedly \(0\)/);
});

await verifyScenario('server exit before shutdown ACK fails', async () => {
  const launched = await launchE2eController({
    build: false,
    captureOutput: true,
    ports: await availablePorts(),
    controllerEnv: { E2E_FAULT_EXIT_BEFORE_SHUTDOWN_ACK: 'browser-mobile' },
  });
  await assert.rejects(launched.teardown, /before accepting Playwright shutdown/);
  const exit = await withTimeout(launched.exit, 5_000, 'Pre-ACK fault controller did not exit within 5000 ms.');
  assert.equal(exit.code, 1, `Pre-ACK fault controller exited with ${exit.code ?? exit.signal} instead of 1.`);
  assert.equal(exit.phase, 'shutdown-requested', 'Pre-ACK exit was incorrectly classified as accepted shutdown.');
  await withTimeout(launched.closed, 5_000, 'Pre-ACK fault controller stdio did not close within 5000 ms.');
  assert.match(launched.output.stderr, /browser-mobile exited unexpectedly \(0\)/);
});

await verifyScenario('occupied port fails startup', async () => {
  const blocker = createServer();
  await new Promise((resolveListen, rejectListen) => {
    blocker.once('error', rejectListen);
    blocker.listen(0, '127.0.0.1', resolveListen);
  });
  const address = blocker.address();
  const mobile = typeof address === 'object' && address ? address.port : 0;
  if (!mobile) throw new Error('Unable to reserve the lifecycle conflict port.');
  let desktop = await availablePort();
  while (desktop === mobile) desktop = await availablePort();
  try {
    await assert.rejects(
      () => launchE2eController({ build: false, captureOutput: true, ports: { mobile, desktop } }),
      /exited before readiness/,
    );
  } finally {
    await closeServer(blocker);
  }
});

await verifyScenario('injected fixture startup failure is cleaned', async () => {
  const ports = await availablePorts();
  await assert.rejects(
    () => launchE2eController({
      build: false,
      captureOutput: true,
      ports,
      controllerEnv: { E2E_FAULT_FAIL_STARTUP: 'browser-mobile' },
    }),
    /exited before readiness/,
  );
});
