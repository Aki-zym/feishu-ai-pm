import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = resolve(repoRoot, 'ci-artifacts', 'e2e-build-provenance.json');
const requiredArtifactRoots = ['apps/web/dist', 'apps/server/dist'];

function currentCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function sourceStateHash() {
  const hash = createHash('sha256');
  hash.update(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repoRoot }));
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).split('\0').filter(Boolean).sort();
  for (const path of untracked) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(resolve(repoRoot, path)));
  }
  return hash.digest('hex');
}

function artifactTreeHash(path) {
  const absolute = resolve(repoRoot, path);
  if (!existsSync(absolute)) throw new Error(`Required E2E build artifact root is missing: ${path}.`);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  visit(absolute);
  if (files.length === 0) throw new Error(`Required E2E build artifact root is empty: ${path}.`);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(relative(absolute, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}

export function writeE2eBuildProvenance() {
  const report = {
    schemaVersion: 1,
    commit: currentCommit(),
    sourceState: sourceStateHash(),
    artifacts: Object.fromEntries(requiredArtifactRoots.map((path) => [path, artifactTreeHash(path)])),
  };
  mkdirSync(dirname(stampPath), { recursive: true });
  writeFileSync(stampPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`E2E build provenance recorded for ${report.commit} (${requiredArtifactRoots.length} artifact trees).\n`);
}

export function verifyE2eBuildProvenance() {
  if (!existsSync(stampPath)) throw new Error('E2E_REUSE_BUILD requires ci-artifacts/e2e-build-provenance.json from this run.');
  const report = JSON.parse(readFileSync(stampPath, 'utf8'));
  const commit = currentCommit();
  if (report.commit !== commit) throw new Error(`E2E build provenance is for ${report.commit}, not current commit ${commit}.`);
  if (report.sourceState !== sourceStateHash()) throw new Error('E2E source state changed after build provenance was recorded.');
  for (const path of requiredArtifactRoots) {
    if (report.artifacts?.[path] !== artifactTreeHash(path)) throw new Error(`E2E build artifact tree changed after provenance was recorded: ${path}.`);
  }
  process.stdout.write(`E2E build provenance verified for ${commit}.\n`);
}

const command = process.argv[2];
if (command === 'write') writeE2eBuildProvenance();
else if (command === 'verify') verifyE2eBuildProvenance();
else if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  throw new Error('Usage: node scripts/e2e-build-provenance.mjs <write|verify>');
}
