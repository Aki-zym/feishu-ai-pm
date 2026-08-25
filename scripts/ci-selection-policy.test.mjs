import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classifyPath,
  selection,
  selectionPolicyErrors,
  selectCiPlan,
} from './ci-selection-policy.mjs';

test('documentation-only paths select only documentation gates', () => {
  const plan = selectCiPlan(['README.md', 'docs/current-state.md']);
  assert.deepEqual(plan.gates, {
    docs: true,
    check: false,
    lifecycle: false,
    e2e: false,
  });
  assert.equal(plan.minimumLevel, 'L0');
  assert.deepEqual(plan.requiredEvidence, ['docs_check']);
  assert.equal(plan.claimAuthorized, false);
});

test('policy source and control-plane validators always force full manual review', () => {
  for (const file of [
    'AGENTS.md',
    'docs/verification-matrix.json',
    'docs/docs-manifest.json',
    'docs/decision-register.json',
    'docs/decision-register.md',
    'docs/domain-contracts.json',
    'docs/domain-contracts.md',
    'docs/security_and_privacy.md',
    'docs/test-selection.md',
    'docs/product-rules/runtime.md',
    'scripts/ci-plan.mjs',
    'scripts/ci-selection-policy.mjs',
    'scripts/ci-selection-policy.test.mjs',
    'scripts/evidence-record-policy.mjs',
    'scripts/evidence-record-policy.test.mjs',
    'scripts/docs-check.mjs',
    'scripts/docs-check.test.mjs',
    'package.json',
    'package-lock.json',
    'apps/server/package.json',
    'apps/web/package.json',
    'plugins/cindy-pm-intake/ghost.json',
    '.github/workflows/ci.yml',
  ]) {
    const plan = selectCiPlan([file]);
    assert.equal(plan.mode, 'full', file);
    assert.equal(plan.manualReviewRequired, true, file);
    assert.equal(plan.gates.check, true, file);
    assert.equal(plan.gates.lifecycle, true, file);
    assert.equal(plan.gates.e2e, true, file);
  }
});

test('code-owned QA control scripts have an L4 floor and cannot become test-ci-only', () => {
  for (const file of [
    'scripts/ci-plan.mjs',
    'scripts/evidence-record-policy.mjs',
    'scripts/docs-check.mjs',
    'scripts/run-vitest-inventory.mjs',
    'scripts/run-vitest-inventory.test.mjs',
    'scripts/playwright-results-verify.mjs',
    'scripts/verify-github-provenance.mjs',
    'scripts/verify-github-provenance.test.mjs',
  ]) {
    const plan = selectCiPlan([file]);
    assert.equal(plan.categories.includes('qa-control-plane'), true, file);
    assert.equal(plan.minimumLevel, 'L4', file);
    assert.equal(plan.manualReviewRequired, true, file);
    assert.equal(plan.mode, 'full', file);
  }
  const weakened = structuredClone(selection);
  weakened.categories['qa-control-plane'].minimum_level = 'L1';
  weakened.categories['qa-control-plane'].required_evidence = ['unit_inventory'];
  assert.match(selectionPolicyErrors(weakened).join('\n'), /安全 floor/);
  assert.equal(selectCiPlan(['scripts/start-e2e-servers.mjs']).minimumLevel, 'L2');
  assert.deepEqual(selectCiPlan(['scripts/run-vitest-inventory.mjs']).categories, ['qa-control-plane']);
});

test('policy mutation cannot weaken protected-path classification', () => {
  const weakened = structuredClone(selection);
  weakened.path_rules = weakened.path_rules.map((rule) => rule.id === 'docs' ? {
    ...rule,
    exact: [...(rule.exact ?? []), 'scripts/ci-selection-policy.mjs'],
  } : rule);
  assert.match(selectionPolicyErrors(weakened).join('\n'), /path_rules/);
  assert.equal(selectCiPlan(['scripts/ci-selection-policy.mjs']).mode, 'full');
  assert.equal(selectCiPlan(['docs/verification-matrix.json']).mode, 'full');
});

test('code-owned floors survive critical rule downgrade, removal, and reorder', () => {
  const critical = [
    ['apps/server/src/runtime.ts', 'server', 'L2'],
    ['plugins/cindy-pm-intake/main.js', 'cindy-plugin', 'L3'],
    ['apps/web/src/App.tsx', 'web', 'L4'],
    ['future/runtime.bin', null, 'L6'],
  ];
  for (const [file, ruleId, minimumLevel] of critical) {
    const downgraded = structuredClone(selection);
    downgraded.path_rules = [{ id: 'docs', category: 'docs-only', regex: '.*' }];
    downgraded.categories['docs-only'] = { minimum_level: 'L0', risk: 'low', required_evidence: ['docs_check'] };
    const plan = selectCiPlan([file], downgraded);
    assert.equal(plan.mode, 'full', file);
    assert.equal(plan.minimumLevel, minimumLevel, file);
    assert.equal(plan.manualReviewRequired, true, file);
    if (ruleId) {
      const removed = structuredClone(selection);
      removed.path_rules = removed.path_rules.filter((rule) => rule.id !== ruleId);
      assert.match(selectionPolicyErrors(removed).join('\n'), /path_rules/);
      const reordered = structuredClone(selection);
      reordered.path_rules = [...reordered.path_rules].reverse();
      assert.match(selectionPolicyErrors(reordered).join('\n'), /path_rules/);
    }
  }
});

test('category minimum floors cannot be weakened or removed', () => {
  for (const category of ['cindy-plugin', 'server-data-runtime', 'web', 'unknown']) {
    const weakened = structuredClone(selection);
    weakened.categories[category].minimum_level = 'L0';
    assert.match(selectionPolicyErrors(weakened).join('\n'), /安全 floor/);
    if (category !== 'docs-only' && category !== 'test-ci-only') {
      const noManual = structuredClone(selection);
      noManual.categories[category].manual_review_required = false;
      assert.match(selectionPolicyErrors(noManual).join('\n'), /安全 floor/);
    }
    const removed = structuredClone(selection);
    delete removed.categories[category].required_evidence;
    assert.match(selectionPolicyErrors(removed).join('\n'), /required_evidence|安全 floor/);
  }
});

test('weak policy schema fails closed', () => {
  const missingCategory = structuredClone(selection);
  delete missingCategory.categories['cindy-plugin'];
  assert.match(selectionPolicyErrors(missingCategory).join('\n'), /categories/);
  const badEvidence = structuredClone(selection);
  badEvidence.categories['cindy-plugin'].required_evidence = [''];
  assert.match(selectionPolicyErrors(badEvidence).join('\n'), /evidence/);
  const duplicateRule = structuredClone(selection);
  duplicateRule.path_rules.push({ ...duplicateRule.path_rules[0] });
  assert.match(selectionPolicyErrors(duplicateRule).join('\n'), /不可重复/);
});

test('policy source deletion or rename stays full through protected-path behavior', () => {
  for (const file of ['docs/verification-matrix.json', 'scripts/ci-selection-policy.mjs', 'scripts/docs-check.mjs']) {
    const plan = selectCiPlan([file]);
    assert.equal(plan.mode, 'full');
    assert.equal(plan.manualReviewRequired, true);
    assert.equal(plan.highRisk, true);
  }
  for (const paths of [
    ['docs/verification-matrix.json'],
    ['docs/verification-matrix.json', 'docs/verification-matrix.legacy.json'],
    ['scripts/ci-selection-policy.mjs', 'scripts/ci-selection-policy.legacy.mjs'],
    ['scripts/docs-check.mjs', 'scripts/docs-check.legacy.mjs'],
  ]) {
    const plan = selectCiPlan(paths);
    assert.equal(plan.mode, 'full', paths.join(', '));
    assert.equal(plan.manualReviewRequired, true, paths.join(', '));
    assert.equal(plan.gates.e2e, true, paths.join(', '));
  }
});

test('runtime source changes select the full gate', () => {
  const plan = selectCiPlan(['apps/server/src/app.ts']);
  assert.equal(plan.mode, 'full');
  assert.equal(plan.categories.includes('server-data-runtime'), true);
  assert.equal(plan.minimumLevel, 'L2');
  assert.equal(plan.manualReviewRequired, true);
  assert.deepEqual(plan.gates, {
    docs: true,
    check: true,
    lifecycle: true,
    e2e: true,
  });
});

test('unknown paths fail closed to the full gate', () => {
  const plan = selectCiPlan(['new-toolchain/runtime.xyz']);
  assert.equal(plan.mode, 'full');
  assert.equal(plan.categories.includes('unknown'), true);
  assert.equal(plan.gates.e2e, true);
});

test('mixed documentation and test paths fail closed to the full gate', () => {
  const plan = selectCiPlan(['docs/current-state.md', 'tests/e2e/app.spec.ts']);
  assert.equal(plan.mode, 'full');
  assert.equal(plan.gates.check, true);
  assert.equal(plan.gates.lifecycle, true);
  assert.equal(plan.gates.e2e, true);
});

test('workspace tests remain test/CI-only rather than being mistaken for product source', () => {
  for (const file of ['apps/server/tests/app.test.ts', 'apps/web/src/App.spec.tsx', 'plugins/cindy-pm-intake/main.test.mjs']) {
    const plan = selectCiPlan([file]);
    assert.deepEqual(plan.categories, ['test-ci-only']);
    assert.equal(plan.mode, 'full');
  }
});

test('empty, absolute, and parent-escaping paths never qualify as docs-only', () => {
  for (const paths of [undefined, [], [null], ['/docs/current-state.md'], ['../docs/current-state.md'], ['C:/docs/current-state.md']]) {
    const plan = selectCiPlan(paths);
    assert.equal(plan.mode, 'full');
    assert.equal(plan.categories.includes('unknown'), true);
  }
});

test('current plugin paths select the plugin contract gate', () => {
  for (const file of ['plugins/cindy-pm-intake/main.js', 'plugins/cindy-pm-intake/node/worker.cjs']) {
    const plan = selectCiPlan([file]);
    assert.equal(plan.mode, 'full');
    assert.equal(plan.categories.includes('cindy-plugin'), true);
    assert.equal(plan.minimumLevel, 'L3');
    assert.equal(plan.gates.e2e, true);
  }
});

test('unrecognized scripts fail closed instead of inheriting test-ci-only L1', () => {
  const unknownScripts = [
    'scripts/start-local.ps1',
    'scripts/browser-bootstrap.mjs',
    'scripts/migrate-production.mjs',
    'scripts/security-policy.mjs',
    'scripts/governance-check.mjs',
  ];
  for (const file of unknownScripts) {
    const plan = selectCiPlan([file]);
    assert.equal(plan.mode, 'full', file);
    assert.deepEqual(plan.categories, ['unknown'], file);
    assert.equal(plan.minimumLevel, 'L6', file);
    assert.equal(plan.highRisk, true, file);
    assert.equal(plan.manualReviewRequired, true, file);
  }
});

test('Cindy plugin paths require contract replay at L3', () => {
  assert.equal(selectCiPlan(['plugins/cindy-pm-intake/main.js']).minimumLevel, 'L3');
  assert.equal(selectCiPlan(['plugins/cindy-pm-intake/node/worker.cjs']).minimumLevel, 'L3');
});

test('Cindy plugin paths select contract and scope evidence', () => {
  const plan = selectCiPlan(['plugins/cindy-pm-intake/main.js']);
  assert.equal(plan.minimumLevel, 'L3');
  assert.equal(plan.requiredEvidence.includes('contract_replay'), true);
  assert.equal(plan.requiredEvidence.includes('scope_guard'), true);
});

test('unknown and mixed paths are high risk and never authorize a broad claim', () => {
  for (const plan of [
    selectCiPlan(['new-toolchain/runtime.xyz']),
    selectCiPlan(['docs/current-state.md', 'apps/server/src/app.ts']),
  ]) {
    assert.equal(plan.highRisk, true);
    assert.equal(plan.manualReviewRequired, true);
    assert.equal(plan.claimAuthorized, false);
    assert.equal(plan.gates.e2e, true);
  }
});

test('the small path matrix reports every requested category', () => {
  assert.equal(classifyPath('AGENTS.md'), 'docs-only');
  assert.equal(classifyPath('.github/workflows/ci.yml'), 'qa-control-plane');
  assert.equal(classifyPath('apps/server/src/index.ts'), 'server-data-runtime');
  assert.equal(classifyPath('apps/web/src/App.tsx'), 'web');
  assert.equal(classifyPath('plugins/cindy-pm-intake/main.js'), 'cindy-plugin');
});

test('workflow runs the current plugin, server and web gates', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm run test:plugin/);
  assert.match(workflow, /npm run test:web:current/);
  assert.match(workflow, /npm run test:server:current/);
  assert.doesNotMatch(workflow, /apps\/desktop|electron|desktop:/i);
});

test('runtime renamed into docs remains a full change when rename detection is disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-policy-rename-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'ci@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: root });
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
    await mkdir(join(root, 'apps/server/src'), { recursive: true });
    await writeFile(join(root, 'apps/server/src/runtime.ts'), 'export const runtime = true;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    await mkdir(join(root, 'docs'), { recursive: true });
    await rename(join(root, 'apps/server/src/runtime.ts'), join(root, 'docs/runtime.md'));
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'rename'], { cwd: root });
    const paths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).split('\0').filter(Boolean);
    assert.deepEqual(paths.sort(), ['apps/server/src/runtime.ts', 'docs/runtime.md']);
    assert.equal(selectCiPlan(paths).mode, 'full');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
