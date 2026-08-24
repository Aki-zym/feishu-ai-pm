import { createHash } from 'node:crypto';

export type CindyBatchGroupAction = 'create_candidate' | 'update_task';
export type CindyPrimaryDisposition = 'group' | 'skip' | 'needs_owner';
export type CindyOwnerDecisionStatus = 'pending' | 'resolved' | 'superseded' | 'cancelled';
export type CindyOwnerDecisionOptionAction = 'skip' | 'create_candidate' | 'append_candidate';

export type CindyOwnerDecisionOptionInput = {
  option_key: string;
  action: CindyOwnerDecisionOptionAction;
  title?: string;
  describe?: string;
  next_step?: string;
  candidate_key?: string;
};

export type CindyBatchInput = {
  decision_request_id: string;
  batch_id: string;
  window_id: string;
  window_start: string;
  window_end: string;
  snapshot_receipts: string[];
  groups: Array<{
    group_key: string;
    action: CindyBatchGroupAction;
    anchor_receipt: string;
    field_evidence_receipts: string[];
    task_key?: string;
    expected_version?: number;
    title?: string;
    describe?: string;
    next_step?: string;
    reason?: string;
  }>;
  primary_dispositions: Array<{
    disposition_ref: string;
    source_receipt: string;
    disposition: CindyPrimaryDisposition;
    primary_group_key?: string;
    owner_decision_key?: string;
    reason?: string;
  }>;
  shared_context?: Array<{
    source_receipt: string;
    shared_group_key: string;
  }>;
  owner_decisions?: Array<{
    decision_key: string;
    reason: string;
    options: CindyOwnerDecisionOptionInput[];
  }>;
};

export type CindyOwnerDecisionDto = {
  decision_id: string;
  batch_id: string;
  status: CindyOwnerDecisionStatus;
  version: number;
  reason_summary: string;
  options: Array<{
    option_key: string;
    action: CindyOwnerDecisionOptionAction;
    title: string | null;
    describe: string | null;
    next_step: string | null;
    available: boolean;
  }>;
  source_count: number;
  last_error: string | null;
  resolution_action: 'skip' | 'create_candidate' | null;
  resolved_candidate_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export type CindyBatchResult = {
  decision_request_id: string;
  batch_id: string;
  window_id: string;
  duplicate: boolean;
  groups: Array<{
    group_key: string;
    action: CindyBatchGroupAction;
    source_status: 'processed';
    candidate_id?: string;
    task_key?: string;
    version?: number;
  }>;
  dispositions: Array<{
    disposition_ref: string;
    disposition: CindyPrimaryDisposition;
    source_status: 'processed' | 'skipped' | 'pending_decision';
    group_key?: string;
    owner_decision_id?: string;
  }>;
  owner_decisions: CindyOwnerDecisionDto[];
};

export type ResolveCindyOwnerDecisionInput = {
  decision_request_id: string;
  expected_version: number;
  action: 'skip' | 'create_candidate';
  option_key?: string;
};

export type CancelCindyOwnerDecisionInput = {
  decision_request_id: string;
  expected_version: number;
};

export const cindyBatchKeyPattern = /^[A-Za-z0-9_-]{1,128}$/u;
export const cindyGroupKeyPattern = /^[A-Za-z0-9_-]{1,64}$/u;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function canonicalCindyBatchInput(input: CindyBatchInput) {
  return canonicalize({
    ...input,
    snapshot_receipts: [...input.snapshot_receipts].sort(),
    groups: [...input.groups]
      .map((group) => ({ ...group, field_evidence_receipts: [...group.field_evidence_receipts].sort() }))
      .sort((left, right) => left.group_key.localeCompare(right.group_key)),
    primary_dispositions: [...input.primary_dispositions]
      .sort((left, right) => left.disposition_ref.localeCompare(right.disposition_ref)),
    shared_context: [...(input.shared_context ?? [])]
      .sort((left, right) => left.source_receipt.localeCompare(right.source_receipt)
        || left.shared_group_key.localeCompare(right.shared_group_key)),
    owner_decisions: [...(input.owner_decisions ?? [])]
      .map((decision) => ({
        ...decision,
        options: [...decision.options].sort((left, right) => left.option_key.localeCompare(right.option_key)),
      }))
      .sort((left, right) => left.decision_key.localeCompare(right.decision_key)),
  });
}

export function hashCindyBatchInput(input: CindyBatchInput) {
  return createHash('sha256').update(JSON.stringify(canonicalCindyBatchInput(input))).digest('hex');
}

export function hashCindyBatchSnapshot(entries: Array<{ revisionId: string; revisionHash: string }>) {
  const canonical = [...entries]
    .sort((left, right) => left.revisionId.localeCompare(right.revisionId))
    .map((entry) => `${entry.revisionId}\0${entry.revisionHash}\n`)
    .join('');
  return createHash('sha256').update(canonical).digest('hex');
}

export function hashCindyOwnerDecisionResolution(value: ResolveCindyOwnerDecisionInput | (CancelCindyOwnerDecisionInput & { action: 'cancel' })) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}
