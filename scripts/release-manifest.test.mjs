import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseManifestArtifactErrors, releaseManifestAuthorization, releaseManifestErrors } from './release-manifest.mjs';

const valid = {
  schema_version: 2,
  status: 'current',
  authorization: false,
  version: '0.2.0',
  source: {
    commit: 'pending_current_runtime',
    tree: 'pending_current_runtime',
    base_commit: 'pending_current_runtime',
    head_commit: 'pending_current_runtime',
    merge_ref: 'pending_current_runtime',
  },
  workflow: {
    repository: 'acme/pm',
    workflow_name: 'Current runtime CI',
    event: 'pull_request',
    run_id: 'pending_current_runtime',
    job_id: 'pending_current_runtime',
    check_name: 'plugin-server-web',
  },
  runtime: { host: '127.0.0.1', port: 4310, database: 'SQLite', server: 'apps/server', web: 'apps/web', plugin: 'plugins/cindy-pm-intake' },
  evidence_contract: { plugin_tests: 'npm run test:plugin', server_tests: 'npm run test:server:current', web_tests: 'npm run test:web:current', typecheck: 'npm run typecheck' },
};

test('current runtime manifest is structurally valid and identifies the local product path', () => {
  assert.deepEqual(releaseManifestErrors(valid), []);
  assert.equal(releaseManifestAuthorization(valid), true);
  assert.deepEqual(releaseManifestArtifactErrors(valid), []);
});

test('runtime manifest rejects a public host or desktop-style runtime entry', () => {
  const host = structuredClone(valid);
  host.runtime.host = '0.0.0.0';
  assert.match(releaseManifestErrors(host).join('\n'), /127\.0\.0\.1/);

  const extra = structuredClone(valid);
  extra.runtime.desktop = 'legacy';
  assert.match(releaseManifestErrors(extra).join('\n'), /runtime\.desktop is not allowed/);
});
