import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import type { FeishuAdapter } from '../src/integration-contracts.js';
import { createAdapters } from '../src/integrations.js';
import { extractFeishuDocumentLinks, FeishuDocumentContextService, sourceContextRevision } from '../src/integrations/feishu-document-context.js';
import { PmService } from '../src/service.js';

function source(
  database: AppDatabase,
  id = 'source-1',
  content = '请分析背景：https://example.feishu.cn/docx/doc-1',
) {
  const now = '2026-08-11T04:00:00.000Z';
  database.raw.prepare(
    `INSERT INTO source_event
      (id, external_id, source_type, conversation_id, sender_id, sender_name, content, occurred_at, captured_at)
     VALUES (?, ?, 'owner_dm', 'chat-1', 'user-1', '需求方', ?, ?, ?)`,
  ).run(id, `external-${id}`, content, now, now);
}

function adapter(overrides: Partial<FeishuAdapter> = {}) {
  return {
    normalizeSource: (event: unknown) => event,
    getDocxDocument: async () => ({ document: { title: '需求背景', revision_id: 1 } }),
    getDocxRawContent: async () => ({ content: '活动上线前需要验证留存和付费效果。' }),
    getWikiNode: async () => ({ node: { obj_type: 'docx', obj_token: 'docx-from-wiki', title: '知识库需求背景' } }),
    ...overrides,
  } as FeishuAdapter;
}

describe('飞书文档背景上下文', () => {
  const databases: AppDatabase[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of databases.splice(0)) database.close();
  });

  it('识别 Docx/Wiki 并对同一链接去重，其他类型保留为受限线索', () => {
    const links = extractFeishuDocumentLinks([
      'https://example.feishu.cn/docx/doc-1',
      '再次引用 https://example.feishu.cn/docx/doc-1?from=chat',
      '知识库 https://example.feishu.cn/wiki/wiki-1',
      '表格 https://example.feishu.cn/sheets/sheet-1',
    ].join('\n'));
    expect(links).toEqual([
      { sourceUrl: 'https://example.feishu.cn/docx/doc-1', token: 'doc-1', documentType: 'docx' },
      { sourceUrl: 'https://example.feishu.cn/wiki/wiki-1', token: 'wiki-1', documentType: 'wiki' },
      { sourceUrl: 'https://example.feishu.cn/sheets/sheet-1', token: 'sheet-1', documentType: 'sheet' },
    ]);
  });

  it('用主人 OAuth 读取 Docx 和 Wiki→Docx，并保存有界版本上下文', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    source(database, 'source-1', 'https://example.feishu.cn/docx/doc-1 https://example.feishu.cn/wiki/wiki-1');
    const tested = new FeishuDocumentContextService(database, adapter());
    const contexts = await tested.refresh('source-1', 'https://example.feishu.cn/docx/doc-1 https://example.feishu.cn/wiki/wiki-1');
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toMatchObject({ documentId: 'doc-1', title: '需求背景', sourceVersion: '1', status: 'ready', completeness: 'complete' });
    expect(contexts[1]).toMatchObject({ documentId: 'docx-from-wiki', title: '需求背景', sourceVersion: '1', status: 'ready' });
    expect(contexts.every((context) => Boolean(context.contentHash))).toBe(true);
  });

  it('权限撤销后清除缓存正文；临时网络失败保留最后一次完整内容', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    source(database);
    const live = adapter();
    const tested = new FeishuDocumentContextService(database, live);
    const url = 'https://example.feishu.cn/docx/doc-1';
    const first = await tested.refresh('source-1', url, true);
    const original = first[0]!.contentExcerpt;

    live.getDocxDocument = async () => { throw new Error('network timeout'); };
    const transient = await tested.refresh('source-1', url, true);
    expect(transient[0]).toMatchObject({ status: 'ready', freshness: 'stale', completeness: 'complete', contentExcerpt: original });
    expect(transient[0]!.lastError).toContain('正在使用上次成功版本');
    expect(transient[0]!.lastError).toContain('network timeout');

    live.getDocxDocument = async () => ({ document: { title: '需求背景', revision_id: 1 } });
    const recovered = await tested.refresh('source-1', url, true);
    expect(recovered[0]).toMatchObject({ status: 'ready', freshness: 'fresh', lastError: null, contentExcerpt: original });

    live.getDocxDocument = async () => { throw Object.assign(new Error('permission denied'), { status: 403 }); };
    const revoked = await tested.refresh('source-1', url, true);
    expect(revoked[0]).toMatchObject({ status: 'unauthorized', contentExcerpt: null, contentHash: null, completeness: 'limited' });
  });

  it('文档版本或读取状态变化会改变上下文版本，相同内容不会', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    source(database);
    let revision = 1;
    const tested = new FeishuDocumentContextService(database, adapter({
      getDocxDocument: async () => ({ document: { title: '需求背景', revision_id: revision } }),
    }));
    const first = await tested.refresh('source-1', 'https://example.feishu.cn/docx/doc-1', true);
    const firstRevision = sourceContextRevision(first);
    expect(sourceContextRevision(await tested.refresh('source-1', 'https://example.feishu.cn/docx/doc-1', true))).toBe(firstRevision);
    revision = 2;
    expect(sourceContextRevision(await tested.refresh('source-1', 'https://example.feishu.cn/docx/doc-1', true))).not.toBe(firstRevision);
  });

  it('较旧的文档 revision 不会反向覆盖已经保存的新版本', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    source(database);
    let revision = 2;
    const tested = new FeishuDocumentContextService(database, adapter({
      getDocxDocument: async () => ({ document: { title: '需求背景', revision_id: revision } }),
    }));
    await tested.refresh('source-1', 'https://example.feishu.cn/docx/doc-1', true);
    revision = 1;
    const afterOlderResponse = await tested.refresh('source-1', 'https://example.feishu.cn/docx/doc-1', true);
    expect(afterOlderResponse[0]).toMatchObject({ sourceVersion: '2', status: 'ready' });
  });

  it('文档读取失败不会丢失先写入的来源，候选会标明文档受限', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const service = new PmService(database, createAdapters(config), config);
    const result = await service.ingestSource({
      externalId: 'message-with-doc',
      sourceType: 'owner_dm',
      conversationId: 'chat-1',
      senderId: 'user-1',
      senderName: '需求方',
      content: '请分析活动留存，背景在 https://example.feishu.cn/docx/doc-1',
      occurredAt: '2026-08-11T04:00:00.000Z',
    });
    expect(result.candidate).toBeTruthy();
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count).toBe(1);
    const context = database.raw.prepare('SELECT status, content_excerpt FROM source_context').get() as { status: string; content_excerpt: string | null };
    expect(context).toEqual({ status: 'unauthorized', content_excerpt: null });
    const analysis = JSON.parse((database.raw.prepare('SELECT analysis_json FROM candidate_request').get() as { analysis_json: string }).analysis_json);
    expect(analysis.linkedDocuments[0]).toMatchObject({ status: 'unauthorized', sourceUrl: 'https://example.feishu.cn/docx/doc-1' });
  });

  it('正式任务的文档版本更新只产生私人复核提醒，不修改任务或创建 Outbox', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    let revision = 1;
    let body = '活动上线前需要验证留存。';
    const adapters = createAdapters(config);
    const service = new PmService(database, { ...adapters, feishu: adapter({
      getDocxDocument: async () => ({ document: { title: '需求背景', revision_id: revision } }),
      getDocxRawContent: async () => ({ content: body }),
    }) as unknown as typeof adapters.feishu }, config);
    const event = {
      externalId: 'accepted-document-update',
      sourceType: 'owner_dm' as const,
      conversationId: 'chat-1',
      senderId: 'user-1',
      senderName: '需求方',
      content: '请分析活动留存，背景在 https://example.feishu.cn/docx/doc-1',
      occurredAt: '2026-08-11T04:00:00.000Z',
    };
    const captured = await service.ingestSource(event);
    const capturedAnalysis = JSON.parse(captured.candidate!.analysis_json) as {
      fieldBasis: { background: string };
      linkedDocuments: Array<{ status: string; freshness: string }>;
    };
    expect(capturedAnalysis.fieldBasis.background).toBe('document');
    expect(capturedAnalysis.linkedDocuments[0]).toMatchObject({ status: 'ready', freshness: 'fresh' });
    const accepted = service.actOnCandidate(captured.candidate!.id, 'accept', undefined, service.getCandidate(captured.candidate!.id)!.version);
    const taskBefore = service.getTask(accepted.task!.id)!;
    const candidateBefore = service.getCandidate(captured.candidate!.id)!;

    revision = 2;
    body = '活动上线前还需要补充付费和次日留存验证。';
    database.raw.prepare("UPDATE source_context SET checked_at = '2020-01-01T00:00:00.000Z'").run();
    await service.ingestSource(event);

    expect(service.getTask(taskBefore.id)).toEqual(taskBefore);
    expect(service.getCandidate(candidateBefore.id)).toEqual(candidateBefore);
    expect(database.raw.prepare("SELECT task_id FROM notification WHERE task_id = ? AND reason LIKE '%原始来源发生更新%'").get(taskBefore.id)).toBeTruthy();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 });
  });
});
