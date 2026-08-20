import { Activity, ShieldCheck } from 'lucide-react';
import { AsyncState } from './AsyncState';
import { normalizeHealth, shortDiagnosticId, type HealthSnapshot } from '../observability';
import type { ResourceState } from '../resource-state';

const readinessLabels: Record<HealthSnapshot['readiness'], string> = {
  ready: '系统就绪',
  degraded: '部分受限',
  not_ready: '暂不可用',
};

const dependencyLabels: Record<string, string> = {
  database: '数据库',
  runner: '运行器',
  listener: '监听器',
  token: '授权状态',
  freshness: '数据新鲜度',
  backoff: '退避状态',
  queue: '任务队列',
  disk: '诊断磁盘',
};

const dependencyStatusLabels: Record<HealthSnapshot['dependencies'][string]['status'], string> = {
  ready: '正常',
  degraded: '部分受限',
  not_ready: '未就绪',
  unknown: '未提供',
};

export function HealthStatusPanel({
  resource,
  onRetry,
  compact = false,
}: {
  resource: ResourceState<HealthSnapshot>;
  onRetry: () => void;
  compact?: boolean;
}) {
  const snapshot = resource.data;
  const readiness = snapshot?.readiness ?? 'not_ready';
  return (
    <section className={`health-status-panel ${compact ? 'health-status-panel-compact' : ''}`} aria-labelledby="health-status-title">
      <div className="health-status-heading">
        <div><h2 id="health-status-title"><Activity size={17} />系统健康</h2><p>存活状态与可就绪状态分开显示；未提供的指标不会被猜测。</p></div>
        <div className="health-status-heading-actions">
          <span className={`health-readiness health-readiness-${readiness}`}>{snapshot ? readinessLabels[readiness] : '正在读取'}</span>
          {resource.status !== 'error' && <button className="quiet-button" type="button" onClick={onRetry}>重试</button>}
        </div>
      </div>
      <AsyncState resource={resource} emptyText={null} loadingText="正在读取健康状态…" errorTitle="健康状态读取失败" onRetry={onRetry}>
        {snapshot && <>
          <div className="health-status-grid">
            <div><span>存活 liveness</span><strong>{snapshot.liveness === 'alive' ? '存活' : '暂不可确认'}</strong></div>
            <div><span>就绪 readiness</span><strong>{readinessLabels[readiness]}</strong></div>
          </div>
          {snapshot.reasons.length > 0 && <div className="health-reasons" role="status"><strong>当前原因</strong>{snapshot.reasons.map((reason) => <div key={reason.code}><code>{reason.code}</code><span>{reason.message}</span></div>)}</div>}
          {snapshot.reasons.length === 0 && snapshot.readiness === 'ready' && !snapshot.invalid && <p className="health-clear"><ShieldCheck size={14} />当前没有后端报告的降级原因。</p>}
          {Object.keys(snapshot.dependencies).length > 0 && <div className="health-dependencies">
            <strong>依赖状态</strong>
            <div className="health-dependency-grid">
              {Object.entries(snapshot.dependencies).map(([name, dependency]) => <div className={`health-dependency health-dependency-${dependency.status}`} key={name}>
                <span>{dependencyLabels[name] ?? '受控依赖'}</span>
                <strong>{dependencyStatusLabels[dependency.status]}</strong>
                {dependency.error_code && <code>{dependency.error_code}</code>}
              </div>)}
            </div>
          </div>}
          <div className="health-meta">
            <span>版本：{snapshot.release?.app_version ?? '未提供'}</span>
            <span>构建：{snapshot.release?.build_identity ?? '未提供'}</span>
            <span>状态时间：{snapshot.timestamp ? new Date(snapshot.timestamp).toLocaleString('zh-CN') : '未提供'}</span>
            <span>诊断标识：{shortDiagnosticId(snapshot.operation_id)} / {shortDiagnosticId(snapshot.request_id)} / {shortDiagnosticId(snapshot.trace_id)}</span>
          </div>
          {snapshot.invalid && <p className="health-not-provided">健康数据合同无效，已按安全边界降级显示。</p>}
        </>}
      </AsyncState>
    </section>
  );
}

export function healthSnapshotFromDto(value: unknown) {
  return normalizeHealth(value);
}
