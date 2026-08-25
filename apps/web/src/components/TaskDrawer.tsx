import { useEffect, useState } from 'react';
import { CalendarClock, Save, Trash2, Undo2, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { formatDate, formatFullDate, riskText, statusText } from '../format';
import type { TaskDetail, TaskStatus } from '../types';

function toDateTimeLocal(value: string | null) {
  if (!value) return '';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIsoOrNull(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('排期时间无效。');
  return parsed.toISOString();
}

function announceTaskChange() {
  window.dispatchEvent(new CustomEvent('task-ledger-changed'));
}

export default function TaskDrawer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const taskId = searchParams.get('task');
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [title, setTitle] = useState('');
  const [describe, setDescribe] = useState('');
  const [status, setStatus] = useState<TaskStatus>('unplanned');
  const [risk, setRisk] = useState<'low' | 'medium' | 'high'>('medium');
  const [nextStep, setNextStep] = useState('');
  const [waitingReason, setWaitingReason] = useState('');
  const [plannedStart, setPlannedStart] = useState('');
  const [plannedDue, setPlannedDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const sync = (detail: TaskDetail) => {
    setTask(detail);
    setTitle(detail.title);
    setDescribe(detail.describe);
    setStatus(detail.status);
    setRisk(detail.risk);
    setNextStep(detail.next_step);
    setWaitingReason(detail.waiting_reason ?? '');
    setPlannedStart(toDateTimeLocal(detail.planned_start_at));
    setPlannedDue(toDateTimeLocal(detail.planned_due_at));
  };

  useEffect(() => {
    setTask(null);
    setError('');
    setMessage('');
    if (!taskId) return;
    void api.get<TaskDetail>('/api/tasks/' + encodeURIComponent(taskId))
      .then(sync)
      .catch((reason) => setError(reason instanceof Error ? reason.message : '任务详情读取失败。'));
  }, [taskId]);

  if (!taskId) return null;

  const close = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('task');
    setSearchParams(next);
  };

  const save = async () => {
    if (!task) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const updated = await api.patch<TaskDetail>('/api/tasks/' + encodeURIComponent(task.id), {
        title,
        describe,
        status,
        risk,
        nextStep,
        waitingReason: waitingReason.trim() || null,
        plannedStartAt: toIsoOrNull(plannedStart),
        plannedDueAt: toIsoOrNull(plannedDue),
        expectedVersion: task.version,
      });
      sync(updated);
      setMessage('任务已保存。');
      announceTaskChange();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务保存失败。');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!task || !window.confirm('确定把这项任务移入回收站吗？来源与审计记录会保留。')) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api.delete<TaskDetail>('/api/tasks/' + encodeURIComponent(task.id), { expectedVersion: task.version });
      sync(updated);
      setMessage('任务已移入回收站。');
      announceTaskChange();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务删除失败。');
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!task) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api.post<TaskDetail>('/api/tasks/' + encodeURIComponent(task.id) + '/restore', { expectedVersion: task.version });
      sync(updated);
      setMessage('任务已恢复。');
      announceTaskChange();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务恢复失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-layer">
      <button className="drawer-backdrop" aria-label="关闭任务详情" onClick={close} />
      <aside className="task-drawer" aria-label="任务详情">
        <div className="drawer-header"><div><span className="drawer-kicker">任务详情</span><h2>{task?.title ?? '正在读取…'}</h2></div><button className="icon-button" aria-label="关闭" onClick={close}><X size={20} /></button></div>
        {error && <div className="error-banner">{error}</div>}
        {message && <div className="success-banner">{message}</div>}
        {task && <>
          <section className="drawer-summary"><span>版本 v{task.version} · 最近更新 {formatFullDate(task.updated_at)}</span>{task.deleted_at && <strong>已在回收站</strong>}</section>
          <section className="drawer-edit-panel" aria-label="编辑任务">
            <label className="correction-field"><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label className="correction-field"><span>Describe</span><textarea value={describe} onChange={(event) => setDescribe(event.target.value)} /></label>
            <div className="correction-grid"><label className="correction-field"><span>状态</span><select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>{Object.entries(statusText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="correction-field"><span>风险</span><select value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)}>{Object.entries(riskText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
            <label className="correction-field"><span>下一步</span><textarea value={nextStep} onChange={(event) => setNextStep(event.target.value)} /></label>
            <label className="correction-field"><span>等待原因</span><textarea value={waitingReason} onChange={(event) => setWaitingReason(event.target.value)} /></label>
            <div className="correction-grid"><label className="correction-field"><span><CalendarClock size={14} />计划开始</span><input type="datetime-local" value={plannedStart} onChange={(event) => setPlannedStart(event.target.value)} /></label><label className="correction-field"><span><CalendarClock size={14} />计划完成</span><input type="datetime-local" value={plannedDue} onChange={(event) => setPlannedDue(event.target.value)} /></label></div>
            <button className="primary-button" type="button" disabled={busy || Boolean(task.deleted_at)} onClick={() => void save()}><Save size={15} />保存任务</button>
          </section>
          <section className="continuity-section" aria-label="任务来源"><div className="section-heading-row"><strong>来源记录</strong><span>{task.sources.length} 条</span></div>{task.sources.length ? <ul className="task-source-list">{task.sources.map((source) => <li key={source.source_scope}><span>{source.source_type}</span><span>{formatDate(source.occurred_at)}</span><small>{source.completeness}</small></li>)}</ul> : <div className="empty-state compact-empty">暂无来源记录。</div>}</section>
          <div className="drawer-actions">{task.deleted_at ? <button className="secondary-button" disabled={busy} onClick={() => void restore()}><Undo2 size={15} />恢复任务</button> : <button className="danger-text-button" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />移入回收站</button>}</div>
        </>}
      </aside>
    </div>
  );
}
