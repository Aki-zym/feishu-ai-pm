import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { desktopBuildArtifactErrors } from './build-artifact.mjs';
import { resolveBuildIdentity } from './build-identity.mjs';

let errors;
try {
  const bundle = readFileSync(resolve(import.meta.dirname, '../dist/main.cjs'), 'utf8');
  errors = desktopBuildArtifactErrors(bundle, resolveBuildIdentity());
} catch {
  errors = ['desktop build artifact unavailable'];
}

if (errors.length) {
  for (const error of errors) process.stderr.write(`desktop build artifact verification failed: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('desktop build artifact verified.\n');
}
