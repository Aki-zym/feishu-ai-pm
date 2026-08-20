import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findForbiddenPlaywrightDirectives,
  summarizePlaywrightReport,
  verifyPlaywrightExecution,
  verifyPlaywrightInventory,
} from './playwright-evidence-policy.mjs';

function report(projects) {
  return {
    config: { forbidOnly: true },
    suites: [{
      specs: Object.entries(projects).flatMap(([projectName, tests]) => tests.map((item, index) => ({
        id: `${projectName}-${index}`,
        title: item.title ?? `test ${index}`,
        tests: [{
          projectName,
          expectedStatus: item.expectedStatus ?? 'passed',
          status: item.status,
          annotations: item.annotations ?? [],
          results: item.results ?? [],
        }],
      }))),
    }],
  };
}

const inventoryReport = report({
  // Playwright list reports unexecuted tests as status=skipped. Inventory
  // policy must distinguish that from a declared skip/fixme.
  'browser-desktop-chromium': [{ status: 'skipped' }],
  'browser-mobile-chromium': [{ status: 'skipped' }],
});
const passedReport = report({
  'browser-desktop-chromium': [{ status: 'expected', results: [{ status: 'passed' }] }],
  'browser-mobile-chromium': [{ status: 'expected', results: [{ status: 'passed' }] }],
});

test('matching desktop and mobile execution passes', () => {
  const inventory = summarizePlaywrightReport(inventoryReport, { phase: 'inventory' });
  const execution = summarizePlaywrightReport(passedReport, { phase: 'execution' });
  verifyPlaywrightInventory(inventory);
  verifyPlaywrightExecution(inventory, execution);
});

test('static skip and fixme directives fail source policy', () => {
  for (const content of ["test.skip('x', () => {});", "test.fixme('x', () => {});"]) {
    assert.equal(findForbiddenPlaywrightDirectives([{ path: 'x.spec.ts', content }]).length, 1);
  }
});

test('declared skipped status fails inventory policy', () => {
  const skipped = report({
    'browser-desktop-chromium': [{ expectedStatus: 'skipped', annotations: [{ type: 'skip' }] }],
    'browser-mobile-chromium': [{ status: 'skipped' }],
  });
  assert.throws(
    () => verifyPlaywrightInventory(summarizePlaywrightReport(skipped, { phase: 'inventory' })),
    /contains skip\/fixme/,
  );
});

test('runtime skip directive fails source policy', () => {
  const content = "test('x', async () => { test.skip(true, 'runtime'); });";
  assert.deepEqual(findForbiddenPlaywrightDirectives([{ path: 'x.spec.ts', content }]), [{ file: 'x.spec.ts', directive: 'skip' }]);
});

test('focused only directive fails source policy', () => {
  for (const content of ["test.only('x', () => {});", "test.describe.only('x', () => {});", "test . describe . only('x', () => {});"]) {
    assert.equal(findForbiddenPlaywrightDirectives([{ path: 'x.spec.ts', content }]).length, 1);
  }
});

test('forbidOnly must be enabled in inventory evidence', () => {
  const unsafe = { ...inventoryReport, config: { forbidOnly: false } };
  assert.throws(
    () => verifyPlaywrightInventory(summarizePlaywrightReport(unsafe, { phase: 'inventory' })),
    /forbidOnly is not enabled/,
  );
});

test('runner errors fail evidence even when test counts otherwise look valid', () => {
  const unsafe = { ...inventoryReport, errors: [{ message: 'synthetic failure' }] };
  assert.throws(
    () => verifyPlaywrightInventory(summarizePlaywrightReport(unsafe, { phase: 'inventory' })),
    /runner reported 1 error/,
  );
});

test('runtime skipped result fails execution policy', () => {
  const inventory = summarizePlaywrightReport(inventoryReport, { phase: 'inventory' });
  const execution = summarizePlaywrightReport(report({
    'browser-desktop-chromium': [{ status: 'skipped', results: [{ status: 'skipped' }] }],
    'browser-mobile-chromium': [{ status: 'expected', results: [{ status: 'passed' }] }],
  }), { phase: 'execution' });
  assert.throws(() => verifyPlaywrightExecution(inventory, execution), /runtime skip/);
});

test('all skipped execution fails passed and skip policy', () => {
  const inventory = summarizePlaywrightReport(inventoryReport, { phase: 'inventory' });
  const execution = summarizePlaywrightReport(report({
    'browser-desktop-chromium': [{ status: 'skipped', results: [{ status: 'skipped' }] }],
    'browser-mobile-chromium': [{ status: 'skipped', results: [{ status: 'skipped' }] }],
  }), { phase: 'execution' });
  assert.throws(() => verifyPlaywrightExecution(inventory, execution), /no passed tests/);
});

test('empty required project fails inventory and execution policy', () => {
  const emptyInventory = summarizePlaywrightReport(report({ 'browser-desktop-chromium': [{ status: 'skipped' }] }), { phase: 'inventory' });
  const emptyExecution = summarizePlaywrightReport(report({ 'browser-desktop-chromium': [{ status: 'expected', results: [{ status: 'passed' }] }] }), { phase: 'execution' });
  assert.throws(() => verifyPlaywrightInventory(emptyInventory), /mobile.*empty/);
  assert.throws(() => verifyPlaywrightExecution(summarizePlaywrightReport(inventoryReport, { phase: 'inventory' }), emptyExecution), /mobile.*empty/);
});

test('inventory and execution count or ids mismatch fails', () => {
  const inventory = summarizePlaywrightReport(inventoryReport, { phase: 'inventory' });
  const mismatch = summarizePlaywrightReport(report({
    'browser-desktop-chromium': [{ status: 'expected', results: [{ status: 'passed' }] }, { status: 'expected', results: [{ status: 'passed' }] }],
    'browser-mobile-chromium': [{ status: 'expected', results: [{ status: 'passed' }] }],
  }), { phase: 'execution' });
  assert.throws(() => verifyPlaywrightExecution(inventory, mismatch), /does not match inventory|total mismatch/);
});

test('matching counts with different test ids still fail', () => {
  const inventory = summarizePlaywrightReport(inventoryReport, { phase: 'inventory' });
  const changedIds = structuredClone(passedReport);
  changedIds.suites[0].specs[0].id = 'renamed-test-id';
  const execution = summarizePlaywrightReport(changedIds, { phase: 'execution' });
  assert.throws(() => verifyPlaywrightExecution(inventory, execution), /test ids do not match inventory/);
});
