declare const __AI_PM_BUILD_IDENTITY__: string | null | undefined;

export const COMPILED_BUILD_IDENTITY = typeof __AI_PM_BUILD_IDENTITY__ === 'string'
  ? __AI_PM_BUILD_IDENTITY__
  : null;
