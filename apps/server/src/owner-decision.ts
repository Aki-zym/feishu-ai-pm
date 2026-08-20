import type { OwnerIntentAction, OwnerIntentDecision, TaskStatus } from './domain.js';

/**
 * A deliberately small, pure decision layer for messages authored by the
 * system owner.  It does not write SQLite, send messages, or decide whether a
 * task version is still current.  The service must perform those operations in
 * its own transaction after checking the returned target snapshot.
 */

export type OwnerDecisionCandidateState = 'pending' | 'snoozed' | 'ignored' | 'accepted';

export type OwnerDecisionTarget = {
  candidateId: string | null;
  /** Candidate revision captured when the Runtime decision was created. */
  candidateVersion?: number | null;
  /** Full candidate-group revision captured for multi-candidate actions. */
  candidateGroupVersionHash?: string | null;
  candidateState: OwnerDecisionCandidateState | null;
  acceptedTaskId: string | null;
  threadId: string | null;
  taskId: string | null;
  taskStatus: TaskStatus | null;
  taskVersion: number | null;
  threadVersion: number | null;
  /** Strong server-side relation to the source message. */
  sourceMatched: boolean;
  /** A retired candidate must never receive a new owner action. */
  candidateDeleted?: boolean;
  /** A deleted/invalidated task must never receive an automatic patch. */
  taskDeleted?: boolean;
  taskInvalidated?: boolean;
};

export type OwnerScheduleEvidence = {
  sourceText: string;
  startAt: string | null;
  dueAt: string | null;
  /** `true` means the date is inferred or otherwise still needs confirmation. */
  needsConfirmation: boolean;
};

export type OwnerDecisionInput = {
  senderId: string;
  metadata: Record<string, unknown>;
  /** Server-resolved identifiers for the currently authorized system owner. */
  trustedOwnerIds: Iterable<string>;
  intent: OwnerIntentDecision | null;
  targets: OwnerDecisionTarget[];
  schedule?: OwnerScheduleEvidence | null;
};

/**
 * Automatic owner actions need a higher bar than ordinary model summaries.
 * Values below this threshold are retained as review records, never applied
 * to a candidate or task.
 */
export const OWNER_INTENT_AUTO_CONFIDENCE = 0.9;

export type OwnerDecisionDisposition =
  | 'apply_task_patch'
  | 'accept_candidate'
  | 'decline_candidate'
  | 'delegate_candidate'
  | 'review'
  | 'noop';

export type OwnerTaskPatch = {
  status?: TaskStatus;
  plannedStartAt?: string | null;
  plannedDueAt?: string | null;
  nextStep?: string;
  waitingReason?: string | null;
  note?: string;
};

export type OwnerDecisionResult = {
  eligible: boolean;
  action: OwnerIntentAction | 'none';
  disposition: OwnerDecisionDisposition;
  target: OwnerDecisionTarget | null;
  patch: OwnerTaskPatch;
  delegateTo: string | null;
  reason: string;
  confidence: number;
};

function emptyResult(reason: string, action: OwnerIntentAction | 'none' = 'none'): OwnerDecisionResult {
  return {
    eligible: false,
    action,
    disposition: 'review',
    target: null,
    patch: {},
    delegateTo: null,
    reason,
    confidence: 0,
  };
}

/**
 * The synchronizer and the classifier both mark owner-authored messages.  A
 * plain sender name is intentionally not accepted: names are mutable and can
 * be spoofed by a model or an imported fixture.
 */
export function isOwnerDecisionSource(metadata: Record<string, unknown>, senderId: string, trustedOwnerIds: Iterable<string>) {
  const normalizedSenderId = senderId.trim();
  const trusted = new Set([...trustedOwnerIds].map((value) => value.trim()).filter(Boolean));
  if (!normalizedSenderId || !trusted.has(normalizedSenderId)) return false;
  if (metadata.isOwnerMessage === true) return true;
  if (metadata.senderRole === 'owner') return true;
  return metadata.contextOnly === true
    && typeof metadata.matchedOwnerOpenId === 'string'
    && metadata.matchedOwnerOpenId === normalizedSenderId;
}

function hasUsableTarget(target: OwnerDecisionTarget) {
  return Boolean(target.sourceMatched && (target.threadId || target.taskId || target.candidateId));
}

/**
 * Pick a target only when the service has one unambiguous strong relation.  A
 * busy private chat may contain several demands; silently choosing the first
 * one would move the wrong task, so ties always go to owner review.
 */
export function selectOwnerDecisionTarget(targets: OwnerDecisionTarget[]) {
  const usable = targets.filter(hasUsableTarget);
  if (usable.length !== 1) {
    return {
      target: null,
      ambiguous: usable.length > 1,
      reason: usable.length > 1
        ? '主人消息同时匹配多个需求，暂不自动修改任何任务。'
        : '主人消息没有找到可验证的候选、需求线程或正式任务。',
    } as const;
  }
  return { target: usable[0]!, ambiguous: false, reason: '已找到唯一且有来源证据的需求目标。' } as const;
}

function activeTaskCanChange(target: OwnerDecisionTarget) {
  return Boolean(
    target.taskId
      && !target.taskDeleted
      && !target.taskInvalidated
      && target.taskStatus !== 'completed'
      && target.taskStatus !== 'archived',
  );
}

function candidateCanBeDisposed(target: OwnerDecisionTarget) {
  return Boolean(
    target.candidateId
      && target.candidateState
      && (target.candidateState === 'pending' || target.candidateState === 'snoozed')
      && !target.candidateDeleted
      && !target.acceptedTaskId,
  );
}

function ownerSummary(intent: OwnerIntentDecision) {
  return intent.summary.trim().slice(0, 1_000);
}

/**
 * Convert one normalized owner intent into a safe internal action.  This is a
 * policy function, not an executor: callers must still use task/candidate
 * version checks and persist an audit record atomically.
 */
export function decideOwnerIntent(input: OwnerDecisionInput): OwnerDecisionResult {
  const intent = input.intent;
  if (!intent) return emptyResult('来源没有主人意图。');
  if (!isOwnerDecisionSource(input.metadata, input.senderId, input.trustedOwnerIds)) {
    return emptyResult('来源未被服务端确认是系统主人发送，忽略主人意图字段。', intent.action);
  }

  const selected = selectOwnerDecisionTarget(input.targets);
  if (!selected.target) return { ...emptyResult(selected.reason, intent.action), confidence: intent.confidence };
  const target = selected.target;
  const confidence = intent.confidence;
  if (!Number.isFinite(confidence) || confidence < OWNER_INTENT_AUTO_CONFIDENCE) {
    return {
      eligible: false,
      action: intent.action,
      disposition: 'review',
      target,
      patch: {},
      delegateTo: null,
      reason: `主人意图置信度为 ${(Number.isFinite(confidence) ? confidence : 0).toFixed(2)}，低于自动执行门槛 ${OWNER_INTENT_AUTO_CONFIDENCE.toFixed(2)}，保留待确认。`,
      confidence: Number.isFinite(confidence) ? confidence : 0,
    };
  }
  const summary = ownerSummary(intent);

  if (intent.action === 'uncertain') {
    return {
      eligible: false,
      action: intent.action,
      disposition: 'review',
      target,
      patch: {},
      delegateTo: null,
      reason: intent.reason || '主人表达含义不够明确，保留待确认。',
      confidence,
    };
  }

  if (intent.action === 'decline') {
    if (!candidateCanBeDisposed(target)) {
      return {
        eligible: false,
        action: intent.action,
        disposition: 'review',
        target,
        patch: {},
        delegateTo: null,
        reason: '正式任务或已接受候选不能被主人一句话静默删除；需要明确的归档/作废流程。',
        confidence,
      };
    }
    return {
      eligible: true,
      action: intent.action,
      disposition: 'decline_candidate',
      target,
      patch: {},
      delegateTo: null,
      reason: summary || '主人明确表示不由自己负责，候选移出活动收件箱并保留审计。',
      confidence,
    };
  }

  if (intent.action === 'delegate') {
    if (!intent.delegateTo?.trim()) {
      return { ...emptyResult('转交对象没有被来源证据支持，保留待确认。', intent.action), target, confidence };
    }
    if (!candidateCanBeDisposed(target)) {
      return {
        eligible: false,
        action: intent.action,
        disposition: 'review',
        target,
        patch: {},
        delegateTo: intent.delegateTo,
        reason: '正式任务或已接受候选不能被自动转交；保留任务并等待主人确认。',
        confidence,
      };
    }
    return {
      eligible: true,
      action: intent.action,
      disposition: 'delegate_candidate',
      target,
      patch: {},
      delegateTo: intent.delegateTo,
      reason: summary || `主人明确将这条候选转交给${intent.delegateTo}，仅记录内部处置，不自动发消息。`,
      confidence,
    };
  }

  // A pending candidate can be accepted directly when the owner explicitly
  // confirms a concrete delivery time.  This covers the common one-turn form
  // “我来做，周五给你” (the model may return only `confirm_schedule`, or pair
  // it with `continue`).  The service executor will create the task and write
  // the status and schedule in one transaction/event.
  if (intent.action === 'confirm_schedule' && candidateCanBeDisposed(target) && !target.taskId) {
    const schedule = input.schedule;
    if (!schedule || schedule.needsConfirmation || (!schedule.startAt && !schedule.dueAt)) {
      return {
        eligible: false,
        action: intent.action,
        disposition: 'review',
        target,
        patch: {},
        delegateTo: null,
        reason: '主人提到时间，但日期仍是推测或没有解析出可写入的时间范围。',
        confidence,
      };
    }
    return {
      eligible: true,
      action: intent.action,
      disposition: 'accept_candidate',
      target,
      patch: {
        status: 'in_progress',
        plannedStartAt: schedule.startAt,
        plannedDueAt: schedule.dueAt,
        note: summary || `主人承接并确认了私人计划时间：${schedule.sourceText}`,
      },
      delegateTo: null,
      reason: '主人明确承接候选并确认了私人计划时间；自动建立进行中的私人任务。',
      confidence,
    };
  }

  // A pending candidate can be accepted directly from the owner's explicit
  // “我来做/我来跟进” message.  This is intentionally separate from a task
  // patch because acceptance creates the private task and changes the
  // candidate state in one idempotent service action.
  if (intent.action === 'continue' && candidateCanBeDisposed(target) && !target.taskId) {
    return {
      eligible: true,
      action: intent.action,
      disposition: 'accept_candidate',
      target,
      patch: {},
      delegateTo: null,
      reason: summary || '主人明确承接这条候选需求，自动建立私人任务并开始推进。',
      confidence,
    };
  }

  if (!activeTaskCanChange(target)) {
    return {
      eligible: false,
      action: intent.action,
      disposition: 'review',
      target,
      patch: {},
      delegateTo: null,
      reason: '目标没有可安全修改的活动正式任务，保留主人判断等待确认。',
      confidence,
    };
  }

  if (intent.action === 'confirm_schedule') {
    const schedule = input.schedule;
    if (!schedule || schedule.needsConfirmation || (!schedule.startAt && !schedule.dueAt)) {
      return {
        eligible: false,
        action: intent.action,
        disposition: 'review',
        target,
        patch: {},
        delegateTo: null,
        reason: '主人提到时间，但日期仍是推测或没有解析出可写入的时间范围。',
        confidence,
      };
    }
    const patch: OwnerTaskPatch = {
      plannedStartAt: schedule.startAt,
      plannedDueAt: schedule.dueAt,
      note: summary || `主人确认了私人计划时间：${schedule.sourceText}`,
    };
    if (target.taskStatus === 'unplanned') patch.status = 'planned';
    return {
      eligible: true,
      action: intent.action,
      disposition: 'apply_task_patch',
      target,
      patch,
      delegateTo: null,
      reason: '主人明确确认了私人计划时间；仅更新本地任务计划，不向外部发送承诺。',
      confidence,
    };
  }

  if (intent.action === 'request_context') {
    const patch: OwnerTaskPatch = {
      status: 'waiting',
      waitingReason: summary || '等待需求方补充必要资料。',
      nextStep: '等待需求方补充必要资料。',
      note: summary || '主人已向需求方索要补充资料。',
    };
    return {
      eligible: true,
      action: intent.action,
      disposition: 'apply_task_patch',
      target,
      patch,
      delegateTo: null,
      reason: '主人明确索要需求资料；任务进入等待资料状态，不自动向外回复。',
      confidence,
    };
  }

  // `continue` is the least destructive owner action.  It can resume a task
  // from waiting/review/unplanned/planned, but never revives a terminal task.
  const patch: OwnerTaskPatch = {
    status: 'in_progress',
    waitingReason: null,
    note: summary || '主人明确表示继续由自己推进。',
  };
  return {
    eligible: true,
    action: intent.action,
    disposition: 'apply_task_patch',
    target,
    patch,
    delegateTo: null,
    reason: '主人明确承接或继续推进该需求；任务进入进行中状态。',
    confidence,
  };
}
