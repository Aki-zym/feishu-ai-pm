import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const settingsSource = readFileSync(path.resolve(import.meta.dirname, 'settings.js'), 'utf8');
const settingsHtml = readFileSync(path.resolve(import.meta.dirname, 'settings.html'), 'utf8');

async function loadSettings({ autoScanEnabled = false, failedPutUrl = null } = {}) {
  const elements = new Map([
    ['pmBaseUrl', { value: '', placeholder: '' }],
    ['save', { onclick: null }],
    ['restart', { onclick: null }],
    ['autoScan', { checked: false, onchange: null }],
    ['progressEnabled', { checked: true }],
    ['status', { textContent: '' }],
  ]);
  const calls = [];
  const nodeCalls = [];
  const context = vm.createContext({
    BroadcastChannel: class { postMessage(message) { calls.push({ url: 'broadcast', message }); } },
    URL,
    document: { getElementById: (id) => elements.get(id) },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/kv' && !options.method) return { json: async () => ({ pmBaseUrl: 'http://127.0.0.1:4310' }) };
      if (url === '/secrets' && !options.method) return { json: async () => [] };
      return { ok: url !== failedPutUrl, json: async () => ({}) };
    },
    cindy: {
      node: {
        request: async (request) => {
          nodeCalls.push(request);
          if (request.method === 'pm/request') return { ok: true, result: { enabled: autoScanEnabled } };
          return { ok: true, result: { url: 'http://127.0.0.1:4310', port: 4310 } };
        },
      },
    },
    console,
  });
  vm.runInContext(settingsSource, context, { filename: 'settings.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { elements, calls, nodeCalls };
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
  assert.equal('ailyAgentId' in JSON.parse(save.options.body), false);
  assert.equal(elements.get('status').textContent, '已保存');
});

test('settings never reads or writes plugin secrets for Aily or the integration token', async () => {
  const { elements, calls } = await loadSettings();
  await elements.get('save').onclick();
  assert.equal(calls.some((call) => String(call.url).startsWith('/secrets')), false);
  assert.doesNotMatch(settingsHtml, /id="ailyAppSecret"|id="ailyUserAccessToken"|id="token"/);
});

test('settings reports a failed PUT instead of showing a false success', async () => {
  const { elements, calls } = await loadSettings({ failedPutUrl: '/kv' });
  await elements.get('save').onclick();
  assert.equal(elements.get('status').textContent, '配置保存失败');
  assert.equal(calls.some((call) => call.url === 'broadcast'), false);
});

test('settings restarts the independent task service through its loopback runtime API', async () => {
  const { elements, nodeCalls } = await loadSettings();
  await elements.get('restart').onclick();
  const restart = nodeCalls.find((request) => request.method === 'pm/request'
    && request.params.path === '/api/runtime/restart');
  assert.ok(restart);
  assert.equal(restart.params.baseUrl, 'http://127.0.0.1:4310');
  assert.equal(restart.params.method, 'POST');
  assert.equal(elements.get('status').textContent, '独立 TooManyTasks 已收到重启请求');
});

test('settings enables the independent 20-minute scan and five-minute Cindy inbox consumer', async () => {
  const { elements, nodeCalls } = await loadSettings();
  elements.get('autoScan').checked = true;
  await elements.get('autoScan').onchange();
  const update = nodeCalls.find((request) => request.method === 'pm/request' && request.params.method === 'PUT');
  assert.ok(update);
  assert.equal(update.params.path, '/api/runtime/auto-scan');
  assert.deepEqual(JSON.parse(JSON.stringify(update.params.body)), { enabled: true });
  assert.match(elements.get('status').textContent, /TooManyTasks 每 20 分钟后台扫描，Cindy 每 5 分钟领取摘要/);
});

test('settings writes false when the auto-scan switch is disabled', async () => {
  const { elements, nodeCalls } = await loadSettings({ autoScanEnabled: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements.get('autoScan').checked, true);
  elements.get('autoScan').checked = false;
  await elements.get('autoScan').onchange();
  const update = nodeCalls.find((request) => request.method === 'pm/request' && request.params.method === 'PUT');
  assert.ok(update);
  assert.deepEqual(JSON.parse(JSON.stringify(update.params.body)), { enabled: false });
  assert.match(elements.get('status').textContent, /已关闭新摘要生成|已有摘要仍会由 Cindy 继续入库/);
});

test('settings explains the asynchronous scan inbox and required discounted Luna route', () => {
  assert.match(settingsHtml, /AI 代办/);
  assert.match(settingsHtml, /codex\/gpt-5\.6-luna/);
  assert.match(settingsHtml, /思考强度选择 <code>high<\/code>/);
  assert.match(settingsHtml, /插件详情「AI 代办」权限选「自动审核」\(Auto-review \/ <code>auto<\/code>\)，不要选只读 <code>plan<\/code> 或完全访问 <code>bypassPermissions<\/code>。/);
  assert.match(settingsHtml, /原价 <code>gpt-5\.6-luna<\/code>/);
  assert.match(settingsHtml, /Cindy 草稿默认可能是 <code>fable5<\/code>/);
  assert.match(settingsHtml, /改一次并保存/);
  assert.match(settingsHtml, /不会静默修改 Cindy 的全局默认模型/);
  assert.match(settingsHtml, /TooManyTasks 每 20 分钟调用 Aily/);
  assert.match(settingsHtml, /Cindy 插件每 5 分钟最多领取一条摘要/);
  assert.match(settingsHtml, /Cindy 退出期间仍会继续生成摘要/);
  assert.doesNotMatch(settingsHtml, /打开自动化面板/);
  assert.match(settingsHtml, /请先独立启动 TooManyTasks/);
  assert.match(settingsHtml, /自行管理 Aily OAuth、Token、官方 SDK/);
  assert.match(settingsHtml, /不保存 Aily App Secret、访问 Token 或任务库令牌/);
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
