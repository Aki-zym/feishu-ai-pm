import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, Bot, CalendarClock, Check, ChevronRight, CircleUserRound, ExternalLink, FileText, Flag, FolderOpen, FolderSync, GitBranch, Link2, PauseCircle, Pencil, PlayCircle, RotateCcw, Save, Trash2, Undo2, Unlink, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { desktopBridge } from '../desktop';
import { formatDate, formatFullDate, recordStateText, riskText, statusText } from '../format';
import type { SourceVerification, Task, TaskDetail, TaskStatus, TaskUpdateProposal } from '../types';

type Tab = 'sources' | 'updates' | 'timeline' | 'approvals' | 'references' | 'corrections';
type TaskCorrectionType = 'false_positive' | 'wrong_fields' | 'describe_incomplete' | 'wrong_association' | 'status_or_schedule_wrong';
type TaskRequestIdentity = { taskId: string; generation: number; task: TaskDetail };

const taskTabs: Tab[] = ['sources', 'updates', 'timeline', 'approvals', 'references', 'corrections'];

function requestedTaskTab(value: string | null): Tab {
  return taskTabs.includes(value as Tab) ? value as Tab : 'sources';
}

const proposalFieldLabels: Record<string, string> = {
  title: '任务标题',
  describe: 'Describe',
  status: '任务状态',
  plannedStartAt: '我的计划开始',
  plannedDueAt: '我的计划完成',
  nextStep: '下一步',
  risk: '风险',
  waitingReason: '等待原因',
  threadTitle: '需求标题',
  threadBackground: '需求背景',
  threadValidationQuestion: '希望验证',
  threadDescribe: '需求 Describe',
  note: '主人备注',
};

const proposalStateText: Record<TaskUpdateProposal['state'], string> = {
  awaiting_approval: '待我确认',
  approved: '已确认',
  rejected: '已拒绝',
  stale: '已失效',
};

const proposalDecisionText: Record<TaskUpdateProposal['decision_mode'], string> = {
  pending: '等待判断',
  auto: 'AI 已自动应用',
  owner: '我已确认',
  reverted: '已撤销',
};

const draftStateText: Record<TaskDetail['approvals'][number]['state'], string> = {
  draft: '待主人审阅',
  rejected: '已拒绝',
  obsolete: '已失效',
};

const runtimeStatusText: Record<string, string> = {
  queued: '等待重试',
  running: '处理中',
  waiting_approval: '等待确认',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function proposalValueText(key: string, value: unknown, emptyText = '清除') {
  if (value === undefined) return '未记录';
  if (value === null || value === '') return emptyText;
  if ((key === 'plannedStartAt' || key === 'plannedDueAt') && typeof value === 'string') return formatFullDate(value);
  if (key === 'risk' && typeof value === 'string') return riskText[value as keyof typeof riskText] ?? value;
  if (key === 'status' && typeof value === 'string') return statusText[value as TaskStatus] ?? value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function proposalEvidenceText(value: unknown) {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
    return items.slice(0, 4).join('；') || '暂无可展示的证据摘要';
  }
  if (!value || typeof value !== 'object') return '暂无可展示的证据摘要';
  const record = value as Record<string, unknown>;
  const items = [
    ...(Array.isArray(record.evidence) ? record.evidence : []),
    ...(Array.isArray(record.recognitionEvidence) ? record.recognitionEvidence : []),
  ].filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
  if (items.length) return items.slice(0, 4).join('；');
  const relation = typeof record.relationType === 'string' ? `关联方式：${record.relationType}` : '';
  const confidence = typeof record.confidence === 'number' ? `关联置信度：${Math.round(record.confidence * 100)}%` : '';
  return [relation, confidence].filter(Boolean).join('；') || '暂无可展示的证据摘要';
}

function isAutomaticTerminalUpdate(proposal: TaskUpdateProposal) {
  return proposal.decision_mode === 'auto'
    && proposal.state === 'approved'
    && proposal.changes.some((change) => change.field === 'status' && (change.after === 'completed' || change.after === 'archived'));
}

function toDateTimeLocal(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function announceTaskChange() {
  window.dispatchEvent(new CustomEvent('task-ledger-changed'));
}

export default function TaskDrawer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const taskId = searchParams.get('task');
  const [taskState, setTask] = useState<TaskDetail | null>(null);
  const task = taskState?.id === taskId ? taskState : null;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tab, setTab] = useState<Tab>('sources');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [referencePath, setReferencePath] = useState('');
  const [correctionType, setCorrectionType] = useState<TaskCorrectionType>('wrong_fields');
  const [correctionValue, setCorrectionValue] = useState('');
  const [correctionSourceId, setCorrectionSourceId] = useState('');
  const [targetTaskId, setTargetTaskId] = useState('');
  const [correctedStatus, setCorrectedStatus] = useState<TaskStatus>('unplanned');
  const [correctedSchedule, setCorrectedSchedule] = useState('');
  const [correctedNextStep, setCorrectedNextStep] = useState('');
  const [verifiedSources, setVerifiedSources] = useState<Record<string, { excerpt: string; capturedAt: string }>>({});
  const [plannedStart, setPlannedStart] = useState('');
  const [plannedDue, setPlannedDue] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescribe, setEditDescribe] = useState('');
  const [editNextStep, setEditNextStep] = useState('');
  const [editRisk, setEditRisk] = useState<Task['risk']>('medium');
  const [editWaitingReason, setEditWaitingReason] = useState('');
  const [editStatus, setEditStatus] = useState<TaskStatus>('unplanned');
  const [editPlannedStart, setEditPlannedStart] = useState('');
  const [editPlannedDue, setEditPlannedDue] = useState('');
  const routeTaskIdRef = useRef(taskId);
  const taskGenerationRef = useRef(0);
  routeTaskIdRef.current = taskId;
  const desktop = desktopBridge();
  const pendingProposalCount = task?.update_proposals.filter((proposal) => proposal.state === 'awaiting_approval').length ?? 0;
  const requestedTab = requestedTaskTab(searchParams.get('tab'));

  useEffect(() => {
    setTab(requestedTab);
  }, [taskId, requestedTab]);

  const syncTaskControls = (detail: TaskDetail) => {
    setCorrectedStatus(detail.status);
    setCorrectedSchedule(toDateTimeLocal(detail.planned_due_at));
    setCorrectedNextStep(detail.next_step);
    setPlannedStart(toDateTimeLocal(detail.planned_start_at));
    setPlannedDue(toDateTimeLocal(detail.planned_due_at));
    setEditTitle(detail.title);
    setEditDescribe(detail.describe);
    setEditNextStep(detail.next_step);
    setEditRisk(detail.risk);
    setEditWaitingReason(detail.waiting_reason ?? '');
    setEditStatus(detail.status);
    setEditPlannedStart(toDateTimeLocal(detail.planned_start_at));
    setEditPlannedDue(toDateTimeLocal(detail.planned_due_at));
  };

  const currentTaskIdentity = (): TaskRequestIdentity | null => {
    if (!taskId || !task || task.id !== taskId || routeTaskIdRef.current !== taskId) return null;
    return { taskId, generation: taskGenerationRef.current, task };
  };

  const identityIsCurrent = (identity: TaskRequestIdentity) => (
    routeTaskIdRef.current === identity.taskId
    && taskGenerationRef.current === identity.generation
  );

  const applyTaskDetail = (identity: TaskRequestIdentity, detail: TaskDetail) => {
    if (!identityIsCurrent(identity) || detail.id !== identity.taskId) return false;
    setTask(detail);
    return true;
  };

  const startTaskAction = (identity: TaskRequestIdentity) => {
    if (!identityIsCurrent(identity)) return false;
    setBusy(true);
    setError('');
    setSuccess('');
    return true;
  };

  const failTaskAction = (identity: TaskRequestIdentity, reason: unknown, fallback: string) => {
    if (identityIsCurrent(identity)) setError(reason instanceof Error ? reason.message : fallback);
  };

  const finishTaskAction = (identity: TaskRequestIdentity) => {
    if (identityIsCurrent(identity)) setBusy(false);
  };

  const toggleTaskEdit = () => {
    if (!task) return;
    if (!editOpen) {
      setEditTitle(task.title);
      setEditDescribe(task.describe);
      setEditNextStep(task.next_step);
      setEditRisk(task.risk);
      setEditWaitingReason(task.waiting_reason ?? '');
      setEditStatus(task.status);
      setEditPlannedStart(toDateTimeLocal(task.planned_start_at));
      setEditPlannedDue(toDateTimeLocal(task.planned_due_at));
    }
    setEditOpen((current) => !current);
    setError('');
    setSuccess('');
  };

  useEffect(() => {
    const generation = ++taskGenerationRef.current;
    setTask(null);
    setTasks([]);
    setBusy(false);
    setError('');
    setSuccess('');
    setReferencePath('');
    setCorrectionType('wrong_fields');
    setCorrectionValue('');
    setCorrectionSourceId('');
    setTargetTaskId('');
    setCorrectedStatus('unplanned');
    setCorrectedSchedule('');
    setCorrectedNextStep('');
    setPlannedStart('');
    setPlannedDue('');
    setEditOpen(false);
    setEditTitle('');
    setEditDescribe('');
    setEditNextStep('');
    setEditRisk('medium');
    setEditWaitingReason('');
    setEditStatus('unplanned');
    setEditPlannedStart('');
    setEditPlannedDue('');
    if (!taskId) {
      return;
    }
    Promise.all([
      api.get<TaskDetail>('/api/tasks/' + taskId),
      api.get<{ items: Task[] }>('/api/tasks'),
    ]).then(([detail, taskList]) => {
      if (routeTaskIdRef.current !== taskId || taskGenerationRef.current !== generation) return;
      if (detail.id !== taskId) {
        setError('任务详情身份不匹配，请重新打开。');
        return;
      }
      setTask(detail);
      setTasks(taskList.items);
      setCorrectionSourceId(detail.sources[0]?.source_scope ?? '');
      setTargetTaskId(taskList.items.find((item) => item.id !== detail.id)?.id ?? '');
      syncTaskControls(detail);
    }).catch((reason: Error) => {
      if (routeTaskIdRef.current === taskId && taskGenerationRef.current === generation) setError(reason.message);
    });
    return () => {
      if (taskGenerationRef.current === generation) taskGenerationRef.current += 1;
    };
  }, [taskId]);

  const refreshTask = async (identity: TaskRequestIdentity) => {
    const [detail, taskList] = await Promise.all([
      api.get<TaskDetail>('/api/tasks/' + identity.taskId),
      api.get<{ items: Task[] }>('/api/tasks'),
    ]);
    if (!identityIsCurrent(identity) || detail.id !== identity.taskId) return null;
    setTask(detail);
    setTasks(taskList.items);
    setCorrectionSourceId(detail.sources[0]?.source_scope ?? '');
    setTargetTaskId((current) => taskList.items.some((item) => item.id === current && item.id !== detail.id) ? current : taskList.items.find((item) => item.id !== detail.id)?.id ?? '');
    syncTaskControls(detail);
    return detail;
  };

  const close = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('task');
    next.delete('tab');
    setSearchParams(next);
  };

  const changeStatus = async (status: TaskStatus) => {
    const identity = currentTaskIdentity();
    if (!identity || !startTaskAction(identity)) return;
    try {
      const updated = await api.patch<TaskDetail>('/api/tasks/' + identity.task.id, { status, expectedVersion: identity.task.version });
      if (!applyTaskDetail(identity, updated)) return;
      announceTaskChange();
    } catch (reason) {
      failTaskAction(identity, reason, '更新失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const requestExternalAction = async () => {
    const identity = currentTaskIdentity();
    if (!identity || !startTaskAction(identity)) return;
    try {
      await api.post('/api/tasks/' + identity.task.id + '/external-actions', {
        actionType: 'draft_status_update',
        payload: { taskId: identity.task.id, note: '仅生成待确认草稿，不发送。' },
      });
      if (!identityIsCurrent(identity)) return;
      const updated = await api.get<TaskDetail>('/api/tasks/' + identity.task.id);
      if (!applyTaskDetail(identity, updated)) return;
      setTab('approvals');
    } catch (reason) {
      failTaskAction(identity, reason, '操作失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const rejectDraft = async (approvalId: string) => {
    const identity = currentTaskIdentity();
    if (!identity || !startTaskAction(identity)) return;
    try {
      const updated = await api.post<TaskDetail>('/api/approvals/' + approvalId + '/reject', {});
      if (!applyTaskDetail(identity, updated)) return;
      setTab('approvals');
    } catch (reason) {
      failTaskAction(identity, reason, '草稿废止失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const addReference = async () => {
    const identity = currentTaskIdentity();
    if (!identity || !referencePath.trim() || !startTaskAction(identity)) return;
    try {
      await api.post('/api/tasks/' + identity.task.id + '/references', {
        label: '工作目录',
        referencePath: referencePath.trim(),
      });
      if (!identityIsCurrent(identity)) return;
      setReferencePath('');
      const updated = await api.get<TaskDetail>('/api/tasks/' + identity.task.id);
      applyTaskDetail(identity, updated);
    } catch (reason) {
      failTaskAction(identity, reason, '添加失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const removeReference = async (referenceId: string) => {
    if (!currentTaskIdentity() || !window.confirm('只解除这项任务的本地引用绑定，不会读取、移动或删除真实目录。继续吗？')) return;
    const identity = currentTaskIdentity();
    if (!identity || !identity.task.references.some((reference) => reference.id === referenceId) || !startTaskAction(identity)) return;
    try {
      const updated = await api.delete<TaskDetail>(`/api/tasks/${identity.task.id}/references/${referenceId}`);
      if (!applyTaskDetail(identity, updated)) return;
      setSuccess('参考路径绑定已解除；真实工作目录没有变化。');
    } catch (reason) {
      failTaskAction(identity, reason, '参考路径解除失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const chooseReference = async () => {
    const identity = currentTaskIdentity();
    if (!identity || !desktop) return;
    const selected = await desktop.workspace.pickDirectory();
    if (selected && identityIsCurrent(identity)) setReferencePath(selected);
  };

  const submitCorrection = async () => {
    const identity = currentTaskIdentity();
    if (!identity || !startTaskAction(identity)) return;
    const currentTask = identity.task;
    try {
      const payload: Record<string, unknown> = {
        correctionType,
        taskId: currentTask.id,
        expectedTaskVersion: currentTask.version,
        idempotencyKey: `task-ui:${currentTask.id}:${Date.now()}`,
        note: '来自任务详情的人工纠错；仅修改私人 PM 记录。',
      };
      if (correctionType === 'wrong_fields' || correctionType === 'describe_incomplete') {
        if (!correctionValue.trim()) throw new Error(correctionType === 'wrong_fields' ? '请填写正确的提出人。' : '请填写完整 describe。');
        payload.replacementValue = correctionValue.trim();
      }
      if (correctionType === 'wrong_association') {
        if (!correctionSourceId || !targetTaskId) throw new Error('请选择具体来源和正确任务。');
        const selectedSource = currentTask.sources.find((source) => source.source_scope === correctionSourceId);
        if (!selectedSource) throw new Error('请选择原消息中的具体需求。');
        const target = tasks.find((item) => item.id === targetTaskId);
        if (!target) throw new Error('目标任务不存在，请刷新后重试。');
        payload.sourceScope = selectedSource.source_scope;
        payload.targetTaskId = targetTaskId;
        payload.expectedTargetTaskVersion = target.version;
      }
      if (correctionType === 'status_or_schedule_wrong') {
        const originalSchedule = toDateTimeLocal(currentTask.planned_due_at);
        if (correctedStatus !== currentTask.status) payload.replacementStatus = correctedStatus;
        if (correctedSchedule !== originalSchedule) payload.replacementScheduleAt = correctedSchedule ? new Date(correctedSchedule).toISOString() : null;
        if (correctedNextStep.trim() !== currentTask.next_step) payload.replacementValue = correctedNextStep.trim();
        if (payload.replacementStatus === undefined && payload.replacementScheduleAt === undefined && payload.replacementValue === undefined) {
          throw new Error('状态、排期和下一步都没有变化。');
        }
      }
      await api.post('/api/corrections', payload);
      const refreshed = await refreshTask(identity);
      if (!refreshed) return;
      setCorrectionValue('');
      setSuccess('纠错已写入私人时间线，不会产生任何对外动作。');
    } catch (reason) {
      failTaskAction(identity, reason, '纠错失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const verifySource = async (sourceScope: string) => {
    const identity = currentTaskIdentity();
    if (!identity || !window.confirm('仅核验这项来源的受控脱敏片段；不会发送消息或执行任何外部动作。继续吗？')) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.post<SourceVerification>(`/api/tasks/${identity.task.id}/sources/${encodeURIComponent(sourceScope)}/verify`, { confirmed: true });
      if (result.status === 'local_snapshot_verified' && result.content_excerpt) {
        setVerifiedSources((current) => ({
          ...current,
          [sourceScope]: { excerpt: result.content_excerpt!, capturedAt: result.snapshot_captured_at },
        }));
      }
      setSuccess(`${result.message} 不会产生对外动作。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '来源核验失败。');
    } finally {
      setBusy(false);
    }
  };

  const savePlan = async (clear = false) => {
    const identity = currentTaskIdentity();
    if (!identity) return;
    const currentTask = identity.task;
    const startAt = clear || !plannedStart ? null : new Date(plannedStart).toISOString();
    const dueAt = clear || !plannedDue ? null : new Date(plannedDue).toISOString();
    if (startAt && dueAt && new Date(startAt) > new Date(dueAt)) {
      setError('计划完成时间不能早于计划开始时间。');
      return;
    }
    if (!startTaskAction(identity)) return;
    try {
      const status = startAt || dueAt
        ? (currentTask.status === 'unplanned' ? 'planned' : currentTask.status)
        : (currentTask.status === 'planned' ? 'unplanned' : currentTask.status);
      const updated = await api.patch<TaskDetail>('/api/tasks/' + currentTask.id, {
        plannedStartAt: startAt,
        plannedDueAt: dueAt,
        status,
        expectedVersion: currentTask.version,
      });
      if (!applyTaskDetail(identity, updated)) return;
      setPlannedStart(toDateTimeLocal(updated.planned_start_at));
      setPlannedDue(toDateTimeLocal(updated.planned_due_at));
      setCorrectedStatus(updated.status);
      setCorrectedSchedule(toDateTimeLocal(updated.planned_due_at));
      setSuccess(clear ? '我的计划时间已清除；没有向需求方发送任何内容。' : '我的计划时间已保存；这只是私人安排，不代表对外承诺。');
      announceTaskChange();
    } catch (reason) {
      failTaskAction(identity, reason, '计划时间保存失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const saveTaskEdit = async () => {
    const identity = currentTaskIdentity();
    if (!identity) return;
    const currentTask = identity.task;
    if (!editTitle.trim() || !editDescribe.trim()) {
      setError('任务标题和 Describe 不能为空。');
      return;
    }
    const startAt = editPlannedStart ? new Date(editPlannedStart).toISOString() : null;
    const dueAt = editPlannedDue ? new Date(editPlannedDue).toISOString() : null;
    if (startAt && dueAt && new Date(startAt) > new Date(dueAt)) {
      setError('计划完成时间不能早于计划开始时间。');
      return;
    }
    if (!startTaskAction(identity)) return;
    try {
      const updated = await api.patch<TaskDetail>(`/api/tasks/${currentTask.id}`, {
        title: editTitle.trim(),
        describe: editDescribe.trim(),
        nextStep: editNextStep.trim(),
        risk: editRisk,
        waitingReason: editWaitingReason.trim() || null,
        status: editStatus,
        plannedStartAt: startAt,
        plannedDueAt: dueAt,
        expectedVersion: currentTask.version,
      });
      if (!applyTaskDetail(identity, updated)) return;
      syncTaskControls(updated);
      setEditOpen(false);
      setSuccess('任务已完整更新并刷新任务记忆；这只是私人 PM 内部修改。');
      announceTaskChange();
    } catch (reason) {
      failTaskAction(identity, reason, '任务保存失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const changeTaskAutomation = async () => {
    const identity = currentTaskIdentity();
    if (!identity || !startTaskAction(identity)) return;
    try {
      const updated = await api.patch<TaskDetail>(`/api/tasks/${identity.task.id}/automation`, {
        paused: !identity.task.auto_update_paused,
        expectedVersion: identity.task.version,
      });
      if (!applyTaskDetail(identity, updated)) return;
      syncTaskControls(updated);
      setSuccess(updated.auto_update_paused
        ? '这项任务已暂停 AI 自动维护；后续消息仍会保存并进入待确认。'
        : '这项任务已恢复 AI 自动维护。');
      announceTaskChange();
    } catch (reason) {
      failTaskAction(identity, reason, '自动维护设置更新失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const deleteTask = async () => {
    if (!currentTaskIdentity() || !window.confirm('删除后任务和对应的已接受候选会同时移到回收站，并从日常列表、工作台和排期中消失。来源、时间线和参考路径仍会保留，且不会通知需求方。继续吗？')) return;
    const identity = currentTaskIdentity();
    if (!identity || !startTaskAction(identity)) return;
    try {
      await api.delete('/api/tasks/' + identity.task.id, { expectedVersion: identity.task.version });
      if (!identityIsCurrent(identity)) return;
      announceTaskChange();
      close();
    } catch (reason) {
      failTaskAction(identity, reason, '删除任务失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const restoreTask = async () => {
    const identity = currentTaskIdentity();
    if (!identity || !startTaskAction(identity)) return;
    try {
      const restored = await api.post<TaskDetail>('/api/tasks/' + identity.task.id + '/restore', { expectedVersion: identity.task.version });
      if (!applyTaskDetail(identity, restored)) return;
      setSuccess('任务和对应的已接受候选已同时恢复；此前作废的对外草稿不会自动恢复。');
      announceTaskChange();
    } catch (reason) {
      failTaskAction(identity, reason, '恢复任务失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const decideProposal = async (proposalId: string, decision: 'approve' | 'reject') => {
    const identity = currentTaskIdentity();
    if (!identity || !identity.task.update_proposals.some((proposal) => proposal.id === proposalId) || !startTaskAction(identity)) return;
    try {
      await api.post(`/api/task-update-proposals/${proposalId}/${decision}`, {});
      const refreshed = await refreshTask(identity);
      if (!refreshed) return;
      setTab('updates');
      setSuccess(decision === 'approve'
        ? '后续更新已写入正式任务和需求线程，任务记忆也已刷新。'
        : '这条后续更新已拒绝；正式任务、需求线程和任务记忆保持原样。');
      announceTaskChange();
    } catch (reason) {
      failTaskAction(identity, reason, '更新提案处理失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const revertAutoUpdate = async (proposal: TaskUpdateProposal) => {
    if (!currentTaskIdentity() || !proposal.can_revert || !window.confirm('撤销后会恢复这次 AI 自动维护前的任务内容，并生成一个新的恢复版本。继续吗？')) return;
    const identity = currentTaskIdentity();
    if (!identity || !identity.task.update_proposals.some((item) => item.id === proposal.id) || !startTaskAction(identity)) return;
    try {
      const updated = await api.post<TaskDetail>(`/api/task-update-proposals/${proposal.id}/revert`, {});
      if (!applyTaskDetail(identity, updated)) return;
      syncTaskControls(updated);
      setSuccess('AI 自动维护已撤销；历史审计仍保留。');
      setTab('updates');
      announceTaskChange();
    } catch (reason) {
      failTaskAction(identity, reason, 'AI 自动维护撤销失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const retryMemoryProjection = async () => {
    const identity = currentTaskIdentity();
    if (!identity || !startTaskAction(identity)) return;
    try {
      await api.post(`/api/tasks/${identity.task.id}/memory/project`, {});
      const refreshed = await refreshTask(identity);
      if (!refreshed) return;
      setTab('updates');
      setSuccess(refreshed?.memory_projection?.state === 'ready'
        ? '任务记忆已重新生成。'
        : '任务记忆仍未生成，请查看下方错误说明。');
    } catch (reason) {
      failTaskAction(identity, reason, '任务记忆重试失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const rebuildMemoryProjection = async () => {
    if (!currentTaskIdentity() || !window.confirm('只清理系统上次登记的生成文件并重建；未知文件和用户附件会保留。继续吗？')) return;
    const identity = currentTaskIdentity();
    if (!identity || !startTaskAction(identity)) return;
    try {
      await api.post(`/api/tasks/${identity.task.id}/memory/rebuild`, {});
      const refreshed = await refreshTask(identity);
      if (!refreshed) return;
      setTab('updates');
      setSuccess(refreshed?.memory_projection?.state === 'ready'
        ? '系统托管的旧投影已清理，任务记忆已重建；未知文件保持不变。'
        : '任务记忆清理重建未完成，请查看错误说明。');
    } catch (reason) {
      failTaskAction(identity, reason, '任务记忆清理重建失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const openMemoryDirectory = async () => {
    const identity = currentTaskIdentity();
    if (!identity || !desktop?.taskMemory || !startTaskAction(identity)) return;
    try {
      await desktop.taskMemory.open(identity.task.id);
      if (!identityIsCurrent(identity)) return;
      setSuccess('已在 Windows 文件资源管理器中打开任务记忆目录。');
    } catch (reason) {
      failTaskAction(identity, reason, '无法打开任务记忆目录。');
    } finally {
      finishTaskAction(identity);
    }
  };

  const retryRuntimeJob = async (jobId: string) => {
    const identity = currentTaskIdentity();
    if (!identity || !identity.task.runtime_jobs.some((job) => job.id === jobId) || !startTaskAction(identity)) return;
    try {
      await api.post(`/api/runtime/jobs/${jobId}/retry`, {});
      const refreshed = await refreshTask(identity);
      if (!refreshed) return;
      setTab('updates');
      setSuccess('Runtime 工作项已重新加入安全重试队列。');
    } catch (reason) {
      failTaskAction(identity, reason, 'Runtime 工作项重试失败。');
    } finally {
      finishTaskAction(identity);
    }
  };

  if (!taskId) return null;

  return (
    <div className="drawer-layer">
      <button className="drawer-backdrop" aria-label="关闭任务详情" onClick={close} />
      <aside className="task-drawer" aria-label="任务详情">
        <div className="drawer-header">
          <div>
            <span className="drawer-kicker">任务详情</span>
            <h2>{task?.title ?? '正在读取…'}</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={close}><X size={20} /></button>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {success && <div className="success-banner">{success}</div>}
        {task && (
          <>
            {task.deleted_at && <div className="warning-banner">这项任务位于回收站。日常列表、工作台、排期和提醒已经停止显示；来源与审计仍保留。</div>}
            <section className="detail-summary">
              <div className="task-management-bar">
                <div className="task-automation-state">
                  <span><Bot size={17} /></span>
                  <div>
                    <strong>{task.auto_update_paused ? '这项任务已暂停 AI 自动维护' : 'AI 可安全维护这项任务'}</strong>
                    <small>{task.auto_update_paused ? '新消息仍会保存，但字段变化会等你确认。' : '只有强关联、高置信且版本一致的内部更新才会自动写入。'}</small>
                  </div>
                </div>
                <div className="task-management-actions">
                  <button className="quiet-button" type="button" disabled={busy || task.record_state === 'invalidated' || Boolean(task.deleted_at)} aria-expanded={editOpen} onClick={toggleTaskEdit}>
                    <Pencil size={14} />{editOpen ? '收起编辑' : '编辑任务'}
                  </button>
                  <button className="quiet-button" type="button" disabled={busy || task.record_state === 'invalidated' || Boolean(task.deleted_at)} onClick={() => void changeTaskAutomation()}>
                    {task.auto_update_paused ? <PlayCircle size={14} /> : <PauseCircle size={14} />}{task.auto_update_paused ? '恢复自动维护' : '暂停自动维护'}
                  </button>
                </div>
              </div>
              {editOpen && (
                <section className="task-edit-panel" aria-label="任务编辑">
                  <div className="task-edit-heading">
                    <div><strong>完整编辑任务</strong><small>保存后会生成新版本并刷新任务记忆，不会通知需求方。</small></div>
                    <span>当前 v{task.version}</span>
                  </div>
                  <div className="task-edit-grid">
                    <label className="task-edit-wide"><span>任务标题</span><input value={editTitle} disabled={busy} onChange={(event) => setEditTitle(event.target.value)} /></label>
                    <label className="task-edit-wide"><span>Describe</span><textarea value={editDescribe} disabled={busy} onChange={(event) => setEditDescribe(event.target.value)} /></label>
                    <label><span>状态</span><select value={editStatus} disabled={busy} onChange={(event) => setEditStatus(event.target.value as TaskStatus)}>{Object.entries(statusText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label><span>风险</span><select value={editRisk} disabled={busy} onChange={(event) => setEditRisk(event.target.value as Task['risk'])}>{Object.entries(riskText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label><span>计划开始</span><input type="datetime-local" value={editPlannedStart} disabled={busy} onChange={(event) => setEditPlannedStart(event.target.value)} /></label>
                    <label><span>计划完成</span><input type="datetime-local" value={editPlannedDue} disabled={busy} onChange={(event) => setEditPlannedDue(event.target.value)} /></label>
                    <label className="task-edit-wide"><span>下一步</span><textarea value={editNextStep} disabled={busy} onChange={(event) => setEditNextStep(event.target.value)} /></label>
                    <label className="task-edit-wide"><span>等待原因（可留空）</span><textarea value={editWaitingReason} disabled={busy} onChange={(event) => setEditWaitingReason(event.target.value)} /></label>
                  </div>
                  <div className="task-edit-actions">
                    <button className="primary-button" type="button" disabled={busy || !editTitle.trim() || !editDescribe.trim()} onClick={() => void saveTaskEdit()}><Save size={15} />保存全部修改</button>
                    <button className="quiet-button" type="button" disabled={busy} onClick={toggleTaskEdit}>取消</button>
                  </div>
                </section>
              )}
              <div className="detail-field detail-field-wide">
                <span><FileText size={16} />描述</span>
                <p>{task.describe}</p>
              </div>
              <div className="detail-grid">
                <div className="detail-field">
                  <span><CircleUserRound size={16} />谁向我提出</span>
                  <strong>{task.proposer_name}</strong>
                </div>
                <div className="detail-field">
                  <span><Flag size={16} />状态</span>
                  <select value={task.status} disabled={busy || editOpen || task.record_state === 'invalidated' || Boolean(task.deleted_at)} title={editOpen ? '完整编辑打开时，请在上方统一修改状态。' : undefined} onChange={(event) => changeStatus(event.target.value as TaskStatus)}>
                    {Object.entries(statusText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
                <div className="detail-field">
                  <span><RotateCcw size={16} />记录</span>
                  <strong className={task.record_state === 'invalidated' ? 'record-state-invalidated' : 'record-state-active'}>{recordStateText[task.record_state]}</strong>
                </div>
                <div className="detail-field">
                  <span><AlertTriangle size={16} />风险</span>
                  <strong className={'risk risk-' + task.risk}><i />{riskText[task.risk]}</strong>
                </div>
              </div>
              <div className="private-plan-editor">
                <div className="private-plan-heading">
                  <span><CalendarClock size={17} /></span>
                  <div><strong>我的计划时间</strong><small>只影响私人工作台、排期和本机提醒，不代表对外承诺。</small></div>
                </div>
                <div className="private-plan-fields">
                  <label><span>计划开始</span><input type="datetime-local" value={plannedStart} disabled={busy || editOpen || task.record_state === 'invalidated' || Boolean(task.deleted_at)} title={editOpen ? '完整编辑打开时，请在上方统一修改计划时间。' : undefined} onChange={(event) => setPlannedStart(event.target.value)} /></label>
                  <label><span>计划完成</span><input type="datetime-local" value={plannedDue} disabled={busy || editOpen || task.record_state === 'invalidated' || Boolean(task.deleted_at)} title={editOpen ? '完整编辑打开时，请在上方统一修改计划时间。' : undefined} onChange={(event) => setPlannedDue(event.target.value)} /></label>
                </div>
                <div className="private-plan-actions">
                  <button className="secondary-button" disabled={busy || editOpen || task.record_state === 'invalidated' || Boolean(task.deleted_at)} onClick={() => void savePlan(false)}>保存我的计划</button>
                  <button className="quiet-button" disabled={busy || editOpen || task.record_state === 'invalidated' || Boolean(task.deleted_at) || (!task.planned_start_at && !task.planned_due_at)} onClick={() => void savePlan(true)}>清除安排</button>
                </div>
              </div>
              <div className="detail-field detail-field-wide">
                <span><ChevronRight size={16} />下一步</span>
                <p>{task.next_step}</p>
              </div>
              {task.waiting_reason && <div className="waiting-note">等待原因：{task.waiting_reason}</div>}
              {pendingProposalCount > 0 && (
                <button className="update-attention" type="button" onClick={() => setTab('updates')}>
                  <GitBranch size={17} />
                  <span><strong>{pendingProposalCount} 条后续更新待你确认</strong><small>确认前不会改变正式任务，也不会向需求方发送内容。</small></span>
                  <ChevronRight size={16} />
                </button>
              )}
            </section>

            <div className="detail-tabs" role="tablist">
              {([
                ['sources', '来源记录'],
                ['updates', pendingProposalCount ? `持续更新 ${pendingProposalCount}` : '持续更新'],
                ['timeline', '时间线'],
                ['approvals', '对外草稿'],
                ['references', '参考路径'],
                ['corrections', '纠错'],
              ] as [Tab, string][]).map(([value, label]) => (
                <button key={value} className={tab === value ? 'tab-active' : ''} onClick={() => setTab(value)}>{label}</button>
              ))}
            </div>

            <div className="detail-tab-content">
              {tab === 'sources' && (
                task.sources.length ? task.sources.map((source) => {
                  const verifiedSource = verifiedSources[source.source_scope];
                  return <article className="source-message" key={source.source_scope}>
                    <div className="source-meta"><span className="avatar avatar-small">?</span><strong>来源记录（正文默认隐藏）</strong><time>{formatFullDate(source.occurred_at)}</time></div>
                    <div className="source-message-summary">
                      <span>最小来源信息</span>
                      <p>{source.summary_available ? '已关联 AI 摘要；来源正文不会随默认响应返回。' : '尚未生成可展示摘要。'}</p>
                      {verifiedSource && <small>本地快照片段（捕获于 {formatFullDate(verifiedSource.capturedAt)}）：{verifiedSource.excerpt}</small>}
                    </div>
                    <div className="source-message-audit"><span>来源：{source.source_type}</span><span>完整正文保留在本地审计记录中</span><button className="quiet-button" type="button" disabled={busy} onClick={() => void verifySource(source.source_scope)}>主人核验来源</button></div>
                  </article>;
                }) : <div className="empty-state">这项任务目前只有人工摘要，没有已关联原文。</div>
              )}
              {tab === 'updates' && (
                <div className="continuity-panel">
                  <section className="continuity-card thread-card" aria-label="需求线程">
                    <div className="continuity-heading">
                      <span><GitBranch size={17} /></span>
                      <div><strong>同一需求的持续对话</strong><small>后续飞书消息会先关联到需求线程；安全门禁通过时自动维护，否则等你确认。</small></div>
                      {task.thread && <em className={`thread-state thread-state-${task.thread.status}`}>{task.thread.status === 'needs_confirmation' ? '待确认' : task.thread.status === 'closed' ? '已关闭' : '进行中'}</em>}
                    </div>
                    {task.thread ? (
                      <div className="thread-fields">
                        <div><span>线程标题</span><p>{task.thread.title || '未推断出'}</p></div>
                        <div><span>背景</span><p>{task.thread.background || '未推断出相关背景'}</p></div>
                        <div><span>希望验证</span><p>{task.thread.validation_question || '未推断出需要验证的问题'}</p></div>
                        <div className="thread-meta"><span>线程版本 v{task.thread.version}</span><span>{task.thread.last_activity_at ? `最近消息 ${formatFullDate(task.thread.last_activity_at)}` : '最近消息时间未知'}</span></div>
                      </div>
                    ) : <div className="empty-state compact-empty">这项任务还没有需求线程；已有来源仍保留。</div>}
                  </section>

                  <section className="continuity-section" aria-label="AI 修改与待确认更新">
                    <div className="section-heading-row"><div><strong>AI 修改与待确认更新</strong><small>自动修改和人工确认都保留前后值、来源、模型、置信度与策略原因。</small></div><span>{pendingProposalCount} 条待确认</span></div>
                    {task.update_proposals.length ? task.update_proposals.map((proposal) => {
                      const terminalUpdate = isAutomaticTerminalUpdate(proposal);
                      const terminalStatus = proposal.changes.find((change) => change.field === 'status')?.after;
                      return (
                      <article className={`proposal-card proposal-${proposal.state} proposal-decision-${proposal.decision_mode}${terminalUpdate ? ' proposal-terminal-warning' : ''}`} key={proposal.id} data-proposal-id={proposal.id}>
                        <header>
                          <div><span className="proposal-state">{proposal.decision_mode === 'pending' ? proposalStateText[proposal.state] : proposalDecisionText[proposal.decision_mode]}</span><strong>{proposal.reason}</strong></div>
                          <time>{formatFullDate(proposal.created_at)}</time>
                        </header>
                        {terminalUpdate && (
                          <div className="proposal-terminal-banner" role="alert">
                            <AlertTriangle size={16} />
                            <div><strong>重点核对：AI 已把私人任务标为{terminalStatus === 'completed' ? '已完成' : '已归档'}</strong><span>请检查下面的来源证据；判断不正确时可立即撤销或编辑任务。</span></div>
                          </div>
                        )}
                        <div className="proposal-changes">
                          {proposal.changes.map((change) => (
                            <div className="proposal-change" key={change.field}>
                              <span>{proposalFieldLabels[change.field] ?? change.field}</span>
                              <div><del>{proposalValueText(change.field, change.before, '未设置')}</del><ChevronRight size={13} /><strong>{proposalValueText(change.field, change.after)}</strong></div>
                            </div>
                          ))}
                          {!proposal.changes.length && <div className="empty-state compact-empty">没有可应用字段；该提案会被安全判为失效。</div>}
                        </div>
                        <div className="proposal-evidence"><span>来源摘要</span><p>{proposalEvidenceText(proposal.evidence)}</p>{proposal.source && <small>{proposal.source.source_type} · {formatFullDate(proposal.source.occurred_at)}</small>}</div>
                        <div className="proposal-audit-grid">
                          <div><span>判断来源</span><strong>服务端受控判断</strong></div>
                          <div><span>置信度</span><strong>归属 {proposal.association_confidence === null ? '未提供' : `${Math.round(proposal.association_confidence * 100)}%`} · 字段 {proposal.update_confidence === null ? '未提供' : `${Math.round(proposal.update_confidence * 100)}%`}</strong></div>
                          <div className="proposal-audit-wide"><span>策略判断</span><strong>{proposal.policy_reason || '未记录策略原因'}{proposal.used_fallback ? ' · 模型已降级' : ''}</strong></div>
                        </div>
                        <footer>
                          <small>策略 {proposal.policy_version || '未记录'} · 基于任务 v{proposal.base_task_version}{proposal.applied_task_version ? ` · 应用为 v${proposal.applied_task_version}` : ''}</small>
                          {proposal.state === 'awaiting_approval' && (
                            <div className="proposal-actions">
                              <button className="quiet-button" type="button" disabled={busy} onClick={() => void decideProposal(proposal.id, 'reject')}><X size={14} />拒绝这条更新</button>
                              <button className="secondary-button" type="button" disabled={busy} onClick={() => void decideProposal(proposal.id, 'approve')}><Check size={14} />确认这条更新</button>
                            </div>
                          )}
                          {proposal.decision_mode === 'auto' && proposal.state === 'approved' && (
                            <div className="proposal-revert">
                              {proposal.can_revert
                                ? <button className="secondary-button" type="button" disabled={busy} onClick={() => void revertAutoUpdate(proposal)}><Undo2 size={14} />撤销这次自动修改</button>
                                : <small>{proposal.cannot_revert_reason ?? '当前不能撤销。'}</small>}
                            </div>
                          )}
                          {proposal.decision_mode === 'reverted' && <div className="proposal-revert"><small>这次修改已撤销，原审计仍保留。</small></div>}
                        </footer>
                      </article>
                    );
                    }) : <div className="empty-state compact-empty">暂时没有后续更新提案。</div>}
                  </section>

                  <section className="continuity-card memory-card" aria-label="任务记忆">
                    <div className="continuity-heading">
                      <span><FolderSync size={17} /></span>
                      <div><strong>任务记忆目录</strong><small>这是 SQLite 真账本的可重建投影，不会修改你的实际工作目录。</small></div>
                      <em className={`memory-state memory-state-${task.memory_projection?.state ?? 'missing'}`}>
                        {task.memory_projection?.state === 'ready' ? '已同步' : task.memory_projection?.state === 'pending' ? '等待中' : task.memory_projection?.state === 'error' ? '失败' : '未生成'}
                      </em>
                    </div>
                    {task.memory_projection ? (
                      <div className="memory-detail">
                        <code>{task.memory_projection.relative_path}</code>
                        <span>投影版本 v{task.memory_projection.projection_version} · {task.memory_projection.last_projected_at ? formatFullDate(task.memory_projection.last_projected_at) : '尚未成功生成'}</span>
                        {task.memory_projection.last_error && <p>{task.memory_projection.last_error}</p>}
                      </div>
                    ) : <p className="memory-missing">接受任务后应自动生成；如果此前失败，可在这里重新建立。</p>}
                    <div className="memory-actions">
                      {desktop?.taskMemory && task.memory_projection?.state === 'ready' && (
                        <button className="secondary-button" type="button" disabled={busy} onClick={() => void openMemoryDirectory()}>
                          <FolderOpen size={14} />打开任务记忆目录
                        </button>
                      )}
                      <button className="quiet-button memory-retry" type="button" disabled={busy || Boolean(task.deleted_at)} onClick={() => void retryMemoryProjection()}>
                        <RotateCcw size={14} />{task.memory_projection?.state === 'ready' ? '重新生成任务记忆' : '重试任务记忆'}
                      </button>
                      <button className="quiet-button memory-rebuild" type="button" disabled={busy || Boolean(task.deleted_at)} onClick={() => void rebuildMemoryProjection()}>
                        <FolderSync size={14} />清理并重建任务记忆
                      </button>
                    </div>
                  </section>

                  <section className="continuity-section runtime-section" aria-label="Runtime 状态">
                    <div className="section-heading-row"><div><strong>最近处理记录</strong><small>用来确认模型失败、重试或取消后是否安全恢复。</small></div><Activity size={16} /></div>
                    {task.runtime_jobs.length ? task.runtime_jobs.slice(0, 6).map((job) => (
                      <div className="runtime-row" key={job.id}>
                        <div><strong>{job.job_type === 'reprocess_candidate' ? '重新整理候选' : job.job_type === 'classify_source' ? '识别来源' : job.job_type}</strong><span>{formatFullDate(job.updated_at)} · 尝试 {job.attempts}/{job.max_attempts}</span>{job.last_error && <small>{job.last_error}</small>}</div>
                        <div className="runtime-actions"><em className={`runtime-state runtime-state-${job.status}`}>{runtimeStatusText[job.status] ?? job.status}</em>{(job.status === 'failed' || job.status === 'cancelled') && <button className="quiet-button" type="button" disabled={busy || Boolean(task.deleted_at)} onClick={() => void retryRuntimeJob(job.id)}><RotateCcw size={13} />重试</button>}</div>
                      </div>
                    )) : <div className="empty-state compact-empty">还没有 Runtime 处理记录。</div>}
                  </section>
                </div>
              )}
              {tab === 'timeline' && (
                <div className="timeline">
                  {task.events.map((event) => (
                    <div className="timeline-item" key={event.id}><i /><div><strong>{event.summary}</strong><span>{formatDate(event.occurred_at)} · {event.visibility === 'private' ? '仅自己可见' : event.visibility}</span></div></div>
                  ))}
                </div>
              )}
              {tab === 'approvals' && (
                <div>
                  <div className="approval-explainer">这里只保存本地草稿，供主人审阅、修改或废止；M1 永久不发送，也不自动执行。</div>
                  {task.approvals.map((approval) => (
                    <div className="approval-row" key={approval.id}>
                      <div><strong>{approval.action_type}</strong><span>{formatDate(approval.created_at)}</span></div>
                      <span className="status-text status-unplanned">{draftStateText[approval.state]}</span>
                      {approval.state === 'draft' && <button className="quiet-button" type="button" disabled={busy} onClick={() => void rejectDraft(approval.id)}>废止草稿</button>}
                    </div>
                  ))}
                  {!task.approvals.length && <div className="empty-state">暂时没有对外动作草稿。</div>}
                </div>
              )}
              {tab === 'references' && (
                <div>
                  {task.references.map((reference) => (
                    <div className="reference-row" key={reference.id}>
                      <ExternalLink size={16} />
                      <div><strong>{reference.label}</strong><code>{reference.path_bound ? '已绑定（路径默认隐藏）' : '未绑定'}</code></div>
                      <span>仅引用</span>
                      <button className="quiet-button reference-unlink" type="button" disabled={busy || Boolean(task.deleted_at)} aria-label={`解除 ${reference.label} 的绑定`} onClick={() => void removeReference(reference.id)}><Unlink size={14} />解除绑定</button>
                  </div>
                  ))}
                  {!task.references.length && <div className="empty-state compact-empty">这项任务还没有挂接参考路径。</div>}
                  <div className="reference-form">
                    <input value={referencePath} onChange={(event) => setReferencePath(event.target.value)} placeholder="workspace:// 或本地 reference path" />
                    {desktop && <button className="quiet-button" disabled={busy} onClick={() => void chooseReference()}>选择目录</button>}
                    <button className="secondary-button" disabled={busy || !referencePath.trim()} onClick={addReference}>挂接引用</button>
                  </div>
                  <small className="form-note">只保存路径，不扫描、不归档，也不修改真实工作文件。</small>
                </div>
              )}
              {tab === 'corrections' && (
                <div className="task-correction-panel">
                  <div className="correction-private-note"><RotateCcw size={16} /><span><strong>这里只修正私人 PM 记录</strong>不会回复需求方、发送排期或创建群聊。</span></div>
                  <label className="correction-field">
                    <span>哪里判断错了</span>
                    <select value={correctionType} onChange={(event) => setCorrectionType(event.target.value as TaskCorrectionType)}>
                      <option value="false_positive">这不是需求</option>
                      <option value="wrong_fields">提需求的人识别错误</option>
                      <option value="describe_incomplete">describe 不完整</option>
                      <option value="wrong_association">关联到了错误任务</option>
                      <option value="status_or_schedule_wrong">状态或排期错误</option>
                    </select>
                  </label>

                  {correctionType === 'false_positive' && <div className="correction-warning">这会保留来源和审计记录，把当前正式任务标记为“无效记录”并归档；不会删除任何聊天内容，也不会产生对外动作。</div>}
                  {correctionType === 'wrong_fields' && <label className="correction-field"><span>正确的提出人</span><input value={correctionValue} onChange={(event) => setCorrectionValue(event.target.value)} placeholder="例如：旭阳" /></label>}
                  {correctionType === 'describe_incomplete' && <label className="correction-field"><span>完整 describe</span><textarea value={correctionValue} onChange={(event) => setCorrectionValue(event.target.value)} placeholder="补全任务背景、需要判断的问题和边界" /></label>}
                  {correctionType === 'wrong_association' && <div className="correction-grid">
                    <label className="correction-field"><span>要移动的具体需求</span><select value={correctionSourceId} onChange={(event) => setCorrectionSourceId(event.target.value)}>{task.sources.map((source) => <option key={source.source_scope} value={source.source_scope}>{source.source_type} · {formatFullDate(source.occurred_at)}</option>)}</select></label>
                    <label className="correction-field"><span>正确任务</span><select value={targetTaskId} onChange={(event) => setTargetTaskId(event.target.value)}>{tasks.filter((item) => item.id !== task.id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
                    {!task.sources.length && <div className="correction-warning">当前任务没有可移动的原始来源。</div>}
                  </div>}
                  {correctionType === 'status_or_schedule_wrong' && <div className="correction-grid">
                    <label className="correction-field"><span>正确状态</span><select value={correctedStatus} onChange={(event) => setCorrectedStatus(event.target.value as TaskStatus)}>{Object.entries(statusText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label className="correction-field"><span>正确排期（留空即清除）</span><input type="datetime-local" value={correctedSchedule} onChange={(event) => setCorrectedSchedule(event.target.value)} /></label>
                    <label className="correction-field correction-field-wide"><span>正确下一步</span><textarea value={correctedNextStep} onChange={(event) => setCorrectedNextStep(event.target.value)} /></label>
                  </div>}
                  <button className="secondary-button correction-submit" disabled={busy || (correctionType === 'wrong_association' && (!correctionSourceId || !targetTaskId))} onClick={() => void submitCorrection()}><Link2 size={15} />记录私人纠错</button>
                </div>
              )}
            </div>

            <div className="drawer-actions">
              <div className="drawer-primary-action">
                <button className="primary-button" disabled={busy || task.record_state === 'invalidated' || Boolean(task.deleted_at)} onClick={requestExternalAction}>生成本地草稿</button>
                <span>{task.record_state === 'invalidated' ? '无效记录不再生成草稿' : task.deleted_at ? '回收站任务不再生成草稿' : '只生成、审阅、修改或废止，不发送'}</span>
              </div>
              {task.deleted_at
                ? <button className="secondary-button" disabled={busy} onClick={() => void restoreTask()}><Undo2 size={15} />恢复任务</button>
                : task.record_state === 'active' && <button className="danger-text-button" disabled={busy} onClick={() => void deleteTask()}><Trash2 size={15} />删除任务</button>}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
