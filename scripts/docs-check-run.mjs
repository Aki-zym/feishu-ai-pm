import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const run = (scriptArgs) => {
  const result = spawnSync(process.execPath, scriptArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(['scripts/docs-check.mjs', ...args]);
run(['scripts/domain-contracts-check.mjs']);
run(['scripts/decision-register-check.mjs']);
run(['scripts/prod-07-calendar-contract-check.mjs']);
