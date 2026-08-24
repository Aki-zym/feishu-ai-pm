import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.NODE_ENV = 'test';
const { startPmServer } = createRequire(import.meta.url)('./pm-runtime.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('stop closes the owned Fastify listener and SQLite handle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-stop-'));
  const runtime = await startPmServer({
    port: 0,
    sqlitePath: join(root, 'pm.sqlite'),
    token: 'test-token',
  });
  assert.deepEqual(Object.keys(runtime), ['url', 'port', 'alreadyRunning', 'foreign']);
  assert.equal(typeof runtime.stop, 'function');
  assert.equal((await fetch(`${runtime.url}/`)).status, 200);
  assert.deepEqual(await runtime.stop(), { stopped: true });
  await assert.rejects(fetch(`${runtime.url}/`));
  assert.deepEqual(await runtime.stop(), { stopped: false, alreadyStopped: true });
});

test('foreign stop returns an explicit error and leaves the foreign listener alive', async () => {
  const foreign = createServer((request, response) => {
    response.statusCode = request.url === '/api/integrations/cindy/tasks' ? 404 : 200;
    response.end('foreign');
  });
  const port = await listen(foreign);
  const root = mkdtempSync(join(tmpdir(), 'cindy-pm-runtime-foreign-'));
  try {
    const runtime = await startPmServer({
      port,
      sqlitePath: join(root, 'pm.sqlite'),
      token: 'test-token',
    });
    assert.equal(runtime.foreign, true);
    assert.deepEqual(await runtime.stop(), {
      stopped: false,
      error_code: 'PM_FOREIGN_PROCESS',
      error: '本机任务库端口由外来进程占用，未执行停止。',
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  } finally {
    await close(foreign);
  }
});
