import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { link, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLocalExactArgs, verifyLocalExactInputs } from './ci-plan.mjs';
import { selectCiPlan } from './ci-selection-policy.mjs';

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const RUN_ID = /^local-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const GENERATION = /^[0-9]{17}-[0-9a-f]{8}$/;
const RECOVERY_EPOCH = /^recovery-[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_ID = /^orca-[1-9][0-9]{0,9}-[0-9a-f]{8}$/i;
const RECLAIMER_ID = /^reclaimer-[1-9][0-9]{0,9}-[0-9a-f]{8}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_LOG_BYTES = 128 * 1024;
const SENSITIVE = /\b(?:password|passwd|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|cookie|authorization|bearer|api[_-]?key|canary)\b\s*[:=]\s*[^\s,;]+/gi;
const URL_USERINFO = /\bhttps?:\/\/[^\s/@]+(?::[^\s/@]*)?@/gi;
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/][^\s"'<>|]*)/g;
const UNC_PATH = /(?:\\\\[^\\\s]+\\[^\s"'<>|]*)/g;
const POSIX_PATH = /(?:^|[\s"'(=])\/(?!\/)[^\s"')]+/gm;
const FORBIDDEN_POSIX_PATH = /(?:^|[\s"'(=])\/(?!\/)[^\s"')]+/m;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const REDACTION_CARRY_CHARS = 2048;

const ROOT_KEYS = new Set(['schemaVersion', 'kind', 'mode', 'runId', 'generation', 'startedAt', 'finishedAt', 'provenance', 'finalProvenance', 'changedPaths', 'plan', 'commands', 'results', 'environment', 'artifacts', 'candidateFingerprint', 'publication', 'payloadDigest']);
const PROVENANCE_KEYS = new Set(['baseCommit', 'headCommit', 'mergeRef', 'tree', 'parents', 'checkedOutHead', 'worktreeClean']);
const PLAN_KEYS = new Set(['schemaVersion', 'mode', 'categories', 'minimumLevel', 'requiredEvidence', 'highRisk', 'manualReviewRequired', 'claimAuthorized', 'files', 'reason', 'gates']);
const GATE_KEYS = new Set(['docs', 'check', 'lifecycle', 'e2e']);
const COMMAND_KEYS = new Set(['id', 'command', 'cwd', 'startedAt', 'finishedAt', 'exitCode', 'status', 'skipReason', 'requiresTests', 'observedBytes', 'truncated', 'counts', 'log', 'artifacts', 'missingArtifacts', 'requiresEvidence']);
const TEST_COUNTS_KEYS = new Set(['total', 'passed', 'failed', 'skipped']);
const RESULT_KEYS = new Set(['passed', 'failed', 'skipped', 'zeroTest']);
const LOG_KEYS = new Set(['path', 'sha256', 'bytes']);
const ARTIFACT_KEYS = new Set(['path', 'sha256', 'sizeBytes']);
const ENVIRONMENT_KEYS = new Set(['os', 'arch', 'node', 'npm', 'git', 'runner', 'realProvider', 'productionData']);
const PUBLICATION_KEYS = new Set(['generation', 'evidencePath', 'pointerPath', 'currentPointerDirectory', 'rootSlotPath', 'previousGeneration', 'candidateFingerprint', 'payloadDigest']);
const RECOVERY_MANIFEST_KEYS = new Set(['schemaVersion', 'kind', 'epoch', 'sourceDirectory', 'sourceDigest', 'createdAt', 'snapshots']);
const RECOVERY_SNAPSHOT_KEYS = new Set(['name', 'sourcePath', 'snapshotPath', 'sha256', 'sizeBytes', 'sourceMetadata', 'snapshotMetadata']);
const RECOVERY_METADATA_KEYS = new Set(['isFile', 'mode', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'dev', 'ino']);
const LEASE_KEYS = new Set(['ownerId', 'token', 'pid', 'acquiredAt', 'heartbeatAt', 'expiresAt', 'generation', 'runId']);
const LEASE_STATE_KEYS = new Set(['schemaVersion', 'kind', 'status', 'ownerId', 'token', 'pid', 'generation', 'runId', 'at']);
const LEASE_REF_KEYS = new Set(['schemaVersion', 'kind', 'status', 'ownerId', 'token', 'pid', 'generation', 'runId', 'identityPath', 'previousGeneration', 'publishedAt']);
const RECLAIM_GUARD_KEYS = new Set(['schemaVersion', 'kind', 'reclaimerId', 'token', 'pid', 'acquiredAt', 'expiresAt', 'generation', 'runId', 'targetToken']);
const POINTER_KEYS = new Set(['schemaVersion', 'kind', 'generation', 'runId', 'evidencePath', 'rootSlotPath', 'previousGeneration', 'candidateFingerprint', 'payloadDigest', 'baseCommit', 'headCommit', 'mergeRef', 'tree']);
const HEARTBEAT_KEYS = new Set(['ownerId', 'token', 'pid', 'generation', 'runId', 'heartbeatAt', 'expiresAt']);
const LEASE_TTL_MS = 30_000;
const RECLAIM_TTL_MS = 5_000;

const publicationInjectionHooks = {
  beforeCandidatePublish: null,
  beforeQuarantineSnapshotLink: null,
  beforeQuarantineFinalCompare: null,
  afterQuarantineManifest: null,
  beforeReleaseFinalCompare: null,
  beforeReleaseStatePublish: null,
  beforeReclaimStatePublish: null,
  beforeLeaseRefPublish: null,
  beforePointerPublish: null,
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const digestObject = (value) => sha256(Buffer.from(JSON.stringify(canonical(value)), 'utf8'));

function unknownKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function addUnknownKeys(add, value, allowed, label) {
  for (const key of unknownKeys(value, allowed)) add(`${label} contains unknown field ${key}`);
}

function exactChangedPaths(repo, base, merge) {
  const output = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, merge], { cwd: repo, encoding: 'utf8' });
  return [...new Set(output.split('\0').filter(Boolean).map((file) => normalizeRepoPath(repo, file)))].sort();
}

function generationId(date = new Date(), previousGeneration = null) {
  const nowStamp = date.toISOString().replace(/\D/g, '').slice(0, 17);
  const previousStamp = GENERATION.exec(previousGeneration ?? '')?.[0]?.slice(0, 17);
  const stamp = previousStamp && previousStamp >= nowStamp
    ? (BigInt(previousStamp) + 1n).toString().padStart(17, '0')
    : nowStamp;
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

async function invokePublicationHook(name, context) {
  const hook = publicationInjectionHooks[name];
  if (typeof hook === 'function') await hook(context);
}

export function setPublicationInjectionHooks(hooks = {}) {
  for (const name of Object.keys(publicationInjectionHooks)) publicationInjectionHooks[name] = typeof hooks[name] === 'function' ? hooks[name] : null;
}

async function writeDurableFile(path, data, { replace = false, role = 'generic' } = {}) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // No destination deletion or overwrite is allowed here. Immutable
    // generations, leases, guards and pointers are published with an
    // fsync/close followed by atomic no-replace hard-link creation.
    if (replace) throw new Error('durable file replacement is disabled; use an inactive slot or immutable generation');
    await invokePublicationHook('beforeCandidatePublish', { path, role, data });
    // Hard-link publication is atomic and no-replace on NTFS and POSIX. It
    // also keeps a crash from exposing a partially written destination.
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncFile(path) {
  const handle = await open(path, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function fileSnapshot(path) {
  const bytes = await readFile(path);
  const metadata = await stat(path);
  const statIdentity = (value) => Number.isSafeInteger(value) ? value : String(value);
  return {
    bytes,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    metadata: {
      isFile: metadata.isFile(),
      mode: statIdentity(metadata.mode),
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
      birthtimeMs: metadata.birthtimeMs,
      dev: statIdentity(metadata.dev),
      ino: statIdentity(metadata.ino),
    },
  };
}

function fileIdentityMetadata(metadata) {
  return metadata && ({ isFile: metadata.isFile, dev: metadata.dev, ino: metadata.ino, birthtimeMs: metadata.birthtimeMs });
}

function sameFileIdentity(left, right) {
  const leftMetadata = left?.metadata ?? left?.sourceMetadata;
  return Boolean(left && right)
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes
    && JSON.stringify(canonical(fileIdentityMetadata(leftMetadata))) === JSON.stringify(canonical(fileIdentityMetadata(right.metadata)));
}

async function readJsonSnapshot(path) {
  const snapshot = await fileSnapshot(path);
  let value;
  try { value = JSON.parse(snapshot.bytes.toString('utf8')); } catch { throw new Error('publication candidate is empty, partial, or malformed'); }
  return { ...snapshot, value };
}

function leaseIdentityEqual(left, right) {
  return Boolean(left && right)
    && left.ownerId === right.ownerId
    && left.token === right.token
    && left.pid === right.pid
    && left.generation === right.generation
    && left.runId === right.runId;
}

function canonicalUtc(value) {
  return typeof value === 'string' && UTC.test(value) && new Date(value).toISOString() === value;
}

function validateLeaseIdentity(value, label = 'publication lease') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || unknownKeys(value, LEASE_KEYS).length > 0) throw new Error(`${label} contains unknown or malformed fields`);
  if (!OWNER_ID.test(value.ownerId ?? '') || !TOKEN.test(value.token ?? '') || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !GENERATION.test(value.generation ?? '') || !RUN_ID.test(value.runId ?? '')) throw new Error(`${label} identity is invalid`);
  if (![value.acquiredAt, value.heartbeatAt, value.expiresAt].every(canonicalUtc)) throw new Error(`${label} timestamps are invalid`);
  const acquired = Date.parse(value.acquiredAt);
  const heartbeat = Date.parse(value.heartbeatAt);
  const expires = Date.parse(value.expiresAt);
  if (!(acquired <= heartbeat && heartbeat < expires)) throw new Error(`${label} timestamp order is invalid`);
  return value;
}

function validateLeaseState(value, label = 'publication lease state') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || unknownKeys(value, LEASE_STATE_KEYS).length > 0) throw new Error(`${label} contains unknown fields`);
  if (value.schemaVersion !== 1 || value.kind !== 'publication_lease_state' || !['released', 'reclaimed'].includes(value.status)) throw new Error(`${label} status is invalid`);
  if (!OWNER_ID.test(value.ownerId ?? '') || !TOKEN.test(value.token ?? '') || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !GENERATION.test(value.generation ?? '') || !RUN_ID.test(value.runId ?? '') || !canonicalUtc(value.at)) throw new Error(`${label} identity is invalid`);
  return value;
}

function leaseIdentityPathMatches(leasePath, value) {
  const normalized = leasePath.replaceAll('\\', '/');
  return normalized.endsWith(`/leases/${value.generation}-${value.token}/lease.json`);
}

function validateLeaseRef(value, label = 'publication lease reference', leaseDirectory = 'ci-artifacts/local-verification/leases') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || unknownKeys(value, LEASE_REF_KEYS).length > 0) throw new Error(`${label} contains unknown fields`);
  if (value.schemaVersion !== 1 || value.kind !== 'publication_lease_ref' || value.status !== 'active') throw new Error(`${label} status is invalid`);
  if (!OWNER_ID.test(value.ownerId ?? '') || !TOKEN.test(value.token ?? '') || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !GENERATION.test(value.generation ?? '') || !RUN_ID.test(value.runId ?? '') || !canonicalUtc(value.publishedAt)) throw new Error(`${label} identity is invalid`);
  if (value.previousGeneration !== null && !GENERATION.test(value.previousGeneration ?? '')) throw new Error(`${label} previousGeneration is invalid`);
  if (typeof value.identityPath !== 'string' || value.identityPath !== `${leaseDirectory}/${value.generation}-${value.token}/lease.json`) throw new Error(`${label} identity path is not canonical`);
  return value;
}

function validateReclaimGuardIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || unknownKeys(value, RECLAIM_GUARD_KEYS).length > 0) throw new Error('publication lease reclaim guard contains unknown fields');
  if (value.schemaVersion !== 1 || value.kind !== 'publication_reclaim_guard' || !RECLAIMER_ID.test(value.reclaimerId ?? '') || !TOKEN.test(value.token ?? '') || !TOKEN.test(value.targetToken ?? '') || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !GENERATION.test(value.generation ?? '') || !RUN_ID.test(value.runId ?? '') || !canonicalUtc(value.acquiredAt) || !canonicalUtc(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt)) throw new Error('publication lease reclaim guard identity is invalid');
  return value;
}

function leaseStoreFor(output) {
  const base = dirname(output).replaceAll('\\', '/');
  return {
    leases: `${base}/local-verification/leases`,
    refs: `${base}/local-verification/lease-refs`,
    guards: `${base}/local-verification/reclaim-guards`,
  };
}

function leaseDirectoryFor(output, generation, token) {
  return `${leaseStoreFor(output).leases}/${generation}-${token}`;
}

function leaseRefPathFor(output, generation) {
  return `${leaseStoreFor(output).refs}/${generation}.json`;
}

function reclaimGuardPathFor(output, generation, targetToken, reclaimerToken) {
  return `${leaseStoreFor(output).guards}/${generation}-${targetToken}-${reclaimerToken}/guard.json`;
}

async function readLeaseState(leaseDirectory) {
  let names;
  try { names = await readdir(`${leaseDirectory}/state`); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const states = names.filter((name) => name.endsWith('.json')).sort();
  if (states.length > 1) throw new Error('publication lease has conflicting terminal states');
  if (states.length === 0) return null;
  let value;
  try { value = JSON.parse(await readFile(`${leaseDirectory}/state/${states[0]}`, 'utf8')); } catch { throw new Error('publication lease state is empty, partial, or malformed'); }
  validateLeaseState(value);
  if (states[0] !== `${value.status}.json`) throw new Error('publication lease state filename is not canonical');
  return value;
}

async function readLeaseFile(leasePath) {
  let value;
  try { value = JSON.parse(await readFile(leasePath, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('publication lease is empty, partial, or malformed');
  }
  validateLeaseIdentity(value);
  if (!leaseIdentityPathMatches(leasePath, value)) throw new Error('publication lease identity path is not canonical');
  const leaseDirectory = dirname(leasePath).replaceAll('\\', '/');
  const state = await readLeaseState(leaseDirectory);
  if (state && !leaseIdentityEqual(state, value)) throw new Error('publication lease state identity changed');
  let names = [];
  try { names = await readdir(`${leaseDirectory}/heartbeats`); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  let effective = { ...value };
  const baseHeartbeat = Date.parse(value.heartbeatAt);
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    if (!new RegExp(`^${value.token}-[0-9]{16}-[0-9a-f]{8}\\.json$`, 'i').test(name)) throw new Error('publication heartbeat filename is not bound to its identity');
    let pulse;
    try { pulse = JSON.parse(await readFile(`${leaseDirectory}/heartbeats/${name}`, 'utf8')); } catch { throw new Error('publication heartbeat is empty, partial, or malformed'); }
    if (!pulse || typeof pulse !== 'object' || Array.isArray(pulse) || unknownKeys(pulse, HEARTBEAT_KEYS).length > 0 || !OWNER_ID.test(pulse.ownerId ?? '') || !TOKEN.test(pulse.token ?? '') || !Number.isSafeInteger(pulse.pid) || pulse.pid <= 0 || !GENERATION.test(pulse.generation ?? '') || !RUN_ID.test(pulse.runId ?? '') || !canonicalUtc(pulse.heartbeatAt) || !canonicalUtc(pulse.expiresAt)) throw new Error('publication heartbeat identity is invalid');
    if (!leaseIdentityEqual(pulse, value) || Date.parse(pulse.heartbeatAt) < baseHeartbeat || Date.parse(pulse.expiresAt) <= Date.parse(pulse.heartbeatAt)) throw new Error('publication heartbeat identity or timestamp changed');
    if (Date.parse(pulse.heartbeatAt) >= Date.parse(effective.heartbeatAt)) effective = { ...effective, heartbeatAt: pulse.heartbeatAt, expiresAt: pulse.expiresAt };
  }
  validateLeaseIdentity(effective);
  return { ...effective, leasePath, state: state?.status ?? 'active' };
}

function leaseExpired(lease, now = Date.now()) {
  try {
    const identity = Object.fromEntries([...LEASE_KEYS].map((key) => [key, lease?.[key]]));
    validateLeaseIdentity(identity);
    if (now < Date.parse(identity.heartbeatAt)) return false;
    return Date.parse(identity.expiresAt) <= now;
  } catch { return false; }
}

async function publishLeaseState(lease, status, hookName) {
  const directory = dirname(lease.leasePath).replaceAll('\\', '/');
  const statePath = `${directory}/state/${status}.json`;
  await mkdir(dirname(statePath), { recursive: true });
  const state = { schemaVersion: 1, kind: 'publication_lease_state', status, ownerId: lease.ownerId, token: lease.token, pid: lease.pid, generation: lease.generation, runId: lease.runId, at: new Date().toISOString() };
  await invokePublicationHook(hookName, { lease, statePath, state });
  try { await writeDurableFile(statePath, `${JSON.stringify(state)}\n`, { role: `lease-${status}` }); return true; } catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
}

async function refreshPublicationLease(lease, now = Date.now()) {
  const current = await readLeaseFile(lease.leasePath);
  if (!leaseIdentityEqual(current, lease) || current.state !== 'active') throw new Error('publication lease identity is stale before heartbeat');
  const previousHeartbeat = Date.parse(current.heartbeatAt);
  if (!Number.isFinite(previousHeartbeat) || now < previousHeartbeat) throw new Error('publication lease clock moved backwards');
  if (leaseExpired(current, now)) throw new Error('publication lease expired before heartbeat');
  const heartbeatAt = new Date(now).toISOString();
  const expiresAt = new Date(now + LEASE_TTL_MS).toISOString();
  const pulse = { ownerId: current.ownerId, token: current.token, pid: current.pid, generation: current.generation, runId: current.runId, heartbeatAt, expiresAt };
  const heartbeatDirectory = `${dirname(lease.leasePath).replaceAll('\\', '/')}/heartbeats`;
  await mkdir(heartbeatDirectory, { recursive: true });
  const pulsePath = `${heartbeatDirectory}/${lease.token}-${String(now).padStart(16, '0')}-${randomUUID().slice(0, 8)}.json`;
  await writeDurableFile(pulsePath, `${JSON.stringify(pulse)}\n`, { role: 'lease-heartbeat' });
  return { ...lease, heartbeatAt, expiresAt };
}

async function reclaimStaleLease(leasePath, stale, output = null) {
  validateLeaseIdentity(stale);
  const normalizedLeasePath = leasePath.replaceAll('\\', '/');
  const match = normalizedLeasePath.match(/^(.*\/local-verification)\/leases\/([0-9]{17}-[0-9a-f]{8})-([0-9a-f-]{36})\/lease\.json$/i);
  if (!match || match[3] !== stale.token) throw new Error('publication lease identity path is not canonical');
  const leaseDirectory = match[1];
  const publicationOutput = output ?? `${match[1].replace(/\/local-verification$/, '')}/local-verification.json`;
  const current = await readLeaseFile(leasePath);
  if (!leaseIdentityEqual(current, stale) || current.state !== 'active' || !leaseExpired(current)) return false;
  const reclaimerToken = randomUUID();
  const guardIdentity = { schemaVersion: 1, kind: 'publication_reclaim_guard', reclaimerId: `reclaimer-${process.pid}-${randomUUID().slice(0, 8)}`, token: reclaimerToken, pid: process.pid, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + RECLAIM_TTL_MS).toISOString(), generation: stale.generation, runId: stale.runId, targetToken: stale.token };
  validateReclaimGuardIdentity(guardIdentity);
  const guardPath = resolve(dirname(leasePath), '..', '..', 'reclaim-guards', `${stale.generation}-${stale.token}-${reclaimerToken}`, 'guard.json');
  await mkdir(dirname(guardPath), { recursive: true });
  await writeDurableFile(guardPath, `${JSON.stringify(guardIdentity)}\n`, { role: 'reclaim-guard' });
  const afterGuard = await readLeaseFile(leasePath);
  if (!leaseIdentityEqual(afterGuard, stale) || afterGuard.state !== 'active' || !leaseExpired(afterGuard)) return false;
  const reclaimed = await publishLeaseState({ ...stale, leasePath }, 'reclaimed', 'beforeReclaimStatePublish');
  return reclaimed;
}

async function acquirePublicationLease(repo, output, runId, generation, leaseOutput = output) {
  if (!RUN_ID.test(runId ?? '') || !GENERATION.test(generation ?? '')) throw new Error('publication lease run/generation is invalid');
  const outputPath = normalizeRepoPath(repo, output);
  const leaseOutputPath = normalizeRepoPath(repo, leaseOutput);
  const legacyPath = resolve(repo, `${leaseOutputPath}.lock`);
  try { await stat(legacyPath); throw new Error('legacy shared publication lease exists; explicit recovery is required'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const stores = leaseStoreFor(leaseOutputPath);
  await mkdir(resolve(repo, stores.leases), { recursive: true });
  await mkdir(resolve(repo, stores.refs), { recursive: true });
  const refs = await readLeaseReferences(repo, leaseOutputPath);
  const previous = refs.at(-1) ?? null;
  if (previous?.generation && generation <= previous.generation) throw new Error('publication lease generation is not newer than current reference');
  if (previous?.lease?.state === 'active' && !leaseExpired(previous.lease)) throw new Error('publication lease is held by an active owner');
  if (previous?.lease?.state === 'active' && leaseExpired(previous.lease)) await reclaimStaleLease(previous.lease.leasePath, previous.lease, leaseOutputPath);
  const token = randomUUID();
  const identity = { ownerId: `orca-${process.pid}-${randomUUID().slice(0, 8)}`, token, pid: process.pid, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(), generation, runId };
  const leaseDirectory = resolve(repo, leaseDirectoryFor(leaseOutputPath, generation, token));
  const leasePath = `${leaseDirectory.replaceAll('\\', '/')}/lease.json`;
  await mkdir(resolve(leaseDirectory, 'heartbeats'), { recursive: true });
  await writeDurableFile(leasePath, `${JSON.stringify(identity)}\n`, { role: 'lease-identity' });
  const liveRefs = await readLeaseReferences(repo, leaseOutputPath);
  if ((liveRefs.at(-1)?.generation ?? null) !== (previous?.generation ?? null)) throw new Error('publication lease current reference changed before CAS');
  const ref = { schemaVersion: 1, kind: 'publication_lease_ref', status: 'active', ownerId: identity.ownerId, token, pid: identity.pid, generation, runId, identityPath: leasePath.replaceAll('\\', '/').replace(`${resolve(repo).replaceAll('\\', '/')}/`, ''), previousGeneration: previous?.generation ?? null, publishedAt: new Date().toISOString() };
  validateLeaseRef(ref, 'publication lease reference', stores.leases.replaceAll('\\', '/'));
  const refPath = resolve(repo, leaseRefPathFor(leaseOutputPath, generation));
  await invokePublicationHook('beforeLeaseRefPublish', { refPath, ref, previousGeneration: previous?.generation ?? null, lease: identity });
  await writeDurableFile(refPath, `${JSON.stringify(ref)}\n`, { role: 'lease-reference' });
  return { ...identity, leasePath, leaseRefPath: refPath, leaseDirectory, previousLeaseGeneration: previous?.generation ?? null };
}

async function releasePublicationLease(lease) {
  if (!lease) return false;
  const current = await readLeaseFile(lease.leasePath);
  if (!current || !leaseIdentityEqual(current, lease) || current.state !== 'active') return false;
  await invokePublicationHook('beforeReleaseFinalCompare', { lease, identityPath: lease.leasePath });
  const final = await readLeaseFile(lease.leasePath);
  if (!final || !leaseIdentityEqual(final, lease) || final.state !== 'active') return false;
  return publishLeaseState(lease, 'released', 'beforeReleaseStatePublish');
}

async function readLeaseReferences(repo, output) {
  const refsDirectory = resolve(repo, leaseStoreFor(output).refs);
  const leaseDirectory = leaseStoreFor(output).leases.replaceAll('\\', '/');
  let names;
  try { names = await readdir(refsDirectory); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const refs = [];
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    let ref;
    try { ref = JSON.parse(await readFile(resolve(refsDirectory, name), 'utf8')); } catch { throw new Error('publication lease reference is empty, partial, or malformed'); }
    validateLeaseRef(ref, 'publication lease reference', leaseDirectory);
    if (name !== `${ref.generation}.json`) throw new Error('publication lease reference filename is not canonical');
    const identity = await readLeaseFile(resolve(repo, ref.identityPath));
    if (!identity || !leaseIdentityEqual(identity, ref)) throw new Error('publication lease reference identity is not bound');
    refs.push({ ref, lease: identity, refPath: resolve(refsDirectory, name) });
  }
  refs.sort((left, right) => left.ref.generation.localeCompare(right.ref.generation));
  for (let index = 0; index < refs.length; index += 1) {
    const expectedPrevious = index === 0 ? null : refs[index - 1].ref.generation;
    if (refs[index].ref.previousGeneration !== expectedPrevious) throw new Error('publication lease reference generation chain is invalid');
  }
  return refs;
}

function pointerDirectoryPath(outputPath) {
  return `${dirname(outputPath).replaceAll('\\', '/')}/local-verification/pointers`;
}

function rootSlotPathFor(outputPath, generation) {
  return `${dirname(outputPath).replaceAll('\\', '/')}/local-verification/root-slots/${generation}.json`;
}

function historicalGitProvenance(repo, provenance) {
  const requireSha = (value, label) => {
    if (!SHA.test(value ?? '')) throw new Error(`${label} is not a full commit SHA`);
    execFileSync('git', ['cat-file', '-e', `${value}^{commit}`], { cwd: repo, stdio: 'ignore' });
    return value;
  };
  const base = requireSha(provenance.baseCommit, 'base');
  const head = requireSha(provenance.headCommit, 'head');
  const merge = requireSha(provenance.mergeRef, 'merge');
  const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', merge], { cwd: repo, encoding: 'utf8' }).trim().split(/\s+/).slice(1);
  if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) throw new Error('historical merge parents are not [base, head]');
  const tree = execFileSync('git', ['show', '-s', '--format=%T', merge], { cwd: repo, encoding: 'utf8' }).trim();
  if (!SHA.test(tree) || tree !== provenance.tree) throw new Error('historical merge tree does not match provenance');
  const virtualTree = execFileSync('git', ['merge-tree', '--write-tree', base, head], { cwd: repo, encoding: 'utf8' }).trim();
  if (virtualTree !== tree) throw new Error('historical merge tree is not the conflict-free virtual merge tree');
  return { baseCommit: base, headCommit: head, mergeRef: merge, tree, parents };
}

async function hasGenerationHistory(repo) {
  const historyPath = resolve(repo, 'ci-artifacts/local-verification/generations');
  let entries;
  try { entries = await readdir(historyPath, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  return entries.some((entry) => entry.isDirectory() && GENERATION.test(entry.name));
}

function recoveryManifestPath(directoryPath, epoch) {
  return `${directoryPath}/recovery/${epoch}/manifest.json`;
}

function recoveryEpochDirectory(directoryPath, epoch) {
  return `${directoryPath}/epochs/${epoch}`;
}

function recoverySourceDigest(sourceDirectory, snapshots) {
  return digestObject({
    sourceDirectory,
    snapshots: snapshots.map((snapshot) => ({
      name: snapshot.name,
      sourcePath: snapshot.sourcePath,
      sha256: snapshot.sha256,
      sizeBytes: snapshot.sizeBytes,
      sourceMetadata: fileIdentityMetadata(snapshot.sourceMetadata),
    })),
  });
}

function validateRecoveryMetadata(metadata, label) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).some((key) => !RECOVERY_METADATA_KEYS.has(key))) throw new Error(`${label} metadata is malformed`);
  const validStatIdentity = (value) => (Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && /^\d+$/.test(value));
  if (metadata.isFile !== true || !validStatIdentity(metadata.mode) || !Number.isFinite(metadata.mtimeMs) || !Number.isFinite(metadata.ctimeMs) || !Number.isFinite(metadata.birthtimeMs) || !validStatIdentity(metadata.dev) || !validStatIdentity(metadata.ino)) throw new Error(`${label} metadata is malformed`);
}

async function readRecoveryManifest(repo, directoryPath, epoch, { expectedSourceDirectory = directoryPath } = {}) {
  if (!RECOVERY_EPOCH.test(epoch ?? '')) throw new Error(`recovery epoch ${epoch ?? '<missing>'} is invalid`);
  const manifestPath = recoveryManifestPath(directoryPath, epoch);
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(repo, manifestPath), 'utf8')); } catch { throw new Error(`recovery epoch ${epoch} manifest is missing or malformed`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some((key) => !RECOVERY_MANIFEST_KEYS.has(key))) throw new Error(`recovery epoch ${epoch} manifest contains unknown fields`);
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'local_pointer_recovery_manifest' || manifest.epoch !== epoch || typeof manifest.sourceDirectory !== 'string' || !SHA256.test(manifest.sourceDigest ?? '') || !UTC.test(manifest.createdAt) || !Array.isArray(manifest.snapshots)) throw new Error(`recovery epoch ${epoch} manifest identity is invalid`);
  const sourceDirectory = normalizeRepoPath(repo, manifest.sourceDirectory);
  const expectedSourcePath = isAbsolute(expectedSourceDirectory) ? relative(repo, resolve(expectedSourceDirectory)).replaceAll('\\', '/') : expectedSourceDirectory;
  if (sourceDirectory !== normalizeRepoPath(repo, expectedSourcePath)) throw new Error(`recovery epoch ${epoch} source directory is not bound`);
  const snapshots = [];
  for (const snapshot of manifest.snapshots) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).some((key) => !RECOVERY_SNAPSHOT_KEYS.has(key))) throw new Error(`recovery epoch ${epoch} snapshot is malformed`);
    if (typeof snapshot.name !== 'string' || snapshot.name !== snapshot.name.replaceAll('\\', '/') || snapshot.name.includes('/') || snapshot.name === '.' || snapshot.name === '..' || !snapshot.sourcePath || !snapshot.snapshotPath || !SHA256.test(snapshot.sha256 ?? '') || !Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes < 0) throw new Error(`recovery epoch ${epoch} snapshot identity is invalid`);
    validateRecoveryMetadata(snapshot.sourceMetadata, `recovery epoch ${epoch} source`);
    validateRecoveryMetadata(snapshot.snapshotMetadata, `recovery epoch ${epoch} snapshot`);
    const expectedSourcePath = `${sourceDirectory}/${snapshot.name}`;
    const expectedSourceRelative = isAbsolute(expectedSourcePath) ? relative(repo, resolve(expectedSourcePath)).replaceAll('\\', '/') : expectedSourcePath;
    if (normalizeRepoPath(repo, snapshot.sourcePath) !== normalizeRepoPath(repo, expectedSourceRelative)) throw new Error(`recovery epoch ${epoch} source path is not canonical`);
    const expectedSnapshotPath = `${directoryPath}/recovery/${epoch}/snapshots/${snapshot.name}`;
    const expectedSnapshotRelative = isAbsolute(expectedSnapshotPath) ? relative(repo, resolve(expectedSnapshotPath)).replaceAll('\\', '/') : expectedSnapshotPath;
    if (normalizeRepoPath(repo, snapshot.snapshotPath) !== normalizeRepoPath(repo, expectedSnapshotRelative)) throw new Error(`recovery epoch ${epoch} snapshot path is not canonical`);
    const snapshotFile = await fileSnapshot(resolve(repo, snapshot.snapshotPath));
    if (!sameFileIdentity({ sha256: snapshot.sha256, sizeBytes: snapshot.sizeBytes, metadata: snapshot.snapshotMetadata }, snapshotFile)) throw new Error(`recovery epoch ${epoch} snapshot hash, size, or identity mismatch`);
    snapshots.push(snapshot);
  }
  const expectedDigest = recoverySourceDigest(sourceDirectory, snapshots);
  if (expectedDigest !== manifest.sourceDigest) throw new Error(`recovery epoch ${epoch} source digest mismatch`);
  return { manifest, manifestPath, snapshots };
}

async function readCurrentPointer(repo, directoryPath, { allowMissingHistory = false, epoch = null } = {}) {
  const normalizedDirectory = isAbsolute(directoryPath) ? relative(repo, resolve(directoryPath)).replaceAll('\\', '/') : directoryPath;
  const rootDirectory = normalizedDirectory;
  directoryPath = normalizedDirectory;
  if (epoch !== null) {
    await readRecoveryManifest(repo, rootDirectory, epoch);
    directoryPath = recoveryEpochDirectory(rootDirectory, epoch);
  }
  const absoluteDirectory = resolve(repo, directoryPath);
  let names;
  try { names = await readdir(absoluteDirectory); } catch (error) {
    if (error?.code === 'ENOENT') {
      if (!allowMissingHistory && await hasGenerationHistory(repo)) throw new Error('publication pointer directory is missing while generation history exists');
      return null;
    }
    throw error;
  }
  const pointers = [];
  for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
    const pointerPath = `${directoryPath}/${name}`;
    let pointer;
    try { pointer = JSON.parse(await readFile(resolve(repo, pointerPath), 'utf8')); } catch { throw new Error(`publication pointer ${pointerPath} is partial or malformed`); }
    if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer) || Object.keys(pointer).some((key) => !POINTER_KEYS.has(key))) throw new Error(`publication pointer ${pointerPath} contains unknown fields`);
    if (pointer.schemaVersion !== 1 || pointer.kind !== 'local_exact_verification_pointer' || !GENERATION.test(pointer.generation ?? '') || !RUN_ID.test(pointer.runId ?? '') || !SHA256.test(pointer.candidateFingerprint ?? '') || !SHA256.test(pointer.payloadDigest ?? '') || !SHA.test(pointer.baseCommit ?? '') || !SHA.test(pointer.headCommit ?? '') || !SHA.test(pointer.mergeRef ?? '') || !SHA.test(pointer.tree ?? '') || typeof pointer.evidencePath !== 'string' || typeof pointer.rootSlotPath !== 'string' || (pointer.previousGeneration !== null && !GENERATION.test(pointer.previousGeneration ?? ''))) throw new Error(`publication pointer ${pointerPath} identity is invalid`);
    let evidencePath;
    try { evidencePath = normalizeRepoPath(repo, pointer.evidencePath); } catch { throw new Error(`publication pointer ${pointerPath} has an unsafe evidence path`); }
    let evidence;
    try { evidence = JSON.parse(await readFile(resolve(repo, evidencePath), 'utf8')); } catch { throw new Error(`publication pointer ${pointerPath} references incomplete evidence`); }
    if (name !== `${pointer.generation}.json`) throw new Error(`publication pointer ${pointerPath} filename is not bound to generation`);
    if (pointerPath !== `${directoryPath}/${pointer.generation}.json`) throw new Error(`publication pointer ${pointerPath} is not canonical`);
    let rootSlotPath;
    try { rootSlotPath = normalizeRepoPath(repo, pointer.rootSlotPath); } catch { throw new Error(`publication pointer ${pointerPath} has an unsafe root slot path`); }
    if (!rootSlotPath.startsWith('ci-artifacts/local-verification/root-slots/')) throw new Error(`publication pointer ${pointerPath} has a non-immutable root slot`);
    // A current pointer is authoritative only when its entire root/evidence
    // chain passes the same full validator used for a candidate publication.
    const rootSlot = await readRootSlot(repo, rootSlotPath);
    if (!rootSlot || JSON.stringify(canonical(rootSlot.record)) !== JSON.stringify(canonical(evidence))) throw new Error(`publication pointer ${pointerPath} is not bound to a complete root slot`);
    if (evidence.payloadDigest !== pointer.payloadDigest
      || evidence.candidateFingerprint !== pointer.candidateFingerprint
      || evidence.generation !== pointer.generation
      || evidence.runId !== pointer.runId
      || evidence.publication?.evidencePath !== pointer.evidencePath
      || evidence.publication?.pointerPath !== pointerPath
      || evidence.publication?.currentPointerDirectory !== directoryPath
      || evidence.publication?.rootSlotPath !== pointer.rootSlotPath
      || evidence.publication?.previousGeneration !== pointer.previousGeneration
      || evidence.provenance?.baseCommit !== pointer.baseCommit
      || evidence.provenance?.headCommit !== pointer.headCommit
      || evidence.provenance?.mergeRef !== pointer.mergeRef
      || evidence.provenance?.tree !== pointer.tree) throw new Error(`publication pointer ${pointerPath} is not bound to its evidence`);
    pointers.push({ pointer, pointerPath });
  }
  if (pointers.length === 0 && !allowMissingHistory && await hasGenerationHistory(repo)) throw new Error('publication pointer directory is empty while generation history exists');
  pointers.sort((left, right) => left.pointer.generation.localeCompare(right.pointer.generation));
  for (let index = 0; index < pointers.length; index += 1) {
    const expectedPrevious = index === 0 ? null : pointers[index - 1].pointer.generation;
    if (pointers[index].pointer.previousGeneration !== expectedPrevious) throw new Error('publication pointer generation chain is invalid');
  }
  return pointers.at(-1) ? { ...pointers.at(-1), epoch } : null;
}

async function quarantineInvalidPointerFiles(repo, sourceDirectory, recoveryRootDirectory = sourceDirectory) {
  const absoluteDirectory = resolve(repo, sourceDirectory);
  let names;
  try { names = await readdir(absoluteDirectory); } catch (error) {
    if (error?.code === 'ENOENT') names = [];
    else throw error;
  }
  const pointerNames = names.filter((name) => name.endsWith('.json')).sort();
  const sourceDirectoryNormalized = normalizeRepoPath(repo, sourceDirectory);
  const sourceSnapshots = [];
  for (const name of pointerNames) {
    const sourcePath = resolve(repo, `${sourceDirectory}/${name}`);
    const expected = await fileSnapshot(sourcePath);
    sourceSnapshots.push({ name, sourcePath: normalizeRepoPath(repo, `${sourceDirectory}/${name}`), sha256: expected.sha256, sizeBytes: expected.sizeBytes, sourceMetadata: expected.metadata, bytes: expected.bytes });
  }
  const sourceDigest = recoverySourceDigest(sourceDirectoryNormalized, sourceSnapshots);
  const epoch = `recovery-${sourceDigest}`;
  const recoveryDirectory = `${recoveryRootDirectory}/recovery/${epoch}`;
  const snapshotsDirectory = `${recoveryDirectory}/snapshots`;
  const manifestPath = `${recoveryDirectory}/manifest.json`;
  await mkdir(resolve(repo, snapshotsDirectory), { recursive: true });
  const manifestSnapshots = [];
  for (const source of sourceSnapshots) {
    const snapshotPath = `${snapshotsDirectory}/${source.name}`;
    let snapshot;
    try {
      snapshot = await fileSnapshot(resolve(repo, snapshotPath));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        await invokePublicationHook('beforeQuarantineSnapshotLink', { sourcePath: resolve(repo, source.sourcePath), snapshotPath: resolve(repo, snapshotPath), expected: source });
        await link(resolve(repo, source.sourcePath), resolve(repo, snapshotPath));
      } catch (linkError) {
        if (linkError?.code === 'EEXIST') {
          snapshot = await fileSnapshot(resolve(repo, snapshotPath));
        } else {
          if (!['EXDEV', 'EPERM', 'EACCES'].includes(linkError?.code)) throw linkError;
          try {
            await writeDurableFile(resolve(repo, snapshotPath), source.bytes, { role: 'pointer-recovery-snapshot' });
          } catch (copyError) {
            if (copyError?.code !== 'EEXIST') throw copyError;
            snapshot = await fileSnapshot(resolve(repo, snapshotPath));
          }
        }
      }
      snapshot ??= await fileSnapshot(resolve(repo, snapshotPath));
    }
    if (snapshot.sha256 !== source.sha256 || snapshot.sizeBytes !== source.sizeBytes) throw new Error(`pointer ${source.name} recovery snapshot hash or size mismatch`);
    manifestSnapshots.push({ name: source.name, sourcePath: source.sourcePath, snapshotPath: normalizeRepoPath(repo, snapshotPath), sha256: source.sha256, sizeBytes: source.sizeBytes, sourceMetadata: source.sourceMetadata, snapshotMetadata: snapshot.metadata });
  }
  const manifest = { schemaVersion: 1, kind: 'local_pointer_recovery_manifest', epoch, sourceDirectory: sourceDirectoryNormalized, sourceDigest, createdAt: new Date().toISOString(), snapshots: manifestSnapshots };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    await writeDurableFile(resolve(repo, manifestPath), manifestText, { role: 'pointer-recovery-manifest' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readRecoveryManifest(repo, recoveryRootDirectory, epoch, { expectedSourceDirectory: sourceDirectory });
    if (existing.manifest.sourceDigest !== sourceDigest) throw new Error(`recovery epoch ${epoch} manifest identity changed`);
  }
  await invokePublicationHook('afterQuarantineManifest', { epoch, sourceDirectory: resolve(repo, sourceDirectory), recoveryDirectory: resolve(repo, recoveryDirectory), manifestPath: resolve(repo, manifestPath), snapshots: manifestSnapshots });
  for (const source of sourceSnapshots) {
    const after = await fileSnapshot(resolve(repo, source.sourcePath));
    if (!sameFileIdentity(source, after)) throw new Error(`pointer ${source.name} changed during explicit recovery`);
  }
  return { epoch, recoveryDirectory, epochDirectory: recoveryEpochDirectory(recoveryRootDirectory, epoch), manifestPath, sourceDigest };
}

async function readRootSlot(repo, slotPath, { validate = true } = {}) {
  try {
    const record = JSON.parse(await readFile(resolve(repo, slotPath), 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some((key) => !ROOT_KEYS.has(key)) || record.kind !== 'local_exact_verification' || !GENERATION.test(record.generation ?? '') || !SHA256.test(record.payloadDigest ?? '') || !SHA256.test(record.candidateFingerprint ?? '')) throw new Error(`root slot ${slotPath} is malformed`);
    const canonicalSlotPath = `ci-artifacts/local-verification/root-slots/${record.generation}.json`;
    if (normalizeRepoPath(repo, slotPath) !== canonicalSlotPath || record.publication?.rootSlotPath !== canonicalSlotPath) throw new Error(`root slot ${slotPath} is not bound to its generation`);
    if (validate) {
      const errors = await validateLocalEvidence(record, { repo, requireFiles: true, verifyGit: true, currentPointer: false, allowCheckedOutHeadDrift: true });
      if (errors.length > 0) throw new Error(`root slot ${slotPath} failed full evidence validation: ${errors.join('; ')}`);
    }
    return { record, slotPath };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function publishImmutableRootSlot(repo, targetPath, serialized) {
  const safePath = normalizeRepoPath(repo, targetPath);
  if (!safePath.startsWith('ci-artifacts/local-verification/root-slots/')) throw new Error('root slot must be an immutable generation path');
  await mkdir(dirname(resolve(repo, safePath)), { recursive: true });
  await writeDurableFile(resolve(repo, safePath), serialized);
}

export const evidenceDigest = (record) => digestObject(evidencePayload(record));

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

export function executableForPlatform(command, platform = process.platform) {
  if (platform === 'win32' && ['npm', 'npx', 'pnpm', 'yarn'].includes(command)) return `${command}.cmd`;
  return command;
}

function commandInvocation(command, args = [], platform = process.platform) {
  const executable = executableForPlatform(command, platform);
  if (platform !== 'win32' || !executable.endsWith('.cmd')) return { command: executable, args };
  const values = [executable, ...args].map((value) => {
    const text = String(value);
    if (/[&|<>^]/.test(text)) throw new Error(`unsafe Windows command argument for ${command}`);
    return /\s/.test(text) ? `"${text}"` : text;
  });
  return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', values.join(' ')] };
}

function normalizeRepoPath(repo, candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '' || isAbsolute(candidate)) throw new Error('path must be a non-empty repository-relative path');
  const normalized = candidate.replaceAll('\\', '/').replace(/^\.\//, '');
  const absolute = resolve(repo, normalized);
  const rel = relative(repo, absolute).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../') || rel.split('/').includes('..')) throw new Error('path escapes repository');
  return rel;
}

export function redactLogText(text) {
  return String(text)
    .replace(CONTROL, '')
    .replace(URL_USERINFO, 'https://redacted.invalid/')
    .replace(SENSITIVE, (match) => `${match.split(/[:=]/, 1)[0]}=<redacted>`)
    .replace(WINDOWS_PATH, '<repo-path>')
    .replace(UNC_PATH, '<repo-path>')
    .replace(POSIX_PATH, (match) => `${match[0] ?? ''}<repo-path>`)
    // A quoted Windows path can leave the separator slash before the
    // placeholder (for example `"/D:\\repo\\file"`). Remove that synthetic
    // slash so the post-redaction fail-closed scan does not mistake it for a
    // leaked POSIX absolute path.
    .replace(/([\"'(=])\/<repo-path>/g, '$1<repo-path>');
}

const REDACTION_BOUNDARY_PATTERNS = [
  /[A-Za-z]:[\\/][^\s"'<>|]*$/,
  /\\\\[^\\\s]+\\[^\s"'<>|]*$/,
  /(?:^|[\s"'(=])\/(?!\/)[^\s"')]*$/,
  /(?:password|passwd|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|cookie|authorization|bearer|api[_-]?key)\s*[:=]\s*[^\s,;]*$/i,
  /https?:\/\/[^\s/@]+(?::[^\s/@]*)?@[^\s"'<>|]*$/i,
];

// Keep a path/secret token intact when a child-process data chunk ends in the
// middle of it. Otherwise the first chunk is redacted to <repo-path> while
// the continuation is emitted later, leaving an unsafe path suffix behind.
export function safeRedactionBoundary(text, cutoff) {
  const limit = Math.max(0, Math.min(String(text).length, cutoff));
  const start = 0;
  const tail = String(text).slice(start, limit);
  let boundary = limit;
  for (const pattern of REDACTION_BOUNDARY_PATTERNS) {
    const match = tail.match(pattern);
    if (match && typeof match.index === 'number') boundary = Math.min(boundary, start + match.index);
  }
  return boundary;
}

function containsForbiddenEvidence(text) {
  return /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\b(?:password|passwd|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|cookie|authorization|bearer|api[_-]?key)\b\s*[:=]\s*[^\s,;]+|https?:\/\/[^\s/@]+(?::[^\s/@]*)?@)/i.test(text)
    || FORBIDDEN_POSIX_PATH.test(text);
}

export function extractCounts(text, fallbackPassed) {
  const match = (pattern) => Number(text.match(pattern)?.[1] ?? 0);
  const tests = match(/(?:#|ℹ)\s*tests\s+(\d+)/i);
  const pass = match(/(?:#|ℹ)\s*pass\s+(\d+)/i);
  const fail = match(/(?:#|ℹ)\s*fail\s+(\d+)/i);
  const skipped = match(/(?:#|ℹ)\s*skipped\s+(\d+)/i);
  const todo = match(/(?:#|ℹ)\s*todo\s+(\d+)/i);
  if (tests > 0 || pass > 0 || fail > 0 || skipped > 0 || todo > 0) return { total: tests, passed: pass, failed: fail, skipped: skipped + todo };
  return { total: 0, passed: 0, failed: fallbackPassed ? 0 : 1, skipped: 0 };
}

async function readJson(repo, path) {
  try { return JSON.parse(await readFile(resolve(repo, path), 'utf8')); } catch { return null; }
}

export async function deriveCounts(repo, spec, output) {
  if (spec.counts) return spec.counts;
  if (spec.countFile) {
    const report = await readJson(repo, spec.countFile);
    if (report?.packages) return report.packages.reduce((sum, item) => ({
      total: sum.total + Number(item.total ?? 0),
      passed: sum.passed + Number(item.passed ?? 0),
      failed: sum.failed + Number(item.failed ?? 0),
      skipped: sum.skipped + Number(item.skipped ?? 0),
    }), { total: 0, passed: 0, failed: 0, skipped: 0 });
    if (spec.id === 'playwright-inventory' && report?.projects) {
      const projects = Object.values(report.projects);
      const total = projects.reduce((sum, item) => sum + Number(item.discovered ?? 0), 0);
      const skipped = projects.reduce((sum, item) => sum + Number(item.skipped ?? 0), 0);
      return { total, passed: total - skipped, failed: 0, skipped };
    }
    if (spec.id === 'playwright-verify' && report?.projects) {
      const projects = Object.values(report.projects);
      return projects.reduce((sum, item) => ({
        total: sum.total + Number(item.discovered ?? 0),
        passed: sum.passed + Number(item.passed ?? 0),
        failed: sum.failed + Number(item.failed ?? 0),
        skipped: sum.skipped + Number(item.skipped ?? 0),
      }), { total: 0, passed: 0, failed: 0, skipped: 0 });
    }
    if (Number.isInteger(report?.total)) return { total: report.total, passed: Number(report.passed ?? report.total), failed: Number(report.failed ?? 0), skipped: Number(report.skipped ?? 0) };
    if (report?.total !== undefined) return { total: Number(report.total), passed: Number(report.passed ?? 0), failed: Number(report.failed ?? 0), skipped: Number(report.skipped ?? 0) };
  }
  if (spec.id === 'lifecycle') {
    const total = (output.match(/E2E lifecycle scenario passed:/g) ?? []).length;
    return { total, passed: total, failed: 0, skipped: 0 };
  }
  if (spec.id === 'playwright-e2e') {
    const report = await readJson(repo, 'tmp/ci-reports/playwright-results.json');
    if (report) {
      const { summarizePlaywrightReport } = await import('./playwright-evidence-policy.mjs');
      const summary = summarizePlaywrightReport(report, { phase: 'execution' });
      return Object.values(summary.projects).reduce((sum, item) => ({
        total: sum.total + Number(item.executed ?? 0),
        passed: sum.passed + Number(item.passed ?? 0),
        failed: sum.failed + Number(item.failed ?? 0),
        skipped: sum.skipped + Number(item.skipped ?? 0),
      }), { total: 0, passed: 0, failed: 0, skipped: 0 });
    }
  }
  return extractCounts(output, spec.exitCode === 0);
}

function artifactPathsFor(spec) {
  return [
    ...(spec.artifacts ?? []),
    ...(spec.countFile ? [spec.countFile] : []),
  ];
}

async function hashArtifacts(repo, paths) {
  const artifacts = [];
  const missing = [];
  for (const candidate of [...new Set(paths)]) {
    const path = normalizeRepoPath(repo, candidate);
    try {
      const bytes = await readFile(resolve(repo, path));
      artifacts.push({ path, sha256: sha256(bytes), sizeBytes: bytes.byteLength });
    } catch {
      missing.push(path);
    }
  }
  return { artifacts, missing };
}

async function runCommand({ repo, spec, logPath }) {
  const startedAt = new Date().toISOString();
  if (spec.skipReason) {
    const summary = `LOCAL COMMAND ${spec.id}: skipped; reason=${spec.skipReason};\n`;
    await writeDurableFile(logPath, summary);
    return {
      id: spec.id,
      command: spec.displayCommand ?? [spec.command, ...(spec.args ?? [])].join(' '),
      cwd: '<repo>',
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: null,
      status: 'skipped',
      skipReason: spec.skipReason,
      requiresTests: spec.requiresTests === true,
      observedBytes: Buffer.byteLength(summary),
      truncated: false,
      counts: { total: 1, passed: 0, failed: 0, skipped: 1 },
      log: { path: normalizeRepoPath(repo, relative(repo, logPath)), sha256: sha256(Buffer.from(summary)), bytes: Buffer.byteLength(summary) },
      artifacts: [],
      missingArtifacts: [],
      requiresEvidence: spec.requiresEvidence === true,
    };
  }
  let observedBytes = 0;
  let capturedBytes = 0;
  let captureTruncated = false;
  const capturedChunks = [];
  let redactionCarry = '';
  const logTempPath = `${logPath}.${randomUUID()}.tmp`;
  const logStream = createWriteStream(logTempPath, { encoding: 'utf8' });
  const logFinished = new Promise((resolveFinish, rejectFinish) => {
    logStream.once('finish', resolveFinish);
    logStream.once('error', rejectFinish);
  });
  const emitRedacted = (text) => {
    const redacted = redactLogText(text);
    if (redacted && capturedBytes < MAX_LOG_BYTES) {
      const remaining = MAX_LOG_BYTES - capturedBytes;
      const redactedBytes = Buffer.from(redacted, 'utf8');
      const bounded = redactedBytes.subarray(0, remaining).toString('utf8');
      if (redactedBytes.byteLength > remaining) captureTruncated = true;
      capturedChunks.push(bounded);
      capturedBytes += Buffer.byteLength(bounded, 'utf8');
    } else if (redacted) {
      captureTruncated = true;
    }
    if (redacted) logStream.write(redacted);
  };
  const invocation = commandInvocation(spec.command, spec.args ?? []);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repo,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(spec.env ?? {}) },
  });
  const collect = (chunk) => {
    const bytes = Buffer.from(chunk);
    observedBytes += bytes.length;
    const combined = `${redactionCarry}${bytes.toString('utf8')}`;
    if (combined.length <= REDACTION_CARRY_CHARS) redactionCarry = combined;
    else {
      const cutoff = combined.length - REDACTION_CARRY_CHARS;
      const boundary = safeRedactionBoundary(combined, cutoff);
      emitRedacted(combined.slice(0, boundary));
      redactionCarry = combined.slice(boundary);
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exitCode = await new Promise((resolveExit) => {
    child.once('error', () => {
      emitRedacted(`LOCAL COMMAND ${spec.id}: failed to start.\n`);
      resolveExit(1);
    });
    child.once('close', (code) => resolveExit(code ?? 1));
  });
  emitRedacted(redactionCarry);
  redactionCarry = '';
  logStream.end();
  await logFinished;
  await syncFile(logTempPath);
  await link(logTempPath, logPath);
  await rm(logTempPath, { force: true });
  const redacted = capturedChunks.join('');
  const fullLog = await readFile(logPath);
  if (containsForbiddenEvidence(redacted) || containsForbiddenEvidence(fullLog.toString('utf8'))) throw new Error(`command ${spec.id} produced unredacted sensitive evidence`);
  const counts = await deriveCounts(repo, { ...spec, exitCode }, redacted);
  const commandText = redactLogText(spec.displayCommand ?? [spec.command, ...(spec.args ?? [])].join(' '));
  if (containsForbiddenEvidence(commandText)) throw new Error(`command ${spec.id} contains unsafe evidence text`);
  const artifactResult = await hashArtifacts(repo, artifactPathsFor(spec));
  return {
    id: spec.id,
    command: commandText,
    cwd: '<repo>',
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    status: exitCode === 0 ? 'passed' : 'failed',
    requiresTests: spec.requiresTests === true,
    observedBytes,
      truncated: captureTruncated,
    counts,
    log: { path: normalizeRepoPath(repo, relative(repo, logPath)), sha256: sha256(fullLog), bytes: fullLog.byteLength },
    artifacts: artifactResult.artifacts,
    missingArtifacts: artifactResult.missing,
    requiresEvidence: spec.requiresEvidence === true,
  };
}

function nodeCommand(args) {
  return { command: process.execPath, displayCommand: ['node', ...args].join(' '), args };
}

export function defaultCommands(plan, platform = process.platform) {
  const commands = [];
  if (plan.gates.docs) commands.push({ id: 'docs-check', ...nodeCommand(['scripts/docs-check-run.mjs']), requiresTests: false, artifacts: ['docs/verification-matrix.md'] });
  if (!plan.gates.check) return commands;
  commands.push({ id: 'typecheck', command: 'npm', displayCommand: 'npm run typecheck', args: ['run', 'typecheck'], requiresTests: false });
  commands.push({ id: 'plugin-tests', command: 'npm', displayCommand: 'npm run test:plugin', args: ['run', 'test:plugin'], requiresTests: true });
  commands.push({ id: 'server-current-tests', command: 'npm', displayCommand: 'npm run test:server:current', args: ['run', 'test:server:current'], requiresTests: true });
  commands.push({ id: 'web-current-tests', command: 'npm', displayCommand: 'npm run test:web:current', args: ['run', 'test:web:current'], requiresTests: true });
  return commands;
}

export function canonicalRequiredGates(plan, platform = process.platform) {
  return defaultCommands(plan, platform).map((spec) => ({
    id: spec.id,
    command: redactLogText(spec.displayCommand ?? [spec.command, ...(spec.args ?? [])].join(' ')),
    requiresTests: spec.requiresTests === true,
    requiresEvidence: spec.requiresEvidence === true,
    artifacts: [...new Set(spec.artifacts ?? [])].sort(),
    skipReason: spec.skipReason ?? null,
  }));
}

function safeEnvironment(repo) {
  const npmVersion = (() => {
    try {
      const invocation = commandInvocation('npm', ['--version']);
      return execFileSync(invocation.command, invocation.args, { cwd: repo, encoding: 'utf8' }).trim();
    } catch { return 'unavailable'; }
  })();
  const gitVersion = (() => { try { return git(repo, ['--version']); } catch { return 'unavailable'; } })();
  return { os: process.platform, arch: process.arch, node: process.version, npm: npmVersion, git: gitVersion, runner: 'local-orca', realProvider: false, productionData: false };
}

export function candidateFingerprint({ provenance, changedPaths, plan }) {
  return digestObject({ provenance, changedPaths, plan: { mode: plan.mode, categories: plan.categories, minimumLevel: plan.minimumLevel, requiredEvidence: plan.requiredEvidence, gates: plan.gates } });
}

export function evidencePayload(record) {
  const { payloadDigest: _ignored, publication, ...payload } = record;
  if (publication) {
    const { payloadDigest: _publicationDigest, ...safePublication } = publication;
    payload.publication = safePublication;
  }
  return payload;
}

export async function validateLocalEvidence(record, { repo = defaultRepoRoot, requireFiles = true, verifyGit = true, currentPointer = true, allowCheckedOutHeadDrift = false } = {}) {
  const errors = [];
  const add = (message) => errors.push(message);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['evidence must be an object'];
  addUnknownKeys(add, record, ROOT_KEYS, 'root');
  if (record.schemaVersion !== 1 || record.kind !== 'local_exact_verification' || record.mode !== 'local_exact') add('schema/kind/mode are invalid');
  if (!RUN_ID.test(record.runId ?? '')) add('runId is invalid');
  if (!GENERATION.test(record.generation ?? '')) add('generation is invalid');
  for (const field of ['startedAt', 'finishedAt']) if (typeof record[field] !== 'string' || Number.isNaN(Date.parse(record[field]))) add(`${field} is invalid`);
  const provenance = record.provenance;
  addUnknownKeys(add, provenance, PROVENANCE_KEYS, 'provenance');
  if (!provenance || !SHA.test(provenance.baseCommit ?? '') || !SHA.test(provenance.headCommit ?? '') || !SHA.test(provenance.mergeRef ?? '') || !SHA.test(provenance.tree ?? '')) add('provenance must contain full base/head/merge/tree SHA');
  if (!Array.isArray(provenance?.parents) || provenance.parents.length !== 2 || provenance.parents[0] !== provenance.baseCommit || provenance.parents[1] !== provenance.headCommit) add('parents must be exactly [baseCommit, headCommit]');
  if (provenance?.checkedOutHead !== provenance?.headCommit || provenance?.worktreeClean !== true) add('worktree provenance is not exact and clean');
  const finalProvenance = record.finalProvenance;
  addUnknownKeys(add, finalProvenance, PROVENANCE_KEYS, 'finalProvenance');
  if (!finalProvenance || typeof finalProvenance !== 'object' || Array.isArray(finalProvenance)) add('finalProvenance is required');
  if (verifyGit && provenance?.baseCommit && provenance?.headCommit && provenance?.mergeRef) {
    try {
      const exact = allowCheckedOutHeadDrift
        ? historicalGitProvenance(repo, provenance)
        : verifyLocalExactInputs({ repoRoot: repo, baseSha: provenance.baseCommit, headSha: provenance.headCommit, mergeSha: provenance.mergeRef });
      const actualChangedPaths = exactChangedPaths(repo, provenance.baseCommit, provenance.mergeRef);
      if (JSON.stringify(record.changedPaths) !== JSON.stringify(actualChangedPaths)) add(`changedPaths do not equal exact base-to-virtual-merge diff: expected ${actualChangedPaths.join(', ')}`);
      const expectedFinal = allowCheckedOutHeadDrift
        ? { baseCommit: exact.baseCommit, headCommit: exact.headCommit, mergeRef: exact.mergeRef, tree: exact.tree, parents: exact.parents, checkedOutHead: provenance.checkedOutHead, worktreeClean: provenance.worktreeClean }
        : { baseCommit: exact.baseSha, headCommit: exact.headSha, mergeRef: exact.mergeSha, tree: exact.treeSha, parents: exact.parents, checkedOutHead: exact.checkedOutHead, worktreeClean: exact.worktreeClean };
      if (JSON.stringify(finalProvenance) !== JSON.stringify(expectedFinal)) add('final provenance differs from current exact Git provenance');
    } catch (error) { add(`provenance drift: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!Array.isArray(record.changedPaths) || record.changedPaths.some((file) => !file || isAbsolute(file) || file.includes('..'))) add('changedPaths must be repository-relative paths');
  else {
    const normalized = record.changedPaths.map((file) => { try { return normalizeRepoPath(repo, file); } catch { return ''; } });
    if (normalized.some((file) => !file)) add('changedPaths contain invalid repository-relative paths');
    if (new Set(normalized).size !== normalized.length || JSON.stringify(normalized) !== JSON.stringify([...normalized].sort())) add('changedPaths must be unique and lexicographically normalized');
  }
  const environment = record.environment;
  addUnknownKeys(add, environment, ENVIRONMENT_KEYS, 'environment');
  if (!environment || environment.realProvider !== false || environment.productionData !== false || environment.runner !== 'local-orca') add('environment boundary is invalid');
  if (verifyGit && environment?.os !== process.platform) add('environment.os does not match the validating runner');
  const planRecord = record.plan;
  addUnknownKeys(add, planRecord, PLAN_KEYS, 'plan');
  addUnknownKeys(add, planRecord?.gates, GATE_KEYS, 'plan.gates');
  if (!planRecord || !['docs-only', 'full'].includes(planRecord.mode) || planRecord.claimAuthorized !== false) add('plan is missing or not fail-closed');
  if (!Array.isArray(record.commands) || record.commands.length === 0) add('commands must be non-empty');
  if (record.results && typeof record.results === 'object') addUnknownKeys(add, record.results, RESULT_KEYS, 'results');
  const publication = record.publication;
  addUnknownKeys(add, publication, PUBLICATION_KEYS, 'publication');
  if (!publication || publication.generation !== record.generation || publication.candidateFingerprint !== record.candidateFingerprint || publication.payloadDigest !== record.payloadDigest) add('publication is not bound to this evidence payload');
  if (publication?.previousGeneration !== null && !GENERATION.test(publication?.previousGeneration ?? '')) add('publication previousGeneration is invalid');
  if (publication?.previousGeneration && publication.previousGeneration >= record.generation) add('publication generation is not newer than previousGeneration');
  const commandIds = new Set();
  let passed = 0; let failed = 0; let skipped = 0; let zeroTest = 0;
  const validateArtifact = async (artifact, owner) => {
    addUnknownKeys(add, artifact, ARTIFACT_KEYS, `artifact ${owner}`);
    if (!artifact || typeof artifact !== 'object' || typeof artifact.path !== 'string' || isAbsolute(artifact.path) || artifact.path.includes('..')) {
      add(`invalid artifact path ${owner}`);
      return;
    }
    if (!SHA256.test(artifact.sha256 ?? '') || !Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
      add(`invalid artifact hash/size ${owner}`);
      return;
    }
    let safePath;
    try { safePath = normalizeRepoPath(repo, artifact.path); } catch { add(`invalid artifact path ${owner}`); return; }
    if (requireFiles) {
      try {
        const bytes = await readFile(resolve(repo, safePath));
        if (sha256(bytes) !== artifact.sha256) add(`artifact hash mismatch ${owner}`);
        if (bytes.byteLength !== artifact.sizeBytes) add(`artifact size mismatch ${owner}`);
      } catch { add(`artifact missing ${owner}`); }
    }
  };
  const selected = selectCiPlan(record.changedPaths ?? []);
  const expectedPlanJson = JSON.stringify(canonical(selected));
  if (JSON.stringify(canonical(planRecord)) !== expectedPlanJson) add('plan does not match the canonical changed-path selection');
  const expectedGates = canonicalRequiredGates(planRecord?.gates ? planRecord : selected, environment?.os ?? process.platform);
  if (!Array.isArray(record.commands) || record.commands.length !== expectedGates.length) add(`commands must exactly cover canonical required gates: expected ${expectedGates.map((gate) => gate.id).join(', ')}`);
  for (let index = 0; index < (record.commands ?? []).length; index += 1) {
    const command = record.commands[index];
    const expectedGate = expectedGates[index];
    addUnknownKeys(add, command, COMMAND_KEYS, `command ${command?.id ?? '<missing>'}`);
    if (commandIds.has(command.id)) add(`duplicate command id ${command.id}`);
    commandIds.add(command.id);
    if (!expectedGate || command.id !== expectedGate.id) add(`command ${command.id ?? '<missing>'} is not the canonical gate at position ${index + 1}`);
    if (expectedGate && command.command !== expectedGate.command) add(`command ${command.id ?? '<missing>'} command text is not canonical`);
    if (expectedGate && command.requiresTests !== expectedGate.requiresTests) add(`command ${command.id ?? '<missing>'} requiresTests does not match canonical gate`);
    if (expectedGate && command.requiresEvidence !== expectedGate.requiresEvidence) add(`command ${command.id ?? '<missing>'} requiresEvidence does not match canonical gate`);
    if (!command.id || !['passed', 'failed', 'skipped'].includes(command.status)) add(`invalid command result ${command.id ?? '<missing>'}`);
    if (typeof command.requiresTests !== 'boolean' || !Number.isInteger(command.observedBytes) || command.observedBytes < 0 || typeof command.truncated !== 'boolean' || typeof command.requiresEvidence !== 'boolean') add(`command metadata is invalid ${command.id ?? '<missing>'}`);
    if (command.truncated === true) add(`truncated command log cannot authorize evidence ${command.id ?? '<missing>'}`);
    if (command.status !== 'skipped' && !Number.isInteger(command.exitCode)) add(`missing exit code ${command.id ?? '<missing>'}`);
    if (command.status === 'passed' && command.exitCode !== 0) add(`passed command has non-zero exit code ${command.id ?? '<missing>'}`);
    if (command.status === 'failed' && command.exitCode === 0) add(`failed command has zero exit code ${command.id ?? '<missing>'}`);
    if (command.status === 'skipped' && (command.exitCode !== null || typeof command.skipReason !== 'string' || command.skipReason.trim() === '')) add(`skipped command is missing an explicit skip reason ${command.id ?? '<missing>'}`);
    if (command.status !== 'skipped' && command.skipReason !== undefined) add(`non-skipped command must not carry skipReason ${command.id ?? '<missing>'}`);
    if (command.status === 'passed') passed += 1;
    if (command.status === 'failed') failed += 1;
    if (command.status === 'skipped') skipped += 1;
    const counts = command.counts;
    addUnknownKeys(add, counts, TEST_COUNTS_KEYS, `command ${command.id ?? '<missing>'}.counts`);
    const validCounts = counts && Number.isInteger(counts.total) && counts.total >= 0
      && Number.isInteger(counts.passed) && counts.passed >= 0
      && Number.isInteger(counts.failed) && counts.failed >= 0
      && Number.isInteger(counts.skipped) && counts.skipped >= 0;
    if (!validCounts) add(`invalid test counts ${command.id ?? '<missing>'}`);
    else {
      if (counts.passed + counts.failed + counts.skipped !== counts.total) add(`test counts do not equal total ${command.id ?? '<missing>'}`);
      if (command.requiresTests && counts.total < 1) zeroTest += 1;
      if (command.status === 'passed' && (command.exitCode !== 0 || counts.passed !== counts.total || counts.failed !== 0 || counts.skipped !== 0)) add(`passed command counts/exitCode are not fully successful ${command.id ?? '<missing>'}`);
      if (command.status === 'skipped' && (command.exitCode !== null || counts.skipped < 1)) add(`skipped command counts/exitCode are invalid ${command.id ?? '<missing>'}`);
    }
    addUnknownKeys(add, command.log, LOG_KEYS, `command ${command.id ?? '<missing>'}.log`);
    if (!SHA256.test(command.log?.sha256 ?? '') || !Number.isInteger(command.log?.bytes) || command.log.bytes < 0) add(`missing log hash/size ${command.id ?? '<missing>'}`);
    let safeLogPath;
    try { safeLogPath = normalizeRepoPath(repo, command.log?.path); } catch { add(`missing or invalid log path ${command.id ?? '<missing>'}`); }
    if (safeLogPath && !safeLogPath.startsWith(`ci-artifacts/local-verification/generations/${record.generation}/${record.runId}/`)) add(`log path is not bound to generation/runId ${command.id ?? '<missing>'}`);
    if (requireFiles && safeLogPath) {
      try {
        const data = await readFile(resolve(repo, safeLogPath), 'utf8');
        if (sha256(Buffer.from(data, 'utf8')) !== command.log.sha256) add(`log hash mismatch ${command.id}`);
        if (Buffer.byteLength(data, 'utf8') !== command.log.bytes) add(`log size mismatch ${command.id}`);
        if (containsForbiddenEvidence(data)) add(`sensitive or absolute path leaked in ${command.id} log`);
      } catch { add(`log missing ${command.id}`); }
    }
    if (validCounts && command.status === 'passed' && counts.failed !== 0) add(`passed command has failed test count ${command.id}`);
    if (validCounts && command.status === 'passed' && counts.skipped !== 0) add(`passed command has skipped test count ${command.id}`);
    if (!Array.isArray(command.artifacts) || !Array.isArray(command.missingArtifacts)) add(`command artifact lists are invalid ${command.id ?? '<missing>'}`);
    for (const missingPath of command.missingArtifacts ?? []) {
      try { normalizeRepoPath(repo, missingPath); } catch { add(`invalid missing artifact path ${command.id ?? '<missing>'}`); }
    }
    if (expectedGate?.requiresEvidence) {
      const actualPaths = new Set((command.artifacts ?? []).map((artifact) => artifact?.path));
      for (const expectedPath of expectedGate.artifacts) if (!actualPaths.has(expectedPath)) add(`required artifact missing ${command.id}: ${expectedPath}`);
      if ((command.missingArtifacts?.length ?? 0) > 0) add(`required artifact missing ${command.id}: ${command.missingArtifacts.join(', ')}`);
    }
    for (const artifact of command.artifacts ?? []) await validateArtifact(artifact, command.id ?? '<missing>');
  }
  for (const artifact of record.artifacts ?? []) await validateArtifact(artifact, 'record');
  if (Array.isArray(record.artifacts) && Array.isArray(record.commands)) {
    const commandArtifacts = record.commands.flatMap((command) => command.artifacts ?? []);
    if (JSON.stringify(canonical(record.artifacts)) !== JSON.stringify(canonical(commandArtifacts))) add('record artifacts do not equal command artifacts');
  }
  if (passed !== record.results?.passed || failed !== record.results?.failed || skipped !== record.results?.skipped || zeroTest !== record.results?.zeroTest) add('result counts do not match command outcomes');
  if (failed > 0 || skipped > 0 || zeroTest > 0) add('failed, skipped, or zero-test command cannot authorize evidence');
  if (record.finalProvenance && JSON.stringify(canonical(record.finalProvenance)) !== JSON.stringify(canonical(record.provenance))) add('final provenance differs from initial provenance');
  if (!Array.isArray(record.artifacts)) add('record artifacts must be an array');
  if (requireFiles && verifyGit && publication?.evidencePath && publication?.pointerPath) {
    try {
      const evidencePath = normalizeRepoPath(repo, publication.evidencePath);
      const pointerPath = normalizeRepoPath(repo, publication.pointerPath);
      const pointerDirectory = normalizeRepoPath(repo, publication.currentPointerDirectory);
      const rootSlotPath = normalizeRepoPath(repo, publication.rootSlotPath);
      if (!evidencePath.startsWith(`ci-artifacts/local-verification/generations/${record.generation}/${record.runId}/`)) add('publication evidence path is not bound to generation/runId');
      if (!pointerDirectory.startsWith('ci-artifacts/local-verification/pointers')) add('publication pointer directory is outside the controlled immutable directory');
      if (pointerPath !== `${pointerDirectory}/${record.generation}.json`) add('publication pointer path is not bound to generation');
      if (rootSlotPath !== `ci-artifacts/local-verification/root-slots/${record.generation}.json`) add('publication root slot is not bound to generation');
      const persisted = JSON.parse(await readFile(resolve(repo, evidencePath), 'utf8'));
      if (JSON.stringify(canonical(persisted)) !== JSON.stringify(canonical(record))) add('persisted generation evidence differs from validated record');
      if (currentPointer) {
        const current = await readCurrentPointer(repo, pointerDirectory);
        const pointer = current?.pointer;
        if (!pointer || current.pointerPath !== pointerPath || pointer.generation !== record.generation || pointer.runId !== record.runId || pointer.evidencePath !== publication.evidencePath || pointer.rootSlotPath !== publication.rootSlotPath || pointer.previousGeneration !== publication.previousGeneration || pointer.candidateFingerprint !== record.candidateFingerprint || pointer.payloadDigest !== record.payloadDigest || pointer.baseCommit !== provenance.baseCommit || pointer.headCommit !== provenance.headCommit || pointer.mergeRef !== provenance.mergeRef || pointer.tree !== provenance.tree) add('publication current pointer is not bound to this candidate');
        const rootSlot = await readRootSlot(repo, rootSlotPath);
        if (!rootSlot || JSON.stringify(canonical(rootSlot.record)) !== JSON.stringify(canonical(record))) add('published root slot differs from validated record');
      }
    } catch { add('publication evidence or pointer is missing/invalid'); }
  }
  if (containsForbiddenEvidence(JSON.stringify(record))) add('evidence contains sensitive or absolute-path text');
  const expectedFingerprint = candidateFingerprint({ provenance, changedPaths: record.changedPaths, plan: record.plan });
  if (record.candidateFingerprint !== expectedFingerprint) add('candidate fingerprint mismatch');
  if (record.payloadDigest !== digestObject(evidencePayload(record))) add('payload digest mismatch');
  return errors;
}

export async function runLocalVerification({ repo = defaultRepoRoot, base, head, merge, output = 'ci-artifacts/local-verification.json', commands, platform = process.platform, recoverMissingPointer = false, epoch = null } = {}) {
  const exact = verifyLocalExactInputs({ repoRoot: repo, baseSha: base, headSha: head, mergeSha: merge });
  const changedPaths = exactChangedPaths(repo, exact.baseSha, exact.mergeSha);
  const plan = selectCiPlan(changedPaths);
  const runId = `local-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomUUID().slice(0, 8)}`;
  const outputPath = normalizeRepoPath(repo, output);
  const basePointerDirectory = normalizeRepoPath(repo, pointerDirectoryPath(outputPath));
  let currentPointerDirectory = epoch === null ? basePointerDirectory : recoveryEpochDirectory(basePointerDirectory, epoch);
  let leaseOutputPath = outputPath;
  if (epoch !== null) await readRecoveryManifest(repo, basePointerDirectory, epoch);
  const initialHadHistory = await hasGenerationHistory(repo);
  let allowMissingPointer = !initialHadHistory;
  let initialCurrent;
  try {
    initialCurrent = await readCurrentPointer(repo, currentPointerDirectory, { allowMissingHistory: allowMissingPointer });
  } catch (error) {
    if (!recoverMissingPointer) throw error;
    const recovery = await quarantineInvalidPointerFiles(repo, currentPointerDirectory, basePointerDirectory);
    currentPointerDirectory = recovery.epochDirectory;
    leaseOutputPath = `${dirname(outputPath).replaceAll('\\\\', '/')}/${recovery.epoch}/local-verification.json`;
    allowMissingPointer = true;
    initialCurrent = await readCurrentPointer(repo, currentPointerDirectory, { allowMissingHistory: true });
  }
  const previousPointer = initialCurrent?.pointer ?? null;
  const previousGeneration = GENERATION.test(previousPointer?.generation ?? '') ? previousPointer.generation : null;
  const generation = generationId(new Date(), previousGeneration);
  const initialRootSlot = previousPointer?.rootSlotPath ?? null;
  const rootSlotPath = rootSlotPathFor(outputPath, generation);
  const generationDirectory = resolve(repo, 'ci-artifacts', 'local-verification', 'generations', generation, runId);
  const logDirectory = generationDirectory;
  const evidencePath = normalizeRepoPath(repo, relative(repo, resolve(generationDirectory, 'evidence.json')));
  let pointerPath = normalizeRepoPath(repo, `${currentPointerDirectory}/${generation}.json`);
  await mkdir(logDirectory, { recursive: true });
  const provenance = { baseCommit: exact.baseSha, headCommit: exact.headSha, mergeRef: exact.mergeSha, tree: exact.treeSha, parents: exact.parents, checkedOutHead: exact.checkedOutHead, worktreeClean: exact.worktreeClean };
  const specs = commands ?? defaultCommands(plan, platform);
  const commandResults = [];
  for (const spec of specs) {
    if (!/^[a-z0-9-]+$/.test(spec.id ?? '')) throw new Error(`unsafe local gate id ${spec.id ?? '<missing>'}`);
    const result = await runCommand({ repo, spec, logPath: resolve(logDirectory, `${spec.id}.log`) });
    commandResults.push(result);
  }
  const finalExact = verifyLocalExactInputs({ repoRoot: repo, baseSha: exact.baseSha, headSha: exact.headSha, mergeSha: exact.mergeSha });
  const finalChangedPaths = exactChangedPaths(repo, exact.baseSha, exact.mergeSha);
  if (JSON.stringify(finalChangedPaths) !== JSON.stringify(changedPaths)) throw new Error('candidate changed during local verification; refusing to publish stale evidence');
  const results = {
    passed: commandResults.filter((item) => item.status === 'passed').length,
    failed: commandResults.filter((item) => item.status === 'failed').length,
    skipped: commandResults.filter((item) => item.status === 'skipped').length,
    zeroTest: commandResults.filter((item) => item.requiresTests === true && (!item.counts || Number(item.counts.total ?? 0) < 1)).length,
  };
  const record = {
    schemaVersion: 1,
    kind: 'local_exact_verification',
    mode: 'local_exact',
    runId,
    generation,
    startedAt: commandResults[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    provenance,
    finalProvenance: { baseCommit: finalExact.baseSha, headCommit: finalExact.headSha, mergeRef: finalExact.mergeSha, tree: finalExact.treeSha, parents: finalExact.parents, checkedOutHead: finalExact.checkedOutHead, worktreeClean: finalExact.worktreeClean },
    changedPaths,
    plan,
    commands: commandResults,
    results,
    environment: safeEnvironment(repo),
    artifacts: commandResults.flatMap((item) => item.artifacts ?? []),
    candidateFingerprint: candidateFingerprint({ provenance, changedPaths, plan }),
    publication: { generation, evidencePath, pointerPath, currentPointerDirectory, rootSlotPath, previousGeneration, candidateFingerprint: candidateFingerprint({ provenance, changedPaths, plan }), payloadDigest: null },
  };
  record.payloadDigest = evidenceDigest(record);
  record.publication.payloadDigest = record.payloadDigest;
  let serialized = `${JSON.stringify(record, null, 2)}\n`;
  await writeDurableFile(resolve(repo, evidencePath), serialized);
  const prePublishErrors = await validateLocalEvidence(record, { repo, requireFiles: true, verifyGit: true, currentPointer: false });
  if (prePublishErrors.length > 0) throw new Error(`local evidence validation failed before publication: ${prePublishErrors.join('; ')}`);
  if (epoch !== null) leaseOutputPath = `${dirname(outputPath).replaceAll('\\\\', '/')}/${epoch}/local-verification.json`;
  let lease = await acquirePublicationLease(repo, outputPath, runId, generation, leaseOutputPath);
  try {
    let liveCurrent;
    try {
      liveCurrent = await readCurrentPointer(repo, currentPointerDirectory, { allowMissingHistory: allowMissingPointer });
    } catch (error) {
      if (!recoverMissingPointer) throw error;
      const recovery = await quarantineInvalidPointerFiles(repo, currentPointerDirectory, basePointerDirectory);
      currentPointerDirectory = recovery.epochDirectory;
      leaseOutputPath = `${dirname(outputPath).replaceAll('\\\\', '/')}/${recovery.epoch}/local-verification.json`;
      pointerPath = normalizeRepoPath(repo, `${currentPointerDirectory}/${generation}.json`);
      record.publication.currentPointerDirectory = currentPointerDirectory;
      record.publication.pointerPath = pointerPath;
      record.payloadDigest = evidenceDigest(record);
      record.publication.payloadDigest = record.payloadDigest;
      serialized = `${JSON.stringify(record, null, 2)}\n`;
      const recoveryErrors = await validateLocalEvidence(record, { repo, requireFiles: true, verifyGit: true, currentPointer: false });
      if (recoveryErrors.length > 0) throw new Error(`local evidence validation failed after recovery: ${recoveryErrors.join('; ')}`);
      liveCurrent = await readCurrentPointer(repo, currentPointerDirectory, { allowMissingHistory: true });
    }
    const liveGeneration = liveCurrent?.pointer?.generation ?? null;
    if (liveGeneration !== previousGeneration) throw new Error('current pointer changed during verification; refusing stale publication');
    const liveRootSlot = liveCurrent?.pointer?.rootSlotPath ?? null;
    if (liveRootSlot !== initialRootSlot) throw new Error('current root slot changed during verification; refusing stale publication');
    lease = await refreshPublicationLease(lease);
    const leaseState = await readLeaseFile(lease.leasePath);
    if (!leaseIdentityEqual(leaseState, lease) || leaseExpired(leaseState)) throw new Error('publication lease identity is stale before publish');
    await publishImmutableRootSlot(repo, rootSlotPath, serialized);
    const pointer = { schemaVersion: 1, kind: 'local_exact_verification_pointer', generation, runId, evidencePath, rootSlotPath, previousGeneration, candidateFingerprint: record.candidateFingerprint, payloadDigest: record.payloadDigest, baseCommit: provenance.baseCommit, headCommit: provenance.headCommit, mergeRef: provenance.mergeRef, tree: provenance.tree };
    const pointerText = `${JSON.stringify(pointer, null, 2)}\n`;
    await invokePublicationHook('beforePointerPublish', {
      leasePath: lease.leasePath,
      pointerPath,
      pointer,
      previousGeneration,
      lease,
    });
    lease = await refreshPublicationLease(lease);
    const finalLeaseState = await readLeaseFile(lease.leasePath);
    if (!leaseIdentityEqual(finalLeaseState, lease) || leaseExpired(finalLeaseState)) throw new Error('publication lease identity changed before pointer CAS');
    await mkdir(resolve(repo, currentPointerDirectory), { recursive: true });
    await writeDurableFile(resolve(repo, pointerPath), pointerText);
    return record;
  } finally {
    await releasePublicationLease(lease);
  }
}

export { acquirePublicationLease, leaseExpired, publishImmutableRootSlot, quarantineInvalidPointerFiles, readCurrentPointer, readLeaseFile, readRootSlot, reclaimStaleLease, refreshPublicationLease, releasePublicationLease, rootSlotPathFor };

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const optionValue = (name) => {
      const index = args.indexOf(name);
      if (index < 0) return null;
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      return value;
    };
    const epoch = optionValue('--epoch');
    if (epoch !== null && !RECOVERY_EPOCH.test(epoch)) throw new Error('--epoch must be a full recovery epoch identity');
    if (args[0] === 'validate') {
      const evidenceIndex = args.indexOf('--evidence');
      const evidencePath = evidenceIndex >= 0 ? args[evidenceIndex + 1] : null;
      if (!evidencePath || isAbsolute(evidencePath) || evidencePath.includes('..')) throw new Error('Usage: node scripts/local-verification.mjs validate --evidence <repo-relative-path>');
      let record;
      if (evidencePath === 'ci-artifacts/local-verification.json') {
        const current = await readCurrentPointer(defaultRepoRoot, pointerDirectoryPath(evidencePath), { epoch });
        if (current?.pointer?.evidencePath) record = JSON.parse(await readFile(resolve(defaultRepoRoot, current.pointer.evidencePath), 'utf8'));
      }
      if (!record) record = JSON.parse(await readFile(resolve(defaultRepoRoot, evidencePath), 'utf8'));
      const errors = await validateLocalEvidence(record, { repo: defaultRepoRoot });
      if (errors.length > 0) throw new Error(`local evidence validation failed: ${errors.join('; ')}`);
      process.stdout.write(`Local evidence valid: ${evidencePath}; run=${record.runId}\n`);
      process.exit(0);
    }
    if (args[0] !== 'local') throw new Error('Usage: node scripts/local-verification.mjs local --base <sha> --head <sha> --merge <sha> [--output <repo-relative-path>]');
    const outputIndex = args.indexOf('--output');
    const output = outputIndex >= 0 ? args[outputIndex + 1] : 'ci-artifacts/local-verification.json';
    const exact = parseLocalExactArgs(args.filter((arg, index) => {
      if (arg === '--recover-missing-pointer' || arg === '--output' || arg === '--epoch') return false;
      if ((outputIndex >= 0 && index === outputIndex + 1) || (args.indexOf('--epoch') >= 0 && index === args.indexOf('--epoch') + 1)) return false;
      return true;
    }));
    const record = await runLocalVerification({ base: exact.baseSha, head: exact.headSha, merge: exact.mergeSha, output, epoch, recoverMissingPointer: args.includes('--recover-missing-pointer') });
    process.stdout.write(`Local exact verification passed: ${record.runId}; commands=${record.commands.length}; evidence=${record.publication.evidencePath}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
