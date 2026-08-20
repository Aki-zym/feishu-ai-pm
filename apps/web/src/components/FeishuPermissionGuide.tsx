import { useState } from 'react';
import { Check, Clipboard, ExternalLink, FileJson2, KeyRound, ShieldCheck } from 'lucide-react';
import { FEISHU_BATCH_PERMISSION_JSON, FEISHU_OWNER_OAUTH_SCOPE_TEXT } from '../feishu-permissions';

type Props = {
  onApplyOAuthScopes?: (value: string) => void;
  defaultOpen?: boolean;
};

export function FeishuPermissionGuide({ onApplyOAuthScopes, defaultOpen = false }: Props) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(FEISHU_BATCH_PERMISSION_JSON);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return <details className="feishu-permission-guide" open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
    <summary>
      <span><ShieldCheck size={17} /><strong>飞书权限开通指南</strong></span>
      <small>图文步骤、批量导入 JSON 和 OAuth scope</small>
    </summary>
    <div className="permission-guide-body">
      <div className="permission-guide-copy">
        <h3>先在飞书开放平台开权限，再回到程序重新授权</h3>
        <ol>
          <li><span>1</span><div><strong>进入应用的“权限管理”</strong><p>开发者后台 → 选择当前企业自建应用 → 开发配置 → 权限管理。</p></div></li>
          <li><span>2</span><div><strong>点击“批量导入/导出权限”</strong><p>选择“导入”页签；已有权限不会被这次导入删除。</p></div></li>
          <li><span>3</span><div><strong>粘贴下面的 JSON 并申请</strong><p>确认新增权限，等待管理员审批；高级权限是否免审以当前租户为准。</p></div></li>
          <li><span>4</span><div><strong>发布应用版本并重新授权</strong><p>旧 user_access_token 不会自动扩权；发布后必须在数据 PM 重新授权一次。</p></div></li>
        </ol>
      </div>
      <div className="permission-guide-visual" role="img" aria-label="飞书开放平台权限管理与批量导入权限示意图">
        <div className="permission-visual-sidebar"><span>开发配置</span><strong><KeyRound size={15} />权限管理</strong><span>事件与回调</span><span>安全设置</span></div>
        <div className="permission-visual-modal">
          <div><strong>批量导入/导出权限</strong><span>×</span></div>
          <nav><b>导入</b><span>导出</span></nav>
          <pre><code>{'{'}<br />&nbsp;&nbsp;"scopes": {'{'}<br />&nbsp;&nbsp;&nbsp;&nbsp;"tenant": [...],<br />&nbsp;&nbsp;&nbsp;&nbsp;"user": [...]<br />&nbsp;&nbsp;{'}'}<br />{'}'}</code></pre>
          <button type="button" tabIndex={-1}>下一步，确认新增权限</button>
        </div>
      </div>
      <section className="permission-json-panel">
        <div><span><FileJson2 size={16} /><strong>可直接粘贴到“批量导入”的 JSON</strong></span><button className="secondary-button" type="button" onClick={() => void copyJson()}><Clipboard size={14} />{copyState === 'copied' ? '已复制' : '复制 JSON'}</button></div>
        <p className="permission-json-note">user 权限用于系统主人的个人信息流；tenant 权限只服务可选的机器人补充入口，可按公司审批要求删除该组后再导入。</p>
        <textarea aria-label="飞书批量导入权限 JSON" readOnly value={FEISHU_BATCH_PERMISSION_JSON} />
        {copyState === 'copied' && <p className="permission-copy-success"><Check size={14} />已复制；请粘贴到飞书开放平台的批量导入窗口。</p>}
        {copyState === 'failed' && <p className="permission-copy-error">浏览器未允许自动复制，请在文本框中全选后手动复制。</p>}
      </section>
      <section className="permission-oauth-panel">
        <div><strong>程序里的 OAuth scope（空格分隔）</strong><span>这与上面的 JSON 不是同一种文本。</span></div>
        <code>{FEISHU_OWNER_OAUTH_SCOPE_TEXT}</code>
        {onApplyOAuthScopes && <button className="quiet-button" type="button" onClick={() => onApplyOAuthScopes(FEISHU_OWNER_OAUTH_SCOPE_TEXT)}>填入程序的 OAuth scope</button>}
      </section>
      <div className="permission-guide-boundary"><ExternalLink size={15} /><span>Scope 只允许调用接口，不会让程序看到你原本无权访问的聊天或文档；审批、发布和重新授权缺一不可。</span></div>
    </div>
  </details>;
}
