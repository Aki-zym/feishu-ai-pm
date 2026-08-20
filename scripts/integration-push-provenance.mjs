import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/i;

function controlledApiBase(value) {
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

export function selectMergedPullRequest(pulls, { repository, branch, mergeSha }) {
  if (!Array.isArray(pulls)) throw new Error('GitHub associated pull requests response must be an array');
  if (typeof repository !== 'string' || repository.trim() === '') throw new Error('GitHub repository is required');
  if (typeof branch !== 'string' || branch.trim() === '') throw new Error('integration branch is required');
  if (!SHA.test(mergeSha ?? '')) throw new Error('integration merge SHA must be a full 40-hex commit SHA');
  const matches = pulls.filter((pull) => (
    pull
    && pull.base?.repo?.full_name === repository
    && pull.base?.ref === branch
    && pull.merge_commit_sha === mergeSha
    && pull.state === 'closed'
    && typeof pull.merged_at === 'string'
    && pull.merged_at !== ''
    && SHA.test(pull.head?.sha ?? '')
  ));
  if (matches.length !== 1) throw new Error(`expected exactly one merged PR for ${mergeSha}, found ${matches.length}`);
  const [pull] = matches;
  return {
    number: pull.number,
    headSha: pull.head.sha.toLowerCase(),
    mergeSha: pull.merge_commit_sha.toLowerCase(),
    baseBranch: pull.base.ref,
  };
}

export async function resolveIntegrationPushProvenance({
  repository,
  branch,
  mergeSha,
  token,
  fetchImpl = globalThis.fetch,
  apiBase = 'https://api.github.com',
} = {}) {
  if (!controlledApiBase(apiBase)) throw new Error('GitHub API base is not controlled');
  if (typeof fetchImpl !== 'function') throw new Error('GitHub API fetch is unavailable');
  const authToken = typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
  if (!authToken) throw new Error('GITHUB_TOKEN is required for integration push provenance');
  if (typeof repository !== 'string' || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error('GitHub repository must be owner/name');
  if (!SHA.test(mergeSha ?? '')) throw new Error('integration merge SHA must be a full 40-hex commit SHA');
  const endpoint = `${apiBase.replace(/\/$/, '')}/repos/${repository}/commits/${mergeSha}/pulls`;
  const response = await fetchImpl(endpoint, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${authToken}` },
    redirect: 'error',
  });
  if (!response || response.redirected === true || !response.ok) throw new Error(`GitHub associated pull requests unavailable (${response?.status ?? 'unknown'})`);
  if (typeof response.url === 'string' && response.url !== '' && response.url !== endpoint) throw new Error('GitHub API response URL is not controlled');
  const pull = selectMergedPullRequest(await response.json(), { repository, branch, mergeSha });
  return { ...pull, repository };
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const repository = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME;
  const mergeSha = process.env.GITHUB_SHA;
  try {
    const provenance = await resolveIntegrationPushProvenance({
      repository,
      branch,
      mergeSha,
      token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    });
    if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required to carry approved PR head provenance');
    appendFileSync(process.env.GITHUB_ENV, `CI_APPROVED_PR_HEAD_SHA=${provenance.headSha}\nCI_APPROVED_PR_NUMBER=${provenance.number}\n`);
    process.stdout.write(`integration push provenance: PR #${provenance.number}, base=${provenance.baseBranch}, approved_pr_head=${provenance.headSha}, merge=${provenance.mergeSha}\n`);
  } catch (error) {
    process.stderr.write(`integration push provenance failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
