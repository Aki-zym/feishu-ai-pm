import { readFileSync } from 'node:fs';

const normalizePath = (file) => file.replaceAll('\\', '/').replace(/^\.\//, '');

const selection = JSON.parse(readFileSync(new URL('../docs/verification-matrix.json', import.meta.url), 'utf8')).selection_policy;
const REQUIRED_CATEGORIES = Object.freeze([
  'docs-only', 'test-ci-only', 'qa-control-plane', 'server-data-runtime', 'feishu', 'llm', 'web', 'desktop', 'release', 'unknown',
]);
const ALLOWED_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
const ALLOWED_RISKS = Object.freeze(['low', 'medium', 'high']);
const ALLOWED_CATEGORY_KEYS = Object.freeze(new Set(['minimum_level', 'risk', 'required_evidence', 'manual_review_required']));
const ALLOWED_PATH_RULE_KEYS = Object.freeze(new Set(['id', 'category', 'prefixes', 'exact', 'regex']));
const CONTROLLED_EVIDENCE = Object.freeze(new Set([
  'docs_check', 'unit_inventory', 'service_integration', 'exact_provenance', 'contract_replay',
  'scope_guard', 'redaction', 'browser_e2e', 'lifecycle', 'windows_installer_smoke', 'artifact_hash', 'path_review',
]));

// The JSON policy is a reviewable source of detail, not the final safety
// authority.  Keep the required rule order, selectors, and category floors
// in code so an edit to verification-matrix.json cannot silently downgrade a
// runtime, integration, desktop, release, or unknown path to docs-only.
const CANONICAL_CATEGORY_FLOORS = Object.freeze({
  'docs-only': Object.freeze({ minimum_level: 'L0', risk: 'low', required_evidence: Object.freeze(['docs_check']) }),
  'test-ci-only': Object.freeze({ minimum_level: 'L1', risk: 'medium', required_evidence: Object.freeze(['unit_inventory', 'exact_provenance']) }),
  'qa-control-plane': Object.freeze({ minimum_level: 'L4', risk: 'high', required_evidence: Object.freeze(['unit_inventory', 'contract_replay', 'exact_provenance']), manual_review_required: true }),
  'server-data-runtime': Object.freeze({ minimum_level: 'L2', risk: 'high', required_evidence: Object.freeze(['unit_inventory', 'service_integration', 'exact_provenance']), manual_review_required: true }),
  feishu: Object.freeze({ minimum_level: 'L3', risk: 'high', required_evidence: Object.freeze(['contract_replay', 'scope_guard', 'exact_provenance']), manual_review_required: true }),
  llm: Object.freeze({ minimum_level: 'L3', risk: 'high', required_evidence: Object.freeze(['contract_replay', 'redaction', 'exact_provenance']), manual_review_required: true }),
  web: Object.freeze({ minimum_level: 'L4', risk: 'high', required_evidence: Object.freeze(['unit_inventory', 'browser_e2e', 'exact_provenance']), manual_review_required: true }),
  desktop: Object.freeze({ minimum_level: 'L5', risk: 'high', required_evidence: Object.freeze(['unit_inventory', 'lifecycle', 'windows_installer_smoke', 'exact_provenance']), manual_review_required: true }),
  release: Object.freeze({ minimum_level: 'L5', risk: 'high', required_evidence: Object.freeze(['artifact_hash', 'windows_installer_smoke', 'exact_provenance']), manual_review_required: true }),
  unknown: Object.freeze({ minimum_level: 'L6', risk: 'high', required_evidence: Object.freeze(['path_review', 'exact_provenance']), manual_review_required: true }),
});

const CANONICAL_PATH_RULES = Object.freeze([
  Object.freeze({ id: 'docs', category: 'docs-only', prefixes: Object.freeze(['docs/']), exact: Object.freeze(['AGENTS.md', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']) }),
  Object.freeze({ id: 'release', category: 'release', prefixes: Object.freeze(['release/']), exact: Object.freeze(['apps/desktop/electron-builder.yml', 'scripts/desktop-installer-smoke.mjs']), regex: '^\\.github/workflows/[^/]*release[^/]*$' }),
  Object.freeze({ id: 'feishu', category: 'feishu', prefixes: Object.freeze(['apps/server/src/integrations/feishu']) }),
  Object.freeze({ id: 'llm', category: 'llm', prefixes: Object.freeze(['apps/server/src/integrations/llm']) }),
  Object.freeze({ id: 'qa-control', category: 'qa-control-plane', prefixes: Object.freeze(['scripts/ci-plan', 'scripts/ci-selection-policy', 'scripts/evidence-record-policy', 'scripts/local-verification', 'scripts/docs-check', 'scripts/ci-log-policy', 'scripts/playwright-evidence-policy', 'scripts/playwright-inventory', 'scripts/playwright-results-verify', 'scripts/verify-github-provenance', 'scripts/run-ci-command', 'scripts/run-vitest-inventory', 'scripts/docs-generate', 'scripts/domain-contracts-check', 'scripts/decision-register-check', 'scripts/e2e-build-provenance', 'scripts/test-e2e-lifecycle']), exact: Object.freeze(['.github/workflows/ci.yml']) }),
  Object.freeze({ id: 'script-runtime', category: 'server-data-runtime', exact: Object.freeze(['scripts/start-e2e-servers.mjs']) }),
  Object.freeze({ id: 'script-tests', category: 'test-ci-only', exact: Object.freeze(['scripts/capture-ui.mjs']) }),
  Object.freeze({ id: 'tests-and-ci', category: 'test-ci-only', prefixes: Object.freeze(['tests/']), regex: '(?:^|/)(?:__fixtures__|__mocks__|__tests__|e2e|fixtures?|mocks?|specs?|tests?)(?:/|$)|(?:^|/)(?:eslint|jest|prettier|vitest|playwright)\\.config\\.[cm]?[jt]$|(?:^|\\.)(?:bench|benchmark|cy|fixture|mock|spec|stories|story|test)\\.[cm]?[jt]sx?$' }),
  Object.freeze({ id: 'web', category: 'web', prefixes: Object.freeze(['apps/web/']) }),
  Object.freeze({ id: 'desktop', category: 'desktop', prefixes: Object.freeze(['apps/desktop/']) }),
  Object.freeze({ id: 'server', category: 'server-data-runtime', prefixes: Object.freeze(['apps/server/', 'apps/url-policy/']), exact: Object.freeze(['.env.example', 'package-lock.json', 'package.json', 'tsconfig.base.json']) }),
]);

// These are deliberately code-owned. A change to the policy source or its
// validators must never be able to turn itself into a docs-only change.
const PROTECTED_EXACT_PATHS = Object.freeze(new Set([
  'AGENTS.md',
  'docs/verification-matrix.json',
  'docs/docs-manifest.json',
  'docs/decision-register.json',
  'docs/decision-register.md',
  'docs/domain-contracts.json',
  'docs/domain-contracts.md',
  'docs/security_and_privacy.md',
  'docs/test-selection.md',
  'package.json',
  'package-lock.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'apps/desktop/package.json',
]));
const PROTECTED_PREFIXES = Object.freeze([
  '.github/workflows/',
  'docs/product-rules/',
  'scripts/ci-plan',
  'scripts/ci-selection-policy',
  'scripts/evidence-record-policy',
  'scripts/local-verification',
  'scripts/docs-check',
  'scripts/run-vitest-inventory',
  'scripts/verify-github-provenance',
  'scripts/playwright-inventory',
  'scripts/playwright-results-verify',
  'scripts/run-ci-command',
  'scripts/docs-generate',
  'scripts/domain-contracts-check',
  'scripts/decision-register-check',
  'scripts/e2e-build-provenance',
  'scripts/test-e2e-lifecycle',
  'scripts/ci-log-policy',
  'scripts/playwright-evidence-policy',
]);

const LEVEL_ORDER = Object.freeze(ALLOWED_LEVELS);
const RISK_ORDER = Object.freeze(['low', 'medium', 'high']);

export function selectionPolicyErrors(policy) {
  const errors = [];
  const add = (message) => errors.push(message);
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return ['selection_policy 必须是对象。'];
  if (policy.schema_version !== 1) add('selection_policy.schema_version 必须是 1。');
  if (!Array.isArray(policy.levels) || policy.levels.length !== ALLOWED_LEVELS.length || policy.levels.some((level, index) => level !== ALLOWED_LEVELS[index])) {
    add('selection_policy.levels 必须严格为 L0-L6。');
  }
  if (!Array.isArray(policy.path_rules) || policy.path_rules.length === 0) {
    add('selection_policy.path_rules 必须是非空数组。');
  }
  const categories = policy.categories;
  if (!categories || typeof categories !== 'object' || Array.isArray(categories)) {
    add('selection_policy.categories 必须是对象。');
  } else {
    const categoryKeys = Object.keys(categories).sort();
    if (categoryKeys.join('\0') !== [...REQUIRED_CATEGORIES].sort().join('\0')) add('selection_policy.categories 必须且只能包含受控类别。');
    for (const category of REQUIRED_CATEGORIES) {
      const rule = categories[category];
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        add(`selection_policy.categories.${category} 必须是对象。`);
        continue;
      }
      for (const key of Object.keys(rule)) if (!ALLOWED_CATEGORY_KEYS.has(key)) add(`selection_policy.categories.${category}.${key} 不是受控字段。`);
      if (!ALLOWED_LEVELS.includes(rule.minimum_level)) add(`selection_policy.categories.${category}.minimum_level 非法。`);
      if (!ALLOWED_RISKS.includes(rule.risk)) add(`selection_policy.categories.${category}.risk 非法。`);
      if (!Array.isArray(rule.required_evidence) || rule.required_evidence.length === 0 || rule.required_evidence.some((evidence) => typeof evidence !== 'string' || evidence.trim() === '' || !CONTROLLED_EVIDENCE.has(evidence))) {
        add(`selection_policy.categories.${category}.required_evidence 必须是非空受控 evidence 名称。`);
      }
      if (rule.manual_review_required !== undefined && typeof rule.manual_review_required !== 'boolean') add(`selection_policy.categories.${category}.manual_review_required 必须是 boolean。`);
      const floor = CANONICAL_CATEGORY_FLOORS[category];
      const floorKeys = Object.keys(floor);
      const actualKeys = Object.keys(rule);
      if (actualKeys.some((key) => !floorKeys.includes(key))) add(`selection_policy.categories.${category} 只能增加受控安全约束字段，不能声明未知字段。`);
      if (LEVEL_ORDER.indexOf(rule.minimum_level) < LEVEL_ORDER.indexOf(floor.minimum_level)) add(`selection_policy.categories.${category} 不得降低代码内置安全 floor 的 minimum_level。`);
      if (RISK_ORDER.indexOf(rule.risk) < RISK_ORDER.indexOf(floor.risk)) add(`selection_policy.categories.${category} 不得降低代码内置安全 floor 的 risk。`);
      if (!Array.isArray(rule.required_evidence) || floor.required_evidence.some((evidence) => !rule.required_evidence.includes(evidence))) add(`selection_policy.categories.${category} 不得删除代码内置安全 floor 的 required_evidence。`);
      if (Array.isArray(rule.required_evidence) && new Set(rule.required_evidence).size !== rule.required_evidence.length) add(`selection_policy.categories.${category}.required_evidence 不得重复。`);
      if (floor.manual_review_required === true && rule.manual_review_required !== true) add(`selection_policy.categories.${category} 必须保持代码内置安全 floor 的 manual_review_required=true。`);
    }
    if (categories.unknown?.manual_review_required !== true) add('unknown category 必须强制 manual review。');
  }
  const mixed = policy.mixed_paths;
  if (!mixed || mixed.minimum_level !== 'max(category.minimum_level)' || mixed.risk !== 'high' || mixed.manual_review_required !== true || mixed.claim_authorized !== false) {
    add('mixed_paths 必须固定为 high/manual/fail-closed。');
  }
  const unknown = policy.unknown_paths;
  if (!unknown || unknown.minimum_level !== 'L6' || unknown.risk !== 'high' || unknown.manual_review_required !== true || unknown.claim_authorized !== false) {
    add('unknown_paths 必须固定为 L6/high/manual/fail-closed。');
  }
  if (!policy.skip_semantics || typeof policy.skip_semantics !== 'object' || Object.keys(policy.skip_semantics).sort().join('\0') !== ['capability', 'none', 'not_executed', 'platform'].join('\0')) {
    add('skip_semantics 必须完整定义四种受控 skip kind。');
  }
  const ruleIds = new Set();
  for (const rule of Array.isArray(policy.path_rules) ? policy.path_rules : []) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      add('selection_policy.path_rules 中每项必须是对象。');
      continue;
    }
    if (typeof rule.id !== 'string' || rule.id.trim() === '' || ruleIds.has(rule.id)) add(`path rule id 非空且不可重复：${rule.id ?? '<missing>'}。`);
    ruleIds.add(rule.id);
    for (const key of Object.keys(rule)) if (!ALLOWED_PATH_RULE_KEYS.has(key)) add(`path rule ${rule.id ?? '<missing>'}.${key} 不是受控字段。`);
    if (!REQUIRED_CATEGORIES.includes(rule.category)) add(`path rule ${rule.id ?? '<missing>'} 的 category 非法。`);
    const selectors = ['exact', 'prefixes', 'regex'].filter((key) => rule[key] !== undefined);
    if (selectors.length === 0) add(`path rule ${rule.id ?? '<missing>'} 必须至少有一个匹配器。`);
    for (const key of ['exact', 'prefixes']) {
      if (rule[key] === undefined) continue;
      if (!Array.isArray(rule[key]) || rule[key].length === 0 || rule[key].some((value) => typeof value !== 'string' || value.trim() === '' || value.includes('\\') || value.startsWith('/') || /^[a-z]:\//i.test(value) || value.split('/').includes('..'))) {
        add(`path rule ${rule.id ?? '<missing>'}.${key} 必须是非空仓库相对路径数组。`);
      }
      if (Array.isArray(rule[key]) && new Set(rule[key]).size !== rule[key].length) add(`path rule ${rule.id ?? '<missing>'}.${key} 不可包含重复路径。`);
    }
    if (rule.regex !== undefined) {
      if (typeof rule.regex !== 'string' || rule.regex === '') add(`path rule ${rule.id ?? '<missing>'}.regex 必须是非空字符串。`);
      else {
        try { new RegExp(rule.regex, 'i'); } catch { add(`path rule ${rule.id ?? '<missing>'}.regex 无法解析。`); }
      }
    }
  }
  const actualRules = Array.isArray(policy.path_rules) ? policy.path_rules : [];
  if (actualRules.length !== CANONICAL_PATH_RULES.length) add('selection_policy.path_rules 必须保持代码内置规则数量与顺序。');
  for (let index = 0; index < Math.max(actualRules.length, CANONICAL_PATH_RULES.length); index += 1) {
    const actual = actualRules[index];
    const expected = CANONICAL_PATH_RULES[index];
    if (!actual || !expected) continue;
    for (const key of ['id', 'category', 'prefixes', 'exact', 'regex']) {
      const actualValue = actual[key];
      const expectedValue = expected[key];
      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) add(`selection_policy.path_rules[${index}].${key} 必须保持代码内置规则。`);
    }
  }
  const protectedExact = [...PROTECTED_EXACT_PATHS];
  const protectedPrefixes = [...PROTECTED_PREFIXES];
  if (new Set(protectedExact).size !== protectedExact.length) add('protected exact paths 不可重复。');
  if (new Set(protectedPrefixes).size !== protectedPrefixes.length) add('protected prefixes 不可重复。');
  for (let index = 0; index < protectedPrefixes.length; index += 1) {
    for (let other = index + 1; other < protectedPrefixes.length; other += 1) {
      if (protectedPrefixes[index].startsWith(protectedPrefixes[other]) || protectedPrefixes[other].startsWith(protectedPrefixes[index])) {
        add('protected prefixes 不得重叠。');
      }
    }
  }
  for (const exact of protectedExact) {
    if (protectedPrefixes.some((prefix) => exact.startsWith(prefix))) add(`protected exact path 与 prefix 重叠：${exact}。`);
  }
  return errors;
}

const policyErrors = selectionPolicyErrors(selection);
if (policyErrors.length) throw new Error(`selection_policy 非法：${policyErrors.join('；')}`);

const CATEGORY_RULES = selection.categories;

const pathMatches = (file, rule) => {
  if (rule.exact?.includes(file)) return true;
  if (rule.prefixes?.some((prefix) => file.startsWith(prefix))) return true;
  return rule.regex ? new RegExp(rule.regex, 'i').test(file) : false;
};

export function isProtectedControlPlanePath(file) {
  const normalized = normalizePath(file);
  return PROTECTED_EXACT_PATHS.has(normalized) || PROTECTED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function classifyPath(file, policy = selection) {
  if (typeof file !== 'string' || file.length === 0 || file.includes('\0')) return 'unknown';
  const normalized = normalizePath(file);
  const segments = normalized.split('/');
  if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || segments.some((part) => part === '..' || part === '')) {
    return 'unknown';
  }
  for (const rule of policy.path_rules ?? []) if (pathMatches(normalized, rule)) return rule.category;
  return 'unknown';
}

const canonicalFloorForPath = (file) => {
  const normalized = normalizePath(file);
  for (const rule of CANONICAL_PATH_RULES) if (pathMatches(normalized, rule)) return CANONICAL_CATEGORY_FLOORS[rule.category];
  return CANONICAL_CATEGORY_FLOORS.unknown;
};

/**
 * Selects CI gates from the complete merge diff. The only narrow plan is a
 * proven docs-only change; every executable, test, configuration, mixed,
 * unknown, or protected control-plane change receives the full gate set.
 */
export function selectCiPlan(files, policy = selection) {
  const candidates = Array.isArray(files) ? files : [];
  const normalizedFiles = [...new Set(candidates.map((file) => typeof file === 'string' ? normalizePath(file) : ''))].sort();
  const protectedFiles = normalizedFiles.filter(isProtectedControlPlanePath);
  const configuredCategories = normalizedFiles.map((file) => classifyPath(file, policy));
  const categories = [...new Set(configuredCategories)];
  categories.sort();
  const categoryRules = (categories.length > 0 ? categories : ['unknown']).map((category) => policy.categories?.[category] ?? policy.categories?.unknown ?? CANONICAL_CATEGORY_FLOORS.unknown);
  const canonicalFloors = normalizedFiles.map(canonicalFloorForPath);
  const effectiveCategories = [...new Set([...categories, ...canonicalFloors.map((floor) => Object.entries(CANONICAL_CATEGORY_FLOORS).find(([, value]) => value === floor)?.[0] ?? 'unknown')])];
  if (effectiveCategories.length === 0) effectiveCategories.push('unknown');
  effectiveCategories.sort();
  const effectiveRules = effectiveCategories.map((category) => policy.categories?.[category] ?? CANONICAL_CATEGORY_FLOORS[category] ?? CANONICAL_CATEGORY_FLOORS.unknown);
  const docsOnly = normalizedFiles.length > 0 && protectedFiles.length === 0 && effectiveCategories.length === 1 && effectiveCategories[0] === 'docs-only';
  const minimumLevel = [...categoryRules, ...effectiveRules, ...canonicalFloors]
    .map((rule) => rule.minimum_level)
    .sort((left, right) => LEVEL_ORDER.indexOf(right) - LEVEL_ORDER.indexOf(left))[0] ?? 'L6';
  const requiredEvidence = [...new Set([...categoryRules, ...effectiveRules, ...canonicalFloors].flatMap((rule) => rule.required_evidence ?? []))].sort();
  const highRisk = normalizedFiles.length === 0 || protectedFiles.length > 0 || effectiveCategories.includes('unknown') || effectiveCategories.length > 1 || [...categoryRules, ...effectiveRules, ...canonicalFloors].some((rule) => rule.risk === 'high');
  const reason = normalizedFiles.length === 0
    ? 'empty diff is not accepted as docs-only'
    : protectedFiles.length > 0
      ? `protected control-plane path requires full gate and manual review: ${protectedFiles.join(', ')}`
      : docsOnly
        ? 'all changed paths are documentation'
        : effectiveCategories.includes('unknown')
          ? 'unknown path requires the broad gate'
          : effectiveCategories.length > 1
            ? 'mixed path categories require the broad gate'
            : `${effectiveCategories[0]} requires the broad gate`;

  return {
    schemaVersion: policy.schema_version,
    mode: docsOnly ? 'docs-only' : 'full',
    categories: effectiveCategories.length > 0 ? effectiveCategories : ['unknown'],
    minimumLevel,
    requiredEvidence,
    highRisk,
    manualReviewRequired: highRisk || categoryRules.some((rule) => rule.manual_review_required === true),
    claimAuthorized: false,
    files: normalizedFiles,
    reason,
    gates: docsOnly
      ? { docs: true, check: false, lifecycle: false, e2e: false }
      : { docs: true, check: true, lifecycle: true, e2e: true },
  };
}

export { CATEGORY_RULES, LEVEL_ORDER, PROTECTED_EXACT_PATHS, PROTECTED_PREFIXES, selection };
