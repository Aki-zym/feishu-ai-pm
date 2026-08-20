import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database.js';
import type { SourceDocumentContext, SourceContextStatus } from '../domain.js';
import type { FeishuAdapter } from '../integration-contracts.js';
import { redactDiagnosticText } from '../redaction.js';

const MAX_CONTEXT_CHARS = 8_000;
export const FEISHU_DOCUMENT_REFRESH_TTL_MS = 5 * 60 * 1_000;
const MAX_SNAPSHOT_ATTEMPTS = 3;

type DocumentType = SourceDocumentContext['documentType'];

type SourceContextRow = {
  source_url: string;
  external_id: string;
  document_type: DocumentType;
  title: string | null;
  source_version: string | null;
  content_excerpt: string | null;
  content_hash: string | null;
  status: SourceContextStatus;
  freshness: SourceDocumentContext['freshness'];
  completeness: SourceDocumentContext['completeness'];
  truncated: number;
  last_error: string | null;
  last_success_at: string | null;
  checked_at: string;
};

export type FeishuDocumentLink = {
  sourceUrl: string;
  token: string;
  documentType: DocumentType;
};

function safeErrorText(error: unknown) {
  return redactDiagnosticText(error instanceof Error ? error : error ?? '飞书文档读取失败。', 300);
}

function errorStatus(error: unknown): SourceContextStatus {
  const value = error as { code?: unknown; status?: unknown; statusCode?: unknown; response?: { status?: unknown; data?: { code?: unknown } } };
  const code = `${value?.status ?? value?.statusCode ?? value?.code ?? value?.response?.status ?? value?.response?.data?.code ?? ''}`;
  const message = safeErrorText(error);
  if (/401|403|9999166[34]|99991672|permission|scope|forbidden|unauthor|oauth|无权|权限|授权/i.test(`${code} ${message}`)) return 'unauthorized';
  if (/404|not.?found|deleted|removed|不存在|已删除/i.test(`${code} ${message}`)) return 'not_found';
  return 'error';
}

function rowToContext(row: SourceContextRow): SourceDocumentContext {
  return {
    sourceUrl: row.source_url,
    documentId: row.external_id,
    documentType: row.document_type,
    title: row.title,
    sourceVersion: row.source_version,
    contentExcerpt: row.content_excerpt,
    contentHash: row.content_hash,
    status: row.status,
    freshness: row.freshness,
    completeness: row.completeness,
    truncated: Boolean(row.truncated),
    lastError: row.last_error,
    lastSuccessAt: row.last_success_at,
    checkedAt: row.checked_at,
  };
}

function normalizeCandidateUrl(raw: string) {
  return raw.replace(/[),.;!?，。；！？）\]}]+$/u, '');
}

export function extractFeishuDocumentLinks(content: string): FeishuDocumentLink[] {
  const normalized = content.replace(/\\\//g, '/').replace(/&amp;/gi, '&');
  const matches = normalized.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  const links = new Map<string, FeishuDocumentLink>();
  for (const raw of matches) {
    try {
      const url = new URL(normalizeCandidateUrl(raw));
      const hostname = url.hostname.toLowerCase();
      if (!(hostname === 'feishu.cn' || hostname.endsWith('.feishu.cn') || hostname === 'larksuite.com' || hostname.endsWith('.larksuite.com'))) continue;
      const parts = url.pathname.split('/').filter(Boolean);
      const route = parts[0]?.toLowerCase();
      const token = parts[1];
      if (!route || !token) continue;
      const documentType: DocumentType = route === 'docx'
        ? 'docx'
        : route === 'wiki'
          ? 'wiki'
          : route === 'sheets'
            ? 'sheet'
            : route === 'base' || route === 'bitable'
              ? 'bitable'
              : route === 'doc'
                ? 'doc'
                : route === 'file'
                  ? 'file'
                  : route === 'slides'
                    ? 'slides'
                    : 'unknown';
      if (documentType === 'unknown') continue;
      const sourceUrl = `${url.protocol}//${url.host}/${route}/${token}`;
      links.set(sourceUrl, { sourceUrl, token, documentType });
    } catch {
      // Malformed links remain part of the original source, but do not block it.
    }
  }
  return [...links.values()];
}

function contextHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function numericVersion(value: string | null | undefined) {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function sourceContextRevision(contexts: SourceDocumentContext[]) {
  const stable = contexts
    .map((context) => ({
      sourceUrl: context.sourceUrl,
      documentId: context.documentId,
      documentType: context.documentType,
      title: context.title,
      sourceVersion: context.sourceVersion,
      contentHash: context.contentHash,
      status: context.status,
      freshness: context.freshness,
      completeness: context.completeness,
      truncated: context.truncated,
    }))
    .sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
  return contextHash(JSON.stringify(stable));
}

export class FeishuDocumentContextService {
  private readonly inFlight = new Map<string, Promise<SourceDocumentContext[]>>();

  constructor(
    private readonly database: AppDatabase,
    private readonly adapter: FeishuAdapter,
  ) {}

  list(sourceEventId: string) {
    const rows = this.database.raw.prepare(
      'SELECT source_url, external_id, document_type, title, source_version, content_excerpt, content_hash, status, freshness, completeness, truncated, last_error, last_success_at, checked_at FROM source_context WHERE source_event_id = ? ORDER BY source_url',
    ).all(sourceEventId) as SourceContextRow[];
    return rows.map(rowToContext);
  }

  refresh(sourceEventId: string, content: string, force = false) {
    const active = this.inFlight.get(sourceEventId);
    if (active) return active;
    const task = this.refreshInternal(sourceEventId, content, force, 0).finally(() => {
      if (this.inFlight.get(sourceEventId) === task) this.inFlight.delete(sourceEventId);
    });
    this.inFlight.set(sourceEventId, task);
    return task;
  }

  private async refreshInternal(
    sourceEventId: string,
    fallbackContent: string,
    force: boolean,
    staleAttempts: number,
  ): Promise<SourceDocumentContext[]> {
    const sourceBefore = this.database.raw.prepare('SELECT content FROM source_event WHERE id = ?').get(sourceEventId) as { content: string } | undefined;
    const content = sourceBefore?.content ?? fallbackContent;
    const links = extractFeishuDocumentLinks(content);
    const current = new Map(this.list(sourceEventId).map((context) => [context.sourceUrl, context]));
    const activeUrls = new Set(links.map((link) => link.sourceUrl));
    for (const existingUrl of current.keys()) {
      if (!activeUrls.has(existingUrl)) {
        this.database.raw.prepare('DELETE FROM source_context WHERE source_event_id = ? AND source_url = ?').run(sourceEventId, existingUrl);
      }
    }

    for (const link of links) {
      const existing = current.get(link.sourceUrl);
      const checkedAt = existing ? Date.parse(existing.checkedAt) : Number.NaN;
      if (!force && Number.isFinite(checkedAt) && Date.now() - checkedAt < FEISHU_DOCUMENT_REFRESH_TTL_MS) continue;
      const next = await this.read(link, existing);
      this.upsert(sourceEventId, next);
    }
    const sourceAfter = this.database.raw.prepare('SELECT content FROM source_event WHERE id = ?').get(sourceEventId) as { content: string } | undefined;
    if (sourceAfter && sourceAfter.content !== content) {
      if (staleAttempts >= 2) throw new Error('来源消息在读取文档背景期间持续更新，请稍后重试。');
      return this.refreshInternal(sourceEventId, sourceAfter.content, true, staleAttempts + 1);
    }
    return this.list(sourceEventId);
  }

  private async read(link: FeishuDocumentLink, existing?: SourceDocumentContext): Promise<SourceDocumentContext> {
    const checkedAt = new Date().toISOString();
    if (!['docx', 'wiki'].includes(link.documentType)) {
      return {
        sourceUrl: link.sourceUrl,
        documentId: link.token,
        documentType: link.documentType,
        title: null,
        sourceVersion: null,
        contentExcerpt: null,
        contentHash: null,
        status: 'unsupported',
        freshness: 'fresh',
        completeness: 'limited',
        truncated: false,
        lastError: '链接已识别；当前版本只读取 Docx，以及实际指向 Docx 的 Wiki 节点。',
        lastSuccessAt: null,
        checkedAt,
      };
    }

    try {
      let documentId = link.token;
      let title: string | null = null;
      if (link.documentType === 'wiki') {
        const wiki = await this.adapter.getWikiNode(link.token) as { node?: { obj_type?: string; obj_token?: string; title?: string } };
        const node = wiki?.node;
        title = node?.title ?? null;
        if (!node?.obj_token) throw new Error('飞书没有返回知识库节点对应的文档 token。');
        if (node.obj_type !== 'docx') {
          return {
            sourceUrl: link.sourceUrl,
            documentId: node.obj_token,
            documentType: link.documentType,
            title,
            sourceVersion: null,
            contentExcerpt: null,
            contentHash: null,
            status: 'unsupported',
            freshness: 'fresh',
            completeness: 'limited',
            truncated: false,
            lastError: `知识库节点类型为 ${node.obj_type || '未知'}；当前版本只读取 Docx。`,
            lastSuccessAt: null,
            checkedAt,
          };
        }
        documentId = node.obj_token;
      }

      const { metadata, raw } = await this.readDocxSnapshot(documentId);
      const text = typeof raw?.content === 'string' ? raw.content.trim() : '';
      const truncated = text.length > MAX_CONTEXT_CHARS;
      const excerpt = text ? text.slice(0, MAX_CONTEXT_CHARS) : null;
      return {
        sourceUrl: link.sourceUrl,
        documentId,
        documentType: link.documentType,
        title: metadata?.document?.title ?? title,
        sourceVersion: metadata?.document?.revision_id === undefined ? null : String(metadata.document.revision_id),
        contentExcerpt: excerpt,
        contentHash: text ? contextHash(text) : null,
        status: text ? (truncated ? 'partial' : 'ready') : 'partial',
        freshness: 'fresh',
        completeness: text ? (truncated ? 'partial' : 'complete') : 'limited',
        truncated,
        lastError: text ? null : '文档可访问，但飞书没有返回可用于需求背景的纯文本。',
        lastSuccessAt: checkedAt,
        checkedAt,
      };
    } catch (error) {
      const status = errorStatus(error);
      const lastError = safeErrorText(error);
      if (status === 'error' && existing && ['ready', 'partial'].includes(existing.status) && existing.contentExcerpt) {
        return {
          ...existing,
          freshness: 'stale',
          lastError: `本次读取失败，正在使用上次成功版本：${lastError}`.slice(0, 300),
          checkedAt,
        };
      }
      return {
        sourceUrl: link.sourceUrl,
        documentId: link.token,
        documentType: link.documentType,
        title: existing?.title ?? null,
        sourceVersion: null,
        contentExcerpt: null,
        contentHash: null,
        status,
        freshness: 'fresh',
        completeness: 'limited',
        truncated: false,
        lastError,
        lastSuccessAt: null,
        checkedAt,
      };
    }
  }

  private async readDocxSnapshot(documentId: string) {
    for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const before = await this.adapter.getDocxDocument(documentId) as { document?: { revision_id?: number; title?: string } };
      const raw = await this.adapter.getDocxRawContent(documentId) as { content?: string };
      const after = await this.adapter.getDocxDocument(documentId) as { document?: { revision_id?: number; title?: string } };
      const beforeVersion = before?.document?.revision_id;
      const afterVersion = after?.document?.revision_id;
      if (beforeVersion === undefined || afterVersion === undefined || beforeVersion === afterVersion) {
        return { metadata: after?.document ? after : before, raw };
      }
      if (attempt === MAX_SNAPSHOT_ATTEMPTS) {
        throw new Error('飞书文档在读取期间持续更新，本轮保留上次成功版本并稍后重试。');
      }
    }
    throw new Error('飞书文档版本读取失败。');
  }

  private upsert(sourceEventId: string, context: SourceDocumentContext) {
    const stored = this.database.raw.prepare(
      'SELECT source_version FROM source_context WHERE source_event_id = ? AND source_url = ?',
    ).get(sourceEventId, context.sourceUrl) as { source_version: string | null } | undefined;
    const storedVersion = numericVersion(stored?.source_version);
    const incomingVersion = numericVersion(context.sourceVersion);
    if (storedVersion !== null && incomingVersion !== null && incomingVersion < storedVersion && ['ready', 'partial'].includes(context.status)) {
      return;
    }
    const timestamp = new Date().toISOString();
    this.database.raw.prepare(
      `INSERT INTO source_context
        (id, source_event_id, context_type, source_url, external_id, document_type, title, source_version, content_excerpt, content_hash, status, freshness, completeness, truncated, last_error, last_success_at, checked_at, created_at, updated_at)
       VALUES (?, ?, 'feishu_document', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_event_id, source_url) DO UPDATE SET
         external_id = excluded.external_id,
         document_type = excluded.document_type,
         title = excluded.title,
         source_version = excluded.source_version,
         content_excerpt = excluded.content_excerpt,
         content_hash = excluded.content_hash,
         status = excluded.status,
         freshness = excluded.freshness,
         completeness = excluded.completeness,
         truncated = excluded.truncated,
         last_error = excluded.last_error,
         last_success_at = excluded.last_success_at,
         checked_at = excluded.checked_at,
         updated_at = excluded.updated_at`,
    ).run(
      `ctx_${randomUUID()}`,
      sourceEventId,
      context.sourceUrl,
      context.documentId,
      context.documentType,
      context.title,
      context.sourceVersion,
      context.contentExcerpt,
      context.contentHash,
      context.status,
      context.freshness,
      context.completeness,
      context.truncated ? 1 : 0,
      context.lastError,
      context.lastSuccessAt,
      context.checkedAt,
      timestamp,
      timestamp,
    );
  }
}
