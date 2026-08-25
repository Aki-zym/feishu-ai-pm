import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/i;
const PENDING = /^pending_[a-z0-9._-]+$/i;
const SEMVER = /^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, keys, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed.`);
  for (const key of keys) if (!hasOwn(value, key)) errors.push(`${path}.${key} is required.`);
}

function identity(value, path, errors) {
  if (!SHA.test(String(value ?? '')) && !PENDING.test(String(value ?? ''))) errors.push(`${path} must be a full SHA or controlled pending identity.`);
}

export function releaseManifestErrors(manifest) {
  const errors = [];
  if (!isObject(manifest)) return ['manifest must be an object.'];
  exactKeys(manifest, ['schema_version', 'status', 'authorization', 'version', 'source', 'workflow', 'runtime', 'evidence_contract'], 'manifest', errors);
  if (manifest.schema_version !== 2) errors.push('manifest.schema_version must be 2.');
  if (!['current', 'pending', 'deprecated'].includes(manifest.status)) errors.push('manifest.status is invalid.');
  if (typeof manifest.authorization !== 'boolean') errors.push('manifest.authorization must be boolean.');
  if (manifest.authorization === true) errors.push('current runtime manifest cannot authorize a distributable artifact.');
  if (!SEMVER.test(String(manifest.version ?? ''))) errors.push('manifest.version must use the supported semver grammar.');

  exactKeys(manifest.source, ['commit', 'tree', 'base_commit', 'head_commit', 'merge_ref'], 'manifest.source', errors);
  if (isObject(manifest.source)) for (const key of ['commit', 'tree', 'base_commit', 'head_commit', 'merge_ref']) identity(manifest.source[key], `manifest.source.${key}`, errors);

  exactKeys(manifest.workflow, ['repository', 'workflow_name', 'event', 'run_id', 'job_id', 'check_name'], 'manifest.workflow', errors);
  if (isObject(manifest.workflow)) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(manifest.workflow.repository ?? ''))) errors.push('manifest.workflow.repository is invalid.');
    if (typeof manifest.workflow.workflow_name !== 'string' || !manifest.workflow.workflow_name.trim()) errors.push('manifest.workflow.workflow_name is required.');
    if (manifest.workflow.event !== 'pull_request' && manifest.workflow.event !== 'push') errors.push('manifest.workflow.event is invalid.');
    for (const key of ['run_id', 'job_id']) if (!PENDING.test(String(manifest.workflow[key] ?? '')) && !/^[1-9][0-9]*$/.test(String(manifest.workflow[key] ?? ''))) errors.push(`manifest.workflow.${key} is invalid.`);
    if (typeof manifest.workflow.check_name !== 'string' || !manifest.workflow.check_name.trim()) errors.push('manifest.workflow.check_name is required.');
  }

  exactKeys(manifest.runtime, ['host', 'port', 'database', 'server', 'web', 'plugin'], 'manifest.runtime', errors);
  if (isObject(manifest.runtime)) {
    if (manifest.runtime.host !== '127.0.0.1') errors.push('manifest.runtime.host must be 127.0.0.1.');
    if (manifest.runtime.port !== 4310) errors.push('manifest.runtime.port must be 4310.');
    for (const key of ['database', 'server', 'web', 'plugin']) if (typeof manifest.runtime[key] !== 'string' || !manifest.runtime[key].trim()) errors.push(`manifest.runtime.${key} is required.`);
  }

  exactKeys(manifest.evidence_contract, ['plugin_tests', 'server_tests', 'web_tests', 'typecheck'], 'manifest.evidence_contract', errors);
  if (isObject(manifest.evidence_contract)) for (const key of ['plugin_tests', 'server_tests', 'web_tests', 'typecheck']) if (typeof manifest.evidence_contract[key] !== 'string' || !manifest.evidence_contract[key].trim()) errors.push(`manifest.evidence_contract.${key} is required.`);
  return errors;
}

export function releaseManifestAuthorization(manifest) {
  return releaseManifestErrors(manifest).length === 0 && manifest.status === 'current' && manifest.authorization === false;
}

export function releaseManifestArtifactErrors(manifest) {
  return releaseManifestErrors(manifest);
}

export function readReleaseManifest(repoRoot, relativePath = 'docs/release-manifest.json') {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf8'));
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const manifestIndex = process.argv.indexOf('--manifest');
  const relativePath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : 'docs/release-manifest.json';
  try {
    const manifest = readReleaseManifest(resolve(dirname(fileURLToPath(import.meta.url)), '..'), relativePath);
    const errors = releaseManifestErrors(manifest);
    if (errors.length) {
      process.stderr.write(`runtime manifest rejected (${errors.length} errors).\n`);
      for (const error of errors) process.stderr.write(`- ${error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`RUNTIME_MANIFEST:${JSON.stringify({ status: manifest.status, version: manifest.version, host: manifest.runtime.host, port: manifest.runtime.port })}\n`);
    }
  } catch {
    process.stderr.write('runtime manifest unavailable.\n');
    process.exitCode = 1;
  }
}
