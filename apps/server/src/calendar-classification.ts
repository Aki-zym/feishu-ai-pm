import { createHash } from 'node:crypto';

import contractSource from '../../../docs/product-rules/PROD-07-calendar-classification.json' with { type: 'json' };

import type { CandidateDraft, CandidateEvidenceBasis, CandidateTimeRange, NormalizedSourceEvent } from './domain.js';

export type CalendarClassificationRoute = 'calendar_fact' | 'candidate_review' | 'owner_confirmation';

export type CalendarClassification = {
  route: CalendarClassificationRoute;
  sourceRetained: true;
  candidateCreated: boolean;
  requiresOwnerConfirmation: boolean;
  explanationCode: string;
  evidenceFields: {
    ownerResponsibility?: string;
    action?: string;
    deliverableOrDeadline?: string;
    sourceReference: string;
    missingSignalCode?: string;
  };
  correctionScope: 'current_event_only';
};

type RouteContract = {
  meaning: string;
  candidate_created: boolean;
  owner_confirmation_required: boolean;
  source_retained: boolean;
  explanation_required: boolean;
};

type Prod07Contract = {
  schema_version: number;
  id: string;
  routes: Record<CalendarClassificationRoute, RouteContract>;
  role_matrix: Array<{ role: string; default_route: CalendarClassificationRoute; candidate_condition: string; does_not_imply_task: boolean }>;
  event_matrix: Array<{ event_type: string; default_route: CalendarClassificationRoute; reason: string }>;
  decision_rules: {
    candidate_requires_all: string[];
    explicit_action_verbs: string[];
    owner_responsibility_signals: string[];
    deliverable_or_deadline_signals: string[];
    non_signals: string[];
    uncertain_rule: { route: CalendarClassificationRoute; candidate_created: boolean; source_retained: boolean; bulk_candidate_creation: boolean; missing_signal_policy: string; scope: string; required_fields: string[]; forbidden_fields: string[] };
    meeting_rule: { placeholder_route: CalendarClassificationRoute; placeholder_is_action: boolean; action_item_sources: string[]; requires_all_candidate_signals: boolean; source_retained: boolean; scope: string };
    explanation_rule: Record<CalendarClassificationRoute, { route: CalendarClassificationRoute; required_fields: string[]; forbidden_fields: string[]; source_reference_required: boolean; raw_content_allowed: boolean; free_text_allowed: boolean; scope: string }>;
  };
  correction_rule: { current_event_scope: 'current_event_only'; source_mutation: string; global_filter: boolean; global_source_deletion: boolean };
  examples: Array<{ id: string; event_type: string; expected_route: CalendarClassificationRoute; explanation_code: string; explanation: string }>;
};

const ROUTES = ['calendar_fact', 'candidate_review', 'owner_confirmation'] as const;
const ALLOWED_ROLES = new Set(['organizer', 'required_attendee', 'optional_attendee', 'no_response']);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,199}$/u;
const SAFE_SOURCE_VERSION_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+./-]{0,63}$/u;
const SAFE_ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const ORGANIZER_KEYS = new Set(['id', 'name']);
const ATTENDEE_KEYS = new Set(['type', 'id', 'name', 'rsvpStatus', 'optional', 'organizer', 'external', 'chatMemberCount']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length > 160)) {
    throw new Error(`PROD-07 contract ${name} must be a non-empty string array.`);
  }
  return value as string[];
}

function route(value: unknown, name: string): CalendarClassificationRoute {
  if (typeof value !== 'string' || !ROUTES.includes(value as CalendarClassificationRoute)) throw new Error(`PROD-07 contract ${name} has an invalid route.`);
  return value as CalendarClassificationRoute;
}

function boundedString(value: unknown, maxLength: number, pattern?: RegExp) {
  return typeof value === 'string'
    && value.length <= maxLength
    && !/[\u0000-\u001F\u007F]/u.test(value)
    && (pattern ? pattern.test(value) : true);
}

function nullableBoundedString(value: unknown, maxLength: number, pattern?: RegExp) {
  return value === null || boundedString(value, maxLength, pattern);
}

function exactObjectKeys(value: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function strictOrganizer(value: unknown) {
  if (!isRecord(value) || !exactObjectKeys(value, ORGANIZER_KEYS)) return false;
  return boundedString(value.id, 200, SAFE_ID_PATTERN) && boundedString(value.name, 160);
}

function strictAttendees(value: unknown) {
  if (!Array.isArray(value) || value.length > 200) return false;
  return value.every((item) => {
    if (!isRecord(item) || !exactObjectKeys(item, ATTENDEE_KEYS)) return false;
    if (!['id', 'name'].some((key) => key in item)) return false;
    if ('type' in item && !boundedString(item.type, 40)) return false;
    if ('id' in item && !boundedString(item.id, 200, SAFE_ID_PATTERN)) return false;
    if ('name' in item && !boundedString(item.name, 160)) return false;
    for (const key of ['optional', 'organizer', 'external'] as const) {
      if (key in item && typeof item[key] !== 'boolean') return false;
    }
    if ('rsvpStatus' in item && !boundedString(item.rsvpStatus, 40)) return false;
    if ('chatMemberCount' in item && (typeof item.chatMemberCount !== 'number' || !Number.isInteger(item.chatMemberCount) || item.chatMemberCount < 0 || item.chatMemberCount > 10_000)) return false;
    return true;
  });
}

function canonicalEvidenceReference(value: unknown, eventId: string, kind: 'minutes' | 'message') {
  if (!boundedString(value, 240)) return false;
  const escapedEventId = eventId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${kind}:${escapedEventId}$`, 'u').test(String(value).trim());
}

function hasCanonicalMeetingEvidence(metadata: Record<string, unknown>) {
  const eventId = typeof metadata.eventId === 'string' ? metadata.eventId : '';
  if (!eventId) return false;
  return canonicalEvidenceReference(metadata.minutesReference, eventId, 'minutes')
    || canonicalEvidenceReference(metadata.explicitMessageReference, eventId, 'message');
}

/** Validate the product contract before the server can classify a source. */
export function validateProd07Contract(value: unknown): asserts value is Prod07Contract {
  if (!isRecord(value) || value.schema_version !== 1 || value.id !== 'PROD-07') throw new Error('PROD-07 contract identity/schema is invalid.');
  if (!isRecord(value.routes)) throw new Error('PROD-07 routes are missing.');
  for (const routeName of ROUTES) {
    const definition = value.routes[routeName];
    if (!isRecord(definition)
      || typeof definition.candidate_created !== 'boolean'
      || typeof definition.owner_confirmation_required !== 'boolean'
      || typeof definition.source_retained !== 'boolean'
      || typeof definition.explanation_required !== 'boolean') throw new Error(`PROD-07 route ${routeName} is invalid.`);
  }
  if (!Array.isArray(value.role_matrix) || value.role_matrix.length !== ALLOWED_ROLES.size) throw new Error('PROD-07 role_matrix is invalid.');
  const roles = new Set<string>();
  for (const item of value.role_matrix) {
    if (!isRecord(item) || typeof item.role !== 'string' || roles.has(item.role) || !ALLOWED_ROLES.has(item.role)
      || !ROUTES.includes(item.default_route as CalendarClassificationRoute) || typeof item.candidate_condition !== 'string' || item.does_not_imply_task !== true) throw new Error('PROD-07 role_matrix contains an invalid role.');
    roles.add(item.role);
  }
  if (!Array.isArray(value.event_matrix) || value.event_matrix.length < 1) throw new Error('PROD-07 event_matrix is missing.');
  const eventTypes = new Set<string>();
  for (const item of value.event_matrix) {
    if (!isRecord(item) || typeof item.event_type !== 'string' || eventTypes.has(item.event_type)
      || !ROUTES.includes(item.default_route as CalendarClassificationRoute) || typeof item.reason !== 'string') throw new Error('PROD-07 event_matrix contains an invalid event.');
    eventTypes.add(item.event_type);
  }
  if (!isRecord(value.decision_rules)) throw new Error('PROD-07 decision_rules are missing.');
  const decision = value.decision_rules;
  for (const key of ['candidate_requires_all', 'explicit_action_verbs', 'owner_responsibility_signals', 'deliverable_or_deadline_signals', 'non_signals'] as const) stringArray(decision[key], `decision_rules.${key}`);
  if (!isRecord(decision.uncertain_rule) || !isRecord(decision.meeting_rule) || !isRecord(decision.explanation_rule)) throw new Error('PROD-07 decision rules are incomplete.');
  const uncertain = decision.uncertain_rule;
  if (route(uncertain.route, 'uncertain_rule.route') !== 'owner_confirmation' || uncertain.candidate_created !== false || uncertain.source_retained !== true || uncertain.bulk_candidate_creation !== false) throw new Error('PROD-07 uncertain_rule must fail closed.');
  const meeting = decision.meeting_rule;
  if (route(meeting.placeholder_route, 'meeting_rule.placeholder_route') !== 'calendar_fact' || meeting.placeholder_is_action !== false || meeting.requires_all_candidate_signals !== true || meeting.source_retained !== true || stringArray(meeting.action_item_sources, 'meeting_rule.action_item_sources').length === 0) throw new Error('PROD-07 meeting_rule is invalid.');
  for (const routeName of ROUTES) {
    const explanation = decision.explanation_rule[routeName];
    if (!isRecord(explanation) || route(explanation.route, `explanation_rule.${routeName}.route`) !== routeName
      || !Array.isArray(explanation.required_fields) || !Array.isArray(explanation.forbidden_fields)
      || typeof explanation.source_reference_required !== 'boolean' || explanation.raw_content_allowed !== false || explanation.free_text_allowed !== false) throw new Error(`PROD-07 explanation_rule.${routeName} is invalid.`);
  }
  if (!isRecord(value.correction_rule) || value.correction_rule.current_event_scope !== 'current_event_only' || value.correction_rule.source_mutation !== 'forbidden' || value.correction_rule.global_filter !== false || value.correction_rule.global_source_deletion !== false) throw new Error('PROD-07 correction_rule is invalid.');
}

validateProd07Contract(contractSource);
export const PROD07_CONTRACT = contractSource as Prod07Contract;
const contract = PROD07_CONTRACT;
const rules = contract.decision_rules;
const eventRules = new Map(contract.event_matrix.map((item) => [item.event_type, item]));
const roleRules = new Map(contract.role_matrix.map((item) => [item.role, item]));
const ENGLISH_ACTION_SIGNALS = ['prepare', 'submit', 'review', 'confirm', 'deliver', 'reply', 'update', 'follow up'];
const ENGLISH_OWNER_SIGNALS = ['i am responsible', 'assigned to me', 'i will', 'i own', 'i need to'];
const ENGLISH_DELIVERY_SIGNALS = ['report', 'list', 'document', 'result', 'plan', 'by ', 'before ', 'due ', 'deadline'];
const NEGATIVE_SEMANTICS = [
  '不是我负责', '不由我', '无需我', '不需要我', '不要提交', '不要做', '无需准备', '仅提醒', '只是提醒', '仅供参考', '仅出席', '无需行动',
  'not my responsibility', 'not assigned to me', 'do not submit', "don't submit", 'i will not', "i won't", 'not going to', 'no need to', 'no action',
  'just a reminder', 'for reference only', 'attendance only',
];

function metadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' ? value : '';
}

function metadataBoolean(metadata: Record<string, unknown>, key: string) {
  return metadata[key] === true;
}

function sourceReference(externalId: string) {
  return `sha256:${createHash('sha256').update(externalId).digest('hex').slice(0, 16)}`;
}

function eventTitle(event: NormalizedSourceEvent) {
  const metadataTitle = metadataString(event.metadata ?? {}, 'calendarTitle');
  if (metadataTitle) return metadataTitle;
  return event.content.match(/^日程：([^\n]+)/u)?.[1] ?? '未命名日程';
}

function candidateTime(event: NormalizedSourceEvent): CandidateTimeRange {
  const metadata = event.metadata ?? {};
  const startAt = metadataString(metadata, 'startTime') || event.occurredAt;
  const endAt = metadataString(metadata, 'endTime') || null;
  return { status: startAt ? 'explicit' : 'unknown', sourceText: startAt || null, startAt: startAt || null, endAt, timezone: 'Asia/Shanghai', needsConfirmation: false, semantic: 'deadline' };
}

function explanationFields(event: NormalizedSourceEvent, owner?: string, action?: string, deliverableOrDeadline?: string, missingSignalCode?: string) {
  return {
    ...(owner ? { ownerResponsibility: owner } : {}),
    ...(action ? { action } : {}),
    ...(deliverableOrDeadline ? { deliverableOrDeadline } : {}),
    sourceReference: sourceReference(event.externalId),
    ...(missingSignalCode ? { missingSignalCode } : {}),
  };
}

const CLASSIFICATION_METADATA_KEYS = new Set([
  'schemaVersion', 'sourceScope', 'calendarId', 'eventId', 'status', 'cancelled', 'startTime', 'endTime', 'startTimezone', 'endTimezone',
  'organizer', 'attendees', 'meetingUrl', 'selfRsvpStatus', 'detailsAvailable', 'fullBodyAvailable', 'calendarTitle', 'isAllDay',
  'recurrenceOrSeriesKey', 'isRecurring', 'calendarKind', 'eventType', 'ownerRole', 'ownerResponse', 'hasMinutesOrExplicitMessageReference',
  'minutesReference', 'explicitMessageReference', 'meetingPlaceholder', 'sourceVersion',
  'calendarInputInvalid',
  'deleted', 'withdrawn', 'recalled', 'classificationBatch', 'classificationBatchSize', 'classificationBatchSourceIds', 'internalRequirementThreadId',
  'classificationRevision', 'failure_inbox', 'calendarClassification',
]);

function inputIsStrictlyValid(metadata: Record<string, unknown>) {
  if (metadata.schemaVersion !== 1) return false;
  if (Object.keys(metadata).some((key) => !CLASSIFICATION_METADATA_KEYS.has(key))) return false;
  for (const key of ['isAllDay', 'isRecurring', 'cancelled', 'detailsAvailable', 'fullBodyAvailable', 'hasMinutesOrExplicitMessageReference', 'meetingPlaceholder', 'calendarInputInvalid']) {
    if (key in metadata && typeof metadata[key] !== 'boolean') return false;
  }
  for (const key of ['deleted', 'withdrawn', 'recalled', 'classificationBatch']) {
    if (key in metadata && typeof metadata[key] !== 'boolean') return false;
  }
  if ('classificationBatchSize' in metadata && (typeof metadata.classificationBatchSize !== 'number' || !Number.isInteger(metadata.classificationBatchSize) || metadata.classificationBatchSize < 1 || metadata.classificationBatchSize > 500)) return false;
  if ('classificationBatchSourceIds' in metadata && (!Array.isArray(metadata.classificationBatchSourceIds) || metadata.classificationBatchSourceIds.length > 500 || metadata.classificationBatchSourceIds.some((item) => !boundedString(item, 200, SAFE_ID_PATTERN)))) return false;
  if (typeof metadata.schemaVersion !== 'number' || !Number.isInteger(metadata.schemaVersion)) return false;
  if ('sourceScope' in metadata && metadata.sourceScope !== 'owner_calendar' && metadata.sourceScope !== 'subscribed_calendar') return false;
  for (const key of ['calendarId', 'eventId', 'eventType', 'ownerRole', 'ownerResponse', 'calendarTitle', 'calendarKind', 'selfRsvpStatus', 'recurrenceOrSeriesKey', 'meetingUrl', 'minutesReference', 'explicitMessageReference', 'status']) {
    if (key in metadata && !nullableBoundedString(metadata[key], key === 'calendarTitle' ? 500 : 240)) return false;
  }
  if ('calendarId' in metadata && metadata.calendarId !== null && !boundedString(metadata.calendarId, 200, SAFE_ID_PATTERN)) return false;
  if ('eventId' in metadata && metadata.eventId !== null && !boundedString(metadata.eventId, 200, SAFE_ID_PATTERN)) return false;
  if ('eventType' in metadata && metadata.eventType !== null && !boundedString(metadata.eventType, 80)) return false;
  if ('ownerRole' in metadata && metadata.ownerRole !== null && !boundedString(metadata.ownerRole, 40)) return false;
  if ('ownerResponse' in metadata && metadata.ownerResponse !== null && !boundedString(metadata.ownerResponse, 40)) return false;
  if ('calendarKind' in metadata && metadata.calendarKind !== null && !boundedString(metadata.calendarKind, 40)) return false;
  if ('selfRsvpStatus' in metadata && metadata.selfRsvpStatus !== null && !boundedString(metadata.selfRsvpStatus, 40)) return false;
  if ('meetingUrl' in metadata && !nullableBoundedString(metadata.meetingUrl, 2_048)) return false;
  if ('startTime' in metadata && !nullableBoundedString(metadata.startTime, 40, SAFE_ISO_INSTANT_PATTERN)) return false;
  if ('endTime' in metadata && !nullableBoundedString(metadata.endTime, 40, SAFE_ISO_INSTANT_PATTERN)) return false;
  if ('startTimezone' in metadata && !nullableBoundedString(metadata.startTimezone, 64, SAFE_TIMEZONE_PATTERN)) return false;
  if ('endTimezone' in metadata && !nullableBoundedString(metadata.endTimezone, 64, SAFE_TIMEZONE_PATTERN)) return false;
  if ('organizer' in metadata && !strictOrganizer(metadata.organizer)) return false;
  if ('attendees' in metadata && !strictAttendees(metadata.attendees)) return false;
  if ('sourceVersion' in metadata && !boundedString(metadata.sourceVersion, 64, SAFE_SOURCE_VERSION_PATTERN)) return false;
  if ('internalRequirementThreadId' in metadata && !boundedString(metadata.internalRequirementThreadId, 200, SAFE_ID_PATTERN)) return false;
  if ('classificationRevision' in metadata && !boundedString(metadata.classificationRevision, 200)) return false;
  if ('failure_inbox' in metadata && !Array.isArray(metadata.failure_inbox)) return false;
  if ('calendarClassification' in metadata && !isRecord(metadata.calendarClassification)) return false;
  if ('minutesReference' in metadata && metadata.minutesReference !== null && !canonicalEvidenceReference(metadata.minutesReference, typeof metadata.eventId === 'string' ? metadata.eventId : '', 'minutes')) return false;
  if ('explicitMessageReference' in metadata && metadata.explicitMessageReference !== null && !canonicalEvidenceReference(metadata.explicitMessageReference, typeof metadata.eventId === 'string' ? metadata.eventId : '', 'message')) return false;
  const exactEvidence = hasCanonicalMeetingEvidence(metadata);
  if ('hasMinutesOrExplicitMessageReference' in metadata && typeof metadata.hasMinutesOrExplicitMessageReference === 'boolean' && metadata.hasMinutesOrExplicitMessageReference !== exactEvidence) return false;
  const eventType = metadataString(metadata, 'eventType');
  const role = metadataString(metadata, 'ownerRole');
  const ownerResponse = metadataString(metadata, 'ownerResponse');
  const calendarKind = metadataString(metadata, 'calendarKind');
  const status = metadataString(metadata, 'status');
  return Boolean(metadata.calendarInputInvalid !== true && eventRules.get(eventType) && roleRules.get(role)
    && (!ownerResponse || OWNER_RESPONSE_VALUES.has(ownerResponse))
    && (!calendarKind || CALENDAR_KIND_VALUES.has(calendarKind))
    && (!status || STATUS_VALUES.has(status)));
}

function normalizedText(event: NormalizedSourceEvent) {
  return `${event.content}\n${eventTitle(event)}`.normalize('NFKC').replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function hasPhrase(text: string, phrase: string) {
  const normalized = phrase.normalize('NFKC').trim();
  if (!normalized) return false;
  const index = text.toLocaleLowerCase().indexOf(normalized.toLocaleLowerCase());
  if (index < 0) return false;
  const before = text.slice(Math.max(0, index - 10), index);
  return !/(?:不|未|无|无需|不要|别|不是|仅|只是|仅供|no|not|don't|dont|do not|without|only)\s*$/iu.test(before);
}

function firstControlledSignal(text: string, configured: string[], english: string[]) {
  return [...configured, ...english].find((signal) => hasPhrase(text, signal));
}

function hasNegativeSemantics(text: string) {
  return NEGATIVE_SEMANTICS.some((signal) => text.toLocaleLowerCase().includes(signal.toLocaleLowerCase()));
}

const OWNER_RESPONSE_VALUES = new Set(['accept', 'accepted', 'decline', 'declined', 'tentative', 'needs_action', 'no_response', 'unknown']);
const CALENDAR_KIND_VALUES = new Set(['owner_calendar', 'subscribed_calendar']);
const STATUS_VALUES = new Set(['confirmed', 'tentative', 'cancelled']);

function eventExplanationCode(eventType: string) {
  return contract.examples.find((item) => item.event_type === eventType)?.explanation_code
    ?? (eventType === 'birthday' || eventType === 'subscribed_calendar' ? 'calendar_subscription' : 'calendar_reminder');
}

function defaultFact(event: NormalizedSourceEvent, eventType: string, invalid = false): CalendarClassification {
  const eventRule = eventRules.get(eventType);
  return {
    route: 'calendar_fact',
    sourceRetained: true,
    candidateCreated: false,
    requiresOwnerConfirmation: false,
    explanationCode: invalid ? 'calendar_input_invalid' : eventExplanationCode(eventType),
    evidenceFields: explanationFields(event),
    correctionScope: contract.correction_rule.current_event_scope,
  };
}

function ownerConfirmation(event: NormalizedSourceEvent, owner: string | undefined, action: string | undefined, deliverable: string | undefined, code: string, missingSignalCode = code) {
  return {
    route: 'owner_confirmation' as const,
    sourceRetained: true as const,
    candidateCreated: false,
    requiresOwnerConfirmation: true,
    explanationCode: code,
    evidenceFields: explanationFields(event, owner, action, deliverable, missingSignalCode),
    correctionScope: contract.correction_rule.current_event_scope,
  };
}

export function classifyCalendarSource(event: NormalizedSourceEvent): CalendarClassification {
  const metadata = event.metadata ?? {};
  const rawEventType = metadataString(metadata, 'eventType');
  const eventType = metadataBoolean(metadata, 'isAllDay') ? 'all_day' : metadataBoolean(metadata, 'isRecurring') ? 'recurring' : rawEventType;
  if (!inputIsStrictlyValid(metadata)) return defaultFact(event, rawEventType, true);
  const role = metadataString(metadata, 'ownerRole');
  const eventRule = eventRules.get(eventType)!;
  const roleRule = roleRules.get(role)!;
  const text = normalizedText(event);
  const owner = firstControlledSignal(text, rules.owner_responsibility_signals, ENGLISH_OWNER_SIGNALS);
  const action = firstControlledSignal(text, rules.explicit_action_verbs, ENGLISH_ACTION_SIGNALS);
  const deliverableOrDeadline = firstControlledSignal(text, rules.deliverable_or_deadline_signals, ENGLISH_DELIVERY_SIGNALS);
  const negative = hasNegativeSemantics(text) || rules.non_signals.some((signal) => hasPhrase(text, signal));
  const explicitContradiction = negative && Boolean(owner || action || deliverableOrDeadline);
  const meetingPlaceholder = eventType === 'meeting_placeholder' || metadataBoolean(metadata, 'meetingPlaceholder');
  const meetingEvidenceRequired = meetingPlaceholder || eventType === 'minutes_action_item';
  const evidence = hasCanonicalMeetingEvidence(metadata);
  const complete = Boolean(owner && action && deliverableOrDeadline);
  const meetingEvidenceAllowed = rules.meeting_rule.action_item_sources.some((source) => source === 'minutes' || source === 'explicit_message') && evidence;

  if (metadataBoolean(metadata, 'isAllDay') || metadataBoolean(metadata, 'isRecurring')) return defaultFact(event, eventType);
  if (negative && !explicitContradiction) return defaultFact(event, eventType);
  if (explicitContradiction) return ownerConfirmation(event, owner, action, deliverableOrDeadline, 'confirmation_negative_or_contradictory_signal');
  if (meetingEvidenceRequired && !meetingEvidenceAllowed) {
    if (eventType === 'minutes_action_item') return defaultFact(event, eventType);
    if (!complete) {
      if (!owner && !action && !deliverableOrDeadline) return defaultFact(event, eventType);
      return ownerConfirmation(event, owner, action, deliverableOrDeadline, 'confirmation_meeting_without_source', 'missing_minutes_or_explicit_message');
    }
    return ownerConfirmation(event, owner, action, deliverableOrDeadline, 'confirmation_meeting_without_source', 'missing_minutes_or_explicit_message');
  }
  if (roleRule.default_route === 'calendar_fact' && eventRule.default_route === 'calendar_fact' && !complete) return defaultFact(event, eventType);
  const eventAllowsCandidate = eventRule.default_route === 'candidate_review' || meetingEvidenceAllowed;
  const roleAllowsCandidate = role !== 'no_response' && roleRule.default_route !== 'owner_confirmation';
  if (complete && eventAllowsCandidate && roleAllowsCandidate && rules.meeting_rule.requires_all_candidate_signals) {
    return {
      route: 'candidate_review',
      sourceRetained: true,
      candidateCreated: true,
      requiresOwnerConfirmation: true,
      explanationCode: meetingEvidenceAllowed
        ? contract.examples.find((item) => item.id === 'positive-minutes-01')?.explanation_code ?? eventExplanationCode(eventType)
        : eventExplanationCode(eventType),
      evidenceFields: explanationFields(event, owner, action, deliverableOrDeadline),
      correctionScope: contract.correction_rule.current_event_scope,
    };
  }
  if (!complete && (owner || action || deliverableOrDeadline)) {
    const missing = owner ? 'missing_deliverable_or_deadline' : deliverableOrDeadline ? 'missing_owner_responsibility' : 'missing_owner_or_delivery';
    const explanationCode = role === 'no_response'
      ? contract.examples.find((item) => item.id === 'boundary-no-response-01')?.explanation_code ?? eventExplanationCode(eventType)
      : eventExplanationCode(eventType);
    return ownerConfirmation(event, owner, action, deliverableOrDeadline, explanationCode, missing);
  }
  return eventRule.default_route === 'owner_confirmation'
    ? ownerConfirmation(event, owner, action, deliverableOrDeadline, 'confirmation_missing_owner_or_delivery')
    : defaultFact(event, eventType);
}

export function calendarClassificationDraft(event: NormalizedSourceEvent, classification: CalendarClassification): CandidateDraft | null {
  if (classification.route !== 'candidate_review') return null;
  const title = eventTitle(event);
  const analysis = {
    timeRange: candidateTime(event),
    fieldBasis: { background: 'fact' as CandidateEvidenceBasis, validationQuestion: 'inferred' as CandidateEvidenceBasis, describe: 'fact' as CandidateEvidenceBasis },
    recognitionEvidence: [classification.explanationCode],
    ownerAction: { required: true, summary: '等待系统主人确认是否纳入私人候选。', role: 'follow_up' as const, basis: 'fact' as CandidateEvidenceBasis, confidence: 1 },
    calendarClassification: classification,
  };
  return {
    title,
    proposerName: event.senderName,
    background: '日历事件已明确系统主人责任、动作和交付物或截止点。',
    validationQuestion: '是否将这项日历交付加入候选收件箱？',
    describe: '来源日历已明确责任、动作和交付/截止，等待系统主人确认。',
    confidence: 1,
    analysis,
  };
}
