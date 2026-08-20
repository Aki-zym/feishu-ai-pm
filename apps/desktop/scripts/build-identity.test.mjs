import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeBuildIdentity, resolveBuildIdentity } from './build-identity.mjs';

describe('desktop build identity', () => {
  it('keeps a controlled commit identity stable', () => {
    const commit = '6159026bde5a3c7bf9746f7300773297610da428';
    expect(resolveBuildIdentity(() => `${commit}\n`)).toBe(commit);
    expect(resolveBuildIdentity(() => `${commit}\n`)).toBe(commit);
  });

  it.each([undefined, '', 'D:/private/build', 'build?token=secret', 'bad value'])('fails closed for %s', (value) => {
    expect(normalizeBuildIdentity(value)).toBeNull();
  });

  it('returns null when the controlled git lookup is unavailable', () => {
    expect(resolveBuildIdentity(() => { throw new Error('synthetic path canary'); })).toBeNull();
  });

  it('desktop runtime only uses the compiled constant, not BUILD_IDENTITY from process.env', () => {
    const mainSource = readFileSync(resolve(import.meta.dirname, '../src/main.ts'), 'utf8');
    expect(mainSource).toContain('COMPILED_BUILD_IDENTITY');
    expect(mainSource).not.toContain('process.env.BUILD_IDENTITY');
  });
});
