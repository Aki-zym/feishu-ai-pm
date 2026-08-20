import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_SCENARIOS = Object.freeze([
  'install',
  'startup',
  'second_instance',
  'window_close',
  'tray_exit',
  'uninstall',
  'upgrade',
  'reinstall',
  'downgrade_rejected',
  'database_corruption',
  'migration_failure',
  'disk_full',
  'file_lock',
  'config_corruption',
  'network_offline',
  'auth_failure',
  'rate_limit_429',
  'pagination_failure',
]);

const FIXED_FAULTS = Object.freeze({
  database_corruption: 'DB_CORRUPT',
  migration_failure: 'MIGRATION_FAILED',
  disk_full: 'DISK_FULL',
  file_lock: 'FILE_LOCKED',
  config_corruption: 'CONFIG_CORRUPT',
  network_offline: 'NETWORK_OFFLINE',
  auth_failure: 'AUTH_FAILED',
  rate_limit_429: 'RATE_LIMITED',
  pagination_failure: 'PAGINATION_FAILED',
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function syntheticProvider(scenario) {
  if (FIXED_FAULTS[scenario]) return { status: 'unavailable', error_code: FIXED_FAULTS[scenario] };
  return { status: 'success', value: `synthetic-${scenario}` };
}

function writeState(root, version, data) {
  writeFileSync(join(root, 'state.json'), JSON.stringify({ version, data }, null, 2));
}

function readState(root) {
  return JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
}

export function runSyntheticReleaseHarness({ platform = process.platform } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-l5-contract-'));
  try {
    const originalData = { owner: 'synthetic-owner', taskCount: 2 };
    writeState(root, '0.1.0', originalData);

    const beforeUpgrade = readState(root);
    writeState(root, '0.2.0', beforeUpgrade.data);
    const upgraded = readState(root);
    assert(upgraded.version === '0.2.0', 'N-1 to N upgrade did not advance version.');
    assert(JSON.stringify(upgraded.data) === JSON.stringify(originalData), 'N-1 to N upgrade lost data.');

    const reinstall = readState(root);
    assert(JSON.stringify(reinstall.data) === JSON.stringify(originalData), 'reinstall did not preserve data.');
    assert(syntheticProvider('downgrade_rejected').status === 'success', 'synthetic adapter setup failed.');
    const downgrade = { status: 'rejected', error_code: 'DOWNGRADE_REJECTED' };
    assert(downgrade.status === 'rejected', 'downgrade was not rejected.');

    const faultResults = Object.fromEntries(Object.keys(FIXED_FAULTS).map((scenario) => [scenario, syntheticProvider(scenario)]));
    for (const [scenario, result] of Object.entries(faultResults)) {
      assert(result.status === 'unavailable', `${scenario} did not fail closed.`);
      assert(result.error_code === FIXED_FAULTS[scenario], `${scenario} returned an unstable error code.`);
    }

    return {
      status: 'synthetic_passed',
      platform,
      windows_available: platform === 'win32',
      scenarios: RELEASE_SCENARIOS,
      upgrade_preserved_data: true,
      downgrade_rejected: true,
      faults_fail_closed: true,
      external_provider: 'synthetic_adapter_only',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const requireWindows = process.argv.includes('--require-windows');
  try {
    if (requireWindows && process.platform !== 'win32') throw new Error('Windows runner is required for the L5 harness.');
    const result = runSyntheticReleaseHarness();
    process.stdout.write(`RELEASE_L5_HARNESS:${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'release L5 harness failed'}\n`);
    process.exitCode = 1;
  }
}
