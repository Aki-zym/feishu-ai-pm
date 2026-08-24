import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Clock3, ExternalLink, FileText, GitBranch, Inbox, RefreshCw, RotateCcw, Sparkles, Split, Star, Trash2, X } from 'lucide-react';
import { api, ApiRequestError } from '../api';
import { AsyncState } from '../components/AsyncState';
import { candidateStateText, formatDate } from '../format';
import { beginResource, beginResourceMutation, beginResourceRequest, failureResource, isLatestResourceMutation, isLatestResourceRequest, loadingResource, mutationRefreshFailure, MUTATION_REFRESH_FAILURE_MESSAGE, successResource, type ResourceMutation, type ResourceState } from '../resource-state';
import { externalLinkFeedbackMessage, requestExternalLinkOpen } from '../external-links';
import type { Candidate, CandidateEvidenceBasis, CandidateMergeSource, CandidateSourceRole, CandidateState, CindyOwnerDecision, PendingOwnerAction, SourceFailure, Task } from '../types';

const filters: { value: CandidateState | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待确认' },
  { value: 'snoozed', label: '稍后再议' },
  { value: 'accepted', label: '已接受' },
  { value: 'ignored', label: '已忽略' },
];

type CandidateView = CandidateState | 'all' | 'trash';

const sourceTypeText: Record<string, string> = {
  owner_dm: '我的普通私聊',
  group: '群聊',
  calendar: '我的日历',
  meeting: '会议纪要',
  bot_dm: '机器人补充入口',
  manual: '人工补录',
};

const basisText: Record<CandidateEvidenceBasis, string> = {
  fact: '来源事实',
  document: '文档内容',
  inferred: '推测 · 待确认',
  unknown: '待复核',
};

const documentStatusText: Record<string, string> = {
  ready: '已读取',
  partial: '部分读取',
  unauthorized: '没有读取权限',
  unsupported: '当前类型暂未读取',
  not_found: '链接失效或已删除',
  error: '最近读取失败',
};

const prioritySuggestionText = { low: '低', medium: '中', high: '高' } as const;

const sourceRoleText: Record<CandidateSourceRole, string> = {
  owner_delivery: '你要推进的主体',
  background: '需求背景',
  constraint: '约束条件',
  process_question: '流程咨询',
  unknown: '作用待确认',
};

const processingStateText: Record<NonNullable<Candidate['processing_state']>, string> = {
  organizing: 'AI 整理中',
  retry_waiting: '等待自动重试',
  ready: 'AI 已完成整理',
  incomplete_context: '背景可能不完整',
  recovered: '已自动恢复',
  failed_visible: 'AI 整理失败',
};

const sourceFailureStatusText: Record<SourceFailure['status'], string> = {
  open: '等待主人重试',
  retrying: '正在恢复',
  resolved: '已恢复',
  ignored: '已归档',
  stale: '记录已陈旧',
};

const sourceFailureStageText: Record<SourceFailure['stage'], string> = {
  classification: 'AI 分类',
};

const ownerActionText: Record<PendingOwnerAction['action'], string> = {
  continue: '接受或继续推进',
  confirm_schedule: '确认时间',
  request_context: '索要资料',
  decline: '拒绝',
  delegate: '转交',
};

function formatCandidateTime(candidate: Candidate) {
  const range = candidate.analysis?.timeRange;
  if (!range || range.status === 'unknown' || (!range.startAt && !range.endAt)) return '未识别到时间';
  const format = (value: string) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '时间格式待确认';
    return new Intl.DateTimeFormat('zh-CN', {
    timeZone: range.timezone || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    }).format(parsed);
  };
  const start = range.startAt ? format(range.startAt) : '未给出开始时间';
  const end = range.endAt ? format(range.endAt) : '未给出结束时间';
  // The source phrase is retained in the audit record, but the candidate
  // inbox only needs the normalized range. Showing the phrase here would
  // expose the raw conversation and make the AI summary easy to miss.
  return `${start} — ${end}`;
}

function CandidateFact({ label, value, basis }: { label: string; value: string; basis: CandidateEvidenceBasis }) {
  const empty = !value.trim();
  return <div className={empty ? 'candidate-fact-empty' : undefined}>
    <dt>{label}</dt>
    <dd><span>{empty ? `未推断出${label === 'Describe' ? '任务描述' : label === '背景' ? '相关背景' : '希望验证的内容'}` : value}</span><em className={`evidence-basis evidence-${basis}`}>{empty ? '未推断出' : basisText[basis]}</em></dd>
  </div>;
}

function RecognitionFact({ candidate }: { candidate: Candidate }) {
  const evidence = candidate.analysis?.recognitionEvidence?.filter((item) => item.trim()) ?? [];
  const value = evidence.length ? evidence.join('；') : candidate.ai_reason?.trim() ?? '';
  const empty = !value;
  return <div className={empty ? 'candidate-fact-empty' : undefined}>
    <dt>为什么被识别</dt>
    <dd><span>{empty ? '未推断出可复核的识别依据' : value}</span><em className={`evidence-basis evidence-${empty ? 'unknown' : 'inferred'}`}>{empty ? '未推断出' : 'AI 整理 · 待确认'}</em></dd>
  </div>;
}

type CandidateMutationPayload = Record<string, unknown>;

function candidateFromMutation(value: unknown): Candidate | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<Candidate>;
  return typeof candidate.id === 'string' && typeof candidate.version === 'number'
    ? candidate as Candidate
    : null;
}

function mutationCandidates(value: unknown): Array<{ candidate: Candidate; mergeGroup?: Candidate['merge_group'] | null }> {
  const result: Array<{ candidate: Candidate; mergeGroup?: Candidate['merge_group'] | null }> = [];
  const add = (candidateValue: unknown, mergeGroup?: Candidate['merge_group'] | null) => {
    const candidate = candidateFromMutation(candidateValue);
    if (candidate) result.push({ candidate, mergeGroup });
  };
  add(value);
  if (!value || typeof value !== 'object') return result;
  const payload = value as CandidateMutationPayload;
  add(payload.candidate, payload.mergeGroup as Candidate['merge_group'] | null | undefined);
  add(payload.splitCandidate, payload.splitGroup as Candidate['merge_group'] | null | undefined);
  add(payload.remainingCandidate, payload.remainingGroup as Candidate['merge_group'] | null | undefined);
  add(payload.targetCandidate);
  return result;
}

function CandidateOwnerActions({ actions }: { actions: PendingOwnerAction[] }) {
  if (!actions.length) return null;
  return <details className="candidate-owner-actions">
    <summary><ChevronDown size={15} /><span>AI 判断（{actions.length}）</span><em>尚未执行</em></summary>
    <div className="candidate-owner-action-list">
      {actions.map((action) => <section className="candidate-owner-action" key={action.id}>
        <div><strong>{ownerActionText[action.action]}</strong><span>{action.state === 'failed' ? '执行失败' : '等待确认'}</span></div>
        <dl>
          <div><dt>置信度</dt><dd>{Math.round(action.confidence * 100)}%</dd></div>
          <div><dt>是否执行</dt><dd>未执行</dd></div>
          <div><dt>未执行原因</dt><dd>{action.message}</dd></div>
          <div><dt>时间</dt><dd>{action.scheduleDetected ? '已识别受控时间语义' : '未识别到明确时间'} · {formatDate(action.createdAt)}</dd></div>
        </dl>
      </section>)}
    </div>
  </details>;
}

function CandidateMergeSourceRow({
  source,
  busy,
  canEdit,
  onPrimary,
  onSplit,
}: {
  source: CandidateMergeSource;
  busy: boolean;
  canEdit: boolean;
  onPrimary: () => void;
  onSplit: () => void;
}) {
  const summary = source.title?.trim() || '未生成来源摘要，等待自动重试。';
  return <li className={source.isPrimary ? 'candidate-merge-source candidate-merge-source-primary' : 'candidate-merge-source'}>
    <div className="candidate-merge-source-heading">
      <div>
        <strong>{summary}</strong>
        <span>来源正文默认隐藏 · {formatDate(source.occurredAt)}</span>
      </div>
      <em className={`candidate-source-role role-${source.role}`}>{sourceRoleText[source.role]}</em>
    </div>
    <div className="candidate-merge-source-audit">
      <span>来源：{sourceTypeText[source.sourceType] ?? '授权来源'}</span>
      <span>关系：{sourceRoleText[source.role]}</span>
    </div>
    {canEdit && source.candidateId && <div className="candidate-merge-source-actions">
      {!source.isPrimary && <button className="quiet-button" type="button" disabled={busy} onClick={onPrimary}><Star size={14} />设为主体</button>}
      <button className="quiet-button" type="button" disabled={busy} onClick={onSplit}><Split size={14} />拆成独立候选</button>
    </div>}
  </li>;
}

export default function CandidatesPage() {
  type CandidatePayload = { items: Candidate[]; ownerActions?: PendingOwnerAction[]; ownerDecisions: CindyOwnerDecision[] };
  const [resource, setResource] = useState<ResourceState<CandidatePayload>>(loadingResource);
  const [sourceFailures, setSourceFailures] = useState<SourceFailure[]>([]);
  const [filter, setFilter] = useState<CandidateView>('pending');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [correctionId, setCorrectionId] = useState('');
  const [correctionType, setCorrectionType] = useState<'false_positive' | 'wrong_fields' | 'describe_incomplete'>('false_positive');
  const [replacementValue, setReplacementValue] = useState('');
  const [guidanceByCandidate, setGuidanceByCandidate] = useState<Record<string, string>>({});
  const [threadSelections, setThreadSelections] = useState<Record<string, string>>({});
  const [mergePrimarySelections, setMergePrimarySelections] = useState<Record<string, string>>({});
  const requestGenerationRef = useRef({ current: 0 });
  const mutationGenerationRef = useRef({ generations: new Map<string, number>() });
  const listAbortRef = useRef<AbortController | null>(null);
  const invalidateReads = useCallback(() => {
    requestGenerationRef.current.current += 1;
    listAbortRef.current?.abort();
  }, []);
  const beginMutation = (resourceId: string, operationId: string): ResourceMutation => beginResourceMutation(mutationGenerationRef.current, resourceId, operationId);
  const isCurrentMutation = (mutation: ResourceMutation) => isLatestResourceMutation(mutationGenerationRef.current, mutation);
  const load = useCallback((options: { silent?: boolean } = {}) => {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    const requestIdentity = beginResourceRequest(requestGenerationRef.current);
    setResource((current) => beginResource(current));
    const request = Promise.all([
      api.get<{ items: Candidate[]; ownerActions?: PendingOwnerAction[] }>('/api/candidates?deleted=all', controller.signal),
      api.get<{ items: SourceFailure[] }>('/api/source-failures?status=all', controller.signal),
      api.get<{ items: CindyOwnerDecision[] }>('/api/owner-decisions?status=pending&limit=50', controller.signal),
    ])
      .then(([data, failureData, ownerDecisionData]) => {
        if (!controller.signal.aborted && isLatestResourceRequest(requestGenerationRef.current, requestIdentity)) {
          setResource(successResource({ ...data, ownerDecisions: ownerDecisionData.items }, data.items.length === 0 && ownerDecisionData.items.length === 0));
          setSourceFailures(failureData.items);
        }
      });
    return request.then(() => true).catch((reason: unknown) => {
      if (!controller.signal.aborted && isLatestResourceRequest(requestGenerationRef.current, requestIdentity)) {
        setResource((current) => failureResource(current, reason instanceof Error ? reason.message : '候选收件箱读取失败。'));
        if (!options.silent) setError('候选收件箱读取失败，请查看上方状态并重试。');
      }
      return false;
    });
  }, []);

  useEffect(() => {
    void load();
    const refreshSilently = () => {
      if (document.visibilityState === 'visible') void load({ silent: true });
    };
    const interval = window.setInterval(refreshSilently, 15_000);
    window.addEventListener('focus', refreshSilently);
    document.addEventListener('visibilitychange', refreshSilently);
    return () => {
      listAbortRef.current?.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshSilently);
      document.removeEventListener('visibilitychange', refreshSilently);
    };
  }, [load]);
  const items = resource.data?.items ?? [];
  const pendingOwnerActions = resource.data?.ownerActions ?? [];
  const ownerDecisions = resource.data?.ownerDecisions ?? [];
  const visible = useMemo(() => filter === 'trash'
    ? items.filter((item) => Boolean(item.deleted_at))
    : items.filter((item) => !item.deleted_at && (filter === 'all' || item.state === filter)), [filter, items]);
  const ownerActionsByCandidate = useMemo(() => {
    const candidateIdsByTask = new Map<string, string>();
    const candidateIds = new Set<string>();
    for (const candidate of items) {
      candidateIds.add(candidate.id);
      if (candidate.accepted_task_id) candidateIdsByTask.set(candidate.accepted_task_id, candidate.id);
    }
    const grouped = new Map<string, PendingOwnerAction[]>();
    const unassigned: PendingOwnerAction[] = [];
    for (const action of pendingOwnerActions) {
      const candidateId = action.candidateId && candidateIds.has(action.candidateId)
        ? action.candidateId
        : action.taskId ? candidateIdsByTask.get(action.taskId) : undefined;
      if (!candidateId) {
        unassigned.push(action);
        continue;
      }
      grouped.set(candidateId, [...(grouped.get(candidateId) ?? []), action]);
    }
    return { grouped, unassigned };
  }, [items, pendingOwnerActions]);

  const resolveOwnerDecision = async (decision: CindyOwnerDecision, action: 'skip' | 'create_candidate', optionKey: string) => {
    const operation = `owner-decision-${decision.decision_id}`;
    setBusy(operation);
    setError('');
    try {
      await api.post(`/api/owner-decisions/${encodeURIComponent(decision.decision_id)}/resolve`, {
        decision_request_id: `owner-${crypto.randomUUID()}`,
        expected_version: decision.version,
        action,
        option_key: optionKey,
      });
      setMessage(action === 'create_candidate' ? '已按主人选择建立候选。' : '已按主人选择跳过这些来源。');
      await load({ silent: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '主人决定执行失败，请刷新后重试。');
    } finally {
      setBusy('');
    }
  };

  const cancelOwnerDecision = async (decision: CindyOwnerDecision) => {
    const operation = `owner-decision-${decision.decision_id}`;
    setBusy(operation);
    setError('');
    try {
      await api.post(`/api/owner-decisions/${encodeURIComponent(decision.decision_id)}/cancel`, {
        decision_request_id: `owner-cancel-${crypto.randomUUID()}`,
        expected_version: decision.version,
      });
      setMessage('已取消这次主人决定；来源会保留，之后可由 Cindy 重新判断。');
      await load({ silent: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '主人决定取消失败，请刷新后重试。');
    } finally {
      setBusy('');
    }
  };

  const activeSourceFailures = useMemo(
    () => sourceFailures.filter((item) => item.status === 'open' || item.status === 'retrying' || item.status === 'stale'),
    [sourceFailures],
  );
  const handledSourceFailures = useMemo(
    () => sourceFailures.filter((item) => item.status === 'resolved' || item.status === 'ignored'),
    [sourceFailures],
  );
  const hasSourceFailureHistory = activeSourceFailures.length > 0 || handledSourceFailures.length > 0;
  const controlsDisabled = Boolean(busy) || resource.status === 'stale';
  const applyCanonicalCandidates = useCallback((payload: unknown) => {
    const updates = mutationCandidates(payload);
    if (!updates.length) return;
    setResource((current) => {
      if (!current.data) return current;
      const byId = new Map(current.data.items.map((item) => [item.id, item]));
      for (const update of updates) {
        const existing = byId.get(update.candidate.id);
        byId.set(update.candidate.id, {
          ...(existing ?? {}),
          ...update.candidate,
          ...(update.mergeGroup === undefined ? {} : { merge_group: update.mergeGroup }),
        } as Candidate);
      }
      return { ...current, data: { ...current.data, items: [...byId.values()] }, error: null };
    });
  }, []);
  const refreshAfterMutation = useCallback(async (mutation: ResourceMutation, payload: unknown) => {
    if (!isLatestResourceMutation(mutationGenerationRef.current, mutation)) return;
    applyCanonicalCandidates(payload);
    const refreshed = await load({ silent: true });
    if (!isLatestResourceMutation(mutationGenerationRef.current, mutation)) return;
    if (!refreshed) {
      setResource((current) => mutationRefreshFailure(current));
      setError('');
      setMessage(MUTATION_REFRESH_FAILURE_MESSAGE);
    }
  }, [applyCanonicalCandidates, load]);
  const applyCandidateConflict = useCallback((reason: unknown) => {
    if (!(reason instanceof ApiRequestError) || reason.status !== 409 || !reason.body || typeof reason.body !== 'object') return false;
    const body = reason.body as { error_code?: string; current?: { id?: string; version?: number; state?: Candidate['state']; processing_state?: Candidate['processing_state']; deleted_at?: string | null; accepted_task_id?: string | null; updated_at?: string } | null };
    if (body.error_code !== 'CONFLICT' || !body.current?.id || typeof body.current.version !== 'number') return false;
    setResource((current) => current.data
      ? {
          ...current,
          data: {
            ...current.data,
            items: current.data.items.map((item) => item.id === body.current!.id ? { ...item, ...body.current } : item),
          },
        }
      : current);
    return true;
  }, []);
  const mutationError = useCallback((reason: unknown, fallback: string) => {
    applyCandidateConflict(reason);
    return reason instanceof Error ? reason.message : fallback;
  }, [applyCandidateConflict]);

  const retrySourceFailure = async (failure: SourceFailure) => {
    const mutation = beginMutation(failure.id, failure.id + ':retry');
    invalidateReads();
    setBusy(failure.id + ':retry');
    setMessage('');
    setError('');
    try {
      const result = await api.post<{ status?: string; message?: string }>(`/api/source-failures/${encodeURIComponent(failure.id)}/retry`, {});
      if (isCurrentMutation(mutation)) {
        setMessage(result.message || '已加入 AI 自动重试队列。');
        await load();
      }
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(reason instanceof Error ? reason.message : '失败来源重试失败。');
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const ignoreSourceFailure = async (failure: SourceFailure) => {
    if (!window.confirm('归档后不会再次出现在待处理失败来源中；来源和审计记录仍会保留。确定归档吗？')) return;
    const mutation = beginMutation(failure.id, failure.id + ':ignore');
    invalidateReads();
    setBusy(failure.id + ':ignore');
    setMessage('');
    setError('');
    try {
      const result = await api.post<{ message?: string }>(`/api/source-failures/${encodeURIComponent(failure.id)}/archive`, {});
      if (isCurrentMutation(mutation)) {
        setMessage(result.message || '失败来源已归档。');
        await load();
      }
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(reason instanceof Error ? reason.message : '失败来源归档失败。');
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const remove = async (candidate: Candidate) => {
    const grouped = (candidate.merge_group?.candidateCount ?? 0) > 1;
    const linkedTask = Boolean(candidate.accepted_task_id);
    if (!window.confirm(linkedTask
      ? '这条候选已经建立正式任务。继续后，候选和正式任务会同时移入回收站，并从日常列表、工作台和排期中隐藏；来源与审计仍会保留。确定继续吗？'
      : grouped
        ? `移入回收站后，已归并的 ${candidate.merge_group!.candidateCount} 条候选都会从普通收件箱隐藏，但来源和审计仍会保留。确定继续吗？`
        : '移入回收站后，这条候选不会出现在普通收件箱，但来源和审计仍会保留。确定继续吗？')) return;
    const mutation = beginMutation(candidate.id, candidate.id + ':delete');
    setBusy(candidate.id + ':delete');
    invalidateReads();
    setMessage('');
    setError('');
    try {
      const result = await api.delete(`/api/candidates/${candidate.id}`, { expectedVersion: candidate.version, expectedGroupVersionHash: candidate.merge_group?.groupVersionHash });
      if (isCurrentMutation(mutation)) {
        setMessage(linkedTask ? '候选和正式任务已同时移入回收站。' : grouped ? '整组候选已移入回收站。' : '候选已移入回收站。');
        await refreshAfterMutation(mutation, result);
      }
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(mutationError(reason, '删除候选失败。'));
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const restore = async (candidate: Candidate) => {
    const grouped = (candidate.merge_group?.candidateCount ?? 0) > 1;
    const linkedTask = Boolean(candidate.accepted_task_id);
    const mutation = beginMutation(candidate.id, candidate.id + ':restore');
    setBusy(candidate.id + ':restore');
    invalidateReads();
    setMessage('');
    setError('');
    try {
      const result = await api.post(`/api/candidates/${candidate.id}/restore`, { expectedVersion: candidate.version, expectedGroupVersionHash: candidate.merge_group?.groupVersionHash });
      if (isCurrentMutation(mutation)) {
        setMessage(linkedTask ? '候选和正式任务已同时恢复。' : grouped ? '整组候选已恢复到原来的状态。' : '候选已恢复到原来的状态。');
        await refreshAfterMutation(mutation, result);
      }
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(mutationError(reason, '恢复候选失败。'));
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const act = async (candidate: Candidate, action: 'accept' | 'snooze' | 'ignore') => {
    const grouped = (candidate.merge_group?.candidateCount ?? 0) > 1;
    const mutation = beginMutation(candidate.id, candidate.id + action);
    setBusy(candidate.id + action);
    invalidateReads();
    setMessage('');
    setError('');
    try {
      const result = await api.post<{ candidate: Candidate; task: Task | null }>('/api/candidates/' + candidate.id + '/action', {
        action,
        expectedVersion: candidate.version,
        expectedGroupVersionHash: candidate.merge_group?.groupVersionHash,
      });
      if (isCurrentMutation(mutation)) setMessage(action === 'accept'
        ? `${grouped ? '整组候选已建立为一个正式任务：' : '已建立正式任务：'}${result.task?.title}`
        : action === 'snooze'
          ? grouped ? '整组候选已放入稍后再议。' : '已放入稍后再议。'
          : grouped ? '已忽略整组候选。' : '已忽略这条候选。');
      if (isCurrentMutation(mutation)) await refreshAfterMutation(mutation, result);
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(mutationError(reason, '操作失败。'));
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const submitCorrection = async (candidate: Candidate) => {
    const mutation = beginMutation(candidate.id, candidate.id + ':correction');
    invalidateReads();
    setBusy(candidate.id + ':correction');
    setError('');
    try {
      const result = await api.post('/api/corrections', {
        correctionType,
        candidateId: candidate.id,
        expectedCandidateVersion: candidate.version,
        replacementValue: replacementValue.trim() || undefined,
        note: '来自候选收件箱的人工纠错。',
        idempotencyKey: `candidate-ui:${candidate.id}:${Date.now()}`,
      });
      if (isCurrentMutation(mutation)) {
        setMessage('纠错已记录，只影响本机任务记录。');
        setCorrectionId('');
        setReplacementValue('');
        await refreshAfterMutation(mutation, result);
      }
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(mutationError(reason, '纠错失败。'));
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const confirmThreadAssociation = async (candidate: Candidate) => {
    const selected = threadSelections[candidate.id];
    if (!selected) return;
    const mutation = beginMutation(candidate.id, candidate.id + ':thread');
    invalidateReads();
    setBusy(candidate.id + ':thread');
    setMessage('');
    setError('');
    try {
      const selectedOption = selected === '__new__'
        ? null
        : candidate.thread_association?.options.find((option) => option.id === selected) ?? null;
      const result = await api.post<{ task: Task | null; proposal: unknown | null }>('/api/candidates/' + candidate.id + '/thread-association', {
        targetThreadId: selected === '__new__' ? null : selected,
        expectedVersion: candidate.version,
        expectedThreadVersion: candidate.thread_association?.threadVersion,
        expectedTargetThreadVersion: selectedOption?.version,
      });
      if (isCurrentMutation(mutation)) setMessage(result.task
        ? `已归入任务“${result.task.title}”；字段变化仍在待确认更新中。`
        : '已确认这是新的独立需求，现在可以接受为正式任务。');
      if (isCurrentMutation(mutation)) setThreadSelections((current) => {
        const next = { ...current };
        delete next[candidate.id];
        return next;
      });
      if (isCurrentMutation(mutation)) await refreshAfterMutation(mutation, result);
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(mutationError(reason, '需求归属确认失败。'));
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const reprocess = async (candidate: Candidate) => {
    const mutation = beginMutation(candidate.id, candidate.id + ':reprocess');
    invalidateReads();
    setBusy(candidate.id + ':reprocess');
    setMessage('');
    setError('');
    try {
      const guidance = guidanceByCandidate[candidate.id]?.trim();
      const result = await api.post('/api/candidates/' + candidate.id + '/reprocess', { guidance: guidance || undefined, expectedVersion: candidate.version });
      if (isCurrentMutation(mutation)) setMessage('已重新整理当前候选，并保留新的 AI 判断记录。');
      if (isCurrentMutation(mutation)) setGuidanceByCandidate((current) => {
        const next = { ...current };
        delete next[candidate.id];
        return next;
      });
      if (isCurrentMutation(mutation)) await refreshAfterMutation(mutation, result);
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(mutationError(reason, '重新整理失败。'));
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const retrySourceClassification = async (candidate: Candidate) => {
    const mutation = beginMutation(candidate.id, candidate.id + ':source-retry');
    invalidateReads();
    setBusy(candidate.id + ':source-retry');
    setMessage('');
    setError('');
    try {
      const result = await api.post<{ status: string; message: string }>(
        `/api/candidates/${encodeURIComponent(candidate.id)}/source-retry`,
        { sourceScope: candidate.source_scope, expectedVersion: candidate.version },
      );
      if (isCurrentMutation(mutation)) {
        setMessage(result.message || '已加入 AI 自动重试队列。');
        await refreshAfterMutation(mutation, result);
      }
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(mutationError(reason, '来源分类重试失败。'));
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const confirmCandidateMerge = async (candidate: Candidate) => {
    const suggestion = candidate.merge_group?.suggestion;
    if (!suggestion?.targetCandidateId) return;
    const primaryCandidateId = mergePrimarySelections[candidate.id]
      || (suggestion.primary === 'target' ? suggestion.targetCandidateId : candidate.id);
    const mutation = beginMutation(candidate.id, candidate.id + ':merge-confirm');
    invalidateReads();
    setBusy(candidate.id + ':merge-confirm');
    setMessage('');
    setError('');
    try {
      const result = await api.post(`/api/candidates/${candidate.id}/merge/confirm`, {
        targetCandidateId: suggestion.targetCandidateId,
        primaryCandidateId,
        suggestionId: suggestion.suggestionId,
        expectedThreadVersion: candidate.merge_group?.threadVersion,
        expectedVersion: candidate.version,
        expectedTargetVersion: suggestion.target?.version,
        expectedGroupVersionHash: candidate.merge_group?.mutationVersionHash,
      });
      if (isCurrentMutation(mutation)) setMessage('已将两条消息归为同一需求，并保留你选择的主体任务。');
      if (isCurrentMutation(mutation)) setMergePrimarySelections((current) => {
        const next = { ...current };
        delete next[candidate.id];
        return next;
      });
      if (isCurrentMutation(mutation)) await refreshAfterMutation(mutation, result);
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(mutationError(reason, '确认归并失败。'));
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const rejectCandidateMerge = async (candidate: Candidate) => {
    const suggestion = candidate.merge_group?.suggestion;
    if (!suggestion?.targetCandidateId) return;
    const mutation = beginMutation(candidate.id, candidate.id + ':merge-reject');
    invalidateReads();
    setBusy(candidate.id + ':merge-reject');
    setMessage('');
    setError('');
    try {
      const result = await api.post(`/api/candidates/${candidate.id}/merge/reject`, {
        targetCandidateId: suggestion.targetCandidateId,
        suggestionId: suggestion.suggestionId,
        expectedVersion: candidate.version,
        expectedTargetVersion: suggestion.target?.version,
        expectedGroupVersionHash: candidate.merge_group?.mutationVersionHash,
      });
      if (isCurrentMutation(mutation)) {
        setMessage('已保留为两件独立需求，原始消息和判断记录仍然保留。');
        await refreshAfterMutation(mutation, result);
      }
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(mutationError(reason, '保留为独立需求失败。'));
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const setMergePrimary = async (candidate: Candidate, primaryCandidateId: string) => {
    const mutation = beginMutation(candidate.id, candidate.id + ':merge-primary');
    invalidateReads();
    setBusy(candidate.id + ':merge-primary');
    setMessage('');
    setError('');
    try {
      const result = await api.post(`/api/candidates/${candidate.id}/merge/primary`, {
        primaryCandidateId,
        expectedVersion: candidate.version,
        expectedThreadVersion: candidate.merge_group?.threadVersion,
        expectedGroupVersionHash: candidate.merge_group?.groupVersionHash,
      });
      if (isCurrentMutation(mutation)) {
        setMessage('已更换这项需求中你需要推进的主体任务。');
        await refreshAfterMutation(mutation, result);
      }
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(mutationError(reason, '更换主体失败。'));
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  const splitMergeSource = async (candidate: Candidate, source: CandidateMergeSource) => {
    if (!source.candidateId) return;
    if (!window.confirm(`确定把“${source.title || '这条消息'}”拆成独立候选吗？原始消息和审计都会保留。`)) return;
    const mutation = beginMutation(source.candidateId, source.candidateId + ':merge-split');
    invalidateReads();
    setBusy(candidate.id + ':merge-split');
    setMessage('');
    setError('');
    try {
      const result = await api.post(`/api/candidates/${source.candidateId}/merge/split`, {
        expectedVersion: source.version,
        expectedThreadVersion: candidate.merge_group?.threadVersion,
        expectedGroupVersionHash: candidate.merge_group?.groupVersionHash,
      });
      if (isCurrentMutation(mutation)) {
        setMessage('已拆成独立候选；两项需求可以分别处理。');
        await refreshAfterMutation(mutation, result);
      }
    } catch (reason) {
      if (isCurrentMutation(mutation)) setError(mutationError(reason, '拆分候选失败。'));
    } finally {
      if (isCurrentMutation(mutation)) setBusy('');
    }
  };

  return (
    <div className="page">
      <div className="page-header"><div><h1>候选收件箱</h1><p><Inbox size={16} />先判断是不是任务，再进入正式台账</p></div><div className="page-header-actions"><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void load()}><RefreshCw size={16} />刷新</button></div></div>
      <div className="filter-bar">
        {filters.map((item) => <button key={item.value} className={filter === item.value ? 'filter-active' : ''} onClick={() => setFilter(item.value)}>{item.label}</button>)}
        <button className={filter === 'trash' ? 'filter-active filter-trash' : 'filter-trash'} onClick={() => setFilter('trash')}><Trash2 size={14} />回收站</button>
      </div>
      {message && <div className="success-banner">{message}</div>}
      {error && <div className="error-banner">{error}</div>}
      {ownerDecisions.length > 0 && <section className="source-failure-inbox" aria-label="等待主人决定的来源">
        <div className="source-failure-heading"><div><strong>等待你决定（{ownerDecisions.length}）</strong><span>Cindy 无法安全确定处理方式。这里只展示安全摘要，不显示聊天正文或技术标识。</span></div></div>
        <div className="source-failure-list">
          {ownerDecisions.map((decision) => <article className="source-failure-card" key={decision.decision_id}>
            <div className="source-failure-card-main">
              <div className="source-failure-card-title"><strong>{decision.reason_summary}</strong><span>{decision.source_count} 条已保存来源</span><em>等待确认</em></div>
              {decision.last_error && <p>上次执行未完成：{decision.last_error}</p>}
              <div className="candidate-owner-action-list">
                {decision.options.map((option) => <section className="candidate-owner-action" key={option.option_key}>
                  <div><strong>{option.action === 'skip' ? '跳过' : option.action === 'create_candidate' ? option.title || '建立候选' : option.title || '追加到已有候选'}</strong><span>{option.available ? '可以执行' : '等待后续追加能力'}</span></div>
                  {option.describe && <p>{option.describe}</p>}
                  {option.next_step && <small>下一步：{option.next_step}</small>}
                  {option.available && option.action !== 'append_candidate' && <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void resolveOwnerDecision(decision, option.action === 'skip' ? 'skip' : 'create_candidate', option.option_key)}>
                    {option.action === 'skip' ? '确认跳过' : '建立候选'}
                  </button>}
                </section>)}
              </div>
            </div>
            <div className="source-failure-actions"><button className="quiet-button" type="button" disabled={Boolean(busy)} onClick={() => void cancelOwnerDecision(decision)}>暂不处理</button></div>
          </article>)}
        </div>
      </section>}
      {hasSourceFailureHistory && <section className="source-failure-inbox" aria-label="失败来源收件箱">
        <div className="source-failure-heading">
          <div><strong>失败来源收件箱（{activeSourceFailures.length}）</strong><span>来源已保存，但 AI 整理没有完成。这里不显示聊天正文，只提供脱敏诊断和主人确认后的本地重试。</span></div>
        </div>
        {activeSourceFailures.length > 0
          ? <div className="source-failure-list">
            {activeSourceFailures.map((failure) => <article className={`source-failure-card source-failure-${failure.status}`} key={failure.id}>
              <div className="source-failure-card-main">
                <div className="source-failure-card-title"><strong>{sourceTypeText[failure.source_type] ?? '授权来源'}</strong><span>{formatDate(failure.occurred_at)}</span><em>{sourceFailureStatusText[failure.status]}</em></div>
                <div className="source-failure-facts">
                  <span>阶段：{sourceFailureStageText[failure.stage]}</span>
                  <span>错误码：<code>{failure.error_code}</code></span>
                  <span>尝试：{failure.attempts}/{failure.max_attempts}</span>
                  {failure.job_status && <span>Runtime：{failure.job_status}</span>}
                </div>
                <p>{failure.stale ? '来源或其背景已经变化，这条失败记录不会覆盖新版本。' : failure.error_message}</p>
              </div>
              <div className="source-failure-actions">
                {failure.retryable && !failure.stale && <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void retrySourceFailure(failure)}><RotateCcw size={15} />重试</button>}
                {failure.status !== 'ignored' && failure.status !== 'resolved' && <button className="quiet-button" type="button" disabled={Boolean(busy)} onClick={() => void ignoreSourceFailure(failure)}>归档</button>}
              </div>
            </article>)}
          </div>
          : <p className="source-failure-empty">当前没有待处理失败来源。</p>}
        {handledSourceFailures.length > 0 && <details className="source-failure-history">
          <summary>查看已处理失败来源（{handledSourceFailures.length}）</summary>
          <ul>{handledSourceFailures.map((failure) => <li key={failure.id}><span>{sourceTypeText[failure.source_type] ?? '授权来源'} · {formatDate(failure.occurred_at)}</span><strong>{sourceFailureStatusText[failure.status]}</strong><code>{failure.error_code}</code></li>)}</ul>
        </details>}
      </section>}
      {ownerActionsByCandidate.unassigned.length > 0 && <section className="candidate-context-warning" aria-label="尚未关联需求的主人动作">
        <strong>有 {ownerActionsByCandidate.unassigned.length} 个 AI 判断尚未找到对应需求</strong>
        {ownerActionsByCandidate.unassigned.slice(0, 5).map((action) => <span key={action.id}>
          {ownerActionText[action.action]} · {action.message}（{formatDate(action.createdAt)}）
        </span>)}
      </section>}
      <AsyncState resource={resource} empty={visible.length === 0} emptyText="这里还没有候选需求。回到 Cindy 说「扫近10分钟」即可扫描已授权消息。" loadingText="正在读取候选收件箱…" errorTitle="候选收件箱读取失败" onRetry={() => void load()}>
      <div className="candidate-list">
        {visible.map((candidate) => (
          <article className="candidate-card" data-candidate-id={candidate.id} key={candidate.id}>
            <div className="candidate-card-main">
              <div className="candidate-card-header">
                <div><h2>{candidate.title}</h2><span>由 {candidate.proposer_name} 提出 · 识别信心 {Math.round(candidate.confidence * 100)}%</span></div>
                <span className={'status-text candidate-' + candidate.state}>{candidateStateText[candidate.state]}</span>
              </div>
              {candidate.merge_group && candidate.merge_group.candidateCount > 1 && <section className="candidate-merge-summary" aria-label="同一需求的已归并消息">
                <div className="candidate-merge-summary-heading">
                  <span className="candidate-merge-icon"><GitBranch size={16} /></span>
                  <div><strong>已合并 {candidate.merge_group.candidateCount} 条候选消息</strong><span>只显示一张主体卡；其他消息仍作为背景、约束或流程咨询保留。</span></div>
                  <em>{candidate.merge_group.primaryConfidence === null ? '主体已确定' : `主体信心 ${Math.round(candidate.merge_group.primaryConfidence * 100)}%`}</em>
                </div>
                <p><strong>为什么这是主体：</strong>{candidate.merge_group.primaryReason}</p>
                <details className="candidate-merge-details">
                  <summary><ChevronDown size={15} />查看 {candidate.merge_group.sourceCount} 条来源摘要并纠正</summary>
                  <p className="candidate-source-privacy-note">聊天正文保留在本地审计记录中，这里只展示 AI 摘要和归类依据。</p>
                  <ul>
                    {candidate.merge_group.sources.map((source) => <CandidateMergeSourceRow
                      key={source.sourceScope}
                      source={source}
                      busy={Boolean(busy)}
                      canEdit={!candidate.deleted_at && candidate.state !== 'accepted'}
                      onPrimary={() => void setMergePrimary(candidate, source.candidateId!)}
                      onSplit={() => void splitMergeSource(candidate, source)}
                    />)}
                  </ul>
                </details>
              </section>}
              {candidate.merge_group?.suggestion && <section className="candidate-merge-suggestion" aria-label="候选归并建议">
                <div className="candidate-merge-suggestion-heading"><Sparkles size={16} /><div><strong>AI 认为这可能是同一个需求</strong><span>信心 {Math.round((candidate.merge_group.suggestion.confidence ?? 0) * 100)}% · 未自动合并，请你确认。</span></div></div>
                <p>{candidate.merge_group.suggestion.reason || '两条消息的业务目标可能一致。'}</p>
                <div className="candidate-merge-primary-choice" role="radiogroup" aria-label="选择需要我推进的主体">
                  <span>哪一条是你需要推进的主体？</span>
                  <label><input type="radio" name={`merge-primary-${candidate.id}`} checked={(mergePrimarySelections[candidate.id] || (candidate.merge_group.suggestion.primary === 'target' ? candidate.merge_group.suggestion.targetCandidateId : candidate.id)) === candidate.id} onChange={() => setMergePrimarySelections((current) => ({ ...current, [candidate.id]: candidate.id }))} />当前消息：{candidate.title}</label>
                  <label><input type="radio" name={`merge-primary-${candidate.id}`} checked={(mergePrimarySelections[candidate.id] || (candidate.merge_group.suggestion.primary === 'target' ? candidate.merge_group.suggestion.targetCandidateId : candidate.id)) === candidate.merge_group.suggestion.targetCandidateId} onChange={() => setMergePrimarySelections((current) => ({ ...current, [candidate.id]: candidate.merge_group!.suggestion!.targetCandidateId }))} />已有候选：{candidate.merge_group.suggestion.target?.title || '已有候选'}</label>
                </div>
                <div className="candidate-merge-suggestion-actions">
                  <button className="secondary-button candidate-merge-confirm" type="button" disabled={Boolean(busy)} onClick={() => void confirmCandidateMerge(candidate)}><Check size={15} />确认归为同一需求</button>
                  <button className="quiet-button" type="button" disabled={Boolean(busy)} onClick={() => void rejectCandidateMerge(candidate)}><Split size={15} />保留为两件事</button>
                </div>
              </section>}
              <div className="candidate-source-context">
                <span>{sourceTypeText[candidate.source_type ?? ''] ?? '授权来源'}</span>
                {Boolean(candidate.owner_mentioned) && <strong>@了你</strong>}
                <span>{candidate.discovery_reason || '来源已保存，可回查原始记录。'}</span>
                <span>信息范围：{candidate.source_completeness === 'complete' ? '完整' : candidate.source_completeness === 'limited' ? '受限' : '部分'}</span>
              </div>
              <CandidateOwnerActions actions={ownerActionsByCandidate.grouped.get(candidate.id) ?? []} />
              {candidate.processing_state && candidate.processing_state !== 'ready' && <div className={`candidate-processing-state candidate-processing-${candidate.processing_state}`}>
                <div>
                  <strong>{processingStateText[candidate.processing_state]}</strong>
                  {candidate.processing_error && <span>{candidate.processing_error}</span>}
                  {candidate.context_state === 'possibly_incomplete' && <span>{candidate.context_reason || '对话背景可能不完整。'}</span>}
                </div>
                {(candidate.processing_state === 'failed_visible' || candidate.processing_state === 'retry_waiting') && <button
                  className="quiet-button"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void retrySourceClassification(candidate)}
                >重新尝试整理</button>}
              </div>}
              {candidate.context_state === 'possibly_incomplete' && candidate.processing_state === 'ready' && <div className="candidate-context-warning">
                <strong>对话背景可能不完整</strong><span>{candidate.context_reason || '系统未能取得这条消息之前的全部上下文。'}</span>
              </div>}
              {candidate.processing_state === 'recovered' && candidate.recovered_at && <div className="candidate-recovered-note">
                已自动恢复并更新当前候选（{formatDate(candidate.recovered_at)}）。
              </div>}
              <dl className="candidate-facts">
                <div><dt>时间范围</dt><dd><span>{formatCandidateTime(candidate)}</span><em className={`evidence-basis evidence-${candidate.analysis?.timeRange?.status === 'inferred' ? 'inferred' : candidate.analysis?.timeRange?.status === 'unknown' || !candidate.analysis?.timeRange ? 'unknown' : 'fact'}`}>{candidate.analysis?.timeRange?.status === 'inferred' ? '推测 · 待确认' : candidate.analysis?.timeRange?.status === 'unknown' || !candidate.analysis?.timeRange ? '未识别到' : '来源时间'}</em></dd></div>
                <CandidateFact label="背景" value={candidate.background ?? ''} basis={candidate.analysis?.fieldBasis?.background ?? 'unknown'} />
                <CandidateFact label="希望验证" value={candidate.validation_question ?? ''} basis={candidate.analysis?.fieldBasis?.validationQuestion ?? 'unknown'} />
                <CandidateFact label="Describe" value={candidate.describe ?? ''} basis={candidate.analysis?.fieldBasis?.describe ?? 'unknown'} />
                {candidate.analysis?.ownerAction?.required && <div><dt>我需要推进</dt><dd><span>{candidate.analysis.ownerAction.summary}</span><em className={`evidence-basis evidence-${candidate.analysis.ownerAction.basis}`}>主体判断 {Math.round(candidate.analysis.ownerAction.confidence * 100)}%</em></dd></div>}
                {candidate.analysis?.prioritySuggestion && <div><dt>优先级建议</dt><dd><span>{prioritySuggestionText[candidate.analysis.prioritySuggestion]}</span><em className="evidence-basis evidence-inferred">建议 · 待确认</em></dd></div>}
                {candidate.analysis?.note && <div><dt>补充备注</dt><dd><span>{candidate.analysis.note}</span><em className="evidence-basis evidence-inferred">来源整理 · 待确认</em></dd></div>}
                <RecognitionFact candidate={candidate} />
              </dl>
              {candidate.analysis?.linkedDocuments?.length ? <div className="candidate-documents">
                <div className="candidate-documents-heading"><FileText size={15} /><strong>关联的文档背景</strong><span>默认只显示受控状态；主人核验来源后才可查看更深层内容</span></div>
                {candidate.analysis.linkedDocuments.map((document, index) => <div className="candidate-document-link" key={`${document.documentType}-${index}`}>
                  <span><strong>{document.documentType.toUpperCase()} 文档</strong><small>{documentStatusText[document.status] ?? document.status}{document.freshness === 'stale' ? ' · 使用上次成功版本，可能已过期' : ''}</small></span>
                </div>)}
              </div> : null}
              {candidate.thread_association?.requiresConfirmation && <section className="candidate-thread-confirmation" aria-label="需求归属待确认">
                <div className="candidate-thread-heading"><GitBranch size={16} /><div><strong>发现多个可能需求，等待确认关联</strong><span>系统没有自动合并。请选择已有需求，或确认它是一项新需求。</span></div></div>
                <div className="candidate-thread-options" role="radiogroup" aria-label={`选择“${candidate.title}”的需求归属`}>
                  {candidate.thread_association.options.map((option) => <label key={option.id} className={threadSelections[candidate.id] === option.id ? 'candidate-thread-option selected' : 'candidate-thread-option'}>
                    <input type="radio" name={`thread-${candidate.id}`} value={option.id} checked={threadSelections[candidate.id] === option.id} onChange={() => setThreadSelections((current) => ({ ...current, [candidate.id]: option.id }))} />
                    <span><strong>{option.activeTaskTitle || option.title}</strong><small>{option.describe || '暂无 Describe'}{option.lastActivityAt ? ` · 最近 ${formatDate(option.lastActivityAt)}` : ''}</small></span>
                  </label>)}
                  <label className={threadSelections[candidate.id] === '__new__' ? 'candidate-thread-option selected' : 'candidate-thread-option'}>
                    <input type="radio" name={`thread-${candidate.id}`} value="__new__" checked={threadSelections[candidate.id] === '__new__'} onChange={() => setThreadSelections((current) => ({ ...current, [candidate.id]: '__new__' }))} />
                    <span><strong>作为新的独立需求</strong><small>保留当前候选，不与已有任务合并。</small></span>
                  </label>
                </div>
                <button className="secondary-button candidate-thread-confirm" type="button" disabled={controlsDisabled || !threadSelections[candidate.id]} onClick={() => void confirmThreadAssociation(candidate)}>确认需求归属</button>
              </section>}
              {candidate.snoozed_until && <div className="snooze-note"><Clock3 size={15} />{formatDate(candidate.snoozed_until)} 后重新提醒</div>}
            </div>
            {!candidate.deleted_at && (
              <div className="candidate-actions">
                {candidate.state !== 'accepted' && <>
                  <button className="primary-button" disabled={controlsDisabled || Boolean(candidate.thread_association?.requiresConfirmation) || Boolean(candidate.merge_group?.suggestion)} title={candidate.thread_association?.requiresConfirmation ? '请先确认需求归属' : candidate.merge_group?.suggestion ? '请先确认这两条是否属于同一需求' : undefined} onClick={() => act(candidate, 'accept')}><Check size={17} />{candidate.merge_group && candidate.merge_group.candidateCount > 1 ? '接受整组为正式任务' : '接受为正式任务'}</button>
                  <button className="secondary-button" disabled={controlsDisabled} onClick={() => act(candidate, 'snooze')}><Clock3 size={17} />{candidate.merge_group && candidate.merge_group.candidateCount > 1 ? '整组稍后再议' : '稍后再议'}</button>
                  <button className="quiet-button" disabled={controlsDisabled} onClick={() => act(candidate, 'ignore')}><X size={17} />{candidate.merge_group && candidate.merge_group.candidateCount > 1 ? '忽略整组' : '忽略'}</button>
                  <button className="quiet-button" disabled={controlsDisabled} onClick={() => { setCorrectionId(correctionId === candidate.id ? '' : candidate.id); setReplacementValue(''); }}><RotateCcw size={16} />纠正判断</button>
                </>}
                <button className="quiet-button candidate-delete-button" disabled={controlsDisabled} onClick={() => void remove(candidate)}><Trash2 size={16} />{candidate.merge_group && candidate.merge_group.candidateCount > 1 ? '整组移入回收站' : '移入回收站'}</button>
              </div>
            )}
            {candidate.deleted_at ? <div className="candidate-trash-state"><span>已于 {formatDate(candidate.deleted_at)} 移入回收站；{candidate.accepted_task_id ? '对应正式任务也已同步进入回收站，' : ''}来源和关联仍保留。</span><button className="secondary-button" disabled={controlsDisabled} onClick={() => void restore(candidate)}><RotateCcw size={16} />{candidate.accepted_task_id ? '恢复候选和任务' : '恢复候选'}</button></div> : correctionId === candidate.id && <div className="correction-box">
              <label><span>纠错类型</span><select disabled={controlsDisabled} value={correctionType} onChange={(event) => setCorrectionType(event.target.value as typeof correctionType)}><option value="false_positive">这不是需求</option><option value="wrong_fields">提出人或字段错误</option><option value="describe_incomplete">describe 不完整</option></select></label>
              {correctionType !== 'false_positive' && <label><span>{correctionType === 'wrong_fields' ? '正确的提出人' : '完整 describe'}</span><textarea disabled={controlsDisabled} value={replacementValue} onChange={(event) => setReplacementValue(event.target.value)} placeholder={correctionType === 'wrong_fields' ? '例如：旭阳' : '用一句话说明任务背景、判断问题和边界'} /></label>}
              <div className="correction-actions"><button className="secondary-button" disabled={controlsDisabled || (correctionType !== 'false_positive' && !replacementValue.trim())} onClick={() => void submitCorrection(candidate)}>记录纠错</button><button className="quiet-button" disabled={controlsDisabled} onClick={() => void reprocess(candidate)}><Sparkles size={14} />重新整理</button></div>
              <input
                className="correction-guidance"
                value={guidanceByCandidate[candidate.id] ?? ''}
                onChange={(event) => setGuidanceByCandidate((current) => ({ ...current, [candidate.id]: event.target.value }))}
                placeholder="可选：告诉模型这次应补充什么"
              />
            </div>}
            {!candidate.deleted_at && candidate.state === 'ignored' && <button className="quiet-button restore-button" disabled={controlsDisabled} onClick={() => act(candidate, 'snooze')}><RotateCcw size={16} />恢复到稍后再议</button>}
          </article>
        ))}
      </div>
      </AsyncState>
    </div>
  );
}
