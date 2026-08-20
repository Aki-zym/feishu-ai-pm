export type SyncOutcome = 'success' | 'partial' | 'skipped' | 'failure';
export type RawSyncOutcome = SyncOutcome | 'partial_success';

export type SyncRelease = {
  app_version: string | null;
  build_identity: string | null;
  redaction_schema_version: string | null;
};

export type SyncSourceRow = {
  source: string;
  outcome: SyncOutcome;
  counts: Record<string, number>;
  duration_ms: number;
  error_code: string | null;
  reason: string | null;
  message: string;
  next_retry_at: string | null;
  stale: boolean;
};

export type SyncOperation = {
  operation_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  parent_span_id: string | null;
  span_id: string | null;
  outcome: SyncOutcome;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number;
  sources: SyncSourceRow[];
  release: SyncRelease | null;
  invalid: boolean;
};

export type HealthReason = { code: string; message: string };
export type HealthDependency = {
  status: 'ready' | 'degraded' | 'not_ready' | 'unknown';
  error_code: string | null;
  observed_at: string | null;
  details: Record<string, string | number | boolean | null>;
};
export type HealthSnapshot = {
  operation_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  liveness: 'alive' | 'unknown';
  readiness: 'ready' | 'degraded' | 'not_ready';
  reasons: HealthReason[];
  dependencies: Record<string, HealthDependency>;
  release: SyncRelease | null;
  timestamp: string | null;
  invalid: boolean;
};

export type SafeLogRow = {
  id: string | null;
  category: 'runtime' | 'integration' | 'ai' | 'workspace' | 'unknown';
  level: 'info' | 'warn' | 'error' | 'unknown';
  event_type: string;
  event_label: string;
  message: string;
  operation_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  parent_span_id: string | null;
  span_id: string | null;
  details: Record<string, string | number | boolean | null>;
  created_at: string | null;
};

export type SafeIntegrationHealthRow = {
  integration: 'feishu' | 'llm' | 'workspace' | 'unknown';
  status: 'ready' | 'mock_ready' | 'partial' | 'unauthorized' | 'admin_required' | 'not_configured' | 'unavailable' | 'error' | 'unknown';
  status_label: string;
  message: string;
  latency_ms: number | null;
  checked_at: string | null;
};

export type SafeDecisionRow = {
  provider: '已记录' | '未提供';
  model: '已记录' | '未提供';
  prompt_version: '已记录' | '未提供';
  used_fallback: boolean;
  fallback_mode: '模型' | '规则降级' | '未知模式';
  input_char_count: number | null;
};

export type SafeCorrectionRow = {
  correction_type: 'false_positive' | 'missed_request' | 'wrong_association' | 'wrong_fields' | 'describe_incomplete' | 'status_or_schedule_wrong' | 'reprocess' | 'unknown';
  correction_label: string;
  note: '有备注' | '未填写备注';
  created_at: string | null;
};

export type SafeLogResponse = {
  logs: SafeLogRow[];
  decisions: SafeDecisionRow[];
  health: SafeIntegrationHealthRow[];
  corrections: SafeCorrectionRow[];
  invalid: boolean;
};

const safeCountKeys = new Set([
  'scopes', 'messages', 'deduplicated', 'failures', 'newChats', 'calendars', 'events',
  'detailFailures', 'minutes', 'pages', 'checked', 'changed',
]);

const sourceNames: Record<string, string> = {
  owner_messages: '主人消息',
  owner_dm: '我的普通私聊',
  owner_mentions: '群聊中 @我',
  bot_supplement: '机器人补充入口',
  calendar: '我的日历',
  minutes: '会议纪要与妙记',
  documents: '文档背景',
  feishu: '飞书信息流',
  feishu_source: '飞书来源',
};

const outcomeMessages: Record<SyncOutcome, string> = {
  success: '该来源同步成功。',
  partial: '该来源部分成功；失败项已保留供后续重试。',
  skipped: '本轮未执行同步。',
  failure: '未完成同步；已保留安全诊断信息。',
};

const readinessMessages: Record<string, string> = {
  OBS_HEALTH_UNAVAILABLE: '健康状态暂时无法确认。',
  OBS_UNKNOWN_REASON: '健康原因暂未提供安全说明。',
  SOURCE_ERROR: '至少一个已启用信息源处于错误状态。',
  FEISHU_AUTHORIZATION_REQUIRED: '至少一个已启用飞书信息源需要系统主人重新授权。',
  FEISHU_ADMIN_APPROVAL_REQUIRED: '至少一个已启用飞书信息源需要管理员批准权限。',
  SOURCE_PARTIAL: '至少一个已启用信息源只能部分工作。',
  RUNTIME_FAILED_JOBS: '存在已失败且需人工查看的本地工作项。',
  DATABASE_UNAVAILABLE: '本地数据库当前不可用。',
  OBS_RUNNER_UNAVAILABLE: '本地运行器当前不可用。',
  OBS_LISTENER_UNAVAILABLE: '信息流监听当前未就绪。',
  OBS_TOKEN_STATE: '授权状态需要重新确认。',
  OBS_DATA_STALE: '部分来源数据已陈旧。',
  OBS_RETRY_COOLDOWN: '部分来源仍在退避冷却中。',
  OBS_QUEUE_DEGRADED: '本地队列存在需要处理的工作项。',
  OBS_DISK_UNAVAILABLE: '本地诊断存储状态无法确认。',
};
const readinessReasonCodes = new Set([
  'SOURCE_ERROR',
  'FEISHU_AUTHORIZATION_REQUIRED',
  'FEISHU_ADMIN_APPROVAL_REQUIRED',
  'SOURCE_PARTIAL',
  'RUNTIME_FAILED_JOBS',
  'DATABASE_UNAVAILABLE',
  'OBS_RUNNER_UNAVAILABLE',
  'OBS_LISTENER_UNAVAILABLE',
  'OBS_TOKEN_STATE',
  'OBS_DATA_STALE',
  'OBS_RETRY_COOLDOWN',
  'OBS_QUEUE_DEGRADED',
  'OBS_DISK_UNAVAILABLE',
]);
const healthDependencyNames = new Set(['database', 'runner', 'listener', 'token', 'freshness', 'backoff', 'queue', 'disk']);
const healthDependencyErrorCodes = new Set([
  'DATABASE_UNAVAILABLE',
  'RUNTIME_FAILED_JOBS',
  'OBS_RUNNER_UNAVAILABLE',
  'OBS_LISTENER_UNAVAILABLE',
  'OBS_TOKEN_STATE',
  'OBS_DATA_STALE',
  'OBS_RETRY_COOLDOWN',
  'OBS_QUEUE_DEGRADED',
  'OBS_DISK_UNAVAILABLE',
]);
const healthDependencyDetailKeys = new Set([
  'provider', 'failed_jobs', 'pending_jobs', 'stale_sources', 'observed_sources',
  'active_cooldowns', 'state', 'live_adapter', 'running', 'available_bytes',
]);

const sourceNameSet = new Set(Object.keys(sourceNames));
const safeErrorCodes = new Set([
  'OBS_ALREADY_RUNNING',
  'OBS_SYNC_DISABLED',
  'FEISHU_OAUTH_REQUIRED',
  'FEISHU_SCOPE_REQUIRED',
  'OBS_ADAPTER_UNAVAILABLE',
  'OBS_NOTHING_TO_SYNC',
  'FEISHU_SYNC_PARTIAL',
  'FEISHU_SYNC_FAILED',
  'OBS_INVALID_SOURCE_RESULT',
  'FEISHU_TOKEN_REFRESH_FAILED',
  'FEISHU_RATE_LIMITED',
  'FEISHU_TRANSIENT_FAILURE',
  'FEISHU_AUTHORIZATION_FAILED',
  'FEISHU_PERMISSION_DENIED',
  'FEISHU_API_ERROR',
  'OBS_INTERNAL_FAILURE',
]);

const internalIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const semverPattern = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const buildIdentityPattern = /^[0-9a-f]{7,64}$/iu;
const schemaVersionPattern = /^v?(?:[1-9][0-9]{0,2})$/u;

const logCategorySet = new Set<SafeLogRow['category']>(['runtime', 'integration', 'ai', 'workspace']);
const logLevelSet = new Set<SafeLogRow['level']>(['info', 'warn', 'error']);
const logEventLabels: Record<string, string> = {
  'feishu.sync.completed': '信息源同步已结束',
  'feishu.source_sync.completed': '单个信息源同步已结束',
  'feishu.listener.started': '信息流监听已启动',
  'feishu.listener.stopped': '信息流监听已停止',
  'feishu.listener.start_failed': '信息流监听启动失败',
  'feishu.bot_listener.start_failed': '补充入口启动失败',
  'feishu.owner.refreshed': '主人身份已刷新',
  'feishu.monitoring_scope.refreshed': '关注范围已刷新',
  'feishu.monitoring_scope.saved': '关注范围已保存',
  'feishu.oauth.completed': '授权已完成',
  'feishu.oauth.exchange_failed': '授权交换失败',
  'feishu.oauth.owner_identity_failed': '主人身份读取失败',
  'integration.checked': '连接检查已完成',
  'logs.cleanup': '诊断日志已清理',
  'reference.inspected': '参考路径已检查',
  'reference.unbound': '参考路径已解除绑定',
  'memory.rebuilt': '任务记忆已重建',
  'memory.projected': '任务记忆已投影',
  'memory.projection_failed': '任务记忆投影失败',
};
const logEventLabelFallback = '已记录一条受控运行事件。';

const integrationNames = new Set<SafeIntegrationHealthRow['integration']>(['feishu', 'llm', 'workspace']);
const integrationStatuses = new Set<Exclude<SafeIntegrationHealthRow['status'], 'unknown'>>([
  'ready', 'mock_ready', 'partial', 'unauthorized', 'admin_required', 'not_configured', 'unavailable', 'error',
]);
const integrationStatusLabels: Record<SafeIntegrationHealthRow['status'], string> = {
  ready: '健康',
  mock_ready: '本地 Mock 健康',
  partial: '部分可用',
  unauthorized: '未授权',
  admin_required: '需要管理员批准',
  not_configured: '未配置',
  unavailable: '暂不可用',
  error: '最近检查失败',
  unknown: '未提供',
};
const integrationStatusMessages: Record<SafeIntegrationHealthRow['status'], string> = {
  ready: '连接检查已通过。',
  mock_ready: '本地 Mock 连接可用。',
  partial: '连接只能部分工作。',
  unauthorized: '尚未完成授权。',
  admin_required: '需要管理员批准权限。',
  not_configured: '尚未完成配置。',
  unavailable: '连接当前不可用。',
  error: '最近一次连接检查失败。',
  unknown: '连接状态暂未提供安全说明。',
};
const correctionLabels: Record<SafeCorrectionRow['correction_type'], string> = {
  false_positive: '这不是需求',
  missed_request: '漏掉的需求',
  wrong_association: '关联错误',
  wrong_fields: '提出人或字段错误',
  describe_incomplete: 'describe 不完整',
  status_or_schedule_wrong: '状态或排期错误',
  reprocess: '重新处理',
  unknown: '未提供安全说明',
};
const logResponseKeys = new Set(['logs', 'decisions', 'health', 'corrections', 'redactionSchemaVersion']);
const logRowKeys = new Set([
  'id', 'category', 'level', 'event_type', 'summary', 'message', 'context_json', 'details',
  'operation_id', 'request_id', 'trace_id', 'parent_span_id', 'span_id', 'created_at',
]);
const safeLogDetailKeys = new Set([
  'active_cooldowns', 'available_bytes', 'botSupplementStarted', 'changed', 'checked', 'completeness',
  'durationMs', 'errorCode', 'errorType', 'failed', 'failures', 'groupsDiscovered', 'messages',
  'nextRetryAt', 'outcome', 'ownerOpenIdPresent', 'pages', 'peopleDiscovered', 'reason', 'running',
  'scope', 'source', 'stale', 'state', 'tenantPresent', 'usedFallback',
]);
const forbiddenLogDetailText = /(?:bearer|token|secret|password|api[_-]?key|client[_-]?secret|provider|prompt|raw|content|body|path)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeIdentity(value: unknown) {
  if (typeof value !== 'string' || value.length !== 36 || !internalIdPattern.test(value)) return null;
  return value.toLowerCase();
}

function safeTimestamp(value: unknown) {
  if (typeof value !== 'string' || value.length > 80 || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function safeLogCategory(value: unknown): SafeLogRow['category'] {
  return typeof value === 'string' && logCategorySet.has(value as SafeLogRow['category'])
    ? value as SafeLogRow['category']
    : 'unknown';
}

function safeLogLevel(value: unknown): SafeLogRow['level'] {
  return typeof value === 'string' && logLevelSet.has(value as SafeLogRow['level'])
    ? value as SafeLogRow['level']
    : 'unknown';
}

function normalizeLogRow(value: unknown): SafeLogRow | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, logRowKeys)) return null;
  const eventType = typeof value.event_type === 'string' && logEventLabels[value.event_type]
    ? value.event_type
    : 'OBS_UNKNOWN_EVENT';
  const details = isPlainRecord(value.details)
    ? Object.fromEntries(Object.entries(value.details)
      .filter(([key]) => safeLogDetailKeys.has(key))
      .filter(([, detail]) => typeof detail === 'string' || typeof detail === 'number' || typeof detail === 'boolean' || detail === null)
      .filter(([, detail]) => typeof detail !== 'string' || (!forbiddenLogDetailText.test(detail) && detail.length <= 160))
      .slice(0, 12)) as Record<string, string | number | boolean | null>
    : {};
  return {
    id: safeIdentity(value.id),
    category: safeLogCategory(value.category),
    level: safeLogLevel(value.level),
    event_type: eventType,
    event_label: logEventLabels[eventType] ?? logEventLabelFallback,
    message: logEventLabels[eventType] ?? logEventLabelFallback,
    operation_id: safeIdentity(value.operation_id),
    request_id: safeIdentity(value.request_id),
    trace_id: safeIdentity(value.trace_id),
    parent_span_id: safeIdentity(value.parent_span_id),
    span_id: safeIdentity(value.span_id),
    details,
    created_at: safeTimestamp(value.created_at),
  };
}

export function normalizeLogRows(value: unknown): SafeLogRow[] {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.logs)
      ? value.logs
      : [];
  return rows.map(normalizeLogRow).filter((row): row is SafeLogRow => Boolean(row));
}

function safeFiniteNonnegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeIntegrationHealthRow(value: unknown): SafeIntegrationHealthRow {
  if (!isPlainRecord(value)) {
    return { integration: 'unknown', status: 'unknown', status_label: integrationStatusLabels.unknown, message: integrationStatusMessages.unknown, latency_ms: null, checked_at: null };
  }
  const integration = typeof value.integration === 'string' && integrationNames.has(value.integration as SafeIntegrationHealthRow['integration'])
    ? value.integration as SafeIntegrationHealthRow['integration']
    : 'unknown';
  const status = typeof value.status === 'string' && integrationStatuses.has(value.status as Exclude<SafeIntegrationHealthRow['status'], 'unknown'>)
    ? value.status as Exclude<SafeIntegrationHealthRow['status'], 'unknown'>
    : 'unknown';
  return {
    integration,
    status,
    status_label: integrationStatusLabels[status],
    message: integrationStatusMessages[status],
    latency_ms: safeFiniteNonnegativeInteger(value.latency_ms),
    checked_at: safeTimestamp(value.checked_at),
  };
}

export function normalizeIntegrationHealthRows(value: unknown): SafeIntegrationHealthRow[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeIntegrationHealthRow);
}

function normalizeDecisionRow(value: unknown): SafeDecisionRow {
  if (!isPlainRecord(value)) {
    return { provider: '未提供', model: '未提供', prompt_version: '未提供', used_fallback: false, fallback_mode: '未知模式', input_char_count: null };
  }
  const usedFallback = value.used_fallback === true;
  const fallbackMode = usedFallback
    ? value.fallback_mode === 'rule_fallback' || value.fallback_mode === 'rule_mock' || value.fallback_mode === undefined
      ? '规则降级'
      : '未知模式'
    : value.fallback_mode === 'llm'
      ? '模型'
      : value.fallback_mode === undefined
        ? '未知模式'
        : '未知模式';
  return {
    provider: typeof value.provider === 'string' && value.provider.trim() ? '已记录' : '未提供',
    model: typeof value.model === 'string' && value.model.trim() ? '已记录' : '未提供',
    prompt_version: typeof value.prompt_version === 'string' && value.prompt_version.trim() ? '已记录' : '未提供',
    used_fallback: usedFallback,
    fallback_mode: fallbackMode,
    input_char_count: safeFiniteNonnegativeInteger(value.input_char_count),
  };
}

export function normalizeDecisionRows(value: unknown): SafeDecisionRow[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeDecisionRow);
}

function normalizeCorrectionRow(value: unknown): SafeCorrectionRow {
  if (!isPlainRecord(value)) {
    return { correction_type: 'unknown', correction_label: correctionLabels.unknown, note: '未填写备注', created_at: null };
  }
  const correctionType = typeof value.correction_type === 'string' && Object.prototype.hasOwnProperty.call(correctionLabels, value.correction_type)
    ? value.correction_type as SafeCorrectionRow['correction_type']
    : 'unknown';
  return {
    correction_type: correctionType,
    correction_label: correctionLabels[correctionType],
    note: typeof value.note === 'string' && value.note.trim() ? '有备注' : '未填写备注',
    created_at: safeTimestamp(value.created_at),
  };
}

export function normalizeCorrectionRows(value: unknown): SafeCorrectionRow[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeCorrectionRow);
}

export function normalizeLogResponse(value: unknown): SafeLogResponse {
  if (!isPlainRecord(value)) return { logs: [], decisions: [], health: [], corrections: [], invalid: true };
  const logsValue = value.logs;
  const decisionsValue = value.decisions;
  const healthValue = value.health;
  const correctionsValue = value.corrections;
  const invalid = !hasOnlyKeys(value, logResponseKeys)
    || !Array.isArray(logsValue)
    || !Array.isArray(decisionsValue)
    || !Array.isArray(healthValue)
    || !Array.isArray(correctionsValue);
  return {
    logs: normalizeLogRows(logsValue),
    decisions: normalizeDecisionRows(decisionsValue),
    health: normalizeIntegrationHealthRows(healthValue),
    corrections: normalizeCorrectionRows(correctionsValue),
    invalid,
  };
}

function safeOutcome(value: unknown): SyncOutcome | null {
  if (value === 'success' || value === 'skipped' || value === 'failure') return value;
  if (value === 'partial' || value === 'partial_success') return 'partial';
  return null;
}

function safeCounts(value: unknown): Record<string, number> | null {
  if (!isPlainRecord(value)) return null;
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!safeCountKeys.has(key) || safeFiniteNonnegativeInteger(count) === null) return null;
    counts[key] = count as number;
  }
  return counts;
}

function safeRelease(value: unknown): SyncRelease | null {
  if (!isRecord(value)) return null;
  return {
    app_version: typeof value.app_version === 'string' && value.app_version.length <= 64 && semverPattern.test(value.app_version)
      ? value.app_version
      : null,
    build_identity: typeof value.build_identity === 'string' && value.build_identity.length <= 64 && buildIdentityPattern.test(value.build_identity)
      ? value.build_identity.toLowerCase()
      : null,
    redaction_schema_version: typeof value.redaction_schema_version === 'string' && value.redaction_schema_version.length <= 4 && schemaVersionPattern.test(value.redaction_schema_version)
      ? value.redaction_schema_version.toLowerCase()
      : null,
  };
}

function normalizeSource(value: unknown): SyncSourceRow | null {
  if (!isPlainRecord(value)) return null;
  const sourceKeys = new Set(['source', 'status', 'counts', 'duration_ms', 'error_code', 'reason', 'message', 'next_retry_at', 'stale']);
  if (!hasOnlyKeys(value, sourceKeys)) return null;
  const outcome = safeOutcome(value.status);
  if (!outcome || typeof value.source !== 'string' || !sourceNameSet.has(value.source)) return null;
  const counts = safeCounts(value.counts);
  if (!counts) return null;
  if (typeof value.duration_ms !== 'number' || !Number.isFinite(value.duration_ms) || value.duration_ms < 0) return null;
  if (!('error_code' in value) || (value.error_code !== null && typeof value.error_code !== 'string')) return null;
  if ('reason' in value && value.reason !== null && typeof value.reason !== 'string') return null;
  if (!('message' in value) || typeof value.message !== 'string') return null;
  if (!('next_retry_at' in value) || (value.next_retry_at !== null && safeTimestamp(value.next_retry_at) === null)) return null;
  if (!('stale' in value) || typeof value.stale !== 'boolean') return null;
  const errorCode = value.error_code === null ? null : typeof value.error_code === 'string' && safeErrorCodes.has(value.error_code) ? value.error_code : null;
  if (value.error_code !== null && errorCode === null) return null;
  const reason = value.reason === null || value.reason === undefined
    ? null
    : typeof value.reason === 'string' && safeErrorCodes.has(value.reason) ? value.reason : null;
  if (value.reason !== null && value.reason !== undefined && reason === null) return null;
  const retryAt = value.next_retry_at as string | null;
  const stale = value.stale as boolean;
  const failures = (counts.failures ?? 0) + (counts.detailFailures ?? 0);
  const useful = Object.entries(counts)
    .filter(([key]) => !['failures', 'detailFailures'].includes(key))
    .reduce((total, [, count]) => total + count, 0);
  if (outcome === 'success' && (stale || errorCode !== null || reason !== null || retryAt !== null || failures > 0)) return null;
  if (outcome === 'partial' && (!stale || errorCode !== 'FEISHU_SYNC_PARTIAL' || reason !== 'FEISHU_SYNC_PARTIAL' || retryAt === null || failures < 1 || useful < 1)) return null;
  if (outcome === 'failure' && (!stale || errorCode === null || reason !== errorCode || retryAt === null || failures < 1)) return null;
  if (outcome === 'skipped' && (!stale || errorCode === null || reason !== errorCode || retryAt === null || failures > 0 || useful > 0)) return null;
  return {
    source: value.source,
    outcome,
    counts,
    duration_ms: value.duration_ms,
    error_code: errorCode,
    reason,
    message: outcomeMessages[outcome],
    next_retry_at: retryAt,
    stale,
  };
}

function invalidSyncOperation(): SyncOperation {
  return {
    operation_id: null,
    request_id: null,
    trace_id: null,
    parent_span_id: null,
    span_id: null,
    outcome: 'failure',
    started_at: null,
    completed_at: null,
    duration_ms: 0,
    sources: [],
    release: null,
    invalid: true,
  };
}

function normalizedOutcomeForSources(sources: SyncSourceRow[]): SyncOutcome {
  if (sources.every((source) => source.outcome === 'skipped')) return 'skipped';
  if (sources.every((source) => source.outcome === 'success')) return 'success';
  if (sources.every((source) => source.outcome === 'failure' || source.outcome === 'skipped')
      && sources.some((source) => source.outcome === 'failure')) return 'failure';
  return 'partial';
}

function normalizedCount(sources: SyncSourceRow[], keys: string[]) {
  return sources.reduce((total, source) => total + keys.reduce((sourceTotal, key) => sourceTotal + (source.counts[key] ?? 0), 0), 0);
}

function normalizedTotals(sources: SyncSourceRow[]) {
  return {
    scopes: normalizedCount(sources, ['scopes']),
    messages: normalizedCount(sources, ['messages', 'events', 'minutes']),
    deduplicated: normalizedCount(sources, ['deduplicated']),
    failures: normalizedCount(sources, ['failures', 'detailFailures']),
    skipped: normalizedOutcomeForSources(sources) === 'skipped',
  };
}

export function normalizeSyncOperation(value: unknown): SyncOperation {
  if (!isPlainRecord(value)) return invalidSyncOperation();
  const operationKeys = new Set([
    'operation_id', 'request_id', 'outcome', 'started_at', 'completed_at', 'duration_ms', 'sources', 'release',
    'scopes', 'messages', 'deduplicated', 'failures', 'skipped', 'trace_id', 'parent_span_id', 'span_id',
  ]);
  if (!hasOnlyKeys(value, operationKeys) || typeof value.outcome !== 'string') return invalidSyncOperation();
  const outcome = safeOutcome(value.outcome);
  if (!outcome || !Array.isArray(value.sources) || value.sources.length === 0) return invalidSyncOperation();
  for (const key of ['scopes', 'messages', 'deduplicated', 'failures'] as const) {
    if (key in value && safeFiniteNonnegativeInteger(value[key]) === null) return invalidSyncOperation();
  }
  if ('skipped' in value && typeof value.skipped !== 'boolean') return invalidSyncOperation();
  if (typeof value.duration_ms !== 'number' || !Number.isFinite(value.duration_ms) || value.duration_ms < 0) return invalidSyncOperation();
  const normalizedSources = value.sources.map(normalizeSource);
  if (normalizedSources.length === 0 || normalizedSources.some((row) => row === null)) return invalidSyncOperation();
  const rawSources = normalizedSources as SyncSourceRow[];
  const expectedOutcome = normalizedOutcomeForSources(rawSources);
  if (outcome !== expectedOutcome) return invalidSyncOperation();
  const totals = normalizedTotals(rawSources);
  for (const [key, expected] of Object.entries(totals)) {
    if (key in value && value[key] !== expected) return invalidSyncOperation();
  }
  return {
    operation_id: safeIdentity(value.operation_id),
    request_id: safeIdentity(value.request_id),
    trace_id: safeIdentity(value.trace_id),
    parent_span_id: safeIdentity(value.parent_span_id),
    span_id: safeIdentity(value.span_id),
    outcome,
    started_at: safeTimestamp(value.started_at),
    completed_at: safeTimestamp(value.completed_at),
    duration_ms: value.duration_ms,
    sources: rawSources,
    release: safeRelease(value.release),
    invalid: false,
  };
}

export function normalizeHealth(value: unknown): HealthSnapshot {
  if (!isRecord(value)) {
    return { operation_id: null, request_id: null, trace_id: null, span_id: null, liveness: 'unknown', readiness: 'not_ready', reasons: [{ code: 'OBS_HEALTH_UNAVAILABLE', message: '健康状态暂时无法确认。' }], dependencies: {}, release: null, timestamp: null, invalid: true };
  }
  const readiness = value.readiness && isRecord(value.readiness) ? value.readiness : null;
  const status = readiness?.status;
  const statusValid = status === 'ready' || status === 'degraded' || status === 'not_ready';
  const rawReasons = readiness && Array.isArray(readiness.reasons) ? readiness.reasons : [];
  const reasonsShapeValid = readiness !== null
    && Array.isArray(readiness.reasons)
    && (status === 'ready' || rawReasons.length > 0)
    && readiness.reasons.every((reason) => isRecord(reason)
      && typeof reason.code === 'string'
      && readinessReasonCodes.has(reason.code));
  const rawDependencies = value.dependencies;
  const dependenciesShapeValid = isPlainRecord(rawDependencies)
    && Object.keys(rawDependencies).every((key) => healthDependencyNames.has(key))
    && Object.values(rawDependencies).every((item) => {
      if (!isPlainRecord(item)) return false;
      if (!(item.status === 'ready' || item.status === 'degraded' || item.status === 'not_ready' || item.status === 'unknown')) return false;
      if (!(item.error_code === null || (typeof item.error_code === 'string' && healthDependencyErrorCodes.has(item.error_code)))) return false;
      if (!(item.observed_at === null || safeTimestamp(item.observed_at) !== null)) return false;
      if (item.details === undefined) return true;
      return isPlainRecord(item.details)
        && Object.keys(item.details).every((key) => healthDependencyDetailKeys.has(key))
        && Object.values(item.details).every((detail) => typeof detail === 'string' || typeof detail === 'number' || typeof detail === 'boolean' || detail === null);
    });
  const requiredDependenciesKnown = ['token', 'freshness', 'backoff', 'disk'].every((name) => {
    const dependency = isPlainRecord(rawDependencies) ? rawDependencies[name] : null;
    return isPlainRecord(dependency) && dependency.status !== 'unknown';
  });
  const readyDependencies = ['token', 'freshness', 'backoff', 'disk'].every((name) => {
    const dependency = isPlainRecord(rawDependencies) ? rawDependencies[name] : null;
    return isPlainRecord(dependency) && dependency.status === 'ready';
  });
  const invalid = readiness === null || !statusValid || !reasonsShapeValid || !dependenciesShapeValid || !requiredDependenciesKnown || (status === 'ready' && !readyDependencies);
  const readinessStatus: HealthSnapshot['readiness'] = !invalid
    ? (status === 'ready' ? 'ready' : status === 'degraded' ? 'degraded' : 'not_ready')
    : 'not_ready';
  const reasons = rawReasons.map((reason) => {
    if (!isRecord(reason)) {
      return { code: 'OBS_UNKNOWN_REASON', message: '健康原因暂未提供安全说明。' };
    }
    const code = typeof reason.code === 'string' && readinessReasonCodes.has(reason.code)
      ? reason.code
      : 'OBS_UNKNOWN_REASON';
    return { code, message: readinessMessages[code] ?? '健康原因暂未提供安全说明。' };
  });
  const safeReasons = invalid
    ? [{ code: 'OBS_HEALTH_UNAVAILABLE', message: readinessMessages.OBS_HEALTH_UNAVAILABLE ?? '健康状态暂时无法确认。' }]
    : reasons;
  return {
    operation_id: safeIdentity(value.operation_id),
    request_id: safeIdentity(value.request_id),
    trace_id: safeIdentity(value.trace_id),
    span_id: safeIdentity(value.span_id),
    liveness: isRecord(value.liveness) && value.liveness.status === 'alive' ? 'alive' : 'unknown',
    readiness: readinessStatus,
    reasons: safeReasons,
    dependencies: isPlainRecord(value.dependencies)
      ? Object.fromEntries(Object.entries(value.dependencies).slice(0, 8).map(([key, item]) => {
        if (!isPlainRecord(item)) return [key, { status: 'unknown', error_code: 'OBS_HEALTH_UNAVAILABLE', observed_at: null, details: {} } satisfies HealthDependency];
        const depStatus = item.status === 'ready' || item.status === 'degraded' || item.status === 'not_ready' ? item.status : 'unknown';
        const details = isPlainRecord(item.details)
          ? Object.fromEntries(Object.entries(item.details)
            .filter(([key]) => healthDependencyDetailKeys.has(key))
            .filter(([, detail]) => typeof detail === 'string' || typeof detail === 'number' || typeof detail === 'boolean' || detail === null)
            .slice(0, 8)) as Record<string, string | number | boolean | null>
          : {};
        return [key, { status: depStatus, error_code: typeof item.error_code === 'string' && healthDependencyErrorCodes.has(item.error_code) ? item.error_code : null, observed_at: safeTimestamp(item.observed_at), details } satisfies HealthDependency];
      }))
      : {},
    release: safeRelease(value.release),
    timestamp: safeTimestamp(value.timestamp),
    invalid,
  };
}

export function syncOutcomeLabel(outcome: SyncOutcome) {
  return { success: '同步成功', partial: '部分同步', skipped: '已跳过', failure: '同步失败' }[outcome];
}

export function syncOutcomeTone(outcome: RawSyncOutcome) {
  const normalized = outcome === 'partial_success' ? 'partial' : outcome;
  if (normalized === 'failure') return 'error' as const;
  if (normalized === 'partial' || normalized === 'skipped') return 'warning' as const;
  return 'success' as const;
}

export function syncSourceLabel(source: string) {
  return sourceNames[source] ?? '其他来源';
}

export function syncOutcomeMessage(outcome: SyncOutcome) {
  return outcomeMessages[outcome];
}

export function shortDiagnosticId(value: string | null) {
  const safeValue = safeIdentity(value);
  return safeValue ? safeValue.slice(0, 8) : '未提供';
}
