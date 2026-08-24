import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const mainSource = readFileSync(path.resolve(import.meta.dirname, 'main.js'), 'utf8');
const ghost = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'ghost.json'), 'utf8'));

function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('等待插件工具结果超时'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function setup({ errandText = '{"accepted":true}', autoScanEnabled = false } = {}) {
  let onHostMessage;
  const nodeCalls = [];
  const sent = [];
  const errandCalls = [];
  const secretCalls = [];
  const cindy = {
    onHostMessage(handler) { onHostMessage = handler; },
    node: {
      async request(request) {
        nodeCalls.push(request);
        if (request.method === 'pm/ensure') {
          return { ok: true, result: { url: 'http://127.0.0.1:4310', port: 4310, alreadyRunning: false, foreign: false } };
        }
        if (request.params.path === '/api/runtime/auto-scan') return {
          ok: true,
          result: { enabled: autoScanEnabled },
        };
        if (request.params.path.endsWith('/tasks')) return {
          ok: true,
          result: {
            items: [{ id: 'task-1', version: 2 }],
            candidates: [{ id: 'candidate-1', title: '待确认需求', version: 1 }],
            cursors: [{ conversation_key: 'conversation-1', cursor: '2026-08-24T00:00:00.000Z' }],
          },
        };
        if (request.params.path.endsWith('/intake')) return { ok: true, result: { accepted: true, intake_id: 'intake-1' } };
        throw new Error(`unexpected node request: ${JSON.stringify(request)}`);
      },
    },
    agent: {
      async errand(request) {
        errandCalls.push(request);
        return { ok: true, status: 'done', jobId: 'job-1', sessionId: 'session-intake', text: errandText };
      },
    },
    async send(message) {
      sent.push(message);
      return { ok: true };
    },
  };
  class TestBroadcastChannel { onmessage = null; }
  vm.runInContext(mainSource, vm.createContext({
    BroadcastChannel: TestBroadcastChannel,
    cindy,
    console,
    fetch: async (url, options = {}) => {
      if (url === '/secrets' && !options.method) return { json: async () => [] };
      if (url === '/secrets/pm_token' && options.method === 'PUT') {
        secretCalls.push({ url, options });
        return { ok: true, json: async () => ({}) };
      }
      return { json: async () => ({ pmBaseUrl: 'http://127.0.0.1:4310' }) };
    },
    setInterval,
    clearInterval,
    setTimeout,
    Date,
    JSON,
    Number,
    Error,
  }), { filename: 'main.js' });
  return { onHostMessage, nodeCalls, sent, errandCalls, secretCalls };
}

test('scan_intake_window starts the fixed intake errand session and returns its result', async () => {
  const { onHostMessage, nodeCalls, errandCalls, sent } = setup({
    errandText: '{"status":"skipped","reason":"empty_window","summary":"窗口无消息，跳过提交。","proposals":[]}',
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-scan', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-scan'));
  assert.equal(errandCalls.length, 1);
  assert.equal(errandCalls[0].sessionKey, 'intake');
  assert.equal(errandCalls[0].mode, 'wait');
  assert.equal(errandCalls[0].callId, 'call-scan');
  assert.match(errandCalls[0].task, /get_pm_tasks/);
  assert.match(errandCalls[0].task, /items、candidates、cursors/);
  assert.match(errandCalls[0].task, /submit_intake/);
  assert.match(errandCalls[0].task, /不可信数据/);
  assert.match(errandCalls[0].task, /\/api\/tasks/);
  assert.match(errandCalls[0].task, /CAS/);
  assert.match(errandCalls[0].task, /create_candidate.*只创建候选/);
  assert.match(errandCalls[0].task, /im_read_messages/);
  assert.match(errandCalls[0].task, /最多回读 4 小时/);
  assert.match(errandCalls[0].task, /empty_window/);
  assert.match(errandCalls[0].task, /\[\{"action"/);
  assert.equal('model' in errandCalls[0], false);
  assert.equal('provider' in errandCalls[0], false);
  assert.equal('effort' in errandCalls[0], false);
  assert.equal('permissionMode' in errandCalls[0], false);
  const result = sent.find((message) => message.callId === 'call-scan');
  assert.equal(result.ok, true);
  assert.equal(result.result.job_id, 'job-1');
  assert.equal(result.result.session_id, 'session-intake');
  assert.equal(result.result.status, 'skipped');
  assert.equal(result.result.reason, 'empty_window');
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.proposals)), []);
  assert.equal(nodeCalls[0].method, 'pm/ensure');
});

test('schedule scan skips the errand when the product auto-scan switch is disabled', async () => {
  const { onHostMessage, nodeCalls, errandCalls, sent } = setup({ autoScanEnabled: false });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-schedule-off', args: { trigger: 'schedule' } });
  await waitFor(() => sent.some((message) => message.callId === 'call-schedule-off'));
  const result = sent.find((message) => message.callId === 'call-schedule-off');
  assert.equal(errandCalls.length, 0);
  assert.equal(nodeCalls.some((call) => call.params?.path === '/api/runtime/auto-scan'), true);
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'skipped');
  assert.equal(result.result.reason, 'auto_scan_disabled');
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.proposals)), []);
});

test('schedule scan runs when the product auto-scan switch is enabled', async () => {
  const { onHostMessage, errandCalls, sent } = setup({ autoScanEnabled: true });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-schedule-on', args: { trigger: 'schedule' } });
  await waitFor(() => sent.some((message) => message.callId === 'call-schedule-on'));
  assert.equal(errandCalls.length, 1);
});

test('manual scan runs even when the product auto-scan switch is disabled', async () => {
  const { onHostMessage, nodeCalls, errandCalls, sent } = setup({ autoScanEnabled: false });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-manual-off', args: { trigger: 'manual' } });
  await waitFor(() => sent.some((message) => message.callId === 'call-manual-off'));
  assert.equal(errandCalls.length, 1);
  assert.equal(nodeCalls.some((call) => call.params?.path === '/api/runtime/auto-scan'), false);
});

test('get_pm_tasks exposes task items, pending candidates, and read cursors', async () => {
  const { onHostMessage, sent } = setup();
  onHostMessage({ type: 'tool-call', tool: 'get_pm_tasks', callId: 'call-snapshot', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-snapshot'));
  const result = sent.find((message) => message.callId === 'call-snapshot');
  assert.deepEqual(Object.keys(result.result).sort(), ['candidates', 'cursors', 'items']);
  assert.equal(result.result.items[0].id, 'task-1');
  assert.equal(result.result.candidates[0].id, 'candidate-1');
  assert.equal(result.result.cursors[0].conversation_key, 'conversation-1');
});

test('scan result returns a readable short proposal list with action and title', async () => {
  const { onHostMessage, sent } = setup({
    errandText: '{"status":"done","summary":"已更新已有任务。","proposals":[{"action":"update_task","title":"活动留存分析"},{"action":"skip","title":"礼貌确认"}]}',
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-proposals', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-proposals'));
  const result = sent.find((message) => message.callId === 'call-proposals');
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.proposals)), [
    { action: 'update_task', title: '活动留存分析' },
    { action: 'skip', title: '礼貌确认' },
  ]);
  assert.equal(result.result.summary, '已更新已有任务。');
});

test('ghost declares schedule support while retaining errand', () => {
  assert.equal(ghost.version, '0.2.5');
  assert.deepEqual(Object.keys(ghost.agent).sort(), ['errand', 'schedule']);
  assert.equal(ghost.agent.errand, true);
  assert.equal(ghost.agent.schedule, true);
  const scanTool = ghost.tools.find((tool) => tool.name === 'scan_intake_window');
  assert.deepEqual(scanTool.parameters.properties.trigger.enum, ['manual', 'schedule']);
  assert.equal(scanTool.parameters.properties.trigger.default, 'manual');
});

test('main flow creates a local task-service token through settings before ensuring the resident service', async () => {
  const { onHostMessage, nodeCalls, secretCalls, sent } = setup();
  onHostMessage({ type: 'tool-call', tool: 'get_pm_tasks', callId: 'call-ensure', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-ensure'));
  assert.equal(secretCalls.length, 1);
  assert.equal(secretCalls[0].url, '/secrets/pm_token');
  const saved = JSON.parse(secretCalls[0].options.body);
  assert.match(saved.value, /^cindy-/);
  assert.equal(nodeCalls[0].method, 'pm/ensure');
  assert.equal(nodeCalls[1].params.path, '/api/integrations/cindy/tasks');
});

test('submit_intake posts the declared source and proposal contract', async () => {
  const { onHostMessage, nodeCalls, sent } = setup();
  const args = {
    window_id: 'window-1',
    window_start: '2026-08-24T01:00:00.000Z',
    window_end: '2026-08-24T01:10:00.000Z',
    sources: [{ source_key: 's1', occurred_at: '2026-08-24T01:05:00.000Z', text: '新增需求。' }],
    proposals: [
      { action: 'create_candidate', source_keys: ['s1'], title: '新增需求', describe: '需求描述' },
      { action: 'skip', source_keys: ['s1'], reason: '仅作测试。' },
      { action: 'update_task', source_keys: ['s1'], task_key: 'task-1', expected_version: 2, next_step: '继续确认。' },
    ],
  };
  onHostMessage({ type: 'tool-call', tool: 'submit_intake', callId: 'call-submit', args });
  await waitFor(() => sent.some((message) => message.callId === 'call-submit'));
  const post = nodeCalls.find((call) => call.params?.path?.endsWith('/intake'));
  assert.equal(post.params.method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(post.params.body)), args);
  assert.deepEqual(sent.find((message) => message.callId === 'call-submit').result, { accepted: true, intake_id: 'intake-1' });
});

test('submit_intake rejects update_task without task_key or expected_version', async () => {
  const { onHostMessage, nodeCalls, sent } = setup();
  onHostMessage({
    type: 'tool-call',
    tool: 'submit_intake',
    callId: 'call-invalid-update',
    args: {
      window_id: 'window-1',
      window_start: '2026-08-24T01:00:00.000Z',
      window_end: '2026-08-24T01:10:00.000Z',
      sources: [{ source_key: 's1', occurred_at: '2026-08-24T01:05:00.000Z', text: '更新已有任务。' }],
      proposals: [{ action: 'update_task', source_keys: ['s1'], next_step: '缺少 CAS 信息。' }],
    },
  });
  await waitFor(() => sent.some((message) => message.callId === 'call-invalid-update'));
  assert.equal(nodeCalls.some((call) => call.params?.path?.endsWith('/intake')), false);
  const failure = sent.find((message) => message.callId === 'call-invalid-update');
  assert.equal(failure.ok, false);
  assert.match(failure.message, /task_key/);
});

test('submit_intake rejects an empty window so the errand must short-circuit', async () => {
  const { onHostMessage, nodeCalls, sent } = setup();
  onHostMessage({
    type: 'tool-call',
    tool: 'submit_intake',
    callId: 'call-empty-window',
    args: {
      window_id: 'window-empty',
      window_start: '2026-08-24T01:00:00.000Z',
      window_end: '2026-08-24T01:10:00.000Z',
      sources: [],
      proposals: [],
    },
  });
  await waitFor(() => sent.some((message) => message.callId === 'call-empty-window'));
  assert.equal(nodeCalls.some((call) => call.params?.path?.endsWith('/intake')), false);
  const failure = sent.find((message) => message.callId === 'call-empty-window');
  assert.equal(failure.ok, false);
  assert.match(failure.message, /empty_window/);
});
