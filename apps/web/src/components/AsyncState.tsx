import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ResourceState } from '../resource-state';

type AsyncStateProps<T> = {
  resource: ResourceState<T>;
  empty?: boolean;
  emptyText?: string | null;
  loadingText?: string;
  errorTitle?: string;
  staleText?: string;
  onRetry?: () => void;
  children: ReactNode;
};

export function AsyncState<T>({
  resource,
  empty = false,
  emptyText = '目前还没有数据。',
  loadingText = '正在读取…',
  errorTitle = '读取失败',
  staleText = '最近一次读取失败，下面保留的是上次成功的数据。请重试。',
  onRetry,
  children,
}: AsyncStateProps<T>) {
  if (resource.status === 'loading' && resource.data === null) {
    return <div className="loading-state" role="status" aria-live="polite">{loadingText}</div>;
  }

  if (resource.status === 'error') {
    return (
      <div className="resource-state resource-state-error">
        <div role="alert"><strong>{errorTitle}：</strong><span>{resource.error ?? '暂时无法读取，请稍后重试。'}</span></div>
        {onRetry && <button className="secondary-button" type="button" onClick={onRetry}><RefreshCw size={15} />重试</button>}
      </div>
    );
  }

  const hasData = resource.data !== null;
  const shouldShowEmpty = (resource.status === 'success-empty' || empty) && resource.status !== 'stale' && resource.status !== 'loading';
  return (
    <>
      {resource.status === 'loading' && hasData && (
        <div className="resource-state resource-state-loading" role="status" aria-live="polite">正在刷新，暂时保留上次成功的数据…</div>
      )}
      {resource.status === 'stale' && (
        <div className="resource-state resource-state-stale" role="status" aria-live="polite">
          <span><strong>数据可能已过期</strong>{resource.error ? `：${resource.error}` : `：${staleText}`}</span>
          {onRetry && <button className="secondary-button" type="button" onClick={onRetry}><RefreshCw size={15} />重试</button>}
        </div>
      )}
      {shouldShowEmpty && emptyText !== null && <div className="empty-state empty-state-large">{emptyText}</div>}
      {!shouldShowEmpty && children}
    </>
  );
}
