import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { NormalizedSourceEvent, OwnerIdentity, OwnerSourceStatus } from '../domain.js';
import type { AppDatabase } from '../database.js';
import { redactDiagnosticText } from '../redaction.js';
import type { OperationContext } from '../observability.js';
import { extractFeishuErrorDetails, feishuApiErrorStatus, isFeishuRetryableError, LiveFeishuAdapter, missingFeishuScopes, parseDurableGrantedScopes, type OwnerMessageScope } from './feishu.js';

type Ingest = (event: NormalizedSourceEvent, context?: OperationContext) => Promise<unknown>;
type IngestBatch = (events: NormalizedSourceEvent[], context?: OperationContext) => Promise<unknown>;
type StatusLevel = 'info' | 'warn' | 'error';

type Page = {
  items?: unknown[];
  p2p_chats?: unknown[];
  has_more?: boolean;
  page_token?: string;
};

type OwnerCursor = {
  version: 1;
  watermark: string;
  filterMode?: 'p2p_selected' | 'group_selected_mentions';
  hardStart?: string;
};

type MonitorTargetRow = {
  id: string;
  owner_open_id: string;
  target_kind: 'person' | 'group';
  target_key: string;
  resolved_chat_id: string | null;
  display_name: string;
  secondary_label: string | null;
  enabled: number;
  manual_excluded: number;
  discovery_rank: number | null;
  selection_version: number;
  read_policy: 'incoming_only' | 'owner_mentions';
  selection_source: 'chat_list' | 'contact_search';
  access_status: 'unknown' | 'readable' | 'restricted' | 'not_found' | 'error';
  last_discovered_at: string | null;
  last_resolved_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type OwnerRecord = OwnerIdentity & {
  grantedScopes: string[];
};

type TargetStats = {
  messages: number;
  deduplicated: number;
  failures: number;
  pages: number;
  skipped: number;
  canceled: boolean;
  deferred?: boolean;
  scopeRequired?: boolean;
  skippedReason?: string;
};

export type OwnerSyncResult = {
  scopes: number;
  messages: number;
  deduplicated: number;
  failures: number;
  newChats: number;
  skipped: boolean;
  reason?: string;
  owner: { dm: number; mentions: number; chats: number };
};

export type OwnerConversationBackfillResult = {
  events: NormalizedSourceEvent[];
  complete: boolean;
  truncated: boolean;
  reason: string | null;
  pages: number;
};

const nowIso = () => new Date().toISOString();
const maxPages = 100;
const initialLookbackSeconds = 24 * 60 * 60;
const ingestionLagSeconds = 5;
const maxTransientAttempts = 3;
const maxTargetsPerKind = 50;
const backfillMaxPages = 3;
const backfillLookbackSeconds = 72 * 60 * 60;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readString(value: unknown, ...keys: string[]) {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if ((typeof record[key] === 'string' || typeof record[key] === 'number') && String(record[key]).trim()) return String(record[key]).trim();
  }
  return '';
}

function isOwnerSender(senderId: string, owner: OwnerIdentity) {
  if (!senderId) return false;
  return [owner.openId, owner.unionId, owner.userId].filter(Boolean).includes(senderId);
}

/**
 * User-OAuth source scanner. Existing P2P chats are enrolled automatically;
 * the owner can explicitly exclude people. Groups remain explicit opt-in.
 * The bot allowlist is intentionally not consulted here: it belongs only to
 * the supplemental bot entrypoint.
 */
export class FeishuOwnerSyncRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig['feishu'],
    private readonly database: AppDatabase,
    private readonly adapter: LiveFeishuAdapter,
    private readonly ingest: Ingest,
    private readonly onStatus?: (level: StatusLevel, message: string, context?: Record<string, unknown>) => void,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly ingestBatch?: IngestBatch,
    private readonly captureBatch?: IngestBatch,
  ) {}

  start() {
    if (this.timer || !this.config.externalEnabled) return;
    this.timer = setInterval(() => void this.runOnce(), this.config.scanIntervalSeconds * 1000);
    void this.runOnce();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async runAfterCurrent(scope?: OwnerMessageScope, context?: OperationContext): Promise<OwnerSyncResult> {
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    return this.runOnce(scope, context);
  }

  async runOnce(scope?: OwnerMessageScope, context?: OperationContext): Promise<OwnerSyncResult> {
    const empty = (skipped: boolean, reason?: string): OwnerSyncResult => ({
      scopes: 0,
      messages: 0,
      deduplicated: 0,
      failures: 0,
      newChats: 0,
      skipped,
      reason,
      owner: { dm: 0, mentions: 0, chats: 0 },
    });
    if (this.running) return empty(true, 'already_running');
    if (!this.config.externalEnabled) return empty(true, 'scan_disabled');
    const includeDm = !scope || scope === 'owner_dm';
    const includeMentions = !scope || scope === 'owner_mentions';
    const owner = this.readOwner();
    if (!owner) {
      if (includeDm) this.markSourceState('owner_dm', 'unauthorized', '尚未完成系统主人 OAuth，个人单聊暂不扫描。');
      if (includeMentions) this.markSourceState('owner_mentions', 'unauthorized', '尚未完成系统主人 OAuth，群聊 @我 暂不扫描。');
      return empty(true, 'owner_oauth_required');
    }
    this.adapter.setOwnerIdentity(owner);
    this.running = true;
    const result: OwnerSyncResult = { ...empty(false), scopes: Number(includeDm) + Number(includeMentions) };
    const scopeRequiredFlags: boolean[] = [];
    try {
      if (includeDm) {
        const stats = await this.runScope('owner_dm', owner, context);
        scopeRequiredFlags.push(Boolean(stats.scopeRequired));
        result.messages += stats.messages;
        result.deduplicated += stats.deduplicated;
        result.failures += stats.failures;
        result.newChats += stats.newTargets;
        result.owner.dm = stats.messages;
        result.owner.chats += stats.discovered;
      }
      if (includeMentions) {
        const stats = await this.runScope('owner_mentions', owner, context);
        scopeRequiredFlags.push(Boolean(stats.scopeRequired));
        result.messages += stats.messages;
        result.deduplicated += stats.deduplicated;
        result.failures += stats.failures;
        result.newChats += stats.newTargets;
        result.owner.mentions = stats.messages;
        result.owner.chats += stats.discovered;
      }
      if (scopeRequiredFlags.length && scopeRequiredFlags.every(Boolean)) {
        return empty(true, 'scope_required');
      } else if (scopeRequiredFlags.some(Boolean)) {
        // The aggregate owner source ran but one sub-source was unavailable.
        // Represent that as a real partial failure rather than attaching a
        // skip-only reason to a non-skipped result.
        result.failures += 1;
        result.reason = 'sync_failed';
      }
      if (this.ownerStillCurrent(owner.openId) && scopeRequiredFlags.some((required) => !required)) this.markOwnerSynced(owner.openId);
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
    return result;
  }

  /**
   * Read a small history window before one saved message without advancing the
   * normal target cursor. This is only for repairing missing conversation
   * context; the owner's current selection and hard-start boundary still win.
   */
  async backfillBeforeSource(input: {
    sourceEventId: string;
    sourceExternalId: string;
    conversationId: string;
    sourceType: 'owner_dm' | 'group';
    occurredAt: string;
    monitorTargetId?: string | null;
    operationContext?: OperationContext;
  }): Promise<OwnerConversationBackfillResult> {
    const fail = (reason: string): OwnerConversationBackfillResult => ({ events: [], complete: false, truncated: false, reason, pages: 0 });
    if (!this.config.externalEnabled) return fail('飞书个人信息流未启用，无法补扫对话背景。');
    const owner = this.readOwner();
    if (!owner) return fail('系统主人 OAuth 不可用，无法补扫对话背景。');
    const kind: OwnerMessageScope = input.sourceType === 'owner_dm' ? 'owner_dm' : 'owner_mentions';
    const missingScopes = missingFeishuScopes(kind, owner.grantedScopes);
    if (missingScopes.length) return fail(this.scopeRequiredMessage(kind, missingScopes));
    const targetKind = kind === 'owner_dm' ? 'person' : 'group';
    const target = (input.monitorTargetId
      ? this.database.raw.prepare(
          'SELECT * FROM feishu_monitor_target WHERE id = ? AND owner_open_id = ? AND target_kind = ? AND enabled = 1',
        ).get(input.monitorTargetId, owner.openId, targetKind)
      : this.database.raw.prepare(
          `SELECT * FROM feishu_monitor_target
           WHERE owner_open_id = ? AND target_kind = ? AND enabled = 1
             AND (resolved_chat_id = ? OR target_key = ?)
           ORDER BY updated_at DESC LIMIT 1`,
        ).get(owner.openId, targetKind, input.conversationId, input.conversationId)) as MonitorTargetRow | undefined;
    if (!target) return fail('该会话不在当前已启用的飞书关注范围内。');
    this.adapter.setOwnerIdentity(owner);
    const chatId = kind === 'owner_dm' ? await this.resolvePersonChat(target, owner.openId) : target.resolved_chat_id || target.target_key;
    if (!chatId || !this.targetStillActive(target.id, owner.openId, target.selection_version)) return fail('飞书关注范围已变化，未继续补扫。');
    const cursor = this.readMessageCursor(this.cursorKey(kind, target.id));
    const occurredMillis = Date.parse(input.occurredAt);
    if (!Number.isFinite(occurredMillis)) return fail('来源消息时间无效，无法安全确定补扫范围。');
    const hardStartMillis = cursor.hardStart ? Date.parse(cursor.hardStart) : Number.NaN;
    const desiredStart = occurredMillis - backfillLookbackSeconds * 1000;
    const startMillis = Number.isFinite(hardStartMillis) ? Math.max(desiredStart, hardStartMillis) : desiredStart;
    const hardStartTruncated = Number.isFinite(hardStartMillis) && hardStartMillis > desiredStart;
    const startTime = String(Math.max(0, Math.floor(startMillis / 1000)));
    const endTime = String(Math.max(0, Math.floor((occurredMillis - 1) / 1000)));
    let pageToken: string | undefined;
    let pages = 0;
    let truncated = hardStartTruncated;
    const seen = new Set<string>();
    const events: NormalizedSourceEvent[] = [];
    try {
      do {
        if (++pages > backfillMaxPages) {
          truncated = true;
          break;
        }
        const page = await this.withTransientRetry(
          () => this.adapter.listMessages({ chatId, startTime, endTime, pageToken, pageSize: 50, sortType: 'desc', authMode: 'owner', operationContext: input.operationContext }) as Promise<Page>,
          `backfill:${kind}:${target.id}`,
        );
        for (const record of page.items ?? []) {
          if (!this.targetStillActive(target.id, owner.openId, target.selection_version)) return fail('飞书关注范围已变化，未继续补扫。');
          const event = this.adapter.normalizeMessageRecord(record, kind === 'owner_dm' ? 'owner_dm' : 'group');
          if (!event?.externalId || event.externalId === input.sourceExternalId || seen.has(event.externalId)) continue;
          seen.add(event.externalId);
          const eventMillis = Date.parse(event.occurredAt);
          if (!Number.isFinite(eventMillis) || eventMillis < startMillis || eventMillis >= occurredMillis) continue;
          if (kind === 'owner_mentions' && !event.ownerMentioned) continue;
          event.discoveryReason = '为疑似补充消息有界补扫的飞书对话背景';
          event.metadata = {
            ...(event.metadata ?? {}),
            sourceScope: kind,
            historyRead: true,
            historyBackfill: true,
            backfillTriggerSourceEventId: input.sourceEventId,
            contextOnly: isOwnerSender(event.senderId, owner),
            isOwnerMessage: isOwnerSender(event.senderId, owner),
            matchedOwnerOpenId: owner.openId,
            monitorTargetId: target.id,
          };
          events.push(event);
        }
        const next = page.has_more ? page.page_token : undefined;
        if (page.has_more && !next) return { events: events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.externalId.localeCompare(right.externalId)), complete: false, truncated: true, reason: '飞书历史分页未返回下一页游标。', pages };
        if (next && next === pageToken) return { events: events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.externalId.localeCompare(right.externalId)), complete: false, truncated: true, reason: '飞书历史分页游标没有前进。', pages };
        pageToken = next;
        if (pages >= backfillMaxPages && pageToken) {
          truncated = true;
          break;
        }
      } while (pageToken);
    } catch (error) {
      return {
        events: events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.externalId.localeCompare(right.externalId)),
        complete: false,
        truncated,
        reason: error instanceof Error ? error.message : '飞书历史补扫失败。',
        pages,
      };
    }
    return {
      events: events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.externalId.localeCompare(right.externalId)),
      complete: !truncated,
      truncated,
      reason: truncated ? '对话历史达到补扫安全上限或受启用边界限制。' : null,
      pages,
    };
  }

  private async runScope(kind: OwnerMessageScope, owner: OwnerRecord, context?: OperationContext) {
    const missingScopes = missingFeishuScopes(kind, owner.grantedScopes);
    if (missingScopes.length > 0) {
      const message = this.scopeRequiredMessage(kind, missingScopes);
      this.markScopeRequired(kind, owner.openId, missingScopes, message);
      this.onStatus?.('warn', kind === 'owner_dm' ? '飞书普通私聊缺少用户权限，已跳过本轮。' : '飞书群聊 @我 缺少用户权限，已跳过本轮。', {
        scope: kind,
        reason: 'scope_required',
        missingScopes,
        ...context,
      });
      return {
        messages: 0,
        deduplicated: 0,
        failures: 0,
        pages: 0,
        discovered: 0,
        newTargets: 0,
        scopeRequired: true,
        skippedReason: 'scope_required',
      };
    }
    let discovered = 0;
    let newTargets = 0;
    let discoveryError: string | null = null;
    let discoveryStatus: OwnerSourceStatus | null = null;
    try {
      const discovery = await this.discoverTargets(kind, owner);
      if (discovery.canceled) return { messages: 0, deduplicated: 0, failures: 0, pages: 0, discovered: 0, newTargets: 0 };
      discovered = discovery.discovered;
      newTargets = discovery.newTargets;
    } catch (error) {
      if (!this.ownerStillCurrent(owner.openId)) return { messages: 0, deduplicated: 0, failures: 0, pages: 0, discovered: 0, newTargets: 0 };
      discoveryError = error instanceof Error ? error.message : '飞书会话范围发现失败。';
      discoveryStatus = this.errorStatus(error);
      if (discoveryStatus === 'unauthorized') this.markOwnerOAuthFailure(discoveryError, owner.openId);
      this.onStatus?.('warn', '飞书会话范围发现失败，继续尝试已选择的对象。', { scope: kind, errorType: error instanceof Error ? error.name : 'unknown', ...context });
    }

    const enabledTargets = this.readEnabledTargets(owner.openId, kind);
    const targets = this.selectTargetsForScan(kind, enabledTargets);
    let messages = 0;
    let deduplicated = 0;
    let failures = 0;
    let pages = 0;
    let succeededTargets = 0;
    let deferredTargets = 0;
    let canceledTargets = 0;
    let worstStatus: OwnerSourceStatus | null = discoveryStatus;
    const targetErrors: string[] = [];
    for (const target of targets) {
      try {
        const stats = await this.scanTarget(kind, target, owner, context);
        messages += stats.messages;
        deduplicated += stats.deduplicated;
        failures += stats.failures;
        pages += stats.pages;
        if (stats.deferred) deferredTargets += 1;
        if (stats.canceled) canceledTargets += 1;
        if (!stats.canceled && !stats.deferred && stats.failures === 0) succeededTargets += 1;
        else if (!stats.canceled) worstStatus = 'error';
      } catch (error) {
        if (!this.targetStillActive(target.id, owner.openId, target.selection_version)) continue;
        failures += 1;
        const message = error instanceof Error ? error.message : '飞书目标会话同步失败。';
        targetErrors.push(message);
        const status = this.errorStatus(error);
        worstStatus = this.worseStatus(worstStatus, status);
        this.saveCursorError(this.cursorKey(kind, target.id), message);
        this.markTargetError(target, owner.openId, status, message);
        if (status === 'unauthorized') this.markOwnerOAuthFailure(message, owner.openId);
        this.onStatus?.('warn', '一个飞书目标同步失败，其他已选目标继续。', { scope: kind, targetKind: target.target_kind, errorType: error instanceof Error ? error.name : 'unknown', ...context });
      }
    }

    if (!this.ownerStillCurrent(owner.openId)) {
      return { messages, deduplicated, failures, pages, discovered, newTargets };
    }
    const currentTargets = this.readEnabledTargets(owner.openId, kind);
    const truncated = currentTargets.length > targets.length;
    const sourceStatus: OwnerSourceStatus = currentTargets.length === 0
      ? discoveryStatus ?? 'partial'
      : truncated || deferredTargets > 0 || canceledTargets > 0
        ? 'partial'
      : failures === 0 && !discoveryError
        ? 'ready'
        : succeededTargets > 0
          ? 'partial'
          : worstStatus ?? 'error';
    const error = failures || discoveryError
      ? [discoveryError, ...targetErrors.slice(0, 2), failures ? `${failures} 个消息或目标未同步成功。` : ''].filter(Boolean).join(' ').slice(0, 300)
      : null;
    const summary = kind === 'owner_dm'
      ? currentTargets.length
        ? truncated
          ? `已关注 ${currentTargets.length} 个个人单聊；本轮读取近期 40 个和最久未扫描 10 个，未关注的联系人不会读取。`
          : `已关注 ${currentTargets.length} 个个人单聊；本轮已读取全部已关注会话，未关注的联系人不会读取。`
        : `已发现 ${discovered} 个个人单聊，但当前未关注任何人；可逐个选择或点击“关注所有人”。`
      : currentTargets.length
        ? `周期读取你明确选择的 ${currentTargets.length} 个群聊，并只把真实 @你的消息送入候选判断。`
        : '已支持按群名选择主人所在群；尚未选择任何群，不会读取群正文。';
    this.markSourceState(kind, sourceStatus, error, {
      selectedCount: currentTargets.length,
      scannedTargetCount: targets.length,
      discoveredCount: discovered,
      newDiscoveredCount: newTargets,
      succeededTargets,
      deferredTargets,
      canceledTargets,
      failures,
      ...context,
      messages,
      pages,
      historyScanTruncated: truncated,
      scanPolicy: truncated ? 'recent_40_plus_oldest_10' : 'all_enabled',
      discoveryError,
      realTenantValidated: sourceStatus === 'ready',
    }, summary, canceledTargets === 0 && deferredTargets === 0);
    this.onStatus?.(failures || discoveryError ? 'warn' : 'info', kind === 'owner_dm' ? '系统主人个人单聊同步完成。' : '系统主人群聊 @我 同步完成。', {
      scope: kind,
      selectedCount: currentTargets.length,
      messages,
      failures,
    });
    return { messages, deduplicated, failures, pages, discovered, newTargets };
  }

  private async discoverTargets(kind: OwnerMessageScope, owner: OwnerIdentity) {
    const targetKind = kind === 'owner_dm' ? 'person' : 'group';
    const types = kind === 'owner_dm' ? 'p2p' : 'group';
    const discoveredAt = nowIso();
    const previousDiscovery = this.database.raw.prepare(
      "SELECT last_success_at FROM sync_cursor WHERE integration = 'feishu_owner' AND scope_key = ?",
    ).get(`discover:${kind}:${owner.openId}`) as { last_success_at: string | null } | undefined;
    const initialWatermark = previousDiscovery?.last_success_at ?? discoveredAt;
    const before = new Set((this.database.raw.prepare(
      'SELECT target_key FROM feishu_monitor_target WHERE owner_open_id = ? AND target_kind = ?',
    ).all(owner.openId, targetKind) as Array<{ target_key: string }>).map((item) => item.target_key));
    const seen = new Set<string>();
    let pageToken: string | undefined;
    let pages = 0;
    do {
      if (++pages > maxPages) throw new Error('飞书会话发现分页超过安全上限。');
      const page = await this.withTransientRetry(
        () => {
          if (!this.ownerStillCurrent(owner.openId)) throw new Error('系统主人身份已变化，停止旧会话发现。');
          return this.adapter.listOwnerChats({ types, pageToken, pageSize: 50 }) as Promise<Page>;
        },
        `discover:${kind}`,
      );
      if (!this.ownerStillCurrent(owner.openId)) return { discovered: 0, newTargets: 0, canceled: true } as const;
      for (const item of page.items ?? []) {
        const chatId = readString(item, 'chat_id', 'chatId', 'id');
        const targetKey = kind === 'owner_dm' ? readString(item, 'p2p_target_id', 'p2pTargetId') : chatId;
        if (!targetKey || !chatId || targetKey === owner.openId) continue;
        if (seen.has(targetKey)) continue;
        const discoveryRank = seen.size;
        seen.add(targetKey);
        this.upsertDiscoveredTarget({
          ownerOpenId: owner.openId,
          kind: targetKind,
          targetKey,
          chatId,
          name: readString(item, 'name') || (targetKind === 'person' ? '最近私聊联系人' : '未命名群聊'),
          secondaryLabel: targetKind === 'person' ? '最近私聊' : readString(item, 'description') || null,
          autoEnable: false,
          discoveryRank,
          discoveredAt,
          initialWatermark,
        });
      }
      const next = page.has_more ? page.page_token : undefined;
      if (page.has_more && !next) throw new Error('飞书会话发现返回了下一页标记，但没有分页游标。');
      if (next && next === pageToken) throw new Error('飞书会话发现游标没有前进。');
      pageToken = next;
    } while (pageToken);
    if (!this.ownerStillCurrent(owner.openId)) return { discovered: 0, newTargets: 0, canceled: true } as const;
    this.saveDiscoveryCursor(kind, owner.openId, discoveredAt, { discoveredCount: seen.size, pages });
    return { discovered: seen.size, newTargets: [...seen].filter((key) => !before.has(key)).length, canceled: false } as const;
  }

  private readEnabledTargets(ownerOpenId: string, kind: OwnerMessageScope) {
    return this.database.raw.prepare(
      `SELECT * FROM feishu_monitor_target
       WHERE owner_open_id = ? AND target_kind = ? AND enabled = 1
       ORDER BY CASE WHEN target_kind = 'person' THEN COALESCE(discovery_rank, 2147483647) ELSE 0 END,
                COALESCE(last_discovered_at, updated_at) DESC,
                display_name COLLATE NOCASE`,
    ).all(ownerOpenId, kind === 'owner_dm' ? 'person' : 'group') as MonitorTargetRow[];
  }

  private selectTargetsForScan(kind: OwnerMessageScope, targets: MonitorTargetRow[]) {
    if (kind !== 'owner_dm' || targets.length <= maxTargetsPerKind) return targets.slice(0, maxTargetsPerKind);

    // Keep newly active chats responsive while reserving part of every cycle
    // for the least recently scanned targets. This prevents a large contact
    // list from permanently starving conversations outside the first page.
    const recentQuota = 40;
    const recent = targets.slice(0, recentQuota);
    const selected = new Set(recent.map((target) => target.id));
    const overdue = targets
      .filter((target) => !selected.has(target.id))
      .sort((left, right) => {
        const bySuccess = (left.last_success_at ?? '').localeCompare(right.last_success_at ?? '');
        if (bySuccess !== 0) return bySuccess;
        return (left.discovery_rank ?? Number.MAX_SAFE_INTEGER) - (right.discovery_rank ?? Number.MAX_SAFE_INTEGER);
      })
      .slice(0, maxTargetsPerKind - recent.length);
    return [...recent, ...overdue];
  }

  private async scanTarget(kind: OwnerMessageScope, target: MonitorTargetRow, owner: OwnerIdentity, context?: OperationContext): Promise<TargetStats> {
    const cursorKey = this.cursorKey(kind, target.id);
    if (!this.targetStillActive(target.id, owner.openId, target.selection_version)) return { messages: 0, deduplicated: 0, failures: 0, pages: 0, skipped: 1, canceled: true };
    // Establish the first fixed watermark before any network resolution. If
    // resolving the P2P chat fails for days, recovery still resumes from this
    // original boundary instead of silently resetting to "now - 24h".
    const cursor = this.readMessageCursor(cursorKey);
    const chatId = kind === 'owner_dm' ? await this.resolvePersonChat(target, owner.openId) : target.resolved_chat_id || target.target_key;
    if (!this.targetStillActive(target.id, owner.openId, target.selection_version)) return { messages: 0, deduplicated: 0, failures: 0, pages: 0, skipped: 1, canceled: true };
    if (!chatId) throw new Error('飞书没有返回可读取的会话 ID。');
    const previous = Date.parse(cursor.watermark);
    const hardStartMillis = cursor.hardStart ? Date.parse(cursor.hardStart) : Number.NaN;
    const endMillis = Date.now() - ingestionLagSeconds * 1000;
    if (Number.isFinite(hardStartMillis) && endMillis < hardStartMillis) {
      return { messages: 0, deduplicated: 0, failures: 0, pages: 0, skipped: 1, canceled: false, deferred: true };
    }
    const baseStartMillis = Number.isFinite(previous)
      ? Math.min(previous, endMillis)
      : Date.now() - initialLookbackSeconds * 1000;
    const startMillis = Number.isFinite(hardStartMillis)
      ? hardStartMillis
      : baseStartMillis - this.config.scanOverlapSeconds * 1000;
    const startTime = String(Math.max(0, Math.floor(startMillis / 1000)));
    const endTime = String(Math.max(0, Math.floor(endMillis / 1000)));
    let pageToken: string | undefined;
    let pages = 0;
    let messages = 0;
    let deduplicated = 0;
    let failures = 0;
    let skipped = 0;
    const pendingEvents: NormalizedSourceEvent[] = [];
    // Owner-authored messages are conversation evidence and may contain the
    // decisive confirmation/decline for a requirement.  They therefore must
    // enter the normal classifier in occurrence order; the classifier's
    // owner-identity gate prevents them from becoming ordinary candidates and
    // routes explicit owner intent to the private task state machine.
    const pendingContextEvents: NormalizedSourceEvent[] = [];
    const flushPendingEvents = async () => {
      if (pendingEvents.length === 0 && pendingContextEvents.length === 0) return;
      try {
        const batch = [...pendingEvents, ...pendingContextEvents].sort((left, right) => {
          const byTime = Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
          return (Number.isFinite(byTime) ? byTime : 0) || left.externalId.localeCompare(right.externalId);
        });
        if (this.ingestBatch) {
          if (batch.length > 0) {
            const outcome = await this.ingestBatch(batch, context) as { deduplicated?: number } | undefined;
            messages += batch.length;
            deduplicated += outcome?.deduplicated ?? 0;
          }
        } else if (batch.length > 0) {
          for (const event of batch) {
            const outcome = await this.ingest(event, context) as { deduplicated?: boolean } | undefined;
            messages += 1;
            if (outcome?.deduplicated) deduplicated += 1;
          }
        }
      } catch (error) {
        failures += 1;
        this.onStatus?.('warn', '一批主人信息流消息写入失败，本目标不会推进同步游标。', {
          scope: kind,
          failedBatch: true,
          sourceCount: pendingEvents.length,
          errorType: error instanceof Error ? error.name : 'unknown',
          ...context,
        });
      }
      pendingEvents.length = 0;
      pendingContextEvents.length = 0;
    };
    const seen = new Set<string>();
    try {
      do {
        if (!this.targetStillActive(target.id, owner.openId, target.selection_version)) return { messages, deduplicated, failures, pages, skipped: skipped + 1, canceled: true };
        if (++pages > maxPages) throw new Error('飞书目标会话历史分页超过安全上限。');
        const page = await this.withTransientRetry(
          () => this.adapter.listMessages({ chatId, startTime, endTime, pageToken, pageSize: 50, sortType: 'asc', authMode: 'owner', operationContext: context }) as Promise<Page>,
          `${kind}:${target.id}`,
        );
        for (const record of page.items ?? []) {
          if (!this.targetStillActive(target.id, owner.openId, target.selection_version)) return { messages, deduplicated, failures, pages, skipped: skipped + 1, canceled: true };
          const event = this.adapter.normalizeMessageRecord(record, kind === 'owner_dm' ? 'owner_dm' : 'group');
          if (!event?.externalId || seen.has(event.externalId)) {
            if (event?.externalId) deduplicated += 1;
            continue;
          }
          seen.add(event.externalId);
          if (Number.isFinite(hardStartMillis)) {
            const eventMillis = Date.parse(event.occurredAt);
            if (!Number.isFinite(eventMillis) || eventMillis < hardStartMillis) {
              skipped += 1;
              continue;
            }
          }
          if (isOwnerSender(event.senderId, owner)) {
            event.discoveryReason = '为后续需求判断保留的系统主人对话背景';
            event.metadata = {
              ...(event.metadata ?? {}),
              sourceScope: kind,
              historyRead: true,
              contextOnly: true,
              isOwnerMessage: true,
              matchedOwnerOpenId: owner.openId,
              monitorTargetId: target.id,
            };
            pendingContextEvents.push(event);
            skipped += 1;
            continue;
          }
          if (kind === 'owner_mentions' && !event.ownerMentioned) {
            skipped += 1;
            continue;
          }
          event.discoveryReason = kind === 'owner_dm'
            ? '系统自动发现的主人个人单聊中新收到的对方消息'
            : '系统主人明确选择的群聊中提及系统主人';
          event.metadata = {
            ...(event.metadata ?? {}),
            sourceScope: kind,
            historyRead: true,
            matchedOwnerOpenId: owner.openId,
            monitorTargetId: target.id,
          };
          pendingEvents.push(event);
        }
        const next = page.has_more ? page.page_token : undefined;
        if (page.has_more && !next) throw new Error('飞书会话历史返回了下一页标记，但没有分页游标。');
        if (next && next === pageToken) throw new Error('飞书会话历史游标没有前进。');
        pageToken = next;
      } while (pageToken);
      await flushPendingEvents();
    } catch (error) {
      // Preserve messages already returned by an earlier page, but do not
      // classify an incomplete history window. The old cursor remains so a
      // later complete scan finalizes the whole batch once.
      if (this.captureBatch) {
        await this.captureBatch([...pendingContextEvents, ...pendingEvents]);
      }
      pendingEvents.length = 0;
      pendingContextEvents.length = 0;
      throw error;
    }

    if (failures > 0) {
      const message = `有 ${failures} 条消息未处理成功；已保留旧游标，后续会在重叠窗口内重试。`;
      this.saveCursorError(cursorKey, message);
      this.markTargetError(target, owner.openId, 'error', message);
      return { messages, deduplicated, failures, pages, skipped, canceled: false };
    }
    if (!this.targetStillActive(target.id, owner.openId, target.selection_version)) return { messages, deduplicated, failures, pages, skipped: skipped + 1, canceled: true };
    this.saveMessageCursor(cursorKey, {
      version: 1,
      watermark: new Date(endMillis).toISOString(),
      filterMode: kind === 'owner_dm' ? 'p2p_selected' : 'group_selected_mentions',
    });
    this.markTargetSuccess(target, owner.openId, chatId);
    return { messages, deduplicated, failures, pages, skipped, canceled: false };
  }

  private async resolvePersonChat(target: MonitorTargetRow, ownerOpenId: string) {
    if (target.resolved_chat_id && target.access_status !== 'not_found') return target.resolved_chat_id;
    const page = await this.withTransientRetry(
      () => {
        if (!this.targetStillActive(target.id, ownerOpenId, target.selection_version)) throw new Error('系统主人或关注范围已变化，停止旧会话解析。');
        return this.adapter.resolveP2PChats([target.target_key]) as Promise<Page>;
      },
      `resolve_p2p:${target.id}`,
    );
    if (!this.targetStillActive(target.id, ownerOpenId, target.selection_version)) return '';
    const chatId = (page.p2p_chats ?? []).map((item) => readString(item, 'chat_id', 'chatId')).find(Boolean) ?? '';
    if (!chatId) {
      this.database.raw.prepare(
        `UPDATE feishu_monitor_target SET resolved_chat_id = NULL, access_status = 'not_found',
         last_error = ?, updated_at = ? WHERE id = ? AND owner_open_id = ? AND enabled = 1 AND selection_version = ?`,
      ).run('未找到系统主人与该联系人的现有个人单聊。', nowIso(), target.id, ownerOpenId, target.selection_version);
      throw new Error('未找到系统主人与该联系人的现有个人单聊。');
    }
    const timestamp = nowIso();
    this.database.raw.prepare(
      `UPDATE feishu_monitor_target SET resolved_chat_id = ?, access_status = 'unknown', last_resolved_at = ?,
       updated_at = ? WHERE id = ? AND owner_open_id = ? AND enabled = 1 AND selection_version = ?`,
    ).run(chatId, timestamp, timestamp, target.id, ownerOpenId, target.selection_version);
    return chatId;
  }

  private upsertDiscoveredTarget(input: {
    ownerOpenId: string;
    kind: 'person' | 'group';
    targetKey: string;
    chatId: string;
    name: string;
    secondaryLabel: string | null;
    autoEnable: boolean;
    discoveryRank: number;
    discoveredAt: string;
    initialWatermark: string;
  }) {
    const existing = this.database.raw.prepare(
      'SELECT id, enabled, manual_excluded, selection_source FROM feishu_monitor_target WHERE owner_open_id = ? AND target_kind = ? AND target_key = ?',
    ).get(input.ownerOpenId, input.kind, input.targetKey) as { id: string; enabled: number; manual_excluded: number; selection_source: 'chat_list' | 'contact_search' } | undefined;
    const targetId = existing?.id ?? `monitor_${randomUUID()}`;
    const nextEnabled = input.kind === 'person' && input.autoEnable
      ? existing?.manual_excluded ? 0 : 1
      : existing?.enabled ?? 0;
    const autoActivatedLegacy = Boolean(existing
      && existing.selection_source === 'chat_list'
      && existing.enabled === 0
      && nextEnabled === 1);
    if (existing) {
      this.database.raw.prepare(
        `UPDATE feishu_monitor_target SET
           resolved_chat_id = ?,
           display_name = CASE WHEN ? <> '' THEN ? ELSE display_name END,
           secondary_label = COALESCE(?, secondary_label),
           enabled = ?,
           selection_version = selection_version + ?,
           access_status = CASE WHEN access_status = 'not_found' THEN 'unknown' ELSE access_status END,
           last_error = CASE WHEN access_status = 'not_found' THEN NULL ELSE last_error END,
           last_discovered_at = ?,
           last_resolved_at = ?,
           discovery_rank = ?,
           updated_at = ?
         WHERE id = ?`,
      ).run(
        input.chatId,
        input.name,
        input.name.slice(0, 160),
        input.secondaryLabel?.slice(0, 240) ?? null,
        nextEnabled,
        existing.enabled === nextEnabled ? 0 : 1,
        input.discoveredAt,
        input.discoveredAt,
        input.discoveryRank,
        input.discoveredAt,
        targetId,
      );
    } else {
      this.database.raw.prepare(
        `INSERT INTO feishu_monitor_target
          (id, owner_open_id, target_kind, target_key, resolved_chat_id, display_name, secondary_label, enabled,
           manual_excluded, discovery_rank, selection_version, read_policy, selection_source, access_status,
           last_discovered_at, last_resolved_at, last_success_at, last_error, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 'chat_list', 'unknown', ?, ?, NULL, NULL, '{}', ?, ?)`,
      ).run(
        targetId,
        input.ownerOpenId,
        input.kind,
        input.targetKey,
        input.chatId,
        input.name.slice(0, 160),
        input.secondaryLabel?.slice(0, 240) ?? null,
        nextEnabled,
        input.discoveryRank,
        input.kind === 'person' ? 'incoming_only' : 'owner_mentions',
        input.discoveredAt,
        input.discoveredAt,
        input.discoveredAt,
        input.discoveredAt,
      );
    }
    if (input.kind === 'person' && input.autoEnable && nextEnabled) {
      const cursor = autoActivatedLegacy
        ? { version: 1 as const, watermark: input.discoveredAt, filterMode: 'p2p_selected' as const, hardStart: input.discoveredAt }
        : { version: 1 as const, watermark: input.initialWatermark, filterMode: 'p2p_selected' as const };
      const conflictUpdate = autoActivatedLegacy
        ? 'cursor = excluded.cursor, last_success_at = NULL, last_error = NULL, updated_at = excluded.updated_at'
        : `cursor = CASE WHEN sync_cursor.cursor IS NULL OR sync_cursor.cursor = '' THEN excluded.cursor ELSE sync_cursor.cursor END,
           updated_at = CASE WHEN sync_cursor.cursor IS NULL OR sync_cursor.cursor = '' THEN excluded.updated_at ELSE sync_cursor.updated_at END`;
      this.database.raw.prepare(
        `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
         VALUES ('feishu_owner', ?, ?, NULL, NULL, ?)
         ON CONFLICT(integration, scope_key) DO UPDATE SET ${conflictUpdate}`,
      ).run(
        `messages:owner_dm:${targetId}`,
        JSON.stringify(cursor),
        input.discoveredAt,
      );
    }
  }

  private readOwner(): OwnerRecord | null {
    const row = this.database.raw.prepare('SELECT open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json FROM owner_profile WHERE id = ?').get('primary') as {
      open_id: string;
      union_id: string | null;
      user_id: string | null;
      name: string;
      tenant_key: string | null;
      oauth_status: string;
      granted_scopes_json: string | null;
    } | undefined;
    if (!row?.open_id || row.oauth_status !== 'authorized') return null;
    const grantedScopes = parseDurableGrantedScopes(row.granted_scopes_json).scopes;
    return {
      openId: row.open_id,
      unionId: row.union_id,
      userId: row.user_id,
      name: row.name,
      tenantKey: row.tenant_key,
      grantedScopes,
    };
  }

  private cursorKey(kind: OwnerMessageScope, targetId: string) {
    return `messages:${kind}:${targetId}`;
  }

  private readMessageCursor(scopeKey: string): OwnerCursor {
    const row = this.database.raw.prepare('SELECT cursor FROM sync_cursor WHERE integration = ? AND scope_key = ?').get('feishu_owner', scopeKey) as { cursor: string | null } | undefined;
    const parsed = parseJson<OwnerCursor | null>(row?.cursor, null);
    if (parsed?.watermark) return parsed;
    const cursor: OwnerCursor = { version: 1, watermark: new Date(Date.now() - initialLookbackSeconds * 1000).toISOString() };
    const timestamp = nowIso();
    this.database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES ('feishu_owner', ?, ?, NULL, NULL, ?)
       ON CONFLICT(integration, scope_key) DO UPDATE SET cursor = excluded.cursor, last_success_at = NULL, updated_at = excluded.updated_at`,
    ).run(scopeKey, JSON.stringify(cursor), timestamp);
    return cursor;
  }

  private saveMessageCursor(scopeKey: string, cursor: OwnerCursor) {
    const timestamp = nowIso();
    this.database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES ('feishu_owner', ?, ?, ?, NULL, ?)
       ON CONFLICT(integration, scope_key) DO UPDATE SET cursor = excluded.cursor, last_success_at = excluded.last_success_at, last_error = NULL, updated_at = excluded.updated_at`,
    ).run(scopeKey, JSON.stringify(cursor), timestamp, timestamp);
  }

  private saveCursorError(scopeKey: string, error: string) {
    const timestamp = nowIso();
    this.database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES ('feishu_owner', ?, NULL, NULL, ?, ?)
       ON CONFLICT(integration, scope_key) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at`,
    ).run(scopeKey, redactDiagnosticText(error, 300), timestamp);
  }

  private saveDiscoveryCursor(kind: OwnerMessageScope, ownerOpenId: string, scanStartedAt: string, details: Record<string, unknown>) {
    const completedAt = nowIso();
    this.database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES ('feishu_owner', ?, ?, ?, NULL, ?)
       ON CONFLICT(integration, scope_key) DO UPDATE SET cursor = excluded.cursor, last_success_at = excluded.last_success_at, last_error = NULL, updated_at = excluded.updated_at`,
    ).run(
      `discover:${kind}:${ownerOpenId}`,
      JSON.stringify({ version: 1, ...details, scanStartedAt, completedAt }),
      scanStartedAt,
      completedAt,
    );
  }

  private markTargetSuccess(target: MonitorTargetRow, ownerOpenId: string, chatId: string) {
    const timestamp = nowIso();
    this.database.raw.prepare(
      `UPDATE feishu_monitor_target SET resolved_chat_id = ?, access_status = 'readable', last_success_at = ?,
       last_error = NULL, last_resolved_at = COALESCE(last_resolved_at, ?), updated_at = ?
       WHERE id = ? AND owner_open_id = ? AND enabled = 1 AND selection_version = ?`,
    ).run(chatId, timestamp, timestamp, timestamp, target.id, ownerOpenId, target.selection_version);
  }

  private markTargetError(target: MonitorTargetRow, ownerOpenId: string, status: OwnerSourceStatus, message: string) {
    const accessStatus = /未找到.*个人单聊|P2P chat not found/i.test(message)
      ? 'not_found'
      : status === 'admin_required' || status === 'unauthorized' || status === 'unsupported'
        ? 'restricted'
        : 'error';
    const clearChat = target.target_kind === 'person' && accessStatus === 'not_found';
    this.database.raw.prepare(
      `UPDATE feishu_monitor_target SET access_status = ?, resolved_chat_id = CASE WHEN ? THEN NULL ELSE resolved_chat_id END,
       last_error = ?, updated_at = ? WHERE id = ? AND owner_open_id = ? AND enabled = 1 AND selection_version = ?`,
    ).run(accessStatus, clearChat ? 1 : 0, redactDiagnosticText(message, 300), nowIso(), target.id, ownerOpenId, target.selection_version);
  }

  private scopeRequiredMessage(kind: OwnerMessageScope, missingScopes: string[]) {
    const sourceName = kind === 'owner_dm' ? '普通私聊' : '群聊 @我';
    return `飞书${sourceName}已跳过：当前用户 OAuth 缺少 ${missingScopes.join('、')}。请在开放平台批准并发布这些权限后重新授权。`;
  }

  private markScopeRequired(kind: OwnerMessageScope, ownerOpenId: string, missingScopes: string[], message: string) {
    const timestamp = nowIso();
    const safeMessage = redactDiagnosticText(message, 300);
    const targets = this.database.raw.prepare(
      `SELECT id FROM feishu_monitor_target
       WHERE owner_open_id = ? AND target_kind = ? AND enabled = 1`,
    ).all(ownerOpenId, kind === 'owner_dm' ? 'person' : 'group') as Array<{ id: string }>;
    this.database.transaction(() => {
      // Scope gating must not create discovery/message cursors. Existing
      // cursors remain untouched so a later reauthorization resumes from the
      // previous durable watermark instead of silently advancing to now.
      this.database.raw.prepare(
        `UPDATE feishu_monitor_target
         SET access_status = 'restricted', last_error = ?, updated_at = ?
         WHERE owner_open_id = ? AND target_kind = ? AND enabled = 1`,
      ).run(safeMessage, timestamp, ownerOpenId, kind === 'owner_dm' ? 'person' : 'group');
      const existing = this.database.raw.prepare('SELECT details_json, scope_summary FROM information_source_state WHERE source_kind = ?').get(kind) as {
        details_json: string | null;
        scope_summary: string;
      } | undefined;
      const details = {
        ...parseJson<Record<string, unknown>>(existing?.details_json, {}),
        scopeGate: true,
        missingScopes,
        selectedCount: targets.length,
        discoveredCount: 0,
        scannedTargetCount: 0,
        failures: 0,
        messages: 0,
        realTenantValidated: false,
      };
      this.database.raw.prepare(
        `UPDATE information_source_state
         SET status = 'admin_required', scope_summary = ?, requires_admin = 1,
             requires_bot_in_chat = 0, sync_mode = 'periodic', last_error = ?,
             details_json = ?, updated_at = ? WHERE source_kind = ?`,
      ).run(safeMessage, safeMessage, JSON.stringify(details), timestamp, kind);
    });
  }

  private ownerStillCurrent(ownerOpenId: string) {
    const row = this.database.raw.prepare(
      "SELECT 1 AS present FROM owner_profile WHERE id = 'primary' AND open_id = ? AND oauth_status = 'authorized'",
    ).get(ownerOpenId) as { present: number } | undefined;
    return Boolean(row?.present);
  }

  private targetStillActive(targetId: string, ownerOpenId: string, selectionVersion: number) {
    if (!this.ownerStillCurrent(ownerOpenId)) return false;
    const row = this.database.raw.prepare(
      'SELECT 1 AS present FROM feishu_monitor_target WHERE id = ? AND owner_open_id = ? AND enabled = 1 AND selection_version = ?',
    ).get(targetId, ownerOpenId, selectionVersion) as { present: number } | undefined;
    return Boolean(row?.present);
  }

  private async withTransientRetry<T>(operation: () => Promise<T>, scope: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxTransientAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isFeishuRetryableError(error) || attempt === maxTransientAttempts) throw error;
        this.onStatus?.('warn', '飞书接口暂时不可用，正在安全重试。', { scope, attempt, maxAttempts: maxTransientAttempts });
        await this.sleep(100 * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  private errorStatus(error: unknown): Extract<OwnerSourceStatus, 'unauthorized' | 'admin_required' | 'unsupported' | 'error'> {
    const details = extractFeishuErrorDetails(error);
    const code = details.code ?? '';
    const message = details.message;
    if (/401|9999166[34]|unauthori[sz]ed|invalid.?token|token.{0,24}(expired|revoked|invalid)|(?:expired|revoked|invalid).{0,24}token|授权已失效|授权.*撤销|撤销.*授权|需要完成.*OAuth|令牌不存在|没有可刷新/i.test(`${code} ${message}`)) return 'unauthorized';
    if (/231204|current.?user|user.?identity|当前用户身份|不支持.*用户身份/i.test(`${code} ${message}`)) return 'unsupported';
    if (/230013|230027|403|forbidden|permission|scope|管理员|权限不足|应用可用范围/i.test(`${code} ${message}`)) return 'admin_required';
    return feishuApiErrorStatus(error);
  }

  private worseStatus(current: OwnerSourceStatus | null, next: OwnerSourceStatus) {
    const rank: Record<OwnerSourceStatus, number> = { ready: 0, mock_ready: 0, partial: 1, unsupported: 2, error: 3, admin_required: 4, unauthorized: 5 };
    return !current || rank[next] > rank[current] ? next : current;
  }

  private markOwnerOAuthFailure(message: string, ownerOpenId: string) {
    const status = /revok|撤销/i.test(message) ? 'revoked' : 'expired';
    this.database.raw.prepare("UPDATE owner_profile SET oauth_status = ?, updated_at = ? WHERE id = 'primary' AND open_id = ?")
      .run(status, nowIso(), ownerOpenId);
  }

  private markOwnerSynced(ownerOpenId: string) {
    const timestamp = nowIso();
    this.database.raw.prepare("UPDATE owner_profile SET last_synced_at = ?, updated_at = ? WHERE id = 'primary' AND open_id = ? AND oauth_status = 'authorized'")
      .run(timestamp, timestamp, ownerOpenId);
  }

  private markSourceState(kind: OwnerMessageScope, status: OwnerSourceStatus, error: string | null, details: Record<string, unknown> = {}, summary?: string, advanceSuccess = true) {
    const timestamp = nowIso();
    const existing = this.database.raw.prepare('SELECT details_json, scope_summary FROM information_source_state WHERE source_kind = ?').get(kind) as {
      details_json: string;
      scope_summary: string;
    } | undefined;
    const merged = { ...parseJson<Record<string, unknown>>(existing?.details_json, {}), ...details, adapterMode: 'live' };
    this.database.raw.prepare(
      `UPDATE information_source_state SET status = ?, scope_summary = ?, requires_admin = 1, requires_bot_in_chat = 0,
       sync_mode = 'periodic', last_success_at = CASE WHEN ? = 1 AND ? IS NULL THEN ? ELSE last_success_at END,
       last_error = ?, details_json = ?, updated_at = ? WHERE source_kind = ?`,
    ).run(status, summary ?? existing?.scope_summary ?? '', advanceSuccess ? 1 : 0, error, timestamp, error ? redactDiagnosticText(error, 300) : null, JSON.stringify(merged), timestamp, kind);
  }
}
