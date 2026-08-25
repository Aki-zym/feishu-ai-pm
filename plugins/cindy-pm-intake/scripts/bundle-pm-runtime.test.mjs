import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  acquireBundleLease,
  esbuildModulePath,
  normalizeGeneratedText,
  pinnedEsbuildVersion,
  releaseBundleLease,
  root,
  runtimeBuildOptions,
  runtimeEntry,
  runtimeOutput,
  withBundleLock,
  writeTextAtomically,
} from './bundle-pm-runtime.mjs';

const contenderFixture = resolve(import.meta.dirname, 'fixtures', 'bundle-lock-contender.mjs');

function waitForChildMessage(child, predicate, timeoutMs = 10_000) {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectMessage(new Error(`timed out waiting for child ${child.pid}`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolveMessage(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectMessage(new Error(`child ${child.pid} exited before the expected message: code=${code}, signal=${signal}`));
    };
    function cleanup() {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function spawnContender(lockPath, mode = 'contend') {
  return fork(contenderFixture, [], {
    cwd: root,
    env: {
      ...process.env,
      CINDY_TEST_BUNDLE_LOCK_PATH: lockPath,
      CINDY_TEST_BUNDLE_LOCK_MODE: mode,
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
}

async function waitForChildExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

async function assertNoLockResidue(directory) {
  assert.deepEqual((await readdir(directory)).filter((entry) => entry.includes('bundle.lock')), []);
}

const staleOwner = () => JSON.stringify({
  pid: 2_147_483_647,
  root,
  token: 'stale-owner-token',
  created_at: '2026-08-24T00:00:00.000Z',
});

test('runtime bundle uses one explicit pinned esbuild configuration', async () => {
  const options = runtimeBuildOptions();
  assert.equal((await import('esbuild')).version, pinnedEsbuildVersion);
  assert.match(esbuildModulePath.replaceAll('\\', '/'), /\/node_modules\/esbuild\/lib\/main\.js$/u);
  assert.equal(options.absWorkingDir, root);
  assert.deepEqual(options.entryPoints, [runtimeEntry]);
  assert.equal(options.outfile, runtimeOutput);
  assert.deepEqual(options.target, ['node24']);
  assert.deepEqual(options.conditions, ['node']);
  assert.deepEqual(options.mainFields, ['main', 'module']);
  assert.equal(options.supported['regexp-unicode-property-escapes'], true);
  assert.equal(options.write, false);
  assert.equal(options.metafile, true);
});

test('bundle lock serializes writers and atomic text replacement leaves no temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cindy-bundle-lock-test-'));
  const lockPath = join(directory, 'bundle.lock');
  const output = join(directory, 'runtime.cjs');
  const order = [];
  try {
    const first = withBundleLock(async () => {
      order.push('first-start');
      await new Promise((resolve) => setTimeout(resolve, 75));
      await writeTextAtomically(output, normalizeGeneratedText('first\r\n  \r\n'));
      order.push('first-end');
    }, { lockPath, timeoutMs: 2_000, retryMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = withBundleLock(async () => {
      order.push('second-start');
      await writeTextAtomically(output, normalizeGeneratedText('second\r\n'));
      order.push('second-end');
    }, { lockPath, timeoutMs: 2_000, retryMs: 10 });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
    assert.equal(await readFile(output, 'utf8'), 'second\n');
    assert.deepEqual((await readdir(directory)).sort(), ['runtime.cjs']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('dead legacy owner recovery serializes twelve real contenders across repeated rounds', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cindy-bundle-lock-contenders-'));
  const lockPath = join(directory, 'bundle.lock');
  try {
    for (let round = 0; round < 6; round += 1) {
      await writeFile(lockPath, staleOwner(), 'utf8');
      const children = Array.from({ length: 12 }, () => spawnContender(lockPath));
      await Promise.all(children.map((child) => waitForChildMessage(child, (message) => message?.type === 'ready')));

      let active = 0;
      let maxOverlap = 0;
      let completed = 0;
      const completion = new Promise((resolveCompletion, rejectCompletion) => {
        for (const child of children) {
          child.on('message', (message) => {
            if (message?.type === 'enter') {
              active += 1;
              maxOverlap = Math.max(maxOverlap, active);
              setTimeout(() => child.send('release'), 25);
            } else if (message?.type === 'exit') {
              active -= 1;
            } else if (message?.type === 'done') {
              completed += 1;
              if (completed === children.length) resolveCompletion();
            } else if (message?.type === 'error') {
              rejectCompletion(new Error(`contender failed: ${message.code ?? 'unknown'} ${message.message ?? ''}`));
            }
          });
          child.once('error', rejectCompletion);
        }
      });
      for (const child of children) child.send('start');
      await completion;
      assert.equal(active, 0, `round ${round + 1} left an active writer`);
      assert.equal(maxOverlap, 1, `round ${round + 1} allowed overlapping writers`);
      assert.deepEqual(await Promise.all(children.map(waitForChildExit)), Array(12).fill(0));
      await assertNoLockResidue(directory);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a delayed stale contender cannot remove the new live owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cindy-bundle-lock-interleave-'));
  const lockPath = join(directory, 'bundle.lock');
  try {
    await writeFile(lockPath, staleOwner(), 'utf8');
    const firstLease = await acquireBundleLease({ lockPath, timeoutMs: 2_000, retryMs: 5 });
    const liveOwner = await readFile(lockPath, 'utf8');
    await assert.rejects(
      acquireBundleLease({ lockPath, timeoutMs: 100, retryMs: 5 }),
      { code: 'BUNDLE_LOCK_TIMEOUT' },
    );
    assert.equal(await readFile(lockPath, 'utf8'), liveOwner);
    await releaseBundleLease(firstLease);
    const secondLease = await acquireBundleLease({ lockPath, timeoutMs: 2_000, retryMs: 5 });
    await releaseBundleLease(secondLease);
    await assertNoLockResidue(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed, unreadable, and foreign-root lock metadata fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cindy-bundle-lock-unsafe-'));
  try {
    const cases = [
      ['malformed.lock', '{not-json', async (path) => assert.equal(await readFile(path, 'utf8'), '{not-json')],
      ['foreign.lock', JSON.stringify({ ...JSON.parse(staleOwner()), root: `${root}-other` }), async (path) => assert.match(await readFile(path, 'utf8'), /-other/u)],
    ];
    for (const [name, content, verify] of cases) {
      const lockPath = join(directory, name);
      await writeFile(lockPath, content, 'utf8');
      let called = false;
      await assert.rejects(
        withBundleLock(async () => { called = true; }, { lockPath, timeoutMs: 100, retryMs: 5 }),
        { code: 'BUNDLE_LOCK_UNSAFE_METADATA' },
      );
      assert.equal(called, false);
      await verify(lockPath);
    }

    const unreadablePath = join(directory, 'unreadable.lock');
    await mkdir(unreadablePath);
    await assert.rejects(
      withBundleLock(async () => assert.fail('unreadable lock must not run the action'), { lockPath: unreadablePath, timeoutMs: 100, retryMs: 5 }),
      { code: 'BUNDLE_LOCK_UNSAFE_METADATA' },
    );
    assert.equal((await stat(unreadablePath)).isDirectory(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('non-owner release and replaced owner identity cannot delete a live lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cindy-bundle-lock-owner-'));
  const lockPath = join(directory, 'bundle.lock');
  try {
    const lease = await acquireBundleLease({ lockPath, timeoutMs: 2_000, retryMs: 5 });
    await assert.rejects(
      releaseBundleLease({ token: lease.token, endpoint: lease.endpoint }),
      { code: 'BUNDLE_LOCK_NOT_OWNER' },
    );
    await assert.rejects(
      acquireBundleLease({ lockPath, timeoutMs: 100, retryMs: 5 }),
      { code: 'BUNDLE_LOCK_TIMEOUT' },
    );

    const replacement = JSON.stringify({ ...JSON.parse(staleOwner()), token: 'replacement-owner' });
    await rm(lockPath);
    await writeFile(lockPath, replacement, 'utf8');
    await assert.rejects(releaseBundleLease(lease), { code: 'BUNDLE_LOCK_UNSAFE_METADATA' });
    assert.equal(await readFile(lockPath, 'utf8'), replacement);
    await rm(lockPath);
    await assertNoLockResidue(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('abnormal process exit releases the endpoint and leaves a safely recoverable owner marker', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cindy-bundle-lock-crash-'));
  const lockPath = join(directory, 'bundle.lock');
  try {
    const child = spawnContender(lockPath, 'crash');
    await waitForChildMessage(child, (message) => message?.type === 'ready');
    child.send('start');
    await waitForChildMessage(child, (message) => message?.type === 'acquired');
    assert.equal(await waitForChildExit(child), 0);
    assert.match(await readFile(lockPath, 'utf8'), /"token":/u);

    const recovered = await acquireBundleLease({ lockPath, timeoutMs: 2_000, retryMs: 5 });
    await releaseBundleLease(recovered);
    await assertNoLockResidue(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
