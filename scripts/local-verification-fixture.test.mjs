import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { validatePublicationFixture } from './local-verification-fixture.mjs';

test('publication review fixture validates the failed-failed-success chain', async () => {
  const result = await validatePublicationFixture();
  assert.equal(result.status, 'valid');
  assert.equal(result.generations, 3);
  assert.equal(result.expectedCurrent, '20260817112000000-a1100001');
});

test('publication review fixture rejects replayed or replaced current generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'issue111-fixture-'));
  const path = join(directory, 'fixture.json');
  const fixture = JSON.parse(await readFile(new URL('../docs/qa/issue111-publication-review-fixture.json', import.meta.url), 'utf8'));
  fixture.expectedCurrent = fixture.generations[1].generation;
  await writeFile(path, JSON.stringify(fixture));
  await assert.rejects(() => validatePublicationFixture(path), /expected current/);
  await rm(directory, { recursive: true, force: true });
});
