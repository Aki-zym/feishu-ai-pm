import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../database.js';
import type { NormalizedSourceEvent, OwnerIdentity, OwnerSourceStatus, SourceCompleteness } from '../domain.js';
import { redactDiagnosticText } from '../redaction.js';
import type { OperationContext } from '../observability.js';
import { feishuApiErrorStatus, feishuErrorDiagnostic, isFeishuDetailBlockingError, isFeishuRetryableError, LiveFeishuAdapter, missingFeishuScopes, normalizeFeishuTimestamp, optionalFeishuTimestamp, parseDurableGrantedScopes, feishuUnixSeconds } from './feishu.js';

type Ingest = (event: NormalizedSourceEvent, context?: OperationContext) => Promise<unknown>;
type StatusLevel = 'info' | 'warn' | 'error';

type MinutesPage = {
  items?: unknown[];
  has_more?: boolean;
  page_token?: string;
  notice?: string;
};

type MinutesCursor = {
  version: 1;
  mode: 'overlap';
  watermark: string;
  lastFullReconciledAt: string | null;
};

type MinutesOwner = OwnerIdentity & {
  grantedScopes: string[];
  scopeState: ReturnType<typeof parseDurableGrantedScopes>;
};

export type MinutesSyncResult = {
  minutes: number;
  deduplicated: number;
  failures: number;
  detailFailures: number;
  pages: number;
  skipped: boolean;
  reason?: string;
  mode?: 'full' | 'overlap' | 'rebuild';
};

const nowIso = () => new Date().toISOString();
const minutesCursorIntegration = 'feishu_minutes';
const minutesCursorScope = 'owner:primary';
const maxPages = 100;
const maxTransientAttempts = 3;
const initialLookbackSeconds = 7 * 24 * 60 * 60;
const fullReconciliationSeconds = 24 * 60 * 60;
const maxContentChars = 5000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readString(value: unknown, ...keys: string[]) {
  const source = record(value);
  for (const key of keys) {
    const candidate = source[key];
    if ((typeof candidate === 'string' || typeof candidate === 'number') && candidate !== '') return String(candidate);
  }
  return '';
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? '飞书妙记同步失败。');
}

function errorStatus(error: unknown): 'admin_required' | 'unauthorized' | 'error' {
  return feishuApiErrorStatus(error);
}

function minuteToken(value: unknown) {
  return readString(value, 'token', 'minute_token', 'minuteToken');
}

function minuteRecord(value: unknown): Record<string, unknown> | null {
  const source = record(value);
  const candidate = source.minute;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  return candidate as Record<string, unknown>;
}

function searchDescription(value: unknown) {
  const item = record(value);
  const metadata = record(item.meta_data ?? item.metadata);
  return readString(item, 'display_info', 'title', 'name') || readString(metadata, 'description');
}

function safeTodos(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((item) => {
    const todo = record(item);
    return {
      content: truncate(readString(todo, 'content', 'title', 'name'), 500),
      assignees: Array.isArray(todo.assignees) ? todo.assignees.slice(0, 20).map(String) : [],
      isDone: typeof todo.is_done === 'boolean' ? todo.is_done : undefined,
      todoId: readString(todo, 'todo_id', 'id') || undefined,
    };
  }).filter((item) => item.content);
}

function safeChapters(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map((item) => {
    const chapter = record(item);
    return {
      title: truncate(readString(chapter, 'title', 'name'), 300),
      summary: truncate(readString(chapter, 'summary_content', 'summary', 'content'), 600),
    };
  }).filter((item) => item.title || item.summary);
}

function sha256(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeMinute(
  token: string,
  listed: Record<string, unknown>,
  minute: Record<string, unknown>,
  artifacts: Record<string, unknown> | null,
  transcript: { available?: boolean; text?: string; truncated?: boolean } | null,
  owner: OwnerIdentity,
  detailStatus: 'complete' | 'partial' | 'denied' | 'not_ready',
): NormalizedSourceEvent {
  const searchMeta = record(listed.meta_data ?? listed.metadata);
  const title = readString(minute, 'title') || searchDescription(listed) || '未命名会议纪要';
  const ownerId = readString(minute, 'owner_id', 'ownerId') || owner.openId || 'minute-owner-unknown';
  const createTime = optionalFeishuTimestamp(minute.create_time ?? minute.createTime);
  const url = readString(minute, 'url', 'app_link', 'appLink') || readString(searchMeta, 'app_link', 'appLink');
  const summary = artifacts ? readString(artifacts, 'summary') : '';
  const todos = safeTodos(artifacts?.minute_todos ?? artifacts?.todos);
  const chapters = safeChapters(artifacts?.minute_chapters ?? artifacts?.chapters);
  const transcriptText = transcript?.text ? truncate(transcript.text, 1800) : '';
  const content = [
    `会议纪要：${truncate(title, 400)}`,
    createTime ? `创建时间：${createTime}` : '创建时间：未知（飞书未返回时间）',
    url ? `来源链接：${url}` : '',
    summary ? `摘要：${truncate(summary, 1800)}` : '',
    todos.length ? `行动项：${todos.map((item) => item.content).join('；')}` : '',
    chapters.length && !summary ? `章节：${chapters.map((item) => item.title || item.summary).join('；')}` : '',
    transcriptText ? `转写摘录：${transcriptText}` : '',
    detailStatus !== 'complete' ? `访问状态：${detailStatus === 'denied' ? '部分内容无权限' : detailStatus === 'not_ready' ? '转写尚未就绪' : '部分内容暂不可读'}` : '',
  ].filter(Boolean).join('\n');
  const transcriptHash = transcript?.text ? sha256(transcript.text) : null;
  const sourceVersion = sha256({
    token,
    title,
    ownerId,
    createTime: createTime ?? null,
    duration: readString(minute, 'duration'),
    url: url || null,
    noteId: readString(minute, 'note_id', 'noteId') || null,
    summary: summary || null,
    todos,
    chapters,
    transcriptHash,
    transcriptAvailable: Boolean(transcript?.available),
    detailStatus,
  });
  const metadata: Record<string, unknown> = {
    sourceScope: 'owner_minutes',
    minuteToken: token,
    ownerId,
    title,
    duration: readString(minute, 'duration') || null,
    noteId: readString(minute, 'note_id', 'noteId') || null,
    sourceVersion,
    accessStatus: detailStatus,
    detailsAvailable: detailStatus === 'complete',
    transcriptAvailable: Boolean(transcript?.available),
    transcriptTruncated: Boolean(transcript?.truncated),
    transcriptHash,
    summaryAvailable: Boolean(summary),
    actionItems: todos,
    chapters,
    participantsAvailable: false,
    sourceUpdatedAt: null,
    timeKnown: Boolean(createTime),
    realTenantValidated: false,
  };
  return {
    externalId: `minutes:${token}`,
    sourceType: 'meeting',
    conversationId: `minutes:${token}`,
    senderId: ownerId,
    senderName: ownerId === owner.openId ? owner.name : ownerId === 'minute-owner-unknown' ? '飞书会议纪要' : `飞书用户 ${ownerId}`,
    content: truncate(content || `会议纪要：${title}`, maxContentChars),
    // `occurredAt` is required by the common source contract. When Feishu
    // omits create_time, use capture time as a transport fallback and expose
    // `timeKnown=false` in metadata instead of claiming the meeting happened
    // at the current time.
    occurredAt: normalizeFeishuTimestamp(createTime),
    ownerMentioned: false,
    sourceUrl: url || undefined,
    completeness: detailStatus === 'complete' ? 'complete' : detailStatus === 'denied' ? 'limited' : 'partial',
    discoveryReason: '系统主人授权的会议纪要/妙记周期同步',
    metadata,
  };
}

export class FeishuMinutesSyncRunner {
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

  async runAfterCurrent(context?: OperationContext): Promise<MinutesSyncResult> {
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    return this.runOnce(context);
  }

  async runOnce(context?: OperationContext): Promise<MinutesSyncResult> {
    const empty = (skipped: boolean, reason?: string): MinutesSyncResult => ({ minutes: 0, deduplicated: 0, failures: 0, detailFailures: 0, pages: 0, skipped, reason });
    if (this.running) return empty(true, 'already_running');
    if (!this.config.externalEnabled) return empty(true, 'scan_disabled');
    const owner = this.readOwner();
    if (!owner) {
      this.markState('unauthorized', '尚未完成系统主人 OAuth，会议纪要暂不扫描。');
      return empty(true, 'owner_oauth_required');
    }
    const missingScopes = missingFeishuScopes('minutes', owner.grantedScopes);
    if (!owner.scopeState.valid || missingScopes.length > 0) {
      const message = '系统主人会议纪要缺少已验证的妙记读取权限，已跳过本轮。';
      this.markState('admin_required', message, {
        reason: 'scope_required',
        scopeState: owner.scopeState.reason,
        missingScopes,
      });
      this.onStatus?.('warn', message, { reason: 'scope_required', missingScopes });
      return empty(true, 'scope_required');
    }
    this.running = true;
    try {
      const cursorInfo = this.readCursor();
      const endMillis = Date.now();
      const previousMillis = Date.parse(cursorInfo.cursor.watermark);
      const baseMillis = Number.isFinite(previousMillis) ? previousMillis : endMillis - initialLookbackSeconds * 1000;
      const startMillis = Math.max(0, baseMillis - this.config.scanOverlapSeconds * 1000);
      const lastFullMillis = cursorInfo.cursor.lastFullReconciledAt ? Date.parse(cursorInfo.cursor.lastFullReconciledAt) : Number.NaN;
      const needsFullReconciliation = !cursorInfo.hasCursor || !Number.isFinite(lastFullMillis) || endMillis - lastFullMillis >= fullReconciliationSeconds * 1000;
      const mode = cursorInfo.rebuilt ? 'rebuild' : needsFullReconciliation ? 'full' : 'overlap';
      const result = await this.scan(owner, needsFullReconciliation ? null : startMillis, endMillis, mode, context);
      if (result.failures === 0) {
        this.saveCursor({
          version: 1,
          mode: 'overlap',
          watermark: new Date(endMillis).toISOString(),
          lastFullReconciledAt: needsFullReconciliation ? new Date(endMillis).toISOString() : cursorInfo.cursor.lastFullReconciledAt,
        });
      }
      return result;
    } catch (error) {
      const message = feishuErrorDiagnostic(error);
      const status = errorStatus(error);
      this.saveCursorError(message);
      this.markState(status, message);
      if (status === 'unauthorized') this.markOwnerOAuthFailure(message);
      this.onStatus?.('error', '系统主人会议纪要同步失败。', { status, ...context });
      return { ...empty(false), failures: 1, reason: 'sync_failed' };
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private readOwner(): MinutesOwner | null {
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
    const scopeState = parseDurableGrantedScopes(row.granted_scopes_json);
    return { openId: row.open_id, unionId: row.union_id, userId: row.user_id, name: row.name, tenantKey: row.tenant_key, grantedScopes: scopeState.scopes, scopeState };
  }

  private readCursor() {
    const row = this.database.raw.prepare('SELECT cursor FROM sync_cursor WHERE integration = ? AND scope_key = ?').get(minutesCursorIntegration, minutesCursorScope) as { cursor: string | null } | undefined;
    const parsed = parseJson<Partial<MinutesCursor> | null>(row?.cursor, null);
    if (parsed?.version === 1 && typeof parsed.watermark === 'string' && Number.isFinite(Date.parse(parsed.watermark))) {
      const lastFullReconciledAt = typeof parsed.lastFullReconciledAt === 'string' && Number.isFinite(Date.parse(parsed.lastFullReconciledAt))
        ? parsed.lastFullReconciledAt
        : null;
      return { cursor: { version: 1, mode: 'overlap' as const, watermark: parsed.watermark, lastFullReconciledAt }, hasCursor: true, rebuilt: false };
    }
    const cursor = { version: 1 as const, mode: 'overlap' as const, watermark: new Date(Date.now() - initialLookbackSeconds * 1000).toISOString(), lastFullReconciledAt: null };
    const timestamp = nowIso();
    this.database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(integration, scope_key) DO UPDATE SET cursor = excluded.cursor, last_success_at = NULL, last_error = NULL, updated_at = excluded.updated_at`,
    ).run(minutesCursorIntegration, minutesCursorScope, JSON.stringify(cursor), timestamp);
    return { cursor, hasCursor: false, rebuilt: Boolean(row?.cursor) };
  }

  private async scan(owner: OwnerIdentity, startMillis: number | null, endMillis: number, mode: 'full' | 'overlap' | 'rebuild', context?: OperationContext): Promise<MinutesSyncResult> {
    let pageToken: string | undefined;
    let pages = 0;
    let minutes = 0;
    let deduplicated = 0;
    let failures = 0;
    let detailFailures = 0;
    let adminFailures = 0;
    let notice: string | undefined;
    const seen = new Set<string>();
    do {
      if (++pages > maxPages) throw new Error('飞书妙记分页超过安全上限。');
      const page = await this.withTransientRetry(
        () => this.adapter.searchMinutes({
          filter: startMillis === null ? undefined : { create_time: { start_time: feishuUnixSeconds(startMillis), end_time: feishuUnixSeconds(endMillis) } },
          pageToken,
          pageSize: Math.min(this.config.scanPageSize, 50),
          operationContext: context,
        }) as Promise<MinutesPage>,
        'minutes:search',
      );
      notice = page.notice ?? notice;
      for (const raw of page.items ?? []) {
        const listed = record(raw);
        const token = minuteToken(listed);
        if (!token || seen.has(token)) {
          if (token) deduplicated += 1;
          continue;
        }
        seen.add(token);
        let minute = listed;
        let artifacts: Record<string, unknown> | null = null;
        let transcript: { available?: boolean; text?: string; truncated?: boolean } | null = null;
        let detailStatus: 'complete' | 'partial' | 'denied' | 'not_ready' = 'complete';
        try {
          const detail = await this.withTransientRetry(() => this.adapter.getMinute(token), `minutes:detail`);
          const resolvedMinute = minuteRecord(detail);
          if (!resolvedMinute || minuteToken(resolvedMinute) !== token) {
            detailFailures += 1;
            detailStatus = 'partial';
            minute = listed;
            this.onStatus?.('warn', '一篇妙记详情响应为空，已保留搜索摘要。', { detailStatus, ...context });
          } else {
            minute = resolvedMinute;
          }
        } catch (error) {
          if (isFeishuDetailBlockingError(error) || errorStatus(error) === 'unauthorized') throw error;
          detailFailures += 1;
          if (errorStatus(error) === 'admin_required') adminFailures += 1;
          detailStatus = errorStatus(error) === 'admin_required' ? 'denied' : 'partial';
          this.onStatus?.('warn', '一篇妙记详情暂不可读，已保留搜索摘要。', { detailStatus, ...context });
        }
        if (detailStatus === 'complete') {
          try {
            artifacts = record(await this.withTransientRetry(() => this.adapter.getMinuteArtifacts(token), `minutes:artifacts`));
          } catch (error) {
            if (isFeishuDetailBlockingError(error) || errorStatus(error) === 'unauthorized') throw error;
            detailFailures += 1;
            if (errorStatus(error) === 'admin_required') adminFailures += 1;
            detailStatus = errorStatus(error) === 'admin_required' ? 'denied' : 'partial';
            this.onStatus?.('warn', '一篇妙记 AI 产物暂不可读，已保留基础会议来源。', { detailStatus, ...context });
          }
          try {
            transcript = await this.withTransientRetry(() => this.adapter.getMinuteTranscript(token), `minutes:transcript`) as { available?: boolean; text?: string; truncated?: boolean };
            if (!transcript?.available) detailStatus = detailStatus === 'complete' ? 'not_ready' : detailStatus;
          } catch (error) {
            if (isFeishuDetailBlockingError(error) || errorStatus(error) === 'unauthorized') throw error;
            detailFailures += 1;
            if (errorStatus(error) === 'admin_required') adminFailures += 1;
            detailStatus = errorStatus(error) === 'admin_required' ? 'denied' : 'partial';
            this.onStatus?.('warn', '一篇妙记转写暂不可读，已保留会议卡片。', { detailStatus, ...context });
          }
        }
        const event = normalizeMinute(token, listed, minute, artifacts, transcript, owner, detailStatus);
        if (detailStatus !== 'complete' && this.hasCompleteSource(token)) {
          // A temporary detail/transcript failure must not replace a previously
          // complete source with a lower-quality hash and stale candidate text.
          // The daily full reconciliation will retry this token.
          deduplicated += 1;
          continue;
        }
        try {
          const outcome = await this.ingest(event, context) as { deduplicated?: boolean } | undefined;
          minutes += 1;
          if (outcome?.deduplicated) deduplicated += 1;
        } catch (error) {
          failures += 1;
          this.onStatus?.('warn', '一篇妙记来源写入主链失败，本轮不会推进游标。', { failureType: error instanceof Error ? error.name : 'unknown', ...context });
        }
      }
      const next = page.has_more ? page.page_token : undefined;
      if (page.has_more && !next) throw new Error('飞书妙记返回了下一页标记，但没有分页游标。');
      if (next && next === pageToken) throw new Error('飞书妙记分页游标没有前进。');
      pageToken = next;
    } while (pageToken);
    if (failures > 0) {
      const message = `有 ${failures} 篇妙记来源未写入主链；已保留旧游标，后续会在重叠窗口内重试。`;
      this.saveCursorError(message);
      this.markState('error', message, { minutes, pages, failures, detailFailures, searchNotice: notice });
      return { minutes, deduplicated, failures, detailFailures, pages, skipped: false, mode };
    }
    const status: 'partial' | 'admin_required' = adminFailures > 0 ? 'admin_required' : 'partial';
    const error = detailFailures > 0 ? `有 ${detailFailures} 项妙记详情、AI 产物或转写暂不可读，已保留受限来源。` : null;
    this.markState(status, error, {
      minutes,
      pages,
      detailFailures,
      searchNotice: notice,
      syncMode: mode,
      windowStart: startMillis === null ? null : new Date(startMillis).toISOString(),
      windowEnd: new Date(endMillis).toISOString(),
      fullReconciliation: startMillis === null,
    }, true);
    this.onStatus?.('info', '系统主人会议纪要同步完成。', { minutes, pages, detailFailures });
    return { minutes, deduplicated, failures: 0, detailFailures, pages, skipped: false, mode };
  }

  private saveCursor(cursor: MinutesCursor) {
    const timestamp = nowIso();
    this.database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT(integration, scope_key) DO UPDATE SET cursor = excluded.cursor, last_success_at = excluded.last_success_at, last_error = NULL, updated_at = excluded.updated_at`,
    ).run(minutesCursorIntegration, minutesCursorScope, JSON.stringify(cursor), timestamp, timestamp);
  }

  private hasCompleteSource(token: string) {
    const row = this.database.raw.prepare('SELECT completeness FROM source_event WHERE external_id = ?').get(`minutes:${token}`) as { completeness: SourceCompleteness } | undefined;
    return row?.completeness === 'complete';
  }

  private saveCursorError(message: string) {
    const timestamp = nowIso();
    this.database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES (?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(integration, scope_key) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at`,
    ).run(minutesCursorIntegration, minutesCursorScope, redactDiagnosticText(message, 300), timestamp);
  }

  private markState(status: Extract<OwnerSourceStatus, 'partial' | 'unauthorized' | 'admin_required' | 'error'>, error: string | null, details: Record<string, unknown> = {}, syncSucceeded = error === null) {
    const timestamp = nowIso();
    const existing = this.database.raw.prepare('SELECT details_json FROM information_source_state WHERE source_kind = ?').get('minutes') as { details_json: string } | undefined;
    const merged = { ...parseJson<Record<string, unknown>>(existing?.details_json, {}), ...details, adapterMode: 'live', realTenantValidated: false };
    this.database.raw.prepare(
      `UPDATE information_source_state SET status = ?, last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END, last_error = ?, details_json = ?, updated_at = ? WHERE source_kind = ?`,
    ).run(status, syncSucceeded ? 1 : 0, timestamp, error ? redactDiagnosticText(error, 300) : null, JSON.stringify(merged), timestamp, 'minutes');
  }

  private markOwnerOAuthFailure(message: string) {
    const status = /revok|撤销/i.test(message) ? 'revoked' : 'expired';
    this.database.raw.prepare('UPDATE owner_profile SET oauth_status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), 'primary');
  }

  private async withTransientRetry<T>(operation: () => Promise<T>, scope: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxTransientAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isFeishuRetryableError(error) || attempt === maxTransientAttempts) throw error;
        this.onStatus?.('warn', '飞书妙记接口暂时不可用，正在安全重试。', { scope, attempt, maxAttempts: maxTransientAttempts });
        await this.sleep(100 * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }
}
