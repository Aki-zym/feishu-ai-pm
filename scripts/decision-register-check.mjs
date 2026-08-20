import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultSource = resolve(root, 'docs/decision-register.json');
const defaultView = resolve(root, 'docs/decision-register.md');

const requiredDecisionKeys = [
  'id', 'type', 'status', 'owner', 'gate', 'options', 'decision', 'rationale', 'scope',
  'dependencies', 'evidence', 'last_reviewed', 'target', 'visible_impact', 'unverified', 'unlocks',
];
const requiredOpenKeys = [...requiredDecisionKeys, 'do_not_default_implement'];
const allowedStatuses = new Set(['decided', 'pending']);
const allowedDecisionTypes = new Set(['database', 'release', 'calendar_and_dates', 'governance', 'privacy', 'validation', 'product_boundary', 'pilot_access', 'privacy_retention', 'multi_device']);
const allowedOwners = new Set(['product_owner']);
const datePattern = /^2026-\d{2}-\d{2}$/;
const issuePattern = /^#\d+$/;
const absolutePathPattern = /(?:^[A-Za-z]:[\\/]|^\\\\|^\/)/;
const secretPattern = /(sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]|BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY|Bearer\s+)/i;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasContent(value) {
  return text(value).length > 0 && !absolutePathPattern.test(text(value)) && !secretPattern.test(text(value));
}

function validateDecision(item, index, { open = false } = {}) {
  const errors = [];
  const keys = open ? requiredOpenKeys : requiredDecisionKeys;
  for (const key of keys) if (!(key in (item ?? {}))) errors.push(`items[${index}] 缺少 ${key}`);
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [`items[${index}] 必须是对象`];
  if (!/^DEC-01(?:\.\d+|-P\d+)$/.test(item.id ?? '')) errors.push(`items[${index}].id 非法`);
  if (!allowedDecisionTypes.has(item.type)) errors.push(`items[${index}].type 非法`);
  if (!allowedStatuses.has(item.status) || (open ? item.status !== 'pending' : item.status !== 'decided')) errors.push(`items[${index}].status 与分区不一致`);
  if (!allowedOwners.has(item.owner)) errors.push(`items[${index}].owner 非法`);
  if (!hasContent(item.gate)) errors.push(`items[${index}].gate 必须是受控非空文本`);
  if (!Array.isArray(item.options) || item.options.length < 2 || item.options.some((v) => !hasContent(v))) errors.push(`items[${index}].options 必须至少有两个安全选项`);
  if (open ? item.decision !== null : !hasContent(item.decision)) errors.push(`items[${index}].decision ${open ? '必须为 null' : '必须是非空决定'}`);
  for (const key of ['rationale', 'scope', 'target', 'visible_impact']) if (!hasContent(item[key])) errors.push(`items[${index}].${key} 必须是受控非空文本`);
  if (!Array.isArray(item.dependencies) || item.dependencies.length === 0 || item.dependencies.some((v) => !issuePattern.test(v) && !/^future /.test(v))) errors.push(`items[${index}].dependencies 必须包含 Issue 或 future 依赖`);
  if (!Array.isArray(item.evidence) || item.evidence.some((v) => !hasContent(v))) errors.push(`items[${index}].evidence 必须是安全数组`);
  if (!datePattern.test(item.last_reviewed ?? '')) errors.push(`items[${index}].last_reviewed 必须是 YYYY-MM-DD`);
  if (!Array.isArray(item.unverified) || item.unverified.length === 0 || item.unverified.some((v) => !hasContent(v))) errors.push(`items[${index}].unverified 必须明确未验证边界`);
  if (!Array.isArray(item.unlocks) || item.unlocks.length === 0 || item.unlocks.some((v) => !hasContent(v))) errors.push(`items[${index}].unlocks 必须非空`);
  if (open && item.do_not_default_implement !== true) errors.push(`items[${index}] 未决项必须 do_not_default_implement=true`);
  if (!open && item.do_not_default_implement !== undefined) errors.push(`items[${index}] 已决项不能携带未决默认实现标记`);
  return errors;
}

export function validateRegister(register) {
  const errors = [];
  if (!register || typeof register !== 'object' || Array.isArray(register)) return ['register 必须是对象'];
  if (register.schema_version !== 1) errors.push('schema_version 必须为 1');
  if (register.register_id !== 'DEC-01') errors.push('register_id 必须为 DEC-01');
  if (!hasContent(register.title) || !hasContent(register.scope)) errors.push('title/scope 必须是受控非空文本');
  if (register.status !== 'accepted') errors.push('status 必须为 accepted');
  if (!allowedOwners.has(register.owner)) errors.push('owner 必须为 product_owner');
  if (!datePattern.test(register.last_reviewed ?? '')) errors.push('register.last_reviewed 必须是 YYYY-MM-DD');
  if (!hasContent(register.target)) errors.push('register.target 必须是受控非空文本');
  if (!register.validation || typeof register.validation !== 'object') errors.push('validation 必须是对象');
  else {
    if (!/^[0-9a-f]{40}$/i.test(register.validation.commit ?? '')) errors.push('validation.commit 必须绑定 40 位 commit');
    for (const key of ['run', 'environment', 'result']) if (!hasContent(register.validation[key])) errors.push(`validation.${key} 必须非空`);
    if (!Array.isArray(register.validation.evidence_ceiling) || register.validation.evidence_ceiling.length === 0 || register.validation.evidence_ceiling.some((v) => !/^L[0-6]$/.test(v))) errors.push('validation.evidence_ceiling 必须是 L0-L6 数组');
    if (!Array.isArray(register.validation.unverified) || register.validation.unverified.length === 0) errors.push('validation.unverified 必须明确 L5/L6 边界');
    if ((register.validation.evidence_ceiling ?? []).some((v) => ['L5', 'L6'].includes(v))) errors.push('validation.evidence_ceiling 不得声称 L5/L6');
  }
  if (!Array.isArray(register.decisions) || register.decisions.length !== 7) errors.push('decisions 必须恰好包含 7 条已决事项');
  if (!Array.isArray(register.open_items) || register.open_items.length < 1) errors.push('open_items 必须保留未决登记');
  const ids = new Set();
  for (const [index, item] of (register.decisions ?? []).entries()) {
    for (const error of validateDecision(item, index)) errors.push(error);
    if (ids.has(item?.id)) errors.push(`重复决策 ID ${item.id}`); else ids.add(item?.id);
  }
  for (const [index, item] of (register.open_items ?? []).entries()) {
    for (const error of validateDecision(item, index, { open: true })) errors.push(`open_items.${error}`);
    if (ids.has(item?.id)) errors.push(`重复登记 ID ${item.id}`); else ids.add(item?.id);
  }
  return errors;
}

function renderList(values) {
  return values.join('；');
}

export function renderMarkdown(register) {
  const lines = [
    '<!-- 此文件由 scripts/decision-register-check.mjs --write 根据 decision-register.json 生成。不要手工修改。 -->',
    '', '# DEC-01：M1 产品与治理负责人决策登记', '',
    `- 状态：\`${register.status}\``,
    `- 负责人：\`${register.owner}\``,
    `- 最后复核：\`${register.last_reviewed}\``,
    `- 生效范围：${register.target}`,
    `- 本登记范围：${register.scope}`,
    '', '## 验证边界', '',
    `- 绑定基线：\`${register.validation.commit}\``,
    `- 运行：\`${register.validation.run}\`；环境：${register.validation.environment}；结果：\`${register.validation.result}\``,
    `- 证据上限：${register.validation.evidence_ceiling.map((v) => `\`${v}\``).join('、')}`,
    `- 未验证：${renderList(register.validation.unverified)}`,
    '', '## 已决定事项', '',
    '| ID | 类型 | 决定 | Gate | 依赖 | 解锁 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const item of register.decisions) lines.push(`| ${item.id} | ${item.type} | ${item.decision} | ${item.gate} | ${item.dependencies.join('、')} | ${item.unlocks.join('、')} |`);
  for (const item of register.decisions) {
    lines.push('', `### ${item.id}：${item.type}`, '', `- 选项：${item.options.join('；')}`, `- 原因：${item.rationale}`, `- 影响：${item.visible_impact}`, `- 范围：${item.scope}`, `- 证据：${item.evidence.length ? item.evidence.join('、') : '暂无独立运行证据'}`, `- 未验证：${renderList(item.unverified)}`);
  }
  lines.push('', '## 待主人决定事项', '', '| ID | 类型 | Gate | 不得默认实现 |', '| --- | --- | --- | --- |');
  for (const item of register.open_items) lines.push(`| ${item.id} | ${item.type} | ${item.gate} | ${item.do_not_default_implement ? '是' : '否'} |`);
  for (const item of register.open_items) lines.push('', `### ${item.id}：${item.type}`, '', `- 选项：${item.options.join('；')}`, `- 当前状态：待主人选择（不得默认实现）`, `- 原因：${item.rationale}`, `- 影响：${item.visible_impact}`, `- 未验证：${renderList(item.unverified)}`);
  lines.push('', '## 产品最高边界', '', '- 系统只发现、记录和管理任务，不自动执行任务。', '- 对外可见内容和外部动作必须由系统主人确认。', '- 来源事实与生成摘要保持区分；文件变化不能证明任务完成。');
  return `${lines.join('\n')}\n`;
}

// Git's checkout settings may materialize the same tracked Markdown blob as
// LF or CRLF. Compare the canonical text while preserving every non-newline
// character; a field or punctuation mutation must still fail closed.
export function canonicalizeGeneratedText(value) {
  const normalized = String(value).replace(/\r\n?/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

export function checkFiles(source = defaultSource, view = defaultView, { write = false } = {}) {
  let register;
  const errors = [];
  try { register = JSON.parse(readFileSync(source, 'utf8')); } catch { return [`无法读取或解析 ${source}`]; }
  errors.push(...validateRegister(register));
  if (errors.length === 0) {
    const rendered = renderMarkdown(register);
    if (write) writeFileSync(view, rendered);
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

if (process.argv[1]?.endsWith('decision-register-check.mjs')) {
  const write = process.argv.includes('--write');
  const errors = checkFiles(defaultSource, defaultView, { write });
  if (errors.length) { console.error(`decision register check 失败（${errors.length} 项）：`); for (const error of errors) console.error(`- ${error}`); process.exitCode = 1; }
  else console.log(`decision register check 通过${write ? '并已生成 Markdown' : ''}。`);
}
