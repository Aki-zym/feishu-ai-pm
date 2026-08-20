import { randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { REDACTION_SCHEMA_VERSION } from './redaction.js';

export type OperationOutcome = 'success' | 'partial_success' | 'skipped' | 'failure';
export type SourceOutcomeStatus = OperationOutcome;
export type ReadinessStatus = 'ready' | 'degraded' | 'not_ready';
export const syncSourceNames = [
  'owner_messages',
  'owner_dm',
  'owner_mentions',
  'bot_supplement',
  'calendar',
  'minutes',
  'documents',
  'feishu',
  'feishu_source',
] as const;
export type SyncSourceName = (typeof syncSourceNames)[number];

export type SafeReason = {
  code: string;
  message: string;
};

export type ReleaseIdentity = {
  app_version: string;
  build_identity: string | null;
  redaction_schema_version: string;
};

export type SourceOutcome = {
  source: SyncSourceName;
  status: SourceOutcomeStatus;
  counts: Record<string, number>;
  duration_ms: number;
  error_code: string | null;
  reason: string | null;
  next_retry_at: string | null;
  stale: boolean;
  message: string;
};

export type ObservableOperationResult = {
  operation_id: string;
  request_id: string;
  trace_id: string;
  parent_span_id: string | null;
  span_id: string;
  outcome: OperationOutcome;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  sources: SourceOutcome[];
  release: ReleaseIdentity;
};

export type OperationContext = {
  operation_id: string;
  request_id: string;
  trace_id: string;
  parent_span_id: string | null;
  span_id: string;
};

export function createOperationContext(input: {
  requestId: string;
  operationId?: string;
  traceId?: string | null;
  parentSpanId?: string | null;
  spanId?: string;
}): OperationContext {
  return {
    operation_id: input.operationId ?? randomUUID(),
    request_id: input.requestId,
    trace_id: input.traceId ?? randomUUID(),
    parent_span_id: input.parentSpanId ?? null,
    span_id: input.spanId ?? randomUUID(),
  };
}

export function childOperationContext(parent: OperationContext): OperationContext {
  return {
    ...parent,
    parent_span_id: parent.span_id,
    span_id: randomUUID(),
  };
}

export function isOperationContext(value: unknown): value is OperationContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.operation_id === 'string'
    && typeof candidate.request_id === 'string'
    && typeof candidate.trace_id === 'string'
    && (candidate.parent_span_id === null || typeof candidate.parent_span_id === 'string')
    && typeof candidate.span_id === 'string';
}

const fixedMessages: Record<OperationOutcome, string> = {
  success: '该来源同步成功。',
  partial_success: '该来源部分成功；失败项已保留供后续重试。',
  skipped: '该来源本轮未执行。',
  failure: '该来源同步失败；已保留安全诊断信息。',
};

const skippedCodes = new Map<string, string>([
  ['already_running', 'OBS_ALREADY_RUNNING'],
  ['scan_disabled', 'OBS_SYNC_DISABLED'],
  ['connection_disabled', 'OBS_SYNC_DISABLED'],
  ['owner_oauth_required', 'FEISHU_OAUTH_REQUIRED'],
  ['scope_required', 'FEISHU_SCOPE_REQUIRED'],
  ['adapter_unavailable', 'OBS_ADAPTER_UNAVAILABLE'],
  ['disabled', 'OBS_SYNC_DISABLED'],
  ['privacy_collection_stopped', 'PRIVACY_COLLECTION_STOPPED'],
  ['no_pending_documents', 'OBS_NOTHING_TO_SYNC'],
]);
const nonSkippedReasons = new Set(['sync_failed', 'sync_token_missing']);

const allowedCountKeys = [
  'scopes', 'messages', 'deduplicated', 'failures', 'newChats', 'calendars', 'events',
  'detailFailures', 'minutes', 'pages', 'checked', 'changed',
] as const;

function finiteCount(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

type NormalizedSyncResult = {
  counts: Record<string, number>;
} & ({
  skipped: true;
  reason: string;
  skippedErrorCode: string;
} | {
  skipped: false;
  reason: string | null;
  skippedErrorCode: null;
});

function ownDataValue(value: object, key: string) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { present: false, valid: true, value: undefined } as const;
  if (!('value' in descriptor)) return { present: true, valid: false, value: undefined } as const;
  return { present: true, valid: true, value: descriptor.value } as const;
}

function normalizeSyncResult(value: unknown): NormalizedSyncResult | null {
  if (!value || typeof value !== 'object') return null;
  try {
    if (nodeTypes.isProxy(value)) return null;
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const counts: Record<string, number> = {};
    let hasNumericCount = false;
    let hasNonZeroCount = false;
    for (const key of allowedCountKeys) {
      const field = ownDataValue(value, key);
      if (!field.valid || (field.present && (typeof field.value !== 'number' || !Number.isInteger(field.value) || field.value < 0))) return null;
      if (field.present) hasNumericCount = true;
      const count = finiteCount(field.value);
      if (count > 0) {
        counts[key] = count;
        hasNonZeroCount = true;
      }
    }
    const skippedField = ownDataValue(value, 'skipped');
    if (!skippedField.valid || !skippedField.present || typeof skippedField.value !== 'boolean') return null;
    const reasonField = ownDataValue(value, 'reason');
    if (!reasonField.valid || (reasonField.present && reasonField.value !== undefined && typeof reasonField.value !== 'string')) return null;
    const reason = typeof reasonField.value === 'string' ? reasonField.value : null;
    if (skippedField.value) {
      const skippedErrorCode = reason ? skippedCodes.get(reason) : undefined;
      if (hasNonZeroCount || !reason || !skippedErrorCode) return null;
      return { counts, skipped: true, reason, skippedErrorCode };
    }
    const failures = finiteCount(counts.failures) + finiteCount(counts.detailFailures);
    if (!hasNumericCount || (reason !== null && (!nonSkippedReasons.has(reason) || failures === 0))) return null;
    return { counts, skipped: false, reason, skippedErrorCode: null };
  } catch {
    return null;
  }
}

function usefulCount(counts: Record<string, number>) {
  return Object.entries(counts)
    .filter(([key]) => !['failures', 'detailFailures'].includes(key))
    .reduce((total, [, value]) => total + value, 0);
}

export function syncSourceOutcome(source: SyncSourceName, result: unknown, durationMs: number): SourceOutcome {
  const normalized = normalizeSyncResult(result);
  if (!normalized) {
    return {
      source,
      status: 'failure',
      counts: { failures: 1 },
      duration_ms: finiteCount(durationMs),
      error_code: 'OBS_INVALID_SOURCE_RESULT',
      reason: 'OBS_INVALID_SOURCE_RESULT',
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
      stale: true,
      message: fixedMessages.failure,
    };
  }
  const { counts } = normalized;
  const failures = finiteCount(counts.failures) + finiteCount(counts.detailFailures);
  let status: SourceOutcomeStatus;
  let errorCode: string | null = null;
  if (normalized.skipped) {
    status = 'skipped';
    errorCode = normalized.skippedErrorCode;
  } else if (failures > 0 && usefulCount(counts) > 0) {
    status = 'partial_success';
    errorCode = 'FEISHU_SYNC_PARTIAL';
  } else if (failures > 0) {
    status = 'failure';
    errorCode = 'FEISHU_SYNC_FAILED';
  } else {
    status = 'success';
  }
  const reason = status === 'success' ? null : errorCode;
  return {
    source,
    status,
    counts,
    duration_ms: finiteCount(durationMs),
    error_code: errorCode,
    reason,
    next_retry_at: status === 'success' ? null : new Date(Date.now() + 60_000).toISOString(),
    stale: status !== 'success',
    message: fixedMessages[status],
  };
}

export function failedSourceOutcome(source: SyncSourceName, error: unknown, durationMs: number): SourceOutcome {
  const errorCode = stableErrorCode(error);
  return {
    source,
    status: 'failure',
    counts: { failures: 1 },
    duration_ms: finiteCount(durationMs),
    error_code: errorCode,
    reason: errorCode,
    next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    stale: true,
    message: errorCode === 'FEISHU_TOKEN_REFRESH_FAILED'
      ? '飞书授权刷新失败；请由系统主人重新授权后再试。'
      : fixedMessages.failure,
  };
}

export function stableErrorCode(error: unknown) {
  const ownData = (value: unknown, key: string) => {
    if (!value || typeof value !== 'object') return undefined;
    try {
      if (nodeTypes.isProxy(value)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch {
      return undefined;
    }
  };
  if (error && typeof error === 'object') {
    const diagnostic = ownData(error, 'diagnostic');
    if (ownData(diagnostic, 'stage') === 'token_refresh') return 'FEISHU_TOKEN_REFRESH_FAILED';
    const category = ownData(error, 'category');
    if (category === 'rate_limit') return 'FEISHU_RATE_LIMITED';
    if (category === 'transient') return 'FEISHU_TRANSIENT_FAILURE';
    if (category === 'authorization') return 'FEISHU_AUTHORIZATION_FAILED';
    if (category === 'permission') return 'FEISHU_PERMISSION_DENIED';
    if (ownData(error, 'errorCode') === 'FEISHU_API_ERROR') return 'FEISHU_API_ERROR';
  }
  return 'OBS_INTERNAL_FAILURE';
}

export function overallOutcome(sources: SourceOutcome[]): OperationOutcome {
  if (!sources.length || sources.every((source) => source.status === 'skipped')) return 'skipped';
  if (sources.every((source) => source.status === 'success')) return 'success';
  if (sources.every((source) => source.status === 'failure' || source.status === 'skipped')
      && sources.some((source) => source.status === 'failure')) return 'failure';
  return 'partial_success';
}

export function safeSyncTotals(sources: SourceOutcome[]) {
  const total = (keys: string[]) => sources.reduce(
    (sum, source) => sum + keys.reduce((sourceSum, key) => sourceSum + finiteCount(source.counts[key]), 0),
    0,
  );
  return {
    scopes: total(['scopes']),
    messages: total(['messages', 'events', 'minutes']),
    deduplicated: total(['deduplicated']),
    failures: total(['failures', 'detailFailures']),
    skipped: overallOutcome(sources) === 'skipped',
  };
}

export function releaseIdentity(input: { appVersion: string; buildIdentity?: string | null }): ReleaseIdentity {
  const appVersion = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(input.appVersion) ? input.appVersion : 'unknown';
  const buildIdentity = input.buildIdentity && /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u.test(input.buildIdentity)
    ? input.buildIdentity
    : null;
  return { app_version: appVersion, build_identity: buildIdentity, redaction_schema_version: REDACTION_SCHEMA_VERSION };
}

export function operationEnvelope(input: {
  context?: OperationContext;
  requestId?: string;
  operationId?: string;
  traceId?: string;
  parentSpanId?: string | null;
  spanId?: string;
  startedAt: number;
  sources: SourceOutcome[];
  release: ReleaseIdentity;
}): ObservableOperationResult {
  const completedAtMillis = Date.now();
  const context = input.context ?? createOperationContext({
    requestId: input.requestId ?? randomUUID(),
    traceId: input.traceId,
    parentSpanId: input.parentSpanId,
    operationId: input.operationId,
    spanId: input.spanId,
  });
  return {
    operation_id: context.operation_id,
    request_id: context.request_id,
    trace_id: context.trace_id,
    parent_span_id: context.parent_span_id,
    span_id: context.span_id,
    outcome: overallOutcome(input.sources),
    started_at: new Date(input.startedAt).toISOString(),
    completed_at: new Date(completedAtMillis).toISOString(),
    duration_ms: Math.max(0, completedAtMillis - input.startedAt),
    sources: input.sources,
    release: input.release,
  };
}
