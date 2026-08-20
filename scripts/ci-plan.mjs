import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectCiPlan } from './ci-selection-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shaPattern = /^[0-9a-f]{40}$/i;

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function requireSha(name, value) {
  if (!shaPattern.test(value ?? '')) throw new Error(`${name} must be a full 40-character Git commit SHA.`);
  return value.toLowerCase();
}

function gitAt(repoRoot, args, options = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...options }).trim();
}

function requireObject(repoRoot, label, sha, type = 'commit') {
  try {
    gitAt(repoRoot, ['cat-file', '-e', `${sha}^{${type}}`]);
  } catch {
    throw new Error(`${label} does not exist as a Git ${type}.`);
  }
}

function requireCleanWorktree(repoRoot) {
  const status = gitAt(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw new Error('local exact verification requires a clean worktree.');
}

export function parseLocalExactArgs(args = []) {
  if (!Array.isArray(args) || args[0] !== 'local') throw new Error('Usage: node scripts/ci-plan.mjs local --base <40-char> --head <40-char> --merge <40-char>.');
  const values = new Map();
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    const match = /^(--base|--head|--merge)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unknown local exact argument ${arg ?? '<missing>'}.`);
    const name = match[1].slice(2);
    const value = match[2] ?? args[++index];
    if (!value || value.startsWith('--') || values.has(name)) throw new Error(`local exact --${name} requires exactly one value.`);
    values.set(name, requireSha(`--${name}`, value));
  }
  for (const name of ['base', 'head', 'merge']) if (!values.has(name)) throw new Error(`local exact --${name} is required.`);
  return { baseSha: values.get('base'), headSha: values.get('head'), mergeSha: values.get('merge') };
}

export function verifyLocalExactInputs({ repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), baseSha, headSha, mergeSha } = {}) {
  const base = requireSha('--base', baseSha);
  const head = requireSha('--head', headSha);
  const merge = requireSha('--merge', mergeSha);
  if (base === head) throw new Error('--base and --head must identify distinct commits.');
  requireObject(repoRoot, 'base', base);
  requireObject(repoRoot, 'head', head);
  requireObject(repoRoot, 'merge', merge);
  requireCleanWorktree(repoRoot);
  const checkedOut = requireSha('checked-out HEAD', gitAt(repoRoot, ['rev-parse', 'HEAD']));
  if (checkedOut !== head) throw new Error(`local exact worktree HEAD is ${checkedOut}, expected --head ${head}.`);
  const parents = gitAt(repoRoot, ['rev-list', '--parents', '-n', '1', merge]).split(/\s+/).slice(1);
  if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) {
    throw new Error(`local exact merge parents must be [base, head], got [${parents.join(', ')}].`);
  }
  const actualTree = requireSha('merge tree', gitAt(repoRoot, ['show', '-s', '--format=%T', merge]));
  let virtualTree;
  try {
    virtualTree = requireSha('computed virtual merge tree', gitAt(repoRoot, ['merge-tree', '--write-tree', base, head]));
  } catch {
    throw new Error('base/head cannot be combined into a conflict-free virtual merge tree.');
  }
  if (actualTree !== virtualTree) throw new Error(`merge tree ${actualTree} does not equal computed virtual merge tree ${virtualTree}.`);
  requireObject(repoRoot, 'merge tree', actualTree, 'tree');
  return Object.freeze({
    baseSha: base,
    headSha: head,
    mergeSha: merge,
    treeSha: actualTree,
    parents: Object.freeze([base, head]),
    checkedOutHead: checkedOut,
    worktreeClean: true,
    virtualTree: actualTree,
  });
}

function verifyPullRequestMerge({ baseSha, headSha, mergeSha }) {
  const expectedMerge = requireSha('CI_MERGE_SHA', mergeSha);
  const actualMerge = requireSha('checked-out HEAD', git(['rev-parse', 'HEAD']));
  if (actualMerge !== expectedMerge) throw new Error(`CI checked out ${actualMerge}, expected merge ref ${expectedMerge}.`);
  const parents = git(['rev-list', '--parents', '-n', '1', actualMerge]).split(/\s+/).slice(1);
  const expectedParents = [requireSha('CI_BASE_SHA', baseSha), requireSha('CI_HEAD_SHA', headSha)];
  if (parents.length !== 2 || parents[0] !== expectedParents[0] || parents[1] !== expectedParents[1]) {
    throw new Error(`Merge ref parents do not match the event base/head (${parents.join(', ') || 'none'}).`);
  }
  return expectedParents[0];
}

export function createCiPlanReport({ eventName = '', localArgs = [], env = process.env, cwd = repoRoot } = {}) {
  const localMode = localArgs[0] === 'local';
  let baseSha;
  let headSha;
  let mergeSha;
  let treeSha;
  let parents = [];
  let plan;
  if (localMode) {
    const requested = parseLocalExactArgs(localArgs);
    const exact = verifyLocalExactInputs({ ...requested, repoRoot: cwd });
    ({ baseSha, headSha, mergeSha, treeSha, parents } = exact);
    const changed = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', baseSha, mergeSha], {
      cwd,
      encoding: 'utf8',
    }).split('\0').filter(Boolean);
    plan = selectCiPlan(changed);
  } else if (eventName === 'pull_request') {
    baseSha = verifyPullRequestMerge({
      baseSha: env.CI_BASE_SHA,
      headSha: env.CI_HEAD_SHA,
      mergeSha: env.CI_MERGE_SHA,
    });
    headSha = requireSha('CI_HEAD_SHA', env.CI_HEAD_SHA);
    mergeSha = requireSha('CI_MERGE_SHA', env.CI_MERGE_SHA);
    treeSha = git(['show', '-s', '--format=%T', mergeSha]);
    parents = git(['rev-list', '--parents', '-n', '1', mergeSha]).split(/\s+/).slice(1);
    const changed = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', baseSha, 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).split('\0').filter(Boolean);
    plan = selectCiPlan(changed);
  } else {
    plan = selectCiPlan(['<non-pull-request-event>']);
  }

  return {
    schemaVersion: 1,
    eventName,
    mode: localMode ? 'local_exact' : eventName === 'pull_request' ? 'pull_request_exact' : 'non_pull_request',
    mergeSha: mergeSha ?? git(['rev-parse', 'HEAD']),
    baseSha: baseSha ?? null,
    headSha: headSha ?? null,
    treeSha: treeSha ?? null,
    parents,
    ...plan,
  };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const report = createCiPlanReport({ eventName: process.env.CI_EVENT_NAME ?? '', localArgs: process.argv.slice(2) });
  mkdirSync(resolve(repoRoot, 'ci-artifacts'), { recursive: true });
  writeFileSync(resolve(repoRoot, 'ci-artifacts', 'ci-plan.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`CI selection: ${report.mode} (${report.reason}); categories=${report.categories.join(',')} files=${report.files.length}\n`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `mode=${report.mode}\n`, { flag: 'a' });
    writeFileSync(process.env.GITHUB_OUTPUT, `base_sha=${report.baseSha ?? ''}\n`, { flag: 'a' });
    writeFileSync(process.env.GITHUB_OUTPUT, `minimum_level=${report.minimumLevel}\n`, { flag: 'a' });
    writeFileSync(process.env.GITHUB_OUTPUT, `manual_review_required=${report.manualReviewRequired}\n`, { flag: 'a' });
  }
}
