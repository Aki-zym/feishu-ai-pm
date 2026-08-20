import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/i;
const ACTIONS_ID = /^[1-9][0-9]*$/;

const unavailable = (reason) => ({ status: 'unavailable', reason });
const failed = (reason) => ({ status: 'failed', reason });

function controlledApiUrl(value, expectedPath) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'api.github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.pathname === expectedPath
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

function controlledGitHubUrl(value, expectedPath) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.pathname === expectedPath
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

function controlledApiBase(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'api.github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && (url.pathname === '' || url.pathname === '/')
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

/**
 * Verify the remote part of an exact pull_request evidence record.
 * The local evidence checker proves only Git-object relationships. This
 * optional verifier is deliberately fail-closed when a trusted GitHub event,
 * workflow/check identity, or repository binding is not available.
 */
export async function verifyGitHubExactProvenance(provenance, {
  owner,
  repo,
  workflowId,
  workflowName,
  checkName,
  sourceCommit,
  eventName = 'pull_request',
  fetchImpl = globalThis.fetch,
  apiBase = 'https://api.github.com',
  token,
} = {}) {
  if (!provenance || provenance.mode !== 'exact_merge_ref_ci') return unavailable('exact_merge_ref_ci provenance is required');
  if (!SHA.test(provenance.base_commit ?? '') || !SHA.test(provenance.head_commit ?? '') || !SHA.test(provenance.merge_ref ?? '') || !SHA.test(provenance.tree ?? '')) {
    return failed('exact provenance SHA fields are invalid');
  }
  if (!Array.isArray(provenance.parents) || provenance.parents.length !== 2 || provenance.parents[0] !== provenance.base_commit || provenance.parents[1] !== provenance.head_commit) {
    return failed('exact provenance parents are not [base_commit, head_commit]');
  }
  if (!ACTIONS_ID.test(provenance.run_id ?? '') || !ACTIONS_ID.test(provenance.job_id ?? '')) return failed('exact provenance run/job ids are invalid');
  if (sourceCommit === undefined || sourceCommit === null || sourceCommit === '') return unavailable('trusted source commit is unavailable');
  if (!SHA.test(sourceCommit) || sourceCommit !== provenance.head_commit) return failed('source_commit must equal the exact head commit');
  if (typeof fetchImpl !== 'function') return unavailable('GitHub remote verifier is unavailable offline');
  if (typeof owner !== 'string' || owner.trim() === '' || typeof repo !== 'string' || repo.trim() === '') return unavailable('GitHub repository identity is unavailable');
  if (!ACTIONS_ID.test(String(workflowId ?? ''))) return unavailable('trusted GitHub workflow identity is unavailable');
  if (typeof checkName !== 'string' || checkName.trim() === '' || checkName === 'not_run' || checkName === 'unrecorded') return unavailable('trusted GitHub check identity is unavailable');
  if (eventName !== 'pull_request') return failed('exact evidence must be verified from a pull_request event');
  if (!controlledApiBase(apiBase)) return unavailable('GitHub API base is unavailable or not controlled');

  const expectedRepository = `${owner}/${repo}`;
  const base = `${String(apiBase).replace(/\/$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const authToken = typeof token === 'string' && token.trim() !== ''
    ? token.trim()
    : (process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || undefined);
  const get = async (path) => {
    try {
      const headers = { accept: 'application/vnd.github+json' };
      if (authToken) headers.authorization = `Bearer ${authToken}`;
      const response = await fetchImpl(`${base}${path}`, { headers, redirect: 'error' });
      if (!response || typeof response.json !== 'function') return { kind: 'unavailable', reason: 'GitHub response is unavailable' };
      if (response.redirected === true) return { kind: 'unavailable', reason: 'GitHub API redirect is not allowed' };
      if (typeof response.url === 'string' && response.url !== '' && response.url !== `${base}${path}`) return { kind: 'unavailable', reason: 'GitHub API response URL is not controlled' };
      const body = await response.json();
      if (!response.ok) return { kind: 'unavailable', reason: `GitHub API unavailable (${response.status ?? 'unknown'})` };
      return { kind: 'ok', body };
    } catch {
      return { kind: 'unavailable', reason: 'GitHub API request failed or is offline' };
    }
  };
  const [run, job, baseCommit, headCommit, merge] = await Promise.all([
    get(`/actions/runs/${provenance.run_id}`),
    get(`/actions/jobs/${provenance.job_id}`),
    get(`/commits/${provenance.base_commit}`),
    get(`/commits/${provenance.head_commit}`),
    get(`/commits/${provenance.merge_ref}`),
  ]);
  for (const response of [run, job, baseCommit, headCommit, merge]) if (response.kind !== 'ok') return unavailable(response.reason);

  for (const [label, response, expectedSha] of [['base', baseCommit, provenance.base_commit], ['head', headCommit, provenance.head_commit], ['merge', merge, provenance.merge_ref]]) {
    if (response.body?.sha !== expectedSha) return failed(`GitHub ${label} commit object does not match the declared SHA`);
  }
  if (run.body?.event !== eventName || run.body?.status !== 'completed' || run.body?.conclusion !== 'success') return failed('GitHub Actions run is not a successful pull_request completion');
  if (run.body?.repository?.full_name !== undefined && run.body.repository.full_name !== expectedRepository) return failed('GitHub Actions run is from the wrong repository');
  if (run.body?.head_sha !== provenance.head_commit) return failed('GitHub Actions run head_sha does not match head_commit');
  if (String(run.body?.workflow_id ?? '') !== String(workflowId)) return failed('GitHub Actions run workflow_id does not match the trusted workflow');
  if (workflowName !== undefined && run.body?.name !== workflowName) return failed('GitHub Actions run name does not match the trusted workflow');
  if (job.body?.status !== 'completed' || job.body?.conclusion !== 'success') return failed('GitHub Actions job is not a successful completion');
  if (String(job.body?.run_id ?? '') !== String(provenance.run_id)) return failed('GitHub Actions job is not bound to the declared run');
  if (!controlledApiUrl(job.body?.run_url, `/repos/${owner}/${repo}/actions/runs/${provenance.run_id}`)) return failed('GitHub Actions job run_url is not bound to the declared repository/run');
  const checkRunPath = /^\/repos\/([^/]+)\/([^/]+)\/check-runs\/([1-9][0-9]*)$/;
  let checkRunUrl;
  try { checkRunUrl = new URL(job.body?.check_run_url ?? ''); } catch { checkRunUrl = null; }
  if (!checkRunUrl || checkRunUrl.protocol !== 'https:' || checkRunUrl.hostname !== 'api.github.com' || checkRunUrl.search !== '' || checkRunUrl.hash !== '') return failed('GitHub Actions job check_run_url is not a controlled api.github.com URL');
  const checkRunMatch = checkRunPath.exec(checkRunUrl.pathname);
  if (!checkRunMatch || checkRunMatch[1] !== owner || checkRunMatch[2] !== repo) return failed('GitHub Actions job check_run_url is not bound to the declared repository');
  const expectedCheckRunUrl = `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunMatch[3]}`;
  if (job.body.check_run_url !== expectedCheckRunUrl) return failed('GitHub Actions job check_run_url is not the exact controlled check-run URL');
  if (job.body?.head_sha !== undefined && job.body.head_sha !== provenance.head_commit) return failed('GitHub Actions job head_sha does not match head_commit');
  if (job.body?.name !== undefined && job.body.name !== checkName) return failed('GitHub Actions job name does not match the trusted check');
  if (workflowName !== undefined && job.body?.workflow_name !== undefined && job.body.workflow_name !== workflowName) return failed('GitHub Actions job workflow_name does not match the trusted workflow');
  const exactCheck = await get(`/check-runs/${checkRunMatch[3]}`);
  if (exactCheck.kind !== 'ok') return unavailable(exactCheck.reason);
  if (!ACTIONS_ID.test(String(exactCheck.body?.id ?? '')) || String(exactCheck.body.id) !== checkRunMatch[3]) return failed('exact check-run id does not match the controlled check_run_url');
  if (!controlledApiUrl(exactCheck.body?.url, `/repos/${owner}/${repo}/check-runs/${checkRunMatch[3]}`) || exactCheck.body.url !== expectedCheckRunUrl) return failed('exact check-run URL is not controlled');
  if (exactCheck.body?.name !== checkName) return failed('exact check-run name does not match the trusted check');
  if (exactCheck.body?.status !== 'completed' || exactCheck.body?.conclusion !== 'success') return failed('exact check-run is not a terminal SUCCESS');
  if (exactCheck.body?.head_sha !== provenance.head_commit) return failed('exact check-run head_sha does not match head_commit');
  if (!controlledGitHubUrl(exactCheck.body?.details_url, `/${owner}/${repo}/actions/runs/${provenance.run_id}/job/${provenance.job_id}`)) return failed('exact check-run details_url is not bound to the declared repository/run/job');
  const parents = Array.isArray(merge.body?.parents) ? merge.body.parents.map((parent) => parent?.sha) : [];
  if (parents.length !== 2 || parents[0] !== provenance.base_commit || parents[1] !== provenance.head_commit) return failed('GitHub merge ref does not have the declared parents');
  if (merge.body?.commit?.tree?.sha !== provenance.tree) return failed('GitHub merge ref tree does not match tree');
  return { status: 'verified', repository: expectedRepository, workflow_id: String(workflowId), check_name: checkName, run_id: provenance.run_id, job_id: provenance.job_id, head_commit: provenance.head_commit, merge_ref: provenance.merge_ref };
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const provenance = {
    mode: 'exact_merge_ref_ci',
    base_commit: process.env.CI_BASE_SHA,
    head_commit: process.env.CI_HEAD_SHA,
    merge_ref: process.env.CI_MERGE_SHA,
    parents: [process.env.CI_BASE_SHA, process.env.CI_HEAD_SHA],
    tree: process.env.CI_MERGE_TREE,
    run_id: process.env.CI_RUN_ID,
    job_id: process.env.CI_JOB_ID,
  };
  const result = await verifyGitHubExactProvenance(provenance, {
    owner: process.env.GITHUB_REPOSITORY_OWNER,
    repo: process.env.GITHUB_REPOSITORY?.split('/')[1],
    workflowId: process.env.CI_WORKFLOW_ID,
    workflowName: process.env.CI_WORKFLOW_NAME,
    checkName: process.env.CI_CHECK_NAME,
    sourceCommit: process.env.CI_SOURCE_COMMIT,
    eventName: process.env.CI_EVENT_NAME,
    token: process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim(),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'verified') process.exitCode = 2;
}
