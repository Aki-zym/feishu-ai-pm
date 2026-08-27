import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import type {
  CandidateState,
  CandidateAnalysis,
  CandidateMergeClassificationContext,
  CandidateMergeDecision,
  CandidateDraft,
  CandidateTimeRange,
  CalendarClassification,
  CandidateNarrativeUpdates,
  FeishuMonitoringScope,
  FeishuMonitorTarget,
  MemoryProjectionRecord,
  MessageAction,
  MessageActionDecision,
  ModelThreadCandidate,
  NormalizedSourceEvent,
  OwnerIdentity,
  OwnerIntentDecision,
  OwnerSourceKind,
  OwnerSourceStatus,
  RequirementThreadRecord,
  RiskLevel,
  TaskUpdateProposalRecord,
  TaskRecord,
  TaskStatus,
  SourceDocumentContext,
  ThreadAssociationDecision,
  ThreadClassificationContext,
} from './domain.js';
import { CURRENT_SCHEMA_VERSION, DatabaseUpgradeError, type AppDatabase } from './database.js';
import {
  DATA04_OWNER_SCOPE,
  canonicalRevisionHash,
} from './data04.js';
import type { ReturnTypeOfAdapters } from './types.js';
import type { ClassificationResult, DurableEventReceipt, IntegrationCheck } from './integration-contracts.js';
import { PmRuntime, sanitizeRuntimeError, type RuntimeJobRow } from './runtime.js';
import { RuntimeCooldownDeferredError } from './runtime.js';
import { classifyRetryFailure, RetryCoordinator, SqliteRetryCooldownStore, type RetryFailureMetadata } from './retry-policy.js';
import {
  SHANGHAI_CALENDAR_OMITTED_WARNING,
  SHANGHAI_TIMEZONE,
  assertShanghaiCalendarPlanRange,
  projectShanghaiCalendarPlan,
  shanghaiDayWindow,
} from './shanghai-time.js';
import {
  REDACTION_SCHEMA_VERSION,
  redactDiagnosticRecord,
  redactDiagnosticText,
  redactDiagnosticValue,
} from './redaction.js';
import {
  failedSourceOutcome,
  childOperationContext,
  createOperationContext,
  isOperationContext,
  operationEnvelope,
  releaseIdentity,
  safeSyncTotals,
  syncSourceOutcome,
  type ReadinessStatus,
  type OperationContext,
  type SafeReason,
  type SourceOutcome,
} from './observability.js';
import {
  minimalCandidateDtoSchema,
  minimalSourceDtoSchema,
  ownerInformationDtoSchema,
  sourceExcerpt,
  sourceScope,
  sourceVerificationDtoSchema,
  sourceVerificationRequestSchema,
  requirementThreadDtoSchema,
  threadRevisionDtoSchema,
  threadDetailDtoSchema,
  taskDetailDtoSchema,
  taskDtoSchema,
  taskUpdateProposalDtoSchema,
  type MinimalSourceDto,
  type SourceVerificationDto,
} from './source-privacy.js';

type OwnerDecisionTarget = {
  candidateId: string | null;
  candidateVersion?: number | null;
  candidateGroupVersionHash?: string | null;
  candidateState: CandidateState | null;
  acceptedTaskId: string | null;
  threadId: string | null;
  taskId: string | null;
  taskStatus: TaskStatus | null;
  taskVersion: number | null;
  threadVersion: number | null;
  sourceMatched: boolean;
  candidateDeleted?: boolean;
  taskDeleted?: boolean;
  taskInvalidated?: boolean;
};

type OwnerScheduleEvidence = {
  sourceText: string;
  startAt: string | null;
  dueAt: string | null;
  needsConfirmation: boolean;
};

type OwnerDecisionResult = {
  eligible: boolean;
  action: OwnerIntentDecision['action'] | 'none';
  disposition: 'apply_task_patch' | 'accept_candidate' | 'decline_candidate' | 'delegate_candidate' | 'review' | 'noop';
  target: OwnerDecisionTarget | null;
  patch: { status?: TaskStatus; plannedStartAt?: string | null; plannedDueAt?: string | null; nextStep?: string; waitingReason?: string | null; note?: string };
  delegateTo: string | null;
  reason: string;
  confidence: number;
};

function isOwnerDecisionSource(metadata: Record<string, unknown>, senderId: string, trustedOwnerIds: Iterable<string>) {
  const sender = senderId.trim();
  return Boolean(sender && new Set([...trustedOwnerIds].map((value) => value.trim())).has(sender)
    && (metadata.isOwnerMessage === true || metadata.senderRole === 'owner'));
}

function decideOwnerIntent(input: { senderId: string; metadata: Record<string, unknown>; trustedOwnerIds: Iterable<string>; intent: OwnerIntentDecision | null; targets: OwnerDecisionTarget[]; schedule?: OwnerScheduleEvidence | null }): OwnerDecisionResult {
  if (!input.intent || !isOwnerDecisionSource(input.metadata, input.senderId, input.trustedOwnerIds) || input.targets.length !== 1) {
    return { eligible: false, action: input.intent?.action ?? 'none', disposition: 'review', target: null, patch: {}, delegateTo: null, reason: '当前路径不执行旧版主人消息分类。', confidence: 0 };
  }
  return { eligible: false, action: input.intent.action, disposition: 'review', target: input.targets[0]!, patch: {}, delegateTo: null, reason: '当前路径不执行旧版主人消息分类。', confidence: input.intent.confidence };
}

function sourceContextRevision(contexts: SourceDocumentContext[]) {
  return createHash('sha256').update(JSON.stringify(contexts.map((context) => ({
    sourceUrl: context.sourceUrl,
    documentId: context.documentId,
    documentType: context.documentType,
    sourceVersion: context.sourceVersion,
    contentHash: context.contentHash,
    status: context.status,
    freshness: context.freshness,
    completeness: context.completeness,
    truncated: context.truncated,
  })).sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl)))).digest('hex');
}

function projectUntrustedSenderName(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : '需求方';
}
function timeRangeFromSource(_content: string, _occurredAt: string): CandidateTimeRange {
  return { status: 'unknown', sourceText: null, startAt: null, endAt: null, timezone: 'Asia/Shanghai', needsConfirmation: true };
}
type CandidateRow = {
  id: string;
  version: number;
  source_event_id: string;
  demand_unit_id: string | null;
  title: string;
  proposer_name: string;
  background: string;
  validation_question: string;
  describe: string;
  analysis_json: string;
  confidence: number;
  state: CandidateState;
  snoozed_until: string | null;
  accepted_task_id: string | null;
  merged_into_candidate_id: string | null;
  merged_at: string | null;
  deleted_at: string | null;
  processing_state: 'organizing' | 'retry_waiting' | 'ready' | 'incomplete_context' | 'recovered' | 'failed_visible';
  processing_job_id: string | null;
  processing_error: string | null;
  context_state: 'complete' | 'possibly_incomplete';
  context_reason: string | null;
  recovered_at: string | null;
  created_at: string;
  updated_at: string;
};

export const CANDIDATE_VERSION_CONFLICT_MESSAGE = '候选已被其他操作更新，请刷新后重试。';

export class CandidateVersionConflictError extends Error {
  readonly errorCode = 'CONFLICT' as const;

  constructor() {
    super(CANDIDATE_VERSION_CONFLICT_MESSAGE);
    this.name = 'CandidateVersionConflictError';
  }
}

export class CandidateVersionRequiredError extends Error {
  readonly errorCode = 'INVALID_EXPECTED_VERSION' as const;

  constructor() {
    super('候选变更需要提供当前候选版本。');
    this.name = 'CandidateVersionRequiredError';
  }
}

export class CindyIntakeValidationError extends Error {
  readonly errorCode = 'INVALID_INPUT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CindyIntakeValidationError';
  }
}

export class CindyIntakeConflictError extends Error {
  readonly errorCode = 'CONFLICT' as const;
  readonly currentVersion: number | null;

  constructor(message: string, currentVersion: number | null = null) {
    super(message);
    this.name = 'CindyIntakeConflictError';
    this.currentVersion = currentVersion;
  }
}

type CandidateRevisionPayloadRow = {
  id: string;
  candidate_id: string;
  title: string;
  proposer_name: string;
  background: string;
  validation_question: string;
  describe: string;
  analysis_json: string;
  confidence: number;
  state: 'current' | 'proposed' | 'superseded' | 'rejected';
};

type CandidateDeletedState = 'active' | 'only' | 'all';
type CandidateRuntimeFence = { candidateId: string; version: number };

const candidateRuntimeFenceSchema = z.array(z.object({
  candidateId: z.string().min(1).max(200),
  version: z.number().int().positive(),
}).strict()).max(128);

type SourceFailureStatus = 'open' | 'retrying' | 'resolved' | 'ignored' | 'stale';
const SOURCE_FAILURE_CODE_VALUES = [
  'MODEL_OUTPUT_INVALID',
  'MODEL_TIMEOUT',
  'MODEL_RATE_LIMITED',
  'MODEL_REQUEST_FAILED',
  'SOURCE_CLASSIFICATION_FAILED',
] as const;
type SourceFailureCode = typeof SOURCE_FAILURE_CODE_VALUES[number];
const SOURCE_FAILURE_CODES = new Set<string>(SOURCE_FAILURE_CODE_VALUES);
function isSourceFailureCode(value: string): value is SourceFailureCode {
  return SOURCE_FAILURE_CODES.has(value);
}

function sourceFailureId(sourceEventId: string, sourceRevision: string) {
  return `failure_${createHash('sha256').update(`${sourceEventId}:${sourceRevision}`).digest('hex').slice(0, 24)}`;
}

function stableSourceFailureCode(code: string | null | undefined, error?: unknown): SourceFailureCode {
  const normalized = typeof code === 'string' ? code.trim() : '';
  if (isSourceFailureCode(normalized)) return normalized;
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || /timeout/i.test(name)) return 'MODEL_TIMEOUT';
  if (/invalidmodeljson|zoderror|schema|json/i.test(`${normalized} ${name}`)) return 'MODEL_OUTPUT_INVALID';
  if (/rate|429/i.test(`${normalized} ${name}`)) return 'MODEL_RATE_LIMITED';
  if (/network|fetch|connect|request/i.test(`${normalized} ${name}`)) return 'MODEL_REQUEST_FAILED';
  return 'SOURCE_CLASSIFICATION_FAILED';
}

function sourceFailureMessage(errorCode: SourceFailureCode) {
  switch (errorCode) {
    case 'MODEL_OUTPUT_INVALID': return '模型输出未通过结构校验，来源已保留，等待安全重试。';
    case 'MODEL_TIMEOUT': return '模型请求超时，来源已保留，等待安全重试。';
    case 'MODEL_RATE_LIMITED': return '模型服务暂时限流，来源已保留，等待安全重试。';
    case 'MODEL_REQUEST_FAILED': return '模型请求失败，来源已保留，等待安全重试。';
    default: return '来源分类未完成，来源已保留，等待安全重试。';
  }
}

const sourceFailureTimestamp = z.string().min(1).max(80).refine((value) => Number.isFinite(Date.parse(value)), '时间格式不合法。');
const sourceFailureRecordSchema = z.object({
  id: z.string().regex(/^failure_[a-f0-9]{24}$/u),
  source_revision: z.string().regex(/^[a-f0-9]{64}$/u),
  source_event_ids: z.array(z.string().trim().min(1).max(256)).min(1).max(64),
  job_id: z.string().trim().min(1).max(256),
  stage: z.literal('classification'),
  error_code: z.enum(SOURCE_FAILURE_CODE_VALUES),
  error_message: z.string().max(300),
  status: z.enum(['open', 'retrying', 'resolved', 'ignored']),
  retryable: z.boolean(),
  attempts: z.number().int().nonnegative().max(1_000_000),
  max_attempts: z.number().int().positive().max(1_000_000),
  first_failed_at: sourceFailureTimestamp,
  last_failed_at: sourceFailureTimestamp,
  next_retry_at: sourceFailureTimestamp.nullable(),
  resolved_at: sourceFailureTimestamp.nullable(),
  ignored_at: sourceFailureTimestamp.nullable(),
  updated_at: sourceFailureTimestamp,
}).strict().superRefine((value, context) => {
  if (new Set(value.source_event_ids).size !== value.source_event_ids.length) {
    context.addIssue({ code: 'custom', path: ['source_event_ids'], message: '来源 ID 不得重复。' });
  }
  if (value.max_attempts < value.attempts) {
    context.addIssue({ code: 'custom', path: ['max_attempts'], message: '最大尝试次数不能小于当前尝试次数。' });
  }
  if (Date.parse(value.first_failed_at) > Date.parse(value.last_failed_at)) {
    context.addIssue({ code: 'custom', path: ['last_failed_at'], message: '失败时间顺序不合法。' });
  }
  if (value.error_message !== sourceFailureMessage(value.error_code)) {
    context.addIssue({ code: 'custom', path: ['error_message'], message: '错误消息不是固定脱敏消息。' });
  }
  const retryable = value.status === 'open' || value.status === 'retrying';
  if (value.retryable !== retryable) {
    context.addIssue({ code: 'custom', path: ['retryable'], message: 'retryable 与状态不一致。' });
  }
  if (value.status === 'resolved' && !value.resolved_at) {
    context.addIssue({ code: 'custom', path: ['resolved_at'], message: 'resolved 必须有 resolved_at。' });
  }
  if (value.status !== 'resolved' && value.resolved_at) {
    context.addIssue({ code: 'custom', path: ['resolved_at'], message: '非 resolved 不得携带 resolved_at。' });
  }
  if (value.status === 'ignored' && !value.ignored_at) {
    context.addIssue({ code: 'custom', path: ['ignored_at'], message: 'ignored 必须有 ignored_at。' });
  }
  if (value.status !== 'ignored' && value.ignored_at) {
    context.addIssue({ code: 'custom', path: ['ignored_at'], message: '非 ignored 不得携带 ignored_at。' });
  }
  if (value.status === 'retrying' && !value.next_retry_at) {
    context.addIssue({ code: 'custom', path: ['next_retry_at'], message: 'retrying 必须有 next_retry_at。' });
  }
  if (value.status !== 'retrying' && value.next_retry_at) {
    context.addIssue({ code: 'custom', path: ['next_retry_at'], message: '非 retrying 不得携带 next_retry_at。' });
  }
});

type SourceFailureRecord = z.infer<typeof sourceFailureRecordSchema>;

type SourceFailureRelation = {
  job: RuntimeJobRow;
  sourceEventIds: string[];
  sourceRevision: string;
};

type SourceFailureMetadata = {
  failure_inbox?: unknown;
};

type LogDecisionRow = Record<
  'id' | 'provider' | 'model' | 'prompt_version' | 'is_data_request' |
  'confidence' | 'used_fallback' | 'http_status' | 'attempts' |
  'structured_mode' | 'input_hash' | 'input_char_count' | 'fallback_mode' |
  'latency_ms' | 'created_at',
  unknown
>;

type LogCorrectionRow = Record<
  'id' | 'task_id' | 'candidate_id' | 'correction_type' | 'note' | 'created_at',
  unknown
>;

function diagnosticNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function diagnosticBoolean(value: unknown) {
  return value === true || value === 1;
}

function diagnosticInternalId(value: unknown) {
  if (typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/u.test(value)) return value;
  return `redacted_${createHash('sha256').update(typeof value === 'string' ? value : '').digest('hex').slice(0, 16)}`;
}

function optionalDiagnosticInternalId(value: unknown) {
  return value === null || value === undefined ? null : diagnosticInternalId(value);
}

function diagnosticTimestamp(value: unknown) {
  return typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value)) ? value : null;
}

const diagnosticEventLabels: Record<string, string> = {
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
const diagnosticEventFallback = '已记录一条受控运行事件。';

function diagnosticLogDetails(value: unknown) {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown; } catch { return {}; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const input = parsed as Record<string, unknown>;
  const aliases: Record<string, string> = {
    operationId: 'operation_id', requestId: 'request_id', traceId: 'trace_id', parentSpanId: 'parent_span_id', spanId: 'span_id',
    errorCode: 'error_code', nextRetryAt: 'next_retry_at', durationMs: 'duration_ms',
  };
  const safeEventCodes = new Set([
    'OBS_ALREADY_RUNNING', 'OBS_SYNC_DISABLED', 'FEISHU_OAUTH_REQUIRED', 'FEISHU_SCOPE_REQUIRED',
    'OBS_ADAPTER_UNAVAILABLE', 'OBS_NOTHING_TO_SYNC', 'FEISHU_SYNC_PARTIAL', 'FEISHU_SYNC_FAILED',
    'OBS_INVALID_SOURCE_RESULT', 'FEISHU_TOKEN_REFRESH_FAILED', 'FEISHU_RATE_LIMITED',
    'FEISHU_TRANSIENT_FAILURE', 'FEISHU_AUTHORIZATION_FAILED', 'FEISHU_PERMISSION_DENIED',
    'FEISHU_API_ERROR', 'OBS_INTERNAL_FAILURE', 'PRIVACY_COLLECTION_STOPPED',
  ]);
  const safeStatuses = new Set(['success', 'partial_success', 'skipped', 'failure']);
  const safeStages = new Set(['token_refresh', 'sync', 'source_sync', 'runtime', 'listener']);
  const safeOutcomes = new Set(['success', 'partial_success', 'skipped', 'failure']);
  const allowed = new Set(['operation_id', 'request_id', 'trace_id', 'parent_span_id', 'span_id', 'outcome', 'source', 'status', 'error_code', 'reason', 'duration_ms', 'stale', 'next_retry_at', 'stage', 'job_id', 'task_id']);
  const result: Record<string, string | number | boolean | null> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = aliases[rawKey] ?? rawKey;
    if (!allowed.has(key)) continue;
    if (typeof rawValue === 'string') {
      if (key.endsWith('_id')) {
        result[key] = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(rawValue) ? rawValue.toLowerCase() : null;
      } else if (key === 'next_retry_at') {
        result[key] = diagnosticTimestamp(rawValue);
      } else if (key === 'error_code' || key === 'reason') {
        result[key] = safeEventCodes.has(rawValue) ? rawValue : null;
      } else if (key === 'status') {
        result[key] = safeStatuses.has(rawValue) ? rawValue : null;
      } else if (key === 'outcome') {
        result[key] = safeOutcomes.has(rawValue) ? rawValue : null;
      } else if (key === 'stage') {
        result[key] = safeStages.has(rawValue) ? rawValue : null;
      } else {
        result[key] = redactDiagnosticText(rawValue, 120) || null;
      }
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) result[key] = rawValue;
    else if (typeof rawValue === 'boolean') result[key] = rawValue;
    else if (rawValue === null) result[key] = null;
  }
  return result;
}

function diagnosticRecentError(row: Record<string, unknown>) {
  const category = row.category === 'runtime' || row.category === 'integration' || row.category === 'ai' || row.category === 'workspace'
    ? row.category
    : 'unknown';
  return {
    category,
    level: 'error',
    event_type: 'OBS_ERROR_EVENT',
    summary: '已记录一条受控运行错误。',
    created_at: diagnosticTimestamp(row.created_at),
  };
}

function diagnosticDecision(row: LogDecisionRow) {
  return {
    id: diagnosticInternalId(row.id),
    provider: redactDiagnosticText(row.provider, 80),
    model: redactDiagnosticText(row.model, 120),
    prompt_version: redactDiagnosticText(row.prompt_version, 120),
    is_data_request: diagnosticBoolean(row.is_data_request),
    confidence: diagnosticNumber(row.confidence),
    used_fallback: diagnosticBoolean(row.used_fallback),
    http_status: diagnosticNumber(row.http_status),
    attempts: diagnosticNumber(row.attempts),
    structured_mode: redactDiagnosticText(row.structured_mode, 80) || null,
    input_hash: typeof row.input_hash === 'string' && /^[a-f0-9]{64}$/iu.test(row.input_hash) ? row.input_hash : null,
    input_char_count: diagnosticNumber(row.input_char_count),
    fallback_mode: redactDiagnosticText(row.fallback_mode, 80) || null,
    latency_ms: diagnosticNumber(row.latency_ms),
    created_at: redactDiagnosticText(row.created_at, 80),
  };
}

function diagnosticCorrection(row: LogCorrectionRow) {
  return {
    id: diagnosticInternalId(row.id),
    task_id: optionalDiagnosticInternalId(row.task_id),
    candidate_id: optionalDiagnosticInternalId(row.candidate_id),
    correction_type: redactDiagnosticText(row.correction_type, 80),
    // A free-form correction note may contain copied source text. The logs UI
    // only needs to know that a note exists, never its contents.
    note: typeof row.note === 'string' && row.note.trim() ? '<redacted>' : '',
    created_at: redactDiagnosticText(row.created_at, 80),
  };
}

type ClassificationPersistResult = {
  deduplicated: boolean;
  sourceEventId: string;
  sourceEventIds?: string[];
  sourceRevision?: string;
  errorCode?: string;
  candidate: CandidateRow | null;
  candidates?: CandidateRow[];
  candidateIds?: string[];
  demandUnitIds?: string[];
  threadIds?: string[];
  classificationDeferred?: boolean;
  /** Optional association deferral can be explicitly terminal even if a legacy adapter omitted metadata. */
  deferredRetryable?: boolean;
  recoveryReason?: string;
  metadata?: ClassificationResult['metadata'];
};

type ClassificationResultIds = Pick<ClassificationPersistResult, 'candidateIds' | 'demandUnitIds' | 'threadIds'>;

type OwnerDecisionRow = {
  id: string;
  source_event_id: string;
  source_revision: string;
  candidate_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  action: OwnerIntentDecision['action'];
  disposition: string;
  confidence: number;
  summary: string;
  delegate_to: string | null;
  schedule_text: string | null;
  patch_json: string;
  evidence_json: string;
  reason: string;
  provider: string;
  model: string;
  prompt_version: string;
  runtime_job_id: string | null;
  state: 'queued' | 'running' | 'applied' | 'review' | 'failed' | 'stale' | 'noop';
  target_snapshot_json: string;
  applied_task_version: number | null;
  applied_thread_version: number | null;
  error: string | null;
  created_at: string;
  applied_at: string | null;
};

type OwnerDecisionCandidateRow = CandidateRow & { source_occurred_at: string };
type OwnerDecisionTargetSnapshots = {
  schemaVersion: 1;
  contextCount: number;
  targets: Record<OwnerIntentDecision['action'], OwnerDecisionTarget[]>;
};

class OwnerTargetSnapshotPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OwnerTargetSnapshotPersistenceError';
  }
}

const ownerDecisionTargetSchema = z.object({
  candidateId: z.string().nullable(),
  // DATA-03 adds candidate CAS identity to the owner target snapshot.  Keep
  // these nullable/optional for snapshots written before the CAS fields
  // existed; ownerTargetMatchesCurrent still fails closed when a live
  // candidate lacks either value.
  candidateVersion: z.number().int().nonnegative().nullable().optional(),
  candidateGroupVersionHash: z.string().nullable().optional(),
  candidateState: z.enum(['pending', 'snoozed', 'ignored', 'accepted']).nullable(),
  acceptedTaskId: z.string().nullable(),
  threadId: z.string().nullable(),
  taskId: z.string().nullable(),
  taskStatus: z.enum(['unplanned', 'planned', 'in_progress', 'waiting', 'review', 'completed', 'archived']).nullable(),
  taskVersion: z.number().int().nonnegative().nullable(),
  threadVersion: z.number().int().nonnegative().nullable(),
  sourceMatched: z.boolean(),
  candidateDeleted: z.boolean(),
  taskDeleted: z.boolean(),
  taskInvalidated: z.boolean(),
}).strict();

const ownerDecisionTargetSnapshotsSchema = z.object({
  schemaVersion: z.literal(1),
  contextCount: z.number().int().nonnegative(),
  targets: z.object({
    continue: z.array(ownerDecisionTargetSchema),
    confirm_schedule: z.array(ownerDecisionTargetSchema),
    request_context: z.array(ownerDecisionTargetSchema),
    decline: z.array(ownerDecisionTargetSchema),
    delegate: z.array(ownerDecisionTargetSchema),
    uncertain: z.array(ownerDecisionTargetSchema),
  }).strict(),
}).strict();

class ClassificationRevisionChangedError extends Error {
  constructor(readonly rows: SourceEventRow[]) {
    super('来源在多需求判断期间发生更新，需要基于新版本重新整理。');
  }
}

/** A persisted owner decision was based on an old task/thread snapshot. */
class OwnerDecisionStaleError extends Error {
  constructor(message = '主人判断对应的需求已经发生变化，未自动覆盖最新状态。') {
    super(message);
    this.name = 'OwnerDecisionStaleError';
  }
}

/** A late OAuth response must not mutate owner or source state. */
class FeishuAuthStateStaleError extends Error {
  constructor() {
    super('飞书授权状态已更新，已丢弃迟到的主人身份响应。');
    this.name = 'FeishuAuthStateStaleError';
  }
}

function classificationResultIds(result: ClassificationPersistResult): ClassificationResultIds {
  const candidates = result.candidates ?? (result.candidate ? [result.candidate] : []);
  return {
    candidateIds: [...new Set(result.candidateIds ?? candidates.map((candidate) => candidate.id))],
    demandUnitIds: [...new Set(result.demandUnitIds ?? candidates.map((candidate) => candidate.demand_unit_id).filter((value): value is string => Boolean(value)))],
    threadIds: [...new Set(result.threadIds ?? [])],
  };
}

type PersistableClassificationUnit = {
  unitKey: string;
  sourceKeys: string[];
  sourceKeyById: Map<string, string>;
  sourceRows: SourceEventRow[];
  anchor: SourceEventRow;
  isDataRequest: boolean;
  draft: CandidateDraft | null;
  reason: string;
};

type RequirementThreadRow = RequirementThreadRecord;

type RequirementThreadSourceRow = {
  thread_id: string;
  source_event_id: string;
  demand_unit_id: string | null;
  relation_type: string;
  confidence: number | null;
  evidence_json: string;
  root_id: string | null;
  parent_id: string | null;
  created_at: string;
};

type TaskUpdateProposalRow = TaskUpdateProposalRecord;

type TaskPatch = Partial<{
  title: string;
  describe: string;
  status: TaskStatus;
  scheduleAt: string | null;
  plannedStartAt: string | null;
  plannedDueAt: string | null;
  nextStep: string;
  risk: RiskLevel;
  waitingReason: string | null;
  threadTitle: string;
  threadBackground: string;
  threadValidationQuestion: string;
  threadDescribe: string;
  note: string;
  expectedVersion: number;
}>;

type ServiceAdapters = ReturnTypeOfAdapters;

export type CindyIntakeInput = {
  window_id: string;
  window_start: string;
  window_end: string;
  result_kind?: 'intake' | 'empty_window';
  inbox_id?: string;
  claim_token?: string;
  sources: Array<{
    source_key: string;
    source_kind?: 'aily_summary';
    occurred_at: string;
    conversation_key?: string;
    sender_role?: string;
    agent_id?: string;
    generated_at?: string;
    text: string;
  }>;
  proposals: Array<{
    action: 'create_candidate' | 'update_task' | 'skip' | 'needs_owner';
    source_keys: string[];
    task_key?: string;
    expected_version?: number;
    title?: string;
    describe?: string;
    next_step?: string;
    reason?: string;
  }>;
};

export type CindyIntakeResult = {
  window_id: string;
  result_kind: 'intake' | 'empty_window';
  duplicate: boolean;
  source_event_ids: string[];
  proposals: Array<{
    action: CindyIntakeInput['proposals'][number]['action'];
    source_keys: string[];
    candidate_id?: string;
    task_key?: string;
    version?: number;
    reason?: string;
  }>;
};

type StoredCindyIntakeResult = CindyIntakeResult & {
  _input_hash: string;
};

type CindyIntakeWindow = {
  window_id: string;
  window_start: string;
  window_end: string;
  reused: boolean;
};

type AilySummaryInboxStatus = 'ready' | 'claimed' | 'retry_waiting' | 'completed' | 'failed';

type AilySummaryInboxRow = {
  id: string;
  window_id: string;
  window_start: string;
  window_end: string;
  result_kind: 'summary' | 'empty';
  agent_id: string;
  summary_text: string;
  content_hash: string;
  generated_at: string;
  status: AilySummaryInboxStatus;
  attempts: number;
  available_at: string;
  lease_until: string | null;
  claim_token_hash: string | null;
  last_error_code: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type AutomationMode = 'auto' | 'suggest';
type ProposalApplyActor = 'owner' | 'ai';
const AUTO_UPDATE_POLICY_VERSION = 'private_task_auto_v1';
const AUTO_ASSOCIATION_CONFIDENCE = 0.9;
const AUTO_SEMANTIC_ASSOCIATION_CONFIDENCE = 0.96;
const AUTO_SEMANTIC_ASSOCIATION_MARGIN = 0.15;
const AUTO_CANDIDATE_MERGE_CONFIDENCE = 0.94;
const AUTO_CANDIDATE_MERGE_MARGIN = 0.15;
const AUTO_CANDIDATE_PRIMARY_CONFIDENCE = 0.9;
const AUTO_CANDIDATE_DRAFT_CONFIDENCE = 0.85;
const MIN_EXPLICIT_MESSAGE_ACTION_CONFIDENCE = 0.85;
const AUTO_UPDATE_CONFIDENCE = 0.92;
const AUTO_TERMINAL_STATUS_CONFIDENCE = 0.97;
const CONTINUOUS_MESSAGE_WINDOW_MS = 5 * 60 * 1000;
const CONTINUOUS_DIALOGUE_WINDOW_MS = 30 * 60 * 1000;
const EXPLICIT_MESSAGE_CONTEXT_WINDOW_MS = 72 * 60 * 60 * 1000;
const AILY_SUMMARY_INBOX_LEASE_MS = 10 * 60 * 1000;
const AILY_SUMMARY_INBOX_MAX_ATTEMPTS = 5;
const AILY_SUMMARY_INBOX_RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 20 * 60_000] as const;
const AILY_SUMMARY_INBOX_RETENTION_DAYS = 30;
const terminalQuestionPattern = /[？?]|(?:是否|能否|可否|是不是|有没有)/iu;
const explicitCompletionPatterns = [
  /^(?:(?:这项|这个|该项|本项)(?:需求|任务|分析|工作|事项))?(?:已经|已|现已|确认(?:已经|已)?)(?:明确)?(?:完成|做完|交付|结项)(?:了|啦|完毕)?$/iu,
  /^(?:这项|这个|该项|本项)(?:需求|任务|分析|工作|事项)(?:完成|做完|交付|结项)(?:了|啦|完毕)?$/iu,
  /^(?:(?:这项|这个|该项|本项)(?:需求|任务|分析|工作|事项))?验收(?:已经|已)?通过(?:了)?$/iu,
  /^(?:可以|可)(?:直接)?(?:结项|关闭(?:(?:这项|这个|该项|本项)(?:需求|任务|分析|工作|事项))?)(?:了)?$/iu,
  /^(?:(?:the\s+)?(?:task|request|work|analysis)\s+)?(?:(?:is|has\s+been|was)\s+)?(?:completed|delivered|done)$/iu,
];
const explicitArchivePatterns = [
  /^(?:这项|这个|该项|本项)(?:需求|任务|分析|工作|事项)?(?:已经|已|正式)?(?:取消|撤销|终止|停止|归档|关闭)(?:了)?$/iu,
  /^(?:已经|已|正式)(?:取消|撤销|终止|停止|归档|关闭)(?:(?:这项|这个|该项|本项)(?:需求|任务|分析|工作|事项)?)?(?:了)?$/iu,
  /^(?:取消|撤销|终止|停止|归档|关闭)(?:这项|这个|该项|本项)(?:需求|任务|分析|工作|事项)?(?:了)?$/iu,
  /^(?:无需|不用|不必|不再)(?:再|继续)?(?:处理|推进|跟进|开展)(?:(?:这项|这个|该项|本项)(?:需求|任务|分析|工作|事项)?)?(?:了)?$/iu,
  /^(?:(?:the\s+)?(?:task|request|work|analysis)\s+)?(?:(?:is|has\s+been|was)\s+)?(?:cancelled|canceled|archived|closed)$/iu,
  /^no\s+longer\s+(?:need|needed)(?:\s+(?:this|the))?(?:\s+(?:task|request|work|analysis))?$/iu,
];

function terminalEvidenceClauses(content: string) {
  return content
    .replace(/([，。！？；;,.!?：:])/gu, '$1\n')
    .split(/\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasExplicitTerminalEvidence(content: string, status: 'completed' | 'archived') {
  const patterns = status === 'completed' ? explicitCompletionPatterns : explicitArchivePatterns;
  return terminalEvidenceClauses(content).some((rawClause) => {
    if (terminalQuestionPattern.test(rawClause)) return false;
    const clause = rawClause.replace(/[，。！；;,.!:：]+$/gu, '').trim();
    return patterns.some((pattern) => pattern.test(clause));
  });
}

function appendNarrativeValue(current: string, addition: string) {
  const existing = current.trim();
  const next = addition.trim();
  if (!next || existing === next || existing.includes(next)) return existing;
  if (!existing) return next;
  return `${existing}\n${next}`;
}

type NarrativeReplacementField = 'title' | 'describe' | 'background' | 'validationQuestion';

const narrativeReplacementFieldPatterns: Record<NarrativeReplacementField, RegExp> = {
  title: /(?:标题|题目|任务名|需求名|task\s*title)/iu,
  describe: /(?:describe|描述|需求摘要|任务摘要|需求描述|任务描述)/iu,
  background: /(?:背景|需求背景|task\s*background)/iu,
  validationQuestion: /(?:希望验证|验证问题|验证目标|核心问题|待验证问题|validation\s*question)/iu,
};

function hasExplicitNarrativeReplacement(content: string, field: NarrativeReplacementField) {
  return terminalEvidenceClauses(content).some((clause) => (
    narrativeReplacementFieldPatterns[field].test(clause)
    && /(?:改成|修改为|调整为|更正为|纠正为|应为|应该是|不是.+(?:而是|是)|(?:说|写|记|理解)?错了)/iu.test(clause)
  ));
}

const AUDIT_SOURCE_TYPES = ['owner_dm', 'group', 'calendar', 'meeting', 'manual', 'document'] as const;
const AUDIT_COMPLETENESS = ['complete', 'partial', 'limited'] as const;
const AUDIT_UNIT_KINDS = ['demand', 'context_only'] as const;
const AUDIT_DEMAND_STATES = ['provisional', 'ready', 'needs_confirmation', 'incomplete_context', 'superseded', 'failed_visible'] as const;
const AUDIT_CANDIDATE_STATES = ['pending', 'snoozed', 'ignored', 'accepted'] as const;
const AUDIT_THREAD_STATES = ['open', 'needs_confirmation', 'closed'] as const;
const AUDIT_TASK_STATUSES = ['unplanned', 'planned', 'in_progress', 'waiting', 'review', 'completed', 'archived'] as const;
const AUDIT_RISK_LEVELS = ['low', 'medium', 'high'] as const;
const AUDIT_RECORD_STATES = ['active', 'invalidated'] as const;
const AUDIT_SOURCE_ROLES = ['anchor', 'evidence', 'context', 'owner_delivery'] as const;
const AUDIT_RELATION_TYPES = [
  'origin', 'primary', 'supporting', 'owner_corrected', 'owner_confirmed', 'owner_corrected_new',
  'owner_confirmed_new', 'owner_delivery', 'session', 'batch_context', 'batch_continuation',
  'semantic_unique', 'merged_origin', 'candidate_auto_merge', 'owner_candidate_merge', 'candidate_owner_merge',
] as const;
const AUDIT_EVENT_TYPES = [
  'task_created', 'task_updated', 'task_auto_updated', 'task_deleted', 'task_restored',
  'task_auto_update_reverted', 'correction_recorded',
] as const;
const AUDIT_ACTOR_TYPES = ['ai', 'owner', 'system'] as const;
const AUDIT_VISIBILITIES = ['private', 'awaiting_approval', 'external'] as const;
const AUDIT_CORRECTION_TYPES = [
  'integrity_gap_closed', 'candidate_auto_merge', 'candidate_owner_merge', 'wrong_association',
  'false_positive', 'describe_incomplete', 'reprocess',
] as const;
const AUDIT_OPERATIONS = ['apply', 'revert', 'dismiss'] as const;
const AUDIT_GAP_STATUSES = ['open', 'corrected', 'dismissed'] as const;
const AUDIT_GAP_CODES = ['missing_or_ambiguous_demand_unit', 'wrong_association'] as const;
const AUDIT_RECORD_KINDS = [
  'source_event', 'source_demand_unit', 'source_demand_unit_source', 'candidate_request',
  'requirement_thread_source', 'requirement_thread_unit', 'task_source_link', 'task_event',
  'correction_event', 'owner_decision', 'ai_decision_log',
] as const;
const AUDIT_INTERNAL_ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/u;

type PrivacyScope = 'all' | 'sources' | 'tasks' | 'audit';
type PrivacyControlRow = {
  collection_status: 'running' | 'stopped';
  oauth_status: 'unknown' | 'authorized' | 'expired' | 'revoked' | 'not_configured';
  retention_status: 'active' | 'paused';
  version: number;
  updated_at: string;
  created_at: string;
};

type PrivacyCollectionSnapshot = {
  control: PrivacyControlRow;
  sourceStates: Array<Record<string, unknown>>;
};

type PrivacyAuthorizationSnapshot = PrivacyCollectionSnapshot & {
  owner: Record<string, unknown> | undefined;
  cursors: Array<Record<string, unknown>>;
  monitorTargets: Array<Record<string, unknown>>;
  adapterState: unknown;
};

type PrivacyLifecycleOperationType = 'collection_start' | 'collection_stop' | 'authorization_revoke' | 'hard_delete';
type PrivacyLifecycleClaimRow = {
  operation_id: string;
  operation_token: string;
  operation_type: PrivacyLifecycleOperationType;
  owner_open_id: string;
  capability_token_hash: string;
  capability_csrf_hash: string;
  capability_origin: 'app://local';
  intent: string;
  expected_version: number;
  claimed_version: number;
  final_version: number | null;
  status: 'claimed' | 'committed' | 'compensating' | 'compensated' | 'recovery_required' | 'failed' | 'expired';
  expires_at: string;
  heartbeat_at: string;
  snapshot_json: string;
  recovery_code: string | null;
  last_error: string | null;
  reclaimed_from_operation_id: string | null;
  reclaimed_from_operation_token: string | null;
  reclaimed_from_expected_version: number | null;
  reclaimed_from_claimed_version: number | null;
  reclaim_count: number;
  created_at: string;
  updated_at: string;
};

const PRIVACY_LIFECYCLE_LEASE_MS = 15 * 60 * 1_000;
const PRIVACY_LIFECYCLE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function parsePrivacyLifecycleTimestamp(value: string, label: string) {
  if (!PRIVACY_LIFECYCLE_TIMESTAMP.test(value)) {
    throw new Error(`隐私生命周期 ${label} 时间戳格式无效；已 fail-closed。`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`隐私生命周期 ${label} 时间戳无效；已 fail-closed。`);
  }
  return parsed;
}

function privacyLifecycleTimeState(claim: PrivacyLifecycleClaimRow, nowMs: number) {
  const createdMs = parsePrivacyLifecycleTimestamp(claim.created_at, 'created_at');
  const heartbeatMs = parsePrivacyLifecycleTimestamp(claim.heartbeat_at, 'heartbeat_at');
  const expiresMs = parsePrivacyLifecycleTimestamp(claim.expires_at, 'expires_at');
  if (heartbeatMs < createdMs || expiresMs < heartbeatMs) {
    throw new Error('隐私生命周期 claim 时间顺序无效；已 fail-closed。');
  }
  if (nowMs < createdMs || nowMs < heartbeatMs) {
    throw new Error('检测到系统时钟回拨，隐私生命周期 claim 已 fail-closed。');
  }
  return { createdMs, heartbeatMs, expiresMs, expired: nowMs >= expiresMs };
}

type PrivacyCapabilityBinding = {
  tokenHash: string;
  csrfTokenHash: string;
  origin: 'app://local';
};

type PrivacyTaskMemoryPurgeStage = {
  count: number;
  proofHash: string;
  finalize(): void;
  rollback(): void;
};

const PRIVACY_PURGE_TABLES = [
  'data_integrity_gap', 'reference_snapshot', 'memory_projection', 'runtime_tool_call',
  'runtime_checkpoint', 'provider_retry_cooldown', 'job_source_link', 'task_update_proposal', 'requirement_thread_revision',
  'cindy_turn_evaluation', 'cindy_task_binding_suggestion', 'cindy_session_task_binding',
  'requirement_thread_unit', 'requirement_thread_source', 'notification', 'reminder',
  'reference_binding', 'outbox', 'approval', 'task_event', 'task_source_link', 'correction_event',
  'candidate_revision', 'candidate_merge_exclusion', 'owner_decision', 'ai_decision_log',
  'audit_replay_capability',
  'ai_decision_source_revision', 'source_event_revision',
  'source_context', 'source_demand_unit_source', 'candidate_request', 'requirement_thread',
  'source_demand_unit', 'privacy_export',
  'job', 'task', 'source_event', 'app_log', 'integration_health', 'sync_cursor',
  'aily_summary_inbox', 'feishu_monitor_target', 'information_source_state', 'owner_profile', 'app_setting',
] as const;
const PRIVACY_PRESERVED_TABLES = new Set([
  'database_metadata', 'schema_migration', 'privacy_control', 'privacy_retention_policy',
  'privacy_deletion', 'privacy_backup', 'privacy_audit_event', 'privacy_lifecycle_claim',
  'privacy_backup_cleanup_intent',
]);

const PRIVACY_RETENTION_OPERATIONS = Object.freeze([
  Object.freeze({ kind: 'source', table: 'source_demand_unit_source', timestamp: 'created_at' }),
  Object.freeze({ kind: 'source', table: 'source_context', timestamp: 'created_at' }),
  Object.freeze({ kind: 'source', table: 'source_demand_unit', timestamp: 'created_at' }),
  Object.freeze({ kind: 'source', table: 'source_event', timestamp: 'captured_at' }),
  Object.freeze({ kind: 'source', table: 'source_event_revision', timestamp: 'created_at' }),
  Object.freeze({ kind: 'derived', table: 'reference_snapshot', timestamp: 'inspected_at' }),
  Object.freeze({ kind: 'derived', table: 'task_event', timestamp: 'recorded_at' }),
  Object.freeze({ kind: 'derived', table: 'ai_decision_log', timestamp: 'created_at' }),
  Object.freeze({ kind: 'derived', table: 'owner_decision', timestamp: 'created_at' }),
  Object.freeze({ kind: 'derived', table: 'correction_event', timestamp: 'created_at' }),
  Object.freeze({ kind: 'derived', table: 'candidate_revision', timestamp: 'created_at' }),
  Object.freeze({ kind: 'derived', table: 'requirement_thread_revision', timestamp: 'created_at' }),
  Object.freeze({ kind: 'derived', table: 'privacy_export', timestamp: 'created_at' }),
  Object.freeze({ kind: 'derived', table: 'candidate_request', timestamp: 'updated_at' }),
  Object.freeze({ kind: 'derived', table: 'requirement_thread', timestamp: 'updated_at' }),
  Object.freeze({ kind: 'derived', table: 'task', timestamp: 'updated_at' }),
  Object.freeze({ kind: 'diagnostics', table: 'app_log', timestamp: 'created_at' }),
  Object.freeze({ kind: 'diagnostics', table: 'integration_health', timestamp: 'checked_at' }),
] as const);

function privacyHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export const PRIVACY_DELETION_INTENT = 'privacy.deletion.hard-delete.v1';
const PRIVACY_OWNER_ACTION_INTENT = 'privacy.owner-action.v1';

function privacyCapabilityBindingHash(binding: PrivacyCapabilityBinding) {
  if (!/^[a-f0-9]{64}$/u.test(binding.tokenHash) || !/^[a-f0-9]{64}$/u.test(binding.csrfTokenHash) || binding.origin !== 'app://local') {
    throw new PrivacyAuthorizationError(403, '桌面主人操作能力凭证绑定无效。');
  }
  return privacyHash(binding);
}

function privacyConfirmationHash(token: string, ownerOpenId: string, deletionId: string, capabilityBinding: PrivacyCapabilityBinding) {
  return privacyHash({
    intent: PRIVACY_DELETION_INTENT,
    ownerOpenId,
    deletionId,
    capabilityBinding: privacyCapabilityBindingHash(capabilityBinding),
    token,
  });
}

function assertPrivacyKey(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/u.test(value)) throw new Error(`${label}格式不正确。`);
}

export class PrivacyAuthorizationError extends Error {
  readonly statusCode: 401 | 403;

  constructor(statusCode: 401 | 403, message: string) {
    super(message);
    this.name = 'PrivacyAuthorizationError';
    this.statusCode = statusCode;
  }
}

function auditEnum(value: string | null | undefined, allowed: readonly string[]) {
  return typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
}

function auditHash(value: string | null | undefined) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function auditRequiredId(value: string | null | undefined) {
  return typeof value === 'string' && AUDIT_INTERNAL_ID_PATTERN.test(value) ? value : 'unknown';
}

function auditOptionalId(value: string | null | undefined) {
  return typeof value === 'string' && AUDIT_INTERNAL_ID_PATTERN.test(value) ? value : null;
}

function privacyFailure(message: string, failures: unknown[]) {
  const errors = failures.filter((failure): failure is Error => failure instanceof Error);
  if (errors.length === 1) return errors[0]!;
  return new AggregateError(errors.length ? errors : failures, message);
}

export type AuditChainDto = {
  filters: {
    source_event_id: string | null;
    demand_unit_id: string | null;
    candidate_id: string | null;
    thread_id: string | null;
    task_id: string | null;
  };
  sources: Array<{
    id: string;
    source_type: string;
    owner_mentioned: boolean;
    completeness: string;
    occurred_at: string;
    captured_at: string;
  }>;
  demand_units: Array<{
    id: string;
    anchor_source_event_id: string;
    unit_kind: string;
    state: string;
    classification_revision: string | null;
    ai_decision_id: string | null;
    created_at: string;
    updated_at: string;
  }>;
  candidates: Array<{
    id: string;
    source_event_id: string;
    demand_unit_id: string | null;
    confidence: number;
    state: string;
    accepted_task_id: string | null;
    merged_into_candidate_id: string | null;
    merged_at: string | null;
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  threads: Array<{
    id: string;
    status: string;
    active_task_id: string | null;
    primary_source_event_id: string | null;
    version: number;
    last_activity_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  tasks: Array<{
    id: string;
    status: string;
    schedule_at: string | null;
    planned_start_at: string | null;
    planned_due_at: string | null;
    risk: string;
    version: number;
    thread_id: string | null;
    record_state: string;
    created_at: string;
    updated_at: string;
  }>;
  source_demand_units: Array<{
    demand_unit_id: string;
    source_event_id: string;
    source_role: string;
    sequence: number;
    created_at: string;
  }>;
  thread_units: Array<{
    thread_id: string;
    demand_unit_id: string;
    relation_type: string;
    confidence: number | null;
    created_at: string;
  }>;
  thread_sources: Array<{
    thread_id: string;
    source_event_id: string;
    demand_unit_id: string | null;
    relation_type: string;
    confidence: number | null;
    source_revision: string | null;
    source_role: string;
    created_at: string;
  }>;
  task_source_links: Array<{
    task_id: string;
    source_event_id: string;
    demand_unit_id: string | null;
    relation_type: string;
    created_at: string;
  }>;
  ai_decisions: Array<{
    id: string;
    source_event_id: string;
    source_revision: string | null;
    demand_unit_id: string | null;
    candidate_id: string | null;
    confidence: number;
    used_fallback: boolean;
    http_status: number | null;
    attempts: number;
    structured_mode: string;
    input_hash: string | null;
    input_char_count: number;
    fallback_mode: string;
    latency_ms: number | null;
    created_at: string;
  }>;
  owner_decisions: Array<{
    id: string;
    source_event_id: string;
    source_revision: string | null;
    demand_unit_id: string | null;
    candidate_id: string | null;
    thread_id: string | null;
    task_id: string | null;
    action: string;
    disposition: string;
    confidence: number;
    state: string;
    applied_task_version: number | null;
    applied_thread_version: number | null;
    created_at: string;
    applied_at: string | null;
  }>;
  task_events: Array<{
    id: string;
    task_id: string;
    event_type: string;
    actor_type: string;
    visibility: string;
    source_event_id: string | null;
    demand_unit_id: string | null;
    occurred_at: string;
    recorded_at: string;
    version: number;
  }>;
  corrections: Array<{
    id: string;
    task_id: string | null;
    candidate_id: string | null;
    source_event_id: string | null;
    demand_unit_id: string | null;
    correction_type: string;
    visibility: string;
    operation: string;
    created_at: string;
  }>;
  integrity_gaps: Array<{
    id: string;
    source_event_id: string | null;
    demand_unit_id: string | null;
    candidate_id: string | null;
    thread_id: string | null;
    task_id: string | null;
    record_kind: string;
    gap_code: string;
    status: string;
    correction_event_id: string | null;
    created_at: string;
    updated_at: string;
  }>;
};

function threadRevisionPatchFromDraft(draft: CandidateDraft, includeNarrative: boolean) {
  if (!includeNarrative) return {};
  return {
    title: draft.title,
    background: draft.background,
    validationQuestion: draft.validationQuestion,
    describe: draft.describe,
    analysis: draft.analysis ?? {},
  };
}

const taskStatusValues = [
  'unplanned', 'planned', 'in_progress', 'waiting', 'review', 'completed', 'archived',
] as const satisfies readonly TaskStatus[];
const riskLevelValues = ['low', 'medium', 'high'] as const satisfies readonly RiskLevel[];
const threadStatusValues = ['open', 'needs_confirmation', 'closed'] as const satisfies readonly RequirementThreadRow['status'][];
const candidateStateValues = ['pending', 'snoozed', 'ignored', 'accepted'] as const satisfies readonly CandidateState[];
const nullableStringSchema = z.string().nullable();
const nullableIsoDateTimeSchema = z.string().datetime().nullable();
const taskUpdateTaskSnapshotSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  proposer_name: z.string(),
  describe: z.string(),
  status: z.enum(taskStatusValues),
  schedule_at: nullableIsoDateTimeSchema,
  planned_start_at: nullableIsoDateTimeSchema,
  planned_due_at: nullableIsoDateTimeSchema,
  next_step: z.string(),
  risk: z.enum(riskLevelValues),
  waiting_reason: nullableStringSchema,
  completed_at: nullableIsoDateTimeSchema,
  archived_at: nullableIsoDateTimeSchema,
  auto_update_paused: z.boolean(),
});
const taskUpdateThreadSnapshotSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  background: z.string(),
  validation_question: z.string(),
  describe: z.string(),
  analysis_json: z.string(),
  status: z.enum(threadStatusValues),
  version: z.number().int().nonnegative(),
  last_activity_at: nullableIsoDateTimeSchema,
});
const taskUpdateCandidateSnapshotSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  proposer_name: z.string(),
  background: z.string(),
  validation_question: z.string(),
  describe: z.string(),
  analysis_json: z.string(),
  confidence: z.number(),
  state: z.enum(candidateStateValues),
});
const taskUpdateProposalSnapshotSchema = z.object({
  task: taskUpdateTaskSnapshotSchema,
  thread: taskUpdateThreadSnapshotSchema.nullable(),
  candidate: taskUpdateCandidateSnapshotSchema.nullable(),
  previousCandidateRevisionId: nullableStringSchema.optional().default(null),
});
type TaskUpdateProposalSnapshot = z.infer<typeof taskUpdateProposalSnapshotSchema>;
const INVALID_TASK_UPDATE_SNAPSHOT_ERROR = '自动更新的前置快照损坏，不能安全撤销。';

type OwnerProfileRow = {
  id: string;
  open_id: string;
  union_id: string | null;
  user_id: string | null;
  name: string;
  tenant_key: string | null;
  oauth_status: 'mock' | 'authorized' | 'expired' | 'revoked' | 'unknown';
  granted_scopes_json: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

type InformationSourceStateRow = {
  source_kind: OwnerSourceKind;
  enabled: number;
  status: OwnerSourceStatus;
  scope_summary: string;
  requires_admin: number;
  requires_bot_in_chat: number;
  sync_mode: 'realtime' | 'periodic' | 'manual' | 'mixed';
  last_success_at: string | null;
  last_error: string | null;
  details_json: string;
  updated_at: string;
};

type FeishuMonitorTargetRow = {
  id: string;
  owner_open_id: string;
  target_kind: 'person' | 'group';
  target_key: string;
  resolved_chat_id: string | null;
  display_name: string;
  secondary_label: string | null;
  enabled: number;
  manual_excluded: number;
  discovery_rank: number | null;
  selection_version: number;
  read_policy: 'incoming_only' | 'owner_mentions';
  selection_source: 'chat_list' | 'contact_search';
  access_status: 'unknown' | 'readable' | 'restricted' | 'not_found' | 'error';
  last_discovered_at: string | null;
  last_resolved_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type SourceEventRow = {
  id: string;
  external_id: string;
  source_type: NormalizedSourceEvent['sourceType'];
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  owner_mentioned: number;
  source_url: string | null;
  completeness: NonNullable<NormalizedSourceEvent['completeness']>;
  discovery_reason: string;
  metadata_json: string;
  occurred_at: string;
  captured_at: string;
  owner_scope: string;
  revision_generation: number;
  current_revision_id: string | null;
};

const nowIso = () => new Date().toISOString();
const id = (prefix: string) => prefix + '_' + randomUUID();

type DraftOnlyState = 'draft' | 'rejected' | 'obsolete';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function draftOnlyApprovalState(status: unknown): DraftOnlyState {
  if (status === 'awaiting_approval') return 'draft';
  if (status === 'rejected') return 'rejected';
  return 'obsolete';
}

function draftOnlyOutboxState(status: unknown): DraftOnlyState {
  return status === 'awaiting_approval' ? 'draft' : 'obsolete';
}

function safeDraftActionType(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/u.test(value) ? value : 'redacted_action';
}

function approvalDraftDto(row: Record<string, unknown>) {
  const status = row.status === 'awaiting_approval'
    ? 'awaiting_approval'
    : row.status === 'rejected'
      ? 'rejected'
      : 'obsolete';
  return {
    id: typeof row.id === 'string' ? row.id : 'redacted_approval',
    action_type: safeDraftActionType(row.action_type),
    status,
    state: draftOnlyApprovalState(row.status),
    created_at: typeof row.created_at === 'string' ? row.created_at : null,
    decided_at: typeof row.decided_at === 'string' ? row.decided_at : null,
    externally_sent: false,
  };
}

function outboxDraftDto(row: Record<string, unknown>) {
  return {
    id: typeof row.id === 'string' ? row.id : 'redacted_outbox',
    approval_id: typeof row.approval_id === 'string' ? row.approval_id : 'redacted_approval',
    action_type: safeDraftActionType(row.action_type),
    state: draftOnlyOutboxState(row.status),
    created_at: typeof row.created_at === 'string' ? row.created_at : null,
    externally_sent: false,
  };
}
const maxFeishuMonitorPeople = 5000;
const maxFeishuPeoplePerRun = 50;
const maxFeishuMonitorGroups = 50;

function objectValue(value: unknown) {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function firstText(value: unknown, ...keys: string[]) {
  const record = objectValue(value);
  for (const key of keys) {
    const item = record[key];
    if ((typeof item === 'string' || typeof item === 'number') && String(item).trim()) return String(item).trim();
  }
  return '';
}

function monitorTargetView(row: FeishuMonitorTargetRow): FeishuMonitorTarget {
  return {
    id: row.id,
    kind: row.target_kind,
    name: row.display_name,
    secondaryLabel: row.secondary_label,
    selected: Boolean(row.enabled),
    readPolicy: row.read_policy,
    accessStatus: row.access_status,
    lastDiscoveredAt: row.last_discovered_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
  };
}

function parseMetadata(value: string | null | undefined) {
  return parseJsonValue<Record<string, unknown>>(value, {});
}

const DERIVED_SOURCE_METADATA_KEYS = new Set([
  'classificationRevision',
  'classificationBatchSourceIds',
  'messageAction',
  'failure_inbox',
  'calendarClassification',
  'internalRequirementThreadId',
]);

function sourceRevisionMetadataJson(value: string | null | undefined) {
  const metadata = parseMetadata(value);
  return stableJson(Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !DERIVED_SOURCE_METADATA_KEYS.has(key)),
  ));
}

function stripExternalFailureInbox(metadata: Record<string, unknown>) {
  const { failure_inbox: _externalFailureInbox, ...safeMetadata } = metadata;
  return safeMetadata;
}

type SourceDedupeIdentity = {
  ownerScope: string;
  sourceScope: string | null;
  sourceType: NormalizedSourceEvent['sourceType'];
  conversationId: string;
};

function sourceDedupeIdentityOfEvent(event: NormalizedSourceEvent): SourceDedupeIdentity {
  const metadata = event.metadata ?? {};
  const ownerScope = typeof metadata.ownerScope === 'string' && metadata.ownerScope.trim()
    ? metadata.ownerScope.trim()
    : DATA04_OWNER_SCOPE;
  const sourceScope = typeof metadata.sourceScope === 'string' && metadata.sourceScope.trim()
    ? metadata.sourceScope.trim()
    : null;
  return {
    ownerScope,
    sourceScope,
    sourceType: event.sourceType,
    conversationId: event.conversationId,
  };
}

function sourceDedupeIdentityOfRow(row: SourceEventRow): SourceDedupeIdentity {
  const metadata = parseMetadata(row.metadata_json);
  const sourceScope = typeof metadata.sourceScope === 'string' && metadata.sourceScope.trim()
    ? metadata.sourceScope.trim()
    : null;
  return {
    ownerScope: row.owner_scope,
    sourceScope,
    sourceType: row.source_type,
    conversationId: row.conversation_id,
  };
}

function sourceDedupeIdentityMatches(left: SourceDedupeIdentity, right: SourceDedupeIdentity) {
  return left.ownerScope === right.ownerScope
    && left.sourceScope === right.sourceScope
    && left.sourceType === right.sourceType
    && left.conversationId === right.conversationId;
}

const checkpointEvidenceBasisSchema = z.enum(['fact', 'document', 'inferred', 'unknown']);
const checkpointTaskStatusSchema = z.enum(['unplanned', 'planned', 'in_progress', 'waiting', 'review', 'completed', 'archived']);
const checkpointRiskSchema = z.enum(['low', 'medium', 'high']);
const checkpointCalendarClassificationSchema = z.object({
  route: z.enum(['calendar_fact', 'candidate_review', 'owner_confirmation']),
  sourceRetained: z.literal(true),
  candidateCreated: z.boolean(),
  requiresOwnerConfirmation: z.boolean(),
  explanationCode: z.string().regex(/^[a-z0-9_:-]{1,160}$/u),
  evidenceFields: z.object({
    ownerResponsibility: z.string().max(240).optional(),
    action: z.string().max(240).optional(),
    deliverableOrDeadline: z.string().max(240).optional(),
    sourceReference: z.string().regex(/^sha256:[0-9a-f]{16}$/u),
    missingSignalCode: z.string().regex(/^[a-z0-9_:-]{1,160}$/u).optional(),
  }).strict(),
  correctionScope: z.literal('current_event_only'),
}).strict();
const checkpointOwnerIntentSchema = z.object({
  action: z.enum(['continue', 'confirm_schedule', 'request_context', 'decline', 'delegate', 'uncertain']),
  confidence: z.number().finite().min(0).max(1),
  summary: z.string().max(500),
  delegateTo: z.string().max(160).nullable(),
  scheduleText: z.string().max(200).nullable(),
  evidence: z.array(z.string().max(300)).max(10),
  reason: z.string().max(1_000),
}).strict();
const checkpointMessageActionSchema = z.object({
  action: z.enum(['new_demand', 'update_existing', 'context_only', 'owner_action', 'decline_or_delegate', 'uncertain']),
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(z.string().max(300)).max(10),
  reason: z.string().max(1_000),
}).strict();
const checkpointThreadAssociationSchema = z.object({
  targetThreadId: z.string().max(200).nullable(),
  targetTaskId: z.string().max(200).nullable(),
  confidence: z.number().finite().min(0).max(1).nullable(),
  scores: z.array(z.object({ threadId: z.string().max(200), taskId: z.string().max(200), confidence: z.number().finite().min(0).max(1) }).strict()).max(16),
  reason: z.string().max(1_000),
  evidence: z.array(z.string().max(300)).max(10),
  candidateSetHash: z.string().regex(/^[a-f0-9]{64}$/u),
  candidateSetComplete: z.boolean(),
}).strict();
const checkpointCandidateMergeSchema = z.object({
  targetCandidateId: z.string().max(200).nullable(),
  targetThreadId: z.string().max(200).nullable(),
  sameRequirement: z.boolean(),
  confidence: z.number().finite().min(0).max(1).nullable(),
  scores: z.array(z.object({ candidateId: z.string().max(200), threadId: z.string().max(200), confidence: z.number().finite().min(0).max(1) }).strict()).max(16),
  primary: z.enum(['current', 'target']).nullable(),
  primaryConfidence: z.number().finite().min(0).max(1).nullable(),
  currentRole: z.enum(['owner_delivery', 'background', 'constraint', 'process_question', 'unknown']).nullable(),
  targetRole: z.enum(['owner_delivery', 'background', 'constraint', 'process_question', 'unknown']).nullable(),
  reason: z.string().max(1_000),
  evidence: z.array(z.string().max(300)).max(10),
  candidateSetHash: z.string().regex(/^[a-f0-9]{64}$/u),
  candidateSetComplete: z.boolean(),
}).strict();
const checkpointNarrativeFieldSchema = z.object({
  value: z.string().max(2_000),
  mode: z.enum(['append', 'replace']),
  basis: checkpointEvidenceBasisSchema,
  confidence: z.number().finite().min(0).max(1),
}).strict();
const checkpointNarrativeUpdatesSchema = z.object({
  taskTitle: checkpointNarrativeFieldSchema.nullable().optional(),
  taskDescribe: checkpointNarrativeFieldSchema.nullable().optional(),
  threadTitle: checkpointNarrativeFieldSchema.nullable().optional(),
  threadBackground: checkpointNarrativeFieldSchema.nullable().optional(),
  threadValidationQuestion: checkpointNarrativeFieldSchema.nullable().optional(),
  threadDescribe: checkpointNarrativeFieldSchema.nullable().optional(),
}).strict();
const checkpointTimeRangeSchema = z.object({
  status: z.enum(['explicit', 'relative_resolved', 'inferred', 'unknown']),
  sourceText: z.string().max(200).nullable(),
  startAt: z.string().max(80).nullable(),
  endAt: z.string().max(80).nullable(),
  timezone: z.literal('Asia/Shanghai'),
  needsConfirmation: z.boolean(),
  semantic: z.enum(['deadline', 'start', 'window', 'reference', 'unknown']).optional(),
}).strict();
const checkpointAnalysisSchema = z.object({
  timeRange: checkpointTimeRangeSchema,
  fieldBasis: z.object({
    background: checkpointEvidenceBasisSchema,
    validationQuestion: checkpointEvidenceBasisSchema,
    describe: checkpointEvidenceBasisSchema,
  }).strict(),
  recognitionEvidence: z.array(z.string().max(300)).max(10),
  calendarClassification: checkpointCalendarClassificationSchema.nullable().optional(),
  ownerAction: z.object({
    required: z.boolean(),
    summary: z.string().max(300),
    role: z.enum(['analyze', 'coordinate', 'review', 'follow_up', 'unknown']),
    basis: checkpointEvidenceBasisSchema,
    confidence: z.number().finite().min(0).max(1),
  }).strict().nullable().optional(),
  ownerIntent: checkpointOwnerIntentSchema.nullable().optional(),
  prioritySuggestion: checkpointRiskSchema.nullable().optional(),
  note: z.string().max(1_000).nullable().optional(),
  statusSuggestion: checkpointTaskStatusSchema.nullable().optional(),
  nextStepSuggestion: z.string().max(1_000).nullable().optional(),
  waitingReasonSuggestion: z.string().max(1_000).nullable().optional(),
  updateConfidence: z.number().finite().min(0).max(1).nullable().optional(),
  narrativeUpdates: checkpointNarrativeUpdatesSchema.optional(),
  threadAssociation: checkpointThreadAssociationSchema.nullable().optional(),
  candidateMerge: checkpointCandidateMergeSchema.nullable().optional(),
}).strict();
const checkpointDraftSchema = z.object({
  title: z.string().max(160),
  proposerName: z.string().max(160),
  background: z.string().max(2_000),
  validationQuestion: z.string().max(1_000),
  describe: z.string().max(2_000),
  confidence: z.number().finite().min(0).max(1),
  analysis: checkpointAnalysisSchema.optional(),
}).strict();
const checkpointRetrySchema = z.object({
  category: z.enum(['rate_limit', 'server_error', 'transport', 'non_retryable']),
  providerKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u),
  cooldownKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u),
  retryable: z.boolean(),
  retryAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u).nullable(),
  retryAfterMs: z.number().int().nonnegative().max(3_600_000).nullable(),
  status: z.number().int().min(0).max(999).nullable(),
  code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u).nullable(),
}).strict();
const checkpointClassificationSchema = z.object({
  outcome: z.enum(['valid', 'repaired', 'rule_final', 'rule_provisional', 'recoverable_error']).optional(),
  deferred: z.object({
    kind: z.literal('association'),
    code: z.literal('association_unavailable'),
    retryable: z.boolean(),
  }).strict().optional(),
  isDataRequest: z.boolean(),
  draft: checkpointDraftSchema.nullable(),
  reason: z.string().max(1_000),
  relatedTaskHint: z.string().max(500).nullable(),
  messageAction: checkpointMessageActionSchema.nullable().optional(),
  semanticAnalysis: checkpointAnalysisSchema.nullable().optional(),
  ownerIntent: checkpointOwnerIntentSchema.nullable().optional(),
  ownerIntents: z.array(checkpointOwnerIntentSchema).max(4).optional(),
  threadAssociation: checkpointThreadAssociationSchema.nullable().optional(),
  candidateMerge: checkpointCandidateMergeSchema.nullable().optional(),
  units: z.array(z.object({
    unitKey: z.string().regex(/^u[1-8]$/u),
    sourceKeys: z.array(z.string().regex(/^s[1-9]\d*$/u)).min(1).max(32),
    isDataRequest: z.boolean(),
    draft: checkpointDraftSchema.nullable(),
    reason: z.string().max(1_000),
  }).strict()).max(8).optional(),
  importantDates: z.array(z.string().max(200)).max(20),
  deliverables: z.array(z.string().max(300)).max(20),
  commitments: z.array(z.string().max(300)).max(20),
  usedFallback: z.boolean(),
  errorCode: z.string().max(160).optional(),
  metadata: z.object({
    httpStatus: z.number().int().optional(),
    requestId: z.string().max(200).optional(),
    attempts: z.number().int().nonnegative().optional(),
    structuredMode: z.enum(['json_schema', 'json_object', 'none']).optional(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    inputCharCount: z.number().int().nonnegative().optional(),
    fallbackMode: z.enum(['llm', 'rule_fallback', 'rule_mock']).optional(),
    calendarClassification: checkpointCalendarClassificationSchema.optional(),
    repairAttempts: z.number().int().nonnegative().optional(),
    initialErrorCode: z.string().max(160).optional(),
    validationIssues: z.array(z.object({ path: z.string().max(200), code: z.string().max(100) }).strict()).max(32).optional(),
    retry: checkpointRetrySchema.optional(),
  }).strict().optional(),
}).strict();

function parseClassificationCheckpoint(value: unknown): ClassificationResult | null {
  const parsed = checkpointClassificationSchema.safeParse(value);
  if (!parsed.success) return null;
  if (!['valid', 'repaired', 'rule_final'].includes(parsed.data.outcome ?? '') || parsed.data.deferred) return null;
  return parsed.data as ClassificationResult;
}

const classificationCheckpointStateSchema = z.object({
  sourceEventIds: z.array(z.string().min(1).max(200)).min(1).max(32),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  reusable: z.literal(true),
  classification: z.unknown(),
}).strict();

function parseReusableClassificationCheckpoint(value: unknown, sourceEventIds: string[], revision: string) {
  const parsed = classificationCheckpointStateSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.revision !== revision || parsed.data.sourceEventIds.length !== sourceEventIds.length
    || !sourceEventIds.every((id) => parsed.data.sourceEventIds.includes(id))) return null;
  const classification = parseClassificationCheckpoint(parsed.data.classification);
  return classification;
}

const reprocessCheckpointStateSchema = z.object({
  candidateId: z.string().min(1).max(200),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  reusable: z.literal(true),
  classification: z.unknown(),
}).strict();

function parseReusableReprocessCheckpoint(value: unknown, candidateId: string, revision: string) {
  const parsed = reprocessCheckpointStateSchema.safeParse(value);
  if (!parsed.success || parsed.data.candidateId !== candidateId || parsed.data.revision !== revision) return null;
  return parseClassificationCheckpoint(parsed.data.classification);
}

const contextCheckpointIdentitySchema = z.object({
  sourceEventIds: z.array(z.string().min(1).max(200)).min(1).max(32),
  contextCount: z.number().int().nonnegative().max(256),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

type ContextCheckpointIdentity = z.infer<typeof contextCheckpointIdentitySchema>;

function matchesContextCheckpointIdentity(actual: ContextCheckpointIdentity, expected: ContextCheckpointIdentity) {
  return actual.sourceEventIds.length === expected.sourceEventIds.length
    && expected.sourceEventIds.every((id) => actual.sourceEventIds.includes(id))
    && actual.sourceRevision === expected.sourceRevision
    && actual.contextFingerprint === expected.contextFingerprint
    && actual.contextCount === expected.contextCount;
}

const documentContextCheckpointSchema = contextCheckpointIdentitySchema.extend({
  continuationRevision: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

function matchesDocumentContextCheckpoint(
  value: unknown,
  expected: { sourceEventIds: string[]; sourceRevision: string; contextFingerprint: string; continuationRevision: string; contextCount: number },
) {
  const parsed = documentContextCheckpointSchema.safeParse(value);
  return parsed.success && matchesContextCheckpointIdentity(parsed.data, expected) && parsed.data.continuationRevision === expected.continuationRevision;
}

const reprocessContextCheckpointSchema = contextCheckpointIdentitySchema.extend({
  candidateId: z.string().min(1).max(200),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

function matchesReprocessContextCheckpoint(value: unknown, expected: {
  candidateId: string;
  sourceEventIds: string[];
  sourceRevision: string;
  contextFingerprint: string;
  revision: string;
  contextCount: number;
}) {
  const parsed = reprocessContextCheckpointSchema.safeParse(value);
  return parsed.success
    && matchesContextCheckpointIdentity(parsed.data, {
      sourceEventIds: expected.sourceEventIds,
      sourceRevision: expected.sourceRevision,
      contextFingerprint: expected.contextFingerprint,
      contextCount: expected.contextCount,
    })
    && parsed.data.candidateId === expected.candidateId
    && parsed.data.revision === expected.revision;
}

function parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
  try {
    return JSON.parse(value || '') as T;
  } catch {
    return fallback;
  }
}

function parseTaskUpdateSnapshot(value: string): TaskUpdateProposalSnapshot {
  const result = taskUpdateProposalSnapshotSchema.safeParse(parseJsonValue<unknown>(value, null));
  if (!result.success) throw new Error(INVALID_TASK_UPDATE_SNAPSHOT_ERROR);
  return result.data;
}

function parseTaskUpdatePatch(value: string): TaskPatch {
  const parsed = parseJsonValue<unknown>(value, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('任务更新提案格式损坏，无法应用。');
  const record = parsed as Record<string, unknown>;
  const allowed = new Set([
    'title', 'describe', 'status', 'plannedStartAt', 'plannedDueAt', 'nextStep', 'risk', 'waitingReason',
    'threadTitle', 'threadBackground', 'threadValidationQuestion', 'threadDescribe', 'note',
  ]);
  const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknownKeys.length) throw new Error(`任务更新提案包含不支持的字段：${unknownKeys.join('、')}。`);
  const optionalString = (key: string, maxLength: number) => {
    const item = record[key];
    if (item === undefined) return undefined;
    if (typeof item !== 'string') throw new Error(`任务更新提案字段 ${key} 格式不正确。`);
    if (item.length > maxLength) throw new Error(`任务更新提案字段 ${key} 超过 ${maxLength} 字符上限。`);
    return item;
  };
  const optionalNullableString = (key: string, maxLength: number) => {
    const item = record[key];
    if (item === undefined) return undefined;
    if (item !== null && typeof item !== 'string') throw new Error(`任务更新提案字段 ${key} 格式不正确。`);
    if (typeof item === 'string' && item.length > maxLength) throw new Error(`任务更新提案字段 ${key} 超过 ${maxLength} 字符上限。`);
    return item as string | null;
  };
  const risk = record.risk;
  if (risk !== undefined && risk !== 'low' && risk !== 'medium' && risk !== 'high') throw new Error('任务更新提案的风险等级格式不正确。');
  const status = record.status;
  if (status !== undefined && !['unplanned', 'planned', 'in_progress', 'waiting', 'review', 'completed', 'archived'].includes(String(status))) {
    throw new Error('任务更新提案的任务状态格式不正确。');
  }
  return {
    title: optionalString('title', 160),
    describe: optionalString('describe', 2_000),
    status: status as TaskStatus | undefined,
    plannedStartAt: optionalNullableString('plannedStartAt', 80),
    plannedDueAt: optionalNullableString('plannedDueAt', 80),
    nextStep: optionalString('nextStep', 1_000),
    risk: risk as RiskLevel | undefined,
    waitingReason: optionalNullableString('waitingReason', 1_000),
    threadTitle: optionalString('threadTitle', 160),
    threadBackground: optionalString('threadBackground', 2_000),
    threadValidationQuestion: optionalString('threadValidationQuestion', 1_000),
    threadDescribe: optionalString('threadDescribe', 2_000),
    note: optionalString('note', 1_000),
  };
}

function metadataText(metadata: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function minimalCandidateAnalysis(value: unknown, sourceContent: readonly string[]) {
  const input = objectValue(value);
  const timeRange = objectValue(input.timeRange);
  const fieldBasis = objectValue(input.fieldBasis);
  const safeIso = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  const safeSummary = (value: unknown, fallback: string, maxLength: number) => safeCandidateNarrative(value, sourceContent, fallback, maxLength);
  const safeEnum = (value: unknown, allowed: readonly string[], fallback: string) => typeof value === 'string' && allowed.includes(value) ? value : fallback;
  const ownerAction = objectValue(input.ownerAction);
  const linkedDocuments = Array.isArray(input.linkedDocuments)
    ? input.linkedDocuments.map((item) => {
        const row = objectValue(item);
        return {
          documentType: safeEnum(row.documentType, ['docx', 'wiki', 'sheet', 'bitable', 'doc', 'file', 'slides', 'unknown'], 'unknown'),
          status: safeEnum(row.status, ['ready', 'partial', 'unauthorized', 'unsupported', 'not_found', 'error', 'unknown'], 'unknown'),
          freshness: safeEnum(row.freshness, ['fresh', 'stale', 'unknown'], 'stale'),
          completeness: safeEnum(row.completeness, ['complete', 'partial', 'limited', 'unknown'], 'limited'),
          truncated: row.truncated === true,
        };
      }).slice(0, 8)
    : [];
  return {
    timeRange: {
      status: safeEnum(timeRange.status, ['unknown', 'relative_resolved', 'inferred', 'explicit'], 'unknown'),
      // The normalized range is useful to the owner; the model's source
      // phrase is not. It remains available only through explicit source
      // verification.
      sourceText: null,
      startAt: safeIso(timeRange.startAt),
      endAt: safeIso(timeRange.endAt),
      timezone: 'Asia/Shanghai' as const,
      needsConfirmation: timeRange.needsConfirmation === true,
    },
    fieldBasis: {
      background: safeEnum(fieldBasis.background, ['fact', 'document', 'inferred', 'unknown'], 'unknown'),
      validationQuestion: safeEnum(fieldBasis.validationQuestion, ['fact', 'document', 'inferred', 'unknown'], 'unknown'),
      describe: safeEnum(fieldBasis.describe, ['fact', 'document', 'inferred', 'unknown'], 'unknown'),
    },
    recognitionEvidence: Array.isArray(input.recognitionEvidence)
      ? input.recognitionEvidence
        .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
        .map((item) => safeSummary(item, '来源识别依据已保留，需主人核验。', 300))
        .slice(0, 8)
      : [],
    ownerAction: ownerAction.required === true ? {
      required: true,
      summary: safeSummary(ownerAction.summary, '主人需要推进一项受控动作。', 300),
      role: safeEnum(ownerAction.role, ['analyze', 'confirm', 'review', 'clarify', 'unknown'], 'unknown'),
      basis: safeEnum(ownerAction.basis, ['fact', 'document', 'inferred', 'unknown'], 'unknown'),
      confidence: typeof ownerAction.confidence === 'number' && Number.isFinite(ownerAction.confidence) ? ownerAction.confidence : 0,
    } : null,
    prioritySuggestion: typeof input.prioritySuggestion === 'string' && ['low', 'medium', 'high'].includes(input.prioritySuggestion)
      ? input.prioritySuggestion
      : null,
    note: input.note === null || input.note === undefined ? null : safeSummary(input.note, '来源备注已保留，需主人核验。', 500),
    linkedDocuments,
    statusSuggestion: typeof input.statusSuggestion === 'string' && ['unplanned', 'planned', 'in_progress', 'waiting', 'review', 'completed', 'archived'].includes(input.statusSuggestion)
      ? input.statusSuggestion
      : null,
    nextStepSuggestion: input.nextStepSuggestion === null || input.nextStepSuggestion === undefined
      ? null
      : safeSummary(input.nextStepSuggestion, '下一步建议已保留，需主人核验。', 1_000),
    waitingReasonSuggestion: input.waitingReasonSuggestion === null || input.waitingReasonSuggestion === undefined
      ? null
      : safeSummary(input.waitingReasonSuggestion, '等待原因已保留，需主人核验。', 1_000),
    updateConfidence: typeof input.updateConfidence === 'number' && Number.isFinite(input.updateConfidence) ? input.updateConfidence : null,
  };
}

const SAFE_NARRATIVE_SOURCE_LIMIT = 8_000;
const SAFE_NARRATIVE_MIN_COPY_LENGTH = 8;
const SAFE_NARRATIVE_MIN_PREFIX_COPY_LENGTH = 16;
const SAFE_NARRATIVE_MIN_COPY_RATIO = 0.68;
const SAFE_NARRATIVE_MIN_SIMILARITY = 0.88;
const SAFE_NARRATIVE_MAX_SIMILARITY_LENGTH = 512;
const SAFE_NARRATIVE_REDACTION_MARKER = '（受控来源信息已隐藏）';

function safeNarrativeCanonical(input: string) {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{White_Space}\p{P}\p{S}]+/gu, '');
}

function hasSafeNarrativeCommonRun(source: string, candidate: string, minimumLength: number) {
  if (minimumLength <= 0 || source.length < minimumLength || candidate.length < minimumLength) return false;
  const sourceWindows = new Set<string>();
  for (let index = 0; index <= source.length - minimumLength; index += 1) {
    sourceWindows.add(source.slice(index, index + minimumLength));
  }
  for (let index = 0; index <= candidate.length - minimumLength; index += 1) {
    if (sourceWindows.has(candidate.slice(index, index + minimumLength))) return true;
  }
  return false;
}

function narrativeEditSimilarity(source: string, candidate: string) {
  if (source === candidate) return 1;
  if (source.length < SAFE_NARRATIVE_MIN_COPY_LENGTH || candidate.length < SAFE_NARRATIVE_MIN_COPY_LENGTH) return 0;
  const maxLength = Math.max(source.length, candidate.length);
  if (maxLength > SAFE_NARRATIVE_MAX_SIMILARITY_LENGTH) return 0;
  const maxDistance = Math.floor(maxLength * (1 - SAFE_NARRATIVE_MIN_SIMILARITY));
  let previous = Array.from({ length: candidate.length + 1 }, (_, index) => index);
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    const current = [sourceIndex];
    let rowMinimum = sourceIndex;
    for (let candidateIndex = 1; candidateIndex <= candidate.length; candidateIndex += 1) {
      const value = Math.min(
        (previous[candidateIndex] ?? Number.POSITIVE_INFINITY) + 1,
        (current[candidateIndex - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[candidateIndex - 1] ?? Number.POSITIVE_INFINITY) + (source[sourceIndex - 1] === candidate[candidateIndex - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maxDistance && sourceIndex > maxDistance) return 0;
    previous = current;
  }
  return 1 - (previous[candidate.length] ?? maxLength) / maxLength;
}

function redactSafeNarrativeStructuredTokens(text: string) {
  let redacted = false;
  let output = text;
  const patterns = [
    /\b(?:https?|workspace|file):\/\/[^\s<>"']+/giu,
    /\b(?:authorization|bearer|password|passwd|secret|token|credential|api[\s_-]*key|private[\s_-]*key)\b\s*[:=]\s*\S+/giu,
    /\b(?:ou|on|oc|om|od|os|ot|ov|ow)_[A-Za-z0-9_-]{4,}\b/giu,
    /\b(?:doxcn|boxcn|wikcn|shtcn|bascn|fldcn|sccn|douc)[A-Za-z0-9_-]{4,}\b/giu,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
    /\b(?:src_scope|candidate|cand|task|thread|evt|event|ai|owner-decision|proposal|revision|snapshot|reference)[_-][A-Za-z0-9_-]{3,}\b/giu,
    /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|workspace|var|tmp|opt|mnt)[\\/])[^\s<>"']+/giu,
  ];
  for (const pattern of patterns) {
    output = output.replace(pattern, () => {
      redacted = true;
      return SAFE_NARRATIVE_REDACTION_MARKER;
    });
  }
  return { text: output, redacted };
}

function hasSafeNarrativeIdLikeToken(text: string) {
  if (
    /\b(?:canary|synthetic|raw[_-]?error|owner[_-]?error|secret|token|credential|password|api[_-]?key)[_-][A-Za-z0-9_-]{3,}\b/iu.test(text)
  ) return true;

  // Run the opaque-token check on the NFKC/compact form as well so a canary
  // split by whitespace or punctuation (for example `ZX 7 K9`) cannot pass
  // merely because its pieces are each short.
  const tokens = [
    ...(text.match(/\b[A-Za-z0-9][A-Za-z0-9_-]{4,}\b/g) ?? []),
    ...(safeNarrativeCanonical(text).match(/[A-Za-z][A-Za-z0-9_-]{4,}/gu) ?? []),
  ];
  return tokens.some((token) => {
    const compact = token.replace(/[_-]/gu, '');
    const digits = (compact.match(/[0-9]/gu) ?? []).length;
    const letters = (compact.match(/[A-Za-z]/gu) ?? []).length;
    // Two or more digits in an opaque mixed token (ZX7K9, zx7k9, ...)
    // are a bounded canary/identifier signal.  Ordinary prose such as
    // "retention" or "version2" is not treated as sensitive.
    return letters > 0 && digits >= 2;
  });
}

function safeCandidateNarrative(value: unknown, sourceContent: string | readonly string[], fallback: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim()) return value === '' ? '' : fallback;
  const structured = redactSafeNarrativeStructuredTokens(value.trim().slice(0, maxLength).trim());
  if (structured.redacted) return fallback;
  const text = structured.text;
  if (!text) return fallback;
  const candidateCanonical = safeNarrativeCanonical(text);
  if (!candidateCanonical) return fallback;
  if (hasSafeNarrativeIdLikeToken(text)) return fallback;

  const sources = Array.isArray(sourceContent) ? sourceContent : [sourceContent];
  for (const source of sources) {
    const boundedSource = String(source).slice(0, SAFE_NARRATIVE_SOURCE_LIMIT);
    const sourceCanonical = safeNarrativeCanonical(boundedSource);
    if (!sourceCanonical) continue;

    // A summary may replace a source URL/token with a safe placeholder while
    // retaining a long verbatim prefix. Treat that prefix as an excerpt too;
    // comparing only the fully redacted strings would miss this boundary.
    const redactedSource = redactSafeNarrativeStructuredTokens(boundedSource).text;
    const sourceBeforeRedaction = redactedSource.split(SAFE_NARRATIVE_REDACTION_MARKER, 1)[0] ?? '';
    const sourcePrefixCanonical = safeNarrativeCanonical(sourceBeforeRedaction);
    if (sourcePrefixCanonical.length >= SAFE_NARRATIVE_MIN_PREFIX_COPY_LENGTH
      && candidateCanonical.startsWith(sourcePrefixCanonical)) return fallback;

    // Combining marks are retained only for this narrowly scoped NFKC canary
    // check.  This catches e + combining acute being re-emitted as a source
    // marker without rejecting ordinary unaccented English summaries.
    if (/\p{M}/u.test(text)) {
      const sourceMarkers = new Set(Array.from(sourceCanonical).filter((character) => !/\p{ASCII}/u.test(character) && /\p{Script=Latin}/u.test(character)));
      if (Array.from(candidateCanonical).some((character) => sourceMarkers.has(character))) return fallback;
    }

    const shorterLength = Math.min(sourceCanonical.length, candidateCanonical.length);
    const longerLength = Math.max(sourceCanonical.length, candidateCanonical.length);
    if (shorterLength < SAFE_NARRATIVE_MIN_COPY_LENGTH) continue;
    if (sourceCanonical === candidateCanonical) return fallback;

    const coverage = shorterLength / longerLength;
    // A bounded source prefix/suffix of meaningful length is a raw excerpt
    // even when the candidate continues with a derived clause.  Keep this
    // separate from the similarity/overlap heuristics so ordinary shared
    // business vocabulary is not treated as leakage.
    const boundedExcerpt = shorterLength >= SAFE_NARRATIVE_MIN_PREFIX_COPY_LENGTH
      && (sourceCanonical.startsWith(candidateCanonical) || sourceCanonical.endsWith(candidateCanonical));
    const highCoverageCopy = coverage >= SAFE_NARRATIVE_MIN_COPY_RATIO
      && (sourceCanonical.includes(candidateCanonical) || candidateCanonical.includes(sourceCanonical));
    const contiguousCopy = coverage >= SAFE_NARRATIVE_MIN_COPY_RATIO
      && hasSafeNarrativeCommonRun(sourceCanonical, candidateCanonical, Math.max(SAFE_NARRATIVE_MIN_COPY_LENGTH, Math.ceil(shorterLength * 0.82)));
    const editCopy = coverage >= SAFE_NARRATIVE_MIN_COPY_RATIO
      && narrativeEditSimilarity(sourceCanonical, candidateCanonical) >= SAFE_NARRATIVE_MIN_SIMILARITY;
    if (boundedExcerpt || highCoverageCopy || contiguousCopy || editCopy) return fallback;
  }
  return text;
}

function safePublicTimestamp(value: string | null | undefined) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function ownerSourceIssue(status: OwnerSourceStatus) {
  switch (status) {
    case 'unauthorized': return { code: 'authorization_required' as const, message: '需要系统主人重新授权后才能继续读取。' };
    case 'admin_required': return { code: 'admin_approval_required' as const, message: '需要飞书管理员批准对应权限。' };
    case 'unsupported': return { code: 'platform_unsupported' as const, message: '当前平台或租户暂不支持这项读取能力。' };
    case 'partial': return { code: 'partial_access' as const, message: '当前只能读取部分已授权范围。' };
    case 'error': return { code: 'sync_failed' as const, message: '最近同步失败；详细诊断已脱敏保留。' };
    default: return null;
  }
}

function ownerSourceScopeSummary(kind: OwnerSourceKind, status: OwnerSourceStatus) {
  if (status === 'mock_ready') return '安全模拟信息源。';
  if (status === 'ready') return '已授权信息源。';
  if (status === 'unauthorized') return '需要系统主人授权。';
  if (status === 'admin_required') return '需要管理员批准。';
  if (status === 'partial') return '信息源部分可用。';
  if (status === 'unsupported') return '当前平台不支持。';
  if (status === 'error') return '最近同步失败；详细诊断已脱敏保留。';
  return `${kind} 信息源状态已受控显示。`;
}

function publicMemoryProjectionError(value: string | null) {
  if (!value) return null;
  if (/符号链接|junction|reparse/i.test(value)) return '任务记忆路径包含符号链接或 junction，已拒绝访问。';
  if (/路径|目录|root|outside|越过|逃逸/i.test(value)) return '任务记忆路径未通过安全边界校验。';
  return '任务记忆投影失败；详细诊断已脱敏保留。';
}

function metadataTextArray(metadata: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = metadata[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => typeof item === 'string' || typeof item === 'number' ? String(item).trim() : '')
        .filter(Boolean);
    }
  }
  return [];
}

function threadMarkers(source: SourceEventRow) {
  const metadata = parseMetadata(source.metadata_json);
  return {
    threadId: metadataText(metadata, 'threadId', 'thread_id'),
    rootId: metadataText(metadata, 'rootId', 'root_id', 'replyRootId', 'reply_root_id'),
    parentId: metadataText(metadata, 'parentId', 'parent_id', 'replyToId', 'reply_to_id'),
    sessionId: metadataText(metadata, 'sessionId', 'session_id'),
  };
}

function threadParticipants(source: SourceEventRow) {
  const metadata = parseMetadata(source.metadata_json);
  return [...new Set([source.sender_id, ...metadataTextArray(metadata, 'participantIds', 'participant_ids')].filter(Boolean))];
}

function safeSlug(value: string) {
  const normalized = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || 'untitled-task';
}

function looksLikeFollowUp(content: string) {
  const normalized = content.trim();
  return /^(?:(?:再|另外|还有)?(?:补充|追加|接着|改成|调整为|再加|继续(?:说|补充|这个|这项|上面|前面))|(?:另外|还有|以及|同时|再者)[\s，,:：]|(?:关于|针对)(?:刚才|上面|前面|这个需求|这件事)|follow[ -]?up\b|update\b|continue\b|previous\b)/iu.test(normalized);
}

function explicitlyStartsNewDemand(content: string) {
  const normalized = content.trim();
  return /(?:^|[，。；;！？!?]\s*)(?:再提|新开|新建|另开|另外(?:还有)?|还有(?:一个|一项)|另一个|另一项|第二个|新的)(?:[^，。；;！？!?]{0,12})(?:需求|任务|分析|事情|问题)|(?:与|跟)前面(?:的)?(?:需求|任务|事情)?无关|单独(?:新建|开|做|分析)/iu.test(normalized);
}

/**
 * Natural conversation turns often omit words such as “补充”. These short
 * confirmations, schedule questions and material hand-offs are still strong
 * continuation signals when the same conversation has only one recent
 * requirement. An explicit “new/another demand” phrase always wins.
 */
function looksLikeConversationContinuation(content: string) {
  const normalized = content.trim();
  if (!normalized || explicitlyStartsNewDemand(normalized)) return false;
  if (looksLikeFollowUp(normalized)) return true;
  if (normalized.length > 160) return false;
  return /^(?:那|那就|然后|接下来|后面|先|等|这个|这项|这件事|该需求|该任务|可以|行|好的|好|没问题|收到|一会儿|稍后|晚点|明天|后天|本周|这周|下周|周[一二三四五六日天])/u.test(normalized)
    || /(?:什么时候(?:要|给|交付)|哪天(?:要|给|交付)|几号(?:要|给|交付)|能(?:不能|否)?[^。！？!?]{0,24}(?:给到|交付|完成)|可以[^。！？!?]{0,24}(?:给到|交付|完成)|策划案|需求文档|说明文档|资料在哪|文档在哪|发(?:我|你)|给(?:我|你)|收到后|对一下具体需求)/u.test(normalized);
}

function metadataVersion(metadata: Record<string, unknown>): number | string | null {
  const opaque = metadata.sourceVersion ?? metadata.version;
  if (opaque !== undefined && opaque !== null && opaque !== '') {
    if (typeof opaque === 'number' && Number.isFinite(opaque)) return opaque;
    return String(opaque);
  }
  const raw = metadata.sourceUpdatedAt ?? metadata.updateTime ?? metadata.updatedAt;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function incomingMetadataIsNewer(incoming: number | string | null, current: number | string | null) {
  if (incoming === null) return false;
  if (current === null) return true;
  if (typeof incoming === 'number' && typeof current === 'number') return incoming > current;
  // Hash/version tokens are opaque. Any change means the source has a new
  // revision; ordering them lexicographically would be misleading.
  return incoming !== current;
}

function sourceRevision(source: SourceEventRow) {
  return canonicalRevisionHash({
    ownerScope: source.owner_scope,
    sourceEventId: source.id,
    revisionNumber: 0,
    revisionKind: 'current',
    externalId: source.external_id,
    sourceType: source.source_type,
    conversationId: source.conversation_id,
    senderId: source.sender_id,
    senderName: source.sender_name,
    content: source.content,
    ownerMentioned: source.owner_mentioned,
    sourceUrl: source.source_url,
    completeness: source.completeness,
    discoveryReason: source.discovery_reason,
    metadataJson: sourceRevisionMetadataJson(source.metadata_json),
    occurredAt: source.occurred_at,
    capturedAt: source.captured_at,
  });
}

function combinedClassificationRevision(source: SourceEventRow, contexts: SourceDocumentContext[]) {
  const sourceHash = sourceRevision(source);
  const contextHash = sourceContextRevision(contexts);
  return {
    sourceHash,
    contextHash,
    revision: createHash('sha256').update(`${sourceHash}:${contextHash}`).digest('hex'),
  };
}

function candidateAnalysisJson(
  draftAnalysis: Omit<CandidateAnalysis, 'linkedDocuments' | 'sourceRevision' | 'contextRevision'> | undefined,
  contexts: SourceDocumentContext[],
  sourceHash: string,
  contextHash: string,
) {
  const analysis: CandidateAnalysis = {
    timeRange: draftAnalysis?.timeRange ?? { status: 'unknown', sourceText: null, startAt: null, endAt: null, timezone: 'Asia/Shanghai', needsConfirmation: true },
    fieldBasis: draftAnalysis?.fieldBasis ?? { background: 'unknown', validationQuestion: 'unknown', describe: 'unknown' },
    recognitionEvidence: draftAnalysis?.recognitionEvidence ?? [],
    ownerAction: draftAnalysis?.ownerAction ?? null,
    calendarClassification: draftAnalysis?.calendarClassification ?? null,
    ownerIntent: draftAnalysis?.ownerIntent ?? null,
    prioritySuggestion: draftAnalysis?.prioritySuggestion ?? null,
    note: draftAnalysis?.note?.trim() || null,
    statusSuggestion: draftAnalysis?.statusSuggestion ?? null,
    nextStepSuggestion: draftAnalysis?.nextStepSuggestion?.trim() || null,
    waitingReasonSuggestion: draftAnalysis?.waitingReasonSuggestion === undefined ? null : draftAnalysis.waitingReasonSuggestion,
    updateConfidence: draftAnalysis?.updateConfidence ?? null,
    narrativeUpdates: draftAnalysis?.narrativeUpdates ?? {},
    threadAssociation: draftAnalysis?.threadAssociation ?? null,
    candidateMerge: draftAnalysis?.candidateMerge ?? null,
    linkedDocuments: contexts.map((context) => ({
      sourceUrl: context.sourceUrl,
      documentId: context.documentId,
      documentType: context.documentType,
      title: context.title,
      sourceVersion: context.sourceVersion,
      status: context.status,
      freshness: context.freshness,
      completeness: context.completeness,
      truncated: context.truncated,
      lastError: context.lastError,
      lastSuccessAt: context.lastSuccessAt,
    })),
    sourceRevision: sourceHash,
    contextRevision: contextHash,
  };
  return JSON.stringify(analysis);
}

function candidateSnapshotRevision(candidate: CandidateRow, thread: RequirementThreadRow) {
  return createHash('sha256').update(JSON.stringify({
    candidateId: candidate.id,
    candidateUpdatedAt: candidate.updated_at,
    candidateState: candidate.state,
    candidateDeletedAt: candidate.deleted_at,
    candidateMergedInto: candidate.merged_into_candidate_id,
    threadId: thread.id,
    threadVersion: thread.version,
    threadStatus: thread.status,
    threadPrimarySourceEventId: thread.primary_source_event_id,
  })).digest('hex');
}

function candidateGroupVersionHash(candidates: Array<Pick<CandidateRow, 'id' | 'version' | 'updated_at'>>) {
  return createHash('sha256')
    .update(JSON.stringify([...candidates]
      .map((candidate) => ({ id: candidate.id, version: candidate.version, updatedAt: candidate.updated_at }))
      .sort((left, right) => left.id.localeCompare(right.id))))
    .digest('hex');
}

function candidatePairVersionHash(current: CandidateRow, target: CandidateRow) {
  return candidateGroupVersionHash([current, target]);
}

function isExplicitOwnerAuthFailure(error: unknown) {
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown; response?: { code?: unknown; status?: unknown; data?: { code?: unknown } } };
  const code = String(value?.status ?? value?.statusCode ?? value?.code ?? value?.response?.status ?? value?.response?.code ?? value?.response?.data?.code ?? '');
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /401|9999166[34]|invalid.?token|token.*expired|授权已失效|revok|撤销/i.test(`${code} ${message}`);
}

function createManualCandidate(content: string, proposerName: string, occurredAt: string) {
  const title = content.replace(/[，。！？\n]/g, ' ').trim().slice(0, 80) || '人工补录的数据需求';
  const describe = content.length > 180 ? content.slice(0, 177) + '…' : content;
  return {
    title,
    proposerName,
    background: content,
    validationQuestion: '人工补录后仍需由系统主人确认需求范围、交付形式和排期。',
    describe,
    confidence: 1,
    analysis: {
      timeRange: timeRangeFromSource(content, occurredAt),
      fieldBasis: { background: 'fact' as const, validationQuestion: 'inferred' as const, describe: 'fact' as const },
      recognitionEvidence: ['系统主人通过人工补录明确要求把这条内容记录为需求。'],
    },
  };
}

function taskAuditSnapshot(task: TaskRecord | null) {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    proposer_name: task.proposer_name,
    describe: task.describe,
    status: task.status,
    schedule_at: task.schedule_at,
    planned_start_at: task.planned_start_at,
    planned_due_at: task.planned_due_at,
    next_step: task.next_step,
    risk: task.risk,
    waiting_reason: task.waiting_reason,
    version: task.version,
    completed_at: task.completed_at,
    archived_at: task.archived_at,
    deleted_at: task.deleted_at,
    record_state: task.record_state,
    merged_into_task_id: task.merged_into_task_id,
    auto_update_paused: Boolean(task.auto_update_paused),
  };
}

function stableSourceOrder(left: SourceEventRow, right: SourceEventRow) {
  const leftTime = Date.parse(left.occurred_at);
  const rightTime = Date.parse(right.occurred_at);
  const byTime = (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
  return byTime || left.external_id.localeCompare(right.external_id);
}

function isMessageSource(source: SourceEventRow) {
  return source.source_type === 'owner_dm' || source.source_type === 'group' || source.source_type === 'bot_dm';
}

function explicitMessageKeys(source: SourceEventRow) {
  const markers = threadMarkers(source);
  return [...new Set([
    `message:${source.external_id}`,
    markers.rootId ? `message:${markers.rootId}` : null,
    markers.parentId ? `message:${markers.parentId}` : null,
    markers.sessionId ? `session:${markers.sessionId}` : null,
    markers.threadId ? `thread:${markers.threadId}` : null,
  ].filter((value): value is string => Boolean(value)))];
}

function combinedBatchClassificationRevision(
  sources: SourceEventRow[],
  contextsBySource: Map<string, SourceDocumentContext[]>,
) {
  const ordered = [...sources].sort(stableSourceOrder);
  const sourceEntries = ordered.map((source) => ({ id: source.id, revision: sourceRevision(source) }));
  const contextEntries = ordered.map((source) => ({ id: source.id, revision: sourceContextRevision(contextsBySource.get(source.id) ?? []) }));
  const sourceHash = createHash('sha256').update(JSON.stringify(sourceEntries)).digest('hex');
  const contextHash = createHash('sha256').update(JSON.stringify(contextEntries)).digest('hex');
  return {
    sourceHash,
    contextHash,
    revision: createHash('sha256').update(`${sourceHash}:${contextHash}`).digest('hex'),
  };
}

function guidanceRevision(guidance?: string) {
  return createHash('sha256').update(guidance?.slice(0, 2_000) ?? '').digest('hex').slice(0, 16);
}

function aggregateClassificationSource(sources: SourceEventRow[], primary: SourceEventRow, forcedThreadId?: string | null) {
  const ordered = [...sources].sort(stableSourceOrder);
  const latest = ordered[ordered.length - 1] ?? primary;
  const metadata = parseMetadata(primary.metadata_json);
  const activeSources = ordered.filter((source) => {
    const item = parseMetadata(source.metadata_json);
    return !Boolean(item.deleted || item.withdrawn || item.recalled);
  });
  // Ordering metadata is already carried by classificationSources.  Keep the
  // aggregate message free of synthetic ISO labels so neither the model nor a
  // deterministic parser can mistake an internal timestamp for user evidence.
  const content = ordered.map((source) => source.content).join('\n\n');
  return {
    ...primary,
    content,
    occurred_at: latest.occurred_at,
    metadata_json: JSON.stringify({
      ...metadata,
      deleted: activeSources.length === 0,
      classificationBatch: ordered.length > 1,
      classificationBatchSize: ordered.length,
      classificationBatchSourceIds: ordered.map((source) => source.id),
      ...(forcedThreadId ? { internalRequirementThreadId: forcedThreadId } : {}),
    }),
  } satisfies SourceEventRow;
}

function normalizeTaskRecord(task: TaskRecord | null | undefined): TaskRecord | null {
  if (!task) return null;
  return {
    ...task,
    planned_start_at: task.planned_start_at ?? null,
    planned_due_at: task.planned_due_at ?? task.schedule_at ?? null,
    deleted_at: task.deleted_at ?? null,
    auto_update_paused: Boolean(task.auto_update_paused),
  };
}

function threadAuditSnapshot(thread: RequirementThreadRow | null | undefined) {
  if (!thread) return null;
  return {
    id: thread.id,
    title: thread.title,
    background: thread.background,
    validation_question: thread.validation_question,
    describe: thread.describe,
    analysis_json: thread.analysis_json,
    status: thread.status,
    version: thread.version,
    last_activity_at: thread.last_activity_at,
  };
}

function candidateFullAuditSnapshot(candidate: CandidateRow | null | undefined) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    title: candidate.title,
    proposer_name: candidate.proposer_name,
    background: candidate.background,
    validation_question: candidate.validation_question,
    describe: candidate.describe,
    analysis_json: candidate.analysis_json,
    confidence: candidate.confidence,
    state: candidate.state,
  };
}

function candidateSnapshotsEqual(left: TaskUpdateProposalSnapshot['candidate'], right: ReturnType<typeof candidateFullAuditSnapshot>) {
  if (left === null || right === null) return left === right;
  return left.id === right.id
    && left.title === right.title
    && left.proposer_name === right.proposer_name
    && left.background === right.background
    && left.validation_question === right.validation_question
    && left.describe === right.describe
    && left.analysis_json === right.analysis_json
    && left.confidence === right.confidence
    && left.state === right.state;
}

function candidateRevisionPayloadMatchesSnapshot(
  revision: CandidateRevisionPayloadRow | null | undefined,
  snapshot: TaskUpdateProposalSnapshot['candidate'],
) {
  if (!revision || !snapshot) return false;
  return revision.candidate_id === snapshot.id
    && revision.title === snapshot.title
    && revision.proposer_name === snapshot.proposer_name
    && revision.background === snapshot.background
    && revision.validation_question === snapshot.validation_question
    && revision.describe === snapshot.describe
    && revision.analysis_json === snapshot.analysis_json
    && revision.confidence === snapshot.confidence;
}

function candidateAuditSnapshot(candidate: CandidateRow | null) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    source_event_id: candidate.source_event_id,
    proposer_name: candidate.proposer_name,
    describe: candidate.describe,
    state: candidate.state,
    accepted_task_id: candidate.accepted_task_id,
  };
}

export class PmService {
  private readonly runtime: PmRuntime;
  private readonly retryCoordinator: RetryCoordinator;

  constructor(
    private readonly database: AppDatabase,
    private readonly adapters: ServiceAdapters,
    private readonly config: AppConfig,
  ) {
    const retryCoordinator = new RetryCoordinator({ store: new SqliteRetryCooldownStore(database.raw) });
    this.retryCoordinator = retryCoordinator;
    this.runtime = new PmRuntime(database, { retryCoordinator });
    this.cleanupLogs(config.logging.retentionDays);
    this.cleanupAilySummaryInbox();
  }

  /**
   * Real-time bot events have a stricter boundary than polling: the source
   * row must be committed before the provider callback is allowed to return.
   * Semantic classification is scheduled only after that durable receipt.
   */

  /**
   * One staged classification can issue several provider turns, each with its
   * own retry budget. Keep the lease longer than that worst-case envelope so a
   * healthy worker does not lose ownership while the provider is still being
   * retried; the Runtime heartbeat extends it while a call is in flight.
   */

  /**
   * A final provider failure must fence other jobs for at least the durable
   * Runtime backoff window. The adapter's local retry delay is intentionally
   * short, but allowing a second job to pass after that delay would defeat
   * the shared cooldown contract.
   */

  /**
   * Validate the durable source/job relation before any recovery stage (and
   * therefore before provider cooldown checks or context writes). A tampered
   * or partial payload is terminally invalid, not a new retryable failure.
   */

  /**
   * Drain due, recoverable Runtime jobs once after process startup. The
   * durable job row remains the source of truth; a fresh lease owner fences
   * workers from a previous process and failed jobs keep their backoff.
   */

  /**
   * Recover the narrow crash window after a WebSocket source commit but
   * before the classification Runtime job was created. Only explicitly
   * tagged bot-supplement rows in the primary owner scope are eligible;
   * polling and manually entered sources are never swept by this path.
   */

  automationPolicy() {
    const row = this.database.raw.prepare("SELECT value_json, updated_at FROM app_setting WHERE key = 'automation.policy'").get() as { value_json: string; updated_at: string } | undefined;
    const value = parseMetadata(row?.value_json);
    const mode: AutomationMode = row ? value.mode === 'auto' ? 'auto' : 'suggest' : 'auto';
    return {
      mode,
      associationThreshold: AUTO_ASSOCIATION_CONFIDENCE,
      updateThreshold: AUTO_UPDATE_CONFIDENCE,
      policyVersion: AUTO_UPDATE_POLICY_VERSION,
      updatedAt: row?.updated_at ?? null,
    };
  }

  autoScanSettings() {
    const row = this.database.raw.prepare("SELECT value_json FROM app_setting WHERE key = 'auto_scan_enabled'").get() as { value_json: string } | undefined;
    const value = parseMetadata(row?.value_json);
    return { enabled: value.enabled === true };
  }

  updateAutoScanSettings(enabled: boolean) {
    const timestamp = nowIso();
    this.database.raw.prepare(
      `INSERT INTO app_setting (key, value_json, updated_at) VALUES ('auto_scan_enabled', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify({ enabled }), timestamp);
    return this.autoScanSettings();
  }

  intakeWindowCursor() {
    return this.ailyScanWindowCursor();
  }

  ailyScanWindowCursor() {
    const row = this.database.raw.prepare(
      "SELECT value_json FROM app_setting WHERE key = 'aily_scan_window_end'",
    ).get() as { value_json: string } | undefined;
    const legacyRow = row ? undefined : this.database.raw.prepare(
      "SELECT value_json FROM app_setting WHERE key = 'intake_window_end'",
    ).get() as { value_json: string } | undefined;
    const value = parseMetadata(row?.value_json ?? legacyRow?.value_json);
    const windowEnd = typeof value.window_end === 'string' && Number.isFinite(Date.parse(value.window_end))
      ? new Date(value.window_end).toISOString()
      : null;
    return { window_end: windowEnd };
  }

  claimIntakeWindow(): CindyIntakeWindow {
    return this.claimAilyScanWindow();
  }

  claimAilyScanWindow(): CindyIntakeWindow {
    return this.database.transaction(() => {
      const cursorEnd = this.ailyScanWindowCursor().window_end;
      const cursorMs = cursorEnd ? Date.parse(cursorEnd) : Number.NaN;
      const pendingRow = this.database.raw.prepare(
        "SELECT value_json FROM app_setting WHERE key = 'aily_scan_pending_window'",
      ).get() as { value_json: string } | undefined;
      const legacyPendingRow = pendingRow ? undefined : this.database.raw.prepare(
        "SELECT value_json FROM app_setting WHERE key = 'intake_pending_window'",
      ).get() as { value_json: string } | undefined;
      const pending = parseMetadata(pendingRow?.value_json ?? legacyPendingRow?.value_json);
      const pendingStart = typeof pending.window_start === 'string' && Number.isFinite(Date.parse(pending.window_start))
        ? new Date(pending.window_start).toISOString()
        : null;
      const pendingEnd = typeof pending.window_end === 'string' && Number.isFinite(Date.parse(pending.window_end))
        ? new Date(pending.window_end).toISOString()
        : null;
      const pendingId = typeof pending.window_id === 'string' && pending.window_id.trim()
        ? pending.window_id.trim()
        : null;
      if (pendingId && pendingStart && pendingEnd
        && (!Number.isFinite(cursorMs) || Date.parse(pendingEnd) > cursorMs)) {
        return {
          window_id: pendingId,
          window_start: pendingStart,
          window_end: pendingEnd,
          reused: true,
        };
      }

      const endMs = Date.now();
      const maxLookbackStartMs = endMs - 4 * 60 * 60 * 1000;
      const startMs = Number.isFinite(cursorMs)
        ? Math.max(Math.min(cursorMs, endMs), maxLookbackStartMs)
        : endMs - 10 * 60 * 1000;
      const window = {
        window_id: `intake-${startMs}-${endMs}`,
        window_start: new Date(startMs).toISOString(),
        window_end: new Date(endMs).toISOString(),
        reused: false,
      } satisfies CindyIntakeWindow;
      const timestamp = nowIso();
      this.database.raw.prepare(
        `INSERT INTO app_setting (key, value_json, updated_at) VALUES ('aily_scan_pending_window', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(JSON.stringify({
        window_id: window.window_id,
        window_start: window.window_start,
        window_end: window.window_end,
      }), timestamp);
      return window;
    });
  }

  updateIntakeWindowCursor(windowEnd: string) {
    return this.updateAilyScanWindowCursor(windowEnd);
  }

  updateAilyScanWindowCursor(windowEnd: string) {
    const next = new Date(windowEnd);
    if (!Number.isFinite(next.getTime())) throw new CindyIntakeValidationError('window_end 不是有效时间。');
    const nextIso = next.toISOString();
    const current = this.ailyScanWindowCursor().window_end;
    if (current && Date.parse(nextIso) <= Date.parse(current)) {
      throw new CindyIntakeConflictError('Aily 扫描窗口游标只允许向前推进。');
    }
    const timestamp = nowIso();
    this.writeAilyScanWindowCursorUnsafe(nextIso, timestamp);
    return { window_end: nextIso };
  }

  private writeAilyScanWindowCursorUnsafe(windowEnd: string, updatedAt: string) {
    this.database.raw.prepare(
      `INSERT INTO app_setting (key, value_json, updated_at) VALUES ('aily_scan_window_end', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify({ window_end: windowEnd }), updatedAt);
    this.database.raw.prepare("DELETE FROM app_setting WHERE key IN ('aily_scan_pending_window', 'intake_pending_window')").run();
  }

  private advanceAilyScanWindowCursorUnsafe(windowEnd: string, updatedAt: string) {
    const next = new Date(windowEnd);
    if (!Number.isFinite(next.getTime())) throw new CindyIntakeValidationError('window_end 不是有效时间。');
    const nextIso = next.toISOString();
    const row = this.database.raw.prepare(
      "SELECT value_json FROM app_setting WHERE key = 'aily_scan_window_end'",
    ).get() as { value_json: string } | undefined;
    const legacyRow = row ? undefined : this.database.raw.prepare(
      "SELECT value_json FROM app_setting WHERE key = 'intake_window_end'",
    ).get() as { value_json: string } | undefined;
    const currentValue = parseMetadata(row?.value_json ?? legacyRow?.value_json).window_end;
    const currentTime = typeof currentValue === 'string' ? Date.parse(currentValue) : Number.NaN;
    if (Number.isFinite(currentTime) && currentTime >= next.getTime()) return;
    this.writeAilyScanWindowCursorUnsafe(nextIso, updatedAt);
  }

  persistAilySummaryWindow(input: {
    window: CindyIntakeWindow;
    agent_id: string;
    generated_at: string;
    text: string;
    empty: boolean;
  }) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(input.agent_id)) {
      throw new CindyIntakeValidationError('Aily Agent ID 格式不合法。');
    }
    if (!Number.isFinite(Date.parse(input.generated_at))) {
      throw new CindyIntakeValidationError('Aily 摘要生成时间无效。');
    }
    const text = input.text.trim();
    if ((!input.empty && !text) || text.length > 20_000) {
      throw new CindyIntakeValidationError('Aily 摘要正文无效或超过长度上限。');
    }
    if (input.empty && text) {
      throw new CindyIntakeValidationError('Aily 空窗口不能保存摘要正文。');
    }
    const contentHash = createHash('sha256').update(text).digest('hex');
    const inboxId = `aily-inbox:${createHash('sha256').update(input.window.window_id).digest('hex')}`;
    return this.database.transaction(() => {
      const timestamp = nowIso();
      const existing = this.database.raw.prepare(
        'SELECT * FROM aily_summary_inbox WHERE window_id = ?',
      ).get(input.window.window_id) as AilySummaryInboxRow | undefined;
      if (existing) {
        if (
          existing.content_hash !== contentHash
          || existing.agent_id !== input.agent_id
          || existing.window_start !== input.window.window_start
          || existing.window_end !== input.window.window_end
          || existing.result_kind !== (input.empty ? 'empty' : 'summary')
        ) {
          throw new CindyIntakeConflictError('同一 Aily 扫描窗口的摘要内容发生变化，已拒绝覆盖旧结果。');
        }
        this.advanceAilyScanWindowCursorUnsafe(input.window.window_end, timestamp);
        return {
          inbox_id: existing.id,
          window_id: existing.window_id,
          status: existing.status,
          duplicate: true,
          summary_ready: existing.status === 'ready' || existing.status === 'claimed' || existing.status === 'retry_waiting',
        };
      }
      const status: AilySummaryInboxStatus = input.empty ? 'completed' : 'ready';
      this.database.raw.prepare(
        `INSERT INTO aily_summary_inbox
          (id, window_id, window_start, window_end, result_kind, agent_id, summary_text, content_hash,
           generated_at, status, attempts, available_at, lease_until, claim_token_hash,
           last_error_code, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?, ?)`,
      ).run(
        inboxId,
        input.window.window_id,
        input.window.window_start,
        input.window.window_end,
        input.empty ? 'empty' : 'summary',
        input.agent_id,
        text,
        contentHash,
        new Date(input.generated_at).toISOString(),
        status,
        timestamp,
        input.empty ? timestamp : null,
        timestamp,
        timestamp,
      );
      this.advanceAilyScanWindowCursorUnsafe(input.window.window_end, timestamp);
      return {
        inbox_id: inboxId,
        window_id: input.window.window_id,
        status,
        duplicate: false,
        summary_ready: !input.empty,
      };
    });
  }

  claimNextAilySummaryInbox() {
    return this.database.transaction(() => {
      const timestamp = nowIso();
      const nowMs = Date.parse(timestamp);
      this.database.raw.prepare(
        `UPDATE aily_summary_inbox
            SET status = 'failed', lease_until = NULL, claim_token_hash = NULL,
                last_error_code = COALESCE(last_error_code, 'CINDY_RETRY_EXHAUSTED'),
                completed_at = COALESCE(completed_at, ?), updated_at = ?
          WHERE status = 'claimed' AND lease_until <= ? AND attempts >= ?`,
      ).run(timestamp, timestamp, timestamp, AILY_SUMMARY_INBOX_MAX_ATTEMPTS);
      const row = this.database.raw.prepare(
        `SELECT * FROM aily_summary_inbox
          WHERE result_kind = 'summary'
            AND attempts < ?
            AND (
              (status IN ('ready','retry_waiting') AND available_at <= ?)
              OR (status = 'claimed' AND lease_until <= ?)
            )
          ORDER BY generated_at ASC, id ASC
          LIMIT 1`,
      ).get(AILY_SUMMARY_INBOX_MAX_ATTEMPTS, timestamp, timestamp) as AilySummaryInboxRow | undefined;
      if (!row) return { status: 'empty' as const };
      const claimToken = randomUUID();
      const claimTokenHash = createHash('sha256').update(claimToken).digest('hex');
      const leaseUntil = new Date(nowMs + AILY_SUMMARY_INBOX_LEASE_MS).toISOString();
      const updated = this.database.raw.prepare(
        `UPDATE aily_summary_inbox
            SET status = 'claimed', attempts = attempts + 1, lease_until = ?, claim_token_hash = ?,
                last_error_code = NULL, updated_at = ?
          WHERE id = ? AND attempts = ? AND (
            (status IN ('ready','retry_waiting') AND available_at <= ?)
            OR (status = 'claimed' AND lease_until <= ?)
          )`,
      ).run(leaseUntil, claimTokenHash, timestamp, row.id, row.attempts, timestamp, timestamp);
      if (updated.changes !== 1) throw new CindyIntakeConflictError('Aily 摘要已被其他消费者领取。');
      return {
        status: 'ready' as const,
        inbox_id: row.id,
        claim_token: claimToken,
        lease_until: leaseUntil,
        attempt: row.attempts + 1,
        window: {
          window_id: row.window_id,
          window_start: row.window_start,
          window_end: row.window_end,
        },
        source: {
          source_key: `aily-summary:${row.window_id}`,
          source_kind: 'aily_summary' as const,
          occurred_at: row.window_end,
          conversation_key: `aily:${row.agent_id}`,
          sender_role: 'Aily 摘要（派生来源）',
          agent_id: row.agent_id,
          generated_at: row.generated_at,
          text: row.summary_text,
        },
      };
    });
  }

  retryAilySummaryInbox(inboxId: string, claimToken: string, errorCode: string) {
    const normalizedId = inboxId.trim();
    const normalizedToken = claimToken.trim();
    const normalizedErrorCode = errorCode.trim().slice(0, 80);
    if (!normalizedId || !normalizedToken || !/^[A-Z0-9_:-]{1,80}$/u.test(normalizedErrorCode)) {
      throw new CindyIntakeValidationError('Aily inbox 重试参数无效。');
    }
    return this.database.transaction(() => {
      const timestamp = nowIso();
      const row = this.database.raw.prepare(
        'SELECT * FROM aily_summary_inbox WHERE id = ?',
      ).get(normalizedId) as AilySummaryInboxRow | undefined;
      if (
        !row
        || row.status !== 'claimed'
        || !row.claim_token_hash
        || !row.lease_until
        || Date.parse(row.lease_until) <= Date.parse(timestamp)
      ) {
        throw new CindyIntakeConflictError('Aily inbox 当前没有有效领取租约。');
      }
      const tokenHash = createHash('sha256').update(normalizedToken).digest('hex');
      if (tokenHash !== row.claim_token_hash) {
        throw new CindyIntakeConflictError('Aily inbox claim token 无效。');
      }
      const exhausted = row.attempts >= AILY_SUMMARY_INBOX_MAX_ATTEMPTS;
      const delay = AILY_SUMMARY_INBOX_RETRY_DELAYS_MS[Math.max(0, Math.min(
        row.attempts - 1,
        AILY_SUMMARY_INBOX_RETRY_DELAYS_MS.length - 1,
      ))]!;
      const nextAvailableAt = new Date(Date.parse(timestamp) + delay).toISOString();
      const status: AilySummaryInboxStatus = exhausted ? 'failed' : 'retry_waiting';
      this.database.raw.prepare(
        `UPDATE aily_summary_inbox
            SET status = ?, available_at = ?, lease_until = NULL, claim_token_hash = NULL,
                last_error_code = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND claim_token_hash = ?`,
      ).run(
        status,
        nextAvailableAt,
        normalizedErrorCode,
        exhausted ? timestamp : null,
        timestamp,
        normalizedId,
        tokenHash,
      );
      return {
        inbox_id: normalizedId,
        status,
        attempts: row.attempts,
        retry_at: exhausted ? null : nextAvailableAt,
      };
    });
  }

  intakeResultStatus(windowId: string) {
    const normalizedWindowId = windowId.trim();
    if (!normalizedWindowId) throw new CindyIntakeValidationError('window_id 不能为空。');
    const row = this.database.raw.prepare(
      `SELECT cursor FROM sync_cursor
       WHERE integration = 'cindy_intake' AND scope_key = ?`,
    ).get(normalizedWindowId) as { cursor: string | null } | undefined;
    const stored = parseJsonValue<StoredCindyIntakeResult | null>(row?.cursor ?? null, null);
    return {
      window_id: normalizedWindowId,
      completed: Boolean(stored && stored.window_id === normalizedWindowId && stored._input_hash),
      result_kind: stored?.result_kind ?? null,
      proposal_count: Array.isArray(stored?.proposals) ? stored.proposals.length : 0,
    };
  }

  updateAutomationPolicy(mode: AutomationMode) {
    const timestamp = nowIso();
    this.database.raw.prepare(
      `INSERT INTO app_setting (key, value_json, updated_at) VALUES ('automation.policy', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify({ mode }), timestamp);
    this.log('runtime', 'info', 'automation.policy_updated', mode === 'auto' ? '已启用 AI 自动维护私人任务。' : '已切换为仅建议模式。', { mode });
    return this.automationPolicy();
  }

  updateTaskAutomation(taskId: string, paused: boolean, expectedVersion?: number) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('任务不存在。');
    if (task.record_state === 'invalidated' || task.deleted_at) throw new Error('无效或回收站任务不能修改自动维护设置。');
    if (expectedVersion !== undefined && expectedVersion !== task.version) throw new Error('任务已被其他操作更新，请刷新后重试。');
    if (task.auto_update_paused === paused) return this.getTaskDetail(taskId);
    const timestamp = nowIso();
    const nextVersion = task.version + 1;
    this.database.transaction(() => {
      const updated = this.database.raw.prepare(
        'UPDATE task SET auto_update_paused = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?',
      ).run(paused ? 1 : 0, nextVersion, timestamp, taskId, task.version);
      if (updated.changes !== 1) throw new Error('任务已被其他操作更新，请刷新后重试。');
      this.database.raw.prepare(
        `INSERT INTO task_event
          (id, task_id, event_type, actor_type, visibility, summary, source_event_id, before_json, after_json, occurred_at, recorded_at, version)
         VALUES (?, ?, 'automation_policy_updated', 'user', 'private', ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        id('evt'),
        taskId,
        paused ? '系统主人暂停了这项任务的 AI 自动维护；后续来源仍会保留并进入待确认。' : '系统主人恢复了这项任务的 AI 自动维护。',
        JSON.stringify(taskAuditSnapshot(task)),
        JSON.stringify({ ...taskAuditSnapshot(task), auto_update_paused: paused, version: nextVersion }),
        timestamp,
        timestamp,
        nextVersion,
      );
    });
    this.projectTaskMemory(taskId);
    return this.getTaskDetail(taskId);
  }

  private observabilityDependencies() {
    const observedAt = nowIso();
    const dependencies: Record<string, { status: 'ready' | 'degraded' | 'not_ready' | 'unknown'; error_code: string | null; observed_at: string; details: Record<string, string | number | boolean | null> }> = {};
    const reasons: SafeReason[] = [];
    try {
      this.database.raw.prepare('SELECT 1 AS ok').get();
      dependencies.database = { status: 'ready', error_code: null, observed_at: observedAt, details: { provider: this.config.database.provider } };
    } catch {
      dependencies.database = { status: 'not_ready', error_code: 'DATABASE_UNAVAILABLE', observed_at: observedAt, details: {} };
      reasons.push({ code: 'DATABASE_UNAVAILABLE', message: '本地数据库当前不可用。' });
    }
    let failedJobs = 0;
    let pendingJobs = 0;
    try {
      failedJobs = (this.database.raw.prepare("SELECT COUNT(*) AS count FROM job WHERE status = 'failed'").get() as { count: number }).count;
      pendingJobs = (this.database.raw.prepare("SELECT COUNT(*) AS count FROM job WHERE status IN ('pending','queued','running')").get() as { count: number }).count;
    } catch {
      // Older local databases may not have the optional runtime queue tables.
    }
    const queueStatus = failedJobs > 0 ? 'degraded' : 'ready';
    dependencies.runner = { status: queueStatus, error_code: failedJobs > 0 ? 'RUNTIME_FAILED_JOBS' : null, observed_at: observedAt, details: { failed_jobs: failedJobs, pending_jobs: pendingJobs } };
    dependencies.queue = { status: queueStatus, error_code: failedJobs > 0 ? 'OBS_QUEUE_DEGRADED' : null, observed_at: observedAt, details: { failed_jobs: failedJobs, pending_jobs: pendingJobs } };
    dependencies.listener = { status: 'ready', error_code: null, observed_at: observedAt, details: { live_adapter: false, running: false } };
    dependencies.disk = { status: 'ready', error_code: null, observed_at: observedAt, details: {} };
    return { dependencies, reasons };
  }

  private availableDiskBytes() {
    const stats = statfsSync(process.cwd());
    return Number(stats.bavail) * Number(stats.bsize);
  }

  health(requestId?: string, readiness = this.readiness()) {
    const feishuKind = (this.adapters.feishu as { kind: string }).kind;
    const workspaceKind = (this.adapters.workspace as { kind: string }).kind;
    const dependencyState = this.observabilityDependencies();
    const databaseUnavailable = readiness.status === 'not_ready'
      && readiness.reasons.some((reason) => reason.code === 'DATABASE_UNAVAILABLE');
    const combinedReasons = (databaseUnavailable ? readiness.reasons : [...readiness.reasons, ...dependencyState.reasons])
      .filter((reason, index, all) => all.findIndex((item) => item.code === reason.code) === index);
    const combinedReadiness: { status: ReadinessStatus; reasons: SafeReason[] } = {
      status: readiness.status === 'not_ready'
        ? 'not_ready'
        : combinedReasons.length ? 'degraded' : readiness.status,
      reasons: combinedReasons,
    };
    return {
      status: 'ok',
      operation_id: randomUUID(),
      request_id: requestId ?? randomUUID(),
      trace_id: randomUUID(),
      span_id: randomUUID(),
      liveness: { status: 'alive' },
      readiness: { status: combinedReadiness.status, reasons: combinedReadiness.reasons.map((reason) => ({ ...reason })) },
      dependencies: dependencyState.dependencies,
      release: this.releaseIdentity(),
      // A live model does not imply that Feishu is connected. Keep each
      // integration explicit so the UI cannot overstate capabilities.
      mode: 'local-shell',
      externalConnections: false,
      database: this.config.database.provider,
      integrations: {
        feishu: feishuKind,
        workspace: workspaceKind,
      },
      timestamp: nowIso(),
    };
  }

  releaseIdentity() {
    return releaseIdentity(this.config.release);
  }

  readiness(): { status: ReadinessStatus; reasons: SafeReason[] } {
    try {
      const reasons: SafeReason[] = [];
      this.database.raw.prepare('SELECT 1 AS ok').get();
      return { status: reasons.length ? 'degraded' : 'ready', reasons };
    } catch {
      return { status: 'not_ready', reasons: [{ code: 'DATABASE_UNAVAILABLE', message: '本地数据库当前不可用。' }] };
    }
  }


  /** Shared durable conflict gate for every owner-sensitive privacy mutation. */

  /** Renew and final-fence a claim immediately before any provider call. */

  /**
   * Stage the complete system-owned task-memory projection before SQLite
   * business rows are touched. The root and every path are validated first;
   * unknown files, traversal, symlinks and junctions fail closed. A whole
   * `tasks` directory is then moved into a quarantine directory so rollback
   * restores the original bytes without creating a second content copy.
   */

  /**
   * Resolve the currently authorized owner's stable Feishu identifiers from
   * SQLite.  Source metadata is supplied by integrations and can be replayed
   * or forged, so `isOwnerMessage`/`senderRole` alone are never sufficient to
   * authorize a state-machine action.
   */

  /** Persist sources without starting AI classification. Used only while a
   * paginated Feishu history window is incomplete; the old cursor guarantees
   * a later complete scan will finalize the same durable rows. */

  /**
   * Persist every source independently, then classify semantic message groups
   * once. Raw Feishu messages remain auditable rows; only the AI judgement is
   * coalesced. Calendar events and minutes are always singleton groups.
   */

  /** DATA-04: source_event is a current pointer; immutable body/history lives in revisions. */


  /**
   * Register the current desktop capability as durable replay authorization.
   * This is an explicit application-startup path called by buildApp; replay
   * itself never trusts this caller-supplied secret or an optional bypass.
   */

  /** Verify and atomically consume the current durable capability. */

  /**
   * Validate the complete persisted decision scope before any capability is
   * consumed. Foreign-but-existing IDs are not enough: every edge must point
   * at the same owner-bound demand unit, ordered source set and candidate/task
   * lineage that produced this decision.
   */

  /** Reconstruct only from immutable revision rows; current source content is never consulted. */

  private persistSourceEventUnsafe(event: NormalizedSourceEvent) {
    const normalized = this.adapters.feishu.normalizeSource(event);
    const incomingIdentity = sourceDedupeIdentityOfEvent(normalized);
    const existing = this.database.raw
      .prepare('SELECT * FROM source_event WHERE external_id = ?')
      .get(normalized.externalId) as SourceEventRow | undefined;
    if (existing) {
      const existingIdentity = sourceDedupeIdentityOfRow(existing);
      if (!sourceDedupeIdentityMatches(existingIdentity, incomingIdentity)) {
        throw new Error('来源 external_id 已绑定到不兼容的主人、入口或会话；已拒绝写入或确认。');
      }
      const rank = (value: NormalizedSourceEvent['completeness'] | undefined) => value === 'complete' ? 3 : value === 'partial' ? 2 : 1;
      const incomingCompleteness = normalized.completeness ?? 'partial';
      const currentMetadata = parseMetadata(existing.metadata_json);
      const incomingMetadata = stripExternalFailureInbox(normalized.metadata ?? {});
      const incomingVersion = metadataVersion(incomingMetadata);
      const currentVersion = metadataVersion(currentMetadata);
      const incomingIsNewer = incomingMetadataIsNewer(incomingVersion, currentVersion);
      const incomingDeleted = Boolean(incomingMetadata.deleted || incomingMetadata.withdrawn || incomingMetadata.recalled);
      const currentDeleted = Boolean(currentMetadata.deleted || currentMetadata.withdrawn || currentMetadata.recalled);
      const mergedMetadata: Record<string, unknown> = { ...currentMetadata, ...incomingMetadata, ...(currentDeleted || incomingDeleted ? { deleted: true } : {}) };
      // Channel provenance is immutable once an external id has been bound.
      // A duplicate may enrich content, but it can never relabel an owner or
      // source namespace (for example, owner history as bot_supplement).
      if (Object.prototype.hasOwnProperty.call(currentMetadata, 'sourceScope')) {
        mergedMetadata.sourceScope = currentMetadata.sourceScope;
      } else {
        delete mergedMetadata.sourceScope;
      }
      if (Object.prototype.hasOwnProperty.call(currentMetadata, 'ownerScope')) {
        mergedMetadata.ownerScope = currentMetadata.ownerScope;
      } else {
        delete mergedMetadata.ownerScope;
      }
      const replaceContent = Boolean(normalized.content) && (incomingDeleted || incomingIsNewer || rank(incomingCompleteness) > rank(existing.completeness) || !existing.content);
      const nextContent = currentDeleted || incomingDeleted ? '[飞书消息已撤回或删除，正文不再保留]' : replaceContent ? normalized.content : existing.content;
      const nextCompleteness = currentDeleted || incomingDeleted ? 'limited' : (incomingIsNewer || rank(incomingCompleteness) > rank(existing.completeness)) ? incomingCompleteness : existing.completeness;
      const nextSenderId = (incomingIsNewer || existing.sender_id === 'unknown-sender') && normalized.senderId ? normalized.senderId : existing.sender_id;
      const nextSenderName = (incomingIsNewer || existing.sender_name === '飞书用户') && normalized.senderName ? normalized.senderName : existing.sender_name;
      const nextOwnerMentioned = existing.owner_mentioned || (normalized.ownerMentioned ? 1 : 0);
      const nextSourceUrl = normalized.sourceUrl ?? existing.source_url;
      const nextReason = normalized.discoveryReason || existing.discovery_reason;
      const changed = nextCompleteness !== existing.completeness
        || nextContent !== existing.content
        || nextOwnerMentioned !== existing.owner_mentioned
        || nextSourceUrl !== existing.source_url
        || nextReason !== existing.discovery_reason
        || nextSenderId !== existing.sender_id
        || nextSenderName !== existing.sender_name
        || JSON.stringify(mergedMetadata) !== existing.metadata_json;
      if (changed) {
        const updated = this.database.raw.prepare(
          `UPDATE source_event
           SET content = ?, sender_id = ?, sender_name = ?, owner_mentioned = ?, source_url = ?, completeness = ?, discovery_reason = ?, metadata_json = ?
           WHERE id = ? AND owner_scope = ? AND revision_generation = ? AND current_revision_id IS ?`,
        ).run(
          nextContent,
          nextSenderId,
          nextSenderName,
          nextOwnerMentioned,
          nextSourceUrl,
          nextCompleteness,
          nextReason,
          JSON.stringify(mergedMetadata),
          existing.id, existing.owner_scope, existing.revision_generation, existing.current_revision_id,
        );
        if (updated.changes !== 1) throw new Error('来源状态已被其他写入者更新；已回滚本次写入。');
        this.log('runtime', 'info', 'source.enriched', incomingDeleted ? '消息已撤回或删除，已清除原正文。' : '已用更新或更完整的授权来源更新原消息。', { sourceEventId: existing.id, completeness: nextCompleteness });
      }
      const refreshed = this.database.raw.prepare('SELECT * FROM source_event WHERE id = ?').get(existing.id) as SourceEventRow;
      return { row: refreshed, deduplicated: true, upgraded: changed, changed };
    }

    const sourceEventId = id('src');
    const capturedAt = nowIso();
    this.database.raw
      .prepare(
        `INSERT INTO source_event
          (id, external_id, source_type, conversation_id, sender_id, sender_name, content, owner_mentioned, source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at, owner_scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceEventId,
        normalized.externalId,
        normalized.sourceType,
        normalized.conversationId,
        normalized.senderId,
        normalized.senderName,
        normalized.content,
        normalized.ownerMentioned ? 1 : 0,
        normalized.sourceUrl ?? null,
        normalized.completeness ?? 'partial',
        normalized.discoveryReason ?? '',
        JSON.stringify(stripExternalFailureInbox(normalized.metadata ?? {})),
        normalized.occurredAt,
        capturedAt,
        incomingIdentity.ownerScope,
      );

    this.log('runtime', 'info', 'source.captured', '已保存一条授权来源消息。', {
      sourceEventId,
      sourceType: normalized.sourceType,
      senderIdPresent: Boolean(normalized.senderId),
    });

    const sourceRow = this.database.raw.prepare('SELECT * FROM source_event WHERE id = ?').get(sourceEventId) as SourceEventRow;
    return { row: sourceRow, deduplicated: false, upgraded: false, changed: true };
  }

  private sourceThreadIds(sourceEventId: string) {
    const rows = this.database.raw.prepare(
      'SELECT DISTINCT thread_id FROM requirement_thread_source WHERE source_event_id = ? ORDER BY thread_id ASC',
    ).all(sourceEventId) as Array<{ thread_id: string }>;
    return rows.map((row) => row.thread_id).filter(Boolean);
  }

  /**
   * A source can belong to more than one demand unit.  Source-only lookup is
   * therefore a legacy convenience and is allowed to return a thread only
   * when the relationship is unambiguous.
   */
  private sourceThreadId(sourceEventId: string) {
    const threadIds = this.sourceThreadIds(sourceEventId);
    return threadIds.length === 1 ? threadIds[0]! : null;
  }


  private candidateGroupRows(rootCandidateId: string) {
    return this.database.raw.prepare(
      `SELECT * FROM candidate_request
       WHERE id = ? OR merged_into_candidate_id = ?
       ORDER BY created_at ASC, id ASC`,
    ).all(rootCandidateId, rootCandidateId) as CandidateRow[];
  }

  private candidateMergePair(leftCandidateId: string, rightCandidateId: string) {
    return leftCandidateId < rightCandidateId
      ? [leftCandidateId, rightCandidateId] as const
      : [rightCandidateId, leftCandidateId] as const;
  }

  private candidateMergeExcluded(left: CandidateRow, right: CandidateRow) {
    const leftRoot = this.candidateGroupRoot(left);
    const rightRoot = this.candidateGroupRoot(right);
    const leftMembers = this.candidateGroupRows(leftRoot.id);
    const rightMembers = this.candidateGroupRows(rightRoot.id);
    const lookup = this.database.raw.prepare(
      'SELECT 1 FROM candidate_merge_exclusion WHERE candidate_a_id = ? AND candidate_b_id = ? LIMIT 1',
    );
    return leftMembers.some((leftMember) => rightMembers.some((rightMember) => {
      if (leftMember.id === rightMember.id) return false;
      const [candidateA, candidateB] = this.candidateMergePair(leftMember.id, rightMember.id);
      return Boolean(lookup.get(candidateA, candidateB));
    }));
  }

  private recordCandidateMergeExclusion(left: CandidateRow, right: CandidateRow, reason: string, timestamp = nowIso()) {
    const leftRoot = this.candidateGroupRoot(left);
    const rightRoot = this.candidateGroupRoot(right);
    const leftMembers = this.candidateGroupRows(leftRoot.id);
    const rightMembers = this.candidateGroupRows(rightRoot.id);
    const insert = this.database.raw.prepare(
      `INSERT OR IGNORE INTO candidate_merge_exclusion
        (candidate_a_id, candidate_b_id, reason, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const leftMember of leftMembers) {
      for (const rightMember of rightMembers) {
        if (leftMember.id === rightMember.id) continue;
        const [candidateA, candidateB] = this.candidateMergePair(leftMember.id, rightMember.id);
        insert.run(candidateA, candidateB, reason, timestamp);
      }
    }
  }

  private candidateMergeSuggestionMatches(
    suggestion: Record<string, unknown>,
    current: CandidateRow,
    currentThread: RequirementThreadRow,
    target: CandidateRow,
    targetThread: RequirementThreadRow,
  ) {
    const storedCurrentMembers = Array.isArray(suggestion.currentGroupMemberIds)
      ? suggestion.currentGroupMemberIds.filter((value): value is string => typeof value === 'string').sort()
      : [];
    const storedTargetMembers = Array.isArray(suggestion.targetGroupMemberIds)
      ? suggestion.targetGroupMemberIds.filter((value): value is string => typeof value === 'string').sort()
      : [];
    const currentMembers = this.candidateGroupRows(current.id).map((candidate) => candidate.id).sort();
    const targetMembers = this.candidateGroupRows(target.id).map((candidate) => candidate.id).sort();
    const currentGroupVersionHash = candidateGroupVersionHash(this.candidateGroupRows(current.id));
    const targetGroupVersionHash = candidateGroupVersionHash(this.candidateGroupRows(target.id));
    return suggestion.suggestionVersion === 1
      && typeof suggestion.suggestionId === 'string'
      && Boolean(suggestion.suggestionId)
      && suggestion.currentCandidateId === current.id
      && suggestion.currentRootCandidateId === current.id
      && suggestion.currentThreadId === currentThread.id
      && suggestion.currentThreadVersion === currentThread.version
      && suggestion.currentSnapshotRevision === candidateSnapshotRevision(current, currentThread)
      && suggestion.targetCandidateId === target.id
      && suggestion.targetRootCandidateId === target.id
      && suggestion.targetThreadId === targetThread.id
      && suggestion.targetThreadVersion === targetThread.version
      && suggestion.targetSnapshotRevision === candidateSnapshotRevision(target, targetThread)
      && JSON.stringify(storedCurrentMembers) === JSON.stringify(currentMembers)
      && JSON.stringify(storedTargetMembers) === JSON.stringify(targetMembers)
      && suggestion.currentGroupVersionHash === currentGroupVersionHash
      && suggestion.targetGroupVersionHash === targetGroupVersionHash
      && !current.merged_into_candidate_id
      && !target.merged_into_candidate_id
      && !current.deleted_at
      && !target.deleted_at
      && !current.accepted_task_id
      && !target.accepted_task_id
      && (current.state === 'pending' || current.state === 'snoozed')
      && (target.state === 'pending' || target.state === 'snoozed')
      && !currentThread.active_task_id
      && !targetThread.active_task_id
      && currentThread.status === 'open'
      && targetThread.status === 'open';
  }

  private applyCandidateMerge(input: {
    currentCandidate: CandidateRow;
    currentThread: RequirementThreadRow;
    targetCandidate: CandidateRow;
    targetThread: RequirementThreadRow;
    decision: CandidateMergeDecision;
    actor: 'ai' | 'user';
    reason: string;
  }) {
    const { currentCandidate, currentThread, targetCandidate, targetThread, decision, actor } = input;
    const sameThread = currentThread.id === targetThread.id;
    const currentRootId = currentCandidate.merged_into_candidate_id ?? currentCandidate.id;
    const targetRootId = targetCandidate.merged_into_candidate_id ?? targetCandidate.id;
    const currentGroup = this.candidateGroupRows(currentRootId);
    const targetGroup = this.candidateGroupRows(targetRootId);
    const members = [...new Map([...currentGroup, ...targetGroup].map((candidate) => [candidate.id, candidate])).values()];
    const currentUnitIds = this.demandUnitIdsForCandidates(currentGroup);
    if (members.some((candidate) => candidate.accepted_task_id || candidate.state === 'accepted' || candidate.deleted_at)) {
      throw new Error('候选组已经被接受或移入回收站，不能继续归并。');
    }
    const primaryCandidate = decision.primary === 'current' ? currentCandidate : targetCandidate;
    const primaryRole = decision.primary === 'current' ? decision.currentRole : decision.targetRole;
    if (!primaryRole) throw new Error('候选归并缺少主体角色。');
    const timestamp = nowIso();
    const before = {
      currentCandidateId: currentCandidate.id,
      currentThreadId: currentThread.id,
      targetCandidateId: targetCandidate.id,
      targetThreadId: targetThread.id,
      memberIds: members.map((candidate) => candidate.id),
    };
    const currentSourceIds = [...new Set(currentGroup.flatMap((candidate) => this.sourceRowsForDemandUnit(
      candidate.demand_unit_id,
      this.database.raw.prepare('SELECT * FROM source_event WHERE id = ?').get(candidate.source_event_id) as SourceEventRow,
    ).map((row) => row.id)))];
    const sourceRelations = sameThread || !currentSourceIds.length ? [] : this.database.raw.prepare(
      `SELECT * FROM requirement_thread_source
       WHERE thread_id = ? AND source_event_id IN (${currentSourceIds.map(() => '?').join(',')})
       ORDER BY created_at ASC`,
    ).all(currentThread.id, ...currentSourceIds) as Array<RequirementThreadSourceRow & {
      session_id: string | null;
      conversation_id: string | null;
      participant_ids_json: string;
      source_revision: string | null;
      source_role: string;
      role_reason: string;
    }>;
    for (const relation of sourceRelations) {
      const isCurrentAnchor = relation.source_event_id === currentCandidate.source_event_id;
      const role = isCurrentAnchor ? decision.currentRole ?? 'unknown' : relation.source_role || 'unknown';
      const roleReason = isCurrentAnchor ? decision.reason : relation.role_reason || '';
      this.database.raw.prepare(
        `INSERT INTO requirement_thread_source
          (thread_id, source_event_id, demand_unit_id, relation_type, confidence, evidence_json, root_id, parent_id, session_id,
           conversation_id, participant_ids_json, source_revision, source_role, role_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, source_event_id) DO UPDATE SET
           relation_type = excluded.relation_type,
           confidence = excluded.confidence,
           evidence_json = excluded.evidence_json,
           root_id = excluded.root_id,
           parent_id = excluded.parent_id,
           session_id = excluded.session_id,
           conversation_id = excluded.conversation_id,
           participant_ids_json = excluded.participant_ids_json,
           source_revision = excluded.source_revision,
           source_role = excluded.source_role,
           role_reason = excluded.role_reason`,
      ).run(
        targetThread.id,
        relation.source_event_id,
        relation.demand_unit_id ?? this.uniqueSourceDemandUnitId(relation.source_event_id),
        isCurrentAnchor ? (actor === 'ai' ? 'candidate_auto_merge' : 'owner_candidate_merge') : relation.relation_type,
        isCurrentAnchor ? decision.confidence : relation.confidence,
        isCurrentAnchor ? JSON.stringify([...decision.evidence, decision.reason].filter(Boolean)) : relation.evidence_json,
        relation.root_id,
        relation.parent_id,
        relation.session_id,
        relation.conversation_id,
        relation.participant_ids_json,
        relation.source_revision,
        role,
        roleReason,
        relation.created_at,
      );
    }
    if (!sameThread) {
      this.moveDemandUnitsToThread(currentUnitIds, currentThread.id, targetThread.id, timestamp);
      for (const sourceEventId of currentSourceIds) {
        if (!this.sourceUsedByOtherThreadUnit(currentThread.id, sourceEventId, currentUnitIds)) {
          this.database.raw.prepare('DELETE FROM requirement_thread_source WHERE thread_id = ? AND source_event_id = ?').run(currentThread.id, sourceEventId);
        }
      }
    }
    const allUnitIds = this.demandUnitIdsForCandidates(members);
    if (allUnitIds.length) {
      this.database.raw.prepare(
        `UPDATE requirement_thread_unit
         SET relation_type = 'supporting'
         WHERE thread_id = ? AND demand_unit_id IN (${allUnitIds.map(() => '?').join(',')})`,
      ).run(targetThread.id, ...allUnitIds);
      if (primaryCandidate.demand_unit_id) {
        this.database.raw.prepare(
          "UPDATE requirement_thread_unit SET relation_type = 'primary' WHERE thread_id = ? AND demand_unit_id = ?",
        ).run(targetThread.id, primaryCandidate.demand_unit_id);
      }
    }
    this.database.raw.prepare(
      `UPDATE requirement_thread_source
       SET relation_type = ?, confidence = ?, evidence_json = ?, source_role = ?, role_reason = ?
       WHERE thread_id = ? AND source_event_id = ?`,
    ).run(
      actor === 'ai' ? 'candidate_auto_merge' : 'owner_candidate_merge',
      decision.confidence,
      JSON.stringify([...decision.evidence, decision.reason].filter(Boolean)),
      decision.currentRole ?? 'unknown',
      decision.reason,
      targetThread.id,
      currentCandidate.source_event_id,
    );
    this.database.raw.prepare(
      `UPDATE requirement_thread_source
       SET source_role = ?, role_reason = ?, confidence = COALESCE(?, confidence)
       WHERE thread_id = ? AND source_event_id = ?`,
    ).run(decision.targetRole ?? 'unknown', decision.reason, decision.confidence, targetThread.id, targetCandidate.source_event_id);
    for (const member of members) {
      if (member.id === primaryCandidate.id) {
        const updated = this.database.raw.prepare(
          'UPDATE candidate_request SET merged_into_candidate_id = NULL, merged_at = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?',
        ).run(timestamp, member.id, member.version);
        if (updated.changes !== 1) throw new CandidateVersionConflictError();
      } else {
        const updated = this.database.raw.prepare(
          'UPDATE candidate_request SET merged_into_candidate_id = ?, merged_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?',
        ).run(primaryCandidate.id, timestamp, timestamp, member.id, member.version);
        if (updated.changes !== 1) throw new CandidateVersionConflictError();
        this.database.raw.prepare(
          'UPDATE notification SET archived_at = COALESCE(archived_at, ?) WHERE candidate_id = ?',
        ).run(timestamp, member.id);
      }
    }
    const combinedParticipants = [...new Set([
      ...parseJsonValue<string[]>(targetThread.participant_ids_json, []),
      ...parseJsonValue<string[]>(currentThread.participant_ids_json, []),
    ])];
    const targetThreadUpdate = this.database.raw.prepare(
      `UPDATE requirement_thread
       SET title = ?, background = ?, validation_question = ?, describe = ?, analysis_json = ?,
           participant_ids_json = ?, ambiguity_json = '[]', status = 'open',
           primary_source_event_id = ?, primary_reason = ?, primary_confidence = ?,
           last_activity_at = CASE
             WHEN last_activity_at IS NULL OR (COALESCE(?, '') <> '' AND last_activity_at < ?) THEN ?
             ELSE last_activity_at
           END,
           version = version + 1, updated_at = ?
       WHERE id = ? AND active_task_id IS NULL AND version = ?`,
    ).run(
      primaryCandidate.title,
      primaryCandidate.background,
      primaryCandidate.validation_question,
      primaryCandidate.describe,
      primaryCandidate.analysis_json,
      JSON.stringify(combinedParticipants),
      primaryCandidate.source_event_id,
      input.reason,
      decision.primaryConfidence,
      currentThread.last_activity_at,
      currentThread.last_activity_at,
      currentThread.last_activity_at,
      timestamp,
      targetThread.id,
      targetThread.version,
    );
    if (targetThreadUpdate.changes !== 1) throw new CandidateVersionConflictError();
    if (!sameThread) {
      const remainingUnits = this.database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread_unit WHERE thread_id = ?').get(currentThread.id) as { count: number };
      if (remainingUnits.count === 0) {
        const currentThreadUpdate = this.database.raw.prepare(
          `UPDATE requirement_thread
           SET status = 'closed', ambiguity_json = '[]', updated_at = ?
           WHERE id = ? AND active_task_id IS NULL AND version = ?`,
        ).run(timestamp, currentThread.id, currentThread.version);
        if (currentThreadUpdate.changes !== 1) throw new CandidateVersionConflictError();
        this.database.raw.prepare(
          "UPDATE requirement_thread_revision SET state = 'stale', decided_at = ? WHERE thread_id = ? AND state = 'proposed'",
        ).run(timestamp, currentThread.id);
      }
    }
    const idempotencyKey = `${actor === 'ai' ? 'candidate-auto-merge' : 'candidate-owner-merge'}:${currentCandidate.id}:${targetCandidate.id}:${decision.candidateSetHash}`;
    this.database.raw.prepare(
      `INSERT OR IGNORE INTO correction_event
        (id, idempotency_key, task_id, candidate_id, source_event_id, demand_unit_id, correction_type,
         before_json, after_json, note, visibility, operation, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'private', 'apply', ?)`,
    ).run(
      id('correction'),
      idempotencyKey,
      primaryCandidate.id,
      currentCandidate.source_event_id,
      primaryCandidate.demand_unit_id,
      actor === 'ai' ? 'candidate_auto_merge' : 'candidate_owner_merge',
      JSON.stringify(before),
      JSON.stringify({
        threadId: targetThread.id,
        primaryCandidateId: primaryCandidate.id,
        primarySourceEventId: primaryCandidate.source_event_id,
        memberIds: members.map((candidate) => candidate.id),
        currentRole: decision.currentRole,
        targetRole: decision.targetRole,
        confidence: decision.confidence,
        primaryConfidence: decision.primaryConfidence,
      }),
      input.reason,
      timestamp,
    );
    const thread = this.database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(targetThread.id) as unknown as RequirementThreadRow;
    return { primaryCandidate: this.getCandidate(primaryCandidate.id)!, thread, memberCount: members.length };
  }


  /**
   * Convert the model's optional multi-demand output into durable units.  The
   * legacy top-level classification is deliberately wrapped as u1 so older
   * providers and rule mocks keep the same behaviour.
   */

  /**
   * Older single-candidate rows predate demand_unit_id. When a later semantic
   * message is attached to such a pending candidate, promote it into the
   * durable unit graph first so the candidate card can expose every source.
   */
  private ensureCandidateDemandUnit(candidate: CandidateRow, thread: RequirementThreadRow, timestamp = nowIso()) {
    const unitId = this.ensureCandidateDemandUnitRecord(candidate, timestamp);
    this.database.raw.prepare(
      `INSERT OR IGNORE INTO requirement_thread_unit
         (thread_id, demand_unit_id, relation_type, confidence, evidence_json, created_at)
       VALUES (?, ?, 'primary', 1, ?, ?)`,
    ).run(thread.id, unitId, JSON.stringify(['候选需求单元已绑定到需求线程。']), timestamp);
    this.database.raw.prepare(
      'UPDATE requirement_thread_source SET demand_unit_id = ? WHERE thread_id = ? AND demand_unit_id IS NULL',
    ).run(unitId, thread.id);
    return unitId;
  }

  private ensureCandidateDemandUnitRecord(candidate: CandidateRow, timestamp = nowIso()) {
    if (candidate.demand_unit_id) return candidate.demand_unit_id;
    const existing = this.database.raw.prepare(
      `SELECT id FROM source_demand_unit
        WHERE anchor_source_event_id = ? AND unit_key = 'legacy'`,
    ).get(candidate.source_event_id) as { id: string } | undefined;
    const unitId = existing?.id ?? `unit_candidate_${candidate.id}`;
    if (!existing) {
      this.database.raw.prepare(
        `INSERT INTO source_demand_unit
          (id, anchor_source_event_id, unit_key, unit_kind, state, classification_revision, ai_decision_id, analysis_json, reason, created_at, updated_at)
         VALUES (?, ?, 'legacy', 'demand', 'ready', 'legacy', NULL, ?, ?, ?, ?)`,
      ).run(unitId, candidate.source_event_id, candidate.analysis_json, '从旧版候选升级为可持续关联的需求单元。', timestamp, timestamp);
    }
    const updated = this.database.raw.prepare(
      'UPDATE candidate_request SET demand_unit_id = ?, updated_at = ?, version = version + 1 WHERE id = ? AND demand_unit_id IS NULL AND version = ?',
    ).run(unitId, timestamp, candidate.id, candidate.version);
    if (updated.changes !== 1) {
      const current = this.getCandidate(candidate.id);
      if (!current?.demand_unit_id) throw new CandidateVersionConflictError();
    }
    const originalSource = this.database.raw.prepare('SELECT id FROM source_event WHERE id = ?').get(candidate.source_event_id) as { id: string } | undefined;
    if (originalSource) {
      this.database.raw.prepare(
        `INSERT OR IGNORE INTO source_demand_unit_source
           (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
         VALUES (?, ?, 's1', 'anchor', 0, ?)`,
      ).run(unitId, originalSource.id, timestamp);
    }
    return unitId;
  }

  private uniqueThreadDemandUnitId(threadId: string) {
    const rows = this.database.raw.prepare(
      'SELECT DISTINCT demand_unit_id FROM requirement_thread_unit WHERE thread_id = ? ORDER BY demand_unit_id',
    ).all(threadId) as Array<{ demand_unit_id: string }>;
    return rows.length === 1 ? rows[0]!.demand_unit_id : null;
  }

  private uniqueSourceDemandUnitId(sourceEventId: string) {
    const rows = this.database.raw.prepare(
      'SELECT DISTINCT demand_unit_id FROM source_demand_unit_source WHERE source_event_id = ? ORDER BY demand_unit_id',
    ).all(sourceEventId) as Array<{ demand_unit_id: string }>;
    return rows.length === 1 ? rows[0]!.demand_unit_id : null;
  }

  private taskDemandUnitIds(taskId: string) {
    const rows = this.database.raw.prepare(
      `SELECT DISTINCT demand_unit_id
         FROM task_source_link
        WHERE task_id = ? AND demand_unit_id IS NOT NULL
       UNION
       SELECT DISTINCT candidate_request.demand_unit_id
         FROM candidate_request
        WHERE candidate_request.accepted_task_id = ?
          AND candidate_request.demand_unit_id IS NOT NULL
       UNION
       SELECT DISTINCT requirement_thread_unit.demand_unit_id
         FROM task
         JOIN requirement_thread_unit
           ON requirement_thread_unit.thread_id = task.thread_id
        WHERE task.id = ?
          AND requirement_thread_unit.demand_unit_id IS NOT NULL
        ORDER BY demand_unit_id`,
    ).all(taskId, taskId, taskId) as Array<{ demand_unit_id: string }>;
    return rows.map((row) => row.demand_unit_id);
  }

  private ensureCindyTaskDemandUnit(task: TaskRecord, sourceEventId: string, timestamp: string) {
    const demandUnitIds = this.taskDemandUnitIds(task.id);
    if (demandUnitIds.length > 1) {
      throw new CindyIntakeConflictError('任务关联多个需求单元，Cindy update_task 无法安全判断来源归属。', task.version);
    }
    if (demandUnitIds.length === 1) {
      this.ensureDemandUnitSourceEdge(demandUnitIds[0]!, sourceEventId, timestamp);
      return demandUnitIds[0]!;
    }

    const demandUnitId = id('unit');
    this.database.raw.prepare(
      `INSERT INTO source_demand_unit
        (id, anchor_source_event_id, unit_key, unit_kind, state, classification_revision, ai_decision_id,
         analysis_json, reason, created_at, updated_at)
       VALUES (?, ?, ?, 'demand', 'ready', 'cindy-intake', NULL, ?, ?, ?, ?)`,
    ).run(
      demandUnitId,
      sourceEventId,
      `cindy-task:${task.id}`,
      JSON.stringify({ origin: 'cindy_update', taskId: task.id }),
      'Cindy 后续来源为历史任务建立兼容需求单元。',
      timestamp,
      timestamp,
    );
    this.ensureDemandUnitSourceEdge(demandUnitId, sourceEventId, timestamp);
    return demandUnitId;
  }

  private ensureDemandUnitSourceEdge(demandUnitId: string, sourceEventId: string, timestamp: string) {
    const existing = this.database.raw.prepare(
      `SELECT 1 FROM source_demand_unit_source
        WHERE demand_unit_id = ? AND source_event_id = ?`,
    ).get(demandUnitId, sourceEventId);
    if (existing) return;
    const sequence = (this.database.raw.prepare(
      'SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM source_demand_unit_source WHERE demand_unit_id = ?',
    ).get(demandUnitId) as { sequence: number }).sequence;
    this.database.raw.prepare(
      `INSERT OR IGNORE INTO source_demand_unit_source
        (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
       VALUES (?, ?, ?, 'evidence', ?, ?)`,
    ).run(demandUnitId, sourceEventId, `owner_${sourceEventId}`, sequence, timestamp);
  }

  /**
   * Close exactly one durable task/source integrity gap after the repaired
   * relation is present.  The correction event and gap update deliberately
   * happen in the caller's transaction so a later failure rolls both back.
   */
  private closeTaskSourceIntegrityGap(input: {
    gapTaskId: string;
    sourceEventId: string;
    resolutionTaskId: string;
    demandUnitId: string;
    timestamp: string;
    correctionEventId?: string;
    correctionTaskId?: string;
  }) {
    const recordId = `${input.gapTaskId}:${input.sourceEventId}`;
    const gap = this.database.raw.prepare(
      `SELECT id, task_id, candidate_id, source_event_id, demand_unit_id, record_table, record_id,
              reason, status, correction_event_id
         FROM data_integrity_gap
        WHERE record_table = 'task_source_link'
          AND record_id = ?
          AND reason = 'missing_or_ambiguous_demand_unit'
          AND status = 'open'`,
    ).get(recordId) as {
      id: string;
      task_id: string | null;
      candidate_id: string | null;
      source_event_id: string | null;
      demand_unit_id: string | null;
      record_table: string;
      record_id: string;
      reason: string;
      status: string;
      correction_event_id: string | null;
    } | undefined;
    if (!gap) return null;
    if (gap.task_id !== input.gapTaskId
      || gap.source_event_id !== input.sourceEventId
      || (gap.demand_unit_id !== null && gap.demand_unit_id !== input.demandUnitId)) {
      throw new Error('完整性缺口结构化绑定不匹配，已拒绝关闭缺口。');
    }

    const sourceDemandUnit = this.database.raw.prepare(
      `SELECT 1 AS present
         FROM source_demand_unit_source
        WHERE demand_unit_id = ? AND source_event_id = ?`,
    ).get(input.demandUnitId, input.sourceEventId);
    if (!sourceDemandUnit) {
      throw new Error('来源与需求单元关系尚未完成精确修复，完整性缺口保持打开。');
    }
    const repairedRelation = this.database.raw.prepare(
      `SELECT 1 AS present
         FROM task_source_link
        WHERE task_id = ? AND source_event_id = ? AND demand_unit_id = ?`,
    ).get(input.resolutionTaskId, input.sourceEventId, input.demandUnitId);
    if (!repairedRelation) {
      throw new Error('任务来源关系尚未完成精确修复，完整性缺口保持打开。');
    }
    const unresolvedLegacyEdge = this.database.raw.prepare(
      `SELECT 1 AS present
         FROM task_source_link
        WHERE task_id = ? AND source_event_id = ? AND demand_unit_id IS NULL`,
    ).get(input.gapTaskId, input.sourceEventId);
    if (unresolvedLegacyEdge) return null;

    const idempotencyKey = `integrity-gap:${gap.id}`;
    const deterministicCorrectionId = `corr-integrity-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
    let correctionId = input.correctionEventId ?? deterministicCorrectionId;
    if (!input.correctionEventId) {
      const existing = this.database.raw.prepare(
        'SELECT id FROM correction_event WHERE idempotency_key = ?',
      ).get(idempotencyKey) as { id: string } | undefined;
      if (existing) {
        correctionId = existing.id;
      } else {
        this.database.raw.prepare(
          `INSERT OR IGNORE INTO correction_event
            (id, idempotency_key, task_id, candidate_id, source_event_id, demand_unit_id, correction_type,
             before_json, after_json, note, visibility, operation, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'integrity_gap_closed', ?, ?,
                   '系统已验证精确任务-来源-需求单元关系，关闭完整性缺口。', 'private', 'apply', ?)`,
        ).run(
          deterministicCorrectionId,
          idempotencyKey,
          gap.task_id ?? input.resolutionTaskId,
          gap.candidate_id,
          input.sourceEventId,
          input.demandUnitId,
          JSON.stringify({ record_table: gap.record_table, record_id: gap.record_id, reason: gap.reason, status: 'open' }),
          JSON.stringify({ record_table: gap.record_table, record_id: gap.record_id, reason: gap.reason, status: 'corrected', demand_unit_id: input.demandUnitId }),
          input.timestamp,
        );
      }
    }
    const correction = this.database.raw.prepare(
      `SELECT id, task_id, correction_type FROM correction_event
        WHERE id = ? AND source_event_id = ? AND demand_unit_id = ?
          AND visibility = 'private' AND operation = 'apply'
          AND (? IS NULL OR task_id = ?)
          AND (? IS NULL OR correction_type = 'wrong_association')`,
    ).get(
      correctionId,
      input.sourceEventId,
      input.demandUnitId,
      input.correctionEventId ? (input.correctionTaskId ?? input.gapTaskId) : null,
      input.correctionEventId ? (input.correctionTaskId ?? input.gapTaskId) : null,
      input.correctionEventId ? 1 : null,
    ) as { id: string; task_id: string | null; correction_type: string } | undefined;
    if (!correction) throw new Error('完整性缺口纠正事件未能持久化，已拒绝关闭缺口。');
    const updated = this.database.raw.prepare(
      `UPDATE data_integrity_gap
          SET status = 'corrected', correction_event_id = ?, updated_at = ?
        WHERE id = ?
          AND record_table = 'task_source_link'
          AND record_id = ?
          AND reason = 'missing_or_ambiguous_demand_unit'
          AND status = 'open'
          AND task_id = ?
          AND source_event_id = ?
          AND demand_unit_id IS ?`,
    ).run(
      correction.id,
      input.timestamp,
      gap.id,
      recordId,
      input.gapTaskId,
      input.sourceEventId,
      gap.demand_unit_id,
    );
    if (updated.changes !== 1) {
      const current = this.database.raw.prepare(
        `SELECT id, task_id, source_event_id, demand_unit_id, record_table, record_id, reason,
                status, correction_event_id
           FROM data_integrity_gap
          WHERE id = ?
            AND record_table = 'task_source_link'
            AND record_id = ?
            AND reason = 'missing_or_ambiguous_demand_unit'
            AND task_id = ?
            AND source_event_id = ?
            AND demand_unit_id IS ?`,
      ).get(
        gap.id,
        recordId,
        input.gapTaskId,
        input.sourceEventId,
        gap.demand_unit_id,
      ) as {
        id: string;
        task_id: string | null;
        source_event_id: string | null;
        demand_unit_id: string | null;
        record_table: string;
        record_id: string;
        reason: string;
        status: string;
        correction_event_id: string | null;
      } | undefined;
      if (!current
        || current.id !== gap.id
        || current.task_id !== input.gapTaskId
        || current.source_event_id !== input.sourceEventId
        || (current.demand_unit_id !== null && current.demand_unit_id !== input.demandUnitId)
        || current.record_table !== 'task_source_link'
        || current.record_id !== recordId
        || current.reason !== 'missing_or_ambiguous_demand_unit'
        || current.status !== 'corrected'
        || current.correction_event_id !== correction.id) {
        throw new Error('完整性缺口状态更新失败，已拒绝继续。');
      }
    }
    return correction.id;
  }

  /**
   * Every new task/source edge must name the demand unit it represents.  A
   * source may intentionally support more than one unit, so inference is
   * allowed only when the relation is unique; otherwise the write stops and
   * leaves all business rows unchanged.
   */
  private linkTaskSource(
    taskId: string,
    sourceEventId: string,
    relationType: string,
    timestamp: string,
    explicitDemandUnitId?: string | null,
    options?: { deferIntegrityGapClosure?: boolean },
  ) {
    let demandUnitId = explicitDemandUnitId ?? null;
    const existingRows = this.database.raw.prepare(
      'SELECT demand_unit_id, relation_type FROM task_source_link WHERE task_id = ? AND source_event_id = ? ORDER BY demand_unit_id',
    ).all(taskId, sourceEventId) as Array<{ demand_unit_id: string | null; relation_type: string }>;
    const explicitRows = existingRows.filter((row): row is { demand_unit_id: string; relation_type: string } => row.demand_unit_id !== null);
    if (demandUnitId) {
      const linked = this.database.raw.prepare(
        `SELECT 1 FROM source_demand_unit_source
         WHERE demand_unit_id = ? AND source_event_id = ?`,
      ).get(demandUnitId, sourceEventId);
      if (!linked) throw new Error('需求单元与来源不匹配，已拒绝写入任务来源链。');
      const exact = explicitRows.find((row) => row.demand_unit_id === demandUnitId);
      if (exact) {
        this.database.raw.prepare(
          `UPDATE task_source_link
              SET relation_type = ?
            WHERE task_id = ? AND source_event_id = ? AND demand_unit_id = ?`,
        ).run(relationType, taskId, sourceEventId, demandUnitId);
        return demandUnitId;
      }
      const unresolvedLegacyEdge = existingRows.find((row) => row.demand_unit_id === null);
      // An explicit caller can deterministically repair a sole legacy edge.
      // If another explicit unit already exists, retain the nullable edge as a
      // separate unresolved historical relation instead of choosing a winner.
      if (unresolvedLegacyEdge && explicitRows.length === 0) {
        this.database.raw.prepare(
          `UPDATE task_source_link
              SET demand_unit_id = ?, relation_type = ?
            WHERE task_id = ? AND source_event_id = ? AND demand_unit_id IS NULL`,
        ).run(demandUnitId, relationType, taskId, sourceEventId);
        if (!options?.deferIntegrityGapClosure) {
          this.closeTaskSourceIntegrityGap({
            gapTaskId: taskId,
            sourceEventId,
            resolutionTaskId: taskId,
            demandUnitId,
            timestamp,
          });
        }
        return demandUnitId;
      }
      // Explicit unit edges are additive. An older nullable edge remains as
      // an unresolved historical relation and must not be overwritten.
      this.database.raw.prepare(
        `INSERT INTO task_source_link (task_id, source_event_id, demand_unit_id, relation_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(taskId, sourceEventId, demandUnitId, relationType, timestamp);
      return demandUnitId;
    }
    if (explicitRows.length > 1) {
      throw new Error('任务来源链已经绑定多个需求单元，隐式来源绑定已拒绝。');
    }
    if (explicitRows.length === 1) {
      return explicitRows[0]!.demand_unit_id;
    }
    {
      const sourceScopedRows = this.database.raw.prepare(
        `SELECT DISTINCT source_demand_unit_source.demand_unit_id AS demand_unit_id
           FROM source_demand_unit_source
           JOIN candidate_request
             ON candidate_request.demand_unit_id = source_demand_unit_source.demand_unit_id
            AND candidate_request.accepted_task_id = ?
          WHERE source_demand_unit_source.source_event_id = ?
         UNION
         SELECT DISTINCT source_demand_unit_source.demand_unit_id AS demand_unit_id
           FROM source_demand_unit_source
           JOIN task ON task.id = ?
           JOIN requirement_thread_unit
             ON requirement_thread_unit.thread_id = task.thread_id
            AND requirement_thread_unit.demand_unit_id = source_demand_unit_source.demand_unit_id
          WHERE source_demand_unit_source.source_event_id = ?
         UNION
         SELECT DISTINCT requirement_thread_source.demand_unit_id AS demand_unit_id
           FROM task
           JOIN requirement_thread_source
             ON requirement_thread_source.thread_id = task.thread_id
            AND requirement_thread_source.source_event_id = ?
          WHERE task.id = ?
            AND requirement_thread_source.demand_unit_id IS NOT NULL
         ORDER BY demand_unit_id`,
      ).all(taskId, sourceEventId, taskId, sourceEventId, sourceEventId, taskId) as Array<{ demand_unit_id: string }>;
      const scopedRows = this.database.raw.prepare(
        `SELECT DISTINCT candidate_request.demand_unit_id AS demand_unit_id
           FROM candidate_request
          WHERE candidate_request.accepted_task_id = ?
            AND candidate_request.demand_unit_id IS NOT NULL
         UNION
         SELECT DISTINCT requirement_thread_unit.demand_unit_id AS demand_unit_id
           FROM task
           JOIN requirement_thread_unit ON requirement_thread_unit.thread_id = task.thread_id
          WHERE task.id = ?
            AND requirement_thread_unit.demand_unit_id IS NOT NULL
         ORDER BY demand_unit_id`,
      ).all(taskId, taskId) as Array<{ demand_unit_id: string }>;
      const fallbackRows = sourceScopedRows.length === 0 && scopedRows.length === 0
        ? this.database.raw.prepare(
          'SELECT DISTINCT demand_unit_id FROM source_demand_unit_source WHERE source_event_id = ? ORDER BY demand_unit_id',
        ).all(sourceEventId) as Array<{ demand_unit_id: string }>
        : [];
      const ids = [...new Set((sourceScopedRows.length ? sourceScopedRows : scopedRows.length ? scopedRows : fallbackRows)
        .map((row) => row.demand_unit_id))];
      if (ids.length !== 1) {
        throw new Error(ids.length === 0
          ? '来源没有可唯一确认的需求单元，已拒绝写入任务来源链。'
          : '来源对应多个需求单元，已拒绝随机选择任务来源链。');
      }
      demandUnitId = ids[0]!;
    }
    const unresolvedLegacyEdge = existingRows.find((row) => row.demand_unit_id === null);
    if (unresolvedLegacyEdge) {
      this.database.raw.prepare(
        `UPDATE task_source_link
            SET demand_unit_id = ?, relation_type = ?
          WHERE task_id = ? AND source_event_id = ? AND demand_unit_id IS NULL`,
      ).run(demandUnitId, relationType, taskId, sourceEventId);
      if (!options?.deferIntegrityGapClosure) {
        this.closeTaskSourceIntegrityGap({
          gapTaskId: taskId,
          sourceEventId,
          resolutionTaskId: taskId,
          demandUnitId,
          timestamp,
        });
      }
    } else {
      this.database.raw.prepare(
        `INSERT INTO task_source_link (task_id, demand_unit_id, source_event_id, relation_type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(taskId, demandUnitId, sourceEventId, relationType, timestamp);
    }
    return demandUnitId;
  }

  private linkDemandUnitSources(unitId: string, unit: PersistableClassificationUnit, timestamp = nowIso()) {
    const sourceIds = unit.sourceRows.map((row) => row.id);
    if (sourceIds.length) {
      const placeholders = sourceIds.map(() => '?').join(',');
      this.database.raw.prepare(
        `DELETE FROM source_demand_unit_source
         WHERE demand_unit_id = ?
           AND source_event_id NOT IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1
             FROM task_source_link
             WHERE task_source_link.demand_unit_id = source_demand_unit_source.demand_unit_id
               AND task_source_link.source_event_id = source_demand_unit_source.source_event_id
           )`,
      ).run(unitId, ...sourceIds);
    } else {
      // Keep source pairs that are still referenced by accepted task edges so
      // the composite task↔unit↔source FK preserves the historical audit
      // chain. Unused stale unit pairs can still be removed as before.
      this.database.raw.prepare(
        `DELETE FROM source_demand_unit_source
         WHERE demand_unit_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM task_source_link
             WHERE task_source_link.demand_unit_id = source_demand_unit_source.demand_unit_id
               AND task_source_link.source_event_id = source_demand_unit_source.source_event_id
           )`,
      ).run(unitId);
    }
    const insert = this.database.raw.prepare(
      `INSERT INTO source_demand_unit_source
        (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(demand_unit_id, source_event_id) DO UPDATE SET
         source_key = excluded.source_key,
         source_role = excluded.source_role,
         sequence = excluded.sequence`,
    );
    unit.sourceRows.forEach((row, index) => insert.run(
      unitId,
      row.id,
      unit.sourceKeyById.get(row.id) ?? `s${index + 1}`,
      row.id === unit.anchor.id ? 'anchor' : 'evidence',
      index,
      timestamp,
    ));
  }

  private getCandidatesForSource(sourceEventId: string) {
    return this.database.raw.prepare(
      `SELECT DISTINCT candidate_request.*
       FROM candidate_request
       LEFT JOIN source_demand_unit
         ON source_demand_unit.id = candidate_request.demand_unit_id
       LEFT JOIN source_demand_unit_source
         ON source_demand_unit_source.demand_unit_id = candidate_request.demand_unit_id
       WHERE (candidate_request.source_event_id = ? OR source_demand_unit_source.source_event_id = ?)
         AND (candidate_request.demand_unit_id IS NULL OR source_demand_unit.state <> 'superseded')
       ORDER BY candidate_request.created_at ASC, candidate_request.id ASC`,
    ).all(sourceEventId, sourceEventId) as CandidateRow[];
  }

  private getCandidatesForSources(sourceEventIds: string[]) {
    const ids = [...new Set(sourceEventIds.filter(Boolean))];
    if (!ids.length) return [] as CandidateRow[];
    const placeholders = ids.map(() => '?').join(',');
    return this.database.raw.prepare(
      `SELECT DISTINCT candidate_request.*
       FROM candidate_request
       LEFT JOIN source_demand_unit
         ON source_demand_unit.id = candidate_request.demand_unit_id
       LEFT JOIN source_demand_unit_source
         ON source_demand_unit_source.demand_unit_id = candidate_request.demand_unit_id
       WHERE (candidate_request.source_event_id IN (${placeholders})
          OR source_demand_unit_source.source_event_id IN (${placeholders}))
         AND (candidate_request.demand_unit_id IS NULL OR source_demand_unit.state <> 'superseded')
       ORDER BY candidate_request.created_at ASC, candidate_request.id ASC`,
    ).all(...ids, ...ids) as CandidateRow[];
  }

  private candidateRuntimeFenceForSources(sourceEventIds: string[], additionalCandidateIds: string[] = []): CandidateRuntimeFence[] {
    const candidates = new Map<string, CandidateRow>();
    for (const candidate of this.getCandidatesForSources(sourceEventIds)) candidates.set(candidate.id, candidate);
    for (const candidateId of additionalCandidateIds) {
      const candidate = this.getCandidate(candidateId);
      if (!candidate) continue;
      const root = this.candidateGroupRoot(candidate);
      for (const member of this.candidateGroupRows(root.id)) candidates.set(member.id, member);
    }
    return [...candidates.values()]
      .map((candidate) => ({ candidateId: candidate.id, version: candidate.version }))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  }

  private parseCandidateRuntimeFence(value: unknown): CandidateRuntimeFence[] | null {
    const parsed = candidateRuntimeFenceSchema.safeParse(value);
    return parsed.success && parsed.data.length > 0
      ? [...parsed.data].sort((left, right) => left.candidateId.localeCompare(right.candidateId))
      : null;
  }

  private assertCandidateRuntimeFence(sourceEventIds: string[], expected: CandidateRuntimeFence[]) {
    const actual = this.candidateRuntimeFenceForSources(sourceEventIds, expected.map((row) => row.candidateId));
    if (actual.length !== expected.length || actual.some((row, index) => (
      row.candidateId !== expected[index]?.candidateId || row.version !== expected[index]?.version
    ))) {
      throw new CandidateVersionConflictError();
    }
  }

  private supersedeMissingDemandUnits(sourceEventIds: string[], activeUnitIds: Set<string>, timestamp: string) {
    const ids = [...new Set(sourceEventIds.filter(Boolean))];
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    const previous = this.database.raw.prepare(
      `SELECT DISTINCT source_demand_unit.id
       FROM source_demand_unit
       LEFT JOIN source_demand_unit_source
         ON source_demand_unit_source.demand_unit_id = source_demand_unit.id
       WHERE source_demand_unit.state <> 'superseded'
         AND (source_demand_unit.anchor_source_event_id IN (${placeholders})
              OR source_demand_unit_source.source_event_id IN (${placeholders}))`,
    ).all(...ids, ...ids) as Array<{ id: string }>;
    const staleUnitIds = previous.map((row) => row.id).filter((unitId) => !activeUnitIds.has(unitId));
    for (const unitId of staleUnitIds) {
      const candidate = this.database.raw.prepare('SELECT * FROM candidate_request WHERE demand_unit_id = ?').get(unitId) as CandidateRow | undefined;
      const threads = this.database.raw.prepare(
        `SELECT requirement_thread.*
         FROM requirement_thread
         JOIN requirement_thread_unit ON requirement_thread_unit.thread_id = requirement_thread.id
         WHERE requirement_thread_unit.demand_unit_id = ?`,
      ).all(unitId) as unknown as RequirementThreadRow[];
      this.database.raw.prepare("UPDATE source_demand_unit SET state = 'superseded', updated_at = ? WHERE id = ?").run(timestamp, unitId);
      this.database.raw.prepare(
        `DELETE FROM source_demand_unit_source
         WHERE demand_unit_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM task_source_link
             WHERE task_source_link.demand_unit_id = source_demand_unit_source.demand_unit_id
               AND task_source_link.source_event_id = source_demand_unit_source.source_event_id
           )`,
      ).run(unitId);
      this.database.raw.prepare("UPDATE candidate_revision SET state = 'superseded' WHERE demand_unit_id = ? AND state IN ('current','proposed')").run(unitId);
      this.database.raw.prepare("UPDATE requirement_thread_revision SET state = 'stale', decided_at = ? WHERE demand_unit_id = ? AND state = 'proposed'").run(timestamp, unitId);
      this.database.raw.prepare("UPDATE task_update_proposal SET state = 'stale', decided_at = ? WHERE demand_unit_id = ? AND state = 'awaiting_approval'").run(timestamp, unitId);
      if (candidate && !candidate.accepted_task_id) {
        this.database.raw.prepare('UPDATE notification SET archived_at = COALESCE(archived_at, ?) WHERE candidate_id = ?').run(timestamp, candidate.id);
      }
      for (const thread of threads) {
        if (thread.active_task_id) continue;
        const remaining = this.database.raw.prepare(
          `SELECT COUNT(*) AS count
           FROM requirement_thread_unit
           JOIN source_demand_unit ON source_demand_unit.id = requirement_thread_unit.demand_unit_id
           WHERE requirement_thread_unit.thread_id = ? AND source_demand_unit.state <> 'superseded'`,
        ).get(thread.id) as { count: number };
        if (remaining.count === 0) {
          this.database.raw.prepare("UPDATE requirement_thread SET status = 'closed', updated_at = ? WHERE id = ? AND active_task_id IS NULL").run(timestamp, thread.id);
        }
      }
    }
  }

  /**
   * Resolve a candidate's thread without using the source event as a loose
   * lookup key.  A single source may intentionally belong to several demand
   * units, and therefore several threads.  Unit-bound candidates must resolve
   * through requirement_thread_unit; legacy candidates may use the source only
   * while that source still maps to one unique thread.
   */
  private threadForCandidate(candidate: Pick<CandidateRow, 'demand_unit_id' | 'source_event_id'>) {
    if (candidate.demand_unit_id) {
      const rows = this.database.raw.prepare(
        `SELECT DISTINCT requirement_thread.*
         FROM requirement_thread
         JOIN requirement_thread_unit
           ON requirement_thread_unit.thread_id = requirement_thread.id
         WHERE requirement_thread_unit.demand_unit_id = ?
         ORDER BY requirement_thread.updated_at DESC, requirement_thread.id ASC`,
      ).all(candidate.demand_unit_id) as unknown as RequirementThreadRow[];
      if (rows.length > 1) {
        throw new Error('需求单元对应多个需求线程，数据关系不一致，已停止随机选择。');
      }
      return rows[0];
    }
    const threadId = this.sourceThreadId(candidate.source_event_id);
    return threadId
      ? this.database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(threadId) as unknown as RequirementThreadRow | undefined
      : undefined;
  }

  private sourceRowsForDemandUnit(demandUnitId: string | null, fallback: SourceEventRow) {
    if (!demandUnitId) return [fallback];
    const rows = this.database.raw.prepare(
      `SELECT source_event.*
       FROM source_demand_unit_source
       JOIN source_event ON source_event.id = source_demand_unit_source.source_event_id
       WHERE source_demand_unit_source.demand_unit_id = ?
       ORDER BY source_demand_unit_source.sequence ASC, source_event.occurred_at ASC, source_event.id ASC`,
    ).all(demandUnitId) as SourceEventRow[];
    return rows.length ? rows : [fallback];
  }

  private demandUnitIdsForCandidates(candidates: CandidateRow[]) {
    return [...new Set(candidates.map((candidate) => candidate.demand_unit_id).filter((value): value is string => Boolean(value)))];
  }

  private sourceUsedByOtherThreadUnit(threadId: string, sourceEventId: string, excludedUnitIds: string[]) {
    const exclusions = [...new Set(excludedUnitIds.filter(Boolean))];
    const exclusionSql = exclusions.length ? ` AND requirement_thread_unit.demand_unit_id NOT IN (${exclusions.map(() => '?').join(',')})` : '';
    const row = this.database.raw.prepare(
      `SELECT COUNT(*) AS count
       FROM requirement_thread_unit
       JOIN source_demand_unit_source
         ON source_demand_unit_source.demand_unit_id = requirement_thread_unit.demand_unit_id
       JOIN source_demand_unit
         ON source_demand_unit.id = requirement_thread_unit.demand_unit_id
       WHERE requirement_thread_unit.thread_id = ?
         AND source_demand_unit_source.source_event_id = ?
         AND source_demand_unit.state <> 'superseded'${exclusionSql}`,
    ).get(threadId, sourceEventId, ...exclusions) as { count: number };
    return row.count > 0;
  }

  private sourceUsedByThreadUnits(threadId: string, sourceEventId: string, unitIds: string[]) {
    const ids = [...new Set(unitIds.filter(Boolean))];
    if (!ids.length) return false;
    const row = this.database.raw.prepare(
      `SELECT COUNT(*) AS count
       FROM requirement_thread_unit
       JOIN source_demand_unit_source
         ON source_demand_unit_source.demand_unit_id = requirement_thread_unit.demand_unit_id
       JOIN source_demand_unit
         ON source_demand_unit.id = requirement_thread_unit.demand_unit_id
       WHERE requirement_thread_unit.thread_id = ?
         AND source_demand_unit_source.source_event_id = ?
         AND source_demand_unit.state <> 'superseded'
         AND requirement_thread_unit.demand_unit_id IN (${ids.map(() => '?').join(',')})`,
    ).get(threadId, sourceEventId, ...ids) as { count: number };
    return row.count > 0;
  }

  private moveDemandUnitsToThread(unitIds: string[], sourceThreadId: string, targetThreadId: string, timestamp: string) {
    const ids = [...new Set(unitIds.filter(Boolean))];
    if (!ids.length || sourceThreadId === targetThreadId) return;
    for (const unitId of ids) {
      const relation = this.database.raw.prepare(
        'SELECT * FROM requirement_thread_unit WHERE thread_id = ? AND demand_unit_id = ?',
      ).get(sourceThreadId, unitId) as { relation_type: string; confidence: number | null; evidence_json: string; created_at: string } | undefined;
      if (!relation) throw new Error('需求单元与原需求线程关系不完整，已停止搬迁。');
      this.database.raw.prepare('DELETE FROM requirement_thread_unit WHERE thread_id = ? AND demand_unit_id = ?').run(sourceThreadId, unitId);
      this.database.raw.prepare(
        `INSERT INTO requirement_thread_unit
          (thread_id, demand_unit_id, relation_type, confidence, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, demand_unit_id) DO UPDATE SET
           relation_type = excluded.relation_type,
           confidence = excluded.confidence,
           evidence_json = excluded.evidence_json`,
      ).run(targetThreadId, unitId, relation.relation_type, relation.confidence, relation.evidence_json, relation.created_at || timestamp);
    }
  }


  /**
   * Load a small, bounded recent conversation window as model context. These
   * rows remain evidence only and never become candidates merely because they
   * appear here. Calendar/minutes keep the stricter contextOnly restriction.
   */


  /**
   * Build the small, server-owned target set for a主人消息.  The model may
   * describe the owner's intent, but it never gets to choose a database row.
   * Reply/root/session relations are preferred; a same-conversation match is
   * only safe when it leaves one candidate.
   */

  private recordCandidateIgnoredRetirement(candidate: CandidateRow, timestamp: string, previousState = candidate.state) {
    this.database.raw.prepare(
      `INSERT OR IGNORE INTO correction_event
       (id, idempotency_key, task_id, candidate_id, source_event_id, demand_unit_id, correction_type,
        before_json, after_json, note, visibility, operation, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'candidate_ignored', ?, ?, ?, 'private', 'apply', ?)`,
    ).run(
      id('correction'),
      `candidate-ignore:${candidate.id}:${timestamp}`,
      candidate.id,
      candidate.source_event_id,
      candidate.demand_unit_id,
      JSON.stringify({ candidateId: candidate.id, state: previousState }),
      JSON.stringify({ candidateId: candidate.id, state: 'ignored', retirementAt: timestamp }),
      '候选已被系统主人移出活动范围。',
      timestamp,
    );
  }


  /** Recover the structured owner intent from the durable classification log.
   * The source revision may already be stamped when a process stopped between
   * classification persistence and owner-decision execution. */

  /**
   * Merge several safe owner-side task patches from one turn into one durable
   * owner decision.  Destructive or ambiguous combinations stay in review;
   * only multiple updates to the same active task can be co-applied.
   */

  /**
   * Resolve an explicit stage-1 action to a server-owned thread target. The
   * model may only select from the bounded anonymous context; IDs and version
   * checks are re-established here before any durable relation is written.
   */

  /** Build a sparse-update draft without copying the old thread summary into a new candidate. */

  /**
   * Persist `update_existing`/`context_only`/`uncertain` without manufacturing
   * another inbox candidate. Sources remain durable and can be replayed after
   * a semantic retry; only a validated target receives a thread/task relation.
   */

  private createTaskUpdateProposal(input: {
    task: TaskRecord;
    threadId: string | null;
    sourceEventId: string | null;
    demandUnitId: string | null;
    candidateRevisionId: string | null;
    threadRevisionId: string | null;
    baseThreadVersion: number | null;
    patch: Record<string, unknown>;
    reason: string;
    evidence: unknown;
    provider?: string;
    model?: string;
    promptVersion?: string;
    origin: 'follow_up' | 'owner_association' | 'reprocess' | 'cindy_turn';
    associationConfidence: number | null;
    updateConfidence: number | null;
    usedFallback: boolean;
    idempotencyKey: string;
    createdAt?: string;
  }) {
    const proposalId = id('task-update');
    const timestamp = input.createdAt ?? nowIso();
    this.database.raw.prepare(
      `INSERT OR IGNORE INTO task_update_proposal
        (id, task_id, thread_id, source_event_id, demand_unit_id, candidate_revision_id, thread_revision_id, base_task_version, base_thread_version,
         patch_json, reason, evidence_json, provider, model, prompt_version, state, origin, association_confidence, update_confidence,
         used_fallback, decision_mode, policy_version, policy_reason, idempotency_key, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL)`,
    ).run(
      proposalId,
      input.task.id,
      input.threadId,
      input.sourceEventId,
      input.demandUnitId,
      input.candidateRevisionId,
      input.threadRevisionId,
      input.task.version,
      input.baseThreadVersion,
      JSON.stringify(input.patch),
      input.reason,
      JSON.stringify(input.evidence),
      input.provider ?? 'cindy',
      input.model ?? 'cindy-intake',
      input.promptVersion ?? 'cindy-intake-v1',
      input.origin,
      input.associationConfidence,
      input.updateConfidence,
      input.usedFallback ? 1 : 0,
      AUTO_UPDATE_POLICY_VERSION,
      '等待自动维护策略判断。',
      input.idempotencyKey,
      timestamp,
    );
    return this.database.raw.prepare('SELECT * FROM task_update_proposal WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as unknown as TaskUpdateProposalRow;
  }


  /**
   * Validate the durable relation behind one failure record or one retry job.
   * The source's current revision is deliberately not part of this fence:
   * an older, but internally consistent record is allowed to remain visible
   * as stale.  The original Runtime payload revision is the authoritative
   * relation fence for retry ownership.
   */

  private sourceRowToEvent(sourceRow: SourceEventRow, documentContexts: SourceDocumentContext[] = []): NormalizedSourceEvent {
    return {
      externalId: sourceRow.external_id,
      sourceType: sourceRow.source_type,
      conversationId: sourceRow.conversation_id,
      senderId: sourceRow.sender_id,
      senderName: sourceRow.sender_name,
      content: sourceRow.content,
      occurredAt: sourceRow.occurred_at,
      ownerMentioned: Boolean(sourceRow.owner_mentioned),
      sourceUrl: sourceRow.source_url ?? undefined,
      completeness: sourceRow.completeness,
      discoveryReason: sourceRow.discovery_reason,
      metadata: parseMetadata(sourceRow.metadata_json),
      documentContexts,
    };
  }

  listCandidates(state?: CandidateState, deletedState: CandidateDeletedState = 'active') {
    const select = `SELECT candidate_request.*,
      source_event.source_type,
      source_event.owner_mentioned,
      source_event.completeness AS source_completeness,
      source_event.discovery_reason,
      source_event.metadata_json AS source_metadata_json,
      source_event.source_url,
      source_event.content AS source_content,
      ai_decision_log.reason AS ai_reason,
      ai_decision_log.provider AS ai_provider,
      ai_decision_log.model AS ai_model,
      ai_decision_log.prompt_version
      FROM candidate_request
      JOIN source_event ON source_event.id = candidate_request.source_event_id
      LEFT JOIN source_demand_unit ON source_demand_unit.id = candidate_request.demand_unit_id
      LEFT JOIN ai_decision_log ON ai_decision_log.id = (
        SELECT latest.id FROM ai_decision_log AS latest
        WHERE (candidate_request.demand_unit_id IS NOT NULL AND latest.demand_unit_id = candidate_request.demand_unit_id)
           OR (candidate_request.demand_unit_id IS NULL AND latest.demand_unit_id IS NULL AND latest.source_event_id = source_event.id)
        ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
      )`;
    const clauses: string[] = [];
    const args: string[] = [];
    if (state) {
      clauses.push('candidate_request.state = ?');
      args.push(state);
    }
    if (deletedState === 'active') clauses.push('candidate_request.deleted_at IS NULL');
    if (deletedState === 'only') clauses.push('candidate_request.deleted_at IS NOT NULL');
    clauses.push("(candidate_request.demand_unit_id IS NULL OR source_demand_unit.state <> 'superseded' OR candidate_request.accepted_task_id IS NOT NULL)");
    clauses.push('candidate_request.merged_into_candidate_id IS NULL');
    clauses.push("NOT (candidate_request.title = 'AI 整理待重试' AND candidate_request.confidence = 0 AND candidate_request.background = '' AND candidate_request.validation_question = '' AND candidate_request.describe = '')");
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.raw
      .prepare(`${select}${where} ORDER BY candidate_request.created_at DESC`)
      .all(...args) as Array<CandidateRow & Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      analysis: parseMetadata(row.analysis_json),
      thread_association: null,
      merge_group: this.candidateMergeGroupView(row),
    }));
  }

  listCandidatesPublic(state?: CandidateState, deletedState: CandidateDeletedState = 'active') {
    return this.listCandidates(state, deletedState)
      .map((row) => this.minimalCandidateView(row as CandidateRow & Record<string, unknown>));
  }

  private sourceContentsByIds(sourceIds: Iterable<string>) {
    const ids = [...new Set([...sourceIds].filter((value): value is string => typeof value === 'string' && Boolean(value)))];
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return (this.database.raw.prepare(`SELECT content FROM source_event WHERE id IN (${placeholders}) ORDER BY occurred_at ASC, id ASC`)
      .all(...ids) as Array<{ content: string | null }>)
      .map((row) => typeof row.content === 'string' ? row.content : '')
      .filter(Boolean);
  }

  private addDemandUnitSourceIds(sourceIds: Set<string>, demandUnitId: string | null | undefined) {
    if (!demandUnitId) return;
    const rows = this.database.raw.prepare(
      'SELECT source_event_id FROM source_demand_unit_source WHERE demand_unit_id = ? ORDER BY sequence ASC, source_event_id ASC',
    ).all(demandUnitId) as Array<{ source_event_id: string }>;
    for (const row of rows) sourceIds.add(row.source_event_id);
  }

  private addThreadSourceIds(sourceIds: Set<string>, threadId: string | null | undefined) {
    if (!threadId) return;
    const rows = this.database.raw.prepare(
      `SELECT source_event_id FROM requirement_thread_source WHERE thread_id = ?
       UNION
       SELECT source_demand_unit_source.source_event_id
       FROM requirement_thread_unit
       JOIN source_demand_unit_source ON source_demand_unit_source.demand_unit_id = requirement_thread_unit.demand_unit_id
       WHERE requirement_thread_unit.thread_id = ?`,
    ).all(threadId, threadId) as Array<{ source_event_id: string }>;
    for (const row of rows) sourceIds.add(row.source_event_id);
  }

  private addTaskSourceIds(sourceIds: Set<string>, taskId: string | null | undefined) {
    if (!taskId) return;
    const rows = this.database.raw.prepare(
      `SELECT source_event_id FROM task_source_link WHERE task_id = ?
       UNION
       SELECT source_event_id FROM task_event WHERE task_id = ? AND source_event_id IS NOT NULL
       UNION
       SELECT source_event_id FROM task_update_proposal WHERE task_id = ? AND source_event_id IS NOT NULL
       UNION
       SELECT source_demand_unit_source.source_event_id
       FROM candidate_request
       JOIN source_demand_unit_source ON source_demand_unit_source.demand_unit_id = candidate_request.demand_unit_id
       WHERE candidate_request.accepted_task_id = ?`,
    ).all(taskId, taskId, taskId, taskId) as Array<{ source_event_id: string }>;
    for (const row of rows) sourceIds.add(row.source_event_id);
    const task = this.getTask(taskId);
    if (task?.thread_id) this.addThreadSourceIds(sourceIds, task.thread_id);
  }

  private expandDemandUnitSourceClosure(sourceIds: Set<string>) {
    for (let pass = 0; pass < 32; pass += 1) {
      const before = sourceIds.size;
      const ids = [...sourceIds];
      if (!ids.length) return;
      const sourcePlaceholders = ids.map(() => '?').join(',');
      const units = this.database.raw.prepare(
        `SELECT DISTINCT demand_unit_id
         FROM source_demand_unit_source
         WHERE source_event_id IN (${sourcePlaceholders})`,
      ).all(...ids) as Array<{ demand_unit_id: string }>;
      const unitIds = [...new Set(units.map((row) => row.demand_unit_id).filter(Boolean))];
      if (unitIds.length) {
        const unitPlaceholders = unitIds.map(() => '?').join(',');
        const relatedSources = this.database.raw.prepare(
          `SELECT DISTINCT source_event_id
           FROM source_demand_unit_source
           WHERE demand_unit_id IN (${unitPlaceholders})`,
        ).all(...unitIds) as Array<{ source_event_id: string }>;
        for (const row of relatedSources) sourceIds.add(row.source_event_id);
      }
      if (sourceIds.size === before) return;
    }
  }

  private sourceContentsForCandidateView(row: CandidateRow & Record<string, unknown>) {
    const sourceIds = new Set<string>();
    const addCandidate = (candidateId: string | null | undefined) => {
      if (!candidateId) return;
      const candidate = this.getCandidate(candidateId);
      if (!candidate) return;
      sourceIds.add(candidate.source_event_id);
      this.addDemandUnitSourceIds(sourceIds, candidate.demand_unit_id);
      this.addTaskSourceIds(sourceIds, candidate.accepted_task_id);
      const thread = this.threadForCandidate(candidate);
      if (thread) {
        this.addThreadSourceIds(sourceIds, thread.id);
        this.addTaskSourceIds(sourceIds, thread.active_task_id);
      }
    };
    addCandidate(row.id);
    const merge = this.candidateMergeGroupView(row);
    if (merge) {
      this.addThreadSourceIds(sourceIds, merge.threadId);
      for (const source of merge.sources) {
        sourceIds.add(source.sourceEventId);
        addCandidate(source.candidateId);
      }
      addCandidate(merge.suggestion?.targetCandidateId);
    }
    this.expandDemandUnitSourceClosure(sourceIds);
    return this.sourceContentsByIds(sourceIds);
  }

  private sourceContentsForTask(taskId: string, extraSourceIds: Iterable<string> = []) {
    const sourceIds = new Set<string>(extraSourceIds);
    this.addTaskSourceIds(sourceIds, taskId);
    this.expandDemandUnitSourceClosure(sourceIds);
    return this.sourceContentsByIds(sourceIds);
  }

  private minimalCandidateView(row: CandidateRow & Record<string, unknown>) {
    const sourceContents = this.sourceContentsForCandidateView(row);
    const merge = this.candidateMergeGroupView(row);
    const safeMerge = merge ? {
      threadId: merge.threadId,
      threadVersion: merge.threadVersion,
      groupVersionHash: merge.groupVersionHash,
      mutationVersionHash: merge.mutationVersionHash,
      sourceCount: merge.sourceCount,
      candidateCount: merge.candidateCount,
      primaryCandidateId: merge.primaryCandidateId,
      primaryTitle: safeCandidateNarrative(merge.primaryTitle, sourceContents, '候选主体摘要已保留；来源正文默认隐藏。', 160),
      primaryReason: '当前候选主体已建立受控归并视图。',
      primaryConfidence: merge.primaryConfidence,
      suggestion: merge.suggestion ? {
        suggestionId: merge.suggestion.suggestionId,
        targetCandidateId: merge.suggestion.targetCandidateId,
        targetThreadId: merge.suggestion.targetThreadId,
        confidence: merge.suggestion.confidence,
        primary: merge.suggestion.primary,
        primaryConfidence: merge.suggestion.primaryConfidence,
        currentRole: merge.suggestion.currentRole,
        targetRole: merge.suggestion.targetRole,
        reason: '候选归并建议已保留，需主人确认；来源正文默认隐藏。',
        evidence: [],
        target: merge.suggestion.target ? {
          candidateId: merge.suggestion.target.candidateId,
          title: safeCandidateNarrative(merge.suggestion.target.title, sourceContents, '目标候选摘要已保留；来源正文默认隐藏。', 160),
        } : null,
      } : null,
      sources: merge.sources.map((source) => ({
        sourceScope: sourceScope(row.id, source.sourceEventId),
        version: source.version,
        sourceType: source.sourceType,
        occurredAt: source.occurredAt,
        relationType: source.relationType,
        confidence: source.confidence,
        role: source.role,
        candidateId: source.candidateId,
        title: safeCandidateNarrative(source.title, sourceContents, '来源摘要已保留；正文默认隐藏。', 160),
        isPrimary: source.isPrimary,
      })),
    } : null;
    return minimalCandidateDtoSchema.parse({
      id: row.id,
      version: row.version,
      title: safeCandidateNarrative(row.title, sourceContents, '候选标题已生成；来源正文默认隐藏。', 160),
      // Sender identity is source/provider metadata, not a safe derived
      // summary. Keep the public candidate DTO on a fixed role label; the
      // owner-controlled verification path is the only place that can expose
      // bounded source content.
      proposer_name: '需求方',
      background: safeCandidateNarrative(row.background, sourceContents, '来源背景已保留，需主人主动核验。', 2_000),
      validation_question: safeCandidateNarrative(row.validation_question, sourceContents, '希望验证的问题已保留，需主人主动核验。', 1_000),
      describe: safeCandidateNarrative(row.describe, sourceContents, 'AI 摘要已生成；来源正文默认隐藏。', 2_000),
      confidence: row.confidence,
      state: row.state,
      snoozed_until: row.snoozed_until,
      accepted_task_id: row.accepted_task_id,
      deleted_at: row.deleted_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      source_type: row.source_type,
      ...(parseMetadata(String(row.source_metadata_json ?? '')).sourceKind === 'aily_summary'
        ? { source_kind: 'aily_summary' }
        : {}),
      owner_mentioned: row.owner_mentioned,
      source_completeness: row.source_completeness,
      discovery_reason: '来源已保存，可由系统主人主动核验。',
      source_scope: sourceScope(row.id, row.source_event_id),
      processing_state: row.processing_state,
      processing_error: row.processing_error ? '来源整理失败，等待安全重试。' : null,
      context_state: row.context_state,
      context_reason: row.context_reason
        ? safeCandidateNarrative(row.context_reason, sourceContents, '来源上下文完整性需主人核验。', 300)
        : null,
      recovered_at: row.recovered_at,
      analysis: minimalCandidateAnalysis(parseMetadata(row.analysis_json), sourceContents),
      thread_association: null,
      merge_group: safeMerge,
    });
  }

  listPendingOwnerActions(limit = 20) {
    const rows = this.database.raw.prepare(
      `SELECT owner_decision.id, owner_decision.action, owner_decision.state,
              owner_decision.candidate_id, owner_decision.task_id,
              owner_decision.confidence, owner_decision.schedule_text,
              owner_decision.created_at
       FROM owner_decision
       LEFT JOIN candidate_request ON candidate_request.id = owner_decision.candidate_id
       LEFT JOIN task ON task.id = owner_decision.task_id
       WHERE owner_decision.state IN ('review','failed')
         AND owner_decision.action <> 'uncertain'
         AND owner_decision.rowid = (
           SELECT latest.rowid FROM owner_decision AS latest
           WHERE latest.source_event_id = owner_decision.source_event_id
           ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
         )
         AND (owner_decision.candidate_id IS NULL
              OR (candidate_request.deleted_at IS NULL
                  AND (candidate_request.state IN ('pending','snoozed')
                       OR (candidate_request.state = 'accepted' AND owner_decision.task_id IS NOT NULL))))
         AND (owner_decision.task_id IS NULL OR (task.deleted_at IS NULL AND task.record_state = 'active'))
         AND NOT (owner_decision.action = 'request_context'
                  AND owner_decision.task_id IS NULL
                  AND candidate_request.state IN ('pending','snoozed'))
       ORDER BY owner_decision.created_at DESC
       LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, 50))) as Array<{
      id: string;
      action: OwnerIntentDecision['action'];
      state: 'review' | 'failed';
      candidate_id: string | null;
      task_id: string | null;
      confidence: number;
      schedule_text: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      state: row.state,
      candidateId: row.candidate_id,
      taskId: row.task_id,
      confidence: row.confidence,
      scheduleText: row.schedule_text,
      createdAt: row.created_at,
      message: row.state === 'failed'
        ? '主人动作已经识别，但执行没有完成；来源和判断均已保留，可继续重试。'
        : row.candidate_id
          ? '主人动作已经识别，但未通过自动执行安全检查，等待主人确认。'
          : '主人动作已经识别，但尚未安全关联到唯一候选，因此没有执行。',
    }));
  }

  listPendingOwnerActionsPublic(limit = 20) {
    return this.listPendingOwnerActions(limit).map(({ scheduleText, ...action }) => ({
      ...action,
      scheduleDetected: Boolean(scheduleText?.trim()),
    }));
  }

  private candidateMergeGroupView(candidate: CandidateRow) {
    const thread = this.threadForCandidate(candidate);
    if (!thread) return null;
    let sources = this.database.raw.prepare(
      `SELECT source_event.id AS source_event_id, source_event.external_id, source_event.source_type,
              source_event.sender_name, source_event.content, source_event.occurred_at,
               COALESCE(requirement_thread_source.relation_type, requirement_thread_unit.relation_type) AS relation_type,
               COALESCE(requirement_thread_source.confidence, requirement_thread_unit.confidence) AS confidence,
               COALESCE(requirement_thread_source.source_role, 'unknown') AS source_role,
               COALESCE(requirement_thread_source.role_reason, '') AS role_reason,
               candidate_request.id AS candidate_id, candidate_request.title AS candidate_title,
               candidate_request.merged_into_candidate_id,
               candidate_request.demand_unit_id
        FROM requirement_thread_unit
        JOIN candidate_request ON candidate_request.demand_unit_id = requirement_thread_unit.demand_unit_id
        JOIN source_demand_unit_source ON source_demand_unit_source.demand_unit_id = requirement_thread_unit.demand_unit_id
        JOIN source_event ON source_event.id = source_demand_unit_source.source_event_id
        LEFT JOIN requirement_thread_source
          ON requirement_thread_source.thread_id = requirement_thread_unit.thread_id
         AND requirement_thread_source.source_event_id = source_event.id
        WHERE requirement_thread_unit.thread_id = ?
        ORDER BY source_event.occurred_at ASC, source_event.id ASC, candidate_request.id ASC`,
    ).all(thread.id) as Array<{
      source_event_id: string;
      external_id: string;
      source_type: string;
      sender_name: string;
      content: string;
      occurred_at: string;
      relation_type: string;
      confidence: number | null;
      source_role: string;
      role_reason: string;
      candidate_id: string | null;
      candidate_title: string | null;
      merged_into_candidate_id: string | null;
      demand_unit_id: string | null;
    }>;
    if (!sources.length) {
      sources = this.database.raw.prepare(
        `SELECT source_event.id AS source_event_id, source_event.external_id, source_event.source_type,
                source_event.sender_name, source_event.content, source_event.occurred_at,
                requirement_thread_source.relation_type, requirement_thread_source.confidence,
                requirement_thread_source.source_role, requirement_thread_source.role_reason,
                candidate_request.id AS candidate_id, candidate_request.title AS candidate_title,
                candidate_request.merged_into_candidate_id, candidate_request.demand_unit_id
         FROM requirement_thread_source
         JOIN source_event ON source_event.id = requirement_thread_source.source_event_id
         LEFT JOIN candidate_request ON candidate_request.source_event_id = source_event.id
         WHERE requirement_thread_source.thread_id = ?
         ORDER BY source_event.occurred_at ASC, source_event.id ASC`,
      ).all(thread.id) as typeof sources;
    }
    const activeCandidateSources = sources.filter((source) => source.candidate_id);
    const primaryCandidate = activeCandidateSources.find((source) => source.source_event_id === thread.primary_source_event_id)
      ?? activeCandidateSources.find((source) => source.candidate_id === candidate.id)
      ?? null;
    const suggestionValue = parseMetadata(candidate.analysis_json).candidateMergeSuggestion;
    const suggestionRecord = suggestionValue && typeof suggestionValue === 'object'
      ? suggestionValue as Record<string, unknown>
      : null;
    const suggestionTargetId = typeof suggestionRecord?.targetCandidateId === 'string' ? suggestionRecord.targetCandidateId : null;
    const suggestionTarget = suggestionTargetId ? this.getCandidate(suggestionTargetId) : null;
    const suggestionTargetThread = suggestionTarget ? this.threadForCandidate(suggestionTarget) : null;
    const suggestion = suggestionTarget && suggestionTargetThread && suggestionRecord
      && this.candidateMergeSuggestionMatches(suggestionRecord, candidate, thread, suggestionTarget, suggestionTargetThread)
      ? suggestionRecord
      : null;
    const suggestionTargetView = suggestionTarget && suggestion ? {
      candidateId: suggestionTarget.id,
      version: suggestionTarget.version,
      title: suggestionTarget.title,
      proposerName: suggestionTarget.proposer_name,
      occurredAt: (this.database.raw.prepare('SELECT occurred_at FROM source_event WHERE id = ?').get(suggestionTarget.source_event_id) as { occurred_at?: string } | undefined)?.occurred_at ?? null,
    } : null;
    const groupRows = this.candidateGroupRows(this.candidateGroupRoot(candidate).id);
    const mutationVersionHash = suggestionTarget
      ? candidatePairVersionHash(candidate, suggestionTarget)
      : candidateGroupVersionHash(groupRows);
    return {
      threadId: thread.id,
      threadVersion: thread.version,
      groupVersionHash: candidateGroupVersionHash(groupRows),
      mutationVersionHash,
      sourceCount: sources.length,
      candidateCount: activeCandidateSources.length,
      primaryCandidateId: primaryCandidate?.candidate_id ?? candidate.id,
      primarySourceEventId: thread.primary_source_event_id ?? candidate.source_event_id,
      primaryTitle: primaryCandidate?.candidate_title ?? candidate.title,
      primaryReason: thread.primary_reason || '当前候选暂作为主体，等待主人确认。',
      primaryConfidence: thread.primary_confidence,
      suggestion: suggestion ? {
        suggestionId: suggestion.suggestionId as string,
        targetCandidateId: suggestionTarget!.id,
        targetThreadId: suggestionTargetThread!.id,
        confidence: typeof suggestion.confidence === 'number' ? suggestion.confidence : null,
        primary: suggestion.primary === 'current' || suggestion.primary === 'target' ? suggestion.primary : null,
        primaryConfidence: typeof suggestion.primaryConfidence === 'number' ? suggestion.primaryConfidence : null,
        currentRole: typeof suggestion.currentRole === 'string' ? suggestion.currentRole : null,
        targetRole: typeof suggestion.targetRole === 'string' ? suggestion.targetRole : null,
        reason: typeof suggestion.reason === 'string' ? suggestion.reason : '',
        evidence: Array.isArray(suggestion.evidence) ? suggestion.evidence.filter((value): value is string => typeof value === 'string') : [],
        candidateSetHash: typeof suggestion.candidateSetHash === 'string' ? suggestion.candidateSetHash : '',
        target: suggestionTargetView,
      } : null,
      sources: sources.map((source) => ({
        sourceEventId: source.source_event_id,
        version: source.candidate_id ? (this.getCandidate(source.candidate_id)?.version ?? 1) : 1,
        externalId: source.external_id,
        sourceType: source.source_type,
        senderName: projectUntrustedSenderName(source.sender_name),
        content: source.content,
        occurredAt: source.occurred_at,
        relationType: source.relation_type,
        confidence: source.confidence,
        role: source.source_role || 'unknown',
        roleReason: source.role_reason || '',
        candidateId: source.candidate_id,
        demandUnitId: source.demand_unit_id,
        title: source.candidate_title,
        isPrimary: source.source_event_id === (thread.primary_source_event_id ?? candidate.source_event_id),
      })),
    };
  }

  getCandidate(candidateId: string) {
    return (this.database.raw.prepare('SELECT * FROM candidate_request WHERE id = ?').get(candidateId) as CandidateRow) ?? null;
  }

  candidateVersionDto(candidateId: string) {
    const candidate = this.getCandidate(candidateId);
    return candidate ? {
      id: candidate.id,
      version: candidate.version,
      state: candidate.state,
      processing_state: candidate.processing_state,
      deleted_at: candidate.deleted_at,
      accepted_task_id: candidate.accepted_task_id,
      updated_at: candidate.updated_at,
    } : null;
  }

  /** Return the same canonical candidate projection used by the inbox after a mutation. */
  candidateCanonicalDto(candidateId: string) {
    return this.listCandidates(undefined, 'all').find((candidate) => candidate.id === candidateId)
      ?? this.candidateVersionDto(candidateId);
  }

  /** Replace candidate mutation payloads with canonical candidate/group state before they reach clients. */
  candidateMutationCanonical(payload: unknown) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    const result = { ...(payload as Record<string, unknown>) };
    for (const key of ['candidate', 'splitCandidate', 'remainingCandidate', 'targetCandidate']) {
      const value = result[key];
      if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') continue;
      result[key] = this.candidateCanonicalDto((value as { id: string }).id);
    }
    return result;
  }

  candidateVersionFenceForSource(sourceEventId: string, expectedVersion: number) {
    const candidates = this.getCandidatesForSources([sourceEventId]);
    if (candidates.length !== 1) return null;
    return { candidateId: candidates[0]!.id, expectedVersion };
  }

  candidateVersionDtoForSource(sourceEventId: string) {
    const candidates = this.getCandidatesForSources([sourceEventId]);
    return candidates.length === 1 ? this.candidateVersionDto(candidates[0]!.id) : null;
  }

  private candidateGroupRoot(candidate: CandidateRow) {
    if (!candidate.merged_into_candidate_id) return candidate;
    const root = this.getCandidate(candidate.merged_into_candidate_id);
    if (!root || root.merged_into_candidate_id) throw new Error('候选归并关系已损坏，请先刷新或导出诊断。');
    return root;
  }

  private clearCandidateMergeSuggestion(candidateIds: string[], timestamp = nowIso()) {
    for (const candidateId of candidateIds) {
      const candidate = this.getCandidate(candidateId);
      if (!candidate) continue;
      const analysis = parseMetadata(candidate.analysis_json);
      if (!Object.prototype.hasOwnProperty.call(analysis, 'candidateMergeSuggestion')) continue;
      delete analysis.candidateMergeSuggestion;
      const updated = this.database.raw.prepare('UPDATE candidate_request SET analysis_json = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
        .run(JSON.stringify(analysis), timestamp, candidateId, candidate.version);
      if (updated.changes !== 1) throw new CandidateVersionConflictError();
    }
  }

  private assertCandidateActive(candidate: CandidateRow) {
    if (candidate.deleted_at) throw new Error('回收站中的候选只能恢复，不能继续操作。');
  }

  private assertCandidateVersion(candidate: CandidateRow, expectedVersion?: number) {
    if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion <= 0 || expectedVersion !== candidate.version) {
      throw new CandidateVersionConflictError();
    }
  }

  private assertCandidateGroupSnapshot(expectedGroup: CandidateRow[], actualGroup: CandidateRow[], expectedGroupVersionHash?: string) {
    const sameSnapshot = expectedGroup.length === actualGroup.length
      && expectedGroup.every((expected, index) => {
        const actual = actualGroup[index];
        if (!actual) return false;
        return actual.id === expected.id
          && actual.version === expected.version
          && actual.updated_at === expected.updated_at
          && actual.merged_into_candidate_id === expected.merged_into_candidate_id
          && actual.accepted_task_id === expected.accepted_task_id
          && actual.deleted_at === expected.deleted_at;
      });
    if (!sameSnapshot || (expectedGroup.length > 1 && candidateGroupVersionHash(actualGroup) !== expectedGroupVersionHash)) {
      throw new CandidateVersionConflictError();
    }
  }

  private updateCandidateGroupDeletedStateInTransaction(
    groupSnapshot: CandidateRow[],
    rootCandidateId: string,
    timestamp: string,
    deletedAt: string | null,
  ) {
    const restoring = deletedAt === null;
    for (const member of groupSnapshot) {
      const isRoot = member.id === rootCandidateId;
      const relationPredicate = isRoot
        ? 'merged_into_candidate_id IS NULL'
        : 'merged_into_candidate_id = ?';
      const query = restoring
        ? `UPDATE candidate_request
           SET deleted_at = NULL, updated_at = ?, version = version + 1
           WHERE id = ? AND ${relationPredicate} AND accepted_task_id IS NULL
             AND version = ? AND deleted_at IS NOT NULL`
        : `UPDATE candidate_request
           SET deleted_at = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND ${relationPredicate} AND accepted_task_id IS NULL
             AND version = ? AND deleted_at IS NULL`;
      const params = isRoot
        ? (restoring ? [timestamp, member.id, member.version] : [deletedAt, timestamp, member.id, member.version])
        : (restoring ? [timestamp, member.id, rootCandidateId, member.version] : [deletedAt, timestamp, member.id, rootCandidateId, member.version]);
      const updated = this.database.raw.prepare(query).run(...params);
      if (updated.changes !== 1) throw new CandidateVersionConflictError();
    }
    const candidateIds = groupSnapshot.map((member) => member.id);
    this.database.raw.prepare(
      `UPDATE notification
       SET archived_at = COALESCE(archived_at, ?)
       WHERE candidate_id IN (${candidateIds.map(() => '?').join(',')})`,
    ).run(timestamp, ...candidateIds);
  }

  private deleteLinkedCandidatesInTransaction(taskId: string, timestamp: string) {
    const linked = this.database.raw.prepare(
      'SELECT id, version FROM candidate_request WHERE accepted_task_id = ? AND deleted_at IS NULL ORDER BY id',
    ).all(taskId) as Array<{ id: string; version: number }>;
    for (const candidate of linked) {
      const updated = this.database.raw.prepare(
        'UPDATE candidate_request SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND accepted_task_id = ? AND version = ? AND deleted_at IS NULL',
      ).run(timestamp, timestamp, candidate.id, taskId, candidate.version);
      if (updated.changes !== 1) throw new CandidateVersionConflictError();
    }
    this.database.raw.prepare(
      'UPDATE notification SET archived_at = COALESCE(archived_at, ?) WHERE candidate_id IN (SELECT id FROM candidate_request WHERE accepted_task_id = ?)',
    ).run(timestamp, taskId);
  }

  private restoreLinkedCandidatesInTransaction(taskId: string, timestamp: string) {
    const linked = this.database.raw.prepare(
      'SELECT id, version FROM candidate_request WHERE accepted_task_id = ? AND deleted_at IS NOT NULL ORDER BY id',
    ).all(taskId) as Array<{ id: string; version: number }>;
    for (const candidate of linked) {
      const updated = this.database.raw.prepare(
        'UPDATE candidate_request SET deleted_at = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND accepted_task_id = ? AND version = ? AND deleted_at IS NOT NULL',
      ).run(timestamp, candidate.id, taskId, candidate.version);
      if (updated.changes !== 1) throw new CandidateVersionConflictError();
    }
  }

  /**
   * M1 keeps approval/outbox rows as audit facts, but a task lifecycle change
   * must make every still-open draft terminal in the same SQLite transaction.
   * The database enum remains backward compatible; the public DTO exposes the
   * draft-only `rejected`/`obsolete` state instead of implying delivery.
   */
  private terminateTaskDraftsInTransaction(taskId: string, timestamp: string) {
    this.database.raw.prepare(
      "UPDATE approval SET status = 'rejected', decided_at = COALESCE(decided_at, ?) WHERE task_id = ? AND status = 'awaiting_approval'",
    ).run(timestamp, taskId);
    this.database.raw.prepare(
      "UPDATE outbox SET status = 'failed' WHERE approval_id IN (SELECT id FROM approval WHERE task_id = ?) AND status IN ('awaiting_approval', 'ready')",
    ).run(taskId);
  }

  private deleteTaskInTransaction(task: TaskRecord, timestamp: string) {
    const nextVersion = task.version + 1;
    const updated = this.database.raw
      .prepare('UPDATE task SET deleted_at = ?, updated_at = ?, version = ? WHERE id = ? AND version = ? AND deleted_at IS NULL')
      .run(timestamp, timestamp, nextVersion, task.id, task.version);
    if (updated.changes !== 1) throw new Error('任务已被其他操作更新，请刷新后重试。');

    this.database.raw.prepare("UPDATE notification SET archived_at = COALESCE(archived_at, ?) WHERE task_id = ?").run(timestamp, task.id);
    this.database.raw.prepare("UPDATE reminder SET state = 'cancelled' WHERE task_id = ? AND state <> 'cancelled'").run(task.id);
    this.terminateTaskDraftsInTransaction(task.id, timestamp);
    this.database.raw.prepare(
      `INSERT INTO task_event
        (id, task_id, event_type, actor_type, visibility, summary, source_event_id, before_json, after_json, occurred_at, recorded_at, version)
       VALUES (?, ?, 'task_deleted', 'user', 'private', ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      id('evt'), task.id,
      '系统主人将任务和对应的已接受候选一起移到回收站；来源、参考路径和审计历史继续保留。',
      JSON.stringify(taskAuditSnapshot(task)),
      JSON.stringify({ ...taskAuditSnapshot(task), deleted_at: timestamp, version: nextVersion }),
      timestamp, timestamp, nextVersion,
    );
  }

  private restoreTaskInTransaction(task: TaskRecord, timestamp: string) {
    const nextVersion = task.version + 1;
    const updated = this.database.raw
      .prepare('UPDATE task SET deleted_at = NULL, updated_at = ?, version = ? WHERE id = ? AND version = ? AND deleted_at IS NOT NULL')
      .run(timestamp, nextVersion, task.id, task.version);
    if (updated.changes !== 1) throw new Error('任务已被其他操作更新，请刷新后重试。');
    this.database.raw.prepare(
      `INSERT INTO task_event
        (id, task_id, event_type, actor_type, visibility, summary, source_event_id, before_json, after_json, occurred_at, recorded_at, version)
       VALUES (?, ?, 'task_restored', 'user', 'private', ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      id('evt'), task.id,
      '系统主人从回收站恢复了任务和对应的已接受候选；此前作废的对外草稿不会自动恢复。',
      JSON.stringify(taskAuditSnapshot(task)),
      JSON.stringify({ ...taskAuditSnapshot(task), deleted_at: null, version: nextVersion }),
      timestamp, timestamp, nextVersion,
    );
  }

  deleteCandidate(candidateId: string, expectedVersion: number, expectedGroupVersionHash?: string) {
    const requested = this.getCandidate(candidateId);
    if (!requested) throw new Error('候选需求不存在。');
    const candidate = this.candidateGroupRoot(requested);
    const group = this.candidateGroupRows(candidate.id);
    if (group.length > 1 && candidateGroupVersionHash(group) !== expectedGroupVersionHash) throw new CandidateVersionConflictError();
    this.assertCandidateVersion(requested, expectedVersion);
    const linkedTask = candidate.accepted_task_id ? this.getTask(candidate.accepted_task_id) : null;
    const timestamp = nowIso();
    const deleted = this.database.transaction(() => {
      const currentRequested = this.getCandidate(candidateId);
      if (!currentRequested) throw new Error('候选需求不存在。');
      const current = this.candidateGroupRoot(currentRequested);
      const currentGroup = this.candidateGroupRows(current.id);
      if (current.id !== candidate.id) throw new CandidateVersionConflictError();
      this.assertCandidateGroupSnapshot(group, currentGroup, expectedGroupVersionHash);
      this.assertCandidateVersion(currentRequested, expectedVersion);
      const allDeleted = currentGroup.every((member) => Boolean(member.deleted_at));
      const allActive = currentGroup.every((member) => !member.deleted_at);
      if (!allDeleted && !allActive) throw new CandidateVersionConflictError();
      const currentLinkedTask = current.accepted_task_id ? this.getTask(current.accepted_task_id) : null;
      if (currentLinkedTask && currentLinkedTask.record_state === 'active') {
        if (!currentLinkedTask.deleted_at) this.deleteTaskInTransaction(currentLinkedTask, timestamp);
        this.deleteLinkedCandidatesInTransaction(currentLinkedTask.id, timestamp);
      } else if (allDeleted) {
        return current;
      } else {
        this.updateCandidateGroupDeletedStateInTransaction(currentGroup, current.id, timestamp, timestamp);
        this.closeUnassignedThreadForCandidate({ ...current, deleted_at: timestamp }, timestamp);
      }
      return this.getCandidate(current.id);
    });
    if (linkedTask?.record_state === 'active') this.projectTaskMemory(linkedTask.id);
    this.log('runtime', 'info', 'candidate.deleted', '系统主人将候选移入回收站。', { candidateId, acceptedTaskId: candidate.accepted_task_id });
    return deleted;
  }

  restoreCandidate(candidateId: string, expectedVersion: number, expectedGroupVersionHash?: string) {
    const requested = this.getCandidate(candidateId);
    if (!requested) throw new Error('候选需求不存在。');
    const candidate = this.candidateGroupRoot(requested);
    const group = this.candidateGroupRows(candidate.id);
    if (group.length > 1 && candidateGroupVersionHash(group) !== expectedGroupVersionHash) throw new CandidateVersionConflictError();
    this.assertCandidateVersion(requested, expectedVersion);
    const linkedTask = candidate.accepted_task_id ? this.getTask(candidate.accepted_task_id) : null;
    const timestamp = nowIso();
    const restored = this.database.transaction(() => {
      const currentRequested = this.getCandidate(candidateId);
      if (!currentRequested) throw new Error('候选需求不存在。');
      const current = this.candidateGroupRoot(currentRequested);
      const currentGroup = this.candidateGroupRows(current.id);
      if (current.id !== candidate.id) throw new CandidateVersionConflictError();
      this.assertCandidateGroupSnapshot(group, currentGroup, expectedGroupVersionHash);
      this.assertCandidateVersion(currentRequested, expectedVersion);
      const allDeleted = currentGroup.every((member) => Boolean(member.deleted_at));
      const allActive = currentGroup.every((member) => !member.deleted_at);
      if (!allDeleted && !allActive) throw new CandidateVersionConflictError();
      const currentLinkedTask = current.accepted_task_id ? this.getTask(current.accepted_task_id) : null;
      if (currentLinkedTask && currentLinkedTask.record_state === 'active') {
        if (currentLinkedTask.deleted_at) this.restoreTaskInTransaction(currentLinkedTask, timestamp);
        this.restoreLinkedCandidatesInTransaction(currentLinkedTask.id, timestamp);
      } else if (allActive) {
        return current;
      } else {
        this.updateCandidateGroupDeletedStateInTransaction(currentGroup, current.id, timestamp, null);
      }
      return this.getCandidate(current.id);
    });
    if (linkedTask?.record_state === 'active') this.projectTaskMemory(linkedTask.id);
    this.log('runtime', 'info', 'candidate.restored', '系统主人从回收站恢复候选。', { candidateId, acceptedTaskId: candidate.accepted_task_id });
    return restored;
  }

  confirmCandidateMerge(candidateId: string, targetCandidateId: string, primaryCandidateId: string, suggestionId: string, expectedThreadVersion: number, expectedVersion: number, expectedTargetVersion: number, expectedGroupVersionHash: string) {
    return this.database.transaction(() => {
      const currentRequested = this.getCandidate(candidateId);
      const targetRequested = this.getCandidate(targetCandidateId);
      if (!currentRequested || !targetRequested) throw new Error('候选需求不存在。');
      this.assertCandidateVersion(currentRequested, expectedVersion);
      this.assertCandidateVersion(targetRequested, expectedTargetVersion);
      if (candidatePairVersionHash(currentRequested, targetRequested) !== expectedGroupVersionHash) throw new CandidateVersionConflictError();
      const analysis = parseMetadata(currentRequested.analysis_json);
      const suggestion = analysis.candidateMergeSuggestion;
      if (!suggestion || typeof suggestion !== 'object') throw new Error('当前候选没有可确认的归并建议。');
      const suggestionRecord = suggestion as Record<string, unknown>;
      if (suggestionRecord.suggestionId !== suggestionId) throw new Error('归并建议已经更新，请刷新后重新判断。');
       const currentThread = this.threadForCandidate(currentRequested);
       const targetThread = this.threadForCandidate(targetRequested);
      if (currentThread?.version !== expectedThreadVersion) throw new Error('候选需求已经变化，请刷新后重新确认。');
      if (!currentThread || !targetThread
        || !this.candidateMergeSuggestionMatches(suggestionRecord, currentRequested, currentThread, targetRequested, targetThread)) {
        throw new Error('归并建议生成后候选或需求线程已经变化，请刷新后重新判断。');
      }
      const current = currentRequested;
      const target = targetRequested;
      if (current.id === target.id) throw new Error('归并建议目标无效，请刷新后重试。');
      if (primaryCandidateId !== current.id && primaryCandidateId !== target.id) throw new Error('主体必须是本次归并的两个候选之一。');
      const currentRole = typeof suggestionRecord.currentRole === 'string' ? suggestionRecord.currentRole : 'unknown';
      const targetRole = typeof suggestionRecord.targetRole === 'string' ? suggestionRecord.targetRole : 'unknown';
      const allowedRoles = new Set(['owner_delivery', 'background', 'constraint', 'process_question', 'unknown']);
      const decision: CandidateMergeDecision = {
        targetCandidateId: target.id,
        targetThreadId: targetThread.id,
        sameRequirement: true,
        confidence: typeof suggestionRecord.confidence === 'number' ? suggestionRecord.confidence : 1,
        scores: [],
        primary: primaryCandidateId === current.id ? 'current' : 'target',
        primaryConfidence: 1,
        currentRole: allowedRoles.has(currentRole) ? currentRole as CandidateMergeDecision['currentRole'] : 'unknown',
        targetRole: allowedRoles.has(targetRole) ? targetRole as CandidateMergeDecision['targetRole'] : 'unknown',
        reason: typeof suggestionRecord.reason === 'string' ? suggestionRecord.reason : '系统主人确认两条候选属于同一需求。',
        evidence: Array.isArray(suggestionRecord.evidence) ? suggestionRecord.evidence.filter((value): value is string => typeof value === 'string') : [],
        candidateSetHash: typeof suggestionRecord.candidateSetHash === 'string' ? suggestionRecord.candidateSetHash : `owner:${current.id}:${target.id}`,
        candidateSetComplete: true,
      };
      if (decision.primary === 'current') decision.currentRole = 'owner_delivery';
      else decision.targetRole = 'owner_delivery';
      const applied = this.applyCandidateMerge({
        currentCandidate: current,
        currentThread,
        targetCandidate: target,
        targetThread,
        decision,
        actor: 'user',
        reason: `系统主人确认两条消息属于同一需求，并选择“${this.getCandidate(primaryCandidateId)?.title ?? '当前候选'}”作为主体。`,
      });
      this.clearCandidateMergeSuggestion(this.candidateGroupRows(applied.primaryCandidate.id).map((candidate) => candidate.id));
      return { candidate: this.getCandidate(applied.primaryCandidate.id), mergeGroup: this.candidateMergeGroupView(applied.primaryCandidate) };
    });
  }

  rejectCandidateMerge(candidateId: string, targetCandidateId: string, suggestionId: string, expectedVersion: number, expectedTargetVersion: number, expectedGroupVersionHash: string) {
    return this.database.transaction(() => {
      const candidate = this.getCandidate(candidateId);
      const target = this.getCandidate(targetCandidateId);
      if (!candidate || !target) throw new Error('候选需求不存在。');
      this.assertCandidateVersion(candidate, expectedVersion);
      this.assertCandidateVersion(target, expectedTargetVersion);
      if (candidatePairVersionHash(candidate, target) !== expectedGroupVersionHash) throw new CandidateVersionConflictError();
      const analysis = parseMetadata(candidate.analysis_json);
      const suggestion = analysis.candidateMergeSuggestion;
      if (!suggestion || typeof suggestion !== 'object') throw new Error('当前候选没有可否决的归并建议。');
      const suggestionRecord = suggestion as Record<string, unknown>;
      if (suggestionRecord.suggestionId !== suggestionId) throw new Error('归并建议已经更新，请刷新后重新判断。');
       const candidateThread = this.threadForCandidate(candidate);
       const targetThread = this.threadForCandidate(target);
      if (!candidateThread || !targetThread
        || !this.candidateMergeSuggestionMatches(suggestionRecord, candidate, candidateThread, target, targetThread)) {
        throw new Error('归并建议生成后候选或需求线程已经变化，请刷新后重新判断。');
      }
      const timestamp = nowIso();
      this.recordCandidateMergeExclusion(candidate, target, '系统主人明确确认这两项需要分别推进。', timestamp);
      delete analysis.candidateMergeSuggestion;
      const rejectedUpdate = this.database.raw.prepare('UPDATE candidate_request SET analysis_json = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
        .run(JSON.stringify(analysis), timestamp, candidate.id, candidate.version);
      if (rejectedUpdate.changes !== 1) throw new CandidateVersionConflictError();
      this.database.raw.prepare(
        `INSERT INTO correction_event
          (id, idempotency_key, task_id, candidate_id, source_event_id, demand_unit_id, correction_type,
           before_json, after_json, note, visibility, operation, created_at)
          VALUES (?, ?, NULL, ?, ?, ?, 'candidate_merge_rejected', ?, ?, ?, 'private', 'apply', ?)`,
      ).run(
        id('correction'),
        `candidate-merge-rejected:${candidate.id}:${target.id}:${candidate.updated_at}`,
        candidate.id,
        candidate.source_event_id,
        candidate.demand_unit_id,
        JSON.stringify({ targetCandidateId: target.id, suggestion: suggestionRecord }),
        JSON.stringify({ targetCandidateId: null, separateCandidates: true }),
        '系统主人确认这两条候选需要分别推进。',
        timestamp,
      );
      this.log('runtime', 'info', 'candidate.merge_rejected', '系统主人确认两条候选不是同一需求。', {
        candidateId: candidate.id,
        targetCandidateId: target.id,
      });
      return { candidate: this.getCandidate(candidate.id), targetCandidate: this.getCandidate(target.id), separateCandidates: true };
    });
  }

  setCandidateMergePrimary(candidateId: string, primaryCandidateId: string, expectedVersion: number, expectedGroupVersionHash: string, expectedThreadVersion: number) {
    return this.database.transaction(() => {
      const requested = this.getCandidate(candidateId);
      const selected = this.getCandidate(primaryCandidateId);
      if (!requested || !selected) throw new Error('候选需求不存在。');
      this.assertCandidateVersion(requested, expectedVersion);
      const root = this.candidateGroupRoot(requested);
      const selectedRoot = this.candidateGroupRoot(selected);
      if (selectedRoot.id !== root.id) throw new Error('所选主体不属于当前候选组。');
      const members = this.candidateGroupRows(root.id);
      if (members.length > 1 && candidateGroupVersionHash(members) !== expectedGroupVersionHash) throw new CandidateVersionConflictError();
      if (members.length < 2) throw new Error('当前候选没有已归并的其他来源。');
      if (members.some((member) => member.deleted_at || member.accepted_task_id || member.state === 'accepted')) {
        throw new Error('候选组已经被接受或移入回收站，不能更换主体。');
      }
      if (!members.some((member) => member.id === selected.id)) throw new Error('所选主体不属于当前候选组。');
      const thread = this.threadForCandidate(root);
      if (!thread || thread.active_task_id || thread.status === 'closed') throw new Error('候选线程已经变化，不能更换主体。');
      if (thread.version !== expectedThreadVersion) throw new CandidateVersionConflictError();
      if (selected.id === root.id) return { candidate: root, mergeGroup: this.candidateMergeGroupView(root) };
      const timestamp = nowIso();
      for (const member of members) {
        if (member.id === selected.id) {
          const updated = this.database.raw.prepare('UPDATE candidate_request SET merged_into_candidate_id = NULL, merged_at = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
            .run(timestamp, member.id, member.version);
          if (updated.changes !== 1) throw new CandidateVersionConflictError();
        } else {
          const updated = this.database.raw.prepare('UPDATE candidate_request SET merged_into_candidate_id = ?, merged_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
            .run(selected.id, timestamp, timestamp, member.id, member.version);
          if (updated.changes !== 1) throw new CandidateVersionConflictError();
          this.database.raw.prepare('UPDATE notification SET archived_at = COALESCE(archived_at, ?) WHERE candidate_id = ?')
            .run(timestamp, member.id);
        }
      }
      this.database.raw.prepare(
        `UPDATE requirement_thread_source
         SET source_role = CASE WHEN source_event_id = ? THEN 'owner_delivery'
                                WHEN source_event_id = ? AND source_role = 'owner_delivery' THEN 'unknown'
                                ELSE source_role END,
             role_reason = CASE WHEN source_event_id = ? THEN ? ELSE role_reason END
         WHERE thread_id = ?`,
      ).run(selected.source_event_id, root.source_event_id, selected.source_event_id, '系统主人明确选择这条来源作为需要推进的主体任务。', thread.id);
      const threadUpdate = this.database.raw.prepare(
        `UPDATE requirement_thread
         SET title = ?, background = ?, validation_question = ?, describe = ?, analysis_json = ?,
             primary_source_event_id = ?, primary_reason = ?, primary_confidence = 1,
             version = version + 1, updated_at = ?
         WHERE id = ? AND active_task_id IS NULL AND version = ?`,
      ).run(
        selected.title,
        selected.background,
        selected.validation_question,
        selected.describe,
        selected.analysis_json,
        selected.source_event_id,
        `系统主人将“${selected.title}”设为本需求的主体任务。`,
        timestamp,
        thread.id,
        expectedThreadVersion,
      );
      if (threadUpdate.changes !== 1) throw new CandidateVersionConflictError();
      this.database.raw.prepare(
        `INSERT INTO correction_event
          (id, idempotency_key, task_id, candidate_id, source_event_id, demand_unit_id, correction_type,
           before_json, after_json, note, visibility, operation, created_at)
          VALUES (?, ?, NULL, ?, ?, ?, 'candidate_primary_changed', ?, ?, ?, 'private', 'apply', ?)`,
      ).run(
        id('correction'),
        `candidate-primary:${root.id}:${selected.id}:${thread.version}`,
        selected.id,
        selected.source_event_id,
        selected.demand_unit_id,
        JSON.stringify({ primaryCandidateId: root.id, primarySourceEventId: thread.primary_source_event_id }),
        JSON.stringify({ primaryCandidateId: selected.id, primarySourceEventId: selected.source_event_id }),
        '系统主人更换了归并候选的主体任务。',
        timestamp,
      );
      this.database.raw.prepare(
        `INSERT OR IGNORE INTO notification
          (id, task_id, task_event_id, candidate_id, notification_type, dedupe_key, reason, read_at, snoozed_until, archived_at, created_at)
         VALUES (?, NULL, NULL, ?, 'immediate', ?, ?, NULL, NULL, NULL, ?)`,
      ).run(
        id('notice'),
        selected.id,
        `candidate-primary:${thread.id}:${selected.id}:${thread.version}`,
        '系统主人更换了归并需求的主体任务。',
        timestamp,
      );
      this.clearCandidateMergeSuggestion(members.map((member) => member.id), timestamp);
      const refreshed = this.getCandidate(selected.id)!;
      return { candidate: refreshed, mergeGroup: this.candidateMergeGroupView(refreshed) };
    });
  }

  splitCandidateMerge(candidateId: string, expectedVersion: number, expectedGroupVersionHash: string, expectedThreadVersion: number) {
    return this.database.transaction(() => {
      const selected = this.getCandidate(candidateId);
      if (!selected) throw new Error('候选需求不存在。');
      this.assertCandidateVersion(selected, expectedVersion);
      const root = this.candidateGroupRoot(selected);
      const members = this.candidateGroupRows(root.id);
      if (members.length > 1 && candidateGroupVersionHash(members) !== expectedGroupVersionHash) throw new CandidateVersionConflictError();
      if (members.length < 2) throw new Error('当前候选没有可拆分的归并来源。');
      if (members.some((member) => member.deleted_at || member.accepted_task_id || member.state === 'accepted')) {
        throw new Error('候选组已经被接受或移入回收站，不能拆分。');
      }
      const thread = this.threadForCandidate(root);
      if (!thread || thread.active_task_id || thread.status === 'closed') throw new Error('候选线程已经变化，不能拆分。');
      if (thread.version !== expectedThreadVersion) throw new CandidateVersionConflictError();
      const source = this.database.raw.prepare('SELECT * FROM source_event WHERE id = ?').get(selected.source_event_id) as SourceEventRow | undefined;
      if (!source) throw new Error('候选来源与需求线程关系不完整。');
      const selectedSources = this.sourceRowsForDemandUnit(selected.demand_unit_id, source);
      const directRelations = selectedSources.map((selectedSource) => ({
        source: selectedSource,
        relation: this.database.raw.prepare(
          'SELECT * FROM requirement_thread_source WHERE thread_id = ? AND source_event_id = ?',
        ).get(thread.id, selectedSource.id) as (RequirementThreadSourceRow & {
          session_id: string | null;
          conversation_id: string | null;
          participant_ids_json: string;
          source_revision: string | null;
          source_role: string;
          role_reason: string;
        }) | undefined,
      }));
      const selectedRelation = directRelations.find((item) => item.source.id === selected.source_event_id)?.relation
        ?? directRelations.find((item) => item.relation)?.relation;
      if (!selectedRelation) throw new Error('候选主来源与需求线程关系不完整。');
      // Older continuous-message batches only stored a thread relation for the
      // anchor message.  The demand-unit mapping is authoritative for the
      // remaining batch rows, so inherit the anchor relation while splitting.
      const selectedRelations = directRelations.map((item) => ({
        source: item.source,
        relation: item.relation ?? selectedRelation,
      }));
      const splitLastActivity = selectedSources.reduce(
        (latest, selectedSource) => latest.localeCompare(selectedSource.occurred_at) >= 0 ? latest : selectedSource.occurred_at,
        source.occurred_at,
      );
      const splitParticipants = [...new Set(selectedRelations.flatMap((item) => parseJsonValue<string[]>(item.relation.participant_ids_json, [])))];
      const remaining = members.filter((member) => member.id !== selected.id);
      const remainingUnitIds = this.demandUnitIdsForCandidates(remaining);
      const remainingRoot = remaining.find((member) => member.id === root.id) ?? remaining[0]!;
      const timestamp = nowIso();
      for (const member of remaining) {
        if (member.id === remainingRoot.id) {
          const updated = this.database.raw.prepare('UPDATE candidate_request SET merged_into_candidate_id = NULL, merged_at = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
            .run(timestamp, member.id, member.version);
          if (updated.changes !== 1) throw new CandidateVersionConflictError();
        } else {
          const updated = this.database.raw.prepare('UPDATE candidate_request SET merged_into_candidate_id = ?, merged_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
            .run(remainingRoot.id, timestamp, timestamp, member.id, member.version);
          if (updated.changes !== 1) throw new CandidateVersionConflictError();
        }
      }
      const selectedUpdated = this.database.raw.prepare('UPDATE candidate_request SET merged_into_candidate_id = NULL, merged_at = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
        .run(timestamp, selected.id, selected.version);
      if (selectedUpdated.changes !== 1) throw new CandidateVersionConflictError();
      const splitThreadId = id('thread');
      this.database.raw.prepare(
        `INSERT INTO requirement_thread
          (id, status, title, background, validation_question, describe, analysis_json, conversation_id,
           participant_ids_json, ambiguity_json, active_task_id, primary_source_event_id, primary_reason,
           primary_confidence, version, last_activity_at, created_at, updated_at)
         VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, '[]', NULL, ?, ?, 1, 1, ?, ?, ?)`,
      ).run(
        splitThreadId,
        selected.title,
        selected.background,
        selected.validation_question,
        selected.describe,
        selected.analysis_json,
        selectedRelation.conversation_id ?? source.conversation_id,
        JSON.stringify(splitParticipants),
        selected.source_event_id,
        `系统主人将“${selected.title}”拆分为独立候选。`,
        splitLastActivity,
        timestamp,
        timestamp,
      );
      for (const item of selectedRelations) {
        const isAnchor = item.source.id === selected.source_event_id;
        this.database.raw.prepare(
          `INSERT INTO requirement_thread_source
            (thread_id, source_event_id, demand_unit_id, relation_type, confidence, evidence_json, root_id, parent_id, session_id,
             conversation_id, participant_ids_json, source_revision, source_role, role_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          splitThreadId,
          item.source.id,
          selected.demand_unit_id,
          isAnchor ? 'owner_split' : 'owner_split_batch',
          isAnchor ? 1 : item.relation.confidence,
          isAnchor
            ? JSON.stringify(['系统主人将这组连续来源从归并需求中拆分为独立候选。'])
            : item.relation.evidence_json,
          item.relation.root_id,
          item.relation.parent_id,
          item.relation.session_id,
          item.relation.conversation_id ?? item.source.conversation_id,
          item.relation.participant_ids_json,
          item.relation.source_revision ?? sourceRevision(item.source),
          isAnchor ? 'owner_delivery' : item.relation.source_role || 'unknown',
          isAnchor ? '系统主人确认这组连续来源需要独立推进。' : item.relation.role_reason || '随连续消息批次一并拆分。',
          item.relation.created_at,
        );
        const sharedWithRemainingUnit = selected.demand_unit_id
          ? this.sourceUsedByThreadUnits(thread.id, item.source.id, remainingUnitIds)
          : false;
        if (!selected.demand_unit_id) {
          // Legacy batches did not have demand units and could leave a
          // continuation row on their original provisional thread after a
          // candidate merge.  A split owns the whole classification batch, so
          // remove those unassigned legacy relations as well.
          this.database.raw.prepare(
            `DELETE FROM requirement_thread_source
             WHERE source_event_id = ? AND thread_id <> ?
               AND thread_id IN (SELECT id FROM requirement_thread WHERE active_task_id IS NULL)`,
          ).run(item.source.id, splitThreadId);
        } else if (!sharedWithRemainingUnit) {
          this.database.raw.prepare('DELETE FROM requirement_thread_source WHERE thread_id = ? AND source_event_id = ?')
            .run(thread.id, item.source.id);
        }
        const metadata = parseMetadata(item.source.metadata_json);
        if (sharedWithRemainingUnit) delete metadata.internalRequirementThreadId;
        else metadata.internalRequirementThreadId = splitThreadId;
        this.database.raw.prepare('UPDATE source_event SET metadata_json = ? WHERE id = ?')
          .run(JSON.stringify(metadata), item.source.id);
      }
      if (selected.demand_unit_id) {
        this.moveDemandUnitsToThread([selected.demand_unit_id], thread.id, splitThreadId, timestamp);
        this.database.raw.prepare(
          `UPDATE requirement_thread_unit SET relation_type = 'primary', confidence = 1, evidence_json = ?
           WHERE thread_id = ? AND demand_unit_id = ?`,
        ).run(JSON.stringify(['系统主人将该需求单元拆分为独立候选。']), splitThreadId, selected.demand_unit_id);
      }
      const remainingRelations = this.database.raw.prepare(
        `SELECT source_event.occurred_at, requirement_thread_source.participant_ids_json
         FROM requirement_thread_source JOIN source_event ON source_event.id = requirement_thread_source.source_event_id
         WHERE requirement_thread_source.thread_id = ?`,
      ).all(thread.id) as Array<{ occurred_at: string; participant_ids_json: string }>;
      const remainingActivity = remainingRelations.reduce<string | null>((latest, row) => (
        !latest || row.occurred_at > latest ? row.occurred_at : latest
      ), null);
      const remainingParticipants = [...new Set(remainingRelations.flatMap((row) => (
        parseJsonValue<string[]>(row.participant_ids_json, [])
      )).filter(Boolean))];
      const remainingThreadUpdate = this.database.raw.prepare(
        `UPDATE requirement_thread
         SET title = ?, background = ?, validation_question = ?, describe = ?, analysis_json = ?,
             primary_source_event_id = ?, primary_reason = ?, primary_confidence = 1,
             participant_ids_json = ?, last_activity_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND active_task_id IS NULL AND version = ?`,
      ).run(
        remainingRoot.title,
        remainingRoot.background,
        remainingRoot.validation_question,
        remainingRoot.describe,
        remainingRoot.analysis_json,
        remainingRoot.source_event_id,
        `系统主人拆出一条独立候选后，将“${remainingRoot.title}”保留为主体。`,
        JSON.stringify(remainingParticipants),
        remainingActivity,
        timestamp,
        thread.id,
        expectedThreadVersion,
      );
      if (remainingThreadUpdate.changes !== 1) throw new CandidateVersionConflictError();
      const splitSourceIds = selectedSources.map((selectedSource) => selectedSource.id);
      const splitPlaceholders = splitSourceIds.map(() => '?').join(',');
      this.database.raw.prepare(
        `UPDATE requirement_thread_revision SET state = 'stale', decided_at = ?
         WHERE thread_id = ? AND source_event_id IN (${splitPlaceholders}) AND state = 'proposed'`,
      ).run(timestamp, thread.id, ...splitSourceIds);
      this.database.raw.prepare(
        `INSERT INTO correction_event
          (id, idempotency_key, task_id, candidate_id, source_event_id, demand_unit_id, correction_type,
           before_json, after_json, note, visibility, operation, created_at)
          VALUES (?, ?, NULL, ?, ?, ?, 'candidate_split', ?, ?, ?, 'private', 'apply', ?)`,
      ).run(
        id('correction'),
        `candidate-split:${root.id}:${selected.id}:${thread.version}`,
        selected.id,
        selected.source_event_id,
        selected.demand_unit_id,
        JSON.stringify({ threadId: thread.id, primaryCandidateId: root.id, memberIds: members.map((member) => member.id), sourceEventIds: splitSourceIds }),
        JSON.stringify({ splitThreadId, splitCandidateId: selected.id, splitSourceEventIds: splitSourceIds, remainingThreadId: thread.id, remainingPrimaryCandidateId: remainingRoot.id }),
        selectedSources.length > 1 ? '系统主人把误归并需求单元的多条来源拆成独立候选。' : '系统主人把误归并的需求单元拆成独立候选。',
        timestamp,
      );
      this.clearCandidateMergeSuggestion(members.map((member) => member.id), timestamp);
      this.database.raw.prepare(
        `INSERT OR IGNORE INTO notification
          (id, task_id, task_event_id, candidate_id, notification_type, dedupe_key, reason, read_at, snoozed_until, archived_at, created_at)
         VALUES (?, NULL, NULL, ?, 'immediate', ?, ?, NULL, NULL, NULL, ?)`,
      ).run(
        id('notice'),
        selected.id,
        `candidate-split:${selected.id}:${splitThreadId}`,
        selectedSources.length > 1 ? `${selectedSources.length} 条需求证据已由主人拆分为独立候选。` : '一个需求单元已由主人拆分为独立候选。',
        timestamp,
      );
      return {
        splitCandidate: this.getCandidate(selected.id),
        remainingCandidate: this.getCandidate(remainingRoot.id),
        splitGroup: this.candidateMergeGroupView(this.getCandidate(selected.id)!),
        remainingGroup: this.candidateMergeGroupView(this.getCandidate(remainingRoot.id)!),
      };
    });
  }


  private closeUnassignedThreadForCandidate(candidate: CandidateRow, timestamp = nowIso()) {
     const thread = this.threadForCandidate(candidate);
    if (!thread || thread.active_task_id) return;
    const remaining = this.database.raw.prepare(
      `SELECT COUNT(DISTINCT candidate_request.id) AS count
       FROM requirement_thread_unit
       JOIN candidate_request ON candidate_request.demand_unit_id = requirement_thread_unit.demand_unit_id
       WHERE requirement_thread_unit.thread_id = ?
         AND candidate_request.id <> ?
          AND candidate_request.state IN ('pending','snoozed','accepted')
          AND candidate_request.deleted_at IS NULL`,
    ).get(thread.id, candidate.id) as { count: number };
    if (remaining.count > 0) return;
    this.database.raw.prepare(
      "UPDATE requirement_thread SET status = 'closed', updated_at = ? WHERE id = ? AND active_task_id IS NULL",
    ).run(timestamp, thread.id);
    this.database.raw.prepare(
      "UPDATE requirement_thread_revision SET state = 'rejected', decided_at = ? WHERE thread_id = ? AND state = 'proposed'",
    ).run(timestamp, thread.id);
  }


  getTaskUpdateProposal(proposalId: string) {
    const row = this.database.raw.prepare('SELECT * FROM task_update_proposal WHERE id = ?').get(proposalId) as TaskUpdateProposalRow | undefined;
    if (!row) return null;
    return { ...this.taskUpdateProposalView(row), task: this.getTask(row.task_id) };
  }

  private runtimeJobView(job: RuntimeJobRow) {
    return {
      id: job.id,
      job_type: job.job_type,
      status: job.status,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      retryable: job.retryable,
      available_at: job.available_at,
      // Runtime errors may contain provider diagnostics or source fragments.
      // The owner can use the status/attempt counters by default; detailed
      // diagnostics stay behind the controlled local diagnostic flow.
      last_error: job.last_error ? '运行失败；详细诊断已脱敏保留。' : null,
      created_at: job.created_at,
      updated_at: job.updated_at,
    };
  }


  /**
   * Retry classification through a source id, keeping Runtime job ids
   * internal to the service. Batch jobs are resolved through job_source_link.
   */

  actOnCandidate(
    candidateId: string,
    action: 'accept' | 'snooze' | 'ignore',
    snoozedUntil: string | undefined,
    expectedVersion: number,
    expectedGroupVersionHash?: string,
  ) {
    const result = this.database.transaction(() => {
      // Re-read inside BEGIN IMMEDIATE so two stale UI requests cannot each
      // create a different task from the same candidate.
      const requested = this.getCandidate(candidateId);
      if (!requested) throw new Error('候选需求不存在。');
      const candidate = this.candidateGroupRoot(requested);
      const group = this.candidateGroupRows(candidate.id);
      this.assertCandidateVersion(candidate, expectedVersion);
      if (group.length > 1 && candidateGroupVersionHash(group) !== expectedGroupVersionHash) {
        throw new CandidateVersionConflictError();
      }
      this.assertCandidateActive(candidate);
      if (candidate.state === 'accepted' && action !== 'accept') {
        throw new Error('已接受的候选已经绑定正式任务，不能再暂存或忽略。');
      }
      if (candidate.state === 'accepted' && candidate.accepted_task_id) {
        const task = this.getTask(candidate.accepted_task_id);
        if (!task) throw new Error('候选关联的正式任务不存在。');
        return { candidate, task, linkedExistingTask: true, projectTaskId: null as string | null };
      }

      const timestamp = nowIso();
      if (action === 'snooze') {
        const until = snoozedUntil ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        for (const member of group) {
          const updated = this.database.raw.prepare(
            "UPDATE candidate_request SET state = 'snoozed', snoozed_until = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND state <> 'accepted' AND accepted_task_id IS NULL",
          ).run(until, timestamp, member.id, member.version);
          if (updated.changes !== 1) throw new CandidateVersionConflictError();
        }
        return { candidate: this.getCandidate(candidate.id), task: null, linkedExistingTask: false, projectTaskId: null as string | null };
      }

      if (action === 'ignore') {
        for (const member of group) {
          const updated = this.database.raw.prepare(
            "UPDATE candidate_request SET state = 'ignored', snoozed_until = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND state <> 'accepted' AND accepted_task_id IS NULL",
          ).run(timestamp, member.id, member.version);
          if (updated.changes !== 1) throw new CandidateVersionConflictError();
        }
        for (const item of group) this.recordCandidateIgnoredRetirement(item, timestamp);
        this.closeUnassignedThreadForCandidate(candidate, timestamp);
        return { candidate: this.getCandidate(candidate.id), task: null, linkedExistingTask: false, projectTaskId: null as string | null };
      }

       const existingThread = this.threadForCandidate(candidate);
      const candidateDemandUnitId = candidate.demand_unit_id ?? this.ensureCandidateDemandUnitRecord(candidate, timestamp);
      const candidateSourceMatchesUnit = Boolean(this.database.raw.prepare(
        `SELECT 1 FROM source_demand_unit_source
         WHERE demand_unit_id = ? AND source_event_id = ?`,
      ).get(candidateDemandUnitId, candidate.source_event_id));
      if (action === 'accept' && existingThread && parseJsonValue<string[]>(existingThread.ambiguity_json, []).length > 0) {
        throw new Error('请先确认这条候选属于哪个需求线程，再接受为正式任务。');
      }
      if (existingThread?.active_task_id) {
        const existingTask = this.getTask(existingThread.active_task_id);
        if (!existingTask) throw new Error('需求线程关联的正式任务不存在。');
        for (const member of group) {
          const accepted = this.database.raw.prepare(
            "UPDATE candidate_request SET state = 'accepted', accepted_task_id = ?, snoozed_until = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND state <> 'accepted' AND accepted_task_id IS NULL",
          ).run(existingTask.id, timestamp, member.id, member.version);
          if (accepted.changes !== 1) throw new CandidateVersionConflictError();
        }
        const threadSources = this.database.raw.prepare(
          'SELECT source_event_id, demand_unit_id FROM requirement_thread_source WHERE thread_id = ?',
        ).all(existingThread.id) as Array<{ source_event_id: string; demand_unit_id: string | null }>;
        for (const source of threadSources) {
          this.linkTaskSource(
            existingTask.id,
            source.source_event_id,
            'thread_update',
            timestamp,
            source.demand_unit_id ?? this.uniqueThreadDemandUnitId(existingThread.id),
          );
        }
        return { candidate: this.getCandidate(candidate.id), task: existingTask, linkedExistingTask: true, projectTaskId: existingTask.id };
      }

      const taskId = id('task');
      this.database.raw.prepare(
        `INSERT INTO task
          (id, title, proposer_name, describe, status, schedule_at, next_step, risk, waiting_reason, version, completed_at, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'unplanned', NULL, ?, 'medium', NULL, 1, NULL, NULL, ?, ?)`,
      ).run(
        taskId,
        candidate.title,
        candidate.proposer_name,
        candidate.describe,
        '确认需求边界、关键问题和可用数据源。',
        timestamp,
        timestamp,
      );
      const originDemandUnitId = this.linkTaskSource(
        taskId,
        candidate.source_event_id,
        'origin',
        timestamp,
        candidateSourceMatchesUnit ? candidateDemandUnitId : null,
      );
      if (existingThread) {
        const threadSources = this.database.raw.prepare(
          'SELECT source_event_id, demand_unit_id FROM requirement_thread_source WHERE thread_id = ?',
        ).all(existingThread.id) as Array<{ source_event_id: string; demand_unit_id: string | null }>;
        for (const source of threadSources) {
          if (source.source_event_id === candidate.source_event_id) continue;
          this.linkTaskSource(
            taskId,
            source.source_event_id,
            'thread_update',
            timestamp,
            source.demand_unit_id ?? this.uniqueThreadDemandUnitId(existingThread.id),
          );
        }
      }
      this.database.raw.prepare(
        `INSERT INTO task_event
          (id, task_id, event_type, actor_type, visibility, summary, source_event_id, demand_unit_id, before_json, after_json, occurred_at, recorded_at, version)
         VALUES (?, ?, 'task_created', 'user', 'private', ?, ?, ?, NULL, ?, ?, ?, 1)`,
      ).run(
        id('evt'),
        taskId,
        '系统主人接受候选，建立正式任务。',
        candidate.source_event_id,
        originDemandUnitId,
        JSON.stringify({ status: 'unplanned' }),
        timestamp,
        timestamp,
      );
      if (existingThread) {
        this.database.raw.prepare('UPDATE task SET thread_id = ? WHERE id = ?').run(existingThread.id, taskId);
        const linked = this.database.raw.prepare(
          `UPDATE requirement_thread
           SET active_task_id = ?, status = 'open', version = version + 1, updated_at = ?
           WHERE id = ? AND active_task_id IS NULL`,
        ).run(taskId, timestamp, existingThread.id);
        if (linked.changes !== 1) throw new Error('需求线程已经绑定其他任务，请刷新后重试。');
        this.database.raw.prepare(
          "UPDATE requirement_thread_revision SET state = 'accepted', decided_at = ? WHERE thread_id = ? AND source_event_id = ? AND state = 'proposed'",
        ).run(timestamp, existingThread.id, candidate.source_event_id);
      }
      for (const member of group) {
        const accepted = this.database.raw.prepare(
          "UPDATE candidate_request SET state = 'accepted', accepted_task_id = ?, snoozed_until = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND state <> 'accepted' AND accepted_task_id IS NULL",
        ).run(taskId, timestamp, member.id, member.version);
        if (accepted.changes !== 1) throw new CandidateVersionConflictError();
      }
      return { candidate: this.getCandidate(candidate.id), task: this.getTask(taskId), linkedExistingTask: false, projectTaskId: taskId };
    });
    if (result.projectTaskId) this.projectTaskMemory(result.projectTaskId);
    const { projectTaskId: _projectTaskId, ...view } = result;
    return view;
  }

  listCindyTasks() {
    const rows = this.database.raw.prepare(
      `SELECT id, title, describe, status, next_step, waiting_reason, version, auto_update_paused, updated_at
         FROM task
        WHERE record_state = 'active'
          AND deleted_at IS NULL
          AND status <> 'archived'
        ORDER BY updated_at DESC, id ASC`,
    ).all() as Array<{
      id: string;
      title: string;
      describe: string;
      status: TaskStatus;
      next_step: string;
      waiting_reason: string | null;
      version: number;
      auto_update_paused: number | boolean;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      describe: row.describe,
      status: row.status,
      next_step: row.next_step,
      waiting_reason: row.waiting_reason,
      version: row.version,
      auto_update_paused: Boolean(row.auto_update_paused),
      updated_at: row.updated_at,
    }));
  }

  getCindySessionBinding(sessionId: string) {
    const row = this.database.raw.prepare(
      `SELECT binding.*, task.title, task.describe, task.status, task.next_step, task.waiting_reason,
              task.version, task.updated_at, task.deleted_at, task.record_state, task.auto_update_paused
       FROM cindy_session_task_binding AS binding
       JOIN task ON task.id = binding.task_id
       WHERE binding.session_id = ? AND binding.invalidated_at IS NULL`,
    ).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.deleted_at || row.record_state !== 'active' || row.status === 'archived') {
      const timestamp = nowIso();
      this.database.raw.prepare(
        'UPDATE cindy_session_task_binding SET invalidated_at = ?, updated_at = ? WHERE session_id = ? AND invalidated_at IS NULL',
      ).run(timestamp, timestamp, sessionId);
      return null;
    }
    return {
      sessionId,
      confidence: Number(row.confidence),
      bindingSource: String(row.binding_source),
      task: {
        id: String(row.task_id),
        title: String(row.title),
        describe: String(row.describe),
        status: String(row.status),
        nextStep: String(row.next_step ?? ''),
        waitingReason: row.waiting_reason === null ? null : String(row.waiting_reason),
        version: Number(row.version),
        updatedAt: String(row.updated_at),
        autoUpdatePaused: Boolean(row.auto_update_paused),
      },
    };
  }

  recordCindyTurnEvaluation(input: {
    sessionId: string;
    turnId: string;
    candidateTaskIds?: string[];
    decision: 'no_match' | 'suggest_binding' | 'bind' | 'no_update' | 'progress_update';
    taskId?: string | null;
    associationConfidence?: number | null;
    updateConfidence?: number | null;
    patch?: { status?: TaskStatus; nextStep?: string; waitingReason?: string | null };
    reason: string;
    evidence?: string[];
    provider?: string;
    model?: string;
    inputHash?: string;
    promptVersion?: string;
  }) {
    const existing = this.database.raw.prepare(
      'SELECT * FROM cindy_turn_evaluation WHERE session_id = ? AND turn_id = ?',
    ).get(input.sessionId, input.turnId) as Record<string, unknown> | undefined;
    if (existing) {
      const proposalId = typeof existing.proposal_id === 'string' ? existing.proposal_id : null;
      const decision = String(existing.decision);
      return {
        duplicate: true,
        evaluation: existing,
        binding: this.getCindySessionBinding(input.sessionId),
        suggestion: decision === 'suggest_binding'
          ? this.database.raw.prepare('SELECT * FROM cindy_task_binding_suggestion WHERE session_id = ? AND turn_id = ?').get(input.sessionId, input.turnId)
          : null,
        proposal: proposalId ? this.getTaskUpdateProposal(proposalId) : null,
      };
    }

    const binding = this.getCindySessionBinding(input.sessionId);
    const requestedDecision = input.decision;
    if (binding) {
      if (!['no_update', 'progress_update'].includes(requestedDecision)) throw new Error('已有会话绑定时只能提交当前任务的进度判断。');
    } else if (!['no_match', 'suggest_binding', 'bind'].includes(requestedDecision)) {
      throw new Error('未绑定会话只能提交匹配、建议绑定或无匹配判断。');
    }
    const associationConfidence = input.associationConfidence ?? null;
    const effectiveDecision = requestedDecision === 'bind' && (associationConfidence ?? 0) < 0.9 ? 'suggest_binding' : requestedDecision;
    let taskId = input.taskId ?? binding?.task.id ?? null;
    const candidateTaskIds = new Set(input.candidateTaskIds ?? []);
    if (!binding && taskId && !candidateTaskIds.has(taskId)) throw new Error('未绑定会话引用的任务不在本轮候选集内。');
    if (!binding && taskId && !this.database.raw.prepare(
      `SELECT 1 FROM task WHERE id = ? AND record_state = 'active' AND deleted_at IS NULL AND status <> 'archived'`,
    ).get(taskId)) throw new Error('未绑定会话只能引用当前未归档任务候选。');
    const task = taskId ? this.getTask(taskId) : null;
    if (taskId && (!task || task.record_state !== 'active' || task.deleted_at || task.status === 'archived')) throw new Error('判断指向的任务不存在或已不可维护。');
    if (binding && taskId && binding.task.id !== taskId) throw new Error('这条会话已有有效绑定，不能由模型改绑到其他任务。');
    const updateConfidence = input.updateConfidence ?? null;
    const timestamp = nowIso();
    if (effectiveDecision === 'bind' && taskId && associationConfidence !== null && associationConfidence >= 0.9) {
      this.database.raw.prepare(
        `INSERT INTO cindy_session_task_binding
          (session_id, task_id, confidence, binding_source, created_at, updated_at, invalidated_at)
         VALUES (?, ?, ?, 'model', ?, ?, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           task_id = excluded.task_id, confidence = excluded.confidence, binding_source = 'model',
           updated_at = excluded.updated_at, invalidated_at = NULL`,
      ).run(input.sessionId, taskId, associationConfidence, timestamp, timestamp);
    } else if (effectiveDecision === 'suggest_binding' && taskId && associationConfidence !== null) {
      this.database.raw.prepare(
        `INSERT OR IGNORE INTO cindy_task_binding_suggestion
          (id, session_id, turn_id, task_id, confidence, reason, state, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      ).run(id('cindy-binding'), input.sessionId, input.turnId, taskId, associationConfidence, input.reason, timestamp);
    }

    let proposalId: string | null = null;
    if (effectiveDecision === 'progress_update' && task) {
      const patchRecord = input.patch ?? {};
      const unknownKeys = Object.keys(patchRecord).filter((key) => !['status', 'nextStep', 'waitingReason'].includes(key));
      if (unknownKeys.length) throw new Error('当前轮次更新包含越权字段。');
      const patch: Record<string, unknown> = {};
      if (patchRecord.status !== undefined && patchRecord.status !== task.status) patch.status = patchRecord.status;
      if (patchRecord.nextStep !== undefined && patchRecord.nextStep !== task.next_step) patch.nextStep = patchRecord.nextStep;
      if (patchRecord.waitingReason !== undefined && patchRecord.waitingReason !== task.waiting_reason) patch.waitingReason = patchRecord.waitingReason;
      if (Object.keys(patch).length) {
        const proposal = this.createTaskUpdateProposal({
          task,
          threadId: null,
          sourceEventId: null,
          demandUnitId: null,
          candidateRevisionId: null,
          threadRevisionId: null,
          baseThreadVersion: null,
          patch,
          reason: input.reason,
          evidence: { sessionId: input.sessionId, turnId: input.turnId, relationType: 'cindy_session_binding', excerpts: (input.evidence ?? []).slice(0, 8) },
          provider: input.provider ?? 'cindy',
          model: input.model ?? '',
          promptVersion: input.promptVersion ?? 'cindy-manual-v2',
          origin: 'cindy_turn',
          associationConfidence,
          updateConfidence,
          usedFallback: false,
          idempotencyKey: `cindy-turn:${input.sessionId}:${input.turnId}`,
          createdAt: timestamp,
        });
        proposalId = proposal.id;
      }
    }
    this.database.raw.prepare(
      `INSERT INTO cindy_turn_evaluation
        (id, session_id, turn_id, task_id, decision, association_confidence, update_confidence,
         reason, evidence_json, provider, model, input_hash, prompt_version, proposal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id('cindy-turn'), input.sessionId, input.turnId, taskId, effectiveDecision,
      associationConfidence, updateConfidence, input.reason, JSON.stringify((input.evidence ?? []).slice(0, 8)),
      input.provider ?? 'cindy', input.model ?? '', input.inputHash ?? '', input.promptVersion ?? '', proposalId, timestamp,
    );
    if (proposalId) this.dispatchTaskUpdateProposal(proposalId, null);
    return {
      duplicate: false,
      binding: this.getCindySessionBinding(input.sessionId),
      suggestion: effectiveDecision === 'suggest_binding'
        ? this.database.raw.prepare('SELECT * FROM cindy_task_binding_suggestion WHERE session_id = ? AND turn_id = ?').get(input.sessionId, input.turnId)
        : null,
      proposal: proposalId ? this.getTaskUpdateProposal(proposalId) : null,
    };
  }

  listCindyCandidates() {
    const candidates = this.database.raw.prepare(
      `SELECT candidate_request.id,
              candidate_request.title,
              candidate_request.describe,
              candidate_request.state,
              candidate_request.version,
              candidate_request.updated_at,
              CASE
                WHEN source_event.conversation_id IS NOT NULL
                 AND source_event.conversation_id NOT LIKE 'cindy:source:%'
                THEN source_event.conversation_id
                ELSE NULL
              END AS conversation_id
         FROM candidate_request
         JOIN source_event ON source_event.id = candidate_request.source_event_id
         LEFT JOIN source_demand_unit ON source_demand_unit.id = candidate_request.demand_unit_id
        WHERE candidate_request.state = 'pending'
          AND candidate_request.accepted_task_id IS NULL
          AND candidate_request.deleted_at IS NULL
          AND candidate_request.merged_into_candidate_id IS NULL
          AND (candidate_request.demand_unit_id IS NULL OR source_demand_unit.state <> 'superseded')
        ORDER BY candidate_request.updated_at DESC, candidate_request.id ASC`,
    ).all() as Array<{
      id: string;
      title: string;
      describe: string;
      state: CandidateState;
      version: number;
      updated_at: string;
      conversation_id: string | null;
    }>;
    return candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      describe: candidate.describe,
      status: candidate.state,
      ...(candidate.conversation_id ? { source: { conversation_key: candidate.conversation_id } } : {}),
      version: candidate.version,
      updated_at: candidate.updated_at,
    }));
  }

  listCindyConversationCursors() {
    return this.database.listCindyConversationCursors();
  }

  processCindyIntake(input: CindyIntakeInput): CindyIntakeResult {
    const resultKind = input.result_kind ?? 'intake';
    if (Boolean(input.inbox_id) !== Boolean(input.claim_token)) {
      throw new CindyIntakeValidationError('inbox_id 和 claim_token 必须同时提供。');
    }
    const sourceKeys = input.sources.map((source) => source.source_key);
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      throw new CindyIntakeValidationError('sources.source_key 不能重复。');
    }
    const sourceKeySet = new Set(sourceKeys);
    if (!Number.isFinite(Date.parse(input.window_start)) || !Number.isFinite(Date.parse(input.window_end))) {
      throw new CindyIntakeValidationError('window_start 或 window_end 不是有效时间。');
    }
    if (Date.parse(input.window_start) > Date.parse(input.window_end)) {
      throw new CindyIntakeValidationError('window_start 不能晚于 window_end。');
    }
    if (!['intake', 'empty_window'].includes(resultKind)) {
      throw new CindyIntakeValidationError('result_kind 不受支持。');
    }
    if (resultKind === 'empty_window' && (input.sources.length !== 0 || input.proposals.length !== 0)) {
      throw new CindyIntakeValidationError('empty_window 必须同时提交空 sources 和空 proposals。');
    }
    if (resultKind === 'intake' && input.sources.length === 0) {
      throw new CindyIntakeValidationError('普通 intake 窗口必须至少提交一条来源；空窗口请使用 result_kind=empty_window。');
    }
    const { claim_token: _claimToken, ...hashableInput } = input;
    const normalizedInput = { ...hashableInput, result_kind: resultKind };
    const inputHash = createHash('sha256').update(stableJson(normalizedInput)).digest('hex');
    const ailySources = input.sources.filter((source) => source.source_kind === 'aily_summary');
    if (ailySources.length > 1) {
      throw new CindyIntakeValidationError('每个入库窗口最多只能提交一条 aily_summary 来源。');
    }
    for (const source of input.sources) {
      if (!source.source_key.trim() || !source.text.trim() || !Number.isFinite(Date.parse(source.occurred_at))) {
        throw new CindyIntakeValidationError('source_key、text 和 occurred_at 必须有效。');
      }
      if (source.source_kind && source.source_kind !== 'aily_summary') {
        throw new CindyIntakeValidationError('source_kind 不受支持。');
      }
      if (source.source_kind === 'aily_summary') {
        if (source.source_key !== `aily-summary:${input.window_id}`) {
          throw new CindyIntakeValidationError('aily_summary 的 source_key 必须由窗口 ID 稳定生成。');
        }
        if (!source.conversation_key?.trim() || !source.conversation_key.startsWith('aily:')) {
          throw new CindyIntakeValidationError('aily_summary 必须包含受控的 Aily conversation_key。');
        }
        if (!source.agent_id?.trim() || !/^[A-Za-z0-9._:-]{1,160}$/u.test(source.agent_id.trim())
          || !source.generated_at || !Number.isFinite(Date.parse(source.generated_at))) {
          throw new CindyIntakeValidationError('aily_summary 必须包含受控 agent_id 和有效 generated_at。');
        }
      }
    }
    for (const proposal of input.proposals) {
      if (new Set(proposal.source_keys).size !== proposal.source_keys.length) {
        throw new CindyIntakeValidationError('proposal.source_keys 不能重复。');
      }
      if (proposal.source_keys.some((sourceKey) => !sourceKeySet.has(sourceKey))) {
        throw new CindyIntakeValidationError('proposal 引用了本窗口未提交的 source_key。');
      }
      if (proposal.action === 'update_task') {
        if (!proposal.task_key) throw new CindyIntakeValidationError('update_task 必须提供 task_key。');
        if (proposal.expected_version === undefined) throw new CindyIntakeValidationError('update_task 必须提供 expected_version。');
        if (proposal.title === undefined && proposal.describe === undefined && proposal.next_step === undefined) {
          throw new CindyIntakeValidationError('update_task 至少需要 title、describe 或 next_step。');
        }
      }
    }

    const updatedTaskIds = new Set<string>();
    const result = this.database.transaction(() => {
      const timestamp = nowIso();
      const claim = this.database.raw.prepare(
        `INSERT OR IGNORE INTO sync_cursor
          (integration, scope_key, cursor, last_success_at, last_error, updated_at)
         VALUES ('cindy_intake', ?, NULL, NULL, NULL, ?)`,
      ).run(input.window_id, timestamp);
      if (claim.changes !== 1) {
        const existing = this.database.raw.prepare(
          `SELECT cursor FROM sync_cursor WHERE integration = 'cindy_intake' AND scope_key = ?`,
        ).get(input.window_id) as { cursor: string | null } | undefined;
        if (!existing?.cursor) throw new CindyIntakeConflictError('Cindy 窗口已存在但结果尚未完成。');
        const stored = parseJsonValue<StoredCindyIntakeResult | null>(existing.cursor, null);
        if (!stored || stored.window_id !== input.window_id) throw new CindyIntakeConflictError('Cindy 窗口幂等记录无效。');
        if (!stored._input_hash || stored._input_hash !== inputHash) {
          throw new CindyIntakeConflictError('同一入库窗口的提交内容发生变化，已拒绝静默复用旧结果。');
        }
        if (input.inbox_id) {
          const completedInbox = this.database.raw.prepare(
            `SELECT id FROM aily_summary_inbox
              WHERE id = ? AND window_id = ? AND status = 'completed'`,
          ).get(input.inbox_id, input.window_id);
          if (!completedInbox) throw new CindyIntakeConflictError('Aily inbox 与已完成入库结果不一致。');
        }
        const { _input_hash: _ignoredInputHash, ...publicResult } = stored;
        return { ...publicResult, duplicate: true };
      }

      let claimedInbox: AilySummaryInboxRow | undefined;
      if (input.inbox_id && input.claim_token) {
        claimedInbox = this.database.raw.prepare(
          'SELECT * FROM aily_summary_inbox WHERE id = ?',
        ).get(input.inbox_id) as AilySummaryInboxRow | undefined;
        const claimTokenHash = createHash('sha256').update(input.claim_token).digest('hex');
        const ailySource = input.sources.find((source) => source.source_kind === 'aily_summary');
        if (
          !claimedInbox
          || claimedInbox.status !== 'claimed'
          || claimedInbox.claim_token_hash !== claimTokenHash
          || !claimedInbox.lease_until
          || Date.parse(claimedInbox.lease_until) <= Date.parse(timestamp)
          || claimedInbox.result_kind !== 'summary'
          || claimedInbox.window_id !== input.window_id
          || claimedInbox.window_start !== input.window_start
          || claimedInbox.window_end !== input.window_end
          || !ailySource
          || ailySource.source_key !== `aily-summary:${claimedInbox.window_id}`
          || ailySource.agent_id !== claimedInbox.agent_id
          || ailySource.generated_at !== claimedInbox.generated_at
          || createHash('sha256').update(ailySource.text.trim()).digest('hex') !== claimedInbox.content_hash
        ) {
          throw new CindyIntakeConflictError('Aily inbox 领取租约或摘要内容与本次入库不一致。');
        }
      }

      const sourceRows = new Map<string, SourceEventRow>();
      const conversationCursors = new Map<string, string>();
      for (const source of input.sources) {
        const conversationId = source.conversation_key?.trim() || `cindy:source:${source.source_key}`;
        const persisted = this.persistSourceEventUnsafe({
          externalId: `cindy:${createHash('sha256').update(`${conversationId}\u0000${source.source_key}`).digest('hex')}`,
          sourceType: 'manual',
          conversationId,
          senderId: `cindy:${source.sender_role ?? 'unknown'}`,
          senderName: source.sender_role ?? 'Cindy',
          content: source.text,
          occurredAt: source.occurred_at,
          ownerMentioned: false,
          completeness: source.source_kind === 'aily_summary' ? 'limited' : 'complete',
          discoveryReason: source.source_kind === 'aily_summary'
            ? 'Aily 按时间窗口生成的派生摘要，不能冒充逐条飞书原文。'
            : 'Cindy 对话窗口入库。',
          metadata: {
            ownerScope: DATA04_OWNER_SCOPE,
            sourceScope: 'cindy',
            cindyWindowId: input.window_id,
            cindySourceKey: source.source_key,
            cindyConversationKey: source.conversation_key?.trim() ?? null,
            windowStart: input.window_start,
            windowEnd: input.window_end,
            sourceKind: source.source_kind ?? 'manual',
            derivedEvidence: source.source_kind === 'aily_summary',
            ...(source.source_kind === 'aily_summary' ? {
              ailyAgentId: source.agent_id?.trim(),
              ailyGeneratedAt: source.generated_at,
              ailySummaryWindowStart: input.window_start,
              ailySummaryWindowEnd: input.window_end,
            } : {}),
          },
        });
        sourceRows.set(source.source_key, persisted.row);
        if (source.source_kind !== 'aily_summary' && source.conversation_key?.trim()) {
          const previous = conversationCursors.get(source.conversation_key.trim());
          if (!previous || Date.parse(source.occurred_at) > Date.parse(previous)) {
            conversationCursors.set(source.conversation_key.trim(), source.occurred_at);
          }
        }
      }

      const attachCandidateSources = (demandUnitId: string, proposalSources: SourceEventRow[], proposalSourceKeys: string[]) => {
        const insert = this.database.raw.prepare(
          `INSERT OR IGNORE INTO source_demand_unit_source
            (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const [sourceIndex, sourceRow] of proposalSources.entries()) {
          insert.run(demandUnitId, sourceRow.id, proposalSourceKeys[sourceIndex]!, sourceIndex === 0 ? 'anchor' : 'evidence', sourceIndex, timestamp);
        }
      };

      const proposalResults: CindyIntakeResult['proposals'] = [];
      for (const [proposalIndex, proposal] of input.proposals.entries()) {
        const proposalSources = proposal.source_keys.map((sourceKey) => sourceRows.get(sourceKey)!);
        const anchor = proposalSources[0]!;
        if (proposal.action === 'create_candidate') {
          const sourceIds = proposalSources.map((source) => source.id);
          const sourcePlaceholders = sourceIds.map(() => '?').join(',');
          const existingCandidate = this.database.raw.prepare(
            `SELECT candidate_request.*
               FROM candidate_request
               LEFT JOIN source_demand_unit_source
                 ON source_demand_unit_source.demand_unit_id = candidate_request.demand_unit_id
              WHERE candidate_request.source_event_id IN (${sourcePlaceholders})
                 OR source_demand_unit_source.source_event_id IN (${sourcePlaceholders})
              ORDER BY candidate_request.created_at ASC, candidate_request.id ASC
              LIMIT 1`,
          ).get(...sourceIds, ...sourceIds) as CandidateRow | undefined;
          if (existingCandidate) {
            let demandUnitId = existingCandidate.demand_unit_id;
            if (!demandUnitId && !existingCandidate.accepted_task_id && !existingCandidate.deleted_at && existingCandidate.state !== 'accepted') {
              demandUnitId = this.ensureCandidateDemandUnitRecord(existingCandidate, timestamp);
            }
            if (demandUnitId) attachCandidateSources(demandUnitId, proposalSources, proposal.source_keys);
            proposalResults.push({ action: proposal.action, source_keys: proposal.source_keys, candidate_id: existingCandidate.id });
            continue;
          }
          const draft = createManualCandidate(anchor.content, anchor.sender_name, anchor.occurred_at);
          const anchorMetadata = parseMetadata(anchor.metadata_json);
          const candidateConfidence = anchorMetadata.sourceKind === 'aily_summary' ? 0.75 : 1;
          const candidateId = id('cand');
          const demandUnitId = id('unit');
          const title = proposal.title ?? draft.title;
          const describe = proposal.describe ?? draft.describe;
          const analysisJson = JSON.stringify({
            ...draft.analysis,
            origin: 'cindy_intake',
            windowId: input.window_id,
            sourceKeys: proposal.source_keys,
            reason: proposal.reason ?? null,
          });
          this.database.raw.prepare(
            `INSERT INTO source_demand_unit
              (id, anchor_source_event_id, unit_key, unit_kind, state, classification_revision, ai_decision_id,
               analysis_json, reason, created_at, updated_at)
             VALUES (?, ?, ?, 'demand', 'ready', ?, NULL, ?, ?, ?, ?)`,
          ).run(
            demandUnitId,
            anchor.id,
            `cindy:${candidateId}`,
            `cindy:${input.window_id}`,
            analysisJson,
            proposal.reason ?? 'Cindy 入库提案。',
            timestamp,
            timestamp,
          );
          this.database.raw.prepare(
            `INSERT INTO candidate_request
              (id, source_event_id, demand_unit_id, title, proposer_name, background, validation_question, describe,
               analysis_json, confidence, state, snoozed_until, accepted_task_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
          ).run(
            candidateId,
            anchor.id,
            demandUnitId,
            title,
            anchor.sender_name,
            draft.background,
            draft.validationQuestion,
            describe,
            analysisJson,
            candidateConfidence,
            timestamp,
            timestamp,
          );
          attachCandidateSources(demandUnitId, proposalSources, proposal.source_keys);
          proposalResults.push({ action: proposal.action, source_keys: proposal.source_keys, candidate_id: candidateId });
          continue;
        }

        if (proposal.action === 'update_task') {
          const task = this.getTask(proposal.task_key!);
          if (!task) throw new CindyIntakeConflictError('update_task 对应的任务不存在。');
          if (task.record_state !== 'active' || task.deleted_at || task.status === 'archived') {
            throw new CindyIntakeConflictError('update_task 对应的任务当前不可更新。', task.version);
          }
          if (task.auto_update_paused) {
            throw new CindyIntakeConflictError('任务已暂停 AI 自动维护，Cindy update_task 已拒绝。', task.version);
          }
          if (task.version !== proposal.expected_version) {
            throw new CindyIntakeConflictError('任务已被其他操作更新，请刷新后重试。', task.version);
          }
          const demandUnitId = this.ensureCindyTaskDemandUnit(task, anchor.id, timestamp);
          for (const source of proposalSources) {
            if (source.id !== anchor.id) this.ensureDemandUnitSourceEdge(demandUnitId, source.id, timestamp);
            this.linkTaskSource(task.id, source.id, 'cindy_update', timestamp, demandUnitId);
          }
          const patch: TaskPatch = {
            title: proposal.title,
            describe: proposal.describe,
            nextStep: proposal.next_step,
            expectedVersion: proposal.expected_version,
          };
          const next = this.resolveTaskPatch(task, patch);
          const nextVersion = task.version + 1;
          const updated = this.database.raw.prepare(
            `UPDATE task
                SET title = ?, describe = ?, next_step = ?, version = ?, updated_at = ?
              WHERE id = ? AND version = ?`,
          ).run(next.title, next.describe, next.nextStep, nextVersion, timestamp, task.id, task.version);
          if (updated.changes !== 1) {
            const current = this.getTask(task.id);
            throw new CindyIntakeConflictError('任务已被其他操作更新，请刷新后重试。', current?.version ?? null);
          }
          const afterSnapshot = {
            ...taskAuditSnapshot(task),
            title: next.title,
            describe: next.describe,
            next_step: next.nextStep,
            version: nextVersion,
            updated_at: timestamp,
          };
          this.database.raw.prepare(
            `INSERT INTO task_event
              (id, task_id, event_type, actor_type, visibility, summary, source_event_id, demand_unit_id,
               before_json, after_json, occurred_at, recorded_at, version)
             VALUES (?, ?, 'task_cindy_intake_update', 'cindy', 'private', ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id('evt'),
            task.id,
            proposal.reason?.trim() || 'Cindy 提案更新了任务字段。',
            anchor.id,
            demandUnitId,
            JSON.stringify(taskAuditSnapshot(task)),
            JSON.stringify(afterSnapshot),
            anchor.occurred_at,
            timestamp,
            nextVersion,
          );
          updatedTaskIds.add(task.id);
          proposalResults.push({ action: proposal.action, source_keys: proposal.source_keys, task_key: task.id, version: nextVersion });
          continue;
        }

        const correctionType = proposal.action === 'skip' ? 'cindy_skip' : 'cindy_needs_owner';
        this.database.raw.prepare(
          `INSERT OR IGNORE INTO correction_event
            (id, task_id, candidate_id, source_event_id, correction_type, before_json, after_json,
             created_at, idempotency_key, note)
           VALUES (?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?)`,
        ).run(
          id('correction'),
          anchor.id,
          correctionType,
          JSON.stringify({
            action: proposal.action,
            windowId: input.window_id,
            sourceKeys: proposal.source_keys,
            reason: proposal.reason ?? null,
          }),
          timestamp,
          `cindy-intake:${input.window_id}:${proposalIndex}`,
          proposal.reason ?? '',
        );
        proposalResults.push({ action: proposal.action, source_keys: proposal.source_keys, reason: proposal.reason });
      }

      const storedResult: CindyIntakeResult = {
        window_id: input.window_id,
        result_kind: resultKind,
        duplicate: false,
        source_event_ids: [...sourceRows.values()].map((source) => source.id),
        proposals: proposalResults,
      };
      const storedPayload: StoredCindyIntakeResult = { ...storedResult, _input_hash: inputHash };
      this.database.raw.prepare(
        `UPDATE sync_cursor
            SET cursor = ?, last_success_at = ?, updated_at = ?
          WHERE integration = 'cindy_intake' AND scope_key = ?`,
      ).run(JSON.stringify(storedPayload), timestamp, timestamp, input.window_id);
      if (claimedInbox) {
        const completed = this.database.raw.prepare(
          `UPDATE aily_summary_inbox
              SET status = 'completed', lease_until = NULL, claim_token_hash = NULL,
                  last_error_code = NULL, completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'claimed' AND claim_token_hash = ?`,
        ).run(timestamp, timestamp, claimedInbox.id, claimedInbox.claim_token_hash);
        if (completed.changes !== 1) {
          throw new CindyIntakeConflictError('Aily inbox 完成状态提交失败。');
        }
      }
      for (const [conversationKey, occurredAt] of conversationCursors) {
        this.database.advanceCindyConversationCursor(conversationKey, occurredAt, timestamp);
      }
      return storedResult;
    });
    for (const taskId of updatedTaskIds) this.projectTaskMemory(taskId);
    return result;
  }

  listTasks(
    status?: TaskStatus,
    recordState: 'active' | 'invalidated' | 'all' = 'active',
    deletedState: 'active' | 'only' | 'all' = 'active',
  ) {
    const stateClause = recordState === 'all' ? '' : ' AND record_state = ?';
    const stateArgs = recordState === 'all' ? [] : [recordState];
    const deletedClause = deletedState === 'all' ? '' : deletedState === 'only' ? ' AND deleted_at IS NOT NULL' : ' AND deleted_at IS NULL';
    const scheduleOrder = 'COALESCE(planned_start_at, planned_due_at, schedule_at)';
    if (status) {
      const rows = this.database.raw
        .prepare(`SELECT * FROM task WHERE status = ?${stateClause}${deletedClause} ORDER BY ${scheduleOrder} IS NULL, ${scheduleOrder}, updated_at DESC`)
        .all(status, ...stateArgs) as unknown as TaskRecord[];
      return rows.map((task) => normalizeTaskRecord(task)!);
    }
    const rows = this.database.raw
      .prepare(`SELECT * FROM task WHERE 1 = 1${stateClause}${deletedClause} ORDER BY deleted_at IS NOT NULL, record_state = 'invalidated', status = 'archived', ${scheduleOrder} IS NULL, ${scheduleOrder}, updated_at DESC`)
      .all(...stateArgs) as unknown as TaskRecord[];
    return rows.map((task) => normalizeTaskRecord(task)!);
  }

  listTasksPublic(
    status?: TaskStatus,
    recordState: 'active' | 'invalidated' | 'all' = 'active',
    deletedState: 'active' | 'only' | 'all' = 'active',
  ) {
    return this.listTasks(status, recordState, deletedState)
      .map((task) => this.publicTask(task.id))
      .filter((task): task is NonNullable<typeof task> => task !== null);
  }

  getTask(taskId: string) {
    return normalizeTaskRecord(this.database.raw.prepare('SELECT * FROM task WHERE id = ?').get(taskId) as TaskRecord | undefined);
  }

  publicCandidate(candidateId: string) {
    const row = this.listCandidates(undefined, 'all').find((candidate) => candidate.id === candidateId);
    return row ? this.minimalCandidateView(row as CandidateRow & Record<string, unknown>) : null;
  }

  publicTask(taskId: string | null | undefined) {
    if (!taskId) return null;
    const detail = this.getTaskDetail(taskId);
    if (!detail) return null;
    return taskDtoSchema.parse({
      id: detail.id,
      title: detail.title,
      proposer_name: detail.proposer_name,
      describe: detail.describe,
      status: detail.status,
      schedule_at: safePublicTimestamp(detail.schedule_at),
      planned_start_at: safePublicTimestamp(detail.planned_start_at),
      planned_due_at: safePublicTimestamp(detail.planned_due_at),
      next_step: detail.next_step,
      risk: detail.risk,
      waiting_reason: detail.waiting_reason,
      version: detail.version,
      completed_at: safePublicTimestamp(detail.completed_at),
      archived_at: safePublicTimestamp(detail.archived_at),
      deleted_at: safePublicTimestamp(detail.deleted_at),
      record_state: detail.record_state,
      merged_into_task_id: detail.merged_into_task_id,
      auto_update_paused: detail.auto_update_paused,
      created_at: detail.created_at,
      updated_at: detail.updated_at,
    });
  }

  publicMergeGroup(candidateId: string) {
    const candidate = this.getCandidate(candidateId);
    if (!candidate) return null;
    return this.publicCandidate(candidateId)?.merge_group ?? null;
  }

  publicTaskUpdateProposal(proposalId: string | null | undefined) {
    if (!proposalId) return null;
    const row = this.database.raw.prepare('SELECT * FROM task_update_proposal WHERE id = ?').get(proposalId) as TaskUpdateProposalRow | undefined;
    return row ? taskUpdateProposalDtoSchema.parse(this.taskUpdateProposalView(row, {
      public: true,
      sourceContents: this.sourceContentsForTask(row.task_id, row.source_event_id ? [row.source_event_id] : []),
    })) : null;
  }

  private taskUpdateProposalView(proposal: TaskUpdateProposalRow, options: { public?: boolean; sourceContents?: readonly string[] } = {}) {
    const patch = parseTaskUpdatePatch(proposal.patch_json);
    const evidence = parseJsonValue<unknown>(proposal.evidence_json, []);
    const beforeSnapshot = parseJsonValue<TaskUpdateProposalSnapshot | null>(proposal.before_snapshot_json, null);
    const afterSnapshot = parseJsonValue<TaskUpdateProposalSnapshot | null>(proposal.after_snapshot_json, null);
    const task = this.getTask(proposal.task_id);
    const thread = proposal.thread_id
      ? this.database.raw.prepare('SELECT version FROM requirement_thread WHERE id = ?').get(proposal.thread_id) as { version: number } | undefined
      : undefined;
    const source = proposal.source_event_id
      ? this.database.raw.prepare('SELECT id, source_type, occurred_at, content FROM source_event WHERE id = ?')
          .get(proposal.source_event_id) as { id: string; source_type: string; occurred_at: string; content: string } | undefined
      : undefined;
    const candidateRevision = proposal.candidate_revision_id
      ? this.database.raw.prepare('SELECT candidate_id FROM candidate_revision WHERE id = ?').get(proposal.candidate_revision_id) as { candidate_id: string } | undefined
      : undefined;
    const candidate = candidateRevision
      ? this.database.raw.prepare('SELECT * FROM candidate_request WHERE id = ?').get(candidateRevision.candidate_id) as CandidateRow | undefined
      : undefined;
    let cannotRevertReason: string | null = null;
    if (proposal.decision_mode !== 'auto') cannotRevertReason = '只有 AI 自动应用的更新可以一键撤销。';
    else if (proposal.reverted_at) cannotRevertReason = '这次自动更新已经撤销。';
    else if (proposal.state !== 'approved' || proposal.applied_task_version === null) cannotRevertReason = '这次自动更新尚未完整应用。';
    else if (!task || task.version !== proposal.applied_task_version) cannotRevertReason = '任务已有后续修改，不能覆盖新内容。';
    else if (proposal.thread_id && (!thread || proposal.applied_thread_version === null || thread.version !== proposal.applied_thread_version)) {
      cannotRevertReason = '需求线程已有后续修改，不能覆盖新内容。';
    } else if (proposal.candidate_revision_id && !candidateRevision) {
      cannotRevertReason = '候选修订已不存在，不能安全撤销。';
    } else if (proposal.candidate_revision_id && !afterSnapshot?.candidate) {
      cannotRevertReason = '自动更新缺少候选应用后快照，不能安全撤销。';
    } else if (proposal.candidate_revision_id && !candidateSnapshotsEqual(afterSnapshot!.candidate, candidateFullAuditSnapshot(candidate))) {
      cannotRevertReason = '候选摘要已有后续人工修改，不能覆盖新内容。';
    }
    const sourceContents = options.sourceContents ?? (source?.content ? [source.content] : []);
    const safeNarrative = (value: unknown, fallback: string, maxLength: number) => options.public
      ? safeCandidateNarrative(value, sourceContents, fallback, maxLength)
      : value;
    const safeProposalValue = (value: unknown, key: string) => {
      if (key === 'plannedStartAt' || key === 'plannedDueAt') {
        return value === null ? null : safePublicTimestamp(typeof value === 'string' ? value : null);
      }
      if (key === 'status' || key === 'risk') return value;
      if (typeof value !== 'string') return value;
      const maxLength = key.toLowerCase().includes('title') ? 160 : key.toLowerCase().includes('describe') || key.toLowerCase().includes('background') ? 2_000 : 1_000;
      return safeNarrative(value, '提案字段已保留；来源正文默认隐藏。', maxLength);
    };
    const safePatch = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, safeProposalValue(value, key)]));
    const valueBefore = (key: string) => {
      const taskBefore = objectValue(beforeSnapshot?.task);
      const threadBefore = objectValue(beforeSnapshot?.thread);
      const map: Record<string, unknown> = {
        title: taskBefore.title,
        describe: taskBefore.describe,
        status: taskBefore.status,
        plannedStartAt: taskBefore.planned_start_at,
        plannedDueAt: taskBefore.planned_due_at,
        nextStep: taskBefore.next_step,
        risk: taskBefore.risk,
        waitingReason: taskBefore.waiting_reason,
        threadTitle: threadBefore.title,
        threadBackground: threadBefore.background,
        threadValidationQuestion: threadBefore.validation_question,
        threadDescribe: threadBefore.describe,
        note: null,
      };
      return safeProposalValue(map[key] ?? null, key);
    };
    return {
      id: proposal.id,
      task_id: proposal.task_id,
      thread_id: proposal.thread_id,
      candidate_revision_id: proposal.candidate_revision_id,
      thread_revision_id: proposal.thread_revision_id,
      base_task_version: proposal.base_task_version,
      base_thread_version: proposal.base_thread_version,
      patch: safePatch,
      changes: Object.entries(safePatch)
        .filter(([, value]) => value !== undefined)
        .map(([field, after]) => ({ field, before: valueBefore(field), after })),
      reason: safeNarrative(proposal.reason, '受控任务更新提案已生成；具体来源需主人主动核验。', 500),
      // Evidence is intentionally represented by the bounded patch and
      // fixed policy text below; model/provider fields never leave the
      // server-side audit record in the default task DTO.
      evidence: Array.isArray(evidence) ? ['已保留受控证据，原文需主人主动核验。'] : [],
      state: proposal.state,
      origin: proposal.origin,
      association_confidence: proposal.association_confidence,
      update_confidence: proposal.update_confidence,
      used_fallback: Boolean(proposal.used_fallback),
      decision_mode: proposal.decision_mode,
      policy_version: options.public
        ? proposal.policy_version === AUTO_UPDATE_POLICY_VERSION ? AUTO_UPDATE_POLICY_VERSION : 'unknown'
        : proposal.policy_version,
      policy_reason: options.public ? '服务端策略门禁已记录。' : proposal.policy_reason,
      applied_task_version: proposal.applied_task_version,
      applied_thread_version: proposal.applied_thread_version,
      task_event_id: proposal.applied_task_event_id,
      reverted_at: proposal.reverted_at,
      reverted_task_event_id: proposal.reverted_task_event_id,
      can_revert: cannotRevertReason === null,
      cannot_revert_reason: cannotRevertReason,
      source: source ? {
        scope: sourceScope(proposal.task_id, source.id),
        source_type: source.source_type,
        occurred_at: source.occurred_at,
      } : null,
      created_at: proposal.created_at,
      decided_at: proposal.decided_at,
    };
  }

  resolveCandidateSourceScope(candidateId: string, scope: string) {
    const candidate = this.getCandidate(candidateId);
    if (!candidate) return null;
    const source = this.database.raw.prepare(
      `SELECT source_event.id, candidate_request.demand_unit_id
       FROM candidate_request JOIN source_event ON source_event.id = candidate_request.source_event_id
       WHERE candidate_request.id = ?`,
    ).get(candidateId) as { id: string; demand_unit_id: string | null } | undefined;
    if (!source || sourceScope(candidateId, source.id) !== scope) return null;
    return { sourceEventId: source.id, demandUnitId: source.demand_unit_id };
  }

  resolveTaskSourceScope(taskId: string, scope: string) {
    const task = this.getTask(taskId);
    if (!task || task.record_state !== 'active' || task.deleted_at) return null;
    const rows = this.database.raw.prepare(
      `SELECT source_event.id, COALESCE(task_source_link.demand_unit_id, candidate_request.demand_unit_id) AS demand_unit_id
       FROM task_source_link
       JOIN source_event ON source_event.id = task_source_link.source_event_id
       LEFT JOIN candidate_request ON candidate_request.accepted_task_id = task_source_link.task_id
         AND candidate_request.source_event_id = task_source_link.source_event_id
       WHERE task_source_link.task_id = ?
       UNION
       SELECT source_event.id, candidate_request.demand_unit_id
       FROM candidate_request
       JOIN source_demand_unit_source ON source_demand_unit_source.demand_unit_id = candidate_request.demand_unit_id
       JOIN source_event ON source_event.id = source_demand_unit_source.source_event_id
       WHERE candidate_request.accepted_task_id = ?`,
    ).all(taskId, taskId) as Array<{ id: string; demand_unit_id: string | null }>;
    const row = rows.find((item) => sourceScope(taskId, item.id) === scope);
    return row ? { sourceEventId: row.id, demandUnitId: row.demand_unit_id } : null;
  }

  verifyTaskSource(taskId: string, scope: string, confirmed: unknown): SourceVerificationDto {
    sourceVerificationRequestSchema.parse({ confirmed });
    const relation = this.resolveTaskSourceScope(taskId, scope);
    if (!relation) throw new Error('来源核验范围无效。');
    const source = this.database.raw.prepare(
      'SELECT source_type, completeness, occurred_at, content, metadata_json, captured_at FROM source_event WHERE id = ?',
    ).get(relation.sourceEventId) as {
      source_type: 'bot_dm' | 'owner_dm' | 'group' | 'calendar' | 'meeting' | 'manual';
      completeness: 'complete' | 'partial' | 'limited';
      occurred_at: string;
      content: string | null;
      metadata_json: string | null;
      captured_at: string;
    } | undefined;
    if (!source) throw new Error('来源核验范围无效。');
    return this.database.transaction(() => {
      let metadata: Record<string, unknown> = {};
      let metadataCorrupt = false;
      try {
        const parsed = JSON.parse(source.metadata_json ?? '');
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') metadataCorrupt = true;
        else metadata = parsed as Record<string, unknown>;
      } catch {
        metadataCorrupt = true;
      }
      const withdrawn = metadata.deleted === true || metadata.withdrawn === true || metadata.recalled === true;
      const permissionDenied = metadata.permissionDenied === true || metadata.accessStatus === 'restricted' || metadata.status === 'unauthorized';
      const contentCorrupt = metadataCorrupt || (source.content !== null && typeof source.content !== 'string');
      const hasContent = typeof source.content === 'string' && Boolean(source.content.trim());
      const reason = metadataCorrupt
        ? 'snapshot_content_corrupt'
        : withdrawn
          ? 'snapshot_marked_revoked'
          : permissionDenied
            ? 'snapshot_permission_unavailable'
            : hasContent
              ? 'available'
              : 'snapshot_content_missing';
      const status = reason === 'available' ? 'local_snapshot_verified' : 'local_snapshot_unavailable';
      const providerStatusByMetadata: Record<string, SourceVerificationDto['provider_status']> = {
        authorized: 'last_known_authorized',
        permission_denied: 'last_known_permission_denied',
        revoked: 'last_known_revoked',
        unavailable: 'last_known_unavailable',
      };
      const lastKnownProviderStatus = typeof metadata.lastKnownProviderStatus === 'string'
        ? providerStatusByMetadata[metadata.lastKnownProviderStatus] ?? 'unknown'
        : 'unknown';
      const lastKnownProviderStatusAt = typeof metadata.lastKnownProviderStatusAt === 'string'
        && Number.isFinite(Date.parse(metadata.lastKnownProviderStatusAt))
        && lastKnownProviderStatus !== 'unknown'
        ? metadata.lastKnownProviderStatusAt
        : null;
      const providerStatus = lastKnownProviderStatusAt ? lastKnownProviderStatus : 'unknown';
      const excerpt = status === 'local_snapshot_verified' ? redactDiagnosticText(sourceExcerpt(source.content!), 280) : null;
      const message = status === 'local_snapshot_verified'
        ? '已核验本地保存的来源快照片段；不代表当前 provider 权限或撤回状态。'
        : reason === 'snapshot_marked_revoked'
          ? '本地保存的来源快照标记为已撤回或删除；未执行实时 provider 核验，当前状态未知。'
          : reason === 'snapshot_permission_unavailable'
            ? '本地保存的来源快照标记为权限不可用；未执行实时 provider 核验，当前状态未知。'
            : reason === 'snapshot_content_corrupt'
              ? '本地保存的来源快照内容损坏；未执行实时 provider 核验，当前状态未知。'
              : '本地保存的来源快照没有可用正文；未执行实时 provider 核验，当前状态未知。';
      const result = sourceVerificationDtoSchema.parse({
        scope,
        status,
        reason,
        provider_status: providerStatus,
        provider_status_at: lastKnownProviderStatusAt,
        snapshot_captured_at: source.captured_at,
        source_type: source.source_type,
        completeness: source.completeness,
        occurred_at: source.occurred_at,
        content_excerpt: excerpt,
        message,
        excerpt_redacted: true,
        external_action: 'none',
      });
      this.log(
        'security',
        status === 'local_snapshot_verified' ? 'info' : 'warn',
        status === 'local_snapshot_verified' ? 'source.verification.completed' : 'source.verification.failed',
        status === 'local_snapshot_verified'
          ? '系统主人主动核验了一项本地来源快照；只返回受控脱敏片段，不产生对外动作。'
          : '系统主人主动核验本地来源快照未完成；只记录受控状态，不产生对外动作。',
        {
          relationFingerprint: createHash('sha256').update(`${taskId}:${relation.sourceEventId}`).digest('hex').slice(0, 16),
          sourceType: source.source_type,
          verificationStatus: status,
          verificationReason: reason,
          providerStatus,
          snapshotCapturedAt: source.captured_at,
          excerptChars: excerpt?.length ?? 0,
          externalAction: 'none',
        },
      );
      return result;
    });
  }

  getTaskDetail(taskId: string, options: { internal?: boolean } = {}) {
    const task = this.getTask(taskId);
    if (!task) {
      return null;
    }
    const sourceRows = this.database.raw
      .prepare(
        `SELECT source_event.*, candidate_request.demand_unit_id,
                candidate_request.title AS demand_unit_title,
                candidate_request.describe AS demand_unit_describe
         FROM candidate_request
         JOIN source_demand_unit_source ON source_demand_unit_source.demand_unit_id = candidate_request.demand_unit_id
         JOIN source_event ON source_event.id = source_demand_unit_source.source_event_id
         WHERE candidate_request.accepted_task_id = ?
         UNION ALL
         SELECT source_event.*, task_source_link.demand_unit_id,
                candidate_request.title AS demand_unit_title,
                candidate_request.describe AS demand_unit_describe
         FROM task_source_link
         JOIN source_event ON source_event.id = task_source_link.source_event_id
         LEFT JOIN candidate_request
           ON candidate_request.demand_unit_id = task_source_link.demand_unit_id
         WHERE task_source_link.task_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM candidate_request
             JOIN source_demand_unit_source ON source_demand_unit_source.demand_unit_id = candidate_request.demand_unit_id
             WHERE candidate_request.accepted_task_id = task_source_link.task_id
               AND source_demand_unit_source.source_event_id = task_source_link.source_event_id
           )
         ORDER BY occurred_at DESC`,
      )
      .all(taskId, taskId);
    const sourceDtos: MinimalSourceDto[] = (sourceRows as Array<Record<string, unknown>>).map((row) => minimalSourceDtoSchema.parse({
      source_scope: sourceScope(taskId, String(row.id)),
      source_type: row.source_type,
      ...(parseMetadata(String(row.metadata_json ?? '')).sourceKind === 'aily_summary' ? { source_kind: 'aily_summary' } : {}),
      completeness: row.completeness,
      occurred_at: row.occurred_at,
      summary_available: Boolean(row.demand_unit_title || row.demand_unit_describe),
    }));
    const events = this.database.raw
      .prepare('SELECT * FROM task_event WHERE task_id = ? ORDER BY occurred_at DESC, recorded_at DESC')
      .all(taskId);
    const references = this.database.raw
      .prepare('SELECT * FROM reference_binding WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId);
    const approvals = (this.database.raw
      .prepare('SELECT id, action_type, status, created_at, decided_at FROM approval WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as Array<Record<string, unknown>>).map(approvalDraftDto);
    const outboxDrafts = (this.database.raw
      .prepare(
        `SELECT outbox.id, outbox.approval_id, outbox.action_type, outbox.status, outbox.created_at
         FROM outbox
         JOIN approval ON approval.id = outbox.approval_id
         WHERE approval.task_id = ?
         ORDER BY outbox.created_at DESC`,
      )
      .all(taskId) as Array<Record<string, unknown>>).map(outboxDraftDto);
    const thread = task.thread_id
      ? this.database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(task.thread_id) as unknown as RequirementThreadRow | undefined
      : undefined;
    const updateProposals = this.database.raw.prepare(
      'SELECT * FROM task_update_proposal WHERE task_id = ? ORDER BY created_at DESC',
    ).all(taskId) as unknown as TaskUpdateProposalRow[];
    const runtimeJobs = this.database.raw.prepare(
      `SELECT id, job_type, status, attempts, max_attempts, retryable, available_at, last_error, created_at, updated_at
       FROM job
       WHERE task_id = ? OR source_event_id IN (SELECT source_event_id FROM task_source_link WHERE task_id = ?)
       ORDER BY updated_at DESC LIMIT 20`,
    ).all(taskId, taskId);
    const relatedSourceIds = [
      ...(sourceRows as Array<Record<string, unknown>>).map((row) => typeof row.id === 'string' ? row.id : null),
      ...(events as Array<Record<string, unknown>>).map((event) => typeof event.source_event_id === 'string' ? event.source_event_id : null),
      ...updateProposals.map((proposal) => proposal.source_event_id),
    ].filter((value): value is string => Boolean(value));
    const sourceContents = this.sourceContentsForTask(taskId, relatedSourceIds);
    const publicDetail = {
      id: task.id,
      title: safeCandidateNarrative(task.title, sourceContents, '任务标题已生成；来源正文默认隐藏。', 160),
      // Do not heuristically authorize sender identity. Public task details
      // expose only the fixed role label; internal callers retain the raw row.
      proposer_name: options.internal ? task.proposer_name : '需求方',
      describe: safeCandidateNarrative(task.describe, sourceContents, '任务摘要已生成；来源正文默认隐藏。', 2_000),
      status: task.status,
      schedule_at: safePublicTimestamp(task.schedule_at),
      planned_start_at: safePublicTimestamp(task.planned_start_at),
      planned_due_at: safePublicTimestamp(task.planned_due_at),
      next_step: safeCandidateNarrative(task.next_step, sourceContents, '下一步已记录；来源正文默认隐藏。', 1_000),
      risk: task.risk,
      waiting_reason: task.waiting_reason === null
        ? null
        : safeCandidateNarrative(task.waiting_reason, sourceContents, '等待原因已记录；来源正文默认隐藏。', 1_000),
      version: task.version,
      completed_at: safePublicTimestamp(task.completed_at),
      archived_at: safePublicTimestamp(task.archived_at),
      deleted_at: safePublicTimestamp(task.deleted_at),
      record_state: task.record_state,
      merged_into_task_id: task.merged_into_task_id,
      auto_update_paused: task.auto_update_paused,
      created_at: task.created_at,
      updated_at: task.updated_at,
      sources: options.internal ? sourceRows : sourceDtos,
      events: options.internal ? events : (events as Array<Record<string, unknown>>).map((event) => ({
        id: event.id,
        event_type: event.event_type,
        actor_type: event.actor_type,
        visibility: event.visibility,
        summary: safeCandidateNarrative(event.summary, sourceContents, '任务事件摘要已保留；来源正文默认隐藏。', 500),
        occurred_at: event.occurred_at,
        recorded_at: event.recorded_at,
        version: event.version,
      })),
      // A reference path can reveal the owner's filesystem layout. Keep the
      // binding usable for remove/inspect actions without returning the path.
      references: options.internal ? references : (references as Array<Record<string, unknown>>).map((reference) => ({
        id: reference.id,
        label: safeCandidateNarrative(reference.label, sourceContents, '受控参考已保留；具体内容需主人主动核验。', 200),
        access_mode: reference.access_mode,
        created_at: reference.created_at,
        path_bound: true,
      })),
      approvals: options.internal ? approvals : (approvals as Array<Record<string, unknown>>).map((approval) => ({
        id: approval.id,
        action_type: approval.action_type,
        status: approval.status,
        created_at: approval.created_at,
        decided_at: approval.decided_at,
      })),
      thread: thread ? {
        id: thread.id,
        status: thread.status,
        title: safeCandidateNarrative(thread.title, sourceContents, '线程摘要已保留；来源正文默认隐藏。', 160),
        background: safeCandidateNarrative(thread.background, sourceContents, '线程背景已保留；来源正文默认隐藏。', 2_000),
        validation_question: safeCandidateNarrative(thread.validation_question, sourceContents, '线程验证问题已保留；来源正文默认隐藏。', 1_000),
        describe: safeCandidateNarrative(thread.describe, sourceContents, '线程摘要已生成；来源正文默认隐藏。', 2_000),
        version: thread.version,
        last_activity_at: thread.last_activity_at,
        ambiguity: [],
      } : null,
      update_proposals: updateProposals.map((proposal) => this.taskUpdateProposalView(proposal, {
        public: !options.internal,
        sourceContents,
      })),
      auto_updates: updateProposals
        .filter((proposal) => proposal.decision_mode === 'auto' || proposal.decision_mode === 'reverted')
        .map((proposal) => this.taskUpdateProposalView(proposal, {
          public: !options.internal,
          sourceContents,
        })),
      memory_projection: this.getMemoryProjectionView(taskId),
      runtime_jobs: options.internal ? runtimeJobs : (runtimeJobs as RuntimeJobRow[]).map((job) => this.runtimeJobView(job)),
    };
    return options.internal ? publicDetail : taskDetailDtoSchema.parse(publicDetail);
  }

  /**
   * Read the complete source → demand unit → candidate/thread/task graph and
   * every related AI/owner/audit record. The ID sets grow monotonically until
   * a fixpoint; a hard cap prevents an accidental pathological graph from
   * becoming an unbounded read.
   */

  getMemoryProjection(taskId: string) {
    return (this.database.raw.prepare('SELECT * FROM memory_projection WHERE task_id = ?').get(taskId) as MemoryProjectionRecord | undefined) ?? null;
  }

  getMemoryProjectionView(taskId: string) {
    const projection = this.getMemoryProjection(taskId);
    if (!projection) return null;
    return {
      task_id: projection.task_id,
      projection_version: projection.projection_version,
      // The persisted projection path includes a title-derived slug and can
      // therefore repeat source text. The renderer only needs a stable label;
      // Electron resolves the real directory from task_id server-side.
      relative_path: `tasks/${projection.task_id}`,
      state: projection.state,
      last_error: publicMemoryProjectionError(projection.last_error),
      last_projected_at: projection.last_projected_at,
      updated_at: projection.updated_at,
    };
  }

  resolveTaskMemoryDirectory(taskId: string) {
    const projection = this.getMemoryProjection(taskId);
    if (!projection) throw new Error('任务记忆投影不存在，请先重新生成。');
    if (projection.state !== 'ready') throw new Error('任务记忆尚未就绪，请先重新生成。');
    const configuredRoot = this.assertTaskMemoryRootSafe(resolve(this.config.taskMemoryRoot));
    if (!this.samePath(projection.root_path, configuredRoot)) {
      throw new Error('任务记忆保存位置已经变化，请先重新生成。');
    }
    const directory = this.assertProjectionPathSafe(configuredRoot, projection.relative_path);
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
      throw new Error('任务记忆目录已不存在，请先重新生成。');
    }
    return directory;
  }

  private atomicMemoryWrite(path: string, content: string) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, path);
  }

  private pathWithin(childPath: string, parentPath: string) {
    const child = resolve(childPath);
    const parent = resolve(parentPath);
    const left = process.platform === 'win32' ? child.toLowerCase() : child;
    const right = process.platform === 'win32' ? parent.toLowerCase() : parent;
    return left === right || left.startsWith(right + sep);
  }

  private samePath(leftPath: string, rightPath: string) {
    const left = resolve(leftPath);
    const right = resolve(rightPath);
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  private assertTaskMemoryRootSafe(rootPath: string) {
    const root = resolve(rootPath);
    const rootAnchor = dirname(root) === root ? root : dirname(root);
    let current = root;
    const existingAncestors: string[] = [];
    while (true) {
      if (existsSync(current)) existingAncestors.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const ancestor of existingAncestors) {
      const stat = lstatSync(ancestor);
      const real = realpathSync(ancestor);
      if (stat.isSymbolicLink() || !this.samePath(real, ancestor)) {
        throw new Error('任务记忆根目录及其父目录不能经过符号链接或 junction。');
      }
    }
    const existingRootBase = existingAncestors[0] ?? rootAnchor;
    const rootRealBase = existsSync(existingRootBase) ? realpathSync(existingRootBase) : existingRootBase;
    const projectedRootReal = resolve(rootRealBase, relative(existingRootBase, root));
    for (const allowed of this.config.workspace.allowedPaths) {
      const allowedPath = resolve(allowed);
      let allowedComparable = allowedPath;
      if (existsSync(allowedPath)) {
        const allowedStat = lstatSync(allowedPath);
        const allowedReal = realpathSync(allowedPath);
        if (allowedStat.isSymbolicLink() || !this.samePath(allowedReal, allowedPath)) {
          throw new Error('实际工作目录授权不能经过符号链接或 junction。');
        }
        allowedComparable = allowedReal;
      }
      if (this.pathWithin(projectedRootReal, allowedComparable) || this.pathWithin(allowedComparable, projectedRootReal)) {
        throw new Error('任务记忆目录不能位于实际工作目录或其父目录内；请单独选择系统自有目录。');
      }
    }
    return root;
  }

  private assertProjectionPathSafe(rootPath: string, relativePath: string) {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).some((part) => part === '..')) {
      throw new Error('任务记忆投影路径必须是根目录内的相对路径。');
    }
    const directory = resolve(rootPath, relativePath);
    if (!this.pathWithin(directory, rootPath)) throw new Error('任务记忆投影路径越过了根目录边界。');
    let current = resolve(rootPath);
    for (const part of relativePath.split(/[\\/]+/u).filter(Boolean)) {
      current = join(current, part);
      if (existsSync(current)) {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !this.samePath(realpathSync(current), current)) {
          throw new Error('任务记忆投影路径不能经过符号链接或 junction。');
        }
      }
    }
    return directory;
  }

  private normalizeManagedProjectionFile(relativeFile: string) {
    const normalized = relativeFile.replaceAll('\\', '/').replace(/^\.\//u, '');
    if (!normalized || isAbsolute(normalized) || normalized.split('/').some((part) => !part || part === '..')) {
      throw new Error('任务记忆托管文件清单包含无效路径，已停止清理。');
    }
    return normalized;
  }

  private assertManagedProjectionFileSafe(directory: string, relativeFile: string) {
    const normalized = this.normalizeManagedProjectionFile(relativeFile);
    const parts = normalized.split('/');
    const filePath = resolve(directory, ...parts);
    if (!this.pathWithin(filePath, directory) || filePath === resolve(directory)) {
      throw new Error('任务记忆托管文件越过了任务目录边界。');
    }
    let current = resolve(directory);
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      if (existsSync(current)) {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || !this.samePath(realpathSync(current), current)) {
          throw new Error('任务记忆托管文件路径不能经过符号链接或 junction。');
        }
      }
    }
    if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
      throw new Error('任务记忆托管文件不能是符号链接。');
    }
    if (existsSync(filePath) && !this.samePath(realpathSync(filePath), filePath)) {
      throw new Error('任务记忆托管文件不能是 junction 或其他 reparse point。');
    }
    return { normalized, filePath };
  }

  private cleanManagedProjectionFiles(directory: string, managedFiles: string[]) {
    let removed = 0;
    for (const item of [...new Set(managedFiles)]) {
      if (typeof item !== 'string') continue;
      const { filePath } = this.assertManagedProjectionFileSafe(directory, item);
      if (!existsSync(filePath)) continue;
      const stat = lstatSync(filePath);
      if (!stat.isFile()) throw new Error('任务记忆托管清单指向了目录，已停止清理以保护未知文件。');
      rmSync(filePath, { force: true });
      removed += 1;
    }
    return removed;
  }

  private recoverLegacyManagedProjectionFiles(directory: string, projection: MemoryProjectionRecord | null) {
    if (!projection || projection.state !== 'ready' || !projection.checksum || !projection.last_projected_at) return [] as string[];
    const index = this.assertManagedProjectionFileSafe(directory, 'updates/index.json');
    if (!existsSync(index.filePath) || !lstatSync(index.filePath).isFile()) return [] as string[];
    try {
      const legacy = JSON.parse(readFileSync(index.filePath, 'utf8')) as {
        taskEvents?: Array<{ id?: unknown }>;
        confirmedRevisions?: Array<{ proposalId?: unknown }>;
      };
      if (!Array.isArray(legacy.taskEvents) || !Array.isArray(legacy.confirmedRevisions)) return [] as string[];
      const files = [
        'task.json',
        'brief.md',
        'sources.md',
        'artifacts.json',
        'updates/index.json',
        ...legacy.taskEvents.flatMap((event) => typeof event?.id === 'string' && event.id ? [`updates/${safeSlug(event.id)}.md`] : []),
        ...legacy.confirmedRevisions.flatMap((revision) => typeof revision?.proposalId === 'string' && revision.proposalId ? [`updates/proposal-${safeSlug(revision.proposalId)}.md`] : []),
      ];
      return [...new Set(files.map((file) => this.normalizeManagedProjectionFile(file)))];
    } catch {
      return [] as string[];
    }
  }

  private memorySafeReferencePath(referencePath: string) {
    const normalized = referencePath.replaceAll('\\', '/');
    if (normalized.startsWith('workspace://')) {
      const suffix = normalized.slice('workspace://'.length).replace(/^\/+/, '');
      return `workspace/${suffix || 'root'}`;
    }
    if (isAbsolute(referencePath)) {
      const allowed = this.config.workspace.allowedPaths.find((item) => this.pathWithin(referencePath, item));
      if (!allowed) return 'workspace/<authorized-path-unavailable>';
      const suffix = relative(resolve(allowed), resolve(referencePath)).replaceAll('\\', '/');
      return `workspace/${suffix || 'root'}`;
    }
    if (normalized.split('/').some((part) => part === '..')) return 'workspace/<invalid-relative-path>';
    return `workspace/${normalized.replace(/^\/+/, '') || 'root'}`;
  }

  /**
   * The task-memory directory is a rebuildable, system-owned projection.
   * It never becomes the source of truth and never writes to reference paths.
   */
  projectTaskMemory(taskId: string) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('任务不存在。');
    const rootPath = resolve(this.config.taskMemoryRoot);
    const timestamp = nowIso();
    const existing = this.getMemoryProjection(taskId);
    // Keep the first directory stable when a title changes so an update cannot
    // leave multiple stale task folders behind.
    const relativePath = existing?.relative_path ?? join('tasks', `${task.id}-${safeSlug(task.title)}`);
    if (!existing) {
      this.database.raw.prepare(
        `INSERT INTO memory_projection
          (id, task_id, projection_version, root_path, relative_path, state, checksum, last_error, last_projected_at, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`,
      ).run(id('memory'), taskId, rootPath, relativePath, timestamp, timestamp);
    } else {
      this.database.raw.prepare("UPDATE memory_projection SET state = 'pending', last_error = NULL, updated_at = ? WHERE task_id = ?").run(timestamp, taskId);
    }

    const memoryTool = this.runtime.authorizeTool(null, 'memory.project', { taskId }, true);
    try {
      if (!memoryTool.allowed) throw new Error(`Runtime 禁止任务记忆投影：${memoryTool.reason}`);
      this.assertTaskMemoryRootSafe(rootPath);
      const detail = this.getTaskDetail(taskId, { internal: true })!;
      const lastSource = detail.sources[detail.sources.length - 1] as { id?: unknown } | undefined;
      const lastSourceId = typeof lastSource?.id === 'string' ? lastSource.id : '';
      const sourceThread = !task.thread_id && lastSourceId ? this.sourceThreadId(lastSourceId) : null;
      const thread = task.thread_id
        ? this.database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(task.thread_id) as unknown as RequirementThreadRow | undefined
        : sourceThread
          ? this.database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(sourceThread) as unknown as RequirementThreadRow | undefined
          : undefined;
      const directory = this.assertProjectionPathSafe(rootPath, relativePath);
      const taskJson = JSON.stringify({
        task,
        threadId: thread?.id ?? null,
        sourceIds: detail.sources.map((source: Record<string, unknown>) => String(source.external_id ?? source.id ?? '')),
        projectionVersion: task.version,
        generatedAt: timestamp,
      }, null, 2);
      const brief = [
        `# ${task.title}`,
        '',
        `- 任务 ID：${task.id}`,
        `- 提出人：${task.proposer_name}`,
        `- 状态：${task.status}`,
        `- 风险：${task.risk}`,
        `- 我的计划开始：${task.planned_start_at ?? '未知'}`,
        `- 我的计划完成：${task.planned_due_at ?? '未知'}`,
        '',
        '## Describe',
        '',
        task.describe || '未知',
        '',
        '## 当前下一步',
        '',
        task.next_step || '未知',
        '',
        '## 线程背景',
        '',
        thread && typeof thread.background === 'string' ? thread.background || '未知' : '未知',
        '',
        '## 投影边界',
        '',
        '只包含主人已确认的正式任务与线程状态；待确认提案不会写入任务记忆目录。',
        '',
      ].join('\n');
      const sources = [
        '# 来源索引',
        '',
        ...detail.sources.map((source: Record<string, unknown>) => {
          const sourceContent = typeof source.content === 'string' ? source.content : '';
          const sourceHash = createHash('sha256').update(sourceContent).digest('hex');
          return [
            `## ${String(source.occurred_at ?? '未知时间')} · ${String(source.sender_name ?? '未知发送人')}`,
            `- 来源类型：${String(source.source_type ?? '未知')}`,
            `- 来源链接：${String(source.source_url ?? '无')}`,
            `- 来源标识哈希：${createHash('sha256').update(String(source.external_id ?? '')).digest('hex').slice(0, 16) || '未知'}`,
            `- 正文哈希：${sourceHash}`,
            `- 正文长度：${sourceContent.length}`,
            '',
          ].join('\n');
        }),
      ].join('\n');
      const updates = detail.events.map((event: Record<string, unknown>) => ({
        id: String(event.id),
        eventType: String(event.event_type),
        summary: String(event.summary),
        version: Number(event.version),
        occurredAt: String(event.occurred_at),
      }));
      const approvedProposals = this.database.raw.prepare(
        "SELECT * FROM task_update_proposal WHERE task_id = ? AND state = 'approved' AND reverted_at IS NULL ORDER BY decided_at ASC, created_at ASC",
      ).all(taskId) as unknown as TaskUpdateProposalRow[];
      const confirmedRevisions = approvedProposals.map((proposal) => ({
        proposalId: proposal.id,
        candidateRevisionId: proposal.candidate_revision_id,
        threadRevisionId: proposal.thread_revision_id,
        baseTaskVersion: proposal.base_task_version,
        baseThreadVersion: proposal.base_thread_version,
        patch: parseMetadata(proposal.patch_json),
        evidence: parseJsonValue<unknown>(proposal.evidence_json, []),
        provider: proposal.provider,
        model: proposal.model,
        promptVersion: proposal.prompt_version,
        createdAt: proposal.created_at,
        decidedAt: proposal.decided_at,
      }));
      const artifacts = JSON.stringify({
        references: detail.references.map((reference: Record<string, unknown>) => {
          const snapshot = this.database.raw.prepare(
            'SELECT state, entry_count, truncated, entries_json, error, inspected_at FROM reference_snapshot WHERE reference_binding_id = ? ORDER BY inspected_at DESC LIMIT 1',
          ).get(String(reference.id ?? '')) as { state?: string; entry_count?: number; truncated?: number; entries_json?: string; error?: string | null; inspected_at?: string } | undefined;
          const entries = parseJsonValue<unknown[]>(snapshot?.entries_json, []).filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
            .map((entry) => ({
              relativePath: typeof entry.relativePath === 'string' ? entry.relativePath.replaceAll('\\', '/') : '未知',
              type: typeof entry.type === 'string' ? entry.type : '未知',
              size: typeof entry.size === 'number' ? entry.size : null,
              modifiedAt: typeof entry.modifiedAt === 'string' ? entry.modifiedAt : null,
            }));
          return {
            label: reference.label,
            referencePath: this.memorySafeReferencePath(String(reference.reference_path ?? '')),
            accessMode: reference.access_mode,
            snapshot: snapshot ? {
              state: snapshot.state ?? 'unknown',
              entryCount: snapshot.entry_count ?? entries.length,
              truncated: Boolean(snapshot.truncated),
              inspectedAt: snapshot.inspected_at ?? null,
              error: snapshot.error ? String(snapshot.error).slice(0, 160) : null,
              entries,
            } : null,
          };
        }),
        note: '实际工作目录只读；此文件不复制或修改工作文件。',
      }, null, 2);
      const managedFiles = [
        'task.json',
        'brief.md',
        'sources.md',
        'artifacts.json',
        'updates/index.json',
        ...updates.map((update) => `updates/${safeSlug(update.id)}.md`),
        ...confirmedRevisions.map((revision) => `updates/proposal-${safeSlug(revision.proposalId)}.md`),
      ].map((item) => this.normalizeManagedProjectionFile(item));
      const storedManagedFiles = parseJsonValue<unknown[]>(existing?.managed_files_json, [])
        .filter((item): item is string => typeof item === 'string');
      const previousManagedFiles = storedManagedFiles.length
        ? storedManagedFiles
        : this.recoverLegacyManagedProjectionFiles(directory, existing);
      const cleanupManifest = [...new Set([...previousManagedFiles, ...managedFiles])];
      this.database.raw.prepare('UPDATE memory_projection SET managed_files_json = ?, updated_at = ? WHERE task_id = ?')
        .run(JSON.stringify(cleanupManifest), timestamp, taskId);
      mkdirSync(directory, { recursive: true });
      this.cleanManagedProjectionFiles(directory, previousManagedFiles);
      const updatesDirectory = join(directory, 'updates');
      if (existsSync(updatesDirectory) && lstatSync(updatesDirectory).isSymbolicLink()) {
        throw new Error('任务记忆 updates 目录不能是符号链接或 junction。');
      }
      mkdirSync(updatesDirectory, { recursive: true });
      this.atomicMemoryWrite(join(directory, 'task.json'), taskJson);
      this.atomicMemoryWrite(join(directory, 'brief.md'), brief);
      this.atomicMemoryWrite(join(directory, 'sources.md'), sources);
      this.atomicMemoryWrite(join(directory, 'artifacts.json'), artifacts);
      this.atomicMemoryWrite(join(directory, 'updates', 'index.json'), JSON.stringify({ taskEvents: updates, confirmedRevisions }, null, 2));
      for (const update of updates) {
        this.atomicMemoryWrite(join(directory, 'updates', `${safeSlug(update.id)}.md`), `# ${update.eventType}\n\n${update.summary}\n\n- 版本：${update.version}\n- 时间：${update.occurredAt}\n`);
      }
      for (const revision of confirmedRevisions) {
        const patchJson = JSON.stringify(revision.patch, null, 2);
        const evidenceJson = JSON.stringify(revision.evidence, null, 2);
        this.atomicMemoryWrite(
          join(directory, 'updates', `proposal-${safeSlug(revision.proposalId)}.md`),
          `# 已确认更新 ${revision.proposalId}\n\n- 候选修订：${revision.candidateRevisionId ?? '无'}\n- 线程修订：${revision.threadRevisionId ?? '无'}\n- 基于任务版本：v${revision.baseTaskVersion}\n- 基于线程版本：${revision.baseThreadVersion === null ? '无' : `v${revision.baseThreadVersion}`}\n- 模型：${revision.provider || '本地规则'}${revision.model ? ` / ${revision.model}` : ''}\n- 确认时间：${revision.decidedAt ?? '未知'}\n\n## Patch\n\n\`\`\`json\n${patchJson}\n\`\`\`\n\n## 证据\n\n\`\`\`json\n${evidenceJson}\n\`\`\`\n`,
        );
      }
      const checksum = createHash('sha256').update(`${taskJson}\n${brief}\n${sources}\n${artifacts}\n${JSON.stringify(updates)}\n${JSON.stringify(confirmedRevisions)}`).digest('hex');
      this.database.raw.prepare(
        `UPDATE memory_projection
         SET projection_version = ?, root_path = ?, relative_path = ?, state = 'ready', checksum = ?, last_error = NULL,
             managed_files_json = ?, last_projected_at = ?, updated_at = ?
         WHERE task_id = ?`,
      ).run(task.version, rootPath, relativePath, checksum, JSON.stringify(managedFiles), timestamp, timestamp, taskId);
      this.runtime.completeToolCall(memoryTool.callId, { taskId, projectionVersion: task.version });
    } catch (error) {
      this.runtime.failToolCall(memoryTool.callId, error);
      const message = sanitizeRuntimeError(error, 300);
      this.database.raw.prepare("UPDATE memory_projection SET state = 'error', last_error = ?, updated_at = ? WHERE task_id = ?").run(message, timestamp, taskId);
      this.log('runtime', 'error', 'memory.projection_failed', '任务记忆投影失败，正式任务保留并等待重试。', { taskId, error: message });
    }
    return this.getMemoryProjection(taskId);
  }

  rebuildTaskMemory(taskId: string) {
    const projection = this.projectTaskMemory(taskId);
    this.log(
      'runtime',
      projection?.state === 'ready' ? 'info' : 'warn',
      'memory.rebuilt',
      projection?.state === 'ready' ? '已清理系统托管的旧文件并重建任务记忆。' : '任务记忆清理重建未完成。',
      { taskId, state: projection?.state ?? 'missing' },
    );
    return this.getMemoryProjectionView(taskId);
  }

  private resolveTaskPatch(task: TaskRecord, patch: TaskPatch) {
    const next = {
      title: patch.title ?? task.title,
      describe: patch.describe ?? task.describe,
      status: patch.status ?? task.status,
      scheduleAt: patch.scheduleAt === undefined ? task.schedule_at : patch.scheduleAt,
      plannedStartAt: patch.plannedStartAt === undefined ? task.planned_start_at : patch.plannedStartAt,
      plannedDueAt: patch.plannedDueAt === undefined
        ? (patch.scheduleAt === undefined ? task.planned_due_at : patch.scheduleAt)
        : patch.plannedDueAt,
      nextStep: patch.nextStep ?? task.next_step,
      risk: patch.risk ?? task.risk,
      waitingReason: patch.waitingReason === undefined ? task.waiting_reason : patch.waitingReason,
    };
    assertShanghaiCalendarPlanRange(next.plannedStartAt, next.plannedDueAt);
    return next;
  }

  private applyTaskPatch(
    task: TaskRecord,
    patch: TaskPatch,
    options: {
      actorType?: string;
      visibility?: 'private' | 'awaiting_approval' | 'external';
      eventType?: string;
      taskEventId?: string;
      summary?: string;
      sourceEventId?: string | null;
      demandUnitId?: string | null;
      afterTransaction?: (timestamp: string, nextVersion: number, taskEventId: string) => void;
    } = {},
  ) {
    if (task.record_state === 'invalidated') throw new Error('无效记录只能查看和纠错，不能继续修改任务。');
    if (task.deleted_at) throw new Error('回收站中的任务只能恢复或查看，不能继续修改。');
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== task.version) throw new Error('任务已被其他操作更新，请刷新后重试。');
    const next = this.resolveTaskPatch(task, patch);
    const timestamp = nowIso();
    const nextVersion = task.version + 1;
    const completedAt = next.status === 'completed' ? task.completed_at ?? timestamp : next.status === 'archived' ? task.completed_at : null;
    const archivedAt = next.status === 'archived' ? task.archived_at ?? timestamp : null;
    const taskEventId = options.taskEventId ?? id('evt');
    const summary = options.summary ?? (patch.plannedStartAt !== undefined || patch.plannedDueAt !== undefined || patch.scheduleAt !== undefined
      ? '系统主人更新了我的计划时间。'
      : '系统主人更新了任务信息。');
    this.database.transaction(() => {
      const result = this.database.raw.prepare(
        `UPDATE task SET title = ?, describe = ?, status = ?, schedule_at = ?, planned_start_at = ?, planned_due_at = ?, next_step = ?, risk = ?, waiting_reason = ?,
           version = ?, completed_at = ?, archived_at = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      ).run(
        next.title,
        next.describe,
        next.status,
        next.plannedDueAt,
        next.plannedStartAt,
        next.plannedDueAt,
        next.nextStep,
        next.risk,
        next.waitingReason,
        nextVersion,
        completedAt,
        archivedAt,
        timestamp,
        task.id,
        task.version,
      );
      if (result.changes !== 1) throw new Error('任务已被其他操作更新，请刷新后重试。');
      this.database.raw.prepare(
        `INSERT INTO task_event
          (id, task_id, event_type, actor_type, visibility, summary, source_event_id, demand_unit_id, before_json, after_json, occurred_at, recorded_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        taskEventId,
        task.id,
        options.eventType ?? 'task_updated',
        options.actorType ?? 'user',
        options.visibility ?? 'private',
        summary,
        options.sourceEventId ?? null,
        options.demandUnitId ?? (options.sourceEventId ? this.uniqueSourceDemandUnitId(options.sourceEventId) : null),
        JSON.stringify(taskAuditSnapshot(task)),
        JSON.stringify({ ...taskAuditSnapshot(task), ...next, version: nextVersion, updated_at: timestamp }),
        timestamp,
        timestamp,
        nextVersion,
      );
      options.afterTransaction?.(timestamp, nextVersion, taskEventId);
    });
    this.projectTaskMemory(task.id);
    return this.getTaskDetail(task.id);
  }

  updateTask(taskId: string, patch: TaskPatch) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('任务不存在。');
    return this.applyTaskPatch(task, patch);
  }

  private refreshThreadProposalStatus(threadId: string, timestamp: string) {
    const pending = this.database.raw.prepare(
      "SELECT COUNT(*) AS count FROM task_update_proposal WHERE thread_id = ? AND state = 'awaiting_approval'",
    ).get(threadId) as { count: number };
    this.database.raw.prepare(
      `UPDATE requirement_thread
       SET status = ?, updated_at = ?
       WHERE id = ? AND status <> 'closed'`,
    ).run(pending.count > 0 ? 'needs_confirmation' : 'open', timestamp, threadId);
  }

  private markTaskUpdateProposalStale(proposal: TaskUpdateProposalRow) {
    const timestamp = nowIso();
    this.database.transaction(() => {
      const updated = this.database.raw.prepare(
        "UPDATE task_update_proposal SET state = 'stale', decided_at = ? WHERE id = ? AND state = 'awaiting_approval'",
      ).run(timestamp, proposal.id);
      if (updated.changes !== 1) return;
      if (proposal.thread_revision_id) {
        this.database.raw.prepare("UPDATE requirement_thread_revision SET state = 'stale', decided_at = ? WHERE id = ? AND state = 'proposed'")
          .run(timestamp, proposal.thread_revision_id);
      }
      if (proposal.candidate_revision_id) {
        this.database.raw.prepare("UPDATE candidate_revision SET state = 'superseded' WHERE id = ? AND state = 'proposed'")
          .run(proposal.candidate_revision_id);
      }
      if (proposal.thread_id) this.refreshThreadProposalStatus(proposal.thread_id, timestamp);
    });
  }

  private markSupersededTaskProposalsStale(taskId: string, approvedProposalId: string, nextTaskVersion: number, timestamp: string) {
    const siblings = this.database.raw.prepare(
      `SELECT * FROM task_update_proposal
       WHERE task_id = ? AND id <> ? AND state = 'awaiting_approval' AND base_task_version < ?`,
    ).all(taskId, approvedProposalId, nextTaskVersion) as unknown as TaskUpdateProposalRow[];
    const affectedThreadIds = new Set<string>();
    for (const sibling of siblings) {
      const updated = this.database.raw.prepare(
        "UPDATE task_update_proposal SET state = 'stale', decided_at = ? WHERE id = ? AND state = 'awaiting_approval'",
      ).run(timestamp, sibling.id);
      if (updated.changes !== 1) continue;
      if (sibling.thread_revision_id) {
        this.database.raw.prepare("UPDATE requirement_thread_revision SET state = 'stale', decided_at = ? WHERE id = ? AND state = 'proposed'")
          .run(timestamp, sibling.thread_revision_id);
      }
      if (sibling.candidate_revision_id) {
        this.database.raw.prepare("UPDATE candidate_revision SET state = 'superseded' WHERE id = ? AND state = 'proposed'")
          .run(sibling.candidate_revision_id);
      }
      if (sibling.thread_id) affectedThreadIds.add(sibling.thread_id);
    }
    for (const threadId of affectedThreadIds) this.refreshThreadProposalStatus(threadId, timestamp);
  }

  private proposalAutomationDecision(proposal: TaskUpdateProposalRow, task: TaskRecord, patch: TaskPatch) {
    if (this.automationPolicy().mode !== 'auto') return { apply: false, reason: '全局当前为仅建议模式。' };
    if (task.auto_update_paused) return { apply: false, reason: '这项任务已暂停 AI 自动维护。' };
    if (task.record_state === 'invalidated' || task.deleted_at) return { apply: false, reason: '无效或回收站任务不能自动更新。' };
    if (proposal.used_fallback) return { apply: false, reason: '本次使用了规则降级，不能自动写入。' };
    if ((proposal.association_confidence ?? 0) < AUTO_ASSOCIATION_CONFIDENCE) return { apply: false, reason: '需求归属置信度不足。' };
    if ((proposal.update_confidence ?? 0) < AUTO_UPDATE_CONFIDENCE) return { apply: false, reason: '字段修改置信度不足。' };
    const candidateAnalysis = proposal.candidate_revision_id
      ? this.database.raw.prepare('SELECT analysis_json FROM candidate_revision WHERE id = ?').get(proposal.candidate_revision_id) as { analysis_json: string } | undefined
      : undefined;
    const proposalEvidence = parseMetadata(proposal.evidence_json);
    const analysis = candidateAnalysis
      ? parseMetadata(candidateAnalysis.analysis_json)
      : objectValue(proposalEvidence.analysis);
    const linkedDocuments = Array.isArray(analysis.linkedDocuments)
      ? analysis.linkedDocuments.filter((document): document is { freshness?: unknown } => Boolean(document && typeof document === 'object' && !Array.isArray(document)))
      : [];
    if (linkedDocuments.some((document) => document.freshness !== 'fresh')) return { apply: false, reason: '来源包含可能过期的文档背景，不能自动写入。' };
    if (!Object.keys(patch).length) return { apply: false, reason: '完整叙述变化需要主人确认；AI 不会用单条补充自动覆盖需求摘要。' };
    if (proposal.origin !== 'owner_association') {
      const evidence = proposalEvidence;
      const relationType = typeof evidence.relationType === 'string' ? evidence.relationType : '';
      if (!['reply_root', 'reply_parent', 'session', 'owner_confirmed', 'semantic_unique'].includes(relationType)) return { apply: false, reason: '当前关联证据仍需主人确认。' };
    }
    if ((patch.plannedStartAt !== undefined || patch.plannedDueAt !== undefined)) {
      const candidate = proposal.candidate_revision_id
        ? this.database.raw.prepare('SELECT analysis_json FROM candidate_revision WHERE id = ?').get(proposal.candidate_revision_id) as { analysis_json: string } | undefined
        : undefined;
      const analysis = candidate
        ? parseMetadata(candidate.analysis_json)
        : objectValue(proposalEvidence.analysis);
      const timeRange = objectValue(analysis.timeRange);
      if (timeRange.needsConfirmation === true || timeRange.status === 'inferred') return { apply: false, reason: '计划时间仍需主人确认。' };
    }
    if (patch.status === 'completed' || patch.status === 'archived') {
      if ((proposal.update_confidence ?? 0) < AUTO_TERMINAL_STATUS_CONFIDENCE) {
        return { apply: false, reason: '完成或归档需要更高置信度的明确证据。' };
      }
      const source = proposal.source_event_id
        ? this.database.raw.prepare('SELECT content, metadata_json FROM source_event WHERE id = ?').get(proposal.source_event_id) as { content: string; metadata_json: string } | undefined
        : undefined;
      const sourceMetadata = parseMetadata(source?.metadata_json);
      const batchSourceIds = Array.isArray(sourceMetadata.classificationBatchSourceIds)
        ? sourceMetadata.classificationBatchSourceIds.filter((value): value is string => typeof value === 'string')
        : [];
      const evidenceRows = batchSourceIds.length
        ? this.database.raw.prepare(`SELECT content FROM source_event WHERE id IN (${batchSourceIds.map(() => '?').join(',')})`).all(...batchSourceIds) as Array<{ content: string }>
        : source ? [{ content: source.content }] : [];
      const terminalStatus = patch.status;
      const terminalEvidence = evidenceRows.some((row) => hasExplicitTerminalEvidence(row.content, terminalStatus));
      if (!terminalEvidence) return { apply: false, reason: '来源正文没有明确表达完成、交付、取消或不再处理。' };
    }
    return { apply: true, reason: '唯一强关联、模型未降级、双重置信度及版本门槛均通过。' };
  }

  private dispatchTaskUpdateProposal(proposalId: string, runtimeJobId: string | null, leaseOwner: string | null = null) {
    // Validate the caller's original fence before touching the proposal. A
    // reclaimed job must never borrow the current owner's token by rereading
    // the mutable job row here.
    const proposal = this.database.raw.prepare('SELECT * FROM task_update_proposal WHERE id = ?').get(proposalId) as unknown as TaskUpdateProposalRow | undefined;
    if (!proposal || proposal.state !== 'awaiting_approval') return null;
    const task = this.getTask(proposal.task_id);
    if (!task) return null;
    const patch = parseTaskUpdatePatch(proposal.patch_json);
    const decision = this.proposalAutomationDecision(proposal, task, patch);
    this.database.raw.prepare(
      'UPDATE task_update_proposal SET policy_version = ?, policy_reason = ? WHERE id = ? AND state = \'awaiting_approval\'',
    ).run(AUTO_UPDATE_POLICY_VERSION, decision.reason, proposal.id);
    if (!decision.apply) return this.getTaskUpdateProposal(proposal.id);
    return this.runtime.executeToolSync({
      jobId: runtimeJobId,
      toolName: 'task.auto_apply_update',
      toolInput: { proposalId: proposal.id, taskId: proposal.task_id, baseTaskVersion: proposal.base_task_version },
      leaseOwner: runtimeJobId ? (leaseOwner ?? undefined) : undefined,
      run: () => this.applyTaskUpdateProposal(proposal.id, 'ai'),
      auditResult: (detail) => ({ proposalId: proposal.id, taskId: proposal.task_id, taskVersion: detail?.version ?? proposal.base_task_version }),
    });
  }

  private dispatchPendingProposalsForSources(sourceEventIds: string[], runtimeJobId: string | null, leaseOwner: string | null = null) {
    if (!sourceEventIds.length) return;
    const placeholders = sourceEventIds.map(() => '?').join(',');
    const proposals = this.database.raw.prepare(
      `SELECT id FROM task_update_proposal
       WHERE source_event_id IN (${placeholders}) AND state = 'awaiting_approval' AND decision_mode = 'pending'
       ORDER BY created_at ASC`,
    ).all(...sourceEventIds) as Array<{ id: string }>;
    for (const proposal of proposals) this.dispatchTaskUpdateProposal(proposal.id, runtimeJobId, leaseOwner);
  }

  approveTaskUpdateProposal(proposalId: string) {
    return this.runtime.executeToolSync({
      jobId: null,
      toolName: 'task.apply_update',
      toolInput: { proposalId },
      approved: true,
      run: () => this.applyTaskUpdateProposal(proposalId, 'owner'),
      auditResult: (detail) => ({ proposalId, taskVersion: detail?.version ?? null }),
    });
  }

  private applyTaskUpdateProposal(proposalId: string, actor: ProposalApplyActor) {
    const proposal = this.database.raw.prepare('SELECT * FROM task_update_proposal WHERE id = ?').get(proposalId) as unknown as TaskUpdateProposalRow | undefined;
    if (!proposal) throw new Error('任务更新提案不存在。');
    if (proposal.state === 'approved') return this.getTaskDetail(proposal.task_id);
    if (proposal.state !== 'awaiting_approval') throw new Error('这条任务更新提案已经失效或被拒绝。');
    const task = this.getTask(proposal.task_id);
    if (!task) throw new Error('提案对应的任务不存在。');
    if (task.version !== proposal.base_task_version) {
      this.markTaskUpdateProposalStale(proposal);
      throw new Error('任务已经发生新修改，这条更新提案已失效，请重新判断。');
    }
    const patch = parseTaskUpdatePatch(proposal.patch_json);
    const thread = proposal.thread_id
      ? this.database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(proposal.thread_id) as unknown as RequirementThreadRow | undefined
      : undefined;
    const threadRevision = proposal.thread_revision_id
      ? this.database.raw.prepare('SELECT * FROM requirement_thread_revision WHERE id = ?').get(proposal.thread_revision_id) as { id: string; base_thread_version: number; patch_json: string; state: string } | undefined
      : undefined;
    if (proposal.thread_id && !thread) throw new Error('提案对应的需求线程不存在。');
    if (proposal.thread_id && (!threadRevision || threadRevision.state !== 'proposed')) {
      this.markTaskUpdateProposalStale(proposal);
      throw new Error('提案对应的需求线程修订已失效，请重新判断。');
    }
    const candidateRevision = proposal.candidate_revision_id
      ? this.database.raw.prepare('SELECT * FROM candidate_revision WHERE id = ?').get(proposal.candidate_revision_id) as CandidateRevisionPayloadRow | undefined
      : undefined;
    const candidate = candidateRevision
      ? this.database.raw.prepare('SELECT * FROM candidate_request WHERE id = ?').get(candidateRevision.candidate_id) as CandidateRow | undefined
      : undefined;
    const proposalSourceCandidate = !candidate && proposal.source_event_id
      ? this.database.raw.prepare(
          'SELECT * FROM candidate_request WHERE source_event_id = ? AND accepted_task_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1',
        ).get(proposal.source_event_id, task.id) as CandidateRow | undefined
      : undefined;
    const previousCandidateRevisions = candidateRevision
      ? this.database.raw.prepare("SELECT * FROM candidate_revision WHERE candidate_id = ? AND state = 'current'").all(candidateRevision.candidate_id) as CandidateRevisionPayloadRow[]
      : [];
    const previousCandidateRevision = previousCandidateRevisions[0];
    if (proposal.candidate_revision_id) {
      if (
        !candidateRevision
        || candidateRevision.state !== 'proposed'
        || !candidate
        || previousCandidateRevisions.length !== 1
        || !previousCandidateRevision
        || previousCandidateRevision.id === candidateRevision.id
        || !candidateRevisionPayloadMatchesSnapshot(previousCandidateRevision, candidateFullAuditSnapshot(candidate))
      ) {
        this.markTaskUpdateProposalStale(proposal);
        throw new Error('提案对应的候选修订已失效，请重新判断。');
      }
    }
    const baseThreadVersion = proposal.base_thread_version ?? threadRevision?.base_thread_version ?? null;
    if (thread && baseThreadVersion !== null && thread.version !== baseThreadVersion) {
      this.markTaskUpdateProposalStale(proposal);
      throw new Error('需求线程已经发生新修改，这条更新提案已失效，请重新判断。');
    }
    const proposedThread = threadRevision ? parseMetadata(threadRevision.patch_json) : {};
    // A follow-up may only apply the sparse, server-gated fields shown in the
    // proposal view. Owner approval must not smuggle in a full model rewrite.
    const appliedThreadPatch = proposal.origin === 'follow_up' ? {} : proposedThread;
    const taskChanged = (
      (patch.title !== undefined && patch.title !== task.title)
      || (patch.describe !== undefined && patch.describe !== task.describe)
      || (patch.status !== undefined && patch.status !== task.status)
      || (patch.plannedStartAt !== undefined && patch.plannedStartAt !== task.planned_start_at)
      || (patch.plannedDueAt !== undefined && patch.plannedDueAt !== task.planned_due_at)
      || (patch.nextStep !== undefined && patch.nextStep !== task.next_step)
      || (patch.risk !== undefined && patch.risk !== task.risk)
      || (patch.waitingReason !== undefined && patch.waitingReason !== task.waiting_reason)
    );
    const threadChanged = Boolean(thread && (
      (typeof appliedThreadPatch.title === 'string' && appliedThreadPatch.title !== thread.title)
      || (typeof appliedThreadPatch.background === 'string' && appliedThreadPatch.background !== thread.background)
      || (typeof appliedThreadPatch.validationQuestion === 'string' && appliedThreadPatch.validationQuestion !== thread.validation_question)
      || (typeof appliedThreadPatch.describe === 'string' && appliedThreadPatch.describe !== thread.describe)
      || (patch.threadTitle !== undefined && patch.threadTitle !== thread.title)
      || (patch.threadBackground !== undefined && patch.threadBackground !== thread.background)
      || (patch.threadValidationQuestion !== undefined && patch.threadValidationQuestion !== thread.validation_question)
      || (patch.threadDescribe !== undefined && patch.threadDescribe !== thread.describe)
    ));
    const noteAdded = Boolean(patch.note?.trim());
    if (!taskChanged && !threadChanged && !noteAdded) {
      this.markTaskUpdateProposalStale(proposal);
      throw new Error('任务更新提案没有可应用的实际变化。');
    }
    patch.expectedVersion = task.version;
    const beforeSnapshot: TaskUpdateProposalSnapshot = {
      task: taskAuditSnapshot(task)!,
      thread: threadAuditSnapshot(thread),
      candidate: candidateFullAuditSnapshot(candidate),
      previousCandidateRevisionId: previousCandidateRevision?.id ?? null,
    };
    return this.applyTaskPatch(task, patch, {
        actorType: actor === 'ai' ? 'ai' : 'owner',
        visibility: 'private',
        eventType: actor === 'ai' ? 'task_auto_updated' : 'task_updated',
        summary: actor === 'ai'
          ? `AI 根据高置信度后续来源自动维护了私人任务${patch.note?.trim() ? `：${patch.note.trim().slice(0, 160)}` : '。'}`
          : patch.note?.trim()
            ? `系统主人确认了后续来源提出的任务更新：${patch.note.trim().slice(0, 200)}`
            : '系统主人确认了后续来源提出的任务更新。',
        sourceEventId: proposal.source_event_id,
        demandUnitId: proposal.demand_unit_id,
        afterTransaction: (timestamp, nextVersion, taskEventId) => {
        const proposalUpdate = this.database.raw.prepare(
          `UPDATE task_update_proposal
           SET state = 'approved', decision_mode = ?, policy_version = ?, policy_reason = ?, applied_task_version = ?, applied_task_event_id = ?,
               before_snapshot_json = ?, decided_at = ?
           WHERE id = ? AND state = 'awaiting_approval'`,
        ).run(
          actor === 'ai' ? 'auto' : 'owner',
          AUTO_UPDATE_POLICY_VERSION,
          actor === 'ai' ? '通过自动维护安全门槛。' : '系统主人确认应用。',
          nextVersion,
          taskEventId,
          JSON.stringify(beforeSnapshot),
          timestamp,
          proposal.id,
        );
        if (proposalUpdate.changes !== 1) throw new Error('这条任务更新提案已被其他操作处理。');
        if (proposal.thread_id) {
          const nextTitle = typeof appliedThreadPatch.title === 'string'
            ? appliedThreadPatch.title
            : patch.threadTitle === undefined ? thread?.title ?? '' : patch.threadTitle;
          const nextBackground = typeof appliedThreadPatch.background === 'string'
            ? appliedThreadPatch.background
            : patch.threadBackground === undefined ? thread?.background ?? '' : patch.threadBackground;
          const nextValidation = typeof appliedThreadPatch.validationQuestion === 'string'
            ? appliedThreadPatch.validationQuestion
            : patch.threadValidationQuestion === undefined ? thread?.validation_question ?? '' : patch.threadValidationQuestion;
          const nextDescribe = typeof appliedThreadPatch.describe === 'string'
            ? appliedThreadPatch.describe
            : patch.threadDescribe === undefined ? thread?.describe ?? '' : patch.threadDescribe;
          const nextAnalysis = appliedThreadPatch.analysis && typeof appliedThreadPatch.analysis === 'object' ? JSON.stringify(appliedThreadPatch.analysis) : thread?.analysis_json ?? '{}';
          const threadUpdate = this.database.raw.prepare(
            `UPDATE requirement_thread
             SET title = ?, background = ?, validation_question = ?, describe = ?, analysis_json = ?,
                 status = ?, version = version + 1, last_activity_at = COALESCE(last_activity_at, ?), updated_at = ?
             WHERE id = ? AND version = ?`,
          ).run(
            nextTitle,
            nextBackground,
            nextValidation,
            nextDescribe,
            nextAnalysis,
            'open',
            proposal.source_event_id ? (this.database.raw.prepare('SELECT occurred_at FROM source_event WHERE id = ?').get(proposal.source_event_id) as { occurred_at?: string } | undefined)?.occurred_at ?? timestamp : timestamp,
            timestamp,
            proposal.thread_id,
            baseThreadVersion ?? thread?.version ?? 1,
          );
          if (threadUpdate.changes !== 1) throw new Error('需求线程已被其他操作更新，请刷新后重试。');
          this.database.raw.prepare('UPDATE task_update_proposal SET applied_thread_version = ? WHERE id = ?')
            .run((baseThreadVersion ?? thread?.version ?? 1) + 1, proposal.id);
          if (threadRevision) this.database.raw.prepare("UPDATE requirement_thread_revision SET state = 'accepted', decided_at = ? WHERE id = ? AND state = 'proposed'").run(timestamp, threadRevision.id);
          this.refreshThreadProposalStatus(proposal.thread_id, timestamp);
        }
        if (candidateRevision) {
          const candidateUpdate = this.database.raw.prepare(
            `UPDATE candidate_request
             SET title = ?, proposer_name = ?, background = ?, validation_question = ?, describe = ?, analysis_json = ?, confidence = ?, updated_at = ?, version = version + 1
             WHERE id = ? AND version = ?`,
          ).run(
            candidateRevision.title,
            candidateRevision.proposer_name,
            candidateRevision.background,
            candidateRevision.validation_question,
            candidateRevision.describe,
            candidateRevision.analysis_json,
            candidateRevision.confidence,
            timestamp,
            candidateRevision.candidate_id,
            candidate?.version ?? -1,
          );
          if (candidateUpdate.changes !== 1 || !previousCandidateRevision) throw new Error('提案对应的候选修订已失效，请重新判断。');
          const supersededPreviousRevision = this.database.raw.prepare(
            "UPDATE candidate_revision SET state = 'superseded' WHERE id = ? AND candidate_id = ? AND state = 'current'",
          ).run(previousCandidateRevision.id, candidateRevision.candidate_id);
          if (supersededPreviousRevision.changes !== 1) throw new Error('提案对应的候选修订已失效，请重新判断。');
          const activatedCandidateRevision = this.database.raw.prepare(
            "UPDATE candidate_revision SET state = 'current' WHERE id = ? AND candidate_id = ? AND state = 'proposed'",
          ).run(candidateRevision.id, candidateRevision.candidate_id);
          if (activatedCandidateRevision.changes !== 1) throw new Error('提案对应的候选修订已失效，请重新判断。');
          const currentRevisions = this.database.raw.prepare(
            "SELECT * FROM candidate_revision WHERE candidate_id = ? AND state = 'current'",
          ).all(candidateRevision.candidate_id) as CandidateRevisionPayloadRow[];
          const updatedCandidate = this.database.raw.prepare('SELECT * FROM candidate_request WHERE id = ?')
            .get(candidateRevision.candidate_id) as CandidateRow | undefined;
          if (
            currentRevisions.length !== 1
            || currentRevisions[0]?.id !== candidateRevision.id
            || !candidateRevisionPayloadMatchesSnapshot(currentRevisions[0], candidateFullAuditSnapshot(updatedCandidate))
          ) {
            throw new Error('提案对应的候选修订已失效，请重新判断。');
          }
        }
        this.markSupersededTaskProposalsStale(task.id, proposal.id, nextVersion, timestamp);
        const afterTask = { ...taskAuditSnapshot(task), ...this.resolveTaskPatch(task, patch), version: nextVersion };
        const afterThread = proposal.thread_id
          ? this.database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(proposal.thread_id) as unknown as RequirementThreadRow | undefined
          : undefined;
        const afterCandidate = candidateRevision
          ? this.database.raw.prepare('SELECT * FROM candidate_request WHERE id = ?').get(candidateRevision.candidate_id) as CandidateRow | undefined
          : undefined;
        this.database.raw.prepare('UPDATE task_update_proposal SET after_snapshot_json = ? WHERE id = ?')
          .run(JSON.stringify({
            task: afterTask,
            thread: threadAuditSnapshot(afterThread),
            candidate: candidateFullAuditSnapshot(afterCandidate),
            previousCandidateRevisionId: null,
          }), proposal.id);
        if (actor === 'ai') {
          const terminalStatus = patch.status === 'completed' || patch.status === 'archived';
          const notificationCandidateId = candidateRevision?.candidate_id ?? proposalSourceCandidate?.id ?? null;
          if (notificationCandidateId) {
            this.database.raw.prepare(
              `UPDATE notification
               SET archived_at = COALESCE(archived_at, ?)
               WHERE candidate_id = ?
                 AND dedupe_key LIKE 'candidate:%:source:%'
                 AND archived_at IS NULL`,
            ).run(timestamp, notificationCandidateId);
          }
          this.database.raw.prepare(
            `INSERT OR IGNORE INTO notification
              (id, task_id, task_event_id, candidate_id, notification_type, dedupe_key, reason, read_at, snoozed_until, archived_at, created_at)
             VALUES (?, ?, ?, ?, 'immediate', ?, ?, NULL, NULL, NULL, ?)`,
          ).run(
            id('notice'),
            task.id,
            taskEventId,
            notificationCandidateId,
            `auto-update:${proposal.id}`,
            terminalStatus
              ? `重点核对：AI 已把私人任务标为${patch.status === 'completed' ? '已完成' : '已归档'}；请检查来源证据，若不正确可立即撤销。`
              : 'AI 已自动维护私人任务；你可以查看证据或在没有后续修改时一键撤销。',
            timestamp,
          );
        }
        },
    });
  }

  revertAutomaticTaskUpdate(proposalId: string) {
    const proposal = this.database.raw.prepare('SELECT * FROM task_update_proposal WHERE id = ?').get(proposalId) as unknown as TaskUpdateProposalRow | undefined;
    if (!proposal) throw new Error('任务更新记录不存在。');
    if (proposal.decision_mode !== 'auto' || proposal.state !== 'approved') throw new Error('只有 AI 自动应用的任务更新可以一键撤销。');
    if (proposal.reverted_at) return this.getTaskDetail(proposal.task_id);
    if (proposal.applied_task_version === null) throw new Error('这条自动更新缺少应用版本，不能安全撤销。');
    const task = this.getTask(proposal.task_id);
    if (!task) throw new Error('自动更新对应的任务不存在。');
    if (task.version !== proposal.applied_task_version) throw new Error('任务在自动更新后已经发生新修改，不能覆盖后续内容。');
    if (task.record_state === 'invalidated' || task.deleted_at) throw new Error('无效或回收站任务不能撤销自动更新。');

    const snapshot = parseTaskUpdateSnapshot(proposal.before_snapshot_json);
    const afterSnapshot = parseTaskUpdateSnapshot(proposal.after_snapshot_json);
    const beforeTask = snapshot.task;
    if (beforeTask.id !== task.id || afterSnapshot.task.id !== task.id) {
      throw new Error(INVALID_TASK_UPDATE_SNAPSHOT_ERROR);
    }
    const thread = proposal.thread_id
      ? this.database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(proposal.thread_id) as unknown as RequirementThreadRow | undefined
      : undefined;
    if (proposal.thread_id) {
      if (
        !thread
        || !snapshot.thread
        || !afterSnapshot.thread
        || snapshot.thread.id !== proposal.thread_id
        || afterSnapshot.thread.id !== proposal.thread_id
        || thread.id !== proposal.thread_id
      ) {
        throw new Error(INVALID_TASK_UPDATE_SNAPSHOT_ERROR);
      }
    } else if (snapshot.thread !== null || afterSnapshot.thread !== null) {
      throw new Error(INVALID_TASK_UPDATE_SNAPSHOT_ERROR);
    }
    if (proposal.thread_id && (!thread || proposal.applied_thread_version === null || thread.version !== proposal.applied_thread_version)) {
      throw new Error('需求线程在自动更新后已经发生新修改，不能覆盖后续内容。');
    }
    const candidateRevision = proposal.candidate_revision_id
      ? this.database.raw.prepare('SELECT * FROM candidate_revision WHERE id = ?').get(proposal.candidate_revision_id) as CandidateRevisionPayloadRow | undefined
      : undefined;
    const currentCandidate = candidateRevision
      ? this.database.raw.prepare('SELECT * FROM candidate_request WHERE id = ?').get(candidateRevision.candidate_id) as CandidateRow | undefined
      : undefined;
    let previousCandidateRevision: CandidateRevisionPayloadRow | undefined;
    if (proposal.candidate_revision_id) {
      if (
        !candidateRevision
        || candidateRevision.state !== 'current'
        || !currentCandidate
        || !snapshot.candidate
        || !afterSnapshot.candidate
        || snapshot.candidate.id !== candidateRevision.candidate_id
        || afterSnapshot.candidate.id !== candidateRevision.candidate_id
        || currentCandidate.id !== candidateRevision.candidate_id
        || snapshot.candidate.state !== currentCandidate.state
        || afterSnapshot.candidate.state !== currentCandidate.state
        || !snapshot.previousCandidateRevisionId
        || snapshot.previousCandidateRevisionId === candidateRevision.id
        || afterSnapshot.previousCandidateRevisionId !== null
        || !candidateRevisionPayloadMatchesSnapshot(candidateRevision, afterSnapshot.candidate)
      ) {
        throw new Error(INVALID_TASK_UPDATE_SNAPSHOT_ERROR);
      }
      previousCandidateRevision = this.database.raw.prepare(
        'SELECT * FROM candidate_revision WHERE id = ?',
      ).get(snapshot.previousCandidateRevisionId) as CandidateRevisionPayloadRow | undefined;
      if (
        !previousCandidateRevision
        || previousCandidateRevision.candidate_id !== candidateRevision.candidate_id
        || previousCandidateRevision.state !== 'superseded'
        || !candidateRevisionPayloadMatchesSnapshot(previousCandidateRevision, snapshot.candidate)
      ) {
        throw new Error(INVALID_TASK_UPDATE_SNAPSHOT_ERROR);
      }
    } else if (
      snapshot.candidate !== null
      || afterSnapshot.candidate !== null
      || snapshot.previousCandidateRevisionId !== null
      || afterSnapshot.previousCandidateRevisionId !== null
    ) {
      throw new Error(INVALID_TASK_UPDATE_SNAPSHOT_ERROR);
    }
    if (candidateRevision && !candidateSnapshotsEqual(afterSnapshot.candidate, candidateFullAuditSnapshot(currentCandidate))) {
      throw new Error('候选摘要在自动更新后已经发生人工修改，不能覆盖后续内容。');
    }
    const authoritativeCandidateState = currentCandidate?.state;

    assertShanghaiCalendarPlanRange(beforeTask.planned_start_at, beforeTask.planned_due_at);
    const timestamp = nowIso();
    const nextVersion = task.version + 1;
    const taskEventId = id('evt');
    this.database.transaction(() => {
      const restored = this.database.raw.prepare(
        `UPDATE task SET title = ?, proposer_name = ?, describe = ?, status = ?, schedule_at = ?, planned_start_at = ?, planned_due_at = ?,
           next_step = ?, risk = ?, waiting_reason = ?, completed_at = ?, archived_at = ?, auto_update_paused = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ? AND deleted_at IS NULL AND record_state = 'active'`,
      ).run(
        beforeTask.title,
        beforeTask.proposer_name,
        beforeTask.describe,
        beforeTask.status,
        beforeTask.schedule_at,
        beforeTask.planned_start_at,
        beforeTask.planned_due_at,
        beforeTask.next_step,
        beforeTask.risk,
        beforeTask.waiting_reason,
        beforeTask.completed_at,
        beforeTask.archived_at,
        beforeTask.auto_update_paused ? 1 : 0,
        nextVersion,
        timestamp,
        task.id,
        task.version,
      );
      if (restored.changes !== 1) throw new Error('任务已被其他操作更新，请刷新后重试。');

      if (thread && snapshot?.thread) {
        const beforeThread = snapshot.thread;
        const restoredThread = this.database.raw.prepare(
          `UPDATE requirement_thread
           SET title = ?, background = ?, validation_question = ?, describe = ?, analysis_json = ?, status = ?,
               version = version + 1, last_activity_at = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        ).run(
          beforeThread.title,
          beforeThread.background,
          beforeThread.validation_question,
          beforeThread.describe,
          beforeThread.analysis_json,
          beforeThread.status,
          beforeThread.last_activity_at,
          timestamp,
          thread.id,
          proposal.applied_thread_version,
        );
        if (restoredThread.changes !== 1) throw new Error('需求线程已被其他操作更新，请刷新后重试。');
      }

      if (currentCandidate && snapshot.candidate && candidateRevision) {
        const beforeCandidate = snapshot.candidate;
        const restoredCandidate = this.database.raw.prepare(
          `UPDATE candidate_request
           SET title = ?, proposer_name = ?, background = ?, validation_question = ?, describe = ?, analysis_json = ?, confidence = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND version = ?`,
        ).run(
          beforeCandidate.title,
          beforeCandidate.proposer_name,
          beforeCandidate.background,
          beforeCandidate.validation_question,
          beforeCandidate.describe,
          beforeCandidate.analysis_json,
          beforeCandidate.confidence,
          timestamp,
          currentCandidate.id,
          currentCandidate.version,
        );
        if (restoredCandidate.changes !== 1) throw new Error(INVALID_TASK_UPDATE_SNAPSHOT_ERROR);
        const supersededAppliedRevision = this.database.raw.prepare(
          "UPDATE candidate_revision SET state = 'superseded' WHERE id = ? AND candidate_id = ? AND state = 'current'",
        ).run(candidateRevision.id, currentCandidate.id);
        if (supersededAppliedRevision.changes !== 1) throw new Error(INVALID_TASK_UPDATE_SNAPSHOT_ERROR);
        const restoredPreviousRevision = this.database.raw.prepare(
          "UPDATE candidate_revision SET state = 'current' WHERE id = ? AND candidate_id = ? AND state = 'superseded'",
        ).run(previousCandidateRevision!.id, currentCandidate.id);
        if (restoredPreviousRevision.changes !== 1) throw new Error(INVALID_TASK_UPDATE_SNAPSHOT_ERROR);
        const restoredCurrentRevisions = this.database.raw.prepare(
          "SELECT * FROM candidate_revision WHERE candidate_id = ? AND state = 'current'",
        ).all(currentCandidate.id) as CandidateRevisionPayloadRow[];
        const restoredCandidateRow = this.database.raw.prepare('SELECT * FROM candidate_request WHERE id = ?')
          .get(currentCandidate.id) as CandidateRow | undefined;
        if (
          restoredCurrentRevisions.length !== 1
          || restoredCurrentRevisions[0]?.id !== previousCandidateRevision!.id
          || !candidateRevisionPayloadMatchesSnapshot(restoredCurrentRevisions[0], snapshot.candidate)
          || !candidateRevisionPayloadMatchesSnapshot(restoredCurrentRevisions[0], candidateFullAuditSnapshot(restoredCandidateRow))
          || restoredCandidateRow?.state !== authoritativeCandidateState
        ) {
          throw new Error(INVALID_TASK_UPDATE_SNAPSHOT_ERROR);
        }
      }

      this.database.raw.prepare(
        `INSERT INTO task_event
          (id, task_id, event_type, actor_type, visibility, summary, source_event_id, demand_unit_id, before_json, after_json, occurred_at, recorded_at, version)
         VALUES (?, ?, 'task_auto_update_reverted', 'owner', 'private', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        taskEventId,
        task.id,
        '系统主人撤销了最近一次 AI 自动维护；任务内容已恢复，但版本历史继续保留。',
        proposal.source_event_id,
        proposal.demand_unit_id,
        JSON.stringify(taskAuditSnapshot(task)),
        JSON.stringify({ ...beforeTask, version: nextVersion, updated_at: timestamp }),
        timestamp,
        timestamp,
        nextVersion,
      );
      const reverted = this.database.raw.prepare(
        `UPDATE task_update_proposal
         SET decision_mode = 'reverted', policy_reason = ?, reverted_at = ?, reverted_task_event_id = ?
         WHERE id = ? AND decision_mode = 'auto' AND reverted_at IS NULL AND applied_task_version = ?`,
      ).run('系统主人在没有后续修改覆盖时撤销了这次 AI 自动维护。', timestamp, taskEventId, proposal.id, task.version);
      if (reverted.changes !== 1) throw new Error('这条自动更新已经被其他操作处理。');
      this.database.raw.prepare("UPDATE notification SET archived_at = COALESCE(archived_at, ?) WHERE dedupe_key = ?")
        .run(timestamp, `auto-update:${proposal.id}`);
      this.database.raw.prepare(
        `INSERT OR IGNORE INTO notification
          (id, task_id, task_event_id, candidate_id, notification_type, dedupe_key, reason, read_at, snoozed_until, archived_at, created_at)
         VALUES (?, ?, ?, ?, 'immediate', ?, ?, NULL, NULL, NULL, ?)`,
      ).run(id('notice'), task.id, taskEventId, currentCandidate?.id ?? null, `auto-update-reverted:${proposal.id}`, 'AI 自动维护已撤销；任务已生成新的恢复版本。', timestamp);
    });
    this.projectTaskMemory(task.id);
    return this.getTaskDetail(task.id);
  }

  rejectTaskUpdateProposal(proposalId: string) {
    const proposal = this.database.raw.prepare('SELECT * FROM task_update_proposal WHERE id = ?').get(proposalId) as unknown as TaskUpdateProposalRow | undefined;
    if (!proposal) throw new Error('任务更新提案不存在。');
    if (proposal.state === 'awaiting_approval') {
      const timestamp = nowIso();
      this.database.transaction(() => {
        const updated = this.database.raw.prepare("UPDATE task_update_proposal SET state = 'rejected', decided_at = ? WHERE id = ? AND state = 'awaiting_approval'").run(timestamp, proposal.id);
        if (updated.changes !== 1) throw new Error('这条任务更新提案已被其他操作处理。');
        if (proposal.thread_id) {
          if (proposal.thread_revision_id) this.database.raw.prepare("UPDATE requirement_thread_revision SET state = 'rejected', decided_at = ? WHERE id = ? AND state = 'proposed'").run(timestamp, proposal.thread_revision_id);
          this.refreshThreadProposalStatus(proposal.thread_id, timestamp);
        }
        if (proposal.candidate_revision_id) this.database.raw.prepare("UPDATE candidate_revision SET state = 'rejected' WHERE id = ? AND state = 'proposed'").run(proposal.candidate_revision_id);
      });
    }
    return this.getTaskDetail(proposal.task_id);
  }

  deleteTask(taskId: string, expectedVersion?: number) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('任务不存在。');
    if (task.record_state === 'invalidated') throw new Error('无效记录已经作为纠错审计保留，不能移到普通回收站。');
    if (expectedVersion !== undefined && expectedVersion !== task.version) throw new Error('任务已被其他操作更新，请刷新后重试。');
    if (task.deleted_at) {
      this.database.transaction(() => this.deleteLinkedCandidatesInTransaction(taskId, nowIso()));
      return this.getTaskDetail(taskId);
    }

    const timestamp = nowIso();
    this.database.transaction(() => {
      this.deleteTaskInTransaction(task, timestamp);
      this.deleteLinkedCandidatesInTransaction(taskId, timestamp);
    });
    this.projectTaskMemory(taskId);
    return this.getTaskDetail(taskId);
  }

  restoreTask(taskId: string, expectedVersion?: number) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('任务不存在。');
    if (task.record_state === 'invalidated') throw new Error('无效记录不能恢复为普通任务；请从纠错流程重新判断。');
    if (expectedVersion !== undefined && expectedVersion !== task.version) throw new Error('任务已被其他操作更新，请刷新后重试。');
    if (!task.deleted_at) {
      this.database.transaction(() => this.restoreLinkedCandidatesInTransaction(taskId, nowIso()));
      return this.getTaskDetail(taskId);
    }

    const timestamp = nowIso();
    this.database.transaction(() => {
      this.restoreTaskInTransaction(task, timestamp);
      this.restoreLinkedCandidatesInTransaction(taskId, timestamp);
    });
    this.projectTaskMemory(taskId);
    return this.getTaskDetail(taskId);
  }

  addReference(taskId: string, label: string, referencePath: string, accessMode: 'reference_only' | 'readonly' = 'reference_only') {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error('任务不存在。');
    }
    if (task.deleted_at) throw new Error('回收站中的任务不能新增参考路径。');
    if (isAbsolute(referencePath) && !this.isAllowedWorkspacePath(referencePath)) {
      throw new Error('本地目录必须先通过桌面原生选择器授权，系统不会接受未授权的绝对路径。');
    }
    if (accessMode === 'readonly' && (!this.config.workspace.readEnabled || !isAbsolute(referencePath))) {
      throw new Error('只读检查只允许对已授权的本地目录执行。');
    }
    const referenceId = id('ref');
    this.database.raw
      .prepare(
        `INSERT INTO reference_binding (id, task_id, label, reference_path, access_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(referenceId, taskId, label, referencePath, accessMode, nowIso());
    this.projectTaskMemory(taskId);
    return this.database.raw.prepare('SELECT * FROM reference_binding WHERE id = ?').get(referenceId);
  }

  removeReference(taskId: string, referenceId: string) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('任务不存在。');
    if (task.deleted_at) throw new Error('回收站中的任务不能修改参考路径。');
    const reference = this.database.raw.prepare('SELECT id FROM reference_binding WHERE id = ? AND task_id = ?')
      .get(referenceId, taskId) as { id: string } | undefined;
    if (!reference) throw new Error('参考路径绑定不存在。');
    const removed = this.database.raw.prepare('DELETE FROM reference_binding WHERE id = ? AND task_id = ?').run(referenceId, taskId);
    if (removed.changes !== 1) throw new Error('参考路径绑定已经发生变化，请刷新后重试。');
    this.log('workspace', 'info', 'reference.unbound', '已解除任务与参考路径的本地绑定；真实工作目录没有被读取、移动或删除。', { taskId, referenceId });
    this.projectTaskMemory(taskId);
    return this.getTaskDetail(taskId);
  }

  private isAllowedWorkspacePath(referencePath: string) {
    const target = resolve(referencePath);
    return this.config.workspace.allowedPaths.some((item) => {
      const allowed = resolve(item);
      const left = process.platform === 'win32' ? allowed.toLowerCase() : allowed;
      const right = process.platform === 'win32' ? target.toLowerCase() : target;
      return right === left || right.startsWith(left + sep);
    });
  }

  requestExternalAction(taskId: string, actionType: string, payload: unknown) {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error('任务不存在。');
    }
    if (task.record_state === 'invalidated') {
      throw new Error('无效记录不能生成对外动作。');
    }
    if (task.deleted_at) {
      throw new Error('回收站中的任务不能生成对外动作。');
    }
    const timestamp = nowIso();
    const payloadJson = stableJson(payload ?? {});
    const requestFingerprint = createHash('sha256')
      .update(`${taskId}\n${task.version}\n${actionType}\n${payloadJson}`)
      .digest('hex');
    const idempotencyKey = `draft:${taskId}:${task.version}:${requestFingerprint}`;
    const approvalId = `approval_${requestFingerprint}`;
    const outboxId = `outbox_${requestFingerprint}`;
    const draft = this.database.transaction(() => {
      const existing = this.database.raw.prepare(
        `SELECT approval.id AS approval_id, outbox.id AS outbox_id, approval.status
         FROM outbox JOIN approval ON approval.id = outbox.approval_id
         WHERE outbox.idempotency_key = ?`,
      ).get(idempotencyKey) as { approval_id: string; outbox_id: string; status: string } | undefined;
      if (existing) return existing;

      // A new task version or payload is a new draft. Any previous open draft
      // remains in the audit ledger but is no longer awaiting owner review.
      this.terminateTaskDraftsInTransaction(taskId, timestamp);
      this.database.raw
        .prepare(
          `INSERT OR IGNORE INTO approval (id, task_id, action_type, payload_json, status, created_at, decided_at)
           VALUES (?, ?, ?, ?, 'awaiting_approval', ?, NULL)`,
        )
        .run(approvalId, taskId, actionType, payloadJson, timestamp);
      this.database.raw
        .prepare(
          `INSERT OR IGNORE INTO outbox (id, approval_id, action_type, payload_json, status, idempotency_key, created_at, sent_at)
           VALUES (?, ?, ?, ?, 'awaiting_approval', ?, ?, NULL)`,
        )
        .run(outboxId, approvalId, actionType, payloadJson, idempotencyKey, timestamp);
      const inserted = this.database.raw.prepare(
        `SELECT approval.id AS approval_id, outbox.id AS outbox_id, approval.status
         FROM outbox JOIN approval ON approval.id = outbox.approval_id
         WHERE outbox.idempotency_key = ?`,
      ).get(idempotencyKey) as { approval_id: string; outbox_id: string; status: string } | undefined;
      if (!inserted) throw new Error('草稿无法安全保存，请刷新后重试。');
      return inserted;
    });
    return {
      approvalId: draft.approval_id,
      outboxId: draft.outbox_id,
      status: draft.status,
      state: draftOnlyApprovalState(draft.status),
      reviewStatus: draftOnlyApprovalState(draft.status) === 'draft' ? 'pending_owner_review' : 'terminal',
      externallySent: false,
      sendAvailable: false,
      adapterSentCount: this.adapters.feishu.sentCount,
    };
  }

  rejectExternalDraft(approvalId: string) {
    const approval = this.database.raw.prepare(
      'SELECT id, task_id, status FROM approval WHERE id = ?',
    ).get(approvalId) as { id: string; task_id: string | null; status: string } | undefined;
    if (!approval || !approval.task_id) throw new Error('草稿不存在。');
    const timestamp = nowIso();
    this.database.transaction(() => {
      if (approval.status === 'awaiting_approval') {
        const updated = this.database.raw.prepare(
          "UPDATE approval SET status = 'rejected', decided_at = COALESCE(decided_at, ?) WHERE id = ? AND status = 'awaiting_approval'",
        ).run(timestamp, approval.id);
        if (updated.changes !== 1) throw new Error('草稿已被其他操作处理，请刷新后重试。');
        this.database.raw.prepare(
          "UPDATE outbox SET status = 'failed' WHERE approval_id = ? AND status IN ('awaiting_approval', 'ready')",
        ).run(approval.id);
      }
    });
    return this.getTaskDetail(approval.task_id);
  }

  dashboard() {
    const generatedAt = nowIso();
    const day = shanghaiDayWindow(generatedAt);
    const activeTaskWhere = "record_state = 'active' AND deleted_at IS NULL";
    const todayDate = "COALESCE(planned_start_at, planned_due_at, schedule_at)";
    const todayWhere = `status IN ('unplanned','planned','in_progress','review')
           AND ((${todayDate} >= ? AND ${todayDate} < ?)
                OR (planned_start_at IS NOT NULL AND planned_due_at IS NOT NULL
                    AND planned_start_at < planned_due_at
                    AND planned_start_at < ? AND planned_due_at > ?))`;
    const candidateWhere = `state = 'pending' AND deleted_at IS NULL
           AND NOT (title = 'AI 整理待重试' AND confidence = 0
                    AND background = '' AND validation_question = '' AND describe = '')`;
    const candidates = this.database.raw
      .prepare(
        `SELECT * FROM candidate_request
         WHERE ${candidateWhere}
         ORDER BY created_at DESC LIMIT 6`,
      )
      .all() as CandidateRow[];
    const today = this.database.raw
      .prepare(
         `SELECT * FROM task
         WHERE ${activeTaskWhere}
           AND ${todayWhere}
         ORDER BY ${todayDate}, updated_at DESC LIMIT 8`,
      )
      .all(day.startAt, day.endAt, day.endAt, day.startAt) as unknown as TaskRecord[];
    const waiting = this.database.raw
      .prepare(`SELECT * FROM task WHERE ${activeTaskWhere} AND status = 'waiting' ORDER BY ${todayDate} IS NULL, ${todayDate}, updated_at DESC LIMIT 8`)
      .all() as unknown as TaskRecord[];
    const publicCandidates = candidates
      .map((candidate) => this.publicCandidate(candidate.id))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
    const publicToday = today
      .map((task) => this.publicTask(task.id))
      .filter((task): task is NonNullable<typeof task> => task !== null);
    const publicWaiting = waiting
      .map((task) => this.publicTask(task.id))
      .filter((task): task is NonNullable<typeof task> => task !== null);
    const candidateTotal = (this.database.raw.prepare(`SELECT COUNT(*) AS count FROM candidate_request WHERE ${candidateWhere}`).get() as { count: number }).count;
    const todayTotal = (this.database.raw.prepare(`SELECT COUNT(*) AS count FROM task WHERE ${activeTaskWhere} AND ${todayWhere}`).get(day.startAt, day.endAt, day.endAt, day.startAt) as { count: number }).count;
    const waitingTotal = (this.database.raw.prepare(`SELECT COUNT(*) AS count FROM task WHERE ${activeTaskWhere} AND status = 'waiting'`).get() as { count: number }).count;
    const inProgressTotal = (this.database.raw.prepare(`SELECT COUNT(*) AS count FROM task WHERE ${activeTaskWhere} AND status = 'in_progress'`).get() as { count: number }).count;
    const overdueTotal = (this.database.raw.prepare(`SELECT COUNT(*) AS count FROM task WHERE ${activeTaskWhere} AND status IN ('planned','in_progress','review','waiting') AND COALESCE(planned_due_at, schedule_at) < ?`).get(generatedAt) as { count: number }).count;
    const dataMode = this.adapters.feishu.kind === 'live' ? 'configured' : 'local_mock';
    return {
      candidates: publicCandidates,
      today: publicToday,
      waiting: publicWaiting,
      counts: { candidates: candidateTotal, today: todayTotal, waiting: waitingTotal, inProgress: inProgressTotal, overdue: overdueTotal },
      asOf: generatedAt,
      todayDate: day.date,
      timezone: SHANGHAI_TIMEZONE,
      dataMode,
    };
  }

  calendar() {
    const generatedAt = nowIso();
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM task
         WHERE record_state = 'active' AND deleted_at IS NULL
           AND COALESCE(planned_start_at, planned_due_at, schedule_at) IS NOT NULL
           AND status NOT IN ('archived')
         ORDER BY COALESCE(planned_start_at, planned_due_at, schedule_at) ASC`,
      )
      .all() as unknown as TaskRecord[];
    type CalendarTaskItem = {
      id: string;
      title: string;
      status: TaskStatus;
      next_step: string;
      display_start_at: string | null;
      display_due_at: string | null;
      display_schedule_at: string | null;
      display_anchor_at: string;
    };
    const days = new Map<string, CalendarTaskItem[]>();
    let omittedCount = 0;
    for (const row of rows) {
      try {
        const task = this.publicTask(row.id);
        if (!task) {
          omittedCount += 1;
          continue;
        }
        const projection = projectShanghaiCalendarPlan(task.planned_start_at, task.planned_due_at, task.schedule_at);
        const item: CalendarTaskItem = {
          id: task.id,
          title: task.title,
          status: task.status,
          next_step: task.next_step,
          display_start_at: projection.displayStartAt,
          display_due_at: projection.displayDueAt,
          display_schedule_at: projection.displayScheduleAt,
          display_anchor_at: projection.displayAnchorAt,
        };
        for (const date of projection.dayKeys) days.set(date, [...(days.get(date) ?? []), item]);
      } catch {
        omittedCount += 1;
      }
    }
    return {
      asOf: generatedAt,
      timezone: SHANGHAI_TIMEZONE,
      warning: omittedCount > 0 ? SHANGHAI_CALENDAR_OMITTED_WARNING : null,
      omittedCount,
      days: Array.from(days.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, items]) => ({ date, items })),
    };
  }

  calendarSources(input: { route?: CalendarClassification['route']; limit?: number } = {}) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const rows = this.database.raw.prepare(
      `SELECT occurred_at, metadata_json
       FROM source_event
       WHERE source_type = 'calendar'
       ORDER BY occurred_at DESC, captured_at DESC
       LIMIT ?`,
    ).all(limit) as Array<{ occurred_at: string; metadata_json: string }>;
    const boundedText = (value: unknown, max: number) => {
      if (typeof value !== 'string') return null;
      const safe = value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim();
      if (/(?:sk-[A-Za-z0-9]|gh[pousr]_[A-Za-z0-9]|Bearer\s+|BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY|sourceEventId|externalId|provider[_ -]?payload|raw[_ -]?(?:json|payload|source))/iu.test(safe)) return '<redacted>';
      return safe ? safe.slice(0, max) : null;
    };
    const safeEvidence = (value: unknown) => {
      const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const result: Record<string, string> = {};
      for (const key of ['ownerResponsibility', 'action', 'deliverableOrDeadline', 'missingSignalCode'] as const) {
        const item = boundedText(raw[key], 160);
        if (item) result[key] = item;
      }
      const sourceReference = typeof raw.sourceReference === 'string' && /^sha256:[0-9a-f]{16}$/u.test(raw.sourceReference)
        ? raw.sourceReference
        : 'sha256:0000000000000000';
      result.sourceReference = sourceReference;
      return result;
    };
    return {
      timezone: SHANGHAI_TIMEZONE,
      items: rows.flatMap((row) => {
        const metadata = parseMetadata(row.metadata_json);
        const classification = metadata.calendarClassification as CalendarClassification | undefined;
        if (!classification || (input.route && classification.route !== input.route)) return [];
        const route = classification.route === 'calendar_fact' || classification.route === 'candidate_review' || classification.route === 'owner_confirmation'
          ? classification.route
          : 'calendar_fact';
        return [{
          title: boundedText(metadata.calendarTitle, 160) || '未命名日程',
          startAt: boundedText(metadata.startTime, 64) || boundedText(row.occurred_at, 64),
          endAt: boundedText(metadata.endTime, 64),
          route,
          sourceRetained: classification.sourceRetained === true,
          candidateCreated: route === 'candidate_review' && classification.candidateCreated === true,
          requiresOwnerConfirmation: route !== 'calendar_fact' && classification.requiresOwnerConfirmation === true,
          explanationCode: typeof classification.explanationCode === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(classification.explanationCode)
            ? classification.explanationCode
            : 'calendar_input_invalid',
          evidenceFields: safeEvidence(classification.evidenceFields),
          correctionScope: 'current_event_only',
        }];
      }),
    };
  }

  listNotifications(unreadOnly = false, limit = 100) {
    type NotificationView = {
      id: string;
      task_id: string | null;
      task_event_id: string | null;
      candidate_id: string | null;
      notification_type: 'immediate' | 'daily';
      dedupe_key: string | null;
      reason: string;
      read_at: string | null;
      snoozed_until: string | null;
      archived_at: string | null;
      created_at: string;
      task_title: string | null;
      candidate_title: string | null;
    };
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const rows = this.database.raw
      .prepare(
        `SELECT notification.*, candidate_request.title AS candidate_title, task.title AS task_title
         FROM notification
         LEFT JOIN candidate_request ON candidate_request.id = notification.candidate_id
         LEFT JOIN task ON task.id = notification.task_id
         WHERE (? = 0 OR notification.read_at IS NULL)
           AND notification.archived_at IS NULL
         ORDER BY notification.created_at DESC LIMIT ?`,
      )
      .all(unreadOnly ? 1 : 0, safeLimit) as NotificationView[];
    return rows.map((row): NotificationView => ({
      ...row,
      task_title: row.task_id ? this.publicTask(row.task_id)?.title ?? null : null,
      candidate_title: row.candidate_id ? this.publicCandidate(row.candidate_id)?.title ?? null : null,
    }));
  }

  markNotificationRead(notificationId: string) {
    const result = this.database.raw.prepare('UPDATE notification SET read_at = COALESCE(read_at, ?) WHERE id = ?').run(nowIso(), notificationId);
    if (!result.changes) throw new Error('提醒不存在。');
    return this.database.raw.prepare('SELECT * FROM notification WHERE id = ?').get(notificationId);
  }

  listLogs(input: { category?: string; level?: string; from?: string; to?: string; operation_id?: string; trace_id?: string; event_type?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const from = input.from ?? null;
    const to = input.to ?? null;
    const rows = this.database.raw
      .prepare(
        `SELECT id, category, level, event_type, summary, context_json, created_at FROM app_log
         WHERE (? IS NULL OR category = ?) AND (? IS NULL OR level = ?)
           AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?)
           AND (? IS NULL OR event_type = ?)
           AND (? IS NULL OR context_json LIKE '%' || ? || '%')
           AND (? IS NULL OR context_json LIKE '%' || ? || '%')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(input.category ?? null, input.category ?? null, input.level ?? null, input.level ?? null, from, from, to, to,
        input.event_type ?? null, input.event_type ?? null,
        input.operation_id ?? null, input.operation_id ?? null,
        input.trace_id ?? null, input.trace_id ?? null, limit);
    const safeRows = (rows as Array<Record<string, unknown>>).map((row) => {
      const details = diagnosticLogDetails(row.context_json);
      const eventType = typeof row.event_type === 'string' && diagnosticEventLabels[row.event_type]
        ? row.event_type
        : 'OBS_UNKNOWN_EVENT';
      return {
        id: diagnosticInternalId(row.id),
        category: row.category === 'runtime' || row.category === 'integration' || row.category === 'ai' || row.category === 'workspace' ? row.category : 'unknown',
        level: row.level === 'info' || row.level === 'warn' || row.level === 'error' ? row.level : 'unknown',
        event_type: eventType,
        summary: diagnosticEventLabels[eventType] ?? diagnosticEventFallback,
        // Keep a JSON string for legacy local consumers, but only serialize
        // the already-projected diagnostic details; raw context never crosses
        // this boundary.
        context_json: JSON.stringify({ details }),
        details,
        operation_id: details.operation_id ?? null,
        request_id: details.request_id ?? null,
        trace_id: details.trace_id ?? null,
        parent_span_id: details.parent_span_id ?? null,
        span_id: details.span_id ?? null,
        created_at: diagnosticTimestamp(row.created_at),
      };
    });
    // Provider request IDs and source relationships are intentionally not
    // selected: the logs UI consumes only this fixed, local diagnostic DTO.
    const decisions = (this.database.raw
      .prepare(
        `SELECT id, provider, model, prompt_version,
                is_data_request, confidence, used_fallback, http_status,
                attempts, structured_mode, input_hash, input_char_count, fallback_mode, latency_ms, created_at
         FROM ai_decision_log
         WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?)
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(from, from, to, to, Math.min(limit, 100)) as unknown as LogDecisionRow[]).map(diagnosticDecision);
    const health = (this.database.raw
      .prepare(`SELECT integration, status, message, latency_ms, checked_at FROM integration_health
        WHERE (? IS NULL OR checked_at >= ?) AND (? IS NULL OR checked_at <= ?)
        ORDER BY checked_at DESC`)
      .all(from, from, to, to) as Array<Record<string, unknown>>).map((row) => ({
        ...row,
        message: redactDiagnosticText(row.message, 300),
      }));
    // Idempotency keys are omitted, while free-form notes are reduced to a
    // presence marker by diagnosticCorrection.
    const corrections = this.database.raw
      .prepare(
        `SELECT id, task_id, candidate_id, correction_type, note, created_at
         FROM correction_event
         WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at <= ?)
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(from, from, to, to, Math.min(limit, 100)) as unknown as LogCorrectionRow[];
    return {
      logs: safeRows,
      decisions,
      health,
      corrections: corrections.map(diagnosticCorrection),
      redactionSchemaVersion: REDACTION_SCHEMA_VERSION,
    };
  }

  diagnostics(requestId?: string) {
    const operationId = randomUUID();
    const traceId = randomUUID();
    let readiness = this.readiness();
    let counts = { sources: 0, candidates: 0, tasks: 0, logs: 0, decisions: 0, corrections: 0 };
    let recentErrors: unknown[] = [];
    if (readiness.status !== 'not_ready') {
      try {
        counts = {
          sources: (this.database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count,
          candidates: (this.database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number }).count,
          tasks: (this.database.raw.prepare('SELECT COUNT(*) AS count FROM task').get() as { count: number }).count,
          logs: (this.database.raw.prepare('SELECT COUNT(*) AS count FROM app_log').get() as { count: number }).count,
          decisions: (this.database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count,
          corrections: (this.database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get() as { count: number }).count,
        };
        recentErrors = (this.database.raw
          .prepare("SELECT category, level, event_type, summary, created_at FROM app_log WHERE level = 'error' ORDER BY created_at DESC LIMIT 20")
          .all() as Array<Record<string, unknown>>).map(diagnosticRecentError);
      } catch {
        readiness = { status: 'not_ready', reasons: [{ code: 'DATABASE_UNAVAILABLE', message: '本地数据库当前不可用。' }] };
        counts = { sources: 0, candidates: 0, tasks: 0, logs: 0, decisions: 0, corrections: 0 };
        recentErrors = [];
      }
    }
    const health = this.health(requestId, readiness);
    let recentEvents: unknown[] = [];
    try {
      recentEvents = this.listLogs({ limit: 50 }).logs;
    } catch {
      recentEvents = [];
    }
    return redactDiagnosticRecord({
      diagnostic_bundle_version: 'obs-01-v1',
      generatedAt: nowIso(),
      operation_id: operationId,
      request_id: requestId ?? randomUUID(),
      trace_id: traceId,
      health,
      readiness,
      release: this.releaseIdentity(),
      counts,
      configuration: {
        databaseProvider: this.config.database.provider,
        runtimeMode: 'cindy-intake',
        taskMemoryRoot: this.config.taskMemoryRoot,
      },
      recentErrors,
      recentEvents,
      summaries: {
        database: { provider: this.config.database.provider, schema_version: CURRENT_SCHEMA_VERSION },
        runtime: { failed_jobs: health.dependencies?.runner?.details?.failed_jobs ?? 0, pending_jobs: health.dependencies?.runner?.details?.pending_jobs ?? 0 },
        integrations: health.integrations,
        sync: { outcome: (recentEvents as Array<Record<string, unknown>>).find((event) => event.event_type === 'feishu.sync.completed')?.details && typeof ((recentEvents as Array<Record<string, unknown>>).find((event) => event.event_type === 'feishu.sync.completed')?.details) === 'object'
          ? (((recentEvents as Array<Record<string, unknown>>).find((event) => event.event_type === 'feishu.sync.completed')?.details as Record<string, unknown>).outcome ?? null)
          : null },
        backoff: health.dependencies?.backoff ?? null,
        queue: health.dependencies?.queue ?? null,
      },
      limits: { recent_events: 50, recent_errors: 20, max_string_length: 300 },
      privacy: {
        rawMessagesIncluded: false,
        secretsIncluded: false,
        absolutePathsIncluded: false,
      },
    });
  }

  cleanupLogs(retentionDays = this.config.logging.retentionDays) {
    const safeDays = Math.min(Math.max(retentionDays, 1), 365);
    const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.database.transaction(() => {
      const logs = this.database.raw.prepare('DELETE FROM app_log WHERE created_at < ?').run(cutoff);
      const decisions = this.database.raw.prepare('DELETE FROM ai_decision_log WHERE created_at < ?').run(cutoff);
      const health = this.database.raw.prepare('DELETE FROM integration_health WHERE checked_at < ?').run(cutoff);
      return { logs: logs.changes, decisions: decisions.changes, health: health.changes };
    });
    this.log('runtime', 'info', 'logs.cleanup', '已按保留期限清理脱敏日志。', { retentionDays: safeDays, ...result });
    return result;
  }

  cleanupAilySummaryInbox(retentionDays = AILY_SUMMARY_INBOX_RETENTION_DAYS) {
    const safeDays = Math.min(Math.max(retentionDays, 1), 365);
    const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
    const removed = this.database.raw.prepare(
      `DELETE FROM aily_summary_inbox
        WHERE status IN ('completed','failed')
          AND COALESCE(completed_at, updated_at) < ?`,
    ).run(cutoff).changes;
    return { removed, retentionDays: safeDays };
  }

  clearLogs(includeCorrections = false) {
    const result = this.database.transaction(() => {
      const logs = this.database.raw.prepare('DELETE FROM app_log').run().changes;
      const decisions = this.database.raw.prepare('DELETE FROM ai_decision_log').run().changes;
      const health = this.database.raw.prepare('DELETE FROM integration_health').run().changes;
      const corrections = includeCorrections ? this.database.raw.prepare('DELETE FROM correction_event').run().changes : 0;
      return { logs, decisions, health, corrections };
    });
    return result;
  }


  private invokeSyncEntry<TRunner>(
    runner: TRunner | undefined,
    operation: (available: TRunner) => Promise<unknown> | unknown,
  ) {
    if (!runner) return { skipped: true, reason: 'adapter_unavailable' } as const;
    return operation(runner);
  }


  listCorrections(limit = 100) {
    return this.database.raw.prepare('SELECT * FROM correction_event ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500));
  }

  listCorrectionsPublic(limit = 100) {
    return (this.listCorrections(limit) as Array<Record<string, unknown>>).map((row) => ({
      id: row.id,
      candidate_id: row.candidate_id ?? null,
      task_id: row.task_id ?? null,
      correction_type: row.correction_type,
      visibility: row.visibility,
      operation: row.operation,
      created_at: row.created_at,
    }));
  }

  recordCorrection(input: {
    correctionType: string;
    candidateId?: string;
    taskId?: string;
    expectedCandidateVersion?: number;
    targetTaskId?: string;
    sourceEventId?: string;
    demandUnitId?: string;
    expectedTaskVersion?: number;
    expectedTargetTaskVersion?: number;
    idempotencyKey?: string;
    note?: string;
    replacementValue?: string;
    replacementStatus?: TaskStatus;
    replacementScheduleAt?: string | null;
    manualContent?: string;
    manualSenderName?: string;
    manualOccurredAt?: string;
  }) {
    const candidate = input.candidateId
      ? this.getCandidate(input.candidateId)
      : input.correctionType === 'false_positive' && input.taskId
        ? (this.database.raw.prepare('SELECT * FROM candidate_request WHERE accepted_task_id = ?').get(input.taskId) as CandidateRow | undefined) ?? null
        : null;
    if (candidate?.deleted_at) throw new Error('回收站中的候选只能恢复，不能继续纠错。');
    if (candidate && (typeof input.expectedCandidateVersion !== 'number' || !Number.isInteger(input.expectedCandidateVersion)
      || input.expectedCandidateVersion <= 0
      || candidate.version !== input.expectedCandidateVersion)) {
      throw new CandidateVersionConflictError();
    }
    const task = input.taskId ? this.getTask(input.taskId) : candidate?.accepted_task_id ? this.getTask(candidate.accepted_task_id) : null;
    const targetTask = input.targetTaskId ? this.getTask(input.targetTaskId) : null;
    if (input.correctionType !== 'missed_request' && !candidate && !task) throw new Error('纠错对象不存在。');
    if (input.correctionType === 'false_positive') {
      if (!candidate) throw new Error('“这不是需求”只能用于候选记录。');
      if (candidate.state === 'ignored' && !candidate.accepted_task_id) throw new Error('该候选已经标记为不是需求。');
      if (task?.record_state === 'invalidated') throw new Error('该正式任务已经标记为无效记录。');
      if (task && input.expectedTaskVersion === undefined) throw new Error('标记已建立的正式任务前需要提供当前任务版本。');
    }
    if (input.correctionType === 'missed_request' && !input.manualContent?.trim()) {
      throw new Error('漏掉的需求需要填写原始消息内容。');
    }
    if (input.correctionType === 'wrong_association' && (!task || !targetTask || task.id === targetTask.id)) {
      throw new Error('任务关联纠错需要提供有效的目标任务。');
    }
    if ((input.correctionType === 'wrong_fields' || input.correctionType === 'describe_incomplete') && !input.replacementValue?.trim()) {
      throw new Error('字段纠错需要填写正确内容。');
    }
    if (input.correctionType === 'status_or_schedule_wrong' && !task) {
      throw new Error('状态或排期纠错需要指定任务。');
    }
    if (task && input.expectedTaskVersion !== undefined && input.expectedTaskVersion !== task.version) {
      throw new Error('任务已被其他操作更新，请刷新后重试。');
    }
    if (targetTask && input.expectedTargetTaskVersion !== undefined && input.expectedTargetTaskVersion !== targetTask.version) {
      throw new Error('目标任务已被其他操作更新，请刷新后重试。');
    }
    const idempotencyKey = input.idempotencyKey?.trim() || id('idem');
    const existing = this.database.raw.prepare('SELECT * FROM correction_event WHERE idempotency_key = ?').get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return { duplicate: true, correction: existing };
    const correctionId = id('corr');
    if (task && input.correctionType === 'status_or_schedule_wrong'
      && input.replacementScheduleAt !== undefined
      && input.replacementScheduleAt !== task.planned_due_at) {
      assertShanghaiCalendarPlanRange(task.planned_start_at, input.replacementScheduleAt);
    }
    const before = {
      candidate: candidateAuditSnapshot(candidate),
      task: taskAuditSnapshot(task),
      targetTask: taskAuditSnapshot(targetTask),
    };
    const timestamp = nowIso();
    let createdCandidateId: string | null = null;
    let createdSourceEventId: string | null = null;
    let affectedSourceEventId = candidate?.source_event_id ?? null;
    let afterCandidate: CandidateRow | null = candidate;
    let afterTask: TaskRecord | null = task;
    let afterTargetTask: TaskRecord | null = targetTask;
    const pendingTaskSourceGapClosures: Array<{
      gapTaskId: string;
      resolutionTaskId: string;
      sourceEventId: string;
      demandUnitId: string;
      correctionTaskId?: string;
    }> = [];
    const appendTaskEvent = (eventTask: TaskRecord, summary: string, beforeValue: unknown, afterValue: unknown, sourceEventId: string | null = null) => {
      const demandUnitId = candidate?.demand_unit_id
        ?? (sourceEventId ? this.uniqueSourceDemandUnitId(sourceEventId) : null);
      this.database.raw.prepare(
        `INSERT INTO task_event
          (id, task_id, event_type, actor_type, visibility, summary, source_event_id, demand_unit_id, before_json, after_json, occurred_at, recorded_at, version)
         VALUES (?, ?, 'correction_recorded', 'user', 'private', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id('evt'), eventTask.id, summary, sourceEventId, demandUnitId, JSON.stringify(beforeValue), JSON.stringify(afterValue), timestamp, timestamp, eventTask.version);
    };
    this.database.transaction(() => {
      if (input.correctionType === 'missed_request') {
        createdSourceEventId = id('src');
        affectedSourceEventId = createdSourceEventId;
        const occurredAt = input.manualOccurredAt ?? timestamp;
        this.database.raw.prepare(
          `INSERT INTO source_event (id, external_id, source_type, conversation_id, sender_id, sender_name, content, occurred_at, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(createdSourceEventId, `manual-correction:${idempotencyKey}`, 'manual', 'manual-entry', 'manual-owner', input.manualSenderName ?? '人工补录', input.manualContent!, occurredAt, timestamp);
        const draft = createManualCandidate(input.manualContent!, input.manualSenderName ?? '人工补录', occurredAt);
        createdCandidateId = id('cand');
        const analysisJson = JSON.stringify({ ...draft.analysis, linkedDocuments: [], sourceRevision: null, contextRevision: null });
        this.database.raw.prepare(
          `INSERT INTO candidate_request
            (id, source_event_id, title, proposer_name, background, validation_question, describe, analysis_json, confidence, state, snoozed_until, accepted_task_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        ).run(createdCandidateId, createdSourceEventId, draft.title, draft.proposerName, draft.background, draft.validationQuestion, draft.describe, analysisJson, draft.confidence, timestamp, timestamp);
        afterCandidate = this.getCandidate(createdCandidateId);
      }
      if (candidate && input.correctionType === 'false_positive') {
        const candidateUpdate = this.database.raw.prepare("UPDATE candidate_request SET state = 'ignored', updated_at = ?, version = version + 1 WHERE id = ? AND version = ?")
          .run(timestamp, candidate.id, candidate.version);
        if (candidateUpdate.changes !== 1) throw new CandidateVersionConflictError();
        afterCandidate = this.getCandidate(candidate.id);
        if (task) {
          const result = this.database.raw.prepare(
            "UPDATE task SET status = 'archived', record_state = 'invalidated', archived_at = COALESCE(archived_at, ?), updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
          ).run(timestamp, timestamp, task.id, task.version);
          if (result.changes !== 1) throw new Error('任务已被其他操作更新，请刷新后重试。');
          afterTask = this.getTask(task.id);
          this.terminateTaskDraftsInTransaction(task.id, timestamp);
          appendTaskEvent(afterTask!, '系统主人确认这条记录不是需求，已将正式任务标记为无效并归档。', taskAuditSnapshot(task), taskAuditSnapshot(afterTask), candidate.source_event_id);
        }
      }
      if (candidate && input.correctionType === 'wrong_fields' && input.replacementValue) {
        const candidateUpdate = this.database.raw.prepare('UPDATE candidate_request SET proposer_name = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
          .run(input.replacementValue, timestamp, candidate.id, candidate.version);
        if (candidateUpdate.changes !== 1) throw new CandidateVersionConflictError();
        afterCandidate = this.getCandidate(candidate.id);
      }
      if (task && input.correctionType === 'wrong_fields' && input.replacementValue) {
        const result = this.database.raw.prepare('UPDATE task SET proposer_name = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
          .run(input.replacementValue, timestamp, task.id, task.version);
        if (result.changes !== 1) throw new Error('任务已被其他操作更新，请刷新后重试。');
        afterTask = this.getTask(task.id);
        appendTaskEvent(afterTask!, '系统主人纠正了任务提出人。', taskAuditSnapshot(task), taskAuditSnapshot(afterTask));
      }
      if (candidate && input.correctionType === 'describe_incomplete' && input.replacementValue) {
        const candidateUpdate = this.database.raw.prepare('UPDATE candidate_request SET describe = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
          .run(input.replacementValue, timestamp, candidate.id, candidate.version);
        if (candidateUpdate.changes !== 1) throw new CandidateVersionConflictError();
        afterCandidate = this.getCandidate(candidate.id);
      }
      if (task && input.correctionType === 'describe_incomplete' && input.replacementValue) {
        const result = this.database.raw.prepare('UPDATE task SET describe = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
          .run(input.replacementValue, timestamp, task.id, task.version);
        if (result.changes !== 1) throw new Error('任务已被其他操作更新，请刷新后重试。');
        afterTask = this.getTask(task.id);
        appendTaskEvent(afterTask!, '系统主人补充了任务 describe。', taskAuditSnapshot(task), taskAuditSnapshot(afterTask));
      }
      if (task && input.correctionType === 'status_or_schedule_wrong') {
        const nextStatus = input.replacementStatus ?? task.status;
        const nextSchedule = input.replacementScheduleAt === undefined ? task.planned_due_at : input.replacementScheduleAt;
        const nextStep = input.replacementValue ?? task.next_step;
        if (nextStatus === task.status && nextSchedule === task.planned_due_at && nextStep === task.next_step) {
          throw new Error('状态、排期和下一步都没有发生变化。');
        }
        const completedAt = nextStatus === 'completed' ? task.completed_at ?? timestamp : nextStatus === 'archived' ? task.completed_at : null;
        const archivedAt = nextStatus === 'archived' ? task.archived_at ?? timestamp : null;
        const result = this.database.raw.prepare(
          'UPDATE task SET status = ?, schedule_at = ?, planned_due_at = ?, next_step = ?, completed_at = ?, archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?',
        ).run(nextStatus, nextSchedule, nextSchedule, nextStep, completedAt, archivedAt, timestamp, task.id, task.version);
        if (result.changes !== 1) throw new Error('任务已被其他操作更新，请刷新后重试。');
        afterTask = this.getTask(task.id);
        appendTaskEvent(afterTask!, '系统主人纠正了任务状态或排期。', taskAuditSnapshot(task), taskAuditSnapshot(afterTask));
      }
      if (task && targetTask && input.correctionType === 'wrong_association') {
        const sourceIds = this.database.raw.prepare('SELECT source_event_id FROM task_source_link WHERE task_id = ?').all(task.id) as Array<{ source_event_id: string }>;
        if (!sourceIds.length) throw new Error('源任务没有可移动的来源记录。');
        const selectedSourceId = input.sourceEventId;
        if (!selectedSourceId) throw new Error('请明确选择要纠正的来源。');
        const matchingUnits = this.database.raw.prepare(
          `SELECT DISTINCT candidate_request.demand_unit_id
           FROM candidate_request
           JOIN source_demand_unit_source ON source_demand_unit_source.demand_unit_id = candidate_request.demand_unit_id
           WHERE candidate_request.accepted_task_id = ?
             AND source_demand_unit_source.source_event_id = ?
             AND candidate_request.demand_unit_id IS NOT NULL`,
        ).all(task.id, selectedSourceId) as Array<{ demand_unit_id: string }>;
        const selectedUnitId = input.demandUnitId ?? (matchingUnits.length === 1 ? matchingUnits[0]!.demand_unit_id : null);
        if (!sourceIds.some((source) => source.source_event_id === selectedSourceId)) {
          throw new Error('所选需求不属于源任务。');
        }
        const legacyCandidates = this.database.raw.prepare(
          'SELECT * FROM candidate_request WHERE source_event_id = ? AND accepted_task_id = ? ORDER BY updated_at DESC',
        ).all(selectedSourceId, task.id) as CandidateRow[];
        if (!selectedUnitId && legacyCandidates.length !== 1) throw new Error('这条消息包含多个需求，请明确选择要纠正的具体需求。');
        const selectedCandidate = selectedUnitId
          ? this.database.raw.prepare('SELECT * FROM candidate_request WHERE demand_unit_id = ?').get(selectedUnitId) as CandidateRow | undefined
          : legacyCandidates[0];
        if (!selectedCandidate || selectedCandidate.accepted_task_id !== task.id) throw new Error('所选需求没有关联当前任务。');
        const oldTaskSourceRows = this.database.raw.prepare(
          'SELECT demand_unit_id FROM task_source_link WHERE task_id = ? AND source_event_id = ?',
        ).all(task.id, selectedSourceId) as Array<{ demand_unit_id: string | null }>;
        const oldExplicitUnitCount = new Set(oldTaskSourceRows
          .map((row) => row.demand_unit_id)
          .filter((value): value is string => value !== null)).size;
        const mayResolveLegacyOldEdge = selectedUnitId === null || oldExplicitUnitCount === 0;
        affectedSourceEventId = selectedSourceId;
        const sourceVersion = input.expectedTaskVersion ?? task.version;
        const targetVersion = input.expectedTargetTaskVersion ?? targetTask.version;
        const sourceUpdated = this.database.raw.prepare('UPDATE task SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?').run(timestamp, task.id, sourceVersion);
        const targetUpdated = this.database.raw.prepare('UPDATE task SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?').run(timestamp, targetTask.id, targetVersion);
        if (sourceUpdated.changes !== 1 || targetUpdated.changes !== 1) throw new Error('任务已被其他操作更新，请刷新后重试。');
        if (!task.thread_id || !targetTask.thread_id) throw new Error('源任务或目标任务缺少需求线程，不能安全移动来源。');
        const unitSources = this.sourceRowsForDemandUnit(selectedUnitId, this.database.raw.prepare('SELECT * FROM source_event WHERE id = ?').get(selectedSourceId) as SourceEventRow);
        const existingThreadRelation = this.database.raw.prepare(
          `SELECT * FROM requirement_thread_source WHERE thread_id = ? AND source_event_id = ?`,
        ).get(task.thread_id, selectedSourceId) as (RequirementThreadSourceRow & {
          session_id: string | null;
          conversation_id: string | null;
          participant_ids_json: string;
          source_revision: string | null;
        }) | undefined;
        if (!existingThreadRelation) throw new Error('所选来源缺少源需求线程关系，不能安全移动。');
        for (const unitSource of unitSources) this.database.raw.prepare(
          `INSERT INTO requirement_thread_source
            (thread_id, source_event_id, demand_unit_id, relation_type, confidence, evidence_json, root_id, parent_id, session_id,
             conversation_id, participant_ids_json, source_revision, created_at)
           VALUES (?, ?, ?, 'owner_corrected', 1, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id, source_event_id) DO UPDATE SET
             relation_type = 'owner_corrected', confidence = 1, evidence_json = excluded.evidence_json,
             root_id = excluded.root_id, parent_id = excluded.parent_id, session_id = excluded.session_id,
             conversation_id = excluded.conversation_id, participant_ids_json = excluded.participant_ids_json,
             source_revision = excluded.source_revision`,
        ).run(
          targetTask.thread_id,
          unitSource.id,
          selectedUnitId,
          JSON.stringify(['系统主人纠正了该来源的需求归属；后续回复应继续进入目标线程。']),
          existingThreadRelation.root_id,
          existingThreadRelation.parent_id,
          existingThreadRelation.session_id,
          existingThreadRelation.conversation_id,
          existingThreadRelation.participant_ids_json,
          existingThreadRelation.source_revision,
          timestamp,
        );
        if (selectedUnitId) this.moveDemandUnitsToThread([selectedUnitId], task.thread_id, targetTask.thread_id, timestamp);
        for (const unitSource of unitSources) {
          if (!selectedUnitId || !this.sourceUsedByOtherThreadUnit(task.thread_id, unitSource.id, [selectedUnitId])) {
            this.database.raw.prepare('DELETE FROM requirement_thread_source WHERE thread_id = ? AND source_event_id = ?')
              .run(task.thread_id, unitSource.id);
          }
        }
        const source = this.database.raw.prepare('SELECT metadata_json FROM source_event WHERE id = ?').get(selectedSourceId) as { metadata_json: string } | undefined;
        if (source) {
          const metadata = parseMetadata(source.metadata_json);
          metadata.internalRequirementThreadId = targetTask.thread_id;
          this.database.raw.prepare('UPDATE source_event SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), selectedSourceId);
        }
        if (selectedUnitId) {
          const selectedCandidates = this.database.raw.prepare(
            'SELECT id, version FROM candidate_request WHERE demand_unit_id = ? AND accepted_task_id = ? ORDER BY id',
          ).all(selectedUnitId, task.id) as Array<{ id: string; version: number }>;
          for (const candidateRow of selectedCandidates) {
            const updated = this.database.raw.prepare(
              'UPDATE candidate_request SET accepted_task_id = ?, updated_at = ?, version = version + 1 WHERE id = ? AND demand_unit_id = ? AND accepted_task_id = ? AND version = ?',
            ).run(targetTask.id, timestamp, candidateRow.id, selectedUnitId, task.id, candidateRow.version);
            if (updated.changes !== 1) throw new CandidateVersionConflictError();
          }
        } else {
          const updated = this.database.raw.prepare(
            'UPDATE candidate_request SET accepted_task_id = ?, updated_at = ?, version = version + 1 WHERE id = ? AND accepted_task_id = ? AND version = ?',
          ).run(targetTask.id, timestamp, selectedCandidate.id, task.id, selectedCandidate.version);
          if (updated.changes !== 1) throw new CandidateVersionConflictError();
        }
        for (const unitSource of unitSources) {
          this.linkTaskSource(targetTask.id, unitSource.id, 'corrected_origin', timestamp, selectedUnitId, { deferIntegrityGapClosure: true });
          if (selectedUnitId) {
            pendingTaskSourceGapClosures.push(
              { gapTaskId: task.id, resolutionTaskId: targetTask.id, sourceEventId: unitSource.id, demandUnitId: selectedUnitId, correctionTaskId: task.id },
              { gapTaskId: targetTask.id, resolutionTaskId: targetTask.id, sourceEventId: unitSource.id, demandUnitId: selectedUnitId, correctionTaskId: task.id },
            );
          }
          const sourceStillUsedByTask = selectedUnitId ? this.database.raw.prepare(
            `SELECT COUNT(*) AS count
             FROM candidate_request
             JOIN source_demand_unit_source ON source_demand_unit_source.demand_unit_id = candidate_request.demand_unit_id
             WHERE candidate_request.accepted_task_id = ? AND source_demand_unit_source.source_event_id = ?`,
          ).get(task.id, unitSource.id) as { count: number } : { count: 0 };
          if (sourceStillUsedByTask.count === 0) {
            this.database.raw.prepare(
              `DELETE FROM task_source_link
                WHERE task_id = ? AND source_event_id = ?
                  AND (demand_unit_id = ? OR (demand_unit_id IS NULL AND ? = 1))`,
            ).run(task.id, unitSource.id, selectedUnitId, mayResolveLegacyOldEdge ? 1 : 0);
          }
        }
        afterCandidate = this.getCandidate(selectedCandidate.id);
        afterTask = this.getTask(task.id);
        afterTargetTask = this.getTask(targetTask.id);
        appendTaskEvent(afterTask!, '系统主人将一条来源移出当前任务。', { task: taskAuditSnapshot(task), linked: true }, { task: taskAuditSnapshot(afterTask), linked: false }, selectedSourceId);
        appendTaskEvent(afterTargetTask!, '系统主人将一条来源纠正关联到当前任务。', { task: taskAuditSnapshot(targetTask), linked: false }, { task: taskAuditSnapshot(afterTargetTask), linked: true }, selectedSourceId);
      }
      this.database.raw
        .prepare(`INSERT INTO correction_event
          (id, idempotency_key, task_id, candidate_id, source_event_id, demand_unit_id, correction_type, before_json, after_json, note, visibility, operation, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', 'apply', ?)`)
        .run(
          correctionId,
          idempotencyKey,
          task?.id ?? null,
          afterCandidate?.id ?? createdCandidateId,
          affectedSourceEventId,
          afterCandidate?.demand_unit_id ?? candidate?.demand_unit_id
            ?? (affectedSourceEventId ? this.uniqueSourceDemandUnitId(affectedSourceEventId) : null),
          input.correctionType,
          JSON.stringify(before),
          JSON.stringify({ candidate: candidateAuditSnapshot(afterCandidate), task: taskAuditSnapshot(afterTask), targetTask: taskAuditSnapshot(afterTargetTask), movedSourceEventId: input.correctionType === 'wrong_association' ? affectedSourceEventId : null }),
          input.note ?? '',
          timestamp,
        );
      for (const closure of pendingTaskSourceGapClosures) {
        this.closeTaskSourceIntegrityGap({
          ...closure,
          timestamp,
          correctionEventId: correctionId,
        });
      }
    });
    const projectionTaskIds = [...new Set([
      afterTask?.id,
      input.correctionType === 'wrong_association' ? afterTargetTask?.id : undefined,
    ].filter((value): value is string => Boolean(value)))];
    for (const projectionTaskId of projectionTaskIds) this.projectTaskMemory(projectionTaskId);
    this.log('ai', 'info', 'correction.recorded', '已记录私人纠错，不会生成对外动作。', { correctionType: input.correctionType, candidateId: candidate?.id, taskId: task?.id });
    return {
      duplicate: false,
      candidate: afterCandidate,
      task: task ? this.getTask(task.id) : null,
      targetTask: targetTask ? this.getTask(targetTask.id) : null,
    };
  }


  private log(category: string, level: 'info' | 'warn' | 'error', eventType: string, summary: string, context: Record<string, unknown> = {}) {
    const safeContext = redactDiagnosticRecord(context, { maxStringLength: 160 });
    this.database.raw.prepare('INSERT INTO app_log (id, category, level, event_type, summary, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id('log'), category, level, eventType, redactDiagnosticText(summary, 300), JSON.stringify(safeContext), nowIso());
  }

  private redactStoredJson(value: unknown) {
    if (typeof value !== 'string' || !value) return JSON.stringify(redactDiagnosticRecord({}));
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
        return JSON.stringify(redactDiagnosticRecord(parsed as Record<string, unknown>));
      }
      return JSON.stringify({ value: redactDiagnosticValue(parsed), redactionSchemaVersion: REDACTION_SCHEMA_VERSION });
    } catch {
      return JSON.stringify({ malformed: true, redactionSchemaVersion: REDACTION_SCHEMA_VERSION });
    }
  }

}
