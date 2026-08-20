import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedChild } from './ci-log-policy.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const [logName, separator, ...command] = process.argv.slice(2);
  if (!/^[a-z0-9-]+$/i.test(logName ?? '') || separator !== '--' || command.length === 0) {
    throw new Error('invalid wrapper invocation');
  }
  if (command[0] !== 'npm') throw new Error('unsupported wrapped command');

  const npmCliCandidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = npmCliCandidates.find((candidate) => existsSync(candidate));
  if (!npmCli) throw new Error('npm CLI unavailable');

  const result = await runBoundedChild({
    command: process.execPath,
    args: [npmCli, ...command.slice(1)],
    cwd: repoRoot,
    label: logName,
  });
  if (result.code !== 0) process.exitCode = result.code;
}

try {
  await main();
} catch {
  process.stderr.write('CI command wrapper: failed; exit_code=1; child_output=suppressed; wrapper_error=controlled.\n');
  process.exitCode = 1;
}
