import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import type { FeishuAdapter } from '../src/integration-contracts.js';
import { FeishuDocumentContextService } from '../src/integrations/feishu-document-context.js';
import { FeishuDocumentContextSyncRunner } from '../src/integrations/feishu-document-sync.js';

describe('飞书文档背景到期刷新', () => {
  const databases: AppDatabase[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of databases.splice(0)) database.close();
  });

  it('旧消息不再重现时，也会发现到期文档的新 revision 并请求重判', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      FEISHU_EXTERNAL_ENABLED: 'true',
    });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    database.raw.prepare(
      `INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content, occurred_at, captured_at)
       VALUES ('source-1', 'message-1', 'owner_dm', 'chat-1', 'user-1', '需求方', ?, ?, ?)`,
    ).run(
      '请分析活动留存，背景在 https://example.feishu.cn/docx/doc-1',
      '2026-08-11T04:00:00.000Z',
      '2026-08-11T04:00:00.000Z',
    );
    let revision = 1;
    let content = '第一版背景：验证留存。';
    const adapter = {
      getDocxDocument: async () => ({ document: { title: '需求背景', revision_id: revision } }),
      getDocxRawContent: async () => ({ content }),
      getWikiNode: async () => ({}),
    } as unknown as FeishuAdapter;
    const contexts = new FeishuDocumentContextService(database, adapter);
    await contexts.refresh('source-1', 'https://example.feishu.cn/docx/doc-1', true);
    database.raw.prepare("UPDATE source_context SET checked_at = '2020-01-01T00:00:00.000Z'").run();
    revision = 2;
    content = '第二版背景：补充付费和留存。';
    const reclassify = vi.fn(async (_sourceEventId: string) => undefined);
    const runner = new FeishuDocumentContextSyncRunner(config.feishu, database, contexts, reclassify);

    const result = await runner.runOnce();

    expect(result).toEqual({ checked: 1, changed: 1, failures: 0, skipped: false });
    expect(reclassify).toHaveBeenCalledWith('source-1');
    expect(contexts.list('source-1')[0]).toMatchObject({ sourceVersion: '2', contentExcerpt: content, status: 'ready' });
  });

  it('文档版本未变化时仍进入轻量对账，由服务端版本门避免重复写入', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      FEISHU_EXTERNAL_ENABLED: 'true',
    });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    database.raw.prepare(
      `INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content, occurred_at, captured_at)
       VALUES ('source-1', 'message-1', 'owner_dm', 'chat-1', 'user-1', '需求方', ?, ?, ?)`,
    ).run(
      '请分析活动留存，背景在 https://example.feishu.cn/docx/doc-1',
      '2026-08-11T04:00:00.000Z',
      '2026-08-11T04:00:00.000Z',
    );
    const adapter = {
      getDocxDocument: async () => ({ document: { title: '需求背景', revision_id: 1 } }),
      getDocxRawContent: async () => ({ content: '稳定版本背景。' }),
      getWikiNode: async () => ({}),
    } as unknown as FeishuAdapter;
    const contexts = new FeishuDocumentContextService(database, adapter);
    await contexts.refresh('source-1', 'https://example.feishu.cn/docx/doc-1', true);
    database.raw.prepare("UPDATE source_context SET checked_at = '2020-01-01T00:00:00.000Z'").run();
    const reclassify = vi.fn(async (_sourceEventId: string) => undefined);
    const runner = new FeishuDocumentContextSyncRunner(config.feishu, database, contexts, reclassify);

    await expect(runner.runOnce()).resolves.toEqual({ checked: 1, changed: 0, failures: 0, skipped: false });
    expect(reclassify).toHaveBeenCalledWith('source-1');
  });

  it('升级前没有 source_context 的 Docx 和 Wiki 历史来源会被受限回填，普通消息和 Sheets 不会被扫描', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      FEISHU_EXTERNAL_ENABLED: 'true',
    });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const insert = database.raw.prepare(
      `INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content, occurred_at, captured_at)
       VALUES (?, ?, 'owner_dm', 'chat-1', 'user-1', '需求方', ?, ?, ?)`,
    );
    const occurredAt = '2026-08-10T04:00:00.000Z';
    insert.run('legacy-docx', 'message-docx', '背景在 https://example.feishu.cn/docx/doc-legacy', occurredAt, occurredAt);
    insert.run('legacy-wiki', 'message-wiki', String.raw`背景在 https:\/\/example.feishu.cn/wiki/wiki-legacy`, occurredAt, occurredAt);
    insert.run('legacy-sheet', 'message-sheet', '表格在 https://example.feishu.cn/sheets/sheet-legacy', occurredAt, occurredAt);
    insert.run('legacy-plain', 'message-plain', '这是一条没有文档链接的普通消息。', occurredAt, occurredAt);
    const adapter = {
      getDocxDocument: vi.fn(async (documentId: string) => ({ document: { title: documentId, revision_id: 1 } })),
      getDocxRawContent: vi.fn(async (documentId: string) => ({ content: `${documentId} 的历史背景。` })),
      getWikiNode: vi.fn(async () => ({ node: { obj_type: 'docx', obj_token: 'wiki-docx', title: '知识库背景' } })),
    } as unknown as FeishuAdapter;
    const contexts = new FeishuDocumentContextService(database, adapter);
    const reclassify = vi.fn(async (_sourceEventId: string) => undefined);
    const runner = new FeishuDocumentContextSyncRunner(config.feishu, database, contexts, reclassify);

    await expect(runner.runOnce()).resolves.toEqual({ checked: 2, changed: 2, failures: 0, skipped: false });
    expect(reclassify.mock.calls.map(([sourceEventId]) => sourceEventId).sort()).toEqual(['legacy-docx', 'legacy-wiki']);
    expect(contexts.list('legacy-docx')).toHaveLength(1);
    expect(contexts.list('legacy-wiki')).toHaveLength(1);
    expect(contexts.list('legacy-sheet')).toHaveLength(0);
    expect(contexts.list('legacy-plain')).toHaveLength(0);
  });

  it('历史回填与到期刷新合计每轮最多处理 50 条，并会在下一轮继续剩余来源', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      FEISHU_EXTERNAL_ENABLED: 'true',
    });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const insert = database.raw.prepare(
      `INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content, occurred_at, captured_at)
       VALUES (?, ?, 'owner_dm', 'chat-1', 'user-1', '需求方', ?, ?, ?)`,
    );
    const occurredAt = '2026-08-10T04:00:00.000Z';
    for (let index = 1; index <= 60; index += 1) {
      insert.run(`legacy-${index}`, `message-${index}`, `背景在 https://example.feishu.cn/docx/doc-${index}`, occurredAt, occurredAt);
    }
    const adapter = {
      getDocxDocument: async (documentId: string) => ({ document: { title: documentId, revision_id: 1 } }),
      getDocxRawContent: async (documentId: string) => ({ content: `${documentId} 的背景。` }),
      getWikiNode: async () => ({}),
    } as unknown as FeishuAdapter;
    const contexts = new FeishuDocumentContextService(database, adapter);
    for (let index = 31; index <= 60; index += 1) {
      await contexts.refresh(`legacy-${index}`, `背景在 https://example.feishu.cn/docx/doc-${index}`, true);
    }
    database.raw.prepare("UPDATE source_context SET checked_at = '2020-01-01T00:00:00.000Z'").run();
    const reclassify = vi.fn(async (_sourceEventId: string) => undefined);
    const runner = new FeishuDocumentContextSyncRunner(config.feishu, database, contexts, reclassify);

    await expect(runner.runOnce()).resolves.toEqual({ checked: 50, changed: 25, failures: 0, skipped: false });
    await expect(runner.runOnce()).resolves.toEqual({ checked: 10, changed: 5, failures: 0, skipped: false });
    expect(reclassify).toHaveBeenCalledTimes(60);
  });
});
