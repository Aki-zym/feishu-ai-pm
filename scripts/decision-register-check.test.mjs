import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import source from '../docs/decision-register.json' with { type: 'json' };
import { canonicalizeGeneratedText, checkFiles, renderMarkdown, validateRegister } from './decision-register-check.mjs';

function valid() { return structuredClone(source); }
function errors(register) { return validateRegister(register).join('\n'); }

test('DEC-01 事实源通过结构化合同', () => assert.deepEqual(validateRegister(valid()), []));

test('mutation matrix：字段、状态、章节语义和敏感值均 fail-closed', () => {
  const mutations = [
    ['删除已决章节字段', (r) => { delete r.decisions[0].gate; }],
    ['删除依赖', (r) => { r.decisions[0].dependencies = []; }],
    ['改成未决但允许默认实现', (r) => { r.open_items[0].do_not_default_implement = false; }],
    ['删除未验证边界', (r) => { r.decisions[0].unverified = []; }],
    ['错误 owner', (r) => { r.decisions[0].owner = 'developer'; }],
    ['错误状态', (r) => { r.decisions[0].status = 'implemented'; }],
    ['绝对路径', (r) => { r.decisions[0].scope = 'C:\\secret\\repo'; }],
    ['secret', (r) => { r.decisions[0].rationale = 'Bearer abc'; }],
    ['validation 缺少运行绑定', (r) => { r.validation.run = ''; }],
    ['validation 伪造 L6', (r) => { r.validation.evidence_ceiling.push('L6'); }],
    ['重复 ID', (r) => { r.open_items[0].id = r.decisions[0].id; }],
  ];
  for (const [name, mutate] of mutations) {
    const fixture = valid();
    mutate(fixture);
    assert.notDeepEqual(validateRegister(fixture), [], name);
  }
});

test('生成视图由事实源确定，临时 root 可检验生成结果', () => {
  const root = mkdtempSync(join(tmpdir(), 'dec-01-'));
  try {
    const output = join(root, 'decision-register.md');
    writeFileSync(output, renderMarkdown(valid()));
    assert.equal(readFileSync(output, 'utf8'), renderMarkdown(source));
    assert.match(readFileSync(output, 'utf8'), /DEC-01\.1/);
    assert.match(readFileSync(output, 'utf8'), /不得默认实现/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('生成视图比较兼容 LF/CRLF，但真实文本变更仍 fail-closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dec-01-newline-'));
  try {
    const sourcePath = join(root, 'decision-register.json');
    const output = join(root, 'decision-register.md');
    writeFileSync(sourcePath, JSON.stringify(valid()));
    const rendered = renderMarkdown(valid());

    writeFileSync(output, rendered.replaceAll('\n', '\r\n'));
    assert.deepEqual(checkFiles(sourcePath, output), []);

    writeFileSync(output, rendered.replace('M1 产品与治理负责人决策登记', 'M1 产品与治理负责人决策登记（变更）').replaceAll('\n', '\r\n'));
    assert.match(checkFiles(sourcePath, output).join('\n'), /与事实源不一致/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('write 输出保持 canonical LF 与单一结尾换行', () => {
  const root = mkdtempSync(join(tmpdir(), 'dec-01-write-'));
  try {
    const sourcePath = join(root, 'decision-register.json');
    const output = join(root, 'decision-register.md');
    writeFileSync(sourcePath, JSON.stringify(valid()));
    assert.deepEqual(checkFiles(sourcePath, output, { write: true }), []);
    const written = readFileSync(output, 'utf8');
    assert.equal(written, canonicalizeGeneratedText(renderMarkdown(valid())));
    assert.equal(written.includes('\r'), false);
    assert.equal(written.endsWith('\n'), true);
    assert.equal(written.endsWith('\n\n'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
