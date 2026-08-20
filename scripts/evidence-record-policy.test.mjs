import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  evidenceRecordContractErrors,
  provenanceErrors,
  skipClassificationErrors,
} from './evidence-record-policy.mjs';
import { verifyGitHubExactProvenance } from './verify-github-provenance.mjs';

const sha = (char) => char.repeat(40);
const exact = {
  mode: 'exact_merge_ref_ci',
  base_commit: sha('a'),
  head_commit: sha('b'),
  merge_ref: sha('c'),
  parents: [sha('a'), sha('b')],
  tree: sha('d'),
  run_id: '31900000000',
  job_id: '95100000000',
  environment: 'GitHub Actions ubuntu-latest; Node.js 24',
  command: 'npm run check',
};

test('exact merge provenance requires [base, head] parents and executable identity', () => {
  assert.deepEqual(provenanceErrors(exact, { sourceCommit: sha('b'), recordStatus: 'attained' }), []);
  assert.match(provenanceErrors({ ...exact, parents: [sha('b'), sha('a')] }).join('\n'), /parents/);
  assert.match(provenanceErrors({ ...exact, merge_ref: 'not_run' }).join('\n'), /merge_ref/);
});

test('exact provenance rejects sentinels, wrong parent count/order, unrelated source, and fake run identities', () => {
  for (const parents of [[], [sha('a')], [sha('a'), sha('b'), sha('c')], [sha('b'), sha('a')]]) {
    assert.notDeepEqual(provenanceErrors({ ...exact, parents }, { sourceCommit: sha('b'), recordStatus: 'attained' }), []);
  }
  for (const field of ['base_commit', 'head_commit', 'merge_ref', 'tree']) {
    assert.match(provenanceErrors({ ...exact, [field]: 'not_run' }).join('\n'), new RegExp(field));
  }
  assert.match(provenanceErrors({ ...exact, head_commit: 'not_run', parents: [sha('a'), 'not_run'] }).join('\n'), /head_commit/);
  assert.match(provenanceErrors({ ...exact, run_id: 'fake', job_id: 'not_run' }).join('\n'), /run_id|job_id/);
  assert.match(provenanceErrors(exact, { sourceCommit: sha('c'), recordStatus: 'attained' }).join('\n'), /source_commit/);
});

test('exact provenance cross-binds record fields and checks available Git objects', () => {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === 'rev-list') return `${sha('c')} ${sha('a')} ${sha('b')}`;
    if (args[0] === 'show') return sha('d');
    return '';
  };
  assert.deepEqual(provenanceErrors(exact, {
    sourceCommit: sha('b'),
    recordStatus: 'attained',
    recordRunId: exact.run_id,
    recordEnvironment: exact.environment,
    recordCommand: exact.command,
    git,
  }), []);
  assert.equal(calls.some((args) => args[0] === 'rev-list'), true);
  assert.match(provenanceErrors(exact, {
    sourceCommit: sha('b'), recordStatus: 'attained', recordRunId: 'other', git,
  }).join('\n'), /record.run_id/);
  assert.match(provenanceErrors(exact, {
    sourceCommit: sha('b'), recordStatus: 'attained', recordEnvironment: 'other', git,
  }).join('\n'), /record.environment/);
  assert.match(provenanceErrors(exact, {
    sourceCommit: sha('b'), recordStatus: 'attained', recordCommand: 'other', git,
  }).join('\n'), /record.command/);
});

test('exact provenance rejects missing or mismatched Git merge objects', () => {
  const missing = () => { throw new Error('missing'); };
  const errors = provenanceErrors(exact, { sourceCommit: sha('b'), recordStatus: 'attained', git: missing }).join('\n');
  assert.match(errors, /不存在|无法读取/);
  const wrong = (args) => {
    if (args[0] === 'rev-list') return `${sha('c')} ${sha('b')} ${sha('a')}`;
    if (args[0] === 'show') return sha('e');
    return '';
  };
  const wrongErrors = provenanceErrors(exact, { sourceCommit: sha('b'), recordStatus: 'attained', git: wrong }).join('\n');
  assert.match(wrongErrors, /实际 parents|实际 tree/);
});

test('exact provenance uses a complete typed Git object expression', () => {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === 'rev-list') return sha('c') + ' ' + sha('a') + ' ' + sha('b');
    if (args[0] === 'show') return sha('d');
    return '';
  };
  assert.deepEqual(provenanceErrors(exact, { sourceCommit: sha('b'), recordStatus: 'attained', git }), []);
  const objectChecks = calls.filter((args) => args[0] === 'cat-file');
  assert.equal(objectChecks.length, 5);
  assert.equal(objectChecks.every((args) => /^[a-f]{40}\^\{(?:commit|tree)\}$/.test(args[2])), true);
});

test('provenance and skip objects reject extra keys and unsafe combinations', () => {
  assert.match(provenanceErrors({ ...exact, credential: 'secret-canary' }).join('\n'), /不是受控字段/);
  const local = {
    mode: 'local_run',
    base_commit: 'not_applicable',
    head_commit: sha('b'),
    merge_ref: 'not_applicable',
    parents: [sha('a')],
    tree: 'not_applicable',
    run_id: 'local-run',
    job_id: 'not_applicable',
    environment: 'synthetic local',
    command: 'node test.mjs',
  };
  assert.match(provenanceErrors(local).join('\n'), /parents/);
  assert.match(skipClassificationErrors({ status: 'present', kinds: ['none'], reason: 'bad' }).join('\n'), /有跳过/);
  assert.match(skipClassificationErrors({ status: 'present', kinds: ['capability', 'capability'], reason: 'bad' }).join('\n'), /重复/);
  assert.match(skipClassificationErrors({ status: 'none', kinds: ['capability'], reason: 'bad' }).join('\n'), /没有跳过/);
  assert.match(skipClassificationErrors({ status: 'none', kinds: [], reason: 'bad', token: 'secret' }).join('\n'), /不是受控字段/);
});

test('evidence records reject unknown top-level keys and attained records require v1', () => {
  const base = {
    evidence_status: 'not_run',
    attained_level: null,
    source_commit: 'unverified',
  };
  assert.match(evidenceRecordContractErrors({ ...base, credential: 'secret-canary' }, { grandfathered: true }).join('\n'), /record\.credential/);
  assert.match(evidenceRecordContractErrors({ ...base, artifact: { sha256: 'a'.repeat(64), secret: 'canary' } }, { grandfathered: true }).join('\n'), /record\.artifact\.secret/);
  assert.match(evidenceRecordContractErrors({ ...base, evidence_status: 'attained' }, { grandfathered: true }).join('\n'), /evidence_contract_version/);
  assert.match(evidenceRecordContractErrors({ ...base, evidence_status: 'attained', evidence_contract_version: 1 }, { grandfathered: true }).join('\n'), /provenance|skip_classification/);
});

test('exact provenance validates real Git commit, merge, and tree objects', () => {
  const repo = mkdtempSync(join(tmpdir(), 'evidence-real-git-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (...args) => git(args).trim();
  try {
    run('init', '-q');
    run('config', 'user.email', 'evidence@example.invalid');
    run('config', 'user.name', 'Evidence Test');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    run('add', '.');
    run('commit', '-qm', 'base');
    const base = run('rev-parse', 'HEAD');

    run('checkout', '-qb', 'feature');
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    run('add', '.');
    run('commit', '-qm', 'feature');
    const head = run('rev-parse', 'HEAD');

    run('checkout', '-qb', 'integration', base);
    writeFileSync(join(repo, 'integration.txt'), 'integration\n');
    run('add', '.');
    run('commit', '-qm', 'integration');
    const mergeBase = run('rev-parse', 'HEAD');
    run('merge', '--no-ff', '-q', '--no-edit', 'feature');
    const mergeRef = run('rev-parse', 'HEAD');
    const tree = run('show', '-s', '--format=%T', mergeRef);
    const provenance = {
      mode: 'exact_merge_ref_ci',
      base_commit: mergeBase,
      head_commit: head,
      merge_ref: mergeRef,
      parents: [mergeBase, head],
      tree,
      run_id: '31900000000',
      job_id: '95100000000',
      environment: 'temporary real Git repository',
      command: 'evidence provenance integration test',
    };
    assert.deepEqual(provenanceErrors(provenance, {
      sourceCommit: head,
      recordStatus: 'attained',
      git,
    }), []);

    const missing = { ...provenance, tree: 'f'.repeat(40) };
    assert.match(provenanceErrors(missing, { sourceCommit: head, recordStatus: 'attained', git }).join('\n'), /不存在/);

    const baseTree = run('show', '-s', '--format=%T', mergeBase);
    const mismatched = { ...provenance, tree: baseTree };
    assert.notEqual(baseTree, tree);
    assert.match(provenanceErrors(mismatched, { sourceCommit: head, recordStatus: 'attained', git }).join('\n'), /实际 tree/);

    const calls = [];
    const recordingGit = (args) => {
      calls.push(args);
      return git(args);
    };
    assert.deepEqual(provenanceErrors(provenance, { sourceCommit: head, recordStatus: 'attained', git: recordingGit }), []);
    assert.ok(calls.some((args) => args[0] === 'cat-file' && args[2] === `${mergeBase}^{commit}`));
    assert.ok(calls.some((args) => args[0] === 'cat-file' && args[2] === `${tree}^{tree}`));
    assert.match(provenanceErrors({ ...provenance, merge_ref: 'f'.repeat(40) }, { sourceCommit: head, recordStatus: 'attained', git }).join('\n'), /不存在|无法读取/);
    assert.match(provenanceErrors({ ...provenance, tree: mergeRef }, { sourceCommit: head, recordStatus: 'attained', git }).join('\n'), /实际 tree|不存在/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('remote exact provenance is verified when available and unavailable is not success', async () => {
  const exactRemote = {
    mode: 'exact_merge_ref_ci',
    base_commit: 'a'.repeat(40),
    head_commit: 'b'.repeat(40),
    merge_ref: 'c'.repeat(40),
    parents: ['a'.repeat(40), 'b'.repeat(40)],
    tree: 'd'.repeat(40),
    run_id: '31900000000',
    job_id: '95100000000',
  };
  const remoteOptions = { owner: 'acme', repo: 'pm', workflowId: '123456', workflowName: 'CI', checkName: 'verify', sourceCommit: exactRemote.head_commit, token: null };
  const payloads = new Map([
    ['/actions/runs/31900000000', { repository: { full_name: 'acme/pm' }, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: exactRemote.head_commit, workflow_id: 123456 }],
    ['/actions/jobs/95100000000', { run_id: 31900000000, status: 'completed', conclusion: 'success', head_sha: exactRemote.head_commit, name: 'verify', workflow_name: 'CI', run_url: 'https://api.github.com/repos/acme/pm/actions/runs/31900000000', check_run_url: 'https://api.github.com/repos/acme/pm/check-runs/777' }],
    ['/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { sha: exactRemote.base_commit, commit: { tree: { sha: 'e'.repeat(40) } }, parents: [] }],
    ['/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { sha: exactRemote.head_commit, commit: { tree: { sha: 'f'.repeat(40) } }, parents: [] }],
    ['/commits/cccccccccccccccccccccccccccccccccccccccc', { sha: exactRemote.merge_ref, parents: [{ sha: exactRemote.base_commit }, { sha: exactRemote.head_commit }], commit: { tree: { sha: exactRemote.tree } } }],
    ['/check-runs/778', { id: 778, name: 'verify', url: 'https://api.github.com/repos/acme/pm/check-runs/778', details_url: 'https://github.com/acme/pm/actions/runs/31900000000/job/95100000000', status: 'completed', conclusion: 'success', head_sha: exactRemote.head_commit }],
    ['/check-runs/777', { id: 777, name: 'verify', url: 'https://api.github.com/repos/acme/pm/check-runs/777', details_url: 'https://github.com/acme/pm/actions/runs/31900000000/job/95100000000', status: 'completed', conclusion: 'success', head_sha: exactRemote.head_commit }],
  ]);
  const requested = [];
  const requestHeaders = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname.replace('/repos/acme/pm', '');
    requested.push(path);
    requestHeaders.push(options.headers ?? {});
    const body = payloads.get(path);
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
  };
  assert.equal((await verifyGitHubExactProvenance(exactRemote, { ...remoteOptions, fetchImpl })).status, 'verified');
  assert.equal(requestHeaders.every((headers) => !Object.hasOwn(headers, 'authorization')), true);
  assert.equal(requested.includes('/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs'), false);
  assert.equal(requested.includes('/commits/cccccccccccccccccccccccccccccccccccccccc/check-runs'), false);
  assert.equal(requested.includes('/check-runs/777'), true);
  assert.equal((await verifyGitHubExactProvenance(exactRemote, { owner: 'acme', repo: 'pm' })).status, 'unavailable');

  const token = 'synthetic-test-token';
  const authenticatedHeaders = [];
  const authenticatedFetch = async (url, options = {}) => {
    authenticatedHeaders.push(options.headers ?? {});
    const path = new URL(url).pathname.replace('/repos/acme/pm', '');
    const body = payloads.get(path);
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
  };
  const authenticated = await verifyGitHubExactProvenance(exactRemote, { ...remoteOptions, token, fetchImpl: authenticatedFetch });
  assert.equal(authenticated.status, 'verified');
  assert.equal(authenticatedHeaders.length > 0, true);
  assert.equal(authenticatedHeaders.every((headers) => headers.authorization === `Bearer ${token}`), true);
  assert.equal(JSON.stringify(authenticated).includes(token), false);

  const savedGitHubToken = process.env.GITHUB_TOKEN;
  const savedGhToken = process.env.GH_TOKEN;
  try {
    for (const variable of ['GITHUB_TOKEN', 'GH_TOKEN']) {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      process.env[variable] = token;
      const envHeaders = [];
      const fromEnvironment = await verifyGitHubExactProvenance(exactRemote, {
        ...remoteOptions,
        token: undefined,
        fetchImpl: async (url, options = {}) => {
          envHeaders.push(options.headers ?? {});
          const path = new URL(url).pathname.replace('/repos/acme/pm', '');
          const body = payloads.get(path);
          return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
        },
      });
      assert.equal(fromEnvironment.status, 'verified');
      assert.equal(envHeaders.every((headers) => headers.authorization === `Bearer ${token}`), true);
      assert.equal(JSON.stringify(fromEnvironment).includes(token), false);
    }
  } finally {
    if (savedGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGitHubToken;
    if (savedGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedGhToken;
  }

  for (const status of [401, 403, 404]) {
    const denied = await verifyGitHubExactProvenance(exactRemote, {
      ...remoteOptions,
      token,
      fetchImpl: async () => ({ ok: false, status, json: async () => ({ message: 'denied' }) }),
    });
    assert.equal(denied.status, 'unavailable');
    assert.equal(JSON.stringify(denied).includes(token), false);
  }
  const unauthenticatedPrivate = await verifyGitHubExactProvenance(exactRemote, {
    ...remoteOptions,
    fetchImpl: async (_url, options = {}) => {
      assert.equal(Object.hasOwn(options.headers ?? {}, 'authorization'), false);
      return { ok: false, status: 404, json: async () => ({ message: 'private repository not readable' }) };
    },
  });
  assert.equal(unauthenticatedPrivate.status, 'unavailable');

  let foreignApiCalled = false;
  const foreignApi = await verifyGitHubExactProvenance(exactRemote, {
    ...remoteOptions,
    token,
    apiBase: 'https://evil.example.invalid',
    fetchImpl: async () => {
      foreignApiCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(foreignApi.status, 'unavailable');
  assert.equal(foreignApiCalled, false);

  const redirectRequests = [];
  const redirected = await verifyGitHubExactProvenance(exactRemote, {
    ...remoteOptions,
    token,
    fetchImpl: async (_url, options = {}) => {
      redirectRequests.push(options);
      return { ok: false, status: 302, redirected: false, url: 'https://evil.example.invalid/leak', json: async () => ({}) };
    },
  });
  assert.equal(redirected.status, 'unavailable');
  assert.equal(redirectRequests.length > 0, true);
  assert.equal(redirectRequests.every((options) => options.redirect === 'error'), true);
  assert.equal(JSON.stringify(redirected).includes(token), false);

  const withPayload = (path, value) => {
    const next = new Map(payloads);
    next.set(path, value);
    return async (url) => {
      const key = new URL(url).pathname.replace('/repos/acme/pm', '');
      const body = next.get(key);
      return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
    };
  };
  const withPayloads = (overrides) => async (url) => {
    const key = new URL(url).pathname.replace('/repos/acme/pm', '');
    const body = overrides.has(key) ? overrides.get(key) : payloads.get(key);
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => ({}) };
  };
  const runWithoutRepository = { ...payloads.get('/actions/runs/31900000000') };
  delete runWithoutRepository.repository;
  assert.equal(Object.hasOwn(runWithoutRepository, 'workflow_name'), false);
  assert.equal((await verifyGitHubExactProvenance(exactRemote, { ...remoteOptions, fetchImpl: withPayload('/actions/runs/31900000000', runWithoutRepository) })).status, 'verified');

  const assertFailed = async (path, value) => assert.equal((await verifyGitHubExactProvenance(exactRemote, { ...remoteOptions, fetchImpl: withPayload(path, value) })).status, 'failed');
  await assertFailed('/actions/runs/31900000000', { repository: { full_name: 'other/pm' }, event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: exactRemote.head_commit, workflow_id: 123456, workflow_name: 'CI' });
  await assertFailed('/actions/jobs/95100000000', { ...payloads.get('/actions/jobs/95100000000'), run_id: 31900000001 });
  await assertFailed('/actions/jobs/95100000000', { ...payloads.get('/actions/jobs/95100000000'), run_url: 'https://api.github.com/repos/acme/pm/actions/runs/31900000001' });
  await assertFailed('/actions/jobs/95100000000', { ...payloads.get('/actions/jobs/95100000000'), check_run_url: 'https://example.invalid/repos/acme/pm/check-runs/777' });
  await assertFailed('/actions/jobs/95100000000', { ...payloads.get('/actions/jobs/95100000000'), check_run_url: 'https://api.github.com/repos/other/pm/check-runs/777' });
  await assertFailed('/actions/jobs/95100000000', { ...payloads.get('/actions/jobs/95100000000'), check_run_url: 'https://api.github.com/repos/acme/pm/check-runs/777?attempt=2' });
  await assertFailed('/actions/jobs/95100000000', { ...payloads.get('/actions/jobs/95100000000'), check_run_url: 'https://api.github.com/repos/acme/pm/check-runs/777#fragment' });
  await assertFailed('/actions/jobs/95100000000', { ...payloads.get('/actions/jobs/95100000000'), workflow_name: 'Other' });
  const wrongCheckRunId = await verifyGitHubExactProvenance(exactRemote, {
    ...remoteOptions,
    fetchImpl: withPayloads(new Map([
      ['/actions/jobs/95100000000', { ...payloads.get('/actions/jobs/95100000000'), check_run_url: 'https://api.github.com/repos/acme/pm/check-runs/778' }],
      ['/check-runs/778', { ...payloads.get('/check-runs/778'), id: 777, url: 'https://api.github.com/repos/acme/pm/check-runs/777' }],
    ])),
  });
  assert.equal(wrongCheckRunId.status, 'failed');
  const exactCheck = payloads.get('/check-runs/777');
  await assertFailed('/check-runs/777', { ...exactCheck, id: 778 });
  await assertFailed('/check-runs/777', { ...exactCheck, name: 'other' });
  await assertFailed('/check-runs/777', { ...exactCheck, head_sha: exactRemote.merge_ref });
  await assertFailed('/check-runs/777', { ...exactCheck, status: 'queued' });
  await assertFailed('/check-runs/777', { ...exactCheck, conclusion: 'failure' });
  await assertFailed('/check-runs/777', { ...payloads.get('/check-runs/777'), details_url: 'https://example.invalid/actions/runs/31900000000/job/95100000000' });
  await assertFailed('/actions/runs/31900000000', { ...payloads.get('/actions/runs/31900000000'), workflow_id: 654321, name: 'Other' });
  await assertFailed('/actions/jobs/95100000000', { ...payloads.get('/actions/jobs/95100000000'), name: 'other' });
  const mergeOnly = await verifyGitHubExactProvenance(exactRemote, { ...remoteOptions, fetchImpl: withPayload('/check-runs/777', { ...exactCheck, head_sha: exactRemote.merge_ref }) });
  assert.equal(mergeOnly.status, 'failed');
  const missingCheck = await verifyGitHubExactProvenance(exactRemote, { ...remoteOptions, fetchImpl: withPayload('/check-runs/777', {}) });
  assert.notEqual(missingCheck.status, 'verified');
  await assertFailed('/commits/cccccccccccccccccccccccccccccccccccccccc', { ...payloads.get('/commits/cccccccccccccccccccccccccccccccccccccccc'), parents: [{ sha: exactRemote.head_commit }, { sha: exactRemote.base_commit }] });
  await assertFailed('/commits/cccccccccccccccccccccccccccccccccccccccc', { ...payloads.get('/commits/cccccccccccccccccccccccccccccccccccccccc'), commit: { tree: { sha: 'e'.repeat(40) } } });
  const failed = await verifyGitHubExactProvenance(exactRemote, { ...remoteOptions, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ event: 'push' }) }) });
  assert.equal(failed.status, 'failed');
});

test('local evidence binds the head to the source and keeps CI fields explicit', () => {
  const local = {
    mode: 'local_run',
    base_commit: 'not_applicable',
    head_commit: sha('b'),
    merge_ref: 'not_applicable',
    parents: [],
    tree: 'not_applicable',
    run_id: 'local-qa-01',
    job_id: 'not_applicable',
    environment: 'Windows local; Node.js 24; synthetic fixtures',
    command: 'npm run ci:policy:test',
  };
  assert.deepEqual(provenanceErrors(local, {
    sourceCommit: sha('b'),
    recordStatus: 'attained',
    recordRunId: local.run_id,
    recordEnvironment: local.environment,
    recordCommand: local.command,
  }), []);
  assert.match(provenanceErrors({ ...local, head_commit: sha('c') }, { sourceCommit: sha('b'), recordStatus: 'attained' }).join('\n'), /head_commit/);
  assert.match(provenanceErrors({ ...local, job_id: '95100000000' }).join('\n'), /job_id/);
});

test('not_run provenance is explicit and cannot be upgraded by wording', () => {
  const notRun = {
    mode: 'not_run',
    base_commit: 'not_run',
    head_commit: 'not_run',
    merge_ref: 'not_run',
    parents: [],
    tree: 'not_run',
    run_id: 'not_run',
    job_id: 'not_run',
    environment: 'not_run',
    command: 'not_run',
  };
  assert.deepEqual(provenanceErrors(notRun, { sourceCommit: 'unverified', recordStatus: 'not_run' }), []);
  assert.match(provenanceErrors({ ...notRun, run_id: 'local-run' }, { recordStatus: 'not_run' }).join('\n'), /not_run 的 run_id/);
});

test('capability/platform skips are distinct from unexecuted evidence', () => {
  assert.deepEqual(skipClassificationErrors({ status: 'present', kinds: ['capability', 'platform'], reason: 'Windows installer is unavailable on Linux CI' }, { evidenceStatus: 'attained', attainedLevel: 'L4' }), []);
  assert.match(skipClassificationErrors({ status: 'present', kinds: ['not_executed'], reason: 'test was not run' }, { evidenceStatus: 'attained', attainedLevel: 'L4' }).join('\n'), /not_executed/);
});

test('contract version fails closed when provenance or skip classification is missing', () => {
  const record = { evidence_contract_version: 1, evidence_status: 'not_run', attained_level: null, source_commit: 'unverified' };
  const errors = evidenceRecordContractErrors(record).join('\n');
  assert.match(errors, /provenance/);
  assert.match(errors, /skip_classification/);
});

test('new or modified records cannot omit the v1 contract', () => {
  const record = { evidence_status: 'not_run', attained_level: null, source_commit: 'unverified' };
  assert.match(evidenceRecordContractErrors(record, { requireProvenance: true, grandfathered: false }).join('\n'), /evidence_contract_version/);
  assert.deepEqual(evidenceRecordContractErrors(record, { grandfathered: true }), []);
  assert.match(evidenceRecordContractErrors({ ...record, evidence_contract_version: 2 }, { grandfathered: true }).join('\n'), /必须是 1/);
});
