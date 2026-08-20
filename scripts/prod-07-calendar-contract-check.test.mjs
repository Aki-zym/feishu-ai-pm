import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import source from '../docs/product-rules/PROD-07-calendar-classification.json' with { type: 'json' };
import { canonicalizeGeneratedText, checkFiles, renderMarkdown, validateContract } from './prod-07-calendar-contract-check.mjs';

const valid = () => structuredClone(source);

test('PROD-07 规则合同和合成夹具通过', () => assert.deepEqual(validateContract(valid()), []));

test('mutation matrix：规则结构、事实保留、生产状态和敏感边界 fail-closed', () => {
  const mutations = [
    ['顶层增加 alternate_policy', (c) => { c.alternate_policy = { create_all_candidates: true }; }],
    ['source_policy 缺少必需键', (c) => { delete c.source_policy.filtered_event_is_retained; }],
    ['source_policy 增加未知键', (c) => { c.source_policy.foo = true; }],
    ['source_policy 必需键变为 false', (c) => { c.source_policy.calendar_fact_is_authoritative = false; }],
    ['routes 布尔值语义被改写', (c) => { c.routes.calendar_fact.candidate_created = true; }],
    ['routes meaning 改写候选语义', (c) => { c.routes.calendar_fact.meaning = '所有普通提醒都应自动创建候选'; }],
    ['routes 增加未知 route', (c) => { c.routes.unknown = structuredClone(c.routes.calendar_fact); }],
    ['route 增加未知字段', (c) => { c.routes.calendar_fact.extra = true; }],
    ['role 默认路径变成候选', (c) => { c.role_matrix[0].default_route = 'candidate_review'; }],
    ['role candidate_condition 改写候选语义', (c) => { c.role_matrix[0].candidate_condition = '组织者默认就是任务'; }],
    ['role 任务含义被改写', (c) => { c.role_matrix[0].does_not_imply_task = false; }],
    ['role 集合缺失', (c) => { c.role_matrix[0].role = 'unknown'; }],
    ['删除候选硬条件', (c) => { c.decision_rules.candidate_requires_all.pop(); }],
    ['不确定规则改为候选路径', (c) => { c.decision_rules.uncertain_rule.route = 'candidate_review'; }],
    ['不确定规则允许候选泛滥', (c) => { c.decision_rules.uncertain_rule.bulk_candidate_creation = true; }],
    ['不确定规则删除来源', (c) => { c.decision_rules.uncertain_rule.source_retained = false; }],
    ['不确定规则扩大为全局作用域', (c) => { c.decision_rules.uncertain_rule.scope = 'global_calendar'; }],
    ['不确定规则允许原始正文', (c) => { c.decision_rules.uncertain_rule.forbidden_fields = ['source_deletion']; }],
    ['增加未知事件类型直接生成候选', (c) => { c.event_matrix.push({ event_type: 'invented_high_priority', default_route: 'candidate_review', reason: '任意新增事件直接生成候选' }); }],
    ['删除事件类型', (c) => { c.event_matrix.pop(); }],
    ['重复事件类型', (c) => { c.event_matrix[1].event_type = c.event_matrix[0].event_type; }],
    ['事件类型增加未知字段', (c) => { c.event_matrix[0].extra = true; }],
    ['event reason 改写候选语义', (c) => { c.event_matrix[0].reason = '所有提醒都自动进入候选页'; }],
    ['事件类型缺少字段', (c) => { delete c.event_matrix[0].reason; }],
    ['把普通提醒变成候选', (c) => { c.event_matrix[0].default_route = 'candidate_review'; }],
    ['把会议占位当 action item', (c) => { c.decision_rules.meeting_rule.placeholder_route = 'candidate_review'; }],
    ['会议规则允许孤立 action item', (c) => { c.decision_rules.meeting_rule.action_item_sources = ['meeting_title']; }],
    ['动作信号被无关词替换', (c) => { c.decision_rules.explicit_action_verbs = ['彩虹']; }],
    ['责任信号被无关词替换', (c) => { c.decision_rules.owner_responsibility_signals = ['彩虹']; }],
    ['交付信号被无关词替换', (c) => { c.decision_rules.deliverable_or_deadline_signals = ['彩虹']; }],
    ['非任务信号被无关词替换', (c) => { c.decision_rules.non_signals = ['彩虹']; }],
    ['产品信号缺失', (c) => { c.decision_rules.explicit_action_verbs.pop(); }],
    ['产品信号重复', (c) => { c.decision_rules.explicit_action_verbs[1] = c.decision_rules.explicit_action_verbs[0]; }],
    ['非任务信号交叉污染动作词', (c) => { c.decision_rules.non_signals[0] = '提交'; }],
    ['非任务信号交叉污染交付词', (c) => { c.decision_rules.non_signals[0] = '报告'; }],
    ['decision_rules 增加未知字段', (c) => { c.decision_rules.extra = 'ignored'; }],
    ['候选解释允许原始正文', (c) => { c.decision_rules.explanation_rule.candidate_review.raw_content_allowed = true; }],
    ['候选解释允许自由文本', (c) => { c.decision_rules.explanation_rule.candidate_review.free_text_allowed = true; }],
    ['候选解释缺少来源引用', (c) => { c.decision_rules.explanation_rule.candidate_review.required_fields.pop(); }],
    ['待确认解释改为无作用域', (c) => { c.decision_rules.explanation_rule.owner_confirmation.scope = 'unbounded'; }],
    ['correction_rule 增加未知字段', (c) => { c.correction_rule.extra = 'ignored'; }],
    ['纠错允许改写来源', (c) => { c.correction_rule.source_mutation = 'allowed'; }],
    ['纠错变成全局过滤', (c) => { c.correction_rule.global_filter = true; }],
    ['纠错允许删除来源', (c) => { c.correction_rule.global_source_deletion = true; }],
    ['纠错不再追加私有审计', (c) => { c.correction_rule.audit_event = 'optional'; }],
    ['纠错扩大当前事件作用域', (c) => { c.correction_rule.current_event_scope = 'all_events'; }],
    ['example 增加未知字段', (c) => { c.examples[0].extra = 'ignored'; }],
    ['acceptance 增加未知字段', (c) => { c.acceptance.extra = 'ignored'; }],
    ['visible_acceptance 改写候选语义', (c) => { c.acceptance.visible_acceptance[0] = '所有日历事实都自动进入候选页'; }],
    ['metrics 增加未知字段', (c) => { c.acceptance.metrics.extra = 'ignored'; }],
    ['fixture batch 增加未知字段', (c) => { c.acceptance.fixture_batches[0].extra = 'ignored'; }],
    ['过滤即删除来源', (c) => { c.routes.calendar_fact.source_retained = false; }],
    ['纠错入口缺失', (c) => { c.correction_rule.entry_label = '忽略'; }],
    ['候选无解释', (c) => { c.examples.find((e) => e.candidate_created).explanation = ''; }],
    ['候选缺少责任信号', (c) => { c.examples.find((e) => e.id === 'positive-delivery-01').signals = ['action', 'deliverable_or_deadline']; }],
    ['候选增加未知信号', (c) => { c.examples.find((e) => e.id === 'positive-delivery-01').signals.push('meeting_title'); }],
    ['候选重复信号', (c) => { c.examples.find((e) => e.id === 'positive-delivery-01').signals.push('action'); }],
    ['正例改成事实路径', (c) => { const e = c.examples.find((item) => item.id === 'positive-delivery-01'); e.expected_route = 'calendar_fact'; e.candidate_created = false; }],
    ['普通提醒改成候选但同步计数', (c) => { const e = c.examples.find((item) => item.id === 'negative-reminder-01'); e.expected_route = 'candidate_review'; e.candidate_created = true; e.signals = ['explicit_owner_responsibility', 'action', 'deliverable_or_deadline']; }],
    ['边界例改成事实路径', (c) => { const e = c.examples.find((item) => item.id === 'boundary-ambiguous-01'); e.expected_route = 'calendar_fact'; }],
    ['事件类型改成未知', (c) => { c.examples[0].event_type = 'invented_event'; }],
    ['声称改了生产行为', (c) => { c.implementation_contract.production_behavior_status = 'implemented'; }],
    ['声称 L4', (c) => { c.evidence_ceiling.push('L4'); }],
    ['证据顺序/集合被放宽', (c) => { c.evidence_ceiling = ['L1']; }],
    ['删除正例', (c) => { c.examples = c.examples.filter((e) => e.kind !== 'positive'); }],
    ['重复示例 ID', (c) => { c.examples[1].id = c.examples[0].id; }],
    ['绝对路径', (c) => { c.scope = 'C:\\private\\calendar'; }],
    ['secret', (c) => { c.examples[0].description = 'Bearer synthetic'; }],
    ['删除重复系列指标', (c) => { delete c.acceptance.metrics.duplicate_series_candidate_multiplier_max; }],
    ['fixture route 与计数不一致', (c) => { c.acceptance.fixture_batches[0].expected_candidate_count = 1; }],
    ['fixture 计数为负数', (c) => { c.acceptance.fixture_batches[0].expected_source_retained_count = -1; }],
    ['fixture 计数为小数', (c) => { c.acceptance.fixture_batches[0].input_count = 50.5; }],
    ['fixture 总数超过输入', (c) => { c.acceptance.fixture_batches[1].expected_owner_confirmation_count = 1; }],
    ['fixture 缺少固定批次', (c) => { c.acceptance.fixture_batches = c.acceptance.fixture_batches.slice(1); }],
    ['fixture 固定 ID 被替换', (c) => { c.acceptance.fixture_batches[0].id = 'ordinary-reminders'; }],
    ['畸形 role 项 fail-closed', (c) => { c.role_matrix[0] = null; }],
    ['畸形 event 项 fail-closed', (c) => { c.event_matrix[0] = null; }],
    ['畸形 example 项 fail-closed', (c) => { c.examples[0] = null; }],
    ['畸形 fixture 项 fail-closed', (c) => { c.acceptance.fixture_batches[0] = null; }],
    ['DTO 必需字段被任意字符串替换', (c) => { c.implementation_contract.minimum_calendar_dto_fields[0] = 'arbitrary_field'; }],
    ['DTO 增加危险原始字段', (c) => { c.implementation_contract.minimum_calendar_dto_fields.push('raw_calendar_payload'); }],
    ['DTO 必需字段重复', (c) => { c.implementation_contract.minimum_calendar_dto_fields[1] = c.implementation_contract.minimum_calendar_dto_fields[0]; }],
    ['输出字段缺失', (c) => { c.implementation_contract.normalized_output_fields.pop(); }],
    ['规范化输出增加 auto_execute', (c) => { c.implementation_contract.normalized_output_fields.push('auto_execute'); }],
    ['最小 DTO 增加 calendar_auto_action', (c) => { c.implementation_contract.minimum_calendar_dto_fields.push('calendar_auto_action'); }],
    ['禁止暴露字段被删除', (c) => { c.implementation_contract.must_not_request_or_expose.pop(); }],
    ['禁止暴露集合增加未知字段', (c) => { c.implementation_contract.must_not_request_or_expose.push('unknown_dangerous_field'); }],
  ];
  for (const [name, mutate] of mutations) {
    const fixture = valid();
    mutate(fixture);
    assert.notDeepEqual(validateContract(fixture), [], name);
  }
});

test('生成视图在临时 root 可重现且包含桌面/窄屏与纠错边界', () => {
  const root = mkdtempSync(join(tmpdir(), 'prod-07-'));
  try {
    const output = join(root, 'PROD-07-calendar-classification.md');
    writeFileSync(output, renderMarkdown(source));
    assert.equal(readFileSync(output, 'utf8'), renderMarkdown(source));
    assert.match(readFileSync(output, 'utf8'), /这只是提醒/);
    assert.match(readFileSync(output, 'utf8'), /后续实现验收目标：桌面\/窄屏 route 与解释保持一致/);
    assert.match(readFileSync(output, 'utf8'), /整仓 CI\/Playwright 仅作为回归门禁/);
    assert.doesNotMatch(readFileSync(output, 'utf8'), /桌面\/窄屏规则一致：是/);
    assert.match(readFileSync(output, 'utf8'), /ordinary-reminder/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('生成视图比较兼容 LF/CRLF，但真实 Markdown/JSON 差异仍 fail-closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'prod-07-eol-'));
  try {
    const sourcePath = join(root, 'PROD-07-calendar-classification.json');
    const viewPath = join(root, 'PROD-07-calendar-classification.md');
    writeFileSync(sourcePath, JSON.stringify(valid(), null, 2));
    const rendered = renderMarkdown(valid());
    writeFileSync(viewPath, rendered.replaceAll('\n', '\r\n'));
    assert.deepEqual(checkFiles(sourcePath, viewPath), []);

    writeFileSync(viewPath, rendered.replace('事实/提醒', '事实/变异').replaceAll('\n', '\r\n'));
    assert.notDeepEqual(checkFiles(sourcePath, viewPath), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('write 输出 canonical LF 与单一结尾换行', () => {
  const root = mkdtempSync(join(tmpdir(), 'prod-07-write-'));
  try {
    const sourcePath = join(root, 'PROD-07-calendar-classification.json');
    const viewPath = join(root, 'PROD-07-calendar-classification.md');
    writeFileSync(sourcePath, JSON.stringify(valid(), null, 2));
    writeFileSync(viewPath, 'stale\r\n');
    assert.deepEqual(checkFiles(sourcePath, viewPath, { write: true }), []);
    const written = readFileSync(viewPath, 'utf8');
    assert.equal(written, canonicalizeGeneratedText(renderMarkdown(valid())));
    assert.equal(written.includes('\r'), false);
    assert.equal(written.endsWith('\n\n'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
