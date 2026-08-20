export type RetryAfterSource = 'seconds' | 'http-date';

export type ParsedRetryAfter = {
  delayMs: number;
  source: RetryAfterSource;
};

export type RetryFailureCategory = 'rate_limit' | 'server_error' | 'transport' | 'non_retryable';

/**
 * Typed retry information shared by provider adapters and Runtime jobs.
 * Free-form provider text is intentionally not part of this contract.
 */
export type ProviderRetrySignal = {
  category: RetryFailureCategory;
  /** Stable provider/tool key used for the durable shared cooldown. */
  providerKey: string;
  /** Backward-compatible internal spelling; always equal to providerKey. */
  cooldownKey: string;
  retryable: boolean;
  /** Absolute retry deadline; relative Retry-After must not be added twice. */
  retryAt: string | null;
  retryAfterMs: number | null;
  status: number | null;
  code: string | null;
};

export type RetryFailureMetadata = ProviderRetrySignal;

export type RetryPolicyOptions = {
  baseMs?: number;
  maxMs?: number;
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
  /** Durable SQLite-backed cooldown store. */
  store?: RetryCooldownStore;
};

export type RetryCooldownStore = {
  getRetryAt(providerKey: string, nowMs: number): number | null;
  maxRetryAt(providerKey: string, retryAtMs: number, nowMs: number): void;
  clearExpired(nowMs: number): void;
};

const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_MS = 3_600_000;
const DEFAULT_JITTER_RATIO = 0.2;
const MIN_JITTER_RATIO = 0;
const MAX_JITTER_RATIO = 0.5;
const HTTP_DATE_PATTERN = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/u;
const HTTP_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const HTTP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const TRANSPORT_ERROR_NAMES = new Set(['AbortError', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'FetchError']);
const TRANSPORT_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
const SAFE_RETRY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u;
const STRICT_RETRY_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function boundedRatio(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_JITTER_RATIO, Math.max(MIN_JITTER_RATIO, value));
}

/**
 * Parse the standard Retry-After header without trusting provider text.
 * Invalid, expired, negative, duplicated, or oversized values return null so
 * callers fail closed instead of retrying with an attacker-controlled delay.
 */
export function parseRetryAfter(
  value: unknown,
  nowMs = Date.now(),
  maxMs = DEFAULT_MAX_MS,
): ParsedRetryAfter | null {
  const ceiling = boundedInteger(maxMs, DEFAULT_MAX_MS, 0, 86_400_000);
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /[\r\n]/u.test(raw)) return null;
  if (/^\d+$/u.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds)) return null;
    const delayMs = seconds * 1_000;
    return Number.isSafeInteger(delayMs) && delayMs <= ceiling
      ? { delayMs, source: 'seconds' }
      : null;
  }
  const httpDate = raw.match(HTTP_DATE_PATTERN);
  if (!httpDate) return null;
  const parsedDate = Date.parse(raw);
  if (!Number.isFinite(parsedDate)) return null;
  const date = new Date(parsedDate);
  const canonical = `${HTTP_WEEKDAYS[date.getUTCDay()]}, ${String(date.getUTCDate()).padStart(2, '0')} ${HTTP_MONTHS[date.getUTCMonth()]} ${String(date.getUTCFullYear()).padStart(4, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')} GMT`;
  if (canonical !== raw || httpDate[1] !== HTTP_WEEKDAYS[date.getUTCDay()]) return null;
  const delayMs = parsedDate - nowMs;
  if (!Number.isSafeInteger(delayMs) || delayMs <= 0 || delayMs > ceiling) return null;
  return { delayMs, source: 'http-date' };
}

export function computeRetryDelay(input: {
  attempt: number;
  retryAfterMs?: number | null;
  cooldownMs?: number | null;
  options?: RetryPolicyOptions;
}): number {
  const options = input.options ?? {};
  const baseMs = boundedInteger(options.baseMs ?? DEFAULT_BASE_MS, DEFAULT_BASE_MS, 1, DEFAULT_MAX_MS);
  const maxMs = boundedInteger(options.maxMs ?? DEFAULT_MAX_MS, DEFAULT_MAX_MS, baseMs, 86_400_000);
  const ratio = boundedRatio(options.jitterRatio ?? DEFAULT_JITTER_RATIO, DEFAULT_JITTER_RATIO);
  const random = options.random ?? Math.random;
  const sampledRandom = random();
  const randomValue = Number.isFinite(sampledRandom) ? Math.min(1, Math.max(0, sampledRandom)) : 0.5;
  const attempt = boundedInteger(input.attempt, 1, 1, 30) - 1;
  const exponential = Math.min(maxMs, baseMs * (2 ** attempt));
  const jittered = Math.round(exponential * (1 - ratio + randomValue * ratio * 2));
  const retryAfterMs = Number.isFinite(input.retryAfterMs) ? Math.max(0, Math.round(input.retryAfterMs!)) : 0;
  const cooldownMs = Number.isFinite(input.cooldownMs) ? Math.max(0, Math.round(input.cooldownMs!)) : 0;
  const providerFloor = Math.max(retryAfterMs, cooldownMs);
  if (providerFloor >= jittered && providerFloor > 0 && ratio > 0) {
    // Retry-After and an existing shared cooldown are lower bounds. Add only
    // positive jitter above that floor so callers do not synchronize at the
    // provider deadline, while never retrying earlier than instructed.
    const positiveJitter = Math.round(providerFloor * ratio * randomValue);
    return Math.min(maxMs, providerFloor + positiveJitter);
  }
  return Math.min(maxMs, Math.max(jittered, providerFloor));
}

function strictRetryAt(value: unknown, nowMs = Date.now(), maxMs = DEFAULT_MAX_MS) {
  if (typeof value !== 'string' || !STRICT_RETRY_AT_PATTERN.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // A signal may arrive after its absolute deadline while a provider retry
  // loop is unwinding. That is still a valid typed signal, but it must not
  // smuggle an unbounded future deadline into the durable job.
  if (parsed - nowMs > maxMs) return null;
  return parsed;
}

export function normalizeRetryFailureMetadata(
  value: unknown,
  fallbackCooldownKey?: string,
  nowMs = Date.now(),
): RetryFailureMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    category?: unknown;
    cooldownKey?: unknown;
    providerKey?: unknown;
    retryable?: unknown;
    retryAt?: unknown;
    retryAfterMs?: unknown;
    status?: unknown;
    code?: unknown;
  };
  if (candidate.category !== 'rate_limit' && candidate.category !== 'server_error' && candidate.category !== 'transport' && candidate.category !== 'non_retryable') return null;
  const rawProviderKey = typeof candidate.providerKey === 'string' && candidate.providerKey.trim()
    ? candidate.providerKey.trim()
    : typeof candidate.cooldownKey === 'string' && candidate.cooldownKey.trim()
      ? candidate.cooldownKey.trim()
      : fallbackCooldownKey?.trim() || '';
  const rawCooldownKey = typeof candidate.cooldownKey === 'string' && candidate.cooldownKey.trim()
    ? candidate.cooldownKey.trim()
    : rawProviderKey;
  if (!rawProviderKey || rawProviderKey !== rawCooldownKey || !SAFE_RETRY_TOKEN.test(rawProviderKey)) return null;
  // This is a retry disposition, not a generic error annotation. Requiring
  // the boolean avoids accidentally treating an omitted/legacy field as a
  // permission to retry. Non-retryable provider outcomes remain typed so the
  // durable Runtime can fail closed after a classifier fallback.
  if (candidate.retryable !== true && candidate.retryable !== false) return null;
  const category = candidate.category;
  const status = candidate.status === null || candidate.status === undefined
    ? null
    : typeof candidate.status === 'number' && Number.isInteger(candidate.status) && candidate.status >= 0 && candidate.status <= 999
      ? candidate.status
      : null;
  if (candidate.status !== null && candidate.status !== undefined && status === null) return null;
  if (category === 'rate_limit' && status !== 429) return null;
  if (category === 'server_error' && (status === null || status < 500 || status > 599)) return null;
  if (category === 'transport' && status !== null) return null;
  if (category === 'non_retryable' && candidate.retryable !== false) return null;
  if (candidate.retryable === true && category === 'non_retryable') return null;
  const retryAtMs = candidate.retryAt === null || candidate.retryAt === undefined
    ? null
    : strictRetryAt(candidate.retryAt, nowMs);
  if (candidate.retryAt !== null && candidate.retryAt !== undefined && retryAtMs === null) return null;
  if (
    candidate.retryAfterMs !== null
    && candidate.retryAfterMs !== undefined
    && (!Number.isFinite(candidate.retryAfterMs) || Number(candidate.retryAfterMs) < 0 || Number(candidate.retryAfterMs) > DEFAULT_MAX_MS)
  ) return null;
  if (candidate.retryable === false && (retryAtMs !== null || (candidate.retryAfterMs !== null && candidate.retryAfterMs !== undefined))) return null;
  if (candidate.code !== null && candidate.code !== undefined && (typeof candidate.code !== 'string' || !SAFE_RETRY_TOKEN.test(candidate.code))) return null;
  return {
    category,
    providerKey: rawProviderKey,
    cooldownKey: rawProviderKey,
    retryable: candidate.retryable,
    retryAt: candidate.retryable && retryAtMs !== null ? new Date(retryAtMs).toISOString() : null,
    retryAfterMs: candidate.retryable && Number.isFinite(candidate.retryAfterMs) ? Math.max(0, Math.round(candidate.retryAfterMs as number)) : null,
    status,
    code: typeof candidate.code === 'string' ? candidate.code : null,
  };
}

export function retryFailureMetadataForHttp(
  status: number,
  cooldownKey: string,
  retryAfterMs: number | null = null,
  retryAfterInvalid = false,
  retryAt: string | null = null,
  nowMs = Date.now(),
): RetryFailureMetadata | null {
  if (!cooldownKey.trim() || !SAFE_RETRY_TOKEN.test(cooldownKey.trim())) return null;
  const category = status === 429 ? 'rate_limit' : status >= 500 && status <= 599 ? 'server_error' : 'non_retryable';
  const malformedRetryAfter = retryAfterMs !== null
    && (!Number.isFinite(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > DEFAULT_MAX_MS);
  const malformedRetryAt = retryAt !== null && strictRetryAt(retryAt, nowMs) === null;
  const retryable = !retryAfterInvalid && !malformedRetryAfter && !malformedRetryAt && category !== 'non_retryable';
  const boundedRetryAfter = retryable && Number.isFinite(retryAfterMs) ? Math.max(0, Math.round(retryAfterMs ?? 0)) : null;
  return {
    category,
    providerKey: cooldownKey.trim(),
    cooldownKey: cooldownKey.trim(),
    retryable,
    retryAt: retryable ? retryAt ?? (boundedRetryAfter === null ? null : new Date(nowMs + boundedRetryAfter).toISOString()) : null,
    retryAfterMs: boundedRetryAfter,
    status: Number.isInteger(status) && status >= 0 && status <= 999 ? status : null,
    code: retryable ? (status === 429 ? 'rate_limit' : 'server_error') : (retryAfterInvalid || malformedRetryAfter || malformedRetryAt) ? 'invalid_retry_after' : 'http_error',
  };
}

/**
 * Read typed retry metadata from an adapter error. Known transport error
 * names/codes may be classified at a tool boundary; arbitrary message text
 * is never parsed as a retry signal.
 */
export function classifyRetryFailure(
  error: unknown,
  fallbackCooldownKey?: string,
  allowKnownTransport = false,
): RetryFailureMetadata | null {
  const typed = normalizeRetryFailureMetadata(
    error && typeof error === 'object' && 'retryMetadata' in error
      ? (error as { retryMetadata?: unknown }).retryMetadata
      : null,
    fallbackCooldownKey,
    Date.now(),
  );
  if (typed) return typed;
  if (!allowKnownTransport || !fallbackCooldownKey?.trim()) return null;
  const errorObject = error as { name?: unknown; code?: unknown } | null;
  const name = typeof errorObject?.name === 'string' ? errorObject.name : '';
  const code = typeof errorObject?.code === 'string' ? errorObject.code : '';
  if (!TRANSPORT_ERROR_NAMES.has(name) && !TRANSPORT_ERROR_CODES.has(code)) return null;
  return {
    category: 'transport',
    providerKey: fallbackCooldownKey.trim(),
    cooldownKey: fallbackCooldownKey.trim(),
    retryable: true,
    retryAt: null,
    retryAfterMs: null,
    status: null,
    code: TRANSPORT_ERROR_CODES.has(code) ? code : TRANSPORT_ERROR_NAMES.has(name) ? name : 'transport',
  };
}

export class SqliteRetryCooldownStore implements RetryCooldownStore {
  constructor(private readonly database: { prepare(sql: string): any }) {}

  getRetryAt(providerKey: string, nowMs: number) {
    this.clearExpired(nowMs);
    const row = this.database.prepare(
      'SELECT retry_at_ms FROM provider_retry_cooldown WHERE provider_key = ?',
    ).get(providerKey) as { retry_at_ms?: number } | undefined;
    return typeof row?.retry_at_ms === 'number' ? row.retry_at_ms : null;
  }

  maxRetryAt(providerKey: string, retryAtMs: number, nowMs: number) {
    this.database.prepare(
      `INSERT INTO provider_retry_cooldown (provider_key, retry_at_ms, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(provider_key) DO UPDATE SET
         retry_at_ms = MAX(provider_retry_cooldown.retry_at_ms, excluded.retry_at_ms),
         updated_at = excluded.updated_at`,
    ).run(providerKey, retryAtMs, new Date(nowMs).toISOString());
  }

  clearExpired(nowMs: number) {
    this.database.prepare('DELETE FROM provider_retry_cooldown WHERE retry_at_ms <= ?').run(nowMs);
  }
}

/**
 * Provider cooldown coordinator. Production Runtime instances inject the
 * SQLite store for cross-process/restart visibility; isolated adapter tests
 * may use the in-memory fallback.
 */
export class RetryCoordinator {
  private readonly cooldowns = new Map<string, number>();
  private readonly now: () => number;
  private readonly options: RetryPolicyOptions;
  private readonly store?: RetryCooldownStore;

  constructor(options: RetryPolicyOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.options = options;
    this.store = options.store;
  }

  /** Keep adapter Retry-After timestamps on the same injected clock. */
  nowMs() {
    return this.now();
  }

  cooldownMs(provider: string) {
    if (this.store) {
      const retryAt = this.store.getRetryAt(provider, this.now());
      return retryAt === null ? 0 : Math.max(0, retryAt - this.now());
    }
    const until = this.cooldowns.get(provider);
    if (until === undefined) return 0;
    const remaining = until - this.now();
    if (remaining <= 0) {
      this.cooldowns.delete(provider);
      return 0;
    }
    return remaining;
  }

  setCooldown(provider: string, delayMs: number) {
    if (!provider || !Number.isFinite(delayMs) || delayMs < 0) return false;
    const maxMs = boundedInteger(this.options.maxMs ?? DEFAULT_MAX_MS, DEFAULT_MAX_MS, 0, 86_400_000);
    const until = this.now() + Math.min(maxMs, Math.round(delayMs));
    if (this.store) {
      this.store.maxRetryAt(provider, until, this.now());
      return true;
    }
    this.cooldowns.set(provider, Math.max(this.cooldowns.get(provider) ?? 0, until));
    return true;
  }

  setCooldownAt(provider: string, retryAt: string | null) {
    const parsedRetryAt = retryAt ? strictRetryAt(retryAt, this.now()) : null;
    if (parsedRetryAt === null) return false;
    const delayMs = parsedRetryAt - this.now();
    if (delayMs <= 0) return false;
    return this.setCooldown(provider, delayMs);
  }

  nextDelay(
    provider: string,
    attempt: number,
    retryAfterMs?: number | null,
    retryAt?: string | null,
    persist = true,
    persistGuard?: () => boolean,
  ) {
    const cooldownMs = this.cooldownMs(provider);
    const parsedRetryAt = retryAt === null || retryAt === undefined ? null : strictRetryAt(retryAt, this.now());
    const absoluteRetryMs = parsedRetryAt !== null
      ? Math.max(0, parsedRetryAt - this.now())
      : null;
    const delay = computeRetryDelay({
      attempt,
      retryAfterMs: absoluteRetryMs ?? retryAfterMs,
      cooldownMs,
      options: this.options,
    });
    // Every retryable response establishes a bounded shared cooldown,
    // even when the provider omitted Retry-After. This fences other jobs from
    // immediately creating a synchronized retry storm while preserving the
    // maximum of jitter, an existing cooldown, and a valid Retry-After value.
    // Runtime-owned retries must not let a stale callback advance the shared
    // durable cooldown after its exact lease has disappeared. The guard is
    // evaluated immediately before the store mutation; the durable job fence
    // remains authoritative for final job updates.
    if (persist && delay > 0 && (!persistGuard || persistGuard())) {
      // Positive jitter above Retry-After/current cooldown is caller-local.
      // Persisting that extra spread would let every waiting caller ratchet
      // the shared deadline forward. The durable floor remains common while
      // each caller gets its own non-synchronized wake-up.
      const providerFloor = Math.max(absoluteRetryMs ?? retryAfterMs ?? 0, cooldownMs);
      this.setCooldown(provider, providerFloor > 0 ? providerFloor : delay);
    }
    return delay;
  }

  /**
   * Compute a caller-local retry delay without reading or updating the
   * provider-wide cooldown.  This is for malformed model output and other
   * local repairable errors: they may retry this request, but must not make
   * unrelated jobs wait on a provider key.
   */
  localDelay(attempt: number) {
    return computeRetryDelay({ attempt, options: this.options });
  }
}

/**
 * Production shares one process-local coordinator between provider adapters
 * and durable Runtime. Isolated tests may inject their own instance.
 */
export const sharedRetryCoordinator = new RetryCoordinator();

export const DEFAULT_RETRY_MAX_MS = DEFAULT_MAX_MS;
