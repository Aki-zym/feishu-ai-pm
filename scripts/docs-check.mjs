import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attainedLevelLabel,
  computeProductFingerprint,
  decodeMarkdownTarget,
  evidenceRecordErrors,
  evidenceStatusLabel,
  isProductSourcePath,
  realEvidenceLabel,
  resolveRepoPath,
  resolveLiveIntegrationTip,
  integrationTipDeclarationErrors,
  snapshotDeclarationErrors,
} from './docs-check-policy.mjs';
import { evidenceRecordContractErrors } from './evidence-record-policy.mjs';
import { selectionPolicyErrors } from './ci-selection-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const write = args.includes('--write');
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1] : process.env.DOCS_CHECK_BASE;
const errors = [];
let integrationFreshness = null;

if (baseIndex >= 0 && !base) errors.push('--base 需要一个 Git commit。');

const posix = (value) => value.split(sep).join('/');
const addError = (message) => errors.push(message);
const safePath = (file, options = {}) => {
  try {
    return resolveRepoPath(root, file, options);
  } catch (error) {
    const label = typeof file === 'string' && !isAbsolute(file) ? file : '<declared path>';
    addError(`${label}: ${error.message}。`);
    return null;
  }
};
const readText = (file) => {
  const path = safePath(file);
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    addError(`${file}: 无法读取。`);
    return '';
  }
};
const readJson = (file) => {
  const content = readText(file);
  if (!content) return {};
  try {
    return JSON.parse(content);
  } catch {
    addError(`${file}: JSON 无法解析。`);
    return {};
  }
};
const runGit = (gitArgs) => execFileSync('git', gitArgs, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const runGitBytes = (gitArgs) => execFileSync('git', gitArgs, {
  cwd: root,
  encoding: null,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const gitPathList = (gitArgs) => runGitBytes([...gitArgs, '-z']).toString('utf8').split('\0').filter(Boolean).map(posix);
const isCommit = (value) => /^[0-9a-f]{40}$/i.test(value);
const isSha256 = (value) => /^[0-9a-f]{64}$/i.test(value);
const escapeCell = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', '<br>');

const stableJson = (value) => {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  return value;
};

const manifest = readJson('docs/docs-manifest.json');
const verification = readJson(manifest.verification_source);
const entrypoints = Array.isArray(manifest.entrypoints) ? manifest.entrypoints : [];
const historyLocations = Array.isArray(manifest.history_locations) ? manifest.history_locations : [];
const changedPathRules = Array.isArray(manifest.changed_path_impact) ? manifest.changed_path_impact : [];

function worktreeProductSnapshot() {
  const paths = gitPathList(['ls-files', '--cached', '--others', '--exclude-standard']);
  return computeProductFingerprint(paths, (file) => {
    const path = safePath(file);
    return path ? readFileSync(path) : Buffer.alloc(0);
  }, (file) => runGit(['hash-object', '--filters', `--path=${file}`, file]));
}

function commitProductSnapshot(commit) {
  const paths = gitPathList(['ls-tree', '-r', '--name-only', commit]);
  return computeProductFingerprint(
    paths,
    (file) => runGitBytes(['show', `${commit}:${file}`]),
    (file) => runGit(['rev-parse', `${commit}:${file}`]),
  );
}

function validateManifest() {
  if (manifest.schema_version !== 2) addError('docs/docs-manifest.json: 不支持的 schema_version。');
  if (!Array.isArray(manifest.entrypoints)) addError('docs/docs-manifest.json: entrypoints 必须是数组。');
  if (!Array.isArray(manifest.history_locations)) addError('docs/docs-manifest.json: history_locations 必须是数组。');
  if (!Array.isArray(manifest.changed_path_impact)) addError('docs/docs-manifest.json: changed_path_impact 必须是数组。');
  for (const key of ['canonical_current_state', 'project_map', 'verification_source', 'verification_view', 'test_selection_source', 'agent_test_sop']) {
    if (!manifest[key]) addError(`docs/docs-manifest.json: 缺少 ${key}。`);
    else safePath(manifest[key]);
  }
  for (const entrypoint of entrypoints) {
    const entryPath = safePath(entrypoint);
    if (!entryPath) continue;
    const targets = localMarkdownTargets(entrypoint, readFileSync(entryPath, 'utf8'));
    if (!targets.includes(manifest.canonical_current_state)) {
      addError(`${entrypoint}: 必须链接唯一当前状态 ${manifest.canonical_current_state}。`);
    }
  }
  for (const historyPath of historyLocations) {
    safePath(historyPath, { kind: 'any' });
  }
  const state = manifest.current_state ?? {};
  const snapshot = manifest.product_snapshot ?? {};
  if (state.audit_snapshot_as_of !== '2026-08-14') {
    addError('docs/docs-manifest.json: current_state.audit_snapshot_as_of 必须保留首次审计日期 2026-08-14。');
  }
  if (state.combination_snapshot_as_of !== '2026-08-15') {
    addError('docs/docs-manifest.json: current_state.combination_snapshot_as_of 必须是本次组合重基线日期 2026-08-15。');
  }
  if (state.combination_base !== 'integration/m1-test-20260815') {
    addError('docs/docs-manifest.json: current_state.combination_base 必须指向本次组合基线 integration/m1-test-20260815。');
  }
  const branch = state.combination_base;
  const declaredTip = state.committed_integration_base;
  const declarationKind = state.integration_declaration_kind;
  const currentStateText = readText(manifest.canonical_current_state);
  const tipDeclaration = integrationTipDeclarationErrors({ manifestTip: declaredTip, currentStateText, branch, declarationKind });
  for (const error of tipDeclaration.errors) addError(`integration tip declaration: ${error}`);
  const parsedTip = tipDeclaration.parsedCurrentStateTip;
  try {
    const live = resolveLiveIntegrationTip({ branch, declaredTip, declarationKind, baseArg: base, env: process.env, git: runGit, requireDeclaredMatch: true });
    integrationFreshness = {
      branch,
      declared_tip: declaredTip,
      declaration_kind: declarationKind,
      live_tip: live.tip,
      declared_match: live.declaredMatch,
      second_parent: live.secondParent ?? null,
      approved_pr_head: live.approvedPrHead ?? null,
      merge_tree: live.mergeTree ?? null,
      tree: live.tree ?? null,
      event: process.env.GITHUB_EVENT_NAME ?? process.env.CI_EVENT_NAME ?? null,
      ref: process.env.GITHUB_REF_NAME ?? process.env.CI_BRANCH ?? null,
    };
    if (base && live.tip !== String(base).toLowerCase()) addError(`integration provenance: base ${base} 解析为 ${live.tip}，声明不一致。`);
  } catch (error) {
    addError(`integration provenance: ${error.message}。`);
  }
  const milestones = manifest.historical_milestones;
  if (!Array.isArray(milestones) || milestones.length === 0) {
    addError('docs/docs-manifest.json: historical_milestones 必须是非空数组。');
  } else {
    const ids = new Set();
    for (const milestone of milestones) {
      if (!milestone || typeof milestone !== 'object' || Array.isArray(milestone)) {
        addError('docs/docs-manifest.json: historical_milestones 每项必须是对象。');
        continue;
      }
      const allowed = new Set(['id', 'kind', 'branch', 'commit', 'status', 'source']);
      for (const key of Object.keys(milestone)) if (!allowed.has(key)) addError(`historical_milestones.${milestone.id ?? '<missing>'}.${key} 不是受控字段。`);
      if (typeof milestone.id !== 'string' || milestone.id.trim() === '' || ids.has(milestone.id)) addError('historical_milestones.id 必须非空且不可重复。');
      ids.add(milestone.id);
      if (typeof milestone.kind !== 'string' || milestone.kind.trim() === '') addError(`historical_milestones.${milestone.id}: kind 必须非空。`);
      if (typeof milestone.status !== 'string' || milestone.status !== 'historical') addError(`historical_milestones.${milestone.id}: status 必须是 historical。`);
      if (milestone.branch !== undefined && typeof milestone.branch !== 'string') addError(`historical_milestones.${milestone.id}: branch 必须是字符串。`);
      if (milestone.commit !== undefined && !isCommit(milestone.commit)) addError(`historical_milestones.${milestone.id}: commit 必须是 40 位 SHA。`);
      if (typeof milestone.source !== 'string' || milestone.source.trim() === '') addError(`historical_milestones.${milestone.id}: source 必须非空。`);
    }
  }
  if (snapshot.snapshot_as_of !== state.combination_snapshot_as_of) {
    addError('docs/docs-manifest.json: product_snapshot.snapshot_as_of 必须与组合重基线日期一致。');
  }
  if (snapshot.equivalent_commit !== null && snapshot.equivalent_commit !== undefined && !isCommit(snapshot.equivalent_commit)) {
    addError('docs/docs-manifest.json: product_snapshot.equivalent_commit 必须是 40 位 commit。');
  }
  let actualSnapshot = { algorithm: '', fingerprint: '', file_count: -1 };
  try {
    actualSnapshot = worktreeProductSnapshot();
  } catch {
    addError('docs/docs-manifest.json: 无法计算被审工作树的产品源码 fingerprint。');
  }
  for (const error of snapshotDeclarationErrors(snapshot, actualSnapshot, verification.product_snapshot)) {
    addError(`docs/docs-manifest.json: ${error}`);
  }
  if (isCommit(snapshot.equivalent_commit)) {
    let referenceAvailable = true;
    try {
      runGit(['cat-file', '-e', `${snapshot.equivalent_commit}^{commit}`]);
    } catch {
      referenceAvailable = false;
    }
    if (referenceAvailable) {
      try {
        const referenceSnapshot = commitProductSnapshot(snapshot.equivalent_commit);
        if (referenceSnapshot.fingerprint !== snapshot.fingerprint) {
          addError('docs/docs-manifest.json: equivalent_commit 与声明的产品源码 fingerprint 不等价。');
        }
      } catch {
        addError('docs/docs-manifest.json: 无法计算 equivalent_commit 的产品源码 fingerprint。');
      }
    }
    // Squash/merge 后参照 commit 可能不在本地对象库；fingerprint 仍是强制事实源。
  }
  const currentText = readText(manifest.canonical_current_state);
  for (const [key, value] of Object.entries(state)) {
    if (!value || !currentText.includes(String(value))) {
      addError(`${manifest.canonical_current_state}: 未同步 manifest.current_state.${key}。`);
    }
  }
  for (const value of [snapshot.algorithm, snapshot.selector, snapshot.fingerprint, snapshot.file_count, snapshot.snapshot_as_of, ...(snapshot.equivalent_commit ? [snapshot.equivalent_commit] : [])]) {
    if (!value || !currentText.includes(String(value))) addError(`${manifest.canonical_current_state}: 未同步 product snapshot ${value ?? '<missing>'}。`);
  }
  const rootPackage = readJson('package.json');
  if (state.product_version !== rootPackage.version) {
    addError(`docs/docs-manifest.json: 产品版本 ${state.product_version} 与 package.json ${rootPackage.version} 不一致。`);
  }
}

function changedVerificationRecordIds() {
  if (!base) return new Set();
  try {
    const baseline = JSON.parse(runGit(['show', `${base}:${manifest.verification_source}`]));
    const baselineRecords = new Map((Array.isArray(baseline.records) ? baseline.records : []).filter((record) => record && typeof record === 'object' && typeof record.id === 'string').map((record) => [record.id, JSON.stringify(stableJson(record))]));
    const changed = new Set();
    for (const record of Array.isArray(verification.records) ? verification.records : []) {
      if (!record || typeof record !== 'object' || typeof record.id !== 'string' || baselineRecords.get(record.id) !== JSON.stringify(stableJson(record))) changed.add(record?.id);
    }
    return changed;
  } catch {
    addError(`${manifest.verification_source}: 无法读取 base ${base} 的验证记录；不能安全 grandfather 历史记录。`);
    return new Set((Array.isArray(verification.records) ? verification.records : []).map((record) => record?.id).filter(Boolean));
  }
}

function validateVerification() {
  if (verification.schema_version !== 2) addError(`${manifest.verification_source}: 不支持的 schema_version。`);
  const levels = Array.isArray(verification.levels) ? verification.levels : [];
  const records = Array.isArray(verification.records) ? verification.records : [];
  if (!Array.isArray(verification.levels)) addError(`${manifest.verification_source}: levels 必须是数组。`);
  if (!Array.isArray(verification.records)) addError(`${manifest.verification_source}: records 必须是数组。`);
  const levelIds = new Set(levels.filter((item) => item && typeof item === 'object').map((item) => item.id));
  const expectedLevels = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
  if (expectedLevels.some((id) => !levelIds.has(id)) || levelIds.size !== expectedLevels.length || levels.length !== expectedLevels.length) {
    addError(`${manifest.verification_source}: 必须且只能定义 L0-L6。`);
  }
  const selectionPolicy = verification.selection_policy;
  if (!selectionPolicy || selectionPolicy.schema_version !== 1 || !Array.isArray(selectionPolicy.path_rules) || !selectionPolicy.categories) {
    addError(`${manifest.verification_source}: 缺少 schema_version=1 的 selection_policy。`);
  } else {
    for (const error of selectionPolicyErrors(selectionPolicy)) addError(`${manifest.verification_source}: ${error}`);
  }
  const evidenceContract = verification.evidence_contract;
  if (!evidenceContract || evidenceContract.schema_version !== 1 || !evidenceContract.provenance_modes || !Array.isArray(evidenceContract.skip_kinds)) {
    addError(`${manifest.verification_source}: 缺少 schema_version=1 的 evidence_contract。`);
  }
  const ids = new Set();
  const changedRecordIds = changedVerificationRecordIds();
  const required = [
    'id', 'capability', 'implementation_state', 'target_level', 'attained_level', 'evidence_status', 'evidence_type', 'scope',
    'source_commit', 'record_commit', 'run_id', 'run_at', 'environment',
    'command_or_scenario', 'result', 'skips', 'target_real_scope', 'real_environment_attained', 'evidence_path', 'limitations',
  ];
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      addError(`${manifest.verification_source}: record 必须是对象。`);
      continue;
    }
    if (ids.has(record.id)) addError(`${manifest.verification_source}: 重复验证 ID ${record.id}。`);
    ids.add(record.id);
    for (const key of required) {
      if (record[key] === undefined || (record[key] === null && key !== 'attained_level') || record[key] === '') {
        addError(`${record.id}: 缺少字段 ${key}。`);
      }
    }
    for (const error of evidenceRecordErrors(record, levelIds)) addError(`${record.id}: ${error}`);
    const changed = changedRecordIds.has(record.id);
    for (const error of evidenceRecordContractErrors(record, {
      requireProvenance: changed,
      grandfathered: !changed,
      git: (gitArgs) => runGit(gitArgs),
    })) addError(`${record.id}: ${error}`);
    if (['attained', 'artifact_integrity_only'].includes(record.evidence_status) && isCommit(record.source_commit)) {
      try {
        runGit(['cat-file', '-e', `${record.source_commit}^{commit}`]);
      } catch {
        addError(`${record.id}: source_commit 在 Git 中不存在。`);
      }
    }
    if (isCommit(record.record_commit)) {
      try {
        runGit(['cat-file', '-e', `${record.record_commit}^{commit}`]);
      } catch {
        addError(`${record.id}: record_commit 在 Git 中不存在。`);
      }
    }
    if (record.artifact) validateArtifact(record);
    safePath(record.evidence_path);
  }

  const currentState = readText(manifest.canonical_current_state);
  for (const id of ids) {
    if (!currentState.includes(`\`${id}\``)) addError(`${manifest.canonical_current_state}: 必须引用验证 ID ${id}。`);
  }
}

function validateArtifact(record) {
  const artifact = record.artifact;
  if (!isCommit(record.source_commit)) addError(`${record.id}: 产物必须绑定 40 位 source_commit。`);
  if (!isSha256(artifact.sha256)) {
    addError(`${record.id}: 产物必须提供 64 位 SHA-256。`);
    return;
  }
  if (!Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes <= 0) {
    addError(`${record.id}: 产物必须提供正整数 size_bytes。`);
    return;
  }
  const artifactPath = safePath(artifact.path);
  if (!artifactPath) return;
  const artifactBytes = readFileSync(artifactPath);
  const pointerText = artifactBytes.length < 1024
    ? artifactBytes.toString('utf8').replace(/\r\n/g, '\n')
    : '';
  const lfsPointer = pointerText.match(
    /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n?$/i,
  );

  if (lfsPointer) {
    const [, pointerHash, pointerSize] = lfsPointer;
    if (Number(pointerSize) !== artifact.size_bytes) {
      addError(`${record.id}: Git LFS 指针大小不一致，manifest=${artifact.size_bytes} pointer=${pointerSize}。`);
    }
    if (pointerHash.toUpperCase() !== artifact.sha256.toUpperCase()) {
      addError(`${record.id}: Git LFS 指针 SHA-256 不一致。`);
    }
  } else {
    const size = statSync(artifactPath).size;
    if (size !== artifact.size_bytes) addError(`${record.id}: 产物大小不一致，manifest=${artifact.size_bytes} actual=${size}。`);
    const actualHash = createHash('sha256').update(artifactBytes).digest('hex').toUpperCase();
    if (actualHash !== artifact.sha256.toUpperCase()) addError(`${record.id}: 产物 SHA-256 不一致。`);
  }

  const rootPackage = readJson('package.json');
  const desktopPackage = readJson('apps/desktop/package.json');
  if (rootPackage.version !== desktopPackage.version) addError(`${record.id}: 根版本与 desktop 版本不一致。`);
  if (!artifact.path.includes(rootPackage.version)) addError(`${record.id}: 产物文件名未包含当前产品版本 ${rootPackage.version}。`);

  const latest = readText('release/latest.yml');
  if (!latest.includes(`version: ${rootPackage.version}`)) addError(`${record.id}: release/latest.yml 版本不一致。`);
  if (!latest.includes(`size: ${artifact.size_bytes}`)) addError(`${record.id}: release/latest.yml 大小不一致。`);
}

function localMarkdownTargets(sourceFile, content) {
  const targets = [];
  let fenced = false;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const regex = /\[[^\]]+\]\(([^)]+)\)/g;
    for (const match of line.matchAll(regex)) {
      let target = match[1].trim().replace(/^<|>$/g, '');
      if (!target || target.startsWith('#') || /^(https?:|mailto:)/i.test(target)) continue;
      const decoded = decodeMarkdownTarget(target.split('#')[0].split('?')[0]);
      if (decoded.error) {
        addError(`${sourceFile}:${index + 1}: ${decoded.error}。`);
        continue;
      }
      target = decoded.value;
      const resolved = posix(relative(root, resolve(root, dirname(sourceFile), target)));
      if (resolved === '..' || resolved.startsWith('../')) {
        addError(`${sourceFile}:${index + 1}: 本地链接不得指向仓库外。`);
        continue;
      }
      targets.push(resolved);
    }
  }
  return targets;
}

function validateLinks() {
  const tracked = new Set(runGit(['ls-files']).split(/\r?\n/).filter(Boolean).map(posix));
  const markdown = [...tracked].filter((file) => file.endsWith('.md'));
  for (const file of markdown) {
    const content = readText(file);
    for (const target of localMarkdownTargets(file, content)) {
      const targetPath = safePath(target, { kind: 'any' });
      if (!targetPath || (!tracked.has(target) && !existsSync(targetPath))) {
        addError(`${file}: 本地链接目标不存在：${target}`);
      }
    }
  }
}

function validateEntrypointWording() {
  const forbidden = [
    [/^## 当前阶段\s*$/m, '不要复制“当前阶段”段落'],
    [/当前源码分支/, '不要写“当前源码分支”'],
    [/\b\d+ passed\b/i, '不要复制历史测试数字'],
    [/SHA-256[^\n]*[A-F0-9]{64}/i, '不要复制安装包 hash'],
    [/当前 Issue #\d+/i, '不要复制易过期的当前 Issue'],
  ];
  for (const entrypoint of entrypoints) {
    const content = readText(entrypoint);
    for (const [pattern, message] of forbidden) {
      if (pattern.test(content)) addError(`${entrypoint}: ${message}；请引用 ${manifest.canonical_current_state}。`);
    }
  }
}

function changedFiles() {
  const files = new Set();
  if (base) {
    try {
      runGit(['cat-file', '-e', `${base}^{commit}`]);
      for (const file of runGit(['diff', '--name-only', '--diff-filter=ACMRT', `${base}...HEAD`]).split(/\r?\n/)) {
        if (file) files.add(posix(file));
      }
    } catch {
      addError(`changed-path: base commit 不存在：${base}`);
    }
  }
  for (const diffArgs of [
    ['diff', '--name-only', '--diff-filter=ACMRT'],
    ['diff', '--cached', '--name-only', '--diff-filter=ACMRT'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    for (const file of runGit(diffArgs).split(/\r?\n/)) {
      if (file) files.add(posix(file));
    }
  }
  return files;
}

function validateChangedPathImpact() {
  const changed = changedFiles();
  for (const rule of changedPathRules) {
    if (!rule || typeof rule !== 'object') {
      addError('changed-path: rule 必须是对象。');
      continue;
    }
    let matched;
    if (rule.selector === 'product_source') {
      matched = [...changed].filter(isProductSourcePath);
    } else {
      let pattern;
      try {
        pattern = new RegExp(rule.pattern);
      } catch {
        addError(`changed-path ${rule.id ?? '<missing id>'}: pattern 无法解析。`);
        continue;
      }
      matched = [...changed].filter((file) => pattern.test(file));
    }
    if (!matched.length) continue;
    const requiresAll = Array.isArray(rule.requires_all) ? rule.requires_all : [];
    const requiresAny = Array.isArray(rule.requires_any) ? rule.requires_any : [];
    if (rule.requires_all !== undefined && !Array.isArray(rule.requires_all)) addError(`changed-path ${rule.id}: requires_all 必须是数组。`);
    if (rule.requires_any !== undefined && !Array.isArray(rule.requires_any)) addError(`changed-path ${rule.id}: requires_any 必须是数组。`);
    const missingAll = requiresAll.filter((file) => !changed.has(file));
    if (missingAll.length) {
      addError(`changed-path ${rule.id}: ${matched.join(', ')} 变化时必须同步 ${missingAll.join(' / ')}。`);
    }
    if (!requiresAny.some((file) => changed.has(file))) {
      if (requiresAny.length) addError(`changed-path ${rule.id}: ${matched.join(', ')} 变化时至少同步 ${requiresAny.join(' / ')}。`);
    }
  }
}

function renderVerification() {
  const levels = Array.isArray(verification.levels) ? verification.levels : [];
  const records = Array.isArray(verification.records) ? verification.records : [];
  const lines = [
    '<!-- 此文件由 scripts/docs-check.mjs --write 根据 verification-matrix.json 生成。不要手工修改。 -->',
    '',
    '# 验证矩阵',
    '',
    `机器事实源：[\`${manifest.verification_source}\`](verification-matrix.json)。当前产品状态见 [当前状态](current-state.md)。`,
    `产品源码快照：日期 \`${verification.product_snapshot?.snapshot_as_of}\`；等价 commit \`${verification.product_snapshot?.equivalent_commit}\`；算法 \`${verification.product_snapshot?.algorithm}\`；选择器 \`${verification.product_snapshot?.selector}\`；文件数 \`${verification.product_snapshot?.file_count}\`；fingerprint \`${verification.product_snapshot?.fingerprint}\`。`,
    '',
    '## L0–L6',
    '',
    `层级定义沿用 ${verification.level_source}，低层级不能替代高层级。`,
    '',
    '| 层级 | 名称 | 环境 | 不能证明 |',
    '|---|---|---|---|',
    ...levels.map((level) => `| ${escapeCell(level.id)} | ${escapeCell(level.name)} | ${escapeCell(level.environment)} | ${escapeCell(level.cannot_prove)} |`),
    '',
    '## Changed-path 选择门禁',
    '',
    '以下规则来自 `verification-matrix.json.selection_policy`，是 CI 选层的唯一机器事实源；unknown、mixed 和 high-risk path 一律 fail-closed，且不能直接授权 broad claim。',
    '',
    '| category | minimum level | risk | required evidence | manual review |',
    '|---|---|---|---|---|',
    ...Object.entries(verification.selection_policy?.categories ?? {}).map(([category, policy]) => `| ${escapeCell(category)} | ${escapeCell(policy.minimum_level)} | ${escapeCell(policy.risk)} | ${escapeCell((policy.required_evidence ?? []).join(', '))} | ${policy.manual_review_required === true ? 'yes' : 'no'} |`),
    '',
    'Path category precedence：docs → release → Feishu/LLM integration → test/CI → web → desktop → server/data/runtime → unknown。空 diff、绝对路径、父目录逃逸和无法识别路径不属于 docs-only。',
    '',
    '## Skip 与 provenance 合同',
    '',
    `证据记录合同 schema ${verification.evidence_contract?.schema_version ?? '<missing>'}：${escapeCell(verification.evidence_contract?.record_rule ?? '<missing>')}`,
    '',
    '| skip kind | 语义 |',
    '|---|---|',
    ...Object.entries(verification.selection_policy?.skip_semantics ?? {}).map(([kind, meaning]) => `| ${escapeCell(kind)} | ${escapeCell(meaning)} |`),
    '',
    '## 当前证据索引',
    '',
    '| 验证 ID | 能力 | 目标层级 | 已取得层级 | 证据状态 | Evidence type | Source commit | Run | 真实环境证据 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...records.map((record) => `| ${escapeCell(record.id)} | ${escapeCell(record.capability)} | ${escapeCell(record.target_level)} | ${escapeCell(attainedLevelLabel(record))} | ${escapeCell(evidenceStatusLabel(record.evidence_status))} | ${escapeCell(record.evidence_type)} | ${escapeCell(record.source_commit)} | ${escapeCell(record.run_id)} | ${escapeCell(realEvidenceLabel(record))} |`),
    '',
    '## 证据详情',
    '',
  ];
  for (const record of records) {
    lines.push(
      `### ${record.id}`,
      '',
      `- 能力：${record.capability}`,
      `- 实现状态：\`${record.implementation_state}\``,
      `- 目标层级：\`${record.target_level}\`；已取得层级：\`${attainedLevelLabel(record)}\``,
      `- 证据状态：\`${record.evidence_status}\`（${evidenceStatusLabel(record.evidence_status)}）`,
      `- 目标真实范围：${record.target_real_scope ? '是' : '否'}；真实环境证据：${realEvidenceLabel(record)}；scope：\`${record.scope}\``,
      `- Evidence type：\`${record.evidence_type}\``,
      `- Source commit：\`${record.source_commit}\`；记录 commit：\`${record.record_commit}\``,
      ...(record.provenance ? [`- Provenance：mode=\`${record.provenance.mode}\`；base=\`${record.provenance.base_commit}\`；head=\`${record.provenance.head_commit}\`；merge=\`${record.provenance.merge_ref}\`；parents=\`${(record.provenance.parents ?? []).join(', ')}\`；tree=\`${record.provenance.tree}\`；run=\`${record.provenance.run_id}\`；job=\`${record.provenance.job_id}\`；environment=${record.provenance.environment}`] : []),
      ...(record.skip_classification ? [`- Skip classification：status=\`${record.skip_classification.status}\`；kinds=\`${(record.skip_classification.kinds ?? []).join(', ')}\`；reason=${record.skip_classification.reason}`] : []),
      `- Run：\`${record.run_id}\`；时间：${record.run_at}；环境：${record.environment}`,
      `- 命令或场景：${record.command_or_scenario}`,
      `- 结果：\`${record.result}\`；skips：${record.skips}`,
      `- Evidence path：\`${record.evidence_path}\``,
      `- 限制 / 未验证：${record.limitations}`,
    );
    if (record.artifact) {
      lines.push(
        `- Artifact：\`${record.artifact.path}\`，${record.artifact.size_bytes} bytes，SHA-256 \`${record.artifact.sha256}\``,
        `- 产物状态：${record.artifact.architecture}；签名 ${record.artifact.signature}；仓库分发 ${record.artifact.repository_distribution}；GitHub Release ${record.artifact.github_release}`,
      );
    }
    lines.push('');
  }
  lines.push(
    '## 使用规则',
    '',
    '- “目标层级”只表示计划达到哪里；只有“已取得层级”和“证据状态”才能说明已经得到什么证据。',
    '- `not_run` 明确表示未取得证据；`historical_documented_claim` 只是历史声明、未独立复验，二者都不能显示为真实环境证据已取得。',
    '- Artifact 的 hash 只证明该产物的完整性或身份；没有绑定该精确 hash 的实际 Windows 安装运行，不能显示为已取得 L5 Smoke。',
    '- Mock、契约、回放、浏览器 E2E、构建产物和旧包 Smoke 均不能写成 L6 真实连接验证。',
    '- 安装包必须以精确 hash 关联 Smoke；同名版本的其他 hash 不能互相替代。',
    '- 历史测试数字保留在 CHANGELOG / QA；入口文档只引用验证 ID。',
  );
  return `${lines.join('\n')}\n`;
}

function validateGeneratedView() {
  if (errors.length) return;
  const generated = renderVerification();
  const viewPath = safePath(manifest.verification_view, { forWrite: write });
  if (!viewPath) return;
  if (write) {
    writeFileSync(viewPath, generated, 'utf8');
  } else if (readFileSync(viewPath, 'utf8').replaceAll('\r\n', '\n') !== generated) {
    addError(`${manifest.verification_view}: 与 ${manifest.verification_source} 不一致；运行 npm run docs:generate。`);
  }
}

validateManifest();
validateVerification();
validateLinks();
validateEntrypointWording();
validateChangedPathImpact();
validateGeneratedView();
if (errors.length) {
  console.error(`docs:check 失败（${errors.length} 项）：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

if (integrationFreshness) {
  mkdirSync(resolve(root, 'ci-artifacts'), { recursive: true });
  writeFileSync(resolve(root, 'ci-artifacts', 'integration-provenance.json'), `${JSON.stringify(integrationFreshness, null, 2)}\n`);
}
console.log(`docs:check 通过：入口、链接、manifest、验证措辞、产物和 changed-path 影响均一致${base ? `（base ${base}）` : ''}；integration freshness live_tip=${integrationFreshness?.live_tip ?? 'unavailable'} match=${integrationFreshness?.declared_match ?? 'unavailable'}。`);
