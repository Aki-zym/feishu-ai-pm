import { describe, expect, it, vi } from 'vitest';
import { evaluateExternalUrl, externalUrlResult, MAX_EXTERNAL_URL_LENGTH } from '@ai-pm/url-policy';
import { createExternalLinkIpcHandler, createExternalLinkOpener, legacyNavigationResult } from './external-links.js';

const OAUTH_STATE = '123e4567-e89b-42d3-a456-426614174000';

function oauthUrl(host = 'accounts.feishu.cn') {
  const params = new URLSearchParams({
    client_id: 'cli_synthetic_57',
    redirect_uri: 'http://127.0.0.1:4311/oauth/feishu/callback',
    response_type: 'code',
    state: OAUTH_STATE,
    scope: 'offline_access im:chat:read',
  });
  return `https://${host}/open-apis/authen/v1/authorize?${params}`;
}

describe('external URL policy', () => {
  it.each([
    ['https://tenant.feishu.cn/docx/doc-1', 'feishu_document', 'document'],
    ['https://TENANT.FEISHU.CN/WIKI/wiki-1', 'feishu_document', 'document'],
    ['https://tenant.larksuite.com/sheets/sheet-1', 'feishu_document', 'document'],
    [oauthUrl(), 'feishu_oauth', 'oauth'],
    [oauthUrl('accounts.larksuite.com'), 'trusted_link', 'oauth'],
  ] as const)('allows explicit trusted target %s', (url, purpose, target) => {
    expect(evaluateExternalUrl(url, purpose)).toMatchObject({ allowed: true, target });
  });

  it('returns a canonical document URL with no unexamined components', () => {
    expect(evaluateExternalUrl('https://TENANT.FEISHU.CN/WIKI/wiki-1', 'feishu_document')).toEqual({
      allowed: true,
      url: 'https://tenant.feishu.cn/wiki/wiki-1',
      purpose: 'feishu_document',
      target: 'document',
    });
  });

  it('accepts the exact generated OAuth contract and canonicalizes parameter order', () => {
    const source = new URL(oauthUrl());
    const reordered = new URLSearchParams([
      ['scope', source.searchParams.get('scope')!],
      ['state', source.searchParams.get('state')!],
      ['response_type', source.searchParams.get('response_type')!],
      ['redirect_uri', source.searchParams.get('redirect_uri')!],
      ['client_id', source.searchParams.get('client_id')!],
    ]);
    expect(evaluateExternalUrl(`${source.origin}${source.pathname}?${reordered}`, 'feishu_oauth')).toEqual({
      allowed: true,
      url: oauthUrl(),
      purpose: 'feishu_oauth',
      target: 'oauth',
    });
  });

  it.each([
    ['http://tenant.feishu.cn/docx/doc-1', 'unsupported_scheme'],
    ['file:///C:/synthetic.txt', 'unsupported_scheme'],
    ['data:text/html,synthetic', 'unsupported_scheme'],
    ['javascript:alert(1)', 'unsupported_scheme'],
    ['feishu://docx/doc-1', 'unsupported_scheme'],
    ['https://user:password@tenant.feishu.cn/docx/doc-1', 'credentials_not_allowed'],
    ['https://localhost/docx/doc-1', 'local_or_private_host'],
    ['https://127.0.0.1/docx/doc-1', 'local_or_private_host'],
    ['https://2130706433/docx/doc-1', 'local_or_private_host'],
    ['https://[::1]/docx/doc-1', 'local_or_private_host'],
    ['https://tenant.feishu.cn:444/docx/doc-1', 'non_standard_port'],
    ['https://tenant.feishu.cn.evil.example/docx/doc-1', 'untrusted_host'],
    ['https://evil-feishu.cn/docx/doc-1', 'untrusted_host'],
    ['https://tenant.feishu.cn/base/base-1', 'untrusted_path'],
    ['https://tenant.feishu.cn/docx', 'untrusted_path'],
    ['https://tenant.feishu.cn/wiki/', 'untrusted_path'],
    ['https://tenant.feishu.cn/docx/doc-1/extra', 'untrusted_path'],
    ['https://accounts.feishu.cn/evil', 'untrusted_path'],
    ['https://tenant.feishu.cn/docx/doc-1?redirect=https%3A%2F%2Fevil.example', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1?%2572edirect=https%3A%2F%2Fevil.example', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1?redirect[]=https%3A%2F%2Fevil.example', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1?redirect.url=https%3A%2F%2Fevil.example', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1?redirect%255B%255D=https%3A%2F%2Fevil.example', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1?from=chat;redirect=https%3A%2F%2Fevil.example', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1?from=chat%3Bredirect=https%3A%2F%2Fevil.example', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1?from=chat%26redirect=https%3A%2F%2Fevil.example', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1?redirectUrl=https%3A%2F%2Fevil.example', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1?continueUrl=https%3A%2F%2Fevil.example', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1#redirect=https%3A%2F%2Fevil.example', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1?from=chat', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1#tab', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1?', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1#', 'redirect_parameter_not_allowed'],
    ['https://tenant.feishu.cn/docx/doc-1%0aevil', 'control_characters'],
    ['https://tenant.feishu.cn/docx/doc-1%250aevil', 'control_characters'],
    ['https://tenant.feishu.cn/docx/doc-1%5cevil', 'control_characters'],
    ['https://tenant.feishu.cn/docx/doc-1%255cevil', 'control_characters'],
    ['https://tenant.feishu.cn\\@evil.example/docx/doc-1', 'control_characters'],
    [' https://tenant.feishu.cn/docx/doc-1', 'control_characters'],
    ['https://tenant.feishu.cn/docx/%zz', 'invalid_encoding'],
    ['not a URL', 'invalid_url'],
  ] as const)('rejects %s without returning the input', (url, reason) => {
    const decision = evaluateExternalUrl(url, 'trusted_link');
    expect(decision).toMatchObject({ allowed: false, reason });
    const result = externalUrlResult(decision);
    expect(result).toMatchObject({ opened: false, reason, errorCode: `EXTERNAL_URL_${reason.toUpperCase()}` });
    expect(JSON.stringify({ decision, result })).not.toContain(url);
  });

  it.each([
    'return', 'RETURN', 'return_url', 'return-url', 'returnUrl',
    'callback', 'CALLBACK_URL', 'callback-url', 'callbackUrl',
    'redirect_to', 'redirect-to', 'redirectTo',
    'continue', 'continueUrl', 'next',
    'redirect[target]', 'redirect.target', 'nested[return_url]',
  ])('rejects redirect-like query key %s', (key) => {
    const url = `https://tenant.feishu.cn/docx/doc-1?${key}=https%3A%2F%2Fevil.example`;
    expect(evaluateExternalUrl(url, 'feishu_document')).toMatchObject({ allowed: false, reason: 'redirect_parameter_not_allowed' });
  });

  it.each([
    'https://tenant.feishu.cn/docx/doc-1?return=x&return=y',
    'https://tenant.feishu.cn/docx/doc-1?from=chat;return=x',
    'https://tenant.feishu.cn/docx/doc-1?from=chat%3Breturn=x',
    'https://tenant.feishu.cn/docx/doc-1?from=chat%253Breturn=x',
    'https://tenant.feishu.cn/docx/doc-1?from=chat%26return=x',
    'https://tenant.feishu.cn/docx/doc-1?from=chat%2526return=x',
    'https://tenant.feishu.cn/docx/doc-1?%2572%2565%2574%2575%2572%256e=x',
    'https://tenant.feishu.cn/docx/doc-1?return%255Furl=x',
    'https://tenant.feishu.cn/docx/doc-1?callback%2555rl=x',
    'https://tenant.feishu.cn/docx/doc-1#callback=https%3A%2F%2Fevil.example',
    'https://tenant.feishu.cn/docx/doc-1#https://evil.example',
  ])('rejects separator, encoding, repetition, or fragment bypass %s', (url) => {
    expect(evaluateExternalUrl(url, 'feishu_document')).toMatchObject({ allowed: false });
  });

  it.each([
    'https://0177.0.0.1/docx/doc-1',
    'https://0x7f000001/docx/doc-1',
    'https://2130706433/docx/doc-1',
    'https://[::1]/docx/doc-1',
    'https://[fc00::1]/docx/doc-1',
    'https://[fe80::1]/docx/doc-1',
    'https://[2001:db8::1]/docx/doc-1',
    'https://tenant.feishu.cn./docx/doc-1',
    'https://tenant.feishu.c\u043d/docx/doc-1',
  ])('rejects local, reserved, or lookalike host %s', (url) => {
    expect(evaluateExternalUrl(url, 'trusted_link')).toMatchObject({ allowed: false });
  });

  it.each([
    `${oauthUrl()}&return=https%3A%2F%2Fevil.example`,
    `${oauthUrl()}&callbackUrl=https%3A%2F%2Fevil.example`,
    `${oauthUrl()}&redirect_to=https%3A%2F%2Fevil.example`,
    `${oauthUrl()}&client_id=cli_duplicate`,
    `${oauthUrl()}&return%255Furl=https%253A%252F%252Fevil.example`,
    oauthUrl().replace('&scope=', '%253Breturn_url=https%253A%252F%252Fevil.example&scope='),
    `${oauthUrl()}#redirect=https%3A%2F%2Fevil.example`,
    `${oauthUrl()}#`,
    oauthUrl().replace('client_id=', 'client_id=synthetic%255c'),
    oauthUrl().replace('redirect_uri=http', 'redirect_uri=https'),
    oauthUrl().replace('127.0.0.1', '2130706433'),
    oauthUrl().replace(encodeURIComponent(OAUTH_STATE), 'synthetic-state'),
    oauthUrl().replace('offline_access+im%3Achat%3Aread', 'offline_access+https%3A%2F%2Fevil.example'),
    oauthUrl().replace('&scope=', '&scope=offline_access&scope='),
  ])('rejects OAuth parameters outside the exact generated contract %s', (url) => {
    expect(evaluateExternalUrl(url, 'feishu_oauth')).toMatchObject({ allowed: false });
  });

  it('rejects overlong values before parsing', () => {
    const canary = `https://tenant.feishu.cn/docx/${'x'.repeat(MAX_EXTERNAL_URL_LENGTH)}`;
    expect(evaluateExternalUrl(canary, 'feishu_document')).toMatchObject({ allowed: false, reason: 'too_long' });
  });

  it('fails closed when control characters remain hidden beyond the decode budget', () => {
    let encoded = '\n';
    for (let index = 0; index < 40; index += 1) encoded = encodeURIComponent(encoded);
    expect(evaluateExternalUrl(`https://tenant.feishu.cn/docx/doc-1${encoded}`, 'feishu_document'))
      .toMatchObject({ allowed: false, reason: 'invalid_encoding' });
  });

  it('does not let renderer purpose widen an OAuth URL into a document URL', () => {
    expect(evaluateExternalUrl('https://accounts.feishu.cn/open-apis/authen/v1/authorize', 'feishu_document'))
      .toMatchObject({ allowed: false, reason: 'untrusted_path' });
  });
});

describe('external link main-process contract', () => {
  it('opens only the canonical URL returned by the policy', async () => {
    const systemOpen = vi.fn(async () => undefined);
    const open = createExternalLinkOpener(systemOpen);
    await expect(open({ url: 'https://tenant.feishu.cn/docx/doc-1', purpose: 'feishu_document' }))
      .resolves.toMatchObject({ opened: true });
    expect(systemOpen).toHaveBeenCalledWith('https://tenant.feishu.cn/docx/doc-1');
  });

  it('revalidates renderer-approved document URLs in main before opening', async () => {
    const systemOpen = vi.fn(async () => undefined);
    const open = createExternalLinkOpener(systemOpen);
    await expect(open({ url: 'https://tenant.feishu.cn/docx/doc-1?return=https%3A%2F%2Fevil.example', purpose: 'feishu_document' }))
      .resolves.toMatchObject({ opened: false, reason: 'redirect_parameter_not_allowed' });
    expect(systemOpen).not.toHaveBeenCalled();
  });

  it('does not call the operating system for denied or failed values', async () => {
    const systemOpen = vi.fn(async () => undefined);
    const open = createExternalLinkOpener(systemOpen);
    const denied = await open({ url: 'https://evil.example/?secret=synthetic-url-57', purpose: 'trusted_link' });
    expect(denied).toMatchObject({ opened: false, reason: 'untrusted_host', errorCode: 'EXTERNAL_URL_UNTRUSTED_HOST' });
    expect(JSON.stringify(denied)).not.toContain('synthetic-url-57');
    expect(systemOpen).not.toHaveBeenCalled();
  });

  it('turns shell failures into a structured, sanitized result', async () => {
    const open = createExternalLinkOpener(async () => { throw new Error('synthetic-shell-secret-57'); });
    const result = await open({ url: 'https://tenant.feishu.cn/wiki/wiki-1', purpose: 'feishu_document' });
    expect(result).toMatchObject({ opened: false, reason: 'open_failed', errorCode: 'EXTERNAL_URL_OPEN_FAILED' });
    expect(JSON.stringify(result)).not.toContain('synthetic-shell-secret-57');
  });

  it('verifies the renderer and validates the IPC payload before opening', async () => {
    const verify = vi.fn();
    const open = vi.fn(async () => ({ opened: true as const, message: 'ok' }));
    const handler = createExternalLinkIpcHandler(verify, open);
    await expect(handler({ sender: 'renderer' }, { url: 'https://tenant.feishu.cn/docx/doc-1', purpose: 'feishu_document' }))
      .resolves.toEqual({ opened: true, message: 'ok' });
    expect(verify).toHaveBeenCalledWith({ sender: 'renderer' });
    expect(open).toHaveBeenCalledTimes(1);

    await expect(handler({ sender: 'renderer' }, { url: 57, purpose: 'feishu_document' }))
      .resolves.toMatchObject({ opened: false, reason: 'invalid_input', errorCode: 'EXTERNAL_URL_INVALID_INPUT' });
    expect(open).toHaveBeenCalledTimes(1);

    await expect(handler({ sender: 'renderer' }, { url: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize', purpose: 'trusted_link' }))
      .resolves.toMatchObject({ opened: false, reason: 'invalid_input', errorCode: 'EXTERNAL_URL_INVALID_INPUT' });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('never opens legacy window or navigation events without the explicit IPC action', () => {
    expect(legacyNavigationResult('https://tenant.feishu.cn/docx/doc-1'))
      .toMatchObject({ opened: false, reason: 'owner_action_required', errorCode: 'EXTERNAL_URL_OWNER_ACTION_REQUIRED' });
    expect(legacyNavigationResult('https://evil.example/docx/doc-1'))
      .toMatchObject({ opened: false, reason: 'untrusted_host', errorCode: 'EXTERNAL_URL_UNTRUSTED_HOST' });
  });
});
