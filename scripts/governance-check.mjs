import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_CODEOWNER_RULES = [
  '/apps/server/',
  '/apps/desktop/',
  '/release/',
  '/apps/web/',
  '/docs/security_and_privacy.md',
  '/docs/feishu-integration.md',
  '/apps/server/src/integrations/',
  '/README.md',
  '/AGENTS.md',
  '/CONTRIBUTING.md',
  '/docs/',
  '/.github/',
  '/scripts/',
];

const read = (root, file, errors) => {
  const path = resolve(root, file);
  if (!existsSync(path)) {
    errors.push(`${file}: 缺少治理文件。`);
    return '';
  }
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
};

const error = (errors, file, message) => errors.push(`${file}: ${message}`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nonCodeLines(text) {
  const lines = text.split('\n');
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return '';
    }
    return fenced ? '' : line;
  });
}

function headingRanges(text, headingPattern) {
  const lines = text.split('\n');
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(headingPattern);
    if (match) headings.push({ index, match });
  }
  return headings.map((heading, position) => ({
    ...heading,
    end: headings[position + 1]?.index ?? lines.length,
  }));
}

function parseNumberedSections(text, file, expected, errors) {
  const lines = text.split('\n');
  const ranges = headingRanges(text, /^##\s+(\d+)\.\s+(.+?)\s*$/);
  const byNumber = new Map();
  for (const range of ranges) {
    const number = Number(range.match[1]);
    if (byNumber.has(number)) error(errors, file, `编号章节 ${number} 重复。`);
    byNumber.set(number, { ...range, title: range.match[2].trim() });
  }
  const expectedNumbers = Object.keys(expected).map(Number);
  if (byNumber.size !== expectedNumbers.length || expectedNumbers.some((number) => !byNumber.has(number))) {
    error(errors, file, `必须有编号章节 ${expectedNumbers.join('、')}。`);
  }
  for (const number of expectedNumbers) {
    const section = byNumber.get(number);
    if (!section) continue;
    if (section.title !== expected[number]) error(errors, file, `第 ${number} 节标题必须是“${expected[number]}”。`);
  }
  return { lines, byNumber };
}

function normalizeFieldLine(line) {
  const match = line.match(/^\s*-\s+(?:\[[ xX]\]\s+)?(.*)$/);
  return match ? match[1].replaceAll('`', '').trim() : null;
}

function isFieldLine(line, field) {
  const normalized = normalizeFieldLine(line);
  if (!normalized) return false;
  return normalized === field
    || normalized.startsWith(`${field}:`)
    || normalized.startsWith(`${field}：`)
    || normalized.startsWith(`${field}（`)
}

function validateHandoff(handoff, errors) {
  const file = 'docs/handoff-template.md';
  const expectedSections = {
    1: '目标与范围',
    2: '现场恢复',
    3: '必读材料',
    4: '依赖、base 与合并顺序',
    5: '证据与证据上限',
    6: '测试清单',
    7: '未决事项、风险与回退',
    8: '下一步',
  };
  const parsed = parseNumberedSections(handoff, file, expectedSections, errors);
  const requiredFields = {
    1: ['Issue / PR', '用户可见结果', '本次包含', '明确不包含', '产品主人确认状态与时间'],
    2: ['Worktree（仓库内相对标识）', 'Branch', 'Commit（behavior/source、docs/evidence 如有多个分别写）', 'git status --short --branch', 'Dirty paths（没有写 clean）', '可恢复副本 / patch / backup ref', '共享工作区是否保持未触碰'],
    3: ['受影响的稳定合同、ADR、QA 或安全文档'],
    4: ['Dependencies', 'Base branch / exact base SHA', 'Dependency PR / branch / exact head SHA', 'Temporary stacked base（如有）', 'Merge order', 'Parent 前进时的处理', 'Parent 合入后的 rebind 目标', 'Rebind 后必须刷新'],
    5: ['Changed paths（完整 base→HEAD）', 'ci-plan 选择', 'Source / record / merge-ref / parents / tree', 'Run / job / environment / command', '已取得层级', 'Skip 分类', 'Evidence ceiling（L0-L6；明确不能证明什么）'],
    7: ['未决产品决定及负责人', '已知风险 / 冲突', '回退方式（保留原始来源和审计）', '不得做的外部动作'],
    8: ['当前阻塞', '下一位负责人', '明确下一动作', '交接时间'],
  };
  const occurrences = new Map();
  for (const [number, fields] of Object.entries(requiredFields)) {
    const section = parsed.byNumber.get(Number(number));
    if (!section) continue;
    const body = parsed.lines.slice(section.index + 1, section.end);
    for (const field of fields) {
      const hits = [];
      for (let offset = 0; offset < body.length; offset += 1) {
        if (isFieldLine(body[offset], field)) hits.push(section.index + 1 + offset);
      }
      occurrences.set(field, hits);
      if (hits.length !== 1) error(errors, file, `字段“${field}”必须在第 ${number} 节恰好出现一次。`);
    }
  }
  for (const [field, hits] of occurrences) {
    if (hits.length !== 1) continue;
    const allSections = [...parsed.byNumber.values()].filter((section) => section.index < hits[0] && hits[0] < section.end);
    if (allSections.length !== 1) error(errors, file, `字段“${field}”章节归属无法确认。`);
  }

  const section6 = parsed.byNumber.get(6);
  if (section6) {
    const body = parsed.lines.slice(section6.index + 1, section6.end);
    const runHeading = body.findIndex((line) => /^###\s+已运行\s*$/.test(line));
    const notRunHeading = body.findIndex((line) => /^###\s+未运行\s*$/.test(line));
    if (runHeading < 0) error(errors, file, '第 6 节必须有独立的“已运行”子节。');
    if (notRunHeading < 0) error(errors, file, '第 6 节必须有独立的“未运行”子节。');
    if (runHeading >= 0) {
      const table = parseTable(body, runHeading + 1);
      if (!table || !table.rows.length || !sameCells(table.header, ['命令/场景', '结果', '时间', '证据位置'])) {
        error(errors, file, '“已运行”必须有独立的四列表格。');
      }
    }
    if (notRunHeading >= 0) {
      const table = parseTable(body, notRunHeading + 1);
      if (!table || !table.rows.length || !sameCells(table.header, ['命令/场景', 'not_executed 原因', '后续负责人'])) {
        error(errors, file, '“未运行”必须有独立表格，原因列必须含 not_executed。');
      }
    }
  }
  const plain = nonCodeLines(handoff).join('\n');
  if (!plain.includes('.handoff/current.md')) error(errors, file, '必须说明被忽略的 .handoff/current.md 恢复位置。');
  if (!/L0[–-]L6/.test(plain)) error(errors, file, '必须明确 L0-L6 证据上限。');
}

function parseTable(lines, start) {
  let index = start;
  while (index < lines.length && !lines[index].trim()) index += 1;
  if (!lines[index]?.trim().startsWith('|') || !lines[index + 1]?.trim().startsWith('|')) return null;
  const header = splitTableRow(lines[index]);
  const separator = splitTableRow(lines[index + 1]);
  if (!header || !separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) return null;
  const rows = [];
  index += 2;
  while (index < lines.length && lines[index].trim().startsWith('|')) {
    const row = splitTableRow(lines[index]);
    if (!row || row.length !== header.length) return null;
    rows.push(row);
    index += 1;
  }
  return { header, rows, end: index };
}

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim().replaceAll('`', ''));
}

function sameCells(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sectionByHeading(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { lines, start, end, body: lines.slice(start + 1, end) };
}

function validateRaci(contributing, errors) {
  const file = 'CONTRIBUTING.md';
  const section = sectionByHeading(contributing, '## RACI 与权限');
  if (!section) {
    error(errors, file, '缺少“## RACI 与权限”结构。');
    return;
  }
  const table = parseTable(section.body, 0);
  const expectedHeader = ['工作', '产品主人', '开发者/Worker', '独立 Reviewer', 'QA/证据负责人', '发布负责人', 'Merge authority（Lead/维护者）'];
  if (!table || !sameCells(table.header, expectedHeader)) {
    error(errors, file, 'RACI 必须是带固定角色列的 Markdown 表格。');
    return;
  }
  const roles = expectedHeader.slice(1);
  const roleIndex = new Map(roles.map((role, index) => [role, index + 1]));
  const responsibilities = new Map([
    ['确认 Issue 范围、用户结果和未决产品选择', '产品主人'],
    ['实现与本地回归', '开发者/Worker'],
    ['证据层级、changed-path、provenance 和未运行项', 'QA/证据负责人'],
    ['独立复核安全、边界和验收', '独立 Reviewer'],
    ['标记 Ready', 'Merge authority（Lead/维护者）'],
    ['合入 integration/m1-test-20260815', 'Merge authority（Lead/维护者）'],
    ['构建、签名、发布 Release', '发布负责人'],
  ]);
  const duplicateRows = new Set();
  const rows = new Map();
  for (const row of table.rows) {
    if (rows.has(row[0])) duplicateRows.add(row[0]);
    rows.set(row[0], row);
  }
  for (const rowName of duplicateRows) error(errors, file, 'RACI 责任行“' + rowName + '”重复。');
  for (const [responsibility, expectedRole] of responsibilities) {
    const row = rows.get(responsibility);
    if (!row) {
      error(errors, file, `RACI 缺少责任行“${responsibility}”。`);
      continue;
    }
    const expectedIndex = roleIndex.get(expectedRole);
    if (expectedIndex === undefined || !/^A\/R$|^A$|^R$/.test(row[expectedIndex])) {
      error(errors, file, `RACI 责任行“${responsibility}”必须由 ${expectedRole} 标记 A/R。`);
    }
    for (let index = 1; index < row.length; index += 1) {
      if (index === expectedIndex) continue;
      if (/^(?:A\/R|A|R)$/.test(row[index])) {
        error(errors, file, `RACI 责任行“${responsibility}”不能由其他角色标记 A/R。`);
      }
    }
  }
  const plain = nonCodeLines(contributing).join('\n');
  if (!/^##\s+可恢复 SOP\s*$/m.test(plain)) error(errors, file, '缺少“可恢复 SOP”章节。');
  const sopSteps = ['恢复现场', '主人确认 Issue', '隔离工作区', '选择证据层级', '实现', '同步文档影响', '写 handoff', '创建 Draft PR', '独立复核', '主人合入、另行发布'];
  for (const [index, step] of sopSteps.entries()) {
    const pattern = new RegExp(`^${index + 1}\\.\\s+\\*\\*${escapeRegExp(step)}\\*\\*`, 'm');
    if (!pattern.test(plain)) error(errors, file, `可恢复 SOP 缺少第 ${index + 1} 步“${step}”。`);
  }
  const boundary = sectionByHeading(contributing, '## GitHub 配置查询边界');
  if (!boundary) error(errors, file, '缺少 GitHub 配置查询边界章节。');
  else {
    const boundaryText = boundary.body.join('\n');
    if (!/HTTP 403/.test(boundaryText)) error(errors, file, 'GitHub 配置查询边界必须记录 HTTP 403 平台限制。');
    if (!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/.test(boundaryText)) error(errors, file, 'GitHub 配置查询边界必须记录查询时点。');
    if (!/branches\/integration%2Fm1-test-20260815\/protection/.test(boundaryText)
      || !/branches\/main\/protection/.test(boundaryText)
      || !/rulesets/.test(boundaryText)) error(errors, file, 'GitHub 配置查询边界必须列出三个只读查询目标。');
  }
  if (!/CODEOWNERS[\s\S]*不能声称已形成两人独立复核/.test(plain)) error(errors, file, '必须记录单 owner 限制，不能把 CODEOWNERS 当成独立性证明。');
  for (const permission of ['Ready', 'merge', 'release', 'draft-only', '不能 rebase 或 force-push']) {
    if (!plain.includes(permission)) error(errors, file, `缺少治理权限/限制“${permission}”。`);
  }
}

function parseYamlScalar(raw) {
  const value = raw.trim();
  if (!value) return {};
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseYamlScalar(item));
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function parseStrictYaml(text) {
  const root = {};
  const stack = [{ indent: -2, object: root }];
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/\t/.test(line)) throw new Error('YAML 不得使用 tab 缩进。');
    const indent = (line.match(/^ */)?.[0].length ?? 0);
    if (indent % 2 !== 0) throw new Error('YAML 缩进必须为两个空格的层级。');
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/);
    if (!match) throw new Error(`YAML 行无法解析：${line}`);
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1);
    if (!parent || indent !== parent.indent + 2) throw new Error(`YAML 对象层级错误：${line}`);
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(parent.object, key)) throw new Error(`YAML 键重复：${key}`);
    const rawValue = match[2] ?? '';
    if (!rawValue.trim()) {
      parent.object[key] = {};
      stack.push({ indent, object: parent.object[key] });
    } else {
      parent.object[key] = parseYamlScalar(rawValue);
    }
  }
  return root;
}

function yamlBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let active = null;
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index].match(/^```\s*([A-Za-z0-9_-]+)?\s*$/);
    if (start && !active) {
      active = { language: start[1] ?? '', start: index, lines: [] };
    } else if (/^```\s*$/.test(lines[index]) && active) {
      blocks.push({ ...active, end: index, text: active.lines.join('\n') });
      active = null;
    } else if (active) {
      active.lines.push(lines[index]);
    }
  }
  return { blocks, unclosed: Boolean(active) };
}

const STACKED_TOP_KEYS = ['issue', 'pr', 'branch', 'temporary_base', 'dependency', 'merge_order', 'after_parent_merge'];
const DEPENDENCY_STATES = new Set(['draft_open', 'open', 'merged', 'closed', 'superseded', 'blocked', 'unavailable']);

function isBranchName(value) {
  return typeof value === 'string' && /^[-A-Za-z0-9._/]+$/.test(value) && value.startsWith('agent/');
}

function validateStackedMetadata(value, file, errors, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    error(errors, file, `${label} 必须是 YAML 对象。`);
    return;
  }
  if (!sameCells(Object.keys(value), STACKED_TOP_KEYS)) error(errors, file, `${label} 顶层键或顺序不正确。`);
  if (!Number.isInteger(value.issue) || value.issue <= 0) error(errors, file, `${label}.issue 必须是正整数。`);
  if (!Number.isInteger(value.pr) || value.pr <= 0) error(errors, file, `${label}.pr 必须是正整数。`);
  if (Number.isInteger(value.issue) && Number.isInteger(value.pr) && value.issue === value.pr) {
    error(errors, file, `${label}.issue 与 ${label}.pr 必须是不同编号。`);
  }
  if (!isBranchName(value.branch)) error(errors, file, `${label}.branch 必须是 agent/ 下的分支名。`);

  const temporary = value.temporary_base;
  if (!temporary || typeof temporary !== 'object' || Array.isArray(temporary)
    || !sameCells(Object.keys(temporary), ['branch', 'sha'])
    || typeof temporary.branch !== 'string' || !temporary.branch
    || typeof temporary.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(temporary.sha)) {
    error(errors, file, `${label}.temporary_base 必须包含 branch 和 40 位 hex sha。`);
  }

  const dependency = value.dependency;
  if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)
    || !sameCells(Object.keys(dependency), ['pr', 'state'])
    || !Number.isInteger(dependency.pr) || dependency.pr <= 0
    || !DEPENDENCY_STATES.has(dependency.state)) {
    error(errors, file, `${label}.dependency 必须包含正整数 pr 和受控 state。`);
  }

  if (!Array.isArray(value.merge_order) || value.merge_order.length < 2
    || value.merge_order.some((item) => !Number.isInteger(item) || item <= 0)
    || new Set(value.merge_order).size !== value.merge_order.length) {
    error(errors, file, `${label}.merge_order 必须是无重复正整数数组。`);
  } else if (Number.isInteger(dependency?.pr) && Number.isInteger(value.pr) && Number.isInteger(value.issue)) {
    const dependencyIndex = value.merge_order.indexOf(dependency.pr);
    const childPrIndex = value.merge_order.indexOf(value.pr);
    const issueIndex = value.merge_order.indexOf(value.issue);
    if (dependencyIndex < 0 || childPrIndex < 0 || dependencyIndex >= childPrIndex || issueIndex >= 0) {
      error(errors, file, `${label}.merge_order 必须只表达 PR，且先合入 dependency.pr，再合入 pr；不得使用 issue。`);
    }
  }

  const after = value.after_parent_merge;
  if (!after || typeof after !== 'object' || Array.isArray(after)
    || !sameCells(Object.keys(after), ['rebind_base', 'refresh_exact_provenance', 'required_ci', 'force_push'])
    || typeof after.rebind_base !== 'string' || !/^integration\/[A-Za-z0-9._/-]+$/.test(after.rebind_base)
    || after.refresh_exact_provenance !== true
    || after.required_ci !== 'pull_request_synchronize_exact_merge_ref'
    || after.force_push !== 'forbidden') {
    error(errors, file, `${label}.after_parent_merge 必须声明 integration rebind、exact provenance、fresh CI 和 force_push=forbidden。`);
  }
}

function validateStackedPr(stacked, errors) {
  const file = 'docs/stacked-pr.md';
  const metadata = sectionByHeading(stacked, '## 必须记录的 metadata');
  const example = sectionByHeading(stacked, '## 示例快照（仅示例，不代表当前 active 实例）');
  if (!metadata) error(errors, file, '缺少 metadata 合同章节。');
  if (!example) error(errors, file, '缺少与 metadata 合同分开的示例快照章节。');
  const blocks = yamlBlocks(stacked);
  if (blocks.unclosed) error(errors, file, 'YAML fenced metadata 未闭合。');
  const metadataBlocks = metadata ? blocks.blocks.filter((block) => block.language === 'yaml' && block.start > metadata.start && block.start < metadata.end) : [];
  if (metadataBlocks.length !== 1) {
    error(errors, file, 'metadata 合同必须恰好包含一个 fenced YAML 对象。');
  } else {
    try {
      validateStackedMetadata(parseStrictYaml(metadataBlocks[0].text), file, errors, 'metadata');
    } catch (parseError) {
      error(errors, file, `metadata YAML 无法严格解析：${parseError instanceof Error ? parseError.message : 'unknown'}`);
    }
  }

  const exampleBlocks = example ? blocks.blocks.filter((block) => block.language === 'yaml' && block.start > example.start && block.start < example.end) : [];
  if (exampleBlocks.length < 2) error(errors, file, '示例快照至少需要两个独立的 generic YAML 实例。');
  for (const [index, block] of exampleBlocks.entries()) {
    try {
      validateStackedMetadata(parseStrictYaml(block.text), file, errors, `example[${index}]`);
    } catch (parseError) {
      error(errors, file, `example[${index}] YAML 无法严格解析：${parseError instanceof Error ? parseError.message : 'unknown'}`);
    }
  }

  const plain = nonCodeLines(stacked).join('\n');
  for (const phrase of ['父分支前进时', '普通 merge', '不 rebase', '不 force-push', 'Merge 与 release 分离', 'historical/example']) {
    if (!plain.includes(phrase)) error(errors, file, `缺少 stacked PR 规则“${phrase}”。`);
  }
}

function validateCodeowners(codeowners, errors) {
  const file = '.github/CODEOWNERS';
  const rules = [];
  const ownerPattern = /^@[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/;
  for (const line of codeowners.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    const path = parts.shift();
    if (!path || !path.startsWith('/') || path.includes(':') || !parts.length) {
      error(errors, file, `存在无效 CODEOWNERS 规则：${line}`);
      continue;
    }
    if (parts.some((owner) => !ownerPattern.test(owner))) {
      error(errors, file, `存在无效 CODEOWNERS owner：${line}`);
      continue;
    }
    rules.push({ path, owners: parts });
  }
  for (const path of REQUIRED_CODEOWNER_RULES) {
    const rule = rules.find((candidate) => candidate.path === path);
    if (!rule) error(errors, file, `缺少有效路径规则 ${path}。`);
    else if (!rule.owners.some((owner) => ownerPattern.test(owner))) error(errors, file, `${path} 未映射到有效 owner/team。`);
  }
  if (!rules.some((rule) => rule.owners.some((owner) => ownerPattern.test(owner)))) error(errors, file, '至少需要一条映射到有效 owner/team 的规则。');
  if (!/not proof of independent review/.test(codeowners)) error(errors, file, '必须记录 CODEOWNERS 不等于独立复核证明的限制。');
}

function validatePrTemplate(prTemplate, errors) {
  const file = '.github/pull_request_template.md';
  const issue = sectionByHeading(prTemplate, '## 关联 Issue');
  if (!issue || !issue.body.some((line) => /^Refs #\s*$/.test(line.trim()))) error(errors, file, '必须有独立可填写的 Refs # 行。');
  if (/^\s*Closes\s+#/im.test(prTemplate)) error(errors, file, 'PR 模板不得使用 Closes 自动关闭 Issue。');
  const stacked = sectionByHeading(prTemplate, '## Stacked PR metadata');
  if (!stacked) {
    error(errors, file, '缺少独立的 Stacked PR metadata 章节。');
    return;
  }
  const fields = [
    'Base branch / exact base SHA:',
    'Dependency PR / branch / exact head SHA (write none when independent):',
    'Merge order:',
    'After the parent merges: rebind base to integration/m1-test-20260815, refresh exact merge-ref provenance, and wait for fresh CI:',
    'If the parent moves before merge: merge the new parent branch normally; do not rebase or force-push:',
  ];
  for (const field of fields) {
    if (!stacked.body.some((line) => line.trim().replaceAll('`', '') === `- ${field}`)) error(errors, file, `Stacked PR metadata 缺少可填写字段“${field}”。`);
  }
}

function validateGithubGovernanceState(collaboration, errors) {
  const file = 'docs/github_collaboration.md';
  const section = sectionByHeading(collaboration, '## GitHub 配置状态');
  if (!section) {
    error(errors, file, '缺少“## GitHub 配置状态”结构化事实章节。');
    return;
  }
  const blocks = yamlBlocks(collaboration).blocks.filter((block) => block.language === 'yaml' && block.start > section.start && block.start < section.end);
  if (blocks.length !== 1) {
    error(errors, file, 'GitHub 配置状态必须恰好包含一个 fenced YAML 对象。');
    return;
  }
  let state;
  try {
    state = parseStrictYaml(blocks[0].text);
  } catch (parseError) {
    error(errors, file, `GitHub 配置状态 YAML 无法严格解析：${parseError instanceof Error ? parseError.message : 'unknown'}`);
    return;
  }
  if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.status !== 'string') {
    error(errors, file, 'GitHub 配置状态必须是带 status 的对象。');
    return;
  }
  const checkedAt = typeof state.checked_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}$/.test(state.checked_at);
  if (!checkedAt) error(errors, file, 'GitHub 配置状态 checked_at 必须是带时区的 ISO 时间。');
  if (state.status === 'unavailable') {
    if (!sameCells(Object.keys(state), ['status', 'checked_at', 'http_status', 'reason'])) error(errors, file, 'unavailable 状态必须只包含 status/checked_at/http_status/reason。');
    if (!Number.isInteger(state.http_status) || state.http_status < 100 || state.http_status > 599) error(errors, file, 'unavailable 状态必须记录有效 HTTP/status 数字。');
    if (typeof state.reason !== 'string' || !state.reason.trim()) error(errors, file, 'unavailable 状态必须记录受控 reason。');
  } else if (state.status === 'verified') {
    if (!sameCells(Object.keys(state), ['status', 'checked_at', 'branch', 'ruleset', 'required_review'])) error(errors, file, 'verified 状态必须只包含 status/checked_at/branch/ruleset/required_review。');
    if (typeof state.branch !== 'string' || !state.branch.trim()) error(errors, file, 'verified 状态必须记录 branch 证据。');
    if (typeof state.ruleset !== 'string' || !state.ruleset.trim()) error(errors, file, 'verified 状态必须记录 ruleset 证据。');
    if (typeof state.required_review !== 'string' || !state.required_review.trim()) error(errors, file, 'verified 状态必须记录 required-review 证据。');
  } else {
    error(errors, file, 'GitHub 配置状态 status 只能是 unavailable 或 verified。');
  }
  const flow = sectionByHeading(collaboration, '## 一项工作的流转');
  if (!flow) {
    error(errors, file, '缺少“一项工作的流转”章节。');
  } else {
    const flowText = flow.body.join('\n');
    if (!/integration\/m1-test-20260815/.test(flowText)) {
      error(errors, file, '当前流转必须声明普通合入 integration/m1-test-20260815。');
    }
    if (/(?:合并到|合入|Merge\s*[：:]|->\s*)\s*`?main\b/i.test(flowText)) {
      error(errors, file, '当前流转不得把 main 写成合入目标。');
    }
  }
}

function validateSafety(files, errors) {
  const personalAbsolutePath = /(?:\b[A-Za-z]:[\\/]|\\\\(?:Users|home|Documents)[\\/]|(?:^|[\s(])\/(?:Users|home|private|var|tmp|mnt)(?:\/|$))/i;
  const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gho|ghp|github_pat)_[A-Za-z0-9_]{12,}\b|\bsk-[A-Za-z0-9]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*[A-Za-z0-9_\-]{16,}/i;
  for (const [file, text] of files) {
    if (personalAbsolutePath.test(text)) error(errors, file, '不得提交个人绝对路径。');
    if (secret.test(text)) error(errors, file, '不得提交 secret/token/private key。');
  }
}

export function governanceErrors(root = defaultRoot) {
  const errors = [];
  const handoff = read(root, 'docs/handoff-template.md', errors);
  const contributing = read(root, 'CONTRIBUTING.md', errors);
  const stacked = read(root, 'docs/stacked-pr.md', errors);
  const codeowners = read(root, '.github/CODEOWNERS', errors);
  const prTemplate = read(root, '.github/pull_request_template.md', errors);
  const ignore = read(root, '.gitignore', errors);
  const collaboration = read(root, 'docs/github_collaboration.md', errors);
  const manifestText = read(root, 'docs/docs-manifest.json', errors);

  if (handoff) validateHandoff(handoff, errors);
  if (contributing) validateRaci(contributing, errors);
  if (stacked) validateStackedPr(stacked, errors);
  if (codeowners) validateCodeowners(codeowners, errors);
  if (prTemplate) validatePrTemplate(prTemplate, errors);
  if (!ignore.includes('.handoff/current.md')) error(errors, '.gitignore', '必须忽略 .handoff/current.md。');
  if (collaboration) validateGithubGovernanceState(collaboration, errors);

  try {
    const manifest = JSON.parse(manifestText);
    const governance = manifest.governance ?? {};
    for (const [key, expected] of Object.entries({
      contributing: 'CONTRIBUTING.md',
      handoff_template: 'docs/handoff-template.md',
      stacked_pr: 'docs/stacked-pr.md',
      codeowners: '.github/CODEOWNERS',
      governance_check: 'scripts/governance-check.mjs',
    })) {
      if (governance[key] !== expected) error(errors, 'docs/docs-manifest.json', `governance.${key} 必须指向 ${expected}。`);
    }
  } catch {
    error(errors, 'docs/docs-manifest.json', 'JSON 无法解析。');
  }

  validateSafety([
    ['docs/handoff-template.md', handoff],
    ['CONTRIBUTING.md', contributing],
    ['docs/stacked-pr.md', stacked],
    ['.github/CODEOWNERS', codeowners],
    ['.github/pull_request_template.md', prTemplate],
    ['docs/github_collaboration.md', collaboration],
  ], errors);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const errors = governanceErrors();
  if (errors.length) {
    console.error(`governance-check 失败（${errors.length} 项）：`);
    for (const item of errors) console.error(`- ${item}`);
    process.exit(1);
  }
  console.log('governance-check 通过：结构化 handoff、RACI、CODEOWNERS、stacked metadata 和平台限制记录完整。');
}
