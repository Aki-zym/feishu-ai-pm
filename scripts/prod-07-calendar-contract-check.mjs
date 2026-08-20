import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultSource = resolve(root, 'docs/product-rules/PROD-07-calendar-classification.json');
const defaultView = resolve(root, 'docs/product-rules/PROD-07-calendar-classification.md');
const routes = new Set(['calendar_fact', 'candidate_review', 'owner_confirmation']);
const roles = new Set(['organizer', 'required_attendee', 'optional_attendee', 'no_response']);
const requiredEventTypes = ['ordinary_reminder', 'attendance_only', 'meeting_placeholder', 'all_day', 'recurring', 'holiday', 'birthday', 'subscribed_calendar', 'explicit_owner_delivery', 'minutes_action_item', 'ambiguous_action'];
const requiredEventTypeSet = new Set(requiredEventTypes);
const expectedEventRoutes = new Map([
  ['ordinary_reminder', 'calendar_fact'], ['attendance_only', 'calendar_fact'], ['meeting_placeholder', 'calendar_fact'],
  ['all_day', 'calendar_fact'], ['recurring', 'calendar_fact'], ['holiday', 'calendar_fact'], ['birthday', 'calendar_fact'],
  ['subscribed_calendar', 'calendar_fact'], ['explicit_owner_delivery', 'candidate_review'], ['minutes_action_item', 'candidate_review'],
  ['ambiguous_action', 'owner_confirmation'],
]);
const requiredSignals = ['explicit_owner_responsibility', 'action', 'deliverable_or_deadline'];
const exactProductSignals = {
  explicit_action_verbs: ['准备', '提交', '评审', '确认', '交付', '整理', '回复', '更新', '跟进'],
  owner_responsibility_signals: ['我负责', '由我', '请我', '主人需要', '我来提交', '我来确认'],
  deliverable_or_deadline_signals: ['报告', '名单', '文档', '结果', '方案', '截止', '到期', '之前完成', '周一前', '明天前'],
  non_signals: ['仅供参考', '提醒一下', '欢迎参加', '可选参加', '生日快乐', '节假日', '订阅日历', '例会'],
};
const exactUncertainRule = {
  route: 'owner_confirmation',
  candidate_created: false,
  source_retained: true,
  bulk_candidate_creation: false,
  missing_signal_policy: 'owner_confirmation',
  scope: 'single_event',
  required_fields: ['missing_signal_code', 'source_reference'],
  forbidden_fields: ['raw_source_content', 'global_calendar_filter', 'source_deletion'],
};
const exactMeetingRule = {
  placeholder_route: 'calendar_fact',
  placeholder_is_action: false,
  action_item_sources: ['minutes', 'explicit_message'],
  requires_all_candidate_signals: true,
  source_retained: true,
  scope: 'event_then_explicit_related_source',
};
const exactExplanationRule = {
  calendar_fact: {
    route: 'calendar_fact',
    required_fields: [],
    forbidden_fields: ['raw_source_content', 'provider_payload', 'attendee_directory'],
    source_reference_required: false,
    raw_content_allowed: false,
    free_text_allowed: false,
    scope: 'none',
  },
  candidate_review: {
    route: 'candidate_review',
    required_fields: ['owner_responsibility', 'action', 'deliverable_or_deadline', 'source_reference'],
    forbidden_fields: ['raw_source_content', 'provider_payload', 'attendee_directory'],
    source_reference_required: true,
    raw_content_allowed: false,
    free_text_allowed: false,
    scope: 'redacted_explanation',
  },
  owner_confirmation: {
    route: 'owner_confirmation',
    required_fields: ['missing_signal_code', 'source_reference'],
    forbidden_fields: ['raw_source_content', 'provider_payload', 'attendee_directory'],
    source_reference_required: true,
    raw_content_allowed: false,
    free_text_allowed: false,
    scope: 'redacted_explanation',
  },
};
const exactCorrectionRule = {
  entry_label: '这只是提醒',
  current_event_scope: 'current_event_only',
  series_scope: 'explicit_owner_selection_only',
  learning_boundary: 'same_event_family_only',
  reclassification_boundary: 'derived_state_only',
  source_mutation: 'forbidden',
  audit_event: 'private_correction_event_required',
  global_filter: false,
  global_source_deletion: false,
  requires_new_revision: true,
  idempotency: 'operation_id_required',
};
const sourcePolicyKeys = [
  'calendar_fact_is_authoritative',
  'filtered_event_is_retained',
  'raw_content_not_uploaded',
  'meeting_placeholder_is_not_action',
  'minutes_or_explicit_message_preferred_for_action_item',
];
const routeContracts = {
  calendar_fact: { candidate_created: false, owner_confirmation_required: false, source_retained: true, explanation_required: false },
  candidate_review: { candidate_created: true, owner_confirmation_required: true, source_retained: true, explanation_required: true },
  owner_confirmation: { candidate_created: false, owner_confirmation_required: true, source_retained: true, explanation_required: true },
};
const requiredRoleNames = [...roles];
const requiredBatchContracts = {
  'ordinary-reminders-50': { input_count: 50, expected_route: 'calendar_fact', expected_candidate_count: 0, expected_owner_confirmation_count: 0, expected_source_retained_count: 50, max_candidate_noise_rate: 0 },
  'explicit-delivery-10': { input_count: 10, expected_route: 'candidate_review', expected_candidate_count: 10, expected_owner_confirmation_count: 0, expected_source_retained_count: 10, max_candidate_noise_rate: 0 },
  'uncertain-responsibility-10': { input_count: 10, expected_route: 'owner_confirmation', expected_candidate_count: 0, expected_owner_confirmation_count: 10, expected_source_retained_count: 10, max_candidate_noise_rate: 0 },
  'repeat-series-12': { input_count: 12, expected_route: 'calendar_fact', expected_candidate_count: 0, expected_owner_confirmation_count: 0, expected_source_retained_count: 12, max_candidate_noise_rate: 0 },
};
const requiredForbiddenFields = [
  'full_attendee_directory', 'raw_user_ids', 'full_meeting_transcript',
  'raw_calendar_payload', 'provider_or_model_prompt', 'source_deletion_as_filtering',
];
const topLevelKeys = [
  'schema_version', 'id', 'title', 'status', 'owner', 'last_reviewed', 'target', 'scope',
  'evidence_ceiling', 'source_policy', 'routes', 'role_matrix', 'event_matrix', 'decision_rules',
  'correction_rule', 'examples', 'acceptance', 'implementation_contract',
];
const exactTopLevelText = {
  title: '日历事实与任务候选分类规则',
  target: 'M1 / 首个受控单用户试点 / calendar source classification',
  scope: '本文件只定义产品规则、合成验收夹具和后续实现输入输出；本 Issue 不修改生产分类行为。',
};
const exactRouteMeanings = {
  calendar_fact: '时间事实或提醒，保留在 Calendar 来源和日历展示中',
  candidate_review: '明确责任、动作和交付物/截止点，生成一个待主人确认的候选',
  owner_confirmation: '有行动迹象但责任或交付边界不完整，只提示主人确认，不批量制造候选',
};
const exactRoleConditions = {
  organizer: '仅当正文明确主人负责动作且同时有交付物或截止点',
  required_attendee: '仅出席不构成候选；需要主人责任、动作和交付信号',
  optional_attendee: '仅在正文明确主人交付责任时进入后续规则',
  no_response: '不得因未响应推断主人需要执行；责任不明时只走确认提示',
};
const exactEventReasons = {
  ordinary_reminder: '普通提醒只是时间事实',
  attendance_only: '仅出席不等于主人有交付责任',
  meeting_placeholder: '会议占位不能单独推断 action item',
  all_day: '全天属性不增加任务责任',
  recurring: '重复属性不增加任务责任，后续实现需按系列去重',
  holiday: '节假日是订阅或时间事实',
  birthday: '生日提醒默认不是交付任务',
  subscribed_calendar: '订阅日历默认只提供事实',
  explicit_owner_delivery: '明确主人责任、动作和交付物或截止点',
  minutes_action_item: '纪要或明确消息提供了可追溯 action item',
  ambiguous_action: '有行动词但责任或交付边界不完整',
};
const exactVisibleAcceptance = [
  'Calendar 中仍能看到被判为事实/提醒的事件，候选页不出现同一事件。',
  '候选卡解释主人责任、动作、交付物/截止点和来源依据；责任不明显示待确认原因。',
  '后续实现验收目标：桌面与窄屏使用相同 route 和解释，不把 Calendar 事实写成任务；本 Issue 尚未实现或验证 UI 分类行为。',
  '“这只是提醒”只影响主人选择的事件或系列，来源、审计和其他事件不被删除。',
];
const exactCalendarDtoFields = [
  'event_key_for_dedupe', 'start_at', 'end_at', 'timezone', 'is_all_day',
  'recurrence_or_series_key', 'calendar_kind', 'title_or_bounded_description',
  'owner_role', 'owner_response', 'has_minutes_or_explicit_message_reference',
];
const exactNormalizedOutputFields = [
  'route', 'source_retained', 'candidate_created', 'requires_owner_confirmation',
  'explanation_code', 'evidence_fields', 'correction_scope',
];
const exactExampleContracts = {
  'negative-reminder-01': { kind: 'negative', role: 'organizer', event_type: 'ordinary_reminder', signals: [], expected_route: 'calendar_fact', candidate_created: false, source_retained: true, explanation_code: 'calendar_reminder', explanation: '仅提醒，不包含主人动作或交付物。' },
  'negative-attendance-01': { kind: 'negative', role: 'required_attendee', event_type: 'attendance_only', signals: [], expected_route: 'calendar_fact', candidate_created: false, source_retained: true, explanation_code: 'calendar_attendance_only', explanation: '仅出席，不推断任务。' },
  'negative-all-day-01': { kind: 'negative', role: 'no_response', event_type: 'all_day', signals: [], expected_route: 'calendar_fact', candidate_created: false, source_retained: true, explanation_code: 'calendar_all_day', explanation: '全天和节假日属性不是交付责任。' },
  'negative-recurring-01': { kind: 'negative', role: 'optional_attendee', event_type: 'recurring', signals: [], expected_route: 'calendar_fact', candidate_created: false, source_retained: true, explanation_code: 'calendar_recurring', explanation: '重复属性和查看提示不足以证明交付。' },
  'negative-subscription-01': { kind: 'negative', role: 'no_response', event_type: 'subscribed_calendar', signals: [], expected_route: 'calendar_fact', candidate_created: false, source_retained: true, explanation_code: 'calendar_subscription', explanation: '订阅日历和生日默认只保留事实。' },
  'negative-meeting-01': { kind: 'negative', role: 'required_attendee', event_type: 'meeting_placeholder', signals: [], expected_route: 'calendar_fact', candidate_created: false, source_retained: true, explanation_code: 'calendar_meeting_placeholder', explanation: '会议占位不能单独推断 action item。' },
  'positive-delivery-01': { kind: 'positive', role: 'organizer', event_type: 'explicit_owner_delivery', signals: ['explicit_owner_responsibility', 'action', 'deliverable_or_deadline'], expected_route: 'candidate_review', candidate_created: true, source_retained: true, explanation_code: 'candidate_explicit_delivery', explanation: '主人责任：我负责；动作：提交；交付物/截止点：复盘报告、周五前。' },
  'positive-prepare-01': { kind: 'positive', role: 'required_attendee', event_type: 'explicit_owner_delivery', signals: ['explicit_owner_responsibility', 'action', 'deliverable_or_deadline'], expected_route: 'candidate_review', candidate_created: true, source_retained: true, explanation_code: 'candidate_prepare', explanation: '明确主人动作和交付截止点，进入待确认候选。' },
  'positive-minutes-01': { kind: 'positive', role: 'required_attendee', event_type: 'minutes_action_item', signals: ['explicit_owner_responsibility', 'action', 'deliverable_or_deadline'], expected_route: 'candidate_review', candidate_created: true, source_retained: true, explanation_code: 'candidate_minutes_action_item', explanation: 'action item 来自纪要并带有主人责任和截止点。' },
  'positive-message-01': { kind: 'positive', role: 'optional_attendee', event_type: 'explicit_owner_delivery', signals: ['explicit_owner_responsibility', 'action', 'deliverable_or_deadline'], expected_route: 'candidate_review', candidate_created: true, source_retained: true, explanation_code: 'candidate_explicit_message', explanation: '即使是可选参与者，正文已明确主人动作和交付截止点。' },
  'boundary-ambiguous-01': { kind: 'boundary', role: 'organizer', event_type: 'ambiguous_action', signals: ['action'], expected_route: 'owner_confirmation', candidate_created: false, source_retained: true, explanation_code: 'confirmation_missing_owner_or_delivery', explanation: '有动作词但没有闭合主人责任和交付物/截止点，只提示确认。' },
  'boundary-no-response-01': { kind: 'boundary', role: 'no_response', event_type: 'explicit_owner_delivery', signals: ['action', 'deliverable_or_deadline'], expected_route: 'owner_confirmation', candidate_created: false, source_retained: true, explanation_code: 'confirmation_missing_owner', explanation: '有交付但责任不明，不直接制造候选。' },
  'boundary-meeting-without-minutes-01': { kind: 'boundary', role: 'organizer', event_type: 'meeting_placeholder', signals: ['action'], expected_route: 'owner_confirmation', candidate_created: false, source_retained: true, explanation_code: 'confirmation_meeting_without_source', explanation: '会议占位和孤立动作词不足以形成候选。' },
};
const unsafe = /(?:[A-Za-z]:[\\/]|^\\\\|^\/|sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]|Bearer\s+|BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY)/i;
const datePattern = /^2026-\d{2}-\d{2}$/;

function safeText(value) { return typeof value === 'string' && value.trim().length > 0 && !unsafe.test(value); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function allStrings(values, min = 1) { return Array.isArray(values) && values.length >= min && values.every(safeText); }
function hasDuplicates(values) { return new Set(values).size !== values.length; }
function exactKeys(value, expected) {
  return object(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function exactArray(values, expected) { return Array.isArray(values) && values.length === expected.length && values.every((value, index) => value === expected[index]); }
function exactSet(values, expected) { return Array.isArray(values) && values.length === expected.length && !hasDuplicates(values) && expected.every((value) => values.includes(value)); }
function exactCanonicalObject(value, expected) {
  if (!exactKeys(value, Object.keys(expected))) return false;
  return Object.entries(expected).every(([key, expectedValue]) => {
    if (Array.isArray(expectedValue)) return exactArray(value[key], expectedValue);
    if (object(expectedValue)) return exactCanonicalObject(value[key], expectedValue);
    return value[key] === expectedValue;
  });
}
function validSignals(signals) { return Array.isArray(signals) && !hasDuplicates(signals) && signals.every((signal) => requiredSignals.includes(signal)); }
function signalsCoverAll(signals) { return validSignals(signals) && exactSet(signals, requiredSignals); }

export function validateContract(contract) {
  const errors = [];
  if (!object(contract)) return ['PROD-07 contract 必须是对象'];
  if (!exactKeys(contract, topLevelKeys)) errors.push('合同顶层字段必须精确，未知 policy/扩展字段必须 fail-closed');
  if (contract.schema_version !== 1) errors.push('schema_version 必须为 1');
  if (contract.id !== 'PROD-07') errors.push('id 必须为 PROD-07');
  if (contract.status !== 'contract_only') errors.push('status 必须为 contract_only，不能声称生产行为已改变');
  if (contract.owner !== 'product_owner') errors.push('owner 必须为 product_owner');
  if (!datePattern.test(contract.last_reviewed ?? '')) errors.push('last_reviewed 必须是 YYYY-MM-DD');
  for (const [key, expected] of Object.entries(exactTopLevelText)) if (contract[key] !== expected) errors.push(`${key} 必须匹配固定产品合同文本`);
  if (!exactArray(contract.evidence_ceiling, ['L0'])) errors.push('evidence_ceiling 必须精确为 [L0]；整仓回归不能升级 PROD-07 证据');
  if (!exactKeys(contract.source_policy, sourcePolicyKeys) || sourcePolicyKeys.some((key) => contract.source_policy[key] !== true)) errors.push('source_policy 必须精确包含五个 true 边界键，不能缺失或增加键');
  if (!exactKeys(contract.routes, [...routes])) errors.push('routes 必须精确包含三个受控 route，不能增加 route');
  for (const route of routes) {
    const item = contract.routes?.[route];
    if (!item) continue;
    if (item.meaning !== exactRouteMeanings[route]) errors.push(`routes.${route}.meaning 必须匹配固定规范模板`);
    const expected = routeContracts[route];
    for (const key of Object.keys(expected)) if (item[key] !== expected[key]) errors.push(`routes.${route}.${key} 不符合固定语义`);
    const routeKeys = ['meaning', ...Object.keys(expected)];
    if (!exactKeys(item, routeKeys)) errors.push(`routes.${route} 只能包含 meaning 和固定布尔键`);
  }
  if (!Array.isArray(contract.role_matrix) || contract.role_matrix.length !== 4) errors.push('role_matrix 必须恰好 4 个角色');
  const roleSeen = new Set();
  for (const item of contract.role_matrix ?? []) {
    if (!object(item) || !roles.has(item?.role) || roleSeen.has(item?.role)) errors.push('role_matrix 角色必须唯一且受控');
    roleSeen.add(item?.role);
    if (!routes.has(item?.default_route) || item?.default_route !== 'calendar_fact' || item?.does_not_imply_task !== true || item?.candidate_condition !== exactRoleConditions[item?.role]) errors.push(`role_matrix.${item?.role ?? 'unknown'} 缺少固定默认规则模板`);
    if (object(item) && !exactKeys(item, ['role', 'default_route', 'candidate_condition', 'does_not_imply_task'])) errors.push(`role_matrix.${item.role ?? 'unknown'} 字段结构非法`);
  }
  if (!exactSet([...roleSeen], requiredRoleNames)) errors.push('role_matrix 必须精确覆盖四个角色');
  if (!Array.isArray(contract.event_matrix) || contract.event_matrix.length !== requiredEventTypes.length) errors.push('event_matrix 必须精确覆盖 11 个受控事件类型');
  const eventSeen = new Set();
  for (const item of contract.event_matrix ?? []) {
    if (!object(item) || eventSeen.has(item.event_type) || !safeText(item.event_type) || !requiredEventTypeSet.has(item.event_type) || !routes.has(item.default_route) || item.reason !== exactEventReasons[item.event_type]) errors.push('event_matrix 含重复、未知或非法事件规则');
    if (object(item) && !exactKeys(item, ['event_type', 'default_route', 'reason'])) errors.push(`event_matrix.${item.event_type ?? 'unknown'} 字段结构非法`);
    if (expectedEventRoutes.has(item?.event_type) && item.default_route !== expectedEventRoutes.get(item.event_type)) errors.push(`event_matrix.${item.event_type} 默认路径不符合 PROD-07`);
    eventSeen.add(item?.event_type);
  }
  for (const eventType of requiredEventTypes) if (!eventSeen.has(eventType)) errors.push(`event_matrix 缺少 ${eventType}`);
  const rules = contract.decision_rules;
  const decisionRuleKeys = ['candidate_requires_all', ...Object.keys(exactProductSignals), 'uncertain_rule', 'meeting_rule', 'explanation_rule'];
  if (!object(rules) || !exactKeys(rules, decisionRuleKeys)) errors.push('decision_rules 字段结构必须精确，不能增加或缺失产品规则键');
  if (JSON.stringify(rules?.candidate_requires_all) !== JSON.stringify(requiredSignals)) errors.push('candidate_requires_all 必须精确包含责任、动作、交付物/截止点');
  for (const [key, expected] of Object.entries(exactProductSignals)) {
    if (!exactArray(rules?.[key], expected)) errors.push(`decision_rules.${key} 必须精确匹配已批准产品信号集合`);
  }
  if (!exactCanonicalObject(rules?.uncertain_rule, exactUncertainRule)) errors.push('decision_rules.uncertain_rule 必须匹配固定责任不明合同');
  if (!exactCanonicalObject(rules?.meeting_rule, exactMeetingRule)) errors.push('decision_rules.meeting_rule 必须匹配固定会议来源合同');
  if (!exactKeys(rules?.explanation_rule, Object.keys(exactExplanationRule)) || Object.entries(exactExplanationRule).some(([route, expected]) => !exactCanonicalObject(rules?.explanation_rule?.[route], expected))) errors.push('decision_rules.explanation_rule 必须匹配固定解释字段、禁用字段和 route 作用域');
  const signalValues = Object.values(exactProductSignals).flat();
  const configuredSignalValues = Object.keys(exactProductSignals).flatMap((key) => Array.isArray(rules?.[key]) ? rules[key] : []);
  if (signalValues.some((value, index) => signalValues.indexOf(value) !== index) || configuredSignalValues.some((value, index) => configuredSignalValues.indexOf(value) !== index)) errors.push('产品信号集合不能交叉污染或重复');
  if ((rules?.non_signals ?? []).some((signal) => (rules?.explicit_action_verbs ?? []).includes(signal) || (rules?.deliverable_or_deadline_signals ?? []).includes(signal) || (rules?.owner_responsibility_signals ?? []).includes(signal))) errors.push('non_signals 不能包含动作、责任或交付信号');
  const correction = contract.correction_rule;
  if (!exactCanonicalObject(correction, exactCorrectionRule)) errors.push('correction_rule 必须匹配固定纠错作用域、审计、版本和禁止全局过滤合同');
  if (!Array.isArray(contract.examples) || contract.examples.length < 12) errors.push('examples 至少需要 12 个合成正/负/边界例');
  const exampleIds = new Set(); const kinds = new Set();
  for (const item of contract.examples ?? []) {
    if (!object(item) || !safeText(item?.id) || exampleIds.has(item?.id) || !['negative', 'positive', 'boundary'].includes(item?.kind)) errors.push('examples 含重复 ID 或非法 kind');
    if (object(item) && !exactKeys(item, ['id', 'kind', 'role', 'event_type', 'title', 'description', 'signals', 'expected_route', 'candidate_created', 'source_retained', 'explanation_code', 'explanation'])) errors.push(`example ${item.id ?? 'unknown'} 字段结构非法`);
    exampleIds.add(item?.id); kinds.add(item?.kind);
    const expectedExample = exactExampleContracts[item?.id];
    if (!roles.has(item?.role) || !requiredEventTypeSet.has(item?.event_type) || !safeText(item?.title) || !safeText(item?.description) || !validSignals(item?.signals) || !routes.has(item?.expected_route) || typeof item?.candidate_created !== 'boolean' || item?.source_retained !== true || !safeText(item?.explanation_code) || !safeText(item?.explanation) || !expectedExample) errors.push(`example ${item?.id ?? 'unknown'} 字段不完整`);
    if (expectedExample && ['kind', 'role', 'event_type', 'expected_route', 'candidate_created', 'source_retained', 'explanation_code', 'explanation'].some((key) => item?.[key] !== expectedExample[key])) errors.push(`example ${item?.id ?? 'unknown'} 的规范输出必须匹配 code-owned 模板`);
    if (expectedExample && !exactArray(item?.signals, expectedExample.signals)) errors.push(`example ${item?.id ?? 'unknown'} 的 signals 必须匹配 code-owned 模板`);
    if (item?.candidate_created !== (item?.expected_route === 'candidate_review')) errors.push(`example ${item?.id ?? 'unknown'} route/candidate_created 不一致`);
    if (item?.expected_route === 'candidate_review' && !signalsCoverAll(item?.signals)) errors.push(`example ${item?.id ?? 'unknown'} candidate_review 必须精确覆盖三个硬条件`);
    if (item?.expected_route !== 'candidate_review' && signalsCoverAll(item?.signals)) errors.push(`example ${item?.id ?? 'unknown'} 缺少边界时不得使用完整三个硬条件`);
    const matrixRoute = expectedEventRoutes.get(item?.event_type);
    const boundaryException = item?.kind === 'boundary' && item?.expected_route === 'owner_confirmation' && (
      (item?.event_type === 'meeting_placeholder' && item?.signals?.includes('action')) ||
      (item?.event_type === 'explicit_owner_delivery' && item?.role === 'no_response' && !item?.signals?.includes('explicit_owner_responsibility'))
    );
    if (matrixRoute && item?.expected_route !== matrixRoute && !boundaryException) errors.push(`example ${item?.id ?? 'unknown'} route 与 event_matrix 不一致`);
    if (item?.kind === 'positive' && item?.expected_route !== 'candidate_review') errors.push(`example ${item?.id ?? 'unknown'} positive 必须进入 candidate_review`);
    if (item?.kind === 'negative' && item?.expected_route !== 'calendar_fact') errors.push(`example ${item?.id ?? 'unknown'} negative 必须进入 calendar_fact`);
    if (item?.kind === 'boundary' && item?.expected_route !== 'owner_confirmation') errors.push(`example ${item?.id ?? 'unknown'} boundary 必须进入 owner_confirmation`);
  }
  for (const kind of ['negative', 'positive', 'boundary']) if (!kinds.has(kind)) errors.push(`examples 缺少 ${kind}`);
  const acceptance = contract.acceptance;
  if (!exactKeys(acceptance, ['fixture_batches', 'metrics', 'visible_acceptance']) || !Array.isArray(acceptance?.fixture_batches) || acceptance.fixture_batches.length !== 4) errors.push('acceptance 必须精确包含四组固定夹具、指标和可见验收');
  const batchIds = new Set();
  for (const batch of acceptance?.fixture_batches ?? []) {
    const expected = requiredBatchContracts[batch?.id];
    if (object(batch) && !exactKeys(batch, ['id', 'input_count', 'expected_route', 'expected_candidate_count', 'expected_owner_confirmation_count', 'expected_source_retained_count', 'max_candidate_noise_rate'])) errors.push(`fixture batch ${batch.id ?? 'unknown'} 字段结构非法`);
    if (!object(batch) || !safeText(batch?.id) || batchIds.has(batch?.id) || !expected || !routes.has(batch?.expected_route) || !Number.isInteger(batch?.input_count) || batch?.input_count <= 0 || !Number.isInteger(batch?.expected_candidate_count) || batch?.expected_candidate_count < 0 || !Number.isInteger(batch?.expected_owner_confirmation_count) || batch?.expected_owner_confirmation_count < 0 || !Number.isInteger(batch?.expected_source_retained_count) || batch?.expected_source_retained_count !== batch?.input_count || typeof batch?.max_candidate_noise_rate !== 'number' || !Number.isFinite(batch?.max_candidate_noise_rate) || batch?.max_candidate_noise_rate < 0 || batch?.expected_candidate_count + batch?.expected_owner_confirmation_count > batch?.input_count) errors.push(`fixture batch ${batch?.id ?? 'unknown'} 非法`);
    if (expected && ['input_count', 'expected_route', 'expected_candidate_count', 'expected_owner_confirmation_count', 'expected_source_retained_count', 'max_candidate_noise_rate'].some((key) => batch?.[key] !== expected[key])) errors.push(`fixture batch ${batch?.id ?? 'unknown'} 的 route/计数/噪声率不符合固定合同`);
    batchIds.add(batch?.id);
  }
  if (!exactSet([...batchIds], Object.keys(requiredBatchContracts))) errors.push('fixture_batches 必须精确覆盖四个固定合成批次');
  const metrics = acceptance?.metrics;
  const metricKeys = ['fact_retention_rate_min', 'facts_only_candidate_noise_rate_max', 'explicit_delivery_candidate_recall_min', 'uncertain_bulk_candidate_count_max', 'candidate_explanation_coverage_min', 'duplicate_series_candidate_multiplier_max', 'desktop_mobile_rule_parity_required'];
  if (!exactKeys(metrics, metricKeys) || metrics.fact_retention_rate_min !== 1 || metrics.facts_only_candidate_noise_rate_max !== 0 || metrics.explicit_delivery_candidate_recall_min !== 1 || metrics.uncertain_bulk_candidate_count_max !== 0 || metrics.candidate_explanation_coverage_min !== 1 || metrics.duplicate_series_candidate_multiplier_max !== 1 || metrics.desktop_mobile_rule_parity_required !== true) errors.push('acceptance.metrics 必须固定无候选泛滥、完整留存、解释覆盖和桌面/窄屏一致性');
  if (!exactArray(acceptance?.visible_acceptance, exactVisibleAcceptance)) errors.push('acceptance.visible_acceptance 必须匹配固定验收模板');
  const implementation = contract.implementation_contract;
  if (!object(implementation) || implementation.production_behavior_status !== 'not_changed_by_issue_85') errors.push('implementation_contract 必须明确本 Issue 不改生产行为');
  if (object(implementation) && !exactKeys(implementation, ['minimum_calendar_dto_fields', 'normalized_output_fields', 'must_not_request_or_expose', 'production_behavior_status'])) errors.push('implementation_contract 字段结构不能增加未知项');
  for (const [name, required] of [['minimum_calendar_dto_fields', exactCalendarDtoFields], ['normalized_output_fields', exactNormalizedOutputFields]]) {
    const values = implementation?.[name];
    if (!exactArray(values, required)) errors.push(`implementation_contract.${name} 必须精确匹配 code-owned 字段集合`);
  }
  const forbidden = implementation?.must_not_request_or_expose;
  if (!exactSet(forbidden, requiredForbiddenFields)) errors.push('implementation_contract.must_not_request_or_expose 必须精确锁定禁止请求/暴露字段');
  return errors;
}

function cell(value) { return String(value).replaceAll('|', '\\|').replaceAll('\n', ' '); }
function list(values) { return values.map((value) => `- ${value}`).join('\n'); }
// Git may materialize the same tracked Markdown as LF or CRLF. Keep the
// comparison strict for every non-newline byte while accepting only the
// controlled line-ending difference and a single final newline.
export function canonicalizeGeneratedText(value) {
  const normalized = String(value).replace(/\r\n?/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}
export function renderMarkdown(contract) {
  const lines = [
    '<!-- 此文件由 scripts/prod-07-calendar-contract-check.mjs --write 根据 PROD-07-calendar-classification.json 生成。不要手工修改。 -->',
    '', '# PROD-07：日历事实与任务候选分类规则', '',
    `- 状态：\`${contract.status}\`；负责人：\`${contract.owner}\`；最后复核：\`${contract.last_reviewed}\``,
    `- 生效目标：${contract.target}`,
    `- 范围：${contract.scope}`,
    `- PROD-07 证据上限：${contract.evidence_ceiling.map((v) => `\`${v}\``).join('、')}；本 Issue 只有合同/静态夹具证据。整仓 CI/Playwright 仅作为回归门禁，不证明规则已在 UI 或生产分类中实现；不声明 L5/L6。`,
    '', '## 三条产品路径', '', '| 路径 | 用户可见含义 | 生成候选 | 需主人确认 | 保留来源 |', '| --- | --- | --- | --- | --- |',
  ];
  for (const [route, item] of Object.entries(contract.routes)) lines.push(`| ${route} | ${cell(item.meaning)} | ${item.candidate_created ? '是' : '否'} | ${item.owner_confirmation_required ? '是' : '否'} | ${item.source_retained ? '是' : '否'} |`);
  lines.push('', '## 角色规则', '', '| 角色 | 默认路径 | 规则 | 角色本身不等于任务 |', '| --- | --- | --- | --- |');
  for (const item of contract.role_matrix) lines.push(`| ${item.role} | ${item.default_route} | ${cell(item.candidate_condition)} | ${item.does_not_imply_task ? '是' : '否'} |`);
  lines.push('', '## 事件类型规则', '', '| 事件类型 | 默认路径 | 原因 |', '| --- | --- | --- |');
  for (const item of contract.event_matrix) lines.push(`| ${item.event_type} | ${item.default_route} | ${cell(item.reason)} |`);
  lines.push('', '## 进入候选的硬条件', '', `必须同时满足：${contract.decision_rules.candidate_requires_all.map((v) => `\`${v}\``).join(' + ')}。`, '', `动作词：${contract.decision_rules.explicit_action_verbs.join('、')}`, `主人责任信号：${contract.decision_rules.owner_responsibility_signals.join('、')}`, `交付物/截止点信号：${contract.decision_rules.deliverable_or_deadline_signals.join('、')}`, `非任务信号：${contract.decision_rules.non_signals.join('、')}`, '', `不确定路径合同：route=${contract.decision_rules.uncertain_rule.route}；scope=${contract.decision_rules.uncertain_rule.scope}；candidate_created=${contract.decision_rules.uncertain_rule.candidate_created}；source_retained=${contract.decision_rules.uncertain_rule.source_retained}；bulk_candidate_creation=${contract.decision_rules.uncertain_rule.bulk_candidate_creation}；required_fields=${contract.decision_rules.uncertain_rule.required_fields.join('、')}；forbidden_fields=${contract.decision_rules.uncertain_rule.forbidden_fields.join('、')}`, `会议来源合同：placeholder_route=${contract.decision_rules.meeting_rule.placeholder_route}；placeholder_is_action=${contract.decision_rules.meeting_rule.placeholder_is_action}；action_item_sources=${contract.decision_rules.meeting_rule.action_item_sources.join('、')}；requires_all_candidate_signals=${contract.decision_rules.meeting_rule.requires_all_candidate_signals}；source_retained=${contract.decision_rules.meeting_rule.source_retained}；scope=${contract.decision_rules.meeting_rule.scope}`, `解释合同：${Object.entries(contract.decision_rules.explanation_rule).map(([route, item]) => `${route}[required=${item.required_fields.join('、') || 'none'};forbidden=${item.forbidden_fields.join('、')};raw_content_allowed=${item.raw_content_allowed};free_text_allowed=${item.free_text_allowed};scope=${item.scope}]`).join('；')}`);
  lines.push('', '## 纠错边界', '', `- 入口：${contract.correction_rule.entry_label}`, `- 当前事件：${contract.correction_rule.current_event_scope}`, `- 重复系列：${contract.correction_rule.series_scope}`, `- 学习范围：${contract.correction_rule.learning_boundary}`, `- 重分类：${contract.correction_rule.reclassification_boundary}`, `- 来源变更：${contract.correction_rule.source_mutation}`, `- 审计：${contract.correction_rule.audit_event}`, `- 全局过滤：${contract.correction_rule.global_filter}`, `- 全局删除来源：${contract.correction_rule.global_source_deletion}`, `- 新 revision：${contract.correction_rule.requires_new_revision}`, `- 幂等：${contract.correction_rule.idempotency}`);
  lines.push('', '## 合成验收夹具与指标', '', '| 夹具组 | 输入 | 路径 | 候选 | 待确认 | 保留来源 | 最大噪声率 |', '| --- | ---: | --- | ---: | ---: | ---: | ---: |');
  for (const batch of contract.acceptance.fixture_batches) lines.push(`| ${batch.id} | ${batch.input_count} | ${batch.expected_route} | ${batch.expected_candidate_count} | ${batch.expected_owner_confirmation_count} | ${batch.expected_source_retained_count} | ${batch.max_candidate_noise_rate} |`);
  lines.push('', `- 事实保留率最低：${contract.acceptance.metrics.fact_retention_rate_min}`, `- 事实误报候选噪声率最高：${contract.acceptance.metrics.facts_only_candidate_noise_rate_max}`, `- 明确交付候选召回率最低：${contract.acceptance.metrics.explicit_delivery_candidate_recall_min}`, `- 责任不明批量候选最高：${contract.acceptance.metrics.uncertain_bulk_candidate_count_max}`, `- 候选解释覆盖率最低：${contract.acceptance.metrics.candidate_explanation_coverage_min}`, `- 重复系列候选倍增最高：${contract.acceptance.metrics.duplicate_series_candidate_multiplier_max}`, `- 后续实现验收目标：桌面/窄屏 route 与解释保持一致（当前 Issue 未实现或验证 UI 分类行为）`);
  lines.push('', '### 可见验收', '', list(contract.acceptance.visible_acceptance));
  lines.push('', '## 合成示例', '', '| ID | 类型 | 事件 | 预期路径 | 生成候选 | 解释模板 | 解释 |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const item of contract.examples) lines.push(`| ${item.id} | ${item.kind} | ${cell(item.title)} | ${item.expected_route} | ${item.candidate_created ? '是' : '否'} | \`${item.explanation_code}\` | ${cell(item.explanation)} |`);
  lines.push('', '## 后续实现输入/输出边界', '', `- 最小日历 DTO：${contract.implementation_contract.minimum_calendar_dto_fields.map((v) => `\`${v}\``).join('、')}`, `- 规范化输出：${contract.implementation_contract.normalized_output_fields.map((v) => `\`${v}\``).join('、')}`, `- 禁止请求/暴露：${contract.implementation_contract.must_not_request_or_expose.join('、')}`, `- 生产行为：\`${contract.implementation_contract.production_behavior_status}\``);
  return `${lines.join('\n')}\n`;
}

export function checkFiles(source = defaultSource, view = defaultView, { write = false } = {}) {
  let contract;
  try { contract = JSON.parse(readFileSync(source, 'utf8')); } catch { return [`无法读取或解析 ${source}`]; }
  const errors = validateContract(contract);
  if (errors.length === 0) {
    const rendered = renderMarkdown(contract);
    if (write) writeFileSync(view, rendered, 'utf8');
    else {
      try {
        if (canonicalizeGeneratedText(readFileSync(view, 'utf8')) !== canonicalizeGeneratedText(rendered)) {
          errors.push(`${view} 与事实源不一致；运行 npm run docs:generate。`);
        }
      }
      catch { errors.push(`${view} 不存在；运行 npm run docs:generate。`); }
    }
  }
  return errors;
}

if (process.argv[1]?.endsWith('prod-07-calendar-contract-check.mjs')) {
  const errors = checkFiles(defaultSource, defaultView, { write: process.argv.includes('--write') });
  if (errors.length) { console.error(`PROD-07 contract check 失败（${errors.length} 项）：`); for (const error of errors) console.error(`- ${error}`); process.exitCode = 1; }
  else console.log(`PROD-07 contract check 通过${process.argv.includes('--write') ? '并已生成 Markdown' : ''}。`);
}
