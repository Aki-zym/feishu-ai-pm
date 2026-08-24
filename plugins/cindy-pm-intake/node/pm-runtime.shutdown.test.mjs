import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { startPmServer } = createRequire(import.meta.url)('./pm-runtime.cjs');

test('browser shutdown route closes the owned listener after returning 200', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-browser-shutdown-'));
  const runtime = await startPmServer({
    port: 0,
    sqlitePath: join(root, 'pm.sqlite'),
    token: 'test-token',
    accountAnchor: 'test-account-anchor',
    receiptSecret: 'test-receipt-secret-0123456789abcdef0123456789abcdef',
  });

  const response = await fetch(`${runtime.url}/api/runtime/shutdown`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.match((await response.json()).message, /4310/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(fetch(`${runtime.url}/`));
  assert.deepEqual(await runtime.stop(), { stopped: false, alreadyStopped: true });
});
