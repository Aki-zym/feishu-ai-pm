import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Renderer-facing source data is deliberately smaller than the durable
 * source_event row.  In particular, source ids, external ids, URLs, sender
 * identities, provider payloads and content are not part of the default DTO.
 */
export const sourceScopeSchema = z.string().regex(/^src_scope_[a-f0-9]{32}$/u);

export const minimalSourceDtoSchema = z.object({
  source_scope: sourceScopeSchema,
  source_type: z.enum(['bot_dm', 'owner_dm', 'group', 'calendar', 'meeting', 'manual']),
  completeness: z.enum(['complete', 'partial', 'limited']),
  occurred_at: z.string().datetime(),
  summary_available: z.boolean(),
}).strict();

export type MinimalSourceDto = z.infer<typeof minimalSourceDtoSchema>;

const minimalCandidateAnalysisSchema = z.object({
  timeRange: z.object({
    status: z.string().max(40),
    sourceText: z.null(),
    startAt: z.string().datetime().nullable(),
    endAt: z.string().datetime().nullable(),
    timezone: z.literal('Asia/Shanghai'),
    needsConfirmation: z.boolean(),
  }).strict(),
  fieldBasis: z.object({
    background: z.string().max(40),
    validationQuestion: z.string().max(40),
    describe: z.string().max(40),
  }).strict(),
  recognitionEvidence: z.array(z.string().max(300)).max(8),
  ownerAction: z.object({
    required: z.boolean(),
    summary: z.string().max(300),
    role: z.string().max(40),
    basis: z.string().max(40),
    confidence: z.number().finite(),
  }).strict().nullable(),
  prioritySuggestion: z.string().max(40).nullable(),
  note: z.string().max(500).nullable(),
  linkedDocuments: z.array(z.object({
    documentType: z.string().max(40),
    status: z.string().max(40),
    freshness: z.string().max(40),
    completeness: z.string().max(40),
    truncated: z.boolean(),
  }).strict()).max(8),
  statusSuggestion: z.string().max(40).nullable(),
  nextStepSuggestion: z.string().max(1_000).nullable(),
  waitingReasonSuggestion: z.string().max(1_000).nullable(),
  updateConfidence: z.number().finite().nullable(),
}).strict();

const minimalCandidateAssociationSchema = z.object({
  threadId: z.string().min(1),
  status: z.string().max(40),
  requiresConfirmation: z.boolean(),
  options: z.array(z.object({
    id: z.string().min(1),
    title: z.string().max(160),
    describe: z.string().max(2_000),
    status: z.string().max(40),
    activeTaskId: z.string().nullable(),
    activeTaskTitle: z.string().max(160).nullable(),
    lastActivityAt: z.string().datetime().nullable(),
  }).strict()).max(20),
}).strict();

const minimalCandidateMergeSourceSchema = z.object({
  sourceScope: sourceScopeSchema,
  version: z.number().int().positive(),
  sourceType: z.string().max(40),
  occurredAt: z.string().datetime(),
  relationType: z.string().max(80),
  confidence: z.number().finite().nullable(),
  role: z.string().max(40),
  candidateId: z.string().nullable(),
  title: z.string().max(160).nullable(),
  isPrimary: z.boolean(),
}).strict();

const minimalCandidateMergeSchema = z.object({
  threadId: z.string().min(1),
  threadVersion: z.number().int().nonnegative(),
  groupVersionHash: z.string().length(64),
  mutationVersionHash: z.string().length(64),
  sourceCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  primaryCandidateId: z.string().min(1),
  primaryTitle: z.string().max(160),
  primaryReason: z.string().max(300),
  primaryConfidence: z.number().finite().nullable(),
  suggestion: z.object({
    suggestionId: z.string().min(1),
    targetCandidateId: z.string().min(1),
    targetThreadId: z.string().nullable(),
    confidence: z.number().finite().nullable(),
    primary: z.enum(['current', 'target']).nullable(),
    primaryConfidence: z.number().finite().nullable(),
    currentRole: z.string().max(40).nullable(),
    targetRole: z.string().max(40).nullable(),
    reason: z.string().max(300),
    evidence: z.array(z.string().max(300)).max(8),
    target: z.object({
      candidateId: z.string().min(1),
      title: z.string().max(160),
    }).strict().nullable(),
  }).strict().nullable(),
  sources: z.array(minimalCandidateMergeSourceSchema).max(50),
}).strict();

/** Strict top-level allowlist for the default candidate renderer DTO. */
export const minimalCandidateDtoSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  title: z.string().max(160),
  proposer_name: z.string().max(160),
  background: z.string().max(2_000),
  validation_question: z.string().max(1_000),
  describe: z.string().max(2_000),
  confidence: z.number().finite(),
  state: z.enum(['pending', 'snoozed', 'ignored', 'accepted']),
  snoozed_until: z.string().nullable(),
  accepted_task_id: z.string().nullable(),
  deleted_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  source_type: z.string().max(40),
  owner_mentioned: z.number().or(z.boolean()),
  source_completeness: z.string().max(40),
  discovery_reason: z.string().max(300),
  source_scope: sourceScopeSchema,
  processing_state: z.string().max(40),
  processing_error: z.string().nullable(),
  context_state: z.string().max(40),
  context_reason: z.string().nullable(),
  recovered_at: z.string().nullable(),
  analysis: minimalCandidateAnalysisSchema,
  thread_association: minimalCandidateAssociationSchema.nullable(),
  merge_group: minimalCandidateMergeSchema.nullable(),
}).strict();

export type MinimalCandidateDto = z.infer<typeof minimalCandidateDtoSchema>;

const pendingOwnerActionDtoSchema = z.object({
  id: z.string().min(1).max(200),
  action: z.enum(['continue', 'confirm_schedule', 'request_context', 'decline', 'delegate']),
  state: z.enum(['review', 'failed']),
  candidateId: z.string().max(200).nullable(),
  taskId: z.string().max(200).nullable(),
  confidence: z.number().finite().min(0).max(1),
  scheduleDetected: z.boolean(),
  createdAt: z.string().datetime(),
  message: z.string().max(240),
}).strict();

export const candidateInboxDtoSchema = z.object({
  items: z.array(minimalCandidateDtoSchema).max(2_000),
  ownerActions: z.array(pendingOwnerActionDtoSchema).max(50),
}).strict();

export type CandidateInboxDto = z.infer<typeof candidateInboxDtoSchema>;

const ownerSourceIssueSchema = z.object({
  code: z.enum(['authorization_required', 'admin_approval_required', 'platform_unsupported', 'partial_access', 'sync_failed']),
  message: z.string().max(120),
}).strict();

export const ownerInformationDtoSchema = z.object({
  owner: z.object({
    name: z.string().max(160),
    oauthStatus: z.enum(['mock', 'authorized', 'expired', 'revoked', 'unknown']),
    configuredScopes: z.array(z.string().max(160)).max(200),
    lastSyncedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  }).strict().nullable(),
  sources: z.array(z.object({
    kind: z.enum(['owner_dm', 'owner_mentions', 'calendar', 'minutes', 'bot_supplement']),
    enabled: z.boolean(),
    status: z.enum(['mock_ready', 'ready', 'unauthorized', 'admin_required', 'partial', 'unsupported', 'error']),
    scopeSummary: z.string().max(500),
    requiresAdmin: z.boolean(),
    requiresBotInChat: z.boolean(),
    syncMode: z.enum(['realtime', 'periodic', 'manual', 'mixed']),
    lastSuccessAt: z.string().datetime().nullable(),
    issue: ownerSourceIssueSchema.nullable(),
    updatedAt: z.string().datetime(),
  }).strict()).max(10),
}).strict();

export type OwnerInformationDto = z.infer<typeof ownerInformationDtoSchema>;

export const sourceVerificationRequestSchema = z.object({
  confirmed: z.literal(true),
}).strict();

export type SourceVerificationRequest = z.infer<typeof sourceVerificationRequestSchema>;

export const sourceVerificationStatusSchema = z.enum(['local_snapshot_verified', 'local_snapshot_unavailable']);
export const sourceVerificationReasonSchema = z.enum([
  'available',
  'snapshot_marked_revoked',
  'snapshot_permission_unavailable',
  'snapshot_content_missing',
  'snapshot_content_corrupt',
]);
export const sourceVerificationProviderStatusSchema = z.enum([
  'unknown',
  'last_known_authorized',
  'last_known_permission_denied',
  'last_known_revoked',
  'last_known_unavailable',
]);

export const sourceVerificationDtoSchema = z.object({
  scope: sourceScopeSchema,
  status: sourceVerificationStatusSchema,
  reason: sourceVerificationReasonSchema,
  provider_status: sourceVerificationProviderStatusSchema,
  provider_status_at: z.string().datetime().nullable(),
  snapshot_captured_at: z.string().datetime(),
  source_type: z.enum(['bot_dm', 'owner_dm', 'group', 'calendar', 'meeting', 'manual']),
  completeness: z.enum(['complete', 'partial', 'limited']),
  occurred_at: z.string().datetime(),
  content_excerpt: z.string().max(280).nullable(),
  message: z.string().max(160),
  excerpt_redacted: z.literal(true),
  external_action: z.literal('none'),
}).strict();

export type SourceVerificationDto = z.infer<typeof sourceVerificationDtoSchema>;

const timestampSchema = z.string().max(80).refine((value) => Number.isFinite(Date.parse(value)), '时间格式无效。');
const nullableTimestampSchema = timestampSchema.nullable();

const taskEventDtoSchema = z.object({
  id: z.string().min(1).max(200),
  event_type: z.string().min(1).max(80),
  actor_type: z.string().min(1).max(80),
  visibility: z.string().min(1).max(80),
  summary: z.string().max(500),
  occurred_at: timestampSchema,
  recorded_at: timestampSchema,
  version: z.number().int().nonnegative(),
}).strict();

const referenceBindingDtoSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().max(200),
  access_mode: z.string().max(80),
  created_at: timestampSchema,
  path_bound: z.literal(true),
}).strict();

const approvalDtoSchema = z.object({
  id: z.string().min(1).max(200),
  action_type: z.string().min(1).max(80),
  status: z.enum(['awaiting_approval', 'approved', 'rejected']),
  created_at: timestampSchema,
  decided_at: nullableTimestampSchema,
}).strict();

export const requirementThreadDtoSchema = z.object({
  id: z.string().min(1).max(200),
  status: z.enum(['open', 'needs_confirmation', 'closed']),
  title: z.string().max(160),
  background: z.string().max(2_000),
  validation_question: z.string().max(1_000),
  describe: z.string().max(2_000),
  version: z.number().int().nonnegative(),
  last_activity_at: nullableTimestampSchema,
  ambiguity: z.array(z.never()).max(0),
}).strict();

export const threadRevisionDtoSchema = z.object({
  id: z.string().min(1).max(200),
  thread_id: z.string().min(1).max(200),
  base_thread_version: z.number().int().nonnegative(),
  state: z.string().max(80),
  created_at: timestampSchema,
  decided_at: nullableTimestampSchema,
}).strict();

export const threadListDtoSchema = z.object({
  items: z.array(requirementThreadDtoSchema).max(5000),
}).strict();

const taskUpdatePatchDtoSchema = z.object({
  title: z.string().max(160).optional(),
  describe: z.string().max(2_000).optional(),
  status: z.enum(['unplanned', 'planned', 'in_progress', 'waiting', 'review', 'completed', 'archived']).optional(),
  plannedStartAt: nullableTimestampSchema.optional(),
  plannedDueAt: nullableTimestampSchema.optional(),
  nextStep: z.string().max(1_000).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  waitingReason: z.string().max(1_000).nullable().optional(),
  threadTitle: z.string().max(160).optional(),
  threadBackground: z.string().max(2_000).optional(),
  threadValidationQuestion: z.string().max(1_000).optional(),
  threadDescribe: z.string().max(2_000).optional(),
  note: z.string().max(1_000).optional(),
}).strict();

export const taskUpdateProposalDtoSchema = z.object({
  id: z.string().min(1).max(200),
  task_id: z.string().min(1).max(200),
  thread_id: z.string().max(200).nullable(),
  candidate_revision_id: z.string().max(200).nullable(),
  thread_revision_id: z.string().max(200).nullable(),
  base_task_version: z.number().int().nonnegative(),
  base_thread_version: z.number().int().nonnegative().nullable(),
  patch: taskUpdatePatchDtoSchema,
  changes: z.array(z.object({
    field: z.string().max(80),
    before: z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]),
    after: z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]),
  }).strict()).max(20),
  reason: z.string().max(500),
  evidence: z.array(z.literal('已保留受控证据，原文需主人主动核验。')).max(1),
  state: z.enum(['awaiting_approval', 'approved', 'rejected', 'stale']),
  origin: z.enum(['follow_up', 'owner_association', 'reprocess']),
  association_confidence: z.number().finite().nullable(),
  update_confidence: z.number().finite().nullable(),
  used_fallback: z.boolean(),
  decision_mode: z.enum(['pending', 'auto', 'owner', 'reverted']),
  policy_version: z.enum(['private_task_auto_v1', 'unknown']),
  policy_reason: z.literal('服务端策略门禁已记录。'),
  applied_task_version: z.number().int().nonnegative().nullable(),
  applied_thread_version: z.number().int().nonnegative().nullable(),
  task_event_id: z.string().max(200).nullable(),
  reverted_at: nullableTimestampSchema,
  reverted_task_event_id: z.string().max(200).nullable(),
  can_revert: z.boolean(),
  cannot_revert_reason: z.string().max(500).nullable(),
  source: z.object({
    scope: sourceScopeSchema,
    source_type: z.enum(['bot_dm', 'owner_dm', 'group', 'calendar', 'meeting', 'manual']),
    occurred_at: timestampSchema,
  }).strict().nullable(),
  created_at: timestampSchema,
  decided_at: nullableTimestampSchema,
}).strict();

const memoryProjectionDtoSchema = z.object({
  task_id: z.string().min(1).max(200),
  projection_version: z.number().int().nonnegative(),
  relative_path: z.string().max(500),
  state: z.enum(['pending', 'ready', 'error']),
  last_error: z.string().max(160).nullable(),
  last_projected_at: nullableTimestampSchema,
  updated_at: timestampSchema,
}).strict();

const runtimeJobDtoSchema = z.object({
  id: z.string().min(1).max(200),
  job_type: z.string().min(1).max(80),
  status: z.enum(['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled']),
  attempts: z.number().int().nonnegative(),
  max_attempts: z.number().int().nonnegative(),
  retryable: z.union([z.boolean(), z.number().int().min(0).max(1)]),
  available_at: timestampSchema,
  last_error: z.string().max(160).nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const taskDtoSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().max(160),
  proposer_name: z.string().max(160),
  describe: z.string().max(2_000),
  status: z.enum(['unplanned', 'planned', 'in_progress', 'waiting', 'review', 'completed', 'archived']),
  schedule_at: nullableTimestampSchema,
  planned_start_at: nullableTimestampSchema,
  planned_due_at: nullableTimestampSchema,
  next_step: z.string().max(1_000),
  risk: z.enum(['low', 'medium', 'high']),
  waiting_reason: z.string().max(1_000).nullable(),
  version: z.number().int().nonnegative(),
  completed_at: nullableTimestampSchema,
  archived_at: nullableTimestampSchema,
  deleted_at: nullableTimestampSchema,
  record_state: z.enum(['active', 'invalidated']),
  merged_into_task_id: z.string().max(200).nullable(),
  auto_update_paused: z.boolean(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const threadDetailDtoSchema = z.object({
  id: z.string().min(1).max(200),
  status: z.enum(['open', 'needs_confirmation', 'closed']),
  title: z.string().max(160),
  background: z.string().max(2_000),
  validation_question: z.string().max(1_000),
  describe: z.string().max(2_000),
  active_task_id: z.string().max(200).nullable(),
  version: z.number().int().nonnegative(),
  last_activity_at: nullableTimestampSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  ambiguity: z.array(z.never()).max(0),
  sources: z.array(minimalSourceDtoSchema).max(500),
  revisions: z.array(threadRevisionDtoSchema).max(500),
  proposals: z.array(taskUpdateProposalDtoSchema).max(500),
  task: taskDtoSchema.nullable(),
}).strict();

export type TaskDto = z.infer<typeof taskDtoSchema>;

export const taskListDtoSchema = z.object({
  items: z.array(taskDtoSchema).max(5_000),
}).strict();

export const dashboardDtoSchema = z.object({
  candidates: z.array(minimalCandidateDtoSchema).max(6),
  today: z.array(taskDtoSchema).max(8),
  waiting: z.array(taskDtoSchema).max(8),
  counts: z.object({
    candidates: z.number().int().nonnegative(),
    today: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
  }).strict(),
  asOf: timestampSchema,
  todayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  timezone: z.literal('Asia/Shanghai'),
  dataMode: z.enum(['local_mock', 'configured']),
}).strict();

export const taskDetailDtoSchema = taskDtoSchema.extend({
  sources: z.array(minimalSourceDtoSchema).max(500),
  events: z.array(taskEventDtoSchema).max(2_000),
  references: z.array(referenceBindingDtoSchema).max(500),
  approvals: z.array(approvalDtoSchema).max(500),
  thread: requirementThreadDtoSchema.nullable(),
  update_proposals: z.array(taskUpdateProposalDtoSchema).max(500),
  auto_updates: z.array(taskUpdateProposalDtoSchema).max(500),
  memory_projection: memoryProjectionDtoSchema.nullable(),
  runtime_jobs: z.array(runtimeJobDtoSchema).max(20),
}).strict();

export type TaskDetailDto = z.infer<typeof taskDetailDtoSchema>;

export const candidateActionDtoSchema = z.object({
  candidate: minimalCandidateDtoSchema,
  task: taskDtoSchema.nullable(),
  linkedExistingTask: z.boolean(),
}).strict();

export const candidateThreadAssociationDtoSchema = z.object({
  candidate: minimalCandidateDtoSchema,
  task: taskDtoSchema.nullable(),
  proposal: taskUpdateProposalDtoSchema.nullable(),
  threadId: z.string().min(1).max(200),
}).strict();

export const candidateMergeDtoSchema = z.object({
  candidate: minimalCandidateDtoSchema,
  mergeGroup: minimalCandidateMergeSchema.nullable(),
}).strict();

export const candidateMergeRejectedDtoSchema = z.object({
  candidate: minimalCandidateDtoSchema,
  targetCandidate: minimalCandidateDtoSchema,
  separateCandidates: z.literal(true),
}).strict();

export const candidateSplitDtoSchema = z.object({
  splitCandidate: minimalCandidateDtoSchema,
  remainingCandidate: minimalCandidateDtoSchema,
  splitGroup: minimalCandidateMergeSchema.nullable(),
  remainingGroup: minimalCandidateMergeSchema.nullable(),
}).strict();

export const candidateSourceRetryDtoSchema = z.object({
  status: z.enum(['completed', 'processing', 'queued']),
  message: z.string().max(160),
}).strict();

export const candidateReprocessDtoSchema = z.object({
  candidate: minimalCandidateDtoSchema,
  changed: z.boolean(),
  message: z.string().max(160),
  proposal: taskUpdateProposalDtoSchema.nullable(),
}).strict();

const correctionSummaryDtoSchema = z.object({
  id: z.string().min(1).max(200),
  candidate_id: z.string().max(200).nullable(),
  task_id: z.string().max(200).nullable(),
  correction_type: z.string().min(1).max(80),
  visibility: z.enum(['private', 'awaiting_approval', 'external']),
  operation: z.enum(['apply', 'revert', 'dismiss']),
  created_at: timestampSchema,
}).strict();

export const correctionListDtoSchema = z.object({
  items: z.array(correctionSummaryDtoSchema).max(500),
}).strict();

export const correctionActionDtoSchema = z.object({
  duplicate: z.boolean(),
  candidate: minimalCandidateDtoSchema.nullable(),
  task: taskDtoSchema.nullable(),
  targetTask: taskDtoSchema.nullable(),
}).strict();

/**
 * This is an opaque, task-scoped capability label rather than a source id.
 * It is deterministic so it does not need to be persisted or put in a
 * renderer-visible database table, and source ids cannot be recovered from
 * it without the server-side relation.
 */
export function sourceScope(taskId: string, sourceEventId: string) {
  return `src_scope_${createHash('sha256')
    .update(`source-verification:v1:${taskId}:${sourceEventId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

export function sourceExcerpt(value: string) {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized.slice(0, 280);
}
