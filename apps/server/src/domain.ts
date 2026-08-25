export type CandidateState = 'pending' | 'snoozed' | 'ignored' | 'accepted';
export type TaskStatus =
  | 'unplanned'
  | 'planned'
  | 'in_progress'
  | 'waiting'
  | 'review'
  | 'completed'
  | 'archived';
export type TaskRecordState = 'active' | 'invalidated';
export type RiskLevel = 'low' | 'medium' | 'high';
export type RequirementThreadStatus = 'open' | 'needs_confirmation' | 'closed';
export type ThreadRevisionState = 'proposed' | 'accepted' | 'rejected' | 'stale';
export type TaskUpdateProposalState = 'awaiting_approval' | 'approved' | 'rejected' | 'stale';
export type MemoryProjectionState = 'pending' | 'ready' | 'error';

export type SourceType = 'bot_dm' | 'owner_dm' | 'group' | 'calendar' | 'meeting' | 'manual';
export type SourceCompleteness = 'complete' | 'partial' | 'limited';

export type SourceContextStatus = 'ready' | 'partial' | 'unauthorized' | 'unsupported' | 'not_found' | 'error';
export type SourceContextFreshness = 'fresh' | 'stale';
export type CandidateEvidenceBasis = 'fact' | 'document' | 'inferred' | 'unknown';
export type CandidateTimeStatus = 'explicit' | 'relative_resolved' | 'inferred' | 'unknown';
/** Calendar text is parsed by code; this is the model's semantic role for it. */
export type CandidateTimeSemantic = 'deadline' | 'start' | 'window' | 'reference' | 'unknown';
export type CandidateSourceRole = 'owner_delivery' | 'background' | 'constraint' | 'process_question' | 'unknown';

export type CalendarClassificationRoute = 'calendar_fact' | 'candidate_review' | 'owner_confirmation';
export type CalendarClassification = {
  route: CalendarClassificationRoute;
  sourceRetained: true;
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

/**
 * The semantic action of the current message relative to a demand thread.
 *
 * This is intentionally separate from `isDataRequest`: a short follow-up
 * such as “下周一可以吗？” is not a new data request, but it still updates
 * an existing demand.  Keeping the action explicit lets the pipeline migrate
 * away from treating every message as a candidate-creation decision while
 * retaining the legacy boolean for one compatibility release.
 */
export type MessageAction =
  | 'new_demand'
  | 'update_existing'
  | 'context_only'
  | 'owner_action'
  | 'decline_or_delegate'
  | 'uncertain';

export interface MessageActionDecision {
  action: MessageAction;
  confidence: number;
  evidence: string[];
  reason: string;
}

export interface CandidateOwnerAction {
  required: boolean;
  summary: string;
  role: 'analyze' | 'coordinate' | 'review' | 'follow_up' | 'unknown';
  basis: CandidateEvidenceBasis;
  confidence: number;
}

/**
 * Structured intent emitted when the system owner speaks in an observed
 * conversation.  This is deliberately separate from CandidateOwnerAction:
 * ownerAction describes work the owner may need to advance, while this type
 * describes what the owner's message means for the demand state machine.
 *
 * The service must still apply its own thread/task/version safety gates before
 * using any action.  The model output is a decision signal, not an authority
 * to delete data or perform external actions.
 */
export type OwnerIntentAction =
  | 'continue'
  | 'confirm_schedule'
  | 'request_context'
  | 'decline'
  | 'delegate'
  | 'uncertain';

export interface OwnerIntentDecision {
  action: OwnerIntentAction;
  confidence: number;
  summary: string;
  delegateTo: string | null;
  scheduleText: string | null;
  evidence: string[];
  reason: string;
}

export interface NarrativeFieldUpdate {
  value: string;
  mode: 'append' | 'replace';
  basis: CandidateEvidenceBasis;
  confidence: number;
}

export interface CandidateNarrativeUpdates {
  taskTitle?: NarrativeFieldUpdate | null;
  taskDescribe?: NarrativeFieldUpdate | null;
  threadTitle?: NarrativeFieldUpdate | null;
  threadBackground?: NarrativeFieldUpdate | null;
  threadValidationQuestion?: NarrativeFieldUpdate | null;
  threadDescribe?: NarrativeFieldUpdate | null;
}

export interface ModelThreadCandidate {
  candidateKey: string;
  threadId: string;
  taskId: string;
  threadVersion: number;
  taskVersion: number;
  autoEligible: boolean;
  threadTitle: string;
  threadDescribe: string;
  validationQuestion: string;
  taskTitle: string;
  taskDescribe: string;
  taskStatus: TaskStatus;
  recency: 'day' | 'week' | 'month' | 'older';
  signals: {
    sameConversation: boolean;
    participantOverlap: boolean;
    explicitReference: boolean;
  };
}

export interface ThreadAssociationDecision {
  targetThreadId: string | null;
  targetTaskId: string | null;
  confidence: number | null;
  scores: Array<{ threadId: string; taskId: string; confidence: number }>;
  reason: string;
  evidence: string[];
  candidateSetHash: string;
  candidateSetComplete: boolean;
}

export interface ModelPendingCandidate {
  candidateKey: string;
  candidateId: string;
  threadId: string;
  snapshotRevision: string;
  title: string;
  background: string;
  validationQuestion: string;
  describe: string;
  occurredAt: string;
  /** Latest source activity used by the deterministic continuation window. */
  lastActivityAt?: string;
  recency: 'day' | 'week' | 'month' | 'older';
  signals: {
    sameConversation: boolean;
    participantOverlap: boolean;
    explicitContinuation: boolean;
  };
}

export interface CandidateMergeClassificationContext {
  candidates: ModelPendingCandidate[];
  candidateSetHash: string;
  candidateSetComplete: boolean;
}

export interface CandidateMergeDecision {
  targetCandidateId: string | null;
  targetThreadId: string | null;
  sameRequirement: boolean;
  confidence: number | null;
  scores: Array<{ candidateId: string; threadId: string; confidence: number }>;
  primary: 'current' | 'target' | null;
  primaryConfidence: number | null;
  currentRole: CandidateSourceRole | null;
  targetRole: CandidateSourceRole | null;
  reason: string;
  evidence: string[];
  candidateSetHash: string;
  candidateSetComplete: boolean;
}

export interface ThreadClassificationContext {
  candidates: ModelThreadCandidate[];
  candidateSetHash: string;
  candidateSetComplete: boolean;
}

export interface SourceDocumentContext {
  sourceUrl: string;
  documentId: string;
  documentType: 'docx' | 'wiki' | 'sheet' | 'bitable' | 'doc' | 'file' | 'slides' | 'unknown';
  title: string | null;
  sourceVersion: string | null;
  contentExcerpt: string | null;
  contentHash: string | null;
  status: SourceContextStatus;
  freshness: SourceContextFreshness;
  completeness: SourceCompleteness;
  truncated: boolean;
  lastError: string | null;
  lastSuccessAt: string | null;
  checkedAt: string;
}

export interface CandidateTimeRange {
  status: CandidateTimeStatus;
  sourceText: string | null;
  startAt: string | null;
  endAt: string | null;
  timezone: 'Asia/Shanghai';
  needsConfirmation: boolean;
  /** Optional during the compatibility window for older adapters. */
  semantic?: CandidateTimeSemantic;
}

export interface CandidateAnalysis {
  timeRange: CandidateTimeRange;
  fieldBasis: {
    background: CandidateEvidenceBasis;
    validationQuestion: CandidateEvidenceBasis;
    describe: CandidateEvidenceBasis;
  };
  recognitionEvidence: string[];
  /** The concrete work the system owner is expected to advance; never an external commitment. */
  ownerAction?: CandidateOwnerAction | null;
  /** Structured meaning of a system-owner message; never an external action. */
  ownerIntent?: OwnerIntentDecision | null;
  /** Model suggestion only; it changes the private task only after the automatic safety gate or owner approval. */
  prioritySuggestion?: RiskLevel | null;
  /** Optional concise note grounded in the source; never treated as an owner statement. */
  note?: string | null;
  /** Deterministic PROD-07 calendar route and bounded evidence fields. */
  calendarClassification?: CalendarClassification | null;
  /** Private task status suggested by explicit source evidence. */
  statusSuggestion?: TaskStatus | null;
  /** Private next step suggested by explicit source evidence. */
  nextStepSuggestion?: string | null;
  /** Waiting reason suggested by explicit source evidence; null means no change. */
  waitingReasonSuggestion?: string | null;
  /** Confidence that the proposed field changes are grounded and safe to apply. */
  updateConfidence?: number | null;
  /** Sparse, field-level updates for an already confirmed task/thread. */
  narrativeUpdates?: CandidateNarrativeUpdates;
  /** Server-validated, privacy-bounded association output for owner review. */
  threadAssociation?: ThreadAssociationDecision | null;
  /** Server-validated relationship to another unaccepted candidate. */
  candidateMerge?: CandidateMergeDecision | null;
  linkedDocuments: Array<Pick<SourceDocumentContext, 'sourceUrl' | 'documentId' | 'documentType' | 'title' | 'sourceVersion' | 'status' | 'freshness' | 'completeness' | 'truncated' | 'lastError' | 'lastSuccessAt'>>;
  sourceRevision: string | null;
  contextRevision: string | null;
}

export type OwnerIdentity = {
  openId: string;
  unionId: string | null;
  userId: string | null;
  name: string;
  tenantKey: string | null;
};

export type OwnerSourceKind = 'owner_dm' | 'owner_mentions' | 'calendar' | 'minutes' | 'bot_supplement';
export type OwnerSourceStatus = 'mock_ready' | 'ready' | 'unauthorized' | 'admin_required' | 'partial' | 'unsupported' | 'error';

export type FeishuMonitorTargetKind = 'person' | 'group';
export type FeishuMonitorReadPolicy = 'incoming_only' | 'owner_mentions';
export type FeishuMonitorAccessStatus = 'unknown' | 'readable' | 'restricted' | 'not_found' | 'error';

export interface FeishuMonitorTarget {
  id: string;
  kind: FeishuMonitorTargetKind;
  name: string;
  secondaryLabel: string | null;
  selected: boolean;
  readPolicy: FeishuMonitorReadPolicy;
  accessStatus: FeishuMonitorAccessStatus;
  lastDiscoveredAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface FeishuMonitoringScope {
  ownerAuthorized: boolean;
  people: FeishuMonitorTarget[];
  groups: FeishuMonitorTarget[];
  selectedPersonCount: number;
  selectedGroupCount: number;
  limits: { people: number; groups: number };
  updatedAt: string | null;
}

export interface NormalizedSourceEvent {
  externalId: string;
  sourceType: SourceType;
  conversationId: string;
  senderId: string;
  senderName: string;
  content: string;
  occurredAt: string;
  ownerMentioned?: boolean;
  sourceUrl?: string;
  completeness?: SourceCompleteness;
  discoveryReason?: string;
  metadata?: Record<string, unknown>;
  documentContexts?: SourceDocumentContext[];
  /** Ephemeral server-generated candidates. Never persisted as raw source metadata. */
  classificationContext?: ThreadClassificationContext;
  /** Ephemeral pending-candidate context. IDs are mapped to anonymous keys before model transport. */
  candidateMergeContext?: CandidateMergeClassificationContext;
  /** Ephemeral, bounded conversation background that must not become a candidate by itself. */
  conversationContext?: Array<{
    sourceKey: string;
    senderName: string;
    content: string;
    occurredAt: string;
    contextOnly: true;
  }>;
  /** Ephemeral batch members; anonymous keys only, never persisted or sent as IDs. */
  classificationSources?: Array<{
    sourceKey: string;
    senderName: string;
    content: string;
    occurredAt: string;
  }>;
}
export interface CandidateDraft {
  title: string;
  proposerName: string;
  background: string;
  validationQuestion: string;
  describe: string;
  confidence: number;
  analysis?: Omit<CandidateAnalysis, 'linkedDocuments' | 'sourceRevision' | 'contextRevision'>;
}

export interface TaskRecord {
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
  thread_id: string | null;
  auto_update_paused: boolean;
  created_at: string;
  updated_at: string;
}

export interface RequirementThreadRecord {
  id: string;
  status: RequirementThreadStatus;
  title: string;
  background: string;
  validation_question: string;
  describe: string;
  analysis_json: string;
  conversation_id: string | null;
  participant_ids_json: string;
  ambiguity_json: string;
  active_task_id: string | null;
  primary_source_event_id: string | null;
  primary_reason: string;
  primary_confidence: number | null;
  version: number;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskUpdateProposalRecord {
  id: string;
  task_id: string;
  thread_id: string | null;
  source_event_id: string | null;
  demand_unit_id: string | null;
  candidate_revision_id: string | null;
  thread_revision_id: string | null;
  base_thread_version: number | null;
  base_task_version: number;
  patch_json: string;
  reason: string;
  evidence_json: string;
  provider: string;
  model: string;
  prompt_version: string;
  state: TaskUpdateProposalState;
  origin: string;
  association_confidence: number | null;
  update_confidence: number | null;
  used_fallback: number;
  decision_mode: 'pending' | 'auto' | 'owner' | 'reverted';
  policy_version: string;
  policy_reason: string;
  applied_task_version: number | null;
  applied_thread_version: number | null;
  applied_task_event_id: string | null;
  before_snapshot_json: string;
  after_snapshot_json: string;
  reverted_at: string | null;
  reverted_task_event_id: string | null;
  idempotency_key: string;
  created_at: string;
  decided_at: string | null;
}

export interface MemoryProjectionRecord {
  id: string;
  task_id: string;
  projection_version: number;
  root_path: string;
  relative_path: string;
  state: MemoryProjectionState;
  checksum: string | null;
  managed_files_json: string;
  last_error: string | null;
  last_projected_at: string | null;
  created_at: string;
  updated_at: string;
}
