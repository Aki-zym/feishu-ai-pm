import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import type { NormalizedSourceEvent } from '../src/domain.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';
import { classifyCalendarSource, PROD07_CONTRACT, validateProd07Contract } from '../src/calendar-classification.js';

const databases: AppDatabase[] = [];

function serviceHarness() {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
  const database = new AppDatabase(':memory:', false);
  databases.push(database);
  return { database, service: new PmService(database, createAdapters(config), config) };
}

function calendarEvent(id: string, description: string, metadata: Record<string, unknown> = {}): NormalizedSourceEvent {
  return {
    externalId: `calendar:prod07:${id}`,
    sourceType: 'calendar',
    conversationId: 'calendar:prod07',
    senderId: 'organizer',
    senderName: '需求方',
    content: `日程：${id}\n描述：${description}`,
    occurredAt: '2026-08-17T09:00:00.000Z',
    completeness: 'complete',
    metadata: {
      schemaVersion: 1,
      calendarTitle: id,
      startTime: '2026-08-17T09:00:00.000Z',
      endTime: '2026-08-17T10:00:00.000Z',
      ownerRole: 'organizer',
      ownerResponse: 'accept',
      eventType: 'ordinary_reminder',
      ...metadata,
    },
  };
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe('PROD-07 calendar classification runtime', () => {
  it('keeps ordinary reminders as calendar facts and prevents candidate flood', async () => {
    const { database, service } = serviceHarness();
    const events = Array.from({ length: 50 }, (_, index) => calendarEvent(
      `普通提醒-${index + 1}`,
      '提醒主人周三 10:00 参加例会。',
      { eventType: 'ordinary_reminder' },
    ));

    const result = await service.ingestSourceBatch(events);

    expect(result.classificationFailures).toBe(0);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 50 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM owner_decision').get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM source_event WHERE json_extract(metadata_json, '$.calendarClassification.route') = 'calendar_fact'").get()).toEqual({ count: 50 });
    expect(service.calendarSources({ route: 'calendar_fact' }).items).toHaveLength(50);
  });

  it('creates one owner-confirmed candidate only when all three signals are explicit', async () => {
    const { database, service } = serviceHarness();
    await service.ingestSource(calendarEvent(
      '提交活动复盘',
      '我负责在周五前提交活动复盘报告。',
      { eventType: 'explicit_owner_delivery' },
    ));

    const candidate = database.raw.prepare('SELECT title, analysis_json FROM candidate_request').get() as { title: string; analysis_json: string };
    expect(candidate.title).toBe('提交活动复盘');
    expect(JSON.parse(candidate.analysis_json).calendarClassification).toMatchObject({
      route: 'candidate_review',
      candidateCreated: true,
      requiresOwnerConfirmation: true,
    });
    expect(database.raw.prepare("SELECT json_extract(metadata_json, '$.calendarClassification.sourceRetained') AS retained FROM source_event").get()).toEqual({ retained: 1 });
  });

  it.each([
    ['minutes', '纪要明确：我负责在周五前提交活动复盘报告。', { minutesReference: 'minutes:meeting-action-item-1' }],
    ['explicit message', '明确消息：由我在周五前提交活动复盘报告。', { explicitMessageReference: 'message:meeting-action-item-1' }],
  ])('accepts a meeting action item only with %s evidence', async (_evidenceKind, description, evidence) => {
    const { database, service } = serviceHarness();
    await service.ingestSource(calendarEvent(
      '会议行动项',
      description,
      { eventId: 'meeting-action-item-1', eventType: 'meeting_placeholder', hasMinutesOrExplicitMessageReference: true, ...evidence },
    ));

    const candidate = database.raw.prepare('SELECT analysis_json FROM candidate_request').get() as { analysis_json: string };
    expect(candidate).toBeTruthy();
    expect(JSON.parse(candidate.analysis_json).calendarClassification).toMatchObject({
      route: 'candidate_review',
      candidateCreated: true,
      explanationCode: 'candidate_minutes_action_item',
    });
  });

  it.each([
    ['missing', {}],
    ['null', { minutesReference: null }],
    ['empty', { minutesReference: '' }],
    ['whitespace', { minutesReference: ' \t' }],
    ['wrong binding', { minutesReference: 'minutes:other-event' }],
    ['wrong kind', { minutesReference: 'message:minutes-action-item' }],
    ['noncanonical prefix', { minutesReference: 'minutes:calendar:minutes-action-item' }],
    ['exact minutes', { minutesReference: 'minutes:minutes-action-item' }],
    ['exact message', { explicitMessageReference: 'message:minutes-action-item' }],
  ])('makes minutes_action_item evidence gate explicit for normalized input: %s', (_name, evidence) => {
    const event = calendarEvent('minutes-action-item', '我负责在周五前提交活动复盘报告。', {
      eventId: 'minutes-action-item',
      eventType: 'minutes_action_item',
      ...evidence,
    });
    const classification = classifyCalendarSource(event);
    if (_name === 'exact minutes' || _name === 'exact message') {
      expect(classification).toMatchObject({ route: 'candidate_review', candidateCreated: true });
    } else {
      expect(classification).toMatchObject({ route: 'calendar_fact', candidateCreated: false });
    }
  });

  it('routes incomplete responsibility and meeting placeholders to owner confirmation', async () => {
    const { database, service } = serviceHarness();
    await service.ingestSource(calendarEvent('评审准备', '准备评审材料。', { eventType: 'ambiguous_action' }));
    await service.ingestSource(calendarEvent('项目评审会议', '确认评审结果。', { eventType: 'meeting_placeholder' }));

    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    const routes = database.raw.prepare(
      "SELECT json_extract(metadata_json, '$.calendarClassification.route') AS route, json_extract(metadata_json, '$.calendarClassification.explanationCode') AS code FROM source_event ORDER BY external_id",
    ).all() as Array<{ route: string; code: string }>;
    expect(routes).toEqual([
      { route: 'owner_confirmation', code: 'confirmation_missing_owner_or_delivery' },
      { route: 'owner_confirmation', code: 'confirmation_meeting_without_source' },
    ]);
  });

  it('exposes bounded route facts through the API without returning source content', async () => {
    const { database, service } = serviceHarness();
    await service.ingestSource(calendarEvent('提交名单', '我负责在周一前提交名单。', { eventType: 'explicit_owner_delivery' }));
    const app = await buildApp(service, { serveWeb: false });
    const response = await app.inject({ method: 'GET', url: '/api/calendar/sources?route=candidate_review' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      timezone: 'Asia/Shanghai',
      items: [{ route: 'candidate_review', candidateCreated: true, sourceRetained: true }],
    });
    const item = response.json().items[0] as Record<string, unknown>;
    expect(item).not.toHaveProperty('sourceEventId');
    expect(item).not.toHaveProperty('externalId');
    expect((item.evidenceFields as Record<string, unknown>).sourceReference).toMatch(/^sha256:[0-9a-f]{16}$/u);
    expect(response.body).not.toContain('我负责在周一前提交名单');
    await app.close();
    database.close();
    databases.splice(databases.indexOf(database), 1);
  });

  it('fails closed for future schema/event/role, unknown fields, and explicit negative semantics', () => {
    const base = calendarEvent('安全边界', '我负责在周五前提交活动复盘报告。', { eventType: 'explicit_owner_delivery' });
    const cases = [
      { metadata: { ...base.metadata, schemaVersion: 999 } },
      { metadata: { ...base.metadata, eventType: 'future_event' } },
      { metadata: { ...base.metadata, ownerRole: 'future_role' } },
      { metadata: { ...base.metadata, futureField: 'unexpected' } },
      { metadata: { ...base.metadata, startTime: {} } },
      { metadata: { ...base.metadata, startTime: Number.NaN } },
      { metadata: { ...base.metadata, endTime: [] } },
      { metadata: { ...base.metadata, endTime: Number.POSITIVE_INFINITY } },
      { metadata: { ...base.metadata, startTimezone: {} } },
      { metadata: { ...base.metadata, startTimezone: 123 } },
      { metadata: { ...base.metadata, endTimezone: [] } },
      { metadata: { ...base.metadata, endTimezone: '\u0000' } },
      { metadata: { ...base.metadata, organizer: [] } },
      { metadata: { ...base.metadata, organizer: { id: [] } } },
      { metadata: { ...base.metadata, organizer: { id: '', name: '需求方' } } },
      { metadata: { ...base.metadata, attendees: {} } },
      { metadata: { ...base.metadata, attendees: [{ id: {} }] } },
      { metadata: { ...base.metadata, attendees: [{}] } },
      { metadata: { ...base.metadata, attendees: [{ id: '' }] } },
      { metadata: { ...base.metadata, sourceVersion: [] } },
      { metadata: { ...base.metadata, sourceVersion: Number.NaN } },
      { metadata: { ...base.metadata, eventId: {} } },
      { metadata: { ...base.metadata, calendarTitle: {} } },
      { metadata: { ...base.metadata, status: [] } },
      { metadata: { ...base.metadata, hasMinutesOrExplicitMessageReference: {} } },
      { metadata: { ...base.metadata, minutesReference: {} } },
      { metadata: { ...base.metadata, explicitMessageReference: [] } },
    ];
    for (const item of cases) {
      const classification = classifyCalendarSource({ ...base, metadata: item.metadata });
      expect(classification.route).toBe('calendar_fact');
      expect(classification.candidateCreated).toBe(false);
    }
    const negative = classifyCalendarSource({
      ...base,
      content: '日程：安全边界\n描述：不是我负责，也不要提交活动复盘报告。',
    });
    expect(negative.route).toBe('owner_confirmation');
    expect(negative.candidateCreated).toBe(false);
  });

  it('does not let arbitrary meeting evidence truthiness create a candidate', () => {
    const base = calendarEvent('会议证据', '我负责在周五前提交活动复盘报告。', {
      eventType: 'meeting_placeholder',
      hasMinutesOrExplicitMessageReference: {},
    });
    const classification = classifyCalendarSource(base);
    expect(['calendar_fact', 'owner_confirmation']).toContain(classification.route);
    expect(classification.candidateCreated).toBe(false);
  });

  it.each([
    ['minutes calendar prefix', { eventId: 'meeting-prefixed-minutes', eventType: 'meeting_placeholder', hasMinutesOrExplicitMessageReference: true, minutesReference: 'minutes:calendar:meeting-prefixed-minutes' }],
    ['message calendar prefix', { eventId: 'meeting-prefixed-message', eventType: 'meeting_placeholder', hasMinutesOrExplicitMessageReference: true, explicitMessageReference: 'message:calendar:meeting-prefixed-message' }],
    ['wrong evidence kind', { eventId: 'meeting-wrong-kind', eventType: 'meeting_placeholder', hasMinutesOrExplicitMessageReference: true, minutesReference: 'message:meeting-wrong-kind' }],
  ])('does not accept %s as linked meeting evidence', async (_name, metadata) => {
    const { database, service } = serviceHarness();
    await service.ingestSource(calendarEvent('会议错误证据', '我负责在周五前提交活动复盘报告。', metadata));

    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT json_extract(metadata_json, '$.calendarClassification.route') AS route, json_extract(metadata_json, '$.calendarClassification.candidateCreated') AS candidate FROM source_event").get()).toEqual({ route: 'calendar_fact', candidate: 0 });
  });

  it('does not let bare boolean meeting evidence create a candidate', () => {
    const base = calendarEvent('会议布尔证据', '我负责在周五前提交活动复盘报告。', {
      eventId: 'meeting-boolean-evidence',
      eventType: 'meeting_placeholder',
      hasMinutesOrExplicitMessageReference: true,
    });
    const classification = classifyCalendarSource(base);
    expect(classification.route).toBe('calendar_fact');
    expect(classification.candidateCreated).toBe(false);
  });

  it('projects hostile or oversized route fields to bounded safe DTOs', async () => {
    const { database, service } = serviceHarness();
    const secret = `provider_payload sk-live-${'x'.repeat(40)} sourceEventId=raw-event`;
    await service.ingestSource(calendarEvent(secret, '我负责在周五前提交活动复盘报告。', { eventType: 'explicit_owner_delivery' }));
    const app = await buildApp(service, { serveWeb: false });
    const response = await app.inject({ method: 'GET', url: '/api/calendar/sources' });
    const item = response.json().items[0] as Record<string, unknown>;
    expect(item.title).toBe('<redacted>');
    expect(String(item.title).length).toBeLessThanOrEqual(160);
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain('sk-live-');
    await app.close();
    database.close();
    databases.splice(databases.indexOf(database), 1);
  });

  it('rejects a mutated PROD-07 contract before runtime use', () => {
    const mutated = {
      ...PROD07_CONTRACT,
      event_matrix: PROD07_CONTRACT.event_matrix.map((item) => ({ ...item })),
    };
    delete (mutated.event_matrix[0] as Record<string, unknown>).reason;
    expect(() => validateProd07Contract(mutated)).toThrow();
  });
});
