import { acquireBundleLease, releaseBundleLease, withBundleLock } from '../bundle-pm-runtime.mjs';

const lockPath = process.env.CINDY_TEST_BUNDLE_LOCK_PATH;
const mode = process.env.CINDY_TEST_BUNDLE_LOCK_MODE ?? 'contend';
if (!lockPath || typeof process.send !== 'function') throw new Error('bundle lock contender requires an IPC channel and lock path');

function waitForMessage(expected) {
  return new Promise((resolve) => {
    const listener = (message) => {
      if (message === expected) {
        process.off('message', listener);
        resolve();
      }
    };
    process.on('message', listener);
  });
}

process.send({ type: 'ready', pid: process.pid });
await waitForMessage('start');

if (mode === 'crash') {
  await acquireBundleLease({ lockPath, timeoutMs: 5_000, retryMs: 5 });
  process.send({ type: 'acquired', pid: process.pid });
  process.exit(0);
}

try {
  await withBundleLock(async () => {
    process.send({ type: 'enter', pid: process.pid });
    await waitForMessage('release');
    process.send({ type: 'exit', pid: process.pid });
  }, { lockPath, timeoutMs: 10_000, retryMs: 5 });
  process.send({ type: 'done', pid: process.pid });
} catch (error) {
  process.send({ type: 'error', pid: process.pid, code: error?.code, message: error?.message });
  process.exitCode = 1;
}

