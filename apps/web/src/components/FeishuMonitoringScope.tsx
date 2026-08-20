import { useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Check, MessageCircle, RefreshCw, Search, UsersRound } from 'lucide-react';
import { api } from '../api';
import { beginResourceRequest, isLatestResourceRequest } from '../resource-state';
import type { FeishuMonitoringScope, FeishuMonitorTarget } from '../types';

type Props = {
  ownerAuthorized: boolean;
  onScopeSaved?: () => void | Promise<void>;
};

const accessLabels: Record<FeishuMonitorTarget['accessStatus'], string> = {
  readable: '可读取',
  unknown: '待实际读取确认',
  restricted: '权限受限',
  not_found: '未找到现有单聊',
  error: '最近读取失败',
};

function mergeTargets(current: FeishuMonitorTarget[], incoming: FeishuMonitorTarget[]) {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

export function FeishuMonitoringScopePanel({ ownerAuthorized, onScopeSaved }: Props) {
  const [scope, setScope] = useState<FeishuMonitoringScope | null>(null);
  const [personIds, setPersonIds] = useState<Set<string>>(new Set());
  const [savedPersonIds, setSavedPersonIds] = useState<Set<string>>(new Set());
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set());
  const [personQuery, setPersonQuery] = useState('');
  const [groupQuery, setGroupQuery] = useState('');
  const [busy, setBusy] = useState<'load' | 'refresh' | 'search' | 'follow_all' | 'save' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const scopeGenerationRef = useRef({ current: 0 });

  const applyScope = (value: FeishuMonitoringScope) => {
    const selectedPeople = new Set(value.people.filter((item) => item.selected).map((item) => item.id));
    setScope(value);
    setPersonIds(selectedPeople);
    setSavedPersonIds(new Set(selectedPeople));
    setGroupIds(new Set(value.groups.filter((item) => item.selected).map((item) => item.id)));
  };

  useEffect(() => {
    const request = beginResourceRequest(scopeGenerationRef.current);
    let active = true;
    setBusy('load');
    api.get<FeishuMonitoringScope>('/api/integrations/feishu/monitoring-scope')
      .then((value) => { if (active && isLatestResourceRequest(scopeGenerationRef.current, request)) applyScope(value); })
      .catch((reason) => {
        if (!active || !isLatestResourceRequest(scopeGenerationRef.current, request)) return;
        setError(true);
        setMessage(reason instanceof Error ? reason.message : '无法读取监控范围。');
      })
      .finally(() => { if (active && isLatestResourceRequest(scopeGenerationRef.current, request)) setBusy(null); });
    return () => { active = false; };
  }, [ownerAuthorized]);

  const visibleGroups = useMemo(() => {
    const query = groupQuery.trim().toLocaleLowerCase('zh-CN');
    if (!query) return scope?.groups ?? [];
    return (scope?.groups ?? []).filter((item) => `${item.name} ${item.secondaryLabel ?? ''}`.toLocaleLowerCase('zh-CN').includes(query));
  }, [groupQuery, scope?.groups]);

  const selectedPeople = personIds.size;
  const selectedGroups = groupIds.size;
  const savedPeople = scope?.selectedPersonCount ?? 0;
  const savedGroups = scope?.selectedGroupCount ?? 0;
  const dirty = selectedPeople !== savedPeople
    || selectedGroups !== savedGroups
    || (scope?.people.some((item) => item.selected !== personIds.has(item.id)) ?? false)
    || (scope?.groups.some((item) => item.selected !== groupIds.has(item.id)) ?? false);

  const refreshOptions = async () => {
    const request = beginResourceRequest(scopeGenerationRef.current);
    setBusy('refresh');
    setError(false);
    setMessage('正在从飞书刷新最近私聊和主人所在群…');
    try {
      const value = await api.post<FeishuMonitoringScope>('/api/integrations/feishu/monitoring-scope/refresh', {});
      if (!isLatestResourceRequest(scopeGenerationRef.current, request)) return;
      applyScope(value);
      setMessage(`已发现 ${value.people.length} 个现有个人单聊；新发现人员默认不关注。另发现 ${value.groups.length} 个群聊，群聊仍由你选择。`);
    } catch (reason) {
      if (!isLatestResourceRequest(scopeGenerationRef.current, request)) return;
      setError(true);
      setMessage(reason instanceof Error ? reason.message : '刷新飞书范围失败。');
    } finally {
      if (isLatestResourceRequest(scopeGenerationRef.current, request)) setBusy(null);
    }
  };

  const searchPeople = async () => {
    const request = beginResourceRequest(scopeGenerationRef.current);
    const query = personQuery.trim();
    setBusy('search');
    setError(false);
    setMessage(query ? `正在搜索“${query}”…` : '正在读取最近聊过的人…');
    try {
      const result = await api.get<{ items: FeishuMonitorTarget[]; hasMore: boolean; notice: string | null }>(`/api/integrations/feishu/people?query=${encodeURIComponent(query)}`);
      if (!isLatestResourceRequest(scopeGenerationRef.current, request)) return;
      setScope((current) => current ? { ...current, people: mergeTargets(current.people, result.items) } : current);
      setMessage(result.items.length ? `找到 ${result.items.length} 位联系人；请根据部门或邮箱确认同名人员。` : '没有找到符合条件的联系人。');
    } catch (reason) {
      if (!isLatestResourceRequest(scopeGenerationRef.current, request)) return;
      setError(true);
      setMessage(reason instanceof Error ? reason.message : '联系人搜索失败。');
    } finally {
      if (isLatestResourceRequest(scopeGenerationRef.current, request)) setBusy(null);
    }
  };

  const toggle = (kind: 'person' | 'group', target: FeishuMonitorTarget) => {
    const setter = kind === 'person' ? setPersonIds : setGroupIds;
    setter((current) => {
      const next = new Set(current);
      if (next.has(target.id)) next.delete(target.id);
      else if (kind === 'person' || next.size < (scope?.limits.groups ?? 50)) next.add(target.id);
      return next;
    });
  };

  const followAllPeople = async () => {
    if (!scope?.people.length) {
      setError(false);
      setMessage('当前还没有发现个人单聊，请先刷新列表。');
      return;
    }
    const pendingGroups = new Set(groupIds);
    const request = beginResourceRequest(scopeGenerationRef.current);
    setBusy('follow_all');
    setError(false);
    setMessage('正在关注当前已发现的所有人员…');
    try {
      const value = await api.patch<FeishuMonitoringScope>('/api/integrations/feishu/monitoring-scope', {
        personChanges: scope.people.filter((item) => !item.selected).map((item) => ({ id: item.id, selected: true })),
      });
      if (!isLatestResourceRequest(scopeGenerationRef.current, request)) return;
      applyScope(value);
      setGroupIds(pendingGroups);
      setMessage(`已关注当前发现的 ${value.selectedPersonCount} 位联系人；以后新发现的人仍默认不关注。`);
      await onScopeSaved?.();
    } catch (reason) {
      if (!isLatestResourceRequest(scopeGenerationRef.current, request)) return;
      setError(true);
      setMessage(reason instanceof Error ? reason.message : '关注所有人失败。');
    } finally {
      if (isLatestResourceRequest(scopeGenerationRef.current, request)) setBusy(null);
    }
  };

  const save = async () => {
    const request = beginResourceRequest(scopeGenerationRef.current);
    setBusy('save');
    setError(false);
    setMessage('正在保存关注范围…');
    try {
      const personChanges = (scope?.people ?? [])
        .filter((item) => savedPersonIds.has(item.id) !== personIds.has(item.id))
        .map((item) => ({ id: item.id, selected: personIds.has(item.id) }));
      const value = await api.patch<FeishuMonitoringScope>('/api/integrations/feishu/monitoring-scope', {
        personChanges,
        groupIds: [...groupIds],
      });
      if (!isLatestResourceRequest(scopeGenerationRef.current, request)) return;
      applyScope(value);
      setMessage(`已保存：已关注 ${value.selectedPersonCount} 个个人单聊、${value.selectedGroupCount} 个群聊。群聊仍只处理真实 @你。`);
      await onScopeSaved?.();
    } catch (reason) {
      if (!isLatestResourceRequest(scopeGenerationRef.current, request)) return;
      setError(true);
      setMessage(reason instanceof Error ? reason.message : '关注范围保存失败。');
    } finally {
      if (isLatestResourceRequest(scopeGenerationRef.current, request)) setBusy(null);
    }
  };

  if (!ownerAuthorized) {
    return <div className="monitoring-scope-locked"><UsersRound size={18} /><div><strong>先完成系统主人授权</strong><span>授权成功后，系统会发现可选的个人私聊；默认不会关注任何人，群聊也需要你选择。</span></div></div>;
  }

  return <section className="monitoring-scope" aria-labelledby="monitoring-scope-title">
    <div className="monitoring-scope-heading">
      <div><h3 id="monitoring-scope-title">选择要关注的个人和群聊</h3><p>个人私聊和群聊都默认不关注；你可以逐个选择，或一键关注当前已发现的所有人员。群聊仍只保存真实 @你的消息。</p></div>
      <button className="quiet-button" type="button" disabled={Boolean(busy)} onClick={() => void refreshOptions()}><RefreshCw size={14} className={busy === 'refresh' ? 'spin' : undefined} />刷新列表</button>
    </div>
    {message && <div className={error ? 'error-banner monitoring-scope-message' : 'success-banner monitoring-scope-message'}>{message}</div>}
    <div className="monitoring-scope-grid">
      <section className="monitoring-picker-card">
        <div className="monitoring-picker-title monitoring-picker-title-action"><span><MessageCircle size={17} /></span><div><strong>个人私聊</strong><small>已关注 {selectedPeople} 人 · 只收对方发来的消息</small></div><button className="quiet-button" type="button" disabled={Boolean(busy) || !scope?.people.length || selectedPeople === scope.people.length} onClick={() => void followAllPeople()}>{busy === 'follow_all' ? '关注中…' : '关注所有人'}</button></div>
        <div className="monitoring-search-row"><label><Search size={15} /><input value={personQuery} onChange={(event) => setPersonQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void searchPeople(); } }} placeholder="输入姓名，例如：张三" /></label><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void searchPeople()}>{busy === 'search' ? '搜索中…' : '搜索'}</button></div>
        <p className="monitoring-picker-help">新发现的人员默认不关注。勾选后从当前时间开始读取；“关注所有人”只作用于当前已发现列表，无需填写 chat ID。</p>
        <div className="monitoring-option-list">
          {scope?.people.map((target) => <label className={'monitoring-option ' + (personIds.has(target.id) ? 'monitoring-option-selected' : '')} key={target.id}>
            <input type="checkbox" checked={personIds.has(target.id)} onChange={() => toggle('person', target)} />
            <span className="monitoring-option-check">{personIds.has(target.id) ? <Check size={14} /> : null}</span>
            <span className="monitoring-option-copy"><strong>{target.name}</strong><small>{target.secondaryLabel ?? '最近私聊联系人'} · {accessLabels[target.accessStatus]}</small>{target.lastError && <em>{target.lastError}</em>}</span>
          </label>)}
          {busy !== 'load' && !scope?.people.length && <div className="monitoring-empty">尚未发现现有个人单聊；也可以输入姓名查找联系人。</div>}
        </div>
      </section>
      <section className="monitoring-picker-card">
        <div className="monitoring-picker-title"><span><AtSign size={17} /></span><div><strong>关注群聊</strong><small>已选 {selectedGroups}/{scope?.limits.groups ?? 50} · 仅处理 @我</small></div></div>
        <div className="monitoring-search-row monitoring-search-row-single"><label><Search size={15} /><input value={groupQuery} onChange={(event) => setGroupQuery(event.target.value)} placeholder="按群名筛选" /></label></div>
        <p className="monitoring-picker-help">使用主人 OAuth 读取所选群，不要求机器人在群内；机器人补充群在下方单独配置。</p>
        <div className="monitoring-option-list">
          {visibleGroups.map((target) => <label className={'monitoring-option ' + (groupIds.has(target.id) ? 'monitoring-option-selected' : '')} key={target.id}>
            <input type="checkbox" checked={groupIds.has(target.id)} onChange={() => toggle('group', target)} />
            <span className="monitoring-option-check">{groupIds.has(target.id) ? <Check size={14} /> : null}</span>
            <span className="monitoring-option-copy"><strong>{target.name}</strong><small>{target.secondaryLabel ?? '主人所在群'} · {accessLabels[target.accessStatus]}</small>{target.lastError && <em>{target.lastError}</em>}</span>
          </label>)}
          {busy !== 'load' && !visibleGroups.length && <div className="monitoring-empty">点击“刷新列表”发现主人所在群。</div>}
        </div>
      </section>
    </div>
    <div className="monitoring-scope-footer"><span>{dirty ? '人员或群聊选择尚未保存。' : `已关注 ${savedPeople} 个个人单聊和 ${savedGroups} 个群聊。`}</span><button className="primary-button" type="button" disabled={!dirty || Boolean(busy)} onClick={() => void save()}>{busy === 'save' ? '保存中…' : '保存范围设置'}</button></div>
  </section>;
}
