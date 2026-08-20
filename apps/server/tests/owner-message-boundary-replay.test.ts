import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import type { CandidateDraft, NormalizedSourceEvent, OwnerIntentAction } from '../src/domain.js';
import type { ClassificationResult, ClassifierAdapter } from '../src/integration-contracts.js';
import { createAdapters } from '../src/integrations.js';
import { timeRangeFromSource } from '../src/integrations/llm.js';
import { PmService } from '../src/service.js';

const OWNER_ID = 'owner-boundary';
const REQUESTER_ID = 'requester-boundary';
const CONVERSATION_ID = 'owner-boundary-conversation';

function seedOwnerProfile(database: AppDatabase) {
  const timestamp = '2026-08-10T00:00:00.000Z';
  database.raw.prepare(
    `INSERT INTO owner_profile
      (id, open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json, last_synced_at, created_at, updated_at)
     VALUES ('primary', ?, ?, ?, ?, ?, 'authorized', '[]', ?, ?, ?)`,
  ).run(OWNER_ID, 'owner-boundary-union', 'owner-boundary-user', '系统主人', 'tenant-test', timestamp, timestamp, timestamp);
}

function draftFor(event: NormalizedSourceEvent): CandidateDraft {
  return {
    title: '活动埋点需求',
    proposerName: event.senderName,
    background: '根据沟通内容完成活动埋点和验证。',
    validationQuestion: '活动数据是否满足需求方的验证目标？',
    describe: '完成活动埋点需求并持续维护任务状态。',
    confidence: 0.98,
    analysis: {
      timeRange: timeRangeFromSource(event.content, event.occurredAt),
      fieldBasis: { background: 'fact', validationQuestion: 'inferred', describe: 'fact' },
      recognitionEvidence: ['虚拟边界回放中的明确需求。'],
    },
  };
}

function ownerAction(content: string): { action: OwnerIntentAction; scheduleText: string | null; delegateTo: string | null } {
  if (content.includes('不是我') || content.includes('不归我')) return { action: 'decline', scheduleText: null, delegateTo: null };
  if (content.includes('小王')) return { action: 'delegate', scheduleText: null, delegateTo: '小王' };
  if (content.includes('策划案') || content.includes('资料')) return { action: 'request_context', scheduleText: null, delegateTo: null };
  if (content.includes('周五') || content.includes('下周一')) {
    return { action: 'confirm_schedule', scheduleText: content.includes('周五') ? '周五' : '下周一', delegateTo: null };
  }
  if (content.includes('我来做') || content.includes('我来跟进')) return { action: 'continue', scheduleText: null, delegateTo: null };
  return { action: 'uncertain', scheduleText: null, delegateTo: null };
}

class BoundaryClassifier implements ClassifierAdapter {
  readonly kind = 'rule_mock' as const;
  readonly provider = 'owner-boundary-test';
  readonly model = 'owner-boundary-model';
  readonly promptVersion = 'owner-boundary-v1';

  async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    const isOwner = event.metadata?.isOwnerMessage === true || event.metadata?.senderRole === 'owner';
    if (isOwner) {
      const decision = ownerAction(event.content);
      return {
        outcome: 'valid',
        isDataRequest: false,
        draft: null,
        reason: '边界回放识别主人消息意图。',
        relatedTaskHint: null,
        ownerIntent: {
          action: decision.action,
          confidence: decision.action === 'uncertain' ? 0.6 : 0.99,
          summary: event.content,
          delegateTo: decision.delegateTo,
          scheduleText: decision.scheduleText,
          evidence: [event.content],
          reason: '主人原话提供了边界回放证据。',
        },
        importantDates: [],
        deliverables: [],
        commitments: [],
        usedFallback: false,
        metadata: { structuredMode: 'json_schema', fallbackMode: 'llm', attempts: 1 },
      };
    }
    return {
      outcome: 'valid',
      isDataRequest: true,
      draft: draftFor(event),
      reason: '边界回放识别需求方消息。',
      relatedTaskHint: null,
      ownerIntent: null,
      importantDates: [],
      deliverables: [],
      commitments: [],
      usedFallback: false,
      metadata: { structuredMode: 'json_schema', fallbackMode: 'llm', attempts: 1 },
    };
  }

  async testConnection() {
    return { ok: true, status: 'mock' as const, message: 'test', checkedAt: new Date().toISOString() };
  }
}

function message(
  externalId: string,
  content: string,
  sender: 'owner' | 'requester',
  occurredAt: string,
  metadata: Record<string, unknown> = {},
): NormalizedSourceEvent {
  const isOwner = sender === 'owner';
  return {
    externalId,
    sourceType: 'owner_dm',
    conversationId: CONVERSATION_ID,
    senderId: isOwner ? OWNER_ID : REQUESTER_ID,
    senderName: isOwner ? '系统主人' : '需求方',
    content,
    occurredAt,
    metadata: {
      senderRole: sender,
      isOwnerMessage: isOwner,
      contextOnly: isOwner,
      matchedOwnerOpenId: OWNER_ID,
      ...metadata,
    },
  };
}

type Harness = { root: string; database: AppDatabase; service: PmService };
const harnesses: Harness[] = [];

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'ai-pm-owner-boundary-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    TASK_MEMORY_ROOT: join(root, 'task-memory'),
  });
  const adapters = createAdapters(config);
  adapters.classifier = new BoundaryClassifier();
  const database = new AppDatabase(':memory:', false);
  seedOwnerProfile(database);
  const service = new PmService(database, adapters, config);
  const harness = { root, database, service };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (harnesses.length) {
    const harness = harnesses.pop()!;
    harness.database.close();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

describe('主人消息长对话边界回放', () => {
  it('跨天对话仍使用消息发生日解析周五，并写入同一任务', async () => {
    const { service, database } = makeHarness();
    const turns = [
      message('cross-day-1', '想做一个活动埋点需求。', 'requester', '2026-08-10T09:00:00.000Z'),
      message('cross-day-2', '我来做，先把需求接住。', 'owner', '2026-08-11T09:00:00.000Z'),
      message('cross-day-3', '周五前能给到吗？', 'requester', '2026-08-12T09:00:00.000Z'),
      message('cross-day-4', '可以，周五给到。', 'owner', '2026-08-13T09:00:00.000Z'),
    ];
    for (const turn of turns) await service.ingestSourceBatch([turn]);

    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT status, planned_start_at, planned_due_at FROM task').get()).toEqual({
      status: 'in_progress',
      planned_start_at: null,
      planned_due_at: '2026-08-14T15:59:59.999Z',
    });
  });

  it('主人先发承接话术时只保留待确认，后续需求出现后仍需再次明确承接', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('owner-first-1', '我来做，先把需求发我。', 'owner', '2026-08-10T09:00:00.000Z')]);
    expect(database.raw.prepare('SELECT state FROM owner_decision').get()).toEqual({ state: 'review' });

    await service.ingestSourceBatch([message('owner-first-2', '能不能帮忙做一下活动埋点？', 'requester', '2026-08-10T09:05:00.000Z')]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });

    await service.ingestSourceBatch([message('owner-first-3', '这次我来做。', 'owner', '2026-08-10T09:10:00.000Z')]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT state FROM candidate_request').get()).toEqual({ state: 'accepted' });
  });

  it('已完成任务不会被后续主人“继续推进”消息自动复活', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('terminal-1', '请帮忙做活动埋点。', 'requester', '2026-08-10T09:00:00.000Z')]);
    await service.ingestSourceBatch([message('terminal-2', '我来做。', 'owner', '2026-08-10T09:05:00.000Z')]);
    const task = service.getTask((database.raw.prepare('SELECT accepted_task_id FROM candidate_request').get() as { accepted_task_id: string }).accepted_task_id)!;
    const completed = service.updateTask(task.id, { status: 'completed', expectedVersion: task.version });
    await service.ingestSourceBatch([message('terminal-3', '我来做，继续推进。', 'owner', '2026-08-10T09:10:00.000Z')]);

    expect(completed).not.toBeNull();
    expect(service.getTask(task.id)).toMatchObject({ status: 'completed', version: completed!.version });
    expect(database.raw.prepare("SELECT action, state FROM owner_decision WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'terminal-3')").get())
      .toMatchObject({ action: 'continue', state: 'review' });
  });

  it('被主人忽略的需求后续重新提起时生成新候选并可重新承接', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('reopen-1', '能不能帮忙做一下活动埋点？', 'requester', '2026-08-10T09:00:00.000Z')]);
    await service.ingestSourceBatch([message('reopen-2', '这个不是我做，你问负责埋点的同学吧。', 'owner', '2026-08-10T09:05:00.000Z')]);
    expect(database.raw.prepare('SELECT state FROM candidate_request').get()).toEqual({ state: 'ignored' });

    await service.ingestSourceBatch([message('reopen-3', '刚才那个活动埋点又需要你帮忙推进了。', 'requester', '2026-08-12T09:00:00.000Z')]);
    const candidates = database.raw.prepare('SELECT id, state FROM candidate_request ORDER BY created_at').all() as Array<{ id: string; state: string }>;
    expect(candidates.map((candidate) => candidate.state)).toEqual(['ignored', 'pending']);

    await service.ingestSourceBatch([message('reopen-4', '这次我来做。', 'owner', '2026-08-12T09:05:00.000Z')]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT state FROM candidate_request ORDER BY created_at').all()).toEqual([
      { state: 'ignored' },
      { state: 'accepted' },
    ]);
  });
});
