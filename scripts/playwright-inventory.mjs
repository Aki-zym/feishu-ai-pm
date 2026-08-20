import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findForbiddenPlaywrightDirectives,
  formatPlaywrightCounts,
  summarizePlaywrightReport,
  verifyPlaywrightInventory,
} from './playwright-evidence-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = resolve(repoRoot, 'ci-artifacts');
const reportRoot = resolve(repoRoot, 'tmp', 'ci-reports');
const rawPath = resolve(reportRoot, 'playwright-list.json');
await mkdir(artifactRoot, { recursive: true });
await mkdir(reportRoot, { recursive: true });

const playwrightCli = join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const exitCode = await new Promise((resolveRun) => {
  const child = spawn(process.execPath, [playwrightCli, 'test', '--list', '--reporter=json'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.once('error', () => resolveRun(1));
  child.once('exit', async (code) => {
    await writeFile(rawPath, stdout);
    resolveRun(code ?? 1);
  });
});
if (exitCode !== 0) throw new Error('Playwright test discovery failed.');
const report = JSON.parse(await readFile(rawPath, 'utf8'));
const inventory = summarizePlaywrightReport(report, { phase: 'inventory' });
verifyPlaywrightInventory(inventory);
const e2eRoot = resolve(repoRoot, 'tests', 'e2e');
const sourceFiles = [];
const collectSources = async (directory, relativeDirectory = 'tests/e2e') => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    const relative = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) await collectSources(absolute, relative);
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) {
      sourceFiles.push({ path: relative, content: await readFile(absolute, 'utf8') });
    }
  }
};
await collectSources(e2eRoot);
const directives = findForbiddenPlaywrightDirectives(sourceFiles);
if (directives.length > 0) {
  throw new Error(`Playwright source contains forbidden only/skip/fixme directives: ${directives.map(({ file, directive }) => `${file}:${directive}`).join(', ')}.`);
}
await writeFile(resolve(reportRoot, 'playwright-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
const inventorySummary = formatPlaywrightCounts('Playwright inventory', inventory);
await writeFile(resolve(artifactRoot, 'playwright-inventory-summary.txt'), inventorySummary);
process.stdout.write(inventorySummary);
