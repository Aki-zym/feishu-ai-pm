import { useCallback, useEffect, useState } from 'react';
import { Download, KeyRound, ShieldAlert, Square, Trash2, Upload } from 'lucide-react';
import { api } from '../api';

type PrivacyStatus = {
  collectionStatus: 'running' | 'stopped';
  oauthStatus: string;
  retentionStatus: string;
  version: number;
  latestDeletion: { id: string; status: string; proofHash: string | null } | null;
  latestExport: { id: string; status: string; payloadHash: string | null } | null;
  latestBackup: { id: string; fileName: string; schemaVersion: number; sha256: string; status: string; createdAt: string; restoredAt: string | null } | null;
  platformRevocation: 'not_verified' | boolean;
};

type DeletionRequest = {
  deletionId: string;
  status: string;
  confirmationToken: string | null;
};

export function PrivacyLifecyclePanel() {
  const [status, setStatus] = useState<PrivacyStatus | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pendingDeletion, setPendingDeletion] = useState<DeletionRequest | null>(null);
  const [backupFileName, setBackupFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<PrivacyStatus>('/api/privacy/status'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '隐私状态读取失败。');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await operation();
      setMessage(success);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败；没有自动重试。');
    } finally {
      setBusy(false);
    }
  };

  const exportData = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.post<{ data: Record<string, unknown>; sha256: string }>('/api/privacy/export', {
        scope: 'all', format: 'json', idempotencyKey: `web-export-${Date.now()}`,
      });
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `privacy-export-${result.sha256.slice(0, 12)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      setMessage('已生成受控 JSON 导出；内容仍只在主人本机下载。');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导出失败。');
    } finally {
      setBusy(false);
    }
  };

  const requestDeletion = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.post<DeletionRequest>('/api/privacy/deletion/request', { idempotencyKey: `web-delete-${Date.now()}` });
      setPendingDeletion(result);
      setMessage('删除请求已创建。请确认范围后，再点击第二步完成硬删除。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除请求失败。');
    } finally {
      setBusy(false);
    }
  };

  const confirmDeletion = async () => {
    if (!pendingDeletion?.confirmationToken) return;
    await run(
      () => api.post('/api/privacy/deletion/confirm', {
        deletionId: pendingDeletion.deletionId,
        confirmationToken: pendingDeletion.confirmationToken,
        expectedVersion: status?.version,
      }),
      '硬删除已完成；系统只保留无内容删除证明和必要审计。',
    );
    setPendingDeletion(null);
  };

  const createBackup = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.post<{ fileName: string }>('/api/privacy/backup', {});
      setBackupFileName(result.fileName);
      setMessage('已创建并校验受管备份。');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '备份创建失败。');
    } finally {
      setBusy(false);
    }
  };

  const restoreBackup = async () => {
    const fileName = backupFileName ?? status?.latestBackup?.fileName;
    if (!fileName) return;
    await run(
      () => api.post('/api/privacy/backup/restore', { fileName, expectedVersion: status?.version }),
      '备份已通过校验并登记为待维护恢复；需要服务重启后替换当前库。',
    );
  };

  const lifecycleReady = status?.collectionStatus === 'stopped' && status.oauthStatus === 'revoked';

  return <section className="integration-section privacy-lifecycle-panel" aria-labelledby="privacy-lifecycle-title">
    <div className="integration-heading">
      <span className="integration-icon"><ShieldAlert size={19} /></span>
      <div><h2 id="privacy-lifecycle-title">隐私生命周期</h2><span>主人可见：停止采集、撤销本地授权、导出或二次确认硬删除。</span></div>
      <span className="integration-status status-local_ready">{status?.collectionStatus === 'running' ? '正在采集' : status?.collectionStatus === 'stopped' ? '已停止' : '读取中'}</span>
    </div>
    <div className="privacy-lifecycle-summary">
      <span>授权：{status?.oauthStatus ?? '读取中'}</span>
      <span>留存：{status?.retentionStatus ?? '读取中'}</span>
      <span>平台撤权：{status?.platformRevocation === 'not_verified' ? '未验证（需平台侧确认）' : status?.platformRevocation ? '已报告' : '未完成'}</span>
    </div>
    <p className="integration-note">软删除不等于硬删除；真实飞书撤权、平台备份残留和 Windows 文件锁仍需主人在真实环境中核验。</p>
    <div className="settings-actions privacy-lifecycle-actions">
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void run(() => api.post('/api/privacy/collection/stop', { expectedVersion: status?.version }), '已停止后续采集。')}><Square size={14} />停止采集</button>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void run(() => api.post('/api/privacy/revoke', { expectedVersion: status?.version }), '已撤销本地授权；平台侧撤权仍未验证。')}><KeyRound size={14} />撤销本地授权</button>
      <button className="secondary-button" type="button" disabled={busy || status?.collectionStatus !== 'stopped'} onClick={() => void exportData()}><Download size={14} />导出 JSON</button>
      <button className="quiet-button" type="button" disabled={busy} onClick={() => void createBackup()}><Upload size={14} />创建备份</button>
      <button className="quiet-button" type="button" disabled={busy || !(backupFileName ?? status?.latestBackup?.fileName)} onClick={() => void restoreBackup()}><Upload size={14} />登记恢复</button>
      <button className="quiet-button" type="button" disabled={busy || status?.retentionStatus === 'paused'} onClick={() => void run(() => api.post('/api/privacy/retention/run', { expectedVersion: status?.version }), '已按留存策略完成一次受控清理。')}><ShieldAlert size={14} />执行留存清理</button>
      <button className="danger-text-button" type="button" disabled={busy || Boolean(pendingDeletion) || !lifecycleReady} onClick={() => void requestDeletion()}><Trash2 size={14} />请求硬删除</button>
    </div>
    {pendingDeletion && <div className="warning-banner privacy-deletion-confirmation">
      <strong>第二步确认硬删除</strong><span>这会删除本地来源、任务、候选、索引、日志和缓存；只保留不含内容的删除证明。</span>
      <code>{pendingDeletion.confirmationToken}</code>
      <div className="settings-actions"><button className="danger-text-button" type="button" disabled={busy} onClick={() => void confirmDeletion()}>我确认永久删除本地数据</button><button className="quiet-button" type="button" disabled={busy} onClick={() => setPendingDeletion(null)}>取消</button></div>
    </div>}
    {message && <div className="success-banner settings-feedback">{message}</div>}
    {error && <div className="error-banner settings-feedback">{error}</div>}
  </section>;
}

export default PrivacyLifecyclePanel;
