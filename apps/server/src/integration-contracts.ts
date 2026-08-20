import type { CandidateAnalysis, CandidateDraft, CandidateMergeDecision, MessageActionDecision, NormalizedSourceEvent, OwnerIdentity, OwnerIntentDecision, ThreadAssociationDecision } from './domain.js';
import type { CalendarClassification } from './calendar-classification.js';
import type { RetryFailureMetadata } from './retry-policy.js';
import type { OperationContext } from './observability.js';
export type { ProviderRetrySignal } from './retry-policy.js';

export type ClassificationUnitResult = {
  unitKey: string;
  sourceKeys: string[];
  isDataRequest: boolean;
  draft: CandidateDraft | null;
  reason: string;
};

export type IntegrationCheck = {
  ok: boolean;
  status: 'ready' | 'not_configured' | 'unauthorized' | 'unavailable' | 'mock';
  message: string;
  checkedAt: string;
  details?: Record<string, unknown>;
};

/** Provider acknowledgement is allowed only after this durable receipt exists. */
export type DurableEventReceipt = {
  externalId: string;
  sourceEventId: string;
  deduplicated: boolean;
  capturedAt: string;
};

/**
 * A scope response has three states.  `omitted` is intentionally different
 * from `set([])`: an omitted scope keeps the last verified local authorization
 * gates, while an explicit empty set clears them.
 */
export type FeishuScopeUpdate =
  | { kind: 'omitted' }
  | { kind: 'set'; scopes: string[] };

export type TokenVaultSnapshot = {
  generation: number;
  /** All rotating OAuth state captured under one vault lock. */
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  grantedScopes: string | null;
};

export type TokenVaultAtomicResult = {
  accepted: boolean;
  generation: number;
};

export type TokenVaultRefreshLease = {
  status: 'acquired' | 'busy' | 'completed' | 'failed';
  generation: number;
  snapshot: TokenVaultSnapshot;
  /** Durable phase used to distinguish safe claim takeover from an uncertain provider exchange. */
  phase?: 'claimed' | 'provider_started' | 'response_pending' | 'retryable_failed' | 'recovery_required' | 'completed';
  leaseId?: string;
  /** Durable owner identity and fencing token; never contains token material. */
  ownerId?: string;
  fencingToken?: number;
  /** SHA-256 fingerprint of the presented refresh token, or null. */
  tokenFingerprint?: string | null;
  resultExpiresAt?: string | null;
};

export type TokenVaultRefreshLeaseResult = {
  status: 'completed' | 'failed';
  generation: number;
  expiresAt?: string | null;
  phase?: 'retryable_failed' | 'recovery_required';
};

export type ClassificationResult = {
  /**
   * A business judgement is final only for valid/repaired/rule_final. A
   * provisional or recoverable result must stay in the Runtime retry path and
   * must not stamp the source classification revision as completed.
   */
  outcome?: 'valid' | 'repaired' | 'rule_final' | 'rule_provisional' | 'recoverable_error';
  /**
   * The core semantic action is usable, but an optional association stage
   * could not be safely completed.  Callers must defer association-dependent
   * writes and let Runtime retry; this is not a rule fallback.
   */
  deferred?: {
    kind: 'association';
    code: 'association_unavailable';
    /** False means an explicit non-retryable provider result closed the job. */
    retryable: boolean;
  };
  isDataRequest: boolean;
  draft: CandidateDraft | null;
  reason: string;
  relatedTaskHint: string | null;
  /**
   * Additive semantic contract for the thread-centric pipeline.  It is
   * optional during the v4 compatibility window; callers should fall back to
   * `isDataRequest`/thread association when a legacy adapter omits it.
   */
  messageAction?: MessageActionDecision | null;
  /** Facts extracted for an existing thread even when no new candidate draft is emitted. */
  semanticAnalysis?: Omit<CandidateAnalysis, 'linkedDocuments' | 'sourceRevision' | 'contextRevision'> | null;
  /** Structured interpretation of a system-owner message, if applicable. */
  ownerIntent?: OwnerIntentDecision | null;
  /** Ordered owner actions from one turn; later actions may refine the same private patch. */
  ownerIntents?: OwnerIntentDecision[];
  threadAssociation?: ThreadAssociationDecision | null;
  candidateMerge?: CandidateMergeDecision | null;
  /** Optional multi-demand decomposition. The legacy top-level fields remain for one-unit responses. */
  units?: ClassificationUnitResult[];
  importantDates: string[];
  deliverables: string[];
  commitments: string[];
  usedFallback: boolean;
  errorCode?: string;
  /** Safe transport metadata for diagnostics; never contains prompts or tokens. */
  metadata?: {
    httpStatus?: number;
    requestId?: string;
    attempts?: number;
    structuredMode?: 'json_schema' | 'json_object' | 'none';
    inputHash?: string;
    inputCharCount?: number;
    fallbackMode?: 'llm' | 'rule_fallback' | 'rule_mock';
    calendarClassification?: CalendarClassification;
    repairAttempts?: number;
    initialErrorCode?: string;
    validationIssues?: Array<{ path: string; code: string }>;
    /** Set by the authoritative SEC-02 post-adapter guard when a decision
     * contains invalid confidence or another write-relevant boundary value. */
    boundaryRejected?: boolean;
    retry?: RetryFailureMetadata;
  };
};

export type ClassificationOptions = {
  signal?: AbortSignal;
  operationContext?: OperationContext;
  /**
   * Runtime-owned fence for durable provider cooldown writes. A provider may
   * emit a retry signal while a job is being cancelled or its lease replaced;
   * the adapter must not let that stale callback advance shared cooldown.
   */
  retryCooldownGuard?: () => boolean;
};

export interface TokenVault {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Optional atomic replacement used for rotating OAuth refresh tokens. */
  setMany?(values: Record<string, string>): Promise<void>;
  /** Read all rotating OAuth state under one vault lock. */
  readSnapshot?(): Promise<TokenVaultSnapshot>;
  /**
   * Atomically apply a token update only when the generation is unchanged.
   * `null` deletes a key; an empty string is a real value and must be kept
   * (notably for an explicitly empty granted-scope response).
   */
  setManyAtomic?(
    values: Record<string, string | null>,
    expectedGeneration: number,
    refreshFence?: {
      identityKey: string;
      leaseId: string;
      fencingToken: number;
      tokenFingerprint: string | null;
      /** When present, completion is published under the same vault lock/journal. */
      resultExpiresAt?: string | null;
    },
  ): Promise<TokenVaultAtomicResult>;
  /** Acquire a durable, cross-process, per-identity refresh lease. */
  acquireRefreshLease?(identityKey: string, waitForResult?: boolean, reuseCurrentResult?: boolean): Promise<TokenVaultRefreshLease>;
  /** Extend a lease while the provider request is still in flight. */
  renewRefreshLease?(
    identityKey: string,
    leaseId: string,
    fencingToken?: number,
    phase?: 'claimed' | 'provider_started' | 'response_pending',
  ): Promise<boolean>;
  /** Publish a bounded, non-secret refresh result and release the lease. */
  releaseRefreshLease?(identityKey: string, leaseId: string, result: TokenVaultRefreshLeaseResult, fencingToken?: number): Promise<void>;
}

export interface FeishuAuthAdapter {
  readonly kind: 'disabled' | 'mock' | 'live';
  buildAuthorizationUrl(state?: string): Promise<string>;
  exchangeCode(code: string): Promise<{ expiresAt: string }>;
  refreshToken(refreshToken?: string): Promise<{ expiresAt: string }>;
  testConnection(): Promise<IntegrationCheck>;
  /** Local fail-closed revocation; provider-side revocation remains an L6 adapter contract. */
  revokeAuthorization?(): Promise<{ localTokensCleared: boolean; providerRevoked: boolean }>;
  /**
   * Opaque local snapshot used only to compensate a failed privacy transaction.
   * It is never returned through an HTTP DTO or written to logs/audit.
   */
  captureAuthorizationState?(): Promise<unknown>;
  restoreAuthorizationState?(snapshot: unknown): Promise<void>;
}

export interface FeishuEventAdapter {
  readonly kind: 'disabled' | 'mock' | 'live';
  start(handler?: (event: NormalizedSourceEvent) => Promise<DurableEventReceipt>): Promise<void>;
  stop(): Promise<void>;
}

export interface FeishuMessageAdapter {
  readonly kind: 'disabled' | 'mock' | 'live';
  listChats(): Promise<unknown[]>;
  /** Paginated data is returned as-is so the scanner can persist its cursor. */
  listMessages(input?: Record<string, unknown>): Promise<unknown>;
  searchMessages(input?: Record<string, unknown>): Promise<unknown>;
}

export interface FeishuOwnerInformationAdapter {
  readonly kind: 'disabled' | 'mock' | 'live';
  getCurrentUser(): Promise<OwnerIdentity>;
  /** Tri-state persisted provider scope result; omitted preserves local gates. */
  getGrantedScopeUpdate?(): Promise<FeishuScopeUpdate>;
  primaryCalendar(): Promise<unknown>;
  listCalendarEvents(input?: Record<string, unknown>): Promise<unknown>;
  /** Read one calendar event with optional attendee details using user OAuth. */
  getCalendarEvent(input: Record<string, unknown>): Promise<unknown>;
  searchMinutes(input?: Record<string, unknown>): Promise<unknown>;
  /** Read one meeting note's stable metadata with the owner's user OAuth. */
  getMinute(minuteToken: string): Promise<unknown>;
  /** Read bounded AI artifacts (summary/action items) when the tenant permits it. */
  getMinuteArtifacts(minuteToken: string): Promise<unknown>;
  getMinuteTranscript(minuteToken: string): Promise<unknown>;
  /** Read Docx metadata and text with the owner's user OAuth. */
  getDocxDocument(documentId: string): Promise<unknown>;
  getDocxRawContent(documentId: string): Promise<unknown>;
  /** Resolve a Wiki node before routing to the underlying document type. */
  getWikiNode(nodeToken: string): Promise<unknown>;
  /** Discover owner-visible P2P or group chats using the owner's user token. */
  listOwnerChats(input?: { types?: 'p2p' | 'group' | 'p2p,group'; pageToken?: string; pageSize?: number }): Promise<unknown>;
  /** Search people by name or restrict discovery to users the owner has chatted with. */
  searchOwnerUsers(input?: { query?: string; hasChatted?: boolean; pageToken?: string; pageSize?: number }): Promise<unknown>;
  /** Resolve stable user open_ids to the owner's existing P2P chat IDs. */
  resolveP2PChats(openIds: string[]): Promise<unknown>;
}

export interface FeishuIdentityAdapter {
  readonly kind: 'disabled' | 'mock' | 'live';
  normalizeSource(input: NormalizedSourceEvent): NormalizedSourceEvent;
}

export interface FeishuOutboxAdapter {
  readonly kind: 'disabled' | 'mock' | 'live';
  readonly sentCount: number;
  sendApproved(input?: Record<string, unknown>): Promise<{ externalId: string }>;
}

export type FeishuAdapter = FeishuAuthAdapter &
  FeishuEventAdapter &
  FeishuMessageAdapter &
  FeishuOwnerInformationAdapter &
  FeishuIdentityAdapter &
  FeishuOutboxAdapter;

export interface ClassifierAdapter {
  readonly kind: 'rule_mock' | 'live';
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  classify(event: NormalizedSourceEvent, guidance?: string, options?: ClassificationOptions): Promise<ClassificationResult>;
  testConnection(): Promise<IntegrationCheck>;
}

export type WorkspaceEntry = {
  relativePath: string;
  type: 'file' | 'directory';
  size: number | null;
  modifiedAt: string;
};

export interface WorkspaceReferenceAdapter {
  readonly kind: 'reference_only' | 'readonly_bridge';
  inspect(referencePath: string): Promise<{
    state: 'not_enabled' | 'ready' | 'unavailable';
    referencePath: string;
    entries: WorkspaceEntry[];
    truncated: boolean;
    inspectedAt: string;
    error?: string;
  }>;
}
