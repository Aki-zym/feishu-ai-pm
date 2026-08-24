import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListFilter, RefreshCw, Search } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { AsyncState } from '../components/AsyncState';
import { beginResource, beginResourceRequest, failureResource, isLatestResourceRequest, loadingResource, successResource, type ResourceState } from '../resource-state';
import TaskTable from '../components/TaskTable';
import { statusText } from '../format';
import type { Task, TaskStatus } from '../types';

export default function TasksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [resource, setResource] = useState<ResourceState<Task[]>>(loadingResource);
  const requestGenerationRef = useRef({ current: 0 });
  const [search, setSearch] = useState('');
  const status = searchParams.get('status') as TaskStatus | null;

  const load = useCallback(() => {
    const request = beginResourceRequest(requestGenerationRef.current);
    setResource((current) => beginResource(current));
    void api.get<{ items: Task[] }>('/api/tasks')
      .then((data) => {
        if (isLatestResourceRequest(requestGenerationRef.current, request)) {
          setResource(successResource(data.items, data.items.length === 0));
        }
      })
      .catch((reason: unknown) => {
        if (isLatestResourceRequest(requestGenerationRef.current, request)) {
          setResource((current) => failureResource(current, reason instanceof Error ? reason.message : '任务列表读取失败。'));
        }
      });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener('task-ledger-changed', load);
    return () => window.removeEventListener('task-ledger-changed', load);
  }, [load]);

  const items = resource.data ?? [];

  const visible = useMemo(() => items.filter((task) => {
    const matchesStatus = !status || task.status === status;
    const query = search.trim().toLowerCase();
    return matchesStatus && (!query || (task.title + task.describe + task.proposer_name).toLowerCase().includes(query));
  }), [items, search, status]);

  const chooseStatus = (next: string) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('status', next); else params.delete('status');
    params.delete('task');
    setSearchParams(params);
  };

  return (
    <div className="page">
      <div className="page-header"><div><h1>全部任务</h1><p><ListFilter size={16} />所有视图都来自同一份正式任务台账</p></div><button className="secondary-button" type="button" onClick={load}><RefreshCw size={16} />刷新</button></div>
      <div className="task-toolbar">
        <label className="search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、提出人或 describe" /></label>
        <select value={status ?? ''} onChange={(event) => chooseStatus(event.target.value)}>
          <option value="">全部状态</option>
          {Object.entries(statusText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {resource.data !== null && resource.status !== 'error' && <div className="list-summary">共 {visible.length} 项任务</div>}
      <AsyncState resource={resource} empty={visible.length === 0} emptyText={status ? `“${statusText[status]}”下还没有任务。` : '目前还没有正式任务。回到 Cindy 说「扫近10分钟」即可扫描已授权消息。'} loadingText="正在读取任务台账…" errorTitle="任务列表读取失败" onRetry={load}>
        <TaskTable tasks={visible} />
      </AsyncState>
    </div>
  );
}
