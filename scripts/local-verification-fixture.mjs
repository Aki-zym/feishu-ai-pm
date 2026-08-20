import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = resolve(root, 'docs/qa/issue111-publication-review-fixture.json');
const SHA256 = /^[0-9a-f]{64}$/i;
const GENERATION = /^[0-9]{17}-[0-9a-f]{8}$/;
const RUN_ID = /^local-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;

const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export async function validatePublicationFixture(path = fixturePath) {
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  const errors = [];
  const add = (message) => errors.push(message);
  if (fixture.schemaVersion !== 2 || fixture.kind !== 'issue111_publication_review_fixture' || fixture.scope !== 'synthetic_local_L4_only') add('fixture header is invalid');
  if (!Array.isArray(fixture.generations) || fixture.generations.length < 3) add('fixture must contain at least two failed and one successful generation');
  const generations = fixture.generations ?? [];
  const seen = new Set();
  for (let index = 0; index < generations.length; index += 1) {
    const item = generations[index];
    if (!item || typeof item !== 'object') { add(`generation ${index} is not an object`); continue; }
    if (!GENERATION.test(item.generation ?? '') || !RUN_ID.test(item.runId ?? '') || seen.has(item.generation)) add(`generation ${index} identity is invalid or duplicated`);
    seen.add(item.generation);
    const expectedPrevious = index === 0 ? null : generations[index - 1]?.generation;
    if (item.previousGeneration !== expectedPrevious) add(`generation ${item.generation} previousGeneration chain is invalid`);
    const counts = item.counts;
    if (!counts || counts.total < 1 || counts.passed + counts.failed + counts.skipped !== counts.total) add(`generation ${item.generation} counts are invalid`);
    if (!['failed', 'success'].includes(item.status)) add(`generation ${item.generation} status is invalid`);
    if (item.status === 'success' && (counts.failed !== 0 || counts.skipped !== 0 || counts.passed !== counts.total)) add(`generation ${item.generation} success is not fully passed`);
    if (item.status === 'failed' && counts.failed === 0) add(`generation ${item.generation} failed status has no failure`);
    const payload = { generation: item.generation, runId: item.runId, status: item.status, previousGeneration: item.previousGeneration, counts };
    if (!SHA256.test(item.payloadDigest ?? '') || item.payloadDigest !== digest(payload)) add(`generation ${item.generation} payloadDigest mismatch`);
    if (!SHA256.test(item.evidenceSha256 ?? '') || item.evidenceSha256 !== digest({ ...payload, payloadDigest: item.payloadDigest })) add(`generation ${item.generation} evidenceSha256 mismatch`);
  }
  const successful = generations.filter((item) => item?.status === 'success');
  if (successful.length !== 1 || fixture.expectedCurrent !== successful[0]?.generation || successful[0]?.generation !== generations.at(-1)?.generation) add('expected current must be the single final successful generation');
  const boundaryText = Array.isArray(fixture.boundaries) ? fixture.boundaries.join('\n') : '';
  if (!/real Feishu|provider|production data/i.test(boundaryText) || !/signed Windows Release|L5|L6/i.test(boundaryText)) add('synthetic-only boundaries are missing');
  if (errors.length > 0) throw new Error(errors.join('; '));
  return { fixturePath: path, generations: generations.length, expectedCurrent: fixture.expectedCurrent, status: 'valid' };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const result = await validatePublicationFixture(process.argv[2] ? resolve(process.argv[2]) : fixturePath);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
