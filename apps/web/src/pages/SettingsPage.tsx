import { useCallback, useEffect, useRef, useState } from 'react';
import { AtSign, Bot, BrainCircuit, CalendarDays, CheckCircle2, FileText, FlaskConical, FolderOpen, KeyRound, MessageCircle, Power, RefreshCw, ShieldCheck, Sparkles, Trash2, UserRound } from 'lucide-react';
import { api, ApiRequestError } from '../api';
import { AsyncState } from '../components/AsyncState';
import { desktopBridge, type DesktopConfigInput, type PublicDesktopConfig } from '../desktop';
import { FeishuPermissionGuide } from '../components/FeishuPermissionGuide';
import { FeishuMonitoringScopePanel } from '../components/FeishuMonitoringScope';
import { PrivacyLifecyclePanel } from '../components/PrivacyLifecyclePanel';
import { FEISHU_OWNER_OAUTH_SCOPE_TEXT, missingOwnerScopes, parseScopeText } from '../feishu-permissions';
import { externalLinkFeedbackMessage, requestExternalLinkOpen } from '../external-links';
import type { AutomationPolicy } from '../types';
import { normalizeSyncOperation, shortDiagnosticId, syncOutcomeLabel, syncOutcomeSummary, syncOutcomeTone, syncSourceLabel, type SyncOperation } from '../sync-outcome';
import { normalizeHealth, type HealthSnapshot } from '../observability';
import { HealthStatusPanel } from '../components/HealthStatusPanel';
import { beginResource, beginResourceRequest, failureResource, isLatestResourceRequest, loadingResource, successResource, type ResourceRequest, type ResourceState } from '../resource-state';
import type { HealthDto, IntegrationHealthDto } from '../types';

type Integration = { id: string; name: string; adapter: string; status: string; fields: string[] };
type Configuration = { liveConnectionsEnabled: boolean; notice: string; integrations: Integration[] };
type IntegrationHealth = IntegrationHealthDto;
type HealthResponse = HealthDto;
type RuntimeAutoScan = { enabled: boolean };
type OwnerInformation = {
  owner: null | {
    name: string;
    oauthStatus: string;
    configuredScopes: string[];
    lastSyncedAt: string | null;
    updatedAt: string;
  };
  sources: Array<{
    kind: 'owner_dm' | 'owner_mentions' | 'calendar' | 'minutes' | 'bot_supplement';
    enabled: boolean;
    status: string;
    scopeSummary: string;
    requiresAdmin: boolean;
    requiresBotInChat: boolean;
    syncMode: string;
    lastSuccessAt: string | null;
    issue: null | {
      code: 'authorization_required' | 'admin_approval_required' | 'platform_unsupported' | 'partial_access' | 'sync_failed';
      message: string;
    };
    updatedAt?: string;
  }>;
};

const sourceIcons = { owner_dm: MessageCircle, owner_mentions: AtSign, calendar: CalendarDays, minutes: FileText, bot_supplement: Bot };
const sourceNames = { owner_dm: '我的普通私聊', owner_mentions: '群聊中 @我', calendar: '我的日历', minutes: '会议纪要与妙记', bot_supplement: '机器人补充入口' };
const sourceStatusNames: Record<string, string> = {
  mock_ready: '本地 Mock 可用',
  ready: '已支持',
  partial: '只能读取部分范围',
  unauthorized: '尚未授权',
  admin_required: '需要管理员批准',
  unsupported: '平台暂不支持',
  error: '最近同步失败',
};
const healthStatusNames: Record<string, string> = {
  ready: '健康',
  mock_ready: '本地 Mock 健康',
  partial: '部分可用',
  unauthorized: '未授权',
  admin_required: '需要管理员批准',
  not_configured: '未配置',
  error: '最近检查失败',
};
function formatTimestamp(value: string | null | undefined) {
  if (!value) return '暂无记录';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '时间未知' : parsed.toLocaleString('zh-CN');
}

function syncCountsText(counts: Record<string, number>) {
  const labels: Record<string, string> = { messages: '消息', events: '事件', minutes: '纪要', documents: '文档', failures: '失败项', detailFailures: '细节失败' };
  const items = Object.entries(counts).filter(([, value]) => value > 0).map(([key, value]) => `${labels[key] ?? '计数'} ${value}`);
  return items.length ? items.join(' · ') : '没有可展示的来源计数';
}

export default function SettingsPage() {
  const [configurationResource, setConfigurationResource] = useState<ResourceState<Configuration>>(loadingResource);
  const [ownerInformationResource, setOwnerInformationResource] = useState<ResourceState<OwnerInformation>>(loadingResource);
  const [automationPolicyResource, setAutomationPolicyResource] = useState<ResourceState<AutomationPolicy>>(loadingResource);
  const [integrationHealthResource, setIntegrationHealthResource] = useState<ResourceState<IntegrationHealth[]>>(loadingResource);
  const [healthResource, setHealthResource] = useState<ResourceState<HealthSnapshot>>(loadingResource);
  const [autoScanResource, setAutoScanResource] = useState<ResourceState<RuntimeAutoScan>>(loadingResource);
  const configurationGenerationRef = useRef({ current: 0 });
  const ownerInformationGenerationRef = useRef({ current: 0 });
  const automationPolicyGenerationRef = useRef({ current: 0 });
  const integrationHealthGenerationRef = useRef({ current: 0 });
  const healthGenerationRef = useRef({ current: 0 });
  const autoScanGenerationRef = useRef({ current: 0 });
  const syncGenerationRef = useRef({ current: 0 });
  const desktopConfigGenerationRef = useRef({ current: 0 });
  const [automationSaving, setAutomationSaving] = useState(false);
  const [autoScanSaving, setAutoScanSaving] = useState(false);
  const [autoScanMessage, setAutoScanMessage] = useState('');
  const [autoScanError, setAutoScanError] = useState(false);
  const [browserSeedState, setBrowserSeedState] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [browserSeedMessage, setBrowserSeedMessage] = useState('');
  const [desktopConfig, setDesktopConfig] = useState<PublicDesktopConfig | null>(null);
  const [savedDesktopConfig, setSavedDesktopConfig] = useState<PublicDesktopConfig | null>(null);
  const [secretInput, setSecretInput] = useState<DesktopConfigInput['secrets']>({});
  const [connectionMessage, setConnectionMessage] = useState('');
  const [connectionError, setConnectionError] = useState(false);
  const [connectionTarget, setConnectionTarget] = useState<'feishu' | 'llm' | 'workspace' | 'local'>('feishu');
  const [sourceSyncing, setSourceSyncing] = useState<Record<string, boolean>>({});
  const [syncResource, setSyncResource] = useState<ResourceState<SyncOperation>>(loadingResource);
  const [lastSyncAction, setLastSyncAction] = useState<{ kind: 'all' | 'source'; source?: OwnerInformation['sources'][number]['kind'] } | null>(null);
  const [listenerActionState, setListenerActionState] = useState<'start' | 'stop' | 'sync' | null>(null);
  const [runtimeShutdownState, setRuntimeShutdownState] = useState<'idle' | 'pending' | 'warning' | 'success' | 'error'>('idle');
  const [runtimeShutdownMessage, setRuntimeShutdownMessage] = useState('');
  const [runtimeRestartState, setRuntimeRestartState] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [runtimeRestartMessage, setRuntimeRestartMessage] = useState('');
  const [runtimeExited, setRuntimeExited] = useState(false);
  const listenerActionRef = useRef(false);
  const desktop = desktopBridge();
  const configuration = configurationResource.data;
  const ownerInformation = ownerInformationResource.data;
  const automationPolicy = automationPolicyResource.data;
  const loadSettings = useCallback(() => {
    const configurationRequest = beginResourceRequest(configurationGenerationRef.current);
    const ownerInformationRequest = beginResourceRequest(ownerInformationGenerationRef.current);
    const automationPolicyRequest = beginResourceRequest(automationPolicyGenerationRef.current);
    const integrationHealthRequest = beginResourceRequest(integrationHealthGenerationRef.current);
    const healthRequest = beginResourceRequest(healthGenerationRef.current);
    const autoScanRequest = beginResourceRequest(autoScanGenerationRef.current);
    const desktopConfigRequest = beginResourceRequest(desktopConfigGenerationRef.current);
    setConfigurationResource((current) => beginResource(current));
    setOwnerInformationResource((current) => beginResource(current));
    setAutomationPolicyResource((current) => beginResource(current));
    setIntegrationHealthResource(loadingResource<IntegrationHealth[]>());
    setHealthResource(loadingResource<HealthSnapshot>());
    setAutoScanResource((current) => beginResource(current));
    const ownerInformationPromise = desktop
      ? api.get<OwnerInformation>('/api/owner-information')
      : Promise.resolve<OwnerInformation>({ owner: null, sources: [] });
    void Promise.allSettled([
      api.get<Configuration>('/api/configuration'),
      ownerInformationPromise,
      api.get<AutomationPolicy>('/api/automation-policy'),
      api.get<IntegrationHealth[]>('/api/integrations/health'),
      api.get<HealthResponse>('/api/health'),
      api.get<RuntimeAutoScan>('/api/runtime/auto-scan'),
    ]).then(([configurationResult, ownerResult, automationResult, integrationHealthResult, healthResult, autoScanResult]) => {
      if (configurationResult.status === 'fulfilled') {
        if (isLatestResourceRequest(configurationGenerationRef.current, configurationRequest)) setConfigurationResource(successResource(configurationResult.value));
      } else if (isLatestResourceRequest(configurationGenerationRef.current, configurationRequest)) {
        setConfigurationResource((current) => failureResource(current, configurationResult.reason instanceof Error ? configurationResult.reason.message : '配置状态读取失败。'));
      }
      if (ownerResult.status === 'fulfilled') {
        if (isLatestResourceRequest(ownerInformationGenerationRef.current, ownerInformationRequest)) setOwnerInformationResource(successResource(ownerResult.value));
      } else if (isLatestResourceRequest(ownerInformationGenerationRef.current, ownerInformationRequest)) {
        setOwnerInformationResource((current) => failureResource(current, ownerResult.reason instanceof Error ? ownerResult.reason.message : '个人信息流状态读取失败。'));
      }
      if (automationResult.status === 'fulfilled') {
        if (isLatestResourceRequest(automationPolicyGenerationRef.current, automationPolicyRequest)) setAutomationPolicyResource(successResource(automationResult.value));
      } else if (isLatestResourceRequest(automationPolicyGenerationRef.current, automationPolicyRequest)) {
        setAutomationPolicyResource((current) => failureResource(current, automationResult.reason instanceof Error ? automationResult.reason.message : '自动维护设置读取失败。'));
      }
      if (integrationHealthResult.status === 'fulfilled') {
        if (isLatestResourceRequest(integrationHealthGenerationRef.current, integrationHealthRequest)) setIntegrationHealthResource(successResource(integrationHealthResult.value, integrationHealthResult.value.length === 0));
      } else if (isLatestResourceRequest(integrationHealthGenerationRef.current, integrationHealthRequest)) {
        setIntegrationHealthResource(failureResource(loadingResource<IntegrationHealth[]>(), integrationHealthResult.reason instanceof Error ? integrationHealthResult.reason.message : '连接健康状态读取失败。'));
      }
      if (healthResult.status === 'fulfilled') {
        if (isLatestResourceRequest(healthGenerationRef.current, healthRequest)) setHealthResource(successResource(normalizeHealth(healthResult.value)));
      } else if (isLatestResourceRequest(healthGenerationRef.current, healthRequest)) {
        setHealthResource(failureResource(loadingResource<HealthSnapshot>(), healthResult.reason instanceof Error ? healthResult.reason.message : '系统就绪状态读取失败。'));
      }
      if (autoScanResult.status === 'fulfilled') {
        if (isLatestResourceRequest(autoScanGenerationRef.current, autoScanRequest)) setAutoScanResource(successResource(autoScanResult.value));
      } else if (isLatestResourceRequest(autoScanGenerationRef.current, autoScanRequest)) {
        setAutoScanResource(failureResource(loadingResource<RuntimeAutoScan>(), autoScanResult.reason instanceof Error ? autoScanResult.reason.message : '自动扫描设置读取失败。'));
      }
    });
    if (desktop) desktop.config.get().then((config) => {
      if (isLatestResourceRequest(desktopConfigGenerationRef.current, desktopConfigRequest)) {
        setDesktopConfig(config);
        setSavedDesktopConfig(config);
      }
    }).catch(() => undefined);
  }, [desktop]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const readOwnerInformation = useCallback(async (request: ResourceRequest) => {
    try {
      const value = await api.get<OwnerInformation>('/api/owner-information');
      if (isLatestResourceRequest(ownerInformationGenerationRef.current, request)) {
        setOwnerInformationResource(successResource(value));
      }
      return value;
    } catch (reason) {
      if (isLatestResourceRequest(ownerInformationGenerationRef.current, request)) {
        setOwnerInformationResource((current) => failureResource(current, reason instanceof Error ? reason.message : '个人信息流状态读取失败。'));
      }
      throw reason;
    }
  }, []);

  const refreshOwnerInformation = useCallback(async () => {
    const request = beginResourceRequest(ownerInformationGenerationRef.current);
    setOwnerInformationResource((current) => beginResource(current));
    await readOwnerInformation(request).catch(() => undefined);
  }, [readOwnerInformation]);

  const saveDesktop = async (target: 'feishu' | 'llm' | 'local' | 'workspace') => {
    if (!desktop || !desktopConfig) return;
    setConnectionTarget(target);
    const saved = await desktop.config.save({ ...desktopConfig, secrets: secretInput });
    setDesktopConfig(saved);
    setSavedDesktopConfig(saved);
    setSecretInput({});
    setConnectionError(false);
    setConnectionMessage('配置已保存并加载；密钥只写入本机安全凭证存储。');
    return saved;
  };

  const shutdownRuntime = async () => {
    if (runtimeShutdownState === 'pending' || runtimeShutdownState === 'success') return;
    setRuntimeShutdownState('pending');
    setRuntimeShutdownMessage('正在退出本机任务库后台…');
    try {
      await api.post<{ message: string }>('/api/runtime/shutdown', {});
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      try {
        await api.get<HealthResponse>('/api/health');
        setRuntimeShutdownState('warning');
        setRuntimeShutdownMessage('4310 仍在，可能是其它进程，当前按钮关不掉它');
      } catch {
        setRuntimeShutdownState('success');
        setRuntimeShutdownMessage('后台已退出，请关闭此标签页');
        setRuntimeExited(true);
      }
    } catch (error) {
      setRuntimeShutdownState('error');
      setRuntimeShutdownMessage(error instanceof Error ? error.message : '退出本机任务库后台失败，请稍后重试。');
    }
  };

  const restartRuntime = async () => {
    if (runtimeRestartState === 'pending') return;
    setRuntimeRestartState('pending');
    setRuntimeRestartMessage('正在重启本机任务库后台…');
    try {
      await api.post<{ message: string }>('/api/runtime/restart', {});
      setRuntimeRestartState('success');
      setRuntimeRestartMessage('后台已重启，本页可继续用。');
    } catch (error) {
      setRuntimeRestartState('error');
      setRuntimeRestartMessage(error instanceof Error ? error.message : '重启本机任务库后台失败，请稍后重试。');
    }
  };

  const addWorkspaceDirectory = async () => {
    if (!desktop || !desktopConfig) return;
    setConnectionTarget('workspace');
    const selected = await desktop.workspace.pickDirectory();
    if (!selected || desktopConfig.workspace.allowedPaths.includes(selected)) return;
    const saved = await desktop.config.save({
      ...desktopConfig,
      workspace: { ...desktopConfig.workspace, readEnabled: true, allowedPaths: [...desktopConfig.workspace.allowedPaths, selected] },
      secrets: {},
    });
    setDesktopConfig(saved);
    setSavedDesktopConfig(saved);
    setConnectionError(false);
    setConnectionMessage('已加入只读目录白名单并加载。');
  };

  const removeWorkspaceDirectory = async (path: string) => {
    if (!desktop || !desktopConfig) return;
    setConnectionTarget('workspace');
    const saved = await desktop.config.save({
      ...desktopConfig,
      workspace: { ...desktopConfig.workspace, allowedPaths: desktopConfig.workspace.allowedPaths.filter((item) => item !== path) },
      secrets: {},
    });
    setDesktopConfig(saved);
    setSavedDesktopConfig(saved);
    setConnectionError(false);
    setConnectionMessage('已撤销目录白名单并加载。');
  };

  const check = async (key: 'feishu' | 'llm' | 'workspace') => {
    setConnectionTarget(key);
    setConnectionError(false);
    setConnectionMessage('正在检查…');
    try {
      const result = await api.post<{ message: string; ok: boolean }>(`/api/integrations/${key}/check`, {});
      setConnectionError(!result.ok);
      setConnectionMessage(`${key}：${result.message}`);
    } catch (error) {
      setConnectionError(true);
      setConnectionMessage(error instanceof Error ? error.message : '连接检查失败。');
    }
  };

  const authorizeFeishu = async () => {
    setConnectionTarget('feishu');
    const hasPendingFeishuSecretChange = Boolean(secretInput && ('feishuAppSecret' in secretInput || secretInput.clearFeishuAppSecret));
    const hasPendingFeishuConfigChange = Boolean(desktopConfig && savedDesktopConfig && JSON.stringify(desktopConfig.feishu) !== JSON.stringify(savedDesktopConfig.feishu));
    if (desktopConfig && !savedDesktopConfig) {
      setConnectionError(true);
      setConnectionMessage('正在读取本机配置，请稍后再授权。');
      return;
    }
    const hasUsableSecret = Boolean(secretInput?.feishuAppSecret || (desktopConfig?.secretState.feishuAppSecret && !secretInput?.clearFeishuAppSecret));
    if (desktopConfig && (!desktopConfig.feishu.externalEnabled || !desktopConfig.feishu.appId.trim() || !hasUsableSecret)) {
      setConnectionError(true);
      setConnectionMessage('请先开启“允许真实飞书连接”，并填写 App ID 和 App Secret。');
      return;
    }
    setConnectionError(false);
    setConnectionMessage(hasPendingFeishuConfigChange || hasPendingFeishuSecretChange ? '正在保存当前飞书配置并生成授权地址…' : '正在生成飞书授权地址…');
    try {
      if (desktop) {
        if (desktopConfig && (hasPendingFeishuConfigChange || hasPendingFeishuSecretChange)) {
          const saved = await desktop.config.save({ ...desktopConfig, secrets: secretInput });
          setDesktopConfig(saved);
          setSavedDesktopConfig(saved);
          setSecretInput({});
        }
        const opened = await desktop.feishu.authorize();
        setConnectionError(!opened.opened);
        setConnectionMessage(opened.opened
          ? '当前配置已保存，并已打开飞书授权页面；请只使用最新打开的这一页。'
          : externalLinkFeedbackMessage(opened));
        return;
      }
      const result = await api.get<{ url: string }>('/api/integrations/feishu/oauth/url');
      const opened = await requestExternalLinkOpen({ url: result.url, purpose: 'feishu_oauth' }, { desktop: null });
      setConnectionError(!opened.opened);
      setConnectionMessage(opened.opened ? '已打开飞书授权页面；完成后回到本程序查看状态。' : externalLinkFeedbackMessage(opened));
    } catch (error) {
      setConnectionError(true);
      setConnectionMessage(error instanceof Error ? error.message : '无法打开飞书授权页面。');
    }
  };

  const refreshOwner = async () => {
    const request = beginResourceRequest(ownerInformationGenerationRef.current);
    setOwnerInformationResource((current) => beginResource(current));
    setConnectionTarget('feishu');
    setConnectionError(false);
    setConnectionMessage('正在读取系统主人身份…');
    try {
      const result = await api.post<OwnerInformation>('/api/integrations/feishu/owner/refresh', {});
      if (!isLatestResourceRequest(ownerInformationGenerationRef.current, request)) return;
      setOwnerInformationResource(successResource(result));
      setConnectionMessage(result.owner ? `已识别系统主人：${result.owner.name}` : '尚未识别系统主人。');
    } catch (error) {
      if (!isLatestResourceRequest(ownerInformationGenerationRef.current, request)) return;
      setConnectionError(true);
      setConnectionMessage(error instanceof Error ? error.message : '系统主人身份读取失败。');
      await readOwnerInformation(request).catch(() => undefined);
    }
  };

  const beginSyncAction = (action: { kind: 'all' | 'source'; source?: OwnerInformation['sources'][number]['kind'] }) => {
    const request = beginResourceRequest(syncGenerationRef.current);
      setSyncResource(loadingResource<SyncOperation>());
    setLastSyncAction(action);
    return request;
  };

  const settleSyncAction = (request: ResourceRequest, payload: unknown, errorMessage = '同步结果暂时无法确认。') => {
    if (!isLatestResourceRequest(syncGenerationRef.current, request)) return;
    const operation = normalizeSyncOperation(payload);
    if (operation.invalid) {
      setSyncResource(failureResource(loadingResource<SyncOperation>(), errorMessage));
    } else {
      setSyncResource(successResource(operation));
    }
  };

  const syncSource = async (kind: OwnerInformation['sources'][number]['kind']) => {
    const syncRequest = beginSyncAction({ kind: 'source', source: kind });
    const ownerRequest = beginResourceRequest(ownerInformationGenerationRef.current);
    setOwnerInformationResource((current) => beginResource(current));
    setSourceSyncing((current) => ({ ...current, [kind]: true }));
    setConnectionError(false);
    setConnectionTarget('feishu');
    try {
      const result = await api.post<unknown>(`/api/integrations/feishu/sources/${kind}/sync`, {});
      settleSyncAction(syncRequest, result);
      await readOwnerInformation(ownerRequest).catch(() => undefined);
    } catch (error) {
      const body = error && typeof error === 'object' && 'body' in error ? (error as { body?: unknown }).body : null;
      settleSyncAction(syncRequest, body, '个人信息流同步失败；请稍后重试。');
      await readOwnerInformation(ownerRequest).catch(() => undefined);
    } finally {
      setSourceSyncing((current) => ({ ...current, [kind]: false }));
    }
  };

  const listenerAction = async (action: 'start' | 'stop' | 'sync') => {
    if (listenerActionRef.current) return;
    listenerActionRef.current = true;
    const syncRequest = action === 'sync' ? beginSyncAction({ kind: 'all' }) : null;
    const ownerRequest = beginResourceRequest(ownerInformationGenerationRef.current);
    setOwnerInformationResource((current) => beginResource(current));
    setListenerActionState(action);
    setConnectionTarget('feishu');
    if (action !== 'sync') {
      setConnectionError(false);
      setConnectionMessage('正在处理…');
    }
    try {
      const result = await api.post<unknown>(`/api/integrations/feishu/${action === 'sync' ? 'sync' : `listener/${action}`}`, {});
      if (action === 'sync' && syncRequest) {
        settleSyncAction(syncRequest, result, '全部来源同步失败；请稍后重试。');
      } else if (action !== 'sync' && isLatestResourceRequest(ownerInformationGenerationRef.current, ownerRequest)) {
        setConnectionMessage(action === 'start' ? '个人信息流与补充入口已启动。' : '个人信息流与补充入口已停止。');
      }
    } catch (error) {
      if (action === 'sync' && syncRequest) {
        const body = error && typeof error === 'object' && 'body' in error ? (error as { body?: unknown }).body : null;
        settleSyncAction(syncRequest, body, '全部来源同步失败；请稍后重试。');
      } else if (action !== 'sync' && isLatestResourceRequest(ownerInformationGenerationRef.current, ownerRequest)) {
        setConnectionError(true);
        setConnectionMessage(error instanceof Error ? error.message : '操作失败。');
      }
    } finally {
      await readOwnerInformation(ownerRequest).catch(() => undefined);
      listenerActionRef.current = false;
      setListenerActionState(null);
    }
  };

  const retryLastSync = () => {
    if (!lastSyncAction) return;
    if (lastSyncAction.kind === 'source' && lastSyncAction.source) void syncSource(lastSyncAction.source);
    if (lastSyncAction.kind === 'all') void listenerAction('sync');
  };

  const saveAndCheckModel = async () => {
    try {
      await saveDesktop('llm');
      await check('llm');
    } catch (error) {
      setConnectionTarget('llm');
      setConnectionError(true);
      setConnectionMessage(error instanceof Error ? error.message : '模型配置保存失败。');
    }
  };

  const clearStoredSecret = async (kind: 'feishu' | 'llm') => {
    if (!desktop || !desktopConfig) return;
    const label = kind === 'feishu' ? '飞书 App Secret' : '模型 API Key';
    if (!window.confirm(`确定清除本机保存的${label}吗？清除后对应连接会停止，任务和来源记录不会删除。`)) return;
    setConnectionTarget(kind);
    try {
      const saved = await desktop.config.save({
        ...desktopConfig,
        secrets: kind === 'feishu' ? { clearFeishuAppSecret: true } : { clearLlmApiKey: true },
      });
      setDesktopConfig(saved);
      setSavedDesktopConfig(saved);
      setSecretInput({});
      setConnectionError(false);
      setConnectionMessage(`${label}已从本机安全凭证存储中清除。`);
    } catch (error) {
      setConnectionError(true);
      setConnectionMessage(error instanceof Error ? error.message : '密钥清除失败。');
    }
  };

  const changeAutomationMode = async (mode: AutomationPolicy['mode']) => {
    const request = beginResourceRequest(automationPolicyGenerationRef.current);
    setAutomationPolicyResource((current) => beginResource(current));
    setAutomationSaving(true);
    setConnectionTarget('local');
    setConnectionError(false);
    setConnectionMessage('正在保存 AI 自动维护设置…');
    try {
      const updated = await api.patch<AutomationPolicy>('/api/automation-policy', { mode });
      if (!isLatestResourceRequest(automationPolicyGenerationRef.current, request)) return;
      setAutomationPolicyResource(successResource(updated));
      setConnectionMessage(mode === 'auto'
        ? '已启用 AI 自动维护本机任务；低置信度、推测时间和版本冲突仍会等待你确认。'
        : '已切换为仅建议；来源继续保存，但 AI 不再自动改正式任务。');
    } catch (error) {
      if (isLatestResourceRequest(automationPolicyGenerationRef.current, request)) {
        setAutomationPolicyResource((current) => failureResource(current, error instanceof Error ? error.message : '自动维护设置保存失败。'));
        setConnectionError(true);
        setConnectionMessage(error instanceof Error ? error.message : '自动维护设置保存失败。');
      }
    } finally {
      setAutomationSaving(false);
    }
  };

  const changeAutoScan = async (enabled: boolean) => {
    const request = beginResourceRequest(autoScanGenerationRef.current);
    const previous = autoScanResource.data;
    setAutoScanResource((current) => current.data ? { ...beginResource(current), data: { enabled } } : beginResource(current));
    setAutoScanSaving(true);
    setAutoScanError(false);
    setAutoScanMessage('正在保存自动扫描设置…');
    try {
      const updated = await api.put<RuntimeAutoScan>('/api/runtime/auto-scan', { enabled });
      if (!isLatestResourceRequest(autoScanGenerationRef.current, request)) return;
      setAutoScanResource(successResource(updated));
      setAutoScanMessage(enabled ? '已开启每 10 分钟自动扫描新任务。' : '已关闭每 10 分钟自动扫描；定时触发不会入库。');
    } catch (error) {
      if (isLatestResourceRequest(autoScanGenerationRef.current, request)) {
        const reason = error instanceof Error ? error.message : '自动扫描设置保存失败。';
        setAutoScanResource((current) => failureResource({ ...current, data: previous }, reason));
        setAutoScanError(true);
        setAutoScanMessage(reason);
      }
    } finally {
      if (isLatestResourceRequest(autoScanGenerationRef.current, request)) setAutoScanSaving(false);
    }
  };

  const seedBrowserCandidate = async () => {
    if (desktop || browserSeedState === 'pending') return;
    const occurredAt = new Date().toISOString();
    const seedPayload = {
      title: '浏览器测试用的模拟需求',
      describe: '请核对候选收件箱是否能接收新内容。',
      background: '用于验证浏览器候选页能够接收一条测试需求。',
    };
    setBrowserSeedState('pending');
    setBrowserSeedMessage('正在生成测试用模拟需求…');
    try {
      try {
        await api.post('/api/dev/seed-intake', seedPayload);
      } catch (reason) {
        if (!(reason instanceof ApiRequestError) || reason.status !== 404) throw reason;
        await api.post('/api/corrections', {
          correctionType: 'missed_request',
          idempotencyKey: `browser-seed:${Date.now()}`,
          manualContent: `${seedPayload.title}：${seedPayload.describe}`,
          manualSenderName: '浏览器测试需求方',
          manualOccurredAt: occurredAt,
        });
      }
      setBrowserSeedState('success');
      setBrowserSeedMessage('模拟需求已加入候选收件箱。');
    } catch (reason) {
      setBrowserSeedState('error');
      setBrowserSeedMessage(reason instanceof Error ? reason.message : '模拟需求添加失败，请稍后重试。');
    }
  };

  const primarySources = ownerInformation?.sources.filter((source) => source.kind !== 'bot_supplement') ?? [];
  const usablePrimarySources = primarySources.filter((source) => source.status === 'ready' || source.status === 'mock_ready' || source.status === 'partial').length;
  const platformLimitedPrimarySources = primarySources.filter((source) => source.status === 'unsupported').length;
  const botSupplement = ownerInformation?.sources.find((source) => source.kind === 'bot_supplement');
  const primarySourcesReady = Boolean(ownerInformation && primarySources.length > 0 && usablePrimarySources + platformLimitedPrimarySources === primarySources.length);
  const ownerAuthorized = ownerInformation?.owner?.oauthStatus === 'authorized';
  const llmIntegration = configuration?.integrations.find((integration) => integration.id === 'llm');
  const integrationHealth = integrationHealthResource.data ?? [];
  const healthByIntegration = new Map(integrationHealth.map((item) => [item.integration, item]));
  const feishuHealth = healthByIntegration.get('feishu');
  const modelHealth = healthByIntegration.get('llm');
  const modelConfigured = llmIntegration?.status === 'configured' || llmIntegration?.status === 'mock_ready' || llmIntegration?.status === 'ready' || llmIntegration?.status === 'local_ready';
  const modelHealthy = modelHealth?.status === 'ready' || modelHealth?.status === 'mock_ready';
  const modelStatusText = configurationResource.status === 'error' ? '读取失败' : !configuration ? '正在读取' : !modelConfigured ? '未配置' : modelHealth ? healthStatusNames[modelHealth.status] ?? modelHealth.status : '已配置，待检查';
  const ownerStatusText = ownerInformationResource.status === 'error' ? '读取失败' : !ownerInformation ? '正在读取' : ownerAuthorized ? (feishuHealth ? `已授权 · ${healthStatusNames[feishuHealth.status] ?? feishuHealth.status}` : '已授权，待检查') : '待授权';
  const bulkSyncing = listenerActionState === 'sync';
  const anySourceSyncing = bulkSyncing || Object.values(sourceSyncing).some(Boolean);
  const requestedScopes = parseScopeText(desktopConfig?.feishu.oauthScopes ?? '');
  const grantedScopes = ownerInformation?.owner?.configuredScopes ?? [];
  const missingScopes = desktopConfig ? missingOwnerScopes(desktopConfig.feishu.oauthScopes, grantedScopes) : [];

  return (
    <div className="page settings-page">
      {runtimeExited && <div className="runtime-exited-overlay" role="status" aria-live="polite"><div className="runtime-exited-card"><Power size={24} /><h1>后台已退出，请关闭此标签页</h1></div></div>}
      <div className="page-header"><div><h1>集成设置</h1><p><KeyRound size={16} />先看连接状态，需要时再展开高级参数</p></div></div>
      <div className="settings-resource-states" aria-label="设置读取状态">
        <AsyncState resource={configurationResource} emptyText={null} errorTitle="配置状态读取失败" onRetry={loadSettings}>{null}</AsyncState>
        <AsyncState resource={ownerInformationResource} emptyText={null} errorTitle="个人信息流状态读取失败" onRetry={loadSettings}>{null}</AsyncState>
        <AsyncState resource={automationPolicyResource} emptyText={null} errorTitle="自动维护设置读取失败" onRetry={loadSettings}>{null}</AsyncState>
      </div>
      <section className="settings-overview" aria-labelledby="connection-overview-title">
        <div className="settings-overview-heading"><div><h2 id="connection-overview-title">连接总览</h2><p>{desktop ? '个人信息流是主入口；机器人只在受限场景下补充。' : '查看判断模型与本机服务状态。'}</p></div></div>
        <div className="settings-overview-body">
          <div className="settings-overview-items">
            {desktop && <div className="settings-overview-item"><span className="overview-icon"><MessageCircle size={18} /></span><div><strong>飞书</strong><span><i className={'status-dot ' + (ownerInformationResource.status === 'error' ? 'status-dot-danger' : !ownerInformation ? 'status-dot-muted' : !ownerAuthorized ? 'status-dot-warning' : feishuHealth && feishuHealth.status === 'ready' ? 'status-dot-safe' : 'status-dot-warning')} />{ownerStatusText}</span><small>{ownerInformationResource.status === 'error' ? '个人信息流状态读取失败，请重试' : !ownerInformation ? '正在读取主人授权状态' : feishuHealth ? `最近检查：${formatTimestamp(feishuHealth.checked_at)}` : ownerInformation.owner?.lastSyncedAt ? `上次同步：${formatTimestamp(ownerInformation.owner.lastSyncedAt)}` : '尚未完成主人同步'}</small></div></div>}
            <div className="settings-overview-item"><span className="overview-icon"><FlaskConical size={18} /></span><div><strong>判断模型</strong><span><i className={'status-dot ' + (!configuration ? 'status-dot-muted' : modelHealthy ? 'status-dot-safe' : 'status-dot-warning')} />{modelStatusText}</span><small>{!configuration ? '正在读取模型配置' : modelHealth ? `最近检查：${formatTimestamp(modelHealth.checked_at)}` : desktopConfig?.llm.model || '本地规则降级可用'}</small></div></div>
            {desktop && <div className="settings-overview-item"><span className="overview-icon"><UserRound size={18} /></span><div><strong>个人信息来源</strong><span><i className={'status-dot ' + (!ownerInformation ? 'status-dot-muted' : primarySourcesReady ? 'status-dot-safe' : 'status-dot-warning')} />{!ownerInformation ? '正在读取状态' : `${usablePrimarySources} 项可用或受限${platformLimitedPrimarySources ? ` · ${platformLimitedPrimarySources} 项平台限制` : ''}`}</span><small>{!ownerInformation ? '普通私聊、@我、日历和会议' : botSupplement?.enabled && ['ready', 'mock_ready'].includes(botSupplement.status) ? '机器人补充入口已启用' : '机器人补充入口未启用（可选）'}</small></div></div>}
          </div>
          {desktop && <button className="primary-button settings-sync-all" type="button" disabled={anySourceSyncing} onClick={() => void listenerAction('sync')}><RefreshCw size={15} className={bulkSyncing ? 'spin' : undefined} />{bulkSyncing ? '同步中…' : '同步全部'}</button>}
        </div>
      </section>
      <HealthStatusPanel resource={healthResource} onRetry={loadSettings} />
      <section className="integration-section integration-health-card" aria-labelledby="integration-health-title">
        <div className="integration-heading"><span className="integration-icon"><CheckCircle2 size={19} /></span><div><h2 id="integration-health-title">连接检查记录</h2><span>这是各适配器最近一次检查；它不替代系统 liveness / readiness。</span></div></div>
        <AsyncState resource={integrationHealthResource} emptyText="还没有连接检查记录；点击对应连接卡片中的检查按钮后，这里会显示结果。" loadingText="正在读取最近的连接检查…" errorTitle="连接健康读取失败" onRetry={loadSettings}>
          <div className="integration-health-list">
            {integrationHealthResource.data?.map((item) => <div className="integration-health-row" key={item.integration}><div><strong>{item.integration === 'llm' ? '判断模型' : item.integration === 'feishu' ? '飞书' : '只读工作区'}</strong><span>{item.message}</span></div><div><em className={'log-level log-' + item.status}>{healthStatusNames[item.status] ?? item.status}</em><small>{formatTimestamp(item.checked_at)}{item.latency_ms === null || item.latency_ms === undefined ? '' : ` · ${item.latency_ms} ms`}</small></div></div>)}
          </div>
        </AsyncState>
      </section>
      <section className="integration-section automation-policy-card" aria-labelledby="automation-policy-title">
        <div className="integration-heading">
          <span className="integration-icon"><BrainCircuit size={19} /></span>
          <div><h2 id="automation-policy-title">AI 如何维护我的任务</h2><span>只修改本机任务库记录；不会回复别人、执行任务或删除文件。</span></div>
          <span className={'connection-state ' + (automationPolicy?.mode === 'auto' ? 'connection-state-ready' : 'connection-state-warning')}>{automationPolicy?.mode === 'auto' ? '自动维护' : automationPolicy ? '仅建议' : '正在读取'}</span>
        </div>
        <div className="automation-mode-options" role="radiogroup" aria-label="AI 自动维护模式">
          <label className={automationPolicy?.mode === 'auto' ? 'automation-mode-option automation-mode-selected' : 'automation-mode-option'}>
            <input type="radio" name="automation-mode" value="auto" checked={automationPolicy?.mode === 'auto'} disabled={!automationPolicy || automationSaving} onChange={() => void changeAutomationMode('auto')} />
            <span><strong>自动维护（推荐）</strong><small>强关联且双重置信度达标时直接更新；每次都有通知、证据和版本保护。</small></span>
          </label>
          <label className={automationPolicy?.mode === 'suggest' ? 'automation-mode-option automation-mode-selected' : 'automation-mode-option'}>
            <input type="radio" name="automation-mode" value="suggest" checked={automationPolicy?.mode === 'suggest'} disabled={!automationPolicy || automationSaving} onChange={() => void changeAutomationMode('suggest')} />
            <span><strong>仅建议</strong><small>所有字段变化停在待确认；适合试运行或暂时关闭自动写入。</small></span>
          </label>
        </div>
        {automationPolicy && <p className="automation-policy-note">当前安全门槛：归属 {Math.round(automationPolicy.associationThreshold * 100)}% · 字段修改 {Math.round(automationPolicy.updateThreshold * 100)}%。完成/归档还需更高明确证据。</p>}
      </section>
      <section className="integration-section auto-scan-card" aria-labelledby="auto-scan-title">
        <div className="integration-heading">
          <span className="integration-icon"><RefreshCw size={19} /></span>
          <div><h2 id="auto-scan-title">定时扫描</h2><span>按固定间隔检查新的需求来源</span></div>
          <span className={'connection-state ' + (autoScanResource.data?.enabled ? 'connection-state-ready' : 'connection-state-warning')}>{autoScanResource.status === 'error' ? '读取失败' : autoScanResource.status === 'loading' && !autoScanResource.data ? '正在读取' : autoScanResource.data?.enabled ? '已开启' : '已关闭'}</span>
        </div>
        <AsyncState resource={autoScanResource} emptyText={null} loadingText="正在读取自动扫描设置…" errorTitle="自动扫描设置读取失败" onRetry={loadSettings}>
          <label className="check-row connection-toggle"><input type="checkbox" aria-label="每 10 分钟自动扫描新任务" checked={Boolean(autoScanResource.data?.enabled)} disabled={!autoScanResource.data || autoScanSaving} onChange={(event) => void changeAutoScan(event.target.checked)} /><span>每 10 分钟自动扫描新任务</span></label>
          <p className="integration-note">打开后还需在 Cindy 插件设置里保存过自动化；关闭后定时即使触发也不入库。手动扫描不受影响。</p>
          <p className="integration-note">入库扫描模型请到 Cindy 插件详情「AI 代办」里改：推荐折扣路由 <code>codex/gpt-5.6-luna</code>、思考强度 <code>high</code>、权限 <code>自动审核</code>。草稿默认可能是 <code>fable5</code>，改完要保存。</p>
          {autoScanMessage && <div className={autoScanError ? 'error-banner settings-feedback' : 'success-banner settings-feedback'} role={autoScanError ? 'alert' : 'status'}>{autoScanMessage}</div>}
        </AsyncState>
      </section>
      <div className="security-banner settings-security-banner"><ShieldCheck size={20} /><div><strong>安全边界</strong><span>{configurationResource.status === 'error' ? '配置状态读取失败，请点击上方“重试”；在确认配置前不要把连接状态当作最新结果。' : configuration?.notice ?? '正在读取配置状态…'}</span></div></div>
      <PrivacyLifecyclePanel />
      {desktop && <section className="integration-section owner-information-section">
        <div className="integration-heading">
          <span className="integration-icon"><UserRound size={19} /></span>
          <div><h2>我的个人信息流</h2><span>按人选择现有个人单聊、按群选择 @我 来源；日历和妙记继续独立增量同步。</span></div>
          <span className={'integration-status status-' + (ownerInformationResource.status === 'error' ? 'error' : !ownerInformation ? 'loading' : ownerInformation.owner ? 'local_ready' : 'not_configured')}>{ownerInformationResource.status === 'error' ? '读取失败' : !ownerInformation ? '正在读取' : ownerInformation.owner ? '已识别主人' : '等待授权'}</span>
        </div>
        <div className="owner-summary">
          <div><strong>{ownerInformationResource.status === 'error' ? '个人信息流状态读取失败' : ownerInformation?.owner?.name ?? '尚未取得系统主人身份'}</strong><span>{ownerInformationResource.status === 'error' ? '请点击上方“重试”；本次失败不代表没有个人信息流。' : ownerInformation?.owner ? `OAuth：${ownerInformation.owner.oauthStatus} · 最近同步：${ownerInformation.owner.lastSyncedAt ? new Date(ownerInformation.owner.lastSyncedAt).toLocaleString('zh-CN') : '尚未同步'}` : '完成飞书用户授权后，系统会读取你的身份并匹配群聊中的 @对象。'}</span></div>
          <button className="quiet-button" type="button" onClick={() => void refreshOwner()}><RefreshCw size={14} />重新读取身份</button>
        </div>
        <FeishuMonitoringScopePanel key={`${ownerInformation?.owner?.lastSyncedAt ?? 'no-owner'}:${ownerInformation?.owner?.updatedAt ?? 'never'}`} ownerAuthorized={ownerAuthorized} onScopeSaved={refreshOwnerInformation} />
        {syncResource.status === 'loading' && <div className="sync-result-panel sync-result-loading" role="status" aria-live="polite">正在同步{lastSyncAction?.kind === 'source' && lastSyncAction.source ? sourceNames[lastSyncAction.source] : '全部个人信息来源'}…较早请求的迟到响应不会覆盖新的结果。</div>}
        {syncResource.status === 'error' && <div className="sync-result-panel sync-result-error" role="alert"><strong>同步结果读取失败</strong><span>{syncResource.error ?? '同步结果暂时无法确认。'}</span><button className="quiet-button" type="button" onClick={retryLastSync}>重试本次同步</button></div>}
        {syncResource.data && <section className={`sync-result-panel sync-result-${syncOutcomeTone(syncResource.data.outcome)} ${syncOutcomeTone(syncResource.data.outcome) === 'error' ? 'error-banner' : syncOutcomeTone(syncResource.data.outcome) === 'warning' ? 'warning-banner' : 'success-banner'}`} aria-live="polite" aria-label="同步结果">
          <div className="sync-result-heading"><div><h3>同步结果：{syncOutcomeLabel(syncResource.data.outcome)}</h3><p>{syncOutcomeSummary(syncResource.data, lastSyncAction?.kind === 'source' && lastSyncAction.source ? sourceNames[lastSyncAction.source] : undefined)}</p></div><span className={`sync-result-badge sync-result-badge-${syncOutcomeTone(syncResource.data.outcome)}`}>{syncOutcomeLabel(syncResource.data.outcome)}</span></div>
          <div className="sync-result-meta"><span>耗时：{syncResource.data.duration_ms} ms</span><span>operation：{shortDiagnosticId(syncResource.data.operation_id)}</span><span>request：{shortDiagnosticId(syncResource.data.request_id)}</span><span>版本：{syncResource.data.release?.app_version ?? '未提供'}</span></div>
          {syncResource.data.sources.length > 0 && <div className="sync-source-list">{syncResource.data.sources.map((source) => <div className="sync-source-row" key={source.source}><div><strong>{syncSourceLabel(source.source)}</strong><span>{source.message}</span><small>{syncCountsText(source.counts)} · {source.duration_ms} ms{source.stale ? ' · 数据陈旧' : ''}{source.next_retry_at ? ` · 下次重试：${formatTimestamp(source.next_retry_at)}` : ''}</small></div><div><em className={`sync-result-badge sync-result-badge-${syncOutcomeTone(source.outcome)}`}>{syncOutcomeLabel(source.outcome)}</em>{source.error_code && <code>{source.error_code}</code>}</div></div>)}</div>}
          {syncResource.data.outcome !== 'success' && <button className="quiet-button" type="button" onClick={retryLastSync}>重试本次同步</button>}
        </section>}
        <div className="source-status-list">
          {ownerInformation?.sources.map((source) => {
            const Icon = sourceIcons[source.kind];
            const optionalBotDisabled = source.kind === 'bot_supplement' && !source.enabled;
            const statusTone = optionalBotDisabled
              ? 'status-dot-muted'
              : source.status === 'ready' || source.status === 'mock_ready'
              ? 'status-dot-safe'
              : source.status === 'error'
                ? 'status-dot-danger'
                : 'status-dot-warning';
            return <article className="source-status-row" key={source.kind}>
              <div className="source-status-main">
                <div className="source-status-name"><span className="source-icon"><Icon size={17} /></span><strong>{sourceNames[source.kind]}</strong></div>
                <div className="source-status-current"><span><i className={'status-dot ' + statusTone} />{optionalBotDisabled ? '未启用（可选）' : sourceStatusNames[source.status] ?? source.status}</span><small>{formatTimestamp(source.lastSuccessAt)}</small></div>
                <details className="source-status-details">
                  <summary>详情</summary>
                  <div><p>{source.scopeSummary}</p><span>同步方式：{source.syncMode}{source.requiresAdmin ? ' · 可能需管理员批准' : ''}{source.requiresBotInChat ? ' · 机器人必须在群内' : ''}</span><span>状态更新：{formatTimestamp(source.updatedAt)}</span>{source.kind === 'owner_dm' && <span>自动发现飞书实际返回的既有一对一会话，但默认不关注；请在上方逐个选择，或使用“关注所有人”。采用周期轮询，不承诺实时或覆盖 API 未返回的会话。</span>}{source.kind === 'owner_mentions' && <span>只读取上方明确选择的群，并仅把真实 @你的消息持久化；不要求机器人在群内。</span>}{source.issue && <em>{source.issue.message}</em>}</div>
                </details>
                <button className="quiet-button source-sync-button" type="button" disabled={bulkSyncing || Boolean(sourceSyncing[source.kind])} onClick={() => void syncSource(source.kind)}>
                  <RefreshCw size={14} className={sourceSyncing[source.kind] ? 'spin' : undefined} />
                  {sourceSyncing[source.kind] ? '同步中…' : '重新同步'}
                </button>
              </div>
            </article>;
          })}
          {!ownerInformation && <div className="source-status-loading">{ownerInformationResource.status === 'error' ? '个人信息流状态读取失败，请重试。' : '正在读取个人信息流状态…'}</div>}
        </div>
      </section>}
      {desktopConfig && <>
        <div className="connection-panel-grid">
          <section className="integration-section connection-panel">
            <div className="integration-heading"><span className="integration-icon"><KeyRound size={19} /></span><div><h2>飞书连接</h2><span>由企业自建应用提供 OAuth 和读取权限。</span></div><span className={'connection-state ' + (ownerAuthorized ? 'connection-state-ready' : 'connection-state-warning')}>{ownerAuthorized ? '已授权' : '待授权'}</span></div>
            <label className="check-row connection-toggle"><input type="checkbox" checked={desktopConfig.feishu.externalEnabled} onChange={(event) => setDesktopConfig({ ...desktopConfig, feishu: { ...desktopConfig.feishu, externalEnabled: event.target.checked } })} /><span>允许真实飞书连接</span></label>
            <div className="settings-fields settings-fields-compact">
              <label><span>飞书 App ID</span><input value={desktopConfig.feishu.appId} onChange={(event) => setDesktopConfig({ ...desktopConfig, feishu: { ...desktopConfig.feishu, appId: event.target.value } })} placeholder="cli_xxx" /></label>
              <label><span>飞书 App Secret</span><input type="password" placeholder={desktopConfig.secretState.feishuAppSecret ? '已保存；留空保持不变' : '只在本机加密保存'} value={secretInput?.feishuAppSecret ?? ''} onChange={(event) => setSecretInput({ ...secretInput, feishuAppSecret: event.target.value, clearFeishuAppSecret: false })} /></label>
              <label className="field-wide"><span>OAuth 回调地址</span><input value={desktopConfig.feishu.oauthRedirectUri} onChange={(event) => setDesktopConfig({ ...desktopConfig, feishu: { ...desktopConfig.feishu, oauthRedirectUri: event.target.value } })} /></label>
              <label className="field-wide"><span>OAuth 权限范围（空格分隔）</span><textarea className="scope-textarea" value={desktopConfig.feishu.oauthScopes} onChange={(event) => setDesktopConfig({ ...desktopConfig, feishu: { ...desktopConfig.feishu, oauthScopes: event.target.value } })} placeholder="先按下方指南申请权限，再填入 OAuth scope" /></label>
            </div>
            <div className="scope-summary">
              <span>当前请求 {requestedScopes.length} 项</span>
              <span>Token 已返回 {grantedScopes.length} 项</span>
              <span className={!requestedScopes.length || missingScopes.length ? 'scope-missing' : 'scope-ready'}>{!requestedScopes.length ? '尚未填写业务 scope' : ownerAuthorized ? (missingScopes.length ? `${missingScopes.length} 项尚未返回` : '当前请求均已返回') : '尚未取得授权结果'}</span>
              <button className="quiet-button" type="button" onClick={() => setDesktopConfig({ ...desktopConfig, feishu: { ...desktopConfig.feishu, oauthScopes: FEISHU_OWNER_OAUTH_SCOPE_TEXT } })}>填入推荐 scope</button>
            </div>
            {missingScopes.length > 0 && <details className="scope-missing-details"><summary>查看尚未返回的 scope</summary><code>{missingScopes.join('\n')}</code><p>可能尚未审批、尚未发布应用版本，或需要重新授权；程序无法仅凭 Token 区分具体环节。</p></details>}
            {desktopConfig.feishu.externalEnabled && !desktopConfig.feishu.oauthScopes.trim() && <div className="warning-banner connection-warning">Scope 为空时只能完成基础授权，个人私聊、@我、日历、妙记和文档背景仍不可读。</div>}
            {connectionMessage && connectionTarget === 'feishu' && <div className={connectionError ? 'error-banner connection-feedback' : 'success-banner connection-feedback'}>{connectionMessage}</div>}
            <div className="settings-actions connection-actions"><button className="primary-button" type="button" onClick={() => void authorizeFeishu()}>{ownerAuthorized ? '重新授权' : '保存并开始授权'}</button><button className="secondary-button" type="button" onClick={() => void check('feishu')}>检查连接</button><button className="quiet-button" type="button" onClick={() => void saveDesktop('feishu')}>仅保存</button></div>
          </section>

          <section className="integration-section connection-panel">
            <div className="integration-heading"><span className="integration-icon"><FlaskConical size={19} /></span><div><h2>判断模型</h2><span>只识别和整理候选；失败时来源仍保留。</span></div><span className={'connection-state ' + (modelHealthy ? 'connection-state-ready' : 'connection-state-warning')}>{modelStatusText}</span></div>
            <div className="settings-fields settings-fields-compact">
              <label><span>Provider</span><input value={desktopConfig.llm.provider} onChange={(event) => setDesktopConfig({ ...desktopConfig, llm: { ...desktopConfig.llm, provider: event.target.value } })} placeholder="deepseek" /></label>
              <label><span>Model</span><input value={desktopConfig.llm.model} onChange={(event) => setDesktopConfig({ ...desktopConfig, llm: { ...desktopConfig.llm, model: event.target.value } })} placeholder="deepseek-v4-flash" /></label>
              <label className="field-wide"><span>API Base</span><input value={desktopConfig.llm.apiBase} onChange={(event) => setDesktopConfig({ ...desktopConfig, llm: { ...desktopConfig.llm, apiBase: event.target.value } })} placeholder="https://api.deepseek.com" /></label>
              <label className="field-wide"><span>API Key</span><input type="password" placeholder={desktopConfig.secretState.llmApiKey ? '已保存；留空保持不变' : '只在本机加密保存'} value={secretInput?.llmApiKey ?? ''} onChange={(event) => setSecretInput({ ...secretInput, llmApiKey: event.target.value, clearLlmApiKey: false })} /></label>
            </div>
            <details className="panel-advanced"><summary>模型高级设置</summary><div className="settings-fields settings-fields-compact"><label><span>超时（毫秒）</span><input type="number" min="1000" value={desktopConfig.llm.timeoutMs} onChange={(event) => setDesktopConfig({ ...desktopConfig, llm: { ...desktopConfig.llm, timeoutMs: Number(event.target.value) || 30000 } })} /></label><label><span>最大重试次数</span><input type="number" min="0" max="5" value={desktopConfig.llm.maxRetries} onChange={(event) => setDesktopConfig({ ...desktopConfig, llm: { ...desktopConfig.llm, maxRetries: Number(event.target.value) || 0 } })} /></label><p className="integration-note field-wide">DeepSeek 直连填写 <code>deepseek</code>、模型名称和 <code>https://api.deepseek.com</code>；公司网关填写网关提供的精确别名和根地址，不要附加 <code>/chat/completions</code>。</p></div></details>
            {connectionMessage && connectionTarget === 'llm' && <div className={connectionError ? 'error-banner connection-feedback' : 'success-banner connection-feedback'}>{connectionMessage}</div>}
            <div className="settings-actions connection-actions"><button className="primary-button" type="button" onClick={() => void saveAndCheckModel()}>保存并检查模型</button><button className="quiet-button" type="button" onClick={() => void saveDesktop('llm')}>仅保存</button></div>
          </section>
        </div>

        {connectionMessage && (connectionTarget === 'workspace' || connectionTarget === 'local') && <div className={connectionError ? 'error-banner settings-feedback' : 'success-banner settings-feedback'}>{connectionMessage}</div>}

        <FeishuPermissionGuide onApplyOAuthScopes={(value) => setDesktopConfig({ ...desktopConfig, feishu: { ...desktopConfig.feishu, oauthScopes: value } })} />

        <details className="settings-disclosure">
          <summary><span>收件运行控制</span><small>仅用于诊断；应用启动后会自动运行</small></summary>
          <div className="settings-disclosure-content">
            <p className="integration-note">启动、停止只控制本次运行；日常使用不需要手动点击。修改飞书连接参数后请在上方保存或重新授权。</p>
            <div className="settings-actions"><button className="secondary-button" type="button" onClick={() => void listenerAction('start')}>启动收件</button><button className="quiet-button" type="button" onClick={() => void listenerAction('stop')}>停止收件</button><button className="quiet-button" type="button" onClick={() => void saveDesktop('feishu')}>保存高级设置</button></div>
          </div>
        </details>

        <details className="settings-disclosure">
          <summary><span>机器人补充入口</span><small>可选；只处理明确的补充群或转发</small></summary>
          <div className="settings-disclosure-content">
            <div className="settings-fields">
              <label className="field-wide"><span>补充需求群 ID（逗号分隔）</span><input value={desktopConfig.feishu.groupIds.join(',')} onChange={(event) => setDesktopConfig({ ...desktopConfig, feishu: { ...desktopConfig.feishu, groupIds: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) } })} placeholder="留空表示不使用机器人补充群" /></label>
              <label className="check-row"><input type="checkbox" checked={desktopConfig.feishu.scanEnabled} onChange={(event) => setDesktopConfig({ ...desktopConfig, feishu: { ...desktopConfig.feishu, scanEnabled: event.target.checked } })} /><span>开启补充群周期补漏</span></label>
              <label><span>扫描间隔（秒）</span><input type="number" min="30" value={desktopConfig.feishu.scanIntervalSeconds} onChange={(event) => setDesktopConfig({ ...desktopConfig, feishu: { ...desktopConfig.feishu, scanIntervalSeconds: Number(event.target.value) || 60 } })} /></label>
            </div>
            <div className="settings-actions"><button className="secondary-button" type="button" onClick={() => void saveDesktop('feishu')}>保存补充入口</button></div>
          </div>
        </details>

        <details className="settings-disclosure">
          <summary><span>本机与工作目录</span><small>日志保留和只读 reference path</small></summary>
          <div className="settings-disclosure-content">
            <div className="settings-fields">
              <label><span>日志保留天数</span><input type="number" min="1" max="365" value={desktopConfig.logRetentionDays} onChange={(event) => setDesktopConfig({ ...desktopConfig, logRetentionDays: Number(event.target.value) || 30 })} /></label>
              <label className="check-row"><input type="checkbox" checked={desktopConfig.workspace.readEnabled} onChange={(event) => setDesktopConfig({ ...desktopConfig, workspace: { ...desktopConfig.workspace, readEnabled: event.target.checked } })} /><span>允许只读查看已授权目录</span></label>
            </div>
            <div className="reference-allowlist">
              {desktopConfig.workspace.allowedPaths.map((path) => <div className="reference-allowlist-row" key={path}><code>{path}</code><button className="quiet-button" type="button" onClick={() => void removeWorkspaceDirectory(path)}><Trash2 size={14} />撤销</button></div>)}
              {!desktopConfig.workspace.allowedPaths.length && <p className="integration-note">还没有授权目录；系统不会扫描其他位置。</p>}
            </div>
            <div className="settings-actions"><button className="secondary-button" type="button" onClick={() => void addWorkspaceDirectory()}><FolderOpen size={15} />选择本地目录</button><button className="quiet-button" type="button" onClick={() => void saveDesktop('workspace')}>保存本机设置</button></div>
          </div>
        </details>

        <details className="settings-disclosure settings-danger-zone">
          <summary><span>危险操作</span><small>仅清除本机密钥，不删除任务和来源</small></summary>
          <div className="settings-disclosure-content danger-actions">
            {desktopConfig.secretState.feishuAppSecret && <button className="danger-text-button" type="button" onClick={() => void clearStoredSecret('feishu')}>清除飞书 Secret</button>}
            {desktopConfig.secretState.llmApiKey && <button className="danger-text-button" type="button" onClick={() => void clearStoredSecret('llm')}>清除模型 Key</button>}
            {!desktopConfig.secretState.feishuAppSecret && !desktopConfig.secretState.llmApiKey && <span className="integration-note">当前没有已保存的密钥。</span>}
          </div>
        </details>
      </>}
      {!desktop && <details className="settings-disclosure legacy-feishu-panel">
        <summary><span>遗留飞书接入</span><small>当前浏览器不提供旧版 OAuth</small></summary>
        <div className="settings-disclosure-content">
          <p className="integration-note">当前浏览器的飞书接入由 Cindy 的 XD Feishu 提供。旧版主人授权、个人或群聊选择、机器人补充配置仅保留在遗留说明中。</p>
        </div>
      </details>}
      <details open className="settings-disclosure settings-danger-zone runtime-shutdown-panel">
        <summary><span>退出后台进程</span><small>关闭本机任务库后台与 4310 端口</small></summary>
        <div className="settings-disclosure-content">
          <p className="integration-note">退出本机任务库后台后，当前浏览器页面会失去连接；任务数据仍保留在本机 SQLite 中。</p>
          {runtimeShutdownMessage && <div className={runtimeShutdownState === 'error' ? 'error-banner settings-feedback' : runtimeShutdownState === 'warning' ? 'warning-banner settings-feedback' : 'success-banner settings-feedback'} role={runtimeShutdownState === 'error' ? 'alert' : 'status'}>{runtimeShutdownMessage}</div>}
          {runtimeRestartMessage && <div className={runtimeRestartState === 'error' ? 'error-banner settings-feedback' : 'success-banner settings-feedback'} role={runtimeRestartState === 'error' ? 'alert' : 'status'}>{runtimeRestartMessage}</div>}
          <div className="settings-actions danger-actions"><button className="danger-text-button" type="button" disabled={runtimeShutdownState === 'pending' || runtimeShutdownState === 'success' || runtimeShutdownState === 'warning'} onClick={() => void shutdownRuntime()}><Power size={15} />{runtimeShutdownState === 'pending' ? '退出中…' : runtimeShutdownState === 'success' ? '后台已退出' : '退出本机任务库后台'}</button><button className="quiet-button" type="button" disabled={runtimeRestartState === 'pending'} onClick={() => void restartRuntime()}><RefreshCw size={15} className={runtimeRestartState === 'pending' ? 'spin' : undefined} />{runtimeRestartState === 'pending' ? '重启中…' : runtimeRestartState === 'success' ? '后台已重启' : '重启本机任务库后台'}</button></div>
        </div>
      </details>
      {!desktop && <details open className="settings-disclosure">
        <summary><span>开发者工具</span><small>仅用于浏览器测试</small></summary>
        <div className="settings-disclosure-content">
          <p className="integration-note">这里的模拟需求只用于验证候选收件箱；日常使用请回到 Cindy 说「扫近10分钟」。</p>
          <div className="settings-actions"><button className="secondary-button" type="button" disabled={browserSeedState === 'pending'} onClick={() => void seedBrowserCandidate()}><Sparkles size={15} />{browserSeedState === 'pending' ? '生成中…' : '模拟一条需求（浏览器测试）'}</button></div>
          {browserSeedMessage && <div className={browserSeedState === 'error' ? 'error-banner settings-feedback' : browserSeedState === 'pending' ? 'warning-banner settings-feedback' : 'success-banner settings-feedback'} role={browserSeedState === 'error' ? 'alert' : 'status'}>{browserSeedMessage}</div>}
        </div>
      </details>}
    </div>
  );
}
