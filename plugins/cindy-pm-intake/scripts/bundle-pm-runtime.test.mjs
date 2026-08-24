import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  esbuildModulePath,
  normalizeGeneratedText,
  pinnedEsbuildVersion,
  root,
  runtimeBuildOptions,
  runtimeEntry,
  runtimeOutput,
  withBundleLock,
  writeTextAtomically,
} from './bundle-pm-runtime.mjs';

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
