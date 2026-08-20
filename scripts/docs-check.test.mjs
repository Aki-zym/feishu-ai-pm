import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import {
  computeProductFingerprint,
  decodeMarkdownTarget,
  evidenceRecordErrors,
  integrationTipDeclarationErrors,
  isProductSourcePath,
  parseDeclaredIntegrationTip,
  resolveRepoPath,
  resolveLiveIntegrationTip,
  snapshotDeclarationErrors,
} from './docs-check-policy.mjs';
import { selectMergedPullRequest } from './integration-push-provenance.mjs';

const levels = new Set(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);

test('integration push API provenance requires one merged PR on the fixed integration branch', () => {
  const mergeSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const pull = {
    number: 123,
    state: 'closed',
    merged_at: '2026-08-17T00:00:00Z',
    merge_commit_sha: mergeSha,
    head: { sha: headSha },
    base: { ref: 'integration/m1-test-20260815', repo: { full_name: 'guanchen-dotcom/feishu-ai-pm' } },
  };
  assert.deepEqual(selectMergedPullRequest([pull], {
    repository: 'guanchen-dotcom/feishu-ai-pm',
    branch: 'integration/m1-test-20260815',
    mergeSha,
  }), {
    number: 123,
    headSha,
    mergeSha,
    baseBranch: 'integration/m1-test-20260815',
  });
  assert.throws(() => selectMergedPullRequest([], {
    repository: 'guanchen-dotcom/feishu-ai-pm',
    branch: 'integration/m1-test-20260815',
    mergeSha,
  }), /exactly one merged PR/);
  assert.throws(() => selectMergedPullRequest([{ ...pull, base: { ...pull.base, ref: 'main' } }], {
    repository: 'guanchen-dotcom/feishu-ai-pm',
    branch: 'integration/m1-test-20260815',
    mergeSha,
  }), /exactly one merged PR/);
});

function record(overrides = {}) {
  return {
    target_level: 'L4',
    attained_level: 'L4',
    evidence_status: 'attained',
    evidence_type: 'browser_e2e_run',
    scope: 'synthetic_browser_e2e',
    source_commit: 'a'.repeat(40),
    run_id: 'ci-123',
    run_at: '2026-08-14T10:00:00Z',
    environment: 'isolated browser fixture',
    result: 'passed',
    target_real_scope: false,
    real_environment_attained: false,
    artifact: null,
    ...overrides,
  };
}

test('实际的本地浏览器证据可取得 L4，但不冒充真实环境', () => {
  assert.deepEqual(evidenceRecordErrors(record(), levels), []);
});

test('产物 hash 只能取得 L0 完整性证据，不能冒充 L5 Smoke', () => {
  const valid = record({
    target_level: 'L5',
    attained_level: 'L0',
    evidence_status: 'artifact_integrity_only',
    evidence_type: 'artifact_hash_and_committed_qa_record',
    scope: 'artifact_only',
    run_id: 'unrecorded',
    run_at: 'unrecorded',
    environment: 'artifact metadata',
    result: 'artifact_present_smoke_not_run',
    artifact: { sha256: 'b'.repeat(64) },
  });
  assert.deepEqual(evidenceRecordErrors(valid, levels), []);
  assert.match(evidenceRecordErrors({ ...valid, attained_level: 'L5' }, levels).join('\n'), /不能伪装成 L5 Smoke/);
});

test('not_run 不得声明已取得层级或真实环境证据', () => {
  const valid = record({
    target_level: 'L6',
    attained_level: null,
    evidence_status: 'not_run',
    evidence_type: 'open_validation_item',
    scope: 'real_external_not_run',
    run_id: 'not_run',
    run_at: 'not_run',
    environment: 'target tenant not connected',
    result: 'not_run',
    target_real_scope: true,
  });
  assert.deepEqual(evidenceRecordErrors(valid, levels), []);
  const errors = evidenceRecordErrors({ ...valid, attained_level: 'L6', real_environment_attained: true }, levels).join('\n');
  assert.match(errors, /not_run 不能声明已取得层级/);
  assert.match(errors, /not_run 不能声明已取得真实环境证据/);
});

test('历史人读声明始终保持未独立复验', () => {
  const valid = record({
    target_level: 'L6',
    attained_level: null,
    evidence_status: 'historical_claim_not_reverified',
    evidence_type: 'historical_documented_claim',
    scope: 'real_external_limited_step',
    run_id: 'unrecorded',
    run_at: '2026-08-11 (documented claim)',
    result: 'historical_claim_not_reverified',
    target_real_scope: true,
  });
  assert.deepEqual(evidenceRecordErrors(valid, levels), []);
  const errors = evidenceRecordErrors({ ...valid, attained_level: 'L6', result: 'passed', real_environment_attained: true }, levels).join('\n');
  assert.match(errors, /历史声明不能声明已取得层级/);
  assert.match(errors, /历史声明不能声明真实环境证据/);
  assert.match(errors, /passed 只能与 attained/);
  const disguised = record({
    target_level: 'L6',
    attained_level: 'L6',
    evidence_type: 'historical_documented_claim',
    scope: 'real_external_limited_step',
    target_real_scope: true,
    real_environment_attained: true,
  });
  assert.match(evidenceRecordErrors(disguised, levels).join('\n'), /必须使用 historical_claim_not_reverified/);
});

test('只有实际 L6 运行可声明真实环境证据', () => {
  const valid = record({
    target_level: 'L6',
    attained_level: 'L6',
    evidence_type: 'actual_real_environment_run',
    scope: 'real_external_limited_step',
    target_real_scope: true,
    real_environment_attained: true,
  });
  assert.deepEqual(evidenceRecordErrors(valid, levels), []);
  assert.match(evidenceRecordErrors({ ...valid, evidence_type: 'contract_replay' }, levels).join('\n'), /actual_real_environment_run/);
});

test('attained 与 passed 都必须绑定实际 run', () => {
  const errors = evidenceRecordErrors(record({ run_id: 'unrecorded' }), levels).join('\n');
  assert.match(errors, /实际 run_id/);
  assert.match(evidenceRecordErrors(record({ evidence_status: 'not_run' }), levels).join('\n'), /passed 只能与 attained/);
});

test('历史 QA 与开放验证类型不能伪装 attained', () => {
  assert.match(evidenceRecordErrors(record({ evidence_type: 'committed_qa_record' }), levels).join('\n'), /必须使用 reported_not_reverified/);
  assert.match(evidenceRecordErrors(record({ evidence_type: 'open_validation_item' }), levels).join('\n'), /必须使用 not_run/);
});

test('产品 fingerprint 忽略 docs 脚本但捕获运行配置和源码漂移', () => {
  const paths = ['package.json', 'apps/server/src/app.ts', 'apps/server/src/app.test.ts'];
  const contents = new Map([
    ['package.json', Buffer.from(JSON.stringify({ version: '1.0.0', scripts: { build: 'build-a', 'docs:check': 'docs-a' } }))],
    ['apps/server/src/app.ts', Buffer.from('export const value = 1;\r\n')],
    ['apps/server/src/app.test.ts', Buffer.from('ignored test')],
  ]);
  const first = computeProductFingerprint(paths, (file) => contents.get(file));
  assert.equal(first.file_count, 2);
  contents.set('apps/server/lib/index.ts', Buffer.from('export const added = true;\n'));
  const withNewProductionFile = computeProductFingerprint([...paths, 'apps/server/lib/index.ts'], (file) => contents.get(file));
  assert.equal(withNewProductionFile.file_count, 3);
  assert.notEqual(withNewProductionFile.fingerprint, first.fingerprint);
  contents.set('package.json', Buffer.from(JSON.stringify({ version: '1.0.0', scripts: { build: 'build-a', 'docs:check': 'docs-b' } })));
  assert.equal(computeProductFingerprint(paths, (file) => contents.get(file)).fingerprint, first.fingerprint);
  contents.set('package.json', Buffer.from(JSON.stringify({ version: '1.0.0', scripts: { build: 'build-b', 'docs:check': 'docs-b' } })));
  assert.notEqual(computeProductFingerprint(paths, (file) => contents.get(file)).fingerprint, first.fingerprint);
  contents.set('package.json', Buffer.from(JSON.stringify({ version: '1.0.0', scripts: { build: 'build-a' } })));
  contents.set('apps/server/src/app.ts', Buffer.from('export const value = 2;\n'));
  assert.notEqual(computeProductFingerprint(paths, (file) => contents.get(file)).fingerprint, first.fingerprint);
});

test('产品 selector 默认纳入 workspace 生产路径', () => {
  for (const file of [
    'apps/server/lib/index.ts',
    'apps/server/config/runtime.json',
    'apps/desktop/resources/preload.js',
    'apps/web/assets/logo.png',
    'apps/web/app/routes.tsx',
    'apps/worker/src/index.ts',
    'apps/worker/public/logo.png',
    'apps/worker/package.json',
  ]) {
    assert.equal(isProductSourcePath(file), true, file);
  }
});

test('产品 selector 集中排除测试、纯文档和确定生成目录', () => {
  for (const file of [
    'apps/server/src/index.test.ts',
    'apps/server/tests/index.ts',
    'apps/server/fixtures/runtime.json',
    'apps/server/README.md',
    'apps/server/docs/architecture.json',
    'apps/server/dist/index.js',
    'apps/server/build/index.js',
    'apps/server/coverage/lcov.info',
    'apps/server/node_modules/pkg/index.js',
    'apps/web/.vite/manifest.json',
    'apps/web/src/App.stories.tsx',
    'apps/web/e2e/main.ts',
    'apps/web/cypress/main.cy.ts',
    'apps/web/__snapshots__/App.snap',
    'apps/desktop/tsconfig.test.json',
  ]) {
    assert.equal(isProductSourcePath(file), false, file);
  }
});

test('snapshot 交叉校验拒绝 baseline 漂移', () => {
  const actual = { selector: 'apps-workspace-default-include-v1', fingerprint: 'a'.repeat(64), file_count: 2 };
  const declared = {
    algorithm: 'product-source-sha256-v1',
    selector: 'apps-workspace-default-include-v1',
    fingerprint: actual.fingerprint,
    file_count: 2,
    snapshot_as_of: '2026-08-15',
    equivalent_commit: 'd'.repeat(40),
  };
  const verification = { ...declared };
  assert.deepEqual(snapshotDeclarationErrors(declared, actual, verification), []);
  assert.match(snapshotDeclarationErrors({ ...declared, fingerprint: 'b'.repeat(64) }, actual, verification).join('\n'), /被审产品源码不一致/);
  assert.match(snapshotDeclarationErrors(declared, actual, { ...verification, fingerprint: 'c'.repeat(64) }).join('\n'), /verification source/);
  assert.match(snapshotDeclarationErrors(declared, actual, { ...verification, snapshot_as_of: '2026-08-14' }).join('\n'), /verification source/);
  assert.match(snapshotDeclarationErrors(declared, actual, { ...verification, equivalent_commit: 'e'.repeat(40) }).join('\n'), /verification source/);
});

test('生成视图写入拒绝符号链接目标', (context) => {
  const temp = mkdtempSync(join(tmpdir(), 'docs-check-symlink-'));
  const repo = join(temp, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'target.md'), 'do not overwrite');
  try {
    try {
      symlinkSync('target.md', join(repo, 'view.md'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        context.skip('当前平台不允许创建文件符号链接');
        return;
      }
      throw error;
    }
    assert.equal(resolveRepoPath(repo, 'view.md'), join(repo, 'view.md'));
    assert.throws(() => resolveRepoPath(repo, 'view.md', { forWrite: true }), /写入目标不能是符号链接/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('仓库路径拒绝绝对路径和父目录逃逸', () => {
  const temp = mkdtempSync(join(tmpdir(), 'docs-check-policy-'));
  const repo = join(temp, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'inside.md'), 'ok');
  try {
    assert.equal(resolveRepoPath(repo, 'inside.md'), join(repo, 'inside.md'));
    assert.throws(() => resolveRepoPath(repo, '../outside.md'), /仓库外/);
    assert.throws(() => resolveRepoPath(repo, '../outside.md', { mustExist: false, forWrite: true }), /仓库外/);
    const absolute = join(temp, 'outside.md');
    assert.equal(isAbsolute(absolute), true);
    assert.throws(() => resolveRepoPath(repo, absolute), /仓库内相对路径/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('畸形 percent Markdown 链接返回受控错误', () => {
  assert.deepEqual(decodeMarkdownTarget('docs/current-state.md'), { value: 'docs/current-state.md' });
  assert.deepEqual(decodeMarkdownTarget('docs%2Fcurrent-state.md'), { value: 'docs/current-state.md' });
  assert.deepEqual(decodeMarkdownTarget('bad%ZZ.md'), { error: '本地链接含非法百分号编码' });
});

test('integration declaration requires complete matching manifest and current-state values', () => {
  const branch = 'integration/m1-test-20260815';
  const tip = 'a'.repeat(40);
  const state = `提交的 integration 基线快照（PR/push pending，不等同于实时 integration tip）为 \`${branch}\` @ \`${tip}\``;
  assert.deepEqual(integrationTipDeclarationErrors({ manifestTip: tip, currentStateText: state, branch, declarationKind: 'committed_base_snapshot' }), {
    errors: [],
    parsedCurrentStateTip: tip,
    parsedDeclarationKind: 'committed_base_snapshot',
  });
  assert.match(integrationTipDeclarationErrors({ manifestTip: undefined, currentStateText: state, branch, declarationKind: 'committed_base_snapshot' }).errors.join('\\n'), /manifest.*完整 40 位/);
  assert.match(integrationTipDeclarationErrors({ manifestTip: tip, currentStateText: 'no integration declaration', branch, declarationKind: 'committed_base_snapshot' }).errors.join('\\n'), /current-state.*完整 40 位/);
  assert.match(integrationTipDeclarationErrors({ manifestTip: tip, currentStateText: `当前 integration tip 为 \`${branch}\` @ \`${'b'.repeat(40)}\``, branch, declarationKind: 'committed_base_snapshot' }).errors.join('\\n'), /必须是 committed_base_snapshot/);
  assert.match(integrationTipDeclarationErrors({ manifestTip: 'not-a-sha', currentStateText: state, branch, declarationKind: 'committed_base_snapshot' }).errors.join('\\n'), /manifest.*完整 40 位/);
  assert.match(integrationTipDeclarationErrors({ manifestTip: tip, currentStateText: `${state}\n当前 integration tip 为 \`${branch}\` @ \`${tip}\``, branch, declarationKind: 'committed_base_snapshot' }).errors.join('\\n'), /只能包含一个/);
});

test('integration tip 严格匹配真实 Git ref，仅允许 exact integration push merge 的第一父提交', () => {
  const temp = mkdtempSync(join(tmpdir(), 'docs-integration-tip-'));
  const git = (args) => execFileSync('git', args, { cwd: temp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (message, file = null) => {
    execFileSync('git', ['add', ...(file ? [file] : ['state.md'])], { cwd: temp });
    execFileSync('git', ['commit', '-qm', message], { cwd: temp });
    return git(['rev-parse', 'HEAD']);
  };
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: temp });
    execFileSync('git', ['config', 'user.email', 'qa@example.invalid'], { cwd: temp });
    execFileSync('git', ['config', 'user.name', 'QA'], { cwd: temp });
    writeFileSync(join(temp, 'state.md'), 'integration/m1-test-20260815');
    const base = commit('base');
    git(['checkout', '-qb', 'integration/m1-test-20260815']);
    writeFileSync(join(temp, 'payload.txt'), 'first');
    const first = commit('integration commit', 'payload.txt');
    writeFileSync(join(temp, 'state.md'), `current integration tip 为 \`integration/m1-test-20260815\` @ \`${first}\``);
    assert.equal(parseDeclaredIntegrationTip(readFileSync(join(temp, 'state.md'), 'utf8'), 'integration/m1-test-20260815'), first);
    assert.equal(resolveLiveIntegrationTip({ branch: 'integration/m1-test-20260815', declaredTip: first, git }).tip, first);
    const committedSnapshot = `提交的 integration 基线快照（PR/push pending，不等同于实时 integration tip）为 \`integration/m1-test-20260815\` @ \`${first}\``;
    assert.deepEqual(integrationTipDeclarationErrors({
      manifestTip: first,
      currentStateText: committedSnapshot,
      branch: 'integration/m1-test-20260815',
      declarationKind: 'committed_base_snapshot',
    }).errors, []);
    writeFileSync(join(temp, 'payload.txt'), 'second');
    const second = commit('integration merge candidate', 'payload.txt');
    const resolved = resolveLiveIntegrationTip({ branch: 'integration/m1-test-20260815', declaredTip: first, git });
    assert.equal(resolved.tip, second);
    const staleManifest = { current_state: { current_integration_tip: first } };
    const staleCurrentState = `current integration tip 为 \`integration/m1-test-20260815\` @ \`${first}\``;
    assert.equal(parseDeclaredIntegrationTip(staleCurrentState, 'integration/m1-test-20260815'), staleManifest.current_state.current_integration_tip);
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: staleManifest.current_state.current_integration_tip,
      git,
      requireDeclaredMatch: true,
    }), /does not match/);
    git(['checkout', '-qb', 'topic']);
    writeFileSync(join(temp, 'payload.txt'), 'topic');
    commit('topic commit', 'payload.txt');
    git(['checkout', 'integration/m1-test-20260815']);
    execFileSync('git', ['merge', '--no-ff', '-qm', 'merge topic', 'topic'], { cwd: temp });
    const mergeTip = git(['rev-parse', 'HEAD']);
    const topicTip = git(['rev-parse', 'topic']);
    const pushEnv = {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_NAME: 'integration/m1-test-20260815',
      GITHUB_SHA: mergeTip,
      CI_APPROVED_PR_HEAD_SHA: topicTip,
    };
    assert.equal(resolveLiveIntegrationTip({ branch: 'integration/m1-test-20260815', declaredTip: first, git }).tip, mergeTip);
    assert.throws(() => resolveLiveIntegrationTip({ branch: 'missing', git }), /cannot resolve/);
    assert.throws(() => resolveLiveIntegrationTip({ branch: 'integration/m1-test-20260815', baseArg: base, git }), /does not match live/);
    const stackedBase = 'c'.repeat(40);
    const stackedParentRef = 'agent/issue-43-runtime-retry-degradation';
    const stackedHeadRef = 'agent/issue-44-api-partial-projection';
    const stackedGit = (args) => {
      if (args[0] === 'rev-parse' && args[1] === `${stackedBase}^{commit}`) return stackedBase;
      if (args[0] === 'rev-parse' && args[1] === `origin/${stackedParentRef}^{commit}`) return stackedBase;
      if (args[0] === 'rev-parse' && args[1] === 'origin/integration/m1-test-20260815^{commit}') return second;
      if (args[0] === 'rev-parse' && args[1] === 'integration/m1-test-20260815^{commit}') return second;
      return git(args);
    };
    const stacked = resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: second,
      baseArg: stackedBase,
      baseRef: stackedParentRef,
      headRef: stackedHeadRef,
      git: stackedGit,
      requireDeclaredMatch: true,
    });
    assert.equal(stacked.tip, second);
    assert.deepEqual(stacked.stackedBase, { ref: stackedParentRef, commit: stackedBase });
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: second,
      baseArg: stackedBase,
      baseRef: 'main',
      headRef: stackedHeadRef,
      git: stackedGit,
      requireDeclaredMatch: true,
    }), /does not match live/);
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: second,
      baseArg: stackedBase,
      baseRef: stackedParentRef,
      headRef: stackedParentRef,
      git: stackedGit,
      requireDeclaredMatch: true,
    }), /does not match live/);
    assert.throws(() => resolveLiveIntegrationTip({ branch: 'integration/m1-test-20260815', declaredTip: first, git, requireDeclaredMatch: true }), /does not match/);
    assert.throws(() => resolveLiveIntegrationTip({ branch: 'integration/m1-test-20260815', git, requireDeclaredMatch: true }), /declared integration tip is required/);
    assert.throws(() => resolveLiveIntegrationTip({ branch: 'integration/m1-test-20260815', declaredTip: 'not-a-sha', git, requireDeclaredMatch: true }), /full 40-hex/);
    assert.equal(resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: second,
      declarationKind: 'committed_base_snapshot',
      env: pushEnv,
      git,
      requireDeclaredMatch: true,
    }).declaredMatch, 'integration_push_merge_first_parent');
    const validMerge = resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: second,
      declarationKind: 'committed_base_snapshot',
      env: pushEnv,
      git,
      requireDeclaredMatch: true,
    });
    assert.equal(validMerge.secondParent, topicTip);
    assert.equal(validMerge.approvedPrHead, topicTip);
    assert.equal(validMerge.tree, validMerge.mergeTree);
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: second,
      declarationKind: 'committed_base_snapshot',
      env: { ...pushEnv, CI_APPROVED_PR_HEAD_SHA: first },
      git,
      requireDeclaredMatch: true,
    }), /does not match/);
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: second,
      declarationKind: 'committed_base_snapshot',
      env: { ...pushEnv, CI_APPROVED_PR_HEAD_SHA: undefined },
      git,
      requireDeclaredMatch: true,
    }), /does not match/);
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: first,
      declarationKind: 'live_tip',
      env: pushEnv,
      git,
      requireDeclaredMatch: true,
    }), /does not match/);
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: first,
      declarationKind: 'live_tip',
      env: pushEnv,
      git,
      requireDeclaredMatch: true,
    }), /does not match/);
    const wrongTreeGit = (args) => args[0] === 'merge-tree'
      ? first
      : git(args);
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: second,
      declarationKind: 'committed_base_snapshot',
      env: pushEnv,
      git: wrongTreeGit,
      requireDeclaredMatch: true,
    }), /does not match/);
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'other-integration',
      declaredTip: second,
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF_NAME: 'other-integration',
        GITHUB_SHA: mergeTip,
      },
      git: (args) => args[0] === 'rev-parse' && args[1] === 'origin/other-integration^{commit}' ? mergeTip : git(args),
      requireDeclaredMatch: true,
    }), /does not match/);
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: second,
      env: pushEnv,
      git: (args) => args[0] === 'rev-parse' && args[1] === 'HEAD^{commit}' ? topicTip : git(args),
      requireDeclaredMatch: true,
    }), /does not match/);
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: topicTip,
      env: pushEnv,
      git,
      requireDeclaredMatch: true,
    }), /does not match/);
    for (const env of [
      { ...pushEnv, GITHUB_EVENT_NAME: 'pull_request' },
      { ...pushEnv, GITHUB_REF_NAME: 'main' },
      { ...pushEnv, GITHUB_SHA: second },
    ]) {
      assert.throws(() => resolveLiveIntegrationTip({
        branch: 'integration/m1-test-20260815',
        declaredTip: second,
        env,
        git,
        requireDeclaredMatch: true,
      }), /does not match/);
    }
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: first,
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF_NAME: 'integration/m1-test-20260815',
        GITHUB_SHA: second,
      },
      git,
      requireDeclaredMatch: true,
    }), /does not match/);
    assert.throws(() => resolveLiveIntegrationTip({ branch: 'integration/m1-test-20260815', baseArg: 'not-a-sha', git }), /cannot resolve|full 40/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('committed base snapshot accepts an ordinary integration push merge and rejects provenance drift', () => {
  const temp = mkdtempSync(join(tmpdir(), 'docs-integration-push-ordinary-'));
  const git = (args) => execFileSync('git', args, { cwd: temp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (message, file, content) => {
    writeFileSync(join(temp, file), content);
    execFileSync('git', ['add', file], { cwd: temp });
    execFileSync('git', ['commit', '-qm', message], { cwd: temp });
    return git(['rev-parse', 'HEAD']);
  };
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: temp });
    execFileSync('git', ['config', 'user.email', 'qa@example.invalid'], { cwd: temp });
    execFileSync('git', ['config', 'user.name', 'QA'], { cwd: temp });
    commit('base', 'state.md', 'base');
    git(['checkout', '-qb', 'integration/m1-test-20260815']);
    const committedSnapshot = commit('integration snapshot', 'state.md', 'snapshot');
    git(['checkout', '-qb', 'agent/issue-38-postmerge-docs']);
    const approvedPrHead = commit('follow-up candidate', 'candidate.txt', 'candidate');
    git(['checkout', 'integration/m1-test-20260815']);
    execFileSync('git', ['merge', '--no-ff', '-qm', 'ordinary integration merge', 'agent/issue-38-postmerge-docs'], { cwd: temp });
    const mergeSha = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/remotes/origin/integration/m1-test-20260815', mergeSha]);
    const env = {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_NAME: 'integration/m1-test-20260815',
      GITHUB_SHA: mergeSha,
      CI_APPROVED_PR_HEAD_SHA: approvedPrHead,
    };
    const accepted = resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: committedSnapshot,
      declarationKind: 'committed_base_snapshot',
      env,
      git,
      requireDeclaredMatch: true,
    });
    assert.equal(accepted.declaredMatch, 'integration_push_merge_first_parent');
    assert.equal(accepted.secondParent, approvedPrHead);
    assert.equal(accepted.tree, accepted.mergeTree);
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: committedSnapshot,
      declarationKind: 'committed_base_snapshot',
      env: { ...env, CI_APPROVED_PR_HEAD_SHA: committedSnapshot },
      git,
      requireDeclaredMatch: true,
    }), /does not match/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('integration push merge 例外拒绝 malformed 与 octopus ancestry', () => {
  const live = 'a'.repeat(40);
  const declared = 'b'.repeat(40);
  const env = {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF_NAME: 'integration/m1-test-20260815',
    GITHUB_SHA: live,
    CI_APPROVED_PR_HEAD_SHA: 'c'.repeat(40),
  };
  const resolver = (ancestry) => (args) => {
    if (args[0] === 'rev-parse') return live;
    if (args[0] === 'rev-list') return ancestry;
    throw new Error('unexpected git command');
  };
  for (const ancestry of [
    'malformed',
    `${live} ${declared}`,
    `${live} ${declared} malformed-second-parent`,
    `${live} ${declared} ${'c'.repeat(40)} ${'d'.repeat(40)}`,
    `${'e'.repeat(40)} ${declared} ${'c'.repeat(40)}`,
  ]) {
    assert.throws(() => resolveLiveIntegrationTip({
      branch: 'integration/m1-test-20260815',
      declaredTip: declared,
      declarationKind: 'committed_base_snapshot',
      env,
      git: resolver(ancestry),
      requireDeclaredMatch: true,
    }), /does not match/);
  }
});
