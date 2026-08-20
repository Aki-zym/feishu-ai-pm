const runtimeBuildIdentityPatterns = [
  /process\s*\.\s*env\s*\.\s*BUILD_IDENTITY/u,
  /process\s*\.\s*env\s*\[\s*['"]BUILD_IDENTITY['"]\s*\]/u,
];
const compiledNullBuildIdentity = /\bCOMPILED_BUILD_IDENTITY\s*=\s*false\s*\?\s*null\s*:\s*null\b/u;

export function desktopBuildArtifactErrors(bundle, expectedIdentity) {
  const errors = [];
  if (typeof bundle !== 'string' || (expectedIdentity !== null && (typeof expectedIdentity !== 'string' || !expectedIdentity))) {
    return ['controlled build identity unavailable'];
  }
  if (expectedIdentity === null) {
    if (!compiledNullBuildIdentity.test(bundle)) errors.push('compiled null build identity missing');
  } else if (!bundle.includes(expectedIdentity)) {
    errors.push('exact controlled Git HEAD identity missing');
  }
  if (bundle.includes('__AI_PM_BUILD_IDENTITY__')) errors.push('build identity placeholder remains');
  if (runtimeBuildIdentityPatterns.some((pattern) => pattern.test(bundle))) {
    errors.push('runtime BUILD_IDENTITY access remains');
  }
  return errors;
}
