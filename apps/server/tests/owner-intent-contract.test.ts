import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { NormalizedSourceEvent } from '../src/domain.js';
import { OpenAICompatibleClassifier } from '../src/integrations/llm.js';

const baseEvent: NormalizedSourceEvent = {
  externalId: 'owner-intent-source-1',
  sourceType: 'owner_dm',
  conversationId: 'dm-chat',
  senderId: 'owner-open',
  senderName: '系统主人',
  content: '可以，我来做，周三前给你。',
  occurredAt: '2026-08-13T10:00:00.000Z',
  metadata: { contextOnly: true, senderRole: 'owner', matchedOwnerOpenId: 'owner-open' },
};

const baseOutput = {
  is_data_request: false,
  title: null,
  proposer_name: '系统主人',
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
  reason: '主人明确表示承接并给出时间。',
  time_range: { status: 'relative_resolved', source_text: '周三前', start_at: null, end_at: '2026-08-19T23:59:59.999Z', timezone: 'Asia/Shanghai', needs_confirmation: false },
  field_basis: { background: 'unknown', validation_question: 'unknown', describe: 'unknown' },
  recognition_evidence: ['主人明确说“我来做”。'],
};

describe('主人意图输出契约', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = null;
  });

  const classifier = (apiBase: string) => {
    const config = loadConfig({
      NODE_ENV: 'test',
      LLM_PROVIDER: 'openai_compatible',
      LLM_MODEL: 'mock-model',
      LLM_API_BASE: apiBase,
      LLM_API_KEY: 'mock-key-not-secret',
      LLM_MAX_RETRIES: '0',
    });
    return new OpenAICompatibleClassifier(config.llm);
  };

  const start = async (payload: Record<string, unknown>) => {
    const handler: RequestListener = (request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
    };
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock server failed');
    return `http://127.0.0.1:${address.port}/v1`;
  };

  it('主人消息保留独立 ownerIntent，并不依赖普通候选 draft', async () => {
    const apiBase = await start({
      ...baseOutput,
      owner_intent: {
        action: 'confirm_schedule',
        confidence: 0.96,
        summary: '主人承接任务并确认周三前交付。',
        delegate_to: null,
        schedule_text: '周三前',
        evidence: ['我来做', '周三前给你'],
        reason: '主人明确承接并给出交付时间。',
      },
    });
    const result = await classifier(apiBase).classify(baseEvent);
    expect(result.draft).toBeNull();
    expect(result.ownerIntent).toMatchObject({
      action: 'confirm_schedule',
      confidence: 0.96,
      scheduleText: '周三前',
      delegateTo: null,
    });
  });

  it('对方消息即使模型误返回 owner_intent，也不会越过主人身份门禁', async () => {
    const apiBase = await start({
      ...baseOutput,
      owner_intent: {
        action: 'decline',
        confidence: 0.99,
        summary: '不做这个需求。',
        delegate_to: null,
        schedule_text: null,
        evidence: ['不做'],
        reason: '模型误将对方语气当成主人意图。',
      },
    });
    const result = await classifier(apiBase).classify({
      ...baseEvent,
      senderId: 'requester-open',
      senderName: '需求方',
      content: '你不做的话我再找别人。',
      metadata: { contextOnly: false, senderRole: 'requester' },
    });
    expect(result.ownerIntent).toBeNull();
  });

  it('转交或排期缺少原文证据时安全降级为 uncertain', async () => {
    const apiBase = await start({
      ...baseOutput,
      owner_intent: {
        action: 'delegate',
        confidence: 0.97,
        summary: '转给其他人。',
        delegate_to: '小王',
        schedule_text: null,
        evidence: ['请转交'],
        reason: '模型推测了转交对象。',
      },
    });
    const result = await classifier(apiBase).classify({
      ...baseEvent,
      content: '我再看看。',
    });
    expect(result.ownerIntent).toMatchObject({ action: 'uncertain', delegateTo: null });
  });

  it('主人只确认前文日期时保留 confirm_schedule，由服务端回查有界上下文', async () => {
    const apiBase = await start({
      ...baseOutput,
      owner_intent: {
        action: 'confirm_schedule',
        confidence: 0.97,
        summary: '主人确认了需求方刚才提出的日期。',
        delegate_to: null,
        schedule_text: null,
        evidence: ['可以'],
        reason: '主人对前文日期做了明确肯定回复。',
      },
    });
    const result = await classifier(apiBase).classify({
      ...baseEvent,
      content: '可以。',
      conversationContext: [{
        sourceKey: 'ctx1',
        senderName: '需求方',
        content: '希望下周一能给到吗？',
        occurredAt: '2026-08-13T09:55:00.000Z',
        contextOnly: true,
      }],
    });
    expect(result.ownerIntent).toMatchObject({
      action: 'confirm_schedule',
      scheduleText: null,
      delegateTo: null,
    });
  });
});
