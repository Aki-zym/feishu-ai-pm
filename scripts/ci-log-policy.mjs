import { spawn } from 'node:child_process';

export const DEFAULT_CAPTURE_LIMIT = 64 * 1024;
const SCAN_CARRY_CHARS = 2048;
const SCAN_CHUNK_BYTES = 4096;
const CONTROL_BYTES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const SENSITIVE_RULES = Object.freeze([
  ['credential-keyword', /\b(?:password|passwd|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|cookie|authorization|bearer|api[_-]?key|canary)\b/i],
  ['url-userinfo', /\bhttps?:\/\/[^\s/@]+(?::[^\s/@]*)?@/i],
  ['windows-absolute-path', /(?:^|[\s"'(=])[A-Za-z]:[\\/]/m],
  ['unc-path', /(?:^|[\s"'(=])\\\\[^\\\s]+\\/m],
  ['posix-absolute-path', /(?:^|[\s"'(=])\/(?!\/)[^\s"')]+/m],
]);

export class BoundedCiOutputGuard {
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #scanCarry = '';
  #boundedBytes = 0;
  #unsafeReasons = new Set();

  constructor(maxBytes = DEFAULT_CAPTURE_LIMIT) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer.');
    this.maxBytes = maxBytes;
    this.totalBytes = 0;
    this.truncated = false;
  }

  observe(value) {
    const bytes = Buffer.isBuffer(value)
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : Buffer.from(value);
    this.truncated ||= this.totalBytes > this.maxBytes - bytes.byteLength;
    this.totalBytes = Math.min(Number.MAX_SAFE_INTEGER, this.totalBytes + bytes.byteLength);
    this.#boundedBytes = Math.min(this.maxBytes, this.#boundedBytes + bytes.byteLength);

    if (!this.#decoder) return;
    for (let offset = 0; offset < bytes.byteLength && this.#decoder; offset += SCAN_CHUNK_BYTES) {
      try {
        this.#scan(this.#decoder.decode(bytes.subarray(offset, offset + SCAN_CHUNK_BYTES), { stream: true }));
      } catch {
        this.#unsafeReasons.add('invalid-utf8');
        this.#decoder = null;
      }
    }
  }

  finish() {
    if (this.#decoder) {
      try {
        this.#scan(this.#decoder.decode());
      } catch {
        this.#unsafeReasons.add('invalid-utf8');
      }
      this.#decoder = null;
    }
    return Object.freeze({
      observedBytes: this.totalBytes,
      boundedBytes: this.#boundedBytes,
      truncated: this.truncated,
      unsafeOutputDetected: this.#unsafeReasons.size > 0,
      unsafeReasons: Object.freeze([...this.#unsafeReasons].sort()),
    });
  }

  #scan(text) {
    const candidate = `${this.#scanCarry}${text}`;
    if (CONTROL_BYTES.test(candidate)) this.#unsafeReasons.add('control-bytes');
    for (const [label, pattern] of SENSITIVE_RULES) {
      if (pattern.test(candidate)) this.#unsafeReasons.add(label);
    }
    this.#scanCarry = candidate.slice(-SCAN_CARRY_CHARS);
  }
}

export function formatControlledCiSummary({ label, code, report, spawnFailed = false }) {
  if (!/^[a-z0-9-]+$/i.test(label ?? '')) throw new Error('CI command label is invalid.');
  const exitCode = Number.isInteger(code) ? code : 1;
  const outcome = exitCode === 0 && !spawnFailed ? 'passed' : 'failed';
  return `CI command ${label}: ${outcome}; exit_code=${exitCode}; child_output=suppressed; observed_bytes=${report.observedBytes}; bounded_bytes=${report.boundedBytes}; truncated=${report.truncated}; unsafe_output_detected=${report.unsafeOutputDetected}.\n`;
}

export async function runBoundedChild({
  command,
  args = [],
  cwd,
  label,
  maxBytes = DEFAULT_CAPTURE_LIMIT,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  const guard = new BoundedCiOutputGuard(maxBytes);
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => guard.observe(chunk));
  child.stderr.on('data', (chunk) => guard.observe(chunk));
  const result = await new Promise((resolveExit) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveExit(value);
    };
    child.once('error', () => finish({ code: 1, spawnFailed: true }));
    child.once('close', (code) => finish({ code: code ?? 1, spawnFailed: false }));
  });
  const report = guard.finish();
  const summary = formatControlledCiSummary({ label, ...result, report });
  const destination = result.code === 0 && !result.spawnFailed ? stdout : stderr;
  destination.write(summary);
  return { ...result, report, summary };
}
