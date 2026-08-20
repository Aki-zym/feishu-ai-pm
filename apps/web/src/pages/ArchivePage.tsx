import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../api';
import { AsyncState } from '../components/AsyncState';
import { beginResource, beginResourceRequest, failureResource, isLatestResourceRequest, loadingResource, successResource, type ResourceState } from '../resource-state';
import TaskTable from '../components/TaskTable';
import type { Task } from '../types';

export default function ArchivePage() {
  const [resource, setResource] = useState<ResourceState<Task[]>>(loadingResource);
  const requestGenerationRef = useRef({ current: 0 });
  const [view, setView] = useState<'archive' | 'trash'>('archive');
  const load = useCallback(() => {
    const request = beginResourceRequest(requestGenerationRef.current);
    setResource((current) => beginResource(current));
    void api.get<{ items: Task[] }>('/api/tasks?recordState=all&deleted=all')
      .then((data) => {
        if (isLatestResourceRequest(requestGenerationRef.current, request)) {
          setResource(successResource(data.items, data.items.length === 0));
        }
      })
      .catch((reason: unknown) => {
        if (isLatestResourceRequest(requestGenerationRef.current, request)) {
          setResource((current) => failureResource(current, reason instanceof Error ? reason.message : '归档和回收站读取失败。'));
        }
      });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener('task-ledger-changed', load);
    return () => window.removeEventListener('task-ledger-changed', load);
  }, [load]);
  const items = resource.data ?? [];
  const archived = useMemo(() => items.filter((task) => !task.deleted_at && (task.status === 'completed' || task.status === 'archived')), [items]);
  const trashed = useMemo(() => items.filter((task) => Boolean(task.deleted_at)), [items]);
  return (
    <div className="page">
      <div className="page-header"><div><h1>归档与回收站</h1><p><Archive size={16} />退出日常工作台，同时保留来源和审计历史</p></div><button className="secondary-button" type="button" onClick={load}><RefreshCw size={16} />刷新</button></div>
      <div className="filter-bar archive-tabs">
        <button className={view === 'archive' ? 'filter-active' : ''} onClick={() => setView('archive')}><Archive size={15} />已完成与归档</button>
        <button className={view === 'trash' ? 'filter-active' : ''} onClick={() => setView('trash')}><Trash2 size={15} />回收站{resource.data !== null && resource.status !== 'error' ? `（${trashed.length}）` : ''}</button>
      </div>
      <AsyncState resource={resource} empty={view === 'archive' ? archived.length === 0 : trashed.length === 0} emptyText={view === 'archive' ? '目前还没有已完成或归档的任务。' : '回收站是空的。'} loadingText="正在读取归档和回收站…" errorTitle="归档和回收站读取失败" onRetry={load}>
        {view === 'archive'
          ? <><div className="archive-explainer">归档任务仍可回查来源和重新打开；它们没有被删除。</div><TaskTable tasks={archived} /></>
          : <><div className="archive-explainer">任务与对应的已接受候选共享回收状态：从任一入口删除或恢复，另一边都会同步；来源、时间线和参考路径仍保留。</div><TaskTable tasks={trashed} /></>}
      </AsyncState>
    </div>
  );
}
