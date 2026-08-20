import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CandidateDraft, MessageAction, NormalizedSourceEvent, OwnerIntentDecision, SourceDocumentContext } from '../src/domain.js';
import type { ClassifierAdapter, ClassificationResult } from '../src/integration-contracts.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { OpenAICompatibleClassifier } from '../src/integrations/llm.js';
import { PmRuntime, sanitizeRuntimeError } from '../src/runtime.js';
import { PmService } from '../src/service.js';

const baseTime = '2026-08-11T09:00:00.000Z';

function syntheticRetryCooldownDatabase() {
  return new AppDatabase(':memory:', false);
}

function draftFor(event: NormalizedSourceEvent): CandidateDraft {
  const isFollowUp = /补充|追加|继续|匹配第一/u.test(event.content);
  const title = event.content.includes('活动A') ? '活动A留存分析' : event.content.includes('活动B') ? '活动B留存分析' : isFollowUp ? '活动留存分析补充' : '留存分析';
  return {
    title,
    proposerName: event.senderName,
    background: isFollowUp ? '补充活动留存与付费背景。' : `需要验证：${event.content}`,
    validationQuestion: isFollowUp ? '是否需要把付费行为纳入验证？' : '是否值得继续投入？',
    describe: event.content,
    confidence: 0.9,
    analysis: {
      timeRange: { status: 'unknown', sourceText: null, startAt: null, endAt: null, timezone: 'Asia/Shanghai', needsConfirmation: true },
      fieldBasis: { background: 'fact', validationQuestion: isFollowUp ? 'inferred' : 'unknown', describe: 'fact' },
      recognitionEvidence: ['测试分类器识别到明确的数据需求。'],
    },
  };
}

class ScriptedClassifier implements ClassifierAdapter {
  readonly kind = 'rule_mock' as const;
  readonly provider = 'test-provider';
  readonly model = 'test-model';
  readonly promptVersion = 'test-prompt-v1';

  async classify(event: NormalizedSourceEvent, guidance?: string): Promise<ClassificationResult> {
    const draft = draftFor(event);
    if (guidance?.trim()) {
      draft.background = `${draft.background} 主人补充：${guidance.trim()}`;
      draft.describe = `${draft.describe}\n主人补充：${guidance.trim()}`;
    }
    return {
      isDataRequest: true,
      draft,
      reason: '测试分类器识别为数据需求。',
      relatedTaskHint: event.content.includes('匹配第一') ? '活动A留存分析' : null,
      importantDates: [],
      deliverables: [],
      commitments: [],
      usedFallback: false,
      metadata: { structuredMode: 'json_object', fallbackMode: 'llm', inputCharCount: event.content.length, attempts: 1 },
    };
  }

  async testConnection() {
    return { ok: true, status: 'mock' as const, message: 'test', checkedAt: new Date().toISOString() };
  }
}

class ScenarioClassifier extends ScriptedClassifier {
  constructor(
    private readonly transform: (draft: CandidateDraft, event: NormalizedSourceEvent) => void,
    private readonly fallback = false,
    private readonly associate?: (event: NormalizedSourceEvent) => {
      targetIndex: number | null;
      scores?: number[];
      confidence?: number;
    },
  ) {
    super();
  }

  override async classify(event: NormalizedSourceEvent, guidance?: string): Promise<ClassificationResult> {
    const result = await super.classify(event, guidance);
    if (result.draft) this.transform(result.draft, event);
    result.usedFallback = this.fallback;
    if (this.fallback) result.outcome = 'rule_final';
    const context = event.classificationContext;
    if (context?.candidates.length && this.associate) {
      const selection = this.associate(event);
      const scores = context.candidates.map((candidate, index) => ({
        threadId: candidate.threadId,
        taskId: candidate.taskId,
        confidence: selection.scores?.[index] ?? (index === selection.targetIndex ? selection.confidence ?? 0.98 : 0.2),
      }));
      const target = selection.targetIndex === null ? null : context.candidates[selection.targetIndex] ?? null;
      result.threadAssociation = {
        targetThreadId: target?.threadId ?? null,
        targetTaskId: target?.taskId ?? null,
        confidence: target ? scores[selection.targetIndex!]?.confidence ?? selection.confidence ?? 0.98 : null,
        scores,
        reason: target ? '测试模型明确选择当前已有需求线程。' : '测试模型无法唯一选择已有需求线程。',
        evidence: target ? ['测试模型返回了匿名候选中的唯一目标。'] : ['测试模型未返回唯一目标。'],
        candidateSetHash: context.candidateSetHash,
        candidateSetComplete: context.candidateSetComplete,
      };
      if (result.draft?.analysis) result.draft.analysis.threadAssociation = result.threadAssociation;
    }
    return result;
  }
}

/**
 * A small live-shaped adapter used to exercise the production thread-centric
 * branch without calling a real provider.  The branch is deliberately gated
 * by `kind: 'live'`, so this fixture verifies that only an explicit semantic
 * model decision can bypass legacy candidate creation.
 */
class LiveThreadCentricClassifier implements ClassifierAdapter {
  readonly kind = 'live' as const;
  readonly provider = 'test-live-provider';
  readonly model = 'test-live-model';
  readonly promptVersion = 'test-thread-centric-v1';

  async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    if (event.content.includes('请分析')) {
      const draft = draftFor(event);
      return {
        outcome: 'valid',
        isDataRequest: true,
        draft,
        messageAction: {
          action: 'new_demand',
          confidence: 0.99,
          evidence: ['消息明确提出新的数据分析目标。'],
          reason: '建立新的需求线程。',
        },
        semanticAnalysis: draft.analysis ?? null,
        reason: '建立新的需求线程。',
        relatedTaskHint: null,
        ownerIntent: null,
        threadAssociation: null,
        candidateMerge: null,
        importantDates: [],
        deliverables: [],
        commitments: [],
        usedFallback: false,
        metadata: { structuredMode: 'json_schema', fallbackMode: 'llm', inputCharCount: event.content.length, attempts: 1 },
      };
    }
    const analysis: NonNullable<ClassificationResult['semanticAnalysis']> = {
      timeRange: {
        status: 'relative_resolved',
        sourceText: '下周一交付',
        startAt: null,
        endAt: '2026-08-17T15:59:59.999Z',
        timezone: 'Asia/Shanghai',
        needsConfirmation: false,
      },
      fieldBasis: { background: 'fact', validationQuestion: 'unknown', describe: 'fact' },
      recognitionEvidence: ['对方给出了明确交付时间，主人确认继续推进。'],
      ownerAction: null,
      ownerIntent: null,
      prioritySuggestion: null,
      note: null,
      statusSuggestion: 'in_progress',
      nextStepSuggestion: '收到策划案后核对具体口径。',
      waitingReasonSuggestion: null,
      updateConfidence: 0.99,
      narrativeUpdates: {
        taskDescribe: { value: '已确认下周一交付，等待策划案补充。', mode: 'append', basis: 'fact', confidence: 0.99 },
      },
      threadAssociation: null,
      candidateMerge: null,
    };
    return {
      outcome: 'valid',
      isDataRequest: false,
      draft: null,
      messageAction: {
        action: 'update_existing',
        confidence: 0.99,
        evidence: ['消息是已有需求的连续推进，不是新的候选。'],
        reason: '将交付时间和推进状态写入已有需求线程。',
      },
      semanticAnalysis: analysis,
      reason: '已有需求的稀疏更新。',
      relatedTaskHint: null,
      ownerIntent: null,
      threadAssociation: null,
      candidateMerge: null,
      importantDates: [],
      deliverables: [],
      commitments: [],
      usedFallback: false,
      metadata: { structuredMode: 'json_schema', fallbackMode: 'llm', inputCharCount: event.content.length, attempts: 1 },
    };
  }

  async testConnection() {
    return { ok: true, status: 'mock' as const, message: 'test', checkedAt: new Date().toISOString() };
  }
}

class LiveContextOnlyClassifier extends LiveThreadCentricClassifier {
  override async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    const result = await super.classify(event);
    if (event.content.includes('请分析')) return result;
    return {
      ...result,
      messageAction: {
        action: 'context_only',
        confidence: 0.97,
        evidence: ['消息只是礼貌确认或背景补充。'],
        reason: '不改变需求内容。',
      },
      semanticAnalysis: null,
    };
  }
}

class LiveAssociationDeferredClassifier extends LiveThreadCentricClassifier {
  override async classify(event: NormalizedSourceEvent) {
    const result = await super.classify(event);
    if (!event.content.includes('补充')) return result;
    return {
      ...result,
      outcome: 'repaired' as const,
      isDataRequest: false,
      draft: null,
      messageAction: {
        action: 'update_existing' as const,
        confidence: 0.98,
        evidence: ['消息明确是已有需求的补充。'],
        reason: '保留核心消息动作，等待关联阶段恢复。',
      },
      threadAssociation: null,
      candidateMerge: null,
      usedFallback: false,
      deferred: { kind: 'association' as const, code: 'association_unavailable' as const, retryable: true as const },
      metadata: {
        ...(result.metadata ?? {}),
        validationIssues: [
          { path: 'thread_association', code: 'provider_http_503' },
          { path: 'candidate_merge', code: 'provider_http_503' },
          { path: 'association', code: 'association_unavailable' },
        ],
      },
    };
  }
}

class LiveAssociationTerminalWithoutMetadataClassifier extends LiveThreadCentricClassifier {
  calls = 0;

  override async classify(event: NormalizedSourceEvent) {
    this.calls += 1;
    const result = await super.classify(event);
    if (!event.content.includes('补充')) return result;
    return {
      ...result,
      outcome: 'repaired' as const,
      isDataRequest: false,
      draft: null,
      messageAction: {
        action: 'update_existing' as const,
        confidence: 0.98,
        evidence: ['消息明确是已有需求的补充。'],
        reason: '保留核心消息动作，等待关联阶段恢复。',
      },
      threadAssociation: null,
      candidateMerge: null,
      usedFallback: false,
      deferred: { kind: 'association' as const, code: 'association_unavailable' as const, retryable: false as const },
      metadata: undefined,
    };
  }
}

type LiveDialogueDecision = {
  action: MessageAction;
  targetThreadIndex?: number | null;
  pendingCandidateIndex?: number | null;
  associationScores?: number[];
  mergeScores?: number[];
  actionConfidence?: number;
  updateConfidence?: number | null;
  timeRange?: NonNullable<ClassificationResult['semanticAnalysis']>['timeRange'];
  statusSuggestion?: NonNullable<ClassificationResult['semanticAnalysis']>['statusSuggestion'];
  nextStepSuggestion?: string | null;
  waitingReasonSuggestion?: string | null;
  narrativeUpdates?: NonNullable<ClassificationResult['semanticAnalysis']>['narrativeUpdates'];
  reason?: string;
  badAssociationHash?: boolean;
  badMergeHash?: boolean;
  ownerIntents?: OwnerIntentDecision[];
  draftTitle?: string;
  draftBackground?: string;
  draftValidationQuestion?: string;
  draftDescribe?: string;
};

/** Live-shaped scripted model for full dialogue replays. The service still
 * validates every anonymous candidate, score, hash and version. */
class LiveDialogueClassifier implements ClassifierAdapter {
  readonly kind = 'live' as const;
  readonly provider = 'test-live-dialogue-provider';
  readonly model = 'test-live-dialogue-model';
  readonly promptVersion = 'test-live-dialogue-v1';

  constructor(private readonly decide: (event: NormalizedSourceEvent) => LiveDialogueDecision) {}

  async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    const decision = this.decide(event);
    const confidence = decision.actionConfidence ?? 0.99;
    const isNew = decision.action === 'new_demand';
    const draft = isNew ? draftFor(event) : null;
    if (draft) {
      if (decision.draftTitle) draft.title = decision.draftTitle;
      if (decision.draftBackground) draft.background = decision.draftBackground;
      if (decision.draftValidationQuestion) draft.validationQuestion = decision.draftValidationQuestion;
      if (decision.draftDescribe) draft.describe = decision.draftDescribe;
    }
    const semanticAnalysis: NonNullable<ClassificationResult['semanticAnalysis']> | null = isNew
      ? draft?.analysis ?? null
      : {
          timeRange: decision.timeRange ?? {
            status: 'unknown', sourceText: null, startAt: null, endAt: null,
            timezone: 'Asia/Shanghai', needsConfirmation: true,
          },
          fieldBasis: { background: 'unknown', validationQuestion: 'unknown', describe: 'fact' },
          recognitionEvidence: [decision.reason ?? '连续对话语义判断。'],
          ownerAction: null,
          ownerIntent: null,
          prioritySuggestion: null,
          note: null,
          statusSuggestion: decision.statusSuggestion ?? null,
          nextStepSuggestion: decision.nextStepSuggestion ?? null,
          waitingReasonSuggestion: decision.waitingReasonSuggestion ?? null,
          updateConfidence: decision.updateConfidence ?? confidence,
          narrativeUpdates: decision.narrativeUpdates ?? {},
          threadAssociation: null,
          candidateMerge: null,
        };
    const result: ClassificationResult = {
      outcome: 'valid',
      isDataRequest: isNew,
      draft,
      messageAction: {
        action: decision.action,
        confidence,
        evidence: [decision.reason ?? '模型识别当前消息动作。'],
        reason: decision.reason ?? '模型识别当前消息动作。',
      },
      semanticAnalysis,
      reason: decision.reason ?? '模型识别当前消息动作。',
      relatedTaskHint: null,
      ownerIntent: null,
      ownerIntents: [],
      threadAssociation: null,
      candidateMerge: null,
      importantDates: [],
      deliverables: [],
      commitments: [],
      usedFallback: false,
      metadata: { structuredMode: 'json_schema', fallbackMode: 'llm', inputCharCount: event.content.length, attempts: 1 },
    };
    if (decision.ownerIntents?.length) {
      result.ownerIntents = decision.ownerIntents;
      result.ownerIntent = decision.ownerIntents[0] ?? null;
      result.messageAction = {
        ...result.messageAction!,
        action: decision.ownerIntents.some((intent) => intent.action === 'decline' || intent.action === 'delegate')
          ? 'decline_or_delegate'
          : 'owner_action',
      };
    }
    const threadContext = event.classificationContext;
    if (threadContext) {
      const scores = threadContext.candidates.map((candidate, index) => ({
        threadId: candidate.threadId,
        taskId: candidate.taskId,
        confidence: decision.associationScores?.[index] ?? (index === decision.targetThreadIndex ? 0.98 : 0.2),
      }));
      const target = decision.targetThreadIndex === null || decision.targetThreadIndex === undefined
        ? null
        : threadContext.candidates[decision.targetThreadIndex] ?? null;
      result.threadAssociation = {
        targetThreadId: target?.threadId ?? null,
        targetTaskId: target?.taskId ?? null,
        confidence: target ? scores[decision.targetThreadIndex!]?.confidence ?? 0.98 : null,
        scores,
        reason: target ? '模型选择唯一现有需求线程。' : '模型无法唯一选择现有需求线程。',
        evidence: ['对话语义与候选线程内容一致。'],
        candidateSetHash: decision.badAssociationHash ? 'bad-hash' : threadContext.candidateSetHash,
        candidateSetComplete: threadContext.candidateSetComplete,
      };
    }
    const mergeContext = event.candidateMergeContext;
    if (mergeContext) {
      const scores = mergeContext.candidates.map((candidate, index) => ({
        candidateId: candidate.candidateId,
        threadId: candidate.threadId,
        confidence: decision.mergeScores?.[index] ?? (index === decision.pendingCandidateIndex ? 0.98 : 0.2),
      }));
      const target = decision.pendingCandidateIndex === null || decision.pendingCandidateIndex === undefined
        ? null
        : mergeContext.candidates[decision.pendingCandidateIndex] ?? null;
      result.candidateMerge = {
        targetCandidateId: target?.candidateId ?? null,
        targetThreadId: target?.threadId ?? null,
        sameRequirement: Boolean(target),
        confidence: target ? scores[decision.pendingCandidateIndex!]?.confidence ?? 0.98 : null,
        scores,
        primary: target ? 'target' : null,
        primaryConfidence: target ? 0.98 : null,
        currentRole: target ? 'process_question' : null,
        targetRole: target ? 'owner_delivery' : null,
        reason: target ? '当前消息是该待确认需求的连续补充。' : '模型无法唯一判断待确认候选归属。',
        evidence: target ? ['同一会话继续讨论同一交付目标。'] : ['候选之间证据不足。'],
        candidateSetHash: decision.badMergeHash ? 'bad-merge-hash' : mergeContext.candidateSetHash,
        candidateSetComplete: mergeContext.candidateSetComplete,
      };
    }
    if (result.semanticAnalysis) {
      result.semanticAnalysis.threadAssociation = result.threadAssociation;
      result.semanticAnalysis.candidateMerge = result.candidateMerge;
    }
    return result;
  }

  async testConnection() {
    return { ok: true, status: 'mock' as const, message: 'test', checkedAt: new Date().toISOString() };
  }
}

class CountingClassifier extends ScriptedClassifier {
  readonly inputs: NormalizedSourceEvent[] = [];

  override async classify(event: NormalizedSourceEvent, guidance?: string): Promise<ClassificationResult> {
    this.inputs.push(event);
    return super.classify(event, guidance);
  }
}

class SemanticAssociationClassifier extends ScriptedClassifier {
  readonly inputs: NormalizedSourceEvent[] = [];

  constructor(
    private readonly select: (event: NormalizedSourceEvent) => {
      targetIndex: number | null;
      scores?: number[];
      candidateSetHash?: string;
      candidateSetComplete?: boolean;
      unknownTarget?: boolean;
    },
  ) {
    super();
  }

  override async classify(event: NormalizedSourceEvent, guidance?: string): Promise<ClassificationResult> {
    this.inputs.push(event);
    const result = await super.classify(event, guidance);
    const context = event.classificationContext;
    if (!context?.candidates.length) return result;
    const selection = this.select(event);
    const scores = context.candidates.map((candidate, index) => ({
      threadId: candidate.threadId,
      taskId: candidate.taskId,
      confidence: selection.scores?.[index] ?? (index === selection.targetIndex ? 0.98 : 0.7),
    }));
    const target = selection.unknownTarget
      ? { threadId: 'thread-unknown', taskId: 'task-unknown' }
      : selection.targetIndex === null ? null : context.candidates[selection.targetIndex] ?? null;
    result.threadAssociation = {
      targetThreadId: target?.threadId ?? null,
      targetTaskId: target?.taskId ?? null,
      confidence: target
        ? (selection.unknownTarget ? 0.99 : scores[selection.targetIndex!]?.confidence ?? 0.98)
        : null,
      scores,
      reason: target ? '模型认为该消息唯一延续目标需求。' : '模型无法唯一判断需求归属。',
      evidence: ['同一会话与任务主题一致。'],
      candidateSetHash: selection.candidateSetHash ?? context.candidateSetHash,
      candidateSetComplete: selection.candidateSetComplete ?? context.candidateSetComplete,
    };
    if (result.draft?.analysis) result.draft.analysis.threadAssociation = result.threadAssociation;
    return result;
  }
}

class PendingCandidateMergeClassifier extends ScriptedClassifier {
  readonly inputs: NormalizedSourceEvent[] = [];

  constructor(
    private readonly decide: (event: NormalizedSourceEvent) => {
      sameRequirement: boolean;
      targetIndex?: number;
      scores?: number[];
      confidence?: number;
      primary?: 'current' | 'target';
      primaryConfidence?: number;
      currentRole?: 'owner_delivery' | 'background' | 'constraint' | 'process_question' | 'unknown';
      targetRole?: 'owner_delivery' | 'background' | 'constraint' | 'process_question' | 'unknown';
      fallback?: boolean;
      badHash?: boolean;
    },
  ) {
    super();
  }

  override async classify(event: NormalizedSourceEvent, guidance?: string): Promise<ClassificationResult> {
    this.inputs.push(event);
    const result = await super.classify(event, guidance);
    if (result.draft) {
      if (event.content.includes('众筹箱')) {
        result.draft.title = '众筹箱功能提交次数分析';
        result.draft.background = '需要掌握众筹箱功能在近几个版本的提交规模。';
        result.draft.validationQuestion = '近 3 至 4 个版本每周提交次数如何变化？';
        result.draft.describe = '统计众筹箱功能近 3 至 4 个版本的周提交次数并输出结论。';
        result.draft.confidence = 0.98;
        if (result.draft.analysis) result.draft.analysis.ownerAction = {
          required: true,
          summary: '统计众筹箱功能近 3 至 4 个版本的周提交次数并输出结论。',
          role: 'analyze',
          basis: 'fact',
          confidence: 0.99,
        };
      } else if (event.content.includes('924')) {
        result.draft.title = '924版本看板与埋点需求流程咨询';
        result.draft.background = '需要了解 924 版本看板与埋点需求如何接入。';
        result.draft.validationQuestion = '看板与埋点需求应该走什么流程？';
        result.draft.describe = '咨询 924 版本看板与埋点的提需流程。';
        result.draft.confidence = 0.95;
        if (result.draft.analysis) result.draft.analysis.ownerAction = {
          required: false,
          summary: '',
          role: 'unknown',
          basis: 'unknown',
          confidence: 0,
        };
      }
    }
    const context = event.candidateMergeContext;
    if (!context?.candidates.length) return result;
    const decision = this.decide(event);
    result.usedFallback = Boolean(decision.fallback);
    if (decision.fallback) return result;
    const targetIndex = decision.targetIndex ?? 0;
    const target = decision.sameRequirement ? context.candidates[targetIndex] ?? null : null;
    const confidence = decision.confidence ?? 0.98;
    result.candidateMerge = {
      targetCandidateId: target?.candidateId ?? null,
      targetThreadId: target?.threadId ?? null,
      sameRequirement: decision.sameRequirement,
      confidence: target ? confidence : null,
      scores: context.candidates.map((candidate, index) => ({
        candidateId: candidate.candidateId,
        threadId: candidate.threadId,
        confidence: decision.scores?.[index] ?? (index === targetIndex && decision.sameRequirement ? confidence : 0.25),
      })),
      primary: target ? decision.primary ?? 'current' : null,
      primaryConfidence: target ? decision.primaryConfidence ?? 0.98 : null,
      currentRole: target ? decision.currentRole ?? 'owner_delivery' : null,
      targetRole: target ? decision.targetRole ?? 'process_question' : null,
      reason: target ? '流程咨询服务于同一个具体分析交付，分析任务应作为主人主体。' : '两条消息要求不同交付，不能归并。',
      evidence: target ? ['共同讨论同一功能和版本需求。', '当前消息明确要求主人完成数据分析。'] : ['交付对象和目标不同。'],
      candidateSetHash: decision.badHash ? 'stale-candidate-set' : context.candidateSetHash,
      candidateSetComplete: context.candidateSetComplete,
    };
    if (result.draft?.analysis) result.draft.analysis.candidateMerge = result.candidateMerge;
    return result;
  }
}

type Harness = {
  root: string;
  database: AppDatabase;
  service: PmService;
  app: Awaited<ReturnType<typeof buildApp>>;
  adapters: ReturnType<typeof createAdapters>;
};

const harnesses: Harness[] = [];

async function makeHarness(options: {
  memoryRoot?: string;
  workspace?: ReturnType<typeof createAdapters>['workspace'];
  classifier?: ClassifierAdapter;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ai-pm-runtime-'));
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const memoryRoot = options.memoryRoot ?? join(root, 'memory');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    TASK_MEMORY_ROOT: memoryRoot,
    WORKSPACE_READ_ENABLED: 'true',
    WORKSPACE_ALLOWED_PATHS: JSON.stringify([workspaceRoot]),
  });
  const adapters = createAdapters(config);
  adapters.classifier = options.classifier ?? new ScriptedClassifier();
  if (options.workspace) adapters.workspace = options.workspace;
  const database = new AppDatabase(':memory:', false);
  const service = new PmService(database, adapters, config);
  const app = await buildApp(service, { serveWeb: false });
  const harness = { root, database, service, app, adapters };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length) {
    const harness = harnesses.pop()!;
    await harness.app.close();
    harness.database.close();
    rmSync(harness.root, { recursive: true, force: true });
  }
}, 30_000);

function source(externalId: string, content: string, metadata: Record<string, unknown> = {}, occurredAt = baseTime): NormalizedSourceEvent {
  return {
    externalId,
    sourceType: 'owner_dm',
    conversationId: 'conversation-1',
    senderId: 'sender-1',
    senderName: '测试需求方',
    content,
    occurredAt,
    metadata,
  };
}

const REPLAY_OWNER_ID = 'replay-owner-open';
const REPLAY_REQUESTER_ID = 'replay-requester-open';

function seedReplayOwner(database: AppDatabase) {
  const timestamp = '2026-08-01T00:00:00.000Z';
  database.raw.prepare(
    `INSERT OR IGNORE INTO owner_profile
      (id, open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json, last_synced_at, created_at, updated_at)
     VALUES ('primary', ?, ?, ?, '回放主人', 'replay-tenant', 'authorized', '[]', ?, ?, ?)`,
  ).run(REPLAY_OWNER_ID, 'replay-owner-union', 'replay-owner-user', timestamp, timestamp, timestamp);
}

function replayMessage(
  externalId: string,
  content: string,
  sender: 'owner' | 'requester',
  occurredAt: string,
  metadata: Record<string, unknown> = {},
): NormalizedSourceEvent {
  const owner = sender === 'owner';
  return {
    externalId,
    sourceType: 'owner_dm',
    conversationId: 'replay-conversation',
    senderId: owner ? REPLAY_OWNER_ID : REPLAY_REQUESTER_ID,
    senderName: owner ? '回放主人' : '回放需求方',
    content,
    occurredAt,
    metadata: {
      senderRole: sender,
      isOwnerMessage: owner,
      contextOnly: owner,
      ...(owner ? { matchedOwnerOpenId: REPLAY_OWNER_ID } : {}),
      ...metadata,
    },
  };
}

async function makeReplayHarness(classifier: ClassifierAdapter) {
  const harness = await makeHarness({ classifier });
  seedReplayOwner(harness.database);
  return harness;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function candidateLinkedUpdateClassifier() {
  return new ScenarioClassifier((draft) => {
    if (!draft.analysis) return;
    draft.analysis.statusSuggestion = 'in_progress';
    draft.analysis.nextStepSuggestion = '先核验候选修订恢复链';
    draft.analysis.updateConfidence = 0.99;
  });
}

async function addCandidateLinkedAutoUpdate(harness: Harness, name: string, content = '请分析活动A的留存数据。') {
  const first = await harness.service.ingestSource(source(`${name}-first`, content));
  const task = harness.service.actOnCandidate(first.candidate!.id, 'accept', undefined, harness.service.getCandidate(first.candidate!.id)!.version).task!;
  const result = await harness.service.reprocessCandidate(first.candidate!.id, '补充候选内容并同步正式任务。', undefined, harness.service.getCandidate(first.candidate!.id)!.version);
  const proposalId = (result.proposal as { id: string } | null)?.id;
  if (!proposalId) throw new Error('测试夹具未生成 candidate-linked 自动更新提案。');
  const proposal = harness.database.raw.prepare(
    `SELECT id, thread_id, candidate_revision_id, before_snapshot_json, after_snapshot_json, decision_mode
     FROM task_update_proposal WHERE id = ?`,
  ).get(proposalId) as {
    id: string;
    thread_id: string;
    candidate_revision_id: string;
    before_snapshot_json: string;
    after_snapshot_json: string;
    decision_mode: string;
  };
  if (proposal.decision_mode !== 'auto' || !proposal.candidate_revision_id) {
    throw new Error('测试夹具未自动应用 candidate-linked 更新。');
  }
  return { candidateId: first.candidate!.id, task, proposal };
}

describe('Issue #9 受控 Runtime、需求线程和任务记忆后端闭环', () => {
  it('Runtime 持久化幂等、checkpoint、租约恢复、退避和取消终态', () => {
    const database = new AppDatabase(':memory:', false);
    const runtime = new PmRuntime(database);
    const first = runtime.begin({ jobType: 'test', payload: { source: 'src-1' }, idempotencyKey: 'same-job' });
    expect(first.acquired).toBe(true);
    expect(first.attempts).toBe(1);
    runtime.checkpoint(first.id, 'captured', { context: 'snapshot' }, first.lease_owner!);
    const duplicate = new PmRuntime(database).begin({ jobType: 'test', payload: { source: 'src-1' }, idempotencyKey: 'same-job' });
    expect(duplicate.acquired).toBe(false);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM job WHERE idempotency_key = ?').get('same-job')).toEqual({ count: 1 });

    runtime.fail(first.id, new Error('temporary'), { retryable: true, leaseOwner: first.lease_owner! });
    database.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), first.id);
    const resumed = new PmRuntime(database).begin({ jobType: 'test', idempotencyKey: 'same-job' });
    expect(resumed.acquired).toBe(true);
    expect(resumed.attempts).toBe(2);
    runtime.complete(resumed.id, { ok: true }, resumed.lease_owner!);
    expect(runtime.get(resumed.id)?.status).toBe('completed');
    runtime.cancel(resumed.id);
    expect(runtime.get(resumed.id)?.status).toBe('completed');
    expect(runtime.complete(resumed.id, { overwritten: true }, resumed.lease_owner!)?.status).toBe('completed');
    expect(runtime.latestCheckpoint(resumed.id)).toMatchObject({ step: 'captured' });
    expect(runtime.authorizeTool(null, 'shell.execute', { command: 'dir' }).allowed).toBe(false);
    expect(runtime.authorizeTool(null, 'source.read', { sourceId: 'src-1' }).allowed).toBe(true);
    database.close();
  });

  it('Tool Registry 会执行重试、超时、审批和脱敏审计，不保存工具原始输入', async () => {
    const database = new AppDatabase(':memory:', false);
    const runtime = new PmRuntime(database);
    let attempts = 0;
    const result = await runtime.executeTool({
      jobId: null,
      toolName: 'source.read',
      toolInput: { sourceId: 'source-private', token: 'must-not-be-stored' },
      run: async (attempt) => {
        attempts = attempt;
        if (attempt < 3) throw Object.assign(new Error('temporary read failure'), { code: 'ECONNRESET' });
        return { count: 2 };
      },
      auditResult: (value, usedAttempts) => ({ count: value.count, attempts: usedAttempts }),
    });
    expect(result).toEqual({ count: 2 });
    expect(attempts).toBe(3);
    const completed = database.raw.prepare("SELECT * FROM runtime_tool_call WHERE tool_name = 'source.read' ORDER BY rowid DESC LIMIT 1").get() as {
      status: string;
      input_hash: string;
      result_json: string;
    };
    expect(completed.status).toBe('completed');
    expect(completed.input_hash).toMatch(/^[a-f0-9]{64}$/u);
    const controlled = runtime.authorizeTool(null, 'task.auto_apply_update', { taskId: 'task-private' });
    expect(controlled).toMatchObject({ allowed: true, definition: { policy: 'controlled_internal_write' } });
    expect(database.raw.prepare('SELECT policy, status FROM runtime_tool_call WHERE id = ?').get(controlled.callId))
      .toEqual({ policy: 'controlled_internal_write', status: 'allowed' });
    const ownerWrite = runtime.authorizeTool(null, 'task.apply_update', { taskId: 'task-private' });
    expect(ownerWrite).toMatchObject({ allowed: false, reason: 'approval_required', definition: { policy: 'approval_required' } });
    expect(JSON.parse(completed.result_json)).toEqual({ count: 2, attempts: 3 });
    expect(JSON.stringify(completed)).not.toContain('must-not-be-stored');

    expect(runtime.authorizeTool(null, 'task.apply_update', { taskId: 'task-1' }).allowed).toBe(false);
    expect(runtime.executeToolSync({
      jobId: null,
      toolName: 'task.apply_update',
      approved: true,
      run: () => 'approved',
    })).toBe('approved');
    expect(runtime.authorizeTool(null, 'shell.execute', { command: 'dir' }, true).allowed).toBe(false);

    let timeoutAttempts = 0;
    vi.useFakeTimers();
    try {
      const timeoutPromise = runtime.executeTool({
        jobId: null,
        toolName: 'source.read',
        toolInput: { sourceId: 'source-timeout' },
        run: () => {
          timeoutAttempts += 1;
          return new Promise<never>(() => undefined);
        },
      });
      const timeoutAssertion = expect(timeoutPromise).rejects.toThrow('执行超时');
      await vi.advanceTimersByTimeAsync(30_100);
      await timeoutAssertion;
    } finally {
      vi.useRealTimers();
    }
    const timedOut = database.raw.prepare("SELECT status, error FROM runtime_tool_call WHERE tool_name = 'source.read' ORDER BY rowid DESC LIMIT 1").get() as {
      status: string;
      error: string;
    };
    expect(timedOut).toMatchObject({ status: 'failed' });
    expect(timedOut.error).toContain('执行超时');
    expect(timeoutAttempts).toBe(1);
    database.close();
  });

  it('Runtime 工作项和工具审计会统一隐藏本机路径、URL 和密钥', () => {
    const database = new AppDatabase(':memory:', false);
    const runtime = new PmRuntime(database);
    const job = runtime.begin({ jobType: 'sanitize', idempotencyKey: 'sanitize', leaseOwner: 'sanitize-worker' });
    runtime.fail(
      job.id,
      new Error('读取 C:\\Users\\example-user\\secret.txt 失败，token=test-token-value，密钥 test-api-key-value'),
      { retryable: false, leaseOwner: 'sanitize-worker' },
    );
    const failedJob = runtime.get(job.id)!;
    expect(failedJob.last_error).toContain('<local-path>');
    expect(failedJob.last_error).not.toContain('Users\\example-user');
    expect(failedJob.last_error).not.toContain('test-token-value');
    expect(failedJob.last_error).not.toContain('test-api-key-value');
    expect(sanitizeRuntimeError(new Error("ENOTDIR: mkdir '/tmp/ai-pm-private/tasks/task-1/updates'"))).toBe("ENOTDIR: mkdir '<local-path>'");

    expect(() => runtime.executeToolSync({
      jobId: null,
      toolName: 'source.read',
      run: () => {
        throw new Error('请求 https://tenant.example/path 失败；api_key=top-secret-value');
      },
    })).toThrow('tenant.example');
    const toolCall = database.raw.prepare("SELECT status, error FROM runtime_tool_call WHERE tool_name = 'source.read' ORDER BY rowid DESC LIMIT 1").get() as {
      status: string;
      error: string;
    };
    expect(toolCall.status).toBe('failed');
    expect(toolCall.error).toContain('<url>');
    expect(toolCall.error).not.toContain('tenant.example');
    expect(toolCall.error).not.toContain('top-secret-value');
    database.close();
  });

  it('Runtime HTTP 视图只返回白名单摘要，不暴露 payload、checkpoint 或工具结果原文', async () => {
    const { database, app } = await makeHarness();
    const runtime = new PmRuntime(database);
    const job = runtime.begin({
      jobType: 'classify_source',
      payload: { sourceEventId: 'source-private', guidance: '主人私密补充 must-not-leak' },
      idempotencyKey: 'runtime-http-privacy',
      leaseOwner: 'privacy-worker',
    });
    runtime.checkpoint(job.id, 'captured', { content: 'checkpoint-secret must-not-leak' }, job.lease_owner!);
    const tool = runtime.authorizeTool(job.id, 'source.read', { token: 'tool-input-secret must-not-leak' }, false, undefined, job.lease_owner!);
    runtime.completeToolCall(tool.callId, { content: 'tool-result-secret must-not-leak' });
    runtime.complete(job.id, { content: 'job-result-secret must-not-leak' }, job.lease_owner!);

    const listResponse = await app.inject({ method: 'GET', url: '/api/runtime/jobs' });
    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json() as { items: Array<Record<string, unknown>> };
    const listed = listBody.items.find((item) => item.id === job.id)!;
    expect(listed).toMatchObject({ id: job.id, job_type: 'classify_source', status: 'completed' });
    expect(Object.keys(listed)).not.toEqual(expect.arrayContaining(['payload_json', 'result_json', 'payload', 'result', 'lease_owner', 'idempotency_key', 'trace_id']));
    expect(listResponse.body).not.toContain('must-not-leak');

    const detailResponse = await app.inject({ method: 'GET', url: `/api/runtime/jobs/${job.id}` });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json() as Record<string, unknown> & {
      checkpoints: Array<Record<string, unknown>>;
      toolCalls: Array<Record<string, unknown>>;
    };
    expect(detail.checkpoints).toEqual([expect.objectContaining({ step: 'captured', created_at: expect.any(String) })]);
    expect(detail.toolCalls).toEqual([expect.objectContaining({ tool_name: 'source.read', status: 'completed' })]);
    expect(Object.keys(detail.checkpoints[0]!)).not.toContain('state_json');
    expect(Object.keys(detail.toolCalls[0]!)).not.toContain('result_json');
    expect(detailResponse.body).not.toContain('must-not-leak');

    const cancellable = runtime.enqueue({
      jobType: 'classify_source',
      payload: { guidance: 'cancel-secret must-not-leak' },
      idempotencyKey: 'runtime-http-cancel',
    });
    const cancelled = await app.inject({ method: 'POST', url: `/api/runtime/jobs/${cancellable.id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: cancellable.id, status: 'cancelled' });
    expect(cancelled.body).not.toContain('must-not-leak');
    expect(cancelled.body).not.toContain('payload_json');
  });

  it('只有 job 表的残缺旧 SQLite 会 fail-closed 且不越权改写原任务', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-pm-legacy-runtime-'));
    const databasePath = join(root, 'legacy.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE job (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    legacy.prepare(
      "INSERT INTO job (id, job_type, payload_json, status, attempts, available_at, created_at, updated_at) VALUES ('legacy-job', 'legacy', '{}', 'queued', 0, ?, ?, ?)",
    ).run(baseTime, baseTime, baseTime);
    legacy.close();

    expect(() => new AppDatabase(databasePath, false)).toThrowError(expect.objectContaining({ stage: 'ledger' }));
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    expect(preserved.prepare('SELECT status, attempts FROM job WHERE id = ?').get('legacy-job'))
      .toEqual({ status: 'queued', attempts: 0 });
    preserved.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('回复链优先、明确补充才按会话关联，多线程时不自动合并', async () => {
    const { service, database } = await makeHarness();
    const first = await service.ingestSource(source('thread-first', '请分析活动A的留存数据。'));
    const reply = await service.ingestSource(source('thread-reply', '补充活动A的付费数据。', { parentId: 'thread-first' }));
    const firstThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_source WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = ?)').get('thread-first') as { thread_id: string };
    const replyThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_source WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = ?)').get('thread-reply') as { thread_id: string };
    expect(replyThread.thread_id).toBe(firstThread.thread_id);
    expect(reply.candidate).toBeTruthy();
    expect(database.raw.prepare('SELECT root_id, parent_id, source_revision FROM requirement_thread_source WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = ?)').get('thread-reply')).toMatchObject({ parent_id: 'thread-first' });

    await service.ingestSource(source('thread-second', '请分析活动B的留存数据。'));
    await service.ingestSource(source('thread-third', '请分析活动C的留存数据。'));
    const threads = database.raw.prepare('SELECT id FROM requirement_thread ORDER BY created_at ASC').all() as Array<{ id: string }>;
    expect(threads.length).toBeGreaterThanOrEqual(3);
    const ambiguous = await service.ingestSource(source('thread-ambiguous', '补充：这条消息没有指明属于哪一个已有需求，需要主人确认。'));
    const ambiguousSource = database.raw.prepare('SELECT thread_id FROM requirement_thread_source WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = ?)').get('thread-ambiguous') as { thread_id: string };
    const ambiguousThread = database.raw.prepare('SELECT status, ambiguity_json FROM requirement_thread WHERE id = ?').get(ambiguousSource.thread_id) as { status: string; ambiguity_json: string };
    expect(ambiguousThread.status).toBe('needs_confirmation');
    expect(JSON.parse(ambiguousThread.ambiguity_json)).toHaveLength(3);
  });

  it('关联阶段 deferred 时保留核心动作但不产生候选、任务、线程或业务审计写入', async () => {
    const { service, database } = await makeHarness({ classifier: new LiveAssociationDeferredClassifier() });
    const first = await service.ingestSource(source('association-deferred-first', '请分析活动A的留存数据。'));
    expect(first.candidate).toBeTruthy();
    const before = {
      candidates: (database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number }).count,
      threads: (database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread').get() as { count: number }).count,
      decisions: (database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count,
      taskEvents: (database.raw.prepare('SELECT COUNT(*) AS count FROM task_event').get() as { count: number }).count,
      notifications: (database.raw.prepare('SELECT COUNT(*) AS count FROM notification').get() as { count: number }).count,
      outbox: (database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count,
      runtimeCalls: (database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_tool_call').get() as { count: number }).count,
    };
    const deferredResult = await service.ingestSource(source(
      'association-deferred-follow-up',
      '补充活动A的付费数据。',
      { parentId: 'association-deferred-first' },
    ));
    expect(deferredResult.classificationDeferred).toBe(true);
    expect(deferredResult.candidate).toBeNull();
    expect({
      candidates: (database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get() as { count: number }).count,
      threads: (database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread').get() as { count: number }).count,
      decisions: (database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get() as { count: number }).count,
      taskEvents: (database.raw.prepare('SELECT COUNT(*) AS count FROM task_event').get() as { count: number }).count,
      notifications: (database.raw.prepare('SELECT COUNT(*) AS count FROM notification').get() as { count: number }).count,
      outbox: (database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count,
    }).toEqual({
      candidates: before.candidates,
      threads: before.threads,
      decisions: before.decisions,
      taskEvents: before.taskEvents,
      notifications: before.notifications,
      outbox: before.outbox,
    });
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_tool_call').get() as { count: number }).count)
      .toBe(before.runtimeCalls + 2);
    const deferredJob = database.raw.prepare("SELECT id, status, retryable FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1").get() as { id: string; status: string; retryable: number };
    expect(deferredJob).toMatchObject({ status: 'queued', retryable: 1 });
    const checkpoint = database.raw.prepare("SELECT state_json FROM runtime_checkpoint WHERE job_id = ? AND step = 'classification_provider_completed' ORDER BY created_at DESC LIMIT 1").get(deferredJob.id) as { state_json: string };
    expect(JSON.parse(checkpoint.state_json)).toMatchObject({ reusable: false, classification: { deferred: { code: 'association_unavailable' } } });
    database.raw.prepare(
      "UPDATE job SET status = 'queued', available_at = ?, locked_until = NULL, lease_owner = NULL WHERE id = ?",
    ).run(new Date(Date.now() - 1_000).toISOString(), deferredJob.id);
    // The deferred association path is intentionally processed without being
    // counted as a durable recovery: it preserves only the core message
    // action and must not claim candidate/task/thread/business completion.
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 0 });
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_tool_call').get() as { count: number }).count)
      .toBe(before.runtimeCalls + 3);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: before.candidates });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual({ count: before.decisions });
  });

  it('optional 关联阶段明确 non-retryable 时 Runtime 终止 job，不按 max_attempts 重复调用 provider', async () => {
    const { service, database, adapters } = await makeHarness();
    const first = await service.ingestSource(source('association-terminal-first', '请分析活动A的留存数据。'));
    expect(first.candidate).toBeTruthy();
    const config = loadConfig({
      NODE_ENV: 'test',
      LLM_PROVIDER: 'deepseek',
      LLM_MODEL: 'mock-model',
      LLM_API_BASE: 'http://synthetic.invalid/v1',
      LLM_API_KEY: 'mock-key-not-secret',
      LLM_MAX_RETRIES: '3',
    });
    let providerCalls = 0;
    const fetcher = (async (_input, init) => {
      providerCalls += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
      const system = body.messages?.[0]?.content ?? '';
      if (system.includes('需求线程关联器')) {
        return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401 });
      }
      if (system.includes('待确认候选归并器')) {
        return new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 });
      }
      const content = system.includes('消息动作路由器')
        ? { action: 'update_existing', confidence: 0.96, evidence: ['继续补充同一需求'], reason: '已有需求更新' }
        : { status_suggestion: null, next_step_suggestion: '核对新补充。', waiting_reason_suggestion: null, time_text: null, date_semantics: 'unknown', needs_confirmation: true, update_confidence: 0.96, narrative_updates: [] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    adapters.classifier = new OpenAICompatibleClassifier(config.llm, fetcher);

    const result = await service.ingestSource(source(
      'association-terminal-follow-up',
      '补充活动A的付费数据。',
      { parentId: 'association-terminal-first' },
    ));
    expect(result).toMatchObject({ classificationDeferred: true, candidate: null });
    expect(providerCalls).toBe(3);
    const job = database.raw.prepare(
      "SELECT status, attempts, max_attempts, retryable FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
    ).get() as { status: string; attempts: number; max_attempts: number; retryable: number };
    expect(job).toEqual({ status: 'failed', attempts: 1, max_attempts: 3, retryable: 0 });
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 0, recovered: 0 });
    expect(providerCalls).toBe(3);
  });

  it('optional 关联阶段缺少 metadata 仍保留明确 non-retryable，不被 Runtime 默认重试', async () => {
    const classifier = new LiveAssociationTerminalWithoutMetadataClassifier();
    const { service, database } = await makeHarness({ classifier });
    await service.ingestSource(source('association-missing-metadata-first', '请分析活动A的留存数据。'));
    const result = await service.ingestSource(source(
      'association-missing-metadata-follow-up',
      '补充活动A的付费数据。',
      { parentId: 'association-missing-metadata-first' },
    ));
    expect(result).toMatchObject({ classificationDeferred: true, candidate: null });
    expect(classifier.calls).toBe(2);
    const job = database.raw.prepare(
      "SELECT status, retryable FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
    ).get() as { status: string; retryable: number };
    expect(job).toEqual({ status: 'failed', retryable: 0 });
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 0, recovered: 0 });
    expect(classifier.calls).toBe(2);
  });

  it('恢复计数不把未取得租约的工作项算作 processed 或 recovered', async () => {
    const { service, database } = await makeHarness();
    const runtime = (service as unknown as { runtime: PmRuntime }).runtime;
    const rival = new PmRuntime(database);
    const job = runtime.begin({
      jobType: 'classify_source',
      payload: { sourceEventId: 'synthetic-claim-race' },
      idempotencyKey: 'recovery-count-claim-race',
      leaseOwner: 'initial-owner',
    });
    database.raw.prepare(
      "UPDATE job SET status = 'queued', available_at = ?, locked_until = NULL, lease_owner = NULL WHERE id = ?",
    ).run(new Date(Date.now() - 1_000).toISOString(), job.id);

    const originalClaim = runtime.claim.bind(runtime);
    const claimSpy = vi.spyOn(runtime, 'claim').mockImplementation((jobId, owner, leaseMs) => {
      expect(rival.claim(jobId, 'rival-owner', leaseMs).acquired).toBe(true);
      return originalClaim(jobId, owner, leaseMs);
    });
    try {
      await expect(service.resumeRuntimeJobs()).resolves.toEqual({ processed: 0, recovered: 0 });
      expect(runtime.get(job.id)).toMatchObject({ status: 'running', lease_owner: 'rival-owner' });
    } finally {
      claimSpy.mockRestore();
    }
  });

  it('混合到期队列只把本轮完成的工作项计为 recovered', async () => {
    const classifier = new LiveThreadCentricClassifier();
    const { service, database } = await makeHarness({ classifier });
    const runtime = (service as unknown as { runtime: PmRuntime }).runtime;
    const captured = [
      ['recovery-count-success', 'success'],
      ['recovery-count-deferred', 'deferred'],
      ['recovery-count-failed', 'failed'],
      ['recovery-count-invalid', 'invalid'],
      ['recovery-count-claim-lost', 'claim-lost'],
      ['recovery-count-cancelled', 'cancelled'],
    ] as const;
    await service.captureSourceBatch(captured.map(([externalId]) => ({
      ...source(externalId, '请分析活动A的留存数据。'),
      conversationId: `conversation-${externalId}`,
    })));

    const revisionFor = (sourceEventId: string) => (service as unknown as {
      currentSourceFailureRevision: (sourceEventIds: string[]) => string | null;
    }).currentSourceFailureRevision([sourceEventId]);
    const jobs = new Map<string, { id: string; sourceEventId: string; outcome: typeof captured[number][1] }>();
    for (const [externalId, outcome] of captured) {
      const sourceRow = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get(externalId) as { id: string };
      const sourceRevision = revisionFor(sourceRow.id);
      expect(sourceRevision).toMatch(/^[a-f0-9]{64}$/u);
      const created = runtime.begin({
        jobType: 'classify_source',
        payload: {
          sourceEventId: sourceRow.id,
          sourceEventIds: [sourceRow.id],
          sourceRevision,
          guidance: null,
        },
        idempotencyKey: `recovery-count:${outcome}`,
        sourceEventId: sourceRow.id,
        leaseMs: 600_000,
      });
      expect(created.acquired).toBe(true);
      database.raw.prepare(
        'INSERT INTO job_source_link (job_id, source_event_id, created_at) VALUES (?, ?, ?)',
      ).run(created.id, sourceRow.id, new Date().toISOString());
      database.raw.prepare(
        "UPDATE job SET status = 'queued', retryable = 1, available_at = ?, locked_until = NULL, lease_owner = NULL, result_json = NULL WHERE id = ?",
      ).run(new Date(Date.now() - 1_000).toISOString(), created.id);
      jobs.set(outcome, { id: created.id, sourceEventId: sourceRow.id, outcome });
    }

    // An unknown/partial relation is terminal and must not be treated as a
    // retryable recovery merely because the job itself was due.
    database.raw.prepare('UPDATE job SET payload_json = ? WHERE id = ?').run(
      JSON.stringify({ sourceEventId: jobs.get('invalid')!.sourceEventId }),
      jobs.get('invalid')!.id,
    );

    const beforeBusiness = {
      candidates: database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get(),
      revisions: database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_revision').get(),
      decisions: database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get(),
      threads: database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread').get(),
      threadSources: database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread_source').get(),
      proposals: database.raw.prepare('SELECT COUNT(*) AS count FROM task_update_proposal').get(),
      taskEvents: database.raw.prepare('SELECT COUNT(*) AS count FROM task_event').get(),
      notifications: database.raw.prepare('SELECT COUNT(*) AS count FROM notification').get(),
      outbox: database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get(),
    };
    expect(beforeBusiness).toEqual({
      candidates: { count: 0 },
      revisions: { count: 0 },
      decisions: { count: 0 },
      threads: { count: 0 },
      threadSources: { count: 0 },
      proposals: { count: 0 },
      taskEvents: { count: 0 },
      notifications: { count: 0 },
      outbox: { count: 0 },
    });

    const internal = vi.spyOn(service as unknown as {
      classifyCapturedSourceInternal: (...args: unknown[]) => Promise<unknown>;
    }, 'classifyCapturedSourceInternal').mockImplementation(async (...args) => {
      const jobId = args[4] as string;
      const outcome = [...jobs.values()].find((job) => job.id === jobId)!.outcome;
      const job = [...jobs.values()].find((item) => item.id === jobId)!;
      if (outcome === 'failed') throw new Error('synthetic recovery failure');
      if (outcome === 'deferred') {
        return {
          deduplicated: true,
          sourceEventId: job.sourceEventId,
          sourceEventIds: [job.sourceEventId],
          sourceRevision: revisionFor(job.sourceEventId),
          candidate: null,
          classificationDeferred: true,
          recoveryReason: 'synthetic retry waiting',
          errorCode: 'SYNTHETIC_DEFERRED',
        };
      }
      return {
        deduplicated: true,
        sourceEventId: job.sourceEventId,
        sourceEventIds: [job.sourceEventId],
        sourceRevision: revisionFor(job.sourceEventId),
        candidate: null,
        classificationDeferred: false,
      };
    });

    const claimLost = jobs.get('claim-lost')!;
    const cancelled = jobs.get('cancelled')!;
    const rival = new PmRuntime(database);
    const originalClaim = runtime.claim.bind(runtime);
    const claimSpy = vi.spyOn(runtime, 'claim').mockImplementation((jobId, owner, leaseMs) => {
      if (jobId === claimLost.id) {
        expect(rival.claim(jobId, 'rival-recovery-owner', leaseMs).acquired).toBe(true);
      }
      if (jobId === cancelled.id) {
        database.raw.prepare(
          "UPDATE job SET status = 'cancelled', cancel_requested_at = ?, locked_until = NULL, lease_owner = NULL WHERE id = ?",
        ).run(new Date().toISOString(), jobId);
      }
      return originalClaim(jobId, owner, leaseMs);
    });

    try {
      await expect(service.resumeRuntimeJobs()).resolves.toEqual({ processed: 4, recovered: 1 });
      expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(jobs.get('success')!.id)).toEqual({ status: 'completed' });
      expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(jobs.get('deferred')!.id)).toEqual({ status: 'queued' });
      expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(jobs.get('failed')!.id)).toEqual({ status: 'queued' });
      expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(jobs.get('invalid')!.id)).toEqual({ status: 'failed' });
      expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(claimLost.id)).toEqual({ status: 'running' });
      expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(cancelled.id)).toEqual({ status: 'cancelled' });
      expect({
        candidates: database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get(),
        revisions: database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_revision').get(),
        decisions: database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get(),
        threads: database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread').get(),
        threadSources: database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread_source').get(),
        proposals: database.raw.prepare('SELECT COUNT(*) AS count FROM task_update_proposal').get(),
        taskEvents: database.raw.prepare('SELECT COUNT(*) AS count FROM task_event').get(),
        notifications: database.raw.prepare('SELECT COUNT(*) AS count FROM notification').get(),
        outbox: database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get(),
      }).toEqual(beforeBusiness);
    } finally {
      claimSpy.mockRestore();
      internal.mockRestore();
    }
  });

  it('主人可以把歧义来源归入已有任务，也可以保留为新的独立需求', async () => {
    const { service, database, app } = await makeHarness();
    const first = await service.ingestSource(source('association-first', '请分析活动A的留存数据。'));
    const firstAccepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const firstTask = firstAccepted.task!;
    const second = await service.ingestSource(source('association-second', '请分析活动B的留存数据。'));
    const secondAccepted = service.actOnCandidate(second.candidate!.id, 'accept', undefined, service.getCandidate(second.candidate!.id)!.version);
    const secondTask = secondAccepted.task!;
    expect(secondTask.id).not.toBe(firstTask.id);

    const ambiguous = await service.ingestSource(source('association-existing', '补充：这条来源可能属于前面任一需求，请主人确认。'));
    const candidateView = service.listCandidates().find((item) => item.id === ambiguous.candidate!.id)!;
    expect(candidateView.thread_association).not.toBeNull();
    expect(candidateView.thread_association).toMatchObject({ requiresConfirmation: true });
    expect(candidateView.thread_association!.options).toHaveLength(2);
    expect(() => service.actOnCandidate(ambiguous.candidate!.id, 'accept', undefined, service.getCandidate(ambiguous.candidate!.id)!.version)).toThrow('请先确认');
    const firstThreadId = firstTask.thread_id!;
    const provisionalThreadId = candidateView.thread_association!.threadId;
    const provisionalThreadVersion = candidateView.thread_association!.threadVersion;
    const firstTargetThreadVersion = candidateView.thread_association!.options.find((option) => option.id === firstThreadId)!.version;
    const invalidSelection = await app.inject({
      method: 'POST',
      url: `/api/candidates/${ambiguous.candidate!.id}/thread-association`,
      payload: {
        targetThreadId: 'thread-not-in-options',
        expectedVersion: ambiguous.candidate!.version,
        expectedThreadVersion: provisionalThreadVersion,
        expectedTargetThreadVersion: 1,
      },
    });
    expect(invalidSelection.statusCode).toBe(409);
    expect(service.getCandidate(ambiguous.candidate!.id)).toMatchObject({ state: 'pending', accepted_task_id: null });
    expect(database.raw.prepare('SELECT status FROM requirement_thread WHERE id = ?').get(provisionalThreadId)).toEqual({ status: 'needs_confirmation' });
    const linked = await app.inject({
      method: 'POST',
      url: `/api/candidates/${ambiguous.candidate!.id}/thread-association`,
      payload: {
        targetThreadId: firstThreadId,
        expectedVersion: ambiguous.candidate!.version,
        expectedThreadVersion: provisionalThreadVersion,
        expectedTargetThreadVersion: firstTargetThreadVersion,
      },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ task: { id: firstTask.id }, proposal: { state: 'awaiting_approval' }, threadId: firstThreadId });
    expect(database.raw.prepare('SELECT candidate_revision_id FROM task_update_proposal WHERE id = ?')
      .get(linked.json().proposal.id)).toEqual({ candidate_revision_id: null });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM candidate_revision WHERE candidate_id = ? AND state = 'current'")
      .get(ambiguous.candidate!.id)).toEqual({ count: 1 });
    expect(service.getCandidate(ambiguous.candidate!.id)).toMatchObject({ state: 'accepted', accepted_task_id: firstTask.id });
    expect(database.raw.prepare('SELECT status FROM requirement_thread WHERE id = ?').get(provisionalThreadId)).toEqual({ status: 'closed' });
    expect(database.raw.prepare(
      'SELECT relation_type FROM requirement_thread_source WHERE thread_id = ? AND source_event_id = (SELECT id FROM source_event WHERE external_id = ?)',
    ).get(firstThreadId, 'association-existing')).toEqual({ relation_type: 'owner_confirmed' });
    const repeatedSelection = await app.inject({
      method: 'POST',
      url: `/api/candidates/${ambiguous.candidate!.id}/thread-association`,
      payload: {
        targetThreadId: firstThreadId,
        expectedVersion: ambiguous.candidate!.version,
        expectedThreadVersion: provisionalThreadVersion,
        expectedTargetThreadVersion: firstTargetThreadVersion,
      },
    });
    expect(repeatedSelection.statusCode).toBe(409);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM task_source_link WHERE task_id = ? AND source_event_id = (SELECT id FROM source_event WHERE external_id = ?)',
    ).get(firstTask.id, 'association-existing')).toEqual({ count: 1 });

    const independent = await service.ingestSource(source('association-new', '补充：这其实是另一项独立需求，也请主人确认。'));
    const independentView = service.listCandidates().find((item) => item.id === independent.candidate!.id)!;
    expect(independentView.thread_association).not.toBeNull();
    expect(independentView.thread_association!.requiresConfirmation).toBe(true);
    const keptNew = await app.inject({
      method: 'POST',
      url: `/api/candidates/${independent.candidate!.id}/thread-association`,
      payload: {
        targetThreadId: null,
        expectedVersion: independent.candidate!.version,
        expectedThreadVersion: independentView.thread_association!.threadVersion,
      },
    });
    expect(keptNew.statusCode).toBe(200);
    expect(keptNew.json()).toMatchObject({ task: null, proposal: null });
    const independentThreadId = keptNew.json().threadId as string;
    expect(database.raw.prepare('SELECT status, ambiguity_json FROM requirement_thread WHERE id = ?').get(independentThreadId)).toEqual({ status: 'open', ambiguity_json: '[]' });
    expect(database.raw.prepare(
      'SELECT relation_type FROM requirement_thread_source WHERE thread_id = ? AND source_event_id = (SELECT id FROM source_event WHERE external_id = ?)',
    ).get(independentThreadId, 'association-new')).toEqual({ relation_type: 'owner_confirmed_new' });
    const newlyAccepted = service.actOnCandidate(independent.candidate!.id, 'accept', undefined, service.getCandidate(independent.candidate!.id)!.version);
    expect(newlyAccepted.task!.id).not.toBe(firstTask.id);
    expect(newlyAccepted.task!.id).not.toBe(secondTask.id);
  });

  it('错误归属纠正会迁移线程关系、刷新双方任务记忆，并让后续回复进入目标线程', async () => {
    const { service, database, root } = await makeHarness();
    const sourceCandidate = await service.ingestSource({ ...source('correction-source-first', '请分析活动A的留存数据。'), conversationId: 'correction-source-conversation' });
    const sourceTask = service.actOnCandidate(sourceCandidate.candidate!.id, 'accept', undefined, service.getCandidate(sourceCandidate.candidate!.id)!.version).task!;
    const targetCandidate = await service.ingestSource({ ...source('correction-target-first', '请分析活动B的留存数据。'), conversationId: 'correction-target-conversation' });
    const targetTask = service.actOnCandidate(targetCandidate.candidate!.id, 'accept', undefined, service.getCandidate(targetCandidate.candidate!.id)!.version).task!;
    const moved = await service.ingestSource(source('correction-moved-source', '补充：活动A还要加入付费维度。', { parentId: 'correction-source-first' }));
    expect(moved.candidate?.accepted_task_id).toBe(sourceTask.id);
    const movedSourceId = (database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('correction-moved-source') as { id: string }).id;
    const sourceProjectionBefore = service.getMemoryProjection(sourceTask.id)!;
    const targetProjectionBefore = service.getMemoryProjection(targetTask.id)!;

    service.recordCorrection({
      correctionType: 'wrong_association',
      taskId: sourceTask.id,
      targetTaskId: targetTask.id,
      sourceEventId: movedSourceId,
      expectedTaskVersion: sourceTask.version,
      expectedTargetTaskVersion: targetTask.version,
      idempotencyKey: 'correction-move-source',
      note: '这条补充实际属于活动B。',
    });

    expect(database.raw.prepare(
      'SELECT relation_type FROM requirement_thread_source WHERE thread_id = ? AND source_event_id = ?',
    ).get(targetTask.thread_id!, movedSourceId)).toEqual({ relation_type: 'owner_corrected' });
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM requirement_thread_source WHERE thread_id = ? AND source_event_id = ?',
    ).get(sourceTask.thread_id!, movedSourceId)).toEqual({ count: 0 });
    expect(database.raw.prepare(
      'SELECT task_id FROM task_source_link WHERE source_event_id = ?',
    ).all(movedSourceId)).toEqual([{ task_id: targetTask.id }]);
    const metadata = JSON.parse((database.raw.prepare('SELECT metadata_json FROM source_event WHERE id = ?').get(movedSourceId) as { metadata_json: string }).metadata_json) as Record<string, unknown>;
    expect(metadata.internalRequirementThreadId).toBe(targetTask.thread_id);
    expect(service.getMemoryProjection(sourceTask.id)!.checksum).not.toBe(sourceProjectionBefore.checksum);
    expect(service.getMemoryProjection(targetTask.id)!.checksum).not.toBe(targetProjectionBefore.checksum);
    const sourceTaskJson = JSON.parse(readFileSync(join(root, 'memory', service.getMemoryProjection(sourceTask.id)!.relative_path, 'task.json'), 'utf8')) as { sourceIds: string[] };
    const targetTaskJson = JSON.parse(readFileSync(join(root, 'memory', service.getMemoryProjection(targetTask.id)!.relative_path, 'task.json'), 'utf8')) as { sourceIds: string[] };
    expect(sourceTaskJson.sourceIds).not.toContain('correction-moved-source');
    expect(targetTaskJson.sourceIds).toContain('correction-moved-source');

    const continued = await service.ingestSource(source('correction-following-reply', '继续补充：还要看地区维度。', { parentId: 'correction-moved-source' }));
    expect(continued.candidate?.accepted_task_id).toBe(targetTask.id);
    expect(database.raw.prepare(
      'SELECT thread_id FROM requirement_thread_source WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = ?)',
    ).get('correction-following-reply')).toEqual({ thread_id: targetTask.thread_id });
  });

  it('群内参与人重叠只形成候选证据，没有结构化语义结果时不会自动关联', async () => {
    const classifier = new SemanticAssociationClassifier((event) => ({
      targetIndex: event.content.includes('匹配第一')
        ? event.classificationContext!.candidates.findIndex((candidate) => candidate.taskTitle === '活动A留存分析')
        : null,
    }));
    const { service, database } = await makeHarness({ classifier });
    await service.ingestSource({
      ...source('participant-first', '请分析活动A的留存数据。', { participantIds: ['owner-1', 'shared-person'] }),
      sourceType: 'group',
      conversationId: 'participant-conversation',
      senderId: 'sender-a',
      senderName: '提出人 A',
    });
    await service.ingestSource({
      ...source('participant-follow-up', '补充：还需要加入付费维度。', { participantIds: ['owner-1', 'shared-person'] }),
      sourceType: 'group',
      conversationId: 'participant-conversation',
      senderId: 'sender-b',
      senderName: '提出人 B',
    });
    const participantRows = database.raw.prepare(
      `SELECT source_event.external_id, requirement_thread_source.thread_id, requirement_thread_source.relation_type
       FROM requirement_thread_source JOIN source_event ON source_event.id = requirement_thread_source.source_event_id
       WHERE source_event.external_id IN ('participant-first','participant-follow-up') ORDER BY source_event.external_id`,
    ).all() as Array<{ external_id: string; thread_id: string; relation_type: string }>;
    expect(new Set(participantRows.map((row) => row.thread_id))).toHaveLength(2);
    expect(participantRows.find((row) => row.external_id === 'participant-follow-up')?.relation_type).toBe('primary');
    const participantFollowUpThread = participantRows.find((row) => row.external_id === 'participant-follow-up')!.thread_id;
    expect(JSON.parse((database.raw.prepare('SELECT ambiguity_json FROM requirement_thread WHERE id = ?').get(participantFollowUpThread) as { ambiguity_json: string }).ambiguity_json)).toHaveLength(1);

    const hintFirst = await service.ingestSource({ ...source('hint-first', '请分析活动A的留存数据。'), conversationId: 'hint-conversation' });
    const firstTask = service.actOnCandidate(hintFirst.candidate!.id, 'accept', undefined, service.getCandidate(hintFirst.candidate!.id)!.version).task!;
    const hintSecond = await service.ingestSource({ ...source('hint-second', '请分析活动B的留存数据。'), conversationId: 'hint-conversation' });
    service.actOnCandidate(hintSecond.candidate!.id, 'accept', undefined, service.getCandidate(hintSecond.candidate!.id)!.version);
    await service.ingestSource({ ...source('hint-follow-up', '匹配第一：这一条属于活动A。'), conversationId: 'hint-conversation' });
    const hintRows = database.raw.prepare(
      `SELECT source_event.external_id, requirement_thread_source.thread_id, requirement_thread_source.relation_type
       FROM requirement_thread_source JOIN source_event ON source_event.id = requirement_thread_source.source_event_id
       WHERE source_event.external_id IN ('hint-first','hint-second','hint-follow-up')`,
    ).all() as Array<{ external_id: string; thread_id: string; relation_type: string }>;
    const firstThread = hintRows.find((row) => row.external_id === 'hint-first')!.thread_id;
    const secondThread = hintRows.find((row) => row.external_id === 'hint-second')!.thread_id;
    const hinted = hintRows.find((row) => row.external_id === 'hint-follow-up')!;
    expect(firstThread).not.toBe(secondThread);
    expect(firstThread).toBe(firstTask.thread_id);
    expect(hinted).toMatchObject({ thread_id: firstThread, relation_type: 'semantic_unique' });
  });

  it.each([
    { name: '分差不足', select: () => ({ targetIndex: 0, scores: [0.98, 0.9] }) },
    { name: '未知候选', select: () => ({ targetIndex: 0, scores: [0.99, 0.4], unknownTarget: true }) },
  ])('语义归属返回$name时只建立待确认关系，不自动并入现有任务', async ({ name, select }) => {
    const classifier = new SemanticAssociationClassifier((event) => event.externalId.endsWith('-follow-up')
      ? select()
      : { targetIndex: null });
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource({ ...source(`semantic-${name}-first`, '请分析活动A的留存数据。'), conversationId: 'semantic-safety-conversation' });
    const firstTask = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const second = await service.ingestSource({ ...source(`semantic-${name}-second`, '请分析活动B的留存数据。'), conversationId: 'semantic-safety-conversation' });
    const secondTask = service.actOnCandidate(second.candidate!.id, 'accept', undefined, service.getCandidate(second.candidate!.id)!.version).task!;

    const followUp = await service.ingestSource({
      ...source(`semantic-${name}-follow-up`, '补充：这条更新可能属于前面任一活动分析。'),
      conversationId: 'semantic-safety-conversation',
    });
    expect(followUp.candidate?.accepted_task_id).toBeNull();
    const association = service.listCandidates().find((item) => item.id === followUp.candidate!.id)!.thread_association!;
    expect(association.requiresConfirmation).toBe(true);
    expect(new Set(association.options.map((option: { activeTaskId: string | null }) => option.activeTaskId))).toEqual(new Set([firstTask.id, secondTask.id]));
    const row = database.raw.prepare(
      'SELECT relation_type FROM requirement_thread_source WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = ?)',
    ).get(`semantic-${name}-follow-up`) as { relation_type: string };
    expect(row.relation_type).toBe('primary');
  });

  it('候选超过 6 项时模型只收到前 6 项且不能自动归属', async () => {
    const classifier = new SemanticAssociationClassifier((event) => event.externalId.endsWith('-follow-up')
      ? { targetIndex: 0, scores: [0.99, 0.4, 0.3, 0.2, 0.1, 0.05] }
      : { targetIndex: null });
    const { service, database } = await makeHarness({ classifier });
    for (let index = 0; index < 7; index += 1) {
      const created = await service.ingestSource({
        ...source(`semantic-truncated-${index}`, `请分析活动${index + 1}的留存数据。`, { participantIds: ['shared-person'] }),
        conversationId: `semantic-truncated-conversation-${index}`,
      });
      service.actOnCandidate(created.candidate!.id, 'accept', undefined, service.getCandidate(created.candidate!.id)!.version);
    }

    const followUp = await service.ingestSource({
      ...source('semantic-truncated-follow-up', '补充：请把这条更新归入之前的活动分析。', { participantIds: ['shared-person'] }),
      conversationId: 'semantic-truncated-follow-up-conversation',
    });
    const modelInput = classifier.inputs.at(-1)!;
    expect(modelInput.classificationContext).toMatchObject({ candidateSetComplete: false });
    expect(modelInput.classificationContext?.candidates).toHaveLength(6);
    expect(followUp.candidate?.accepted_task_id).toBeNull();
    expect((database.raw.prepare(
      'SELECT status, ambiguity_json FROM requirement_thread WHERE id = (SELECT thread_id FROM requirement_thread_source WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = ?))',
    ).get('semantic-truncated-follow-up') as { status: string; ambiguity_json: string })).toMatchObject({ status: 'needs_confirmation' });
  });

  it('自然补充和 root_id 能归入同一线程，乱序补扫不回拨活动时间，全部忽略后关闭空线程', async () => {
    const classifier = new PendingCandidateMergeClassifier((event) => ({
      sameRequirement: event.externalId === 'monotonic-supplement',
      targetIndex: 0,
      scores: [event.externalId === 'monotonic-supplement' ? 0.98 : 0.2],
      primary: 'target',
      primaryConfidence: 0.98,
      currentRole: 'background',
      targetRole: 'owner_delivery',
    }));
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('monotonic-first', '请分析活动A的留存数据。', {}, '2026-08-11T09:00:00.000Z'));
    const supplement = await service.ingestSource(source('monotonic-supplement', '另外，付费行为也要看。', {}, '2026-08-11T10:00:00.000Z'));
    const lateOldReply = await service.ingestSource(source('monotonic-old-reply', '补充一条更早发送但刚被补扫到的说明。', { rootId: 'monotonic-first' }, '2026-08-11T08:00:00.000Z'));
    const rows = database.raw.prepare(
      `SELECT requirement_thread_source.source_event_id, requirement_thread_source.thread_id
       FROM requirement_thread_source
       JOIN source_event ON source_event.id = requirement_thread_source.source_event_id
       WHERE source_event.external_id IN ('monotonic-first','monotonic-supplement','monotonic-old-reply')`,
    ).all() as Array<{ source_event_id: string; thread_id: string }>;
    expect(new Set(rows.map((row) => row.thread_id)).size).toBe(1);
    const threadId = rows[0]!.thread_id;
    expect(database.raw.prepare('SELECT last_activity_at FROM requirement_thread WHERE id = ?').get(threadId)).toEqual({ last_activity_at: '2026-08-11T10:00:00.000Z' });
    const tooOld = await service.ingestSource(source('monotonic-too-old', '另外，这是一条四天前的独立需求。', {}, '2026-08-07T09:00:00.000Z'));
    const tooOldThread = database.raw.prepare(
      `SELECT requirement_thread_source.thread_id
       FROM requirement_thread_source JOIN source_event ON source_event.id = requirement_thread_source.source_event_id
       WHERE source_event.external_id = 'monotonic-too-old'`,
    ).get() as { thread_id: string };
    expect(tooOldThread.thread_id).not.toBe(threadId);

    const groupHashFor = (candidateId: string) => {
      const row = service.getCandidate(candidateId)!;
      const rootId = row.merged_into_candidate_id ?? row.id;
      return service.listCandidates(undefined, 'all').find((candidate) => candidate.id === rootId)!.merge_group!.groupVersionHash;
    };
    service.actOnCandidate(first.candidate!.id, 'ignore', undefined, service.getCandidate(first.candidate!.id)!.version, groupHashFor(first.candidate!.id));
    service.actOnCandidate(supplement.candidate!.id, 'ignore', undefined, service.getCandidate(supplement.candidate!.id)!.version, groupHashFor(supplement.candidate!.id));
    service.actOnCandidate(lateOldReply.candidate!.id, 'ignore', undefined, service.getCandidate(lateOldReply.candidate!.id)!.version, groupHashFor(lateOldReply.candidate!.id));
    service.actOnCandidate(tooOld.candidate!.id, 'ignore', undefined, service.getCandidate(tooOld.candidate!.id)!.version);
    expect(database.raw.prepare('SELECT status FROM requirement_thread WHERE id = ?').get(threadId)).toEqual({ status: 'closed' });
    expect(database.raw.prepare('SELECT status FROM requirement_thread WHERE id = ?').get(tooOldThread.thread_id)).toEqual({ status: 'closed' });
  });

  it('后续来源先生成提案，主人确认后才改任务版本并更新记忆投影', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.endsWith('follow-up') || !draft.analysis) return;
      draft.analysis.nextStepSuggestion = '加入付费维度并复核结果';
      draft.analysis.updateConfidence = 0.5;
    }, false, (event) => event.externalId.endsWith('follow-up') ? { targetIndex: 0, scores: [0.98] } : { targetIndex: null });
    const { service, database, root, app } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('proposal-first', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const taskBefore = service.getTask(accepted.task!.id)!;
    const memory = service.getMemoryProjection(taskBefore.id)!;
    expect(memory.state).toBe('ready');
    expect(existsSync(join(root, 'memory', memory.relative_path, 'brief.md'))).toBe(true);

    const followUp = await service.ingestSource(source('proposal-follow-up', '补充：活动A还要加入付费数据。'));
    expect(followUp.candidate?.accepted_task_id).toBe(taskBefore.id);
    const proposalRow = database.raw.prepare("SELECT * FROM task_update_proposal WHERE task_id = ? AND state = 'awaiting_approval'").get(taskBefore.id) as { id: string; base_task_version: number; provider: string; model: string };
    expect(proposalRow).toMatchObject({ base_task_version: taskBefore.version, provider: 'test-provider', model: 'test-model' });
    expect(service.getTask(taskBefore.id)).toMatchObject({ version: taskBefore.version, title: taskBefore.title, describe: taskBefore.describe });
    const pendingBrief = readFileSync(join(root, 'memory', memory.relative_path, 'brief.md'), 'utf8');
    expect(pendingBrief).toContain('待确认提案不会写入任务记忆目录');
    expect(pendingBrief).not.toContain('proposal-follow-up');

    const approved = await app.inject({ method: 'POST', url: `/api/task-update-proposals/${proposalRow.id}/approve` });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().version).toBe(taskBefore.version + 1);
    const approvedAgain = await app.inject({ method: 'POST', url: `/api/task-update-proposals/${proposalRow.id}/approve` });
    expect(approvedAgain.statusCode).toBe(200);
    expect(approvedAgain.json().version).toBe(taskBefore.version + 1);
    expect((database.raw.prepare('SELECT state FROM task_update_proposal WHERE id = ?').get(proposalRow.id) as { state: string }).state).toBe('approved');
    expect((database.raw.prepare("SELECT COUNT(*) AS count FROM task_event WHERE task_id = ? AND source_event_id IS NOT NULL").get(taskBefore.id) as { count: number }).count).toBeGreaterThanOrEqual(1);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count).toBe(0);
    const afterMemory = service.getMemoryProjection(taskBefore.id)!;
    expect(afterMemory.state).toBe('ready');
    expect(readFileSync(join(root, 'memory', afterMemory.relative_path, 'task.json'), 'utf8')).toContain('proposal-follow-up');
    expect(statSync(join(root, 'memory', afterMemory.relative_path)).isDirectory()).toBe(true);
    const updateDirectory = join(root, 'memory', afterMemory.relative_path, 'updates');
    expect(readFileSync(join(updateDirectory, 'index.json'), 'utf8')).toContain(proposalRow.id);
    expect(readdirSync(updateDirectory).some((name) => name.startsWith(`proposal-${proposalRow.id}`))).toBe(true);

    const detailResponse = await app.inject({ method: 'GET', url: `/api/tasks/${taskBefore.id}` });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      thread: { id: taskBefore.thread_id },
      memory_projection: { state: 'ready', projection_version: taskBefore.version + 1 },
      update_proposals: [expect.objectContaining({ id: proposalRow.id, state: 'approved' })],
      runtime_jobs: expect.any(Array),
    });
    expect(detailResponse.json().runtime_jobs.length).toBeGreaterThan(0);
    const memoryResponse = await app.inject({ method: 'GET', url: `/api/tasks/${taskBefore.id}/memory` });
    expect(memoryResponse.statusCode).toBe(200);
    expect(memoryResponse.json()).not.toHaveProperty('root_path');
    expect(JSON.stringify(memoryResponse.json())).not.toContain(root);
  });

  it('强回复链和高置信字段会自动维护私人任务，并保留结构化审计', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.endsWith('follow-up')) return;
      if (!draft.analysis) throw new Error('测试分类器缺少分析字段。');
      draft.analysis.statusSuggestion = 'in_progress';
      draft.analysis.nextStepSuggestion = '加入付费维度并复核结果';
      draft.analysis.updateConfidence = 0.98;
    });
    const { service, database, app } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('auto-first', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const before = service.getTask(accepted.task!.id)!;
    const threadBefore = database.raw.prepare(
      'SELECT title, background, validation_question, describe, analysis_json FROM requirement_thread WHERE id = ?',
    ).get(before.thread_id!) as Record<string, unknown>;

    await service.ingestSource(source('auto-follow-up', '补充：请加入付费维度，现在开始推进。', { parentId: 'auto-first' }));

    const after = service.getTask(before.id)!;
    expect(after).toMatchObject({ status: 'in_progress', next_step: '加入付费维度并复核结果', version: before.version + 1 });
    expect(after).toMatchObject({ title: before.title, describe: before.describe });
    expect(database.raw.prepare(
      'SELECT title, background, validation_question, describe, analysis_json FROM requirement_thread WHERE id = ?',
    ).get(before.thread_id!)).toEqual(threadBefore);
    const proposal = database.raw.prepare('SELECT * FROM task_update_proposal WHERE task_id = ?').get(before.id) as {
      id: string; state: string; decision_mode: string; policy_reason: string; applied_task_version: number; before_snapshot_json: string; after_snapshot_json: string;
    };
    expect(proposal).toMatchObject({ state: 'approved', decision_mode: 'auto', applied_task_version: after.version });
    expect(proposal.policy_reason).toContain('通过自动维护安全门槛');
    expect(JSON.parse(proposal.before_snapshot_json).task.status).toBe(before.status);
    expect(JSON.parse(proposal.after_snapshot_json).task.status).toBe('in_progress');
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM task_event WHERE task_id = ? AND event_type = 'task_auto_updated'").get(before.id)).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 });
    const activeNotifications = service.listNotifications(true).filter((item) => item.task_id === before.id) as Array<{ dedupe_key: string; reason: string }>;
    expect(activeNotifications).toHaveLength(1);
    expect(activeNotifications[0]).toMatchObject({ dedupe_key: `auto-update:${proposal.id}` });
    expect(activeNotifications[0]!.reason).toContain('AI 已自动维护');
    expect(activeNotifications.some((item) => item.dedupe_key.startsWith('candidate:'))).toBe(false);

    const detailResponse = await app.inject({ method: 'GET', url: `/api/tasks/${before.id}` });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json() as Record<string, unknown> & { auto_updates: Array<Record<string, unknown>> };
    expect(detail.auto_updates[0]).toMatchObject({ id: proposal.id, decision_mode: 'auto', can_revert: true });
    expect(detail.auto_updates[0]?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'status', before: before.status, after: 'in_progress' }),
      expect.objectContaining({ field: 'nextStep', before: before.next_step, after: '加入付费维度并复核结果' }),
    ]));
    expect(JSON.stringify(detail)).not.toContain('patch_json');
    expect(JSON.stringify(detail)).not.toContain('before_snapshot_json');
    expect(JSON.stringify(detail)).not.toContain('after_snapshot_json');

    const threadResponse = await app.inject({ method: 'GET', url: `/api/threads/${before.thread_id}` });
    expect(threadResponse.statusCode).toBe(200);
    const threadDetailText = JSON.stringify(threadResponse.json());
    for (const internalKey of ['patch_json', 'evidence_json', 'before_snapshot_json', 'after_snapshot_json', 'analysis_json', 'participant_ids_json', 'ambiguity_json', 'metadata_json']) {
      expect(threadDetailText).not.toContain(internalKey);
    }
  });

  it('只有唯一强回复链会把已确认任务上下文交给分类器', async () => {
    const classifier = new CountingClassifier();
    const { service } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('context-first', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);

    await service.ingestSource(source('context-reply', '补充：加入付费维度。', { parentId: 'context-first' }));
    const replyInput = classifier.inputs.at(-1)!;
    expect(replyInput.metadata?.confirmedTask).toMatchObject({ id: accepted.task!.id, title: accepted.task!.title });
    expect(replyInput.metadata?.confirmedThread).toMatchObject({ id: accepted.task!.thread_id });

    await service.ingestSource(source('context-unlinked', '请分析活动B的留存数据。'));
    const unlinkedInput = classifier.inputs.at(-1)!;
    expect(unlinkedInput.metadata).not.toHaveProperty('confirmedTask');
    expect(unlinkedInput.metadata).not.toHaveProperty('confirmedThread');
  });

  it('主人确认普通 follow-up 时也只应用界面展示的稀疏 patch', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.endsWith('follow-up') || !draft.analysis) return;
      draft.title = '模型完整重写标题';
      draft.background = '模型完整重写背景';
      draft.validationQuestion = '模型完整重写希望验证';
      draft.describe = '模型完整重写 Describe';
      draft.analysis.statusSuggestion = 'in_progress';
      draft.analysis.nextStepSuggestion = '先核验可见 patch';
      draft.analysis.updateConfidence = 0.5;
    });
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('owner-sparse-first', '请分析活动A的留存数据。'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const threadBefore = database.raw.prepare(
      'SELECT title, background, validation_question, describe FROM requirement_thread WHERE id = ?',
    ).get(task.thread_id!) as Record<string, unknown>;

    await service.ingestSource(source('owner-sparse-follow-up', '补充：现在开始推进。', { parentId: 'owner-sparse-first' }));
    const proposal = service.listTaskUpdateProposals('awaiting_approval').find((item) => item.task_id === task.id)!;
    expect(proposal.patch).toMatchObject({ status: 'in_progress', nextStep: '先核验可见 patch' });
    expect(proposal.patch.threadTitle).toBeUndefined();
    service.approveTaskUpdateProposal(proposal.id);

    expect(service.getTask(task.id)).toMatchObject({ title: task.title, describe: task.describe, status: 'in_progress', next_step: '先核验可见 patch' });
    expect(database.raw.prepare(
      'SELECT title, background, validation_question, describe FROM requirement_thread WHERE id = ?',
    ).get(task.thread_id!)).toEqual(threadBefore);
  });

  it('只有完整摘要重写而没有安全字段时不生成空提案，但仍提醒主人复核已关联来源', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.endsWith('follow-up')) return;
      draft.title = '不应直接应用的新标题';
      draft.background = '不应直接应用的新背景';
      draft.validationQuestion = '不应直接应用的新验证问题';
      draft.describe = '不应直接应用的新摘要';
    });
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('empty-proposal-first', '请分析活动A的留存数据。'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const before = service.getTask(task.id)!;

    await service.ingestSource(source('empty-proposal-follow-up', '补充：增加付费维度。', { parentId: 'empty-proposal-first' }));

    expect(service.getTask(task.id)).toMatchObject({ title: before.title, describe: before.describe, version: before.version });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_update_proposal WHERE task_id = ?').get(task.id)).toEqual({ count: 0 });
    const notifications = service.listNotifications(true).filter((item) => item.task_id === task.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ reason: '后续来源已关联到正式任务或原始来源发生更新；当前没有可应用的任务字段修改，请复核来源或文档背景。' });
    expect(database.raw.prepare(
      "SELECT state FROM requirement_thread_revision WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = ?)",
    ).get('empty-proposal-follow-up')).toEqual({ state: 'rejected' });
  });

  it('叙述字段只允许对应字段的明确替换，追加超限和超长旧提案都不能写入', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.endsWith('follow-up') || !draft.analysis) return;
      draft.analysis.updateConfidence = 0.5;
      draft.analysis.narrativeUpdates = {
        taskTitle: { value: '新标题', mode: 'replace', basis: 'fact', confidence: 0.99 },
        threadTitle: { value: '新标题', mode: 'replace', basis: 'fact', confidence: 0.99 },
        threadBackground: { value: '不应被替换的背景', mode: 'replace', basis: 'fact', confidence: 0.99 },
        taskDescribe: { value: 'x'.repeat(2_000), mode: 'append', basis: 'fact', confidence: 0.99 },
      };
    });
    const { service, database, app } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('field-gate-first', '请分析活动A的留存数据。'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const threadBefore = database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(task.thread_id!) as { background: string };

    await service.ingestSource(source('field-gate-follow-up', '标题改成新标题；其他内容只是补充。', { parentId: 'field-gate-first' }));
    const proposal = service.listTaskUpdateProposals('awaiting_approval').find((item) => item.task_id === task.id)!;
    expect(proposal.patch).toMatchObject({ title: '新标题', threadTitle: '新标题' });
    expect(proposal.patch.threadBackground).toBeUndefined();
    expect(proposal.patch.describe).toBeUndefined();
    service.approveTaskUpdateProposal(proposal.id);
    expect(service.getTask(task.id)).toMatchObject({ title: '新标题', describe: task.describe });
    expect((database.raw.prepare('SELECT background FROM requirement_thread WHERE id = ?').get(task.thread_id!) as { background: string }).background).toBe(threadBefore.background);

    const current = service.getTask(task.id)!;
    const oversizedId = 'task-update-oversized';
    database.raw.prepare(
      `INSERT INTO task_update_proposal
        (id, task_id, thread_id, source_event_id, candidate_revision_id, thread_revision_id, base_task_version, base_thread_version,
         patch_json, reason, evidence_json, provider, model, prompt_version, state, idempotency_key, created_at, decided_at)
       VALUES (?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, '超长旧提案', '{}', 'test', 'test', 'test', 'awaiting_approval', ?, ?, NULL)`,
    ).run(oversizedId, task.id, current.version, JSON.stringify({ title: 'x'.repeat(161) }), oversizedId, new Date().toISOString());
    const response = await app.inject({ method: 'POST', url: `/api/task-update-proposals/${oversizedId}/approve` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('超过 160 字符上限');
    expect(service.getTask(task.id)?.version).toBe(current.version);
  });

  it('弱关联、fallback、推测时间、全局仅建议和单任务暂停都保留为待确认', async () => {
    const scenarios: Array<{
      name: string;
      metadata?: Record<string, unknown>;
      content?: string;
      configure?: (service: PmService, taskId: string, version: number) => void;
      classifier: ClassifierAdapter;
      reason: string;
    }> = [
      {
        name: 'weak',
        content: '补充：增加付费维度。',
        classifier: new ScenarioClassifier((draft) => {
          if (!draft.analysis) return;
          draft.analysis.nextStepSuggestion = '补充付费维度';
          draft.analysis.updateConfidence = 0.99;
        }, false, (event) => event.externalId.endsWith('follow-up')
          ? { targetIndex: 0, scores: [0.89], confidence: 0.89 }
          : { targetIndex: null }),
        reason: '需求归属置信度不足',
      },
      {
        name: 'fallback',
        metadata: { parentId: 'fallback-first' },
        classifier: new ScenarioClassifier((draft) => {
          if (!draft.analysis) return;
          draft.analysis.nextStepSuggestion = '补充付费维度';
          draft.analysis.updateConfidence = 0.99;
        }, true, (event) => event.externalId.endsWith('follow-up') ? { targetIndex: 0, scores: [0.98] } : { targetIndex: null }),
        reason: '规则降级',
      },
      {
        name: 'time',
        metadata: { parentId: 'time-first' },
        classifier: new ScenarioClassifier((draft, event) => {
          if (!event.externalId.endsWith('follow-up') || !draft.analysis) return;
          draft.analysis.updateConfidence = 0.99;
          draft.analysis.timeRange = { status: 'inferred', sourceText: '月底前', startAt: null, endAt: '2026-08-31T10:00:00.000Z', timezone: 'Asia/Shanghai', needsConfirmation: true };
        }, false, (event) => event.externalId.endsWith('follow-up') ? { targetIndex: 0, scores: [0.98] } : { targetIndex: null }),
        reason: '计划时间仍需主人确认',
      },
      {
        name: 'suggest',
        metadata: { parentId: 'suggest-first' },
        classifier: new ScenarioClassifier((draft) => {
          if (!draft.analysis) return;
          draft.analysis.nextStepSuggestion = '补充付费维度';
          draft.analysis.updateConfidence = 0.99;
        }, false, (event) => event.externalId.endsWith('follow-up') ? { targetIndex: 0, scores: [0.98] } : { targetIndex: null }),
        configure: (service) => { service.updateAutomationPolicy('suggest'); },
        reason: '全局当前为仅建议模式',
      },
      {
        name: 'paused',
        metadata: { parentId: 'paused-first' },
        classifier: new ScenarioClassifier((draft) => {
          if (!draft.analysis) return;
          draft.analysis.nextStepSuggestion = '补充付费维度';
          draft.analysis.updateConfidence = 0.99;
        }, false, (event) => event.externalId.endsWith('follow-up') ? { targetIndex: 0, scores: [0.98] } : { targetIndex: null }),
        configure: (service, taskId, version) => { service.updateTaskAutomation(taskId, true, version); },
        reason: '已暂停 AI 自动维护',
      },
    ];

    for (const scenario of scenarios) {
      const { service, database } = await makeHarness({ classifier: scenario.classifier });
      const firstId = `${scenario.name}-first`;
      const initial = await service.ingestSource(source(firstId, '请分析活动A的留存数据。'));
      const accepted = service.actOnCandidate(initial.candidate!.id, 'accept', undefined, service.getCandidate(initial.candidate!.id)!.version);
      scenario.configure?.(service, accepted.task!.id, accepted.task!.version);
      const before = service.getTask(accepted.task!.id)!;
      await service.ingestSource(source(`${scenario.name}-follow-up`, scenario.content ?? '补充：活动A还要加入付费数据。', scenario.metadata ?? {}));
      const after = service.getTask(before.id)!;
      expect(after.version, scenario.name).toBe(before.version);
      const proposal = database.raw.prepare("SELECT state, decision_mode, policy_reason FROM task_update_proposal WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(before.id) as { state: string; decision_mode: string; policy_reason: string };
      if (scenario.name === 'weak') {
        expect(proposal).toBeUndefined();
        expect(service.listCandidates('pending')).toHaveLength(1);
        const unresolved = service.listCandidates('pending')[0]!;
        expect(unresolved.thread_association?.requiresConfirmation).toBe(true);
        continue;
      }
      expect(proposal, scenario.name).toMatchObject({ state: 'awaiting_approval', decision_mode: 'pending' });
      expect(proposal.policy_reason, scenario.name).toContain(scenario.reason);
      const notifications = service.listNotifications(true).filter((item) => item.task_id === before.id) as Array<{ dedupe_key: string }>;
      expect(notifications, scenario.name).toHaveLength(1);
      expect(notifications[0]!.dedupe_key, scenario.name).toMatch(/^candidate:.+:source:/u);
      expect(notifications.some((item) => item.dedupe_key.startsWith('auto-update:')), scenario.name).toBe(false);
    }
  });

  it('含 stale 文档背景的高置信后续更新仍停在待确认，不执行受控自动写工具', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.endsWith('follow-up') || !draft.analysis) return;
      draft.analysis.nextStepSuggestion = '根据过期文档补充付费维度';
      draft.analysis.updateConfidence = 0.99;
    });
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('stale-document-first', '请分析活动A的留存数据。'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    service.updateAutomationPolicy('suggest');
    const followUp = await service.ingestSource(source('stale-document-follow-up', '补充：活动A还要加入付费数据。', { parentId: 'stale-document-first' }));
    const proposal = database.raw.prepare(
      "SELECT id, candidate_revision_id, evidence_json FROM task_update_proposal WHERE task_id = ? AND state = 'awaiting_approval' ORDER BY created_at DESC LIMIT 1",
    ).get(task.id) as { id: string; candidate_revision_id: string | null; evidence_json: string };
    expect(proposal.candidate_revision_id).toBeNull();
    const evidence = JSON.parse(proposal.evidence_json) as Record<string, unknown> & { analysis: Record<string, unknown> };
    const analysis = evidence.analysis;
    analysis.linkedDocuments = [{ freshness: 'stale', status: 'ready', documentType: 'docx' }];
    database.raw.prepare('UPDATE task_update_proposal SET evidence_json = ? WHERE id = ?').run(JSON.stringify(evidence), proposal.id);

    const before = service.getTask(task.id)!;
    service.updateAutomationPolicy('auto');
    const dispatched = (service as unknown as { dispatchTaskUpdateProposal: (proposalId: string, runtimeJobId: string | null) => unknown })
      .dispatchTaskUpdateProposal(proposal.id, null) as { policy_reason?: string };
    expect(dispatched.policy_reason).toContain('可能过期的文档背景');
    expect(service.getTask(task.id)).toMatchObject({ version: before.version, next_step: before.next_step });
    expect(database.raw.prepare(
      "SELECT COUNT(*) AS count FROM runtime_tool_call WHERE tool_name = 'task.auto_apply_update' AND status = 'completed'",
    ).get()).toEqual({ count: 0 });
    expect(followUp.candidate?.accepted_task_id).toBe(task.id);
  });

  it('旧 Runtime continuation 不能在租约 reclaim 后借用新 owner 触发提案、任务事件或工具审计', async () => {
    const { service, database } = await makeHarness({ classifier: candidateLinkedUpdateClassifier() });
    const first = await service.ingestSource(source('lease-fence-first', '请分析活动A的留存数据。'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    service.updateAutomationPolicy('suggest');
    await service.ingestSource(source('lease-fence-follow-up', '补充：活动A还要加入付费数据。', { parentId: 'lease-fence-first' }));
    const proposal = database.raw.prepare(
      "SELECT id FROM task_update_proposal WHERE task_id = ? AND state = 'awaiting_approval' ORDER BY created_at DESC LIMIT 1",
    ).get(task.id) as { id: string };
    const runtime = (service as unknown as { runtime: PmRuntime }).runtime;
    const old = runtime.begin({ jobType: 'lease-fence-dispatch', idempotencyKey: 'lease-fence-dispatch', leaseOwner: 'old-owner' });
    database.raw.prepare('UPDATE job SET locked_until = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), old.id);
    const reclaimed = runtime.claim(old.id, 'new-owner');
    expect(reclaimed.acquired).toBe(true);
    const before = {
      task: service.getTask(task.id),
      proposal: database.raw.prepare('SELECT state, applied_task_version FROM task_update_proposal WHERE id = ?').get(proposal.id),
      events: database.raw.prepare('SELECT COUNT(*) AS count FROM task_event WHERE task_id = ?').get(task.id),
      audits: database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_tool_call WHERE tool_name = 'task.auto_apply_update'").get(),
    };
    expect(() => (service as unknown as {
      dispatchTaskUpdateProposal: (proposalId: string, runtimeJobId: string | null, leaseOwner?: string | null) => unknown;
    }).dispatchTaskUpdateProposal(proposal.id, old.id, 'old-owner')).toThrow('租约已失效');
    expect({
      task: service.getTask(task.id),
      proposal: database.raw.prepare('SELECT state, applied_task_version FROM task_update_proposal WHERE id = ?').get(proposal.id),
      events: database.raw.prepare('SELECT COUNT(*) AS count FROM task_event WHERE task_id = ?').get(task.id),
      audits: database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_tool_call WHERE tool_name = 'task.auto_apply_update'").get(),
    }).toEqual(before);
  });

  it('自动完成或归档必须达到 0.97，且一键撤销只允许最新自动版本', async () => {
    const terminalClassifier = (confidence: number) => new ScenarioClassifier((draft, event) => {
      if (!event.externalId.endsWith('follow-up') || !draft.analysis) return;
      draft.analysis.statusSuggestion = 'completed';
      draft.analysis.updateConfidence = confidence;
    });

    const gated = await makeHarness({ classifier: terminalClassifier(0.96) });
    const gatedFirst = await gated.service.ingestSource(source('terminal-gated-first', '请分析活动A的留存数据。'));
    const gatedTask = gated.service.actOnCandidate(gatedFirst.candidate!.id, 'accept', undefined, gated.service.getCandidate(gatedFirst.candidate!.id)!.version).task!;
    await gated.service.ingestSource(source('terminal-gated-follow-up', '补充：这项需求已经明确完成。', { parentId: 'terminal-gated-first' }));
    expect(gated.service.getTask(gatedTask.id)?.status).not.toBe('completed');
    expect((gated.database.raw.prepare('SELECT policy_reason FROM task_update_proposal WHERE task_id = ?').get(gatedTask.id) as { policy_reason: string }).policy_reason).toContain('更高置信度');

    const applied = await makeHarness({ classifier: terminalClassifier(0.98) });
    const first = await applied.service.ingestSource(source('terminal-auto-first', '请分析活动A的留存数据。'));
    const before = applied.service.actOnCandidate(first.candidate!.id, 'accept', undefined, applied.service.getCandidate(first.candidate!.id)!.version).task!;
    await applied.service.ingestSource(source('terminal-auto-follow-up', '补充：这项需求已经明确完成。', { parentId: 'terminal-auto-first' }));
    const auto = applied.service.getTask(before.id)!;
    expect(auto).toMatchObject({ status: 'completed', version: before.version + 1 });
    const proposal = applied.database.raw.prepare("SELECT id FROM task_update_proposal WHERE task_id = ? AND decision_mode = 'auto'").get(before.id) as { id: string };
    const reverted = await applied.app.inject({ method: 'POST', url: `/api/task-update-proposals/${proposal.id}/revert` });
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json()).toMatchObject({ status: before.status, version: auto.version + 1 });
    expect(applied.database.raw.prepare('SELECT decision_mode FROM task_update_proposal WHERE id = ?').get(proposal.id)).toEqual({ decision_mode: 'reverted' });
    expect(applied.database.raw.prepare("SELECT COUNT(*) AS count FROM task_event WHERE task_id = ? AND event_type = 'task_auto_update_reverted'").get(before.id)).toEqual({ count: 1 });

    const conflictHarness = await makeHarness({ classifier: terminalClassifier(0.98) });
    const conflictFirst = await conflictHarness.service.ingestSource(source('terminal-conflict-first', '请分析活动A的留存数据。'));
    const conflictBefore = conflictHarness.service.actOnCandidate(conflictFirst.candidate!.id, 'accept', undefined, conflictHarness.service.getCandidate(conflictFirst.candidate!.id)!.version).task!;
    await conflictHarness.service.ingestSource(source('terminal-conflict-follow-up', '补充：这项需求已经明确完成。', { parentId: 'terminal-conflict-first' }));
    const conflictAuto = conflictHarness.service.getTask(conflictBefore.id)!;
    const conflictProposal = conflictHarness.database.raw.prepare("SELECT id FROM task_update_proposal WHERE task_id = ? AND decision_mode = 'auto'").get(conflictBefore.id) as { id: string };
    conflictHarness.service.updateTask(conflictBefore.id, { nextStep: '主人后续又做了修改', expectedVersion: conflictAuto.version });
    const conflict = await conflictHarness.app.inject({ method: 'POST', url: `/api/task-update-proposals/${conflictProposal.id}/revert` });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toContain('已经发生新修改');
    expect(conflictHarness.service.getTask(conflictBefore.id)?.next_step).toBe('主人后续又做了修改');
  });

  it('自动更新撤销在写入前校验快照排期，并对非法区间保持任务、提案和时间线零写入', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.endsWith('follow-up') || !draft.analysis) return;
      draft.analysis.statusSuggestion = 'in_progress';
      draft.analysis.nextStepSuggestion = '先核验自动更新';
      draft.analysis.updateConfidence = 0.99;
    });
    const prepareRevert = async (name: string, plannedStartAt: string | null, plannedDueAt: string | null) => {
      const harness = await makeHarness({ classifier });
      const first = await harness.service.ingestSource(source(`${name}-first`, '请分析活动A的留存数据。'));
      const task = harness.service.actOnCandidate(first.candidate!.id, 'accept', undefined, harness.service.getCandidate(first.candidate!.id)!.version).task!;
      await harness.service.ingestSource(source(`${name}-follow-up`, '补充：现在开始推进。', { parentId: `${name}-first` }));
      const proposal = harness.database.raw.prepare(
        "SELECT id, before_snapshot_json FROM task_update_proposal WHERE task_id = ? AND decision_mode = 'auto'",
      ).get(task.id) as { id: string; before_snapshot_json: string };
      const snapshot = JSON.parse(proposal.before_snapshot_json) as { task: Record<string, unknown> };
      snapshot.task.planned_start_at = plannedStartAt;
      snapshot.task.planned_due_at = plannedDueAt;
      snapshot.task.schedule_at = plannedDueAt;
      harness.database.raw.prepare('UPDATE task_update_proposal SET before_snapshot_json = ? WHERE id = ?')
        .run(JSON.stringify(snapshot), proposal.id);
      return { ...harness, taskId: task.id, proposalId: proposal.id };
    };
    const writeSnapshot = (harness: Awaited<ReturnType<typeof prepareRevert>>) => ({
      task: harness.database.raw.prepare('SELECT * FROM task WHERE id = ?').get(harness.taskId),
      proposal: harness.database.raw.prepare('SELECT * FROM task_update_proposal WHERE id = ?').get(harness.proposalId),
      taskEvents: harness.database.raw.prepare('SELECT * FROM task_event WHERE task_id = ? ORDER BY recorded_at, id').all(harness.taskId),
    });

    const atLimit = await prepareRevert(
      'revert-calendar-limit',
      '2023-12-31T16:00:00.000Z',
      '2024-12-31T16:00:00.000Z',
    );
    const atLimitResponse = await atLimit.app.inject({ method: 'POST', url: `/api/task-update-proposals/${atLimit.proposalId}/revert` });
    expect(atLimitResponse.statusCode).toBe(200);
    expect(atLimitResponse.json()).toMatchObject({
      planned_start_at: '2023-12-31T16:00:00.000Z',
      planned_due_at: '2024-12-31T16:00:00.000Z',
      schedule_at: '2024-12-31T16:00:00.000Z',
    });

    const equalPoint = await prepareRevert(
      'revert-calendar-point',
      '2026-08-14T16:00:00.000Z',
      '2026-08-14T16:00:00.000Z',
    );
    const equalPointResponse = await equalPoint.app.inject({ method: 'POST', url: `/api/task-update-proposals/${equalPoint.proposalId}/revert` });
    expect(equalPointResponse.statusCode).toBe(200);
    expect(equalPointResponse.json()).toMatchObject({
      planned_start_at: '2026-08-14T16:00:00.000Z',
      planned_due_at: '2026-08-14T16:00:00.000Z',
    });

    for (const scenario of [
      {
        name: 'revert-calendar-reversed',
        startAt: '2026-08-15T16:00:00.000Z',
        dueAt: '2026-08-14T16:00:00.000Z',
        error: '计划完成时间不能早于计划开始时间。',
      },
      {
        name: 'revert-calendar-over-limit',
        startAt: '2023-12-31T16:00:00.000Z',
        dueAt: '2025-01-01T16:00:00.000Z',
        error: '计划时间跨度不能超过 366 个上海自然日。',
      },
    ]) {
      const harness = await prepareRevert(scenario.name, scenario.startAt, scenario.dueAt);
      const before = writeSnapshot(harness);
      const response = await harness.app.inject({ method: 'POST', url: `/api/task-update-proposals/${harness.proposalId}/revert` });
      expect(response.statusCode, scenario.name).toBe(409);
      expect(response.json(), scenario.name).toEqual({ error: scenario.error });
      expect(response.body, scenario.name).not.toContain(scenario.startAt);
      expect(response.body, scenario.name).not.toContain(scenario.dueAt);
      expect(writeSnapshot(harness), scenario.name).toEqual(before);
    }
  });

  it('自动更新撤销严格校验持久化快照类型，并对损坏 JSON shape 保持三表零写入', async () => {
    const harness = await makeHarness({ classifier: candidateLinkedUpdateClassifier() });
    const prepared = await addCandidateLinkedAutoUpdate(harness, 'revert-snapshot-schema');
    const task = prepared.task;
    const proposal = prepared.proposal;
    const originalBeforeSnapshot = proposal.before_snapshot_json;
    const originalAfterSnapshot = proposal.after_snapshot_json;
    const cloneSnapshot = (value = originalBeforeSnapshot) => JSON.parse(value) as {
      task: Record<string, unknown>;
      thread: Record<string, unknown> | null;
      candidate: Record<string, unknown> | null;
    };
    const persistedState = () => ({
      task: harness.database.raw.prepare('SELECT * FROM task WHERE id = ?').get(task.id),
      proposal: harness.database.raw.prepare('SELECT * FROM task_update_proposal WHERE id = ?').get(proposal.id),
      taskEvents: harness.database.raw.prepare('SELECT * FROM task_event WHERE task_id = ? ORDER BY recorded_at, id').all(task.id),
    });
    const withTaskValue = (key: string, value: unknown) => {
      const snapshot = cloneSnapshot();
      snapshot.task[key] = value;
      return snapshot;
    };
    const withoutTaskField = (key: string) => {
      const snapshot = cloneSnapshot();
      delete snapshot.task[key];
      return snapshot;
    };
    const invalidStatusCanary = 'snapshot-status-canary';
    const invalidTitleCanary = 'snapshot-title-canary';
    const invalidRootCanary = 'snapshot-root-canary';
    const scenarios: Array<{ name: string; snapshot: unknown; canary?: string; target?: 'before' | 'after' }> = [
      { name: 'planned_start_at number', snapshot: withTaskValue('planned_start_at', 20260815) },
      { name: 'planned_due_at number', snapshot: withTaskValue('planned_due_at', 20260815) },
      { name: 'schedule_at number', snapshot: withTaskValue('schedule_at', 20260815) },
      { name: 'planned_start_at boolean', snapshot: withTaskValue('planned_start_at', true) },
      { name: 'planned_due_at boolean', snapshot: withTaskValue('planned_due_at', false) },
      { name: 'schedule_at boolean', snapshot: withTaskValue('schedule_at', true) },
      { name: 'missing restored title', snapshot: withoutTaskField('title') },
      { name: 'root array', snapshot: [cloneSnapshot()] },
      { name: 'root string', snapshot: invalidRootCanary, canary: invalidRootCanary },
      { name: 'root null', snapshot: null },
      { name: 'invalid task id type', snapshot: withTaskValue('id', 42) },
      { name: 'invalid task status', snapshot: withTaskValue('status', invalidStatusCanary), canary: invalidStatusCanary },
      { name: 'invalid task field type', snapshot: withTaskValue('title', { value: invalidTitleCanary }), canary: invalidTitleCanary },
      ...[
        ['schedule_at', '1.0'],
        ['planned_start_at', '01/02/2026'],
        ['planned_due_at', '2026-08-15'],
        ['completed_at', '2026/08/15'],
        ['archived_at', 'Aug 15 2026'],
      ].map(([field, value]) => ({
        name: `${field} rejects non-ISO ${value}`,
        snapshot: withTaskValue(field!, value),
        canary: value,
      })),
      {
        name: 'thread last_activity_at rejects non-ISO datetime',
        snapshot: (() => {
          const snapshot = cloneSnapshot();
          if (snapshot.thread) snapshot.thread.last_activity_at = '2026-08-15 00:00:00';
          return snapshot;
        })(),
        canary: '2026-08-15 00:00:00',
      },
      {
        name: 'after snapshot uses the same strict parser',
        snapshot: (() => {
          const snapshot = cloneSnapshot(originalAfterSnapshot);
          snapshot.task.schedule_at = '2026-08-15';
          return snapshot;
        })(),
        canary: '2026-08-15',
        target: 'after',
      },
      {
        name: 'invalid restored thread field type',
        snapshot: (() => {
          const snapshot = cloneSnapshot();
          if (snapshot.thread) snapshot.thread.title = 42;
          return snapshot;
        })(),
      },
      {
        name: 'invalid restored candidate field type',
        snapshot: (() => {
          const snapshot = cloneSnapshot();
          if (snapshot.candidate) snapshot.candidate.confidence = 'high';
          return snapshot;
        })(),
      },
    ];

    for (const scenario of scenarios) {
      harness.database.raw.prepare(
        `UPDATE task_update_proposal SET ${scenario.target === 'after' ? 'after_snapshot_json' : 'before_snapshot_json'} = ? WHERE id = ?`,
      ).run(JSON.stringify(scenario.snapshot), proposal.id);
      const before = persistedState();
      const response = await harness.app.inject({ method: 'POST', url: `/api/task-update-proposals/${proposal.id}/revert` });
      expect(response.statusCode, scenario.name).toBe(409);
      expect(response.json(), scenario.name).toEqual({ error: '自动更新的前置快照损坏，不能安全撤销。' });
      if (scenario.canary) expect(response.body, scenario.name).not.toContain(scenario.canary);
      expect(persistedState(), scenario.name).toEqual(before);
      harness.database.raw.prepare('UPDATE task_update_proposal SET before_snapshot_json = ?, after_snapshot_json = ? WHERE id = ?')
        .run(originalBeforeSnapshot, originalAfterSnapshot, proposal.id);
    }
  });

  it('自动更新撤销在写入前闭合线程、候选和修订关联，错配时保持关联数据零写入', async () => {
    const harness = await makeHarness({ classifier: candidateLinkedUpdateClassifier() });
    const prepared = await addCandidateLinkedAutoUpdate(harness, 'revert-link');
    const task = prepared.task;
    const proposal = prepared.proposal;
    const appliedRevision = harness.database.raw.prepare(
      'SELECT candidate_id FROM candidate_revision WHERE id = ?',
    ).get(proposal.candidate_revision_id) as { candidate_id: string };

    const other = await addCandidateLinkedAutoUpdate(harness, 'revert-link-other', '请分析活动B的留存数据。');
    const otherRevision = { id: other.proposal.candidate_revision_id };

    const cloneBefore = () => JSON.parse(proposal.before_snapshot_json) as {
      task: Record<string, unknown>;
      thread: Record<string, unknown> | null;
      candidate: Record<string, unknown> | null;
      previousCandidateRevisionId?: string | null;
    };
    const cloneAfter = () => JSON.parse(proposal.after_snapshot_json) as {
      task: Record<string, unknown>;
      thread: Record<string, unknown> | null;
      candidate: Record<string, unknown> | null;
      previousCandidateRevisionId?: string | null;
    };
    const validBefore = cloneBefore();
    const validAfter = cloneAfter();
    const authoritativeCandidateState = (harness.database.raw.prepare(
      'SELECT state FROM candidate_request WHERE id = ?',
    ).get(appliedRevision.candidate_id) as { state: string }).state;
    expect(validBefore.previousCandidateRevisionId).toEqual(expect.any(String));
    expect(validAfter.previousCandidateRevisionId).toBeNull();
    expect(validBefore.candidate!.state).toBe(authoritativeCandidateState);
    expect(validAfter.candidate!.state).toBe(authoritativeCandidateState);
    expect(harness.database.raw.prepare(
      `SELECT title, proposer_name, background, validation_question, describe, analysis_json, confidence, state
       FROM candidate_revision WHERE id = ?`,
    ).get(validBefore.previousCandidateRevisionId!)).toEqual({
      title: validBefore.candidate!.title,
      proposer_name: validBefore.candidate!.proposer_name,
      background: validBefore.candidate!.background,
      validation_question: validBefore.candidate!.validation_question,
      describe: validBefore.candidate!.describe,
      analysis_json: validBefore.candidate!.analysis_json,
      confidence: validBefore.candidate!.confidence,
      state: 'superseded',
    });
    expect(harness.database.raw.prepare(
      `SELECT title, proposer_name, background, validation_question, describe, analysis_json, confidence, state
       FROM candidate_revision WHERE id = ?`,
    ).get(proposal.candidate_revision_id)).toEqual({
      title: validAfter.candidate!.title,
      proposer_name: validAfter.candidate!.proposer_name,
      background: validAfter.candidate!.background,
      validation_question: validAfter.candidate!.validation_question,
      describe: validAfter.candidate!.describe,
      analysis_json: validAfter.candidate!.analysis_json,
      confidence: validAfter.candidate!.confidence,
      state: 'current',
    });
    const persistedState = () => ({
      task: harness.database.raw.prepare('SELECT * FROM task WHERE id = ?').get(task.id),
      proposal: harness.database.raw.prepare('SELECT * FROM task_update_proposal WHERE id = ?').get(proposal.id),
      taskEvents: harness.database.raw.prepare('SELECT * FROM task_event WHERE task_id = ? ORDER BY recorded_at, id').all(task.id),
      thread: harness.database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(proposal.thread_id),
      candidate: harness.database.raw.prepare('SELECT * FROM candidate_request WHERE id = ?').get(appliedRevision.candidate_id),
      revisions: harness.database.raw.prepare('SELECT * FROM candidate_revision WHERE candidate_id = ? ORDER BY created_at, id').all(appliedRevision.candidate_id),
    });
    const restoreProposal = () => harness.database.raw.prepare(
      `UPDATE task_update_proposal
       SET thread_id = ?, candidate_revision_id = ?, before_snapshot_json = ?, after_snapshot_json = ?
       WHERE id = ?`,
    ).run(
      proposal.thread_id,
      proposal.candidate_revision_id,
      proposal.before_snapshot_json,
      proposal.after_snapshot_json,
      proposal.id,
    );
    const scenarios: Array<{
      name: string;
      canary?: string;
      mutate: (before: ReturnType<typeof cloneBefore>, after: ReturnType<typeof cloneAfter>) => void;
      restore?: () => void;
    }> = [
      {
        name: 'wrong linked thread id',
        canary: 'wrong-thread-link-canary',
        mutate: (before) => { if (before.thread) before.thread.id = 'wrong-thread-link-canary'; },
      },
      {
        name: 'missing linked thread snapshot',
        mutate: (before) => { before.thread = null; },
      },
      {
        name: 'thread snapshot forbidden without proposal thread',
        mutate: () => { harness.database.raw.prepare('UPDATE task_update_proposal SET thread_id = NULL WHERE id = ?').run(proposal.id); },
      },
      {
        name: 'wrong linked candidate id',
        canary: 'wrong-candidate-link-canary',
        mutate: (before) => { if (before.candidate) before.candidate.id = 'wrong-candidate-link-canary'; },
      },
      ...(['pending', 'snoozed', 'ignored'] as const).flatMap((state) => [
        {
          name: `before candidate business state cannot change to ${state}`,
          canary: state,
          mutate: (before: ReturnType<typeof cloneBefore>) => { if (before.candidate) before.candidate.state = state; },
        },
        {
          name: `after candidate business state cannot change to ${state}`,
          canary: state,
          mutate: (_before: ReturnType<typeof cloneBefore>, after: ReturnType<typeof cloneAfter>) => { if (after.candidate) after.candidate.state = state; },
        },
      ]),
      {
        name: 'candidate-linked before previous revision is null',
        mutate: (before) => { before.previousCandidateRevisionId = null; },
      },
      {
        name: 'candidate-linked after previous revision is non-null',
        canary: 'after-previous-revision-canary',
        mutate: (_before, after) => { after.previousCandidateRevisionId = 'after-previous-revision-canary'; },
      },
      {
        name: 'missing previous candidate revision',
        canary: 'missing-previous-revision-canary',
        mutate: (before) => { before.previousCandidateRevisionId = 'missing-previous-revision-canary'; },
      },
      {
        name: 'previous revision belongs to another candidate',
        mutate: (before) => { before.previousCandidateRevisionId = otherRevision.id; },
      },
      {
        name: 'previous revision payload differs from before candidate snapshot',
        canary: 'previous-payload-mismatch-canary',
        mutate: (before) => {
          harness.database.raw.prepare('UPDATE candidate_revision SET describe = ? WHERE id = ?')
            .run('previous-payload-mismatch-canary', before.previousCandidateRevisionId!);
        },
        restore: () => {
          const before = cloneBefore();
          harness.database.raw.prepare('UPDATE candidate_revision SET describe = ? WHERE id = ?')
            .run((before.candidate as { describe: string }).describe, before.previousCandidateRevisionId!);
        },
      },
      {
        name: 'candidate snapshot forbidden without proposal revision',
        mutate: () => { harness.database.raw.prepare('UPDATE task_update_proposal SET candidate_revision_id = NULL WHERE id = ?').run(proposal.id); },
      },
      {
        name: 'wrong after task id',
        canary: 'wrong-after-task-canary',
        mutate: (_before, after) => { after.task.id = 'wrong-after-task-canary'; },
      },
    ];

    for (const scenario of scenarios) {
      const beforeSnapshot = cloneBefore();
      const afterSnapshot = cloneAfter();
      scenario.mutate(beforeSnapshot, afterSnapshot);
      harness.database.raw.prepare(
        'UPDATE task_update_proposal SET before_snapshot_json = ?, after_snapshot_json = ? WHERE id = ?',
      ).run(JSON.stringify(beforeSnapshot), JSON.stringify(afterSnapshot), proposal.id);
      const before = persistedState();
      try {
        const response = await harness.app.inject({ method: 'POST', url: `/api/task-update-proposals/${proposal.id}/revert` });
        expect(response.statusCode, scenario.name).toBe(409);
        expect(response.json(), scenario.name).toEqual({ error: '自动更新的前置快照损坏，不能安全撤销。' });
        if (scenario.canary) expect(response.body, scenario.name).not.toContain(scenario.canary);
        expect(persistedState(), scenario.name).toEqual(before);
      } finally {
        scenario.restore?.();
        restoreProposal();
      }
    }
  });

  it('candidate-less 自动提案的损坏 after 快照也会在任何写入前固定拒绝', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.endsWith('follow-up') || !draft.analysis) return;
      draft.analysis.statusSuggestion = 'in_progress';
      draft.analysis.nextStepSuggestion = '先核验 after 快照';
      draft.analysis.updateConfidence = 0.99;
    });
    const harness = await makeHarness({ classifier });
    const first = await harness.service.ingestSource(source('revert-after-first', '请分析活动A的留存数据。'));
    const task = harness.service.actOnCandidate(first.candidate!.id, 'accept', undefined, harness.service.getCandidate(first.candidate!.id)!.version).task!;
    const followUp = await harness.service.ingestSource(source('revert-after-follow-up', '补充：现在开始推进。', { parentId: 'revert-after-first' }));
    const proposal = harness.database.raw.prepare(
      "SELECT id, candidate_revision_id, before_snapshot_json FROM task_update_proposal WHERE task_id = ? AND decision_mode = 'auto'",
    ).get(task.id) as { id: string; candidate_revision_id: string | null; before_snapshot_json: string };
    expect(proposal.candidate_revision_id).toBeNull();
    expect(harness.database.raw.prepare("SELECT COUNT(*) AS count FROM candidate_revision WHERE candidate_id = ? AND state = 'current'")
      .get(followUp.candidate!.id)).toEqual({ count: 1 });
    const beforeSnapshot = JSON.parse(proposal.before_snapshot_json) as Record<string, unknown> & {
      candidate: unknown;
      previousCandidateRevisionId?: string | null;
    };
    beforeSnapshot.candidate = null;
    beforeSnapshot.previousCandidateRevisionId = null;
    const afterCanary = 'candidate-less-after-canary';
    harness.database.raw.prepare(
      'UPDATE task_update_proposal SET before_snapshot_json = ?, after_snapshot_json = ? WHERE id = ?',
    ).run(JSON.stringify(beforeSnapshot), JSON.stringify(afterCanary), proposal.id);
    const persistedState = () => ({
      task: harness.database.raw.prepare('SELECT * FROM task WHERE id = ?').get(task.id),
      proposal: harness.database.raw.prepare('SELECT * FROM task_update_proposal WHERE id = ?').get(proposal.id),
      taskEvents: harness.database.raw.prepare('SELECT * FROM task_event WHERE task_id = ? ORDER BY recorded_at, id').all(task.id),
    });
    const before = persistedState();
    const response = await harness.app.inject({ method: 'POST', url: `/api/task-update-proposals/${proposal.id}/revert` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: '自动更新的前置快照损坏，不能安全撤销。' });
    expect(response.body).not.toContain(afterCanary);
    expect(persistedState()).toEqual(before);
  });

  it('合法历史快照会剥离额外字段，恢复成功且 canary 不进入响应或任务审计', async () => {
    const harness = await makeHarness({ classifier: candidateLinkedUpdateClassifier() });
    const prepared = await addCandidateLinkedAutoUpdate(harness, 'revert-strip');
    const beforeTask = prepared.task;
    const proposal = prepared.proposal;
    const candidateStateBeforeRevert = (harness.database.raw.prepare(
      'SELECT state FROM candidate_request WHERE id = (SELECT candidate_id FROM candidate_revision WHERE id = ?)',
    ).get(proposal.candidate_revision_id) as { state: string }).state;
    const beforeSnapshot = JSON.parse(proposal.before_snapshot_json) as Record<string, unknown> & {
      task: Record<string, unknown>;
      thread: Record<string, unknown> | null;
      candidate: Record<string, unknown> | null;
    };
    const afterSnapshot = JSON.parse(proposal.after_snapshot_json) as typeof beforeSnapshot;
    const canary = 'snapshot-extra-strip-canary';
    for (const snapshot of [beforeSnapshot, afterSnapshot]) {
      snapshot.extra_root = canary;
      snapshot.task.extra_task = canary;
      if (snapshot.thread) snapshot.thread.extra_thread = canary;
      if (snapshot.candidate) snapshot.candidate.extra_candidate = canary;
    }
    harness.database.raw.prepare(
      'UPDATE task_update_proposal SET before_snapshot_json = ?, after_snapshot_json = ? WHERE id = ?',
    ).run(JSON.stringify(beforeSnapshot), JSON.stringify(afterSnapshot), proposal.id);

    const response = await harness.app.inject({ method: 'POST', url: `/api/task-update-proposals/${proposal.id}/revert` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: beforeTask.status, next_step: beforeTask.next_step });
    expect(response.body).not.toContain(canary);
    const revertEvent = harness.database.raw.prepare(
      "SELECT before_json, after_json FROM task_event WHERE task_id = ? AND event_type = 'task_auto_update_reverted'",
    ).get(beforeTask.id) as { before_json: string; after_json: string };
    expect(JSON.stringify(revertEvent)).not.toContain(canary);
    const restoredCandidate = harness.database.raw.prepare(
      'SELECT * FROM candidate_request WHERE id = (SELECT candidate_id FROM candidate_revision WHERE id = ?)',
    ).get(proposal.candidate_revision_id) as Record<string, unknown>;
    expect(restoredCandidate.state).toBe(candidateStateBeforeRevert);
    const restoredCurrent = harness.database.raw.prepare(
      "SELECT * FROM candidate_revision WHERE candidate_id = ? AND state = 'current'",
    ).all(restoredCandidate.id as string) as Array<Record<string, unknown>>;
    expect(restoredCurrent).toHaveLength(1);
    expect(restoredCurrent[0]).toMatchObject({
      title: restoredCandidate.title,
      proposer_name: restoredCandidate.proposer_name,
      background: restoredCandidate.background,
      validation_question: restoredCandidate.validation_question,
      describe: restoredCandidate.describe,
      analysis_json: restoredCandidate.analysis_json,
      confidence: restoredCandidate.confidence,
    });
  });

  it('候选摘要被主人纠正后拒绝撤销，且候选快照或修订缺失时安全失败', async () => {
    const corrected = await makeHarness({ classifier: candidateLinkedUpdateClassifier() });
    const correctedPrepared = await addCandidateLinkedAutoUpdate(corrected, 'candidate-conflict');
    const correctedTask = correctedPrepared.task;
    const correctedProposal = correctedPrepared.proposal;
    const candidateId = (corrected.database.raw.prepare('SELECT candidate_id FROM candidate_revision WHERE id = ?').get(correctedProposal.candidate_revision_id) as { candidate_id: string }).candidate_id;
    corrected.database.raw.prepare('UPDATE candidate_request SET describe = ? WHERE id = ?').run('主人纠正后的候选摘要', candidateId);
    const conflict = await corrected.app.inject({ method: 'POST', url: `/api/task-update-proposals/${correctedProposal.id}/revert` });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toContain('候选摘要');
    expect(corrected.database.raw.prepare('SELECT describe FROM candidate_request WHERE id = ?').get(candidateId)).toEqual({ describe: '主人纠正后的候选摘要' });
    expect(corrected.service.getTask(correctedTask.id)?.status).toBe('in_progress');

    const missingSnapshot = await makeHarness({ classifier: candidateLinkedUpdateClassifier() });
    const snapshotPrepared = await addCandidateLinkedAutoUpdate(missingSnapshot, 'snapshot-missing');
    const snapshotProposal = snapshotPrepared.proposal;
    missingSnapshot.database.raw.prepare("UPDATE task_update_proposal SET after_snapshot_json = '{}' WHERE id = ?").run(snapshotProposal.id);
    const snapshotResponse = await missingSnapshot.app.inject({ method: 'POST', url: `/api/task-update-proposals/${snapshotProposal.id}/revert` });
    expect(snapshotResponse.statusCode).toBe(409);
    expect(snapshotResponse.json()).toEqual({ error: '自动更新的前置快照损坏，不能安全撤销。' });

    const missingRevision = await makeHarness({ classifier: candidateLinkedUpdateClassifier() });
    const revisionPrepared = await addCandidateLinkedAutoUpdate(missingRevision, 'revision-missing');
    const revisionProposal = revisionPrepared.proposal;
    missingRevision.database.raw.exec('PRAGMA foreign_keys = OFF');
    missingRevision.database.raw.prepare('DELETE FROM candidate_revision WHERE id = ?').run(revisionProposal.candidate_revision_id);
    missingRevision.database.raw.exec('PRAGMA foreign_keys = ON');
    const revisionResponse = await missingRevision.app.inject({ method: 'POST', url: `/api/task-update-proposals/${revisionProposal.id}/revert` });
    expect(revisionResponse.statusCode).toBe(409);
    expect(revisionResponse.json()).toEqual({ error: '自动更新的前置快照损坏，不能安全撤销。' });
  });

  it('高置信度但没有明确结束原文时，仍不能自动完成任务', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.endsWith('follow-up') || !draft.analysis) return;
      draft.analysis.statusSuggestion = 'completed';
      draft.analysis.updateConfidence = 0.99;
    });
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('terminal-no-evidence-first', '请分析活动A的留存数据。'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    await service.ingestSource(source('terminal-no-evidence-follow-up', '补充：最终版文件已经放在目录里。', { parentId: 'terminal-no-evidence-first' }));
    expect(service.getTask(task.id)?.status).not.toBe('completed');
    expect((database.raw.prepare('SELECT policy_reason FROM task_update_proposal WHERE task_id = ?').get(task.id) as { policy_reason: string }).policy_reason).toContain('来源正文没有明确表达');
  });

  it.each([
    ['completed', '这项需求已经完成。', true],
    ['completed', '已经交付。', true],
    ['completed', '验收通过。', true],
    ['completed', '可以结项了。', true],
    ['completed', '这项需求还没完成。', false],
    ['completed', '现在不能交付。', false],
    ['completed', '不要结项。', false],
    ['completed', '这项需求是否完成？', false],
    ['completed', '最终版文件已经放好。', false],
    ['archived', '这项需求已经取消。', true],
    ['archived', '不再处理这项需求。', true],
    ['archived', '不要取消这项需求。', false],
    ['archived', '暂不归档。', false],
  ] as const)('终态证据识别：%s / %s', async (status, content, shouldApply) => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.endsWith('follow-up') || !draft.analysis) return;
      draft.analysis.statusSuggestion = status;
      draft.analysis.updateConfidence = 0.99;
    });
    const { service, database } = await makeHarness({ classifier });
    const suffix = Buffer.from(`${status}:${content}`).toString('hex').slice(0, 20);
    const firstId = `terminal-matrix-${suffix}-first`;
    const first = await service.ingestSource(source(firstId, '请分析活动A的留存数据。'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    await service.ingestSource(source(`terminal-matrix-${suffix}-follow-up`, content, { parentId: firstId }));
    expect(service.getTask(task.id)?.status).toBe(shouldApply ? status : task.status);
    const proposal = database.raw.prepare('SELECT decision_mode, policy_reason FROM task_update_proposal WHERE task_id = ?').get(task.id) as { decision_mode: string; policy_reason: string };
    expect(proposal.decision_mode).toBe(shouldApply ? 'auto' : 'pending');
    if (!shouldApply) expect(proposal.policy_reason).toContain('来源正文没有明确表达');
  });

  it('优先级建议和来源备注只进入提案，主人确认后才更新风险与私人时间线', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (event.externalId !== 'priority-follow-up') return;
      if (!draft.analysis) throw new Error('测试分类器缺少分析字段。');
      draft.analysis.prioritySuggestion = 'high';
      draft.analysis.note = '需求方明确说明本周发布前需要复核。';
    }, false, (event) => event.externalId === 'priority-follow-up'
      ? { targetIndex: 0, scores: [0.98] }
      : { targetIndex: null });
    const { service, database } = await makeHarness({ classifier });
    const initial = await service.ingestSource(source('priority-first', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(initial.candidate!.id, 'accept', undefined, service.getCandidate(initial.candidate!.id)!.version);
    const task = accepted.task!;
    expect(task.risk).toBe('medium');

    const followUp = await service.ingestSource(source('priority-follow-up', '补充：活动A需要增加付费数据。'));
    const candidateView = service.listCandidates().find((candidate) => candidate.id === followUp.candidate?.id)!;
    expect(candidateView.analysis).toMatchObject({
      prioritySuggestion: 'high',
      note: '需求方明确说明本周发布前需要复核。',
    });
    const proposal = service.listTaskUpdateProposals('awaiting_approval').find((item) => item.task_id === task.id)!;
    expect(proposal.patch).toMatchObject({ risk: 'high', note: '需求方明确说明本周发布前需要复核。' });
    expect(service.getTask(task.id)?.risk).toBe('medium');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_event WHERE task_id = ? AND summary LIKE ?').get(task.id, '%本周发布前需要复核%')).toEqual({ count: 0 });

    const approved = service.approveTaskUpdateProposal(proposal.id)!;
    expect(approved.risk).toBe('high');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_event WHERE task_id = ? AND summary LIKE ?').get(task.id, '%本周发布前需要复核%')).toEqual({ count: 1 });
  });

  it('提案拒绝、版本冲突和空 Patch 都不会偷偷改正式任务', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.includes('follow-up') || !draft.analysis) return;
      draft.analysis.nextStepSuggestion = `核验 ${event.externalId}`;
      draft.analysis.updateConfidence = 0.5;
    }, false, (event) => event.externalId.includes('follow-up') ? { targetIndex: 0, scores: [0.98] } : { targetIndex: null });
    const { service, database, app } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('reject-first', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const task = service.getTask(accepted.task!.id)!;
    await service.ingestSource(source('reject-follow-up', '补充：活动A还要加入付费数据。'));
    const proposal = database.raw.prepare("SELECT id FROM task_update_proposal WHERE task_id = ? AND state = 'awaiting_approval'").get(task.id) as { id: string };
    const rejected = await app.inject({ method: 'POST', url: `/api/task-update-proposals/${proposal.id}/reject` });
    expect(rejected.statusCode).toBe(200);
    expect(service.getTask(task.id)?.version).toBe(task.version);
    expect((database.raw.prepare('SELECT state FROM task_update_proposal WHERE id = ?').get(proposal.id) as { state: string }).state).toBe('rejected');

    await service.ingestSource(source('conflict-follow-up', '补充：活动A再加入设备维度。'));
    const conflict = database.raw.prepare("SELECT id FROM task_update_proposal WHERE task_id = ? AND state = 'awaiting_approval' ORDER BY created_at DESC LIMIT 1").get(task.id) as { id: string };
    service.updateTask(task.id, { nextStep: '主人手工先更新', expectedVersion: task.version });
    const conflictResponse = await app.inject({ method: 'POST', url: `/api/task-update-proposals/${conflict.id}/approve` });
    expect(conflictResponse.statusCode).toBe(409);
    expect((database.raw.prepare('SELECT state FROM task_update_proposal WHERE id = ?').get(conflict.id) as { state: string }).state).toBe('stale');

    const current = service.getTask(task.id)!;
    const noOpId = 'task-update-no-op';
    database.raw.prepare(
      `INSERT INTO task_update_proposal
        (id, task_id, thread_id, source_event_id, candidate_revision_id, thread_revision_id, base_task_version, base_thread_version,
         patch_json, reason, evidence_json, provider, model, prompt_version, state, idempotency_key, created_at, decided_at)
       VALUES (?, ?, NULL, NULL, NULL, NULL, ?, NULL, '{}', '空更新测试', '{}', 'test', 'test', 'test', 'awaiting_approval', ?, ?, NULL)`,
    ).run(noOpId, task.id, current.version, noOpId, new Date().toISOString());
    const empty = await app.inject({ method: 'POST', url: `/api/task-update-proposals/${noOpId}/approve` });
    expect(empty.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT state FROM task_update_proposal WHERE id = ?').get(noOpId)).toEqual({ state: 'stale' });
    expect(service.getTask(task.id)?.version).toBe(current.version);
  });

  it('多条后续消息精确绑定各自 revision，拒绝一条不会串改另一条或任务记忆', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.includes('follow-up') || !draft.analysis) return;
      draft.analysis.nextStepSuggestion = `核验 ${event.externalId}`;
      draft.analysis.updateConfidence = 0.5;
    }, false, (event) => event.externalId.includes('follow-up') ? { targetIndex: 0, scores: [0.98] } : { targetIndex: null });
    const { service, database, root } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('binding-first', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const task = service.getTask(accepted.task!.id)!;
    const threadBefore = database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(task.thread_id!) as { id: string; title: string; background: string; validation_question: string; describe: string; status: string };
    const projection = service.getMemoryProjection(task.id)!;
    const briefPath = join(root, 'memory', projection.relative_path, 'brief.md');
    const briefBefore = readFileSync(briefPath, 'utf8');

    await service.ingestSource(source('binding-follow-up-1', '补充：活动A还要加入付费数据。'));
    await service.ingestSource(source('binding-follow-up-2', '补充：活动A还要加入设备维度。'));
    const proposals = database.raw.prepare(
      `SELECT task_update_proposal.*, source_event.external_id
       FROM task_update_proposal
       JOIN source_event ON source_event.id = task_update_proposal.source_event_id
       WHERE task_update_proposal.task_id = ? AND task_update_proposal.state = 'awaiting_approval'
       ORDER BY source_event.external_id`,
    ).all(task.id) as Array<{ id: string; external_id: string; candidate_revision_id: string | null; thread_revision_id: string; base_thread_version: number }>;
    expect(proposals).toHaveLength(2);
    expect(proposals.every((proposal) => proposal.candidate_revision_id === null)).toBe(true);
    expect(new Set(proposals.map((proposal) => proposal.thread_revision_id)).size).toBe(2);
    expect(proposals.every((proposal) => proposal.base_thread_version === task.version + 1)).toBe(true);
    const sourceRevisionIds = new Map(proposals.map((proposal) => [
      proposal.external_id,
      (database.raw.prepare(
        `SELECT candidate_revision.id
         FROM candidate_revision
         JOIN candidate_request ON candidate_request.id = candidate_revision.candidate_id
         JOIN source_event ON source_event.id = candidate_request.source_event_id
         WHERE source_event.external_id = ? AND candidate_revision.state = 'current'`,
      ).get(proposal.external_id) as { id: string }).id,
    ]));
    expect(new Set(sourceRevisionIds.values()).size).toBe(2);

    const rejected = proposals[0]!;
    const untouched = proposals[1]!;
    service.rejectTaskUpdateProposal(rejected.id);
    expect(database.raw.prepare('SELECT state FROM candidate_revision WHERE id = ?').get(sourceRevisionIds.get(rejected.external_id)!)).toEqual({ state: 'current' });
    expect(database.raw.prepare('SELECT state FROM requirement_thread_revision WHERE id = ?').get(rejected.thread_revision_id)).toEqual({ state: 'rejected' });
    expect(database.raw.prepare('SELECT state FROM candidate_revision WHERE id = ?').get(sourceRevisionIds.get(untouched.external_id)!)).toEqual({ state: 'current' });
    expect(database.raw.prepare('SELECT state FROM requirement_thread_revision WHERE id = ?').get(untouched.thread_revision_id)).toEqual({ state: 'proposed' });
    expect(service.getTask(task.id)).toMatchObject({ version: task.version, title: task.title, describe: task.describe });
    expect(database.raw.prepare('SELECT title, background, validation_question, describe, status FROM requirement_thread WHERE id = ?').get(threadBefore.id)).toEqual({
      title: threadBefore.title,
      background: threadBefore.background,
      validation_question: threadBefore.validation_question,
      describe: threadBefore.describe,
      status: 'needs_confirmation',
    });
    expect(readFileSync(briefPath, 'utf8')).toBe(briefBefore);

    const approved = service.approveTaskUpdateProposal(untouched.id)!;
    expect(approved.version).toBe(task.version + 1);
    expect(database.raw.prepare('SELECT state FROM candidate_revision WHERE id = ?').get(sourceRevisionIds.get(untouched.external_id)!)).toEqual({ state: 'current' });
    expect(database.raw.prepare('SELECT state FROM requirement_thread_revision WHERE id = ?').get(untouched.thread_revision_id)).toEqual({ state: 'accepted' });
    expect(database.raw.prepare('SELECT status FROM requirement_thread WHERE id = ?').get(threadBefore.id)).toEqual({ status: 'open' });
    expect(readFileSync(briefPath, 'utf8')).not.toBe(briefBefore);
  });

  it('确认一条旧版本提案会让同版本兄弟提案失效，记忆历史只保留已确认更新', async () => {
    const classifier = new ScenarioClassifier((draft, event) => {
      if (!event.externalId.includes('follow-up') || !draft.analysis) return;
      draft.analysis.nextStepSuggestion = `核验 ${event.externalId}`;
      draft.analysis.updateConfidence = 0.5;
    }, false, (event) => event.externalId.includes('follow-up') ? { targetIndex: 0, scores: [0.98] } : { targetIndex: null });
    const { service, database, root, app } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('sibling-first', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const task = service.getTask(accepted.task!.id)!;
    const projection = service.getMemoryProjection(task.id)!;
    const updateDirectory = join(root, 'memory', projection.relative_path, 'updates');

    await service.ingestSource(source('sibling-follow-up-1', '补充：活动A还要加入付费数据。'));
    await service.ingestSource(source('sibling-follow-up-2', '补充：活动A还要加入设备维度。'));
    const proposals = database.raw.prepare(
      `SELECT task_update_proposal.*, source_event.external_id
       FROM task_update_proposal
       JOIN source_event ON source_event.id = task_update_proposal.source_event_id
       WHERE task_update_proposal.task_id = ? AND task_update_proposal.state = 'awaiting_approval'
       ORDER BY source_event.external_id`,
    ).all(task.id) as Array<{ id: string; external_id: string; candidate_revision_id: string | null; thread_revision_id: string }>;
    expect(proposals).toHaveLength(2);
    expect(proposals.every((proposal) => proposal.candidate_revision_id === null)).toBe(true);
    expect(readdirSync(updateDirectory).some((name) => name.startsWith('proposal-'))).toBe(false);

    const approved = proposals[0]!;
    const superseded = proposals[1]!;
    const approvedResponse = await app.inject({ method: 'POST', url: `/api/task-update-proposals/${approved.id}/approve` });
    expect(approvedResponse.statusCode).toBe(200);
    expect(database.raw.prepare('SELECT state FROM task_update_proposal WHERE id = ?').get(approved.id)).toEqual({ state: 'approved' });
    expect(database.raw.prepare('SELECT state FROM task_update_proposal WHERE id = ?').get(superseded.id)).toEqual({ state: 'stale' });
    expect(database.raw.prepare('SELECT state FROM requirement_thread_revision WHERE id = ?').get(superseded.thread_revision_id)).toEqual({ state: 'stale' });
    const staleResponse = await app.inject({ method: 'POST', url: `/api/task-update-proposals/${superseded.id}/approve` });
    expect(staleResponse.statusCode).toBe(409);

    const approvedIndex = JSON.parse(readFileSync(join(updateDirectory, 'index.json'), 'utf8')) as { confirmedRevisions: Array<{ proposalId: string }> };
    expect(approvedIndex.confirmedRevisions.map((revision) => revision.proposalId)).toEqual([approved.id]);
    expect(readdirSync(updateDirectory)).toContain(`proposal-${approved.id}.md`);
    expect(readdirSync(updateDirectory)).not.toContain(`proposal-${superseded.id}.md`);

    await service.ingestSource(source('sibling-follow-up-rejected', '补充：活动A还要加入地区维度。'));
    const rejected = database.raw.prepare(
      "SELECT id FROM task_update_proposal WHERE task_id = ? AND state = 'awaiting_approval' ORDER BY created_at DESC LIMIT 1",
    ).get(task.id) as { id: string };
    service.rejectTaskUpdateProposal(rejected.id);
    service.projectTaskMemory(task.id);
    const finalIndex = JSON.parse(readFileSync(join(updateDirectory, 'index.json'), 'utf8')) as { confirmedRevisions: Array<{ proposalId: string }> };
    expect(finalIndex.confirmedRevisions.map((revision) => revision.proposalId)).toEqual([approved.id]);
    expect(readdirSync(updateDirectory)).not.toContain(`proposal-${rejected.id}.md`);
  });

  it('已接受任务重新整理只产生 proposal，不直接改任务；reference_only 不会触发扫描', async () => {
    const inspect = vi.fn(async (referencePath: string) => ({ state: 'ready' as const, referencePath, entries: [], truncated: false, inspectedAt: new Date().toISOString() }));
    const workspace = { kind: 'readonly_bridge' as const, inspect };
    const { service, database, app } = await makeHarness({ workspace });
    const first = await service.ingestSource(source('reprocess-first', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const taskBefore = service.getTask(accepted.task!.id)!;
    const candidateBefore = service.getCandidate(first.candidate!.id)!;
    const threadBefore = database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(taskBefore.thread_id!) as { background: string; version: number };
    const memory = service.getMemoryProjection(taskBefore.id)!;
    const briefPath = join((service as unknown as { config: { taskMemoryRoot: string } }).config.taskMemoryRoot, memory.relative_path, 'brief.md');
    const briefBefore = readFileSync(briefPath, 'utf8');
    const reference = service.addReference(taskBefore.id, '引用目录', 'workspace://reports', 'reference_only');
    const blocked = await app.inject({ method: 'POST', url: `/api/tasks/${taskBefore.id}/references/${(reference as { id: string }).id}/inspect` });
    expect(blocked.statusCode).toBe(409);
    expect(inspect).not.toHaveBeenCalled();
    const result = await service.reprocessCandidate(first.candidate!.id, '请补充背景，但不要新增事实。', undefined, service.getCandidate(first.candidate!.id)!.version);
    expect(result.proposal).toBeTruthy();
    expect(service.getTask(taskBefore.id)).toMatchObject({ version: taskBefore.version, title: taskBefore.title, describe: taskBefore.describe });
    expect(service.getCandidate(first.candidate!.id)).toMatchObject({
      title: candidateBefore.title,
      background: candidateBefore.background,
      describe: candidateBefore.describe,
    });
    expect(database.raw.prepare('SELECT background, version FROM requirement_thread WHERE id = ?').get(taskBefore.thread_id!)).toEqual({
      background: threadBefore.background,
      version: threadBefore.version,
    });
    expect(readFileSync(briefPath, 'utf8')).toBe(briefBefore);
    expect(result.proposal).toMatchObject({
      candidate_revision_id: expect.any(String),
      thread_revision_id: expect.any(String),
      base_thread_version: threadBefore.version,
    });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM candidate_revision WHERE candidate_id = ?").get(first.candidate!.id)).toEqual({ count: 2 });

    const approved = service.approveTaskUpdateProposal((result.proposal as { id: string }).id)!;
    expect(approved.version).toBe(taskBefore.version + 1);
    expect(service.getCandidate(first.candidate!.id)?.describe).toContain('主人补充');
    expect((database.raw.prepare('SELECT background, version FROM requirement_thread WHERE id = ?').get(taskBefore.thread_id!) as { background: string; version: number }).version).toBe(threadBefore.version + 1);
    expect(readFileSync(briefPath, 'utf8')).not.toBe(briefBefore);
  });

  it('reprocess model checkpoint 在上下文 fingerprint 匹配时只恢复一次，后续提交不重复业务副作用', async () => {
    class CountingClassifier extends ScriptedClassifier {
      calls = 0;

      override async classify(event: NormalizedSourceEvent, guidance?: string) {
        this.calls += 1;
        return { ...(await super.classify(event, guidance)), outcome: 'valid' as const };
      }
    }
    const classifier = new CountingClassifier();
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('run01-reprocess-checkpoint', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    await service.reprocessCandidate(first.candidate!.id, '补充恢复测试背景。', undefined, service.getCandidate(first.candidate!.id)!.version);
    expect(classifier.calls).toBe(2);
    const reprocessJob = database.raw.prepare("SELECT id FROM job WHERE job_type = 'reprocess_candidate'").get() as { id: string };
    const revisions = database.raw.prepare('SELECT id, ai_decision_id FROM candidate_revision WHERE candidate_id = ? ORDER BY created_at').all(first.candidate!.id) as Array<{ id: string; ai_decision_id: string }>;
    const latestRevision = revisions.at(-1)!;
    const initialDecisionId = revisions[0]!.ai_decision_id;
    const reprocessProposal = database.raw.prepare("SELECT id, thread_revision_id FROM task_update_proposal WHERE origin = 'reprocess'").get() as { id: string; thread_revision_id: string | null };
    database.raw.prepare('DELETE FROM task_update_proposal WHERE id = ?').run(reprocessProposal.id);
    if (reprocessProposal.thread_revision_id) database.raw.prepare('DELETE FROM requirement_thread_revision WHERE id = ?').run(reprocessProposal.thread_revision_id);
    database.raw.prepare("DELETE FROM correction_event WHERE correction_type = 'reprocess'").run();
    database.raw.prepare('DELETE FROM candidate_revision WHERE id = ?').run(latestRevision.id);
    database.raw.prepare('DELETE FROM ai_decision_log WHERE id <> ? AND candidate_id = ?').run(initialDecisionId, first.candidate!.id);
    database.raw.prepare(
      "UPDATE job SET status = 'queued', retryable = 1, available_at = ?, locked_until = NULL, lease_owner = NULL, result_json = NULL WHERE id = ?",
    ).run(new Date(Date.now() - 1_000).toISOString(), reprocessJob.id);

    const refresh = vi.spyOn((service as unknown as { feishuDocumentContext: { refresh: (sourceEventId: string, content: string, force?: boolean) => Promise<SourceDocumentContext[]> } }).feishuDocumentContext, 'refresh');
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect(classifier.calls).toBe(2);
    expect(refresh).not.toHaveBeenCalled();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_revision WHERE candidate_id = ?').get(first.candidate!.id)).toEqual({ count: 2 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'reprocess'").get()).toEqual({ count: 1 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM task_update_proposal WHERE origin = 'reprocess'").get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(reprocessJob.id)).toEqual({ status: 'completed' });
    expect(accepted.task).toBeTruthy();
  });

  it('reprocess context 数量相同但 fingerprint 变化时不复用旧上下文或模型 checkpoint', async () => {
    class CountingClassifier extends ScriptedClassifier {
      calls = 0;

      override async classify(event: NormalizedSourceEvent, guidance?: string) {
        this.calls += 1;
        return { ...(await super.classify(event, guidance)), outcome: 'valid' as const };
      }
    }
    const classifier = new CountingClassifier();
    const { service, database } = await makeHarness({ classifier });
    const event = source('run01-reprocess-context-fingerprint', '请分析活动A的留存数据，背景见 https://example.feishu.cn/docx/doc-1。');
    const first = await service.ingestSource(event);
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    await service.reprocessCandidate(first.candidate!.id, '补充 fingerprint 恢复测试背景。', undefined, service.getCandidate(first.candidate!.id)!.version);
    expect(classifier.calls).toBe(2);

    const sourceRow = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get(event.externalId) as { id: string };
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_context WHERE source_event_id = ?').get(sourceRow.id)).toEqual({ count: 1 });
    const reprocessJob = database.raw.prepare("SELECT id FROM job WHERE job_type = 'reprocess_candidate'").get() as { id: string };
    const latestRevision = database.raw.prepare('SELECT id, ai_decision_id FROM candidate_revision WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1').get(first.candidate!.id) as { id: string; ai_decision_id: string };
    const initialDecisionId = database.raw.prepare('SELECT ai_decision_id FROM candidate_revision WHERE candidate_id = ? ORDER BY created_at ASC LIMIT 1').get(first.candidate!.id) as { ai_decision_id: string };
    const reprocessProposal = database.raw.prepare("SELECT id, thread_revision_id FROM task_update_proposal WHERE origin = 'reprocess'").get() as { id: string; thread_revision_id: string | null };
    database.raw.prepare('DELETE FROM task_update_proposal WHERE id = ?').run(reprocessProposal.id);
    if (reprocessProposal.thread_revision_id) database.raw.prepare('DELETE FROM requirement_thread_revision WHERE id = ?').run(reprocessProposal.thread_revision_id);
    database.raw.prepare("DELETE FROM correction_event WHERE correction_type = 'reprocess'").run();
    database.raw.prepare('DELETE FROM candidate_revision WHERE id = ?').run(latestRevision.id);
    database.raw.prepare('DELETE FROM ai_decision_log WHERE id <> ? AND candidate_id = ?').run(initialDecisionId.ai_decision_id, first.candidate!.id);

    database.raw.prepare('UPDATE source_context SET content_hash = ? WHERE source_event_id = ?').run('synthetic-context-fingerprint-change', sourceRow.id);
    const toolCallsBeforeRecovery = database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_tool_call WHERE tool_name = 'task.propose_update'").get() as { count: number };
    const contextService = (service as unknown as {
      feishuDocumentContext: {
        refresh: (sourceEventId: string, content: string, force?: boolean) => Promise<unknown>;
        list: (sourceEventId: string) => unknown;
      };
    }).feishuDocumentContext;
    const refresh = vi.spyOn(contextService, 'refresh').mockImplementation(async (sourceEventId) => contextService.list(sourceEventId));
    database.raw.prepare(
      "UPDATE job SET status = 'queued', retryable = 1, available_at = ?, locked_until = NULL, lease_owner = NULL, result_json = NULL WHERE id = ?",
    ).run(new Date(Date.now() - 1_000).toISOString(), reprocessJob.id);

    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 0 });
    expect(refresh).not.toHaveBeenCalled();
    expect(classifier.calls).toBe(2);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_tool_call WHERE tool_name = 'task.propose_update'").get()).toEqual({ count: toolCallsBeforeRecovery.count });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_checkpoint WHERE job_id = ? AND step = 'reprocess_context_loaded'").get(reprocessJob.id)).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_revision WHERE candidate_id = ?').get(first.candidate!.id)).toEqual({ count: 1 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'reprocess'").get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM task_update_proposal WHERE origin = 'reprocess'").get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(reprocessJob.id)).toEqual({ status: 'queued' });
    expect(accepted.task).toBeTruthy();
  });

  it('运行中取消会保留 durable source，但不会写候选、线程或更新提案', async () => {
    const started = deferred<void>();
    const released = deferred<ClassificationResult>();
    const classifier: ClassifierAdapter = {
      kind: 'rule_mock',
      provider: 'cancel-test',
      model: 'cancel-test',
      promptVersion: 'cancel-test-v1',
      classify: async () => {
        started.resolve();
        return released.promise;
      },
      testConnection: async () => ({ ok: true, status: 'mock', message: 'test', checkedAt: new Date().toISOString() }),
    };
    const { service, database } = await makeHarness({ classifier });
    const event = source('cancel-running', '请分析活动A的留存数据。');
    const pending = service.ingestSource(event);
    await started.promise;
    const job = database.raw.prepare("SELECT id FROM job WHERE job_type = 'classify_source'").get() as { id: string };
    service.cancelRuntimeJob(job.id);
    released.resolve(await new ScriptedClassifier().classify(event));
    await expect(pending).rejects.toThrow('Runtime 工作项已取消或租约已失效');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_update_proposal').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(job.id)).toEqual({ status: 'cancelled' });
  });

  it('模型失败后可由启动恢复器继续，提交后崩溃也不会重复生成 reprocess 提案', async () => {
    class FailOnceClassifier extends ScriptedClassifier {
      attempts = 0;

      override async classify(event: NormalizedSourceEvent, guidance?: string) {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error('temporary model failure');
        return super.classify(event, guidance);
      }
    }
    const flaky = new FailOnceClassifier();
    const { service, database } = await makeHarness({ classifier: flaky });
    await expect(service.ingestSource(source('recovery-source', '请分析活动A的留存数据。'))).rejects.toThrow('temporary model failure');
    const classifyJob = database.raw.prepare("SELECT id, status FROM job WHERE job_type = 'classify_source'").get() as { id: string; status: string };
    expect(classifyJob.status).toBe('queued');
    database.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), classifyJob.id);
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(classifyJob.id)).toEqual({ status: 'completed' });

    const candidate = database.raw.prepare('SELECT * FROM candidate_request').get() as { id: string };
    const accepted = service.actOnCandidate(candidate.id, 'accept', undefined, service.getCandidate(candidate.id)!.version);
    const reprocessed = await service.reprocessCandidate(candidate.id, '请补充恢复测试背景。', undefined, service.getCandidate(candidate.id)!.version);
    expect(reprocessed.proposal).toBeTruthy();
    const reprocessJob = database.raw.prepare("SELECT id FROM job WHERE job_type = 'reprocess_candidate' ORDER BY created_at DESC LIMIT 1").get() as { id: string };
    const beforeCounts = {
      revisions: database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_revision WHERE candidate_id = ?').get(candidate.id),
      proposals: database.raw.prepare('SELECT COUNT(*) AS count FROM task_update_proposal WHERE task_id = ?').get(accepted.task!.id),
      corrections: database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'reprocess'").get(),
    };
    database.raw.prepare(
      "UPDATE job SET status = 'queued', retryable = 1, available_at = ?, locked_until = NULL, lease_owner = NULL, result_json = NULL WHERE id = ?",
    ).run(new Date(Date.now() - 1_000).toISOString(), reprocessJob.id);
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect({
      revisions: database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_revision WHERE candidate_id = ?').get(candidate.id),
      proposals: database.raw.prepare('SELECT COUNT(*) AS count FROM task_update_proposal WHERE task_id = ?').get(accepted.task!.id),
      corrections: database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'reprocess'").get(),
    }).toEqual(beforeCounts);
    expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(reprocessJob.id)).toEqual({ status: 'completed' });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_checkpoint WHERE job_id = ? AND step = 'reprocess_commit_recovered'").get(reprocessJob.id)).toEqual({ count: 1 });
  });

  it('分类 provider checkpoint 在匹配 source/context revision 时恢复一次且不刷新、不重复业务落库', async () => {
    class CountingClassifier extends LiveThreadCentricClassifier {
      calls = 0;

      override async classify(event: NormalizedSourceEvent) {
        this.calls += 1;
        return super.classify(event);
      }
    }
    const classifier = new CountingClassifier();
    const { service, database } = await makeHarness({ classifier });
    const event = source('run01-classification-checkpoint-reuse', '请分析活动A的留存数据。');
    await service.ingestSource(event);
    expect(classifier.calls).toBe(1);
    const sourceRow = database.raw.prepare('SELECT id, metadata_json FROM source_event WHERE external_id = ?').get(event.externalId) as { id: string; metadata_json: string };
    const job = database.raw.prepare("SELECT id FROM job WHERE job_type = 'classify_source'").get() as { id: string };
    const refresh = vi.spyOn((service as unknown as { feishuDocumentContext: { refresh: (sourceEventId: string, content: string, force?: boolean) => Promise<SourceDocumentContext[]> } }).feishuDocumentContext, 'refresh');
    const metadata = JSON.parse(sourceRow.metadata_json) as Record<string, unknown>;
    delete metadata.classificationRevision;
    database.raw.prepare('UPDATE source_event SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), sourceRow.id);
    // Model the crash boundary: provider/audit/checkpoint are durable, while
    // the later business persistence has not committed yet.
    database.raw.exec('DELETE FROM candidate_revision; DELETE FROM ai_decision_log; DELETE FROM candidate_request;');
    database.raw.prepare(
      "UPDATE job SET status = 'queued', retryable = 1, available_at = ?, locked_until = NULL, lease_owner = NULL, result_json = NULL WHERE id = ?",
    ).run(new Date(Date.now() - 1_000).toISOString(), job.id);
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect(classifier.calls).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_revision').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_tool_call WHERE tool_name = \'task.propose_update\'').get()).toEqual({ count: 1 });
  });

  it.each([
    { label: '429', status: 429, transport: false },
    { label: '503', status: 503, transport: false },
    { label: 'transport', status: 0, transport: true },
  ])('生产分类路径将 $label typed retry 同时传播到 durable job 与 provider cooldown', async ({ status, transport }) => {
    const root = mkdtempSync(join(tmpdir(), `ai-pm-durable-retry-${status || 'transport'}-`));
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      TASK_MEMORY_ROOT: join(root, 'memory'),
      LLM_PROVIDER: `synthetic-durable-${status || 'transport'}`,
      LLM_MODEL: 'synthetic-model',
      LLM_API_BASE: 'http://synthetic.invalid/v1',
      LLM_API_KEY: 'synthetic-key-not-secret',
      LLM_MAX_RETRIES: '0',
    });
    let providerCalls = 0;
    const fetcher = (async () => {
      providerCalls += 1;
      if (transport) throw Object.assign(new Error('synthetic transport failure'), { code: 'ECONNRESET' });
      return new Response(JSON.stringify({ error: { message: 'synthetic provider failure' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const adapters = createAdapters(config);
    adapters.classifier = new OpenAICompatibleClassifier(config.llm, fetcher);
    const database = syntheticRetryCooldownDatabase();
    const service = new PmService(database, adapters, config);
    const app = await buildApp(service, { serveWeb: false });

    try {
      const firstResult = await service.ingestSource(source(`durable-retry-${status || 'transport'}-first`, '请分析活动A的留存数据。'));
      expect(firstResult.classificationDeferred).toBe(true);
      expect(providerCalls).toBe(1);
      const firstJob = database.raw.prepare(
        "SELECT status, retryable, available_at, updated_at, lease_owner FROM job WHERE job_type = 'classify_source' ORDER BY created_at ASC LIMIT 1",
      ).get() as { status: string; retryable: number; available_at: string; updated_at: string; lease_owner: string | null };
      expect(firstJob).toMatchObject({ status: 'queued', retryable: 1, lease_owner: null });
      expect(Date.parse(firstJob.available_at)).toBeGreaterThan(Date.parse(firstJob.updated_at));

      const secondResult = await service.ingestSource(source(`durable-retry-${status || 'transport'}-second`, '请分析活动B的留存数据。'));
      expect(providerCalls).toBe(1);
      const secondJob = database.raw.prepare(
        "SELECT status, retryable, available_at, updated_at, lease_owner FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
      ).get() as { status: string; retryable: number; available_at: string; updated_at: string; lease_owner: string | null };
      expect(secondJob).toMatchObject({ status: 'queued', retryable: 1, lease_owner: null });
      expect(Date.parse(secondJob.available_at)).toBeGreaterThan(Date.parse(secondJob.updated_at));

      expect(secondResult.classificationDeferred).toBe(true);
      expect(providerCalls).toBe(1);
      expect(database.raw.prepare("SELECT COUNT(*) AS count FROM candidate_request").get()).toEqual({ count: 0 });
      expect(database.raw.prepare("SELECT COUNT(*) AS count FROM task_event").get()).toEqual({ count: 0 });
      const jobs = database.raw.prepare(
        "SELECT status, retryable, lease_owner FROM job WHERE job_type = 'classify_source' ORDER BY created_at ASC",
      ).all() as Array<{ status: string; retryable: number; lease_owner: string | null }>;
      expect(jobs).toEqual([
        { status: 'queued', retryable: 1, lease_owner: null },
        { status: 'queued', retryable: 1, lease_owner: null },
      ]);
    } finally {
      await app.close();
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RUN-02 cooldown 跨 service 重启保持 durable，第二个 job 不提前调用 provider', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-16T00:00:00.000Z') });
    const root = mkdtempSync(join(tmpdir(), 'ai-pm-durable-retry-restart-'));
    const databasePath = join(root, 'pm.sqlite');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databasePath,
      TASK_MEMORY_ROOT: join(root, 'memory'),
      LLM_PROVIDER: 'synthetic-restart-provider',
      LLM_MODEL: 'synthetic-model',
      LLM_API_BASE: 'http://synthetic.invalid/v1',
      LLM_API_KEY: 'synthetic-key-not-secret',
      LLM_MAX_RETRIES: '0',
    });
    let providerCalls = 0;
    const fetcher = (async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'synthetic provider failure' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const openService = () => {
      const database = new AppDatabase(databasePath, false);
      const adapters = createAdapters(config);
      adapters.classifier = new OpenAICompatibleClassifier(config.llm, fetcher);
      return { database, service: new PmService(database, adapters, config) };
    };
    const first = openService();
    let second: ReturnType<typeof openService> | null = null;
    try {
      const firstResult = await first.service.ingestSource(source('durable-restart-first', '请分析活动A的留存数据。'));
      expect(firstResult.classificationDeferred).toBe(true);
      expect(providerCalls).toBe(1);
      const firstJob = first.database.raw.prepare(
        "SELECT status, retryable, available_at, lease_owner FROM job WHERE job_type = 'classify_source' ORDER BY created_at ASC LIMIT 1",
      ).get() as { status: string; retryable: number; available_at: string; lease_owner: string | null };
      expect(firstJob).toMatchObject({ status: 'queued', retryable: 1, lease_owner: null });
      expect(Date.parse(firstJob.available_at)).toBeGreaterThan(Date.now());
      first.database.close();

      second = openService();
      try {
        const secondResult = await second.service.ingestSource(source('durable-restart-second', '请分析活动B的留存数据。'));
        expect(secondResult.classificationDeferred).toBe(true);
        expect(providerCalls).toBe(1);
        const cooldown = second.database.raw.prepare(
          'SELECT provider_key, retry_at_ms FROM provider_retry_cooldown WHERE provider_key = ?',
        ).get('synthetic-restart-provider') as { provider_key: string; retry_at_ms: number };
        expect(cooldown.provider_key).toBe('synthetic-restart-provider');
        expect(cooldown.retry_at_ms).toBeGreaterThan(Date.now());
      } finally {
        second.database.close();
        second = null;
      }
    } finally {
      try { second?.database.close(); } catch { /* already closed */ }
      try { first.database.close(); } catch { /* already closed */ }
      vi.useRealTimers();
      try { if (existsSync(databasePath)) rmSync(databasePath, { force: true }); } catch { /* test cleanup only */ }
      try { rmSync(root, { recursive: true, force: true }); } catch { /* test cleanup only */ }
    }
  });

  it('分类 checkpoint source/context fingerprint 变化或伪造分类 JSON 时 fail-closed 并重新调用 provider', async () => {
    class CountingClassifier extends LiveThreadCentricClassifier {
      calls = 0;

      override async classify(event: NormalizedSourceEvent) {
        this.calls += 1;
        return super.classify(event);
      }
    }
    const classifier = new CountingClassifier();
    const { service, database } = await makeHarness({ classifier });
    const event = source('run01-classification-checkpoint-invalid', '请分析活动B的留存数据。');
    await service.ingestSource(event);
    const sourceRow = database.raw.prepare('SELECT id, metadata_json FROM source_event WHERE external_id = ?').get(event.externalId) as { id: string; metadata_json: string };
    const job = database.raw.prepare("SELECT id FROM job WHERE job_type = 'classify_source'").get() as { id: string };
    const checkpoint = database.raw.prepare("SELECT id, state_json FROM runtime_checkpoint WHERE job_id = ? AND step = 'classification_provider_completed'").get(job.id) as { id: string; state_json: string };
    const state = JSON.parse(checkpoint.state_json) as Record<string, unknown>;
    state.classification = { ...(state.classification as Record<string, unknown>), outcome: 'valid', sensitiveCanary: 'must-not-reuse' };
    database.raw.prepare('UPDATE runtime_checkpoint SET state_json = ? WHERE id = ?').run(JSON.stringify(state), checkpoint.id);
    const metadata = JSON.parse(sourceRow.metadata_json) as Record<string, unknown>;
    delete metadata.classificationRevision;
    database.raw.prepare('UPDATE source_event SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), sourceRow.id);
    database.raw.prepare(
      "UPDATE job SET status = 'queued', retryable = 1, available_at = ?, locked_until = NULL, lease_owner = NULL, result_json = NULL WHERE id = ?",
    ).run(new Date(Date.now() - 1_000).toISOString(), job.id);

    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 0 });
    expect(classifier.calls).toBe(2);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_tool_call WHERE tool_name = 'task.propose_update'").get()).toEqual({ count: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM runtime_checkpoint WHERE job_id = ? AND step = \'classification_provider_completed\'').get(job.id)).toEqual({ count: 2 });
  });

  it('失败和取消的安全 Runtime 工作项可通过 API 手动重试，其他类型会被拒绝', async () => {
    const { database, app } = await makeHarness();
    const runtime = new PmRuntime(database);
    const failed = runtime.begin({ jobType: 'classify_source', idempotencyKey: 'manual-retry-failed', leaseOwner: 'failed-worker' });
    runtime.fail(failed.id, new Error('terminal failure'), { retryable: false, leaseOwner: 'failed-worker' });
    const failedRetry = await app.inject({ method: 'POST', url: `/api/runtime/jobs/${failed.id}/retry` });
    expect(failedRetry.statusCode).toBe(200);
    expect(failedRetry.json()).toMatchObject({ status: 'queued', attempts: 0, retryable: 1, last_error: null });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_checkpoint WHERE job_id = ? AND step = 'manual_retry_requested'").get(failed.id)).toEqual({ count: 1 });

    const cancelled = runtime.begin({ jobType: 'reprocess_candidate', idempotencyKey: 'manual-retry-cancelled' });
    runtime.cancel(cancelled.id);
    const cancelledRetry = await app.inject({ method: 'POST', url: `/api/runtime/jobs/${cancelled.id}/retry` });
    expect(cancelledRetry.statusCode).toBe(200);
    expect(cancelledRetry.json()).toMatchObject({ status: 'queued' });
    expect(cancelledRetry.body).not.toContain('cancel_requested_at');

    const unsupported = runtime.begin({ jobType: 'memory_projection', idempotencyKey: 'manual-retry-unsupported', leaseOwner: 'unsupported-worker' });
    runtime.fail(unsupported.id, new Error('projection failure'), { retryable: false, leaseOwner: 'unsupported-worker' });
    const unsupportedRetry = await app.inject({ method: 'POST', url: `/api/runtime/jobs/${unsupported.id}/retry` });
    expect(unsupportedRetry.statusCode).toBe(409);
    expect(unsupportedRetry.json().error).toContain('没有安全的自动重试处理器');
    const missing = await app.inject({ method: 'POST', url: '/api/runtime/jobs/not-found/retry' });
    expect(missing.statusCode).toBe(404);
  });

  it('真实分类失败可经 API 手动重试并由 Runtime 恢复，来源和候选都不会重复', async () => {
    class RecoveringClassifier extends ScriptedClassifier {
      failing = true;

      override async classify(event: NormalizedSourceEvent, guidance?: string): Promise<ClassificationResult> {
        if (this.failing) throw new Error('temporary classifier outage');
        return super.classify(event, guidance);
      }
    }
    const classifier = new RecoveringClassifier();
    const { service, database, app } = await makeHarness({ classifier });
    await expect(service.ingestSource(source('manual-retry-real-source', '请分析活动A的留存数据。'))).rejects.toThrow('temporary classifier outage');
    const job = database.raw.prepare(
      "SELECT id, status, attempts FROM job WHERE job_type = 'classify_source' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; status: string; attempts: number };
    expect(job).toMatchObject({ status: 'queued', attempts: 1 });

    for (let expectedAttempt = 2; expectedAttempt <= 3; expectedAttempt += 1) {
      database.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id);
      await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 0 });
      expect((database.raw.prepare('SELECT attempts FROM job WHERE id = ?').get(job.id) as { attempts: number }).attempts).toBe(expectedAttempt);
    }
    expect(database.raw.prepare('SELECT status, retryable FROM job WHERE id = ?').get(job.id)).toEqual({ status: 'failed', retryable: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE external_id = ?').get('manual-retry-real-source')).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });

    classifier.failing = false;
    const retryResponse = await app.inject({ method: 'POST', url: `/api/runtime/jobs/${job.id}/retry` });
    expect(retryResponse.statusCode).toBe(200);
    expect(retryResponse.json()).toMatchObject({ id: job.id, status: 'queued', attempts: 0 });
    expect(retryResponse.body).not.toContain('payload_json');
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 0, recovered: 0 });
    expect(database.raw.prepare('SELECT status FROM job WHERE id = ?').get(job.id)).toEqual({ status: 'completed' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE external_id = ?').get('manual-retry-real-source')).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
  });

  it('关闭数据库并重新建立 Service 后，仍能从耐久来源恢复失败的模型工作项', async () => {
    class AlwaysFailClassifier extends ScriptedClassifier {
      override async classify(): Promise<ClassificationResult> {
        throw new Error('temporary restart test failure');
      }
    }
    const root = mkdtempSync(join(tmpdir(), 'ai-pm-restart-runtime-'));
    const databasePath = join(root, 'runtime.sqlite');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: `file:${databasePath}`,
      TASK_MEMORY_ROOT: join(root, 'memory'),
    });
    const firstDatabase = new AppDatabase(databasePath, false);
    const firstAdapters = createAdapters(config);
    firstAdapters.classifier = new AlwaysFailClassifier();
    const firstService = new PmService(firstDatabase, firstAdapters, config);
    await expect(firstService.ingestSource(source('restart-source', '请分析活动A的留存数据。'))).rejects.toThrow('temporary restart test failure');
    const savedJob = firstDatabase.raw.prepare("SELECT id, status FROM job WHERE job_type = 'classify_source'").get() as { id: string; status: string };
    expect(savedJob.status).toBe('queued');
    firstDatabase.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), savedJob.id);
    firstDatabase.close();

    const secondDatabase = new AppDatabase(databasePath, false);
    const secondAdapters = createAdapters(config);
    secondAdapters.classifier = new ScriptedClassifier();
    const secondService = new PmService(secondDatabase, secondAdapters, config);
    await expect(secondService.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect(secondDatabase.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
    expect(secondDatabase.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(secondDatabase.raw.prepare('SELECT status FROM job WHERE id = ?').get(savedJob.id)).toEqual({ status: 'completed' });
    secondDatabase.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('记忆投影失败不回滚任务，并能在修复目录后重试', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-pm-memory-file-'));
    const badRoot = join(root, 'not-a-directory');
    writeFileSync(badRoot, 'occupied', 'utf8');
    const { service, database, app } = await makeHarness({ memoryRoot: badRoot });
    const first = await service.ingestSource(source('projection-failure', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const projection = service.getMemoryProjection(accepted.task!.id)!;
    expect(accepted.task).toBeTruthy();
    expect(projection.state).toBe('error');
    expect(projection.last_error).not.toContain(root);
    const config = (service as unknown as { config: { taskMemoryRoot: string } }).config;
    config.taskMemoryRoot = join(root, 'fixed-memory');
    const retried = service.projectTaskMemory(accepted.task!.id)!;
    expect(retried.state).toBe('ready');
    rmSync(root, { recursive: true, force: true });
  });

  it('清理重建只删除登记的旧投影文件，未知文件和用户附件保持不变', async () => {
    const { service, database, root, app } = await makeHarness();
    const first = await service.ingestSource(source('memory-rebuild-safe', '请分析活动A的留存数据。'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const projection = service.getMemoryProjection(task.id)!;
    const directory = join(root, 'memory', projection.relative_path);
    const updates = join(directory, 'updates');
    const oldManaged = join(updates, 'old-managed.md');
    const unknownFile = join(directory, 'my-notes.txt');
    const userAttachment = join(updates, 'user-attachment.txt');
    writeFileSync(oldManaged, 'old generated content', 'utf8');
    writeFileSync(unknownFile, 'keep me', 'utf8');
    writeFileSync(userAttachment, 'keep attachment', 'utf8');
    const managed = JSON.parse(service.getMemoryProjection(task.id)!.managed_files_json) as string[];
    database.raw.prepare('UPDATE memory_projection SET managed_files_json = ? WHERE task_id = ?')
      .run(JSON.stringify([...managed, 'updates/old-managed.md']), task.id);

    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/memory/rebuild` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'ready' });
    expect(existsSync(oldManaged)).toBe(false);
    expect(readFileSync(unknownFile, 'utf8')).toBe('keep me');
    expect(readFileSync(userAttachment, 'utf8')).toBe('keep attachment');
  });

  it('旧版空托管清单会从 updates/index.json 恢复，并只清理旧系统文件', async () => {
    const { service, database, root, app } = await makeHarness();
    const first = await service.ingestSource(source('memory-legacy-recovery', '请分析活动A的留存数据。'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const projection = service.getMemoryProjection(task.id)!;
    const directory = join(root, 'memory', projection.relative_path);
    const updates = join(directory, 'updates');
    const legacyEventId = 'legacy-event-obsolete';
    const legacyProposalId = 'legacy-proposal-obsolete';
    const oldEvent = join(updates, `${legacyEventId}.md`);
    const oldProposal = join(updates, `proposal-${legacyProposalId}.md`);
    const unknownAttachment = join(updates, 'user-attachment.txt');
    writeFileSync(oldEvent, 'obsolete event projection', 'utf8');
    writeFileSync(oldProposal, 'obsolete proposal projection', 'utf8');
    writeFileSync(unknownAttachment, 'keep attachment', 'utf8');
    writeFileSync(join(updates, 'index.json'), JSON.stringify({
      taskEvents: [{ id: legacyEventId }],
      confirmedRevisions: [{ proposalId: legacyProposalId }],
    }), 'utf8');
    database.raw.prepare(
      "UPDATE memory_projection SET managed_files_json = '[]', state = 'ready', checksum = ?, last_projected_at = ? WHERE task_id = ?",
    ).run('legacy-checksum', '2026-08-11T00:00:00.000Z', task.id);

    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/memory/rebuild` });
    expect(response.statusCode).toBe(200);
    expect(existsSync(oldEvent)).toBe(false);
    expect(existsSync(oldProposal)).toBe(false);
    expect(readFileSync(unknownAttachment, 'utf8')).toBe('keep attachment');
    const nextManaged = JSON.parse(service.getMemoryProjection(task.id)!.managed_files_json) as string[];
    expect(nextManaged).toContain('updates/index.json');
    expect(nextManaged).not.toContain(`updates/${legacyEventId}.md`);
  });

  it('任务记忆 updates 为 junction 时拒绝清理，不触碰外部文件', async () => {
    const { service, database, root, app } = await makeHarness();
    const first = await service.ingestSource(source('memory-rebuild-junction', '请分析活动A的留存数据。'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const projection = service.getMemoryProjection(task.id)!;
    const directory = join(root, 'memory', projection.relative_path);
    const updates = join(directory, 'updates');
    const outside = join(root, 'outside-updates');
    mkdirSync(outside, { recursive: true });
    const outsideFile = join(outside, 'do-not-delete.txt');
    writeFileSync(outsideFile, 'protected', 'utf8');
    rmSync(updates, { recursive: true, force: true });
    symlinkSync(outside, updates, 'junction');
    database.raw.prepare('UPDATE memory_projection SET managed_files_json = ? WHERE task_id = ?')
      .run(JSON.stringify(['updates/do-not-delete.txt']), task.id);

    const response = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/memory/rebuild` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'error' });
    expect(response.json().last_error).toContain('符号链接');
    expect(readFileSync(outsideFile, 'utf8')).toBe('protected');
  });

  it('任务记忆根目录的父级为 junction 时拒绝写入外部目录', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'ai-pm-memory-parent-link-'));
    const outside = join(fixture, 'outside');
    const linkedParent = join(fixture, 'linked-parent');
    mkdirSync(outside, { recursive: true });
    const protectedFile = join(outside, 'protected.txt');
    writeFileSync(protectedFile, 'protected', 'utf8');
    symlinkSync(outside, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const { service } = await makeHarness({ memoryRoot: join(linkedParent, 'not-created-yet') });
      const first = await service.ingestSource(source('memory-parent-junction', '请分析活动A的留存数据。'));
      const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
      const projection = service.getMemoryProjection(task.id)!;
      expect(projection.state).toBe('error');
      expect(projection.last_error).toContain('父目录');
      expect(readFileSync(protectedFile, 'utf8')).toBe('protected');
      expect(existsSync(join(outside, 'not-created-yet'))).toBe(false);
    } finally {
      rmSync(linkedParent, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('解除参考路径会级联删除快照，但不会触碰真实工作目录', async () => {
    const inspect = vi.fn(async (referencePath: string) => ({
      state: 'ready' as const,
      referencePath,
      entries: [{ relativePath: 'report.md', type: 'file' as const, size: 12, modifiedAt: baseTime }],
      truncated: false,
      inspectedAt: baseTime,
    }));
    const { service, database, root, app } = await makeHarness({ workspace: { kind: 'readonly_bridge' as const, inspect } });
    const first = await service.ingestSource(source('reference-unbind-safe', '请分析活动A的留存数据。'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const workspaceFile = join(root, 'workspace', 'report.md');
    writeFileSync(workspaceFile, 'real work file', 'utf8');
    const reference = service.addReference(task.id, '真实工作目录', join(root, 'workspace'), 'readonly') as { id: string };
    await service.inspectReference(task.id, reference.id);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM reference_snapshot WHERE reference_binding_id = ?').get(reference.id)).toEqual({ count: 1 });

    const response = await app.inject({ method: 'DELETE', url: `/api/tasks/${task.id}/references/${reference.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().references).toEqual([]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM reference_snapshot WHERE reference_binding_id = ?').get(reference.id)).toEqual({ count: 0 });
    expect(readFileSync(workspaceFile, 'utf8')).toBe('real work file');
  });

  it('任务记忆拒绝相对路径逃逸和符号链接，不会写入系统目录之外', async () => {
    const { service, database, root } = await makeHarness();
    const first = await service.ingestSource(source('projection-boundary', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const taskId = accepted.task!.id;
    const memoryRoot = join(root, 'memory');
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });

    const safeDirectory = service.resolveTaskMemoryDirectory(taskId);
    expect(statSync(safeDirectory).isDirectory()).toBe(true);

    database.raw.prepare("UPDATE memory_projection SET relative_path = '../outside/escaped' WHERE task_id = ?").run(taskId);
    expect(() => service.resolveTaskMemoryDirectory(taskId)).toThrow('相对路径');
    expect(service.projectTaskMemory(taskId)).toMatchObject({ state: 'error' });
    expect(existsSync(join(outside, 'escaped', 'task.json'))).toBe(false);

    const linkParent = join(memoryRoot, 'tasks');
    const linkPath = join(linkParent, 'linked-outside');
    mkdirSync(linkParent, { recursive: true });
    symlinkSync(outside, linkPath, 'junction');
    database.raw.prepare("UPDATE memory_projection SET relative_path = 'tasks/linked-outside/task' WHERE task_id = ?").run(taskId);
    const linked = service.projectTaskMemory(taskId)!;
    expect(linked).toMatchObject({ state: 'error' });
    expect(linked.last_error).toContain('符号链接');
    expect(existsSync(join(outside, 'task', 'task.json'))).toBe(false);
  });
});

describe('Issue #13 候选归并与主人主体任务', () => {
  it('跨旧 5 分钟窗口的流程咨询与明确分析任务会归并，并以主人实际要交付的分析为主体', async () => {
    const classifier = new PendingCandidateMergeClassifier((event) => event.content.includes('众筹箱')
      ? {
          sameRequirement: true,
          confidence: 0.98,
          scores: [0.98],
          primary: 'current',
          primaryConfidence: 0.99,
          currentRole: 'owner_delivery',
          targetRole: 'process_question',
        }
      : { sameRequirement: false });
    const { service, database } = await makeHarness({ classifier });

    const process = await service.ingestSource(source(
      'candidate-merge-process',
      '想咨询一下 924 版本看板与埋点需求应该走什么提需流程。',
      {},
      '2026-08-11T09:00:00.000Z',
    ));
    const analysis = await service.ingestSource(source(
      'candidate-merge-analysis',
      '请分析众筹箱功能提交次数，统计近 3 到 4 个版本每周提交量并输出结论。',
      {},
      '2026-08-11T09:05:42.000Z',
    ));

    expect(classifier.inputs.at(-1)?.candidateMergeContext?.candidates).toHaveLength(1);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 2 });
    const pending = service.listCandidates('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: analysis.candidate!.id, title: '众筹箱功能提交次数分析' });
    expect(pending[0]!.merge_group).toMatchObject({
      sourceCount: 2,
      candidateCount: 2,
      primaryCandidateId: analysis.candidate!.id,
      primaryTitle: '众筹箱功能提交次数分析',
    });
    expect(pending[0]!.merge_group!.primaryReason).toContain('主体');
    const roles = database.raw.prepare(
      `SELECT source_event.external_id, requirement_thread_source.source_role
       FROM requirement_thread_source JOIN source_event ON source_event.id = requirement_thread_source.source_event_id
       WHERE source_event.external_id IN ('candidate-merge-process','candidate-merge-analysis')
       ORDER BY source_event.external_id`,
    ).all();
    expect(roles).toEqual([
      { external_id: 'candidate-merge-analysis', source_role: 'owner_delivery' },
      { external_id: 'candidate-merge-process', source_role: 'process_question' },
    ]);
    expect(database.raw.prepare(
      `SELECT source_event.external_id
       FROM requirement_thread JOIN source_event ON source_event.id = requirement_thread.primary_source_event_id
       WHERE requirement_thread.status = 'open'`,
    ).get()).toEqual({ external_id: 'candidate-merge-analysis' });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'candidate_auto_merge'").get()).toEqual({ count: 1 });

    const accepted = service.actOnCandidate(analysis.candidate!.id, 'accept', undefined, service.getCandidate(analysis.candidate!.id)!.version, service.listCandidates('pending')[0]!.merge_group!.groupVersionHash);
    expect(accepted.task).toMatchObject({ title: '众筹箱功能提交次数分析' });
    expect(database.raw.prepare('SELECT COUNT(DISTINCT accepted_task_id) AS tasks, COUNT(*) AS candidates FROM candidate_request WHERE state = \'accepted\'').get())
      .toEqual({ tasks: 1, candidates: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_source_link WHERE task_id = ?').get(accepted.task!.id)).toEqual({ count: 2 });
    const acceptedGroup = service.listCandidates(undefined, 'all').find((candidate) => candidate.id === (service.getCandidate(process.candidate!.id)!.merged_into_candidate_id ?? process.candidate!.id))!;
    expect(service.actOnCandidate(process.candidate!.id, 'accept', undefined, service.getCandidate(process.candidate!.id)!.version, acceptedGroup.merge_group!.groupVersionHash).task?.id).toBe(accepted.task!.id);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
  });

  it('低置信归并只给建议，主人确认后可以更换主体并拆分误归并来源', async () => {
    const classifier = new PendingCandidateMergeClassifier((event) => event.content.includes('众筹箱')
      ? {
          sameRequirement: true,
          confidence: 0.82,
          scores: [0.82],
          primary: 'current',
          primaryConfidence: 0.84,
          currentRole: 'owner_delivery',
          targetRole: 'process_question',
        }
      : { sameRequirement: false });
    const { service, database, app } = await makeHarness({ classifier });
    const process = await service.ingestSource(source('candidate-suggest-process', '咨询 924 版本看板与埋点需求流程。'));
    const analysis = await service.ingestSource(source(
      'candidate-suggest-analysis',
      '请分析众筹箱功能提交次数并输出结论。',
      {},
      '2026-08-11T09:06:00.000Z',
    ));

    expect(service.listCandidates('pending')).toHaveLength(2);
    const suggested = service.listCandidates('pending').find((candidate) => candidate.id === analysis.candidate!.id)!;
    expect(suggested.merge_group!.suggestion).toMatchObject({ targetCandidateId: process.candidate!.id, confidence: 0.82, primary: 'current' });
    expect(database.raw.prepare('SELECT merged_into_candidate_id FROM candidate_request WHERE id = ?').get(analysis.candidate!.id))
      .toEqual({ merged_into_candidate_id: null });

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/candidates/${analysis.candidate!.id}/merge/confirm`,
      payload: {
        targetCandidateId: process.candidate!.id,
        primaryCandidateId: analysis.candidate!.id,
        suggestionId: suggested.merge_group!.suggestion!.suggestionId,
        expectedThreadVersion: suggested.merge_group!.threadVersion,
        expectedVersion: suggested.version,
        expectedTargetVersion: suggested.merge_group!.suggestion!.target!.version,
        expectedGroupVersionHash: suggested.merge_group!.mutationVersionHash,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(service.listCandidates('pending')).toHaveLength(1);
    expect(database.raw.prepare('SELECT merged_into_candidate_id FROM candidate_request WHERE id = ?').get(process.candidate!.id))
      .toEqual({ merged_into_candidate_id: analysis.candidate!.id });

    const primaryChanged = await app.inject({
      method: 'POST',
      url: `/api/candidates/${analysis.candidate!.id}/merge/primary`,
      payload: (() => {
        const current = service.listCandidates('pending').find((candidate) => candidate.id === analysis.candidate!.id)!;
        return {
          primaryCandidateId: process.candidate!.id,
          expectedVersion: service.getCandidate(analysis.candidate!.id)!.version,
          expectedThreadVersion: current.merge_group!.threadVersion,
          expectedGroupVersionHash: current.merge_group!.groupVersionHash,
        };
      })(),
    });
    expect(primaryChanged.statusCode).toBe(200);
    expect(service.listCandidates('pending')).toMatchObject([{ id: process.candidate!.id, title: '924版本看板与埋点需求流程咨询' }]);
    expect(database.raw.prepare(
      'SELECT id, merged_into_candidate_id FROM candidate_request ORDER BY id',
    ).all()).toEqual(expect.arrayContaining([
      { id: process.candidate!.id, merged_into_candidate_id: null },
      { id: analysis.candidate!.id, merged_into_candidate_id: process.candidate!.id },
    ]));

    const splitView = service.listCandidates('pending')[0]!;
    const split = await app.inject({ method: 'POST', url: `/api/candidates/${analysis.candidate!.id}/merge/split`, payload: { expectedVersion: service.getCandidate(analysis.candidate!.id)!.version, expectedThreadVersion: splitView.merge_group!.threadVersion, expectedGroupVersionHash: splitView.merge_group!.groupVersionHash } });
    expect(split.statusCode, split.body).toBe(200);
    expect(service.listCandidates('pending')).toHaveLength(2);
    expect(database.raw.prepare('SELECT id, merged_into_candidate_id FROM candidate_request ORDER BY id').all())
      .toEqual(expect.arrayContaining([
        { id: process.candidate!.id, merged_into_candidate_id: null },
        { id: analysis.candidate!.id, merged_into_candidate_id: null },
      ]));
    const threads = database.raw.prepare(
      `SELECT source_event.external_id, requirement_thread_source.thread_id
       FROM requirement_thread_source JOIN source_event ON source_event.id = requirement_thread_source.source_event_id
       WHERE source_event.external_id IN ('candidate-suggest-process','candidate-suggest-analysis')`,
    ).all() as Array<{ external_id: string; thread_id: string }>;
    expect(new Set(threads.map((row) => row.thread_id)).size).toBe(2);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type IN ('candidate_owner_merge','candidate_primary_changed','candidate_split')").get())
      .toEqual({ count: 3 });
  });

  it('低置信归并建议可以明确否决，并保留两条独立候选与纠错审计', async () => {
    const classifier = new PendingCandidateMergeClassifier((event) => event.content.includes('众筹箱')
      ? {
          sameRequirement: true,
          confidence: 0.81,
          scores: [0.81],
          primary: 'current',
          primaryConfidence: 0.85,
          currentRole: 'owner_delivery',
          targetRole: 'background',
        }
      : { sameRequirement: false });
    const { service, database, app } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('candidate-reject-first', '请说明 924 版本看板流程。'));
    const second = await service.ingestSource(source('candidate-reject-second', '请分析众筹箱提交次数。'));
    const rejectedView = service.listCandidates('pending')
      .find((candidate) => candidate.id === second.candidate!.id)!;
    const suggestionId = rejectedView.merge_group!.suggestion!.suggestionId;
    const response = await app.inject({
      method: 'POST',
      url: `/api/candidates/${second.candidate!.id}/merge/reject`,
      payload: { targetCandidateId: first.candidate!.id, suggestionId, expectedVersion: rejectedView.version, expectedTargetVersion: service.getCandidate(first.candidate!.id)!.version, expectedGroupVersionHash: rejectedView.merge_group!.mutationVersionHash },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ separateCandidates: true });
    const pending = service.listCandidates('pending');
    expect(pending).toHaveLength(2);
    expect(pending.find((candidate) => candidate.id === second.candidate!.id)?.merge_group?.suggestion).toBeNull();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request WHERE merged_into_candidate_id IS NOT NULL').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_merge_exclusion').get()).toEqual({ count: 1 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'candidate_merge_rejected'").get()).toEqual({ count: 1 });

    await service.ingestSource(source(
      'candidate-reject-second',
      '请分析众筹箱提交次数并补充每周趋势。',
      { version: 2 },
    ));
    const refreshed = service.listCandidates('pending').find((candidate) => candidate.id === second.candidate!.id)!;
    expect(refreshed.merge_group!.suggestion).toBeNull();
    expect(classifier.inputs.at(-1)?.candidateMergeContext?.candidates.some((candidate) => candidate.candidateId === first.candidate!.id)).toBe(false);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request WHERE merged_into_candidate_id IS NOT NULL').get()).toEqual({ count: 0 });
  });

  it('低置信建议生成后任一候选或线程变化时，旧页面确认必须返回 409 且零写入', async () => {
    const classifier = new PendingCandidateMergeClassifier((event) => event.content.includes('众筹箱')
      ? {
          sameRequirement: true,
          confidence: 0.82,
          scores: [0.82],
          primary: 'current',
          primaryConfidence: 0.84,
          currentRole: 'owner_delivery',
          targetRole: 'process_question',
        }
      : { sameRequirement: false });
    const { service, database, app } = await makeHarness({ classifier });
    const first = await service.ingestSource(source('candidate-stale-first', '咨询 924 版本看板流程。'));
    const second = await service.ingestSource(source('candidate-stale-second', '请分析众筹箱提交次数。'));
    const stale = service.listCandidates('pending').find((candidate) => candidate.id === second.candidate!.id)!;

    database.raw.prepare('UPDATE requirement_thread SET version = version + 1, updated_at = ? WHERE id = ?')
      .run('2026-08-13T04:00:00.000Z', stale.merge_group!.threadId);
    const response = await app.inject({
      method: 'POST',
      url: `/api/candidates/${second.candidate!.id}/merge/confirm`,
      payload: {
        targetCandidateId: first.candidate!.id,
        primaryCandidateId: second.candidate!.id,
        suggestionId: stale.merge_group!.suggestion!.suggestionId,
        expectedThreadVersion: stale.merge_group!.threadVersion,
        expectedVersion: stale.version,
        expectedTargetVersion: stale.merge_group!.suggestion!.target!.version,
        expectedGroupVersionHash: stale.merge_group!.mutationVersionHash,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('变化');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request WHERE merged_into_candidate_id IS NOT NULL').get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'candidate_owner_merge'").get()).toEqual({ count: 0 });
  });

  it('拆分连续消息候选时会整体迁移完整分类批次，并重算两边线程摘要', async () => {
    const classifier = new PendingCandidateMergeClassifier((event) => event.content.includes('众筹箱')
      ? {
          sameRequirement: true,
          confidence: 0.98,
          scores: [0.98],
          primary: 'current',
          primaryConfidence: 0.99,
          currentRole: 'owner_delivery',
          targetRole: 'process_question',
        }
      : { sameRequirement: false });
    const { service, database, app } = await makeHarness({ classifier });
    const process = await service.ingestSource(source('candidate-batch-process', '咨询 924 版本看板流程。', {}, '2026-08-11T09:00:00.000Z'));
    const batch = await service.ingestSourceBatch([
      source('candidate-batch-analysis', '请分析众筹箱提交次数。', { participantIds: ['owner', 'requester'] }, '2026-08-11T09:06:00.000Z'),
      source('candidate-batch-detail', '另外补充每周趋势。', { participantIds: ['owner', 'requester'] }, '2026-08-11T09:08:00.000Z'),
    ]);
    const analysis = batch.candidates[0]!;
    expect(service.listCandidates('pending')).toHaveLength(1);

    const splitView = service.listCandidates('pending')[0]!;
    const split = await app.inject({ method: 'POST', url: `/api/candidates/${analysis.id}/merge/split`, payload: { expectedVersion: service.getCandidate(analysis.id)!.version, expectedThreadVersion: splitView.merge_group!.threadVersion, expectedGroupVersionHash: splitView.merge_group!.groupVersionHash } });
    expect(split.statusCode, split.body).toBe(200);
    expect(service.listCandidates('pending')).toHaveLength(2);
    const threadRows = database.raw.prepare(
      `SELECT source_event.external_id, requirement_thread_source.thread_id, requirement_thread_source.relation_type
       FROM requirement_thread_source JOIN source_event ON source_event.id = requirement_thread_source.source_event_id
       WHERE source_event.external_id IN ('candidate-batch-process','candidate-batch-analysis','candidate-batch-detail')
       ORDER BY source_event.external_id`,
    ).all() as Array<{ external_id: string; thread_id: string; relation_type: string }>;
    const analysisThread = threadRows.find((row) => row.external_id === 'candidate-batch-analysis')!.thread_id;
    expect(threadRows.find((row) => row.external_id === 'candidate-batch-detail')).toMatchObject({ thread_id: analysisThread, relation_type: 'owner_split_batch' });
    expect(threadRows.find((row) => row.external_id === 'candidate-batch-process')!.thread_id).not.toBe(analysisThread);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread_source WHERE thread_id = ?').get(analysisThread)).toEqual({ count: 2 });
    const splitThread = database.raw.prepare('SELECT participant_ids_json, last_activity_at FROM requirement_thread WHERE id = ?').get(analysisThread) as { participant_ids_json: string; last_activity_at: string };
    expect(JSON.parse(splitThread.participant_ids_json)).toEqual(expect.arrayContaining(['owner', 'requester']));
    expect(splitThread.last_activity_at).toBe('2026-08-11T09:08:00.000Z');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread_revision WHERE thread_id <> ? AND state = \'proposed\' AND source_event_id IN (SELECT id FROM source_event WHERE external_id IN (\'candidate-batch-analysis\',\'candidate-batch-detail\'))').get(analysisThread))
      .toEqual({ count: 0 });
    expect(process.candidate).toBeTruthy();
  });

  it('同一私聊或时间接近但交付目标不同，不会自动归并', async () => {
    const classifier = new PendingCandidateMergeClassifier(() => ({ sameRequirement: false }));
    const { service, database } = await makeHarness({ classifier });
    await service.ingestSource(source('candidate-independent-a', '请分析活动A留存并输出复盘。', {}, '2026-08-11T09:00:00.000Z'));
    await service.ingestSource(source('candidate-independent-b', '请分析活动B付费并设计看板。', {}, '2026-08-11T09:01:00.000Z'));
    expect(service.listCandidates('pending')).toHaveLength(2);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request WHERE merged_into_candidate_id IS NOT NULL').get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'candidate_auto_merge'").get()).toEqual({ count: 0 });
  });
});

describe('Issue #11 连续消息耐久批次', () => {
  it('同一会话同一发送人的 5 分钟连续消息逐条保存，但只调用一次分类并共同关联任务', async () => {
    const classifier = new CountingClassifier();
    const { service, database } = await makeHarness({ classifier });
    const events = [
      source('batch-first', '请分析活动A的留存数据。', {}, '2026-08-11T09:00:00.000Z'),
      source('batch-second', '另外，还需要加入付费维度。', {}, '2026-08-11T09:03:00.000Z'),
    ];

    const result = await service.ingestSourceBatch(events);

    expect(result).toMatchObject({ messages: 2, deduplicated: 0, classifications: 1, classificationFailures: 0 });
    expect(classifier.inputs).toHaveLength(1);
    expect(classifier.inputs[0]!.content).toContain('请分析活动A的留存数据');
    expect(classifier.inputs[0]!.content).toContain('加入付费维度');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(DISTINCT thread_id) AS count FROM requirement_thread_source').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread_source').get()).toEqual({ count: 2 });

    const candidate = result.candidates[0]!;
    const accepted = service.actOnCandidate(candidate.id, 'accept', undefined, service.getCandidate(candidate.id)!.version);
    expect(accepted.task).toBeTruthy();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_source_link WHERE task_id = ?').get(accepted.task!.id)).toEqual({ count: 2 });

    const duplicate = await service.ingestSourceBatch(events);
    expect(duplicate).toMatchObject({ messages: 2, deduplicated: 2, classifications: 0, classificationFailures: 0 });
    expect(classifier.inputs).toHaveLength(1);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM job WHERE job_type = 'classify_source_batch'").get()).toEqual({ count: 1 });
  });

  it('跨 5 分钟、不同发送人和冲突回复根保持独立，乱序输入仍按时间与 externalId 稳定排序', async () => {
    const classifier = new CountingClassifier();
    const { service } = await makeHarness({ classifier });
    const event = (externalId: string, occurredAt: string, senderId: string, metadata: Record<string, unknown> = {}) => ({
      ...source(externalId, `请分析 ${externalId} 数据。`, metadata, occurredAt),
      senderId,
    });

    const result = await service.ingestSourceBatch([
      event('later', '2026-08-11T09:03:00.000Z', 'sender-a'),
      event('same-time-b', '2026-08-11T09:00:00.000Z', 'sender-a'),
      event('same-time-a', '2026-08-11T09:00:00.000Z', 'sender-a'),
      event('other-sender', '2026-08-11T09:02:00.000Z', 'sender-b'),
      event('too-late', '2026-08-11T09:20:00.000Z', 'sender-a'),
      event('root-a', '2026-08-11T10:00:00.000Z', 'sender-a', { rootId: 'root-a' }),
      event('root-b', '2026-08-11T10:01:00.000Z', 'sender-a', { rootId: 'root-b' }),
    ]);

    expect(result.classifications).toBe(5);
    expect(classifier.inputs).toHaveLength(5);
    const combined = classifier.inputs.find((input) => input.content.includes('same-time-a') && input.content.includes('later'))!;
    expect(combined.content.indexOf('same-time-a')).toBeLessThan(combined.content.indexOf('same-time-b'));
    expect(combined.content.indexOf('same-time-b')).toBeLessThan(combined.content.indexOf('later'));
  });

  it('日历与妙记即使同批进入也保持 singleton，不按共同会话误合并', async () => {
    const classifier = new CountingClassifier();
    const { service } = await makeHarness({ classifier });
    const result = await service.ingestSourceBatch([
      { ...source('calendar-a', '日程：活动复盘', {}, '2026-08-11T09:00:00.000Z'), sourceType: 'calendar', conversationId: 'calendar:primary' },
      { ...source('calendar-b', '日程：版本复盘', {}, '2026-08-11T09:01:00.000Z'), sourceType: 'calendar', conversationId: 'calendar:primary' },
      { ...source('minutes-a', '会议纪要：活动分析', {}, '2026-08-11T09:02:00.000Z'), sourceType: 'meeting', conversationId: 'minutes:a' },
    ]);
    expect(result.classifications).toBe(3);
    // Calendar events take the deterministic PROD-07 route before the model;
    // only the meeting-note source needs the classifier here. This keeps the
    // singleton guarantee while preventing calendar facts from becoming
    // model-generated candidates.
    expect(classifier.inputs).toHaveLength(1);
    expect(classifier.inputs[0]?.sourceType).toBe('meeting');
    expect(service.calendarSources({ route: 'calendar_fact' }).items).toHaveLength(2);
  });

  it('批次模型失败时保留全部来源，Runtime 恢复后只生成一条决策和候选', async () => {
    class RecoveringBatchClassifier extends CountingClassifier {
      failures = 1;
      override async classify(event: NormalizedSourceEvent, guidance?: string) {
        if (this.failures-- > 0) throw new Error('temporary batch classifier failure');
        return super.classify(event, guidance);
      }
    }
    const classifier = new RecoveringBatchClassifier();
    const { service, database } = await makeHarness({ classifier });
    const events = [
      source('recover-batch-first', '请分析活动A留存数据。', {}, '2026-08-11T09:00:00.000Z'),
      source('recover-batch-second', '另外补充付费维度。', {}, '2026-08-11T09:02:00.000Z'),
    ];

    const first = await service.ingestSourceBatch(events);
    expect(first).toMatchObject({ messages: 2, classificationFailures: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 2 });
    expect(database.raw.prepare("SELECT status, attempts FROM job WHERE job_type = 'classify_source_batch'").get()).toMatchObject({ status: 'queued', attempts: 1 });

    database.raw.prepare("UPDATE job SET available_at = ? WHERE job_type = 'classify_source_batch'").run(new Date(Date.now() - 1_000).toISOString());
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread_source').get()).toEqual({ count: 2 });
    expect(database.raw.prepare("SELECT status FROM job WHERE job_type = 'classify_source_batch'").get()).toEqual({ status: 'completed' });

    const duplicate = await service.ingestSourceBatch(events);
    expect(duplicate.classifications).toBe(0);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual({ count: 1 });
  });
});

describe('Issue #21 连续对话承接与时间范围边界', () => {
  it('兼容适配器没有返回 LLM 归并结果时，程序不猜测唯一候选', async () => {
    const classifier = new ScriptedClassifier();
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource(source(
      'issue-21-continuation-first',
      '请分析活动A留存数据并输出结论。',
      {},
      '2026-08-11T09:00:00.000Z',
    ));
    const second = await service.ingestSource(source(
      'issue-21-continuation-schedule',
      '下周一能给到吗？',
      {},
      '2026-08-11T09:12:00.000Z',
    ));

    expect(first.candidate).toBeTruthy();
    expect(second.candidate).toBeTruthy();
    expect(second.candidate?.id).not.toBe(first.candidate?.id);
    expect(service.listCandidates('pending')).toHaveLength(2);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM candidate_request WHERE merged_into_candidate_id IS NOT NULL',
    ).get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread_source').get()).toEqual({ count: 2 });
  });

  it('明确说是新需求时，即使同一私聊也不会被唯一候选兜底归并', async () => {
    const { service, database } = await makeHarness({ classifier: new ScriptedClassifier() });
    await service.ingestSource(source(
      'issue-21-new-demand-first',
      '请分析活动A留存数据。',
      {},
      '2026-08-11T09:00:00.000Z',
    ));
    await service.ingestSource(source(
      'issue-21-new-demand-second',
      '新建另一个需求：请分析活动B付费数据。',
      {},
      '2026-08-11T09:12:00.000Z',
    ));

    expect(service.listCandidates('pending')).toHaveLength(2);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM candidate_request WHERE merged_into_candidate_id IS NOT NULL',
    ).get()).toEqual({ count: 0 });
  });

  it('超过 30 分钟的短句不凭唯一候选自动续接', async () => {
    const { service, database } = await makeHarness({ classifier: new ScriptedClassifier() });
    await service.ingestSource(source(
      'issue-21-window-first',
      '请分析活动A留存数据。',
      {},
      '2026-08-11T09:00:00.000Z',
    ));
    await service.ingestSource(source(
      'issue-21-window-late',
      '下周一能给到吗？',
      {},
      '2026-08-11T09:31:00.000Z',
    ));

    expect(service.listCandidates('pending')).toHaveLength(2);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM candidate_request WHERE merged_into_candidate_id IS NOT NULL',
    ).get()).toEqual({ count: 0 });
  });

  it('模型明确判断为独立需求时，不被唯一候选连续对话兜底覆盖', async () => {
    const classifier = new PendingCandidateMergeClassifier(() => ({ sameRequirement: false }));
    const { service, database } = await makeHarness({ classifier });
    await service.ingestSource(source(
      'issue-21-explicit-independent-first',
      '请分析活动A留存数据。',
      {},
      '2026-08-11T09:00:00.000Z',
    ));
    await service.ingestSource(source(
      'issue-21-explicit-independent-second',
      '可以，但这是另一个需求：下周一给到吗？',
      {},
      '2026-08-11T09:12:00.000Z',
    ));

    expect(service.listCandidates('pending')).toHaveLength(2);
    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM candidate_request WHERE merged_into_candidate_id IS NOT NULL',
    ).get()).toEqual({ count: 0 });
  });
});

describe('Issue #15 结构失败自动恢复', () => {
  it('旧版 0% 故障占位仍留在数据库，但不会再显示为候选任务卡', async () => {
    class LegacyPlaceholderClassifier extends ScriptedClassifier {
      override async classify(event: NormalizedSourceEvent, guidance?: string): Promise<ClassificationResult> {
        const result = await super.classify(event, guidance);
        return {
          ...result,
          outcome: 'rule_final',
          draft: {
            title: 'AI 整理待重试',
            proposerName: event.senderName,
            background: '',
            validationQuestion: '',
            describe: '',
            confidence: 0,
          },
        };
      }
    }
    const { service, database } = await makeHarness({ classifier: new LegacyPlaceholderClassifier() });
    await service.ingestSource(source('legacy-placeholder', '请分析活动留存数据。'));
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(service.listCandidates('pending')).toEqual([]);
  });

  it('来源级重试接口只唤醒原有工作项，不暴露 Runtime 内部标识', async () => {
    class AlwaysProvisionalClassifier extends ScriptedClassifier {
      override async classify(event: NormalizedSourceEvent, guidance?: string): Promise<ClassificationResult> {
        const result = await super.classify(event, guidance);
        return {
          ...result,
          outcome: 'rule_provisional',
          usedFallback: true,
          reason: '模型结构仍未通过校验，已保留明确需求并等待自动重试。',
          errorCode: 'ZodError',
        };
      }
    }

    const { service, database, app } = await makeHarness({ classifier: new AlwaysProvisionalClassifier() });
    const event = source('issue-15-source-retry-api', '请分析活动留存数据并验证是否继续投入。');
    const first = await service.ingestSource(event);
    const sourceRow = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get(event.externalId) as { id: string };
    const initialJob = database.raw.prepare(
      "SELECT id, status, available_at FROM job WHERE job_type = 'classify_source'",
    ).get() as { id: string; status: string; available_at: string };
    expect(first).toMatchObject({ classificationDeferred: true, candidate: { id: expect.any(String) } });
    expect(initialJob.status).toBe('queued');

    const retried = await app.inject({
      method: 'POST',
      url: `/api/sources/${sourceRow.id}/classification/retry`,
      payload: { expectedVersion: service.getCandidate(first.candidate!.id)!.version },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toEqual({
      sourceEventId: sourceRow.id,
      status: 'queued',
      message: '已加入 AI 自动重试队列。',
    });
    expect(retried.json()).not.toHaveProperty('jobId');
    expect(retried.json()).not.toHaveProperty('payload_json');
    expect(database.raw.prepare('SELECT id, status, available_at FROM job WHERE job_type = \'classify_source\'').get()).toMatchObject({
      id: initialJob.id,
      status: 'queued',
    });
    expect(Date.parse((database.raw.prepare('SELECT available_at FROM job WHERE id = ?').get(initialJob.id) as { available_at: string }).available_at))
      .toBeLessThanOrEqual(Date.now() + 1_000);

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/sources/${sourceRow.id}/classification/retry`,
      payload: { expectedVersion: service.getCandidate(first.candidate!.id)!.version },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ sourceEventId: sourceRow.id, status: 'queued' });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM job WHERE job_type = 'classify_source'").get()).toEqual({ count: 1 });

    const missing = await app.inject({
      method: 'POST',
      url: '/api/sources/source-does-not-exist/classification/retry',
      payload: { expectedVersion: 1 },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: '来源消息不存在。' });
  });

  it('已完成来源再次请求时返回无需重试，且不创建新的工作项', async () => {
    const { service, database, app } = await makeHarness();
    const event = source('issue-15-completed-source', '请分析活动付费数据并输出结论。');
    const result = await service.ingestSource(event);
    const sourceRow = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get(event.externalId) as { id: string };
    expect(result.candidate).toBeTruthy();

    const response = await app.inject({
      method: 'POST',
      url: `/api/sources/${sourceRow.id}/classification/retry`,
      payload: { expectedVersion: result.candidate!.version },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sourceEventId: sourceRow.id,
      status: 'completed',
      message: '这个来源已经完成整理，无需重复重试。',
    });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 1 });
  });

  it('明确需求先显示暂定候选，Runtime 成功后原地恢复且重复投递不重复建档', async () => {
    class ProvisionalThenValidClassifier extends ScriptedClassifier {
      calls = 0;

      override async classify(event: NormalizedSourceEvent, guidance?: string): Promise<ClassificationResult> {
        this.calls += 1;
        const valid = await super.classify(event, guidance);
        if (this.calls > 1) return { ...valid, outcome: 'valid' };
        return {
          ...valid,
          outcome: 'rule_provisional',
          usedFallback: true,
          reason: '模型结构仍未通过校验，已保留明确需求并等待自动重试。',
          errorCode: 'ZodError',
        };
      }
    }

    const classifier = new ProvisionalThenValidClassifier();
    const { service, database } = await makeHarness({ classifier });
    const event = source('issue-15-provisional', '我需要一个海外大客户 ID 看板，按区服拆分。');

    const first = await service.ingestSource(event);
    expect(first).toMatchObject({ classificationDeferred: true, candidate: { id: expect.any(String) } });
    const candidateId = first.candidate!.id;
    const sourceRow = database.raw.prepare('SELECT id, metadata_json FROM source_event WHERE external_id = ?').get(event.externalId) as { id: string; metadata_json: string };
    const job = database.raw.prepare(
      "SELECT id, status, attempts, retryable, available_at, updated_at FROM job WHERE job_type = 'classify_source'",
    ).get() as { id: string; status: string; attempts: number; retryable: number; available_at: string; updated_at: string };
    expect(job).toMatchObject({ status: 'queued', attempts: 1, retryable: 1 });
    expect(Date.parse(job.available_at)).toBeGreaterThan(Date.parse(job.updated_at));
    expect(database.raw.prepare(
      'SELECT processing_state, processing_job_id, processing_error, recovered_at FROM candidate_request WHERE id = ?',
    ).get(candidateId)).toMatchObject({
      processing_state: 'retry_waiting',
      processing_job_id: job.id,
      processing_error: expect.stringContaining('等待自动重试'),
      recovered_at: null,
    });
    expect(JSON.parse(sourceRow.metadata_json)).not.toHaveProperty('classificationRevision');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM job_source_link WHERE job_id = ? AND source_event_id = ?').get(job.id, sourceRow.id)).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_revision').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread').get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_checkpoint WHERE job_id = ? AND step = 'classification_retry_waiting'").get(job.id)).toEqual({ count: 1 });

    database.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id);
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });

    expect(database.raw.prepare(
      'SELECT id, processing_state, processing_job_id, processing_error, recovered_at FROM candidate_request',
    ).get()).toMatchObject({
      id: candidateId,
      processing_state: 'recovered',
      processing_job_id: null,
      processing_error: null,
      recovered_at: expect.any(String),
    });
    expect(database.raw.prepare('SELECT status, attempts FROM job WHERE id = ?').get(job.id)).toEqual({ status: 'completed', attempts: 2 });
    expect(JSON.parse((database.raw.prepare('SELECT metadata_json FROM source_event WHERE id = ?').get(sourceRow.id) as { metadata_json: string }).metadata_json)).toHaveProperty('classificationRevision');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM job_source_link').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_revision').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread_source').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual({ count: 2 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM runtime_checkpoint WHERE job_id = ? AND step = 'classification_recovered'").get(job.id)).toEqual({ count: 1 });
    expect(classifier.calls).toBe(2);

    const duplicate = await service.ingestSource(event);
    expect(duplicate).toMatchObject({ deduplicated: true, candidate: { id: candidateId } });
    expect(classifier.calls).toBe(2);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 1 });
  });

  it('结构失败达到最大重试次数后仍保留为可见候选，不会固化为“不是需求”', async () => {
    class AlwaysProvisionalClassifier extends ScriptedClassifier {
      override async classify(event: NormalizedSourceEvent, guidance?: string): Promise<ClassificationResult> {
        const valid = await super.classify(event, guidance);
        return {
          ...valid,
          outcome: 'rule_provisional',
          usedFallback: true,
          reason: '结构校验持续失败，已保留候选并等待人工或后续恢复。',
          errorCode: 'ZodError',
        };
      }
    }

    const { service, database } = await makeHarness({ classifier: new AlwaysProvisionalClassifier() });
    const event = source('issue-15-retry-exhausted', '请做一个活动留存看板，按区域拆分并输出结论。');
    const first = await service.ingestSource(event);
    expect(first).toMatchObject({ classificationDeferred: true, candidate: { id: expect.any(String) } });
    const candidateId = first.candidate!.id;
    const job = database.raw.prepare(
      "SELECT id, status, attempts, retryable FROM job WHERE job_type = 'classify_source'",
    ).get() as { id: string; status: string; attempts: number; retryable: number };
    expect(job).toMatchObject({ status: 'queued', attempts: 1, retryable: 1 });

    for (const expectedAttempt of [2, 3]) {
      database.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id);
      await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 0 });
      expect((database.raw.prepare('SELECT attempts FROM job WHERE id = ?').get(job.id) as { attempts: number }).attempts)
        .toBe(expectedAttempt);
    }

    expect(database.raw.prepare('SELECT status, attempts, retryable FROM job WHERE id = ?').get(job.id)).toEqual({
      status: 'failed',
      attempts: 3,
      retryable: 0,
    });
    expect(database.raw.prepare('SELECT state, processing_state, processing_error FROM candidate_request WHERE id = ?').get(candidateId))
      .toMatchObject({
        state: 'pending',
        processing_state: 'failed_visible',
        processing_error: expect.stringContaining('结构校验持续失败'),
      });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM candidate_request WHERE state = 'ignored'").get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual({ count: 3 });
  });

  it('进程重启后仍能继续恢复结构失败工作项，并沿用同一候选', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-pm-structural-restart-'));
    const databasePath = join(root, 'runtime.sqlite');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: `file:${databasePath}`,
      TASK_MEMORY_ROOT: join(root, 'memory'),
    });

    class ProvisionalClassifier extends ScriptedClassifier {
      override async classify(event: NormalizedSourceEvent, guidance?: string): Promise<ClassificationResult> {
        const valid = await super.classify(event, guidance);
        return {
          ...valid,
          outcome: 'rule_provisional',
          usedFallback: true,
          reason: '重启前结构校验失败，等待 Runtime 恢复。',
          errorCode: 'ZodError',
        };
      }
    }

    const firstDatabase = new AppDatabase(databasePath, false);
    const firstAdapters = createAdapters(config);
    firstAdapters.classifier = new ProvisionalClassifier();
    const firstService = new PmService(firstDatabase, firstAdapters, config);
    const event = source('issue-15-structural-restart', '我需要一个按区域拆分的活动留存看板。');
    const first = await firstService.ingestSource(event);
    expect(first.candidate).toBeTruthy();
    const candidateId = first.candidate!.id;
    const savedJob = firstDatabase.raw.prepare(
      "SELECT id, status, attempts FROM job WHERE job_type = 'classify_source'",
    ).get() as { id: string; status: string; attempts: number };
    expect(savedJob).toMatchObject({ status: 'queued', attempts: 1 });
    firstDatabase.raw.prepare('UPDATE job SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), savedJob.id);
    firstDatabase.close();

    const secondDatabase = new AppDatabase(databasePath, false);
    const secondAdapters = createAdapters(config);
    secondAdapters.classifier = new ScriptedClassifier();
    const secondService = new PmService(secondDatabase, secondAdapters, config);
    await expect(secondService.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 1 });
    expect(secondDatabase.raw.prepare('SELECT status FROM job WHERE id = ?').get(savedJob.id)).toEqual({ status: 'completed' });
    expect(secondDatabase.raw.prepare('SELECT id, processing_state, recovered_at FROM candidate_request').get()).toMatchObject({
      id: candidateId,
      processing_state: 'recovered',
      recovered_at: expect.any(String),
    });
    expect(secondDatabase.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(secondDatabase.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
    secondDatabase.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('live 模型把连续对话写回同一需求线程，不再制造第二张候选卡', async () => {
    const { service, database } = await makeHarness({ classifier: new LiveThreadCentricClassifier() });
    const first = await service.ingestSource(source('thread-centric-first', '请分析活动A的留存数据。'));
    expect(first.candidate).toBeTruthy();
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    expect(accepted.task).toBeTruthy();
    const taskBefore = service.getTask(accepted.task!.id)!;

    const followUp = await service.ingestSource(source(
      'thread-centric-follow-up',
      '我来做，按下周一交付；收到策划案后核对具体口径。',
      { parentId: 'thread-centric-first' },
      '2026-08-11T10:00:00.000Z',
    ));

    expect(followUp.candidate).toBeNull();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare(
      `SELECT relation_type FROM requirement_thread_source
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = ?)`,
    ).get('thread-centric-follow-up')).toEqual({ relation_type: 'reply_parent' });

    const taskAfter = service.getTask(taskBefore.id)!;
    expect(taskAfter).toMatchObject({
      status: 'in_progress',
      planned_due_at: '2026-08-17T15:59:59.999Z',
      next_step: '收到策划案后核对具体口径。',
      version: taskBefore.version + 1,
    });
    expect(database.raw.prepare(
      `SELECT decision_mode, state, policy_reason FROM task_update_proposal
       WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(taskBefore.id)).toMatchObject({ decision_mode: 'auto', state: 'approved' });
    expect(database.raw.prepare(
      `SELECT json_extract(metadata_json, '$.messageAction') AS message_action
       FROM source_event WHERE external_id = ?`,
    ).get('thread-centric-follow-up')).toEqual({ message_action: 'update_existing' });
  });

  it('live 模型把礼貌上下文挂到已有线程，但不创建候选或任务更新提案', async () => {
    const { service, database } = await makeHarness({ classifier: new LiveContextOnlyClassifier() });
    const first = await service.ingestSource(source('context-only-first', '请分析活动A的留存数据。'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);

    const followUp = await service.ingestSource(source(
      'context-only-follow-up',
      '好的，收到，谢谢。',
      { parentId: 'context-only-first' },
      '2026-08-11T10:05:00.000Z',
    ));

    expect(followUp.candidate).toBeNull();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_update_proposal WHERE task_id = ?').get(accepted.task!.id)).toEqual({ count: 0 });
    expect(database.raw.prepare(
      `SELECT relation_type FROM requirement_thread_source
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = ?)`,
    ).get('context-only-follow-up')).toEqual({ relation_type: 'context_only' });
  });

  it('结构失败或规则降级不会进入线程中心化写入，来源仍等待 Runtime 重试', async () => {
    class FallbackLiveClassifier extends LiveThreadCentricClassifier {
      override async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
        const result = await super.classify(event);
        return { ...result, outcome: 'recoverable_error', usedFallback: true, messageAction: { action: 'update_existing', confidence: 0.99, evidence: ['fallback'], reason: '模型结构失败。' } };
      }
    }
    const { service, database } = await makeHarness({ classifier: new FallbackLiveClassifier() });
    const result = await service.ingestSource(source('fallback-thread-centric', '请分析活动A的留存数据。'));
    expect(result.candidate).toBeNull();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread_source').get()).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM job WHERE job_type = 'classify_source'").get()).toEqual({ count: 1 });
  });
});

describe('Issue #23 需求线程中心化长对话回放', () => {
  const dialogueSource = (externalId: string, content: string, conversationId: string, occurredAt: string) => ({
    ...source(externalId, content, {}, occurredAt),
    conversationId,
    senderId: 'requester-1',
    senderName: '需求方',
  });

  const titleIndex = (event: NormalizedSourceEvent, title: string) => {
    const index = event.classificationContext?.candidates.findIndex((candidate) => candidate.taskTitle.includes(title)) ?? -1;
    return index >= 0 ? index : null;
  };

  it('现场五轮对话：补充背景后由主人确认承接，并只生成一个任务', async () => {
    const classifier = new LiveDialogueClassifier((event) => {
      if (event.content.includes('需要查看小镇开服至今')) {
        return {
          action: 'new_demand',
          draftTitle: '小镇开服至今活跃及趋势分析',
          draftBackground: '新加入项目的数据分析同学需要了解小镇开服以来的整体表现。',
          draftValidationQuestion: '开服以来活跃如何变化，未来趋势和关注方向是什么？',
          draftDescribe: '整理小镇开服至今的活跃数据并分析后续趋势。',
          reason: '提出了明确的数据范围和趋势分析交付。',
        };
      }
      if (event.metadata?.isOwnerMessage === true && event.content.includes('啥背景')) {
        return {
          action: 'owner_action',
          pendingCandidateIndex: 0,
          ownerIntents: [{
            action: 'request_context', confidence: 0.99, summary: '询问需求背景。', delegateTo: null,
            scheduleText: null, evidence: ['啥背景？'], reason: '主人明确索要背景信息。',
          }],
          reason: '主人正在补齐需求背景。',
        };
      }
      if (event.metadata?.isOwnerMessage === true && event.content.includes('下周一给你')) {
        return {
          action: 'owner_action',
          pendingCandidateIndex: 0,
          ownerIntents: [
            { action: 'continue', confidence: 0.99, summary: '确认由主人承接。', delegateTo: null, scheduleText: null, evidence: ['也行吧'], reason: '主人明确同意推进。' },
            { action: 'confirm_schedule', confidence: 0.99, summary: '确认下周一交付。', delegateTo: null, scheduleText: '下周一', evidence: ['下周一给你'], reason: '主人明确确认交付时间。' },
          ],
          reason: '主人确认承接并给出交付时间。',
        };
      }
      return {
        action: 'update_existing',
        pendingCandidateIndex: 0,
        narrativeUpdates: event.content.includes('新来的数分')
          ? { threadBackground: { value: '需求方是新加入小镇项目的数据分析同学，需要快速了解历史表现。', mode: 'append', basis: 'fact', confidence: 0.99 } }
          : { threadDescribe: { value: '希望结合历史活跃判断未来走势。', mode: 'append', basis: 'fact', confidence: 0.99 } },
        reason: '需求方继续补充同一分析需求。',
      };
    });
    const { service, database } = await makeReplayHarness(classifier);
    const turns = [
      replayMessage('real-five-1', '需要查看小镇开服至今的活跃数据，希望下周给到。', 'requester', '2026-08-11T07:00:00.000Z'),
      replayMessage('real-five-2', '啥背景？', 'owner', '2026-08-11T07:01:00.000Z'),
      replayMessage('real-five-3', '我是小镇新来的数分。', 'requester', '2026-08-11T07:02:00.000Z'),
      replayMessage('real-five-4', '希望看下数据，分析一下未来的走向。', 'requester', '2026-08-11T07:03:00.000Z'),
      replayMessage('real-five-5', '也行吧，下周一给你。', 'owner', '2026-08-11T07:04:00.000Z'),
    ];
    for (const turn of turns) await service.ingestSourceBatch([turn]);

    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT state FROM candidate_request').get()).toEqual({ state: 'accepted' });
    expect(database.raw.prepare('SELECT title, status, planned_due_at FROM task').get()).toEqual({
      title: '小镇开服至今活跃及趋势分析',
      status: 'in_progress',
      planned_due_at: '2026-08-17T15:59:59.999Z',
    });
  });

  it('场景 1：无回复链的连续短句仍由 LLM 归入唯一已接受任务', async () => {
    const classifier = new LiveDialogueClassifier((event) => event.content.includes('请分析')
      ? { action: 'new_demand', reason: '提出活动A分析需求。' }
      : {
          action: 'update_existing',
          targetThreadIndex: titleIndex(event, '活动A'),
          timeRange: { status: 'relative_resolved', sourceText: '下周一', startAt: null, endAt: '2026-08-17T15:59:59.999Z', timezone: 'Asia/Shanghai', needsConfirmation: false },
          statusSuggestion: 'in_progress',
          nextStepSuggestion: '核对策划案。',
          reason: '连续对话补充了排期和下一步。',
        });
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource(dialogueSource('s1-first', '请分析活动A的留存数据。', 'dialogue-1', '2026-08-11T09:00:00.000Z'));
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const before = service.getTask(accepted.task!.id)!;
    const followUp = await service.ingestSource(dialogueSource('s1-follow', '下周一可以，我来做。', 'dialogue-1', '2026-08-11T10:00:00.000Z'));
    expect(followUp.candidate).toBeNull();
    expect(service.getTask(before.id)).toMatchObject({ status: 'in_progress', planned_due_at: '2026-08-17T15:59:59.999Z', version: before.version + 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
  });

  it('场景 2：同一私聊交错的两个需求分别更新自己的线程', async () => {
    const classifier = new LiveDialogueClassifier((event) => event.content.includes('请分析')
      ? { action: 'new_demand', reason: '提出独立分析需求。' }
      : {
          action: 'update_existing',
          targetThreadIndex: titleIndex(event, event.content.includes('活动B') ? '活动B' : '活动A'),
          statusSuggestion: 'in_progress',
          nextStepSuggestion: event.content.includes('活动B') ? '补齐活动B口径。' : '补齐活动A口径。',
          reason: '模型根据对象选择对应需求线程。',
        });
    const { service } = await makeHarness({ classifier });
    const a = await service.ingestSource(dialogueSource('s2-a', '请分析活动A的留存数据。', 'dialogue-2', '2026-08-11T09:00:00.000Z'));
    const taskA = service.actOnCandidate(a.candidate!.id, 'accept', undefined, service.getCandidate(a.candidate!.id)!.version).task!;
    const b = await service.ingestSource(dialogueSource('s2-b', '请分析活动B的留存数据。', 'dialogue-2', '2026-08-11T09:02:00.000Z'));
    const taskB = service.actOnCandidate(b.candidate!.id, 'accept', undefined, service.getCandidate(b.candidate!.id)!.version).task!;
    const versionA = service.getTask(taskA.id)!.version;
    const versionB = service.getTask(taskB.id)!.version;
    await service.ingestSource(dialogueSource('s2-a-follow', '活动A再补充一个留存口径。', 'dialogue-2', '2026-08-11T09:10:00.000Z'));
    await service.ingestSource(dialogueSource('s2-b-follow', '活动B再补充一个留存口径。', 'dialogue-2', '2026-08-11T09:12:00.000Z'));
    expect(service.getTask(taskA.id)!.version).toBe(versionA + 1);
    expect(service.getTask(taskB.id)!.version).toBe(versionB + 1);
    expect(service.getTask(taskA.id)!.next_step).toBe('补齐活动A口径。');
    expect(service.getTask(taskB.id)!.next_step).toBe('补齐活动B口径。');
  });

  it('场景 3：待接受候选收到补充时原地增加来源，不生成第二张卡', async () => {
    const classifier = new LiveDialogueClassifier((event) => event.content.includes('请分析')
      ? { action: 'new_demand', reason: '建立待确认候选。' }
      : {
          action: 'update_existing',
          pendingCandidateIndex: event.candidateMergeContext?.candidates.findIndex((candidate) => candidate.title.includes('活动A')) ?? null,
          narrativeUpdates: { threadDescribe: { value: '补充活动A的付费口径。', mode: 'append', basis: 'fact', confidence: 0.99 } },
          reason: '补充同一待确认需求。',
        });
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource(dialogueSource('s3-first', '请分析活动A的留存数据。', 'dialogue-3', '2026-08-11T09:00:00.000Z'));
    const follow = await service.ingestSource(dialogueSource('s3-follow', '补充活动A的付费口径。', 'dialogue-3', '2026-08-11T09:10:00.000Z'));
    expect(first.candidate).toBeTruthy();
    expect(follow.candidate).toBeNull();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare(
      `SELECT COUNT(*) AS count FROM source_demand_unit_source
       WHERE demand_unit_id = (SELECT demand_unit_id FROM candidate_request LIMIT 1)`,
    ).get()).toEqual({ count: 2 });
    expect(service.listCandidates('pending')[0]?.describe).toContain('补充活动A的付费口径。');
  });

  it('场景 4：两个候选分数接近时只进入待确认，不随机修改任务', async () => {
    const classifier = new LiveDialogueClassifier((event) => event.content.includes('请分析')
      ? { action: 'new_demand', reason: '建立独立需求。' }
      : {
          action: 'update_existing',
          targetThreadIndex: null,
          associationScores: [0.95, 0.94],
          reason: '两个需求都可能相关。',
        });
    const { service, database } = await makeHarness({ classifier });
    const a = await service.ingestSource(dialogueSource('s4-a', '请分析活动A的留存数据。', 'dialogue-4', '2026-08-11T09:00:00.000Z'));
    const taskA = service.actOnCandidate(a.candidate!.id, 'accept', undefined, service.getCandidate(a.candidate!.id)!.version).task!;
    const b = await service.ingestSource(dialogueSource('s4-b', '请分析活动B的留存数据。', 'dialogue-4', '2026-08-11T09:02:00.000Z'));
    const taskB = service.actOnCandidate(b.candidate!.id, 'accept', undefined, service.getCandidate(b.candidate!.id)!.version).task!;
    const before = [service.getTask(taskA.id)!.version, service.getTask(taskB.id)!.version];
    const result = await service.ingestSource(dialogueSource('s4-ambiguous', '再补充一个口径。', 'dialogue-4', '2026-08-11T09:10:00.000Z'));
    expect(result.candidate).toBeNull();
    expect(result.demandUnitIds).toHaveLength(1);
    expect([service.getTask(taskA.id)!.version, service.getTask(taskB.id)!.version]).toEqual(before);
    expect(service.listNotifications(true).some((item) => String(item.reason ?? '').includes('无法安全判断'))).toBe(true);
    const demandUnitId = result.demandUnitIds?.[0];
    expect(demandUnitId).toBeTruthy();
    expect(database.raw.prepare("SELECT state FROM source_demand_unit WHERE id = ?").get(demandUnitId!)).toEqual({ state: 'needs_confirmation' });
  });

  it('场景 5：明确“另一个新需求”时保持拆分并创建第二张候选', async () => {
    const classifier = new LiveDialogueClassifier((event) => event.content.includes('另一个新需求')
      ? { action: 'new_demand', reason: '明确声明另一个新需求。' }
      : event.content.includes('请分析')
        ? { action: 'new_demand', reason: '提出数据需求。' }
        : { action: 'update_existing', targetThreadIndex: titleIndex(event, '活动A'), reason: '继续原需求。' });
    const { service } = await makeHarness({ classifier });
    const first = await service.ingestSource(dialogueSource('s5-a', '请分析活动A的留存数据。', 'dialogue-5', '2026-08-11T09:00:00.000Z'));
    service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const second = await service.ingestSource(dialogueSource('s5-b', '另一个新需求：分析活动B的付费。', 'dialogue-5', '2026-08-11T09:10:00.000Z'));
    expect(second.candidate).toBeTruthy();
    expect(service.listCandidates('pending')).toHaveLength(1);
  });

  it('场景 6：跨越 30 天后明确提及原任务标题仍可恢复原线程', async () => {
    const classifier = new LiveDialogueClassifier((event) => event.content.includes('请分析')
      ? { action: 'new_demand', reason: '建立长期需求。' }
      : {
          action: 'update_existing',
          targetThreadIndex: titleIndex(event, '活动A'),
          nextStepSuggestion: '补充最新口径。',
          reason: '明确提及原任务标题。',
        });
    const { service } = await makeHarness({ classifier });
    const first = await service.ingestSource(dialogueSource('s6-first', '请分析活动A的留存数据。', 'dialogue-6', '2026-07-01T09:00:00.000Z'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const before = service.getTask(task.id)!.version;
    await service.ingestSource(dialogueSource('s6-follow', '活动A留存分析，今天补充新的口径。', 'dialogue-6', '2026-08-14T09:00:00.000Z'));
    expect(service.getTask(task.id)!.version).toBe(before + 1);
  });

  it('场景 7：跨越 30 天且没有明确引用时不自动归属', async () => {
    const classifier = new LiveDialogueClassifier((event) => event.content.includes('请分析')
      ? { action: 'new_demand', reason: '建立长期需求。' }
      : { action: 'update_existing', targetThreadIndex: 0, reason: '只有模糊的延续表达。' });
    const { service } = await makeHarness({ classifier });
    const first = await service.ingestSource(dialogueSource('s7-first', '请分析活动A的留存数据。', 'dialogue-7', '2026-07-01T09:00:00.000Z'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const before = service.getTask(task.id)!.version;
    const result = await service.ingestSource(dialogueSource('s7-follow', '补充一下最新口径。', 'dialogue-7', '2026-08-14T09:00:00.000Z'));
    expect(result.demandUnitIds).toHaveLength(1);
    expect(service.getTask(task.id)!.version).toBe(before);
    expect(service.listNotifications(true).some((item) => String(item.reason ?? '').includes('无法安全判断'))).toBe(true);
  });

  it('场景 8：预计 3—4 个版本只更新推进状态，不伪造日历日期', async () => {
    const classifier = new LiveDialogueClassifier((event) => event.content.includes('请分析')
      ? { action: 'new_demand', reason: '建立需求。' }
      : { action: 'update_existing', targetThreadIndex: titleIndex(event, '活动A'), statusSuggestion: 'in_progress', reason: '版本数量不是具体日期。' });
    const { service } = await makeHarness({ classifier });
    const first = await service.ingestSource(dialogueSource('s8-first', '请分析活动A的留存数据。', 'dialogue-8', '2026-08-11T09:00:00.000Z'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    await service.ingestSource(dialogueSource('s8-follow', '预计 3—4 个版本，先继续整理。', 'dialogue-8', '2026-08-11T10:00:00.000Z'));
    expect(service.getTask(task.id)).toMatchObject({ status: 'in_progress', planned_due_at: null });
  });

  it('场景 8b：需求方提出交付日期但模型返回未知时，不把提议写成主人计划', async () => {
    const classifier = new LiveDialogueClassifier((event) => event.content.includes('请分析')
      ? { action: 'new_demand', reason: '建立需求。' }
      : {
          action: 'update_existing',
          targetThreadIndex: titleIndex(event, '活动A'),
          statusSuggestion: 'in_progress',
          // Deliberately leave timeRange unset: the model did not determine
          // whether the requester merely proposed the date or the owner
          // actually confirmed it.
          reason: '需求方提出时间，但主人尚未确认。',
        });
    const { service } = await makeHarness({ classifier });
    const first = await service.ingestSource(dialogueSource('s8b-first', '请分析活动A的留存数据。', 'dialogue-8b', '2026-08-11T09:00:00.000Z'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    await service.ingestSource(dialogueSource('s8b-follow', '下周一能给到吗？', 'dialogue-8b', '2026-08-11T10:00:00.000Z'));
    expect(service.getTask(task.id)).toMatchObject({ status: 'in_progress', planned_due_at: null });
  });

  it('场景 9：重复投递同一来源不会重复任务版本、提案或来源关系', async () => {
    const classifier = new LiveDialogueClassifier((event) => event.content.includes('请分析')
      ? { action: 'new_demand', reason: '建立需求。' }
      : { action: 'update_existing', targetThreadIndex: titleIndex(event, '活动A'), statusSuggestion: 'in_progress', reason: '连续推进。' });
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource(dialogueSource('s9-first', '请分析活动A的留存数据。', 'dialogue-9', '2026-08-11T09:00:00.000Z'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const follow = dialogueSource('s9-follow', '继续补充活动A口径。', 'dialogue-9', '2026-08-11T10:00:00.000Z');
    await service.ingestSource(follow);
    const version = service.getTask(task.id)!.version;
    await service.ingestSource(follow);
    expect(service.getTask(task.id)!.version).toBe(version);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_update_proposal WHERE task_id = ?').get(task.id)).toEqual({ count: 1 });
    expect(database.raw.prepare(
      `SELECT COUNT(*) AS count FROM requirement_thread_source
       WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = ?)`,
    ).get('s9-follow')).toEqual({ count: 1 });
  });

  it('场景 10：低置信语义动作转为待确认，不允许 LLM 直接修改任务', async () => {
    const classifier = new LiveDialogueClassifier((event) => event.content.includes('请分析')
      ? { action: 'new_demand', reason: '建立需求。' }
      : { action: 'update_existing', targetThreadIndex: titleIndex(event, '活动A'), actionConfidence: 0.6, statusSuggestion: 'completed', reason: '模型只有低置信猜测。' });
    const { service, database } = await makeHarness({ classifier });
    const first = await service.ingestSource(dialogueSource('s10-first', '请分析活动A的留存数据。', 'dialogue-10', '2026-08-11T09:00:00.000Z'));
    const task = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version).task!;
    const before = service.getTask(task.id)!;
    const result = await service.ingestSource(dialogueSource('s10-follow', '应该差不多做完了吧。', 'dialogue-10', '2026-08-11T10:00:00.000Z'));
    expect(result.demandUnitIds).toHaveLength(1);
    expect(service.getTask(task.id)).toMatchObject({ status: before.status, version: before.version });
    expect(database.raw.prepare(
      `SELECT json_extract(metadata_json, '$.messageAction') AS action
       FROM source_event WHERE external_id = ?`,
    ).get('s10-follow')).toEqual({ action: 'uncertain' });
  });
});
