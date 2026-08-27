import { useEffect, useState } from 'react';
import { Activity, Bot, Link, Power, RefreshCw, Sparkles, Unplug } from 'lucide-react';
import { api } from '../api';
import { HealthStatusPanel } from '../components/HealthStatusPanel';
import { normalizeHealth, type HealthSnapshot } from '../observability';
import { beginResource, failureResource, loadingResource, successResource, type ResourceState } from '../resource-state';
import type { HealthDto } from '../types';

type RuntimeAutoScan = { enabled: boolean };
type IntakeCursor = { window_end: string | null };
type AilyStatus = {
  appId: string;
  agentId: string;
  domain: 'feishu' | 'lark';
  oauthRedirectUri: string;
  oauthScopes: string[];
  appSecretSaved: boolean;
  connected: boolean;
  refreshAvailable: boolean;
  expiresAt: string | null;
  grantedScopes: string[];
  authStatus: 'connected' | 'expired' | 'not_connected' | 'not_configured';
};

function toDateTimeLocal(value: string | null) {
  if (!value) return '';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIso(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('请输入有效的窗口结束时间。');
  return parsed.toISOString();
}

export default function SettingsPage() {
  const [health, setHealth] = useState<ResourceState<HealthSnapshot>>(loadingResource);
  const [autoScan, setAutoScan] = useState<ResourceState<RuntimeAutoScan>>(loadingResource);
  const [cursor, setCursor] = useState<ResourceState<IntakeCursor>>(loadingResource);
  const [cursorInput, setCursorInput] = useState('');
  const [autoScanMessage, setAutoScanMessage] = useState('');
  const [cursorMessage, setCursorMessage] = useState('');
  const [runtimeMessage, setRuntimeMessage] = useState('');
  const [runtimeState, setRuntimeState] = useState<'idle' | 'pending' | 'warning' | 'error'>('idle');
  const [runtimeExited, setRuntimeExited] = useState(false);
  const [seedState, setSeedState] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [seedMessage, setSeedMessage] = useState('');
  const [aily, setAily] = useState<AilyStatus | null>(null);
  const [ailyForm, setAilyForm] = useState({
    appId: '',
    appSecret: '',
    agentId: '',
    domain: 'feishu' as 'feishu' | 'lark',
    oauthRedirectUri: '',
    oauthScopes: [] as string[],
  });
  const [ailyState, setAilyState] = useState<'idle' | 'pending' | 'error'>('idle');
  const [ailyMessage, setAilyMessage] = useState('');

  const applyAilyStatus = (status: AilyStatus) => {
    setAily(status);
    setAilyForm((current) => ({
      appId: status.appId,
      appSecret: current.appSecret,
      agentId: status.agentId,
      domain: status.domain,
      oauthRedirectUri: status.oauthRedirectUri,
      oauthScopes: status.oauthScopes,
    }));
  };

  const loadAily = async () => {
    const status = await api.get<AilyStatus>('/api/integrations/aily/status');
    applyAilyStatus(status);
    return status;
  };

  const load = async () => {
    setHealth((current) => beginResource(current));
    setAutoScan((current) => beginResource(current));
    setCursor((current) => beginResource(current));
    const [healthResult, autoScanResult, cursorResult, ailyResult] = await Promise.allSettled([
      api.get<HealthDto>('/api/health'),
      api.get<RuntimeAutoScan>('/api/runtime/auto-scan'),
      api.get<IntakeCursor>('/api/runtime/intake-cursor'),
      api.get<AilyStatus>('/api/integrations/aily/status'),
    ]);
    if (healthResult.status === 'fulfilled') setHealth(successResource(normalizeHealth(healthResult.value)));
    else setHealth(failureResource(loadingResource<HealthSnapshot>(), healthResult.reason instanceof Error ? healthResult.reason.message : '健康状态读取失败。'));
    if (autoScanResult.status === 'fulfilled') setAutoScan(successResource(autoScanResult.value));
    else setAutoScan(failureResource(loadingResource<RuntimeAutoScan>(), autoScanResult.reason instanceof Error ? autoScanResult.reason.message : '自动扫描设置读取失败。'));
    if (cursorResult.status === 'fulfilled') {
      setCursor(successResource(cursorResult.value));
      setCursorInput(toDateTimeLocal(cursorResult.value.window_end));
    } else {
      setCursor(failureResource(loadingResource<IntakeCursor>(), cursorResult.reason instanceof Error ? cursorResult.reason.message : '入库游标读取失败。'));
    }
    if (ailyResult.status === 'fulfilled') applyAilyStatus(ailyResult.value);
    else setAilyMessage(ailyResult.reason instanceof Error ? ailyResult.reason.message : 'Aily 设置读取失败。');
  };

  useEffect(() => {
    void load();
    const receiveOAuth = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'toomanytasks:aily-oauth') return;
      void loadAily()
        .then(() => setAilyMessage(event.data.ok ? 'Aily 已连接，用户 Token 将由 TooManyTasks 自动刷新。' : 'Aily 授权未完成。'))
        .catch((error) => setAilyMessage(error instanceof Error ? error.message : 'Aily 状态刷新失败。'));
    };
    window.addEventListener('message', receiveOAuth);
    return () => window.removeEventListener('message', receiveOAuth);
  }, []);

  const saveAilyConfig = async () => {
    if (ailyState === 'pending') return;
    setAilyState('pending');
    setAilyMessage('正在保存 Aily 应用配置…');
    try {
      const updated = await api.put<AilyStatus>('/api/integrations/aily/config', {
        appId: ailyForm.appId.trim(),
        agentId: ailyForm.agentId.trim(),
        domain: ailyForm.domain,
        oauthRedirectUri: ailyForm.oauthRedirectUri.trim(),
        oauthScopes: ailyForm.oauthScopes,
        ...(ailyForm.appSecret.trim() ? { appSecret: ailyForm.appSecret.trim() } : {}),
      });
      setAilyForm((current) => ({ ...current, appSecret: '' }));
      applyAilyStatus(updated);
      setAilyState('idle');
      setAilyMessage('Aily 应用配置已保存。');
    } catch (error) {
      setAilyState('error');
      setAilyMessage(error instanceof Error ? error.message : 'Aily 应用配置保存失败。');
    }
  };

  const connectAily = async () => {
    if (ailyState === 'pending') return;
    setAilyState('pending');
    setAilyMessage('正在打开飞书用户授权页…');
    try {
      const result = await api.get<{ url: string }>('/api/integrations/aily/oauth/url');
      const popup = window.open(result.url, 'toomanytasks-aily-oauth', 'popup,width=720,height=760');
      if (!popup) throw new Error('浏览器拦截了授权窗口，请允许弹窗后重试。');
      setAilyState('idle');
      setAilyMessage('请在飞书授权窗口完成授权。');
    } catch (error) {
      setAilyState('error');
      setAilyMessage(error instanceof Error ? error.message : 'Aily 授权页打开失败。');
    }
  };

  const disconnectAily = async () => {
    if (ailyState === 'pending') return;
    setAilyState('pending');
    setAilyMessage('正在清除本机 Aily 用户授权…');
    try {
      const result = await api.post<{ status: AilyStatus }>('/api/integrations/aily/disconnect', {});
      applyAilyStatus(result.status);
      setAilyState('idle');
      setAilyMessage('Aily 用户授权已从本机凭证库清除。');
    } catch (error) {
      setAilyState('error');
      setAilyMessage(error instanceof Error ? error.message : 'Aily 授权断开失败。');
    }
  };

  const changeAutoScan = async (enabled: boolean) => {
    const previous = autoScan.data;
    setAutoScan((current) => current.data ? { ...beginResource(current), data: { enabled } } : beginResource(current));
    setAutoScanMessage('正在保存自动扫描设置…');
    try {
      const updated = await api.put<RuntimeAutoScan>('/api/runtime/auto-scan', { enabled });
      setAutoScan(successResource(updated));
      setAutoScanMessage(enabled ? '已开启每 20 分钟自动扫描新任务。' : '已关闭每 20 分钟自动扫描；手动扫描不受影响。');
    } catch (error) {
      setAutoScan((current) => failureResource({ ...current, data: previous }, error instanceof Error ? error.message : '自动扫描设置保存失败。'));
      setAutoScanMessage(error instanceof Error ? error.message : '自动扫描设置保存失败。');
    }
  };

  const saveCursor = async () => {
    try {
      const updated = await api.put<IntakeCursor>('/api/runtime/intake-cursor', { window_end: toIso(cursorInput) });
      setCursor(successResource(updated));
      setCursorInput(toDateTimeLocal(updated.window_end));
      setCursorMessage('入库窗口游标已推进。');
    } catch (error) {
      setCursorMessage(error instanceof Error ? error.message : '入库窗口游标保存失败。');
    }
  };

  const shutdown = async () => {
    if (runtimeState === 'pending') return;
    setRuntimeState('pending');
    setRuntimeMessage('正在退出本机任务库后台…');
    try {
      await api.post('/api/runtime/shutdown', {});
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      try {
        await api.get('/api/health');
        setRuntimeState('warning');
        setRuntimeMessage('4310 仍在，可能是其它进程，当前按钮关不掉它');
      } catch {
        setRuntimeState('idle');
        setRuntimeMessage('后台已退出，请关闭此标签页');
        setRuntimeExited(true);
      }
    } catch (error) {
      setRuntimeState('error');
      setRuntimeMessage(error instanceof Error ? error.message : '退出本机任务库后台失败。');
    }
  };

  const restart = async () => {
    if (runtimeState === 'pending') return;
    setRuntimeState('pending');
    setRuntimeMessage('正在重启本机任务库后台…');
    try {
      await api.post('/api/runtime/restart', {});
      setRuntimeState('idle');
      setRuntimeMessage('后台已重启，本页可继续使用。');
    } catch (error) {
      setRuntimeState('error');
      setRuntimeMessage(error instanceof Error ? error.message : '重启本机任务库后台失败。');
    }
  };

  const seedCandidate = async () => {
    if (seedState === 'pending') return;
    setSeedState('pending');
    setSeedMessage('正在生成测试用模拟需求…');
    try {
      await api.post('/api/dev/seed-intake', {
        title: '浏览器测试用的模拟需求',
        describe: '请核对候选收件箱是否能接收新内容。',
        background: '用于验证浏览器候选页能够接收一条测试需求。',
      });
      setSeedState('success');
      setSeedMessage('模拟需求已加入候选收件箱。');
    } catch (error) {
      setSeedState('error');
      setSeedMessage(error instanceof Error ? error.message : '模拟需求添加失败。');
    }
  };

  if (runtimeExited) {
    return <div className="runtime-exited-overlay" role="status" aria-live="polite"><div className="runtime-exited-card"><Power size={24} /><h1>后台已退出，请关闭此标签页</h1></div></div>;
  }

  return (
    <div className="page settings-page">
      <div className="page-header"><div><h1>任务台设置</h1><p><Activity size={16} />管理本机自动入库、窗口游标和后台进程。</p></div></div>

      <HealthStatusPanel resource={health} onRetry={() => void load()} />

      <section className="integration-section" aria-labelledby="aily-title">
        <div className="integration-heading">
          <span className="integration-icon"><Bot size={19} /></span>
          <div>
            <h2 id="aily-title">Aily 连接</h2>
            <span>TooManyTasks 独立保存应用凭证和用户 OAuth Token，并通过官方 SDK 调用 Aily。</span>
          </div>
          <span className={`connection-state ${aily?.authStatus === 'connected' ? 'connected' : ''}`}>
            {aily?.authStatus === 'connected' ? '已连接' : aily?.authStatus === 'expired' ? '需要重连' : aily?.authStatus === 'not_configured' ? '待配置' : '未连接'}
          </span>
        </div>
        <div className="settings-fields">
          <label><span>App ID</span><input value={ailyForm.appId} spellCheck={false} onChange={(event) => setAilyForm((current) => ({ ...current, appId: event.target.value }))} /></label>
          <label><span>App Secret</span><input type="password" value={ailyForm.appSecret} placeholder={aily?.appSecretSaved ? '已安全保存；留空保持不变' : '输入飞书自建应用 App Secret'} onChange={(event) => setAilyForm((current) => ({ ...current, appSecret: event.target.value }))} /></label>
          <label><span>Agent ID</span><input value={ailyForm.agentId} spellCheck={false} onChange={(event) => setAilyForm((current) => ({ ...current, agentId: event.target.value }))} /></label>
          <label><span>飞书域</span><select value={ailyForm.domain} onChange={(event) => setAilyForm((current) => ({ ...current, domain: event.target.value as 'feishu' | 'lark' }))}><option value="feishu">飞书</option><option value="lark">Lark</option></select></label>
          <label className="field-wide"><span>OAuth 回调地址</span><input value={ailyForm.oauthRedirectUri} spellCheck={false} onChange={(event) => setAilyForm((current) => ({ ...current, oauthRedirectUri: event.target.value }))} /></label>
        </div>
        <p className="integration-note">授权范围由 TooManyTasks 配置管理。访问 Token 和 refresh token 只进入本机加密凭证库，不会交给 Cindy 插件。</p>
        {aily?.grantedScopes.length ? <p className="integration-note">已授权 {aily.grantedScopes.length} 项权限；Token 到期时间：{aily.expiresAt ? new Date(aily.expiresAt).toLocaleString('zh-CN') : '由飞书返回决定'}。</p> : null}
        <div className="settings-actions">
          <button className="secondary-button" type="button" disabled={ailyState === 'pending'} onClick={() => void saveAilyConfig()}><RefreshCw size={15} />保存应用配置</button>
          <button className="primary-button" type="button" disabled={ailyState === 'pending' || !aily?.appSecretSaved} onClick={() => void connectAily()}><Link size={15} />{aily?.connected ? '重新连接 Aily' : '连接 Aily'}</button>
          <button className="quiet-button" type="button" disabled={ailyState === 'pending' || !aily?.connected} onClick={() => void disconnectAily()}><Unplug size={15} />断开</button>
        </div>
        {ailyMessage && <p className="settings-feedback" role={ailyState === 'error' ? 'alert' : 'status'}>{ailyMessage}</p>}
      </section>

      <section className="integration-section auto-scan-card" aria-labelledby="auto-scan-title">
        <div className="integration-heading"><span className="integration-icon"><RefreshCw size={19} /></span><div><h2 id="auto-scan-title">定时扫描</h2><span>控制独立 TooManyTasks 每 20 分钟调用一次 Aily。</span></div></div>
        <label className="check-row connection-toggle"><input type="checkbox" aria-label="每 20 分钟自动扫描新任务" checked={Boolean(autoScan.data?.enabled)} disabled={!autoScan.data || autoScan.status === 'loading'} onChange={(event) => void changeAutoScan(event.target.checked)} /><span>每 20 分钟自动扫描新任务</span></label>
        <p className="integration-note">关闭后，定时触发不会跑扫描；手动「扫近10分钟」不受影响。</p>
        {autoScanMessage && <p className="settings-feedback" role="status">{autoScanMessage}</p>}
      </section>

      <section className="integration-section" aria-labelledby="cursor-title">
        <div className="integration-heading"><span className="integration-icon"><RefreshCw size={19} /></span><div><h2 id="cursor-title">入库窗口游标</h2><span>下一次扫描从上次成功结束时间继续。</span></div></div>
        <label className="settings-fields"><span>窗口结束时间</span><input type="datetime-local" value={cursorInput} onChange={(event) => setCursorInput(event.target.value)} /></label>
        <div className="settings-actions"><button className="secondary-button" type="button" disabled={!cursorInput || cursor.status === 'loading'} onClick={() => void saveCursor()}>保存游标</button>{cursor.data?.window_end && <span>当前：{new Date(cursor.data.window_end).toLocaleString('zh-CN')}</span>}</div>
        {cursorMessage && <p className="settings-feedback" role="status">{cursorMessage}</p>}
      </section>

      <section className="integration-section" aria-labelledby="seed-title">
        <div className="integration-heading"><span className="integration-icon"><Sparkles size={19} /></span><div><h2 id="seed-title">开发者测试入口</h2><span>只接受本机回环请求，写入一条 pending 候选，不创建正式任务。</span></div></div>
        <button className="secondary-button" type="button" disabled={seedState === 'pending'} onClick={() => void seedCandidate()}>{seedState === 'pending' ? '生成中…' : '生成测试用模拟需求'}</button>
        {seedMessage && <p className="settings-feedback" role={seedState === 'error' ? 'alert' : 'status'}>{seedMessage}</p>}
      </section>

      <details open className="settings-disclosure settings-danger-zone runtime-shutdown-panel">
        <summary><span>本机后台进程</span><small>退出或重启 4310；接口仅接受 loopback。</small></summary>
        <div className="settings-disclosure-content">
          <div className="settings-actions danger-actions"><button className="danger-text-button" type="button" disabled={runtimeState === 'pending' || runtimeState === 'warning'} onClick={() => void shutdown()}><Power size={15} />{runtimeState === 'pending' ? '处理中…' : '退出本机任务库后台'}</button><button className="quiet-button" type="button" disabled={runtimeState === 'pending'} onClick={() => void restart()}><RefreshCw size={15} className={runtimeState === 'pending' ? 'spin' : undefined} />重启本机任务库后台</button></div>
          {runtimeMessage && <p className="settings-feedback" role={runtimeState === 'error' ? 'alert' : 'status'}>{runtimeMessage}</p>}
        </div>
      </details>
    </div>
  );
}
