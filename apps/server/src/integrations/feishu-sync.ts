import type { AppConfig } from '../config.js';
import type { NormalizedSourceEvent } from '../domain.js';
import type { AppDatabase } from '../database.js';
import { redactDiagnosticText } from '../redaction.js';
import { LiveFeishuAdapter } from './feishu.js';
import type { OperationContext } from '../observability.js';

type Ingest = (event: NormalizedSourceEvent, context?: OperationContext) => Promise<unknown>;
type IngestBatch = (events: NormalizedSourceEvent[], context?: OperationContext) => Promise<unknown>;

type SyncResult = {
  scopes: number;
  messages: number;
  deduplicated: number;
  failures: number;
  skipped: boolean;
  reason?: 'already_running' | 'scan_disabled';
};

const now = () => new Date().toISOString();

/**
 * Read-only, overlap-window scanner for explicitly configured requirement
 * groups. It never scans arbitrary local paths and never changes PM status.
 */
export class FeishuSyncRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig['feishu'],
    private readonly database: AppDatabase,
    private readonly adapter: LiveFeishuAdapter,
    private readonly ingest: Ingest,
    private readonly onStatus?: (level: 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>) => void,
    private readonly ingestBatch?: IngestBatch,
    private readonly captureBatch?: IngestBatch,
  ) {}

  start() {
    if (this.timer || !this.config.scanEnabled) return;
    this.timer = setInterval(() => void this.runOnce(), this.config.scanIntervalSeconds * 1000);
    void this.runOnce();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async runAfterCurrent(context?: OperationContext): Promise<SyncResult> {
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    return this.runOnce(context);
  }

  async runOnce(context?: OperationContext): Promise<SyncResult> {
    if (this.running) return { scopes: 0, messages: 0, deduplicated: 0, failures: 0, skipped: true, reason: 'already_running' };
    if (!this.config.externalEnabled || !this.config.scanEnabled || this.config.groupIds.length === 0) {
      return { scopes: 0, messages: 0, deduplicated: 0, failures: 0, skipped: true, reason: 'scan_disabled' };
    }
    this.running = true;
    const result: SyncResult = { scopes: this.config.groupIds.length, messages: 0, deduplicated: 0, failures: 0, skipped: false };
    try {
      for (const groupId of this.config.groupIds) {
        try {
          const stats = await this.scanGroup(groupId, context);
          result.messages += stats.messages;
          result.deduplicated += stats.deduplicated;
          result.failures += stats.failures;
        } catch (error) {
          result.failures += 1;
          this.onStatus?.('error', '飞书需求群扫描失败。', { scope: 'group', failed: true, ...context });
          this.saveCursorError(groupId, error instanceof Error ? error.message : 'scan_failed', context);
        }
      }
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
    return result;
  }

  private async scanGroup(groupId: string, context?: OperationContext) {
    const cursor = this.readOrCreateCursor(groupId);
    const startTime = new Date(Math.max(0, cursor - this.config.scanOverlapSeconds * 1000)).toISOString();
    let pageToken: string | undefined;
    let pages = 0;
    let latest = cursor;
    let messages = 0;
    let deduplicated = 0;
    let failures = 0;
    const pendingEvents: NormalizedSourceEvent[] = [];
    try {
      do {
        if (++pages > 100) throw new Error('飞书分页超过安全上限。');
        const page = await this.adapter.listMessages({ chatId: groupId, startTime, sortType: 'asc', pageSize: this.config.scanPageSize, pageToken, authMode: 'app', operationContext: context }) as {
          items?: unknown[];
          has_more?: boolean;
          page_token?: string;
        };
        for (const item of page.items ?? []) {
          const event = this.adapter.normalizeMessageRecord(item);
          if (!event || event.conversationId !== groupId) continue;
          const occurred = Date.parse(event.occurredAt);
          latest = Math.max(latest, Number.isFinite(occurred) ? occurred : latest);
          pendingEvents.push(event);
        }
        const nextToken = page.has_more ? page.page_token : undefined;
        if (page.has_more && !nextToken) throw new Error('飞书需求群分页返回了下一页标记，但没有分页游标。');
        if (nextToken && nextToken === pageToken) throw new Error('飞书分页游标没有前进。');
        pageToken = nextToken;
      } while (pageToken);
    } catch (error) {
      // Keep pages already returned by Feishu, but never classify an
      // incomplete history window. The old cursor stays in place so the next
      // complete scan can submit the whole batch once.
      if (pendingEvents.length > 0 && this.captureBatch) await this.captureBatch(pendingEvents, context);
      throw error;
    }
    if (pendingEvents.length > 0) {
      try {
        if (this.ingestBatch) {
          const outcome = await this.ingestBatch(pendingEvents, context) as { deduplicated?: number } | undefined;
          messages += pendingEvents.length;
          deduplicated += outcome?.deduplicated ?? 0;
        } else {
          for (const event of pendingEvents) {
            const outcome = await this.ingest(event, context) as { deduplicated?: boolean };
            messages += 1;
            if (outcome?.deduplicated) deduplicated += 1;
          }
        }
      } catch {
        failures += 1;
      }
    }
    if (failures > 0) {
      this.saveCursorError(groupId, `有 ${failures} 条需求群消息未处理成功；后续会在重叠窗口内重试。`, context);
      this.onStatus?.('warn', '飞书需求群存在未处理消息，本轮保留旧游标。', { scope: 'group', failures, ...context });
      return { messages, deduplicated, failures };
    }
    this.saveCursor(groupId, new Date(latest).toISOString(), null);
    this.onStatus?.('info', '飞书需求群扫描完成。', { scope: 'group', messages, deduplicated, failures, ...context });
    return { messages, deduplicated, failures };
  }

  private saveCursor(scopeKey: string, cursor: string | null, lastError: string | null) {
    this.database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES ('feishu_group', ?, ?, ?, ?, ?)
       ON CONFLICT(integration, scope_key) DO UPDATE SET cursor = excluded.cursor, last_success_at = excluded.last_success_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
    ).run(scopeKey, cursor, cursor ? now() : null, lastError, now());
  }

  private readOrCreateCursor(scopeKey: string) {
    const row = this.database.raw.prepare('SELECT cursor FROM sync_cursor WHERE integration = ? AND scope_key = ?').get('feishu_group', scopeKey) as { cursor: string | null } | undefined;
    const parsed = row?.cursor ? Date.parse(row.cursor) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
    const initial = new Date(Date.now() - this.config.scanOverlapSeconds * 1000).toISOString();
    this.database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES ('feishu_group', ?, ?, NULL, NULL, ?)
       ON CONFLICT(integration, scope_key) DO UPDATE SET
         cursor = excluded.cursor, last_success_at = NULL, updated_at = excluded.updated_at`,
    ).run(scopeKey, initial, now());
    return Date.parse(initial);
  }

  private saveCursorError(scopeKey: string, lastError: string, _context?: OperationContext) {
    this.database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES ('feishu_group', ?, NULL, NULL, ?, ?)
       ON CONFLICT(integration, scope_key) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at`,
    ).run(scopeKey, redactDiagnosticText(lastError, 300), now());
  }
}
