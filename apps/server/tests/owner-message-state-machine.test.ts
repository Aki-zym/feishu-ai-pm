import { createHash } from 'node:crypto';
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

const OWNER_ID = 'owner-open';
const REQUESTER_ID = 'requester-open';
const CONVERSATION_ID = 'owner-state-conversation';

function seedOwnerProfile(database: AppDatabase) {
  const timestamp = '2026-08-10T00:00:00.000Z';
  database.raw.prepare(
    `INSERT OR IGNORE INTO owner_profile
      (id, open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json, last_synced_at, created_at, updated_at)
     VALUES ('primary', ?, ?, ?, ?, ?, 'authorized', '[]', ?, ?, ?)`,
  ).run(OWNER_ID, 'owner-union', 'owner-user', '系统主人', 'tenant-test', timestamp, timestamp, timestamp);
}

function draftFor(event: NormalizedSourceEvent): CandidateDraft {
  return {
    title: event.content.includes('付费') ? '活动付费分析' : '活动埋点需求',
    proposerName: event.senderName,
    background: '需要根据沟通内容完成活动埋点和数据验证。',
    validationQuestion: '活动数据是否满足需求方的验证目标？',
    describe: '完成活动埋点需求并持续维护任务状态。',
    confidence: 0.98,
    analysis: {
      timeRange: timeRangeFromSource(event.content, event.occurredAt),
      fieldBasis: { background: 'fact', validationQuestion: 'inferred', describe: 'fact' },
      recognitionEvidence: ['虚拟完整对话中的明确数据需求。'],
    },
  };
}

function ownerAction(content: string): { action: OwnerIntentAction; scheduleText: string | null; delegateTo: string | null } {
  if (content.includes('我拒绝') || content.includes('不是我') || content.includes('不归我')) return { action: 'decline', scheduleText: null, delegateTo: null };
  if (content.includes('小王')) return { action: 'delegate', scheduleText: null, delegateTo: '小王' };
  if (content.includes('策划案') || content.includes('埋点表')) return { action: 'request_context', scheduleText: null, delegateTo: null };
  if (content.includes('下周一') || content.includes('周五')) {
    return { action: 'confirm_schedule', scheduleText: content.includes('下周一') ? '下周一' : '周五', delegateTo: null };
  }
  if (/^(可以|行|没问题)[。！!]?$/.test(content.trim())) return { action: 'confirm_schedule', scheduleText: null, delegateTo: null };
  if (content.includes('我来做') || content.includes('我来跟进')) return { action: 'continue', scheduleText: null, delegateTo: null };
  return { action: 'uncertain', scheduleText: null, delegateTo: null };
}

class OwnerStateMachineClassifier implements ClassifierAdapter {
  readonly kind = 'rule_mock' as const;
  readonly provider = 'owner-state-test';
  readonly model = 'owner-state-model';
  readonly promptVersion = 'owner-state-v1';

  constructor(
    private readonly returnOwnerDraft = false,
    private readonly associateRequesterFollowUps = false,
  ) {}

  async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    const isOwner = event.metadata?.isOwnerMessage === true || event.metadata?.senderRole === 'owner';
    if (isOwner) {
      const decisions = event.content.includes('策划案') && (event.content.includes('下周一') || event.content.includes('周五'))
        ? [
            { action: 'confirm_schedule' as const, scheduleText: event.content.includes('下周一') ? '下周一' : '周五', delegateTo: null },
            { action: 'request_context' as const, scheduleText: null, delegateTo: null },
          ]
        : [ownerAction(event.content)];
      const ownerIntents = decisions.map((decision) => ({
        action: decision.action,
        confidence: decision.action === 'uncertain' ? 0.6 : 0.99,
        summary: decision.action === 'confirm_schedule'
          ? `确认计划时间：${decision.scheduleText ?? event.content}`
          : decision.action === 'request_context' ? '索要策划案或埋点表' : event.content,
        delegateTo: decision.delegateTo,
        scheduleText: decision.scheduleText,
        evidence: [event.content],
        reason: '主人原话提供了状态机证据。',
      }));
      return {
        outcome: 'valid',
        isDataRequest: this.returnOwnerDraft,
        draft: this.returnOwnerDraft ? draftFor(event) : null,
        reason: '测试分类器识别主人消息意图。',
        relatedTaskHint: null,
        ownerIntent: ownerIntents[0] ?? null,
        ownerIntents,
        importantDates: [],
        deliverables: [],
        commitments: [],
        usedFallback: false,
        metadata: { structuredMode: 'json_schema', fallbackMode: 'llm', attempts: 1 },
      };
    }
    const result: ClassificationResult = {
      outcome: 'valid',
      isDataRequest: true,
      draft: draftFor(event),
      reason: '测试分类器识别明确的数据需求。',
      relatedTaskHint: null,
      ownerIntent: null,
      importantDates: [],
      deliverables: [],
      commitments: [],
      usedFallback: false,
      metadata: { structuredMode: 'json_schema', fallbackMode: 'llm', attempts: 1 },
    };
    const context = event.classificationContext;
    if (this.associateRequesterFollowUps && context?.candidates.length) {
      const target = context.candidates[0]!;
      result.threadAssociation = {
        targetThreadId: target.threadId,
        targetTaskId: target.taskId,
        confidence: 0.98,
        scores: context.candidates.map((candidate, index) => ({
          threadId: candidate.threadId,
          taskId: candidate.taskId,
          confidence: index === 0 ? 0.98 : 0.2,
        })),
        reason: '测试模型明确判断请求方的后续消息属于当前需求。',
        evidence: ['测试模型从匿名需求候选中选择了唯一目标。'],
        candidateSetHash: context.candidateSetHash,
        candidateSetComplete: context.candidateSetComplete,
      };
    }
    return result;
  }

  async testConnection() {
    return { ok: true, status: 'mock' as const, message: 'test', checkedAt: new Date().toISOString() };
  }
}

class DelayedOwnerStateMachineClassifier extends OwnerStateMachineClassifier {
  private readonly ownerStartedResolve: () => void;
  private readonly releaseOwnerResolve: () => void;
  readonly ownerStarted: Promise<void>;
  private readonly ownerReleased: Promise<void>;

  constructor() {
    super();
    let started!: () => void;
    let released!: () => void;
    this.ownerStarted = new Promise<void>((resolve) => { started = resolve; });
    this.ownerReleased = new Promise<void>((resolve) => { released = resolve; });
    this.ownerStartedResolve = started;
    this.releaseOwnerResolve = released;
  }

  releaseOwner() {
    this.releaseOwnerResolve();
  }

  override async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    const isOwner = event.metadata?.isOwnerMessage === true || event.metadata?.senderRole === 'owner';
    if (isOwner) {
      this.ownerStartedResolve();
      await this.ownerReleased;
    }
    return super.classify(event);
  }
}

class RetryableDelayedOwnerStateMachineClassifier extends OwnerStateMachineClassifier {
  private readonly ownerStartedResolve: () => void;
  private readonly releaseOwnerResolve: () => void;
  readonly ownerStarted: Promise<void>;
  private readonly ownerReleased: Promise<void>;
  private failedOnce = false;

  constructor() {
    super();
    let started!: () => void;
    let released!: () => void;
    this.ownerStarted = new Promise<void>((resolve) => { started = resolve; });
    this.ownerReleased = new Promise<void>((resolve) => { released = resolve; });
    this.ownerStartedResolve = started;
    this.releaseOwnerResolve = released;
  }

  releaseOwner() {
    this.releaseOwnerResolve();
  }

  override async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    const isOwner = event.metadata?.isOwnerMessage === true || event.metadata?.senderRole === 'owner';
    if (isOwner && !this.failedOnce) {
      this.ownerStartedResolve();
      await this.ownerReleased;
      this.failedOnce = true;
      throw new Error('simulated provider interruption before classification retry');
    }
    return super.classify(event);
  }
}

class CountingOwnerStateMachineClassifier extends OwnerStateMachineClassifier {
  providerCalls = 0;

  override async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    this.providerCalls += 1;
    return super.classify(event);
  }
}

class CrashAfterOwnerProviderClassifier extends OwnerStateMachineClassifier {
  providerCalls = 0;
  private failed = false;

  override async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    this.providerCalls += 1;
    const result = await super.classify(event);
    const isOwner = event.metadata?.isOwnerMessage === true || event.metadata?.senderRole === 'owner';
    if (isOwner && !this.failed) {
      this.failed = true;
      throw new Error('simulated provider crash after owner classification');
    }
    return result;
  }
}

class RetryableCrashingDelayedOwnerClassifier extends OwnerStateMachineClassifier {
  providerCalls = 0;
  private ownerCalls = 0;
  private readonly firstStartedResolve: () => void;
  private readonly firstReleaseResolve: () => void;
  private readonly retryStartedResolve: () => void;
  private readonly retryReleaseResolve: () => void;
  readonly firstStarted: Promise<void>;
  readonly retryStarted: Promise<void>;
  private readonly firstReleased: Promise<void>;
  private readonly retryReleased: Promise<void>;

  constructor() {
    super();
    let firstStarted!: () => void;
    let firstReleased!: () => void;
    let retryStarted!: () => void;
    let retryReleased!: () => void;
    this.firstStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    this.firstReleased = new Promise<void>((resolve) => { firstReleased = resolve; });
    this.retryStarted = new Promise<void>((resolve) => { retryStarted = resolve; });
    this.retryReleased = new Promise<void>((resolve) => { retryReleased = resolve; });
    this.firstStartedResolve = firstStarted;
    this.firstReleaseResolve = firstReleased;
    this.retryStartedResolve = retryStarted;
    this.retryReleaseResolve = retryReleased;
  }

  releaseFirst() {
    this.firstReleaseResolve();
  }

  releaseRetry() {
    this.retryReleaseResolve();
  }

  override async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    this.providerCalls += 1;
    const isOwner = event.metadata?.isOwnerMessage === true || event.metadata?.senderRole === 'owner';
    if (!isOwner) return super.classify(event);
    this.ownerCalls += 1;
    const attempt = this.ownerCalls;
    if (attempt === 1) {
      this.firstStartedResolve();
      await this.firstReleased;
      throw new Error('simulated legacy owner provider interruption');
    }
    if (isOwner && attempt === 2) {
      this.retryStartedResolve();
      await this.retryReleased;
    }
    return super.classify(event);
  }
}

function message(
  externalId: string,
  text: string,
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
    content: text,
    occurredAt,
    metadata: {
      senderRole: isOwner ? 'owner' : 'requester',
      isOwnerMessage: isOwner,
      contextOnly: isOwner,
      matchedOwnerOpenId: OWNER_ID,
      ...metadata,
    },
  };
}

type Harness = { root: string; database: AppDatabase; service: PmService };
const harnesses: Harness[] = [];

function makeHarness(returnOwnerDraft = false, associateRequesterFollowUps = false, classifier?: ClassifierAdapter) {
  const root = mkdtempSync(join(tmpdir(), 'ai-pm-owner-state-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    TASK_MEMORY_ROOT: join(root, 'task-memory'),
  });
  const adapters = createAdapters(config);
  adapters.classifier = classifier ?? new OwnerStateMachineClassifier(returnOwnerDraft, associateRequesterFollowUps);
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

describe('主人消息需求状态机端到端', () => {
  it('主人承接候选后自动建立同一正式任务，而不是要求手工接受', async () => {
    const { service, database } = makeHarness(false, true);
    await service.ingestSourceBatch([
      message('accept-1', '想做一个活动埋点需求，先看下数据效果。', 'requester', '2026-08-10T09:00:00.000Z'),
    ]);

    await service.ingestSourceBatch([
      message('accept-2', '算了，我来做吧。', 'owner', '2026-08-10T09:05:00.000Z'),
    ]);

    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT state, accepted_task_id FROM candidate_request').get()).toMatchObject({
      state: 'accepted',
      accepted_task_id: expect.any(String),
    });
    expect(database.raw.prepare('SELECT status FROM task').get()).toEqual({ status: 'in_progress' });
  });

  it('主人一句话承接并确认截止时间时一次建任务并写入排期', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([
      message('accept-schedule-1', '想做一个活动埋点需求，先看下数据效果。', 'requester', '2026-08-10T09:00:00.000Z'),
    ]);

    await service.ingestSourceBatch([
      message('accept-schedule-2', '明白，那下周五给吧，我来做。', 'owner', '2026-08-10T09:05:00.000Z'),
    ]);

    const task = database.raw.prepare('SELECT status, planned_start_at, planned_due_at FROM task').get();
    expect(task).toEqual({
      status: 'in_progress',
      planned_start_at: null,
      planned_due_at: '2026-08-21T15:59:59.999Z',
    });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM task_event WHERE event_type = 'task_created'").get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT state, accepted_task_id FROM candidate_request').get()).toMatchObject({
      state: 'accepted',
      accepted_task_id: expect.any(String),
    });
  });

  it('模型误把主人消息返回成数据需求时，服务端仍不创建普通候选', async () => {
    const { service, database } = makeHarness(true);
    await service.ingestSourceBatch([
      message('owner-guard-request', '想做一个活动埋点需求，先看下数据效果。', 'requester', '2026-08-10T08:00:00.000Z'),
    ]);
    await service.ingestSourceBatch([
      message('owner-guard-owner', '我来做吧。', 'owner', '2026-08-10T08:05:00.000Z'),
    ]);

    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT state FROM candidate_request').get()).toEqual({ state: 'accepted' });
    expect(database.raw.prepare('SELECT status FROM task').get()).toEqual({ status: 'in_progress' });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM candidate_request WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'owner-guard-owner')").get())
      .toEqual({ count: 0 });
  });

  it('仅伪造主人字段但发送者不属于已授权主人时，不触发主人状态机', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([
      message('spoof-request', '想做一个活动埋点需求。', 'requester', '2026-08-10T08:10:00.000Z'),
    ]);
    const spoofed = message('spoof-owner', '我来做吧。', 'owner', '2026-08-10T08:15:00.000Z', {
      senderRole: 'owner',
      isOwnerMessage: true,
      matchedOwnerOpenId: 'spoofed-owner',
    });
    spoofed.senderId = 'spoofed-owner';
    await service.ingestSourceBatch([spoofed]);

    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM owner_decision').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT state FROM candidate_request').get()).toEqual({ state: 'pending' });
  });

  it('五轮交替对话由主人消息直接维护承接、截止时间和等待资料', async () => {
    const { service, database } = makeHarness();
    const turns = [
      message('dialog-1', '想做一个活动埋点需求，先看下数据效果。', 'requester', '2026-08-10T09:00:00.000Z'),
      message('dialog-2', '算了，我来做吧。这个任务什么时候要？', 'owner', '2026-08-10T09:05:00.000Z'),
      message('dialog-3', '希望下周一能给到吗？', 'requester', '2026-08-10T09:10:00.000Z'),
      message('dialog-4', '可以，下周一给到。我们后面先对一下具体需求。', 'owner', '2026-08-10T09:15:00.000Z'),
      message('dialog-5', '策划案在哪？先发我，我收到后再对齐具体需求。', 'owner', '2026-08-10T09:20:00.000Z'),
    ];
    for (const turn of turns) await service.ingestSourceBatch([turn]);

    const task = database.raw.prepare('SELECT * FROM task').get() as Record<string, unknown>;
    expect(task).toMatchObject({
      status: 'waiting',
      planned_start_at: null,
      planned_due_at: '2026-08-17T15:59:59.999Z',
    });
    expect(String(task.waiting_reason)).toContain('策划案');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
    // The rule-shaped compatibility fixture does not emit an explicit LLM
    // thread association for the requester's schedule proposal. Keep that
    // source visible for review instead of reviving the old program shortcut;
    // the trusted owner turns still maintain the accepted task directly.
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM candidate_request WHERE state = 'pending'").get()).toEqual({ count: 1 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM candidate_request WHERE state = 'accepted'").get()).toEqual({ count: 1 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM task_event WHERE event_type = 'task_auto_updated'").get())
      .toMatchObject({ count: expect.any(Number) });
    expect((database.raw.prepare("SELECT COUNT(*) AS count FROM task_event WHERE event_type = 'task_auto_updated'").get() as { count: number }).count).toBeGreaterThanOrEqual(2);
  });

  it('主人一句话同时确认排期和索要资料时合并为一次版本安全更新', async () => {
    const { service, database } = makeHarness();
    const turns = [
      message('compound-1', '想做一个活动埋点需求。', 'requester', '2026-08-10T10:00:00.000Z'),
      message('compound-2', '我来做。', 'owner', '2026-08-10T10:05:00.000Z'),
      message('compound-3', '希望下周一给到。', 'requester', '2026-08-10T10:10:00.000Z'),
      message('compound-4', '可以，下周一给到，策划案在哪？', 'owner', '2026-08-10T10:15:00.000Z'),
    ];
    for (const turn of turns) await service.ingestSourceBatch([turn]);

    expect(database.raw.prepare('SELECT status, planned_due_at, waiting_reason FROM task').get()).toMatchObject({
      status: 'waiting',
      planned_due_at: '2026-08-17T15:59:59.999Z',
      waiting_reason: expect.stringContaining('策划案'),
    });
    const decision = database.raw.prepare(
      `SELECT action, disposition, patch_json, state FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'compound-4')`,
    ).get() as { action: string; disposition: string; patch_json: string; state: string };
    expect(decision).toMatchObject({ action: 'request_context', disposition: 'apply_task_patch', state: 'applied' });
    expect(JSON.parse(decision.patch_json)).toMatchObject({
      status: 'waiting',
      plannedDueAt: '2026-08-17T15:59:59.999Z',
      waitingReason: expect.stringContaining('策划案'),
    });
    expect(database.raw.prepare(
      `SELECT COUNT(*) AS count FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'compound-4')`,
    ).get()).toEqual({ count: 1 });
  });

  it('主人只回复“可以”时从前文明确日期写入截止时间', async () => {
    const { service, database } = makeHarness();
    const turns = [
      message('confirm-context-1', '想做一个活动埋点需求。', 'requester', '2026-08-13T08:00:00.000Z'),
      message('confirm-context-2', '我来做。', 'owner', '2026-08-13T08:05:00.000Z'),
      message('confirm-context-3', '希望下周一能给到吗？', 'requester', '2026-08-13T08:10:00.000Z'),
      message('confirm-context-4', '可以。', 'owner', '2026-08-13T08:15:00.000Z'),
    ];
    for (const turn of turns) await service.ingestSourceBatch([turn]);

    expect(database.raw.prepare('SELECT status, planned_start_at, planned_due_at FROM task').get()).toEqual({
      status: 'in_progress',
      planned_start_at: null,
      planned_due_at: '2026-08-17T15:59:59.999Z',
    });
  });

  it('未接受候选阶段的背景或时间追问只保留审计，不显示成需要主人再次确认的失败动作', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([
      message('pending-question-1', '想看一下上周新卡池的流水数据。', 'requester', '2026-08-14T14:25:16.737Z'),
      message('pending-question-2', '策划案在哪？', 'owner', '2026-08-14T14:25:29.169Z'),
    ]);

    expect(database.raw.prepare('SELECT action, state, candidate_id FROM owner_decision').get()).toMatchObject({
      action: 'request_context',
      state: 'review',
      candidate_id: expect.any(String),
    });
    expect(service.listPendingOwnerActions()).toEqual([]);
  });

  it('待处理主人判断返回候选、任务、置信度和时间，供前端挂回对应卡片', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([
      message('owner-action-card-1', '想做一个活动埋点需求。', 'requester', '2026-08-14T08:00:00.000Z'),
      message('owner-action-card-2', '我来做。', 'owner', '2026-08-14T08:05:00.000Z'),
      message('owner-action-card-3', '下周一可以吗？', 'requester', '2026-08-14T08:10:00.000Z'),
      message('owner-action-card-4', '可以，下周一给到。', 'owner', '2026-08-14T08:15:00.000Z'),
    ]);
    database.raw.prepare(
      `UPDATE owner_decision SET state = 'review'
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'owner-action-card-4')`,
    ).run();

    const candidate = database.raw.prepare('SELECT id, accepted_task_id FROM candidate_request').get() as { id: string; accepted_task_id: string };
    expect(service.listPendingOwnerActions()).toEqual([
      expect.objectContaining({
        action: 'confirm_schedule',
        state: 'review',
        candidateId: candidate.id,
        taskId: candidate.accepted_task_id,
        confidence: 0.99,
        scheduleText: '下周一',
      }),
    ]);
  });

  it('同一次周期扫描中的多条主人消息仍按每条消息分别推进状态', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([
      message('batch-owner-1', '想做一个活动埋点需求，先看下数据效果。', 'requester', '2026-08-10T09:00:00.000Z'),
      message('batch-owner-2', '我来做吧。', 'owner', '2026-08-10T09:05:00.000Z'),
      message('batch-owner-3', '希望下周一能给到吗？', 'requester', '2026-08-10T09:10:00.000Z'),
      message('batch-owner-4', '可以，下周一给到。', 'owner', '2026-08-10T09:15:00.000Z'),
      message('batch-owner-5', '策划案在哪？先发我。', 'owner', '2026-08-10T09:20:00.000Z'),
    ]);

    const task = database.raw.prepare('SELECT * FROM task').get() as Record<string, unknown>;
    expect(task).toMatchObject({
      status: 'waiting',
      planned_due_at: '2026-08-17T15:59:59.999Z',
    });
    expect((database.raw.prepare("SELECT COUNT(*) AS count FROM owner_decision WHERE state = 'applied'").get() as { count: number }).count)
      .toBe(3);
  });

  it('明确提出另一个新需求时不承接到刚才的任务', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([
      message('split-1', '想做一个活动埋点需求。', 'requester', '2026-08-10T09:00:00.000Z'),
    ]);
    await service.ingestSourceBatch([
      message('split-2', '我来做。', 'owner', '2026-08-10T09:05:00.000Z'),
    ]);
    await service.ingestSourceBatch([
      message('split-3', '另外还有一个新需求：分析活动付费表现。', 'requester', '2026-08-10T09:10:00.000Z'),
    ]);

    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM candidate_request WHERE state = 'accepted'").get()).toEqual({ count: 1 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM candidate_request WHERE state = 'pending'").get()).toEqual({ count: 1 });
    expect(database.raw.prepare("SELECT title FROM candidate_request WHERE state = 'pending'").get()).toEqual({ title: '活动付费分析' });
  });

  it.each([
    { action: 'decline', text: '这个不是我做，你问负责埋点的同学吧。' },
    { action: 'delegate', text: '这个让小王负责，我不承接。' },
  ])('主人明确 $action 时把未接受候选移出活动收件箱并保留审计', async ({ action, text }) => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([
      message(`${action}-1`, '能不能帮忙做一下活动埋点？', 'requester', '2026-08-10T10:00:00.000Z'),
    ]);
    const candidate = database.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };

    await service.ingestSourceBatch([
      message(`${action}-2`, text, 'owner', '2026-08-10T10:05:00.000Z'),
    ]);

    expect(database.raw.prepare('SELECT state FROM candidate_request WHERE id = ?').get(candidate.id)).toEqual({ state: 'ignored' });
    expect(database.raw.prepare('SELECT deleted_at FROM candidate_request WHERE id = ?').get(candidate.id)).toEqual({ deleted_at: null });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event WHERE candidate_id = ?').get(candidate.id) as { count: number }).count).toBeGreaterThan(0);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 2 });
  });

  it('同一私聊有旧候选时，明确拒绝只忽略主人消息前最近的新候选', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([
      message('recent-decline-old', '活动A要做埋点分析。', 'requester', '2026-08-10T06:00:00.000Z'),
    ]);
    await service.ingestSourceBatch([
      message('recent-decline-new', '活动B要做付费分析。', 'requester', '2026-08-10T10:00:00.000Z'),
    ]);
    const before = database.raw.prepare('SELECT id, title, state FROM candidate_request ORDER BY created_at').all() as Array<{ id: string; title: string; state: string }>;
    expect(before).toHaveLength(2);

    await service.ingestSourceBatch([
      message('recent-decline-owner', '这个需求我拒绝，我是数分，不是产品。', 'owner', '2026-08-10T10:05:00.000Z'),
    ]);

    const decision = database.raw.prepare(
      `SELECT action, disposition, state, reason, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'recent-decline-owner')`,
    ).get();
    expect(decision).toMatchObject({ action: 'decline', disposition: 'decline_candidate', state: 'applied' });
    const after = database.raw.prepare('SELECT title, state, deleted_at FROM candidate_request ORDER BY created_at').all();
    expect(after).toEqual([
      { title: '活动埋点需求', state: 'pending', deleted_at: null },
      { title: '活动付费分析', state: 'ignored', deleted_at: null },
    ]);
  });

  it('同一会话有两个活动需求时，含糊主人消息不随机修改第一个任务', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([
      message('multi-1', '活动A要做埋点分析。', 'requester', '2026-08-10T11:00:00.000Z', { rootId: 'root-a' }),
    ]);
    await service.ingestSourceBatch([
      message('multi-2', '活动B要做付费分析。', 'requester', '2026-08-10T11:05:00.000Z', { rootId: 'root-b' }),
    ]);
    const candidates = database.raw.prepare('SELECT id FROM candidate_request ORDER BY created_at').all() as Array<{ id: string }>;
    expect(candidates).toHaveLength(2);
    service.actOnCandidate(candidates[0]!.id, 'accept', undefined, service.getCandidate(candidates[0]!.id)!.version);
    service.actOnCandidate(candidates[1]!.id, 'accept', undefined, service.getCandidate(candidates[1]!.id)!.version);
    const before = database.raw.prepare('SELECT id, status, version FROM task ORDER BY created_at').all();

    await service.ingestSourceBatch([
      message('multi-3', '我来做，继续推进。', 'owner', '2026-08-10T11:10:00.000Z'),
    ]);

    expect(database.raw.prepare('SELECT id, status, version FROM task ORDER BY created_at').all()).toEqual(before);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_update_proposal').get()).toEqual({ count: 0 });
    expect(service.listPendingOwnerActions()).toEqual([
      expect.objectContaining({
        action: 'continue',
        state: 'review',
        candidateId: null,
        message: '主人动作已经识别，但尚未安全关联到唯一候选，因此没有执行。',
      }),
    ]);
  });

  it('重复投递同一主人消息不会重复建任务或重复执行自动更新', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([
      message('dup-1', '想做一个活动埋点需求。', 'requester', '2026-08-10T12:00:00.000Z'),
    ]);
    const owner = message('dup-2', '我来做。', 'owner', '2026-08-10T12:05:00.000Z');
    await service.ingestSourceBatch([owner]);
    const snapshot = {
      tasks: database.raw.prepare('SELECT COUNT(*) AS count FROM task').get(),
      events: database.raw.prepare('SELECT COUNT(*) AS count FROM task_event').get(),
      corrections: database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get(),
    };

    await service.ingestSourceBatch([owner]);

    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual(snapshot.tasks);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_event').get()).toEqual(snapshot.events);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get()).toEqual(snapshot.corrections);
  });

  it('主人判断执行中断后，重建 Service 可由 Runtime 恢复并只承接一次', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-pm-owner-decision-restart-'));
    const databasePath = join(root, 'runtime.sqlite');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: `file:${databasePath}`,
      TASK_MEMORY_ROOT: join(root, 'task-memory'),
    });

    const firstDatabase = new AppDatabase(databasePath, false);
    seedOwnerProfile(firstDatabase);
    const firstAdapters = createAdapters(config);
    firstAdapters.classifier = new OwnerStateMachineClassifier();
    const firstService = new PmService(firstDatabase, firstAdapters, config);

    await firstService.ingestSourceBatch([
      message('restart-request', '想做一个活动埋点需求，先看下数据效果。', 'requester', '2026-08-10T13:00:00.000Z'),
    ]);

    // Simulate a process crash exactly at the controlled business-action
    // boundary. The durable owner_decision row and Runtime job must remain
    // retryable; no task should be created by the failed attempt.
    const mutableService = firstService as unknown as {
      acceptCandidateForOwner: (...args: unknown[]) => unknown;
    };
    mutableService.acceptCandidateForOwner = () => {
      throw new Error('simulated owner decision process interruption');
    };
    const interrupted = await firstService.ingestSourceBatch([
      message('restart-owner', '我来做。', 'owner', '2026-08-10T13:05:00.000Z'),
    ]);
    expect(interrupted.classificationFailures).toBe(1);
    expect(firstDatabase.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
    const savedDecision = firstDatabase.raw.prepare(
      "SELECT id, state FROM owner_decision ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; state: string };
    const savedJob = firstDatabase.raw.prepare(
      "SELECT id, status FROM job WHERE job_type = 'owner_decision' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; status: string };
    expect(savedDecision.state).toBe('failed');
    expect(savedJob.status).toBe('queued');
    const ownerSourceRow = firstDatabase.raw.prepare(
      "SELECT id FROM source_event WHERE external_id = 'restart-owner'",
    ).get() as { id: string };
    expect(firstDatabase.raw.prepare('SELECT COUNT(*) AS count FROM job_source_link WHERE job_id = ? AND source_event_id = ?').get(savedJob.id, ownerSourceRow.id))
      .toEqual({ count: 1 });
    // Owner-decision jobs are also safe to retry manually. This resets the
    // durable job before the simulated process restart; the decision itself
    // remains the same idempotent record.
    firstDatabase.raw.prepare("UPDATE job SET status = 'failed', retryable = 0, available_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), savedJob.id);
    expect(firstService.retryRuntimeJob(savedJob.id)).toMatchObject({ id: savedJob.id, status: 'queued', attempts: 0 });
    firstDatabase.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), savedJob.id);
    firstDatabase.close();

    const secondDatabase = new AppDatabase(databasePath, false);
    seedOwnerProfile(secondDatabase);
    const secondAdapters = createAdapters(config);
    secondAdapters.classifier = new OwnerStateMachineClassifier();
    const secondService = new PmService(secondDatabase, secondAdapters, config);
    await expect(secondService.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });

    expect(secondDatabase.raw.prepare('SELECT status FROM job WHERE id = ?').get(savedJob.id))
      .toEqual({ status: 'completed' });
    expect(secondDatabase.raw.prepare('SELECT state FROM owner_decision WHERE id = ?').get(savedDecision.id))
      .toEqual({ state: 'applied' });
    expect(secondDatabase.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
    expect(secondDatabase.raw.prepare('SELECT status FROM task').get()).toEqual({ status: 'in_progress' });
    expect(secondDatabase.raw.prepare('SELECT state FROM candidate_request').get()).toEqual({ state: 'accepted' });
    await expect(secondService.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 0, recovered: 0 });
    secondDatabase.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('分类已落库但主人判断尚未创建时，重启恢复仍会承接且只执行一次', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-pm-owner-classification-restart-'));
    const databasePath = join(root, 'runtime.sqlite');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: `file:${databasePath}`,
      TASK_MEMORY_ROOT: join(root, 'task-memory'),
    });

    const firstDatabase = new AppDatabase(databasePath, false);
    seedOwnerProfile(firstDatabase);
    const firstAdapters = createAdapters(config);
    firstAdapters.classifier = new OwnerStateMachineClassifier();
    const firstService = new PmService(firstDatabase, firstAdapters, config);

    await firstService.ingestSourceBatch([
      message('classification-restart-request', '想做一个活动埋点需求。', 'requester', '2026-08-10T14:00:00.000Z'),
    ]);

    // Simulate a crash after the source classification transaction has
    // committed its revision, but before processOwnerIntent can create the
    // durable owner_decision row. Recovery must not mistake the source for a
    // fully handled owner turn merely because classificationRevision exists.
    const mutableService = firstService as unknown as {
      processOwnerIntent: (...args: unknown[]) => Promise<unknown>;
    };
    mutableService.processOwnerIntent = async () => {
      throw new Error('simulated crash before owner decision persistence');
    };
    const interrupted = await firstService.ingestSourceBatch([
      message('classification-restart-owner', '我来做。', 'owner', '2026-08-10T14:05:00.000Z'),
    ]);
    expect(interrupted.classificationFailures).toBe(1);
    expect(firstDatabase.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
    expect(firstDatabase.raw.prepare('SELECT COUNT(*) AS count FROM owner_decision').get()).toEqual({ count: 0 });
    const ownerSource = firstDatabase.raw.prepare(
      "SELECT metadata_json FROM source_event WHERE external_id = 'classification-restart-owner'",
    ).get() as { metadata_json: string };
    expect(JSON.parse(ownerSource.metadata_json)).toMatchObject({ classificationRevision: expect.any(String) });
    const savedJob = firstDatabase.raw.prepare(
      "SELECT id, status FROM job WHERE job_type = 'classify_source' ORDER BY rowid DESC LIMIT 1",
    ).get() as { id: string; status: string };
    expect(savedJob.status).toBe('queued');
    const savedCandidate = firstDatabase.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };
    expect(JSON.parse((firstDatabase.raw.prepare('SELECT payload_json FROM job WHERE id = ?').get(savedJob.id) as { payload_json: string }).payload_json))
      .toMatchObject({ ownerTargetSnapshots: { contextCount: 1 } });
    firstService.actOnCandidate(savedCandidate.id, 'ignore', undefined, firstService.getCandidate(savedCandidate.id)!.version);
    firstDatabase.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), savedJob.id);
    firstDatabase.close();

    const secondDatabase = new AppDatabase(databasePath, false);
    seedOwnerProfile(secondDatabase);
    const secondAdapters = createAdapters(config);
    secondAdapters.classifier = new OwnerStateMachineClassifier();
    const secondService = new PmService(secondDatabase, secondAdapters, config);
    await expect(secondService.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });

    expect(secondDatabase.raw.prepare('SELECT status FROM job WHERE id = ?').get(savedJob.id))
      .toEqual({ status: 'completed' });
    expect(secondDatabase.raw.prepare('SELECT state, candidate_id FROM owner_decision').get()).toEqual({ state: 'stale', candidate_id: savedCandidate.id });
    expect(secondDatabase.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
    expect(secondDatabase.raw.prepare('SELECT state FROM candidate_request').get()).toEqual({ state: 'ignored' });
    expect(secondDatabase.raw.prepare('SELECT status FROM job WHERE id = ?').get(savedJob.id)).toEqual({ status: 'completed' });
    expect(secondService.listPendingOwnerActions()).toEqual([]);
    await expect(secondService.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 0, recovered: 0 });
    secondDatabase.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('主人判断目标版本已变化时进入 stale，不覆盖最新任务', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('stale-request', '想做一个活动埋点需求。', 'requester', '2026-08-10T15:00:00.000Z')]);
    await service.ingestSourceBatch([message('stale-owner-accept', '我来做。', 'owner', '2026-08-10T15:05:00.000Z')]);
    const task = service.getTask((database.raw.prepare('SELECT accepted_task_id FROM candidate_request').get() as { accepted_task_id: string }).accepted_task_id)!;

    const original = (service as unknown as { applyOwnerTaskPatchInTransaction: (...args: unknown[]) => unknown }).applyOwnerTaskPatchInTransaction;
    (service as unknown as { applyOwnerTaskPatchInTransaction: (...args: unknown[]) => unknown }).applyOwnerTaskPatchInTransaction = () => {
      throw new Error('simulated owner patch interruption');
    };
    const interrupted = await service.ingestSourceBatch([message('stale-owner-patch', '下周一给到。', 'owner', '2026-08-10T15:10:00.000Z')]);
    expect(interrupted.classificationFailures).toBe(1);
    (service as unknown as { applyOwnerTaskPatchInTransaction: (...args: unknown[]) => unknown }).applyOwnerTaskPatchInTransaction = original;

    const decision = database.raw.prepare("SELECT id, state FROM owner_decision WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'stale-owner-patch')").get() as { id: string; state: string };
    const job = database.raw.prepare('SELECT id FROM job WHERE job_type = \'owner_decision\' ORDER BY created_at DESC LIMIT 1').get() as { id: string };
    expect(decision.state).toBe('failed');
    database.raw.prepare('UPDATE task SET version = version + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), task.id);
    database.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id);

    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect(database.raw.prepare('SELECT state, error FROM owner_decision WHERE id = ?').get(decision.id)).toMatchObject({ state: 'stale', error: expect.stringContaining('需求已经发生变化') });
    expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(job.id)).toMatchObject({ status: 'completed' });
    expect(service.getTask(task.id)?.version).toBe(task.version + 1);
  });

  it('任务删除后重放同一主人消息保留受控 review，不从空快照重扫出孤儿目标', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('retired-replay-request', '想做一个活动埋点需求。', 'requester', '2026-08-14T08:00:00.000Z')]);
    await service.ingestSourceBatch([message('retired-replay-owner', '我来做。', 'owner', '2026-08-14T08:05:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };
    service.deleteCandidate(candidate.id, service.getCandidate(candidate.id)!.version);

    database.raw.prepare("UPDATE source_event SET content = content || ' ' WHERE external_id = 'retired-replay-owner'").run();
    const source = database.raw.prepare("SELECT * FROM source_event WHERE external_id = 'retired-replay-owner'").get();
    await (service as unknown as {
      classifySourceWithStoredBatch: (row: unknown, guidance: string | undefined, deduplicated: boolean, retryFailed: boolean) => Promise<unknown>;
    }).classifySourceWithStoredBatch(source, undefined, true, true);

    expect(database.raw.prepare(
      `SELECT state, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'retired-replay-owner')
       ORDER BY created_at, rowid`,
    ).all()).toEqual([
      { state: 'applied', candidate_id: candidate.id },
      { state: 'review', candidate_id: null },
    ]);
    expect(service.listPendingOwnerActions()).toEqual([
      expect.objectContaining({ state: 'review', candidateId: null, taskId: null }),
    ]);
  });

  it('任务先删除、主人判断后完成时标记 stale，不留下未关联提醒', async () => {
    const classifier = new DelayedOwnerStateMachineClassifier();
    const { service, database } = makeHarness(false, false, classifier);
    await service.ingestSourceBatch([message('delayed-retired-request', '想做一个活动埋点需求。', 'requester', '2026-08-14T09:00:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };

    const ownerIngest = service.ingestSourceBatch([message('delayed-retired-owner', '我来做。', 'owner', '2026-08-14T09:05:00.000Z')]);
    await classifier.ownerStarted;
    service.deleteCandidate(candidate.id, service.getCandidate(candidate.id)!.version);
    classifier.releaseOwner();
    await expect(ownerIngest).resolves.toMatchObject({ classificationFailures: 0 });

    expect(database.raw.prepare(
      `SELECT state, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'delayed-retired-owner')`,
    ).get()).toEqual({ state: 'stale', candidate_id: candidate.id });
    expect(service.listPendingOwnerActions()).toEqual([]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
  });

  it('分类已启动、候选随后被忽略、模型最后完成时标记 stale', async () => {
    const classifier = new DelayedOwnerStateMachineClassifier();
    const { service, database } = makeHarness(false, false, classifier);
    await service.ingestSourceBatch([message('delayed-ignored-request', '想做一个活动埋点需求。', 'requester', '2026-08-14T09:30:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };

    const ownerIngest = service.ingestSourceBatch([message('delayed-ignored-owner', '我来做。', 'owner', '2026-08-14T09:35:00.000Z')]);
    await classifier.ownerStarted;
    const job = database.raw.prepare(
      "SELECT id, payload_json FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; payload_json: string };
    expect(JSON.parse(job.payload_json)).toMatchObject({ ownerTargetSnapshots: { contextCount: 1 } });

    service.actOnCandidate(candidate.id, 'ignore', undefined, service.getCandidate(candidate.id)!.version);
    classifier.releaseOwner();
    await expect(ownerIngest).resolves.toMatchObject({ classificationFailures: 0 });

    expect(database.raw.prepare(
      `SELECT state, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'delayed-ignored-owner')`,
    ).get()).toEqual({ state: 'stale', candidate_id: candidate.id });
    expect(database.raw.prepare('SELECT state FROM candidate_request WHERE id = ?').get(candidate.id))
      .toEqual({ state: 'ignored' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(job.id)).toEqual({ status: 'completed' });
    expect(service.listPendingOwnerActions()).toEqual([]);
    expect(database.raw.prepare(
      "SELECT correction_type, created_at FROM correction_event WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(candidate.id)).toMatchObject({ correction_type: 'candidate_ignored' });
  });

  it('主人分类开始时的零目标快照不会绑定 provider 等待期间后来创建的候选', async () => {
    const classifier = new DelayedOwnerStateMachineClassifier();
    const { service, database } = makeHarness(false, false, classifier);
    const ownerIngest = service.ingestSourceBatch([
      message('empty-snapshot-owner', '我来做。', 'owner', '2026-08-14T09:30:00.000Z'),
    ]);
    await classifier.ownerStarted;

    const job = database.raw.prepare(
      "SELECT id, payload_json FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; payload_json: string };
    expect(JSON.parse(job.payload_json)).toMatchObject({
      ownerTargetSnapshots: {
        schemaVersion: 1,
        contextCount: 0,
        targets: { continue: [], confirm_schedule: [], request_context: [], decline: [], delegate: [], uncertain: [] },
      },
    });

    // This candidate is inserted only after the authoritative negative
    // snapshot was captured, but its source timestamp is still before the
    // owner message so an unsafe completion-time rescan would select it.
    await service.ingestSourceBatch([
      message('empty-snapshot-late-candidate', '想做一个活动埋点需求。', 'requester', '2026-08-14T09:29:00.000Z'),
    ]);
    const candidate = database.raw.prepare('SELECT id, state FROM candidate_request').get() as { id: string; state: string };

    classifier.releaseOwner();
    await expect(ownerIngest).resolves.toMatchObject({ classificationFailures: 0 });

    expect(database.raw.prepare(
      `SELECT state, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'empty-snapshot-owner')`,
    ).get()).toEqual({ state: 'review', candidate_id: null });
    expect(database.raw.prepare('SELECT state FROM candidate_request WHERE id = ?').get(candidate.id))
      .toEqual({ state: candidate.state });
    expect(service.listPendingOwnerActions()).toEqual([
      expect.objectContaining({ state: 'review', candidateId: null, taskId: null }),
    ]);
  });

  it('零目标快照在 provider 崩溃后重启恢复仍不绑定后来候选', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-pm-owner-empty-snapshot-restart-'));
    const databasePath = join(root, 'runtime.sqlite');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: `file:${databasePath}`,
      TASK_MEMORY_ROOT: join(root, 'task-memory'),
    });

    const firstDatabase = new AppDatabase(databasePath, false);
    seedOwnerProfile(firstDatabase);
    const firstAdapters = createAdapters(config);
    const firstClassifier = new CrashAfterOwnerProviderClassifier();
    firstAdapters.classifier = firstClassifier;
    const firstService = new PmService(firstDatabase, firstAdapters, config);

    const interrupted = await firstService.ingestSourceBatch([
      message('empty-restart-owner', '我来做。', 'owner', '2026-08-16T09:30:00.000Z'),
    ]);
    expect(interrupted.classificationFailures).toBe(1);
    expect(firstClassifier.providerCalls).toBe(1);
    const queuedJob = firstDatabase.raw.prepare(
      "SELECT id, status, payload_json FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; status: string; payload_json: string };
    expect(queuedJob.status).toBe('queued');
    expect(JSON.parse(queuedJob.payload_json)).toMatchObject({
      ownerTargetSnapshots: {
        schemaVersion: 1,
        contextCount: 0,
        targets: { continue: [], confirm_schedule: [], request_context: [], decline: [], delegate: [], uncertain: [] },
      },
    });

    // The candidate is created only after the empty snapshot and provider
    // failure have committed. A restarted worker must never bind it.
    await firstService.ingestSourceBatch([
      message('empty-restart-late-candidate', '想做一个活动埋点需求。', 'requester', '2026-08-16T09:29:00.000Z'),
    ]);
    const candidate = firstDatabase.raw.prepare('SELECT id, state FROM candidate_request').get() as { id: string; state: string };
    expect(candidate.state).toBe('pending');
    firstDatabase.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), queuedJob.id);
    firstDatabase.close();

    const secondDatabase = new AppDatabase(databasePath, false);
    seedOwnerProfile(secondDatabase);
    const secondAdapters = createAdapters(config);
    const secondClassifier = new CountingOwnerStateMachineClassifier();
    secondAdapters.classifier = secondClassifier;
    const secondService = new PmService(secondDatabase, secondAdapters, config);
    const persistedBeforeResume = secondDatabase.raw.prepare('SELECT payload_json FROM job WHERE id = ?').get(queuedJob.id) as { payload_json: string };
    expect(JSON.parse(persistedBeforeResume.payload_json)).toMatchObject({
      ownerTargetSnapshots: { schemaVersion: 1, contextCount: 0, targets: { continue: [] } },
    });

    await expect(secondService.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect(secondClassifier.providerCalls).toBe(1);
    expect(secondDatabase.raw.prepare('SELECT status FROM job WHERE id = ?').get(queuedJob.id))
      .toEqual({ status: 'completed' });
    const persistedAfterResume = secondDatabase.raw.prepare('SELECT payload_json FROM job WHERE id = ?').get(queuedJob.id) as { payload_json: string };
    expect(JSON.parse(persistedAfterResume.payload_json)).toMatchObject({
      ownerTargetSnapshots: { schemaVersion: 1, contextCount: 0, targets: { continue: [] } },
    });
    expect(secondDatabase.raw.prepare(
      `SELECT state, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'empty-restart-owner')`,
    ).get()).toEqual({ state: 'noop', candidate_id: null });
    expect(secondDatabase.raw.prepare('SELECT state FROM candidate_request WHERE id = ?').get(candidate.id))
      .toEqual({ state: 'pending' });
    expect(secondDatabase.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
    expect(secondService.listPendingOwnerActions()).toEqual([]);

    secondDatabase.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('无 Runtime job 的 direct 分类也固定使用 provider 开始前的主人目标快照', async () => {
    const classifier = new DelayedOwnerStateMachineClassifier();
    const { service, database } = makeHarness(false, false, classifier);
    await service.ingestSourceBatch([message('direct-snapshot-request', '想做一个活动埋点需求。', 'requester', '2026-08-16T09:00:00.000Z')]);
    const firstCandidate = database.raw.prepare('SELECT id FROM candidate_request ORDER BY rowid LIMIT 1').get() as { id: string };
    await service.captureSourceBatch([message('direct-snapshot-owner', '我来做。', 'owner', '2026-08-16T09:05:00.000Z')]);
    const ownerSource = database.raw.prepare(
      "SELECT * FROM source_event WHERE external_id = 'direct-snapshot-owner'",
    ).get();

    const direct = (service as unknown as {
      classifyCapturedSourceInternal: (source: unknown, guidance: string | undefined, deduplicated: boolean) => Promise<unknown>;
    }).classifyCapturedSourceInternal(ownerSource, undefined, true);
    await classifier.ownerStarted;

    // Persist only a source and a synthetic candidate after the direct
    // provider call has started; classifying this late source would create a
    // competing owner path and obscure the direct-call fence under test.
    await service.captureSourceBatch([message('direct-snapshot-late-request', '想做另一个活动埋点需求。', 'requester', '2026-08-16T09:04:00.000Z')]);
    const lateSource = database.raw.prepare(
      "SELECT id FROM source_event WHERE external_id = 'direct-snapshot-late-request'",
    ).get() as { id: string };
    const firstRow = database.raw.prepare('SELECT * FROM candidate_request WHERE id = ?').get(firstCandidate.id) as {
      title: string;
      proposer_name: string;
      background: string;
      validation_question: string;
      describe: string;
      analysis_json: string;
      confidence: number;
      context_state: string;
      context_reason: string | null;
    };
    const lateCandidate = { id: 'cand_direct_snapshot_late' };
    database.raw.prepare(
      `INSERT INTO candidate_request
       (id, source_event_id, demand_unit_id, title, proposer_name, background, validation_question, describe,
        analysis_json, confidence, state, snoozed_until, accepted_task_id, merged_into_candidate_id,
        merged_at, deleted_at, processing_state, processing_job_id, processing_error, context_state,
        context_reason, recovered_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, 'ready', NULL, NULL, ?, ?, NULL, ?, ?)`
    ).run(
      lateCandidate.id,
      lateSource.id,
      `${String(firstRow.title)}（后来候选）`,
      firstRow.proposer_name,
      firstRow.background,
      firstRow.validation_question,
      firstRow.describe,
      firstRow.analysis_json,
      firstRow.confidence,
      firstRow.context_state,
      firstRow.context_reason,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    classifier.releaseOwner();
    await expect(direct).resolves.toBeTruthy();

    expect(database.raw.prepare(
      `SELECT state, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'direct-snapshot-owner')`,
    ).get()).toEqual({ state: 'applied', candidate_id: firstCandidate.id });
    expect(database.raw.prepare('SELECT state FROM candidate_request WHERE id = ?').get(lateCandidate.id))
      .toEqual({ state: 'pending' });
  });

  it('已存在的耐久主人目标快照不会在 provider 在途时重新捕获或绑定后来候选', async () => {
    const classifier = new DelayedOwnerStateMachineClassifier();
    const { service, database } = makeHarness(false, false, classifier);
    await service.ingestSourceBatch([message('stored-snapshot-request', '想做一个活动埋点需求。', 'requester', '2026-08-16T10:00:00.000Z')]);
    const firstCandidate = database.raw.prepare('SELECT id FROM candidate_request ORDER BY rowid LIMIT 1').get() as { id: string };
    const mutable = service as unknown as {
      captureOwnerDecisionTargets: (source: unknown) => unknown;
    };
    const originalCapture = mutable.captureOwnerDecisionTargets;
    let captureCalls = 0;
    mutable.captureOwnerDecisionTargets = (source) => {
      captureCalls += 1;
      return originalCapture.call(service, source);
    };

    const ownerIngest = service.ingestSourceBatch([message('stored-snapshot-owner', '我来做。', 'owner', '2026-08-16T10:05:00.000Z')]);
    await classifier.ownerStarted;
    await service.ingestSourceBatch([message('stored-snapshot-late-request', '想做另一个活动埋点需求。', 'requester', '2026-08-16T10:04:00.000Z')]);
    const lateCandidate = database.raw.prepare(
      "SELECT id FROM candidate_request WHERE id <> ?",
    ).get(firstCandidate.id) as { id: string };
    classifier.releaseOwner();
    await expect(ownerIngest).resolves.toMatchObject({ classificationFailures: 0 });

    expect(captureCalls).toBe(1);
    expect(database.raw.prepare(
      `SELECT state, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'stored-snapshot-owner')`,
    ).get()).toEqual({ state: 'applied', candidate_id: firstCandidate.id });
    expect(database.raw.prepare('SELECT state FROM candidate_request WHERE id = ?').get(lateCandidate.id))
      .toEqual({ state: 'pending' });
  });

  it('legacy job 缺少快照时只捕获一次并持久化，provider 在途新增候选不改变目标', async () => {
    const classifier = new RetryableCrashingDelayedOwnerClassifier();
    const { service, database } = makeHarness(false, false, classifier);
    await service.ingestSourceBatch([message('legacy-missing-request', '想做一个活动埋点需求。', 'requester', '2026-08-16T11:00:00.000Z')]);
    const firstCandidate = database.raw.prepare('SELECT id FROM candidate_request ORDER BY rowid LIMIT 1').get() as { id: string };

    const ownerIngest = service.ingestSourceBatch([message('legacy-missing-owner', '我来做。', 'owner', '2026-08-16T11:05:00.000Z')]);
    await classifier.firstStarted;
    classifier.releaseFirst();
    await expect(ownerIngest).resolves.toMatchObject({ classificationFailures: 1 });
    const job = database.raw.prepare(
      "SELECT id, payload_json FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; payload_json: string };
    const legacyPayload = JSON.parse(job.payload_json) as Record<string, unknown>;
    delete legacyPayload.ownerTargetSnapshots;
    database.raw.prepare('UPDATE job SET payload_json = ?, available_at = ? WHERE id = ?')
      .run(JSON.stringify(legacyPayload), new Date(Date.now() - 1_000).toISOString(), job.id);

    const resume = service.resumeRuntimeJobs();
    await classifier.retryStarted;
    await service.ingestSourceBatch([message('legacy-missing-late-request', '想做另一个活动埋点需求。', 'requester', '2026-08-16T11:04:00.000Z')]);
    const lateCandidate = database.raw.prepare(
      "SELECT id FROM candidate_request WHERE id <> ?",
    ).get(firstCandidate.id) as { id: string };
    classifier.releaseRetry();
    await expect(resume).resolves.toMatchObject({ processed: 1, recovered: 1 });

    expect(database.raw.prepare(
      `SELECT state, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'legacy-missing-owner')`,
    ).get()).toEqual({ state: 'applied', candidate_id: firstCandidate.id });
    expect(database.raw.prepare('SELECT state FROM candidate_request WHERE id = ?').get(lateCandidate.id))
      .toEqual({ state: 'pending' });
    const persisted = database.raw.prepare('SELECT payload_json FROM job WHERE id = ?').get(job.id) as { payload_json: string };
    expect(JSON.parse(persisted.payload_json)).toMatchObject({ ownerTargetSnapshots: { contextCount: 1 } });
  });

  it('malformed persisted 主人目标快照在 provider 前 fail-closed，不回退扫描', async () => {
    const classifier = new CrashAfterOwnerProviderClassifier();
    const { service, database } = makeHarness(false, false, classifier);
    await service.ingestSourceBatch([message('malformed-snapshot-request', '想做一个活动埋点需求。', 'requester', '2026-08-16T12:00:00.000Z')]);
    const ownerIngest = service.ingestSourceBatch([message('malformed-snapshot-owner', '我来做。', 'owner', '2026-08-16T12:05:00.000Z')]);
    await expect(ownerIngest).resolves.toMatchObject({ classificationFailures: 1 });
    const job = database.raw.prepare(
      "SELECT id, payload_json FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; payload_json: string };
    const malformed = JSON.parse(job.payload_json) as Record<string, unknown>;
    malformed.ownerTargetSnapshots = { schemaVersion: 1, contextCount: 'unknown', targets: {} };
    database.raw.prepare('UPDATE job SET payload_json = ?, available_at = ? WHERE id = ?')
      .run(JSON.stringify(malformed), new Date(Date.now() - 1_000).toISOString(), job.id);
    const callsBeforeResume = classifier.providerCalls;

    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect(classifier.providerCalls).toBe(callsBeforeResume);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM owner_decision').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(job.id))
      .toMatchObject({ status: 'queued' });
  });

  it('分类重试排队后候选被忽略，Runtime 重试仍沿用耐久目标快照并标记 stale', async () => {
    const classifier = new RetryableDelayedOwnerStateMachineClassifier();
    const { service, database } = makeHarness(false, false, classifier);
    await service.ingestSourceBatch([message('retry-ignored-request', '想做一个活动埋点需求。', 'requester', '2026-08-14T09:40:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };
    const ownerIngest = service.ingestSourceBatch([message('retry-ignored-owner', '我来做。', 'owner', '2026-08-14T09:45:00.000Z')]);
    await classifier.ownerStarted;
    const job = database.raw.prepare(
      "SELECT id, payload_json FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; payload_json: string };
    expect(JSON.parse(job.payload_json)).toMatchObject({ ownerTargetSnapshots: { contextCount: 1 } });
    service.actOnCandidate(candidate.id, 'ignore', undefined, service.getCandidate(candidate.id)!.version);
    classifier.releaseOwner();
    await expect(ownerIngest).resolves.toMatchObject({ classificationFailures: 1 });
    database.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id);

    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect(database.raw.prepare(
      `SELECT state, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'retry-ignored-owner')`,
    ).get()).toEqual({ state: 'stale', candidate_id: candidate.id });
    expect(service.listPendingOwnerActions()).toEqual([]);
  });

  it('主人目标快照持久化失败时在 provider 前 fail-closed 且不产生业务副作用', async () => {
    const classifier = new CountingOwnerStateMachineClassifier();
    const { service, database } = makeHarness(false, false, classifier);
    await service.ingestSourceBatch([message('snapshot-write-failure-request', '想做一个活动埋点需求。', 'requester', '2026-08-14T09:47:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id, state FROM candidate_request').get() as { id: string; state: string };
    const providerCallsBeforeOwner = classifier.providerCalls;
    const sideEffectTables = [
      'candidate_request',
      'task',
      'owner_decision',
      'notification',
      'task_event',
      'correction_event',
      'runtime_tool_call',
      'ai_decision_log',
    ] as const;
    const sideEffectsBefore = Object.fromEntries(sideEffectTables.map((table) => [
      table,
      database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]));
    const mutable = service as unknown as {
      captureOwnerDecisionTargets: (source: unknown) => unknown;
    };
    const originalCapture = mutable.captureOwnerDecisionTargets;
    let captureCalls = 0;
    mutable.captureOwnerDecisionTargets = (source) => {
      captureCalls += 1;
      // Force a legacy-shaped queued job so the fallback durable write is the
      // only boundary that can make provider execution safe.
      return captureCalls === 1 ? undefined : originalCapture.call(service, source);
    };
    // The production path must fail at the real SQLite payload UPDATE, not
    // only when a private method is monkeypatched.  INSERT still succeeds,
    // while this trigger aborts the exact durable snapshot boundary.
    database.raw.exec(`CREATE TRIGGER injected_owner_snapshot_payload_failure
      BEFORE UPDATE OF payload_json ON job
      WHEN NEW.id = (SELECT id FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1)
      BEGIN SELECT RAISE(ABORT, 'injected owner snapshot payload failure'); END;`);

    const result = await service.ingestSourceBatch([message(
      'snapshot-write-failure-owner',
      '我来做。',
      'owner',
      '2026-08-14T09:48:00.000Z',
    )]);

    expect(result.classificationFailures).toBe(1);
    expect(classifier.providerCalls).toBe(providerCallsBeforeOwner);
    for (const table of sideEffectTables) {
      expect(database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
        .toEqual(sideEffectsBefore[table]);
    }
    expect(database.raw.prepare('SELECT state FROM candidate_request WHERE id = ?').get(candidate.id))
      .toEqual({ state: candidate.state });
    const job = database.raw.prepare(
      "SELECT id, status, payload_json FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; status: string; payload_json: string };
    expect(job.status).toBe('queued');
    expect(JSON.parse(job.payload_json)).not.toHaveProperty('ownerTargetSnapshots');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_tool_call WHERE job_id = ?').get(job.id))
      .toEqual({ count: 0 });
  });

  it('旧任务缺少快照时只有同一 root 强关系和退休边界都成立才标记 stale', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('legacy-ignored-request', '想做一个活动埋点需求。', 'requester', '2026-08-14T09:50:00.000Z', { rootId: 'legacy-ignored-root' })]);
    const candidate = database.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };
    const original = (service as unknown as { processOwnerIntent: (...args: unknown[]) => Promise<unknown> }).processOwnerIntent;
    (service as unknown as { processOwnerIntent: (...args: unknown[]) => Promise<unknown> }).processOwnerIntent = async () => {
      throw new Error('simulated crash before owner decision persistence');
    };
    const interrupted = await service.ingestSourceBatch([
      message('legacy-ignored-owner', '我来做。', 'owner', '2026-08-14T09:55:00.000Z', { rootId: 'legacy-ignored-root' }),
    ]);
    expect(interrupted.classificationFailures).toBe(1);
    (service as unknown as { processOwnerIntent: (...args: unknown[]) => Promise<unknown> }).processOwnerIntent = original;
    const job = database.raw.prepare(
      "SELECT id, payload_json FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; payload_json: string };
    service.actOnCandidate(candidate.id, 'ignore', undefined, service.getCandidate(candidate.id)!.version);
    const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
    delete payload.ownerTargetSnapshots;
    database.raw.prepare('UPDATE job SET payload_json = ?, available_at = ? WHERE id = ?')
      .run(JSON.stringify(payload), new Date(Date.now() - 1_000).toISOString(), job.id);

    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect(database.raw.prepare(
      `SELECT state, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'legacy-ignored-owner')`,
    ).get()).toEqual({ state: 'stale', candidate_id: candidate.id });
  });

  it('真正从未关联活动需求的主人歧义判断仍显示待确认', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('unbound-owner-only', '这个需求我拒绝，我是数分，不是产品。', 'owner', '2026-08-14T10:00:00.000Z')]);

    expect(database.raw.prepare('SELECT state, candidate_id FROM owner_decision').get())
      .toEqual({ state: 'review', candidate_id: null });
    expect(service.listPendingOwnerActions()).toMatchObject([{
      action: 'decline',
      state: 'review',
      candidateId: null,
      taskId: null,
    }]);
  });

  it('任务被纠错为无效记录时立即关闭相关待处理主人判断并保留审计', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('invalidated-request', '想做一个活动埋点需求。', 'requester', '2026-08-14T11:00:00.000Z')]);
    await service.ingestSourceBatch([message('invalidated-owner', '我来做。', 'owner', '2026-08-14T11:05:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id, accepted_task_id FROM candidate_request').get() as { id: string; accepted_task_id: string };
    const task = service.getTask(candidate.accepted_task_id)!;
    database.raw.prepare("UPDATE owner_decision SET state = 'review' WHERE candidate_id = ?").run(candidate.id);

    service.recordCorrection({ correctionType: 'false_positive', candidateId: candidate.id, expectedCandidateVersion: service.getCandidate(candidate.id)!.version, expectedTaskVersion: task.version });

    expect(database.raw.prepare('SELECT record_state FROM task WHERE id = ?').get(task.id)).toEqual({ record_state: 'invalidated' });
    expect(database.raw.prepare('SELECT state FROM owner_decision WHERE candidate_id = ?').get(candidate.id)).toEqual({ state: 'stale' });
    expect(service.listPendingOwnerActions()).toEqual([]);
  });

  it('忽略候选组会把相关待确认主人判断转为 stale，其他审计逐值不变', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('ignored-group-request', '想做一个活动埋点需求。', 'requester', '2026-08-14T12:00:00.000Z')]);
    await service.ingestSourceBatch([message('ignored-group-owner', '策划案在哪？先发我。', 'owner', '2026-08-14T12:05:00.000Z')]);
    const before = database.raw.prepare(
      'SELECT id, source_event_id, action, disposition, candidate_id, state, created_at FROM owner_decision',
    ).get() as {
      id: string;
      source_event_id: string;
      action: string;
      disposition: string;
      candidate_id: string | null;
      state: string;
      created_at: string;
    };
    const candidate = database.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };
    service.actOnCandidate(candidate.id, 'ignore', undefined, service.getCandidate(candidate.id)!.version);

    expect(database.raw.prepare('SELECT state FROM owner_decision WHERE id = ?').get(before.id)).toEqual({ state: 'stale' });
    expect(database.raw.prepare(
      'SELECT id, source_event_id, action, disposition, candidate_id, created_at FROM owner_decision WHERE id = ?',
    ).get(before.id)).toEqual({
      id: before.id,
      source_event_id: before.source_event_id,
      action: before.action,
      disposition: before.disposition,
      candidate_id: before.candidate_id,
      created_at: before.created_at,
    });
    expect(service.listPendingOwnerActions()).toEqual([]);
  });

  it('启动对账只修复可证明属于退休目标的 legacy 孤儿判断', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('legacy-orphan-request', '想做一个活动埋点需求。', 'requester', '2026-08-14T13:00:00.000Z')]);
    await service.ingestSourceBatch([message('legacy-orphan-owner', '我来做。', 'owner', '2026-08-14T13:05:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };
    service.deleteCandidate(candidate.id, service.getCandidate(candidate.id)!.version);
    database.raw.prepare(
      `INSERT INTO owner_decision
       (id, source_event_id, source_revision, candidate_id, thread_id, task_id, action, disposition,
        confidence, summary, delegate_to, schedule_text, patch_json, evidence_json, reason,
        provider, model, prompt_version, runtime_job_id, state, target_snapshot_json, error, created_at, applied_at)
       SELECT 'legacy-owner-orphan', source_event_id, source_revision || ':legacy', NULL, NULL, NULL,
              action, 'review', confidence, summary, delegate_to, schedule_text, patch_json, evidence_json, reason,
              provider, model, prompt_version, NULL, 'review', '{}', NULL, ?, NULL
       FROM owner_decision WHERE state = 'applied' LIMIT 1`,
    ).run('2026-08-14T13:10:00.000Z');

    (service as unknown as { reconcileRetiredOwnerDecisions: () => void }).reconcileRetiredOwnerDecisions();

    expect(database.raw.prepare("SELECT state, error FROM owner_decision WHERE id = 'legacy-owner-orphan'").get())
      .toMatchObject({ state: 'stale', error: expect.stringContaining('仅保留审计') });
    expect(service.listPendingOwnerActions()).toEqual([]);
  });

  it('旧 Runtime 租约在新主人接管后不能覆盖主人目标快照', async () => {
    const { service, database } = makeHarness();
    const mutable = service as unknown as {
      runtime: {
        begin: (input: Record<string, unknown>) => { id: string; acquired: boolean; lease_owner: string | null };
        claim: (jobId: string, leaseOwner: string, leaseMs?: number) => { acquired: boolean; lease_owner: string | null };
        get: (jobId: string) => { payload_json: string; lease_owner: string | null } | null;
      };
      persistRuntimeOwnerDecisionTargets: (jobId: string, leaseOwner: string, snapshots: unknown) => void;
    };
    const job = mutable.runtime.begin({
      jobType: 'classify_source',
      payload: { keep: true },
      idempotencyKey: 'owner-target-lease-fence',
      leaseOwner: 'old-owner',
      leaseMs: 60_000,
    });
    expect(job.acquired).toBe(true);
    database.raw.prepare('UPDATE job SET locked_until = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), job.id);
    const takeover = mutable.runtime.claim(job.id, 'new-owner', 60_000);
    expect(takeover).toMatchObject({ acquired: true, lease_owner: 'new-owner' });

    expect(() => mutable.persistRuntimeOwnerDecisionTargets(job.id, 'old-owner', {
      contextCount: 1,
      targets: {},
    })).toThrow('租约已失效');
    expect(JSON.parse(mutable.runtime.get(job.id)!.payload_json)).toEqual({ keep: true });
    expect(mutable.runtime.get(job.id)!.lease_owner).toBe('new-owner');
  });

  it('忽略候选后无关更新不能伪造退休时间，主人判断保持 review', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('ignored-unrelated-request', '想做一个活动埋点需求。', 'requester', '2026-08-15T08:00:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };
    service.actOnCandidate(candidate.id, 'ignore', undefined, service.getCandidate(candidate.id)!.version);
    database.raw.prepare('UPDATE candidate_request SET title = ?, updated_at = ? WHERE id = ?')
      .run('无关编辑后的标题', '2026-08-16T08:00:00.000Z', candidate.id);

    await service.ingestSourceBatch([message('ignored-unrelated-owner', '我来做。', 'owner', '2026-08-15T08:05:00.000Z')]);

    expect(database.raw.prepare(
      `SELECT state, candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'ignored-unrelated-owner')`,
    ).get()).toEqual({ state: 'review', candidate_id: null });
    expect(service.listPendingOwnerActions()).toMatchObject([{ candidateId: null, state: 'review' }]);
  });

  it('同会话但无强关系的无关退休候选不能把 legacy orphan 判断改成 stale', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('unrelated-retired-request', '想做一个活动埋点需求。', 'requester', '2026-08-15T09:00:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };
    service.deleteCandidate(candidate.id, service.getCandidate(candidate.id)!.version);
    const source = message('unrelated-retired-owner', '这不是我的需求。', 'owner', '2026-08-15T09:05:00.000Z', {
      isOwnerMessage: false,
      senderRole: 'requester',
      contextOnly: false,
      matchedOwnerOpenId: null,
    });
    await service.ingestSourceBatch([source]);
    const sourceRow = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get(source.externalId) as { id: string };
    database.raw.prepare(
      `INSERT INTO owner_decision
       (id, source_event_id, source_revision, candidate_id, thread_id, task_id, action, disposition,
        confidence, summary, delegate_to, schedule_text, patch_json, evidence_json, reason,
        provider, model, prompt_version, runtime_job_id, state, target_snapshot_json, error, created_at, applied_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, 'decline', 'review', 0.5, ?, NULL, NULL, '{}', '[]', ?,
               'test', 'test', 'v1', NULL, 'review', '{}', NULL, ?, NULL)`,
    ).run('legacy-unrelated-orphan', sourceRow.id, 'legacy-unrelated-revision', '不是我的需求', '未找到可验证目标。', '2026-08-15T09:06:00.000Z');

    (service as unknown as { reconcileRetiredOwnerDecisions: () => void }).reconcileRetiredOwnerDecisions();

    expect(database.raw.prepare("SELECT state, candidate_id FROM owner_decision WHERE id = 'legacy-unrelated-orphan'").get())
      .toEqual({ state: 'review', candidate_id: null });
  });

  it('accepted snapshot 在候选状态或 accepted_task_id 变化后均 fail-closed', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('accepted-target-request', '想做一个活动埋点需求。', 'requester', '2026-08-15T10:00:00.000Z')]);
    await service.ingestSourceBatch([message('accepted-target-owner', '我来做。', 'owner', '2026-08-15T10:05:00.000Z')]);
    const row = database.raw.prepare(
      `SELECT candidate_id FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'accepted-target-owner')`,
    ).get() as { candidate_id: string };
    const candidateBefore = service.getCandidate(row.candidate_id)!;
    const taskBefore = service.getTask(candidateBefore.accepted_task_id!)!;
    const threadBefore = (service as unknown as {
      threadForCandidate: (candidate: unknown) => { id: string; version: number } | null;
    }).threadForCandidate(candidateBefore);
    const persistedTarget = JSON.parse((database.raw.prepare(
      `SELECT target_snapshot_json FROM owner_decision
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'accepted-target-owner')`,
    ).get() as { target_snapshot_json: string }).target_snapshot_json) as Record<string, unknown>;
    const currentGroupRows = database.raw.prepare(
      'SELECT id, version, updated_at FROM candidate_request WHERE id = ? OR merged_into_candidate_id = ? ORDER BY id',
    ).all(candidateBefore.id, candidateBefore.id) as Array<{ id: string; version: number; updated_at: string }>;
    const candidateGroupVersionHash = createHash('sha256')
      .update(JSON.stringify(currentGroupRows.map((candidate) => ({
        id: candidate.id,
        version: candidate.version,
        updatedAt: candidate.updated_at,
      })).sort((left, right) => left.id.localeCompare(right.id))))
      .digest('hex');
    const target = {
      ...persistedTarget,
      candidateVersion: candidateBefore.version,
      candidateGroupVersionHash,
      candidateState: candidateBefore.state,
      acceptedTaskId: candidateBefore.accepted_task_id,
      threadId: threadBefore?.id ?? null,
      taskId: taskBefore.id,
      taskStatus: taskBefore.status,
      taskVersion: taskBefore.version,
      threadVersion: threadBefore?.version ?? null,
    };
    const mutable = service as unknown as { ownerTargetMatchesCurrent: (value: unknown) => boolean };
    expect(mutable.ownerTargetMatchesCurrent(target)).toBe(true);

    database.raw.prepare('UPDATE candidate_request SET state = \'pending\', accepted_task_id = NULL WHERE id = ?').run(row.candidate_id);
    expect(mutable.ownerTargetMatchesCurrent(target)).toBe(false);

    database.raw.prepare('UPDATE candidate_request SET state = \'accepted\', accepted_task_id = ? WHERE id = ?')
      .run(null, row.candidate_id);
    expect(mutable.ownerTargetMatchesCurrent(target)).toBe(false);
  });

  it('忽略事务中 stale 更新失败时候选、提醒和主人判断全部回滚', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('ignore-rollback-request', '想做一个活动埋点需求。', 'requester', '2026-08-15T11:00:00.000Z')]);
    await service.ingestSourceBatch([message('ignore-rollback-owner', '策划案在哪？先发我。', 'owner', '2026-08-15T11:05:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id, state FROM candidate_request').get() as { id: string; state: string };
    database.raw.exec(`CREATE TRIGGER injected_owner_stale_failure
      BEFORE UPDATE OF state ON owner_decision
      WHEN NEW.state = 'stale'
      BEGIN SELECT RAISE(ABORT, 'injected stale update failure'); END;`);

    expect(() => service.actOnCandidate(candidate.id, 'ignore', undefined, service.getCandidate(candidate.id)!.version)).toThrow('injected stale update failure');
    expect(database.raw.prepare('SELECT state FROM candidate_request WHERE id = ?').get(candidate.id)).toEqual({ state: candidate.state });
    expect(database.raw.prepare(
      'SELECT archived_at FROM notification WHERE candidate_id = ? ORDER BY created_at LIMIT 1',
    ).get(candidate.id)).toEqual({ archived_at: null });
    expect(database.raw.prepare('SELECT state FROM owner_decision').get()).toEqual({ state: 'review' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get()).toEqual({ count: 0 });
  });

  it('无效纠错中 stale 更新失败时 task、candidate、decision、notification、correction 全部回滚', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('invalidate-rollback-request', '想做一个活动埋点需求。', 'requester', '2026-08-15T12:00:00.000Z')]);
    await service.ingestSourceBatch([message('invalidate-rollback-owner', '我来做。', 'owner', '2026-08-15T12:05:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id, accepted_task_id FROM candidate_request').get() as { id: string; accepted_task_id: string };
    const task = service.getTask(candidate.accepted_task_id)!;
    database.raw.prepare("UPDATE owner_decision SET state = 'review' WHERE candidate_id = ?").run(candidate.id);
    database.raw.exec(`CREATE TRIGGER injected_owner_stale_failure
      BEFORE UPDATE OF state ON owner_decision
      WHEN NEW.state = 'stale'
      BEGIN SELECT RAISE(ABORT, 'injected stale update failure'); END;`);

    expect(() => service.recordCorrection({ correctionType: 'false_positive', candidateId: candidate.id, expectedCandidateVersion: service.getCandidate(candidate.id)!.version, expectedTaskVersion: task.version }))
      .toThrow('injected stale update failure');
    expect(database.raw.prepare('SELECT state, accepted_task_id FROM candidate_request WHERE id = ?').get(candidate.id))
      .toEqual({ state: 'accepted', accepted_task_id: task.id });
    expect(database.raw.prepare('SELECT record_state, deleted_at FROM task WHERE id = ?').get(task.id))
      .toEqual({ record_state: 'active', deleted_at: null });
    expect(database.raw.prepare('SELECT state FROM owner_decision').get()).toEqual({ state: 'review' });
    expect(database.raw.prepare('SELECT archived_at FROM notification WHERE candidate_id = ? ORDER BY created_at LIMIT 1').get(candidate.id))
      .toEqual({ archived_at: null });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get()).toEqual({ count: 0 });
  });

  it('候选恢复后旧 stale 判断保持 stale，旧来源重放不回 review', async () => {
    const { service, database } = makeHarness();
    await service.ingestSourceBatch([message('restore-stale-request', '想做一个活动埋点需求。', 'requester', '2026-08-15T13:00:00.000Z')]);
    await service.ingestSourceBatch([message('restore-stale-owner', '策划案在哪？先发我。', 'owner', '2026-08-15T13:05:00.000Z')]);
    const candidate = database.raw.prepare('SELECT id FROM candidate_request').get() as { id: string };
    const source = database.raw.prepare('SELECT * FROM source_event WHERE external_id = ?').get('restore-stale-owner');
    service.deleteCandidate(candidate.id, service.getCandidate(candidate.id)!.version);
    service.restoreCandidate(candidate.id, service.getCandidate(candidate.id)!.version);

    await (service as unknown as {
      classifySourceWithStoredBatch: (row: unknown, guidance: string | undefined, deduplicated: boolean, retryFailed: boolean) => Promise<unknown>;
    }).classifySourceWithStoredBatch(source, undefined, true, false);

    expect(database.raw.prepare('SELECT state FROM owner_decision ORDER BY rowid LIMIT 1').get()).toEqual({ state: 'stale' });
    expect(service.listPendingOwnerActions()).toEqual([]);
  });
});
