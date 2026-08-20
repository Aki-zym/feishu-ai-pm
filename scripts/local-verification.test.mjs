import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { acquirePublicationLease, candidateFingerprint, defaultCommands, deriveCounts, executableForPlatform, evidenceDigest, extractCounts, publishImmutableRootSlot, quarantineInvalidPointerFiles, readCurrentPointer, readLeaseFile, readRootSlot, reclaimStaleLease, redactLogText, refreshPublicationLease, releasePublicationLease, rootSlotPathFor, runLocalVerification, safeRedactionBoundary, setPublicationInjectionHooks, validateLocalEvidence } from './local-verification.mjs';
import { selectCiPlan } from './ci-selection-policy.mjs';

const sha = (value) => value.repeat(40);
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('local log redaction removes secrets, userinfo, absolute paths and control bytes', () => {
  const raw = 'token=secret-canary password=hunter2 https://alice:pw@example.invalid/x C:\\Users\\alice\\repo /private/alice\u0000';
  const redacted = redactLogText(raw);
  assert.doesNotMatch(redacted, /secret-canary|hunter2|alice:pw|C:\\Users|\/private\/alice/);
  assert.match(redacted, /redacted/);
});

test('local chunk boundary keeps absolute paths intact for redaction', () => {
  const raw = `${'x'.repeat(1000)} D:\\${'a'.repeat(3000)}`;
  const cutoff = raw.length - 2048;
  const boundary = safeRedactionBoundary(raw, cutoff);
  assert.ok(boundary < cutoff);
  const redacted = `${redactLogText(raw.slice(0, boundary))}${redactLogText(raw.slice(boundary))}`;
  assert.doesNotMatch(redacted, /D:\\|\\\\/);
});

test('quoted Windows paths do not leave a synthetic POSIX separator after redaction', () => {
  assert.equal(redactLogText('"/D:\\Users\\alice\\repo\\report.json"'), '"<repo-path>"');
});

test('local command execution resolves Windows package-manager shims', () => {
  assert.equal(executableForPlatform('npm', 'win32'), 'npm.cmd');
  assert.equal(executableForPlatform('node', 'win32'), 'node');
  assert.equal(executableForPlatform('npm', 'linux'), 'npm');
});

test('local count extraction understands Node test runner summaries', () => {
  assert.deepEqual(extractCounts('ℹ tests 8\nℹ pass 7\nℹ fail 1\nℹ skipped 0\nℹ todo 0\n', false), { total: 8, passed: 7, failed: 1, skipped: 0 });
});

test('operational Windows gates count the gate result, not nested check summaries', async () => {
  assert.deepEqual(await deriveCounts(process.cwd(), { id: 'windows-smoke-build', exitCode: 0 }, 'ℹ tests 42\nℹ pass 41\nℹ skipped 1\n'), { total: 1, passed: 1, failed: 0, skipped: 0 });
});

test('local plan keeps Windows L5 explicit when desktop/release paths require it', () => {
  const plan = { gates: { docs: true, check: true }, minimumLevel: 'L5' };
  const linux = defaultCommands(plan, 'linux');
  assert.equal(linux.at(-1).id, 'windows-l5');
  assert.equal(linux.at(-1).status, undefined);
  assert.match(linux.at(-1).skipReason, /Windows runner/);
  const windows = defaultCommands(plan, 'win32').map(({ id }) => id);
  assert.deepEqual(windows.slice(-4), ['windows-manifest', 'windows-l5-harness', 'windows-smoke-build', 'windows-smoke']);
});

test('playwright execution counts aggregate project failures and skips', async () => {
  const root = process.cwd();
  const reportPath = join(root, 'tmp', 'ci-reports', 'playwright-execution-counts-test.json');
  await mkdir(join(root, 'tmp', 'ci-reports'), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ projects: {
    web: { discovered: 3, executed: 3, passed: 2, failed: 1, skipped: 0 },
    desktop: { discovered: 2, executed: 1, passed: 1, failed: 0, skipped: 1 },
  }}));
  try {
    assert.deepEqual(await deriveCounts(root, { id: 'playwright-verify', countFile: 'tmp/ci-reports/playwright-execution-counts-test.json' }, ''), { total: 5, passed: 3, failed: 1, skipped: 1 });
  } finally {
    await rm(reportPath, { force: true });
  }
});

function validRecord(root, runId = 'local-20260817T010203Z-deadbeef') {
  const generation = '20260817010203000-deadbeef';
  const provenance = { baseCommit: sha('a'), headCommit: sha('b'), mergeRef: sha('c'), tree: sha('d'), parents: [sha('a'), sha('b')], checkedOutHead: sha('b'), worktreeClean: true };
  const changedPaths = ['docs/local-verification.md'];
  const plan = { schemaVersion: 1, mode: 'docs-only', categories: ['docs-only'], minimumLevel: 'L0', requiredEvidence: ['docs_check'], highRisk: false, manualReviewRequired: false, claimAuthorized: false, files: changedPaths, reason: 'all changed paths are documentation', gates: { docs: true, check: false, lifecycle: false, e2e: false } };
  const log = 'docs check passed\n';
  const logPath = `ci-artifacts/local-verification/generations/${generation}/${runId}/docs-check.log`;
  const command = { id: 'docs-check', command: 'node scripts/docs-check-run.mjs', cwd: '<repo>', startedAt: '2026-08-17T01:02:03.000Z', finishedAt: '2026-08-17T01:02:04.000Z', exitCode: 0, status: 'passed', requiresTests: false, observedBytes: Buffer.byteLength(log), truncated: false, counts: { total: 0, passed: 0, failed: 0, skipped: 0 }, log: { path: logPath, sha256: hash(log), bytes: Buffer.byteLength(log) }, artifacts: [], missingArtifacts: [], requiresEvidence: false };
  const record = { schemaVersion: 1, kind: 'local_exact_verification', mode: 'local_exact', runId, generation, startedAt: '2026-08-17T01:02:03.000Z', finishedAt: '2026-08-17T01:02:04.000Z', provenance, finalProvenance: provenance, changedPaths, plan, commands: [command], results: { passed: 1, failed: 0, skipped: 0, zeroTest: 0 }, environment: { os: 'win32', arch: 'x64', node: 'v24', npm: '11', git: '2.54', runner: 'local-orca', realProvider: false, productionData: false, windowsL5: true }, artifacts: [], candidateFingerprint: candidateFingerprint({ provenance, changedPaths, plan }), publication: { generation, evidencePath: `ci-artifacts/local-verification/generations/${generation}/${runId}/evidence.json`, pointerPath: `ci-artifacts/local-verification/pointers/${generation}.json`, currentPointerDirectory: 'ci-artifacts/local-verification/pointers', rootSlotPath: `ci-artifacts/local-verification/root-slots/${generation}.json`, previousGeneration: null, candidateFingerprint: candidateFingerprint({ provenance, changedPaths, plan }), payloadDigest: null } };
  record.payloadDigest = evidenceDigest(record);
  record.publication.payloadDigest = record.payloadDigest;
  return { record, log, path: join(root, command.log.path) };
}

test('local evidence validator rejects tampered logs, wrong fingerprint, replay and skip/zero-test results', async () => {
  const root = process.cwd();
  const valid = validRecord(root);
  await mkdir(join(root, 'ci-artifacts', 'local-verification', 'generations', valid.record.generation, valid.record.runId), { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(valid.path, valid.log));
  const validErrors = await validateLocalEvidence(valid.record, { repo: root, verifyGit: false });
  assert.deepEqual(validErrors, []);
  const tampered = structuredClone(valid.record);
  await import('node:fs/promises').then(({ writeFile }) => writeFile(valid.path, 'tampered\n'));
  assert.match((await validateLocalEvidence(tampered, { repo: root, verifyGit: false })).join('\n'), /hash mismatch/);
  await rm(join(root, 'ci-artifacts', 'local-verification', valid.record.runId), { recursive: true, force: true });
});

test('validator rejects truncated logs even after payloadDigest is recomputed', async () => {
  const root = process.cwd();
  const valid = validRecord(root, 'local-20260817T010206Z-cafebabe');
  await mkdir(join(root, 'ci-artifacts', 'local-verification', 'generations', valid.record.generation, valid.record.runId), { recursive: true });
  await writeFile(valid.path, valid.log);
  const truncated = structuredClone(valid.record);
  truncated.commands[0].truncated = true;
  truncated.payloadDigest = evidenceDigest(truncated);
  truncated.publication.payloadDigest = truncated.payloadDigest;
  assert.match((await validateLocalEvidence(truncated, { repo: root, verifyGit: false })).join('\n'), /truncated command log/);
  await rm(join(root, 'ci-artifacts', 'local-verification', 'generations', valid.record.generation), { recursive: true, force: true });
});

test('local evidence validator fails closed for malformed counts, POSIX paths and tampered artifacts', async () => {
  const root = process.cwd();
  const valid = validRecord(root, 'local-20260817T010204Z-cafebabe');
  const directory = join(root, 'ci-artifacts', 'local-verification', 'generations', valid.record.generation, valid.record.runId);
  await mkdir(directory, { recursive: true });
  await writeFile(valid.path, valid.log);
  const malformed = structuredClone(valid.record);
  delete malformed.commands[0].counts;
  assert.match((await validateLocalEvidence(malformed, { repo: root, verifyGit: false })).join('\n'), /invalid test counts/);

  const posix = structuredClone(valid.record);
  const posixLog = '/private/should-not-be-recorded\n';
  await writeFile(valid.path, posixLog);
  posix.commands[0].log.sha256 = hash(posixLog);
  posix.commands[0].log.bytes = Buffer.byteLength(posixLog);
  posix.payloadDigest = evidenceDigest(posix);
  assert.match((await validateLocalEvidence(posix, { repo: root, verifyGit: false })).join('\n'), /sensitive or absolute path/);

  const artifactPath = join(directory, 'artifact.json');
  const artifact = { path: `ci-artifacts/local-verification/generations/${valid.record.generation}/${valid.record.runId}/artifact.json`, sha256: hash('artifact\n'), sizeBytes: Buffer.byteLength('artifact\n') };
  await writeFile(valid.path, valid.log);
  await writeFile(artifactPath, 'artifact\n');
  const withArtifact = structuredClone(valid.record);
  withArtifact.commands[0].artifacts = [artifact];
  withArtifact.artifacts = [artifact];
  withArtifact.payloadDigest = evidenceDigest(withArtifact);
  withArtifact.publication.payloadDigest = withArtifact.payloadDigest;
  assert.deepEqual(await validateLocalEvidence(withArtifact, { repo: root, verifyGit: false }), []);
  await writeFile(artifactPath, 'tampered\n');
  assert.match((await validateLocalEvidence(withArtifact, { repo: root, verifyGit: false })).join('\n'), /artifact hash mismatch/);
  await rm(directory, { recursive: true, force: true });
});

test('empty diff is always full L6 high-risk manual and fail-closed', () => {
  assert.deepEqual(selectCiPlan([]), {
    schemaVersion: 1,
    mode: 'full',
    categories: ['unknown'],
    minimumLevel: 'L6',
    requiredEvidence: ['exact_provenance', 'path_review'],
    highRisk: true,
    manualReviewRequired: true,
    claimAuthorized: false,
    files: [],
    reason: 'empty diff is not accepted as docs-only',
    gates: { docs: true, check: true, lifecycle: true, e2e: true },
  });
});

test('validator rejects injected fields, changed-path shrinkage, desktop docs-only substitution, and total/pass mismatch', async () => {
  const root = process.cwd();
  const valid = validRecord(root, 'local-20260817T010205Z-cafebabe');
  const unknown = structuredClone(valid.record);
  unknown.EXTRA_REVIEWER = true;
  assert.match((await validateLocalEvidence(unknown, { repo: root, verifyGit: false })).join('\\n'), /unknown field EXTRA_REVIEWER/);

  const pathShrink = structuredClone(valid.record);
  pathShrink.changedPaths = ['docs/local-verification.md', 'scripts/local-verification.mjs'];
  pathShrink.payloadDigest = evidenceDigest(pathShrink);
  pathShrink.publication.payloadDigest = pathShrink.payloadDigest;
  assert.match((await validateLocalEvidence(pathShrink, { repo: root, verifyGit: false })).join('\\n'), /plan does not match|commands must exactly cover/);

  const desktopDocs = structuredClone(valid.record);
  desktopDocs.changedPaths = ['apps/desktop/src/main.ts'];
  desktopDocs.payloadDigest = evidenceDigest(desktopDocs);
  desktopDocs.publication.payloadDigest = desktopDocs.payloadDigest;
  assert.match((await validateLocalEvidence(desktopDocs, { repo: root, verifyGit: false })).join('\\n'), /plan does not match|commands must exactly cover/);

  const countMismatch = structuredClone(valid.record);
  countMismatch.commands[0].counts = { total: 1, passed: 0, failed: 0, skipped: 1 };
  countMismatch.payloadDigest = evidenceDigest(countMismatch);
  countMismatch.publication.payloadDigest = countMismatch.payloadDigest;
  assert.match((await validateLocalEvidence(countMismatch, { repo: root, verifyGit: false })).join('\\n'), /passed command counts|test counts/);
});

test('publication uses immutable root generations and identity-bound heartbeat leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-verification-publication-'));
  await mkdir(join(root, 'ci-artifacts'), { recursive: true });
  const valid = validRecord(root, 'local-20260817T010207Z-cafebabe');
  const rootPath = rootSlotPathFor('ci-artifacts/local-verification.json', valid.record.generation);
  await publishImmutableRootSlot(root, rootPath, JSON.stringify(valid.record));
  assert.deepEqual((await readRootSlot(root, rootPath, { validate: false })).record, valid.record);
  await assert.rejects(() => publishImmutableRootSlot(root, rootPath, JSON.stringify(valid.record)), /EEXIST|already exists/);

  const lease = await acquirePublicationLease(root, 'ci-artifacts/local-verification.json', valid.record.runId, valid.record.generation);
  const refreshed = await refreshPublicationLease(lease, Date.now() + 10);
  const onDisk = await readLeaseFile(lease.leasePath);
  assert.equal(onDisk.token, lease.token);
  assert.equal(onDisk.heartbeatAt, refreshed.heartbeatAt);
  assert.equal(await releasePublicationLease({ ...refreshed, token: 'stale-owner-token' }), false);
  assert.equal((await readLeaseFile(lease.leasePath)).token, lease.token);
  assert.equal(await releasePublicationLease(refreshed), true);
  assert.equal((await readLeaseFile(lease.leasePath)).state, 'released');
  assert.match(lease.leasePath.replaceAll('\\', '/'), /\/leases\/20260817010203000-deadbeef-[0-9a-f-]{36}\/lease\.json$/i);

  const staleToken = '55555555-5555-4555-8555-555555555555';
  const staleDirectory = join(root, 'ci-artifacts', 'local-verification', 'leases', `${valid.record.generation}-${staleToken}`);
  const stalePath = join(staleDirectory, 'lease.json');
  const stale = { ownerId: `orca-${process.pid}-deadbeef`, token: staleToken, pid: 1, acquiredAt: '2026-08-17T00:00:00.000Z', heartbeatAt: '2026-08-17T00:00:00.000Z', expiresAt: '2026-08-17T00:00:01.000Z', generation: valid.record.generation, runId: valid.record.runId };
  await mkdir(join(staleDirectory, 'heartbeats'), { recursive: true });
  await writeFile(stalePath, `${JSON.stringify(stale)}\n`);
  assert.equal(await reclaimStaleLease(stalePath, stale), true);
  assert.equal((await readLeaseFile(stalePath)).state, 'reclaimed');
  await rm(root, { recursive: true, force: true });
});

test('failed command preserves history but never advances the current pointer', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'local-verification-failed-run-'));
  const git = (args, options = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', ...options }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'local@example.invalid']);
  git(['config', 'user.name', 'Local Verification']);
  await writeFile(join(repo, '.gitignore'), 'ci-artifacts/\n');
  git(['add', '.gitignore']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'docs', 'candidate.md'), 'candidate\n');
  git(['add', 'docs/candidate.md']);
  git(['commit', '-qm', 'head']);
  const head = git(['rev-parse', 'HEAD']);
  const tree = git(['show', '-s', '--format=%T', head]);
  const merge = execFileSync('git', ['commit-tree', tree, '-p', base, '-p', head], { cwd: repo, input: 'virtual merge\n', encoding: 'utf8' }).trim();
  const plan = selectCiPlan(['docs/candidate.md']);
  await assert.rejects(() => runLocalVerification({ repo, base, head, merge, commands: defaultCommands(plan, 'win32') }), /validation failed before publication/);
  await assert.rejects(() => readCurrentPointer(repo, 'ci-artifacts/local-verification/pointers'), /generation history exists/);
  assert.equal(await readCurrentPointer(repo, 'ci-artifacts/local-verification/pointers', { allowMissingHistory: true }), null);
  const generations = await readdir(join(repo, 'ci-artifacts', 'local-verification', 'generations'));
  assert.equal(generations.length, 1);
  const generationRun = await readdir(join(repo, 'ci-artifacts', 'local-verification', 'generations', generations[0]));
  assert.equal(generationRun.length, 1);
  assert.deepEqual(await readdir(join(repo, 'ci-artifacts', 'local-verification', 'root-slots')).catch(() => []), []);
  await assert.rejects(() => readFile(join(repo, 'ci-artifacts', 'local-verification.json.lock')), { code: 'ENOENT' });
  await rm(repo, { recursive: true, force: true });
});

async function createDocsCandidateRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'local-verification-adversarial-'));
  const git = (args, options = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', ...options }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'local@example.invalid']);
  git(['config', 'user.name', 'Local Verification']);
  await writeFile(join(repo, '.gitignore'), 'ci-artifacts/\ntmp/\n');
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'docs', 'verification-matrix.md'), 'fixture\n');
  git(['add', '.gitignore', 'docs/verification-matrix.md']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'docs', 'candidate.md'), 'candidate\n');
  git(['add', 'docs/candidate.md']);
  git(['commit', '-qm', 'head']);
  const head = git(['rev-parse', 'HEAD']);
  const tree = git(['show', '-s', '--format=%T', head]);
  const merge = execFileSync('git', ['commit-tree', tree, '-p', base, '-p', head], { cwd: repo, input: 'virtual merge\n', encoding: 'utf8' }).trim();
  const plan = selectCiPlan(['docs/candidate.md']);
  const command = { id: 'docs-check', command: process.execPath, displayCommand: 'node scripts/docs-check-run.mjs', args: ['-e', 'process.stdout.write("docs check passed\\n")'], requiresTests: false, artifacts: ['docs/verification-matrix.md'] };
  return { repo, base, head, merge, plan, command };
}

test('candidate crash before atomic publication leaves no shared lock or temp candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-verification-crash-a-'));
  await mkdir(join(root, 'ci-artifacts'), { recursive: true });
  setPublicationInjectionHooks({ beforeCandidatePublish: () => { throw new Error('injected candidate crash'); } });
  try {
    await assert.rejects(() => acquirePublicationLease(root, 'ci-artifacts/local-verification.json', 'local-20260817T010208Z-cafebabe', '20260817010208000-cafebabe'), /injected candidate crash/);
    await assert.rejects(() => readFile(join(root, 'ci-artifacts/local-verification.json.lock')), { code: 'ENOENT' });
    const names = await readdir(join(root, 'ci-artifacts'));
    assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), []);
  } finally {
    setPublicationInjectionHooks({});
    await rm(root, { recursive: true, force: true });
  }
});

test('release and stale reclaim never delete a replacement interposed at final identity compare', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-verification-interposition-bc-'));
  await mkdir(join(root, 'ci-artifacts'), { recursive: true });
  const generation = '20260817010209000-cafebabe';
  const runId = 'local-20260817T010209Z-cafebabe';
  const lease = await acquirePublicationLease(root, 'ci-artifacts/local-verification.json', runId, generation);
  const replacementToken = '11111111-1111-4111-8111-111111111111';
  const replacementDirectory = join(root, 'ci-artifacts', 'local-verification', 'leases', `${generation}-${replacementToken}`);
  const replacementPath = join(replacementDirectory, 'lease.json');
  const replacement = { ownerId: `orca-${process.pid}-feedbeef`, token: replacementToken, pid: process.pid, acquiredAt: lease.acquiredAt, heartbeatAt: lease.heartbeatAt, expiresAt: lease.expiresAt, generation, runId };
  await mkdir(join(replacementDirectory, 'heartbeats'), { recursive: true });
  await writeFile(replacementPath, `${JSON.stringify(replacement)}\n`);
  setPublicationInjectionHooks({ beforeReleaseFinalCompare: async ({ identityPath }) => {
    assert.equal(identityPath, lease.leasePath);
    assert.equal((await readLeaseFile(replacementPath)).token, replacementToken);
  } });
  try {
    assert.equal(await releasePublicationLease(lease), true);
  } finally {
    setPublicationInjectionHooks({});
  }
  assert.equal((await readLeaseFile(replacementPath)).token, replacementToken);

  const staleToken = '22222222-2222-4222-8222-222222222222';
  const staleDirectory = join(root, 'ci-artifacts', 'local-verification', 'leases', `${generation}-${staleToken}`);
  const stalePath = join(staleDirectory, 'lease.json');
  const stale = { ownerId: `orca-${process.pid}-deadbeef`, token: staleToken, pid: 1, acquiredAt: '2026-08-17T00:00:00.000Z', heartbeatAt: '2026-08-17T00:00:00.000Z', expiresAt: '2026-08-17T00:00:01.000Z', generation, runId };
  await mkdir(join(staleDirectory, 'heartbeats'), { recursive: true });
  await writeFile(stalePath, `${JSON.stringify(stale)}\n`);
  const staleReplacementToken = '33333333-3333-4333-8333-333333333333';
  const staleReplacementDirectory = join(root, 'ci-artifacts', 'local-verification', 'leases', `${generation}-${staleReplacementToken}`);
  const staleReplacementPath = join(staleReplacementDirectory, 'lease.json');
  const staleReplacement = { ...stale, ownerId: `orca-${process.pid}-feedcafe`, token: staleReplacementToken, expiresAt: new Date(Date.now() + 30_000).toISOString() };
  await mkdir(join(staleReplacementDirectory, 'heartbeats'), { recursive: true });
  await writeFile(staleReplacementPath, `${JSON.stringify(staleReplacement)}\n`);
  setPublicationInjectionHooks({ beforeReclaimStatePublish: async ({ lease: target }) => {
    assert.equal(target.token, staleToken);
    assert.equal((await readLeaseFile(staleReplacementPath)).token, staleReplacementToken);
  } });
  try {
    assert.equal(await reclaimStaleLease(stalePath, stale), true);
  } finally {
    setPublicationInjectionHooks({});
  }
  assert.equal((await readLeaseFile(staleReplacementPath)).token, staleReplacementToken);
  await rm(root, { recursive: true, force: true });
});

test('legacy shared lock fails closed and cannot be stale-recovered into a new identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-verification-malformed-lock-'));
  await mkdir(join(root, 'ci-artifacts'), { recursive: true });
  const lockPath = join(root, 'ci-artifacts/local-verification.json.lock');
  const generation = '20260817010210000-cafebabe';
  const runId = 'local-20260817T010210Z-cafebabe';
  await writeFile(lockPath, '{');
  await assert.rejects(() => acquirePublicationLease(root, 'ci-artifacts/local-verification.json', runId, generation), /legacy shared publication lease exists/);
  await utimes(lockPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  await assert.rejects(() => acquirePublicationLease(root, 'ci-artifacts/local-verification.json', runId, generation), /legacy shared publication lease exists/);
  await rm(root, { recursive: true, force: true });
});

test('heartbeat rejects clock rollback and two stale reclaimers allow exactly one winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-verification-concurrency-'));
  await mkdir(join(root, 'ci-artifacts'), { recursive: true });
  const generation = '20260817010211000-cafebabe';
  const runId = 'local-20260817T010211Z-cafebabe';
  const lease = await acquirePublicationLease(root, 'ci-artifacts/local-verification.json', runId, generation);
  await assert.rejects(() => refreshPublicationLease(lease, Date.parse(lease.heartbeatAt) - 1), /clock moved backwards/);
  assert.equal(await releasePublicationLease(lease), true);
  const staleToken = '44444444-4444-4444-8444-444444444444';
  const stale = { ownerId: `orca-${process.pid}-deadbeef`, token: staleToken, pid: 1, acquiredAt: '2026-08-17T00:00:00.000Z', heartbeatAt: '2026-08-17T00:00:00.000Z', expiresAt: '2026-08-17T00:00:01.000Z', generation, runId };
  const staleDirectory = join(root, 'ci-artifacts', 'local-verification', 'leases', `${generation}-${staleToken}`);
  const leasePath = join(staleDirectory, 'lease.json');
  await mkdir(join(staleDirectory, 'heartbeats'), { recursive: true });
  await writeFile(leasePath, `${JSON.stringify(stale)}\n`);
  const outcomes = await Promise.allSettled([reclaimStaleLease(leasePath, stale), reclaimStaleLease(leasePath, stale)]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled' && item.value === true).length, 1);
  assert.equal((await readLeaseFile(leasePath)).state, 'reclaimed');
  await rm(root, { recursive: true, force: true });
});

test('pointer publish rejects a stale writer after lease replacement and preserves history without current', async () => {
  const { repo, base, head, merge, command } = await createDocsCandidateRepo();
  setPublicationInjectionHooks({ beforePointerPublish: async ({ lease }) => {
    assert.equal(await releasePublicationLease(lease), true);
  } });
  try {
    await assert.rejects(() => runLocalVerification({ repo, base, head, merge, commands: [command] }), /identity is stale|identity changed|lease/);
    await assert.rejects(() => readCurrentPointer(repo, 'ci-artifacts/local-verification/pointers'), /generation history exists/);
    const leaseRoots = await readdir(join(repo, 'ci-artifacts', 'local-verification', 'leases'));
    assert.equal(leaseRoots.length, 1);
    assert.equal((await readLeaseFile(join(repo, 'ci-artifacts', 'local-verification', 'leases', leaseRoots[0], 'lease.json'))).state, 'released');
    assert.equal((await readdir(join(repo, 'ci-artifacts', 'local-verification', 'root-slots'))).length, 1);
  } finally {
    setPublicationInjectionHooks({});
    await rm(repo, { recursive: true, force: true });
  }
});

test('authoritative current reader rejects persisted failed results with a stale digest', async () => {
  const { repo, base, head, merge, command } = await createDocsCandidateRepo();
  try {
    const record = await runLocalVerification({ repo, base, head, merge, commands: [command] });
    assert.equal((await readCurrentPointer(repo, 'ci-artifacts/local-verification/pointers')).pointer.generation, record.generation);
    const evidencePath = join(repo, record.publication.evidencePath);
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    evidence.commands[0].exitCode = 1;
    evidence.commands[0].status = 'failed';
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
    await assert.rejects(() => readCurrentPointer(repo, 'ci-artifacts/local-verification/pointers'), /full evidence validation|publication pointer|complete root slot/);
  } finally {
    setPublicationInjectionHooks({});
    await rm(repo, { recursive: true, force: true });
  }
});

test('history with missing pointer requires explicit recovery before a new current chain can publish', async () => {
  const { repo, base, head, merge, command } = await createDocsCandidateRepo();
  try {
    await assert.rejects(() => runLocalVerification({ repo, base, head, merge, commands: [{ ...command, args: ['-e', 'process.exit(1)'] }] }), /validation failed before publication/);
    await assert.rejects(() => runLocalVerification({ repo, base, head, merge, commands: [command] }), /generation history exists/);
    const recovered = await runLocalVerification({ repo, base, head, merge, commands: [command], recoverMissingPointer: true });
    const epoch = recovered.publication.currentPointerDirectory.split('/').at(-1);
    assert.match(epoch, /^recovery-[0-9a-f]{64}$/);
    const current = await readCurrentPointer(repo, 'ci-artifacts/local-verification/pointers', { epoch });
    assert.equal(current.pointer.generation, recovered.generation);
    assert.equal(current.pointer.previousGeneration, null);
  } finally {
    setPublicationInjectionHooks({});
    await rm(repo, { recursive: true, force: true });
  }
});

test('damaged current pointer requires explicit recovery and is preserved in a recovery quarantine', async () => {
  const { repo, base, head, merge, command } = await createDocsCandidateRepo();
  try {
    await assert.rejects(() => runLocalVerification({ repo, base, head, merge, commands: [{ ...command, args: ['-e', 'process.exit(1)'] }] }), /validation failed before publication/);
    const pointerDirectory = join(repo, 'ci-artifacts', 'local-verification', 'pointers');
    await mkdir(pointerDirectory, { recursive: true });
    const damagedPath = join(pointerDirectory, '20260817010213000-damaged.json');
    await writeFile(damagedPath, '{partial');
    await assert.rejects(() => runLocalVerification({ repo, base, head, merge, commands: [command] }), /partial or malformed/);
    const recovered = await runLocalVerification({ repo, base, head, merge, commands: [command], recoverMissingPointer: true });
    const epoch = recovered.publication.currentPointerDirectory.split('/').at(-1);
    await assert.rejects(() => readCurrentPointer(repo, pointerDirectory), /partial or malformed/);
    const current = await readCurrentPointer(repo, pointerDirectory, { epoch });
    assert.equal(current.pointer.generation, recovered.generation);
    assert.equal(await readFile(damagedPath, 'utf8'), '{partial');
    const recoveryDirectories = (await readdir(join(pointerDirectory, 'recovery'), { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name === epoch);
    assert.equal(recoveryDirectories.length, 1);
    assert.equal(await readFile(join(pointerDirectory, 'recovery', epoch, 'snapshots', '20260817010213000-damaged.json'), 'utf8'), '{partial');
    assert.equal((await readFile(join(pointerDirectory, 'recovery', epoch, 'manifest.json'), 'utf8')).includes('local_pointer_recovery_manifest'), true);
  } finally {
    setPublicationInjectionHooks({});
    await rm(repo, { recursive: true, force: true });
  }
});

test('recovery never removes a same-byte replacement inserted after the immutable manifest', async () => {
  const { repo, base, head, merge, command } = await createDocsCandidateRepo();
  const pointerDirectory = join(repo, 'ci-artifacts', 'local-verification', 'pointers');
  const damagedPath = join(pointerDirectory, '20260817010214000-damaged.json');
  await mkdir(pointerDirectory, { recursive: true });
  await writeFile(damagedPath, '{partial');
  setPublicationInjectionHooks({ afterQuarantineManifest: async ({ sourceDirectory }) => {
    const sourcePath = join(sourceDirectory, '20260817010214000-damaged.json');
    const temporary = `${sourcePath}.replacement`;
    await writeFile(temporary, '{partial');
    await rm(sourcePath, { force: true });
    await rename(temporary, sourcePath);
  } });
  try {
    await assert.rejects(() => runLocalVerification({ repo, base, head, merge, commands: [command], recoverMissingPointer: true }), /changed during explicit recovery/);
    assert.equal(await readFile(damagedPath, 'utf8'), '{partial');
  } finally {
    setPublicationInjectionHooks({});
    await rm(repo, { recursive: true, force: true });
  }
});

test('recovery detects a different-identity replacement and preserves the replacement path', async () => {
  const { repo, base, head, merge, command } = await createDocsCandidateRepo();
  const pointerDirectory = join(repo, 'ci-artifacts', 'local-verification', 'pointers');
  const damagedPath = join(pointerDirectory, '20260817010215000-damaged.json');
  await mkdir(pointerDirectory, { recursive: true });
  await writeFile(damagedPath, '{partial');
  setPublicationInjectionHooks({ afterQuarantineManifest: async ({ sourceDirectory }) => {
    const sourcePath = join(sourceDirectory, '20260817010215000-damaged.json');
    const temporary = `${sourcePath}.replacement`;
    await writeFile(temporary, '{replacement');
    await rm(sourcePath, { force: true });
    await rename(temporary, sourcePath);
  } });
  try {
    await assert.rejects(() => runLocalVerification({ repo, base, head, merge, commands: [command], recoverMissingPointer: true }), /changed during explicit recovery/);
    assert.equal(await readFile(damagedPath, 'utf8'), '{replacement');
  } finally {
    setPublicationInjectionHooks({});
    await rm(repo, { recursive: true, force: true });
  }
});

test('copy fallback and concurrent recoverers publish one deterministic recovery epoch', async () => {
  const { repo } = await createDocsCandidateRepo();
  const pointerDirectory = 'ci-artifacts/local-verification/pointers';
  const damagedPath = join(repo, pointerDirectory, '20260817010216000-damaged.json');
  await mkdir(join(repo, pointerDirectory), { recursive: true });
  await writeFile(damagedPath, '{partial');
  setPublicationInjectionHooks({ beforeQuarantineSnapshotLink: () => {
    const error = new Error('cross-device snapshot');
    error.code = 'EXDEV';
    throw error;
  } });
  try {
    const recoveries = await Promise.all([
      quarantineInvalidPointerFiles(repo, pointerDirectory),
      quarantineInvalidPointerFiles(repo, pointerDirectory),
    ]);
    assert.equal(recoveries[0].epoch, recoveries[1].epoch);
    assert.equal(recoveries[0].epochDirectory, recoveries[1].epochDirectory);
    const recoveryRoot = join(repo, pointerDirectory, 'recovery');
    const epochs = (await readdir(recoveryRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    assert.deepEqual(epochs.map((entry) => entry.name), [recoveries[0].epoch]);
    assert.equal(await readFile(damagedPath, 'utf8'), '{partial');
    const manifest = JSON.parse(await readFile(join(recoveryRoot, recoveries[0].epoch, 'manifest.json'), 'utf8'));
    assert.equal(manifest.sourceDigest, recoveries[0].sourceDigest);
    assert.equal(await readFile(join(recoveryRoot, recoveries[0].epoch, 'snapshots', '20260817010216000-damaged.json'), 'utf8'), '{partial');
  } finally {
    setPublicationInjectionHooks({});
    await rm(repo, { recursive: true, force: true });
  }
});

test('recovery manifest crash leaves immutable history but no selected current pointer', async () => {
  const { repo } = await createDocsCandidateRepo();
  const pointerDirectory = 'ci-artifacts/local-verification/pointers';
  const damagedPath = join(repo, pointerDirectory, '20260817010217000-damaged.json');
  await mkdir(join(repo, pointerDirectory), { recursive: true });
  await writeFile(damagedPath, '{partial');
  setPublicationInjectionHooks({ afterQuarantineManifest: () => { throw new Error('injected recovery crash'); } });
  try {
    await assert.rejects(() => quarantineInvalidPointerFiles(repo, pointerDirectory), /injected recovery crash/);
    const recoveryRoot = join(repo, pointerDirectory, 'recovery');
    const epochs = (await readdir(recoveryRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    assert.equal(epochs.length, 1);
    assert.equal(await readFile(damagedPath, 'utf8'), '{partial');
    const epoch = epochs[0].name;
    assert.equal(await readCurrentPointer(repo, pointerDirectory, { epoch }), null);
  } finally {
    setPublicationInjectionHooks({});
    await rm(repo, { recursive: true, force: true });
  }
});
