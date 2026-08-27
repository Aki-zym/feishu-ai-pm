import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { renderMarkdown } from './domain-contracts-check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const contractPath = fileURLToPath(new URL('../docs/domain-contracts.json', import.meta.url));
const checkerPath = fileURLToPath(new URL('./domain-contracts-check.mjs', import.meta.url));
const base = JSON.parse(readFileSync(contractPath, 'utf8'));

function run(mutator, markdownMutator, { preRenderStructuralRejection = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'domain-contract-negative-'));
  const fixture = join(dir, 'contract.json');
  const markdown = join(dir, 'domain-contracts.md');
  const value = structuredClone(base);
  mutator(value);
  writeFileSync(fixture, JSON.stringify(value));
  if (preRenderStructuralRejection) writeFileSync(markdown, '');
  else {
    const generated = renderMarkdown(value);
    writeFileSync(markdown, markdownMutator ? markdownMutator(generated) : generated);
  }
  const result = spawnSync(process.execPath, [checkerPath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DOMAIN_CONTRACT_FIXTURE: fixture, DOMAIN_CONTRACT_MARKDOWN_FIXTURE: markdown },
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function rejects(mutator, markdownMutator) {
  const result = run(mutator, markdownMutator);
  assert.notEqual(result.status, 0, `fixture unexpectedly passed:\n${result.output}`);
  return result.output;
}

function runWriteStructural(mutator) {
  const dir = mkdtempSync(join(tmpdir(), 'domain-contract-write-structural-'));
  // Build an isolated, git-indexed checkout so the command resolves the real
  // docs/domain-contracts.json and docs/domain-contracts.md paths without
  // fixture env vars (and therefore exercises the actual --write branch).
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const relative of tracked) {
    const source = join(root, relative);
    if (!existsSync(source)) continue;
    const destination = join(dir, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8' });
  const fixture = join(dir, 'docs', 'domain-contracts.json');
  const markdown = join(dir, 'docs', 'domain-contracts.md');
  const value = structuredClone(base);
  mutator(value);
  writeFileSync(fixture, JSON.stringify(value));
  const before = readFileSync(markdown);
  const env = { ...process.env };
  delete env.DOMAIN_CONTRACT_FIXTURE;
  delete env.DOMAIN_CONTRACT_MARKDOWN_FIXTURE;
  const result = spawnSync(process.execPath, ['scripts/domain-contracts-check.mjs', '--write'], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
  const after = readFileSync(markdown);
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`, viewUnchanged: before.equals(after) };
}

test('binding drift is rejected', () => {
  assert.match(rejects((value) => { value.objects.candidate.binding.name = 'WrongState'; }), /binding 必须精确/);
  assert.match(rejects((value) => { value.objects.approval.binding.table = 'wrong_table'; }), /binding 必须精确/);
  assert.match(rejects((value) => { value.objects.outbox.binding.column = 'wrong_column'; }), /binding 必须精确/);
  assert.match(rejects((value) => { value.objects.source_event.binding.table = 'wrong_table'; }), /binding 必须精确/);
  assert.match(rejects((value) => { value.objects.source_event.binding.column = 'wrong_column'; }), /binding 必须精确/);
  assert.match(rejects((value) => { value.objects.candidate.binding.table = 'wrong_table'; }), /binding 必须精确/);
  assert.match(rejects((value) => { value.objects.approval.binding.name = 'unexpected'; }), /binding 必须精确/);
  assert.match(rejects((value) => { delete value.objects.outbox.binding.column; }), /binding 必须精确/);
});

test('actor, terminal, outcome, authority and evidence drift are rejected', () => {
  assert.match(rejects((value) => { delete value.objects.candidate.transitions[0].actor; }), /from\/to\/actor/);
  assert.match(rejects((value) => { value.objects.task.terminal.target = 'missing'; }), /terminal missing/);
  assert.match(rejects((value) => { delete value.objects.task.terminal.gap; }), /\[STRUCTURE\] objects\.task\.terminal/);
  assert.match(rejects((value) => { value.objects.task.terminal.gap = ''; }), /terminal\.current\/target\/gap/);
  assert.match(rejects((value) => { value.objects.task.terminal.gap = '   '; }), /terminal\.current\/target\/gap/);
  for (const invalid of [',', ' , ', 'completed,', ',completed', 'completed,,cancelled', 'not_applicable', 'completed, completed']) {
    assert.match(rejects((value) => { value.objects.job.terminal.target = invalid; }), /terminal/);
  }
  const validTerminal = run((value) => { value.objects.job.terminal.target = ' completed, cancelled '; });
  assert.equal(validTerminal.status, 0, validTerminal.output);
  assert.match(rejects((value) => { delete value.outcomes.target.failure; }), /outcomes\.target/);
  assert.match(rejects((value) => { value.outcomes.target.extra = 'fifth'; }), /只能包含四态/);
  assert.match(rejects((value) => { delete value.authority_layers.sqlite_fact; }), /authority_layers/);
  assert.match(rejects((value) => { delete value.objects.job.transitions[0].evidence_scope; }), /evidence_scope/);
  assert.match(rejects((value) => { value.objects.job.transitions[0].scope = 'invented'; }), /scope\/evidence_scope/);
  assert.match(rejects((value) => { value.objects.task.authority = 'invented'; }), /authority/);
  assert.match(rejects((value) => { value.objects.task.authority = value.objects.job.authority; }), /authority/);
  assert.match(rejects((value) => { value.outcomes.evidence_scope.current = 'invented'; }), /outcomes\.evidence_scope/);
  assert.match(rejects((value) => { value.error_catalog[0].outcome = 'invented'; }), /error_catalog/);
  assert.match(rejects((value) => { value.adr_contract.canonical_id_pattern = 'ANYTHING'; }), /canonical ADR 正则/);
  const missingPolicy = run((value) => { delete value.external_id_policy; }, undefined, { preRenderStructuralRejection: true });
  assert.notEqual(missingPolicy.status, 0);
  assert.match(missingPolicy.output, /\[STRUCTURE\] external_id_policy/);
  assert.doesNotMatch(missingPolicy.output, /TypeError|at .*domain-contracts-check|\n\s+at /);
  for (const [label, mutator] of [
    ['authority_order', (value) => { delete value.authority_order; }],
    ['outcomes', (value) => { delete value.outcomes; }],
    ['objects', (value) => { delete value.objects; }],
    ['adr_contract', (value) => { delete value.adr_contract; }],
  ]) {
    const structural = run(mutator, undefined, { preRenderStructuralRejection: true });
    assert.notEqual(structural.status, 0);
    assert.match(structural.output, new RegExp(`\\[STRUCTURE\\] ${label}`));
    assert.doesNotMatch(structural.output, /TypeError|at .*domain-contracts-check|\n\s+at /);
  }
  assert.match(rejects((value) => { value.external_id_policy.allowlist[0].display_rule = '公开日志'; }), /external_id_policy/);
  assert.match(rejects((value) => { value.external_id_policy.allowlist[1].storage = 'public_log'; }), /external_id_policy/);
  assert.match(rejects((value) => { value.external_id_policy.allowlist[1].egress = 'API 原值展示'; }), /external_id_policy/);
  assert.match(rejects((value) => { value.external_id_policy.allowlist[1].extra = 'bypass'; }), /external_id_policy/);
  assert.match(rejects((value) => { value.external_id_policy.extra = 'bypass'; }), /external_id_policy/);
  assert.match(rejects((value) => { value.adr_contract.required_yaml_keys = [...value.adr_contract.required_yaml_keys, 'extra']; }), /required_yaml_keys/);
  assert.match(rejects((value) => { value.adr_contract.required_yaml_keys = value.adr_contract.required_yaml_keys.slice(1); }), /required_yaml_keys/);
  assert.match(rejects((value) => { value.adr_contract.required_yaml_keys = [...value.adr_contract.required_yaml_keys].reverse(); }), /required_yaml_keys/);
  assert.match(rejects((value) => { value.adr_contract.required_body_sections = [...value.adr_contract.required_body_sections, '附加']; }), /required_body_sections/);
  assert.match(rejects((value) => { value.adr_contract.required_body_sections = value.adr_contract.required_body_sections.slice(1); }), /required_body_sections/);
  assert.match(rejects((value) => { value.adr_contract.required_body_sections = [...value.adr_contract.required_body_sections].reverse(); }), /required_body_sections/);
});

test('exactly nine objects and generated Markdown are enforced', () => {
  assert.match(rejects((value) => { value.objects.extra = structuredClone(value.objects.task); }), /精确的 9 个对象/);
  assert.match(rejects((value) => value, (text) => text.replace('## Hard rules', '## Tampered rules')), /完整生成视图/);
  assert.match(rejects((value) => value, (text) => text.replace('Terminal current', 'Tampered terminal')), /完整生成视图/);
  assert.match(rejects((value) => value, (text) => text.replace('Error / outcome catalog', 'Tampered outcomes')), /完整生成视图/);
  const crlf = run((value) => value, (text) => text.replace(/\n/g, '\r\n'));
  assert.equal(crlf.status, 0, crlf.output);
  assert.match(rejects((value) => value, (text) => text.replace(/\n/g, '\r\n').replace('## Hard rules', '## Tampered rules')), /完整生成视图/);
});

test('同步普通 hard_rules 文本是 control：不属于固定 schema 时可通过', () => {
  const result = run((value) => { value.hard_rules[0] = 'control-only wording change'; });
  assert.equal(result.status, 0, result.output);
});

test('真实 --write 入口在 render 前受控拒绝根结构缺失', () => {
  for (const [label, mutator] of [
    ['external_id_policy', (value) => { delete value.external_id_policy; }],
    ['authority_order', (value) => { delete value.authority_order; }],
    ['outcomes', (value) => { delete value.outcomes; }],
    ['objects', (value) => { delete value.objects; }],
    ['adr_contract', (value) => { delete value.adr_contract; }],
  ]) {
    const result = runWriteStructural(mutator);
    assert.notEqual(result.status, 0, label);
    assert.match(result.output, new RegExp(`\\[STRUCTURE\\] ${label}`));
    assert.doesNotMatch(result.output, /TypeError|SyntaxError|stack|at .*domain-contracts-check|[A-Za-z]:\\/);
    assert.equal(result.viewUnchanged, true, `${label} must not overwrite generated view`);
  }
});

test('真实 --write 合法输入确实进入写分支', () => {
  const result = runWriteStructural((value) => { value.hard_rules[0] = 'real isolated write branch control'; });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.viewUnchanged, false, '合法 --write 必须更新隔离副本中的 generated view');
});

test('CLI 结构校验必须位于 --write 之前', () => {
  const source = readFileSync(checkerPath, 'utf8');
  const validation = source.indexOf('const structuralErrors = validateRenderableStructure();');
  const write = source.indexOf("writeFileSync(resolve(root, 'docs/domain-contracts.md'), renderMarkdown(contract), 'utf8')");
  assert.notEqual(validation, -1, '必须存在独立结构校验阶段');
  assert.notEqual(write, -1, '必须存在真实 --write 分支');
  assert.ok(validation < write, '结构校验必须先于 --write');
});

test('非法 canonical regex 在 ordinary check 与真实 --write 中受控失败', () => {
  const ordinary = rejects((value) => { value.adr_contract.canonical_id_pattern = '['; });
  assert.match(ordinary, /canonical ADR 正则/);
  assert.doesNotMatch(ordinary, /TypeError|SyntaxError|stack|at .*domain-contracts-check|[A-Za-z]:\\/);
  const write = runWriteStructural((value) => { value.adr_contract.canonical_id_pattern = '['; });
  assert.notEqual(write.status, 0);
  assert.match(write.output, /canonical ADR 正则/);
  assert.doesNotMatch(write.output, /TypeError|SyntaxError|stack|at .*domain-contracts-check|[A-Za-z]:\\/);
});
