import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export const PRODUCT_SNAPSHOT_ALGORITHM = 'product-source-sha256-v1';
export const PRODUCT_SNAPSHOT_SELECTOR = 'apps-workspace-default-include-v1';

const STATUS_LABELS = {
  attained: '实际运行证据已取得',
  artifact_integrity_only: '仅产物完整性；Smoke 未运行',
  reported_not_reverified: '历史 QA 报告；本次未独立复验',
  historical_claim_not_reverified: '历史声明；未独立复验',
  not_run: '未运行；未取得证据',
};

const PLACEHOLDERS = new Set(['unrecorded', 'not_run']);
const TEXT_EXTENSIONS = /\.(?:cjs|css|html|js|json|jsx|mjs|ts|tsx|ya?ml)$/i;
const PRODUCT_FILES = new Set([
  '.env.example',
  'package-lock.json',
  'package.json',
  'tsconfig.base.json',
]);
const WORKSPACE_PATH = /^apps\/[^/]+\/(.+)$/;
const EXCLUDED_WORKSPACE_DIRECTORIES = new Set([
  '.cache', '.next', '.parcel-cache', '.turbo', '.vite',
  '__fixtures__', '__mocks__', '__snapshots__', '__tests__',
  'build', 'coverage', 'dist', 'docs', 'documentation',
  'cypress', 'e2e', 'fixture', 'fixtures', 'mock', 'mocks', 'node_modules',
  'out', 'playwright-report', 'spec', 'specs', 'storybook-static',
  'target', 'temp', 'test', 'test-results', 'tests', 'tmp',
]);
const TEST_FILE = /(?:^|\.)(?:bench|benchmark|cy|fixture|mock|spec|stories|story|test)\.[cm]?[jt]sx?$|\.snap$/i;
const DOCUMENT_FILE = /^(?:changelog|code_of_conduct|contributing|license|notice|readme)(?:\..*)?$|\.(?:adoc|md|mdx|rst)$/i;
const GENERATED_FILE = /\.(?:map|tsbuildinfo)$/i;
const NON_PRODUCT_CONFIG_FILE = /^(?:eslint|jest|playwright|prettier|vitest|cypress)\.config\.|^tsconfig\.(?:spec|test|vitest)\.json$|^\.(?:eslint|prettier)/i;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const INTEGRATION_BRANCH = 'integration/m1-test-20260815';
export const INTEGRATION_DECLARATION_KINDS = new Set(['committed_base_snapshot', 'live_tip']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

export function resolveRepoPath(repoRoot, declared, options = {}) {
  const { mustExist = true, kind = 'file', forWrite = false } = options;
  if (typeof declared !== 'string' || declared.trim() === '' || isAbsolute(declared)) {
    throw new Error('必须是仓库内相对路径');
  }

  const rootReal = realpathSync(repoRoot);
  const resolved = resolve(repoRoot, declared);
  if (!isWithin(repoRoot, resolved)) throw new Error('不得指向仓库外');

  if (existsSync(resolved)) {
    if (forWrite && lstatSync(resolved).isSymbolicLink()) throw new Error('写入目标不能是符号链接');
    const targetReal = realpathSync(resolved);
    if (!isWithin(rootReal, targetReal)) throw new Error('不得通过符号链接指向仓库外');
    const stats = statSync(targetReal);
    if (kind === 'file' && !stats.isFile()) throw new Error('必须指向普通文件');
    if (kind === 'directory' && !stats.isDirectory()) throw new Error('必须指向目录');
  } else if (mustExist) {
    throw new Error('指向的路径不存在');
  }

  if (forWrite) {
    const parentReal = realpathSync(dirname(resolved));
    if (!isWithin(rootReal, parentReal)) throw new Error('写入目标的父目录不在仓库内');
  }
  return resolved;
}

export function decodeMarkdownTarget(rawTarget) {
  try {
    return { value: decodeURIComponent(rawTarget) };
  } catch {
    return { error: '本地链接含非法百分号编码' };
  }
}

export function evidenceStatusLabel(status) {
  return STATUS_LABELS[status] ?? `未知状态：${status}`;
}

export function attainedLevelLabel(record) {
  if (record.attained_level === null || record.attained_level === undefined) return '未取得';
  return record.evidence_status === 'artifact_integrity_only'
    ? `${record.attained_level}（仅产物完整性）`
    : record.attained_level;
}

export function realEvidenceLabel(record) {
  return record.real_environment_attained ? '已取得（仅限所列步骤）' : '未取得';
}

export function evidenceRecordErrors(record, levelIds) {
  const errors = [];
  const add = (message) => errors.push(message);
  const levelRank = (level) => levelIds.has(level) ? Number(level.slice(1)) : -1;
  const targetRank = levelRank(record.target_level);
  const attainedRank = record.attained_level === null ? -1 : levelRank(record.attained_level);
  const status = record.evidence_status;

  if (targetRank < 0) add(`未知目标层级 ${record.target_level}。`);
  if (record.attained_level !== null && attainedRank < 0) add(`未知已取得层级 ${record.attained_level}。`);
  if (targetRank >= 0 && attainedRank > targetRank) add('已取得层级不能高于目标层级。');
  if (!Object.hasOwn(STATUS_LABELS, status)) add(`未知证据状态 ${status}。`);
  for (const key of ['target_real_scope', 'real_environment_attained']) {
    if (typeof record[key] !== 'boolean') add(`${key} 必须是 boolean。`);
  }
  if (record.target_real_scope === true && record.target_level !== 'L6') add('真实外部目标只能设置为 L6。');
  if (String(record.scope).includes('real_external') && record.target_real_scope !== true) add('real_external scope 必须明确 target_real_scope=true。');

  if (status === 'not_run') {
    if (record.attained_level !== null) add('not_run 不能声明已取得层级。');
    if (record.real_environment_attained !== false) add('not_run 不能声明已取得真实环境证据。');
    if (record.result !== 'not_run' || record.run_id !== 'not_run' || record.run_at !== 'not_run') {
      add('not_run 的 result、run_id、run_at 必须一致标为 not_run。');
    }
  }

  if (status === 'reported_not_reverified') {
    if (record.attained_level !== null) add('未独立复验的历史 QA 报告不能声明已取得层级。');
    if (record.real_environment_attained !== false) add('未独立复验的历史 QA 报告不能声明真实环境证据。');
    if (record.result !== 'reported_passed_not_reverified') add('历史 QA 报告必须标为 reported_passed_not_reverified。');
    if (record.run_id !== 'unrecorded') add('未独立复验的历史 QA 报告不能伪装成独立 run。');
  }

  if (status === 'historical_claim_not_reverified') {
    if (record.evidence_type !== 'historical_documented_claim') add('历史声明状态必须使用 historical_documented_claim。');
    if (record.attained_level !== null) add('未独立复验的历史声明不能声明已取得层级。');
    if (record.real_environment_attained !== false) add('未独立复验的历史声明不能声明真实环境证据。');
    if (record.result !== 'historical_claim_not_reverified') add('历史声明结果必须标为 historical_claim_not_reverified。');
    if (record.run_id !== 'unrecorded') add('未独立复验的历史声明不能伪装成独立 run。');
  }

  const requiredStatusByType = {
    historical_documented_claim: 'historical_claim_not_reverified',
    committed_qa_record: 'reported_not_reverified',
    open_validation_item: 'not_run',
    artifact_hash_and_committed_qa_record: 'artifact_integrity_only',
  };
  const requiredStatus = requiredStatusByType[record.evidence_type];
  if (requiredStatus && status !== requiredStatus) {
    add(`${record.evidence_type} 必须使用 ${requiredStatus}，不能伪装成 attained。`);
  }

  if (status === 'artifact_integrity_only') {
    if (record.target_level !== 'L5' || record.attained_level !== 'L0') {
      add('仅产物完整性记录必须是目标 L5、已取得 L0，不能伪装成 L5 Smoke。');
    }
    if (record.real_environment_attained !== false) add('仅产物完整性不能声明真实环境证据。');
    if (record.result !== 'artifact_present_smoke_not_run') add('仅产物完整性必须明确 Smoke 未运行。');
    if (!record.artifact) add('仅产物完整性记录必须绑定 artifact。');
    if (record.run_id !== 'unrecorded') add('仅产物完整性不能伪装成 Windows Smoke run。');
  }

  if (status === 'attained') {
    if (record.attained_level === null) add('attained 必须声明已取得层级。');
    if (!/^[0-9a-f]{40}$/i.test(record.source_commit)) add('attained 必须绑定 40 位 source_commit。');
    for (const key of ['run_id', 'run_at', 'environment']) {
      if (!record[key] || PLACEHOLDERS.has(record[key])) add(`attained 必须提供实际 ${key}。`);
    }
    if (record.result !== 'passed') add('attained 必须是实际运行 passed。');
    if (record.attained_level === 'L5') {
      if (record.evidence_type !== 'windows_installer_smoke' || !record.artifact) {
        add('L5 已取得证据必须是绑定精确 artifact 的 Windows 安装 Smoke。');
      }
    }
    if (record.attained_level === 'L6') {
      if (record.evidence_type !== 'actual_real_environment_run' || record.target_real_scope !== true || record.real_environment_attained !== true) {
        add('L6 已取得证据必须是明确的实际真实环境运行。');
      }
    }
  }

  if (record.result === 'passed' && status !== 'attained') add('passed 只能与 attained 状态组合。');
  if (status !== 'attained' && record.real_environment_attained === true) add('非 attained 状态不能声明真实环境证据。');
  if (record.real_environment_attained === true) {
    if (record.attained_level !== 'L6' || record.target_real_scope !== true || record.evidence_type !== 'actual_real_environment_run') {
      add('真实环境证据必须来自目标 L6 的 actual_real_environment_run。');
    }
  }
  if (status === 'attained' && record.attained_level === 'L6' && record.evidence_type === 'actual_real_environment_run' && record.real_environment_attained !== true) {
    add('实际 L6 真实环境运行必须明确 real_environment_attained=true。');
  }

  return errors;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function packageProjection(bytes) {
  const source = JSON.parse(bytes.toString('utf8'));
  const scriptNames = [
    'dev', 'build', 'start', 'test:plugin', 'test:server:current', 'test:web:current', 'test:current', 'typecheck', 'check',
  ];
  const projection = {};
  for (const key of ['version', 'main', 'workspaces', 'engines', 'dependencies', 'devDependencies', 'overrides', 'resolutions', 'allowScripts']) {
    if (source[key] !== undefined) projection[key] = source[key];
  }
  projection.scripts = Object.fromEntries(scriptNames.filter((key) => source.scripts?.[key] !== undefined).map((key) => [key, source.scripts[key]]));
  return Buffer.from(`${JSON.stringify(canonical(projection))}\n`, 'utf8');
}

export function isProductSourcePath(file) {
  const normalized = file.replaceAll('\\', '/');
  if (PRODUCT_FILES.has(normalized)) return true;
  const match = WORKSPACE_PATH.exec(normalized);
  if (!match) return false;

  const workspaceRelative = match[1];
  const segments = workspaceRelative.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  const basename = segments.at(-1);
  if (directories.some((segment) => EXCLUDED_WORKSPACE_DIRECTORIES.has(segment))) return false;
  if (TEST_FILE.test(basename) || DOCUMENT_FILE.test(basename) || GENERATED_FILE.test(basename)) return false;
  if (NON_PRODUCT_CONFIG_FILE.test(basename)) return false;
  return true;
}

export function computeProductFingerprint(paths, readBytes, contentIdentifier) {
  const selected = [...new Set(paths.map((file) => file.replaceAll('\\', '/')).filter(isProductSourcePath))].sort();
  const entries = selected.map((file) => {
    let contentHash;
    if (file === 'package.json') {
      const bytes = packageProjection(readBytes(file));
      contentHash = sha256(bytes);
    } else if (contentIdentifier) {
      contentHash = contentIdentifier(file);
    } else {
      let bytes = readBytes(file);
      if (file === '.env.example' || TEXT_EXTENSIONS.test(file)) {
        bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
      }
      contentHash = sha256(bytes);
    }
    return `${file}\0${contentHash}\n`;
  });
  return {
    algorithm: PRODUCT_SNAPSHOT_ALGORITHM,
    selector: PRODUCT_SNAPSHOT_SELECTOR,
    fingerprint: sha256(Buffer.from(entries.join(''), 'utf8')),
    file_count: selected.length,
  };
}

export function snapshotDeclarationErrors(declared, actual, verificationSnapshot) {
  const errors = [];
  if (declared?.algorithm !== PRODUCT_SNAPSHOT_ALGORITHM) errors.push('product snapshot algorithm 不受支持。');
  if (declared?.selector !== actual.selector || actual.selector !== PRODUCT_SNAPSHOT_SELECTOR) errors.push('product snapshot selector 不受支持。');
  if (!/^[0-9a-f]{64}$/i.test(declared?.fingerprint ?? '')) errors.push('product snapshot fingerprint 必须是 64 位 SHA-256。');
  if (declared?.fingerprint !== actual.fingerprint) errors.push('声明的 product snapshot fingerprint 与被审产品源码不一致。');
  if (declared?.file_count !== actual.file_count) errors.push('声明的 product snapshot file_count 与被审产品源码不一致。');
  if (
    verificationSnapshot?.fingerprint !== declared?.fingerprint
    || verificationSnapshot?.algorithm !== declared?.algorithm
    || verificationSnapshot?.selector !== declared?.selector
    || verificationSnapshot?.file_count !== declared?.file_count
    || verificationSnapshot?.snapshot_as_of !== declared?.snapshot_as_of
    || verificationSnapshot?.equivalent_commit !== declared?.equivalent_commit
  ) {
    errors.push('verification source 的 product snapshot 与 manifest 不一致。');
  }
  return errors;
}

/**
 * Read the synchronized integration branch and tip from the human current
 * state without making a particular historical SHA part of the checker.
 */
export function parseDeclaredIntegrationDeclarations(currentStateText, branch) {
  if (typeof currentStateText !== 'string' || typeof branch !== 'string' || branch.trim() === '') return [];
  const escaped = branch.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    {
      kind: 'committed_base_snapshot',
      pattern: new RegExp('(?:committed integration base snapshot|提交的 integration 基线快照)'
        + '\\s*(?:\\([^\\n)]*\\)|（[^\\n）]*）)?\\s*(?:为|is)?\\s*[`]?'
        + escaped + '[`]?\\s*@\\s*[`]?([0-9a-f]{40})', 'gi'),
    },
    {
      kind: 'live_tip',
      pattern: new RegExp('(?:current integration tip|当前 integration tip)\\s*(?:为|is)?\\s*[`]?'
        + escaped + '[`]?\\s*@\\s*[`]?([0-9a-f]{40})', 'gi'),
    },
  ];
  return patterns.flatMap(({ kind, pattern }) => [...currentStateText.matchAll(pattern)].map((match) => ({
    kind,
    tip: match[1].toLowerCase(),
    index: match.index ?? 0,
  }))).sort((left, right) => left.index - right.index);
}

export function parseDeclaredIntegrationDeclaration(currentStateText, branch) {
  return parseDeclaredIntegrationDeclarations(currentStateText, branch)[0] ?? null;
}

export function parseDeclaredIntegrationTip(currentStateText, branch) {
  return parseDeclaredIntegrationDeclaration(currentStateText, branch)?.tip ?? null;
}

export function integrationTipDeclarationErrors({ manifestTip, currentStateText, branch, declarationKind }) {
  const errors = [];
  const normalizedManifestTip = typeof manifestTip === 'string' ? manifestTip.toLowerCase() : manifestTip;
  const declarations = parseDeclaredIntegrationDeclarations(currentStateText, branch);
  const parsedDeclaration = declarations[0] ?? null;
  const expectedKind = declarationKind ?? parsedDeclaration?.kind ?? null;
  if (!FULL_SHA.test(String(manifestTip ?? ''))) {
    errors.push('manifest current_state.committed_integration_base 必须是完整 40 位 commit SHA。');
  }
  if (!INTEGRATION_DECLARATION_KINDS.has(expectedKind)) {
    errors.push('manifest current_state.integration_declaration_kind 必须是 committed_base_snapshot 或 live_tip。');
  }
  if (declarations.length === 0) {
    errors.push('docs/current-state 必须包含完整 40 位 integration 声明。');
  } else if (declarations.length > 1) {
    errors.push('docs/current-state 只能包含一个受控 integration 声明。');
  }
  if (parsedDeclaration && INTEGRATION_DECLARATION_KINDS.has(expectedKind) && parsedDeclaration.kind !== expectedKind) {
    errors.push(`docs/current-state integration 声明必须是 ${expectedKind}，不能是 ${parsedDeclaration.kind}。`);
  }
  if (FULL_SHA.test(String(manifestTip ?? '')) && parsedDeclaration && normalizedManifestTip !== parsedDeclaration.tip) {
    errors.push('manifest 与 docs/current-state 的 integration 声明必须一致。');
  }
  return {
    errors,
    parsedCurrentStateTip: parsedDeclaration?.tip ?? null,
    parsedDeclarationKind: parsedDeclaration?.kind ?? null,
  };
}

/**
 * Resolve the live integration tip from the supplied Git/CI provenance.
 * `baseArg` is the exact pull-request base when docs-check runs in CI;
 * otherwise origin/<branch> (then the local branch) is used.  A stale
 * synchronized baseline is intentionally not treated as the live ref.
 */
export function resolveLiveIntegrationTip({ branch, declaredTip, declarationKind = 'live_tip', baseArg, baseRef, headRef, env = {}, git, requireDeclaredMatch = false }) {
  if (typeof branch !== 'string' || branch.trim() === '') throw new Error('integration branch is required');
  if (typeof git !== 'function') throw new Error('Git resolver is unavailable');
  if (!INTEGRATION_DECLARATION_KINDS.has(declarationKind)) throw new Error('integration declaration kind is unsupported');
  const explicit = baseArg || env.DOCS_CHECK_BASE || env.CI_BASE_SHA;
  const resolveCandidate = (candidate) => {
    try {
      const sha = String(git(['rev-parse', `${candidate}^{commit}`])).trim().toLowerCase();
      return FULL_SHA.test(sha) ? sha : null;
    } catch {
      return null;
    }
  };
  let resolved;
  let selected;
  let stackedBase = null;
  if (explicit) {
    resolved = resolveCandidate(explicit);
    selected = explicit;
    if (!resolved) throw new Error(`cannot resolve live integration tip for ${branch}`);
    const liveBranchRef = resolveCandidate(`origin/${branch}`) ?? resolveCandidate(branch);
    if (liveBranchRef && liveBranchRef !== resolved) {
      const stackedRef = typeof baseRef === 'string' ? baseRef.trim() : '';
      const stackedHeadRef = typeof headRef === 'string' ? headRef.trim() : '';
      const stackedRefAllowed = branch === INTEGRATION_BRANCH
        && /^agent\/issue-\d+(?:-|$)/.test(stackedRef)
        && stackedRef !== branch
        && stackedRef !== stackedHeadRef
        && resolveCandidate(`origin/${stackedRef}`) === resolved;
      if (!stackedRefAllowed) throw new Error(`integration provenance ${resolved} does not match live ${branch} tip ${liveBranchRef}`);
      // A stacked PR compares changed paths against its parent branch while
      // still proving the independent live integration tip.
      resolved = liveBranchRef;
      selected = `origin/${branch}`;
      stackedBase = { ref: stackedRef, commit: explicit };
    }
  } else {
    for (const candidate of [`origin/${branch}`, branch]) {
      resolved = resolveCandidate(candidate);
      if (resolved) {
        selected = candidate;
        break;
      }
    }
  }
  if (!resolved) throw new Error(`cannot resolve live integration tip for ${branch}`);
  if (explicit && !FULL_SHA.test(String(explicit))) throw new Error('CI/base provenance must be a full 40-hex commit SHA');
  if (declaredTip !== undefined && declaredTip !== null && declaredTip !== '' && !FULL_SHA.test(String(declaredTip))) {
    throw new Error('declared integration tip must be a full 40-hex commit SHA');
  }
  const normalizedDeclaredTip = declaredTip?.toLowerCase() ?? null;
  const isExactIntegrationPushMergeParent = () => {
    if (explicit || declarationKind !== 'committed_base_snapshot' || !normalizedDeclaredTip) return false;
    const eventName = env.GITHUB_EVENT_NAME ?? env.CI_EVENT_NAME;
    const refName = env.GITHUB_REF_NAME ?? env.CI_BRANCH;
    const eventSha = env.GITHUB_SHA ?? env.CI_MERGE_SHA;
    if (eventName !== 'push' || branch !== INTEGRATION_BRANCH || refName !== branch || !FULL_SHA.test(String(eventSha ?? ''))) return false;
    if (String(eventSha).toLowerCase() !== resolved) return false;
    if (resolveCandidate('HEAD') !== resolved) return false;
    try {
      const ancestry = String(git(['rev-list', '--parents', '-n', '1', resolved])).trim().toLowerCase().split(/\s+/);
      if (ancestry.length !== 3 || ancestry.some((token) => !FULL_SHA.test(token)) || ancestry[0] !== resolved || ancestry[1] !== normalizedDeclaredTip) return false;
      const approvedHead = String(env.CI_APPROVED_PR_HEAD_SHA ?? env.GITHUB_PR_HEAD_SHA ?? '').trim().toLowerCase();
      if (!FULL_SHA.test(approvedHead) || ancestry[2] !== approvedHead) return false;
      for (const parent of ancestry.slice(0, 3)) git(['cat-file', '-e', `${parent}^{commit}`]);
      const mergeTree = String(git(['show', '-s', '--format=%T', resolved])).trim().toLowerCase();
      const recomputedTree = String(git(['merge-tree', '--write-tree', ancestry[1], ancestry[2]])).trim().toLowerCase();
      if (!FULL_SHA.test(mergeTree) || !FULL_SHA.test(recomputedTree) || mergeTree !== recomputedTree) return false;
      return {
        secondParent: ancestry[2],
        approvedPrHead: approvedHead,
        tree: mergeTree,
        mergeTree: recomputedTree,
      };
    } catch {
      return false;
    }
  };
  const mergeDetails = resolved === normalizedDeclaredTip ? null : isExactIntegrationPushMergeParent();
  const declaredMatch = resolved === normalizedDeclaredTip
    ? 'exact'
    : mergeDetails
      ? 'integration_push_merge_first_parent'
      : null;
  if (requireDeclaredMatch && !FULL_SHA.test(String(declaredTip ?? ''))) {
    throw new Error('declared integration tip is required for strict matching');
  }
  if (requireDeclaredMatch && !declaredMatch) {
    throw new Error(`declared integration tip ${declaredTip} does not match live tip ${resolved}`);
  }
  return {
    branch,
    ref: selected,
    tip: resolved,
    declaredTip: normalizedDeclaredTip,
    declaredMatch,
    stackedBase,
    ...(mergeDetails ?? {}),
  };
}
