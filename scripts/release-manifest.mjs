import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const POSITIVE_ID = /^[1-9][0-9]*$/;
const SEMVER = /^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const COMPAT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const PENDING = /^pull_request_[1-9][0-9]*_pending$/;
const RELEASE_ARTIFACT = /^release\/[A-Za-z0-9._-]+-Setup\.exe$/;
const SIGNED_THUMBPRINT = /^[0-9a-f]{40}$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SIGNATURE_CHAIN_STATUS = new Set(['valid', 'invalid', 'unavailable']);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPending = (value) => typeof value === 'string' && PENDING.test(value);

function requireKeys(value, keys, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object.`);
    return false;
  }
  for (const key of keys) if (!hasOwn(value, key)) errors.push(`${path}.${key} is required.`);
  return true;
}

function expectExactKeys(value, keys, path, errors) {
  if (!isObject(value)) return;
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed.`);
}

function validateIdentity(value, path, errors, { allowPending = true } = {}) {
  if (SHA.test(String(value ?? ''))) return;
  if (allowPending && isPending(value)) return;
  errors.push(`${path} must be a full SHA or controlled pending identity.`);
}

export function releaseManifestErrors(manifest, {
  requireAuthorization = false,
  expectedSourceCommit,
  expectedSourceTree,
  expectedBaseCommit,
  expectedHeadCommit,
  expectedMergeRef,
  expectedArtifactSha256,
  expectedArtifactSize,
  expectedRunId,
  expectedJobId,
  authorizedThumbprints,
  artifactInspection,
} = {}) {
  const errors = [];
  if (!isObject(manifest)) return ['manifest must be an object.'];
  expectExactKeys(manifest, ['schema_version', 'status', 'authorization', 'version', 'source', 'artifact', 'workflow', 'compatibility', 'signature', 'smoke', 'evidence_contract'], 'manifest', errors);
  if (manifest.schema_version !== 1) errors.push('manifest.schema_version must be 1.');
  if (!['pending', 'verified', 'rejected'].includes(manifest.status)) errors.push('manifest.status is invalid.');
  if (typeof manifest.authorization !== 'boolean') errors.push('manifest.authorization must be boolean.');
  if (manifest.status === 'pending' && manifest.authorization !== false) errors.push('pending manifest cannot authorize release.');
  if (manifest.status === 'verified' && manifest.authorization !== true) errors.push('verified manifest must authorize release.');
  if (!SEMVER.test(String(manifest.version ?? ''))) errors.push('manifest.version must use the supported semver grammar.');

  if (requireKeys(manifest.source, ['commit', 'tree', 'base_commit', 'head_commit', 'merge_ref'], 'manifest.source', errors)) {
    expectExactKeys(manifest.source, ['commit', 'tree', 'base_commit', 'head_commit', 'merge_ref'], 'manifest.source', errors);
    validateIdentity(manifest.source.commit, 'manifest.source.commit', errors, { allowPending: !requireAuthorization });
    validateIdentity(manifest.source.tree, 'manifest.source.tree', errors, { allowPending: !requireAuthorization });
    validateIdentity(manifest.source.base_commit, 'manifest.source.base_commit', errors, { allowPending: !requireAuthorization });
    validateIdentity(manifest.source.head_commit, 'manifest.source.head_commit', errors, { allowPending: !requireAuthorization });
    validateIdentity(manifest.source.merge_ref, 'manifest.source.merge_ref', errors, { allowPending: !requireAuthorization });
    if (manifest.source.commit !== manifest.source.head_commit && !isPending(manifest.source.commit) && !isPending(manifest.source.head_commit)) errors.push('manifest.source.commit must equal manifest.source.head_commit.');
  }

  if (requireKeys(manifest.artifact, ['path', 'sha256', 'size_bytes', 'architecture', 'blockmap_sha256', 'blockmap_size_bytes'], 'manifest.artifact', errors)) {
    expectExactKeys(manifest.artifact, ['path', 'sha256', 'size_bytes', 'architecture', 'blockmap_sha256', 'blockmap_size_bytes'], 'manifest.artifact', errors);
    if (!RELEASE_ARTIFACT.test(String(manifest.artifact.path ?? ''))) errors.push('manifest.artifact.path must be a release NSIS EXE path.');
    if (typeof manifest.version === 'string' && !manifest.artifact.path.includes(`-${manifest.version}-`)) errors.push('manifest.artifact.path must contain the manifest version.');
    if (!(SHA256.test(String(manifest.artifact.sha256 ?? '')) || (!requireAuthorization && manifest.artifact.sha256 === 'pending'))) errors.push('manifest.artifact.sha256 is invalid.');
    if (!(Number.isSafeInteger(manifest.artifact.size_bytes) && manifest.artifact.size_bytes > 0) && !(manifest.artifact.size_bytes === 'pending' && !requireAuthorization)) errors.push('manifest.artifact.size_bytes is invalid.');
    if (manifest.artifact.architecture !== 'x64') errors.push('manifest.artifact.architecture must be x64.');
    if (!(SHA256.test(String(manifest.artifact.blockmap_sha256 ?? '')) || (!requireAuthorization && manifest.artifact.blockmap_sha256 === 'pending'))) errors.push('manifest.artifact.blockmap_sha256 is invalid.');
    if (!(Number.isSafeInteger(manifest.artifact.blockmap_size_bytes) && manifest.artifact.blockmap_size_bytes > 0) && !(manifest.artifact.blockmap_size_bytes === 'pending' && !requireAuthorization)) errors.push('manifest.artifact.blockmap_size_bytes is invalid.');
  }

  if (requireKeys(manifest.workflow, ['repository', 'workflow_name', 'event', 'run_id', 'job_id', 'check_name'], 'manifest.workflow', errors)) {
    expectExactKeys(manifest.workflow, ['repository', 'workflow_name', 'event', 'run_id', 'job_id', 'check_name'], 'manifest.workflow', errors);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(manifest.workflow.repository ?? ''))) errors.push('manifest.workflow.repository is invalid.');
    if (typeof manifest.workflow.workflow_name !== 'string' || manifest.workflow.workflow_name.trim() === '') errors.push('manifest.workflow.workflow_name is required.');
    if (manifest.workflow.event !== 'pull_request') errors.push('manifest.workflow.event must be pull_request.');
    for (const key of ['run_id', 'job_id']) {
      if (!(POSITIVE_ID.test(String(manifest.workflow[key] ?? '')) || (!requireAuthorization && isPending(manifest.workflow[key])))) errors.push(`manifest.workflow.${key} is invalid.`);
    }
    if (typeof manifest.workflow.check_name !== 'string' || manifest.workflow.check_name.trim() === '') errors.push('manifest.workflow.check_name is required.');
  }

  if (requireKeys(manifest.compatibility, ['electron', 'node_major', 'database_schema', 'config_schema'], 'manifest.compatibility', errors)) {
    expectExactKeys(manifest.compatibility, ['electron', 'node_major', 'database_schema', 'config_schema'], 'manifest.compatibility', errors);
    if (!COMPAT_VERSION.test(String(manifest.compatibility.electron ?? ''))) errors.push('manifest.compatibility.electron is invalid.');
    if (!Number.isInteger(manifest.compatibility.node_major) || manifest.compatibility.node_major < 20) errors.push('manifest.compatibility.node_major is invalid.');
    for (const key of ['database_schema', 'config_schema']) if (typeof manifest.compatibility[key] !== 'string' || manifest.compatibility[key].trim() === '') errors.push(`manifest.compatibility.${key} is required.`);
  }

  if (requireKeys(manifest.signature, ['status', 'thumbprint', 'timestamp', 'chain_status', 'artifact_sha256', 'artifact_size_bytes'], 'manifest.signature', errors)) {
    expectExactKeys(manifest.signature, ['status', 'thumbprint', 'timestamp', 'chain_status', 'artifact_sha256', 'artifact_size_bytes'], 'manifest.signature', errors);
    if (!['signed', 'NotSigned', 'unavailable'].includes(manifest.signature.status)) errors.push('manifest.signature.status is invalid.');
    const signed = manifest.signature.status === 'signed';
    if (signed && !SIGNED_THUMBPRINT.test(String(manifest.signature.thumbprint ?? ''))) errors.push('signed manifest requires an Authenticode thumbprint.');
    if (signed && !ISO_TIMESTAMP.test(String(manifest.signature.timestamp ?? ''))) errors.push('signed manifest requires an RFC3339 UTC timestamp.');
    if (manifest.signature.chain_status !== null && !SIGNATURE_CHAIN_STATUS.has(manifest.signature.chain_status)) errors.push('manifest.signature.chain_status is invalid.');
    if (signed && manifest.signature.chain_status !== 'valid') errors.push('signed manifest requires a valid Authenticode certificate chain.');
    if (signed && !SHA256.test(String(manifest.signature.artifact_sha256 ?? ''))) errors.push('signed manifest requires the inspected artifact SHA-256.');
    if (signed && (!Number.isSafeInteger(manifest.signature.artifact_size_bytes) || manifest.signature.artifact_size_bytes <= 0)) errors.push('signed manifest requires the inspected artifact size.');
    if (!signed && manifest.signature.thumbprint !== null) errors.push('unsigned manifest thumbprint must be null.');
    if (!signed && manifest.signature.timestamp !== null) errors.push('unsigned manifest timestamp must be null.');
    if (!signed && manifest.signature.chain_status !== null) errors.push('unsigned manifest certificate chain status must be null.');
    if (!signed && manifest.signature.artifact_sha256 !== null) errors.push('unsigned manifest inspected artifact SHA-256 must be null.');
    if (!signed && manifest.signature.artifact_size_bytes !== null) errors.push('unsigned manifest inspected artifact size must be null.');
  }

  if (requireKeys(manifest.smoke, ['status', 'evidence_ids', 'scenarios', 'environment'], 'manifest.smoke', errors)) {
    expectExactKeys(manifest.smoke, ['status', 'evidence_ids', 'scenarios', 'environment'], 'manifest.smoke', errors);
    if (!['passed', 'not_run', 'unavailable'].includes(manifest.smoke.status)) errors.push('manifest.smoke.status is invalid.');
    if (!Array.isArray(manifest.smoke.evidence_ids) || manifest.smoke.evidence_ids.some((value) => typeof value !== 'string' || value.trim() === '')) errors.push('manifest.smoke.evidence_ids must be a string array.');
    const requiredScenarios = ['install', 'startup', 'second_instance', 'window_close', 'tray_exit', 'uninstall', 'upgrade', 'reinstall', 'downgrade_rejected', 'database_corruption', 'migration_failure', 'disk_full', 'file_lock', 'config_corruption', 'network_offline', 'auth_failure', 'rate_limit_429', 'pagination_failure'];
    if (!Array.isArray(manifest.smoke.scenarios) || requiredScenarios.some((scenario) => !manifest.smoke.scenarios.includes(scenario))) errors.push('manifest.smoke.scenarios must include the complete release scenario set.');
    if (typeof manifest.smoke.environment !== 'string' || manifest.smoke.environment.trim() === '') errors.push('manifest.smoke.environment is required.');
  }

  if (requireKeys(manifest.evidence_contract, ['browser_desktop', 'browser_mobile', 'electron_window'], 'manifest.evidence_contract', errors)) {
    expectExactKeys(manifest.evidence_contract, ['browser_desktop', 'browser_mobile', 'electron_window'], 'manifest.evidence_contract', errors);
    if (manifest.evidence_contract.browser_desktop !== '1440x900') errors.push('browser_desktop must be 1440x900.');
    if (manifest.evidence_contract.browser_mobile !== 'Pixel 7 / 320px') errors.push('browser_mobile must be Pixel 7 / 320px.');
    if (manifest.evidence_contract.electron_window !== '980x680') errors.push('electron_window must be 980x680.');
  }

  if (manifest.authorization === true) {
    if (manifest.status !== 'verified') errors.push('authorized manifest must be verified.');
    if (manifest.signature?.status !== 'signed') errors.push('authorized manifest requires Authenticode signing.');
    if (manifest.smoke?.status !== 'passed') errors.push('authorized manifest requires passed Windows Smoke.');
    if (manifest.source?.commit && !SHA.test(manifest.source.commit)) errors.push('authorized manifest source.commit must be real.');
    if (manifest.source?.tree && !SHA.test(manifest.source.tree)) errors.push('authorized manifest source.tree must be real.');
    if (manifest.source?.base_commit && !SHA.test(manifest.source.base_commit)) errors.push('authorized manifest source.base_commit must be real.');
    if (manifest.source?.head_commit && !SHA.test(manifest.source.head_commit)) errors.push('authorized manifest source.head_commit must be real.');
    if (manifest.source?.merge_ref && !SHA.test(manifest.source.merge_ref)) errors.push('authorized manifest source.merge_ref must be real.');
    if (!POSITIVE_ID.test(String(manifest.workflow?.run_id ?? '')) || !POSITIVE_ID.test(String(manifest.workflow?.job_id ?? ''))) errors.push('authorized manifest requires real workflow run/job IDs.');
    if (manifest.signature?.chain_status !== 'valid') errors.push('authorized manifest requires a valid certificate chain.');
    if (manifest.signature?.artifact_sha256 !== manifest.artifact?.sha256) errors.push('authorized manifest signature must bind the same artifact SHA-256.');
    if (manifest.signature?.artifact_size_bytes !== manifest.artifact?.size_bytes) errors.push('authorized manifest signature must bind the same artifact size.');
    if (!Array.isArray(authorizedThumbprints) || authorizedThumbprints.length === 0) errors.push('authorized manifest requires an explicit owner certificate thumbprint allowlist.');
    else if (!authorizedThumbprints.every((value) => SIGNED_THUMBPRINT.test(String(value)))) errors.push('owner certificate thumbprint allowlist is invalid.');
    else if (!authorizedThumbprints.some((value) => String(value).toUpperCase() === String(manifest.signature?.thumbprint ?? '').toUpperCase())) errors.push('manifest signer thumbprint is not owner-authorized.');
    if (!artifactInspection || typeof artifactInspection !== 'object') errors.push('authorized manifest requires an actual Authenticode inspection result.');
    else {
      const inspectedPath = artifactInspection.path ?? artifactInspection.artifact_path;
      if (inspectedPath !== manifest.artifact?.path) errors.push('Authenticode inspection path does not match the manifest artifact.');
      if (artifactInspection.sha256 !== manifest.artifact?.sha256) errors.push('Authenticode inspection SHA-256 does not match the manifest artifact.');
      if (artifactInspection.size_bytes !== manifest.artifact?.size_bytes) errors.push('Authenticode inspection size does not match the manifest artifact.');
      const inspectedSignature = artifactInspection.signature ?? artifactInspection.authenticode ?? artifactInspection;
      for (const key of ['status', 'thumbprint', 'timestamp', 'chain_status']) {
        if (inspectedSignature?.[key] !== manifest.signature?.[key]) errors.push(`Authenticode inspection ${key} does not match the manifest signature.`);
      }
    }
  }
  const expected = [
    ['source.commit', expectedSourceCommit, manifest.source?.commit],
    ['source.tree', expectedSourceTree, manifest.source?.tree],
    ['source.base_commit', expectedBaseCommit, manifest.source?.base_commit],
    ['source.head_commit', expectedHeadCommit, manifest.source?.head_commit],
    ['source.merge_ref', expectedMergeRef, manifest.source?.merge_ref],
    ['artifact.sha256', expectedArtifactSha256, manifest.artifact?.sha256],
    ['artifact.size_bytes', expectedArtifactSize, manifest.artifact?.size_bytes],
    ['workflow.run_id', expectedRunId, manifest.workflow?.run_id],
    ['workflow.job_id', expectedJobId, manifest.workflow?.job_id],
  ];
  for (const [label, expectedValue, actualValue] of expected) {
    if (expectedValue !== undefined && String(actualValue) !== String(expectedValue)) errors.push(`manifest ${label} does not match the exact expected value.`);
  }
  if (requireAuthorization) {
    for (const [label, expectedValue] of [
      ['source.commit', expectedSourceCommit],
      ['source.tree', expectedSourceTree],
      ['source.base_commit', expectedBaseCommit],
      ['source.head_commit', expectedHeadCommit],
      ['source.merge_ref', expectedMergeRef],
      ['artifact.sha256', expectedArtifactSha256],
      ['artifact.size_bytes', expectedArtifactSize],
      ['workflow.run_id', expectedRunId],
      ['workflow.job_id', expectedJobId],
    ]) {
      if (expectedValue === undefined || expectedValue === null || expectedValue === '') errors.push(`authorized manifest requires trusted expected ${label}.`);
    }
  }
  return errors;
}

export function releaseManifestAuthorization(manifest, options = {}) {
  const errors = releaseManifestErrors(manifest, { ...options, requireAuthorization: true });
  errors.push(...releaseManifestArtifactErrors(manifest, { repoRoot: options.repoRoot }));
  return errors.length === 0;
}

export function readReleaseManifest(repoRoot, relativePath = 'docs/release-manifest.json') {
  const path = resolve(repoRoot, relativePath);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

function sha512Base64File(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

function isWithinRoot(root, target) {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const relativeTarget = relative(normalizedRoot, normalizedTarget);
  return relativeTarget === '' || (!relativeTarget.startsWith('..') && !isAbsolute(relativeTarget));
}

export function releaseManifestArtifactErrors(manifest, { repoRoot } = {}) {
  const errors = [];
  if (!isObject(manifest) || !isObject(manifest.artifact)) return ['manifest.artifact is required for artifact verification.'];
  const root = resolve(repoRoot ?? process.cwd());
  const artifactPath = resolve(root, String(manifest.artifact.path ?? ''));
  if (!isWithinRoot(root, artifactPath)) return ['manifest.artifact.path escapes the repository root.'];
  let artifactStat;
  try {
    artifactStat = statSync(artifactPath);
  } catch {
    errors.push('manifest.artifact.path does not exist.');
    return errors;
  }
  if (!artifactStat.isFile()) errors.push('manifest.artifact.path must be a regular file.');
  if (errors.length > 0) return errors;
  const actualSha256 = sha256File(artifactPath);
  if (actualSha256 !== String(manifest.artifact.sha256 ?? '').toUpperCase()) errors.push('manifest.artifact.sha256 does not match the tracked artifact.');
  if (artifactStat.size !== manifest.artifact.size_bytes) errors.push('manifest.artifact.size_bytes does not match the tracked artifact.');

  const blockmapPath = `${artifactPath}.blockmap`;
  try {
    const blockmapStat = statSync(blockmapPath);
    if (!blockmapStat.isFile()) errors.push('manifest artifact blockmap must be a regular file.');
    else {
      if (sha256File(blockmapPath) !== String(manifest.artifact.blockmap_sha256 ?? '').toUpperCase()) errors.push('manifest.artifact.blockmap_sha256 does not match the tracked blockmap.');
      if (blockmapStat.size !== manifest.artifact.blockmap_size_bytes) errors.push('manifest.artifact.blockmap_size_bytes does not match the tracked blockmap.');
    }
  } catch {
    errors.push('manifest artifact blockmap does not exist.');
  }

  const latestYmlPath = resolve(root, 'release', 'latest.yml');
  try {
    const latestYml = readFileSync(latestYmlPath, 'utf8');
    const expectedSha512 = sha512Base64File(artifactPath);
    const latestLines = latestYml.split(/\r?\n/u).map((line) => line.trim());
    if (!latestLines.includes(`version: ${manifest.version}`)) errors.push('release/latest.yml version does not match the manifest.');
    if (!latestLines.includes(`size: ${manifest.artifact.size_bytes}`)) errors.push('release/latest.yml size does not match the manifest artifact.');
    if (!latestLines.includes(`sha512: ${expectedSha512}`)) errors.push('release/latest.yml sha512 does not match the tracked artifact.');
  } catch {
    errors.push('release/latest.yml does not exist.');
  }
  return errors;
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const manifestIndex = process.argv.indexOf('--manifest');
  const relativePath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : 'docs/release-manifest.json';
  const requireAuthorization = process.argv.includes('--require-authorized');
  const verifyArtifact = process.argv.includes('--verify-artifact');
  try {
    const manifest = readReleaseManifest(resolve(dirname(fileURLToPath(import.meta.url)), '..'), relativePath);
    const errors = [
      ...releaseManifestErrors(manifest, { requireAuthorization }),
      ...(verifyArtifact ? releaseManifestArtifactErrors(manifest, { repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..') }) : []),
    ];
    if (errors.length > 0) {
      process.stderr.write(`release manifest rejected (${errors.length} errors).\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`RELEASE_MANIFEST:${JSON.stringify({ status: manifest.status, authorization: manifest.authorization, version: manifest.version })}\n`);
    }
  } catch {
    process.stderr.write('release manifest unavailable.\n');
    process.exitCode = 1;
  }
}
