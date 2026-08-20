import { randomUUID } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config.js';
import type { NormalizedSourceEvent, OwnerIdentity, SourceType } from '../domain.js';
import type {
  DurableEventReceipt,
  FeishuAdapter,
  FeishuScopeUpdate,
  IntegrationCheck,
  TokenVault,
  TokenVaultRefreshLease,
  TokenVaultSnapshot,
} from '../integration-contracts.js';
import { redactDiagnosticText } from '../redaction.js';

type AnyClient = InstanceType<typeof lark.Client>;

type FeishuAdapterOptions = {
  tokenVault?: TokenVault;
  client?: AnyClient;
};

type UserTokenRefreshBudget = { used: boolean };

/**
 * Build the provider callback with an explicit durable-receipt gate. The
 * returned promise does not resolve until `handle` resolves, so SDK callers
 * cannot acknowledge an accepted event before the local inbox write.
 */
export function createDurableFeishuEventHandler(input: {
  normalize: (data: unknown) => NormalizedSourceEvent | null;
  shouldAccept: (event: NormalizedSourceEvent) => boolean;
  handle: (event: NormalizedSourceEvent) => Promise<DurableEventReceipt>;
}) {
  return async (data: unknown) => {
    const event = input.normalize(data);
    if (!event || !input.shouldAccept(event)) return {};
    const receipt = await input.handle(event);
    if (!receipt || receipt.externalId !== event.externalId || !receipt.sourceEventId || !receipt.capturedAt) {
      throw new Error('飞书实时事件未取得有效耐久收件回执；已拒绝确认。');
    }
    return {};
  };
}

export type FeishuTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  /** Provider scope is deliberately left unknown until normalized. */
  scope?: unknown;
};

export class FeishuScopeError extends Error {
  readonly code = 'FEISHU_SCOPE_INVALID';

  constructor() {
    super('FEISHU_SCOPE_INVALID：飞书 OAuth scope 无效，已拒绝保存或继续授权。');
    this.name = 'FeishuScopeError';
  }
}

export type OwnerMessageScope = 'owner_dm' | 'owner_mentions';

export type FeishuAuthErrorStage = 'token_exchange' | 'token_refresh' | 'owner_identity' | 'connection_check';
export type FeishuAuthErrorCategory = 'configuration' | 'authorization' | 'permission' | 'network' | 'unknown';
export type FeishuApiErrorCategory = 'authorization' | 'permission' | 'rate_limit' | 'transient' | 'business';
export type FeishuBusinessCodeState = 'missing' | 'success' | 'error' | 'invalid';
export type FeishuAuthDiagnostic = {
  stage: FeishuAuthErrorStage;
  category: FeishuAuthErrorCategory;
  statusCode: number | null;
  code: string | null;
  providerError: string | null;
  message: string;
};

const validFeishuScopeToken = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Refresh tokens are opaque and preserved byte-for-byte, but blank values are never usable credentials. */
function hasUsableRefreshToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Normalize the provider's optional scope field without collapsing empty. */
export function feishuScopeUpdateOf(value: unknown): FeishuScopeUpdate {
  if (value === undefined) return { kind: 'omitted' };
  const rawValues = Array.isArray(value)
    ? value.map((item) => {
      if (typeof item !== 'string') throw new FeishuScopeError();
      return item;
    })
    : typeof value === 'string'
      ? [value]
      : (() => { throw new FeishuScopeError(); })();
  const scopes = [...new Set(rawValues
    .flatMap((item) => item.split(/[\s,]+/))
    .map((item) => item.trim())
    .filter(Boolean))];
  if (scopes.some((scope) => !validFeishuScopeToken.test(scope))) throw new FeishuScopeError();
  return { kind: 'set', scopes };
}

/** Validate the typed tri-state envelope at service/adapter boundaries. */
export function normalizeFeishuScopeUpdate(value: unknown): FeishuScopeUpdate {
  if (!value || typeof value !== 'object') throw new FeishuScopeError();
  const candidate = value as { kind?: unknown; scopes?: unknown };
  const keys = Object.keys(candidate);
  if (candidate.kind === 'omitted' && keys.length === 1 && keys[0] === 'kind') return { kind: 'omitted' };
  if (
    candidate.kind === 'set'
    && keys.length === 2
    && keys.includes('kind')
    && keys.includes('scopes')
    && Object.prototype.hasOwnProperty.call(candidate, 'scopes')
  ) {
    const update = feishuScopeUpdateOf(candidate.scopes);
    if (update.kind !== 'set') throw new FeishuScopeError();
    return update;
  }
  throw new FeishuScopeError();
}

export type FeishuScopeSource = OwnerMessageScope | 'calendar' | 'minutes';
export type DurableGrantedScopes = {
  valid: boolean;
  scopes: string[];
  reason: 'missing' | 'null' | 'invalid_json' | 'invalid_type' | 'invalid_scope' | 'valid';
};

/**
 * The durable owner_profile scope column is the authorization source of truth
 * for every live source runner. Keep its parser aligned with the OAuth
 * tri-state normalization above, but fail closed for malformed persisted data.
 * A syntactically valid empty array is still unauthorized for every source
 * with required scopes; it must never fall back to an older token/snapshot.
 */
export function parseDurableGrantedScopes(value: unknown): DurableGrantedScopes {
  if (value === undefined) return { valid: false, scopes: [], reason: 'missing' };
  if (value === null) return { valid: false, scopes: [], reason: 'null' };
  if (typeof value !== 'string' || value.trim() === '') return { valid: false, scopes: [], reason: 'invalid_type' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { valid: false, scopes: [], reason: 'invalid_json' };
  }
  if (!Array.isArray(parsed)) return { valid: false, scopes: [], reason: 'invalid_type' };
  const normalized = [...new Set(parsed.map((scope) => {
    if (typeof scope !== 'string') return null;
    const trimmed = scope.trim();
    return trimmed && validFeishuScopeToken.test(trimmed) ? trimmed : null;
  }))];
  if (normalized.some((scope) => scope === null)) return { valid: false, scopes: [], reason: 'invalid_scope' };
  return { valid: true, scopes: normalized as string[], reason: 'valid' };
}

/** Required user scopes are declared once and reused by all source runners. */
export const requiredFeishuScopes: Readonly<Record<FeishuScopeSource, ReadonlyArray<ReadonlyArray<string>>>> = {
  owner_dm: [
    ['im:chat:read'],
    ['im:message:readonly', 'im:message'],
    ['im:message.p2p_msg:get_as_user'],
  ],
  owner_mentions: [
    ['im:chat:read'],
    ['im:message:readonly', 'im:message'],
    ['im:message.group_msg:get_as_user'],
  ],
  calendar: [
    ['calendar:calendar:readonly'],
  ],
  minutes: [
    ['minutes:minutes.search:read'],
    ['minutes:minutes.basic:read'],
    ['minutes:minutes.artifacts:read'],
    ['minutes:minutes.transcript:export'],
  ],
};

export function missingFeishuScopes(kind: FeishuScopeSource, grantedScopes: readonly string[]) {
  const granted = new Set(grantedScopes);
  return requiredFeishuScopes[kind]
    .filter((alternatives) => !alternatives.some((scope) => granted.has(scope)))
    .map((alternatives) => alternatives.join(' 或 '));
}

function safeDiagnosticText(value: unknown) {
  return redactDiagnosticText(value, 240);
}

function firstNumeric(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 599) return value;
  if (typeof value === 'string' && /^\d{1,3}$/.test(value)) {
    const numeric = Number(value);
    return numeric <= 599 ? numeric : null;
  }
  return null;
}

type ErrorRecord = Record<string, unknown>;

function asErrorRecord(value: unknown): ErrorRecord | null {
  return value && typeof value === 'object' ? value as ErrorRecord : null;
}

function controlledRequestId(value: unknown) {
  if (typeof value !== 'string') return null;
  const requestId = value.trim();
  return requestId && requestId.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(requestId) ? requestId : null;
}

function normalizedBusinessCode(value: unknown) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value !== 'string' || !/^-?\d{1,16}$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? String(numeric) : null;
}

/**
 * Feishu SDK responses are not fully consistent: most failures expose
 * `code/msg` at the top level, while some raw requests put them under
 * `response.data`. Keep the extraction in one place so callers do not
 * accidentally treat a permission failure as an empty successful page.
 */
export function extractFeishuErrorDetails(error: unknown): {
  code: string | null;
  codeState: FeishuBusinessCodeState;
  statusCode: number | null;
  message: string;
  requestId: string | null;
} {
  const root = asErrorRecord(error);
  const response = asErrorRecord(root?.response);
  const responseData = asErrorRecord(response?.data);
  const data = asErrorRecord(root?.data);
  const nestedError = asErrorRecord(root?.error);
  const candidates = [root, response, responseData, data, nestedError].filter((value): value is ErrorRecord => Boolean(value));
  const codeValues = candidates.map((value) => value.code ?? value.error_code ?? value.errorCode);
  const presentCodeValues = codeValues.filter((value) => value !== undefined && value !== null && value !== '');
  const normalizedCodes = presentCodeValues.map(normalizedBusinessCode);
  const errorCode = normalizedCodes.find((value) => value !== null && value !== '0') ?? null;
  const codeState: FeishuBusinessCodeState = errorCode !== null
    ? 'error'
    : normalizedCodes.some((value) => value === null)
      ? 'invalid'
      : normalizedCodes.includes('0')
        ? 'success'
        : 'missing';
  const statusValues = candidates.map((value) => value.statusCode ?? value.status_code ?? value.status ?? value.httpStatus);
  const rawStatus = statusValues.find((value) => {
    const numeric = firstNumeric(value);
    return numeric !== null && numeric >= 400;
  }) ?? statusValues.find((value) => value !== undefined && value !== null && value !== '');
  const messageValues = candidates.map((value) => value.msg ?? value.message ?? value.error_description ?? value.errorDescription ?? (typeof value.error === 'string' ? value.error : undefined));
  const rawMessage = messageValues.find((value) => value !== undefined && value !== null && value !== '' && !/^request failed$/i.test(String(value)))
    ?? messageValues.find((value) => value !== undefined && value !== null && value !== '');
  const requestId = candidates
    .map((value) => value.request_id ?? value.requestId ?? value.requestID)
    .map(controlledRequestId)
    .find((value): value is string => Boolean(value)) ?? null;
  const fallbackMessage = error instanceof Error ? error.message : String(error ?? '');
  return {
    code: errorCode,
    codeState,
    statusCode: firstNumeric(rawStatus),
    message: safeDiagnosticText(rawMessage ?? fallbackMessage),
    requestId,
  };
}

// Keep this allowlist small and code-only. Official Feishu documentation
// confirms 230027 (permission) and 99991400 (rate limit); 99991663/64 are the
// repository's existing user-token invalidation contract and remain subject to
// real-tenant verification. Unknown codes never inherit a category from msg.
const feishuApiCategoryByCode: Readonly<Record<string, FeishuApiErrorCategory>> = {
  '230027': 'permission',
  '99991400': 'rate_limit',
  '99991663': 'authorization',
  '99991664': 'authorization',
};

function feishuApiErrorCategory(details: Pick<ReturnType<typeof extractFeishuErrorDetails>, 'code' | 'statusCode'>): FeishuApiErrorCategory {
  const mapped = details.code ? feishuApiCategoryByCode[details.code] : undefined;
  if (mapped) return mapped;
  if (details.statusCode === 401) return 'authorization';
  if (details.statusCode === 403) return 'permission';
  if (details.statusCode === 429) return 'rate_limit';
  if ((details.statusCode ?? 0) >= 500) return 'transient';
  return 'business';
}

const feishuTransportErrorCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Recognize only real Error instances (or a bounded Error cause chain) as
 * transport failures. Provider response objects with a string `code` must
 * remain invalid business responses, even when that string resembles a
 * Node.js transport code.
 */
export function isFeishuTransportError(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    const value = current as Error & { code?: unknown; cause?: unknown };
    const code = typeof value.code === 'string' ? value.code.trim().toUpperCase() : '';
    if (feishuTransportErrorCodes.has(code)) return true;
    if (value.name === 'AbortError') return true;
    if (/^fetch failed$/i.test(value.message.trim())) return true;
    current = value.cause;
  }
  return false;
}

/**
 * Classify both adapter errors and the plain errors used by contract fakes.
 * The adapter always throws FeishuApiError for a non-zero/invalid business
 * response; fakes may instead throw an Error carrying the same code/status.
 * Keep the legacy network-text fallback here so every source runner shares
 * one retry/status policy without making unknown business codes inherit a
 * category from a provider-localized message.
 */
export function feishuApiErrorCategoryOf(error: unknown): FeishuApiErrorCategory {
  if (error instanceof FeishuApiError) return error.category;
  if (isFeishuTransportError(error)) return 'transient';
  const details = extractFeishuErrorDetails(error);
  const category = feishuApiErrorCategory(details);
  if (details.codeState !== 'missing' || details.statusCode !== null) return category;
  const message = details.message;
  if (/unauthor|expired|invalid.?token|revoked|授权已失效|撤销|没有可刷新/i.test(message)) return 'authorization';
  if (/permission|scope|forbidden|管理员|权限不足/i.test(message)) return 'permission';
  return category;
}

export function isFeishuBusinessError(error: unknown) {
  if (error instanceof FeishuApiError) return error.businessFailure;
  if (isFeishuTransportError(error)) return false;
  const details = extractFeishuErrorDetails(error);
  return details.codeState === 'error' || details.codeState === 'invalid';
}

export function isFeishuRetryableError(error: unknown) {
  const category = feishuApiErrorCategoryOf(error);
  return category === 'rate_limit' || category === 'transient';
}

export function feishuApiErrorStatus(error: unknown): 'unauthorized' | 'admin_required' | 'error' {
  const category = feishuApiErrorCategoryOf(error);
  if (category === 'authorization') return 'unauthorized';
  if (category === 'permission') return 'admin_required';
  return 'error';
}

/**
 * Detail failures that must abort the source run instead of becoming a
 * permission-style partial result. Known permission/authorization errors
 * retain their existing partial contract; retryable exhaustion and unknown
 * business failures do not.
 */
export function isFeishuDetailBlockingError(error: unknown) {
  if (isFeishuRetryableError(error)) return true;
  if (error instanceof FeishuApiError) return error.category === 'business';
  return isFeishuBusinessError(error);
}

/** Return a stable, provider-safe diagnostic for classified Feishu failures. */
export function feishuErrorDiagnostic(error: unknown) {
  if (error instanceof FeishuApiError) return error.message;
  if (isFeishuBusinessError(error) || isFeishuRetryableError(error)) {
    const details = extractFeishuErrorDetails(error);
    const requestId = details.requestId ? ` request_id=${details.requestId}` : '';
    return `FEISHU_API_ERROR code=${details.code ?? 'UNKNOWN'} category=${feishuApiErrorCategoryOf(error)}${requestId}`;
  }
  // Unknown plain errors are not provider metadata.  Never export their
  // message: it may contain refresh_token, app_secret, paths, or headers.
  // Keep the boundary fixed to the finite category allowlist instead.
  return `FEISHU_API_ERROR code=UNKNOWN category=${feishuApiErrorCategoryOf(error)}`;
}

function feishuAuthErrorCategory(details: ReturnType<typeof extractFeishuErrorDetails>): FeishuAuthErrorCategory {
  const apiCategory = feishuApiErrorCategory(details);
  if (apiCategory === 'authorization') return 'authorization';
  if (apiCategory === 'permission') return 'permission';
  if (apiCategory === 'rate_limit' || apiCategory === 'transient') return 'network';
  const combined = `${details.code ?? ''} ${details.statusCode ?? ''} ${details.message}`;
  if (/7104|app.?secret.*(empty|missing)|client.?assertion.*empty/i.test(combined)) return 'configuration';
  if (/invalid.?grant|invalid.?request|authorization.?code|code.*(expired|invalid|used)|redirect.?uri|code.?verifier|pkce|state/i.test(combined)) return 'authorization';
  if (/permission|scope|admin|approval|forbidden/i.test(combined)) return 'permission';
  if (details.statusCode === 0 || /network|timeout|econn|enotfound|socket|fetch failed/i.test(combined)) return 'network';
  return 'unknown';
}

export function describeFeishuAuthError(error: unknown, stage: FeishuAuthErrorStage): FeishuAuthDiagnostic {
  const details = extractFeishuErrorDetails(error);
  const statusCode = details.statusCode;
  const code = details.code;
  const providerError = details.message;
  const detail = providerError;
  const category = feishuAuthErrorCategory(details);
  const stageLabel = stage === 'token_exchange' ? '授权码换 Token' : stage === 'token_refresh' ? '刷新 Token' : stage === 'owner_identity' ? '读取系统主人身份' : '连接检查';
  const hint = code === '20049'
    ? '这是 PKCE 校验失败，不是 scope 权限问题。请关闭旧授权页，并从当前数据 PM 重新发起授权。'
    : category === 'configuration'
    ? '请确认 App ID、App Secret 属于同一个自建应用。'
    : category === 'authorization'
      ? '请重新发起授权，并确认回调地址与应用配置完全一致。授权码只能使用一次。'
      : category === 'permission'
        ? '请检查用户权限范围及管理员批准状态。'
        : category === 'network'
          ? '请检查网络、代理或公司网关后重试。'
          : '请根据官方错误说明检查飞书应用配置。';
  const codePart = code ? `（官方 code：${code}${statusCode ? `，HTTP ${statusCode}` : ''}）` : statusCode ? `（HTTP ${statusCode}，未返回业务 code）` : '（未取得官方 code）';
  const detailPart = detail && !/^request failed$/i.test(detail) ? ` 官方说明：${detail}` : '';
  return {
    stage,
    category,
    statusCode,
    code,
    providerError: providerError || null,
    message: `飞书${stageLabel}失败${codePart}。${hint}${detailPart}`.slice(0, 600),
  };
}

export class FeishuAuthError extends Error {
  readonly diagnostic: FeishuAuthDiagnostic;

  constructor(diagnostic: FeishuAuthDiagnostic) {
    super(diagnostic.message);
    this.name = 'FeishuAuthError';
    this.diagnostic = diagnostic;
  }
}

const tokenKeys = {
  access: 'FEISHU_USER_ACCESS_TOKEN',
  refresh: 'FEISHU_REFRESH_TOKEN',
  expiresAt: 'FEISHU_TOKEN_EXPIRES_AT',
  grantedScopes: 'FEISHU_GRANTED_SCOPES',
} as const;

type RefreshOutcome = { expiresAt: string };

/**
 * A vault is the identity boundary for local OAuth state.  Sharing the
 * singleflight map by vault collapses refreshes from multiple adapters that
 * are created during a desktop reload, while keeping unrelated vaults apart.
 */
const refreshFlightsByVault = new WeakMap<object, Map<string, Promise<RefreshOutcome>>>();
const refreshLeasePollMs = 25;
const refreshLeaseWaitMs = 30_000;

function hostFor(domain: AppConfig['feishu']['domain']) {
  return domain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
}

function oauthHostFor(domain: AppConfig['feishu']['domain']) {
  return domain === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn';
}

function safeError(error: unknown, stage: FeishuAuthErrorStage = 'connection_check') {
  const diagnostic = describeFeishuAuthError(error, stage);
  if (diagnostic.category === 'authorization') return { status: 'unauthorized' as const, message: diagnostic.message, diagnostic };
  if (diagnostic.category === 'permission') return { status: 'unavailable' as const, message: diagnostic.message, diagnostic };
  return { status: 'unavailable' as const, message: diagnostic.message, diagnostic };
}

function parseMessageContent(content: string | undefined, messageType: string | undefined) {
  if (!content) return '';
  if (messageType === 'text') {
    try {
      const value = JSON.parse(content) as { text?: string };
      return value.text ?? content;
    } catch {
      return content;
    }
  }
  // Keep the source fact without copying attachment bytes or card payloads.
  return `[${messageType || 'message'}] ${content.slice(0, 2000)}`;
}

function mentionIds(mentions: unknown): string[] {
  if (!Array.isArray(mentions)) return [];
  const values = new Set<string>();
  for (const item of mentions) {
    if (!item || typeof item !== 'object') continue;
    const value = item as { id?: string | { open_id?: string; union_id?: string; user_id?: string }; open_id?: string; union_id?: string; user_id?: string };
    if (typeof value.id === 'string') values.add(value.id);
    if (value.id && typeof value.id === 'object') {
      if (value.id.open_id) values.add(value.id.open_id);
      if (value.id.union_id) values.add(value.id.union_id);
      if (value.id.user_id) values.add(value.id.user_id);
    }
    if (value.open_id) values.add(value.open_id);
    if (value.union_id) values.add(value.union_id);
    if (value.user_id) values.add(value.user_id);
  }
  return [...values];
}

/** Return a timestamp only when Feishu actually supplied a valid value. */
export function optionalFeishuTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let millis: number;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const numeric = Number(value);
    millis = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  } else {
    millis = Date.parse(String(value));
  }
  if (!Number.isFinite(millis) || !Number.isFinite(new Date(millis).getTime())) return undefined;
  return new Date(millis).toISOString();
}

/** Feishu returns create_time in milliseconds in most message APIs, while
 * some fixtures and older endpoints use seconds. Missing event time falls
 * back to capture time; optional update time must use the helper above. */
export function normalizeFeishuTimestamp(value: unknown): string {
  return optionalFeishuTimestamp(value) ?? new Date().toISOString();
}

/** Message list/search windows use Unix seconds, not ISO strings. */
export function feishuUnixSeconds(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const numeric = Number(value);
    return String(Math.floor(numeric >= 1_000_000_000_000 ? numeric / 1000 : numeric));
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? String(Math.floor(parsed / 1000)) : undefined;
}

function isUnauthorizedError(error: unknown) {
  return feishuApiErrorCategory(extractFeishuErrorDetails(error)) === 'authorization';
}

export class FeishuApiError extends Error {
  readonly errorCode = 'FEISHU_API_ERROR';
  readonly codeState: FeishuBusinessCodeState;
  readonly businessFailure: boolean;
  readonly code?: number;
  readonly statusCode?: number;
  readonly category: FeishuApiErrorCategory;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(details: ReturnType<typeof extractFeishuErrorDetails>) {
    const category = feishuApiErrorCategory(details);
    const controlled = [
      `code=${details.code ?? 'UNKNOWN'}`,
      `category=${category}`,
      details.requestId ? `request_id=${details.requestId}` : null,
    ].filter(Boolean).join(' ');
    super(`FEISHU_API_ERROR ${controlled}`);
    this.name = 'FeishuApiError';
    this.codeState = details.codeState;
    this.businessFailure = details.codeState === 'error' || details.codeState === 'invalid';
    this.code = details.code && /^\d+$/.test(details.code) ? Number(details.code) : undefined;
    this.statusCode = details.statusCode ?? undefined;
    this.category = category;
    this.requestId = details.requestId ?? undefined;
    this.retryable = category === 'rate_limit' || category === 'transient';
  }
}

function assertFeishuApiSuccess<T>(response: T): T {
  const details = extractFeishuErrorDetails(response);
  if (details.codeState === 'error' || details.codeState === 'invalid') throw new FeishuApiError(details);
  return response;
}

export class LiveFeishuAdapter implements FeishuAdapter {
  readonly kind = 'live' as const;
  private readonly client: AnyClient;
  private readonly tokenVault?: TokenVault;
  private wsClient: lark.WSClient | null = null;
  private eventHandler: ((event: NormalizedSourceEvent) => Promise<DurableEventReceipt>) | null = null;
  private running = false;
  private _sentCount = 0;
  private readonly pendingOAuthStates = new Map<string, number>();
  private ownerIdentity: OwnerIdentity | null = null;

  constructor(
    private readonly config: AppConfig['feishu'],
    options: FeishuAdapterOptions = {},
  ) {
    this.tokenVault = options.tokenVault;
    this.client = options.client ?? new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    });
  }

  get sentCount() {
    return this._sentCount;
  }

  async buildAuthorizationUrl(state = randomUUID()) {
    const params = new URLSearchParams({
      client_id: this.config.appId,
      redirect_uri: this.config.oauthRedirectUri,
      response_type: 'code',
      state,
    });
    const configuredScopes = feishuScopeUpdateOf(this.config.oauthScopes);
    const scopes = new Set(configuredScopes.kind === 'set' ? configuredScopes.scopes : []);
    // A desktop background sync cannot remain healthy without a refresh
    // token. Feishu only returns it when offline_access is requested and
    // granted, so the authorization URL always includes this minimum scope.
    scopes.add('offline_access');
    params.set('scope', [...scopes].join(' '));
    // This is the confidential-client flow documented for self-built apps:
    // the Electron main process keeps the app secret encrypted and exchanges
    // the code server-side. Do not send a code_verifier unless the matching
    // authorization request is guaranteed to carry the same PKCE challenge.
    // Starting a new flow invalidates old browser tabs and their callback state.
    this.pendingOAuthStates.clear();
    this.pendingOAuthStates.set(state, Date.now());
    return `https://${oauthHostFor(this.config.domain)}/open-apis/authen/v1/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string, state?: string) {
    if (!code) throw new Error('飞书 OAuth code 不能为空。');
    const startedAt = state ? this.pendingOAuthStates.get(state) : undefined;
    if (!state || startedAt === undefined || Date.now() - startedAt > 10 * 60 * 1000) {
      if (state) this.pendingOAuthStates.delete(state);
      throw new Error('飞书 OAuth 状态已失效，请关闭旧授权页并从数据 PM 重新发起授权。');
    }
    // A callback state is single-use, even if the provider exchange fails.
    this.pendingOAuthStates.delete(state);
    try {
      const expectedGeneration = await this.tokenWriteGeneration();
      const token = await this.client.accessToken.retrieveByAuthorizationCode({
        code,
        redirectUri: this.config.oauthRedirectUri || undefined,
      });
      if (!hasUsableRefreshToken(token.refreshToken)) {
        throw new FeishuAuthError({
          stage: 'token_exchange',
          category: 'permission',
          statusCode: null,
          code: 'offline_access_missing',
          providerError: null,
          message: '飞书授权完成但未返回 refresh token（官方 code：offline_access_missing）。请确认已申请并批准 offline_access，然后重新授权。',
        });
      }
      const saved = await this.saveTokens(token, expectedGeneration);
      if (!saved.accepted) throw new Error('飞书授权状态已更新，已拒绝迟到的 Token 响应。');
      return { expiresAt: new Date(Date.now() + (token.expiresIn ?? 7200) * 1000).toISOString() };
    } catch (error) {
      if (error instanceof FeishuAuthError) throw error;
      throw new FeishuAuthError(describeFeishuAuthError(error, 'token_exchange'));
    }
  }

  async refreshToken(refreshToken?: string) {
    const vault = this.tokenVault;
    if (!vault) throw new Error('飞书 token vault 未配置，不能刷新授权。');
    const identityKey = this.ownerIdentity?.openId ? `owner:${this.ownerIdentity.openId}` : 'owner:primary';
    let flights = refreshFlightsByVault.get(vault);
    if (!flights) {
      flights = new Map();
      refreshFlightsByVault.set(vault, flights);
    }
    const flightKey = identityKey;
    const existing = flights.get(flightKey);
    if (existing) return existing;
    const flight = this.performRefreshWithLease(identityKey, refreshToken);
    flights.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (flights.get(flightKey) === flight) flights.delete(flightKey);
    }
  }

  private async performRefreshWithLease(identityKey: string, requestedRefresh?: string): Promise<RefreshOutcome> {
    const vault = this.tokenVault;
    if (!vault) throw new Error('飞书 token vault 未配置，不能刷新授权。');
    if (!vault.acquireRefreshLease || !vault.renewRefreshLease || !vault.releaseRefreshLease) {
      throw new Error('飞书 token vault 缺少跨进程 refresh lease 能力，已拒绝刷新授权。');
    }
    const lease = await this.waitForRefreshLease(identityKey);
    if (lease.status === 'failed') {
      if (lease.phase === 'recovery_required') throw new Error('飞书上一轮 refresh provider 状态不确定，需要重新授权或人工恢复。');
      throw new Error('飞书上一轮 refresh lease 未完成，已拒绝重复调用 provider。');
    }
    if (lease.status === 'completed') {
      const expiresAt = lease.resultExpiresAt ?? lease.snapshot.expiresAt;
      if (!expiresAt) throw new Error('飞书 refresh lease 已完成但缺少可证明的 token 状态，已拒绝刷新授权。');
      return { expiresAt };
    }
    const fencingToken = lease.fencingToken;
    const tokenFingerprint = lease.tokenFingerprint;
    if (lease.status !== 'acquired' || !lease.leaseId || typeof fencingToken !== 'number' || !Number.isSafeInteger(fencingToken) || fencingToken <= 0 || tokenFingerprint === undefined) throw new Error('飞书 refresh lease 状态无效，已拒绝刷新授权。');
    const snapshot = lease.snapshot;
    this.assertTokenSnapshot(snapshot);
    if (requestedRefresh && requestedRefresh !== snapshot.refreshToken) {
      await vault.releaseRefreshLease(identityKey, lease.leaseId, { status: 'failed', generation: snapshot.generation }, fencingToken);
      throw new Error('飞书授权状态已更新，已拒绝过期的 refresh token。');
    }
    if (!hasUsableRefreshToken(snapshot.refreshToken)) {
      await vault.releaseRefreshLease(identityKey, lease.leaseId, { status: 'failed', generation: snapshot.generation }, fencingToken);
      throw new Error('没有可刷新的飞书 refresh token。');
    }
    return this.performRefresh(snapshot.refreshToken, snapshot.generation, identityKey, lease.leaseId, fencingToken, tokenFingerprint);
  }

  private async waitForRefreshLease(identityKey: string): Promise<TokenVaultRefreshLease> {
    const vault = this.tokenVault;
    if (!vault?.acquireRefreshLease) throw new Error('飞书 token vault 缺少跨进程 refresh lease 能力，已拒绝刷新授权。');
    const deadline = Date.now() + refreshLeaseWaitMs;
    let waitForResult = false;
    while (true) {
      const lease = await vault.acquireRefreshLease(identityKey, waitForResult, true);
      if (lease.status !== 'busy') return lease;
      waitForResult = true;
      if (Date.now() >= deadline) throw new Error('飞书 refresh lease 等待超时，已拒绝重复调用 provider。');
      await new Promise<void>((resolve) => setTimeout(resolve, refreshLeasePollMs));
    }
  }

  private async performRefresh(refresh: string, expectedGeneration: number, identityKey: string, leaseId: string, fencingToken: number, tokenFingerprint: string | null): Promise<RefreshOutcome> {
    const vault = this.tokenVault;
    if (!vault?.renewRefreshLease || !vault.releaseRefreshLease) throw new Error('飞书 token vault 缺少跨进程 refresh lease 能力，已拒绝刷新授权。');
    let leaseLost = false;
    let currentPhase: 'claimed' | 'provider_started' | 'response_pending' = 'claimed';
    const renew = async (phase: 'claimed' | 'provider_started' | 'response_pending' = currentPhase) => {
      if (leaseLost) return false;
      const renewed = await vault.renewRefreshLease!(identityKey, leaseId, fencingToken, phase);
      if (!renewed) leaseLost = true;
      else currentPhase = phase;
      return renewed;
    };
    const heartbeat = setInterval(() => { void renew(currentPhase).catch(() => { leaseLost = true; }); }, 5_000);
    let providerStarted = false;
    try {
      if (!await renew()) throw new Error('飞书 refresh lease 已失效，已拒绝调用 provider。');
      if (!await renew('provider_started')) throw new Error('飞书 refresh lease 已失效，已拒绝调用 provider。');
      providerStarted = true;
      const token = await this.client.accessToken.refresh({ refreshToken: refresh });
      if (leaseLost || !await renew('response_pending')) throw new Error('飞书 refresh lease 在 provider 响应后已失效，已拒绝保存 Token。');
      const expiresAt = new Date(Date.now() + (token.expiresIn ?? 7200) * 1000).toISOString();
      const saved = await this.saveTokens(token, expectedGeneration, { identityKey, leaseId, fencingToken, tokenFingerprint, resultExpiresAt: expiresAt });
      if (saved.accepted) {
        // DesktopConfigStore publishes completion inside the same journaled
        // commit. Older contract fakes may only expose the separate release
        // operation, so keep this idempotent compatibility path; a completed
        // durable lease rejects the second release without changing state.
        try {
          await vault.releaseRefreshLease(identityKey, leaseId, { status: 'completed', generation: saved.generation, expiresAt }, fencingToken);
        } catch {
          // The atomic store already marked the lease completed, or a stale
          // owner lost the fence. Never turn a durable success into a second
          // provider call.
        }
        return { expiresAt };
      }
      // A provider refresh may rotate/consume the presented token.  A CAS
      // rejection therefore cannot be reported as success: the caller must
      // surface the conflict and never pretend the stored token is healthy.
      throw new Error('飞书授权状态已更新，刷新结果未写入，已拒绝迟到的 Token 响应。');
    } catch (error) {
      try {
        // Once the provider request has started, the response does not prove
        // that the presented rotating refresh token was not consumed.  This
        // includes FeishuApiError business/auth/rate-limit/5xx responses and
        // plain or transport exceptions.  Only failures before the provider
        // call may be retried with the same credential.
        const definitelyNonConsuming = !providerStarted;
        await vault.releaseRefreshLease(identityKey, leaseId, {
          status: 'failed',
          generation: expectedGeneration,
          phase: definitelyNonConsuming ? 'retryable_failed' : 'recovery_required',
        }, fencingToken);
      } catch {
        // Keep the provider/config error controlled; a lost lease is never
        // converted into success and the durable marker remains fail-closed.
      }
      if (error instanceof FeishuAuthError) throw error;
      throw new FeishuAuthError(describeFeishuAuthError(error, 'token_refresh'));
    } finally {
      clearInterval(heartbeat);
    }
  }

  async revokeAuthorization() {
    // The local vault is the authoritative stop gate for this desktop
    // process. Feishu tenant-side revocation requires a live, tenant-specific
    // provider contract and is deliberately reported as unverified here.
    if (this.tokenVault?.setMany) {
      await this.tokenVault.setMany({
        [tokenKeys.access]: '',
        [tokenKeys.refresh]: '',
        [tokenKeys.expiresAt]: '',
        [tokenKeys.grantedScopes]: '',
      });
    } else if (this.tokenVault) {
      await Promise.all([
        this.tokenVault.set(tokenKeys.access, ''),
        this.tokenVault.set(tokenKeys.refresh, ''),
        this.tokenVault.set(tokenKeys.expiresAt, ''),
        this.tokenVault.set(tokenKeys.grantedScopes, ''),
      ]);
    }
    this.ownerIdentity = null;
    this.pendingOAuthStates.clear();
    return { localTokensCleared: Boolean(this.tokenVault), providerRevoked: false };
  }

  async captureAuthorizationState() {
    if (!this.tokenVault) return null;
    const [access, refresh, expiresAt, grantedScopes] = await Promise.all([
      this.tokenVault.get(tokenKeys.access),
      this.tokenVault.get(tokenKeys.refresh),
      this.tokenVault.get(tokenKeys.expiresAt),
      this.tokenVault.get(tokenKeys.grantedScopes),
    ]);
    return { access, refresh, expiresAt, grantedScopes };
  }

  async restoreAuthorizationState(snapshot: unknown) {
    if (!this.tokenVault || !snapshot || typeof snapshot !== 'object') return;
    const state = snapshot as { access?: string | null; refresh?: string | null; expiresAt?: string | null; grantedScopes?: string | null };
    const values = {
      [tokenKeys.access]: state.access ?? '',
      [tokenKeys.refresh]: state.refresh ?? '',
      [tokenKeys.expiresAt]: state.expiresAt ?? '',
      [tokenKeys.grantedScopes]: state.grantedScopes ?? '',
    };
    if (this.tokenVault.setMany) await this.tokenVault.setMany(values);
    else for (const [key, value] of Object.entries(values)) await this.tokenVault.set(key, value);
  }

  private async refreshUserTokenOnce(budget: UserTokenRefreshBudget, refreshToken?: string) {
    if (budget.used) return false;
    budget.used = true;
    try {
      await this.refreshToken(refreshToken);
      return true;
    } catch (error) {
      if (!refreshToken && error instanceof Error && error.message === '没有可刷新的飞书 refresh token。') return false;
      throw error;
    }
  }

  private async ensureFreshUserToken(refreshBudget: UserTokenRefreshBudget) {
    const access = await this.tokenVault?.get(tokenKeys.access);
    if (!access) throw new Error('读取系统主人个人信息需要完成用户 OAuth。');
    const expiresAt = await this.tokenVault?.get(tokenKeys.expiresAt);
    if (expiresAt && Date.parse(expiresAt) <= Date.now() + 60_000) {
      await this.refreshUserTokenOnce(refreshBudget);
    }
    const current = await this.tokenVault?.get(tokenKeys.access);
    if (!current) throw new Error('飞书用户授权令牌不存在。');
    return current;
  }

  private async withUserToken<T>(operation: (options: ReturnType<typeof lark.withUserAccessToken>) => Promise<T>) {
    const refreshBudget: UserTokenRefreshBudget = { used: false };
    while (true) {
      const access = await this.ensureFreshUserToken(refreshBudget);
      try {
        return assertFeishuApiSuccess(await operation(lark.withUserAccessToken(access)));
      } catch (error) {
        if (isUnauthorizedError(error) && await this.refreshUserTokenOnce(refreshBudget)) continue;
        throw error;
      }
    }
  }

  async testConnection(): Promise<IntegrationCheck> {
    const checkedAt = new Date().toISOString();
    if (!this.config.externalEnabled) {
      return { ok: false, status: 'not_configured', message: '飞书外部连接开关未开启；当前仍使用本地或 Mock 模式。', checkedAt };
    }
    if (!this.config.appId || !this.config.appSecret) {
      return { ok: false, status: 'not_configured', message: '请先填写飞书 App ID 和 App Secret。', checkedAt };
    }
    const started = Date.now();
    try {
      assertFeishuApiSuccess(await this.client.auth.v3.tenantAccessToken.internal({
        data: { app_id: this.config.appId, app_secret: this.config.appSecret },
      }));
      const access = await this.tokenVault?.get(tokenKeys.access);
      if (access) {
        try {
          await this.getCurrentUser();
        } catch (error) {
          const safe = safeError(error, 'owner_identity');
          return { ok: false, status: safe.status, message: safe.message, checkedAt, details: { ...safe.diagnostic, latencyMs: Date.now() - started } };
        }
      }
      return {
        ok: true,
        status: 'ready',
        message: access
          ? (this.config.oauthScopes.trim()
            ? '飞书应用凭证和用户 OAuth 均可用；可在设置中按姓名选择已有个人单聊、按群名选择主人所在群，再周期读取获准范围。机器人补充入口仍按应用身份运行。'
            : '飞书应用凭证和用户 OAuth 可用，但 OAuth 权限范围配置为空；联系人、个人单聊、群聊 @主人、日历和妙记仍受限。')
          : (this.config.oauthScopes.trim()
            ? '飞书应用凭证可用；尚未完成用户 OAuth，联系人、个人单聊、群聊 @主人、个人日历和妙记仍不可读；机器人补充入口可继续按应用身份运行。'
            : '飞书应用凭证可用；尚未完成用户 OAuth，且 OAuth 权限范围配置为空；个人信息流仍不可读。'),
        checkedAt,
        details: { authMode: access ? 'user_access_token' : 'app_credentials', latencyMs: Date.now() - started },
      };
    } catch (error) {
      const safe = safeError(error);
      return { ok: false, status: safe.status, message: safe.message, checkedAt, details: { ...safe.diagnostic, latencyMs: Date.now() - started } };
    }
  }

  async getCurrentUser(): Promise<OwnerIdentity> {
    try {
      const response = await this.withUserToken((options) => this.client.authen.v1.userInfo.get({}, options));
      const data = response.data;
      if (!data?.open_id) throw new Error('飞书没有返回系统主人的 open_id。');
      this.ownerIdentity = {
        openId: data.open_id,
        unionId: data.union_id ?? null,
        userId: data.user_id ?? null,
        name: data.name ?? '系统主人',
        tenantKey: data.tenant_key ?? null,
      };
      return this.ownerIdentity;
    } catch (error) {
      if (error instanceof FeishuAuthError) throw error;
      throw new FeishuAuthError(describeFeishuAuthError(error, 'owner_identity'));
    }
  }

  async getGrantedScopes(): Promise<string[] | undefined> {
    const stored = await this.tokenVault?.get(tokenKeys.grantedScopes);
    const update = feishuScopeUpdateOf(stored === null ? undefined : stored);
    return update.kind === 'omitted' ? undefined : update.scopes;
  }

  async getGrantedScopeUpdate(): Promise<FeishuScopeUpdate> {
    const stored = await this.tokenVault?.get(tokenKeys.grantedScopes);
    return feishuScopeUpdateOf(stored === null ? undefined : stored);
  }

  /** Read the vault generation used to fence a stale owner response. */
  async readAuthGeneration(): Promise<number | null> {
    if (!this.tokenVault?.readSnapshot) return null;
    return (await this.tokenVault.readSnapshot()).generation;
  }

  /** Restore the persisted owner identity after an EXE restart. */
  setOwnerIdentity(owner: OwnerIdentity) {
    this.ownerIdentity = owner;
  }

  async start(handler?: (event: NormalizedSourceEvent) => Promise<DurableEventReceipt>) {
    if (this.running) return;
    if (!this.config.externalEnabled) return;
    this.eventHandler = handler ?? null;
    const dispatcher = new lark.EventDispatcher({
      encryptKey: this.config.encryptKey || undefined,
      verificationToken: this.config.verificationToken || undefined,
    }).register({
      'im.message.receive_v1': createDurableFeishuEventHandler({
        normalize: (data) => this.normalizeEvent(data),
        shouldAccept: (event) => this.shouldAccept(event),
        handle: async (event) => {
          if (!this.eventHandler) throw new Error('飞书实时事件处理器未就绪；已拒绝确认。');
          return this.eventHandler(event);
        },
      }),
    });
    const wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      autoReconnect: true,
      handshakeTimeoutMs: 15000,
      wsConfig: { pingTimeout: 60 },
    });
    this.wsClient = wsClient;
    try {
      await wsClient.start({ eventDispatcher: dispatcher });
      this.running = true;
    } catch (error) {
      this.running = false;
      this.eventHandler = null;
      if (this.wsClient === wsClient) this.wsClient = null;
      try { wsClient.close({ force: true }); } catch { /* best effort cleanup */ }
      throw error;
    }
  }

  async stop() {
    const wsClient = this.wsClient;
    this.wsClient = null;
    this.running = false;
    this.eventHandler = null;
    wsClient?.close({ force: true });
  }

  async listChats() {
    const access = await this.tokenVault?.get(tokenKeys.access);
    const options = access ? lark.withUserAccessToken(access) : undefined;
    const rows: unknown[] = [];
    let pageToken: string | undefined;
    do {
      const response = assertFeishuApiSuccess(await this.client.im.v1.chat.list({ params: { page_size: this.config.scanPageSize, page_token: pageToken } }, options));
      rows.push(...(response.data?.items ?? []));
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    return rows;
  }

  async listMessages(input: Record<string, unknown> = {}) {
    const chatId = String(input.chatId ?? input.containerId ?? '');
    if (!chatId) throw new Error('listMessages 需要 chatId。');
    const request = (options?: unknown) => this.client.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: feishuUnixSeconds(input.startTime),
          end_time: feishuUnixSeconds(input.endTime),
          sort_type: input.sortType === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
          page_size: Math.min(Math.max(Number(input.pageSize ?? this.config.scanPageSize), 1), 50),
          page_token: input.pageToken ? String(input.pageToken) : undefined,
          with_sender_name: true,
        },
      }, options as any);
    const authMode = input.authMode === 'owner' ? 'owner' : input.authMode === 'app' ? 'app' : 'auto';
    let response;
    if (authMode === 'owner') response = await this.withUserToken((options) => request(options));
    else if (authMode === 'app') response = await request();
    else {
      const access = await this.tokenVault?.get(tokenKeys.access);
      response = await request(access ? lark.withUserAccessToken(access) : undefined);
    }
    assertFeishuApiSuccess(response);
    return response.data ?? { items: [], has_more: false };
  }

  async searchMessages(input: Record<string, unknown> = {}) {
    const query = String(input.query ?? '').trim();
    if (!query) throw new Error('飞书消息搜索需要非空关键词；不能用空 query 扫描全部消息。');
    const response = await this.withUserToken((options) => this.client.im.v1.message.search({
      data: {
        query,
        filter: input.filter as any,
      },
      params: { page_size: Number(input.pageSize ?? this.config.scanPageSize), page_token: input.pageToken ? String(input.pageToken) : undefined, user_id_type: 'open_id' },
    }, options));
    return response.data ?? { items: [], has_more: false };
  }

  async searchOwnerMessages(input: { scope: OwnerMessageScope; startTime: string; endTime: string; pageToken?: string; pageSize?: number }) {
    void input;
    throw new Error('主人信息流不能用空关键词消息搜索；请使用已知会话历史读取或平台限制降级。');
  }

  async getMessage(messageId: string) {
    if (!messageId) throw new Error('读取飞书消息需要 message_id。');
    const messageApi = this.client.im.v1.message as unknown as { get?: (input: unknown, options: unknown) => Promise<any> };
    if (!messageApi.get) throw new Error('当前飞书 SDK 不提供单条消息读取；来源将按受限摘要处理。');
    const response = await this.withUserToken((options) => messageApi.get!({ path: { message_id: messageId }, params: { user_id_type: 'open_id', with_sender_name: true } }, options));
    return response.data ?? { items: [] };
  }

  async listOwnerChats(input: { types?: 'p2p' | 'group' | 'p2p,group'; pageToken?: string; pageSize?: number } = {}) {
    const response = await this.withUserToken((options) => this.client.im.v1.chat.list({
      params: {
        page_size: Math.min(Math.max(input.pageSize ?? this.config.scanPageSize, 1), 50),
        page_token: input.pageToken,
        user_id_type: 'open_id',
        sort_type: 'ByActiveTimeDesc',
        types: input.types,
      },
    }, options));
    return response.data ?? { items: [], has_more: false };
  }

  async searchOwnerUsers(input: { query?: string; hasChatted?: boolean; pageToken?: string; pageSize?: number } = {}) {
    const query = String(input.query ?? '').trim();
    if (!query && !input.hasChatted) throw new Error('联系人发现需要姓名关键词，或限定为最近聊过的人。');
    if (query.length > 50) throw new Error('联系人姓名关键词不能超过 50 个字符。');
    const response = await this.withUserToken((options) => this.client.request<{
      code?: number;
      msg?: string;
      data?: { items?: unknown[]; has_more?: boolean; page_token?: string; notice?: string };
    }>({
      method: 'POST',
      url: '/open-apis/contact/v3/users/search',
      params: {
        page_size: Math.min(Math.max(input.pageSize ?? 30, 1), 30),
        page_token: input.pageToken || undefined,
      },
      data: {
        query: query || undefined,
        filter: input.hasChatted ? { has_contact: true } : undefined,
      },
    }, options));
    return response.data ?? { items: [], has_more: false };
  }

  async resolveP2PChats(openIds: string[]) {
    const chatterIds = [...new Set(openIds.map((value) => value.trim()).filter(Boolean))];
    if (chatterIds.length === 0) throw new Error('解析个人单聊需要至少一个联系人。');
    if (chatterIds.length > 50) throw new Error('单次最多解析 50 个联系人。');
    const response = await this.withUserToken((options) => this.client.request<{
      code?: number;
      msg?: string;
      data?: { p2p_chats?: unknown[] };
    }>({
      method: 'POST',
      url: '/open-apis/im/v1/chat_p2p/batch_query',
      params: { chatter_id_type: 'open_id' },
      data: { chatter_ids: chatterIds },
    }, options));
    return response.data ?? { p2p_chats: [] };
  }

  async primaryCalendar() {
    const response = await this.withUserToken((options) => this.client.calendar.v4.calendar.primary({ params: { user_id_type: 'open_id' } }, options));
    return response.data ?? { calendars: [] };
  }

  async listCalendarEvents(input: Record<string, unknown> = {}) {
    const calendarId = String(input.calendarId ?? 'primary');
    const response = await this.withUserToken((options) => this.client.calendar.v4.calendarEvent.list({
      path: { calendar_id: calendarId },
      params: {
        start_time: input.startTime ? String(input.startTime) : undefined,
        end_time: input.endTime ? String(input.endTime) : undefined,
        page_size: Number(input.pageSize ?? this.config.scanPageSize),
        page_token: input.pageToken ? String(input.pageToken) : undefined,
        sync_token: input.syncToken ? String(input.syncToken) : undefined,
        user_id_type: 'open_id',
      },
    }, options));
    return response.data ?? { items: [], has_more: false };
  }

  async getCalendarEvent(input: Record<string, unknown> = {}) {
    const calendarId = String(input.calendarId ?? '');
    const eventId = String(input.eventId ?? '');
    if (!calendarId || !eventId) throw new Error('读取飞书日程详情需要 calendar_id 和 event_id。');
    const response = await this.withUserToken((options) => this.client.calendar.v4.calendarEvent.get({
      path: { calendar_id: calendarId, event_id: eventId },
      params: {
        need_attendee: input.needAttendee !== false,
        max_attendee_num: Number(input.maxAttendeeNum ?? 100),
        user_id_type: 'open_id',
      },
    }, options));
    return response.data ?? { event: null };
  }

  async searchMinutes(input: Record<string, unknown> = {}) {
    const response = await this.withUserToken((options) => this.client.minutes.v1.minute.search({
      data: { query: String(input.query ?? ''), filter: input.filter as any, sorter: 'create_time_desc' },
      params: { page_size: Number(input.pageSize ?? this.config.scanPageSize), page_token: input.pageToken ? String(input.pageToken) : undefined, user_id_type: 'open_id' },
    }, options));
    return response.data ?? { items: [], has_more: false };
  }

  async getMinute(minuteToken: string) {
    if (!minuteToken) throw new Error('读取妙记详情需要 minute_token。');
    const response = await this.withUserToken((options) => this.client.minutes.v1.minute.get({
      path: { minute_token: minuteToken },
      params: { user_id_type: 'open_id' },
    }, options));
    return response.data ?? { minute: null };
  }

  async getMinuteArtifacts(minuteToken: string) {
    if (!minuteToken) throw new Error('读取妙记 AI 产物需要 minute_token。');
    const response = await this.withUserToken((options) => this.client.minutes.v1.minute.artifacts({
      path: { minute_token: minuteToken },
    }, options));
    return response.data ?? {};
  }

  async getMinuteTranscript(minuteToken: string) {
    const response = await this.withUserToken((options) => this.client.minutes.v1.minuteTranscript.get({ path: { minute_token: minuteToken }, params: { need_speaker: true, need_timestamp: true, file_format: 'txt' } }, options));
    const stream = typeof response?.getReadableStream === 'function' ? response.getReadableStream() : null;
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      return { available: false, message: '飞书 SDK 没有返回可读取的妙记文字流。' };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const maxBytes = 128 * 1024;
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = maxBytes - size;
      if (remaining <= 0) break;
      chunks.push(buffer.subarray(0, remaining));
      size += Math.min(buffer.length, remaining);
      if (size >= maxBytes) break;
    }
    return { available: true, text: Buffer.concat(chunks).toString('utf8'), truncated: size >= maxBytes };
  }

  async getDocxDocument(documentId: string) {
    if (!documentId) throw new Error('读取飞书文档需要 document_id。');
    const response = await this.withUserToken((options) => this.client.docx.v1.document.get({
      path: { document_id: documentId },
    }, options));
    return response.data ?? { document: null };
  }

  async getDocxRawContent(documentId: string) {
    if (!documentId) throw new Error('读取飞书文档正文需要 document_id。');
    const response = await this.withUserToken((options) => this.client.docx.v1.document.rawContent({
      path: { document_id: documentId },
      params: { lang: 0 },
    }, options));
    return response.data ?? { content: '' };
  }

  async getWikiNode(nodeToken: string) {
    if (!nodeToken) throw new Error('读取飞书知识库节点需要 node token。');
    const response = await this.withUserToken((options) => this.client.wiki.v2.space.getNode({
      params: { token: nodeToken },
    }, options));
    return response.data ?? { node: null };
  }

  normalizeSource(input: NormalizedSourceEvent) {
    return input;
  }

  /** Convert a paginated history item into the same source contract as events. */
  normalizeMessageRecord(item: any, sourceHint?: SourceType): NormalizedSourceEvent | null {
    const messageId = item?.message_id ?? item?.messageId;
    const chatId = item?.chat_id ?? item?.chatId;
    if (!messageId || !chatId) return null;
    const mentions = mentionIds(item.mentions ?? item.mentionList);
    const ownerIds = this.ownerIdentity
      ? [this.ownerIdentity.openId, this.ownerIdentity.unionId, this.ownerIdentity.userId].filter((value): value is string => Boolean(value))
      : [];
    const ownerMentioned = ownerIds.some((value) => mentions.includes(value));
    const chatType = String(item.chat_type ?? item.chatType ?? '');
    const sourceType = sourceHint ?? (chatType === 'p2p' ? 'bot_dm' : 'group');
    const sender = item.sender ?? item.from ?? {};
    const messageType = String(item.msg_type ?? item.message_type ?? item.messageType ?? '');
    const body = item.body ?? {};
    const content = typeof body.content === 'string' ? body.content : typeof item.content === 'string' ? item.content : undefined;
    const sourceUrl = item.message_app_link ?? item.messageAppLink ?? item.source_url ?? item.sourceUrl ?? item.message_url ?? item.messageUrl ?? item.open_message_url ?? item.openMessageUrl;
    const updateTime = item.update_time ?? item.updateTime;
    const deleted = Boolean(item.deleted ?? item.is_deleted ?? item.isDeleted ?? item.recalled ?? item.withdrawn);
    const rootId = item.root_id ?? item.rootId;
    const parentId = item.parent_id ?? item.parentId;
    const threadId = item.thread_id ?? item.threadId;
    return {
      externalId: String(messageId),
      sourceType,
      conversationId: String(chatId),
      senderId: String(sender.sender_id ?? sender.senderId ?? sender.id ?? item.sender_id ?? item.senderId ?? ''),
      senderName: String(sender.sender_name ?? sender.senderName ?? sender.name ?? item.sender_name ?? item.senderName ?? '飞书用户'),
      content: deleted ? '[飞书消息已撤回或删除，正文不再保留]' : parseMessageContent(content, messageType),
      occurredAt: normalizeFeishuTimestamp(item.create_time ?? item.createTime ?? item.update_time ?? item.updateTime),
      ownerMentioned,
      sourceUrl: typeof sourceUrl === 'string' && sourceUrl ? sourceUrl : undefined,
      completeness: deleted ? 'limited' : 'partial',
      discoveryReason: sourceType === 'owner_dm' ? '系统自动发现的主人个人单聊中新收到的对方消息' : ownerMentioned ? '群聊中提及系统主人' : '明确授权的补充需求群',
      metadata: {
        chatType,
        messageType,
        mentionCount: mentions.length,
        sourceUpdatedAt: optionalFeishuTimestamp(updateTime),
        rootId: rootId ? String(rootId) : undefined,
        parentId: parentId ? String(parentId) : undefined,
        threadId: threadId ? String(threadId) : undefined,
        sessionId: rootId ? String(rootId) : threadId ? String(threadId) : undefined,
        participantIds: [...new Set([String(sender.sender_id ?? sender.senderId ?? sender.id ?? item.sender_id ?? item.senderId ?? ''), ...mentions].filter(Boolean))],
        deleted,
        fullBodyAvailable: !deleted && Boolean(content),
      },
    };
  }

  async sendApproved(input: Record<string, unknown> = {}) {
    const receiveId = String(input.receiveId ?? '');
    const content = String(input.content ?? '');
    if (!receiveId || !content) throw new Error('发送消息需要 receiveId 和 content。');
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: String(input.receiveIdType ?? 'chat_id') as any },
      data: { receive_id: receiveId, msg_type: String(input.msgType ?? 'text'), content },
    });
    assertFeishuApiSuccess(response);
    this._sentCount += 1;
    return { externalId: response.data?.message_id ?? '' };
  }

  private async tokenWriteGeneration() {
    if (!this.tokenVault?.readSnapshot || !this.tokenVault.setManyAtomic) {
      throw new Error('飞书 token vault 缺少跨进程 generation/CAS 能力，已拒绝保存授权。');
    }
    return (await this.tokenVault.readSnapshot()).generation;
  }

  private assertTokenSnapshot(snapshot: TokenVaultSnapshot) {
    if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) throw new Error('飞书 token vault 快照 generation 无效，已拒绝刷新授权。');
    for (const value of [snapshot.accessToken, snapshot.refreshToken, snapshot.expiresAt, snapshot.grantedScopes]) {
      if (value !== null && typeof value !== 'string') throw new Error('飞书 token vault 快照字段无效，已拒绝刷新授权。');
    }
  }

  private async saveTokens(token: FeishuTokenResponse, expectedGeneration: number, refreshFence?: { identityKey: string; leaseId: string; fencingToken: number; tokenFingerprint: string | null; resultExpiresAt?: string | null }): Promise<{ accepted: boolean; generation: number }> {
    if (!this.tokenVault) throw new Error('飞书 token vault 未配置，不能保存授权。');
    const values: Record<string, string | null> = {
      [tokenKeys.access]: token.accessToken,
      [tokenKeys.expiresAt]: new Date(Date.now() + (token.expiresIn ?? 7200) * 1000).toISOString(),
    };
    if (token.refreshToken) values[tokenKeys.refresh] = token.refreshToken;
    const scopeUpdate = feishuScopeUpdateOf(token.scope);
    // An omitted provider field preserves the last verified scopes. An
    // explicit empty string is a real set([]) and must remain observable in
    // the vault so service gates can clear local authorization.
    if (scopeUpdate.kind === 'set') values[tokenKeys.grantedScopes] = scopeUpdate.scopes.join(' ');

    if (!this.tokenVault.setManyAtomic) {
      throw new Error('飞书 token vault 缺少跨进程 generation/CAS 能力，已拒绝保存授权。');
    }
    const result = await this.tokenVault.setManyAtomic(values, expectedGeneration, refreshFence);
    return result;
  }

  private shouldAccept(event: NormalizedSourceEvent) {
    if (event.sourceType !== 'group') return true;
    // Explicit groups remain the reliable bot supplement. A message that
    // explicitly mentions the authenticated owner may also enter, but only
    // when the platform delivered it to this application in the first place.
    return event.ownerMentioned === true || (this.config.groupIds.length > 0 && this.config.groupIds.includes(event.conversationId));
  }

  private normalizeEvent(data: any): NormalizedSourceEvent | null {
    const message = data?.message;
    if (!message?.message_id || !message.chat_id) return null;
    const chatType = String(message.chat_type ?? '');
    const sourceType: NormalizedSourceEvent['sourceType'] = chatType === 'p2p' ? 'bot_dm' : 'group';
    const sender = message.sender ?? {};
    const mentions = mentionIds(message.mentions);
    const ownerIds = this.ownerIdentity
      ? [this.ownerIdentity.openId, this.ownerIdentity.unionId, this.ownerIdentity.userId].filter((value): value is string => Boolean(value))
      : [];
    const ownerMentioned = ownerIds.some((value) => mentions.includes(value));
    if (chatType !== 'p2p' && chatType !== 'group') return null;
    const rootId = message.root_id ?? message.rootId;
    const parentId = message.parent_id ?? message.parentId;
    const threadId = message.thread_id ?? message.threadId;
    return {
      externalId: String(message.message_id),
      sourceType,
      conversationId: String(message.chat_id),
      senderId: String(sender.sender_id ?? sender.id ?? ''),
      senderName: String(sender.sender_name ?? sender.name ?? '飞书用户'),
      content: parseMessageContent(message.content, message.message_type ?? message.msg_type),
      occurredAt: normalizeFeishuTimestamp(message.create_time ?? message.createTime),
      ownerMentioned,
      completeness: 'partial',
      discoveryReason: sourceType === 'bot_dm' ? '需求方直接私聊补充机器人' : ownerMentioned ? '群聊中提及系统主人' : '明确授权的补充需求群',
      metadata: {
        sourceScope: 'bot_supplement',
        ownerScope: 'primary',
        chatType,
        messageType: String(message.message_type ?? message.msg_type ?? ''),
        mentionCount: mentions.length,
        rootId: rootId ? String(rootId) : undefined,
        parentId: parentId ? String(parentId) : undefined,
        threadId: threadId ? String(threadId) : undefined,
        sessionId: rootId ? String(rootId) : threadId ? String(threadId) : undefined,
        participantIds: [...new Set([String(sender.sender_id ?? sender.id ?? ''), ...mentions].filter(Boolean))],
      },
    };
  }
}
