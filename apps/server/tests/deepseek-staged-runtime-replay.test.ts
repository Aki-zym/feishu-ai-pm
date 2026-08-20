import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import type { NormalizedSourceEvent } from '../src/domain.js';
import { createAdapters } from '../src/integrations.js';
import { OpenAICompatibleClassifier } from '../src/integrations/llm.js';
import { PmService } from '../src/service.js';

const OWNER_ID = 'staged-owner-open';
const REQUESTER_ID = 'staged-requester-open';

function message(
  externalId: string,
  content: string,
  sender: 'owner' | 'requester',
  occurredAt: string,
): NormalizedSourceEvent {
  const owner = sender === 'owner';
  return {
    externalId,
    sourceType: 'owner_dm',
    conversationId: 'staged-five-turn-conversation',
    senderId: owner ? OWNER_ID : REQUESTER_ID,
    senderName: owner ? '系统主人' : '需求方',
    content,
    occurredAt,
    metadata: {
      senderRole: sender,
      isOwnerMessage: owner,
      contextOnly: owner,
      ...(owner ? { matchedOwnerOpenId: OWNER_ID } : {}),
    },
  };
}

describe('DeepSeek v7 分阶段连续对话服务回放', () => {
  let server: Server | null = null;
  let database: AppDatabase | null = null;
  let root: string | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = null;
    database?.close();
    database = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('真实 OpenAICompatibleClassifier 经过六轮卡池对话，由主人明确确认周三后自动承接与排期', async () => {
    const stageCounts = new Map<string, number>();
    const systemPrompts: string[] = [];
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
        const system = payload.messages[0]?.content ?? '';
        systemPrompts.push(system);
        const input = JSON.parse(payload.messages[1]?.content ?? '{}') as Record<string, any>;
        const current = String(input.message ?? '');
        const threadCandidates = Array.isArray(input.thread_candidates) ? input.thread_candidates : [];
        const pendingCandidates = Array.isArray(input.candidate_merge_candidates) ? input.candidate_merge_candidates : [];
        const sourceKey = String(input.classification_sources?.[0]?.source_key ?? 's1');

        let stage = 'unknown';
        let content: unknown;
        if (system.includes('消息动作路由器')) {
          stage = 'message_action';
          const action = current.includes('上周新上卡池的流水数据')
            ? 'new_demand'
            : input.current_sender_role === 'owner'
              ? 'owner_action'
              : 'update_existing';
          content = { action, confidence: 0.99, evidence: [current], reason: '五轮回放中的明确连续对话动作。' };
        } else if (system.includes('需求摘要器')) {
          stage = 'demand_details';
          content = {
            demands: [{
              source_keys: [sourceKey],
              title: '上周新上卡池流水与抽取分析',
              background: '需要核对舆情反馈与卡池实际表现。',
              validation_question: '相较同类卡池，实际抽取和付费表现如何？',
              describe: '分析上周新卡池的流水、抽取和付费表现。',
              confidence: 0.99,
              reason: '提出了明确的数据范围和趋势分析交付。',
            }],
          };
        } else if (system.includes('需求线程关联器')) {
          stage = 'thread_association';
          const target = threadCandidates[0]?.candidate_key ?? null;
          content = {
            target_candidate_key: target,
            confidence: target ? 0.99 : null,
            scores: threadCandidates.map((candidate: Record<string, unknown>) => ({ candidate_key: candidate.candidate_key, confidence: 0.99 })),
            reason: target ? '同一需求线程的连续补充。' : '没有正式任务候选。',
            evidence: target ? [current] : [],
          };
        } else if (system.includes('待确认候选归并器')) {
          stage = 'candidate_merge';
          const target = pendingCandidates[0]?.candidate_key ?? null;
          content = {
            target_candidate_key: target,
            same_requirement: Boolean(target),
            confidence: target ? 0.99 : null,
            scores: pendingCandidates.map((candidate: Record<string, unknown>) => ({ candidate_key: candidate.candidate_key, confidence: 0.99 })),
            primary: target ? 'target' : null,
            primary_confidence: target ? 0.99 : null,
            current_role: target ? (current.includes('啥背景') ? 'process_question' : 'background') : null,
            target_role: target ? 'owner_delivery' : null,
            reason: target ? '当前消息继续补充同一具体分析需求。' : '没有待确认候选。',
            evidence: target ? [current] : [],
          };
        } else if (system.includes('私人任务最小补丁提取器')) {
          stage = 'task_update';
          const background = current.includes('舆情');
          content = {
            status_suggestion: null,
            next_step_suggestion: null,
            waiting_reason_suggestion: null,
            time_text: null,
            date_semantics: 'unknown',
            needs_confirmation: true,
            update_confidence: 0.99,
            narrative_updates: [{
              field: background ? 'thread_background' : 'thread_describe',
              value: background
                ? '需求方希望核对舆情反馈，并与历史同类卡池进行对比。'
                : '需求方提出了下周三的交付期望。',
              mode: 'append',
              basis: 'fact',
              confidence: 0.99,
            }],
          };
        } else if (system.includes('系统主人消息的意图提取器')) {
          stage = 'owner_intent';
          content = current.includes('周三给到你')
            ? { intents: [
                { action: 'continue', confidence: 0.99, summary: '主人确认承接。', delegate_to: null, schedule_text: null, evidence: ['也行吧'], reason: '主人明确同意推进。' },
                { action: 'confirm_schedule', confidence: 0.99, summary: '确认周三交付。', delegate_to: null, schedule_text: '周三', evidence: ['周三给到你'], reason: '主人明确确认交付时间。' },
              ] }
            : { intents: [
                { action: 'request_context', confidence: 0.99, summary: '询问需求背景或时间。', delegate_to: null, schedule_text: null, evidence: [current.includes('背景') ? '背景是什么' : '什么时候要'], reason: '主人明确索要需求信息。' },
              ] };
        } else {
          throw new Error(`未识别的分阶段提示词：${system.slice(0, 80)}`);
        }
        stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock server failed');

    root = mkdtempSync(join(tmpdir(), 'ai-pm-deepseek-v7-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      TASK_MEMORY_ROOT: join(root, 'memory'),
      LLM_PROVIDER: 'deepseek',
      LLM_MODEL: 'deepseek-v4-flash',
      LLM_API_BASE: `http://127.0.0.1:${address.port}/v1`,
      LLM_API_KEY: 'mock-key-not-secret',
      LLM_MAX_RETRIES: '0',
    });
    const adapters = createAdapters(config);
    adapters.classifier = new OpenAICompatibleClassifier(config.llm);
    database = new AppDatabase(':memory:', false);
    const service = new PmService(database, adapters, config);
    const timestamp = '2026-08-01T00:00:00.000Z';
    database.raw.prepare(
      `INSERT OR IGNORE INTO owner_profile
        (id, open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json, last_synced_at, created_at, updated_at)
       VALUES ('primary', ?, 'owner-union', 'owner-user', '系统主人', 'tenant', 'authorized', '[]', ?, ?, ?)`,
    ).run(OWNER_ID, timestamp, timestamp, timestamp);

    const turns = [
      message('v7-six-1', '你好，想问一下上周新上卡池的流水数据。', 'requester', '2026-08-14T14:25:16.737Z'),
      message('v7-six-2', '请问背景是什么？', 'owner', '2026-08-14T14:25:29.169Z'),
      message('v7-six-3', '因为看到舆情说不好看，想对比之前的同类卡池，看实际抽取和付费情况。', 'requester', '2026-08-14T14:26:05.394Z'),
      message('v7-six-4', '好的，那请问什么时候要？', 'owner', '2026-08-14T14:26:32.778Z'),
      message('v7-six-5', '下周三给到可以吗？', 'requester', '2026-08-14T14:26:43.253Z'),
      message('v7-six-6', '可以的，周三给到你', 'owner', '2026-08-14T14:26:57.796Z'),
    ];
    for (const turn of turns) await service.ingestSourceBatch([turn]);

    expect(stageCounts).toEqual(new Map([
      ['message_action', 3],
      ['demand_details', 1],
      ['candidate_merge', 2],
      ['owner_intent', 3],
      ['task_update', 2],
    ]));
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 6 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT state FROM candidate_request').get()).toEqual({ state: 'accepted' });
    expect(database.raw.prepare('SELECT title, status, planned_due_at FROM task').get()).toEqual({
      title: '上周新上卡池流水与抽取分析',
      status: 'in_progress',
      planned_due_at: '2026-08-19T15:59:59.999Z',
    });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM ai_decision_log WHERE fallback_mode = 'rule_fallback'").get()).toEqual({ count: 0 });
    expect(systemPrompts.every((prompt) => !prompt.includes('已确定消息动作：'))).toBe(true);
    expect(systemPrompts.every((prompt) => !prompt.includes('五轮回放中的明确连续对话动作'))).toBe(true);
  });
});
