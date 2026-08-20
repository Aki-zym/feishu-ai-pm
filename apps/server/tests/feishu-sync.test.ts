import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { LiveFeishuAdapter } from '../src/integrations/feishu.js';
import { FeishuSyncRunner } from '../src/integrations/feishu-sync.js';

class FakeAdapter extends LiveFeishuAdapter {
  calls = 0;
  readonly inputs: Array<Record<string, unknown>> = [];
  constructor(private readonly pages: unknown[]) {
    super(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', FEISHU_EXTERNAL_ENABLED: 'true', FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FEISHU_SCAN_ENABLED: 'true', FEISHU_GROUP_IDS: 'group-1' }).feishu, { client: {} as never });
  }
  override async listMessages(input: Record<string, unknown> = {}) {
    this.inputs.push(input);
    return this.pages[this.calls++] ?? { items: [], has_more: false };
  }
}

describe('FeishuSyncRunner', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-08-10T12:00:00.000Z') }));
  afterEach(() => vi.useRealTimers());

  it('按重叠时间窗分页并保存游标，重复消息交给主链去重', async () => {
    const database = new AppDatabase(':memory:', false);
    const adapter = new FakeAdapter([
      { items: [{ message_id: 'm1', chat_id: 'group-1', msg_type: 'text', create_time: '1786276800000', sender: { id: 'u1', sender_name: '需求方' }, body: { content: JSON.stringify({ text: '请分析留存数据。' }) } }], has_more: true, page_token: 'p2' },
      { items: [{ message_id: 'm1', chat_id: 'group-1', msg_type: 'text', create_time: '1786276800000', sender: { id: 'u1', sender_name: '需求方' }, body: { content: JSON.stringify({ text: '请分析留存数据。' }) } }], has_more: false },
    ]);
    const seen: string[] = [];
    const runner = new FeishuSyncRunner(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', FEISHU_EXTERNAL_ENABLED: 'true', FEISHU_SCAN_ENABLED: 'true', FEISHU_GROUP_IDS: 'group-1' }).feishu, database, adapter, async (event) => {
      const existing = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get(event.externalId);
      if (existing) return { deduplicated: true };
      database.raw.prepare('INSERT INTO source_event (id, external_id, source_type, conversation_id, sender_id, sender_name, content, occurred_at, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`src_${event.externalId}`, event.externalId, event.sourceType, event.conversationId, event.senderId, event.senderName, event.content, event.occurredAt, new Date().toISOString());
      seen.push(event.externalId);
      return { deduplicated: false };
    });
    const result = await runner.runOnce();
    expect(result).toMatchObject({ scopes: 1, messages: 2, deduplicated: 1, failures: 0, skipped: false });
    expect(adapter.inputs.every((input) => input.authMode === 'app')).toBe(true);
    expect(seen).toEqual(['m1']);
    expect((database.raw.prepare('SELECT cursor FROM sync_cursor WHERE scope_key = ?').get('group-1') as { cursor: string }).cursor).toBeTruthy();
    database.close();
  });

  it('跨分页的连续群消息在整群收齐后只提交一次批次', async () => {
    const database = new AppDatabase(':memory:', false);
    const adapter = new FakeAdapter([
      { items: [{ message_id: 'm2', chat_id: 'group-1', msg_type: 'text', create_time: '1786276860000', sender: { id: 'u1', sender_name: '需求方' }, body: { content: JSON.stringify({ text: '补充付费维度。' }) } }], has_more: true, page_token: 'p2' },
      { items: [{ message_id: 'm1', chat_id: 'group-1', msg_type: 'text', create_time: '1786276800000', sender: { id: 'u1', sender_name: '需求方' }, body: { content: JSON.stringify({ text: '请分析留存数据。' }) } }], has_more: false },
    ]);
    const batches: string[][] = [];
    const runner = new FeishuSyncRunner(
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', FEISHU_EXTERNAL_ENABLED: 'true', FEISHU_SCAN_ENABLED: 'true', FEISHU_GROUP_IDS: 'group-1' }).feishu,
      database,
      adapter,
      async () => { throw new Error('有 batch handler 时不应走单条入口。'); },
      undefined,
      async (events) => {
        batches.push(events.map((event) => event.externalId));
        return { deduplicated: 0 };
      },
    );

    const result = await runner.runOnce();

    expect(result).toMatchObject({ messages: 2, failures: 0 });
    expect(batches).toEqual([['m2', 'm1']]);
    database.close();
  });

  it('未配置指定群时安全跳过，不调用外部适配器', async () => {
    const database = new AppDatabase(':memory:', false);
    const adapter = new FakeAdapter([]);
    const result = await new FeishuSyncRunner(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', FEISHU_EXTERNAL_ENABLED: 'true', FEISHU_SCAN_ENABLED: 'true' }).feishu, database, adapter, async () => undefined).runOnce();
    expect(result.skipped).toBe(true);
    expect(adapter.calls).toBe(0);
    database.close();
  });

  it('手动同步会等待后台轮次结束后再真实补跑一次', async () => {
    const database = new AppDatabase(':memory:', false);
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    class BlockingAdapter extends FakeAdapter {
      override async listMessages(input: Record<string, unknown> = {}) {
        this.inputs.push(input);
        this.calls += 1;
        if (this.calls === 1) {
          firstStarted();
          await firstGate;
        }
        return { items: [], has_more: false };
      }
    }
    const adapter = new BlockingAdapter([]);
    const runner = new FeishuSyncRunner(
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', FEISHU_EXTERNAL_ENABLED: 'true', FEISHU_SCAN_ENABLED: 'true', FEISHU_GROUP_IDS: 'group-1' }).feishu,
      database,
      adapter,
      async () => undefined,
    );

    const background = runner.runOnce();
    await started;
    const manual = runner.runAfterCurrent();
    releaseFirst();

    await expect(background).resolves.toMatchObject({ skipped: false });
    await expect(manual).resolves.toMatchObject({ skipped: false });
    expect(adapter.calls).toBe(2);
    database.close();
  });

  it('首次需求群扫描失败时固定保存起始水位，恢复后仍从原窗口补扫', async () => {
    const database = new AppDatabase(':memory:', false);
    const failing = new FakeAdapter([]);
    failing.listMessages = async () => { failing.calls += 1; throw new Error('network failed'); };
    const liveConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', FEISHU_EXTERNAL_ENABLED: 'true', FEISHU_SCAN_ENABLED: 'true', FEISHU_SCAN_OVERLAP_SECONDS: '60', FEISHU_GROUP_IDS: 'group-1' }).feishu;
    await new FeishuSyncRunner(liveConfig, database, failing, async () => undefined).runOnce();
    const saved = database.raw.prepare("SELECT cursor, last_success_at, last_error FROM sync_cursor WHERE integration = 'feishu_group' AND scope_key = ?").get('group-1') as { cursor: string; last_success_at: string | null; last_error: string };
    expect(saved.last_success_at).toBeNull();
    expect(saved.last_error).toContain('network failed');

    vi.setSystemTime(new Date('2026-08-12T12:00:00.000Z'));
    let resumedStart = '';
    const resumed = new FakeAdapter([]);
    resumed.listMessages = async (input: any = {}) => { resumed.calls += 1; resumedStart = input.startTime; return { items: [], has_more: false }; };
    await new FeishuSyncRunner(liveConfig, database, resumed, async () => undefined).runOnce();

    expect(Date.parse(resumedStart)).toBe(Date.parse(saved.cursor) - 60_000);
    database.close();
  });

  it('第二页返回 HTTP 200 业务错误时只保存已抓来源，不分类半批且不推进游标', async () => {
    const database = new AppDatabase(':memory:', false);
    let calls = 0;
    const pages = [
      { code: 0, data: { items: [{ message_id: 'm1', chat_id: 'group-1', msg_type: 'text', create_time: '1786276800000', sender: { id: 'u1', sender_name: '需求方' }, body: { content: JSON.stringify({ text: '请分析留存数据。' }) } }], has_more: true, page_token: 'p2' } },
      { code: 99991400, msg: 'rate limit exceeded', request_id: 'req-page-2', data: { items: [], has_more: false } },
    ];
    const fakeClient = {
      im: { v1: { message: { list: async () => pages[calls++] } } },
    };
    const classified: string[] = [];
    const captured: string[] = [];
    const liveConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', FEISHU_EXTERNAL_ENABLED: 'true', FEISHU_SCAN_ENABLED: 'true', FEISHU_GROUP_IDS: 'group-1' }).feishu;
    const adapter = new LiveFeishuAdapter(liveConfig, { client: fakeClient as never });
    const initial = new Date(Date.now() - liveConfig.scanOverlapSeconds * 1000).toISOString();
    const result = await new FeishuSyncRunner(
      liveConfig,
      database,
      adapter,
      async (event) => { classified.push(event.externalId); return {}; },
      undefined,
      async (events) => { classified.push(...events.map((event) => event.externalId)); return {}; },
      async (events) => { captured.push(...events.map((event) => event.externalId)); return {}; },
    ).runOnce();

    expect(result.failures).toBe(1);
    expect(calls).toBe(2);
    expect(captured).toEqual(['m1']);
    expect(classified).toEqual([]);
    const cursor = database.raw.prepare("SELECT cursor, last_error FROM sync_cursor WHERE integration = 'feishu_group' AND scope_key = 'group-1'").get() as { cursor: string; last_error: string };
    expect(cursor.cursor).toBe(initial);
    expect(cursor.last_error).toBe('FEISHU_API_ERROR code=99991400 category=rate_limit request_id=req-page-2');
    expect(cursor.last_error).not.toContain('rate limit exceeded');
    database.close();
  });

  it('非法业务码只以 UNKNOWN 持久化且不推进游标', async () => {
    const database = new AppDatabase(':memory:', false);
    const liveConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', FEISHU_EXTERNAL_ENABLED: 'true', FEISHU_SCAN_ENABLED: 'true', FEISHU_GROUP_IDS: 'group-1' }).feishu;
    const initial = new Date(Date.now() - liveConfig.scanOverlapSeconds * 1000).toISOString();
    const adapter = new LiveFeishuAdapter(liveConfig, { client: {
      im: { v1: { message: { list: async () => ({
        code: ' access_token=should-not-appear ',
        msg: 'permission denied',
        request_id: 'req-invalid-code',
      }) } } },
    } as never });

    const result = await new FeishuSyncRunner(liveConfig, database, adapter, async () => undefined).runOnce();

    expect(result.failures).toBe(1);
    const cursor = database.raw.prepare("SELECT cursor, last_error FROM sync_cursor WHERE integration = 'feishu_group' AND scope_key = 'group-1'").get() as { cursor: string; last_error: string };
    expect(cursor.cursor).toBe(initial);
    expect(cursor.last_error).toBe('FEISHU_API_ERROR code=UNKNOWN category=business request_id=req-invalid-code');
    expect(cursor.last_error).not.toContain('access_token');
    expect(cursor.last_error).not.toContain('permission denied');
    database.close();
  });

  it('遗留空游标也会被修复为固定水位，连续故障时不会漂移', async () => {
    const database = new AppDatabase(':memory:', false);
    database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES ('feishu_group', 'group-1', NULL, NULL, 'legacy', ?)`,
    ).run(new Date().toISOString());
    const failing = new FakeAdapter([]);
    failing.listMessages = async () => { failing.calls += 1; throw new Error('network failed'); };
    const liveConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:', FEISHU_EXTERNAL_ENABLED: 'true', FEISHU_SCAN_ENABLED: 'true', FEISHU_SCAN_OVERLAP_SECONDS: '60', FEISHU_GROUP_IDS: 'group-1' }).feishu;

    await new FeishuSyncRunner(liveConfig, database, failing, async () => undefined).runOnce();
    const first = database.raw.prepare("SELECT cursor FROM sync_cursor WHERE integration = 'feishu_group' AND scope_key = 'group-1'").get() as { cursor: string };
    vi.setSystemTime(new Date('2026-08-12T12:00:00.000Z'));
    await new FeishuSyncRunner(liveConfig, database, failing, async () => undefined).runOnce();
    const second = database.raw.prepare("SELECT cursor FROM sync_cursor WHERE integration = 'feishu_group' AND scope_key = 'group-1'").get() as { cursor: string };

    expect(first.cursor).toBeTruthy();
    expect(second.cursor).toBe(first.cursor);
    database.close();
  });
});
