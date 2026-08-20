import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { desktopBuildArtifactErrors } from './build-artifact.mjs';

const head = '0123456789abcdef0123456789abcdef01234567';

describe('desktop post-build artifact contract', () => {
  it('accepts an artifact with only the exact compiled identity', () => {
    expect(desktopBuildArtifactErrors(`BUILD_IDENTITY:${head}`, head)).toEqual([]);
  });

  it.each([
    ['missing identity', 'safe bundle', ['exact controlled Git HEAD identity missing']],
    ['placeholder', `${head} __AI_PM_BUILD_IDENTITY__`, ['build identity placeholder remains']],
    ['dot runtime env', `${head} process.env.BUILD_IDENTITY`, ['runtime BUILD_IDENTITY access remains']],
    ['bracket runtime env', `${head} process.env['BUILD_IDENTITY']`, ['runtime BUILD_IDENTITY access remains']],
  ])('rejects %s', (_label, bundle, expected) => {
    expect(desktopBuildArtifactErrors(bundle, head)).toEqual(expected);
  });

  it('accepts a bundle that compiled the unavailable identity to null', () => {
    expect(desktopBuildArtifactErrors('var COMPILED_BUILD_IDENTITY = false ? null : null;', null)).toEqual([]);
  });

  it('rejects an unavailable identity unless the bundle proves the compiled null', () => {
    expect(desktopBuildArtifactErrors('safe bundle', null)).toEqual(['compiled null build identity missing']);
    expect(desktopBuildArtifactErrors('safe bundle', undefined)).toEqual(['controlled build identity unavailable']);
  });

  it('runs the artifact verifier only after the latest root build in npm run check', () => {
    const rootPackage = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf8'));
    const desktopPackage = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
    expect(rootPackage.scripts.check).toMatch(/npm run check:runtime$/u);
    expect(rootPackage.scripts['check:runtime']).toMatch(
      /npm run build && npm run verify:desktop-build-artifact && node scripts\/e2e-build-provenance\.mjs write$/u,
    );
    expect(rootPackage.scripts['verify:desktop-build-artifact']).toBe('npm run verify:build-artifact -w @ai-pm/desktop');
    expect(desktopPackage.scripts.build).toBe('node scripts/build.mjs');
    expect(desktopPackage.scripts['verify:build-artifact']).toBe('node scripts/verify-build-artifact.mjs');
  });
});
