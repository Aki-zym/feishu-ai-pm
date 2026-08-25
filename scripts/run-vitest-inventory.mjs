import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportRoot = resolve(repoRoot, 'tmp', 'ci-reports', 'vitest');
const artifactRoot = resolve(repoRoot, 'ci-artifacts');
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const DEFAULT_VITEST_TEST_TIMEOUT_MS = 5_000;
const MAX_VITEST_TEST_TIMEOUT_MS = 120_000;
const TEST_FILE = /(?:^|\.)(?:bench|benchmark|cy|fixture|mock|spec|stories|story|test)\.[cm]?[jt]sx?$/i;
const workspaces = Object.freeze([
  { name: 'server', package: '@ai-pm/server', directory: 'apps/server' },
  { name: 'web', package: '@ai-pm/web', directory: 'apps/web' },
]);
const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));

const normalizePath = (value) => value.replaceAll('\\', '/').replace(/^\.\//, '');

function usageError(message) {
  throw new Error(`${message} Usage: npm test [-- --workspace server|web [--file <workspace-relative-test-file>]]`);
}

export function parseVitestTestTimeout(env = process.env) {
  const raw = env.VITEST_TEST_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_VITEST_TEST_TIMEOUT_MS;
  if (!/^\d+$/.test(String(raw))) usageError('VITEST_TEST_TIMEOUT_MS must be an integer in milliseconds.');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_VITEST_TEST_TIMEOUT_MS) {
    usageError(`VITEST_TEST_TIMEOUT_MS must be between 1000 and ${MAX_VITEST_TEST_TIMEOUT_MS}.`);
  }
  return value;
}

export function parseVitestFileParallelism(env = process.env) {
  const raw = env.VITEST_FILE_PARALLELISM;
  if (raw === undefined || raw === '') return true;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  usageError('VITEST_FILE_PARALLELISM must be true or false.');
}

function parseValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) usageError(`${flag} requires a value.`);
  return value;
}

export function parseInventoryArgs(args = []) {
  if (!Array.isArray(args)) usageError('Arguments must be an array.');
  let workspaceName;
  let file;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--workspace') {
      if (workspaceName !== undefined) usageError('--workspace may be specified only once.');
      workspaceName = parseValue(args, index, '--workspace');
      index += 1;
      continue;
    }
    if (arg.startsWith('--workspace=')) {
      if (workspaceName !== undefined) usageError('--workspace may be specified only once.');
      workspaceName = arg.slice('--workspace='.length);
      if (!workspaceName) usageError('--workspace requires a value.');
      continue;
    }
    if (arg === '--file') {
      if (file !== undefined) usageError('--file may be specified only once.');
      file = parseValue(args, index, '--file');
      index += 1;
      continue;
    }
    if (arg.startsWith('--file=')) {
      if (file !== undefined) usageError('--file may be specified only once.');
      file = arg.slice('--file='.length);
      if (!file) usageError('--file requires a value.');
      continue;
    }
    usageError(`Unknown argument ${arg}.`);
  }

  if (workspaceName !== undefined && !workspaceByName.has(workspaceName)) usageError(`Unknown workspace ${workspaceName}.`);
  if (file !== undefined && workspaceName === undefined) usageError('--file requires --workspace.');
  const workspace = workspaceName ? workspaceByName.get(workspaceName) : null;
  let target;
  if (file !== undefined) {
    if (typeof file !== 'string' || file.trim() === '' || isAbsolute(file)) usageError('--file must be a non-empty repository-relative path.');
    const normalized = normalizePath(file.trim());
    const workspacePrefix = `${workspace.directory}/`;
    const repoRelative = normalized.startsWith(workspacePrefix) ? normalized : `${workspace.directory}/${normalized}`;
    const workspaceRelative = repoRelative.slice(workspacePrefix.length);
    const resolved = resolve(repoRoot, repoRelative);
    const escaped = relative(resolve(repoRoot, workspace.directory), resolved);
    if (!workspaceRelative || workspaceRelative.split('/').includes('..') || escaped === '..' || escaped.startsWith('../') || !TEST_FILE.test(workspaceRelative)) {
      usageError(`Invalid test file ${file}.`);
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) usageError(`Test file does not exist: ${repoRelative}.`);
    target = { repoRelative, workspaceRelative };
  }
  return { workspaces: workspace ? [workspace] : [...workspaces], target };
}

function runWorkspace(workspace, outputFile, target, testTimeoutMs, fileParallelism) {
  const reportPath = relative(resolve(repoRoot, workspace.directory), outputFile).replaceAll('\\', '/');
  const args = [
    'run',
    'test',
    '-w',
    workspace.package,
    '--',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
    `--testTimeout=${testTimeoutMs}`,
  ];
  if (!fileParallelism) args.push(...vitestSerialFlags());
  if (target) args.push(target.workspaceRelative);
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd: repoRoot, stdio: 'inherit', windowsHide: true });
    child.once('error', (error) => resolveRun({ code: 1, error }));
    child.once('exit', (code, signal) => resolveRun({ code: code ?? 1, signal }));
  });
}

export function vitestSerialFlags() {
  return ['--no-file-parallelism', '--maxWorkers=1', '--minWorkers=1', '--pool=threads', '--poolOptions.threads.singleThread'];
}

export function inventoryPackagePasses(result, report) {
  const total = Number(report?.numTotalTests ?? 0);
  const passed = Number(report?.numPassedTests ?? 0);
  const failedTests = Number(report?.numFailedTests ?? 0);
  return result?.code === 0 && total >= 1 && passed >= 1 && failedTests === 0;
}

export async function runInventory(args = process.argv.slice(2)) {
  if (!existsSync(npmCli)) throw new Error('Unable to locate the npm CLI for test inventory.');
  const selection = parseInventoryArgs(args);
  const testTimeoutMs = parseVitestTestTimeout();
  const fileParallelism = parseVitestFileParallelism();
  await mkdir(reportRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  const inventory = { schemaVersion: 1, runner: 'vitest', selection: { workspaces: selection.workspaces.map(({ name }) => name), file: selection.target?.repoRelative ?? null }, packages: [] };
  let failed = false;
  for (const workspace of selection.workspaces) {
    const outputFile = resolve(reportRoot, `${workspace.name}.json`);
    await rm(outputFile, { force: true });
    const result = await runWorkspace(workspace, outputFile, selection.target, testTimeoutMs, fileParallelism);
    let report;
    try {
      report = JSON.parse(await readFile(outputFile, 'utf8'));
    } catch (error) {
      failed = true;
      process.stderr.write(`${workspace.name}: Vitest did not produce a readable JSON report (${error instanceof Error ? error.message : String(error)}).\n`);
      continue;
    }
    const total = Number(report.numTotalTests ?? 0);
    const passed = Number(report.numPassedTests ?? 0);
    const failedTests = Number(report.numFailedTests ?? 0);
    const skipped = Number(report.numPendingTests ?? 0) + Number(report.numTodoTests ?? 0);
    inventory.packages.push({ name: workspace.name, total, passed, failed: failedTests, skipped });
    process.stdout.write(`Test inventory ${workspace.name}: total=${total} passed=${passed} failed=${failedTests} skipped=${skipped}\n`);
    if (!inventoryPackagePasses(result, report)) failed = true;
  }
  await writeFile(resolve(artifactRoot, 'vitest-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(resolve(artifactRoot, 'vitest-inventory-summary.txt'), `${[
    'schema=vitest-inventory-v1',
    `selection.workspaces=${selection.workspaces.map(({ name }) => name).join(',')}`,
    `selection.file=${selection.target?.repoRelative ?? 'all'}`,
    ...inventory.packages.flatMap((item) => [
      `${item.name}.total=${item.total}`,
      `${item.name}.passed=${item.passed}`,
      `${item.name}.failed=${item.failed}`,
      `${item.name}.skipped=${item.skipped}`,
    ]),
    '',
  ].join('\n')}`);
  if (inventory.packages.length !== selection.workspaces.length) failed = true;
  if (failed) throw new Error('Vitest inventory gate failed; every selected package must discover and pass at least one test.');
  return inventory;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    await runInventory();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
