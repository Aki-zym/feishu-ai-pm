import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import test from 'node:test';
import {
  BoundedCiOutputGuard,
  formatControlledCiSummary,
  runBoundedChild,
} from './ci-log-policy.mjs';
import { runPlaywrightResultsVerifier } from './playwright-results-verify.mjs';

function sink() {
  let value = '';
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { value += String(chunk); callback(); } }),
    value: () => value,
  };
}

async function captureProcess(args, cwd) {
  const output = sink();
  const error = sink();
  const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output.stream);
  child.stderr.pipe(error.stream);
  const code = await new Promise((resolveExit) => child.once('close', resolveExit));
  return { code, stdout: output.value(), stderr: error.value() };
}

test('sensitive markers split across chunks are detected without retaining raw output in summaries', () => {
  for (const value of [
    'password=value', 'passwd=value', 'private_key=value', 'Authorization: Basic value',
    'Bearer value', 'Cookie: value', 'client_secret=value', 'access_token=value', 'canary=value',
  ]) {
    const guard = new BoundedCiOutputGuard(128);
    const split = Math.max(1, Math.floor(value.length / 2));
    guard.observe(Buffer.from(value.slice(0, split)));
    guard.observe(Buffer.from(value.slice(split)));
    const report = guard.finish();
    assert.equal(report.unsafeOutputDetected, true, value);
    const summary = formatControlledCiSummary({ label: 'probe', code: 1, report });
    assert.equal(summary.includes(value), false, value);
  }
});

test('URL userinfo and Windows/POSIX secret paths are detected across chunk boundaries', () => {
  for (const value of [
    'https://user:pass@example.invalid/path',
    'source C:\\private\\file.txt',
    'source /srv/app/private.txt',
    'source /run/secrets/service-key',
    'source /home/runner/work/repo/file.ts',
    'source /custom/absolute/path.txt',
  ]) {
    const guard = new BoundedCiOutputGuard(128);
    for (let index = 0; index < value.length; index += 3) guard.observe(Buffer.from(value.slice(index, index + 3)));
    assert.equal(guard.finish().unsafeOutputDetected, true, value);
  }
});

test('oversized output keeps only bounded accounting and reports truncation', () => {
  const guard = new BoundedCiOutputGuard(32);
  guard.observe(Buffer.alloc(4096, 0x61));
  const report = guard.finish();
  assert.equal(report.observedBytes, 4096);
  assert.equal(report.boundedBytes, 32);
  assert.equal(report.truncated, true);
});

test('binary controls and invalid UTF-8 fail closed', () => {
  for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xc3, 0x28])]) {
    const guard = new BoundedCiOutputGuard();
    guard.observe(bytes);
    assert.equal(guard.finish().unsafeOutputDetected, true);
  }
});

test('successful child output is suppressed, bounded, and never written to disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-log-policy-'));
  const output = sink();
  const error = sink();
  const rawCanary = 'canary-raw-password=never-print';
  try {
    const result = await runBoundedChild({
      command: process.execPath,
      args: ['-e', `process.stdout.write('${rawCanary}'); process.stderr.write('Authorization: Bearer hidden')`],
      cwd: root,
      label: 'probe-success',
      maxBytes: 64,
      stdout: output.stream,
      stderr: error.stream,
    });
    assert.equal(result.code, 0);
    assert.equal(result.report.unsafeOutputDetected, true);
    assert.match(output.value(), /child_output=suppressed/);
    assert.doesNotMatch(`${output.value()}${error.value()}`, /canary-raw|never-print|Bearer hidden/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed child emits only a fixed stderr summary and never the raw failure', async () => {
  const output = sink();
  const error = sink();
  const result = await runBoundedChild({
    command: process.execPath,
    args: ['-e', "process.stderr.write('/run/secrets/raw-canary'); process.exit(7)"],
    label: 'probe-failure',
    stdout: output.stream,
    stderr: error.stream,
  });
  assert.equal(result.code, 7);
  assert.equal(output.value(), '');
  assert.match(error.value(), /probe-failure: failed; exit_code=7/);
  assert.doesNotMatch(error.value(), /run\/secrets|raw-canary/);
});

test('oversized runtime output is scanned in bounded pieces without printing or persisting its canary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-log-policy-large-'));
  const output = sink();
  const error = sink();
  const rawCanary = ['pass', 'word=', 'oversized-raw-canary'].join('');
  try {
    const result = await runBoundedChild({
      command: process.execPath,
      args: ['-e', `process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 97), () => process.stderr.write(${JSON.stringify(rawCanary)}, () => { process.exitCode = 9; }))`],
      cwd: root,
      label: 'probe-large-failure',
      maxBytes: 1024,
      stdout: output.stream,
      stderr: error.stream,
    });
    assert.equal(result.code, 9);
    assert.equal(result.report.observedBytes > 4 * 1024 * 1024, true);
    assert.equal(result.report.boundedBytes, 1024);
    assert.equal(result.report.truncated, true);
    assert.equal(result.report.unsafeOutputDetected, true);
    assert.doesNotMatch(`${output.value()}${error.value()}`, /password=|oversized-raw-canary/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wrapper invocation failures emit no stack, raw message, or absolute path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-log-policy-wrapper-'));
  const wrapperPath = fileURLToPath(new URL('./run-ci-command.mjs', import.meta.url));
  try {
    for (const args of [[wrapperPath], [wrapperPath, 'probe', '--', 'node']]) {
      const result = await captureProcess(args, root);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'CI command wrapper: failed; exit_code=1; child_output=suppressed; wrapper_error=controlled.\n');
      assert.doesNotMatch(result.stderr, /Error|invalid wrapper|unsupported wrapped|[A-Za-z]:[\\/]|\/(?:home|srv|run|tmp)\//);
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing Playwright evidence fails with a fixed message and no runner path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-log-policy-playwright-'));
  const output = sink();
  const error = sink();
  try {
    const code = await runPlaywrightResultsVerifier({ repoRoot: root, stdout: output.stream, stderr: error.stream });
    assert.equal(code, 1);
    assert.equal(output.value(), '');
    assert.equal(error.value(), 'Playwright execution verification failed; evidence missing or invalid.\n');
    assert.doesNotMatch(error.value(), /Error|ENOENT|[A-Za-z]:[\\/]|\/(?:home|srv|run|tmp)\//);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
