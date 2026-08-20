import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseManifestArtifactErrors, releaseManifestAuthorization, releaseManifestErrors } from './release-manifest.mjs';

const scenarios = ['install', 'startup', 'second_instance', 'window_close', 'tray_exit', 'uninstall', 'upgrade', 'reinstall', 'downgrade_rejected', 'database_corruption', 'migration_failure', 'disk_full', 'file_lock', 'config_corruption', 'network_offline', 'auth_failure', 'rate_limit_429', 'pagination_failure'];
const pending = {
  schema_version: 1,
  status: 'pending',
  authorization: false,
  version: '0.2.0',
  source: {
    commit: 'pull_request_62_pending',
    tree: 'pull_request_62_pending',
    base_commit: 'pull_request_62_pending',
    head_commit: 'pull_request_62_pending',
    merge_ref: 'pull_request_62_pending',
  },
  artifact: { path: 'release/Feishu-AI-PM-0.2.0-x64-Setup.exe', sha256: 'a'.repeat(64), size_bytes: 101, architecture: 'x64', blockmap_sha256: 'b'.repeat(64), blockmap_size_bytes: 10 },
  workflow: { repository: 'acme/pm', workflow_name: 'Release L5 Gate', event: 'pull_request', run_id: 'pull_request_62_pending', job_id: 'pull_request_62_pending', check_name: 'windows-l5' },
  compatibility: { electron: '43.3.0', node_major: 24, database_schema: 'ai-pm-v1-current', config_schema: 'desktop-config-v1' },
  signature: { status: 'NotSigned', thumbprint: null, timestamp: null, chain_status: null, artifact_sha256: null, artifact_size_bytes: null },
  smoke: { status: 'not_run', evidence_ids: [], scenarios, environment: 'pending' },
  evidence_contract: { browser_desktop: '1440x900', browser_mobile: 'Pixel 7 / 320px', electron_window: '980x680' },
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex').toUpperCase();

function createArtifactFixture(manifest) {
  const root = mkdtempSync(join(tmpdir(), 'release-manifest-fixture-'));
  mkdirSync(join(root, 'release'), { recursive: true });
  const artifact = Buffer.from('synthetic nsis artifact');
  const blockmap = Buffer.from('synthetic blockmap');
  const artifactPath = join(root, manifest.artifact.path);
  writeFileSync(artifactPath, artifact);
  writeFileSync(`${artifactPath}.blockmap`, blockmap);
  const artifactSha256 = sha256(artifact);
  const blockmapSha256 = sha256(blockmap);
  const sha512 = createHash('sha512').update(artifact).digest('base64');
  writeFileSync(join(root, 'release', 'latest.yml'), [
    'version: 0.2.0',
    'files:',
    `  - url: ${manifest.artifact.path.split('/').pop()}`,
    `    sha512: ${sha512}`,
    `    size: ${artifact.length}`,
    `path: ${manifest.artifact.path.split('/').pop()}`,
    `sha512: ${sha512}`,
  ].join('\n'));
  manifest.artifact = {
    ...manifest.artifact,
    sha256: artifactSha256,
    size_bytes: artifact.length,
    blockmap_sha256: blockmapSha256,
    blockmap_size_bytes: blockmap.length,
  };
  return { root, artifactPath, artifactSha256, artifactSize: artifact.length };
}

function authorizedFixture() {
  const manifest = structuredClone(pending);
  manifest.status = 'verified';
  manifest.authorization = true;
  manifest.source = {
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    base_commit: 'c'.repeat(40),
    head_commit: 'a'.repeat(40),
    merge_ref: 'e'.repeat(40),
  };
  manifest.workflow = { ...manifest.workflow, run_id: '123', job_id: '456' };
  manifest.signature = { status: 'signed', thumbprint: 'f'.repeat(40), timestamp: '2026-08-16T00:00:00Z', chain_status: 'valid', artifact_sha256: null, artifact_size_bytes: null };
  manifest.smoke = { ...manifest.smoke, status: 'passed', evidence_ids: ['VER-62-WINDOWS-L5'] };
  const fixture = createArtifactFixture(manifest);
  manifest.signature.artifact_sha256 = manifest.artifact.sha256;
  manifest.signature.artifact_size_bytes = manifest.artifact.size_bytes;
  const options = {
    repoRoot: fixture.root,
    expectedSourceCommit: manifest.source.commit,
    expectedSourceTree: manifest.source.tree,
    expectedBaseCommit: manifest.source.base_commit,
    expectedHeadCommit: manifest.source.head_commit,
    expectedMergeRef: manifest.source.merge_ref,
    expectedArtifactSha256: manifest.artifact.sha256,
    expectedArtifactSize: manifest.artifact.size_bytes,
    expectedRunId: manifest.workflow.run_id,
    expectedJobId: manifest.workflow.job_id,
    authorizedThumbprints: [manifest.signature.thumbprint],
    artifactInspection: {
      path: manifest.artifact.path,
      sha256: manifest.artifact.sha256,
      size_bytes: manifest.artifact.size_bytes,
      signature: { ...manifest.signature },
    },
  };
  return { manifest, fixture, options };
}

test('pending release manifest is structurally valid but cannot authorize', () => {
  assert.deepEqual(releaseManifestErrors(pending), []);
  assert.equal(releaseManifestAuthorization(pending), false);
});

test('authorization requires trusted exact provenance, owner policy and actual inspection', () => {
  const { manifest, fixture, options } = authorizedFixture();
  try {
    assert.deepEqual(releaseManifestErrors(manifest, { requireAuthorization: true }), [
      'authorized manifest requires an explicit owner certificate thumbprint allowlist.',
      'authorized manifest requires an actual Authenticode inspection result.',
      'authorized manifest requires trusted expected source.commit.',
      'authorized manifest requires trusted expected source.tree.',
      'authorized manifest requires trusted expected source.base_commit.',
      'authorized manifest requires trusted expected source.head_commit.',
      'authorized manifest requires trusted expected source.merge_ref.',
      'authorized manifest requires trusted expected artifact.sha256.',
      'authorized manifest requires trusted expected artifact.size_bytes.',
      'authorized manifest requires trusted expected workflow.run_id.',
      'authorized manifest requires trusted expected workflow.job_id.',
    ]);
    assert.equal(releaseManifestAuthorization(manifest, options), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('format-valid replayed provenance is rejected when any trusted value differs', () => {
  const { manifest, fixture, options } = authorizedFixture();
  try {
    const expectedKeys = ['expectedSourceCommit', 'expectedSourceTree', 'expectedBaseCommit', 'expectedHeadCommit', 'expectedMergeRef', 'expectedArtifactSha256', 'expectedArtifactSize', 'expectedRunId', 'expectedJobId'];
    for (const key of expectedKeys) {
      const replay = { ...options };
      replay[key] = key.endsWith('Id') ? '999' : key.endsWith('Size') ? options[key] + 1 : '0'.repeat(40);
      assert.equal(releaseManifestAuthorization(manifest, replay), false, `${key} must be exact-bound`);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('artifact replacement and mismatched Authenticode inspection fail closed', () => {
  const { manifest, fixture, options } = authorizedFixture();
  try {
    writeFileSync(fixture.artifactPath, Buffer.from('replacement artifact'));
    assert.equal(releaseManifestAuthorization(manifest, options), false);

    const restored = Buffer.from('synthetic nsis artifact');
    writeFileSync(fixture.artifactPath, restored);
    const mismatchedInspection = {
      ...options,
      artifactInspection: {
        ...options.artifactInspection,
        signature: { ...options.artifactInspection.signature, thumbprint: '0'.repeat(40) },
      },
    };
    assert.equal(releaseManifestAuthorization(manifest, mismatchedInspection), false);

    const unsignedInspection = {
      ...options,
      artifactInspection: {
        ...options.artifactInspection,
        signature: { ...options.artifactInspection.signature, status: 'NotSigned', thumbprint: null, timestamp: null, chain_status: null },
      },
    };
    assert.equal(releaseManifestAuthorization(manifest, unsignedInspection), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('owner allowlist rejects a format-valid but unauthorized thumbprint', () => {
  const { manifest, fixture, options } = authorizedFixture();
  try {
    assert.equal(releaseManifestAuthorization(manifest, { ...options, authorizedThumbprints: ['0'.repeat(40)] }), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('artifact verification binds executable, blockmap and latest metadata', () => {
  const manifest = structuredClone(pending);
  const fixture = createArtifactFixture(manifest);
  try {
    assert.deepEqual(releaseManifestArtifactErrors(manifest, { repoRoot: fixture.root }), []);
    const mismatch = structuredClone(manifest);
    mismatch.artifact.size_bytes += 1;
    assert.ok(releaseManifestArtifactErrors(mismatch, { repoRoot: fixture.root }).some((error) => error.includes('size_bytes')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
