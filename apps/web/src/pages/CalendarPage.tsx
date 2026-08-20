import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, RefreshCw } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { AsyncState } from '../components/AsyncState';
import { beginResource, beginResourceRequest, failureResource, isLatestResourceRequest, loadingResource, successResource, type ResourceState } from '../resource-state';
import { formatShanghaiFullDate, formatShanghaiPlanRange, formatShanghaiTime, statusText } from '../format';
import type { CalendarResponse, CalendarSource, CalendarSourcesResponse } from '../types';

const emptyCalendar: CalendarResponse = {
  asOf: '',
  timezone: 'Asia/Shanghai',
  warning: null,
  omittedCount: 0,
  days: [],
};

const emptySources: CalendarSourcesResponse = { timezone: 'Asia/Shanghai', items: [] };

const routeLabels = {
  calendar_fact: '时间事实',
  owner_confirmation: '待主人确认',
  candidate_review: '待确认候选',
} as const;

function sourceReason(source: CalendarSource) {
  if (source.route === 'calendar_fact') return '保留为日历事实，不自动生成任务候选。';
  if (source.route === 'candidate_review') {
    const fields = [source.evidenceFields.ownerResponsibility, source.evidenceFields.action, source.evidenceFields.deliverableOrDeadline].filter(Boolean);
    return fields.length ? `依据：${fields.join(' · ')}` : '已识别责任、动作和交付边界，等待主人确认。';
  }
  const missing = source.evidenceFields.missingSignalCode;
  const labels: Record<string, string> = {
    missing_owner_responsibility: '缺少明确主人责任',
    missing_deliverable_or_deadline: '缺少交付物或截止点',
    missing_minutes_or_explicit_message: '会议缺少纪要或明确关联消息',
    confirmation_negative_or_contradictory_signal: '存在否定或冲突信号',
  };
  return labels[missing ?? ''] ?? '行动边界不完整，仅提示主人确认。';
}

function calendarDayLabel(date: string) {
  const [, month, day] = date.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

export default function CalendarPage() {
  const [resource, setResource] = useState<ResourceState<CalendarResponse>>(loadingResource);
  const [sourcesResource, setSourcesResource] = useState<ResourceState<CalendarSourcesResponse>>(loadingResource);
  const requestGenerationRef = useRef({ current: 0 });
  const [, setSearchParams] = useSearchParams();
  const load = useCallback(() => {
    const request = beginResourceRequest(requestGenerationRef.current);
    setResource((current) => beginResource(current));
    setSourcesResource((current) => beginResource(current));
    void api.get<CalendarResponse>('/api/calendar')
      .then((data) => {
        if (isLatestResourceRequest(requestGenerationRef.current, request)) {
          setResource(successResource(data, data.days.length === 0));
        }
      })
      .catch((reason: unknown) => {
        if (isLatestResourceRequest(requestGenerationRef.current, request)) {
          setResource((current) => failureResource(current, reason instanceof Error ? reason.message : '排期日历读取失败。'));
        }
      });
    void api.get<CalendarSourcesResponse>('/api/calendar/sources?limit=100')
      .then((data) => setSourcesResource(successResource(data, data.items.length === 0)))
      .catch((reason: unknown) => setSourcesResource((current) => failureResource(current, reason instanceof Error ? reason.message : '日历来源读取失败。')));
  }, []);

  useEffect(() => {
    load();
    window.addEventListener('task-ledger-changed', load);
    return () => window.removeEventListener('task-ledger-changed', load);
  }, [load]);

  const calendar = resource.data ?? emptyCalendar;
  const sources = sourcesResource.data ?? emptySources;
  return (
    <div className="page">
      <div className="page-header"><div><h1>排期日历</h1><p><CalendarDays size={16} />排期由人确认，系统只负责整理和提醒</p><p className="calendar-contract">普通日历提醒、仅出席和会议占位会保留为来源事实，不会自动生成候选；只有明确主人责任、动作和交付/截止点的日历内容才进入待确认候选。</p></div><button className="secondary-button" type="button" onClick={load}><RefreshCw size={16} />刷新</button></div>
      <AsyncState resource={resource} empty={calendar.days.length === 0} emptyText="还没有已经排期的任务。" loadingText="正在整理排期日历…" errorTitle="排期日历读取失败" onRetry={load}>
        {calendar.asOf && <p className="calendar-contract">按 {calendar.timezone} 自然日展示 · 数据截至 {formatShanghaiFullDate(calendar.asOf)}</p>}
        {calendar.warning && (
          <div className="calendar-warning" role="alert">
            <strong>{calendar.warning}</strong>
            <span>已隐藏 {calendar.omittedCount} 项异常排期，其他正常任务仍可查看。</span>
          </div>
        )}
        <div className="calendar-layout">
          {calendar.days.map(({ date, items }) => (
            <section className="calendar-day" key={date} aria-label={`${date} 排期`}>
              <div className="calendar-date"><strong>{calendarDayLabel(date)}</strong><span>{date}</span></div>
              <div className="calendar-items">
                {items.map((task) => (
                  <button key={`${date}-${task.id}`} className="calendar-task" onClick={() => setSearchParams({ task: task.id })}>
                    <time>{formatShanghaiTime(task.display_anchor_at)}</time>
                    <div><strong>{task.title}</strong><span>{formatShanghaiPlanRange(task.display_start_at, task.display_due_at)} · {task.next_step}</span></div>
                    <span className={'status-text status-' + task.status}>{statusText[task.status]}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </AsyncState>
      <section className="calendar-sources" aria-labelledby="calendar-sources-title">
        <div className="calendar-sources-header">
          <div><h2 id="calendar-sources-title">日历来源事实</h2><p className="calendar-contract">这里展示安全摘要，不替代任务排期；来源事实会保留，只有明确边界的内容才会进入待确认候选。</p></div>
          {sourcesResource.status === 'loading' && <span className="calendar-source-status">正在读取…</span>}
          {sourcesResource.status === 'error' && <span className="calendar-source-status" role="alert">来源读取失败，请重试。</span>}
        </div>
        {sources.items.length === 0 && sourcesResource.status !== 'loading' && <div className="empty-state">还没有日历来源事实。</div>}
        <div className="calendar-source-list">
          {sources.items.map((source, index) => (
            <article className={`calendar-source-card route-${source.route}`} key={`${source.startAt ?? 'unknown'}-${source.title}-${index}`}>
              <div className="calendar-source-card-header"><strong>{source.title}</strong><span className="calendar-source-route">{routeLabels[source.route]}</span></div>
              <p>{sourceReason(source)}</p>
              <small>{source.startAt ?? '时间待确认'}{source.endAt ? ` – ${source.endAt}` : ''} · 来源已保留 · {source.correctionScope}</small>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
