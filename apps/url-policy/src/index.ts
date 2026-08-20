export const MAX_EXTERNAL_URL_LENGTH = 2048;

export type ExternalUrlPurpose = 'feishu_oauth' | 'feishu_document' | 'trusted_link';

export type ExternalUrlBlockReason =
  | 'invalid_input'
  | 'too_long'
  | 'control_characters'
  | 'invalid_encoding'
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'credentials_not_allowed'
  | 'local_or_private_host'
  | 'non_standard_port'
  | 'untrusted_host'
  | 'untrusted_path'
  | 'redirect_parameter_not_allowed'
  | 'owner_action_required'
  | 'open_failed';

export type ExternalUrlErrorCode = `EXTERNAL_URL_${Uppercase<ExternalUrlBlockReason>}`;

export type ExternalUrlDecision =
  | { allowed: true; url: string; purpose: ExternalUrlPurpose; target: 'oauth' | 'document' }
  | { allowed: false; reason: ExternalUrlBlockReason; message: string };

export type OpenExternalUrlInput = { url: string; purpose: ExternalUrlPurpose };

export type OpenExternalUrlResult =
  | { opened: true; message: string }
  | { opened: false; reason: ExternalUrlBlockReason; errorCode: ExternalUrlErrorCode; message: string };

const OAUTH_HOSTS = new Set(['accounts.feishu.cn', 'accounts.larksuite.com']);
const DOCUMENT_ROOTS = ['feishu.cn', 'larksuite.com'] as const;
const DOCUMENT_ROUTES = new Set(['docx', 'wiki', 'sheets']);
const OAUTH_QUERY_KEYS = ['client_id', 'redirect_uri', 'response_type', 'state', 'scope'] as const;
const REDIRECT_COMPONENT_WORDS = new Set(['return', 'callback', 'redirect', 'continue', 'next', 'destination', 'target', 'url']);
const MAX_DECODE_PASSES = 32;

const messages: Record<ExternalUrlBlockReason, string> = {
  invalid_input: '链接内容无效，系统没有打开外部页面。',
  too_long: '链接过长，系统没有打开外部页面。',
  control_characters: '链接包含不安全字符，系统没有打开外部页面。',
  invalid_encoding: '链接编码无效，系统没有打开外部页面。',
  invalid_url: '链接无法安全解析，系统没有打开外部页面。',
  unsupported_scheme: '只允许打开受信任的 HTTPS 飞书链接。',
  credentials_not_allowed: '链接包含用户名或密码，系统没有打开外部页面。',
  local_or_private_host: '本机或内网地址不能作为外部链接打开。',
  non_standard_port: '外部链接使用了不受信任的端口。',
  untrusted_host: '链接不属于受信任的飞书或 Lark 域名。',
  untrusted_path: '该飞书链接类型不在允许范围内。',
  redirect_parameter_not_allowed: '链接包含未验证的跳转目标，系统没有打开外部页面。',
  owner_action_required: '请使用页面内明确的打开按钮，系统没有执行这次跳转。',
  open_failed: '系统浏览器未能打开该链接，请稍后重试。',
};

function blocked(reason: ExternalUrlBlockReason): ExternalUrlDecision {
  return { allowed: false, reason, message: messages[reason] };
}

function decodeForInspection(value: string): { value: string } | { reason: 'control_characters' | 'invalid_encoding' } {
  let current = value;
  for (let depth = 0; depth < MAX_DECODE_PASSES; depth += 1) {
    if (/[\u0000-\u001f\u007f]/u.test(current) || current.includes('\\')) return { reason: 'control_characters' };
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) return { value: current };
      current = decoded;
    } catch {
      return { reason: 'invalid_encoding' };
    }
  }
  return { reason: 'invalid_encoding' };
}

function isPrivateOrLocalHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::' || host === '::1') return true;
  if (/^(?:fc|fd)[0-9a-f:]*$/i.test(host) || /^fe(?:8|9|a|b)[0-9a-f:]*$/i.test(host)) return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return false;
  const [first, second] = octets as [number, number, number, number];
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function isDocumentHost(hostname: string) {
  return DOCUMENT_ROOTS.some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

function documentRoute(url: URL) {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || url.pathname.endsWith('/')) return null;
  const route = segments[0]?.toLowerCase();
  const token = segments[1];
  if (!route || !DOCUMENT_ROUTES.has(route) || !token) return null;
  try {
    const decodedToken = decodeURIComponent(token);
    return /^[a-z0-9_-]+$/i.test(decodedToken) ? { route, token: decodedToken } : null;
  } catch {
    return null;
  }
}

type InspectedComponentEntry = {
  key: string;
  value: string;
  redirectLike: boolean;
  urlBearing: boolean;
};

type InspectedComponent = { entries: InspectedComponentEntry[] };

function componentKeyVariants(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return [key.toLowerCase().replaceAll(/[^a-z0-9]/gu, ''), ...words, ...words.slice(0, -1).map((word, index) => `${word}${words[index + 1]}`)];
}

function isRedirectComponentKey(key: string) {
  return componentKeyVariants(key).some((variant) => (
    REDIRECT_COMPONENT_WORDS.has(variant)
    || /^(?:return|callback|redirect|continue|next|destination|target)(?:url|uri|to)$/u.test(variant)
  ));
}

function inspectUrlComponent(value: string): InspectedComponent | { reason: 'control_characters' | 'invalid_encoding' } {
  const inspected = decodeForInspection(value);
  if ('reason' in inspected) return inspected;
  const entries = inspected.value.length === 0 ? [] : inspected.value.split(/[&;]/u).map((part) => {
    const separator = part.indexOf('=');
    const key = separator === -1 ? part : part.slice(0, separator);
    const componentValue = separator === -1 ? '' : part.slice(separator + 1);
    return {
      key,
      value: componentValue,
      redirectLike: isRedirectComponentKey(key),
      urlBearing: /(?:https?:\/\/|\/\/)/iu.test(`${key}=${componentValue}`),
    };
  });
  return { entries };
}

function singleQueryValue(url: URL, key: string) {
  const values = url.searchParams.getAll(key);
  return values.length === 1 ? values[0] : null;
}

function safeOAuthRedirect(value: string) {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/oauth\/feishu\/callback$/u.exec(value);
  return Boolean(match && Number(match[1]) <= 65535);
}

function canonicalOAuthUrl(url: URL, query: InspectedComponent, hasFragment: boolean) {
  if (hasFragment || query.entries.length !== OAUTH_QUERY_KEYS.length) return null;
  if (query.entries.some((entry) => (
    !OAUTH_QUERY_KEYS.includes(entry.key as typeof OAUTH_QUERY_KEYS[number])
    || (entry.redirectLike && entry.key !== 'redirect_uri')
    || (entry.urlBearing && entry.key !== 'redirect_uri')
  ))) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== OAUTH_QUERY_KEYS.length || keys.some((key) => !OAUTH_QUERY_KEYS.includes(key as typeof OAUTH_QUERY_KEYS[number]))) return null;

  const clientId = singleQueryValue(url, 'client_id');
  const redirectUri = singleQueryValue(url, 'redirect_uri');
  const responseType = singleQueryValue(url, 'response_type');
  const state = singleQueryValue(url, 'state');
  const scope = singleQueryValue(url, 'scope');
  if (
    !clientId || !/^[a-z0-9_-]{1,200}$/i.test(clientId)
    || !redirectUri || !safeOAuthRedirect(redirectUri)
    || responseType !== 'code'
    || !state || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(state)
    || !scope || scope.length > 4096
  ) return null;

  const scopes = scope.split(' ');
  if (!scopes.includes('offline_access') || scopes.some((item) => !/^[a-z0-9_.:-]+$/i.test(item))) return null;
  const canonical = new URL(`${url.protocol}//${url.hostname}${url.pathname}`);
  canonical.searchParams.set('client_id', clientId);
  canonical.searchParams.set('redirect_uri', redirectUri);
  canonical.searchParams.set('response_type', responseType);
  canonical.searchParams.set('state', state);
  canonical.searchParams.set('scope', scopes.join(' '));
  return canonical.toString();
}

function canonicalDocumentUrl(url: URL, hasQuery: boolean, hasFragment: boolean) {
  const document = documentRoute(url);
  if (!document || hasQuery || hasFragment) return null;
  return `${url.protocol}//${url.hostname}/${document.route}/${document.token}`;
}

function classifyTrustedTarget(url: URL, purpose: ExternalUrlPurpose): 'oauth' | 'document' | null {
  const oauth = OAUTH_HOSTS.has(url.hostname) && url.pathname === '/open-apis/authen/v1/authorize';
  const document = isDocumentHost(url.hostname) && Boolean(documentRoute(url));
  if (purpose === 'feishu_oauth') return oauth ? 'oauth' : null;
  if (purpose === 'feishu_document') return document ? 'document' : null;
  return oauth ? 'oauth' : document ? 'document' : null;
}

export function evaluateExternalUrl(input: unknown, purpose: ExternalUrlPurpose): ExternalUrlDecision {
  if (typeof input !== 'string' || input.length === 0) return blocked('invalid_input');
  if (input.length > MAX_EXTERNAL_URL_LENGTH) return blocked('too_long');
  if (input !== input.trim()) return blocked('control_characters');
  const inspectedInput = decodeForInspection(input);
  if ('reason' in inspectedInput) return blocked(inspectedInput.reason);

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return blocked('invalid_url');
  }
  if (url.protocol !== 'https:') return blocked('unsupported_scheme');
  if (url.username || url.password) return blocked('credentials_not_allowed');
  if (isPrivateOrLocalHost(url.hostname)) return blocked('local_or_private_host');
  if (url.port && url.port !== '443') return blocked('non_standard_port');

  const query = inspectUrlComponent(url.search.slice(1));
  if ('reason' in query) return blocked(query.reason);
  const fragment = inspectUrlComponent(url.hash.slice(1));
  if ('reason' in fragment) return blocked(fragment.reason);
  const hasQuery = input.includes('?');
  const hasFragment = input.includes('#');

  const target = classifyTrustedTarget(url, purpose);
  if (!target) {
    const trustedHost = OAUTH_HOSTS.has(url.hostname) || isDocumentHost(url.hostname);
    return blocked(trustedHost ? 'untrusted_path' : 'untrusted_host');
  }
  const canonicalUrl = target === 'oauth'
    ? canonicalOAuthUrl(url, query, hasFragment)
    : canonicalDocumentUrl(url, hasQuery, hasFragment);
  if (!canonicalUrl) return blocked('redirect_parameter_not_allowed');
  return { allowed: true, url: canonicalUrl, purpose, target };
}

export function externalUrlResult(decision: ExternalUrlDecision): OpenExternalUrlResult {
  return decision.allowed
    ? { opened: true, message: decision.target === 'oauth' ? '已打开飞书授权页面。' : '已在系统浏览器中打开飞书文档。' }
    : externalUrlFailure(decision.reason);
}

export function externalUrlFailure(reason: ExternalUrlBlockReason): OpenExternalUrlResult {
  const errorCode = `EXTERNAL_URL_${reason.toUpperCase()}` as ExternalUrlErrorCode;
  return { opened: false, reason, errorCode, message: messages[reason] };
}

export function externalUrlOpenFailed(): OpenExternalUrlResult {
  return externalUrlFailure('open_failed');
}

export function externalUrlOwnerActionRequired(): OpenExternalUrlResult {
  return externalUrlFailure('owner_action_required');
}
