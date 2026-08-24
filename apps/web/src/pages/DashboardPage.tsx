import { useCallback, useEffect, useRef, useState } from 'react';
import { BellRing, CalendarDays, Check, Info, RefreshCw } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { AsyncState } from '../components/AsyncState';
import TaskTable from '../components/TaskTable';
import { formatFullDate, formatShanghaiFullDate } from '../format';
import { beginResource, beginResourceRequest, failureResource, isLatestResourceRequest, loadingResource, successResource, type ResourceState } from '../resource-state';
import type { Candidate, Notification, Task } from '../types';

type DashboardData = {
  candidates: Candidate[];
  today: Task[];
  waiting: Task[];
  counts: { candidates: number; today: number; waiting: number; inProgress: number; overdue: number };
  asOf: string;
  todayDate: string;
  timezone: 'Asia/Shanghai';
  dataMode: 'local_mock' | 'configured';
};

const dataModeText: Record<DashboardData['dataMode'], string> = {
  local_mock: '本地模拟模式',
  configured: '外部适配器已配置',
};

function notificationTaskTab(notification: Notification) {
  const key = notification.dedupe_key ?? '';
  return key.startsWith('auto-update:')
    || key.startsWith('auto-update-reverted:')
    || (key.startsWith('candidate:') && key.includes(':source:'))
    ? 'updates'
    : null;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [dashboardResource, setDashboardResource] = useState<ResourceState<DashboardData>>(loadingResource);
  const [notificationsResource, setNotificationsResource] = useState<ResourceState<Notification[]>>(loadingResource);
  const dashboardGenerationRef = useRef({ current: 0 });
  const notificationsGenerationRef = useRef({ current: 0 });
  const load = useCallback(() => {
    const dashboardRequest = beginResourceRequest(dashboardGenerationRef.current);
    const notificationsRequest = beginResourceRequest(notificationsGenerationRef.current);
    setDashboardResource((current) => beginResource(current));
    setNotificationsResource((current) => beginResource(current));
    void api.get<DashboardData>('/api/dashboard')
      .then((value) => {
        if (isLatestResourceRequest(dashboardGenerationRef.current, dashboardRequest)) {
          setDashboardResource(successResource(value));
        }
      })
      .catch((reason: unknown) => {
        if (isLatestResourceRequest(dashboardGenerationRef.current, dashboardRequest)) {
          setDashboardResource((current) => failureResource(current, reason instanceof Error ? reason.message : '工作台暂时无法读取。'));
        }
      });
    void api.get<{ items: Notification[] }>('/api/notifications?unreadOnly=true&limit=20')
      .then((value) => {
        if (isLatestResourceRequest(notificationsGenerationRef.current, notificationsRequest)) {
          setNotificationsResource(successResource(value.items, value.items.length === 0));
        }
      })
      .catch((reason: unknown) => {
        if (isLatestResourceRequest(notificationsGenerationRef.current, notificationsRequest)) {
          setNotificationsResource((current) => failureResource(current, reason instanceof Error ? reason.message : '提醒暂时无法读取。'));
        }
      });
  }, []);

  const openNotification = async (notification: Notification) => {
    const request = beginResourceRequest(notificationsGenerationRef.current);
    setNotificationsResource((current) => beginResource(current));
    try {
      await api.post(`/api/notifications/${notification.id}/read`, {});
      if (!isLatestResourceRequest(notificationsGenerationRef.current, request)) return;
      setNotificationsResource((current) => current.data ? successResource(current.data.filter((item) => item.id !== notification.id), current.data.length <= 1) : current);
    } catch (reason) {
      if (isLatestResourceRequest(notificationsGenerationRef.current, request)) {
        setNotificationsResource((current) => failureResource(current, reason instanceof Error ? reason.message : '提醒处理失败。'));
      }
      return;
    }
    if (!isLatestResourceRequest(notificationsGenerationRef.current, request)) return;
    if (!notification.task_id) return;
    const tab = notificationTaskTab(notification);
    navigate(`/tasks?task=${encodeURIComponent(notification.task_id)}${tab ? `&tab=${tab}` : ''}`);
  };

  useEffect(() => {
    void load();
    window.addEventListener('task-ledger-changed', load);
    return () => window.removeEventListener('task-ledger-changed', load);
  }, [load]);

  const data = dashboardResource.data;
  const notifications = notificationsResource.data ?? [];

  return (
    <div className="page page-dashboard">
      <div className="page-header">
        <div><h1>工作台</h1><p><CalendarDays size={16} />{data ? `${formatShanghaiFullDate(data.asOf)} · 上海时间` : '按上海时间整理'}</p></div>
        <button className="secondary-button" onClick={load}><RefreshCw size={16} />刷新</button>
      </div>
      <div className="system-boundary"><Info size={17} /><span>系统自动记录线索，不会执行任何业务任务；所有对外事项均需你确认。</span></div>
      <AsyncState resource={notificationsResource} emptyText={null} onRetry={load}>
        {notifications.length > 0 && (
          <section className="work-section notification-section" aria-label="需要关注的提醒">
            <div className="section-heading"><h2>需要关注 <span>({notifications.length})</span></h2></div>
            <div className="notification-list">
              {notifications.map((notification) => (
                <article className="notification-row" key={notification.id}>
                  <span className="notification-icon"><BellRing size={16} /></span>
                  <div>
                    <strong>{notification.task_title || notification.candidate_title || '新的任务提醒'}</strong>
                    <p>{notification.reason}</p>
                    <small>{formatFullDate(notification.created_at)}</small>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => void openNotification(notification)}>
                    <Check size={14} />{notification.task_id ? '查看并已读' : '标记已读'}
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}
      </AsyncState>
      <AsyncState resource={dashboardResource} loadingText="正在整理你的任务台账…" errorTitle="工作台读取失败" onRetry={load}>
        {data ? <>
          <section className="dashboard-metrics" aria-label="任务统计">
            <div><span>进行中</span><strong>{data.counts.inProgress}</strong></div>
            <div><span>已逾期</span><strong>{data.counts.overdue}</strong></div>
          </section>
          <section className="work-section">
            <div className="section-heading"><h2>需要我确认 <span>({data.counts.candidates})</span></h2><Link to="/candidates">查看全部</Link></div>
            {data.candidates.length ? (
              <div className="candidate-brief-list">
                {data.candidates.slice(0, 3).map((candidate) => (
                  <Link to="/candidates" className="candidate-brief" key={candidate.id}>
                    <div><strong>{candidate.title}</strong><span>{candidate.proposer_name} · {candidate.describe}</span></div>
                    <span className="status-text status-unplanned">待确认</span>
                  </Link>
                ))}
              </div>
            ) : <div className="empty-state">这里还没有候选需求。回到 Cindy 说「扫近10分钟」即可扫描已授权消息。</div>}
          </section>
          <section className="work-section">
            <div className="section-heading"><h2>今天推进 <span>({data.counts.today})</span></h2><Link to="/tasks">查看全部</Link></div>
            <TaskTable tasks={data.today} compact />
          </section>
          <section className="work-section">
            <div className="section-heading"><h2>等待他人 <span>({data.counts.waiting})</span></h2><Link to="/tasks?status=waiting">查看全部</Link></div>
            <TaskTable tasks={data.waiting} compact emptyText="没有正在等待他人的任务。" />
          </section>
          <footer className="sync-footer">统计日：{data.todayDate} · 时区：{data.timezone} · {dataModeText[data.dataMode]}</footer>
        </> : null}
      </AsyncState>
    </div>
  );
}
