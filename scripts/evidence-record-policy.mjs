const SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const ACTIONS_ID = /^[1-9][0-9]*$/;
const SENTINEL = new Set(['not_applicable', 'not_run', 'unrecorded']);
const MODES = new Set(['exact_merge_ref_ci', 'local_run', 'not_run']);
const SKIP_KINDS = new Set(['none', 'capability', 'platform', 'not_executed']);
const PROVENANCE_KEYS = Object.freeze(new Set([
  'mode', 'base_commit', 'head_commit', 'merge_ref', 'parents', 'tree',
  'run_id', 'job_id', 'environment', 'command',
]));
const SKIP_KEYS = Object.freeze(new Set(['status', 'kinds', 'reason']));
const RECORD_KEYS = Object.freeze(new Set([
  'artifact', 'attained_level', 'capability', 'command_or_scenario', 'environment',
  'evidence_contract_version', 'evidence_path', 'evidence_status', 'evidence_type',
  'id', 'implementation_state', 'limitations', 'provenance', 'real_environment_attained',
  'record_commit', 'result', 'run_at', 'run_id', 'scope', 'skip_classification',
  'skips', 'source_commit', 'target_level', 'target_real_scope',
]));
const ARTIFACT_KEYS = Object.freeze(new Set(['architecture', 'github_release', 'path', 'repository_distribution', 'sha256', 'signature', 'size_bytes']));

const actualText = (value) => typeof value === 'string' && value.trim() !== '';
const isSha = (value) => SHA.test(value ?? '');
const normalizeText = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

function add(errors, message) {
  errors.push(message);
}

function rejectExtraKeys(value, allowed, label, errors) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) add(errors, `${label}.${key} 不是受控字段。`);
}

function gitObjectErrors(provenance, sourceCommit, git, errors) {
  if (typeof git !== 'function') return;
  const requireObject = (label, sha, type = 'commit') => {
    try {
      git(['cat-file', '-e', `${sha}^{${type}}`]);
    } catch {
      add(errors, `${label} 在当前 Git 对象库中不存在。`);
    }
  };
  requireObject('provenance.base_commit', provenance.base_commit);
  requireObject('provenance.head_commit', provenance.head_commit);
  requireObject('provenance.merge_ref', provenance.merge_ref);
  requireObject('provenance.tree', provenance.tree, 'tree');
  if (isSha(sourceCommit)) requireObject('record.source_commit', sourceCommit);
  try {
    const actualParents = git(['rev-list', '--parents', '-n', '1', provenance.merge_ref]).trim().split(/\s+/).slice(1);
    if (actualParents.length !== 2 || actualParents[0] !== provenance.base_commit || actualParents[1] !== provenance.head_commit) {
      add(errors, 'merge_ref 的实际 parents 不等于声明的 [base_commit, head_commit]。');
    }
  } catch {
    add(errors, '无法读取 merge_ref 的实际 parents。');
  }
  try {
    const actualTree = git(['show', '-s', '--format=%T', provenance.merge_ref]).trim();
    if (actualTree !== provenance.tree) add(errors, 'merge_ref 的实际 tree 不等于声明的 tree。');
  } catch {
    add(errors, '无法读取 merge_ref 的实际 tree。');
  }
}

export function provenanceErrors(provenance, {
  sourceCommit,
  recordStatus,
  recordRunId,
  recordEnvironment,
  recordCommand,
  git,
} = {}) {
  const errors = [];
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    add(errors, 'provenance 必须是对象。');
    return errors;
  }
  rejectExtraKeys(provenance, PROVENANCE_KEYS, 'provenance', errors);
  const mode = provenance.mode;
  if (!MODES.has(mode)) add(errors, `provenance.mode 必须是 ${[...MODES].join(' / ')}。`);

  if (mode === 'exact_merge_ref_ci') {
    for (const field of ['base_commit', 'head_commit', 'merge_ref', 'tree']) {
      if (!isSha(provenance[field])) add(errors, `exact_merge_ref_ci.${field} 必须是 40 位 SHA。`);
    }
    if (!Array.isArray(provenance.parents) || provenance.parents.length !== 2 || provenance.parents.some((parent) => !isSha(parent))) {
      add(errors, 'exact_merge_ref_ci.parents 必须恰好包含两个 40 位 SHA。');
    } else if (provenance.parents[0] !== provenance.base_commit || provenance.parents[1] !== provenance.head_commit) {
      add(errors, 'merge-ref parents 必须严格等于 [base_commit, head_commit]。');
    }
    if (!ACTIONS_ID.test(provenance.run_id ?? '')) add(errors, 'exact_merge_ref_ci.run_id 必须是正整数 GitHub Actions run id。');
    if (!ACTIONS_ID.test(provenance.job_id ?? '')) add(errors, 'exact_merge_ref_ci.job_id 必须是正整数 GitHub Actions job id。');
  } else {
    for (const field of ['base_commit', 'head_commit', 'merge_ref', 'tree']) {
      const value = provenance[field];
      if (value !== 'not_applicable' && value !== 'not_run' && !isSha(value)) {
        add(errors, `provenance.${field} 必须是 40 位 SHA 或明确 sentinel。`);
      }
    }
    if (!Array.isArray(provenance.parents) || provenance.parents.length !== 0) add(errors, '非 exact provenance 的 parents 必须精确为空数组。');
  }

  if (mode === 'local_run') {
    for (const field of ['base_commit', 'merge_ref', 'tree', 'job_id']) {
      if (!SENTINEL.has(provenance[field])) add(errors, `local_run 的 ${field} 必须明确标为 not_applicable/not_run/unrecorded。`);
    }
    if (!isSha(provenance.head_commit)) add(errors, 'local_run 必须绑定 40 位 head_commit。');
    if (SENTINEL.has(provenance.run_id) || !actualText(provenance.run_id)) add(errors, 'local_run.run_id 必须是实际本地运行标识。');
    if (SENTINEL.has(provenance.environment) || !actualText(provenance.environment)) add(errors, 'local_run.environment 必须是实际环境。');
    if (SENTINEL.has(provenance.command) || !actualText(provenance.command)) add(errors, 'local_run.command 必须是实际命令或场景。');
  }
  if (mode === 'not_run') {
    for (const field of ['base_commit', 'head_commit', 'merge_ref', 'tree', 'run_id', 'job_id', 'environment', 'command']) {
      if (!SENTINEL.has(provenance[field])) add(errors, `not_run 的 ${field} 必须明确标为 sentinel。`);
    }
    if (!Array.isArray(provenance.parents) || provenance.parents.length !== 0) add(errors, 'not_run 的 parents 必须为空数组。');
  }
  if (mode === 'exact_merge_ref_ci') {
    for (const field of ['run_id', 'job_id', 'environment', 'command']) {
      if (SENTINEL.has(provenance[field]) || !actualText(provenance[field])) add(errors, `exact_merge_ref_ci.${field} 必须是实际声明值，不能使用 sentinel。`);
    }
  }
  if (!actualText(provenance.run_id)) add(errors, 'provenance.run_id 不能为空。');
  if (!actualText(provenance.job_id)) add(errors, 'provenance.job_id 不能为空。');
  if (!actualText(provenance.environment)) add(errors, 'provenance.environment 不能为空。');
  if (!actualText(provenance.command)) add(errors, 'provenance.command 不能为空。');

  if (recordRunId !== undefined && provenance.run_id !== recordRunId) add(errors, 'record.run_id 必须与 provenance.run_id 一致。');
  if (recordEnvironment !== undefined && normalizeText(provenance.environment) !== normalizeText(recordEnvironment)) add(errors, 'record.environment 必须与 provenance.environment 一致。');
  if (recordCommand !== undefined && normalizeText(provenance.command) !== normalizeText(recordCommand)) add(errors, 'record.command_or_scenario 必须与 provenance.command 按空白归一化后一致。');

  if (recordStatus === 'attained') {
    if (mode === 'not_run') add(errors, 'attained 不能使用 not_run provenance。');
    if (!isSha(sourceCommit)) add(errors, 'attained 必须绑定 40 位 source_commit。');
    if (mode === 'local_run' && provenance.head_commit !== sourceCommit) add(errors, 'local_run head_commit 必须等于 source_commit。');
    if (mode === 'exact_merge_ref_ci' && provenance.head_commit !== sourceCommit) add(errors, 'attained exact evidence 的 head_commit 必须等于 source_commit。');
  }
  if (mode === 'exact_merge_ref_ci') gitObjectErrors(provenance, sourceCommit, git, errors);
  return errors;
}

export function skipClassificationErrors(skipClassification, { evidenceStatus, attainedLevel } = {}) {
  const errors = [];
  if (!skipClassification || typeof skipClassification !== 'object' || Array.isArray(skipClassification)) {
    return ['skip_classification 必须是对象。'];
  }
  rejectExtraKeys(skipClassification, SKIP_KEYS, 'skip_classification', errors);
  if (!['none', 'present'].includes(skipClassification.status)) add(errors, 'skip_classification.status 必须是 none 或 present。');
  if (!Array.isArray(skipClassification.kinds) || skipClassification.kinds.some((kind) => !SKIP_KINDS.has(kind))) {
    add(errors, 'skip_classification.kinds 只能使用 none/capability/platform/not_executed。');
  }
  const kinds = skipClassification.kinds ?? [];
  if (new Set(kinds).size !== kinds.length) add(errors, 'skip_classification.kinds 不得包含重复 kind。');
  if (skipClassification.status === 'none' && (kinds.length !== 0 || !actualText(skipClassification.reason))) {
    add(errors, '没有跳过时 kinds 必须为空且必须写 reason。');
  }
  if (skipClassification.status === 'present' && (kinds.length === 0 || kinds.includes('none') || !actualText(skipClassification.reason))) {
    add(errors, '有跳过时必须写至少一个 kind 和 reason。');
  }
  if (kinds.includes('none') && kinds.length !== 1) add(errors, 'none 不能与其他 skip kind 混用。');
  if (kinds.includes('not_executed') && evidenceStatus === 'attained') add(errors, 'not_executed 不能与 attained 证据状态组合。');
  if (kinds.includes('not_executed') && attainedLevel !== null && attainedLevel !== undefined) add(errors, 'not_executed 不能声明已取得层级。');
  return errors;
}

export function evidenceRecordContractErrors(record, { requireProvenance = false, grandfathered = true, git } = {}) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return ['record 必须是对象。'];
  }
  rejectExtraKeys(record, RECORD_KEYS, 'record', errors);
  if (record.artifact !== null && record.artifact !== undefined) {
    if (typeof record.artifact !== 'object' || Array.isArray(record.artifact)) add(errors, 'record.artifact 必须是对象或 null。');
    else rejectExtraKeys(record.artifact, ARTIFACT_KEYS, 'record.artifact', errors);
  }
  const hasVersion = Object.hasOwn(record ?? {}, 'evidence_contract_version');
  if (hasVersion && record.evidence_contract_version !== 1) add(errors, 'evidence_contract_version 必须是 1。');
  const attained = record.evidence_status === 'attained';
  const shouldRequire = requireProvenance || hasVersion || !grandfathered || attained;
  if (shouldRequire && record.evidence_contract_version !== 1) add(errors, '新增或 attained 记录必须声明 evidence_contract_version=1。');
  if (shouldRequire && !record?.provenance) add(errors, '缺少 exact evidence provenance。');
  if (record?.provenance) errors.push(...provenanceErrors(record.provenance, {
    sourceCommit: record.source_commit,
    recordStatus: record.evidence_status,
    recordRunId: record.run_id,
    recordEnvironment: record.environment,
    recordCommand: record.command_or_scenario,
    git,
  }));
  if (shouldRequire && !record?.skip_classification) add(errors, '缺少 skip_classification；不能区分 capability/platform 与 not_executed。');
  if (record?.skip_classification) errors.push(...skipClassificationErrors(record.skip_classification, {
    evidenceStatus: record.evidence_status,
    attainedLevel: record.attained_level,
  }));
  if (record?.artifact?.sha256 && !SHA256.test(record.artifact.sha256)) add(errors, 'artifact.sha256 必须是 64 位 SHA-256。');
  if (record?.evidence_status === 'not_run' && record?.provenance?.mode !== 'not_run' && shouldRequire) add(errors, 'not_run 记录必须使用 not_run provenance。');
  return errors;
}

export { ACTIONS_ID, ARTIFACT_KEYS, PROVENANCE_KEYS, RECORD_KEYS, SHA, SENTINEL, SKIP_KEYS, SKIP_KINDS };
