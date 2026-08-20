import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { FeishuMinutesSyncRunner } from '../src/integrations/feishu-minutes-sync.js';
import { LiveFeishuAdapter } from '../src/integrations/feishu.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

type Page = { items?: unknown[]; has_more?: boolean; page_token?: string; notice?: string };

class ScriptedMinutesAdapter extends LiveFeishuAdapter {
  readonly searchCalls: Array<Record<string, unknown>> = [];
  readonly detailCalls: string[] = [];
  readonly artifactCalls: string[] = [];
  readonly transcriptCalls: string[] = [];
  private searchIndex = 0;

  constructor(
    private readonly scripts: {
      pages?: Array<Page | Error>;
      details?: Record<string, unknown | Error>;
      artifacts?: Record<string, unknown | Error>;
      transcripts?: Record<string, unknown | Error>;
    },
    config = liveConfig(),
  ) {
    super(config.feishu, { client: {} as never });
  }

  override async searchMinutes(input: Record<string, unknown> = {}): Promise<any> {
    this.searchCalls.push(input);
    const item = this.scripts.pages?.[this.searchIndex++] ?? { items: [], has_more: false };
    if (item instanceof Error) throw item;
    return item;
  }

  override async getMinute(token: string): Promise<any> {
    this.detailCalls.push(token);
    const item = this.scripts.details?.[token] ?? minute(token);
    if (item instanceof Error) throw item;
    return item;
  }

  override async getMinuteArtifacts(token: string): Promise<any> {
    this.artifactCalls.push(token);
    const item = this.scripts.artifacts?.[token] ?? { summary: '会议摘要', minute_todos: [{ content: '补充留存指标', assignees: ['owner-open'], is_done: false }] };
    if (item instanceof Error) throw item;
    return item;
  }

  override async getMinuteTranscript(token: string): Promise<any> {
    this.transcriptCalls.push(token);
    const item = this.scripts.transcripts?.[token] ?? { available: true, text: '请在下周前补齐活动留存分析。', truncated: false };
    if (item instanceof Error) throw item;
    return item;
  }
}

const fixedNow = new Date('2026-08-10T12:00:00.000Z');

function liveConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    FEISHU_EXTERNAL_ENABLED: 'true',
    FEISHU_APP_ID: 'test-app',
    FEISHU_APP_SECRET: 'test-secret',
    FEISHU_SCAN_ENABLED: 'false',
    FEISHU_GROUP_IDS: '',
    ...overrides,
  });
}

function seedOwner(database: AppDatabase) {
  const timestamp = fixedNow.toISOString();
  database.raw.prepare(
    `INSERT INTO owner_profile
      (id, open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json, last_synced_at, created_at, updated_at)
     VALUES ('primary', ?, ?, ?, ?, ?, 'authorized', ?, ?, ?, ?)`,
  ).run('owner-open', 'owner-union', 'owner-user', '系统主人', 'tenant-test', JSON.stringify([
    'minutes:minutes.search:read',
    'minutes:minutes.basic:read',
    'minutes:minutes.artifacts:read',
    'minutes:minutes.transcript:export',
  ]), timestamp, timestamp, timestamp);
}

function minute(token: string, patch: Record<string, unknown> = {}) {
  return {
    minute: {
      token,
      owner_id: 'requester-open',
      create_time: '1786356000000',
      title: '活动留存需求会',
      duration: '3600',
      url: `https://example.invalid/minutes/${token}`,
      note_id: `note-${token}`,
      ...patch,
    },
  };
}

function cursor(database: AppDatabase) {
  return database.raw.prepare("SELECT cursor, last_success_at, last_error FROM sync_cursor WHERE integration = 'feishu_minutes' AND scope_key = 'owner:primary'").get() as {
    cursor: string | null;
    last_success_at: string | null;
    last_error: string | null;
  } | undefined;
}

function saveCursor(database: AppDatabase, value: Record<string, unknown>) {
  const timestamp = fixedNow.toISOString();
  database.raw.prepare(
    `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
     VALUES ('feishu_minutes', 'owner:primary', ?, ?, NULL, ?)
     ON CONFLICT(integration, scope_key) DO UPDATE SET cursor = excluded.cursor, last_success_at = excluded.last_success_at, last_error = NULL, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(value), timestamp, timestamp);
}

describe('FeishuMinutesSyncRunner 会议纪要增量契约', () => {
  beforeEach(() => vi.useFakeTimers({ now: fixedNow }));
  afterEach(() => vi.useRealTimers());

  it.each([
    ['omitted/default-empty', '[]', false],
    ['invalid-json', 'not-json', false],
    ['explicit-empty', '[]', false],
    ['whitespace-scope', '["   "]', false],
    ['partial-scope', '["minutes:minutes.search:read"]', false],
    ['wrong-case', '["minutes:minutes.search:read","minutes:minutes.basic:read","minutes:minutes.artifacts:read","minutes:minutes.transcript:Export"]', false],
    ['duplicate-exact-scopes', '["minutes:minutes.search:read","minutes:minutes.basic:read","minutes:minutes.artifacts:read","minutes:minutes.transcript:export","minutes:minutes.search:read"]', true],
    ['valid-exact-scopes', '["minutes:minutes.search:read","minutes:minutes.basic:read","minutes:minutes.artifacts:read","minutes:minutes.transcript:export"]', true],
  ] as const)('durable scope gate rejects malformed or insufficient state before provider/cursor/business access: %s', async (_label, durableScopes, allowed) => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    database.raw.prepare("UPDATE owner_profile SET granted_scopes_json = ? WHERE id = 'primary'").run(durableScopes);
    const adapter = new ScriptedMinutesAdapter({ pages: [{ items: [], has_more: false }] });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, liveConfig());
    const runner = new FeishuMinutesSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event));

    const result = await runner.runOnce();

    expect(result.skipped).toBe(!allowed);
    if (allowed) {
      expect(result.reason).not.toBe('scope_required');
      expect(adapter.searchCalls).toHaveLength(1);
      expect(cursor(database)).toEqual(expect.objectContaining({ cursor: expect.any(String) }));
    } else {
      expect(result).toMatchObject({ skipped: true, reason: 'scope_required', failures: 0, minutes: 0 });
      expect(adapter.searchCalls).toHaveLength(0);
      expect(adapter.detailCalls).toHaveLength(0);
      expect(adapter.artifactCalls).toHaveLength(0);
      expect(adapter.transcriptCalls).toHaveLength(0);
      expect(cursor(database)).toBeUndefined();
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
      expect(database.raw.prepare("SELECT status FROM information_source_state WHERE source_kind = 'minutes'").get()).toEqual({ status: 'admin_required' });
    }
    database.close();
  });

  it('scope clear after an authorized run blocks concurrent runners without stale token fallback or business writes', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const firstAdapter = new ScriptedMinutesAdapter({ pages: [{ items: [{ token: 'minute-before-clear' }], has_more: false }] });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: firstAdapter }, liveConfig());
    const firstRunner = new FeishuMinutesSyncRunner(liveConfig().feishu, database, firstAdapter, (event) => service.ingestSource(event));
    await firstRunner.runOnce();
    const cursorBefore = cursor(database);
    const sourceCountBefore = (database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count;
    const candidateCountBefore = (database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number }).count;

    database.raw.prepare("UPDATE owner_profile SET granted_scopes_json = '[]' WHERE id = 'primary'").run();
    const adapterA = new ScriptedMinutesAdapter({ pages: [{ items: [{ token: 'minute-must-not-read-a' }], has_more: false }] });
    const adapterB = new ScriptedMinutesAdapter({ pages: [{ items: [{ token: 'minute-must-not-read-b' }], has_more: false }] });
    const runnerA = new FeishuMinutesSyncRunner(liveConfig().feishu, database, adapterA, (event) => service.ingestSource(event));
    const runnerB = new FeishuMinutesSyncRunner(liveConfig().feishu, database, adapterB, (event) => service.ingestSource(event));

    const [resultA, resultB] = await Promise.all([runnerA.runOnce(), runnerB.runOnce()]);

    expect(resultA).toMatchObject({ skipped: true, reason: 'scope_required' });
    expect(resultB).toMatchObject({ skipped: true, reason: 'scope_required' });
    expect(adapterA.searchCalls).toHaveLength(0);
    expect(adapterA.detailCalls).toHaveLength(0);
    expect(adapterA.artifactCalls).toHaveLength(0);
    expect(adapterA.transcriptCalls).toHaveLength(0);
    expect(adapterB.searchCalls).toHaveLength(0);
    expect(adapterB.detailCalls).toHaveLength(0);
    expect(adapterB.artifactCalls).toHaveLength(0);
    expect(adapterB.transcriptCalls).toHaveLength(0);
    expect(cursor(database)).toEqual(cursorBefore);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: sourceCountBefore });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: candidateCountBefore });
    database.close();
  });

  it('首次分页读取详情、行动项和受限转写，落入统一 inbox 后保存重叠游标', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const adapter = new ScriptedMinutesAdapter({
      pages: [
        { items: [{ token: 'minute-1', display_info: '活动留存需求会', meta_data: { app_link: 'https://example.invalid/minutes/minute-1' } }], has_more: true, page_token: 'page-2' },
        { items: [{ token: 'minute-2', display_info: '指标口径会' }], has_more: false },
      ],
      details: { 'minute-2': minute('minute-2', { title: '指标口径会' }) },
    });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, liveConfig());
    const runner = new FeishuMinutesSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event));

    const result = await runner.runOnce();

    expect(result).toMatchObject({ minutes: 2, failures: 0, pages: 2, skipped: false, mode: 'full' });
    expect(adapter.searchCalls).toHaveLength(2);
    const firstSearch = adapter.searchCalls[0]!;
    expect(firstSearch).toMatchObject({ pageToken: undefined, pageSize: 50 });
    expect(firstSearch.filter).toBeUndefined();
    expect(adapter.detailCalls).toEqual(['minute-1', 'minute-2']);
    expect(adapter.artifactCalls).toEqual(['minute-1', 'minute-2']);
    expect(adapter.transcriptCalls).toEqual(['minute-1', 'minute-2']);
    expect(JSON.parse(cursor(database)!.cursor!)).toMatchObject({ version: 1, mode: 'overlap', watermark: fixedNow.toISOString() });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 2 });
    const source = database.raw.prepare('SELECT external_id, source_type, sender_name, content, completeness, metadata_json FROM source_event WHERE external_id = ?').get('minutes:minute-1') as {
      external_id: string; source_type: string; sender_name: string; content: string; completeness: string; metadata_json: string;
    };
    expect(source).toMatchObject({ external_id: 'minutes:minute-1', source_type: 'meeting', sender_name: '飞书用户 requester-open', completeness: 'complete' });
    expect(source.content).toContain('补充留存指标');
    expect(JSON.parse(source.metadata_json)).toMatchObject({ minuteToken: 'minute-1', transcriptAvailable: true, sourceScope: 'owner_minutes' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 2 });
    database.close();
  });

  it('常规增量使用创建时间重叠窗口，每日全量对账可发现旧妙记的新版本', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const config = liveConfig();
    const watermark = new Date(fixedNow.getTime() - 60 * 60 * 1000).toISOString();
    saveCursor(database, {
      version: 1,
      mode: 'overlap',
      watermark,
      lastFullReconciledAt: fixedNow.toISOString(),
    });
    const overlapAdapter = new ScriptedMinutesAdapter({ pages: [{ items: [], has_more: false }] });
    const overlapResult = await new FeishuMinutesSyncRunner(config.feishu, database, overlapAdapter, async () => undefined).runOnce();
    expect(overlapResult.mode).toBe('overlap');
    expect(overlapAdapter.searchCalls[0]).toMatchObject({
      filter: {
        create_time: {
          start_time: String(Math.floor((Date.parse(watermark) - config.feishu.scanOverlapSeconds * 1000) / 1000)),
          end_time: String(Math.floor(fixedNow.getTime() / 1000)),
        },
      },
    });

    const initial = new ScriptedMinutesAdapter({ pages: [{ items: [{ token: 'minute-old' }], has_more: false }] });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: initial }, config);
    await new FeishuMinutesSyncRunner(config.feishu, database, initial, (event) => service.ingestSource(event)).runOnce();
    saveCursor(database, {
      version: 1,
      mode: 'overlap',
      watermark: fixedNow.toISOString(),
      lastFullReconciledAt: new Date(fixedNow.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const reconciled = new ScriptedMinutesAdapter({
      pages: [{ items: [{ token: 'minute-old' }], has_more: false }],
      details: { 'minute-old': minute('minute-old', { title: '旧妙记的新版本' }) },
      artifacts: { 'minute-old': { summary: '会议结束后补充的新行动项', minute_todos: [{ content: '新增回访分析', is_done: false }] } },
    });
    const reconciledResult = await new FeishuMinutesSyncRunner(config.feishu, database, reconciled, (event) => service.ingestSource(event)).runOnce();
    expect(reconciledResult.mode).toBe('full');
    expect(reconciled.searchCalls[0]?.filter).toBeUndefined();
    expect((database.raw.prepare('SELECT content FROM source_event WHERE external_id = ?').get('minutes:minute-old') as { content: string }).content).toContain('新增回访分析');
    expect(JSON.parse(cursor(database)!.cursor!)).toMatchObject({ lastFullReconciledAt: fixedNow.toISOString() });
    database.close();
  });

  it('同 token 同版本幂等；内容版本变化更新同一来源并重新判断', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const first = new ScriptedMinutesAdapter({ pages: [{ items: [{ token: 'minute-update', display_info: '留存会' }], has_more: false }] });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: first }, liveConfig());
    await new FeishuMinutesSyncRunner(liveConfig().feishu, database, first, (event) => service.ingestSource(event)).runOnce();
    const decisionsAfterFirst = (database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count;
    await new FeishuMinutesSyncRunner(liveConfig().feishu, database, first, (event) => service.ingestSource(event)).runOnce();
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE external_id = ?').get('minutes:minute-update') as { count: number }).count).toBe(1);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count).toBe(decisionsAfterFirst);

    const updated = new ScriptedMinutesAdapter({
      pages: [{ items: [{ token: 'minute-update', display_info: '留存会（更新）' }], has_more: false }],
      details: { 'minute-update': minute('minute-update', { title: '留存会（更新）' }) },
      artifacts: { 'minute-update': { summary: '新增付费指标行动项', minute_todos: [{ content: '补充付费指标', is_done: false }] } },
      transcripts: { 'minute-update': { available: true, text: '更新后的内容：补充付费指标。', truncated: false } },
    });
    const updatedResult = await new FeishuMinutesSyncRunner(liveConfig().feishu, database, updated, (event) => service.ingestSource(event)).runOnce();
    expect(updatedResult.minutes).toBe(1);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE external_id = ?').get('minutes:minute-update') as { count: number }).count).toBe(1);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count).toBeGreaterThan(decisionsAfterFirst);
    expect((database.raw.prepare('SELECT content FROM source_event WHERE external_id = ?').get('minutes:minute-update') as { content: string }).content).toContain('补充付费指标');
    database.close();
  });

  it('详情或转写权限不足时保留受限来源并推进游标，不写完整原文日志', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const forbidden = Object.assign(new Error('403 forbidden: permission denied'), { status: 403 });
    const adapter = new ScriptedMinutesAdapter({
      pages: [{ items: [{ token: 'minute-limited', display_info: '受限会议' }], has_more: false }],
      details: { 'minute-limited': forbidden },
      artifacts: { 'minute-limited': forbidden },
      transcripts: { 'minute-limited': forbidden },
    });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, liveConfig());
    const result = await new FeishuMinutesSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event)).runOnce();
    expect(result).toMatchObject({ minutes: 1, failures: 0, detailFailures: 1 });
    expect(cursor(database)!.last_success_at).toBe(fixedNow.toISOString());
    const source = database.raw.prepare('SELECT completeness, metadata_json, content FROM source_event WHERE external_id = ?').get('minutes:minute-limited') as { completeness: string; metadata_json: string; content: string };
    expect(source.completeness).toBe('limited');
    expect(JSON.parse(source.metadata_json)).toMatchObject({ accessStatus: 'denied', transcriptAvailable: false });
    expect(source.content).not.toContain('请在下周前补齐');
    const logs = database.raw.prepare("SELECT summary, context_json FROM app_log WHERE context_json LIKE '%下周%' OR summary LIKE '%下周%'").all();
    expect(logs).toHaveLength(0);
    database.close();
  });

  it('详情、AI 产物或转写鉴权失效会终止本轮、标记主人授权失效且不推进游标', async () => {
    for (const failedStep of ['details', 'artifacts', 'transcripts'] as const) {
      const database = new AppDatabase(':memory:', false);
      seedOwner(database);
      const previousCursor = {
        version: 1,
        mode: 'overlap',
        watermark: new Date(fixedNow.getTime() - 30 * 60 * 1000).toISOString(),
        lastFullReconciledAt: fixedNow.toISOString(),
      };
      saveCursor(database, previousCursor);
      const unauthorized = Object.assign(new Error('request failed'), { code: 99991663 });
      const adapter = new ScriptedMinutesAdapter({
        pages: [{ items: [{ token: `minute-auth-${failedStep}` }], has_more: false }],
        [failedStep]: { [`minute-auth-${failedStep}`]: unauthorized },
      });
      const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, liveConfig());
      const result = await new FeishuMinutesSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event)).runOnce();
      expect(result).toMatchObject({ failures: 1, reason: 'sync_failed' });
      expect(JSON.parse(cursor(database)!.cursor!)).toEqual(previousCursor);
      expect(cursor(database)!.last_error).toBe('FEISHU_API_ERROR code=99991663 category=authorization');
      expect(database.raw.prepare('SELECT oauth_status FROM owner_profile WHERE id = ?').get('primary')).toEqual({ oauth_status: 'expired' });
      expect(database.raw.prepare('SELECT status FROM information_source_state WHERE source_kind = ?').get('minutes')).toEqual({ status: 'unauthorized' });
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
      database.close();
    }
  });

  it('已有完整来源遇到临时读取失败时不会被受限版本覆盖或重新判断', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const config = liveConfig();
    const initial = new ScriptedMinutesAdapter({ pages: [{ items: [{ token: 'minute-stable' }], has_more: false }] });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: initial }, config);
    await new FeishuMinutesSyncRunner(config.feishu, database, initial, (event) => service.ingestSource(event)).runOnce();
    const before = database.raw.prepare('SELECT content, completeness, metadata_json FROM source_event WHERE external_id = ?').get('minutes:minute-stable') as {
      content: string;
      completeness: string;
      metadata_json: string;
    };
    const cursorBefore = cursor(database)!;
    const decisionsBefore = (database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count;
    const temporary = Object.assign(new Error('503 temporary unavailable'), { status: 503 });
    const degraded = new ScriptedMinutesAdapter({
      pages: [{ items: [{ token: 'minute-stable', display_info: '不完整搜索摘要' }], has_more: false }],
      details: { 'minute-stable': temporary },
    });
    const result = await new FeishuMinutesSyncRunner(config.feishu, database, degraded, (event) => service.ingestSource(event), undefined, async () => undefined).runOnce();
    expect(result).toMatchObject({ minutes: 0, failures: 1, detailFailures: 0, reason: 'sync_failed' });
    expect(cursor(database)!.cursor).toBe(cursorBefore.cursor);
    expect(cursor(database)!.last_success_at).toBe(cursorBefore.last_success_at);
    expect(database.raw.prepare('SELECT content, completeness, metadata_json FROM source_event WHERE external_id = ?').get('minutes:minute-stable')).toEqual(before);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count).toBe(decisionsBefore);

    const emptyDetail = new ScriptedMinutesAdapter({
      pages: [{ items: [{ token: 'minute-stable', display_info: '只有搜索摘要' }], has_more: false }],
      details: { 'minute-stable': { minute: null } },
    });
    const emptyResult = await new FeishuMinutesSyncRunner(config.feishu, database, emptyDetail, (event) => service.ingestSource(event)).runOnce();
    expect(emptyResult).toMatchObject({ minutes: 0, failures: 0, detailFailures: 1, deduplicated: 1 });
    expect(database.raw.prepare('SELECT content, completeness, metadata_json FROM source_event WHERE external_id = ?').get('minutes:minute-stable')).toEqual(before);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count).toBe(decisionsBefore);
    database.close();
  });

  it('新来源遇到错形或错层详情时降级为受限来源，不读取后续详情接口', async () => {
    for (const detail of [{}, { minute: null }, { token: 'minute-wrong-layer' }, { minute: { token: 'minute-other' } }]) {
      const database = new AppDatabase(':memory:', false);
      seedOwner(database);
      const adapter = new ScriptedMinutesAdapter({
        pages: [{ items: [{ token: 'minute-limited-shape', display_info: '受限会议' }], has_more: false }],
        details: { 'minute-limited-shape': detail },
      });
      const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, liveConfig());
      const result = await new FeishuMinutesSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event)).runOnce();

      expect(result).toMatchObject({ minutes: 1, failures: 0, detailFailures: 1 });
      expect(adapter.artifactCalls).toEqual([]);
      expect(adapter.transcriptCalls).toEqual([]);
      const source = database.raw.prepare('SELECT completeness, metadata_json FROM source_event WHERE external_id = ?').get('minutes:minute-limited-shape') as { completeness: string; metadata_json: string };
      expect(source.completeness).toBe('partial');
      expect(JSON.parse(source.metadata_json)).toMatchObject({ accessStatus: 'partial', detailsAvailable: false });
      database.close();
    }
  });

  it('搜索分页或耐久写入失败时不推进旧游标，限流错误可重试', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const timestamp = fixedNow.toISOString();
    database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at) VALUES ('feishu_minutes', 'owner:primary', ?, ?, NULL, ?)`,
    ).run(JSON.stringify({ version: 1, mode: 'overlap', watermark: timestamp }), timestamp, timestamp);
    const rateLimit = Object.assign(new Error('429 rate limit'), { status: 429 });
    const adapter = new ScriptedMinutesAdapter({ pages: [rateLimit, { items: [{ token: 'minute-retry' }], has_more: false }] });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, liveConfig());
    const result = await new FeishuMinutesSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event), undefined, async () => undefined).runOnce();
    expect(result.failures).toBe(0);
    expect(adapter.searchCalls.length).toBe(2);
    expect(JSON.parse(cursor(database)!.cursor!)).toMatchObject({ watermark: fixedNow.toISOString() });

    const failAdapter = new ScriptedMinutesAdapter({ pages: [{ items: [{ token: 'minute-ingest-fail' }], has_more: false }] });
    const before = cursor(database)!.cursor;
    const failed = await new FeishuMinutesSyncRunner(liveConfig().feishu, database, failAdapter, async () => { throw new Error('durable inbox unavailable'); }, undefined, async () => undefined).runOnce();
    expect(failed.failures).toBe(1);
    expect(cursor(database)!.cursor).toBe(before);
    expect(cursor(database)!.last_error).toContain('未写入主链');
    database.close();
  });

  it('真实网络错误按统一重试策略处理：成功只 durable ingest 一次，耗尽则保留旧水位', async () => {
    const successDatabase = new AppDatabase(':memory:', false);
    seedOwner(successDatabase);
    const timestamp = fixedNow.toISOString();
    saveCursor(successDatabase, { version: 1, mode: 'overlap', watermark: timestamp });
    const transportError = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    const successAdapter = new ScriptedMinutesAdapter({
      pages: [transportError, { items: [{ token: 'minute-transport-retry' }], has_more: false }],
    });
    const captured: string[] = [];
    const successRunner = new FeishuMinutesSyncRunner(
      liveConfig().feishu,
      successDatabase,
      successAdapter,
      async (event) => { captured.push(event.externalId); return {}; },
      undefined,
      async () => undefined,
    );

    const success = await successRunner.runOnce();

    expect(success).toMatchObject({ minutes: 1, failures: 0, skipped: false });
    expect(successAdapter.searchCalls).toHaveLength(2);
    expect(captured).toEqual(['minutes:minute-transport-retry']);
    expect(JSON.parse(cursor(successDatabase)!.cursor!)).toMatchObject({ watermark: fixedNow.toISOString() });
    successDatabase.close();

    const failureDatabase = new AppDatabase(':memory:', false);
    seedOwner(failureDatabase);
    saveCursor(failureDatabase, { version: 1, mode: 'overlap', watermark: timestamp });
    const before = cursor(failureDatabase)!;
    const failureAdapter = new ScriptedMinutesAdapter({
      pages: [
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      ],
    });
    const failureRunner = new FeishuMinutesSyncRunner(liveConfig().feishu, failureDatabase, failureAdapter, async () => ({}), undefined, async () => undefined);

    const failure = await failureRunner.runOnce();

    expect(failure.failures).toBeGreaterThan(0);
    expect(failureAdapter.searchCalls).toHaveLength(3);
    const after = cursor(failureDatabase)!;
    expect(after.cursor).toBe(before.cursor);
    expect(after.last_success_at).toBe(before.last_success_at);
    failureDatabase.close();
  });

  it('详情、AI 产物和转写的真实传输错误重试耗尽即失败，保留旧水位和完整来源', async () => {
    for (const failedStep of ['details', 'artifacts', 'transcripts'] as const) {
      const database = new AppDatabase(':memory:', false);
      seedOwner(database);
      const previousCursor = {
        version: 1,
        mode: 'overlap',
        watermark: new Date(fixedNow.getTime() - 30 * 60 * 1000).toISOString(),
        lastFullReconciledAt: fixedNow.toISOString(),
      };
      saveCursor(database, previousCursor);
      const initial = new ScriptedMinutesAdapter({ pages: [{ items: [{ token: `minute-transport-${failedStep}` }], has_more: false }] });
      const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: initial }, liveConfig());
      await new FeishuMinutesSyncRunner(liveConfig().feishu, database, initial, (event) => service.ingestSource(event)).runOnce();
      const sourceBefore = database.raw.prepare('SELECT content, completeness, metadata_json FROM source_event WHERE external_id = ?').get(`minutes:minute-transport-${failedStep}`);
      const decisionsBefore = (database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count;
      const cursorBefore = cursor(database)!;
      const transportError = Object.assign(new Error(`socket hang up token=synthetic-${failedStep}`), { code: 'ECONNRESET' });
      const failureAdapter = new ScriptedMinutesAdapter({
        pages: [{ items: [{ token: `minute-transport-${failedStep}`, display_info: '不完整搜索摘要' }], has_more: false }],
        details: failedStep === 'details' ? { [`minute-transport-${failedStep}`]: transportError } : undefined,
        artifacts: failedStep === 'artifacts' ? { [`minute-transport-${failedStep}`]: transportError } : undefined,
        transcripts: failedStep === 'transcripts' ? { [`minute-transport-${failedStep}`]: transportError } : undefined,
      });
      const captured: string[] = [];
      const failure = await new FeishuMinutesSyncRunner(
        liveConfig().feishu,
        database,
        failureAdapter,
        async (event) => { captured.push(event.externalId); return {}; },
        undefined,
        async () => undefined,
      ).runOnce();

      expect(failure).toMatchObject({ minutes: 0, failures: 1, detailFailures: 0, reason: 'sync_failed' });
      expect(failureAdapter.searchCalls).toHaveLength(1);
      expect(failureAdapter.detailCalls).toHaveLength(failedStep === 'details' ? 3 : 1);
      expect(failureAdapter.artifactCalls).toHaveLength(failedStep === 'artifacts' ? 3 : failedStep === 'details' ? 0 : 1);
      expect(failureAdapter.transcriptCalls).toHaveLength(failedStep === 'transcripts' ? 3 : 0);
      expect(captured).toEqual([]);
      expect(database.raw.prepare('SELECT content, completeness, metadata_json FROM source_event WHERE external_id = ?').get(`minutes:minute-transport-${failedStep}`)).toEqual(sourceBefore);
      expect((database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count).toBe(decisionsBefore);
      const cursorAfter = cursor(database)!;
      expect(cursorAfter.cursor).toBe(cursorBefore.cursor);
      expect(cursorAfter.last_success_at).toBe(cursorBefore.last_success_at);
      expect(cursorAfter.last_error).not.toContain('socket hang up');
      expect(cursorAfter.last_error).not.toContain('synthetic');
      database.close();
    }
  });

  it('单来源 API 运行妙记，统一同步结果包含 minutes', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const adapter = new ScriptedMinutesAdapter({ pages: [{ items: [{ token: 'minute-api' }], has_more: false }] });
    const service = new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, liveConfig());
    const app = await buildApp(service, { serveWeb: false });
    const minutes = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sources/minutes/sync' });
    expect(minutes.statusCode).toBe(200);
    expect(minutes.json()).toMatchObject({ outcome: 'success', messages: 1, failures: 0, sources: [{ source: 'minutes', counts: { minutes: 1 } }] });
    const all = await service.syncFeishuOnce();
    expect(all.sources).toContainEqual(expect.objectContaining({ source: 'minutes', status: 'success', counts: expect.objectContaining({ pages: 1 }) }));
    await app.close();
    database.close();
  });
});
