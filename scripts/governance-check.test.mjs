import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { governanceErrors } from './governance-check.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFiles = [
  'docs/handoff-template.md',
  'CONTRIBUTING.md',
  'docs/stacked-pr.md',
  '.github/CODEOWNERS',
  '.github/pull_request_template.md',
  '.gitignore',
  'docs/github_collaboration.md',
  'docs/docs-manifest.json',
];

function normalizeLf(text) {
  return text.replaceAll('\r\n', '\n');
}

function withLineEnding(text, lineEnding) {
  const normalized = normalizeLf(text);
  return lineEnding === 'crlf' ? normalized.replaceAll('\n', '\r\n') : normalized;
}

function copyFixture(lineEnding = 'lf') {
  const root = mkdtempSync(join(tmpdir(), 'governance-check-'));
  for (const file of fixtureFiles) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    if (lineEnding === 'lf') cpSync(join(repoRoot, file), target);
    else writeFileSync(target, withLineEnding(readFileSync(join(repoRoot, file), 'utf8'), lineEnding), 'utf8');
  }
  return root;
}

function mutate(file, change, lineEnding = 'lf') {
  const root = copyFixture(lineEnding);
  const path = join(root, file);
  assert.ok(existsSync(path), 'fixture missing ' + file);
  const originalRaw = readFileSync(path, 'utf8');
  const original = normalizeLf(originalRaw);
  try {
    const mutated = change(original);
    assert.equal(typeof mutated, 'string', `${file} mutation must return text`);
    assert.notEqual(mutated, original, `${file} mutation was a no-op`);
    writeFileSync(path, withLineEnding(mutated, lineEnding), 'utf8');
    return governanceErrors(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('governance contract has recoverable handoff, RACI, ownership and stacked metadata', () => {
  assert.deepEqual(governanceErrors(), []);
});

test('governance checker fails closed for structural mutations', () => {
  const tick = String.fromCharCode(96);
  const mutations = [
    ['handoff missing numbered section', 'docs/handoff-template.md', (text) => text.replace(/^## 8\. 下一步\n[\s\S]*$/m, '')],
    ['handoff field in wrong section', 'docs/handoff-template.md', (text) => text
      .replace('- 当前阻塞：', '- 已知风险 / 冲突：')
      .replace('- 已知风险 / 冲突：', '- 已知风险 / 冲突：\n- 当前阻塞：')],
    ['handoff missing executed table', 'docs/handoff-template.md', (text) => text.replace(/^### 已运行\n[\s\S]*?(?=^### 未运行\n)/m, '')],
    ['handoff executed table row deleted', 'docs/handoff-template.md', (text) => text.replace('|  |  |  |  |\n', '')],
    ['handoff not-executed table row deleted', 'docs/handoff-template.md', (text) => text.replace('|  |  |  |\n', '')],
    ['handoff missing not-executed reason column', 'docs/handoff-template.md', (text) => text.replace(tick + 'not_executed' + tick + ' 原因', '原因')],
    ['handoff keyword soup', 'docs/handoff-template.md', () => '# 目标 Issue Branch clean passed L0-L6 .handoff/current.md'],
    ['RACI header missing role column', 'CONTRIBUTING.md', (text) => text.replace('| QA/证据负责人 |', '| QA |')],
    ['RACI key responsibility missing', 'CONTRIBUTING.md', (text) => text.replace(/^\| 标记 Ready .*\n/m, '')],
    ['RACI duplicate responsibility row', 'CONTRIBUTING.md', (text) => text.replace('| 构建、签名、发布 Release | A（确认可见结果） | I | I | C | A/R | C |\n', '| 构建、签名、发布 Release | A（确认可见结果） | I | I | C | A/R | C |\n| 构建、签名、发布 Release | A（确认可见结果） | I | I | C | A/R | C |\n')],
    ['CONTRIBUTING keyword soup', 'CONTRIBUTING.md', () => '# RACI Ready merge release draft-only'],
    ['CODEOWNERS rules commented out', '.github/CODEOWNERS', (text) => text.replace(/^(?!#)(\S+\s+@\S+.*)$/gm, '# $1')],
    ['CODEOWNERS invalid owner', '.github/CODEOWNERS', (text) => text.replaceAll('@guanchen-dotcom', 'owner')],
    ['stacked YAML scalar type mutation', 'docs/stacked-pr.md', (text) => text.replace('issue: 65', 'issue: "65"')],
    ['stacked YAML invalid temporary SHA', 'docs/stacked-pr.md', (text) => text.replace('92eccd190753752324ee78bf4a3fd564b36f2519', 'not-a-sha')],
    ['stacked YAML merge order mutation', 'docs/stacked-pr.md', (text) => text.replace('merge_order: [90, 91]', 'merge_order: [91, 90]')],
    ['stacked YAML issue used as child PR', 'docs/stacked-pr.md', (text) => text.replace('merge_order: [90, 91]', 'merge_order: [90, 65]')],
    ['stacked YAML child PR omitted', 'docs/stacked-pr.md', (text) => text.replace('merge_order: [90, 91]', 'merge_order: [90, 92]')],
    ['stacked YAML duplicate PR order', 'docs/stacked-pr.md', (text) => text.replace('merge_order: [90, 91]', 'merge_order: [90, 90, 91]')],
    ['stacked YAML issue and PR collision', 'docs/stacked-pr.md', (text) => text.replace('pr: 91', 'pr: 65')],
    ['stacked YAML force-push mutation', 'docs/stacked-pr.md', (text) => text.replace('force_push: forbidden', 'force_push: allowed')],
    ['stacked YAML in wrong section', 'docs/stacked-pr.md', (text) => text.replace('## 必须记录的 metadata', '## Metadata moved elsewhere')],
    ['stacked keyword soup', 'docs/stacked-pr.md', () => '# stacked PR metadata merge_order rebind force_push'],
    ['PR template missing Refs field', '.github/pull_request_template.md', (text) => text.replace(/^Refs #\s*$/m, '')],
    ['PR template missing stacked field', '.github/pull_request_template.md', (text) => text.replace(/^- Merge order:\n/m, '')],
    ['collaboration flow targets main', 'docs/github_collaboration.md', (text) => text.replace('-> Merge：仅由 Lead/维护者普通合入 integration/m1-test-20260815', '-> Merge：合并到 main')],
    ['collaboration flow missing integration target', 'docs/github_collaboration.md', (text) => text.replace('-> Merge：仅由 Lead/维护者普通合入 integration/m1-test-20260815', '-> Merge：仅由 Lead/维护者普通合入 integration/other-target')],
    ['absolute path injection', 'CONTRIBUTING.md', (text) => text + '\nEvidence: C:\\Users\\example\\secret.txt\n'],
    ['secret injection', 'CONTRIBUTING.md', (text) => text + '\napi_key: 0123456789abcdef\n'],
  ];

  for (const lineEnding of ['lf', 'crlf']) {
    for (const [name, file, change] of mutations) {
      const errors = mutate(file, change, lineEnding);
      assert.ok(errors.length > 0, `${lineEnding} ${name} unexpectedly passed`);
    }
  }
});

test('mutation helper rejects no-op changes instead of reporting a false green', () => {
  assert.throws(
    () => mutate('docs/handoff-template.md', (text) => text, 'crlf'),
    /mutation was a no-op/,
  );
});

test('generic stacked instances accept different issue, PR, parent and SHA values', () => {
  const errors = mutate('docs/stacked-pr.md', (text) => text
    .replace('issue: 65', 'issue: 72')
    .replace('pr: 91', 'pr: 104')
    .replace('branch: agent/issue-65-gov-01', 'branch: agent/issue-72-governance')
    .replace('branch: agent/issue-59-qa-01', 'branch: agent/issue-71-runtime')
    .replace('sha: 92eccd190753752324ee78bf4a3fd564b36f2519', 'sha: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    .replace('pr: 90', 'pr: 101')
    .replace('merge_order: [90, 91]', 'merge_order: [101, 104]'));
  assert.deepEqual(errors, []);
});

test('GitHub governance facts support verified only with complete evidence', () => {
  const errors = mutate('docs/github_collaboration.md', (text) => text.replace(
    /```yaml\nstatus: unavailable[\s\S]*?```/,
    '```yaml\nstatus: verified\nchecked_at: 2026-08-16T20:00:00+08:00\nbranch: integration/m1-test-20260815\nruleset: repository-ruleset-1\nrequired_review: two independent approvals recorded by platform\n```',
  ));
  assert.deepEqual(errors, []);
  const pseudoVerified = mutate('docs/github_collaboration.md', (text) => text.replace('status: unavailable', 'status: verified'));
  assert.ok(pseudoVerified.length > 0);
});

test('CODEOWNERS accepts additional valid user and team owners', () => {
  const errors = mutate('.github/CODEOWNERS', (text) => text.replace('/apps/server/ @guanchen-dotcom', '/apps/server/ @guanchen-dotcom @acme/platform-reviewers'));
  assert.deepEqual(errors, []);
});
