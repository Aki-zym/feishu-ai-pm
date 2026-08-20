import {
  evaluateExternalUrl,
  externalUrlFailure,
  externalUrlOpenFailed,
  externalUrlOwnerActionRequired,
  externalUrlResult,
  type OpenExternalUrlInput,
  type OpenExternalUrlResult,
} from '@ai-pm/url-policy';

export type SystemExternalOpener = (url: string) => Promise<void>;
type RendererVerifier<TEvent> = (event: TEvent) => void;

export function createExternalLinkOpener(openExternal: SystemExternalOpener) {
  return async (input: OpenExternalUrlInput): Promise<OpenExternalUrlResult> => {
    const decision = evaluateExternalUrl(input.url, input.purpose);
    if (!decision.allowed) return externalUrlResult(decision);
    try {
      await openExternal(decision.url);
      return externalUrlResult(decision);
    } catch {
      return externalUrlOpenFailed();
    }
  };
}

export function createExternalLinkIpcHandler<TEvent>(
  verifyRenderer: RendererVerifier<TEvent>,
  openExternal: ReturnType<typeof createExternalLinkOpener>,
) {
  return async (event: TEvent, input: unknown): Promise<OpenExternalUrlResult> => {
    verifyRenderer(event);
    if (!input || typeof input !== 'object') {
      return externalUrlFailure('invalid_input');
    }
    const { url, purpose } = input as Partial<OpenExternalUrlInput>;
    if (typeof url !== 'string' || purpose !== 'feishu_document') {
      return externalUrlFailure('invalid_input');
    }
    return openExternal({ url, purpose });
  };
}

export function legacyNavigationResult(url: string): OpenExternalUrlResult {
  const decision = evaluateExternalUrl(url, 'trusted_link');
  return decision.allowed ? externalUrlOwnerActionRequired() : externalUrlResult(decision);
}
