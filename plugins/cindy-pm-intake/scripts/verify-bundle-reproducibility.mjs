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
  await execFileAsync(process.execPath, [bundleScript], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
}

await runBundle();
const first = await snapshot();
await runBundle();
const second = await snapshot();
assert.deepEqual(second, first);
console.log(`bundle reproducibility verified: ${first.size} generated files, LF-only text, identical hashes`);
