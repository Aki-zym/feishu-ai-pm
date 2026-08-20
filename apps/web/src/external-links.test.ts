import { describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from './desktop';
import { externalLinkFeedbackMessage, requestExternalLinkOpen } from './external-links';

describe('renderer external-link contract', () => {
  it('rejects malicious desktop links before they reach the preload bridge', async () => {
    const open = vi.fn();
    const desktop = { externalLinks: { open, onResult: vi.fn() } } as unknown as DesktopBridge;
    const result = await requestExternalLinkOpen(
      { url: 'https://evil.example/?secret=synthetic-renderer-57', purpose: 'feishu_document' },
      { desktop },
    );
    expect(result).toMatchObject({ opened: false, reason: 'untrusted_host', errorCode: 'EXTERNAL_URL_UNTRUSTED_HOST' });
    expect(JSON.stringify(result)).not.toContain('synthetic-renderer-57');
    expect(open).not.toHaveBeenCalled();
  });

  it('passes only the canonical allowed URL to preload for main-process revalidation', async () => {
    const open = vi.fn(async () => ({ opened: true as const, message: '已打开' }));
    const desktop = { externalLinks: { open, onResult: vi.fn() } } as unknown as DesktopBridge;
    await expect(requestExternalLinkOpen(
      { url: 'https://TENANT.FEISHU.CN/WIKI/wiki-1', purpose: 'feishu_document' },
      { desktop },
    )).resolves.toEqual({ opened: true, message: '已打开' });
    expect(open).toHaveBeenCalledWith({ url: 'https://tenant.feishu.cn/wiki/wiki-1', purpose: 'feishu_document' });
  });

  it('sanitizes preload bridge failures before UI feedback', async () => {
    const open = vi.fn(async () => { throw new Error('synthetic-preload-secret-57'); });
    const desktop = { externalLinks: { open, onResult: vi.fn() } } as unknown as DesktopBridge;
    const result = await requestExternalLinkOpen(
      { url: 'https://tenant.feishu.cn/docx/doc-1', purpose: 'feishu_document' },
      { desktop },
    );
    expect(result).toMatchObject({ opened: false, reason: 'open_failed', errorCode: 'EXTERNAL_URL_OPEN_FAILED' });
    expect(JSON.stringify(result)).not.toContain('synthetic-preload-secret-57');
  });

  it('does not turn the document bridge into a general OAuth URL opener', async () => {
    const open = vi.fn();
    const desktop = { externalLinks: { open, onResult: vi.fn() } } as unknown as DesktopBridge;
    const params = new URLSearchParams({
      client_id: 'cli_synthetic_57',
      redirect_uri: 'http://127.0.0.1:4311/oauth/feishu/callback',
      response_type: 'code',
      state: '123e4567-e89b-42d3-a456-426614174000',
      scope: 'offline_access',
    });
    const result = await requestExternalLinkOpen(
      { url: `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${params}`, purpose: 'feishu_oauth' },
      { desktop },
    );
    expect(result).toMatchObject({ opened: false, reason: 'invalid_input', errorCode: 'EXTERNAL_URL_INVALID_INPUT' });
    expect(open).not.toHaveBeenCalled();
  });

  it('uses the same policy in browser development without opening denied links', async () => {
    const browserOpen = vi.fn();
    const result = await requestExternalLinkOpen(
      { url: 'javascript:synthetic-browser-57', purpose: 'trusted_link' },
      { desktop: null, browserOpen },
    );
    expect(result).toMatchObject({ opened: false, reason: 'unsupported_scheme', errorCode: 'EXTERNAL_URL_UNSUPPORTED_SCHEME' });
    expect(externalLinkFeedbackMessage(result)).toContain('错误码：EXTERNAL_URL_UNSUPPORTED_SCHEME');
    expect(JSON.stringify(result)).not.toContain('synthetic-browser-57');
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it('opens an allowed browser link only after canonical validation', async () => {
    const browserOpen = vi.fn(() => ({}));
    const result = await requestExternalLinkOpen(
      { url: 'https://tenant.feishu.cn/wiki/wiki-1', purpose: 'feishu_document' },
      { desktop: null, browserOpen },
    );
    expect(result).toMatchObject({ opened: true });
    expect(browserOpen).toHaveBeenCalledWith('https://tenant.feishu.cn/wiki/wiki-1', '_blank', 'noopener,noreferrer');
  });

  it('reports a visible-safe failure when the browser opener throws', async () => {
    const result = await requestExternalLinkOpen(
      { url: 'https://tenant.feishu.cn/docx/doc-1', purpose: 'feishu_document' },
      { desktop: null, browserOpen: () => { throw new Error('synthetic-browser-open-secret-57'); } },
    );
    expect(result).toMatchObject({ opened: false, reason: 'open_failed', errorCode: 'EXTERNAL_URL_OPEN_FAILED' });
    expect(JSON.stringify(result)).not.toContain('synthetic-browser-open-secret-57');
  });
});
