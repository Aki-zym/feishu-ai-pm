import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const bundleScript = resolve(import.meta.dirname, 'bundle-pm-runtime.mjs');
const generatedRoots = [
  resolve(root, 'plugins', 'cindy-pm-intake', 'node', 'pm-runtime.cjs'),
  resolve(root, 'plugins', 'cindy-pm-intake', 'web-dist'),
];
const textExtensions = new Set(['.cjs', '.html', '.js', '.css', '.json', '.map', '.txt', '.md', '.svg']);

async function filesAt(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!entries) return [path];
  const files = [];
  for (const entry of entries) files.push(...await filesAt(resolve(path, entry.name)));
  return files.sort();
}

async function snapshot() {
  const files = (await Promise.all(generatedRoots.map(filesAt))).flat().sort();
  const hashes = new Map();
  for (const file of files) {
    const bytes = await readFile(file);
    if (textExtensions.has(extname(file).toLowerCase())) {
      assert.equal(bytes.includes(13), false, `${file} must use LF-only text`);
    }
    hashes.set(file, createHash('sha256').update(bytes).digest('hex'));
  }
  return hashes;
}

async function runBundle() {
  const { stdout } = await execFileAsync(process.execPath, [bundleScript], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  const stateLine = stdout.split(/\r?\n/u).findLast((line) => line.startsWith('bundle-runtime-state '));
  assert.ok(stateLine, 'bundle did not report its deterministic runtime state');
  return JSON.parse(stateLine.slice('bundle-runtime-state '.length));
}

async function gitOutput(args) {
  return (await execFileAsync('git', args, { cwd: root, maxBuffer: 20 * 1024 * 1024 })).stdout;
}

assert.equal(await gitOutput(['status', '--porcelain=v1', '--untracked-files=all']), '', 'bundle verification requires a clean committed HEAD');
const committed = await snapshot();
const firstState = await runBundle();
const first = await snapshot();
assert.deepEqual(first, committed, 'first bundle generation differs from the clean committed HEAD');
await gitOutput(['diff', '--exit-code']);
await gitOutput(['diff', '--check']);
assert.equal(await gitOutput(['status', '--porcelain=v1', '--untracked-files=all']), '', 'first bundle generation changed the committed worktree');
const secondState = await runBundle();
const second = await snapshot();
assert.deepEqual(second, first, 'second bundle generation differs from the first generation');
assert.deepEqual(second, committed, 'second bundle generation differs from the clean committed HEAD');
assert.deepEqual(secondState, firstState, 'bundle input/config/esbuild state changed inside one verification round');
await gitOutput(['diff', '--exit-code']);
await gitOutput(['diff', '--check']);
assert.equal(await gitOutput(['status', '--porcelain=v1', '--untracked-files=all']), '', 'bundle generation changed the committed worktree');
console.log(`bundle reproducibility verified against committed HEAD: ${first.size} generated files, runtime=${firstState.output_sha256}, inputs=${firstState.input_sha256}, config=${firstState.config_sha256}, esbuild=${firstState.esbuild_version}@${firstState.esbuild_module}, LF-only text, identical hashes, clean worktree`);
