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

function setup({ errandText = '{"accepted":true}', errandResponse = null, errandError = null, autoScanEnabled = false, intakeWindowEnd = null, progressMode = 'manual', progressEnabled = true, progressModelText = '{"decision":"no_update","reason":"无变化","evidence":[]}' } = {}) {
  let onHostMessage;
  const nodeCalls = [];
  const sent = [];
  const errandCalls = [];
  const secretCalls = [];
  const cursorWrites = [];
  const sourcePosts = [];
  const decisionPosts = [];
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
        if (request.params.path === '/api/runtime/intake-cursor') {
          if (request.params.method === 'PUT') {
            cursorWrites.push(request.params.body);
            return { ok: true, result: { window_end: request.params.body.window_end } };
          }
          return { ok: true, result: { window_end: intakeWindowEnd } };
        }
        if (request.params.path.includes('/bindings/')) return {
          ok: true,
          result: { binding: null },
        };
        if (request.params.path.endsWith('/turn-evaluations')) return {
          ok: true,
          result: { duplicate: false, binding: null, proposal: null, suggestion: null },
        };
        if (request.params.path.endsWith('/tasks')) return {
          ok: true,
          result: {
            items: [{ id: 'task-1', version: 2 }],
            candidates: [{ id: 'candidate-1', title: '待确认需求', version: 1 }],
            cursors: [{ conversation_key: 'conversation-1', cursor: '2026-08-24T00:00:00.000Z' }],
          },
        };
        if (request.params.path.endsWith('/sources')) {
          sourcePosts.push(request.params.body);
          return { ok: true, result: { save_request_id: request.params.body.save_request_id, duplicate: false, sources: [{ client_ref: 's1', source_receipt: 'r'.repeat(43), source_status: 'pending_decision', revision: { generation: 1 } }] } };
        }
        if (request.params.path.endsWith('/decisions')) {
          decisionPosts.push(request.params.body);
          return { ok: true, result: { decision_request_id: request.params.body.decision_request_id, duplicate: false, decisions: [] } };
        }
        throw new Error(`unexpected node request: ${JSON.stringify(request)}`);
      },
    },
    agent: {
      async errand(request) {
        errandCalls.push(request);
        if (errandError) throw errandError;
        return errandResponse || { ok: true, status: 'done', jobId: 'job-1', sessionId: 'session-intake', text: errandText };
      },
    },
    async send(message) {
      sent.push(message);
      if (message.type === 'cindy-request') return { ok: true, text: progressModelText, model: 'codex/gpt-5.6-luna' };
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
      if (url.startsWith('/secrets/') && options.method === 'PUT') {
        secretCalls.push({ url, options });
        return { ok: true, json: async () => ({}) };
      }
      return { json: async () => ({ pmBaseUrl: 'http://127.0.0.1:4310', progressMode, progressEnabled }) };
    },
    setInterval,
    clearInterval,
    setTimeout,
    Date,
    JSON,
    Number,
    Error,
    crypto: globalThis.crypto,
  }), { filename: 'main.js' });
  return { onHostMessage, nodeCalls, sent, errandCalls, secretCalls, cursorWrites, sourcePosts, decisionPosts };
}

test('scan_intake_window starts the fixed intake errand session and returns its result', async () => {
  const { onHostMessage, nodeCalls, errandCalls, sent, cursorWrites, decisionPosts } = setup({
    errandText: '{"status":"skipped","reason":"empty_window","summary":"窗口无消息，跳过提交。","proposals":[]}',
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-scan', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-scan'));
  assert.equal(errandCalls.length, 1);
  assert.equal(errandCalls[0].sessionKey, 'intake-v2');
  assert.equal(errandCalls[0].mode, 'wait');
  assert.equal(errandCalls[0].callId, 'call-scan');
  assert.match(errandCalls[0].task, /get_pm_tasks/);
  assert.match(errandCalls[0].task, /items、candidates、cursors/);
  assert.match(errandCalls[0].task, /save_pm_sources/);
  assert.match(errandCalls[0].task, /submit_pm_decisions/);
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
  const firstWindowDuration = Date.parse(result.result.window_end) - Date.parse(result.result.window_start);
  assert.ok(firstWindowDuration >= 10 * 60 * 1000);
  assert.ok(firstWindowDuration < 10 * 60 * 1000 + 2000);
  assert.equal(nodeCalls[0].method, 'pm/ensure');
  assert.equal(nodeCalls.some((call) => call.params?.path === '/api/runtime/intake-cursor'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(cursorWrites)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(decisionPosts)), [{
    decision_request_id: result.result.window_id,
    window_id: result.result.window_id,
    window_start: result.result.window_start,
    window_end: result.result.window_end,
    decisions: [],
  }]);
});

test('scan_intake_window starts after the last successful intake window end', async () => {
  const cursor = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { onHostMessage, errandCalls, sent } = setup({ intakeWindowEnd: cursor });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-cursor', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-cursor'));
  assert.equal(errandCalls.length, 1);
  assert.equal(errandCalls[0].context.window_start, cursor);
  assert.equal(errandCalls[0].context.window_end, sent.find((message) => message.callId === 'call-cursor').result.window_end);
});

test('scan_intake_window caps an old intake cursor at four hours before now', async () => {
  const cursor = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const { onHostMessage, errandCalls, sent } = setup({ intakeWindowEnd: cursor });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-old-cursor', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-old-cursor'));
  const result = sent.find((message) => message.callId === 'call-old-cursor');
  const startMs = Date.parse(errandCalls[0].context.window_start);
  const endMs = Date.parse(result.result.window_end);
  assert.ok(endMs - startMs >= 4 * 60 * 60 * 1000);
  assert.ok(endMs - startMs < 4 * 60 * 60 * 1000 + 2000);
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

test('scan_intake_window skips nested dispatch inside current and legacy intake errand sessions', async () => {
  for (const sessionKey of ['intake', 'intake-v2']) {
    const { onHostMessage, nodeCalls, errandCalls, sent } = setup();
    const callId = `call-nested-${sessionKey}`;
    onHostMessage({
      type: 'tool-call',
      tool: 'scan_intake_window',
      callId,
      args: { session_context: { session: { sessionKey } } },
    });
    await waitFor(() => sent.some((message) => message.callId === callId));
    const result = sent.find((message) => message.callId === callId);
    assert.equal(errandCalls.length, 0);
    assert.equal(nodeCalls.length, 0);
    assert.equal(result.ok, true);
    assert.equal(result.result.reason, 'already_in_intake_errand');
    assert.match(result.result.next_action, /get_pm_tasks/);
    assert.match(result.result.next_action, /save_pm_sources/);
    assert.match(result.result.next_action, /submit_pm_decisions/);
    assert.match(result.result.next_action, /不要再次调用 scan_intake_window/);
  }
});

test('scan_intake_window turns a BUSY errand response into direct intake instructions', async () => {
  const { onHostMessage, nodeCalls, errandCalls, sent } = setup({
    errandResponse: { ok: false, errorCode: 'BUSY', message: '已有 intake session occupied' },
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-busy', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-busy'));
  const result = sent.find((message) => message.callId === 'call-busy');
  assert.equal(errandCalls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.result.reason, 'intake_errand_busy');
  assert.match(result.result.summary, /已占用/);
  assert.match(result.result.next_action, /飞书 MCP/);
  assert.match(result.result.next_action, /不要再次调用 scan_intake_window/);
  assert.equal(nodeCalls[0].method, 'pm/ensure');
});

test('scan_intake_window turns a thrown session-occupied error into direct intake instructions', async () => {
  const error = new Error('intake session occupied');
  error.code = 'BUSY';
  const { onHostMessage, errandCalls, sent } = setup({ errandError: error });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-thrown-busy', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-thrown-busy'));
  const result = sent.find((message) => message.callId === 'call-thrown-busy');
  assert.equal(errandCalls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.result.reason, 'intake_errand_busy');
  assert.match(result.result.next_action, /submit_pm_decisions/);
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
  const { onHostMessage, sent, cursorWrites } = setup({
    errandText: '{"status":"done","summary":"已更新已有任务。","proposals":[{"action":"update_task","title":"活动留存分析"},{"action":"skip","title":"礼貌确认"}]}',
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-proposals', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-proposals'));
  const result = sent.find((message) => message.callId === 'call-proposals');
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.proposals)), [
    { action: 'update_task', title: '活动留存分析' },
    { action: 'skip', title: '礼貌确认' },
  ]);
  assert.equal(result.result.summary, '已更新正式任务：活动留存分析。');
  assert.equal(result.result.model_summary, '已更新已有任务。');
  assert.equal(cursorWrites.length, 0);
});

test('scan result uses human language for candidates, formal task updates, and empty windows', async () => {
  const { onHostMessage, sent } = setup({
    errandText: '{"status":"done","proposals":[{"action":"create_candidate","title":"新候选"},{"action":"update_task","title":"正式任务 A"},{"action":"update_task","title":"正式任务 B"}]}' ,
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-readable', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-readable'));
  const result = sent.find((message) => message.callId === 'call-readable');
  assert.equal(result.result.summary, '新建 1 张候选；已更新正式任务：正式任务 A、正式任务 B。');
});

test('ghost declares schedule support while retaining errand', () => {
  assert.equal(ghost.version, '0.5.0');
  assert.equal(ghost.id, 'ai-pm-intake');
  assert.equal(ghost.name, 'TooManyTasks');
  assert.match(ghost.description, /本机后台运行时菜单栏会显示 TooManyTasks，点击打开任务台/);
  assert.match(ghost.whenToUse, /本机后台运行时菜单栏会显示 TooManyTasks，点击打开任务台/);
  assert.equal(ghost.launch, 'resident');
  assert.deepEqual(Object.keys(ghost.agent).sort(), ['errand', 'schedule']);
  assert.equal(ghost.agent.errand, true);
  assert.equal(ghost.agent.schedule, true);
  const scanTool = ghost.tools.find((tool) => tool.name === 'scan_intake_window');
  assert.match(scanTool.description, /入库 errand 会话内禁止调用本工具/);
  assert.deepEqual(scanTool.parameters.properties.trigger.enum, ['manual', 'schedule']);
  assert.equal(scanTool.parameters.properties.trigger.default, 'manual');
  assert.equal(ghost.cindy.oneshotModel, 'codex/gpt-5.6-luna');
  assert.deepEqual(ghost.subscribe.topics, ['turn']);
  assert.deepEqual(ghost.subscribe.hooks, ['will-user-message']);
  assert.ok(ghost.tools.some((tool) => tool.name === 'update_pm_progress'));
  assert.ok(ghost.tools.some((tool) => tool.name === 'save_pm_sources'));
  assert.ok(ghost.tools.some((tool) => tool.name === 'submit_pm_decisions'));
  assert.equal(ghost.tools.some((tool) => tool.name === 'submit_intake'), false);
  assert.deepEqual(ghost.node.secretBindings.map((binding) => binding.key), [
    'pm_token',
    'pm_account_anchor',
    'pm_receipt_secret',
  ]);
});

test('main flow creates separate Bearer, account anchor and receipt secrets before ensuring the resident service', async () => {
  const { onHostMessage, nodeCalls, secretCalls, sent } = setup();
  onHostMessage({ type: 'tool-call', tool: 'get_pm_tasks', callId: 'call-ensure', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-ensure'));
  assert.equal(secretCalls.length, 3);
  assert.deepEqual(secretCalls.map((call) => call.url), [
    '/secrets/pm_token',
    '/secrets/pm_account_anchor',
    '/secrets/pm_receipt_secret',
  ]);
  const saved = secretCalls.map((call) => JSON.parse(call.options.body).value);
  assert.match(saved[0], /^cindy-/);
  assert.match(saved[1], /^cindy-account-/);
  assert.match(saved[2], /^cindy-receipt-/);
  assert.ok(saved[1].length >= 64);
  assert.ok(saved[2].length >= 64);
  assert.equal(nodeCalls[0].method, 'pm/ensure');
  assert.equal(nodeCalls[1].params.path, '/api/integrations/cindy/tasks');
});

test('save_pm_sources posts the declared source contract before decisions', async () => {
  const { onHostMessage, nodeCalls, sent } = setup();
  const args = {
    save_request_id: 'save-window-1',
    sources: [{
      client_ref: 's1', provider: 'feishu', source_kind: 'im_message', stable_message_id: 'om_1',
      occurred_at: '2026-08-24T01:05:00.000Z', sender_id: 'ou_1', display_name: '需求方', chat_id: 'oc_1',
      mentioned_owner: true, sender_is_owner: false, message_type: 'text', text: '新增需求。', revision: { sequence: 1 },
    }],
  };
  onHostMessage({ type: 'tool-call', tool: 'save_pm_sources', callId: 'call-save', args });
  await waitFor(() => sent.some((message) => message.callId === 'call-save'));
  const post = nodeCalls.find((call) => call.params?.path?.endsWith('/sources'));
  assert.equal(post.params.method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(post.params.body)), args);
  assert.equal(sent.find((message) => message.callId === 'call-save').result.sources[0].source_status, 'pending_decision');
});

test('save_pm_sources preserves MCP facts but rejects context beyond the hard boundary before HTTP', async () => {
  const { onHostMessage, nodeCalls, sent } = setup();
  const source = (index) => ({
    client_ref: `s${index}`,
    provider: 'feishu',
    source_kind: 'im_message',
    stable_message_id: `om_${index}`,
    occurred_at: `2026-08-24T01:${String(index).padStart(2, '0')}:00.000Z`,
    sender_id: `ou_${index}`,
    display_name: index === 0 ? { unsafe: 'object shape' } : '需求方',
    chat_id: 'oc_bounded',
    mentioned_owner: index === 0,
    sender_is_owner: false,
    message_type: 'text',
    reactions: [{ type: 'DONE', actor_is_owner: false }],
    text: '合成消息。',
  });
  onHostMessage({ type: 'tool-call', tool: 'save_pm_sources', callId: 'call-safe-shape', args: { save_request_id: 'save-safe-shape', sources: [source(0)] } });
  await waitFor(() => sent.some((message) => message.callId === 'call-safe-shape'));
  const posted = nodeCalls.find((call) => call.params?.body?.save_request_id === 'save-safe-shape');
  assert.deepEqual(posted.params.body.sources[0].display_name, { unsafe: 'object shape' });

  onHostMessage({
    type: 'tool-call', tool: 'save_pm_sources', callId: 'call-too-many',
    args: { save_request_id: 'save-too-many', sources: Array.from({ length: 21 }, (_, index) => source(index)) },
  });
  await waitFor(() => sent.some((message) => message.callId === 'call-too-many'));
  const failure = sent.find((message) => message.callId === 'call-too-many');
  assert.equal(failure.ok, false);
  assert.match(failure.message, /20 条限制/);
  assert.equal(nodeCalls.some((call) => call.params?.body?.save_request_id === 'save-too-many'), false);

  onHostMessage({
    type: 'tool-call', tool: 'save_pm_sources', callId: 'call-mixed-context',
    args: {
      save_request_id: 'save-mixed-context',
      sources: [
        { ...source(0), client_ref: 'threaded', stable_message_id: 'threaded', thread_id: 'thread-a' },
        ...Array.from({ length: 21 }, (_, index) => ({ ...source(index), client_ref: `plain-${index}`, stable_message_id: `plain-${index}` })),
      ],
    },
  });
  await waitFor(() => sent.some((message) => message.callId === 'call-mixed-context'));
  assert.match(sent.find((message) => message.callId === 'call-mixed-context').message, /20 条限制/);
  assert.equal(nodeCalls.some((call) => call.params?.body?.save_request_id === 'save-mixed-context'), false);

  const separateThreads = Array.from({ length: 120 }, (_, index) => ({
    ...source(index % 60),
    client_ref: `separate-${index}`,
    stable_message_id: `separate-${index}`,
    thread_id: index < 60 ? 'thread-a' : 'thread-b',
  }));
  onHostMessage({ type: 'tool-call', tool: 'save_pm_sources', callId: 'call-separate-threads', args: { save_request_id: 'save-separate-threads', sources: separateThreads } });
  await waitFor(() => sent.some((message) => message.callId === 'call-separate-threads'));
  assert.ok(nodeCalls.some((call) => call.params?.body?.save_request_id === 'save-separate-threads'));

  onHostMessage({
    type: 'tool-call', tool: 'save_pm_sources', callId: 'call-evidence-after-context',
    args: {
      save_request_id: 'save-evidence-after-context',
      sources: [
        { ...source(0), client_ref: 'before', stable_message_id: 'before', mentioned_owner: false },
        { ...source(1), client_ref: 'evidence', stable_message_id: 'evidence', mentioned_owner: true },
      ],
    },
  });
  await waitFor(() => sent.some((message) => message.callId === 'call-evidence-after-context'));
  assert.match(sent.find((message) => message.callId === 'call-evidence-after-context').message, /主人证据开始/);
  assert.equal(nodeCalls.some((call) => call.params?.body?.save_request_id === 'save-evidence-after-context'), false);
});

test('submit_pm_decisions posts receipts only and rejects update_task without CAS fields', async () => {
  const { onHostMessage, nodeCalls, sent } = setup();
  const args = {
    decision_request_id: 'decision-window-1',
    window_id: 'window-1',
    window_start: '2026-08-24T01:00:00.000Z',
    window_end: '2026-08-24T01:10:00.000Z',
    decisions: [{ decision_ref: 'd1', action: 'create_candidate', source_receipts: ['r'.repeat(43)], title: '新增需求' }],
  };
  onHostMessage({ type: 'tool-call', tool: 'submit_pm_decisions', callId: 'call-decide', args });
  await waitFor(() => sent.some((message) => message.callId === 'call-decide'));
  const post = nodeCalls.find((call) => call.params?.path?.endsWith('/decisions'));
  assert.deepEqual(JSON.parse(JSON.stringify(post.params.body)), args);
  assert.equal(JSON.stringify(post.params.body).includes('stable_message_id'), false);

  onHostMessage({
    type: 'tool-call',
    tool: 'submit_pm_decisions',
    callId: 'call-invalid-update',
    args: {
      decision_request_id: 'decision-invalid',
      window_id: 'window-1',
      window_start: '2026-08-24T01:00:00.000Z',
      window_end: '2026-08-24T01:10:00.000Z',
      decisions: [{ decision_ref: 'd1', action: 'update_task', source_receipts: ['r'.repeat(43)], next_step: '缺少 CAS 信息。' }],
    },
  });
  await waitFor(() => sent.some((message) => message.callId === 'call-invalid-update'));
  const failure = sent.find((message) => message.callId === 'call-invalid-update');
  assert.equal(failure.ok, false);
  assert.match(failure.message, /task_key/);
});

test('update_pm_progress keeps progress oneshot separate from intake errand', async () => {
  const { onHostMessage, nodeCalls, sent, errandCalls } = setup({
    progressModelText: JSON.stringify({ decision: 'bind', taskId: 'task-1', associationConfidence: 0.95, updateConfidence: 0, reason: '当前会话与候选任务匹配。', evidence: [] }),
  });
  onHostMessage({
    type: 'tool-call',
    tool: 'update_pm_progress',
    callId: 'call-progress',
    args: {
      goal: '完成活动留存核验',
      completed: '已复核数据口径',
      verification: '测试通过',
      blockers: '',
      next_step: '补充分组',
      status_hint: 'in_progress',
      session_context: { session_id: 'session-progress-1' },
    },
  });
  await waitFor(() => sent.some((message) => message.type === 'tool-result' && message.callId === 'call-progress'));
  const result = sent.find((message) => message.type === 'tool-result' && message.callId === 'call-progress');
  assert.equal(result.ok, true);
  assert.equal(result.result.mode, 'manual');
  assert.equal(errandCalls.length, 0);
  assert.equal(sent.some((message) => message.type === 'cindy-request' && message.kind === 'oneshot_text'), true);
  assert.equal(nodeCalls.some((request) => request.params?.path?.endsWith('/decisions')), false);
  assert.equal(nodeCalls.some((request) => request.params?.path?.endsWith('/turn-evaluations')), true);
});

test('automatic progress skips current and legacy intake errand sessions by session key', async () => {
  for (const sessionKey of ['intake', 'intake-v2']) {
    const { onHostMessage, nodeCalls, sent } = setup({ progressMode: 'automatic' });
    const sessionId = `session-${sessionKey}`;
    onHostMessage({
      type: 'event',
      name: 'will-user-message',
      hookId: `hook-${sessionKey}`,
      ts: Date.now(),
      data: { sessionId, sessionKey, source: 'user', text: '入库 errand' },
    });
    onHostMessage({
      type: 'event',
      name: 'did-turn-end',
      ts: Date.now(),
      data: { sessionId, sessionKey, source: 'user', endReason: 'completed' },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(nodeCalls.some((request) => request.method === 'cindy/read-completed-turn'), false);
    assert.equal(sent.some((message) => message.type === 'cindy-request'), false);
  }
});
