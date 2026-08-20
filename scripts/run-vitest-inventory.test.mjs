import assert from 'node:assert/strict';
import test from 'node:test';
import { inventoryPackagePasses, parseInventoryArgs, parseVitestFileParallelism, parseVitestTestTimeout, vitestSerialFlags } from './run-vitest-inventory.mjs';

test('inventory defaults to every workspace', () => {
  const selection = parseInventoryArgs([]);
  assert.deepEqual(selection.workspaces.map(({ name }) => name), ['server', 'web', 'desktop']);
  assert.equal(selection.target, undefined);
});

test('inventory accepts an explicit workspace and forwards a test file target', () => {
  const selection = parseInventoryArgs(['--workspace', 'server', '--file', 'tests/app.test.ts']);
  assert.deepEqual(selection.workspaces.map(({ name }) => name), ['server']);
  assert.equal(selection.target.repoRelative, 'apps/server/tests/app.test.ts');
  assert.equal(selection.target.workspaceRelative, 'tests/app.test.ts');
});

test('inventory rejects empty, unknown, unsafe, and non-test targets', () => {
  for (const args of [
    ['--workspace'],
    ['--workspace', 'unknown'],
    ['--file', 'apps/server/tests/app.test.ts'],
    ['--workspace', 'server', '--file', '../web/src/App.test.ts'],
    ['--workspace', 'server', '--file', 'src/app.ts'],
    ['--unknown', 'value'],
  ]) {
    assert.throws(() => parseInventoryArgs(args), /Usage:/, args.join(' '));
  }
});

test('inventory timeout defaults to the existing five-second contract and accepts a bounded Windows override', () => {
  assert.equal(parseVitestTestTimeout({}), 5_000);
  assert.equal(parseVitestTestTimeout({ VITEST_TEST_TIMEOUT_MS: '30000' }), 30_000);
  assert.throws(() => parseVitestTestTimeout({ VITEST_TEST_TIMEOUT_MS: '0' }), /Usage:/);
  assert.throws(() => parseVitestTestTimeout({ VITEST_TEST_TIMEOUT_MS: 'not-a-timeout' }), /Usage:/);
});

test('inventory file parallelism defaults on and accepts a controlled Windows serial override', () => {
  assert.equal(parseVitestFileParallelism({}), true);
  assert.equal(parseVitestFileParallelism({ VITEST_FILE_PARALLELISM: 'false' }), false);
  assert.equal(parseVitestFileParallelism({ VITEST_FILE_PARALLELISM: '1' }), true);
  assert.throws(() => parseVitestFileParallelism({ VITEST_FILE_PARALLELISM: 'maybe' }), /Usage:/);
});

test('Windows serial inventory removes the Vitest worker IPC boundary', () => {
  assert.deepEqual(vitestSerialFlags(), [
    '--no-file-parallelism',
    '--maxWorkers=1',
    '--minWorkers=1',
    '--pool=threads',
    '--poolOptions.threads.singleThread',
  ]);
});

test('a passing JSON report cannot hide a nonzero Vitest child exit', () => {
  const report = { numTotalTests: 593, numPassedTests: 593, numFailedTests: 0 };
  assert.equal(inventoryPackagePasses({ code: 1 }, report), false);
  assert.equal(inventoryPackagePasses({ code: 0 }, report), true);
});
