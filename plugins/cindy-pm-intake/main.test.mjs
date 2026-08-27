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

function setup({ errandText = '{"status":"done","intake_submitted":true,"intake_window_id":"window-1","summary":"已提交。","proposals":[]}', errandResponse = null, errandError = null, errandGate = null, ailyText = '窗口内有一条任务摘要。', ailyResponse = null, ailyError = null, autoScanEnabled = false, intakeWindowEnd = null, intakeStatus = { completed: true, result_kind: 'intake', proposal_count: 0 }, progressMode = 'manual', progressEnabled = true, progressModelText = '{"decision":"no_update","reason":"无变化","evidence":[]}' } = {}) {
  let onHostMessage;
  const nodeCalls = [];
  const sent = [];
  const errandCalls = [];
  const secretCalls = [];
  const cursorWrites = [];
  const intakePosts = [];
  const intervals = [];
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
          const endMs = Date.now();
          const cursorMs = typeof intakeWindowEnd === 'string' ? Date.parse(intakeWindowEnd) : Number.NaN;
          const startMs = Number.isFinite(cursorMs)
            ? Math.max(Math.min(cursorMs, endMs), endMs - 4 * 60 * 60 * 1000)
            : endMs - 10 * 60 * 1000;
          const window = {
            window_id: `intake-${startMs}-${endMs}`,
            window_start: new Date(startMs).toISOString(),
            window_end: new Date(endMs).toISOString(),
            reused: false,
          };
          if (request.params.body?.trigger === 'schedule' && autoScanEnabled === false) {
            return {
              ok: true,
              result: {
                ...window,
                status: 'skipped',
                reason: 'auto_scan_disabled',
                summary: 'TooManyTasks 自动扫描已关闭。',
                aily_status: 'not_started',
                aily_summary_generated: false,
                proposals: [],
              },
            };
          }
          if (ailyError) {
            return {
              ok: true,
              result: {
                ...window,
                status: 'failed',
                reason: 'aily_failed',
                summary: 'Aily 摘要失败，未启动 Cindy 入库判断，也未推进窗口游标。',
                aily_status: 'failed',
                aily_summary_generated: false,
                aily_error_code: ailyError.code || 'AILY_FAILED',
                proposals: [],
              },
            };
          }
          if (/^NO_NEW_INFORMATION[。.!！?？]*$/u.test(ailyText.trim())) {
            return {
              ok: true,
              result: {
                ...window,
                status: 'skipped',
                reason: 'aily_empty',
                summary: 'Aily 在本次窗口没有发现新的任务相关信息，已推进窗口游标。',
                aily_status: 'Completed',
                aily_summary_generated: false,
                intake_result: { window_id: window.window_id, result_kind: 'empty_window' },
                proposals: [],
              },
            };
          }
          if (ailyResponse) return ailyResponse;
          const generatedAt = new Date(endMs + 1).toISOString();
          return {
            ok: true,
            result: {
              ...window,
              status: 'summary_ready',
              reason: null,
              summary: 'Aily 已生成窗口摘要。',
              aily_status: 'Completed',
              aily_summary_generated: true,
              aily_agent_id: 'agent_4kx9t1gjymdxf0w',
              aily_chat_id_suffix: '12345678',
              aily_session_id_present: true,
              source: {
                source_key: `aily-summary:${window.window_id}`,
                source_kind: 'aily_summary',
                occurred_at: window.window_end,
                conversation_key: 'aily:agent_4kx9t1gjymdxf0w',
                sender_role: 'Aily 摘要（派生来源）',
                agent_id: 'agent_4kx9t1gjymdxf0w',
                generated_at: generatedAt,
                text: ailyText,
              },
              proposals: [],
            },
          };
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
  return { onHostMessage, nodeCalls, sent, errandCalls, secretCalls, cursorWrites, intakePosts, intervals };
}

test('scan_intake_window asks independent TooManyTasks for the Aily summary before the fixed intake errand', async () => {
  const { onHostMessage, nodeCalls, errandCalls, sent, cursorWrites, intakePosts } = setup();
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-scan', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-scan'));
  assert.equal(errandCalls.length, 1);
  assert.equal(errandCalls[0].sessionKey, 'intake');
  assert.equal(errandCalls[0].mode, 'wait');
  assert.equal(errandCalls[0].callId, 'call-scan');
  const scanCall = nodeCalls.find((call) => call.params?.path === '/api/integrations/cindy/scan');
  assert.ok(scanCall);
  assert.equal(scanCall.method, 'pm/request');
  assert.equal(scanCall.params.method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(scanCall.params.body)), { trigger: 'manual' });
  assert.equal(scanCall.timeoutMs, 120000);
  assert.match(errandCalls[0].task, /get_pm_tasks/);
  assert.match(errandCalls[0].task, /items、candidates、cursors/);
  assert.match(errandCalls[0].task, /submit_intake/);
  assert.match(errandCalls[0].task, /Aily 摘要/);
  assert.match(errandCalls[0].task, /source_kind/);
  assert.match(errandCalls[0].task, /Aily Agent ID：agent_4kx9t1gjymdxf0w/);
  assert.match(errandCalls[0].task, /摘要生成时间：/);
  assert.match(errandCalls[0].task, /agent_id、generated_at/);
  assert.match(errandCalls[0].task, /不得读取飞书/);
  assert.doesNotMatch(errandCalls[0].task, /飞书 MCP/);
  assert.match(errandCalls[0].task, /\/api\/tasks/);
  assert.match(errandCalls[0].task, /CAS/);
  assert.match(errandCalls[0].task, /create_candidate.*只创建候选/);
  assert.doesNotMatch(errandCalls[0].task, /im_read_messages/);
  assert.doesNotMatch(errandCalls[0].task, /读取消息整理为 sources/);
  assert.match(errandCalls[0].task, /\[\{"action"/);
  assert.equal('model' in errandCalls[0], false);
  assert.equal('provider' in errandCalls[0], false);
  assert.equal('effort' in errandCalls[0], false);
  assert.equal('permissionMode' in errandCalls[0], false);
  const result = sent.find((message) => message.callId === 'call-scan');
  assert.equal(result.ok, true);
  assert.equal(result.result.job_id, 'job-1');
  assert.equal(result.result.session_id, 'session-intake');
  assert.equal(result.result.status, 'done');
  assert.equal(result.result.aily_status, 'Completed');
  assert.equal(result.result.aily_summary_generated, true);
  assert.equal(result.result.cindy_result.intake_submitted, true);
  assert.equal(result.result.cindy_result.server_receipt_verified, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.proposals)), []);
  const firstWindowDuration = Date.parse(result.result.window_end) - Date.parse(result.result.window_start);
  assert.ok(firstWindowDuration >= 10 * 60 * 1000);
  assert.ok(firstWindowDuration < 10 * 60 * 1000 + 2000);
  assert.equal(nodeCalls[0].params.path, '/api/integrations/cindy/scan');
  assert.equal(nodeCalls.some((call) => call.method === 'aily/summarize'), false);
  assert.equal(nodeCalls.some((call) => call.params?.path === '/api/runtime/intake-cursor'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(cursorWrites)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(intakePosts)), []);
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

test('Aily returns no new information: submit an explicit empty window and advance', async () => {
  const { onHostMessage, nodeCalls, errandCalls, intakePosts, sent } = setup({ ailyText: 'NO_NEW_INFORMATION' });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-aily-empty', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-aily-empty'));
  const result = sent.find((message) => message.callId === 'call-aily-empty');
  assert.equal(result.ok, true);
  assert.equal(result.result.reason, 'aily_empty');
  assert.equal(result.result.aily_status, 'Completed');
  assert.equal(result.result.aily_summary_generated, false);
  assert.equal(errandCalls.length, 0);
  assert.equal(intakePosts.length, 0);
  assert.equal(result.result.intake_result.result_kind, 'empty_window');
  assert.equal(nodeCalls.some((call) => call.params?.path === '/api/integrations/cindy/scan'), true);
});

test('Chinese empty-summary equivalents are treated as real summaries and sent to the errand', async () => {
  for (const [index, ailyText] of ['没有新信息', '窗口内没有新信息'].entries()) {
    const { onHostMessage, errandCalls, intakePosts, sent } = setup({ ailyText });
    const callId = `call-aily-chinese-${index}`;
    onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId, args: {} });
    await waitFor(() => sent.some((message) => message.callId === callId));
    const result = sent.find((message) => message.callId === callId);
    assert.equal(result.ok, true);
    assert.equal(result.result.aily_summary_generated, true);
    assert.equal(errandCalls.length, 1);
    assert.equal(intakePosts.length, 0);
  }
});

test('Aily failure returns a classified status without starting Cindy or moving the cursor', async () => {
  const failure = new Error('Aily 用户访问 Token 已失效或无权限，请重新授权或更新 Aily Token。');
  failure.code = 'AILY_AUTH_REQUIRED';
  const { onHostMessage, nodeCalls, errandCalls, intakePosts, sent } = setup({ ailyError: failure });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-aily-failed', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-aily-failed'));
  const result = sent.find((message) => message.callId === 'call-aily-failed');
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'failed');
  assert.equal(result.result.reason, 'aily_failed');
  assert.equal(result.result.aily_error_code, 'AILY_AUTH_REQUIRED');
  assert.equal(errandCalls.length, 0);
  assert.equal(intakePosts.length, 0);
  assert.equal(nodeCalls.some((call) => call.params?.path === '/api/integrations/cindy/scan'), true);
});

test('schedule scan skips the errand when the product auto-scan switch is disabled', async () => {
  const { onHostMessage, nodeCalls, errandCalls, sent } = setup({ autoScanEnabled: false });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-schedule-off', args: { trigger: 'schedule' } });
  await waitFor(() => sent.some((message) => message.callId === 'call-schedule-off'));
  const result = sent.find((message) => message.callId === 'call-schedule-off');
  assert.equal(errandCalls.length, 0);
  assert.equal(nodeCalls.some((call) => call.params?.path === '/api/integrations/cindy/scan'), true);
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

test('schedule scan skips the round when the errand host reports BUSY', async () => {
  const { onHostMessage, errandCalls, sent } = setup({
    autoScanEnabled: true,
    errandResponse: { ok: false, errorCode: 'BUSY', message: '已有 intake session occupied' },
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-schedule-busy', args: { trigger: 'schedule' } });
  await waitFor(() => sent.some((message) => message.callId === 'call-schedule-busy'));
  const result = sent.find((message) => message.callId === 'call-schedule-busy');
  assert.equal(errandCalls.length, 1);
  assert.equal(result.result.reason, 'intake_scan_busy');
  assert.match(result.result.summary, /跳过/);
});

test('manual scan runs even when the product auto-scan switch is disabled', async () => {
  const { onHostMessage, nodeCalls, errandCalls, sent } = setup({ autoScanEnabled: false });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-manual-off', args: { trigger: 'manual' } });
  await waitFor(() => sent.some((message) => message.callId === 'call-manual-off'));
  assert.equal(errandCalls.length, 1);
  assert.equal(nodeCalls.some((call) => call.params?.path === '/api/integrations/cindy/scan'), true);
});

test('resident scan loop skips a round when auto-scan is disabled', async () => {
  const { intervals, nodeCalls, errandCalls } = setup({ autoScanEnabled: false });
  const timer = intervals.find((item) => item.delay === 10 * 60 * 1000);
  assert.ok(timer);
  await timer.callback();
  assert.equal(errandCalls.length, 0);
  assert.equal(nodeCalls.some((call) => call.params?.path === '/api/integrations/cindy/scan'), true);
});

test('resident scan loop dispatches a schedule scan when auto-scan is enabled', async () => {
  const { intervals, nodeCalls, errandCalls } = setup({ autoScanEnabled: true });
  const timer = intervals.find((item) => item.delay === 10 * 60 * 1000);
  assert.ok(timer);
  await timer.callback();
  assert.equal(errandCalls.length, 1);
  assert.equal(errandCalls[0].sessionKey, 'intake');
  assert.equal(nodeCalls.some((call) => call.params?.path === '/api/integrations/cindy/scan'), true);
});

test('resident scan loop skips a round while another intake scan is running', async () => {
  let release;
  const errandGate = new Promise((resolve) => { release = resolve; });
  const { intervals, errandCalls } = setup({ autoScanEnabled: true, errandGate });
  const timer = intervals.find((item) => item.delay === 10 * 60 * 1000);
  assert.ok(timer);
  const first = timer.callback();
  await waitFor(() => errandCalls.length === 1);
  await timer.callback();
  assert.equal(errandCalls.length, 1);
  release();
  await first;
});

test('scan_intake_window skips nested dispatch inside the intake errand session', async () => {
  const { onHostMessage, nodeCalls, errandCalls, sent } = setup();
  onHostMessage({
    type: 'tool-call',
    tool: 'scan_intake_window',
    callId: 'call-nested-intake',
    args: { session_context: { session: { sessionKey: 'intake' } } },
  });
  await waitFor(() => sent.some((message) => message.callId === 'call-nested-intake'));
  const result = sent.find((message) => message.callId === 'call-nested-intake');
  assert.equal(errandCalls.length, 0);
  assert.equal(nodeCalls.length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.result.reason, 'already_in_intake_errand');
  assert.doesNotMatch(result.result.next_action, /飞书 MCP/);
  assert.match(result.result.next_action, /不要再次调用 scan_intake_window/);
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
  assert.doesNotMatch(result.result.next_action, /飞书 MCP/);
  assert.match(result.result.next_action, /不要再次调用 scan_intake_window/);
  assert.equal(nodeCalls[0].params.path, '/api/integrations/cindy/scan');
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
  assert.doesNotMatch(result.result.next_action, /飞书 MCP/);
});

test('Cindy errand failure returns a structured result and keeps the window unadvanced', async () => {
  const { onHostMessage, nodeCalls, errandCalls, intakePosts, sent } = setup({
    errandResponse: { ok: false, errorCode: 'CINDY_FAILED', message: 'errand failed' },
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-cindy-failed', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-cindy-failed'));
  const result = sent.find((message) => message.callId === 'call-cindy-failed');
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'failed');
  assert.equal(result.result.reason, 'cindy_failed');
  assert.equal(result.result.aily_summary_generated, true);
  assert.equal(result.result.cindy_result.reason, 'errand_failed');
  assert.equal(result.result.cindy_result.error_code, 'CINDY_FAILED');
  assert.equal(errandCalls.length, 1);
  assert.equal(intakePosts.length, 0);
  assert.equal(nodeCalls.some((call) => call.params?.path?.endsWith('/intake')), false);
});

test('Cindy text cannot stand in for a missing server intake receipt', async () => {
  const { onHostMessage, nodeCalls, sent } = setup({
    intakeStatus: { completed: false, result_kind: null, proposal_count: 0 },
    errandText: '{"status":"done","intake_submitted":true,"intake_window_id":"window-1","summary":"我已提交。","proposals":[]}',
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-unconfirmed-receipt', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-unconfirmed-receipt'));
  const result = sent.find((message) => message.callId === 'call-unconfirmed-receipt');
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'failed');
  assert.equal(result.result.reason, 'cindy_intake_not_confirmed');
  assert.equal(result.result.cindy_result.server_receipt_verified, false);
  assert.equal(nodeCalls.some((call) => call.params?.path?.endsWith('/intake')), false);
});

test('server intake receipt remains authoritative when Cindy final text is not valid JSON', async () => {
  const { onHostMessage, sent } = setup({
    intakeStatus: { completed: true, result_kind: 'intake', proposal_count: 2 },
    errandText: '已完成提交，但最终回复没有按约定输出 JSON。',
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-authoritative-receipt', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-authoritative-receipt'));
  const result = sent.find((message) => message.callId === 'call-authoritative-receipt');
  assert.equal(result.ok, true);
  assert.notEqual(result.result.status, 'failed');
  assert.equal(result.result.cindy_result.intake_submitted, true);
  assert.equal(result.result.cindy_result.server_receipt_verified, true);
  assert.equal(result.result.cindy_result.model_confirmation_present, false);
  assert.equal(result.result.summary, '服务端已确认提交 2 条入库提案。');
});

test('server intake receipt overrides a contradictory failed status in Cindy final text', async () => {
  const { onHostMessage, sent } = setup({
    intakeStatus: { completed: true, result_kind: 'intake', proposal_count: 1 },
    errandText: '{"status":"failed","reason":"errand_failed","summary":"模型误报失败。","proposals":[]}',
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-contradictory-model-status', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-contradictory-model-status'));
  const result = sent.find((message) => message.callId === 'call-contradictory-model-status');
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'done');
  assert.equal(result.result.reason, null);
  assert.equal(result.result.cindy_result.status, 'succeeded');
  assert.equal(result.result.cindy_result.server_receipt_verified, true);
  assert.equal(result.result.summary, '服务端已确认提交 1 条入库提案。');
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

test('scan result returns a readable short proposal list with action and title', async () => {
  const { onHostMessage, sent, cursorWrites } = setup({
    errandText: '{"status":"done","intake_submitted":true,"intake_window_id":"window-1","summary":"已更新已有任务。","proposals":[{"action":"update_task","title":"活动留存分析"},{"action":"skip","title":"礼貌确认"}]}',
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
    errandText: '{"status":"done","intake_submitted":true,"intake_window_id":"window-1","proposals":[{"action":"create_candidate","title":"新候选"},{"action":"update_task","title":"正式任务 A"},{"action":"update_task","title":"正式任务 B"}]}' ,
  });
  onHostMessage({ type: 'tool-call', tool: 'scan_intake_window', callId: 'call-readable', args: {} });
  await waitFor(() => sent.some((message) => message.callId === 'call-readable'));
  const result = sent.find((message) => message.callId === 'call-readable');
  assert.equal(result.result.summary, '新建 1 张候选；已更新正式任务：正式任务 A、正式任务 B。');
});

test('ghost keeps resident errand support only', () => {
  assert.equal(ghost.version, '0.6.0');
  assert.equal(ghost.id, 'ai-pm-intake');
  assert.equal(ghost.name, 'TooManyTasks');
  assert.match(ghost.description, /独立运行的 TooManyTasks/);
  assert.match(ghost.whenToUse, /独立 TooManyTasks/);
  assert.equal(ghost.launch, 'resident');
  assert.deepEqual(Object.keys(ghost.agent).sort(), ['errand']);
  assert.equal(ghost.agent.errand, true);
  assert.equal('schedule' in ghost.agent, false);
  const scanTool = ghost.tools.find((tool) => tool.name === 'scan_intake_window');
  assert.match(scanTool.description, /入库 errand 会话内禁止调用本工具/);
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
