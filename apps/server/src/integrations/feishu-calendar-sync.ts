import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../database.js';
import type { NormalizedSourceEvent, OwnerIdentity, OwnerSourceStatus, SourceCompleteness } from '../domain.js';
import { redactDiagnosticText } from '../redaction.js';
import type { OperationContext } from '../observability.js';
import { feishuApiErrorStatus, feishuErrorDiagnostic, isFeishuDetailBlockingError, isFeishuRetryableError, LiveFeishuAdapter, missingFeishuScopes, normalizeFeishuTimestamp, optionalFeishuTimestamp, parseDurableGrantedScopes } from './feishu.js';

type Ingest = (event: NormalizedSourceEvent, context?: OperationContext) => Promise<unknown>;
type StatusLevel = 'info' | 'warn' | 'error';

type CalendarPage = {
  items?: unknown[];
  has_more?: boolean;
  page_token?: string;
  sync_token?: string;
};

type CalendarCursor = {
  version: 1;
  calendarId: string;
  mode: 'full' | 'incremental';
  syncToken: string | null;
};

type CalendarOwner = OwnerIdentity & {
  grantedScopes: string[];
  scopeState: ReturnType<typeof parseDurableGrantedScopes>;
};

export type CalendarSyncResult = {
  calendars: number;
  events: number;
  deduplicated: number;
  failures: number;
  detailFailures: number;
  skipped: boolean;
  reason?: string;
  calendarId?: string;
  mode?: 'full' | 'incremental' | 'rebuild';
};

const nowIso = () => new Date().toISOString();
const maxPages = 100;
const maxTransientAttempts = 3;
const calendarCursorIntegration = 'feishu_calendar';

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readString(value: unknown, ...keys: string[]) {
  const source = record(value);
  for (const key of keys) {
    const candidate = source[key];
    if ((typeof candidate === 'string' || typeof candidate === 'number') && candidate !== '') return String(candidate);
  }
  return '';
}

function nested(value: unknown, ...keys: string[]) {
  const source = record(value);
  for (const key of keys) {
    if (source[key] && typeof source[key] === 'object') return source[key] as Record<string, unknown>;
  }
  return {};
}

function calendarIdFromPrimary(value: unknown) {
  const source = record(value);
  const calendars = Array.isArray(source.calendars) ? source.calendars : [];
  for (const item of calendars) {
    const calendar = nested(item, 'calendar');
    const id = readString(calendar, 'calendar_id', 'calendarId') || readString(item, 'calendar_id', 'calendarId');
    const type = readString(calendar, 'type');
    if (id && (!type || type === 'primary')) return id;
  }
  const first = calendars[0];
  return readString(nested(first, 'calendar'), 'calendar_id', 'calendarId') || readString(first, 'calendar_id', 'calendarId');
}

function eventId(value: unknown) {
  return readString(value, 'event_id', 'eventId', 'id');
}

function eventStatus(value: unknown) {
  return readString(value, 'status').toLowerCase();
}

function eventTime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'object') {
    const source = record(value);
    return eventTime(source.timestamp ?? source.date ?? source.time);
  }
  return optionalFeishuTimestamp(value);
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function associatedReference(value: unknown, eventIdValue: string, kind: 'minutes' | 'message') {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 180) return null;
  const escapedEventId = eventIdValue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`^${kind}:${escapedEventId}$`, 'u');
  return pattern.test(normalized) ? normalized : null;
}

function exactEvidence(value: string, eventIdValue: string, kind: 'minutes' | 'message') {
  const reference = associatedReference(value, eventIdValue, kind);
  return { present: reference !== null, reference };
}

function anyExactEvidence(values: string[], eventIdValue: string, kind: 'minutes' | 'message') {
  for (const value of values) {
    const result = exactEvidence(value, eventIdValue, kind);
    if (result.present) return result;
  }
  return { present: false, reference: null as string | null };
}

function safeAttendees(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map((item) => {
    const attendee = record(item);
    const chatMembers = Array.isArray(attendee.chat_members) ? attendee.chat_members.length : undefined;
    return {
      type: readString(attendee, 'type') || undefined,
      id: readString(attendee, 'attendee_id', 'user_id', 'userId', 'open_id', 'chat_id', 'room_id', 'operate_id') || undefined,
      name: readString(attendee, 'display_name', 'name') || undefined,
      rsvpStatus: readString(attendee, 'rsvp_status') || undefined,
      optional: typeof attendee.is_optional === 'boolean' ? attendee.is_optional : undefined,
      organizer: typeof attendee.is_organizer === 'boolean' ? attendee.is_organizer : undefined,
      external: typeof attendee.is_external === 'boolean' ? attendee.is_external : undefined,
      chatMemberCount: chatMembers,
    };
  });
}

const CALENDAR_TEXT_PATTERN = /^[^\u0000-\u001F\u007F]{0,2000}$/u;
const CALENDAR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,199}$/u;
const CALENDAR_TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+./-]{0,63}$/u;
const CALENDAR_SOURCE_VERSION_PATTERN = /^[a-f0-9]{64}$/u;
const CALENDAR_TIME_KEYS = new Set(['timestamp', 'date', 'time', 'timezone']);
const CALENDAR_TIME_VALUE_KEYS = ['timestamp', 'date', 'time'] as const;
const CALENDAR_ORGANIZER_ID_KEYS = ['user_id', 'open_id', 'userId'] as const;
const CALENDAR_ORGANIZER_NAME_KEYS = ['display_name', 'name'] as const;
const CALENDAR_ATTENDEE_ID_KEYS = [
  'attendee_id', 'user_id', 'userId', 'open_id', 'chat_id', 'room_id', 'operate_id',
] as const;
const CALENDAR_ATTENDEE_NAME_KEYS = ['display_name', 'name'] as const;
const CALENDAR_ORGANIZER_KEYS = new Set<string>([...CALENDAR_ORGANIZER_ID_KEYS, ...CALENDAR_ORGANIZER_NAME_KEYS]);
const CALENDAR_ATTENDEE_KEYS = new Set<string>([
  'type', ...CALENDAR_ATTENDEE_ID_KEYS, ...CALENDAR_ATTENDEE_NAME_KEYS, 'rsvp_status', 'is_optional',
  'is_organizer', 'is_external', 'chat_members',
]);
const CALENDAR_CHAT_MEMBER_KEYS = new Set<string>([
  'type', ...CALENDAR_ATTENDEE_ID_KEYS, ...CALENDAR_ATTENDEE_NAME_KEYS,
]);
const CALENDAR_MEETING_KEYS = new Set(['meeting_url', 'meetingUrl', 'live_link']);
const CALENDAR_EVENT_KEYS = new Set([
  'event_id', 'eventId', 'id', 'summary', 'title', 'name', 'description', 'description_rich',
  'start_time', 'startTime', 'end_time', 'endTime', 'start_timezone', 'startTimezone', 'end_timezone', 'endTimezone',
  'status', 'event_type', 'eventType', 'calendar_event_type', 'calendar_kind', 'calendarKind', 'calendar_type', 'calendarType',
  'recurrence_id', 'recurrenceId', 'series_id', 'seriesId', 'recurrence_rule', 'recurrenceRule',
  'app_link', 'appLink', 'source_url', 'sourceUrl', 'self_rsvp_status', 'selfRsvpStatus',
  'event_organizer', 'eventOrganizer', 'organizer', 'attendees', 'vchat', 'video_conference',
  'is_all_day', 'isAllDay', 'all_day', 'allDay', 'is_deleted', 'isDeleted',
  'has_minutes_or_explicit_message_reference', 'hasMinutesOrExplicitMessageReference',
  'minutes_reference', 'minutesReference', 'explicit_message_reference', 'explicitMessageReference',
  'source_version', 'sourceVersion', 'create_time', 'createTime',
]);

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strictCalendarText(value: unknown, maxLength = 2_000) {
  return typeof value === 'string' && value.length <= maxLength && CALENDAR_TEXT_PATTERN.test(value);
}

function strictCalendarNonEmptyText(value: unknown, maxLength = 2_000) {
  return strictCalendarText(value, maxLength) && String(value).length > 0;
}

function strictCalendarId(value: unknown) {
  return typeof value === 'string' && CALENDAR_ID_PATTERN.test(value);
}

type NormalizedCalendarTime = { timestamp: string; timezone?: string };

function normalizedCalendarTime(value: unknown): NormalizedCalendarTime | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number') {
    const timestamp = optionalFeishuTimestamp(value);
    return timestamp ? { timestamp } : null;
  }
  const source = plainRecord(value);
  if (!source || Object.keys(source).some((key) => !CALENDAR_TIME_KEYS.has(key))) return null;
  const providedTimes = CALENDAR_TIME_VALUE_KEYS.filter((key) => key in source).map((key) => source[key]);
  if (providedTimes.length === 0) return null;
  const timestamps = providedTimes.map((item) => {
    if ((typeof item !== 'string' && typeof item !== 'number') || item === '') return undefined;
    return optionalFeishuTimestamp(item);
  });
  if (timestamps.some((item): item is undefined => item === undefined) || timestamps.some((item) => item !== timestamps[0])) return null;
  if ('timezone' in source && (typeof source.timezone !== 'string' || !CALENDAR_TIMEZONE_PATTERN.test(source.timezone))) return null;
  return source.timezone === undefined
    ? { timestamp: timestamps[0]! }
    : { timestamp: timestamps[0]!, timezone: source.timezone as string };
}

function strictCalendarTime(value: unknown) {
  return normalizedCalendarTime(value) !== null;
}

function strictCalendarProvidedField(event: Record<string, unknown>, key: string, validator: (value: unknown) => boolean) {
  return !(key in event) || (event[key] !== undefined && validator(event[key]));
}

function strictCalendarOrganizer(value: unknown) {
  if (value === undefined) return true;
  if (value === null) return false;
  const source = plainRecord(value);
  if (!source || Object.keys(source).length === 0 || Object.keys(source).some((key) => !CALENDAR_ORGANIZER_KEYS.has(key))) return false;
  if (!Object.keys(source).some((key) => [...CALENDAR_ORGANIZER_ID_KEYS, ...CALENDAR_ORGANIZER_NAME_KEYS].some((allowed) => allowed === key))) return false;
  if (!consistentAliases(source, [...CALENDAR_ORGANIZER_ID_KEYS]) || !consistentAliases(source, [...CALENDAR_ORGANIZER_NAME_KEYS])) return false;
  return Object.values(source).every((item) => strictCalendarNonEmptyText(item, 200));
}

function strictCalendarAttendees(value: unknown) {
  if (value === undefined) return true;
  if (value === null) return false;
  if (!Array.isArray(value) || value.length > 200) return false;
  return value.every((item) => {
    const source = plainRecord(item);
    if (!source || Object.keys(source).some((key) => !CALENDAR_ATTENDEE_KEYS.has(key))) return false;
    if (![...CALENDAR_ATTENDEE_ID_KEYS, ...CALENDAR_ATTENDEE_NAME_KEYS].some((key) => key in source)) return false;
    if (!consistentAliases(source, [...CALENDAR_ATTENDEE_ID_KEYS]) || !consistentAliases(source, [...CALENDAR_ATTENDEE_NAME_KEYS])) return false;
    for (const key of ['type', ...CALENDAR_ATTENDEE_ID_KEYS, ...CALENDAR_ATTENDEE_NAME_KEYS, 'rsvp_status'] as const) {
      if (key in source && !strictCalendarNonEmptyText(source[key], 200)) return false;
    }
    for (const key of ['is_optional', 'is_organizer', 'is_external'] as const) {
      if (key in source && typeof source[key] !== 'boolean') return false;
    }
    if ('chat_members' in source && (!Array.isArray(source.chat_members) || source.chat_members.length > 10_000 || source.chat_members.some((member) => {
      const nestedMember = plainRecord(member);
      if (!nestedMember || Object.keys(nestedMember).length === 0 || Object.keys(nestedMember).some((key) => !CALENDAR_CHAT_MEMBER_KEYS.has(key))) return true;
      if (![...CALENDAR_ATTENDEE_ID_KEYS, ...CALENDAR_ATTENDEE_NAME_KEYS].some((key) => key in nestedMember)) return true;
      if (!consistentAliases(nestedMember, [...CALENDAR_ATTENDEE_ID_KEYS]) || !consistentAliases(nestedMember, [...CALENDAR_ATTENDEE_NAME_KEYS])) return true;
      return Object.values(nestedMember).some((item) => !strictCalendarNonEmptyText(item, 200));
    }))) return false;
    return true;
  });
}

function strictCalendarStringAliases(event: Record<string, unknown>, keys: string[], maxLength = 2_000, pattern?: RegExp) {
  return keys.every((key) => {
    if (!(key in event)) return true;
    if (typeof event[key] !== 'string') return false;
    const value = String(event[key]);
    return value.trim().length > 0
      && value.length <= maxLength
      && CALENDAR_TEXT_PATTERN.test(value)
      && (!pattern || pattern.test(value));
  });
}

function strictCalendarBooleanAliases(event: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => !(key in event) || typeof event[key] === 'boolean');
}

function strictCalendarContainerStrings(value: unknown, allowed: Set<string>, maxLength = 2_048) {
  if (value === undefined) return true;
  if (value === null) return false;
  const source = plainRecord(value);
  if (!source || Object.keys(source).length === 0 || Object.keys(source).some((key) => !allowed.has(key))) return false;
  return Object.values(source).every((item) => strictCalendarNonEmptyText(item, maxLength));
}

function consistentContainerAliases(value: unknown, keys: string[]) {
  const source = plainRecord(value);
  return source === null || consistentAliases(source, keys);
}

function consistentTimeZoneAliases(event: Record<string, unknown>, timeKeys: string[], timezoneKeys: string[]) {
  const values: unknown[] = [];
  for (const key of timeKeys) {
    if (!(key in event)) continue;
    const source = plainRecord(event[key]);
    if (source && 'timezone' in source) values.push(source.timezone);
  }
  for (const key of timezoneKeys) {
    if (key in event) values.push(event[key]);
  }
  return values.length < 2 || values.every((value) => value === values[0]);
}

function consistentCalendarTimeAliases(event: Record<string, unknown>, keys: string[]) {
  const values = keys.filter((key) => key in event).map((key) => normalizedCalendarTime(event[key]));
  return values.length < 2 || values.every((value) => value !== null && JSON.stringify(value) === JSON.stringify(values[0]));
}

function consistentAliases(event: Record<string, unknown>, keys: string[]) {
  const values = keys.filter((key) => key in event).map((key) => event[key]);
  return values.length < 2 || values.every((value) => value === values[0]);
}

function canonicalAliasValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalAliasValue);
  const source = plainRecord(value);
  if (source) return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonicalAliasValue(source[key])]));
  return value;
}

function consistentStructuredAliases(event: Record<string, unknown>, keys: string[]) {
  const values = keys.filter((key) => key in event).map((key) => JSON.stringify(canonicalAliasValue(event[key])));
  return values.length < 2 || values.every((value) => value === values[0]);
}

function normalizedOrganizer(value: unknown) {
  const source = plainRecord(value);
  if (!source) return null;
  return {
    identity: CALENDAR_ORGANIZER_ID_KEYS.filter((key) => key in source).map((key) => source[key])[0],
    name: CALENDAR_ORGANIZER_NAME_KEYS.filter((key) => key in source).map((key) => source[key])[0],
  };
}

function consistentOrganizerAliases(event: Record<string, unknown>, keys: string[]) {
  const values = keys.filter((key) => key in event).map((key) => normalizedOrganizer(event[key]));
  return values.length < 2 || values.every((value) => value !== null && JSON.stringify(value) === JSON.stringify(values[0]));
}

function detailEvent(value: unknown) {
  const source = record(value);
  return source.event && typeof source.event === 'object' ? source.event as Record<string, unknown> : source;
}

function sourceVersion(calendarId: string, event: Record<string, unknown>) {
  const organizer = nested(event, 'event_organizer', 'organizer');
  const attendees = safeAttendees(event.attendees);
  const stable = {
    calendarId,
    eventId: eventId(event),
    summary: readString(event, 'summary', 'title', 'name'),
    description: readString(event, 'description', 'description_rich'),
    status: eventStatus(event),
    start: eventTime(event.start_time ?? event.startTime),
    end: eventTime(event.end_time ?? event.endTime),
    startTimezone: readString(nested(event, 'start_time', 'startTime'), 'timezone'),
    endTimezone: readString(nested(event, 'end_time', 'endTime'), 'timezone'),
    organizer: { id: readString(organizer, 'user_id', 'open_id', 'userId'), name: readString(organizer, 'display_name', 'name') },
    attendees,
    appLink: readString(event, 'app_link', 'appLink', 'source_url', 'sourceUrl'),
    meetingUrl: readString(nested(event, 'vchat', 'video_conference'), 'meeting_url', 'meetingUrl', 'live_link'),
    selfRsvpStatus: readString(event, 'self_rsvp_status', 'selfRsvpStatus'),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function calendarOwnerRole(event: Record<string, unknown>, owner: OwnerIdentity, organizerId: string) {
  if (organizerId && [owner.openId, owner.userId, owner.unionId].filter(Boolean).includes(organizerId)) return 'organizer';
  const attendees = safeAttendees(event.attendees);
  const ownerAttendee = attendees.find((attendee) => attendee.id && [owner.openId, owner.userId, owner.unionId].filter(Boolean).includes(attendee.id));
  if (!ownerAttendee) return 'no_response';
  if (ownerAttendee.organizer) return 'organizer';
  return ownerAttendee.optional ? 'optional_attendee' : 'required_attendee';
}

function calendarOwnerResponse(event: Record<string, unknown>, owner: OwnerIdentity) {
  const attendees = safeAttendees(event.attendees);
  const ownerAttendee = attendees.find((attendee) => attendee.id && [owner.openId, owner.userId, owner.unionId].filter(Boolean).includes(attendee.id));
  return ownerAttendee?.rsvpStatus || readString(event, 'self_rsvp_status', 'selfRsvpStatus') || 'no_response';
}

function normalizeEvent(calendarId: string, item: unknown, owner: OwnerIdentity, detailAvailable: boolean): NormalizedSourceEvent | null {
  const event = record(item);
  const id = eventId(event);
  if (!id) return null;
  const organizer = nested(event, 'event_organizer', 'eventOrganizer', 'organizer');
  const startInput = event.start_time ?? event.startTime;
  const endInput = event.end_time ?? event.endTime;
  const minutesReferenceValues = [event.minutes_reference, event.minutesReference].filter((value): value is string => typeof value === 'string');
  const explicitMessageReferenceValues = [event.explicit_message_reference, event.explicitMessageReference].filter((value): value is string => typeof value === 'string');
  const evidenceFlagValues = [event.has_minutes_or_explicit_message_reference, event.hasMinutesOrExplicitMessageReference].filter((value) => value !== undefined);
  const providedSourceVersionValues = [event.source_version, event.sourceVersion].filter((value) => value !== undefined);
  const rawInputInvalid = Object.keys(event).some((key) => !CALENDAR_EVENT_KEYS.has(key))
    || !strictCalendarStringAliases(event, ['event_id', 'eventId', 'id'], 200, CALENDAR_ID_PATTERN)
    || !strictCalendarId(id)
    || !consistentAliases(event, ['event_id', 'eventId', 'id'])
    || !strictCalendarStringAliases(event, ['summary', 'title', 'name'], 500)
    || !strictCalendarStringAliases(event, ['description', 'description_rich'], 2_000)
    || !strictCalendarStringAliases(event, ['status'], 40)
    || !strictCalendarStringAliases(event, ['event_type', 'eventType', 'calendar_event_type'], 80)
    || !strictCalendarStringAliases(event, ['calendar_kind', 'calendarKind', 'calendar_type', 'calendarType'], 80)
    || !strictCalendarStringAliases(event, ['recurrence_id', 'recurrenceId', 'series_id', 'seriesId', 'recurrence_rule', 'recurrenceRule'], 240)
    || !strictCalendarStringAliases(event, ['app_link', 'appLink', 'source_url', 'sourceUrl'], 2_048)
    || !strictCalendarStringAliases(event, ['self_rsvp_status', 'selfRsvpStatus'], 40)
    || !strictCalendarProvidedField(event, 'start_time', strictCalendarTime)
    || !strictCalendarProvidedField(event, 'startTime', strictCalendarTime)
    || !strictCalendarProvidedField(event, 'end_time', strictCalendarTime)
    || !strictCalendarProvidedField(event, 'endTime', strictCalendarTime)
    || !strictCalendarProvidedField(event, 'create_time', strictCalendarTime)
    || !strictCalendarProvidedField(event, 'createTime', strictCalendarTime)
    || !strictCalendarStringAliases(event, ['start_timezone', 'startTimezone'], 64, CALENDAR_TIMEZONE_PATTERN)
    || !strictCalendarStringAliases(event, ['end_timezone', 'endTimezone'], 64, CALENDAR_TIMEZONE_PATTERN)
    || !strictCalendarProvidedField(event, 'event_organizer', strictCalendarOrganizer)
    || !strictCalendarProvidedField(event, 'eventOrganizer', strictCalendarOrganizer)
    || !strictCalendarProvidedField(event, 'organizer', strictCalendarOrganizer)
    || !strictCalendarProvidedField(event, 'attendees', strictCalendarAttendees)
    || !strictCalendarProvidedField(event, 'vchat', (value) => strictCalendarContainerStrings(value, CALENDAR_MEETING_KEYS))
    || !strictCalendarProvidedField(event, 'video_conference', (value) => strictCalendarContainerStrings(value, CALENDAR_MEETING_KEYS))
    || !strictCalendarBooleanAliases(event, ['is_all_day', 'isAllDay', 'all_day', 'allDay', 'is_deleted', 'isDeleted'])
    || !strictCalendarBooleanAliases(event, ['has_minutes_or_explicit_message_reference', 'hasMinutesOrExplicitMessageReference'])
    || !strictCalendarStringAliases(event, ['minutes_reference', 'minutesReference', 'explicit_message_reference', 'explicitMessageReference'], 240)
    || !strictCalendarStringAliases(event, ['source_version', 'sourceVersion'], 64, CALENDAR_SOURCE_VERSION_PATTERN)
    || !consistentAliases(event, ['summary', 'title', 'name'])
    || !consistentAliases(event, ['description', 'description_rich'])
    || !consistentAliases(event, ['event_type', 'eventType', 'calendar_event_type'])
    || !consistentAliases(event, ['calendar_kind', 'calendarKind', 'calendar_type', 'calendarType'])
    || !consistentAliases(event, ['recurrence_id', 'recurrenceId', 'series_id', 'seriesId', 'recurrence_rule', 'recurrenceRule'])
    || !consistentAliases(event, ['app_link', 'appLink', 'source_url', 'sourceUrl'])
    || !consistentAliases(event, ['self_rsvp_status', 'selfRsvpStatus'])
    || !consistentAliases(event, ['is_all_day', 'isAllDay', 'all_day', 'allDay'])
    || !consistentAliases(event, ['is_deleted', 'isDeleted'])
    || !consistentCalendarTimeAliases(event, ['create_time', 'createTime'])
    || (event.status !== undefined && !['confirmed', 'tentative', 'cancelled'].includes(String(event.status).toLowerCase()))
    || (event.minutes_reference !== undefined && typeof event.minutes_reference !== 'string')
    || (event.minutesReference !== undefined && typeof event.minutesReference !== 'string')
    || (event.explicit_message_reference !== undefined && typeof event.explicit_message_reference !== 'string')
    || (event.explicitMessageReference !== undefined && typeof event.explicitMessageReference !== 'string')
    || !consistentAliases(event, ['minutes_reference', 'minutesReference'])
    || !consistentAliases(event, ['explicit_message_reference', 'explicitMessageReference'])
    || !consistentAliases(event, ['has_minutes_or_explicit_message_reference', 'hasMinutesOrExplicitMessageReference'])
    || !consistentAliases(event, ['start_timezone', 'startTimezone'])
    || !consistentAliases(event, ['end_timezone', 'endTimezone'])
    || !consistentTimeZoneAliases(event, ['start_time', 'startTime'], ['start_timezone', 'startTimezone'])
    || !consistentTimeZoneAliases(event, ['end_time', 'endTime'], ['end_timezone', 'endTimezone'])
    || !consistentAliases(event, ['source_version', 'sourceVersion'])
    || !consistentCalendarTimeAliases(event, ['start_time', 'startTime'])
    || !consistentCalendarTimeAliases(event, ['end_time', 'endTime'])
    || !consistentCalendarTimeAliases(event, ['create_time', 'createTime'])
    || !consistentOrganizerAliases(event, ['event_organizer', 'eventOrganizer', 'organizer'])
    || !consistentStructuredAliases(event, ['vchat', 'video_conference'])
    || !consistentContainerAliases(event.vchat, ['meeting_url', 'meetingUrl', 'live_link'])
    || !consistentContainerAliases(event.video_conference, ['meeting_url', 'meetingUrl', 'live_link']);
  const summary = readString(event, 'summary', 'title', 'name') || '未命名日程';
  const description = readString(event, 'description', 'description_rich');
  const status = eventStatus(event) || 'confirmed';
  const cancelled = status === 'cancelled' || Boolean(event.is_deleted ?? event.isDeleted);
  const start = eventTime(startInput);
  const end = eventTime(endInput);
  const organizerId = readString(organizer, 'user_id', 'open_id', 'userId') || 'calendar-organizer';
  const organizerName = readString(organizer, 'display_name', 'name') || owner.name || '飞书日历';
  const appLink = readString(event, 'app_link', 'appLink', 'source_url', 'sourceUrl');
  const meetingUrl = readString(nested(event, 'vchat', 'video_conference'), 'meeting_url', 'meetingUrl', 'live_link');
  const allDayValues = [event.is_all_day, event.isAllDay, event.all_day, event.allDay].filter((value) => value !== undefined);
  const isAllDay = allDayValues.some((value) => value === true);
  const recurrenceOrSeriesKey = readString(event, 'recurrence_id', 'recurrenceId', 'series_id', 'seriesId', 'recurrence_rule', 'recurrenceRule') || null;
  const calendarKind = readString(event, 'calendar_kind', 'calendarKind', 'calendar_type', 'calendarType') || 'owner_calendar';
  const rawEventTypeValues = [event.event_type, event.eventType, event.calendar_event_type].filter((value) => value !== undefined && value !== null);
  const rawEventType = readString(event, 'event_type', 'eventType', 'calendar_event_type');
  const rawCalendarKindValues = [event.calendar_kind, event.calendarKind, event.calendar_type, event.calendarType].filter((value) => value !== undefined && value !== null);
  const recurrenceValues = [event.recurrence_id, event.recurrenceId, event.series_id, event.seriesId, event.recurrence_rule, event.recurrenceRule].filter((value) => value !== undefined && value !== null);
  const eventType = rawEventType || (isAllDay ? 'all_day' : recurrenceOrSeriesKey ? 'recurring' : meetingUrl ? 'meeting_placeholder' : 'ordinary_reminder');
  const minutesEvidence = anyExactEvidence(minutesReferenceValues, id, 'minutes');
  const messageEvidence = anyExactEvidence(explicitMessageReferenceValues, id, 'message');
  const hasMinutesOrExplicitMessageReference = minutesEvidence.present || messageEvidence.present;
  const invalidEvidenceReference = (event.minutes_reference !== undefined && !minutesEvidence.present)
    || (event.minutesReference !== undefined && !minutesEvidence.present)
    || (event.explicit_message_reference !== undefined && !messageEvidence.present)
    || (event.explicitMessageReference !== undefined && !messageEvidence.present);
  const derivedSourceVersion = sourceVersion(calendarId, event);
  const calendarInputInvalid = rawInputInvalid
    || allDayValues.some((value) => typeof value !== 'boolean')
    || rawEventTypeValues.some((value) => typeof value !== 'string')
    || rawCalendarKindValues.some((value) => typeof value !== 'string')
    || recurrenceValues.some((value) => typeof value !== 'string')
    || (event.status !== undefined && typeof event.status !== 'string')
    || (event.is_deleted !== undefined && typeof event.is_deleted !== 'boolean')
    || (event.isDeleted !== undefined && typeof event.isDeleted !== 'boolean')
    || [event.has_minutes_or_explicit_message_reference, event.hasMinutesOrExplicitMessageReference].filter((value) => value !== undefined).some((value) => typeof value !== 'boolean')
    || (event.minutes_reference !== undefined && typeof event.minutes_reference !== 'string')
    || (event.minutesReference !== undefined && typeof event.minutesReference !== 'string')
    || (event.explicit_message_reference !== undefined && typeof event.explicit_message_reference !== 'string')
    || (event.explicitMessageReference !== undefined && typeof event.explicitMessageReference !== 'string')
    || evidenceFlagValues.some((value) => value === true || value !== hasMinutesOrExplicitMessageReference)
    || invalidEvidenceReference
    || (providedSourceVersionValues.length > 0 && providedSourceVersionValues.some((value) => value !== derivedSourceVersion));
  const content = [
    `日程：${summary}`,
    description ? `描述：${truncate(description, 1800)}` : '',
    start ? `开始：${start}` : '',
    end ? `结束：${end}` : '',
    cancelled ? '状态：已取消' : '',
  ].filter(Boolean).join('\n');
  const completeness: SourceCompleteness = detailAvailable ? 'complete' : (summary || description ? 'partial' : 'limited');
  const metadata: Record<string, unknown> = {
    schemaVersion: 1,
    sourceScope: 'owner_calendar',
    calendarId,
    eventId: id,
    status,
    cancelled,
    startTime: start ?? null,
    endTime: end ?? null,
    startTimezone: readString(startInput, 'timezone') || readString(event, 'start_timezone', 'startTimezone') || null,
    endTimezone: readString(endInput, 'timezone') || readString(event, 'end_timezone', 'endTimezone') || null,
    organizer: { id: organizerId, name: organizerName },
    attendees: safeAttendees(event.attendees),
    meetingUrl: meetingUrl || null,
    selfRsvpStatus: readString(event, 'self_rsvp_status', 'selfRsvpStatus') || null,
    detailsAvailable: detailAvailable,
    fullBodyAvailable: Boolean(summary || description),
    calendarTitle: summary,
    isAllDay,
    recurrenceOrSeriesKey,
    isRecurring: Boolean(recurrenceOrSeriesKey),
    calendarKind,
    eventType,
    ownerRole: calendarOwnerRole(event, owner, organizerId),
    ownerResponse: calendarOwnerResponse(event, owner),
    hasMinutesOrExplicitMessageReference,
    calendarInputInvalid,
    ...(minutesEvidence.reference ? { minutesReference: minutesEvidence.reference } : {}),
    ...(messageEvidence.reference ? { explicitMessageReference: messageEvidence.reference } : {}),
    meetingPlaceholder: eventType === 'meeting_placeholder',
    sourceVersion: derivedSourceVersion,
  };
  const occurredAt = start ?? eventTime(event.create_time ?? event.createTime) ?? nowIso();
  return {
    externalId: `calendar:${calendarId}:${id}`,
    sourceType: 'calendar',
    conversationId: `calendar:${calendarId}`,
    senderId: organizerId,
    senderName: organizerName,
    content,
    occurredAt: normalizeFeishuTimestamp(occurredAt),
    ownerMentioned: false,
    sourceUrl: appLink || undefined,
    completeness,
    discoveryReason: '系统主人授权的个人日历同步',
    metadata,
  };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? '飞书日历同步失败。');
}

function statusForError(error: unknown): Extract<OwnerSourceStatus, 'unauthorized' | 'admin_required' | 'error'> {
  return feishuApiErrorStatus(error);
}

function isInvalidSyncToken(error: unknown) {
  const value = error as { code?: unknown; response?: { code?: unknown } };
  const code = String(value?.code ?? value?.response?.code ?? '');
  const message = errorText(error);
  // The SDK does not expose a stable enum for this condition. Only reset on
  // an explicit sync-token invalid/expired response; generic errors retain the
  // old cursor so a later retry cannot silently skip changes.
  return /sync[_ -]?token.{0,32}(invalid|expired|过期|无效)|(?:invalid|expired|过期|无效).{0,32}sync[_ -]?token/i.test(`${code} ${message}`);
}

export class FeishuCalendarSyncRunner {
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

  async runAfterCurrent(context?: OperationContext): Promise<CalendarSyncResult> {
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    return this.runOnce(context);
  }

  async runOnce(context?: OperationContext): Promise<CalendarSyncResult> {
    const empty = (skipped: boolean, reason?: string): CalendarSyncResult => ({ calendars: 0, events: 0, deduplicated: 0, failures: 0, detailFailures: 0, skipped, reason });
    if (this.running) return empty(true, 'already_running');
    if (!this.config.externalEnabled) return empty(true, 'scan_disabled');
    const owner = this.readOwner();
    if (!owner) {
      this.markState('unauthorized', '尚未完成系统主人 OAuth，个人日历暂不扫描。');
      return empty(true, 'owner_oauth_required');
    }
    const missingScopes = missingFeishuScopes('calendar', owner.grantedScopes);
    if (!owner.scopeState.valid || missingScopes.length > 0) {
      const message = '系统主人个人日历缺少已验证的日历只读权限，已跳过本轮。';
      this.markState('admin_required', message, {
        reason: 'scope_required',
        scopeState: owner.scopeState.reason,
        missingScopes,
      });
      this.onStatus?.('warn', message, { reason: 'scope_required', missingScopes });
      return empty(true, 'scope_required');
    }
    this.running = true;
    let activeCalendarId: string | undefined;
    try {
      const primary = await this.withTransientRetry(() => this.adapter.primaryCalendar(), 'calendar:primary');
      const calendarId = calendarIdFromPrimary(primary);
      if (!calendarId) throw new Error('飞书没有返回系统主人主日历 ID。');
      activeCalendarId = calendarId;
      const cursor = this.readCursor(calendarId);
      try {
          return await this.scanCalendar(calendarId, owner, cursor, cursor?.syncToken ? 'incremental' : 'full', context);
      } catch (error) {
        if (cursor?.syncToken && isInvalidSyncToken(error)) {
          this.onStatus?.('warn', '飞书日历增量游标已失效，下一次请求将受控重建。', { calendarId, rebuild: true, ...context });
          return await this.scanCalendar(calendarId, owner, null, 'rebuild', context);
        }
        throw error;
      }
    } catch (error) {
      const message = feishuErrorDiagnostic(error);
      const status = statusForError(error);
      this.saveCursorError(message, activeCalendarId);
      this.markState(status, message);
      if (status === 'unauthorized') this.markOwnerOAuthFailure(message);
      this.onStatus?.('error', '系统主人个人日历同步失败。', { status, ...context });
      return { ...empty(false), failures: 1, reason: 'sync_failed' };
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private readOwner(): CalendarOwner | null {
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

  private readCursor(calendarId: string): CalendarCursor | null {
    const row = this.database.raw.prepare('SELECT cursor FROM sync_cursor WHERE integration = ? AND scope_key = ?').get(calendarCursorIntegration, `calendar:${calendarId}`) as { cursor: string | null } | undefined;
    const parsed = parseJson<Partial<CalendarCursor> | null>(row?.cursor, null);
    if (parsed?.version === 1 && parsed.calendarId === calendarId && typeof parsed.syncToken === 'string' && parsed.syncToken.length > 0) {
      return { version: 1, calendarId, mode: 'incremental', syncToken: parsed.syncToken };
    }
    return null;
  }

  private async scanCalendar(calendarId: string, owner: OwnerIdentity, cursor: CalendarCursor | null, requestedMode: 'full' | 'incremental' | 'rebuild', context?: OperationContext) {
    const mode = requestedMode === 'rebuild' ? 'full' : requestedMode;
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    let pages = 0;
    let events = 0;
    let deduplicated = 0;
    let failures = 0;
    let detailFailures = 0;
    let detailStatus: 'admin_required' | 'error' | null = null;
    const seen = new Set<string>();
    do {
      if (++pages > maxPages) throw new Error('飞书日历分页超过安全上限。');
      const page = await this.withTransientRetry(
        () => this.adapter.listCalendarEvents({ calendarId, pageToken, syncToken: mode === 'incremental' ? cursor?.syncToken : undefined, pageSize: Math.min(this.config.scanPageSize, 50), operationContext: context }) as Promise<CalendarPage>,
        `calendar:${calendarId}`,
      );
      nextSyncToken = page.sync_token || nextSyncToken;
      for (const item of page.items ?? []) {
        const listed = record(item);
        const id = eventId(listed);
        if (!id || seen.has(id)) {
          if (id) deduplicated += 1;
          continue;
        }
        seen.add(id);
        let merged = listed;
        let detailsAvailable = false;
        try {
          const detail = await this.withTransientRetry(() => this.adapter.getCalendarEvent({ calendarId, eventId: id, needAttendee: true, operationContext: context }), `calendar-event:${calendarId}`);
          const resolved = detailEvent(detail);
          if (eventId(resolved)) {
            merged = { ...listed, ...resolved };
            detailsAvailable = true;
          }
        } catch (error) {
          if (isFeishuDetailBlockingError(error)) throw error;
          detailFailures += 1;
          const status = statusForError(error);
          if (status === 'admin_required') detailStatus = 'admin_required';
          else if (!detailStatus) detailStatus = 'error';
          this.onStatus?.('warn', '一条日历详情暂不可读，已保留列表摘要。', { calendarId, detailStatus: status, ...context });
        }
        const event = normalizeEvent(calendarId, merged, owner, detailsAvailable);
        if (!event) continue;
        try {
          const outcome = await this.ingest(event, context) as { deduplicated?: boolean } | undefined;
          events += 1;
          if (outcome?.deduplicated) deduplicated += 1;
        } catch (error) {
          failures += 1;
          this.onStatus?.('warn', '一条日历来源写入主链失败，本轮不会推进游标。', { calendarId, failureType: error instanceof Error ? error.name : 'unknown', ...context });
        }
      }
      const next = page.has_more ? page.page_token : undefined;
      if (page.has_more && !next) throw new Error('飞书日历返回了下一页标记，但没有分页游标。');
      if (next && next === pageToken) throw new Error('飞书日历分页游标没有前进。');
      pageToken = next;
    } while (pageToken);

    if (failures > 0) {
      const message = `有 ${failures} 条日历来源未写入主链；已保留旧游标，后续会重试。`;
      this.saveCursorError(message, calendarId);
      this.markState('error', message, { calendarId, mode, events, pages, failures, detailFailures });
      return { calendars: 1, events, deduplicated, failures, detailFailures, skipped: false, calendarId, mode: requestedMode };
    }
    if (!nextSyncToken) {
      const message = '飞书日历响应未返回 sync_token；已保留全量模式，下一轮会继续完整扫描。';
      this.saveCursorError(message, calendarId);
      this.markState('error', message, { calendarId, mode, events, pages, failures, detailFailures, syncTokenPresent: false });
      return { calendars: 1, events, deduplicated, failures: 1, detailFailures, skipped: false, calendarId, mode: requestedMode, reason: 'sync_token_missing' };
    }
    this.saveCursor({ version: 1, calendarId, mode: 'incremental', syncToken: nextSyncToken });
    const status = detailStatus ?? 'partial';
    const detailError = detailFailures > 0 ? `有 ${detailFailures} 条日历详情暂不可读，已保留列表摘要。` : null;
    // The event list and durable inbox completed even if individual detail
    // calls were permission-limited. Keep this run visible as a successful
    // (possibly partial) sync while preserving the detail error for the UI.
    this.markState(status, detailError, { calendarId, mode, events, pages, failures: 0, detailFailures, syncTokenPresent: true }, true);
    this.onStatus?.('info', '系统主人个人日历同步完成。', { calendarId, mode, events, pages, detailFailures });
    return { calendars: 1, events, deduplicated, failures: 0, detailFailures, skipped: false, calendarId, mode: requestedMode };
  }

  private async withTransientRetry<T>(operation: () => Promise<T>, scope: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxTransientAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isFeishuRetryableError(error) || attempt === maxTransientAttempts) throw error;
        this.onStatus?.('warn', '飞书日历接口暂时不可用，正在安全重试。', { scope, attempt, maxAttempts: maxTransientAttempts });
        await this.sleep(100 * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  private saveCursor(cursor: CalendarCursor) {
    const timestamp = nowIso();
    this.database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT(integration, scope_key) DO UPDATE SET cursor = excluded.cursor, last_success_at = excluded.last_success_at, last_error = NULL, updated_at = excluded.updated_at`,
    ).run(calendarCursorIntegration, `calendar:${cursor.calendarId}`, JSON.stringify(cursor), timestamp, timestamp);
  }

  private saveCursorError(message: string, calendarId?: string) {
    const timestamp = nowIso();
    if (calendarId) {
      this.database.raw.prepare(
        `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
         VALUES (?, ?, NULL, NULL, ?, ?)
         ON CONFLICT(integration, scope_key) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at`,
      ).run(calendarCursorIntegration, `calendar:${calendarId}`, redactDiagnosticText(message, 300), timestamp);
    }
  }

  private markState(status: Extract<OwnerSourceStatus, 'partial' | 'unauthorized' | 'admin_required' | 'error'>, error: string | null, details: Record<string, unknown> = {}, syncSucceeded = error === null) {
    const timestamp = nowIso();
    const existing = this.database.raw.prepare('SELECT details_json FROM information_source_state WHERE source_kind = ?').get('calendar') as { details_json: string } | undefined;
    const merged = { ...parseJson<Record<string, unknown>>(existing?.details_json, {}), ...details, adapterMode: 'live', realTenantValidated: false };
    this.database.raw.prepare(
      `UPDATE information_source_state SET status = ?, last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END, last_error = ?, details_json = ?, updated_at = ? WHERE source_kind = ?`,
    ).run(status, syncSucceeded ? 1 : 0, timestamp, error ? redactDiagnosticText(error, 300) : null, JSON.stringify(merged), timestamp, 'calendar');
  }

  private markOwnerOAuthFailure(message: string) {
    const status = /revok|撤销/i.test(message) ? 'revoked' : 'expired';
    this.database.raw.prepare('UPDATE owner_profile SET oauth_status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), 'primary');
  }
}
