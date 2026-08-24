import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Eraser, FilePlus2, ScrollText, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { desktopBridge } from '../desktop';
import { HealthStatusPanel } from '../components/HealthStatusPanel';
import { normalizeHealth, normalizeLogResponse, type HealthSnapshot, type SafeLogResponse } from '../observability';
import { beginResourceRequest, failureResource, isLatestResourceRequest, loadingResource, successResource, type ResourceState } from '../resource-state';

const safeReadError = '日志或健康状态暂时无法读取。';
const safeCorrectionError = '纠错记录暂时无法提交。';

export default function LogsPage() {
  const [data, setData] = useState<SafeLogResponse | null>(null);
  const [category, setCategory] = useState('');
  const [level, setLevel] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [operationId, setOperationId] = useState('');
  const [traceId, setTraceId] = useState('');
  const [eventType, setEventType] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [manualContent, setManualContent] = useState('');
  const [manualSender, setManualSender] = useState('人工补录');
  const [healthResource, setHealthResource] = useState<ResourceState<HealthSnapshot>>(loadingResource);
  const loadGenerationRef = useRef({ current: 0 });
  const desktop = desktopBridge();

  const load = useCallback(async () => {
    const request = beginResourceRequest(loadGenerationRef.current);
    const query = new URLSearchParams({ limit: '200' });
    if (category) query.set('category', category);
    if (level) query.set('level', level);
    if (fromDate) query.set('from', new Date(`${fromDate}T00:00:00`).toISOString());
    if (toDate) query.set('to', new Date(`${toDate}T23:59:59.999`).toISOString());
    if (operationId.trim()) query.set('operation_id', operationId.trim());
    if (traceId.trim()) query.set('trace_id', traceId.trim());
    if (eventType.trim()) query.set('event_type', eventType.trim());
    setError('');
    setHealthResource(loadingResource<HealthSnapshot>());
    const [logsResult, healthResult] = await Promise.allSettled([
      api.get<unknown>('/api/logs?' + query.toString()),
      api.get<unknown>('/api/health'),
    ]);
    if (!isLatestResourceRequest(loadGenerationRef.current, request)) return;
    if (logsResult.status === 'fulfilled') {
      const normalized = normalizeLogResponse(logsResult.value);
      setData(normalized);
      if (normalized.invalid) setError(safeReadError);
    } else setError(safeReadError);
    if (healthResult.status === 'fulfilled') setHealthResource(successResource(normalizeHealth(healthResult.value)));
    else setHealthResource(failureResource(loadingResource<HealthSnapshot>(), safeReadError));
  }, [category, level, fromDate, toDate, operationId, traceId, eventType]);

  useEffect(() => { void load().catch(() => setError(safeReadError)); }, [load]);

  const counts = useMemo(() => ({
    errors: data?.logs.filter((row) => row.level === 'error').length ?? 0,
    fallbacks: data?.decisions.filter((row) => row.used_fallback).length ?? 0,
    corrections: data?.corrections.length ?? 0,
  }), [data]);
  const exportDiagnostics = async () => {
    if (!desktop) return;
    const result = await desktop.diagnostics.export();
    setMessage(result.saved ? '脱敏诊断包已导出。' : '已取消导出。');
  };

  const cleanupExpiredLogs = async () => {
    await api.post('/api/diagnostics/cleanup', {});
    setMessage('已按设置中的保留天数清理到期日志。');
    await load();
  };

  const deleteDiagnosticLogs = async () => {
    if (!window.confirm('一键删除运行日志、模型判断和连接健康记录；不会删除任务、原始来源或纠错审计。继续吗？')) return;
    await api.delete('/api/logs?includeCorrections=false');
    setMessage('已删除运行诊断日志；任务、原始来源和纠错审计仍保留。');
    await load();
  };

  const submitManual = async (event: FormEvent) => {
    event.preventDefault();
    if (!manualContent.trim()) return;
    try {
      await api.post('/api/corrections', {
        correctionType: 'missed_request',
        idempotencyKey: `manual-ui:${Date.now()}`,
        manualContent: manualContent.trim(),
        manualSenderName: manualSender.trim() || '人工补录',
      });
      setManualContent('');
      setMessage('已补录到候选收件箱，仍需主人确认后才会成为正式任务。');
      await load();
    } catch (reason) {
      setError(safeCorrectionError);
    }
  };

  return (
    <div className="page">
      <div className="page-header"><div><h1>日志与纠错</h1><p><ScrollText size={16} />帮助确认判断依据、连接健康和后续改进方向</p></div></div>
      <div className="security-banner"><ShieldCheck size={20} /><div><strong>默认脱敏</strong><span>这里不展示完整密钥或完整聊天原文；模型记录只保留版本、状态、耗时和输入哈希。</span></div></div>
      {message && <div className="success-banner">{message}</div>}
      {error && <div className="error-banner">{error}</div>}
      <div className="log-summary-grid">
        <div><strong>{counts.errors}</strong><span>错误日志</span></div>
        <div><strong>{counts.fallbacks}</strong><span>规则降级</span></div>
        <div><strong>{counts.corrections}</strong><span>纠错记录</span></div>
      </div>
      <div className="log-toolbar">
        <select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">全部类型</option><option value="runtime">运行</option><option value="ai">AI 判断</option><option value="integration">连接</option><option value="workspace">工作目录</option></select>
        <select value={level} onChange={(event) => setLevel(event.target.value)}><option value="">全部级别</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option></select>
        <label className="log-date-field"><span>开始日期</span><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
        <label className="log-date-field"><span>结束日期</span><input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
        <label className="log-correlation-field"><span>operation_id</span><input value={operationId} onChange={(event) => setOperationId(event.target.value)} placeholder="可选 UUID" /></label>
        <label className="log-correlation-field"><span>trace_id</span><input value={traceId} onChange={(event) => setTraceId(event.target.value)} placeholder="可选 UUID" /></label>
        <label className="log-correlation-field"><span>事件类型</span><input value={eventType} onChange={(event) => setEventType(event.target.value)} placeholder="例如 feishu.sync.completed" /></label>
        {desktop
          ? <button className="secondary-button" type="button" onClick={() => void exportDiagnostics()}><Download size={15} />导出脱敏诊断包</button>
          : <span className="integration-note">浏览器入口暂不提供脱敏诊断包导出。</span>}
        <button className="quiet-button" type="button" onClick={() => void cleanupExpiredLogs()}><Eraser size={15} />清理到期日志</button>
        <button className="quiet-button" type="button" onClick={() => void deleteDiagnosticLogs()}><Eraser size={15} />一键删除日志</button>
      </div>
      <HealthStatusPanel resource={healthResource} onRetry={() => void load()} compact />
      <section className="log-section"><h2>运行事件</h2>{data?.logs.length ? data.logs.slice(0, 50).map((row, index) => <div className="log-row" key={row.id ?? `log-${index}`}><div><strong>{row.event_label}</strong><span>{row.message}</span><small>{row.event_type === 'OBS_UNKNOWN_EVENT' ? '事件类型未提供安全说明。' : row.event_type} · {row.created_at ? new Date(row.created_at).toLocaleString('zh-CN') : '未提供时间'}</small><small>关联：{row.operation_id?.slice(0, 8) ?? '未提供'} / {row.trace_id?.slice(0, 8) ?? '未提供'}{typeof row.details.reason === 'string' ? ` · ${row.details.reason}` : ''}</small>{Object.keys(row.details).length > 0 && <details><summary>查看受控详情</summary><div className="log-details">{Object.entries(row.details).map(([key, value]) => <span key={key}><code>{key}</code>{String(value ?? '未提供')}</span>)}</div></details>}</div><em className={`log-level log-${row.level}`}>{row.level === 'error' ? '错误' : row.level === 'warn' ? '警告' : row.level === 'info' ? '信息' : '未提供'}</em></div>) : <div className="empty-state">还没有运行事件。</div>}</section>
      <section className="log-section"><h2>连接检查记录</h2>{data?.health.length ? data.health.map((row, index) => <div className="log-row" key={`health-${index}`}><div><strong>{row.integration === 'feishu' ? '飞书' : row.integration === 'llm' ? '判断模型' : row.integration === 'workspace' ? '只读工作区' : '未提供连接'}</strong><span>{row.message}</span></div><em className={'log-level log-' + row.status}>{row.status_label}</em></div>) : <div className="empty-state">还没有连接检查记录。</div>}</section>
      <section className="log-section"><h2>模型判断</h2>{data?.decisions.length ? data.decisions.slice(0, 30).map((row, index) => <div className="log-row" key={`decision-${index}`}><div><strong>{row.provider} / {row.model}</strong><span>{row.prompt_version} · {row.fallback_mode} · 输入 {row.input_char_count ?? '未提供'} 字符</span></div><em className={'log-level ' + (row.used_fallback ? 'log-warn' : 'log-info')}>{row.used_fallback ? '降级' : '已记录'}</em></div>) : <div className="empty-state">还没有模型判断记录。</div>}</section>
      <section className="log-section"><h2>纠错记录</h2>{data?.corrections.length ? data.corrections.slice(0, 30).map((row, index) => <div className="log-row" key={`correction-${index}`}><div><strong>{row.correction_label}</strong><span>{row.note}</span></div><time>{row.created_at ? new Date(row.created_at).toLocaleString() : '未提供时间'}</time></div>) : <div className="empty-state">还没有纠错记录。</div>}</section>
      <section className="manual-correction-section"><div><h2><FilePlus2 size={17} />人工补录漏掉的需求</h2><p>把原消息或你的简短说明放进候选收件箱；系统不会自动建成正式任务，也不会发送给外部人员。</p></div><form onSubmit={submitManual}><div className="settings-fields"><label><span>提出人</span><input value={manualSender} onChange={(event) => setManualSender(event.target.value)} /></label><label className="field-wide"><span>需求内容</span><textarea value={manualContent} onChange={(event) => setManualContent(event.target.value)} placeholder="例如：请评估本次活动的留存变化，并说明是否值得继续投入。" /></label></div><button className="primary-button" type="submit" disabled={!manualContent.trim()}>加入候选收件箱</button></form></section>
    </div>
  );
}
