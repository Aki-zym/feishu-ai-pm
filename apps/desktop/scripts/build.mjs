import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { resolveBuildIdentity } from './build-identity.mjs';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'dist');
const buildIdentity = resolveBuildIdentity();

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  define: { __AI_PM_BUILD_IDENTITY__: JSON.stringify(buildIdentity) },
  logLevel: 'info',
};

await Promise.all([
  build({ ...shared, entryPoints: [resolve(root, 'src/main.ts')], outfile: resolve(outdir, 'main.cjs') }),
  build({ ...shared, entryPoints: [resolve(root, 'src/preload.ts')], outfile: resolve(outdir, 'preload.cjs') }),
]);
