import { execFileSync } from 'node:child_process';

const safeBuildIdentity = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u;

export function normalizeBuildIdentity(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return safeBuildIdentity.test(normalized) ? normalized : null;
}

export function resolveBuildIdentity(runGit = () => execFileSync(
  'git',
  ['rev-parse', '--verify', 'HEAD'],
  { encoding: 'utf8', windowsHide: true },
)) {
  try {
    return normalizeBuildIdentity(runGit());
  } catch {
    return null;
  }
}
