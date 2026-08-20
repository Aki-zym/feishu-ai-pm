import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../database.js';
import {
  FEISHU_DOCUMENT_REFRESH_TTL_MS,
  FeishuDocumentContextService,
  sourceContextRevision,
} from './feishu-document-context.js';
import type { OperationContext } from '../observability.js';

type StatusLevel = 'info' | 'warn' | 'error';
type Reclassify = (sourceEventId: string, context?: OperationContext) => Promise<unknown>;

type DueSource = {
  id: string;
  content: string;
};

export type DocumentContextSyncResult = {
  checked: number;
  changed: number;
  failures: number;
  skipped: boolean;
  reason?: 'already_running' | 'connection_disabled';
};

const MAX_SOURCES_PER_RUN = 50;

export class FeishuDocumentContextSyncRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly config: AppConfig['feishu'],
    private readonly database: AppDatabase,
    private readonly contexts: FeishuDocumentContextService,
    private readonly reclassify: Reclassify,
    private readonly onStatus?: (level: StatusLevel, message: string, context?: Record<string, unknown>) => void,
  ) {}

  start() {
    if (this.timer || !this.config.externalEnabled) return;
    const interval = Math.max(FEISHU_DOCUMENT_REFRESH_TTL_MS, this.config.scanIntervalSeconds * 1_000);
    this.timer = setInterval(() => void this.runOnce(), interval);
    void this.runOnce();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async runAfterCurrent(options: { force?: boolean } = {}, context?: OperationContext): Promise<DocumentContextSyncResult> {
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    return this.runOnce(options, context);
  }

  async runOnce(options: { force?: boolean } = {}, context?: OperationContext): Promise<DocumentContextSyncResult> {
    if (this.running) return { checked: 0, changed: 0, failures: 0, skipped: true, reason: 'already_running' };
    if (!this.config.externalEnabled) return { checked: 0, changed: 0, failures: 0, skipped: true, reason: 'connection_disabled' };
    this.running = true;
    let checked = 0;
    let changed = 0;
    let failures = 0;
    try {
      const sources = this.dueSources(Boolean(options.force));
      for (const source of sources) {
        try {
          const before = sourceContextRevision(this.contexts.list(source.id));
          const afterContexts = await this.contexts.refresh(source.id, source.content, true);
          checked += 1;
          if (sourceContextRevision(afterContexts) !== before) changed += 1;
          // Reconcile every due source. The service's combined-revision fast path
          // makes unchanged sources cheap, while a prior classifier failure still
          // gets another safe chance without losing the durable inbox record.
          if (context) await this.reclassify(source.id, context);
          else await this.reclassify(source.id);
        } catch (error) {
          failures += 1;
          this.onStatus?.('warn', '一条飞书文档背景刷新失败，原来源和上次成功版本已保留。', {
            sourceEventId: source.id,
            errorType: error instanceof Error ? error.name : 'unknown',
            ...context,
          });
        }
      }
      if (sources.length > 0) {
        this.onStatus?.(failures ? 'warn' : 'info', '飞书文档背景到期刷新完成。', { checked, changed, failures });
      }
      return { checked, changed, failures, skipped: false };
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private dueSources(force: boolean) {
    const backfill = this.backfillSources();
    const due = this.refreshSources(force);
    const sources: DueSource[] = [];
    const seen = new Set<string>();
    for (let index = 0; sources.length < MAX_SOURCES_PER_RUN && (index < backfill.length || index < due.length); index += 1) {
      for (const candidate of [backfill[index], due[index]]) {
        if (!candidate || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        sources.push(candidate);
        if (sources.length >= MAX_SOURCES_PER_RUN) break;
      }
    }
    return sources;
  }

  private backfillSources() {
    const statement = this.database.raw.prepare(
      `WITH no_context AS (
         SELECT
           source_event.id,
           source_event.content,
           source_event.occurred_at,
           LOWER(REPLACE(source_event.content, char(92) || '/', '/')) AS normalized_content
         FROM source_event
         WHERE NOT EXISTS (
           SELECT 1 FROM source_context WHERE source_context.source_event_id = source_event.id
         )
       )
       SELECT id, content
       FROM no_context
       WHERE normalized_content LIKE '%://feishu.cn/docx/%'
          OR normalized_content LIKE '%://%.feishu.cn/docx/%'
          OR normalized_content LIKE '%://feishu.cn/wiki/%'
          OR normalized_content LIKE '%://%.feishu.cn/wiki/%'
          OR normalized_content LIKE '%://larksuite.com/docx/%'
          OR normalized_content LIKE '%://%.larksuite.com/docx/%'
          OR normalized_content LIKE '%://larksuite.com/wiki/%'
          OR normalized_content LIKE '%://%.larksuite.com/wiki/%'
       ORDER BY occurred_at ASC, id ASC
       LIMIT ?`,
    );
    return statement.all(MAX_SOURCES_PER_RUN) as DueSource[];
  }

  private refreshSources(force: boolean) {
    const cutoff = new Date(Date.now() - FEISHU_DOCUMENT_REFRESH_TTL_MS).toISOString();
    const where = force ? '' : 'AND source_context.checked_at <= ?';
    const statement = this.database.raw.prepare(
      `SELECT source_event.id, source_event.content
       FROM source_event
       JOIN source_context ON source_context.source_event_id = source_event.id
       WHERE source_context.document_type IN ('docx', 'wiki') ${where}
       GROUP BY source_event.id, source_event.content
       ORDER BY MIN(source_context.checked_at) ASC
       LIMIT ?`,
    );
    return (force ? statement.all(MAX_SOURCES_PER_RUN) : statement.all(cutoff, MAX_SOURCES_PER_RUN)) as DueSource[];
  }
}
