import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { NormalizedSourceEvent, OwnerIntentAction } from '../src/domain.js';
import { OpenAICompatibleClassifier } from '../src/integrations/llm.js';

type ModelPayload = Record<string, unknown>;
type ReplayMessage = {
  text: string;
  sender: 'owner' | 'requester';
  occurredAt: string;
};
type ReplayScenario = {
  name: string;
  messages: ReplayMessage[];
  expected: OwnerIntentAction;
  scheduleText?: string | null;
  delegateTo?: string | null;
};

const baseOutput: ModelPayload = {
  is_data_request: false,
  title: null,
  proposer_name: '需求方',
  background: '',
  validation_question: '',
  describe: '',
  confidence: 0.92,
  related_task_hint: null,
  important_dates: [],
  deliverables: [],
  commitments: [],
  priority_suggestion: null,
  note: null,
  status_suggestion: null,
  next_step_suggestion: null,
  waiting_reason_suggestion: null,
  update_confidence: null,
  reason: '回放模型给出主人消息意图。',
  time_range: {
    status: 'unknown',
    source_text: null,
    start_at: null,
    end_at: null,
    timezone: 'Asia/Shanghai',
    needs_confirmation: true,
  },
  field_basis: { background: 'unknown', validation_question: 'unknown', describe: 'unknown' },
};

const scenarios: ReplayScenario[] = [
  {
    name: '承接后继续推进',
    messages: [
      { text: '想做一个活动留存分析，先看下能不能排期。', sender: 'requester', occurredAt: '2026-08-10T09:00:00.000Z' },
      { text: '我来做，先把口径和数据范围对一下。', sender: 'owner', occurredAt: '2026-08-10T09:05:00.000Z' },
    ],
    expected: 'continue',
  },
  {
    name: '确认明确交付日期',
    messages: [
      { text: '这个活动希望下周交付，可以吗？', sender: 'requester', occurredAt: '2026-08-10T10:00:00.000Z' },
      { text: '可以，我来做，周三前给你。', sender: 'owner', occurredAt: '2026-08-10T10:10:00.000Z' },
    ],
    expected: 'confirm_schedule',
    scheduleText: '周三前',
  },
  {
    name: '索要资料并等待背景',
    messages: [
      { text: '想看这个版本的付费转化。', sender: 'requester', occurredAt: '2026-08-10T11:00:00.000Z' },
      { text: '把策划案和埋点表发我，我先看背景。', sender: 'owner', occurredAt: '2026-08-10T11:08:00.000Z' },
    ],
    expected: 'request_context',
  },
  {
    name: '明确不是主人负责',
    messages: [
      { text: '能不能帮忙做一下活动埋点？', sender: 'requester', occurredAt: '2026-08-10T12:00:00.000Z' },
      { text: '这个不是我做，你问负责埋点的同学吧。', sender: 'owner', occurredAt: '2026-08-10T12:06:00.000Z' },
    ],
    expected: 'decline',
  },
  {
    name: '明确转交指定人员',
    messages: [
      { text: '希望把活动参与和留存一起分析。', sender: 'requester', occurredAt: '2026-08-10T13:00:00.000Z' },
      { text: '埋点让小王负责，我来帮忙看数据。', sender: 'owner', occurredAt: '2026-08-10T13:12:00.000Z' },
    ],
    expected: 'delegate',
    delegateTo: '小王',
  },
  {
    name: '没有承诺的含糊回复',
    messages: [
      { text: '那这个需求你这周能接吗？', sender: 'requester', occurredAt: '2026-08-10T14:00:00.000Z' },
      { text: '我再看看吧，晚点回复你。', sender: 'owner', occurredAt: '2026-08-10T14:05:00.000Z' },
    ],
    expected: 'uncertain',
  },
  {
    name: '密集聊天中交错两个需求',
    messages: [
      { text: '需求A看活动留存，需求B看商城付费。', sender: 'requester', occurredAt: '2026-08-11T02:00:00.000Z' },
      { text: 'A我来做，B先问小王。', sender: 'owner', occurredAt: '2026-08-11T02:04:00.000Z' },
    ],
    // A mixed message has two different dispositions; the safe aggregate
    // result is review rather than silently choosing one task.
    expected: 'uncertain',
  },
  {
    name: '跨天后修改原定日期',
    messages: [
      { text: '上周说周三给，但资料今天才齐。', sender: 'requester', occurredAt: '2026-08-12T02:00:00.000Z' },
      { text: '那改成这周五前给你，之前的时间作废。', sender: 'owner', occurredAt: '2026-08-12T02:08:00.000Z' },
    ],
    expected: 'confirm_schedule',
    scheduleText: '这周五前',
  },
  {
    name: '主人确认但要求先补齐输入',
    messages: [
      { text: '如果能拿到策划案，就帮我判断活动是否值得继续。', sender: 'requester', occurredAt: '2026-08-13T02:00:00.000Z' },
      { text: '可以，我接这个；先把策划案补给我。', sender: 'owner', occurredAt: '2026-08-13T02:09:00.000Z' },
    ],
    expected: 'request_context',
  },
  {
    name: '晚到的补扫消息仍按发生时间提供上下文',
    messages: [
      { text: '先确认活动目标。', sender: 'requester', occurredAt: '2026-08-09T04:00:00.000Z' },
      { text: '我来跟进这个需求。', sender: 'owner', occurredAt: '2026-08-09T04:05:00.000Z' },
      { text: '补充：需要按渠道拆分。', sender: 'requester', occurredAt: '2026-08-09T04:10:00.000Z' },
      { text: '收到，周四前给你第一版。', sender: 'owner', occurredAt: '2026-08-13T04:00:00.000Z' },
    ],
    expected: 'confirm_schedule',
    scheduleText: '周四前',
  },
];

function eventFor(message: ReplayMessage, conversationContext: ReplayMessage[]): NormalizedSourceEvent {
  const owner = message.sender === 'owner';
  return {
    externalId: `replay-${message.occurredAt}-${message.sender}`,
    sourceType: 'owner_dm',
    conversationId: 'conversation-redacted',
    senderId: owner ? 'owner-open' : 'requester-open',
    senderName: owner ? '系统主人' : '需求方',
    content: message.text,
    occurredAt: message.occurredAt,
    metadata: {
      contextOnly: owner,
      senderRole: owner ? 'owner' : 'requester',
      matchedOwnerOpenId: 'owner-open',
    },
    conversationContext: conversationContext.map((item, index) => ({
      sourceKey: `ctx${index + 1}`,
      senderName: item.sender === 'owner' ? '系统主人' : '需求方',
      content: item.text,
      occurredAt: item.occurredAt,
      contextOnly: true as const,
    })),
  };
}

function ownerIntentFor(scenario: ReplayScenario): ModelPayload {
  const latest = scenario.messages.at(-1)!;
  return {
    ...baseOutput,
    owner_intent: {
      action: scenario.expected,
      confidence: scenario.expected === 'uncertain' ? 0.62 : 0.94,
      summary: latest.text,
      delegate_to: scenario.delegateTo ?? null,
      schedule_text: scenario.scheduleText ?? null,
      evidence: [latest.text],
      reason: '回放消息提供了可观察的主人意图证据。',
    },
  };
}

describe('主人消息长对话回放合同', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = null;
  });

  const start = async (payload: ModelPayload, requests: Array<Record<string, unknown>>) => {
    const handler: RequestListener = (request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        try {
          requests.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          requests.push({});
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
      });
    };
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock server failed');
    return `http://127.0.0.1:${address.port}/v1`;
  };

  it.each(scenarios)('$name：长对话只把主人消息作为意图判断输入', async (scenario) => {
    const requests: Array<Record<string, unknown>> = [];
    const apiBase = await start(ownerIntentFor(scenario), requests);
    const config = loadConfig({
      NODE_ENV: 'test',
      LLM_PROVIDER: 'openai_compatible',
      LLM_MODEL: 'replay-model',
      LLM_API_BASE: apiBase,
      LLM_API_KEY: 'mock-key-not-secret',
      LLM_MAX_RETRIES: '0',
    });
    const classifier = new OpenAICompatibleClassifier(config.llm);
    const ownerMessage = scenario.messages.at(-1)!;
    const result = await classifier.classify(eventFor(ownerMessage, scenario.messages.slice(0, -1)));

    expect(result.ownerIntent).toMatchObject({
      action: scenario.expected,
      delegateTo: scenario.delegateTo ?? null,
      scheduleText: scenario.scheduleText ?? null,
    });
    expect(result.draft).toBeNull();
    expect(requests).toHaveLength(1);
    const requestBody = requests[0]!;
    const userMessage = JSON.parse(String((requestBody.messages as Array<{ content: string }>)[1]!.content)) as Record<string, unknown>;
    expect(userMessage.conversation_context).toHaveLength(scenario.messages.length - 1);
    expect(JSON.stringify(userMessage)).not.toContain('conversation-redacted');
    expect(JSON.stringify(userMessage)).not.toContain('owner-open');
    expect(JSON.stringify(userMessage)).not.toContain('requester-open');
  });

  it('跨天回放的上下文按原发生时间保留，不按输入顺序倒置', async () => {
    const scenario = scenarios.find((item) => item.name.includes('晚到'))!;
    const requests: Array<Record<string, unknown>> = [];
    const apiBase = await start(ownerIntentFor(scenario), requests);
    const config = loadConfig({
      NODE_ENV: 'test', LLM_PROVIDER: 'openai_compatible', LLM_MODEL: 'replay-model',
      LLM_API_BASE: apiBase, LLM_API_KEY: 'mock-key-not-secret', LLM_MAX_RETRIES: '0',
    });
    const classifier = new OpenAICompatibleClassifier(config.llm);
    const ownerMessage = scenario.messages.at(-1)!;
    await classifier.classify(eventFor(ownerMessage, scenario.messages.slice(0, -1)));
    const userMessage = JSON.parse(String((requests[0]!.messages as Array<{ content: string }>)[1]!.content)) as Record<string, any>;
    const context = userMessage.conversation_context as Array<{ occurred_at: string; content: string }>;
    expect(context.map((item) => item.occurred_at)).toEqual([
      '2026-08-09T04:00:00.000Z',
      '2026-08-09T04:05:00.000Z',
      '2026-08-09T04:10:00.000Z',
    ]);
    expect(context.map((item) => item.content)).toEqual([
      '先确认活动目标。',
      '我来跟进这个需求。',
      '补充：需要按渠道拆分。',
    ]);
  });
});
