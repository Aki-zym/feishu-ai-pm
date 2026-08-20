import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseLocalExactArgs, verifyLocalExactInputs } from './ci-plan.mjs';

const sha = (value) => value.repeat(40);

test('local exact argument parsing requires explicit full base/head/merge SHAs', () => {
  assert.deepEqual(parseLocalExactArgs(['local', `--base=${sha('a')}`, '--head', sha('b'), '--merge', sha('c')]), { baseSha: sha('a'), headSha: sha('b'), mergeSha: sha('c') });
  for (const args of [
    ['local', '--base', 'a', '--head', sha('b'), '--merge', sha('c')],
    ['local', '--base', sha('a'), '--head', sha('b')],
    ['local', '--base', sha('a'), '--base', sha('b'), '--head', sha('c'), '--merge', sha('d')],
    ['local', '--base', sha('a'), '--head', sha('b'), '--merge', sha('c'), '--unknown', 'x'],
  ]) assert.throws(() => parseLocalExactArgs(args));
});

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'local-exact-plan-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run('init', '-q');
  run('config', 'user.email', 'local-exact@example.invalid');
  run('config', 'user.name', 'Local Exact');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  run('add', '.');
  run('commit', '-qm', 'base');
  const base = run('rev-parse', 'HEAD');
  run('checkout', '-qb', 'feature');
  writeFileSync(join(root, 'feature.txt'), 'feature\n');
  run('add', '.');
  run('commit', '-qm', 'feature');
  const head = run('rev-parse', 'HEAD');
  run('checkout', '-qb', 'integration', base);
  writeFileSync(join(root, 'integration.txt'), 'integration\n');
  run('add', '.');
  run('commit', '-qm', 'integration');
  run('merge', '--no-ff', '-q', '--no-edit', 'feature');
  const merge = run('rev-parse', 'HEAD');
  const firstParent = run('rev-parse', `${merge}^1`);
  run('checkout', '-q', 'feature');
  return { root, run, base: firstParent, head, merge };
}

test('local exact verification binds checked-out head, parents, tree and virtual merge tree', () => {
  const fixture = makeRepo();
  try {
    assert.deepEqual(verifyLocalExactInputs({ repoRoot: fixture.root, baseSha: fixture.base, headSha: fixture.head, mergeSha: fixture.merge }), {
      baseSha: fixture.base,
      headSha: fixture.head,
      mergeSha: fixture.merge,
      treeSha: fixture.run('show', '-s', '--format=%T', fixture.merge),
      parents: [fixture.base, fixture.head],
      checkedOutHead: fixture.head,
      worktreeClean: true,
      virtualTree: fixture.run('show', '-s', '--format=%T', fixture.merge),
    });
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('local exact verification rejects dirty worktree, wrong parent, wrong tree, single-parent and non-ancestor inputs', () => {
  const fixture = makeRepo();
  try {
    writeFileSync(join(fixture.root, 'dirty.txt'), 'dirty\n');
    assert.throws(() => verifyLocalExactInputs({ repoRoot: fixture.root, baseSha: fixture.base, headSha: fixture.head, mergeSha: fixture.merge }), /clean worktree/);
    rmSync(join(fixture.root, 'dirty.txt'));
    const wrongParent = fixture.run('commit-tree', fixture.run('show', '-s', '--format=%T', fixture.merge), '-p', fixture.head, '-p', fixture.base);
    assert.throws(() => verifyLocalExactInputs({ repoRoot: fixture.root, baseSha: fixture.base, headSha: fixture.head, mergeSha: wrongParent }), /parents/);
    assert.throws(() => verifyLocalExactInputs({ repoRoot: fixture.root, baseSha: fixture.base, headSha: fixture.base, mergeSha: fixture.merge }), /distinct/);
    const single = fixture.head;
    assert.throws(() => verifyLocalExactInputs({ repoRoot: fixture.root, baseSha: fixture.base, headSha: fixture.head, mergeSha: single }), /parents/);
    const wrongTree = fixture.run('commit-tree', fixture.run('show', '-s', '--format=%T', fixture.base), '-p', fixture.base, '-p', fixture.head);
    assert.throws(() => verifyLocalExactInputs({ repoRoot: fixture.root, baseSha: fixture.base, headSha: fixture.head, mergeSha: wrongTree }), /merge tree/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
