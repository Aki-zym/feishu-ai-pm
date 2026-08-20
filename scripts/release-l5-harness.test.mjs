import assert from 'node:assert/strict';
import test from 'node:test';
import { RELEASE_SCENARIOS, runSyntheticReleaseHarness } from './release-l5-harness.mjs';

test('release L5 synthetic harness covers upgrade, rollback and fail-closed fault scenarios', () => {
  const result = runSyntheticReleaseHarness({ platform: 'linux' });
  assert.equal(result.status, 'synthetic_passed');
  assert.equal(result.windows_available, false);
  assert.equal(result.upgrade_preserved_data, true);
  assert.equal(result.downgrade_rejected, true);
  assert.equal(result.faults_fail_closed, true);
  assert.deepEqual(result.scenarios, RELEASE_SCENARIOS);
  assert.equal(result.external_provider, 'synthetic_adapter_only');
});
