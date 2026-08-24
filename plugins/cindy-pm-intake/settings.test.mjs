import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const settingsSource = readFileSync(path.resolve(import.meta.dirname, 'settings.js'), 'utf8');

async function loadSettings() {
  const elements = new Map([
    ['pmBaseUrl', { value: '', placeholder: '' }],
    ['token', { value: '', placeholder: '' }],
    ['save', { onclick: null }],
    ['status', { textContent: '' }],
  ]);
  const calls = [];
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
    console,
  });
  vm.runInContext(settingsSource, context, { filename: 'settings.js' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { elements, calls };
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
