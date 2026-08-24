import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const settingsSource = readFileSync(path.resolve(import.meta.dirname, 'settings.js'), 'utf8');
const settingsHtml = readFileSync(path.resolve(import.meta.dirname, 'settings.html'), 'utf8');

async function loadSettings({ autoScanEnabled = false } = {}) {
  const elements = new Map([
    ['pmBaseUrl', { value: '', placeholder: '' }],
    ['token', { value: '', placeholder: '' }],
    ['save', { onclick: null }],
    ['restart', { onclick: null }],
    ['autoScan', { checked: false, onchange: null }],
    ['progressEnabled', { checked: true }],
    ['status', { textContent: '' }],
  ]);
  const calls = [];
  const nodeCalls = [];
  const scheduleCalls = [];
  const context = vm.createContext({
    BroadcastChannel: class { postMessage(message) { calls.push({ url: 'broadcast', message }); } },
    URL,
    document: { getElementById: (id) => elements.get(id) },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/kv' && !options.method) return { json: async () => ({ pmBaseUrl: 'http://127.0.0.1:4310' }) };
      if (url === '/secrets' && !options.method) return { json: async () => [] };
      return { json: async () => ({}) };
    },
    cindy: {
      node: {
        request: async (request) => {
          nodeCalls.push(request);
          if (request.method === 'pm/request') return { ok: true, result: { enabled: autoScanEnabled } };
          return { ok: true, result: { url: 'http://127.0.0.1:4310', port: 4310 } };
        },
      },
      agent: {
        requestSchedule: async (request) => {
          scheduleCalls.push(request);
          return { ok: true };
        },
      },
    },
    console,
  });
  vm.runInContext(settingsSource, context, { filename: 'settings.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { elements, calls, nodeCalls, scheduleCalls };
}

test('settings rejects non-loopback pmBaseUrl before writing configuration', async () => {
  const { elements, calls } = await loadSettings();
  elements.get('pmBaseUrl').value = 'https://example.com';
  await elements.get('save').onclick();
  assert.equal(elements.get('status').textContent, '本机任务库地址必须是本机 HTTP 回环地址');
  assert.equal(calls.some((call) => call.url === '/kv' && call.options.method === 'PUT'), false);
});

test('settings accepts loopback pmBaseUrl and writes configuration', async () => {
  const { elements, calls } = await loadSettings();
  elements.get('pmBaseUrl').value = 'http://[::1]:4310';
  await elements.get('save').onclick();
  const save = calls.find((call) => call.url === '/kv' && call.options.method === 'PUT');
  assert.ok(save);
  assert.equal(JSON.parse(save.options.body).pmBaseUrl, 'http://[::1]:4310');
  assert.equal(elements.get('status').textContent, '已保存');
});

test('settings restarts the local task library through pm/restart without the stop exit path', async () => {
  const { elements, nodeCalls } = await loadSettings();
  await elements.get('restart').onclick();
  const restart = nodeCalls.find((request) => request.method === 'pm/restart');
  assert.ok(restart);
  assert.equal(restart.params.baseUrl, 'http://127.0.0.1:4310');
  assert.equal(restart.params.scheduleExit, false);
  assert.equal(elements.get('status').textContent, '本机任务库已重启');
});

test('settings opens the 10-minute scan schedule after enabling the switch', async () => {
  const { elements, nodeCalls, scheduleCalls } = await loadSettings();
  elements.get('autoScan').checked = true;
  await elements.get('autoScan').onchange();
  const update = nodeCalls.find((request) => request.method === 'pm/request' && request.params.method === 'PUT');
  assert.ok(update);
  assert.equal(update.params.path, '/api/runtime/auto-scan');
  assert.deepEqual(JSON.parse(JSON.stringify(update.params.body)), { enabled: true });
  assert.equal(scheduleCalls.length, 1);
  assert.equal(scheduleCalls[0].name, 'TooManyTasks 每 10 分钟入库扫描');
  assert.match(scheduleCalls[0].prompt, /scan_intake_window/);
  assert.match(scheduleCalls[0].prompt, /trigger.*schedule/);
  assert.equal(scheduleCalls[0].intervalMs, 10 * 60 * 1000);
  assert.match(elements.get('status').textContent, /请确认并保存/);
});

test('settings writes false when the auto-scan switch is disabled', async () => {
  const { elements, nodeCalls, scheduleCalls } = await loadSettings({ autoScanEnabled: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements.get('autoScan').checked, true);
  elements.get('autoScan').checked = false;
  await elements.get('autoScan').onchange();
  const update = nodeCalls.find((request) => request.method === 'pm/request' && request.params.method === 'PUT');
  assert.ok(update);
  assert.deepEqual(JSON.parse(JSON.stringify(update.params.body)), { enabled: false });
  assert.equal(scheduleCalls.length, 0);
  assert.match(elements.get('status').textContent, /关闭只停止本产品自动流程|已关闭本产品自动扫描/);
});

test('settings explains the required discounted Luna route and manual save', () => {
  assert.match(settingsHtml, /AI 代办/);
  assert.match(settingsHtml, /codex\/gpt-5\.6-luna/);
  assert.match(settingsHtml, /思考强度选择 <code>high<\/code>/);
  assert.match(settingsHtml, /插件详情「AI 代办」权限选「自动审核」\(Auto-review \/ <code>auto<\/code>\)，不要选只读 <code>plan<\/code> 或完全访问 <code>bypassPermissions<\/code>。/);
  assert.match(settingsHtml, /原价 <code>gpt-5\.6-luna<\/code>/);
  assert.match(settingsHtml, /Cindy 草稿默认可能是 <code>fable5<\/code>/);
  assert.match(settingsHtml, /改一次并保存/);
  assert.match(settingsHtml, /不会静默修改 Cindy 的全局默认模型/);
  assert.match(settingsHtml, /关闭只停止本产品自动流程/);
  assert.match(settingsHtml, /Cindy 自动化条目可能仍在/);
  assert.match(settingsHtml, /到点会空跑短路/);
  assert.match(settingsHtml, /本机后台运行时菜单栏会显示 TooManyTasks，点击打开任务台/);
});

test('settings exposes active and automatic progress modes', async () => {
  const { elements, calls } = await loadSettings();
  assert.match(settingsHtml, /主动模式/);
  assert.match(settingsHtml, /自动模式/);
  assert.match(settingsHtml, /Orca Worker、入库 errand 和 source=plugin 会跳过/);
  const progressRadio = { value: 'automatic', checked: true };
  const originalQuery = globalThis.document;
  void originalQuery;
  elements.get('progressEnabled').checked = false;
  await elements.get('save').onclick();
  const save = calls.find((call) => call.url === '/kv' && call.options.method === 'PUT');
  assert.equal(JSON.parse(save.options.body).progressEnabled, false);
  assert.equal(JSON.parse(save.options.body).progressMode, 'manual');
  void progressRadio;
});

test('schedule request leaves model routing to the plugin AI errand settings', async () => {
  const { elements, scheduleCalls } = await loadSettings();
  elements.get('autoScan').checked = true;
  await elements.get('autoScan').onchange();
  assert.equal('model' in scheduleCalls[0], false);
  assert.equal('provider' in scheduleCalls[0], false);
  assert.equal('effort' in scheduleCalls[0], false);
  assert.equal('permissionMode' in scheduleCalls[0], false);
});
