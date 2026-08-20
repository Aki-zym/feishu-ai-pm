import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatPlaywrightCounts,
  summarizePlaywrightReport,
  verifyPlaywrightExecution,
} from './playwright-evidence-policy.mjs';

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const controlledFailure = 'Playwright execution verification failed; evidence missing or invalid.\n';

export async function runPlaywrightResultsVerifier({
  repoRoot = defaultRepoRoot,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const artifactRoot = resolve(repoRoot, 'ci-artifacts');
    const reportRoot = resolve(repoRoot, 'tmp', 'ci-reports');
    const inventory = JSON.parse(await readFile(resolve(reportRoot, 'playwright-inventory.json'), 'utf8'));
    const report = JSON.parse(await readFile(resolve(reportRoot, 'playwright-results.json'), 'utf8'));
    const result = summarizePlaywrightReport(report, { phase: 'execution' });
    verifyPlaywrightExecution(inventory, result);
    await mkdir(artifactRoot, { recursive: true });
    const counts = {
      schemaVersion: 1,
      runner: 'playwright',
      total: result.total,
      projects: Object.fromEntries(Object.entries(result.projects).map(([name, project]) => [name, {
        discovered: project.discovered,
        executed: project.executed,
        passed: project.passed,
        skipped: project.skipped,
        failed: project.failed,
      }])),
    };
    await writeFile(resolve(reportRoot, 'playwright-execution.json'), `${JSON.stringify(counts, null, 2)}\n`);
    const executionSummary = formatPlaywrightCounts('Playwright execution verified', result);
    await writeFile(resolve(artifactRoot, 'playwright-execution-summary.txt'), executionSummary);
    stdout.write(executionSummary);
    return 0;
  } catch {
    stderr.write(controlledFailure);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPlaywrightResultsVerifier();
}
