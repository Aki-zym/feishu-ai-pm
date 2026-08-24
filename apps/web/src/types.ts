export type CandidateState = 'pending' | 'snoozed' | 'ignored' | 'accepted';
/** Stable read-only DTO returned by /api/integrations/health. */
export type IntegrationHealthDto = {
  integration: string;
  status: string;
  message: string;
  latency_ms?: number | null;
  checked_at: string;
};
/** Stable read-only DTO returned by /api/health for UI readiness messaging. */
export type HealthDto = {
  operation_id?: string;
  request_id?: string;
  liveness?: { status?: string };
  readiness: { status: 'ready' | 'degraded' | 'not_ready' | string; reasons?: Array<{ code?: string; message?: string }> };
  release?: { app_version?: string; build_identity?: string | null; redaction_schema_version?: string };
  timestamp?: string;
};
export type CandidateProcessingState = 'organizing' | 'retry_waiting' | 'ready' | 'incomplete_context' | 'recovered' | 'failed_visible';
export type CandidateContextState = 'complete' | 'possibly_incomplete';
export type TaskStatus = 'unplanned' | 'planned' | 'in_progress' | 'waiting' | 'review' | 'completed' | 'archived';
export type TaskRecordState = 'active' | 'invalidated';
export type RiskLevel = 'low' | 'medium' | 'high';
export type CandidateEvidenceBasis = 'fact' | 'document' | 'inferred' | 'unknown';
export type CandidateSourceRole = 'owner_delivery' | 'background' | 'constraint' | 'process_question' | 'unknown';

export type CandidateMergeSource = {
  sourceScope: string;
  version: number;
  sourceType: string;
  occurredAt: string;
  relationType: string;
  confidence: number | null;
  role: CandidateSourceRole;
  candidateId: string | null;
  title: string | null;
  isPrimary: boolean;
};

export type CandidateMergeSuggestion = {
  suggestionId: string;
  targetCandidateId: string;
  targetThreadId: string | null;
  confidence: number | null;
  primary: 'current' | 'target' | null;
  primaryConfidence: number | null;
  currentRole: CandidateSourceRole | null;
  targetRole: CandidateSourceRole | null;
  reason: string;
  evidence: string[];
  candidateSetHash: string;
  target?: {
    candidateId: string;
    version: number;
    title: string;
    proposerName: string;
    occurredAt: string | null;
  } | null;
};

export type CandidateMergeGroup = {
  threadId: string;
  threadVersion: number;
  groupVersionHash: string;
  mutationVersionHash: string;
  sourceCount: number;
  candidateCount: number;
  primaryCandidateId: string;
  primaryTitle: string;
  primaryReason: string;
  primaryConfidence: number | null;
  suggestion: CandidateMergeSuggestion | null;
  sources: CandidateMergeSource[];
};

export type CandidateAnalysis = {
  timeRange: {
    status: 'explicit' | 'relative_resolved' | 'inferred' | 'unknown';
    sourceText: null;
    startAt: string | null;
    endAt: string | null;
    timezone: 'Asia/Shanghai';
    needsConfirmation: boolean;
  };
  fieldBasis: {
    background: CandidateEvidenceBasis;
    validationQuestion: CandidateEvidenceBasis;
    describe: CandidateEvidenceBasis;
  };
  recognitionEvidence: string[];
  ownerAction?: {
    required: boolean;
    summary: string;
    role: 'analyze' | 'coordinate' | 'review' | 'follow_up' | 'unknown';
    basis: CandidateEvidenceBasis;
    confidence: number;
  } | null;
  prioritySuggestion?: RiskLevel | null;
  note?: string | null;
  linkedDocuments: Array<{
    documentType: string;
    status: 'ready' | 'partial' | 'unauthorized' | 'unsupported' | 'not_found' | 'error';
    freshness: 'fresh' | 'stale';
    completeness: 'complete' | 'partial' | 'limited';
    truncated: boolean;
  }>;
  sourceRevision: string | null;
  contextRevision: string | null;
  statusSuggestion?: TaskStatus | null;
  nextStepSuggestion?: string | null;
  waitingReasonSuggestion?: string | null;
  updateConfidence?: number | null;
};

export type Candidate = {
  id: string;
  version: number;
  source_scope: string;
  title: string;
  proposer_name: string;
  background: string;
  validation_question: string;
  describe: string;
  confidence: number;
  state: CandidateState;
  snoozed_until: string | null;
  accepted_task_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  source_type?: string;
  owner_mentioned?: number;
  source_completeness?: 'complete' | 'partial' | 'limited';
  discovery_reason?: string;
  source_url?: string | null;
  ai_reason?: string;
  ai_provider?: string;
  ai_model?: string;
  prompt_version?: string;
  processing_state?: CandidateProcessingState;
  processing_error?: string | null;
  context_state?: CandidateContextState;
  context_reason?: string | null;
  recovered_at?: string | null;
  analysis?: CandidateAnalysis;
  thread_association?: {
    threadId: string;
    threadVersion: number;
    status: 'open' | 'needs_confirmation' | 'closed';
    requiresConfirmation: boolean;
    options: Array<{
      id: string;
      title: string;
      describe: string;
      status: 'open' | 'needs_confirmation' | 'closed';
      version: number;
      activeTaskId: string | null;
      activeTaskTitle: string | null;
      lastActivityAt: string | null;
    }>;
  } | null;
  merge_group?: CandidateMergeGroup | null;
};

export type SourceFailure = {
  id: string;
  source_event_id: string;
  source_type: string;
  occurred_at: string;
  stage: 'classification';
  error_code: string;
  error_message: string;
  status: 'open' | 'retrying' | 'resolved' | 'ignored' | 'stale';
  retryable: boolean;
  stale: boolean;
  attempts: number;
  max_attempts: number;
  job_status: RuntimeJobSummary['status'] | null;
  next_retry_at: string | null;
  first_failed_at: string;
  last_failed_at: string;
  resolved_at: string | null;
  ignored_at: string | null;
  updated_at: string;
};
export type Task = {
  id: string;
  title: string;
  proposer_name: string;
  describe: string;
  status: TaskStatus;
  schedule_at: string | null;
  planned_start_at: string | null;
  planned_due_at: string | null;
  next_step: string;
  risk: RiskLevel;
  waiting_reason: string | null;
  version: number;
  completed_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  record_state: TaskRecordState;
  merged_into_task_id: string | null;
  auto_update_paused: boolean;
  created_at: string;
  updated_at: string;
};

export type CalendarResponse = {
  asOf: string;
  timezone: 'Asia/Shanghai';
  warning: string | null;
  omittedCount: number;
  days: Array<{
    date: string;
    items: CalendarTaskItem[];
  }>;
};

export type CalendarSourceRoute = 'calendar_fact' | 'candidate_review' | 'owner_confirmation';

export type CalendarSource = {
  title: string;
  startAt: string | null;
  endAt: string | null;
  route: CalendarSourceRoute;
  sourceRetained: boolean;
  candidateCreated: boolean;
  requiresOwnerConfirmation: boolean;
  explanationCode: string;
  evidenceFields: {
    ownerResponsibility?: string;
    action?: string;
    deliverableOrDeadline?: string;
    sourceReference: string;
    missingSignalCode?: string;
  };
  correctionScope: 'current_event_only';
};

export type CalendarSourcesResponse = {
  timezone: 'Asia/Shanghai';
  items: CalendarSource[];
};

export type CalendarTaskItem = Pick<Task, 'id' | 'title' | 'status' | 'next_step'> & {
  display_start_at: string | null;
  display_due_at: string | null;
  display_schedule_at: string | null;
  display_anchor_at: string;
};

export type SourceEvent = {
  source_scope: string;
  source_type: string;
  completeness: string;
  occurred_at: string;
  summary_available: boolean;
  display_name: string;
};

export type SourceVerification = {
  scope: string;
  status: 'local_snapshot_verified' | 'local_snapshot_unavailable';
  reason: 'available' | 'snapshot_marked_revoked' | 'snapshot_permission_unavailable' | 'snapshot_content_missing' | 'snapshot_content_corrupt';
  provider_status: 'unknown' | 'last_known_authorized' | 'last_known_permission_denied' | 'last_known_revoked' | 'last_known_unavailable';
  provider_status_at: string | null;
  snapshot_captured_at: string;
  source_type: string;
  completeness: string;
  occurred_at: string;
  content_excerpt: string | null;
  message: string;
  excerpt_redacted: true;
  external_action: 'none';
};

export type PendingOwnerAction = {
  id: string;
  action: 'continue' | 'confirm_schedule' | 'request_context' | 'decline' | 'delegate';
  state: 'review' | 'failed';
  candidateId: string | null;
  taskId: string | null;
  confidence: number;
  scheduleDetected: boolean;
  createdAt: string;
  message: string;
};

export type CindyOwnerDecision = {
  decision_id: string;
  status: 'pending' | 'resolved' | 'superseded' | 'cancelled';
  version: number;
  reason_summary: string;
  options: Array<{
    option_key: string;
    action: 'skip' | 'create_candidate' | 'append_candidate';
    title: string | null;
    describe: string | null;
    next_step: string | null;
    available: boolean;
  }>;
  source_count: number;
  last_attempt_failed: boolean;
  resolution_action: 'skip' | 'create_candidate' | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export type TaskEvent = {
  id: string;
  event_type: string;
  visibility: string;
  summary: string;
  occurred_at: string;
};

export type ReferenceBinding = {
  id: string;
  label: string;
  access_mode: string;
  created_at: string;
  path_bound: boolean;
};

export type Approval = {
  id: string;
  action_type: string;
  status: string;
  state: 'draft' | 'rejected' | 'obsolete';
  created_at: string;
  decided_at: string | null;
  externally_sent: false;
};

export type RequirementThread = {
  id: string;
  status: 'open' | 'needs_confirmation' | 'closed';
  title: string;
  background: string;
  validation_question: string;
  describe: string;
  version: number;
  last_activity_at: string | null;
  ambiguity: unknown[];
};

export type TaskUpdateProposal = {
  id: string;
  task_id: string;
  thread_id: string | null;
  candidate_revision_id: string | null;
  thread_revision_id: string | null;
  base_task_version: number;
  base_thread_version: number | null;
  patch: Record<string, unknown>;
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  reason: string;
  evidence: unknown;
  state: 'awaiting_approval' | 'approved' | 'rejected' | 'stale';
  origin: 'follow_up' | 'owner_association' | 'reprocess';
  association_confidence: number | null;
  update_confidence: number | null;
  used_fallback: boolean;
  decision_mode: 'pending' | 'auto' | 'owner' | 'reverted';
  policy_version: string;
  policy_reason: string;
  applied_task_version: number | null;
  applied_thread_version: number | null;
  task_event_id: string | null;
  reverted_at: string | null;
  reverted_task_event_id: string | null;
  can_revert: boolean;
  cannot_revert_reason: string | null;
  source: null | {
    scope: string;
    source_type: string;
    occurred_at: string;
  };
  created_at: string;
  decided_at: string | null;
};

export type MemoryProjection = {
  task_id: string;
  projection_version: number;
  relative_path: string;
  state: 'pending' | 'ready' | 'error';
  last_error: string | null;
  last_projected_at: string | null;
  updated_at: string;
};

export type RuntimeJobSummary = {
  id: string;
  job_type: string;
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  max_attempts: number;
  retryable: number;
  available_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskDetail = Task & {
  sources: SourceEvent[];
  events: TaskEvent[];
  references: ReferenceBinding[];
  approvals: Approval[];
  outbox_drafts: Array<{
    id: string;
    approval_id: string;
    action_type: string;
    state: 'draft' | 'rejected' | 'obsolete';
    created_at: string | null;
    externally_sent: false;
  }>;
  thread: RequirementThread | null;
  update_proposals: TaskUpdateProposal[];
  auto_updates: TaskUpdateProposal[];
  memory_projection: MemoryProjection | null;
  runtime_jobs: RuntimeJobSummary[];
};

export type AutomationPolicy = {
  mode: 'auto' | 'suggest';
  associationThreshold: number;
  updateThreshold: number;
  policyVersion: string;
  updatedAt: string | null;
};

export type Notification = {
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

export type FeishuMonitorTarget = {
  id: string;
  kind: 'person' | 'group';
  name: string;
  secondaryLabel: string | null;
  selected: boolean;
  readPolicy: 'incoming_only' | 'owner_mentions';
  accessStatus: 'unknown' | 'readable' | 'restricted' | 'not_found' | 'error';
  lastDiscoveredAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

export type FeishuMonitoringScope = {
  ownerAuthorized: boolean;
  people: FeishuMonitorTarget[];
  groups: FeishuMonitorTarget[];
  selectedPersonCount: number;
  selectedGroupCount: number;
  limits: { people: number; groups: number };
  updatedAt: string | null;
};
