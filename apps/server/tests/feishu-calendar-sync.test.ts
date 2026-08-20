import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { FeishuCalendarSyncRunner } from '../src/integrations/feishu-calendar-sync.js';
import { LiveFeishuAdapter, parseDurableGrantedScopes } from '../src/integrations/feishu.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

type Page = { items?: unknown[]; has_more?: boolean; page_token?: string; sync_token?: string };

class ScriptedCalendarAdapter extends LiveFeishuAdapter {
  readonly listCalls: Array<{ calendarId?: string; pageToken?: string; syncToken?: string }> = [];
  readonly detailCalls: Array<{ calendarId?: string; eventId?: string }> = [];
  readonly primaryCalls: number[] = [];
  private listIndex = 0;

  constructor(
    private readonly scripts: { primary?: unknown | Error; pages?: Array<Page | Error>; details?: Record<string, unknown | Error> },
    config = liveConfig().feishu,
  ) {
    super(config, { client: {} as never });
  }

  override async primaryCalendar(): Promise<any> {
    this.primaryCalls.push(this.primaryCalls.length + 1);
    if (this.scripts.primary instanceof Error) throw this.scripts.primary;
    return this.scripts.primary ?? { calendars: [{ calendar: { calendar_id: 'cal-primary', type: 'primary', role: 'owner' }, user_id: 'owner-open' }] };
  }

  override async listCalendarEvents(input: Record<string, unknown> = {}): Promise<any> {
    this.listCalls.push({
      calendarId: input.calendarId ? String(input.calendarId) : undefined,
      pageToken: input.pageToken ? String(input.pageToken) : undefined,
      syncToken: input.syncToken ? String(input.syncToken) : undefined,
    });
    const item = this.scripts.pages?.[this.listIndex++] ?? { items: [], has_more: false, sync_token: 'sync-empty' };
    if (item instanceof Error) throw item;
    return item;
  }

  override async getCalendarEvent(input: Record<string, unknown> = {}): Promise<any> {
    const eventId = input.eventId ? String(input.eventId) : '';
    this.detailCalls.push({ calendarId: input.calendarId ? String(input.calendarId) : undefined, eventId });
    const item = this.scripts.details?.[eventId];
    if (item instanceof Error) throw item;
    return item ?? { event: calendarEvent(eventId) };
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
    'calendar:calendar:readonly',
    'minutes:minutes.search:read',
    'minutes:minutes.basic:read',
    'minutes:minutes.artifacts:read',
    'minutes:minutes.transcript:export',
  ]), timestamp, timestamp, timestamp);
}

function prepareService(database: AppDatabase, adapter: ScriptedCalendarAdapter, config = liveConfig()) {
  const base = createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' }));
  return new PmService(database, { ...base, feishu: adapter }, config);
}

function calendarEvent(eventId: string, patch: Record<string, unknown> = {}) {
  return {
    event_id: eventId,
    summary: '需求评审会',
    description: '请分析活动留存数据，支持是否继续投入的判断。',
    start_time: { timestamp: '1786356000', timezone: 'Asia/Shanghai' },
    end_time: { timestamp: '1786359600', timezone: 'Asia/Shanghai' },
    status: 'confirmed',
    event_organizer: { user_id: 'requester-open', display_name: '需求方' },
    app_link: `https://example.invalid/calendar/${eventId}`,
    attendees: [{ type: 'user', attendee_id: 'owner-open', display_name: '系统主人', rsvp_status: 'accept' }],
    vchat: { meeting_url: 'https://example.invalid/meeting' },
    ...patch,
  };
}

function seedCalendarCursor(database: AppDatabase, syncToken = 'sync-old') {
  const timestamp = fixedNow.toISOString();
  database.raw.prepare(
    `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
     VALUES ('feishu_calendar', 'calendar:cal-primary', ?, ?, NULL, ?)`,
  ).run(JSON.stringify({ version: 1, calendarId: 'cal-primary', mode: 'incremental', syncToken }), timestamp, timestamp);
}

function cursor(database: AppDatabase) {
  return database.raw.prepare("SELECT cursor, last_success_at, last_error FROM sync_cursor WHERE integration = 'feishu_calendar' AND scope_key = 'calendar:cal-primary'").get() as {
    cursor: string | null;
    last_success_at: string | null;
    last_error: string | null;
  } | undefined;
}

describe('FeishuCalendarSyncRunner 个人日历增量契约', () => {
  beforeEach(() => vi.useFakeTimers({ now: fixedNow }));
  afterEach(() => vi.useRealTimers());

  it.each([
    ['omitted/default-empty', '[]', false],
    ['invalid-json', 'not-json', false],
    ['explicit-empty', '[]', false],
    ['whitespace-scope', '["   "]', false],
    ['partial-scope', '["calendar:calendar"]', false],
    ['wrong-case', '["Calendar:calendar:readonly"]', false],
    ['duplicate-exact-scope', '["calendar:calendar:readonly","calendar:calendar:readonly"]', true],
    ['valid-exact-scope', '["calendar:calendar:readonly"]', true],
  ] as const)('durable scope gate rejects malformed or insufficient state before provider/cursor/business access: %s', async (_label, durableScopes, allowed) => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    database.raw.prepare("UPDATE owner_profile SET granted_scopes_json = ? WHERE id = 'primary'").run(durableScopes);
    const adapter = new ScriptedCalendarAdapter({ pages: [{ items: [], has_more: false, sync_token: 'sync-authorized' }] });
    const service = prepareService(database, adapter);
    const runner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event));

    const result = await runner.runOnce();

    expect(result.skipped).toBe(!allowed);
    if (allowed) {
      expect(result.reason).not.toBe('scope_required');
      expect(adapter.primaryCalls).toHaveLength(1);
      expect(adapter.listCalls).toHaveLength(1);
      expect(cursor(database)).toEqual(expect.objectContaining({ cursor: expect.any(String) }));
    } else {
      expect(result).toMatchObject({ skipped: true, reason: 'scope_required', failures: 0, events: 0 });
      expect(adapter.primaryCalls).toHaveLength(0);
      expect(adapter.listCalls).toHaveLength(0);
      expect(adapter.detailCalls).toHaveLength(0);
      expect(cursor(database)).toBeUndefined();
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
      expect(database.raw.prepare("SELECT status FROM information_source_state WHERE source_kind = 'calendar'").get()).toEqual({ status: 'admin_required' });
    }
    database.close();
  });

  it.each([
    ['omitted', undefined, 'missing'],
    ['null', null, 'null'],
    ['invalid-json', 'not-json', 'invalid_json'],
    ['invalid-type', '{}', 'invalid_type'],
    ['invalid-scope', '[" "]', 'invalid_scope'],
    ['duplicate-normalized', '["calendar:calendar:readonly"," calendar:calendar:readonly "]', 'valid'],
  ] as const)('canonical durable scope parser is strict and shared: %s', (_label, value, reason) => {
    const parsed = parseDurableGrantedScopes(value);
    expect(parsed.reason).toBe(reason);
    if (reason === 'valid') expect(parsed.scopes).toEqual(['calendar:calendar:readonly']);
    else expect(parsed.scopes).toEqual([]);
  });

  it('scope clear after an authorized run blocks concurrent runners without stale token fallback or business writes', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const firstAdapter = new ScriptedCalendarAdapter({ pages: [{ items: [calendarEvent('evt-before-clear')], has_more: false, sync_token: 'sync-before-clear' }] });
    const service = prepareService(database, firstAdapter);
    const firstRunner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, firstAdapter, (event) => service.ingestSource(event));
    await firstRunner.runOnce();
    const cursorBefore = cursor(database);
    const sourceCountBefore = (database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get() as { count: number }).count;
    const candidateCountBefore = (database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number }).count;

    database.raw.prepare("UPDATE owner_profile SET granted_scopes_json = '[]' WHERE id = 'primary'").run();
    const adapterA = new ScriptedCalendarAdapter({ pages: [{ items: [calendarEvent('evt-must-not-read-a')], has_more: false, sync_token: 'sync-a' }] });
    const adapterB = new ScriptedCalendarAdapter({ pages: [{ items: [calendarEvent('evt-must-not-read-b')], has_more: false, sync_token: 'sync-b' }] });
    const runnerA = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapterA, (event) => service.ingestSource(event));
    const runnerB = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapterB, (event) => service.ingestSource(event));

    const [resultA, resultB] = await Promise.all([runnerA.runOnce(), runnerB.runOnce()]);

    expect(resultA).toMatchObject({ skipped: true, reason: 'scope_required' });
    expect(resultB).toMatchObject({ skipped: true, reason: 'scope_required' });
    expect(adapterA.primaryCalls).toHaveLength(0);
    expect(adapterA.listCalls).toHaveLength(0);
    expect(adapterA.detailCalls).toHaveLength(0);
    expect(adapterB.primaryCalls).toHaveLength(0);
    expect(adapterB.listCalls).toHaveLength(0);
    expect(adapterB.detailCalls).toHaveLength(0);
    expect(cursor(database)).toEqual(cursorBefore);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: sourceCountBefore });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: candidateCountBefore });
    database.close();
  });

  it('首次完整分页后才保存最终 sync_token，并把详情和参与者写入统一来源', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const adapter = new ScriptedCalendarAdapter({
      pages: [
        { items: [calendarEvent('evt-1')], has_more: true, page_token: 'page-2' },
        { items: [calendarEvent('evt-2')], has_more: false, sync_token: 'sync-2' },
      ],
      details: {
        'evt-1': { event: calendarEvent('evt-1', { attendees: [{ type: 'user', attendee_id: 'owner-open', display_name: '系统主人', rsvp_status: 'accept' }] }) },
        'evt-2': { event: calendarEvent('evt-2', { summary: '指标口径评审', description: '请统一活跃用户的数据口径。' }) },
      },
    });
    const service = prepareService(database, adapter);
    const runner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event));

    const result = await runner.runOnce();

    expect(result).toMatchObject({ calendars: 1, events: 2, failures: 0, detailFailures: 0, skipped: false, mode: 'full' });
    expect(adapter.listCalls).toEqual([
      { calendarId: 'cal-primary', pageToken: undefined, syncToken: undefined },
      { calendarId: 'cal-primary', pageToken: 'page-2', syncToken: undefined },
    ]);
    expect(JSON.parse(cursor(database)!.cursor!)).toMatchObject({ calendarId: 'cal-primary', mode: 'incremental', syncToken: 'sync-2' });
    const source = database.raw.prepare('SELECT external_id, source_type, sender_name, content, completeness, metadata_json FROM source_event WHERE external_id = ?').get('calendar:cal-primary:evt-1') as {
      external_id: string;
      source_type: string;
      sender_name: string;
      content: string;
      completeness: string;
      metadata_json: string;
    };
    expect(source).toMatchObject({ external_id: 'calendar:cal-primary:evt-1', source_type: 'calendar', sender_name: '需求方', completeness: 'complete' });
    expect(source.content).toContain('请分析活动留存数据');
    expect(JSON.parse(source.metadata_json)).toMatchObject({ calendarId: 'cal-primary', eventId: 'evt-1', detailsAvailable: true, attendees: [{ id: 'owner-open', name: '系统主人' }] });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 });
    const state = database.raw.prepare("SELECT status, last_success_at, last_error, details_json FROM information_source_state WHERE source_kind = 'calendar'").get() as { status: string; last_success_at: string | null; last_error: string | null; details_json: string };
    expect(state.status).toBe('partial');
    expect(state.last_success_at).toBe(fixedNow.toISOString());
    expect(state.last_error).toBeNull();
    expect(JSON.parse(state.details_json)).toMatchObject({ syncTokenPresent: true, realTenantValidated: false, pages: 2 });
    database.close();
  });

  it('会议证据只接受与当前事件绑定的 typed reference，错误形状 fail closed', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const adapter = new ScriptedCalendarAdapter({
      pages: [{
        items: [
          calendarEvent('evt-linked', {
            event_type: 'meeting_placeholder',
            description: '我负责在周五前提交活动复盘报告。',
            minutes_reference: 'minutes:evt-linked',
          }),
          calendarEvent('evt-boolean', {
            event_type: 'meeting_placeholder',
            description: '我负责在周五前提交活动复盘报告。',
            has_minutes_or_explicit_message_reference: true,
          }),
          calendarEvent('evt-truthy', {
            event_type: 'meeting_placeholder',
            description: '我负责在周五前提交活动复盘报告。',
            has_minutes_or_explicit_message_reference: {},
          }),
          calendarEvent('evt-unlinked', {
            event_type: 'meeting_placeholder',
            description: '我负责在周五前提交活动复盘报告。',
            minutes_reference: 'minutes:other-event',
          }),
          calendarEvent('evt-mismatched', {
            event_type: 'meeting_placeholder',
            description: '我负责在周五前提交活动复盘报告。',
            explicit_message_reference: 'message:other-event',
          }),
          calendarEvent('evt-camel-boolean', {
            event_type: 'meeting_placeholder',
            description: '我负责在周五前提交活动复盘报告。',
            hasMinutesOrExplicitMessageReference: true,
          }),
          calendarEvent('evt-camel-reference', {
            event_type: 'meeting_placeholder',
            description: '我负责在周五前提交活动复盘报告。',
            minutesReference: true,
          }),
          calendarEvent('evt-typed-with-boolean', {
            event_type: 'meeting_placeholder',
            description: '我负责在周五前提交活动复盘报告。',
            minutes_reference: 'minutes:evt-typed-with-boolean',
            has_minutes_or_explicit_message_reference: true,
          }),
          calendarEvent('evt-malformed', {
            event_type: 'explicit_owner_delivery',
            start_time: { timestamp: [] },
            end_time: { timestamp: Number.NaN },
            startTimezone: {},
            endTimezone: [],
            event_organizer: [],
            attendees: {},
            sourceVersion: [],
            minutes_reference: true,
          }),
        ],
        has_more: false,
        sync_token: 'sync-typed-evidence',
      }],
      details: {
        'evt-linked': { event: calendarEvent('evt-linked', { event_type: 'meeting_placeholder', description: '我负责在周五前提交活动复盘报告。', minutes_reference: 'minutes:evt-linked' }) },
        'evt-boolean': { event: calendarEvent('evt-boolean', { event_type: 'meeting_placeholder', description: '我负责在周五前提交活动复盘报告。', has_minutes_or_explicit_message_reference: true }) },
        'evt-truthy': { event: calendarEvent('evt-truthy', { event_type: 'meeting_placeholder', description: '我负责在周五前提交活动复盘报告。', has_minutes_or_explicit_message_reference: {} }) },
        'evt-unlinked': { event: calendarEvent('evt-unlinked', { event_type: 'meeting_placeholder', description: '我负责在周五前提交活动复盘报告。', minutes_reference: 'minutes:other-event' }) },
        'evt-mismatched': { event: calendarEvent('evt-mismatched', { event_type: 'meeting_placeholder', description: '我负责在周五前提交活动复盘报告。', explicit_message_reference: 'message:other-event' }) },
        'evt-camel-boolean': { event: calendarEvent('evt-camel-boolean', { event_type: 'meeting_placeholder', description: '我负责在周五前提交活动复盘报告。', hasMinutesOrExplicitMessageReference: true }) },
        'evt-camel-reference': { event: calendarEvent('evt-camel-reference', { event_type: 'meeting_placeholder', description: '我负责在周五前提交活动复盘报告。', minutesReference: true }) },
        'evt-typed-with-boolean': { event: calendarEvent('evt-typed-with-boolean', { event_type: 'meeting_placeholder', description: '我负责在周五前提交活动复盘报告。', minutes_reference: 'minutes:evt-typed-with-boolean', has_minutes_or_explicit_message_reference: true }) },
        'evt-malformed': { event: calendarEvent('evt-malformed', { event_type: 'explicit_owner_delivery', start_time: { timestamp: [] }, end_time: { timestamp: Number.NaN }, startTimezone: {}, endTimezone: [], event_organizer: [], attendees: {}, sourceVersion: [], minutes_reference: true }) },
      },
    });
    const service = prepareService(database, adapter);
    const runner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event));

    const result = await runner.runOnce();

    expect(result).toMatchObject({ events: 9, failures: 0, detailFailures: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    const rows = database.raw.prepare(
      'SELECT external_id, metadata_json FROM source_event WHERE external_id LIKE ? ORDER BY external_id',
    ).all('calendar:cal-primary:evt-%') as Array<{ external_id: string; metadata_json: string }>;
    const byId = new Map(rows.map((row) => [row.external_id, JSON.parse(row.metadata_json) as Record<string, unknown>]));
    expect((byId.get('calendar:cal-primary:evt-linked')?.minutesReference)).toBe('minutes:evt-linked');
    for (const eventId of ['evt-boolean', 'evt-truthy', 'evt-unlinked', 'evt-mismatched', 'evt-camel-boolean', 'evt-camel-reference', 'evt-typed-with-boolean', 'evt-malformed']) {
      expect(byId.get(`calendar:cal-primary:${eventId}`)?.calendarInputInvalid).toBe(true);
    }
    expect(database.raw.prepare(
      "SELECT COUNT(*) AS count FROM source_event WHERE json_extract(metadata_json, '$.calendarClassification.route') = 'calendar_fact'",
    ).get()).toEqual({ count: 8 });
    database.close();
  });

  it('raw minutes_action_item ingress requires exact linked evidence before candidate creation', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['evt-minutes-missing', { event_type: 'minutes_action_item' }],
      ['evt-minutes-null', { event_type: 'minutes_action_item', minutes_reference: null }],
      ['evt-minutes-empty', { event_type: 'minutes_action_item', minutes_reference: '' }],
      ['evt-minutes-whitespace', { event_type: 'minutes_action_item', minutes_reference: ' \t' }],
      ['evt-minutes-wrong-binding', { event_type: 'minutes_action_item', minutes_reference: 'minutes:other-event' }],
      ['evt-minutes-wrong-kind', { event_type: 'minutes_action_item', minutes_reference: 'message:evt-minutes-wrong-kind' }],
      ['evt-minutes-prefix', { event_type: 'minutes_action_item', minutes_reference: 'minutes:calendar:evt-minutes-prefix' }],
      ['evt-minutes-exact', { event_type: 'minutes_action_item', minutes_reference: 'minutes:evt-minutes-exact' }],
      ['evt-message-exact', { event_type: 'minutes_action_item', explicit_message_reference: 'message:evt-message-exact' }],
    ];
    const makeEvent = ([id, patch]: [string, Record<string, unknown>]) => calendarEvent(id, {
      description: '我负责在周五前提交活动复盘报告。',
      ...patch,
    });
    const events = cases.map(makeEvent);
    const adapter = new ScriptedCalendarAdapter({
      pages: [{ items: events, has_more: false, sync_token: 'sync-minutes-action-item-gate' }],
      details: Object.fromEntries(events.map((event) => [event.event_id, { event }])),
    });
    const service = prepareService(database, adapter);
    const runner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event));

    const result = await runner.runOnce();

    expect(result).toMatchObject({ events: cases.length, failures: 0, detailFailures: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 2 });
    const rows = database.raw.prepare(
      'SELECT external_id, metadata_json FROM source_event WHERE external_id LIKE ? ORDER BY external_id',
    ).all('calendar:cal-primary:evt-%') as Array<{ external_id: string; metadata_json: string }>;
    const byId = new Map(rows.map((row) => [row.external_id.slice('calendar:cal-primary:'.length), JSON.parse(row.metadata_json) as Record<string, unknown>]));
    for (const id of ['evt-minutes-exact', 'evt-message-exact']) {
      expect(byId.get(id)?.calendarClassification).toMatchObject({ route: 'candidate_review', candidateCreated: true });
    }
    for (const id of ['evt-minutes-missing', 'evt-minutes-null', 'evt-minutes-empty', 'evt-minutes-whitespace', 'evt-minutes-wrong-binding', 'evt-minutes-wrong-kind', 'evt-minutes-prefix']) {
      expect(byId.get(id)?.calendarClassification).toMatchObject({ route: 'calendar_fact', candidateCreated: false });
    }
    for (const id of ['evt-minutes-null', 'evt-minutes-empty', 'evt-minutes-whitespace', 'evt-minutes-wrong-binding', 'evt-minutes-wrong-kind', 'evt-minutes-prefix']) {
      expect(byId.get(id)?.calendarInputInvalid).toBe(true);
    }
    database.close();
  });

  it('拒绝 calendar evidence 前缀和会被静默丢弃的原始字段形状', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['evt-prefix-minutes', { event_type: 'meeting_placeholder', minutes_reference: 'minutes:calendar:evt-prefix-minutes' }],
      ['evt-prefix-message', { event_type: 'meeting_placeholder', explicit_message_reference: 'message:calendar:evt-prefix-message' }],
      ['evt-prefix-camel-minutes', { event_type: 'meeting_placeholder', minutesReference: 'minutes:calendar:evt-prefix-camel-minutes' }],
      ['evt-prefix-camel-message', { event_type: 'meeting_placeholder', explicitMessageReference: 'message:calendar:evt-prefix-camel-message' }],
      ['evt-empty-organizer', { event_type: 'explicit_owner_delivery', event_organizer: { display_name: '' } }],
      ['evt-empty-organizer-alias', { event_type: 'explicit_owner_delivery', eventOrganizer: {} }],
      ['evt-null-organizer', { event_type: 'explicit_owner_delivery', event_organizer: null }],
      ['evt-empty-attendee', { event_type: 'explicit_owner_delivery', attendees: [{}] }],
      ['evt-empty-attendee-id', { event_type: 'explicit_owner_delivery', attendees: [{ attendee_id: '' }] }],
      ['evt-null-attendees', { event_type: 'explicit_owner_delivery', attendees: null }],
      ['evt-null-start-time', { event_type: 'explicit_owner_delivery', start_time: null }],
      ['evt-null-end-time', { event_type: 'explicit_owner_delivery', end_time: null }],
      ['evt-start-timezone-shape', { event_type: 'explicit_owner_delivery', startTimezone: {} }],
      ['evt-end-timezone-shape', { event_type: 'explicit_owner_delivery', end_timezone: [] }],
      ['evt-source-version-empty', { event_type: 'explicit_owner_delivery', source_version: '' }],
      ['evt-source-version-shape', { event_type: 'explicit_owner_delivery', sourceVersion: [] }],
      ['evt-unknown-raw-field', { event_type: 'explicit_owner_delivery', futureCalendarField: 'must-not-be-dropped' }],
      ['evt-conflicting-id-alias', { event_type: 'explicit_owner_delivery', eventId: 'evt-conflicting-id-alias-other' }],
      ['evt-conflicting-short-id-alias', { event_type: 'explicit_owner_delivery', id: 'evt-conflicting-short-id-alias-other' }],
      ['evt-conflicting-summary-alias', { event_type: 'explicit_owner_delivery', title: '另一标题' }],
      ['evt-conflicting-description-alias', { event_type: 'explicit_owner_delivery', description_rich: '另一描述' }],
      ['evt-conflicting-type-alias', { event_type: 'explicit_owner_delivery', eventType: 'ordinary_reminder' }],
      ['evt-conflicting-kind-alias', { event_type: 'explicit_owner_delivery', calendar_kind: 'owner_calendar', calendarKind: 'subscribed_calendar' }],
      ['evt-conflicting-recurrence-alias', { event_type: 'explicit_owner_delivery', recurrence_id: 'series-base', recurrenceId: 'series-other' }],
      ['evt-conflicting-link-alias', { event_type: 'explicit_owner_delivery', appLink: 'https://example.invalid/other' }],
      ['evt-conflicting-rsvp-alias', { event_type: 'explicit_owner_delivery', self_rsvp_status: 'accept', selfRsvpStatus: 'decline' }],
      ['evt-conflicting-all-day-alias', { event_type: 'explicit_owner_delivery', is_all_day: true, isAllDay: false }],
      ['evt-conflicting-delete-alias', { event_type: 'explicit_owner_delivery', is_deleted: true, isDeleted: false }],
      ['evt-conflicting-evidence-flag-alias', { event_type: 'explicit_owner_delivery', has_minutes_or_explicit_message_reference: false, hasMinutesOrExplicitMessageReference: true }],
      ['evt-conflicting-evidence-reference-alias', { event_type: 'meeting_placeholder', minutes_reference: 'minutes:evt-conflicting-evidence-reference-alias', minutesReference: 'minutes:other-event' }],
      ['evt-conflicting-source-version-alias', { event_type: 'explicit_owner_delivery', source_version: 'a'.repeat(64), sourceVersion: 'b'.repeat(64) }],
      ['evt-conflicting-organizer-alias', {
        event_type: 'explicit_owner_delivery',
        eventOrganizer: { user_id: 'other-requester', display_name: '其他需求方' },
      }],
      ['evt-conflicting-organizer-short-alias', {
        event_type: 'explicit_owner_delivery',
        organizer: { user_id: 'other-requester', display_name: '其他需求方' },
      }],
      ['evt-conflicting-organizer-inner-alias', {
        event_type: 'explicit_owner_delivery',
        event_organizer: { display_name: '需求方', name: '另一需求方' },
      }],
      ['evt-conflicting-organizer-id-inner-alias', {
        event_type: 'explicit_owner_delivery',
        event_organizer: { user_id: 'requester-open', userId: 'other-requester', display_name: '需求方' },
      }],
      ['evt-conflicting-organizer-open-id-inner-alias', {
        event_type: 'explicit_owner_delivery',
        event_organizer: { user_id: 'requester-open', open_id: 'other-requester', display_name: '需求方' },
      }],
      ['evt-conflicting-attendee-inner-alias', {
        event_type: 'explicit_owner_delivery',
        attendees: [{ attendee_id: 'owner-open', display_name: '系统主人', name: '另一主人' }],
      }],
      ['evt-conflicting-attendee-identity-alias', {
        event_type: 'explicit_owner_delivery',
        attendees: [{ attendee_id: 'owner-open', userId: 'other-owner', display_name: '系统主人' }],
      }],
      ['evt-conflicting-attendee-open-id-alias', {
        event_type: 'explicit_owner_delivery',
        attendees: [{ user_id: 'owner-open', open_id: 'other-owner', display_name: '系统主人' }],
      }],
      ['evt-unknown-chat-member-field', {
        event_type: 'explicit_owner_delivery',
        attendees: [{ attendee_id: 'owner-open', display_name: '系统主人', chat_members: [{ raw_member_payload: 'must-not-pass' }] }],
      }],
      ['evt-conflicting-vchat-alias', {
        event_type: 'explicit_owner_delivery',
        video_conference: { meeting_url: 'https://example.invalid/other-meeting' },
      }],
      ['evt-conflicting-timezone-alias', {
        event_type: 'explicit_owner_delivery',
        start_timezone: 'UTC',
        startTimezone: 'Asia/Shanghai',
      }],
      ['evt-conflicting-nested-timezone-alias', {
        event_type: 'explicit_owner_delivery',
        start_time: { timestamp: '1786356000', timezone: 'UTC' },
        startTimezone: 'Asia/Shanghai',
      }],
      ['evt-conflicting-end-nested-timezone-alias', {
        event_type: 'explicit_owner_delivery',
        end_time: { timestamp: '1786359600', timezone: 'UTC' },
        endTimezone: 'Asia/Shanghai',
      }],
      ['evt-conflicting-nested-time-value-alias', {
        event_type: 'explicit_owner_delivery',
        start_time: { timestamp: '1786356000', date: '1786356001', timezone: 'Asia/Shanghai' },
      }],
      ['evt-conflicting-nested-time-container-alias', {
        event_type: 'explicit_owner_delivery',
        start_time: { timestamp: '1786356000', timezone: 'Asia/Shanghai' },
        startTime: { date: '1786356001', timezone: 'Asia/Shanghai' },
      }],
      ['evt-conflicting-end-time-alias', {
        event_type: 'explicit_owner_delivery',
        endTime: { timestamp: '1786359601', timezone: 'Asia/Shanghai' },
      }],
      ['evt-conflicting-all-day-short-alias', { event_type: 'explicit_owner_delivery', all_day: true, allDay: false }],
      ['evt-conflicting-delete-short-alias', { event_type: 'explicit_owner_delivery', is_deleted: true, isDeleted: false }],
      ['evt-contradictory-time-alias', {
        event_type: 'explicit_owner_delivery',
        start_time: { timestamp: '1786356000', timezone: 'Asia/Shanghai' },
        startTime: { timestamp: '1786359600', timezone: 'Asia/Shanghai' },
      }],
    ];
    const adapter = new ScriptedCalendarAdapter({
      pages: [{ items: cases.map(([eventId, patch]) => calendarEvent(eventId, { description: '我负责在周五前提交活动复盘报告。', ...patch })), has_more: false, sync_token: 'sync-strict-raw-calendar' }],
      details: Object.fromEntries(cases.map(([eventId, patch]) => [eventId, { event: calendarEvent(eventId, { description: '我负责在周五前提交活动复盘报告。', ...patch }) }])),
    });
    const service = prepareService(database, adapter);
    const runner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event));

    const result = await runner.runOnce();

    expect(result).toMatchObject({ events: cases.length, failures: 0, detailFailures: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    const rows = database.raw.prepare(
      'SELECT external_id, metadata_json FROM source_event WHERE external_id LIKE ? ORDER BY external_id',
    ).all('calendar:cal-primary:evt-%') as Array<{ external_id: string; metadata_json: string }>;
    const byId = new Map(rows.map((row) => [row.external_id, JSON.parse(row.metadata_json) as Record<string, unknown>]));
    for (const [eventId] of cases) {
      expect(byId.get(`calendar:cal-primary:${eventId}`)?.calendarInputInvalid).toBe(true);
      expect(byId.get(`calendar:cal-primary:${eventId}`)?.calendarClassification).toMatchObject({ route: 'calendar_fact', candidateCreated: false });
    }
    database.close();
  });

  it('接受语义等价的嵌套时间、timezone、organizer 和 attendee 别名', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const patch = {
      event_type: 'ordinary_reminder',
      start_time: { timestamp: '1786356000', timezone: 'Asia/Shanghai' },
      startTime: { date: '2026-08-10T10:00:00.000Z', timezone: 'Asia/Shanghai' },
      end_time: { timestamp: '1786359600', timezone: 'Asia/Shanghai' },
      endTime: { time: '2026-08-10T11:00:00.000Z', timezone: 'Asia/Shanghai' },
      create_time: '1786356000',
      createTime: '2026-08-10T10:00:00.000Z',
      event_organizer: { user_id: 'requester-open', display_name: '需求方' },
      eventOrganizer: { open_id: 'requester-open', name: '需求方' },
      organizer: { userId: 'requester-open', name: '需求方' },
      attendees: [{
        attendee_id: 'owner-open',
        user_id: 'owner-open',
        userId: 'owner-open',
        open_id: 'owner-open',
        display_name: '系统主人',
        name: '系统主人',
      }],
    };
    const adapter = new ScriptedCalendarAdapter({
      pages: [{ items: [calendarEvent('evt-equivalent-aliases', patch)], has_more: false, sync_token: 'sync-equivalent-aliases' }],
      details: { 'evt-equivalent-aliases': { event: calendarEvent('evt-equivalent-aliases', patch) } },
    });
    const service = prepareService(database, adapter);
    const runner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event));

    await runner.runOnce();

    const source = database.raw.prepare('SELECT metadata_json FROM source_event WHERE external_id = ?').get('calendar:cal-primary:evt-equivalent-aliases') as { metadata_json: string };
    expect(JSON.parse(source.metadata_json)).toMatchObject({
      calendarInputInvalid: false,
      attendees: [{ id: 'owner-open', name: '系统主人' }],
      organizer: { id: 'requester-open', name: '需求方' },
    });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    database.close();
  });

  it('表驱动拒绝所有存在但为空的顶层文本别名，并允许缺失与合法非空值', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const aliasGroups: Array<[string, string[]]> = [
      ['event-id', ['event_id', 'eventId', 'id']],
      ['summary', ['summary', 'title', 'name']],
      ['description', ['description', 'description_rich']],
      ['status', ['status']],
      ['event-type', ['event_type', 'eventType', 'calendar_event_type']],
      ['calendar-kind', ['calendar_kind', 'calendarKind', 'calendar_type', 'calendarType']],
      ['recurrence', ['recurrence_id', 'recurrenceId', 'series_id', 'seriesId', 'recurrence_rule', 'recurrenceRule']],
      ['app-link', ['app_link', 'appLink', 'source_url', 'sourceUrl']],
      ['self-rsvp', ['self_rsvp_status', 'selfRsvpStatus']],
      ['start-timezone', ['start_timezone', 'startTimezone']],
      ['end-timezone', ['end_timezone', 'endTimezone']],
      ['evidence-reference', ['minutes_reference', 'minutesReference', 'explicit_message_reference', 'explicitMessageReference']],
      ['source-version', ['source_version', 'sourceVersion']],
    ];
    const emptyCases: Array<{ id: string; patch: Record<string, unknown> }> = [];
    for (const [group, keys] of aliasGroups) {
      const values = group === 'event-id' ? [''] : ['', ' \t'];
      for (const value of values) {
        for (const key of keys) {
          const id = `evt-empty-${group}-${key.replaceAll('_', '-')}-${value === '' ? 'empty' : 'space'}`;
          const patch: Record<string, unknown> = { [key]: value };
          if (key === 'event_id') patch.eventId = id;
          emptyCases.push({ id, patch });
        }
      }
    }
    const adapter = new ScriptedCalendarAdapter({
      pages: [{ items: emptyCases.map(({ id, patch }) => calendarEvent(id, { description: '我负责在周五前提交活动复盘报告。', ...patch })), has_more: false, sync_token: 'sync-empty-text-aliases' }],
      details: Object.fromEntries(emptyCases.map(({ id, patch }) => [id, { event: calendarEvent(id, { description: '我负责在周五前提交活动复盘报告。', ...patch }) }])),
    });
    const service = prepareService(database, adapter);
    const runner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event));

    await runner.runOnce();

    const rows = database.raw.prepare(
      'SELECT metadata_json FROM source_event WHERE external_id LIKE ? ORDER BY rowid',
    ).all('calendar:cal-primary:%') as Array<{ metadata_json: string }>;
    const byEventId = new Map(rows.map((row) => {
      const metadata = JSON.parse(row.metadata_json) as { eventId: string; calendarInputInvalid?: boolean; calendarClassification?: { route?: string; candidateCreated?: boolean } };
      return [metadata.eventId, metadata];
    }));
    expect(byEventId.size).toBe(emptyCases.length);
    for (const { id } of emptyCases) {
      expect(byEventId.get(id)).toMatchObject({
        eventId: id,
        calendarInputInvalid: true,
        calendarClassification: { route: 'calendar_fact', candidateCreated: false },
      });
    }
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    database.close();
  });

  it('保留可选文本缺失与合法非空值的语义', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const valid = calendarEvent('evt-valid-optional-texts', {
      event_type: 'ordinary_reminder',
      calendar_kind: 'owner_calendar',
      recurrence_id: 'series-1',
      app_link: 'https://example.invalid/calendar/evt-valid-optional-texts',
      self_rsvp_status: 'accept',
      startTimezone: 'Asia/Shanghai',
      endTimezone: 'Asia/Shanghai',
    });
    const missing = calendarEvent('evt-missing-optional-texts');
    const adapter = new ScriptedCalendarAdapter({
      pages: [{ items: [valid, missing], has_more: false, sync_token: 'sync-optional-texts' }],
      details: {
        'evt-valid-optional-texts': { event: valid },
        'evt-missing-optional-texts': { event: missing },
      },
    });
    const service = prepareService(database, adapter);
    const runner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event));

    await runner.runOnce();

    const rows = database.raw.prepare(
      'SELECT metadata_json FROM source_event WHERE external_id IN (?, ?) ORDER BY external_id',
    ).all('calendar:cal-primary:evt-missing-optional-texts', 'calendar:cal-primary:evt-valid-optional-texts') as Array<{ metadata_json: string }>;
    expect(rows.map((row) => JSON.parse(row.metadata_json)).every((metadata: { calendarInputInvalid?: boolean }) => metadata.calendarInputInvalid === false)).toBe(true);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    database.close();
  });

  it('后续同步使用旧 sync_token；同一事件修改正文并保持一条来源和候选', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    seedCalendarCursor(database);
    const adapter = new ScriptedCalendarAdapter({
      pages: [{ items: [calendarEvent('evt-update', { description: '请分析旧活动数据。' })], has_more: false, sync_token: 'sync-first' }],
      details: { 'evt-update': { event: calendarEvent('evt-update', { description: '请分析旧活动数据。' }) } },
    });
    const service = prepareService(database, adapter);
    const firstRunner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event));
    await firstRunner.runOnce();

    const updateAdapter = new ScriptedCalendarAdapter({
      pages: [{ items: [calendarEvent('evt-update', { description: '请分析新活动留存数据，并补充付费指标。' })], has_more: false, sync_token: 'sync-next' }],
      details: { 'evt-update': { event: calendarEvent('evt-update', { description: '请分析新活动留存数据，并补充付费指标。' }) } },
    });
    const secondRunner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, updateAdapter, (event) => service.ingestSource(event));
    const result = await secondRunner.runOnce();

    expect(updateAdapter.listCalls[0]?.syncToken).toBe('sync-first');
    expect(result).toMatchObject({ mode: 'incremental', events: 1, failures: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE external_id = ?').get('calendar:cal-primary:evt-update')).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    expect((database.raw.prepare('SELECT content FROM source_event WHERE external_id = ?').get('calendar:cal-primary:evt-update') as { content: string }).content).toContain('补充付费指标');
    expect(JSON.parse(cursor(database)!.cursor!)).toMatchObject({ syncToken: 'sync-next' });
    database.close();
  });

  it('取消事件保留可追踪正文和 cancelled 状态，不按消息撤回逻辑清空', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const cancelled = calendarEvent('evt-cancelled', { status: 'cancelled', description: '原定需求评审已取消。' });
    const adapter = new ScriptedCalendarAdapter({ pages: [{ items: [cancelled], has_more: false, sync_token: 'sync-cancelled' }], details: { 'evt-cancelled': { event: cancelled } } });
    const service = prepareService(database, adapter);
    const result = await new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event)).runOnce();

    expect(result.failures).toBe(0);
    const source = database.raw.prepare('SELECT content, completeness, metadata_json FROM source_event WHERE external_id = ?').get('calendar:cal-primary:evt-cancelled') as { content: string; completeness: string; metadata_json: string };
    expect(source.content).toContain('状态：已取消');
    expect(source.content).not.toContain('正文不再保留');
    expect(source.completeness).toBe('complete');
    expect(JSON.parse(source.metadata_json)).toMatchObject({ cancelled: true, status: 'cancelled' });
    database.close();
  });

  it('详情权限不足时保留列表摘要、推进 token，并同时记录部分同步错误', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const forbidden = Object.assign(new Error('403 forbidden: permission denied'), { status: 403 });
    const adapter = new ScriptedCalendarAdapter({
      pages: [{ items: [calendarEvent('evt-limited')], has_more: false, sync_token: 'sync-limited' }],
      details: { 'evt-limited': forbidden },
    });
    const service = prepareService(database, adapter);
    const result = await new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, (event) => service.ingestSource(event)).runOnce();

    expect(result).toMatchObject({ events: 1, failures: 0, detailFailures: 1 });
    expect(JSON.parse(cursor(database)!.cursor!)).toMatchObject({ syncToken: 'sync-limited' });
    const source = database.raw.prepare('SELECT completeness, metadata_json FROM source_event WHERE external_id = ?').get('calendar:cal-primary:evt-limited') as { completeness: string; metadata_json: string };
    expect(source.completeness).toBe('partial');
    expect(JSON.parse(source.metadata_json)).toMatchObject({ detailsAvailable: false });
    const state = database.raw.prepare("SELECT status, last_success_at, last_error FROM information_source_state WHERE source_kind = 'calendar'").get() as { status: string; last_success_at: string | null; last_error: string | null };
    expect(state.status).toBe('admin_required');
    expect(state.last_success_at).toBe(fixedNow.toISOString());
    expect(state.last_error).toContain('详情暂不可读');
    database.close();
  });

  it('详情返回 HTTP 200 业务错误时保留旧 token，不把列表摘要当作成功检查点', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    seedCalendarCursor(database, 'sync-before-business-error');
    const before = cursor(database)!;
    const businessError = Object.assign(new Error('FEISHU_API_ERROR code=230027 category=permission request_id=req-calendar-detail'), {
      code: 230027,
      request_id: 'req-calendar-detail',
    });
    const adapter = new ScriptedCalendarAdapter({
      pages: [{ items: [calendarEvent('evt-business-error')], has_more: false, sync_token: 'sync-must-not-save' }],
      details: { 'evt-business-error': businessError },
    });
    prepareService(database, adapter);

    const result = await new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, async () => ({})).runOnce();

    expect(result).toMatchObject({ failures: 1, skipped: false, reason: 'sync_failed' });
    const after = cursor(database)!;
    expect(after.cursor).toBe(before.cursor);
    expect(after.last_success_at).toBe(before.last_success_at);
    expect(after.last_error).toContain('FEISHU_API_ERROR');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
    database.close();
  });

  it('真实网络错误按统一重试策略处理：成功只 durable ingest 一次，耗尽则保留旧 token', async () => {
    const successDatabase = new AppDatabase(':memory:', false);
    seedOwner(successDatabase);
    const transportError = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });
    const successAdapter = new ScriptedCalendarAdapter({
      pages: [transportError, { items: [calendarEvent('evt-transport-retry')], has_more: false, sync_token: 'sync-transport-retry' }],
    });
    prepareService(successDatabase, successAdapter);
    const captured: string[] = [];
    const successRunner = new FeishuCalendarSyncRunner(
      liveConfig().feishu,
      successDatabase,
      successAdapter,
      async (event) => { captured.push(event.externalId); return {}; },
      undefined,
      async () => undefined,
    );

    const success = await successRunner.runOnce();

    expect(success).toMatchObject({ events: 1, failures: 0, skipped: false });
    expect(successAdapter.listCalls).toHaveLength(2);
    expect(captured).toEqual(['calendar:cal-primary:evt-transport-retry']);
    expect(JSON.parse(cursor(successDatabase)!.cursor!)).toMatchObject({ syncToken: 'sync-transport-retry' });
    successDatabase.close();

    const failureDatabase = new AppDatabase(':memory:', false);
    seedOwner(failureDatabase);
    seedCalendarCursor(failureDatabase, 'sync-before-transport-failure');
    const before = cursor(failureDatabase)!;
    const failureAdapter = new ScriptedCalendarAdapter({
      pages: [
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      ],
    });
    prepareService(failureDatabase, failureAdapter);
    const failureRunner = new FeishuCalendarSyncRunner(liveConfig().feishu, failureDatabase, failureAdapter, async () => ({}), undefined, async () => undefined);

    const failure = await failureRunner.runOnce();

    expect(failure.failures).toBeGreaterThan(0);
    expect(failureAdapter.listCalls).toHaveLength(3);
    const after = cursor(failureDatabase)!;
    expect(after.cursor).toBe(before.cursor);
    expect(after.last_success_at).toBe(before.last_success_at);
    failureDatabase.close();
  });

  it('详情阶段真实传输错误重试耗尽即阻塞本轮，不写来源也不推进旧 token', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    seedCalendarCursor(database, 'sync-before-detail-transport');
    const before = cursor(database)!;
    const transportError = Object.assign(new Error('socket hang up with provider token=synthetic'), { code: 'ECONNRESET' });
    const adapter = new ScriptedCalendarAdapter({
      pages: [{ items: [calendarEvent('evt-detail-transport')], has_more: false, sync_token: 'sync-must-not-save' }],
      details: { 'evt-detail-transport': transportError },
    });
    prepareService(database, adapter);
    const captured: string[] = [];
    const runner = new FeishuCalendarSyncRunner(
      liveConfig().feishu,
      database,
      adapter,
      async (event) => { captured.push(event.externalId); return {}; },
      undefined,
      async () => undefined,
    );

    const result = await runner.runOnce();

    expect(result).toMatchObject({ failures: 1, skipped: false, reason: 'sync_failed' });
    expect(adapter.detailCalls).toHaveLength(3);
    expect(captured).toEqual([]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
    const after = cursor(database)!;
    expect(after.cursor).toBe(before.cursor);
    expect(after.last_success_at).toBe(before.last_success_at);
    expect(after.last_error).not.toContain('socket hang up');
    expect(after.last_error).not.toContain('synthetic');
    database.close();
  });

  it('第二页失败或 durable ingest 失败时不推进旧 token，并记录同步健康错误', async () => {
    for (const scenario of ['page', 'ingest'] as const) {
      const database = new AppDatabase(':memory:', false);
      seedOwner(database);
      seedCalendarCursor(database, 'sync-before-failure');
      const before = cursor(database)!;
      const adapter = new ScriptedCalendarAdapter({
        pages: scenario === 'page'
          ? [
              { items: [calendarEvent('evt-before-failure')], has_more: true, page_token: 'page-2' },
              new Error('network failed'), new Error('network failed'), new Error('network failed'),
            ]
          : [{ items: [calendarEvent('evt-ingest-failure')], has_more: false, sync_token: 'sync-should-not-save' }],
      });
      // Initialize the source-health row before exercising the runner in isolation.
      // `prepareService` is intentionally not used here because the test injects
      // a failing durable-ingest callback, but it is still the canonical bootstrap
      // for information_source_state.
      prepareService(database, adapter);
      const runner = new FeishuCalendarSyncRunner(liveConfig().feishu, database, adapter, async (event) => {
        if (scenario === 'ingest') throw new Error('durable inbox unavailable');
        return { deduplicated: false, event };
      }, undefined, async () => undefined);

      const result = await runner.runOnce();
      expect(result.failures).toBeGreaterThan(0);
      const after = cursor(database)!;
      expect(after.cursor).toBe(before.cursor);
      expect(after.last_success_at).toBe(before.last_success_at);
      expect(after.last_error).toBeTruthy();
      const state = database.raw.prepare("SELECT status, last_success_at, last_error FROM information_source_state WHERE source_kind = 'calendar'").get() as { status: string; last_success_at: string | null; last_error: string | null };
      expect(state.status).toBe('error');
      expect(state.last_success_at).toBeNull();
      expect(state.last_error).toBeTruthy();
      database.close();
    }
  });

  it('明确 sync_token 失效时受控全量重建；普通错误不清除旧 token', async () => {
    const rebuildDatabase = new AppDatabase(':memory:', false);
    seedOwner(rebuildDatabase);
    seedCalendarCursor(rebuildDatabase, 'sync-expired');
    const adapter = new ScriptedCalendarAdapter({
      pages: [new Error('sync_token invalid or expired'), { items: [calendarEvent('evt-rebuild')], has_more: false, sync_token: 'sync-rebuilt' }],
    });
    const result = await new FeishuCalendarSyncRunner(liveConfig().feishu, rebuildDatabase, adapter, async () => ({})).runOnce();
    expect(result).toMatchObject({ mode: 'rebuild', failures: 0 });
    expect(adapter.listCalls.map((call) => call.syncToken)).toEqual(['sync-expired', undefined]);
    expect(JSON.parse(cursor(rebuildDatabase)!.cursor!)).toMatchObject({ syncToken: 'sync-rebuilt' });
    rebuildDatabase.close();

    const safeDatabase = new AppDatabase(':memory:', false);
    seedOwner(safeDatabase);
    seedCalendarCursor(safeDatabase, 'sync-keep');
    const ordinary = new ScriptedCalendarAdapter({ pages: [new Error('unexpected calendar error')] });
    const failed = await new FeishuCalendarSyncRunner(liveConfig().feishu, safeDatabase, ordinary, async () => ({})).runOnce();
    expect(failed.failures).toBe(1);
    expect(JSON.parse(cursor(safeDatabase)!.cursor!)).toMatchObject({ syncToken: 'sync-keep' });
    safeDatabase.close();
  });

  it('单来源 API 只运行指定来源，妙记已实现，非法来源返回 400', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const adapter = new ScriptedCalendarAdapter({ pages: [{ items: [calendarEvent('evt-api')], has_more: false, sync_token: 'sync-api' }] });
    const app = await buildApp(prepareService(database, adapter), { serveWeb: false });

    const calendar = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sources/calendar/sync' });
    expect(calendar.statusCode).toBe(200);
    expect(calendar.json()).toMatchObject({ outcome: 'success', messages: 1, failures: 0, sources: [{ source: 'calendar', counts: { events: 1 } }] });
    expect(calendar.body).not.toContain('ownerInformation');
    expect(adapter.primaryCalls).toHaveLength(1);
    expect(adapter.listCalls).toHaveLength(1);

    const minutes = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sources/minutes/sync' });
    expect(minutes.statusCode).toBe(200);
    expect(minutes.json()).toMatchObject({ outcome: 'failure', failures: 1, sources: [{ source: 'minutes', status: 'failure' }] });

    const invalid = await app.inject({ method: 'POST', url: '/api/integrations/feishu/sources/not-a-source/sync' });
    expect(invalid.statusCode).toBe(400);
    await app.close();
    database.close();
  });
});
