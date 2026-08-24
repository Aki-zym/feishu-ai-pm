import { FormEvent, useState } from 'react';
import { Bot, CheckCircle2, KeyRound, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import { desktopBridge, type DesktopConfigInput, type PublicDesktopConfig } from '../desktop';
import { FeishuPermissionGuide } from '../components/FeishuPermissionGuide';

type Props = { initial: PublicDesktopConfig };

export default function SetupPage({ initial }: Props) {
  const [form, setForm] = useState<DesktopConfigInput>({ ...initial, secrets: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const persist = async (mockOnly: boolean) => {
    const desktop = desktopBridge();
    if (!desktop) return;
    setBusy(true);
    setError('');
    try {
      await desktop.config.save({
        ...form,
        setupComplete: true,
        feishu: mockOnly ? { ...form.feishu, externalEnabled: false, scanEnabled: false } : form.feishu,
        llm: mockOnly ? { ...form.llm, provider: 'rule_mock' } : { ...form.llm, provider: form.llm.provider.trim() || 'openai_compatible' },
      });
      await desktop.app.relaunch();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败。');
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void persist(false);
  };

  return (
    <main className="setup-page">
      <section className="setup-card">
        <div className="setup-heading">
          <span className="brand-mark"><Bot size={22} /></span>
          <div><span>首次启动</span><h1>配置 TooManyTasks</h1></div>
        </div>
        <div className="security-banner"><ShieldCheck size={20} /><div><strong>密钥只保存在这台电脑</strong><span>使用本机安全凭证存储加密，不会写入项目、日志或任务数据库。</span></div></div>
        <form onSubmit={submit} className="setup-form">
          <section className="setup-connection-panel">
            <div className="setup-section-title"><span className="setup-step-number">1</span><UserRound size={18} /><div><h2>连接我的飞书</h2><p>保存后到“集成设置”完成授权；现有个人私聊会自动发现并可按人排除，群聊仍按群名选择，无需填写 chat ID。</p></div></div>
            <label className="check-row setup-primary-toggle"><input type="checkbox" checked={form.feishu.externalEnabled} onChange={(event) => setForm((current) => ({ ...current, feishu: { ...current.feishu, externalEnabled: event.target.checked } }))} /><span>允许真实飞书连接</span></label>
            <div className="settings-fields settings-fields-compact">
              <label><span>App ID</span><input value={form.feishu.appId} onChange={(event) => setForm((current) => ({ ...current, feishu: { ...current.feishu, appId: event.target.value } }))} placeholder="cli_xxx" /></label>
              <label><span>App Secret</span><input type="password" value={form.secrets?.feishuAppSecret ?? ''} onChange={(event) => setForm((current) => ({ ...current, secrets: { ...current.secrets, feishuAppSecret: event.target.value } }))} placeholder={initial.secretState.feishuAppSecret ? '已安全保存；留空保持不变' : '输入后由本机安全存储加密'} /></label>
              <label className="field-wide"><span>OAuth 回调地址</span><input value={form.feishu.oauthRedirectUri} onChange={(event) => setForm((current) => ({ ...current, feishu: { ...current.feishu, oauthRedirectUri: event.target.value } }))} /></label>
              <label className="field-wide"><span>OAuth 权限范围（空格分隔）</span><textarea className="scope-textarea" value={form.feishu.oauthScopes} onChange={(event) => setForm((current) => ({ ...current, feishu: { ...current.feishu, oauthScopes: event.target.value } }))} placeholder="先按下方指南申请权限，再填入 OAuth scope" /></label>
            </div>
            {form.feishu.externalEnabled && !form.feishu.oauthScopes.trim() && <div className="warning-banner">Scope 为空时只能完成基础授权，个人私聊、@我、日历、妙记和文档背景仍不可读。</div>}
            <details className="setup-advanced"><summary>机器人补充入口（可选）</summary><div className="settings-fields settings-fields-compact"><label className="field-wide"><span>机器人补充群 ID（可选）</span><input value={form.feishu.groupIds.join(',')} onChange={(event) => setForm((current) => ({ ...current, feishu: { ...current.feishu, groupIds: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) } }))} placeholder="留空表示不使用机器人补充群" /></label><label className="check-row"><input type="checkbox" checked={form.feishu.scanEnabled} onChange={(event) => setForm((current) => ({ ...current, feishu: { ...current.feishu, scanEnabled: event.target.checked } }))} /><span>开启补充群周期补漏</span></label><label><span>扫描间隔（秒）</span><input type="number" min="30" value={form.feishu.scanIntervalSeconds} onChange={(event) => setForm((current) => ({ ...current, feishu: { ...current.feishu, scanIntervalSeconds: Number(event.target.value) || 60 } }))} /></label></div></details>
          </section>

          <FeishuPermissionGuide onApplyOAuthScopes={(value) => setForm((current) => ({ ...current, feishu: { ...current.feishu, oauthScopes: value } }))} />

          <section className="setup-connection-panel">
            <div className="setup-section-title"><span className="setup-step-number">2</span><Sparkles size={18} /><div><h2>连接判断模型</h2><p>DeepSeek 直连或公司的 OpenAI-compatible 网关都可以；模型失败时仍保留来源。</p></div></div>
            <div className="settings-fields settings-fields-compact">
              <label><span>Provider</span><input value={form.llm.provider} onChange={(event) => setForm((current) => ({ ...current, llm: { ...current.llm, provider: event.target.value } }))} placeholder="deepseek" /></label>
              <label><span>Model</span><input value={form.llm.model} onChange={(event) => setForm((current) => ({ ...current, llm: { ...current.llm, model: event.target.value } }))} placeholder="deepseek-v4-flash" /></label>
              <label className="field-wide"><span>API Base</span><input value={form.llm.apiBase} onChange={(event) => setForm((current) => ({ ...current, llm: { ...current.llm, apiBase: event.target.value } }))} placeholder="https://api.deepseek.com" /></label>
              <label className="field-wide"><span>API Key</span><input type="password" value={form.secrets?.llmApiKey ?? ''} onChange={(event) => setForm((current) => ({ ...current, secrets: { ...current.secrets, llmApiKey: event.target.value } }))} placeholder={initial.secretState.llmApiKey ? '已安全保存；留空保持不变' : '输入后由本机安全存储加密'} /></label>
            </div>
            <details className="setup-advanced"><summary>模型高级设置</summary><div className="settings-fields settings-fields-compact"><label><span>超时（毫秒）</span><input type="number" min="1000" value={form.llm.timeoutMs} onChange={(event) => setForm((current) => ({ ...current, llm: { ...current.llm, timeoutMs: Number(event.target.value) || 30000 } }))} /></label><label><span>最大重试次数</span><input type="number" min="0" max="5" value={form.llm.maxRetries} onChange={(event) => setForm((current) => ({ ...current, llm: { ...current.llm, maxRetries: Number(event.target.value) || 0 } }))} /></label></div></details>
          </section>

          <section className="setup-local-options"><div className="setup-section-title"><span className="setup-step-number">3</span><KeyRound size={18} /><div><h2>确认本机选项</h2><p>密钥只存本机；开机启动可随时在设置中修改。</p></div></div><label className="check-row"><input type="checkbox" checked={form.launchAtLogin} onChange={(event) => setForm((current) => ({ ...current, launchAtLogin: event.target.checked }))} /><span>开机后在托盘启动（默认关闭）</span></label></section>
          {error && <div className="error-banner">{error}</div>}
          <div className="setup-actions">
            <button className="primary-button" disabled={busy} type="submit"><CheckCircle2 size={16} />保存并进入连接检查</button>
            <button className="quiet-button" disabled={busy} type="button" onClick={() => void persist(true)}><KeyRound size={16} />先用安全模拟模式</button>
          </div>
        </form>
      </section>
    </main>
  );
}
