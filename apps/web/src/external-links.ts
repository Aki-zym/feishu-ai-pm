import {
  evaluateExternalUrl,
  externalUrlFailure,
  externalUrlOpenFailed,
  externalUrlResult,
  type OpenExternalUrlInput,
  type OpenExternalUrlResult,
} from '@ai-pm/url-policy';
import { desktopBridge, type DesktopBridge } from './desktop';

type BrowserOpen = (url: string, target: string, features: string) => unknown;

export async function requestExternalLinkOpen(
  input: OpenExternalUrlInput,
  options: { desktop?: DesktopBridge | null; browserOpen?: BrowserOpen } = {},
): Promise<OpenExternalUrlResult> {
  const desktop = options.desktop === undefined ? desktopBridge() : options.desktop;
  const decision = evaluateExternalUrl(input.url, input.purpose);
  if (!decision.allowed) return externalUrlResult(decision);
  if (desktop) {
    if (input.purpose !== 'feishu_document' || decision.target !== 'document') {
      return externalUrlFailure('invalid_input');
    }
    try {
      return await desktop.externalLinks.open({ url: decision.url, purpose: 'feishu_document' });
    } catch {
      return externalUrlOpenFailed();
    }
  }

  const browserOpen = options.browserOpen ?? ((url, target, features) => window.open(url, target, features));
  try {
    browserOpen(decision.url, '_blank', 'noopener,noreferrer');
    return externalUrlResult(decision);
  } catch {
    return externalUrlOpenFailed();
  }
}

export function externalLinkFeedbackMessage(result: OpenExternalUrlResult) {
  return result.opened ? result.message : `${result.message} 错误码：${result.errorCode}`;
}
