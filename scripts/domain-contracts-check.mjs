import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const contractPath = process.env.DOMAIN_CONTRACT_FIXTURE ? resolve(process.env.DOMAIN_CONTRACT_FIXTURE) : resolve(root, 'docs/domain-contracts.json');
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const domain = read('apps/server/src/domain.ts');
const database = read('apps/server/src/database.ts');
const runtime = read('apps/server/src/runtime.ts');
const verification = JSON.parse(read('docs/verification-matrix.json'));
const requiredObjects = ['candidate', 'thread', 'task', 'owner_decision', 'job', 'approval', 'outbox', 'projection'];
const allObjects = ['source_event', ...requiredObjects];
const allowedAdrStatuses = new Set(['proposed', 'accepted', 'superseded-in-part', 'deprecated', 'rejected']);
const requiredAdrKeys = ['id', 'title', 'status', 'date', 'owner', 'scope', 'supersedes', 'evidence'];
const requiredAdrBodySections = ['决定', '限制', '重新评估条件'];
const adrBodySectionAliases = { 决定: '决定|最终决定', 限制: '限制|边界|代价|不采用|未采用', 重新评估条件: '重新评估|升级条件|兼容与迁移' };
const evidenceScopes = new Set(['code_path_review', 'runtime_type_and_code_path_review', 'fresh_schema_ddl_check_only', 'manual_contract_only', 'manual_runtime_evidence', 'not_unified_on_base', 'independent_draft_dependency']);
const transitionScopes = new Set(['current', 'target']);
const outcomeKeys = new Set(['success', 'partial_success', 'skipped', 'failure']);
const canonicalIdPattern = '^ADR-[0-9]{4}(?:-[a-z0-9-]+)?$';
const allowedAuthorities = new Set([
  'sqlite_fact.source_event current row plus provider source',
  'sqlite_fact.candidate_request + candidate_revision',
  'sqlite_fact.requirement_thread + requirement_thread_revision',
  'sqlite_fact.task + task_event',
  'sqlite_fact.owner_decision + source_event',
  'sqlite_fact.job + runtime_checkpoint',
  'sqlite_fact.approval',
  'sqlite_fact.outbox',
  'sqlite_fact.memory_projection metadata; files are derived',
]);
const exactAuthorities = {
  source_event: 'sqlite_fact.source_event current row plus provider source',
  candidate: 'sqlite_fact.candidate_request + candidate_revision',
  thread: 'sqlite_fact.requirement_thread + requirement_thread_revision',
  task: 'sqlite_fact.task + task_event',
  owner_decision: 'sqlite_fact.owner_decision + source_event',
  job: 'sqlite_fact.job + runtime_checkpoint',
  approval: 'sqlite_fact.approval',
  outbox: 'sqlite_fact.outbox',
  projection: 'sqlite_fact.memory_projection metadata; files are derived',
};
const expectedExternalIdPolicy = {
  allowlist: [
    { field: 'source_event.external_id', purpose: '业务来源去重/关联', storage: 'sqlite_fact', egress: '不得默认进入诊断、API同步结果或原值展示', display_rule: '不得公开日志、API原值或公开展示' },
    { field: 'ai_decision_log.provider_request_id', purpose: '受控 provider 请求诊断关联', storage: 'sqlite_fact', egress: '仅在现有格式校验与脱敏规则允许的受控诊断场景展示，且不得携带 token/body/URL', display_rule: '仅允许受控脱敏诊断展示；不得公开日志、API原值或公开展示' },
  ],
  identity_external_ids_default_forbidden: ['user_id', 'tenant_id', 'message_id', 'calendar_id', 'open_id', 'union_id', 'chat_id', 'conversation_id', 'document_id'],
  forbidden_payloads: ['token', 'request_body', 'response_body', 'url'],
};

const deepEqualExact = (actual, expected) => {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => deepEqualExact(value, expected[index]));
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]) && expectedKeys.every((key) => deepEqualExact(actual[key], expected[key]));
  }
  return actual === expected;
};
const parseTerminalStates = (value, states) => {
  if (typeof value !== 'string' || !value.trim()) return { states: [], error: 'terminal.current/target/gap 必须为 trim 后非空字符串。' };
  const normalized = value.trim();
  if (normalized === 'none') return { states: [] };
  const tokens = value.split(',').map((token) => token.trim());
  if (tokens.some((token) => !token)) return { states: [], error: 'terminal 状态列表不得包含 leading/trailing/double empty token。' };
  if (new Set(tokens).size !== tokens.length) return { states: [], error: 'terminal 状态列表不得包含重复 token。' };
  const unknown = tokens.find((token) => !states.has(token));
  if (unknown) return { states: [], error: `terminal ${unknown} 不在 states 内。` };
  return { states: tokens };
};

const typeStates = (name) => {
  const start = domain.indexOf(`export type ${name} =`);
  if (start < 0) return [];
  const end = domain.indexOf(';', start);
  return [...domain.slice(start, end < 0 ? domain.length : end).matchAll(/'([^']+)'/g)].map((match) => match[1]);
};
const runtimeTypeStates = (name) => {
  const start = runtime.indexOf(`export type ${name} =`);
  if (start < 0) return [];
  const end = runtime.indexOf(';', start);
  return [...runtime.slice(start, end < 0 ? runtime.length : end).matchAll(/'([^']+)'/g)].map((match) => match[1]);
};
const tableBlock = (table) => {
  const start = database.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) return '';
  const end = database.indexOf('\n  );', start);
  return database.slice(start, end < 0 ? database.length : end);
};
const checkValues = (table, column) => {
  const block = tableBlock(table);
  const match = block.match(new RegExp(`${column} TEXT NOT NULL(?: DEFAULT '[^']*')? CHECK \\(\\s*${column} IN \\(([^)]*)\\)`));
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]) : [];
};
const frontmatter = (path) => {
  const text = read(`docs/adr/${path}`);
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator >= 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
};
const idsFrom = (value) => [...String(value ?? '').matchAll(/ADR-[0-9]{4}(?:-[a-z0-9-]+)?/g)].map((match) => match[0]);
const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
const bindingLabel = (binding) => Object.entries(binding ?? {}).map(([key, value]) => `${key}=${value}`).join(', ');
const normalizeEol = (value) => String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const renderMarkdown = (value) => {
  const lines = [
    '# 领域合同：术语、权威、状态机与错误结果', '',
    '> Issue #64 的唯一细粒度事实源是 [domain-contracts.json](domain-contracts.json)。本页由 scripts/domain-contracts-check.mjs --write 生成；不得手写第二套状态、CAS、error/outcome 或终态事实。M1 当前为 SQLite、draft-only；#58 是独立 Draft/future dependency，不把 Mock/L4 升级为真实租户 L6。', '',
    '## 统一术语与数据权威矩阵', '',
    '| 术语 | 含义 | 权威源 | 派生/可重建物 | 禁止推断 |', '|---|---|---|---|---|',
    ...value.glossary.map((item) => `| ${cell(item.term)} | ${cell(item.meaning)} | ${cell(item.authority)} | ${cell(item.derived)} | ${cell(item.prohibited)} |`), '',
    `权威层顺序固定为：${value.authority_order.join(' → ')}。`, '',
    '## 对象状态、转移、CAS 与恢复（机器事实完整投影）', '',
  ];
  for (const name of allObjects) {
    const object = value.objects[name];
    lines.push(`### ${name}`, `- Current：${cell(object.current)}`, `- Target：${cell(object.target)}`, `- Gap：${cell(object.gap)}`, `- Authority：${cell(object.authority)}`, `- Evidence scope：current=${object.evidence_scope.current}；target=${object.evidence_scope.target}`, `- Binding：${cell(bindingLabel(object.binding))}`, `- Actor：${cell(object.actor)}`, `- States：${object.states.join(', ')}`, '');
    lines.push('| from | to | actor | guard | scope | evidence_scope |', '|---|---|---|---|---|---|');
    for (const transition of object.transitions) lines.push(`| ${cell(transition.from)} | ${cell(transition.to)} | ${cell(transition.actor)} | ${cell(transition.guard)} | ${transition.scope} | ${transition.evidence_scope} |`);
    lines.push('', `- Terminal current：${cell(object.terminal.current)}`, `- Terminal target：${cell(object.terminal.target)}`, `- Terminal gap：${cell(object.terminal.gap)}`);
    if (object.business_complete?.length) lines.push(`- Business-complete：${object.business_complete.join(', ')}`);
    lines.push(`- CAS：${cell(object.cas)}`, `- Recovery：${cell(object.recovery)}`, '');
  }
  lines.push('## Hard rules', '', ...value.hard_rules.map((rule) => `- ${cell(rule)}`), '', '## External ID policy', '', `Allowlist：${value.external_id_policy.allowlist.map((item) => `${item.field}（purpose=${item.purpose}；storage=${item.storage}；egress=${item.egress}；display_rule=${item.display_rule}）`).join('；')}`, `Identity IDs default forbidden：${value.external_id_policy.identity_external_ids_default_forbidden.join('、')}`, `Forbidden payloads：${value.external_id_policy.forbidden_payloads.join('、')}`, '', '## Error / outcome catalog', '', `Current outcome：${cell(value.outcomes.current)}`, `Target outcome：${Object.entries(value.outcomes.target).map(([key, text]) => `${key}: ${cell(text)}`).join('；')}`, `Gap：${cell(value.outcomes.gap)}`, `Evidence scope：current=${value.outcomes.evidence_scope.current}；target=${value.outcomes.evidence_scope.target}`, '', '| error_code | outcome | HTTP | 使用场景与恢复 |', '|---|---|---:|---|', ...value.error_catalog.map((item) => `| ${item.code} | ${item.outcome} | ${item.http} | ${cell(item.recovery)} |`), '', '## ADR 元数据与数据库裁决', '', `ADR YAML 必需 keys：${value.adr_contract.required_yaml_keys.join('、')}。正文必须包含：${value.adr_contract.required_body_sections.join('、')}。canonical ID 使用 ${value.adr_contract.canonical_id_pattern}。`, '', 'ADR 0007 将 ADR 0001 的 PostgreSQL-before-PoC 条款收窄为 M1 SQLite、draft-only；PostgreSQL 只保留为 M1 之后的负责人裁决项。', '', '## 证据边界', '', cell(value.evidence_boundary));
  return `${lines.join('\n')}\n`;
};

const validateRenderableStructure = () => {
  const errors = [];
  const requiredArrayRoots = ['glossary', 'authority_order', 'hard_rules', 'error_catalog'];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return ['[STRUCTURE] contract 必须是 JSON object。'];
  for (const key of requiredArrayRoots) if (!Array.isArray(contract[key])) errors.push(`[STRUCTURE] ${key} 必须是数组。`);
  if (Array.isArray(contract.glossary) && contract.glossary.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) errors.push('[STRUCTURE] glossary 每项必须是 object。');
  if (Array.isArray(contract.authority_order) && contract.authority_order.some((item) => typeof item !== 'string')) errors.push('[STRUCTURE] authority_order 每项必须是 string。');
  if (Array.isArray(contract.error_catalog) && contract.error_catalog.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) errors.push('[STRUCTURE] error_catalog 每项必须是 object。');
  if (!contract.adr_contract || typeof contract.adr_contract !== 'object' || !Array.isArray(contract.adr_contract.required_yaml_keys) || !Array.isArray(contract.adr_contract.required_body_sections) || typeof contract.adr_contract.canonical_id_pattern !== 'string') errors.push('[STRUCTURE] adr_contract 必须包含 required_yaml_keys、required_body_sections、canonical_id_pattern。');
  if (!contract.external_id_policy || typeof contract.external_id_policy !== 'object' || !Array.isArray(contract.external_id_policy.allowlist) || !Array.isArray(contract.external_id_policy.identity_external_ids_default_forbidden) || !Array.isArray(contract.external_id_policy.forbidden_payloads)) errors.push('[STRUCTURE] external_id_policy 必须包含 allowlist、identity_external_ids_default_forbidden、forbidden_payloads。');
  if (Array.isArray(contract.external_id_policy?.allowlist) && contract.external_id_policy.allowlist.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) errors.push('[STRUCTURE] external_id_policy.allowlist 每项必须是 object。');
  if (!contract.outcomes || typeof contract.outcomes !== 'object' || typeof contract.outcomes.current !== 'string' || !contract.outcomes.target || typeof contract.outcomes.target !== 'object' || typeof contract.outcomes.gap !== 'string' || !contract.outcomes.evidence_scope || typeof contract.outcomes.evidence_scope !== 'object') errors.push('[STRUCTURE] outcomes 必须包含 current、target、gap、evidence_scope。');
  if (!contract.objects || typeof contract.objects !== 'object' || Array.isArray(contract.objects)) errors.push('[STRUCTURE] objects 必须是 JSON object。');
  else for (const name of allObjects) {
    const object = contract.objects[name];
    if (!object || typeof object !== 'object' || Array.isArray(object)) { errors.push(`[STRUCTURE] objects.${name} 必须存在且为 object。`); continue; }
    if (!object.evidence_scope || typeof object.evidence_scope !== 'object' || !object.binding || typeof object.binding !== 'object' || !Array.isArray(object.states) || !Array.isArray(object.transitions) || !object.terminal || typeof object.terminal !== 'object') errors.push(`[STRUCTURE] objects.${name} 缺少 checker 渲染所需结构。`);
    else if (!Object.prototype.hasOwnProperty.call(object.terminal, 'current') || !Object.prototype.hasOwnProperty.call(object.terminal, 'target') || !Object.prototype.hasOwnProperty.call(object.terminal, 'gap')) errors.push(`[STRUCTURE] objects.${name}.terminal 必须包含 current、target、gap。`);
    if (Array.isArray(object.transitions) && object.transitions.some((transition) => !transition || typeof transition !== 'object' || Array.isArray(transition))) errors.push(`[STRUCTURE] objects.${name}.transitions 每项必须是 object。`);
  }
  return errors;
};

const check = ({ skipStructure = false } = {}) => {
  const errors = skipStructure ? [] : validateRenderableStructure();
  if (errors.length) return errors;
  if (contract.schema_version !== 1) errors.push('domain-contracts.json schema_version 必须为 1。');
  for (const key of ['external_source', 'sqlite_fact', 'describe', 'memory_projection', 'reference_activity']) if (typeof contract.authority_layers?.[key] !== 'string') errors.push(`authority_layers 缺少固定键 ${key}。`);
  if (JSON.stringify(contract.authority_order ?? []) !== JSON.stringify(['external_source', 'sqlite_fact', 'describe', 'memory_projection', 'reference_activity'])) errors.push('authority_order 必须固定且顺序一致。');
  if (!Array.isArray(contract.glossary) || contract.glossary.length !== 9) errors.push('glossary 必须精确包含 9 个对象术语。');
  if (!Array.isArray(contract.hard_rules) || contract.hard_rules.length < 4) errors.push('hard_rules 必须由 JSON 提供且至少包含 4 条。');
  if (!Array.isArray(contract.error_catalog) || contract.error_catalog.length === 0) errors.push('error_catalog 必须由 JSON 提供。');
  if (!contract.adr_contract || !Array.isArray(contract.adr_contract.required_yaml_keys) || !Array.isArray(contract.adr_contract.required_body_sections)) errors.push('adr_contract 必须由 JSON 提供。');
  if (!deepEqualExact(contract.adr_contract?.required_yaml_keys, requiredAdrKeys)) errors.push('adr_contract.required_yaml_keys 必须精确匹配固定有序集合。');
  if (!deepEqualExact(contract.adr_contract?.required_body_sections, requiredAdrBodySections)) errors.push('adr_contract.required_body_sections 必须精确匹配固定有序集合。');
  if (contract.adr_contract?.canonical_id_pattern !== canonicalIdPattern) errors.push('adr_contract.canonical_id_pattern 必须使用固定 canonical ADR 正则。');
  if (!deepEqualExact(contract.external_id_policy, expectedExternalIdPolicy)) errors.push('external_id_policy 必须精确匹配固定字段、值和安全语义。');
  for (const key of ['current', 'target', 'gap', 'evidence_scope']) if (contract.outcomes?.[key] === undefined) errors.push(`outcomes 缺少固定键 ${key}。`);
  for (const key of outcomeKeys) if (typeof contract.outcomes?.target?.[key] !== 'string') errors.push(`outcomes.target 缺少固定键 ${key}。`);
  const targetOutcomeKeys = Object.keys(contract.outcomes?.target ?? {});
  if (targetOutcomeKeys.length !== outcomeKeys.size || targetOutcomeKeys.some((key) => !outcomeKeys.has(key))) errors.push('outcomes.target 必须精确且只能包含四态键。');
  if (!contract.outcomes?.evidence_scope || typeof contract.outcomes.evidence_scope !== 'object' || !evidenceScopes.has(contract.outcomes.evidence_scope.current) || !evidenceScopes.has(contract.outcomes.evidence_scope.target)) errors.push('outcomes.evidence_scope 必须使用固定枚举。');
  const errorCodes = new Set();
  for (const item of contract.error_catalog ?? []) {
    if (!item.code || errorCodes.has(item.code) || !outcomeKeys.has(item.outcome) || !Number.isInteger(item.http) || !item.recovery) errors.push('error_catalog 必须包含唯一 code、固定 outcome、HTTP 整数和 recovery。');
    errorCodes.add(item.code);
  }
  const objectNames = Object.keys(contract.objects ?? {});
  if (objectNames.length !== allObjects.length || objectNames.some((name) => !allObjects.includes(name))) errors.push('domain-contracts.json 必须且只能包含精确的 9 个对象。');
  if (new Set(objectNames).size !== objectNames.length) errors.push('domain-contracts.json 对象名必须唯一。');
  for (const name of allObjects) {
    const object = contract.objects?.[name];
    if (!object) { errors.push(`${name} 缺少对象定义。`); continue; }
    for (const key of ['current', 'target', 'gap', 'evidence_scope', 'states', 'actor', 'transitions', 'cas', 'terminal', 'recovery', 'authority']) if (object[key] === undefined || (typeof object[key] === 'string' && !object[key].trim())) errors.push(`${name} 缺少 ${key}。`);
    if (!allowedAuthorities.has(object.authority) || object.authority !== exactAuthorities[name]) errors.push(`${name} authority 不在该对象固定允许集合。`);
    if (!object.evidence_scope || typeof object.evidence_scope !== 'object' || !evidenceScopes.has(object.evidence_scope.current) || !evidenceScopes.has(object.evidence_scope.target)) errors.push(`${name} evidence_scope 必须是固定枚举对象。`);
    const states = new Set(object.states);
    for (const transition of object.transitions ?? []) {
      if (!transition.from || !transition.to || !transition.actor || !transition.guard || !transition.scope || !transition.evidence_scope) errors.push(`${name} 存在缺少 from/to/actor/guard/scope/evidence_scope 的转移。`);
      if (!transitionScopes.has(transition.scope) || !evidenceScopes.has(transition.evidence_scope)) errors.push(`${name} transition scope/evidence_scope 必须使用固定枚举。`);
      if (!states.has(transition.from) || !states.has(transition.to)) errors.push(`${name} 转移 ${transition.from}->${transition.to} 不在 states 内。`);
    }
    if (!object.terminal) errors.push(`${name} terminal 必须存在。`);
    else {
      for (const key of ['current', 'target']) {
        const parsed = parseTerminalStates(object.terminal[key], states);
        if (parsed.error) errors.push(`${name} ${parsed.error}`);
      }
      if (typeof object.terminal.gap !== 'string' || !object.terminal.gap.trim()) errors.push(`${name} terminal.current/target/gap 必须为 trim 后非空字符串。`);
    }
    for (const business of object.business_complete ?? []) if (!states.has(business)) errors.push(`${name} business_complete ${business} 不在 states 内。`);
    if (!object.binding?.kind) errors.push(`${name} 缺少精确 binding。`);
  }

  const exactBindings = {
    source_event: { kind: 'sqlite_table', table: 'source_event', column: 'external_id' }, candidate: { kind: 'typescript_type', name: 'CandidateState' }, task: { kind: 'typescript_type', name: 'TaskStatus' }, thread: { kind: 'typescript_type', name: 'RequirementThreadStatus' }, projection: { kind: 'typescript_type', name: 'MemoryProjectionState' }, approval: { kind: 'sqlite_check', table: 'approval', column: 'status' }, outbox: { kind: 'sqlite_check', table: 'outbox', column: 'status' }, owner_decision: { kind: 'sqlite_check', table: 'owner_decision', column: 'state' }, job: { kind: 'runtime_statuses_only', source_file: 'apps/server/src/runtime.ts', type_name: 'RuntimeJobStatus', db_constraint_proven: false },
  };
  for (const [name, expected] of Object.entries(exactBindings)) if (!deepEqualExact(contract.objects?.[name]?.binding, expected)) errors.push(`${name} binding 必须精确匹配固定 key 集合和值。`);
  const sourceBlock = tableBlock('source_event');
  if (!sourceBlock || contract.objects.source_event.binding.column !== 'external_id' || !/\bid\s+TEXT\s+PRIMARY KEY/iu.test(sourceBlock) || !/\bexternal_id\s+TEXT\s+NOT NULL\s+UNIQUE/iu.test(sourceBlock)) errors.push('source_event binding 必须证明 fresh schema source_event(id, external_id)。');
  const tsBindings = { candidate: 'CandidateState', task: 'TaskStatus', thread: 'RequirementThreadStatus', projection: 'MemoryProjectionState' };
  for (const [objectName, typeName] of Object.entries(tsBindings)) { const actual = new Set(typeStates(typeName)); const declared = new Set(contract.objects[objectName].states); if (actual.size !== declared.size || [...actual].some((state) => !declared.has(state))) errors.push(`${objectName} 状态与 ${typeName} 不一致。`); }
  for (const objectName of ['approval', 'outbox', 'owner_decision']) { const binding = contract.objects[objectName].binding; const actual = new Set(checkValues(binding.table, binding.column)); const declared = new Set(contract.objects[objectName].states); if (actual.size !== declared.size || [...actual].some((state) => !declared.has(state))) errors.push(`${objectName} 状态与 ${binding.table}.${binding.column} CHECK 不一致。`); }
  const jobBinding = contract.objects.job.binding; const runtimeStates = new Set(runtimeTypeStates(jobBinding.type_name)); const declaredJobStates = new Set(contract.objects.job.states); if (runtimeStates.size !== declaredJobStates.size || [...runtimeStates].some((state) => !declaredJobStates.has(state))) errors.push('job 状态与 runtime.ts RuntimeJobStatus 不一致。');

  const adrFiles = readdirSync(resolve(root, 'docs/adr')).filter((file) => file.endsWith('.md') && file !== 'README.md');
  const adrValues = adrFiles.map((file) => ({ file, text: read(`docs/adr/${file}`), values: frontmatter(file) }));
  const adrIds = adrValues.map(({ values }) => values?.id).filter(Boolean); const verificationIds = new Set((verification.records ?? []).map((record) => record.id));
  if (adrValues.some(({ values }) => !values)) errors.push('所有 ADR（README 除外）必须包含 YAML frontmatter。');
  for (const { file, text, values } of adrValues) {
    if (!values) continue;
    for (const key of contract.adr_contract.required_yaml_keys) if (!values[key]) errors.push(`${file} 缺少 ADR 元数据 ${key}。`);
    // Use the fixed, schema-validated pattern rather than compiling an
    // arbitrary JSON value. This keeps malformed patterns (for example "[")
    // as a controlled semantic failure instead of an uncaught SyntaxError.
    if (values.id && !(new RegExp(canonicalIdPattern)).test(values.id)) errors.push(`${file} canonical ADR id 格式非法：${values.id}`);
    if (values.status && !allowedAdrStatuses.has(values.status)) errors.push(`${file} status 不在允许集合内：${values.status}`);
    const supersedesText = String(values.supersedes ?? '').replace(/[\[\]\s]/g, ''); if (supersedesText && supersedesText.split(',').some((ref) => !/^ADR-[0-9]{4}(?:-[a-z0-9-]+)?(?:#[^,]+)?$/.test(ref))) errors.push(`${file} supersedes 只能引用可解析 ADR-*。`);
    for (const ref of [...idsFrom(values.supersedes), ...idsFrom(values.superseded_by)]) if (!adrIds.includes(ref)) errors.push(`${file} 引用了不存在的 ADR ID ${ref}。`);
    const evidenceText = String(values.evidence ?? '').replace(/[\[\]\s]/g, ''); if (evidenceText && evidenceText.split(',').some((ref) => !/^VER-[A-Z0-9-]+$/.test(ref))) errors.push(`${file} evidence 只能引用可解析 VER-*。`); for (const evidenceId of evidenceText.split(',').filter(Boolean)) if (!verificationIds.has(evidenceId)) errors.push(`${file} 引用了 verification-matrix.json 中不存在的证据 ID ${evidenceId}。`);
    if (file === '0007-m1-sqlite-draft-only-and-contracts.md' && !evidenceText.includes('VER-ISSUE64-CONTRACT-L1-20260815')) errors.push('ADR-0007 必须直接引用 VER-ISSUE64-CONTRACT-L1-20260815。');
    for (const section of contract.adr_contract.required_body_sections) {
      const pattern = adrBodySectionAliases[section] ?? escapeRegExp(section);
      if (!(new RegExp(`^##\\s+[^\\n]*(${pattern})`, 'm')).test(text)) errors.push(`${file} 正文缺少“${section}”段落。`);
    }
  }
  if (new Set(adrIds).size !== adrIds.length) errors.push('ADR frontmatter id 必须唯一。');
  const trackedDocs = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter((file) => file.endsWith('.md') && file !== 'docs/verification-matrix.md');
  for (const file of trackedDocs) for (const evidenceId of read(file).match(/VER-[A-Z0-9-]+/g) ?? []) if (!verificationIds.has(evidenceId)) errors.push(`${file} 引用了 verification-matrix.json 中不存在的证据 ID ${evidenceId}。`);
  const markdownPath = process.env.DOMAIN_CONTRACT_MARKDOWN_FIXTURE ? resolve(process.env.DOMAIN_CONTRACT_MARKDOWN_FIXTURE) : resolve(root, 'docs/domain-contracts.md'); const markdown = readFileSync(markdownPath, 'utf8'); if (normalizeEol(markdown) !== normalizeEol(renderMarkdown(contract))) errors.push('domain-contracts.md 必须是 domain-contracts.json 的完整生成视图，禁止细节漂移。');
  return errors;
};

if (process.argv[1]?.endsWith('domain-contracts-check.mjs')) {
  const structuralErrors = validateRenderableStructure();
  if (structuralErrors.length) {
    console.error(`domain contract check 失败（${structuralErrors.length} 项）：`);
    structuralErrors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  if (process.argv.includes('--write') && !process.env.DOMAIN_CONTRACT_FIXTURE) writeFileSync(resolve(root, 'docs/domain-contracts.md'), renderMarkdown(contract), 'utf8');
  const errors = check({ skipStructure: true });
  if (errors.length) {
    console.error(`domain contract check 失败（${errors.length} 项）：`);
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log('domain contract check 通过：JSON、生成 Markdown、TS enum、精确 SQLite DDL/Runtime binding、ADR 元数据和验证引用一致。');
}

export { check, renderMarkdown };
