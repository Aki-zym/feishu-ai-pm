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

function setup({
  errandText = '{"status":"done","intake_submitted":true,"intake_window_id":"window-1","summary":"已提交。","proposals":[]}',
  errandResponse = null,
  errandError = null,
  errandGate = null,
  autoScanEnabled = false,
  scanResponse = { status: 'accepted', job_id: 'aily-scan:test', summary: '已请求后台扫描。' },
  inboxResponse = null,
  intakeStatus = { completed: true, result_kind: 'intake', proposal_count: 0 },
  progressMode = 'manual',
  progressEnabled = true,
  progressModelText = '{"decision":"no_update","reason":"无变化","evidence":[]}',
} = {}) {
  let onHostMessage;
  const nodeCalls = [];
  const sent = [];
  const errandCalls = [];
  const secretCalls = [];
  const cursorWrites = [];
  const intakePosts = [];
  const retryPosts = [];
  const intervals = [];
  const defaultInbox = {
    status: 'ready',
    inbox_id: 'aily-inbox:test',
    claim_token: 'claim-token-private',
    lease_until: '2026-08-27T09:10:00.000Z',
    attempt: 1,
    window: {
      window_id: 'intake-async-test',
      window_start: '2026-08-27T08:40:00.000Z',
      window_end: '2026-08-27T09:00:00.000Z',
    },
    source: {
      source_key: 'aily-summary:intake-async-test',
      source_kind: 'aily_summary',
      occurred_at: '2026-08-27T09:00:00.000Z',
      conversation_key: 'aily:agent_test',
      sender_role: 'Aily 摘要（派生来源）',
      agent_id: 'agent_test',
      generated_at: '2026-08-27T09:00:01.000Z',
      text: '窗口内有一条任务摘要。',
    },
  };
  const cindy = {
    onHostMessage(handler) { onHostMessage = handler; },
    node: {
      async request(request) {
        nodeCalls.push(request);
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
        if (request.params.path === '/api/runtime/intake-window') {
          const endMs = Date.now();
          const cursorMs = typeof intakeWindowEnd === 'string' ? Date.parse(intakeWindowEnd) : Number.NaN;
          const startMs = Number.isFinite(cursorMs)
            ? Math.max(Math.min(cursorMs, endMs), endMs - 4 * 60 * 60 * 1000)
            : endMs - 10 * 60 * 1000;
          const end = new Date(endMs).toISOString();
          const start = new Date(startMs).toISOString();
          return {
            ok: true,
            result: {
              window_id: `intake-${Date.parse(start)}-${Date.parse(end)}`,
              window_start: start,
              window_end: end,
              reused: false,
            },
          };
        }
        if (request.params.path === '/api/integrations/cindy/scan') {
          if (request.params.body?.trigger === 'schedule' && autoScanEnabled === false) {
            return {
              ok: true,
              result: {
                status: 'disabled',
                reason: 'auto_scan_disabled',
                summary: 'TooManyTasks 自动扫描已关闭。',
              },
            };
          }
          return { ok: true, result: scanResponse };
        }
        if (request.params.path === '/api/integrations/cindy/summary-inbox/next') {
          return { ok: true, result: inboxResponse ?? defaultInbox };
        }
        if (request.params.path.match(/^\/api\/integrations\/cindy\/summary-inbox\/[^/]+\/retry$/u)) {
          retryPosts.push(request.params.body);
          return { ok: true, result: { status: 'retry_waiting', attempts: 1 } };
        }
        if (request.params.path.match(/^\/api\/integrations\/cindy\/intake\/[^/]+\/status$/u)) {
          return {
            ok: true,
            result: intakeStatus,
          };
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
            items: [{ id: 'task-1', version: 2, auto_update_paused: false }],
            candidates: [{ id: 'candidate-1', title: '待确认需求', version: 1 }],
            cursors: [{ conversation_key: 'conversation-1', cursor: '2026-08-24T00:00:00.000Z' }],
          },
        };
        if (request.params.path.endsWith('/intake')) {
          intakePosts.push(request.params.body);
          return { ok: true, result: { accepted: true, intake_id: 'intake-1' } };
        }
        throw new Error(`unexpected node request: ${JSON.stringify(request)}`);
      },
    },
    agent: {
      async errand(request) {
        errandCalls.push(request);
        if (errandGate) await errandGate;
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
      if (url === '/secrets/pm_token' && options.method === 'PUT') {
        secretCalls.push({ url, options });
        return { ok: true, json: async () => ({}) };
      }
      return { json: async () => ({ pmBaseUrl: 'http://127.0.0.1:4310', progressMode, progressEnabled }) };
    },
    setInterval(callback, delay) {
      const timer = { callback, delay };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) {
      if (timer) timer.cleared = true;
    },
    setTimeout,
    Date,
    JSON,
    Number,
    Error,
  }), { filename: 'main.js' });
  return {
    onHostMessage,
    nodeCalls,
    sent,
    errandCalls,
    secretCalls,
    cursorWrites,
    intakePosts,
    retryPosts,
    intervals,
    defaultInbox,
  };
}

test('scan_intake_window only asks independent TooManyTasks to start an asynchronous Aily scan', async () => {
  const { onHostMessage, nodeCalls, errandCalls, sent } = setup();
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-scan', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-scan'));
  assert.equal(errandCalls.length, 0);
  const scanCall = nodeCalls.find((call) => call.params?.path === '/api/integrations/cindy/scan');
  assert.ok(scanCall);
  assert.equal(scanCall.method, 'pm/request');
  assert.equal(scanCall.params.method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(scanCall.params.body)), { trigger: 'manual' });
  assert.equal(scanCall.timeoutMs, 30000);
  const result = sent.find((message) => message.callId === 'call-scan');
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'accepted');
  assert.equal(result.result.job_id, 'aily-scan:test');
  assert.equal(nodeCalls[0].params.path, '/api/integrations/cindy/scan');
  assert.equal(nodeCalls.some((call) => call.method === 'aily/summarize'), false);
});

test('the non-empty errand source contract passes the real plugin validator only with all Aily metadata', async () => {
  const { onHostMessage, sent, intakePosts } = setup();
  const base = {
    window_id: 'window-validator',
    window_start: '2026-08-24T01:00:00.000Z',
    window_end: '2026-08-24T01:10:00.000Z',
    result_kind: 'intake',
    proposals: [{
      action: 'create_candidate',
      source_keys: ['aily-summary:window-validator'],
      title: '校验来源',
    }],
  };
  onHostMessage({
    type: 'tool-call',
    tool: 'submit_intake',
    callId: 'call-validator-missing',
    args: {
      ...base,
      sources: [{
        source_key: 'aily-summary:window-validator',
        source_kind: 'aily_summary',
        occurred_at: base.window_end,
        conversation_key: 'aily:agent_test_123',
        sender_role: 'Aily 摘要（派生来源）',
        text: '摘要。',
      }],
    },
  });
  await waitFor(() => sent.some((message) => message.callId === 'call-validator-missing'));
  assert.equal(sent.find((message) => message.callId === 'call-validator-missing').ok, false);
  assert.match(sent.find((message) => message.callId === 'call-validator-missing').message, /agent_id/);
  assert.equal(intakePosts.length, 0);

  onHostMessage({
    type: 'tool-call',
    tool: 'submit_intake',
    callId: 'call-validator-complete',
    args: {
      ...base,
      sources: [{
        source_key: 'aily-summary:window-validator',
        source_kind: 'aily_summary',
        occurred_at: base.window_end,
        conversation_key: 'aily:agent_test_123',
        sender_role: 'Aily 摘要（派生来源）',
        agent_id: 'agent_test_123',
        generated_at: '2026-08-24T01:10:01.000Z',
        text: '摘要。',
      }],
    },
  });
  await waitFor(() => sent.some((message) => message.callId === 'call-validator-complete'));
  assert.equal(sent.find((message) => message.callId === 'call-validator-complete').ok, true);
  assert.equal(intakePosts.length, 1);
  assert.equal(intakePosts[0].sources[0].agent_id, 'agent_test_123');
  assert.equal(intakePosts[0].sources[0].generated_at, '2026-08-24T01:10:01.000Z');
});

test('the resident plugin polls one Aily inbox item every five minutes and starts the fixed intake errand', async () => {
  const { intervals, nodeCalls, errandCalls } = setup();
  const timer = intervals.find((item) => item.delay === 5 * 60 * 1000);
  assert.ok(timer);
  await timer.callback();
  assert.equal(errandCalls.length, 1);
  assert.equal(errandCalls[0].sessionKey, 'intake');
  assert.equal(errandCalls[0].mode, 'wait');
  assert.match(errandCalls[0].task, /get_pm_tasks/);
  assert.match(errandCalls[0].task, /submit_intake/);
  assert.match(errandCalls[0].task, /Aily Agent ID：agent_test/);
  assert.match(errandCalls[0].task, /不得读取飞书/);
  assert.doesNotMatch(errandCalls[0].task, /claim-token-private/);
  assert.equal(nodeCalls.filter((call) => call.params?.path === '/api/integrations/cindy/summary-inbox/next').length, 1);
  assert.equal(nodeCalls.some((call) => call.params?.path === '/api/integrations/cindy/scan'), false);
});

test('the five-minute inbox poll does nothing when TooManyTasks has no ready summary', async () => {
  const { intervals, errandCalls } = setup({ inboxResponse: { status: 'empty' } });
  const timer = intervals.find((item) => item.delay === 5 * 60 * 1000);
  assert.ok(timer);
  await timer.callback();
  assert.equal(errandCalls.length, 0);
});

test('only one inbox errand runs at a time', async () => {
  let release;
  const errandGate = new Promise((resolve) => { release = resolve; });
  const { intervals, errandCalls, nodeCalls } = setup({ errandGate });
  const timer = intervals.find((item) => item.delay === 5 * 60 * 1000);
  assert.ok(timer);
  const first = timer.callback();
  await waitFor(() => errandCalls.length === 1);
  const second = timer.callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errandCalls.length, 1);
  assert.equal(nodeCalls.filter((call) => call.params?.path === '/api/integrations/cindy/summary-inbox/next').length, 1);
  release();
  await Promise.all([first, second]);
});

test('submit_intake injects the active inbox claim without exposing it to the model prompt', async () => {
  let release;
  const errandGate = new Promise((resolve) => { release = resolve; });
  const { intervals, onHostMessage, errandCalls, intakePosts, sent, defaultInbox } = setup({ errandGate });
  const timer = intervals.find((item) => item.delay === 5 * 60 * 1000);
  const polling = timer.callback();
  await waitFor(() => errandCalls.length === 1);
  onHostMessage({
    type: 'tool-call',
    tool: 'submit_intake',
    callId: 'call-inbox-submit',
    args: {
      ...defaultInbox.window,
      result_kind: 'intake',
      sources: [defaultInbox.source],
      proposals: [{ action: 'skip', source_keys: [defaultInbox.source.source_key], reason: '暂不入库。' }],
    },
  });
  await waitFor(() => sent.some((message) => message.callId === 'call-inbox-submit'));
  assert.equal(intakePosts.length, 1);
  assert.equal(intakePosts[0].inbox_id, defaultInbox.inbox_id);
  assert.equal(intakePosts[0].claim_token, defaultInbox.claim_token);
  assert.doesNotMatch(errandCalls[0].task, new RegExp(defaultInbox.claim_token, 'u'));
  release();
  await polling;
});

test('errand failure returns the claim to TooManyTasks with a controlled error code', async () => {
  const { intervals, retryPosts } = setup({
    errandResponse: { ok: false, errorCode: 'BUSY', message: 'intake session occupied' },
  });
  const timer = intervals.find((item) => item.delay === 5 * 60 * 1000);
  await timer.callback();
  assert.equal(retryPosts.length, 1);
  assert.equal(retryPosts[0].claim_token, 'claim-token-private');
  assert.equal(retryPosts[0].error_code, 'CINDY_ERRAND_BUSY');
});

test('a model success message cannot replace the server intake receipt', async () => {
  const { intervals, retryPosts } = setup({
    intakeStatus: { completed: false, result_kind: null, proposal_count: 0 },
    errandText: '{"status":"done","intake_submitted":true,"summary":"我已提交。","proposals":[]}',
  });
  const timer = intervals.find((item) => item.delay === 5 * 60 * 1000);
  await timer.callback();
  assert.equal(retryPosts.length, 1);
  assert.equal(retryPosts[0].error_code, 'CINDY_INTAKE_NOT_CONFIRMED');
});

test('scan_intake_window skips recursive triggers inside the intake errand session', async () => {
  const { onHostMessage, nodeCalls, sent } = setup();
  onHostMessage({
    type: 'tool-call',
    tool: 'scan_intake_window',
    callId: 'call-nested-intake',
    args: { session_context: { session: { sessionKey: 'intake' } } },
  });
  await waitFor(() => sent.some((message) => message.callId === 'call-nested-intake'));
  const result = sent.find((message) => message.callId === 'call-nested-intake');
  assert.equal(nodeCalls.length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.result.reason, 'already_in_intake_errand');
});

test('get_pm_tasks exposes task items, pending candidates, and read cursors', async () => {
  const { onHostMessage, sent } = setup();
  onHostMessage({ type: 'tool-call', tool: 'get_pm_tasks', callId: 'call-snapshot', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-snapshot'));
  const result = sent.find((message) => message.callId === 'call-snapshot');
  assert.deepEqual(Object.keys(result.result).sort(), ['candidates', 'cursors', 'items']);
  assert.equal(result.result.items[0].id, 'task-1');
  assert.equal(result.result.items[0].auto_update_paused, false);
  assert.equal(result.result.candidates[0].id, 'candidate-1');
  assert.equal(result.result.cursors[0].conversation_key, 'conversation-1');
});

test('ghost keeps resident errand support only', () => {
  assert.equal(ghost.version, '0.7.0');
  assert.equal(ghost.id, 'ai-pm-intake');
  assert.equal(ghost.name, 'TooManyTasks');
  assert.match(ghost.description, /独立运行的 TooManyTasks/);
  assert.match(ghost.whenToUse, /独立 TooManyTasks/);
  assert.equal(ghost.launch, 'resident');
  assert.deepEqual(Object.keys(ghost.agent).sort(), ['errand']);
  assert.equal(ghost.agent.errand, true);
  assert.equal('schedule' in ghost.agent, false);
  const scanTool = ghost.tools.find((tool) => tool.name === 'scan_intake_window');
  assert.match(scanTool.description, /后台 Aily 扫描/);
  assert.match(scanTool.description, /独立 TooManyTasks/);
  assert.deepEqual(scanTool.parameters.properties.trigger.enum, ['manual', 'schedule']);
  assert.equal(scanTool.parameters.properties.trigger.default, 'manual');
  assert.equal(ghost.cindy.oneshotModel, 'codex/gpt-5.6-luna');
  assert.deepEqual(ghost.subscribe.topics, ['turn']);
  assert.deepEqual(ghost.subscribe.hooks, ['will-user-message']);
  assert.ok(ghost.tools.some((tool) => tool.name === 'update_pm_progress'));
  assert.equal('secretBindings' in ghost.node, false);
});

test('main flow calls the independent task service without creating plugin secrets or ensuring a resident service', async () => {
  const { onHostMessage, nodeCalls, secretCalls, sent } = setup();
  onHostMessage({ type: 'tool-call', tool: 'get_pm_tasks', callId: 'call-ensure', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-ensure'));
  assert.equal(secretCalls.length, 0);
  assert.equal(nodeCalls.length, 1);
  assert.equal(nodeCalls[0].method, 'pm/request');
  assert.equal(nodeCalls[0].params.path, '/api/integrations/cindy/tasks');
});

test('submit_intake posts the declared source and proposal contract', async () => {
  const { onHostMessage, nodeCalls, sent } = setup();
  const args = {
    window_id: 'window-1',
    window_start: '2026-08-24T01:00:00.000Z',
    window_end: '2026-08-24T01:10:00.000Z',
    result_kind: 'intake',
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

test('submit_intake preserves the controlled Aily source metadata', async () => {
  const { onHostMessage, nodeCalls, sent } = setup();
  const args = {
    window_id: 'window-aily-1',
    window_start: '2026-08-24T01:00:00.000Z',
    window_end: '2026-08-24T01:10:00.000Z',
    result_kind: 'intake',
    sources: [{
      source_key: 'aily-summary:window-aily-1',
      source_kind: 'aily_summary',
      occurred_at: '2026-08-24T01:10:00.000Z',
      conversation_key: 'aily:agent_test_123',
      sender_role: 'Aily 摘要（派生来源）',
      agent_id: 'agent_test_123',
      generated_at: '2026-08-24T01:10:01.000Z',
      text: '窗口内发现一项新任务。',
    }],
    proposals: [{
      action: 'create_candidate',
      source_keys: ['aily-summary:window-aily-1'],
      title: '新任务',
    }],
  };
  onHostMessage({ type: 'tool-call', tool: 'submit_intake', callId: 'call-submit-aily', args });
  await waitFor(() => sent.some((message) => message.callId === 'call-submit-aily'));
  const post = nodeCalls.find((call) => call.params?.path?.endsWith('/intake'));
  assert.deepEqual(JSON.parse(JSON.stringify(post.params.body)), args);
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
      result_kind: 'intake',
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
      result_kind: 'intake',
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
  assert.equal(nodeCalls.some((request) => request.params?.path?.endsWith('/intake')), false);
  assert.equal(nodeCalls.some((request) => request.params?.path?.endsWith('/turn-evaluations')), true);
});

test('automatic progress skips the intake errand session', async () => {
  const { onHostMessage, nodeCalls, sent } = setup({ progressMode: 'automatic' });
  onHostMessage({
    type: 'event',
    name: 'will-user-message',
    hookId: 'hook-intake',
    ts: Date.now(),
    data: { sessionId: 'session-intake', sessionKey: 'intake', source: 'plugin', text: '入库 errand' },
  });
  onHostMessage({
    type: 'event',
    name: 'did-turn-end',
    ts: Date.now(),
    data: { sessionId: 'session-intake', sessionKey: 'intake', source: 'plugin', endReason: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(nodeCalls.some((request) => request.method === 'cindy/read-completed-turn'), false);
  assert.equal(sent.some((message) => message.type === 'cindy-request'), false);
});
