import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CandidateDraft, NormalizedSourceEvent } from '../src/domain.js';
import type { ClassifierAdapter, ClassificationResult } from '../src/integration-contracts.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

const baseTime = '2026-08-13T09:00:00.000Z';

function draft(title: string, describe: string): CandidateDraft {
  return {
    title,
    proposerName: '测试需求方',
    background: `${title} 的背景。`,
    validationQuestion: `${title} 是否值得继续投入？`,
    describe,
    confidence: 0.98,
    analysis: {
      timeRange: {
        status: 'unknown',
        sourceText: null,
        startAt: null,
        endAt: null,
        timezone: 'Asia/Shanghai',
        needsConfirmation: true,
      },
      fieldBasis: { background: 'fact', validationQuestion: 'fact', describe: 'fact' },
      recognitionEvidence: [`识别到${title}。`],
    },
  };
}

function source(externalId: string, content: string, occurredAt = baseTime): NormalizedSourceEvent {
  return {
    externalId,
    sourceType: 'owner_dm',
    conversationId: 'conversation-multi-unit',
    senderId: 'sender-requester',
    senderName: '测试需求方',
    content,
    occurredAt,
    metadata: {},
  };
}

class MultiUnitClassifier implements ClassifierAdapter {
  readonly kind = 'rule_mock' as const;
  readonly provider = 'test-provider';
  readonly model = 'multi-unit-fixture';
  readonly promptVersion = 'multi-unit-test-v1';
  calls = 0;
  unitKeys: Array<'u1' | 'u2' | 'u3'> = ['u1', 'u2'];
  omitUnits = false;
  beforeReturn: ((event: NormalizedSourceEvent, call: number) => void | Promise<void>) | null = null;

  async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    this.calls += 1;
    await this.beforeReturn?.(event, this.calls);
    const members = event.classificationSources ?? [{
      sourceKey: 's1',
      senderName: event.senderName,
      content: event.content,
      occurredAt: event.occurredAt,
    }];
    const first = members[0]!;
    const second = members[1];
    const baseUnits = second
      ? [
          {
            unitKey: 'u1',
            sourceKeys: ['s1'],
            isDataRequest: true,
            draft: draft('活动A留存分析', first.content),
            reason: '第一条来源对应活动 A。',
          },
          {
            unitKey: 'u2',
            sourceKeys: ['s2'],
            isDataRequest: true,
            draft: draft('活动B付费分析', second.content),
            reason: '第二条来源对应活动 B。',
          },
        ]
      : [
          {
            unitKey: 'u1',
            sourceKeys: ['s1'],
            isDataRequest: true,
            draft: draft('活动A留存分析', event.content),
            reason: '来源对应活动 A。',
          },
          {
            unitKey: 'u2',
            sourceKeys: ['s1'],
            isDataRequest: true,
            draft: draft('活动A付费分析', event.content),
            reason: '同一来源同时提出另一项独立交付。',
          },
        ];
    const units = this.unitKeys.map((unitKey, index) => {
      const template = baseUnits[index % baseUnits.length]!;
      return {
        ...template,
        unitKey,
        draft: draft(
          unitKey === 'u1' ? '活动A留存分析' : unitKey === 'u2' ? '活动B付费分析' : '活动C回流分析',
          template.draft?.describe ?? event.content,
        ),
        reason: `测试分类器输出 ${unitKey}。`,
      };
    });
    return {
      isDataRequest: true,
      draft: units[0]!.draft,
      reason: '测试分类器将来源拆成多个匿名需求单元。',
      relatedTaskHint: null,
      units: this.omitUnits ? undefined : units,
      importantDates: [],
      deliverables: [],
      commitments: [],
      usedFallback: false,
      outcome: 'valid',
      metadata: { structuredMode: 'json_object', fallbackMode: 'llm', inputCharCount: event.content.length, attempts: 1 },
    };
  }

  async testConnection() {
    return { ok: true, status: 'mock' as const, message: 'test', checkedAt: new Date().toISOString() };
  }
}

type Harness = {
  root: string;
  database: AppDatabase;
  service: PmService;
  app: Awaited<ReturnType<typeof buildApp>>;
  classifier: MultiUnitClassifier;
};

const harnesses: Harness[] = [];

async function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'ai-pm-multi-unit-'));
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    TASK_MEMORY_ROOT: join(root, 'memory'),
    WORKSPACE_READ_ENABLED: 'true',
    WORKSPACE_ALLOWED_PATHS: JSON.stringify([workspaceRoot]),
  });
  const adapters = createAdapters(config);
  const classifier = new MultiUnitClassifier();
  adapters.classifier = classifier;
  const database = new AppDatabase(':memory:', false);
  const service = new PmService(database, adapters, config);
  const app = await buildApp(service, { serveWeb: false });
  const harness = { root, database, service, app, classifier };
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
});

describe('Issue #15 多需求单元隔离', () => {
  it('一条来源拆成两个需求单元时生成两个候选，并保留同一来源的双重归属', async () => {
    const { service, database } = await makeHarness();
    const result = await service.ingestSource(source('multi-same-source', '活动A留存和活动A付费都要分析。'));

    expect(result.candidates).toHaveLength(2);
    expect(result.candidateIds).toHaveLength(2);
    expect(new Set(result.candidateIds)).toEqual(new Set(result.candidates!.map((candidate) => candidate.id)));
    expect(result.demandUnitIds).toHaveLength(2);
    expect(result.threadIds).toHaveLength(2);
    expect(result.candidate).toBeTruthy();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_demand_unit').get()).toEqual({ count: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_demand_unit_source').get()).toEqual({ count: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 2 });
    expect(database.raw.prepare('SELECT COUNT(DISTINCT source_event_id) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(DISTINCT demand_unit_id) AS count FROM candidate_request').get()).toEqual({ count: 2 });
  });

  it('审计链按来源返回全部需求单元、候选、线程和决策，不选择唯一赢家', async () => {
    const { service, database, app } = await makeHarness();
    const result = await service.ingestSource(source('audit-chain-shared', '活动A留存和活动A付费都要分析。'));
    const first = result.candidates![0]!;
    const accepted = service.actOnCandidate(first.id, 'accept', undefined, service.getCandidate(first.id)!.version);
    const sourceId = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('audit-chain-shared') as { id: string };

    const chain = service.getAuditChain({ sourceEventId: sourceId.id });
    expect(chain.sources).toHaveLength(1);
    expect(chain.demand_units).toHaveLength(2);
    expect(chain.candidates).toHaveLength(2);
    expect(chain.threads).toHaveLength(2);
    expect(chain.tasks).toHaveLength(1);
    expect(chain.ai_decisions).toHaveLength(2);
    expect(chain.task_events.some((event) => event.task_id === accepted.task!.id)).toBe(true);
    expect((chain.ai_decisions as Array<{ demand_unit_id: string | null }>).every((decision) => decision.demand_unit_id)).toBe(true);
    expect((chain.task_events as Array<{ task_id: string; source_event_id: string | null; demand_unit_id: string | null }>)
      .filter((event) => event.task_id === accepted.task!.id && event.source_event_id)
      .every((event) => event.demand_unit_id)).toBe(true);

    const response = await app.inject({ method: 'GET', url: `/api/audit-chain?sourceEventId=${sourceId.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().demand_units).toHaveLength(2);
  });

  it('同一共享来源的两个需求单元汇入同一任务时保留两条精确任务来源边并幂等', async () => {
    const { service, database } = await makeHarness();
    const result = await service.ingestSource(source('same-task-shared-source', '活动A留存和活动A付费都要分析。'));
    const candidates = [...(result.candidates ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    const firstAccepted = service.actOnCandidate(candidates[0]!.id, 'accept', undefined, service.getCandidate(candidates[0]!.id)!.version);
    const linkTaskSource = (service as unknown as {
      linkTaskSource: (taskId: string, sourceEventId: string, relationType: string, timestamp: string, demandUnitId?: string | null) => string;
    }).linkTaskSource;
    linkTaskSource.call(service, firstAccepted.task!.id, candidates[1]!.source_event_id, 'merged_origin', baseTime, candidates[1]!.demand_unit_id);

    const edges = database.raw.prepare(
      `SELECT task_id, source_event_id, demand_unit_id, relation_type
         FROM task_source_link
        WHERE task_id = ?
        ORDER BY demand_unit_id`,
    ).all(firstAccepted.task!.id) as Array<{ task_id: string; source_event_id: string; demand_unit_id: string; relation_type: string }>;
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((edge) => edge.demand_unit_id))).toEqual(new Set(candidates.map((candidate) => candidate.demand_unit_id)));
    expect(new Set(edges.map((edge) => edge.source_event_id))).toEqual(new Set([candidates[0]!.source_event_id]));

    linkTaskSource.call(service, firstAccepted.task!.id, candidates[1]!.source_event_id, 'merged_origin', baseTime, candidates[1]!.demand_unit_id);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_source_link WHERE task_id = ?').get(firstAccepted.task!.id)).toEqual({ count: 2 });
    const chain = service.getAuditChain({ taskId: firstAccepted.task!.id });
    expect(chain.task_source_links).toHaveLength(2);
    expect(chain.tasks).toHaveLength(1);
  });

  it('确定性补齐 nullable 任务来源边时精确关闭 gap，并保持 correction 幂等且回滚安全', async () => {
    const { service, database, classifier } = await makeHarness();
    classifier.unitKeys = ['u1'];
    const firstResult = await service.ingestSource(source('gap-close-source', '请分析活动A留存。'));
    const first = (firstResult.candidates?.[0] ?? firstResult.candidate)!;
    const firstTask = service.actOnCandidate(first.id, 'accept', undefined, service.getCandidate(first.id)!.version).task!;
    const linkTaskSource = (service as unknown as {
      linkTaskSource: (taskId: string, sourceEventId: string, relationType: string, timestamp: string, demandUnitId?: string | null) => string;
    }).linkTaskSource;
    database.raw.prepare('DELETE FROM task_source_link WHERE task_id = ? AND source_event_id = ?')
      .run(firstTask.id, first.source_event_id);
    database.raw.prepare(`INSERT INTO task_source_link
      (task_id, source_event_id, demand_unit_id, relation_type, created_at)
      VALUES (?, ?, NULL, 'legacy', ?)`).run(firstTask.id, first.source_event_id, baseTime);
    database.raw.prepare(`INSERT INTO data_integrity_gap
      (id, source_event_id, task_id, record_table, record_id, reason, status, created_at, updated_at)
      VALUES ('gap-close-exact', ?, ?, 'task_source_link', ?, 'missing_or_ambiguous_demand_unit', 'open', ?, ?)`)
      .run(first.source_event_id, firstTask.id, `${firstTask.id}:${first.source_event_id}`, baseTime, baseTime);

    linkTaskSource.call(service, firstTask.id, first.source_event_id, 'repaired_origin', baseTime);
    const closedGap = database.raw.prepare(`SELECT status, correction_event_id
      FROM data_integrity_gap WHERE id = 'gap-close-exact'`).get() as { status: string; correction_event_id: string };
    expect(closedGap.status).toBe('corrected');
    expect(database.raw.prepare('SELECT id, correction_type, visibility, operation FROM correction_event WHERE id = ?').get(closedGap.correction_event_id))
      .toMatchObject({ id: closedGap.correction_event_id, correction_type: 'integrity_gap_closed', visibility: 'private', operation: 'apply' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get()).toEqual({ count: 1 });

    linkTaskSource.call(service, firstTask.id, first.source_event_id, 'repaired_origin', baseTime);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get()).toEqual({ count: 1 });

    database.raw.prepare(`INSERT INTO data_integrity_gap
      (id, source_event_id, task_id, record_table, record_id, reason, status, created_at, updated_at)
      VALUES ('gap-close-prefix', ?, ?, 'task_source_link', ?, 'missing_or_ambiguous_demand_unit', 'open', ?, ?),
             ('gap-close-wrong-reason', ?, ?, 'task_source_link', ?, 'other_reason', 'open', ?, ?)`)
      .run(
        first.source_event_id, firstTask.id, `${firstTask.id}:${first.source_event_id}:prefix`, baseTime, baseTime,
        first.source_event_id, firstTask.id, `${firstTask.id}:${first.source_event_id}`, baseTime, baseTime,
      );

    const secondResult = await service.ingestSource(source('gap-rollback-source', '请分析活动B付费。'));
    const second = (secondResult.candidates?.[0] ?? secondResult.candidate)!;
    const secondTask = service.actOnCandidate(second.id, 'accept', undefined, service.getCandidate(second.id)!.version).task!;
    database.raw.prepare('DELETE FROM task_source_link WHERE task_id = ? AND source_event_id = ?')
      .run(secondTask.id, second.source_event_id);
    database.raw.prepare(`INSERT INTO task_source_link
      (task_id, source_event_id, demand_unit_id, relation_type, created_at)
      VALUES (?, ?, NULL, 'legacy', ?)`).run(secondTask.id, second.source_event_id, baseTime);
    database.raw.prepare(`INSERT INTO data_integrity_gap
      (id, source_event_id, task_id, record_table, record_id, reason, status, created_at, updated_at)
      VALUES ('gap-close-rollback', ?, ?, 'task_source_link', ?, 'missing_or_ambiguous_demand_unit', 'open', ?, ?)`)
      .run(second.source_event_id, secondTask.id, `${secondTask.id}:${second.source_event_id}`, baseTime, baseTime);
    const closeGap = (service as unknown as {
      closeTaskSourceIntegrityGap: (input: {
        gapTaskId: string; sourceEventId: string; resolutionTaskId: string; demandUnitId: string; timestamp: string;
      }) => string | null;
    }).closeTaskSourceIntegrityGap;
    expect(() => database.transaction(() => {
      database.raw.prepare(`UPDATE task_source_link SET demand_unit_id = ?
        WHERE task_id = ? AND source_event_id = ? AND demand_unit_id IS NULL`)
        .run(second.demand_unit_id, secondTask.id, second.source_event_id);
      closeGap.call(service, {
        gapTaskId: secondTask.id,
        sourceEventId: second.source_event_id,
        resolutionTaskId: secondTask.id,
        demandUnitId: 'wrong-unit',
        timestamp: baseTime,
      });
    })).toThrow();
    expect(database.raw.prepare('SELECT demand_unit_id FROM task_source_link WHERE task_id = ? AND source_event_id = ?')
      .get(secondTask.id, second.source_event_id)).toEqual({ demand_unit_id: null });
    expect(database.raw.prepare("SELECT status, correction_event_id FROM data_integrity_gap WHERE id = 'gap-close-rollback'")
      .get()).toEqual({ status: 'open', correction_event_id: null });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get()).toEqual({ count: 1 });
    expect(database.raw.prepare("SELECT status FROM data_integrity_gap WHERE id IN ('gap-close-prefix', 'gap-close-wrong-reason') ORDER BY id")
      .all()).toEqual([{ status: 'open' }, { status: 'open' }]);

    const bindingResult = await service.ingestSource(source('gap-close-binding-source', '请分析活动C回流。'));
    const binding = (bindingResult.candidates?.[0] ?? bindingResult.candidate)!;
    const bindingTask = service.actOnCandidate(binding.id, 'accept', undefined, service.getCandidate(binding.id)!.version).task!;
    database.raw.prepare('DELETE FROM task_source_link WHERE task_id = ? AND source_event_id = ?')
      .run(bindingTask.id, binding.source_event_id);
    database.raw.prepare(`INSERT INTO task_source_link
      (task_id, source_event_id, demand_unit_id, relation_type, created_at)
      VALUES (?, ?, NULL, 'legacy', ?)`).run(bindingTask.id, binding.source_event_id, baseTime);
    database.raw.prepare(`INSERT INTO data_integrity_gap
      (id, source_event_id, task_id, record_table, record_id, reason, status, created_at, updated_at)
      VALUES ('gap-close-binding', ?, ?, 'task_source_link', ?, 'missing_or_ambiguous_demand_unit', 'open', ?, ?)`)
      .run(first.source_event_id, bindingTask.id, `${bindingTask.id}:${binding.source_event_id}`, baseTime, baseTime);
    expect(() => database.transaction(() => {
      linkTaskSource.call(service, bindingTask.id, binding.source_event_id, 'repaired_origin', baseTime);
    })).toThrow();
    expect(database.raw.prepare('SELECT demand_unit_id FROM task_source_link WHERE task_id = ? AND source_event_id = ?')
      .get(bindingTask.id, binding.source_event_id)).toEqual({ demand_unit_id: null });
    expect(database.raw.prepare("SELECT status, correction_event_id FROM data_integrity_gap WHERE id = 'gap-close-binding'")
      .get()).toEqual({ status: 'open', correction_event_id: null });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get()).toEqual({ count: 1 });
    database.raw.prepare('UPDATE task_source_link SET demand_unit_id = ? WHERE task_id = ? AND source_event_id = ?')
      .run(binding.demand_unit_id, bindingTask.id, binding.source_event_id);

    const closeBindingGap = (input: {
      correctionEventId?: string;
      correctionTaskId?: string;
      demandUnitId?: string;
    } = {}) => closeGap.call(service, {
      gapTaskId: bindingTask.id,
      sourceEventId: binding.source_event_id,
      resolutionTaskId: bindingTask.id,
      demandUnitId: input.demandUnitId ?? binding.demand_unit_id!,
      timestamp: baseTime,
      correctionEventId: input.correctionEventId,
      correctionTaskId: input.correctionTaskId,
    });
    const bindingLinkBefore = database.raw.prepare(
      'SELECT task_id, source_event_id, demand_unit_id, relation_type FROM task_source_link WHERE task_id = ? AND source_event_id = ?',
    ).get(bindingTask.id, binding.source_event_id);

    database.raw.prepare('UPDATE data_integrity_gap SET task_id = ? WHERE id = ?')
      .run(firstTask.id, 'gap-close-binding');
    const wrongTaskBefore = database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, status, correction_event_id FROM data_integrity_gap WHERE id = ?',
    ).get('gap-close-binding');
    expect(() => closeBindingGap()).toThrow();
    expect(database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, status, correction_event_id FROM data_integrity_gap WHERE id = ?',
    ).get('gap-close-binding')).toEqual(wrongTaskBefore);
    expect(database.raw.prepare(
      'SELECT task_id, source_event_id, demand_unit_id, relation_type FROM task_source_link WHERE task_id = ? AND source_event_id = ?',
    ).get(bindingTask.id, binding.source_event_id)).toEqual(bindingLinkBefore);
    database.raw.prepare('UPDATE data_integrity_gap SET task_id = ? WHERE id = ?')
      .run(bindingTask.id, 'gap-close-binding');

    database.raw.prepare('UPDATE data_integrity_gap SET source_event_id = ? WHERE id = ?')
      .run(first.source_event_id, 'gap-close-binding');
    const wrongSourceBefore = database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, status, correction_event_id FROM data_integrity_gap WHERE id = ?',
    ).get('gap-close-binding');
    expect(() => closeBindingGap()).toThrow();
    expect(database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, status, correction_event_id FROM data_integrity_gap WHERE id = ?',
    ).get('gap-close-binding')).toEqual(wrongSourceBefore);
    expect(database.raw.prepare(
      'SELECT task_id, source_event_id, demand_unit_id, relation_type FROM task_source_link WHERE task_id = ? AND source_event_id = ?',
    ).get(bindingTask.id, binding.source_event_id)).toEqual(bindingLinkBefore);
    database.raw.prepare('UPDATE data_integrity_gap SET source_event_id = ? WHERE id = ?')
      .run(binding.source_event_id, 'gap-close-binding');

    database.raw.prepare('UPDATE data_integrity_gap SET demand_unit_id = ? WHERE id = ?')
      .run(second.demand_unit_id, 'gap-close-binding');
    const wrongDemandBefore = database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, status, correction_event_id FROM data_integrity_gap WHERE id = ?',
    ).get('gap-close-binding');
    expect(() => closeBindingGap()).toThrow();
    expect(database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, status, correction_event_id FROM data_integrity_gap WHERE id = ?',
    ).get('gap-close-binding')).toEqual(wrongDemandBefore);
    expect(database.raw.prepare(
      'SELECT task_id, source_event_id, demand_unit_id, relation_type FROM task_source_link WHERE task_id = ? AND source_event_id = ?',
    ).get(bindingTask.id, binding.source_event_id)).toEqual(bindingLinkBefore);
    database.raw.prepare('UPDATE data_integrity_gap SET demand_unit_id = NULL WHERE id = ?')
      .run('gap-close-binding');

    database.raw.prepare(`INSERT INTO correction_event
      (id, idempotency_key, task_id, candidate_id, source_event_id, demand_unit_id, correction_type,
       before_json, after_json, note, visibility, operation, created_at)
      VALUES ('correction-unrelated', 'correction-unrelated-key', ?, NULL, ?, ?, 'wrong_association', '{}', '{}',
              'unrelated', 'private', 'apply', ?)`)
      .run(firstTask.id, binding.source_event_id, binding.demand_unit_id, baseTime);
    const unrelatedBefore = database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, status, correction_event_id FROM data_integrity_gap WHERE id = ?',
    ).get('gap-close-binding');
    expect(() => closeBindingGap({ correctionEventId: 'correction-unrelated', correctionTaskId: bindingTask.id })).toThrow();
    expect(database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, status, correction_event_id FROM data_integrity_gap WHERE id = ?',
    ).get('gap-close-binding')).toEqual(unrelatedBefore);
    expect(database.raw.prepare(
      'SELECT task_id, source_event_id, demand_unit_id, relation_type FROM task_source_link WHERE task_id = ? AND source_event_id = ?',
    ).get(bindingTask.id, binding.source_event_id)).toEqual(bindingLinkBefore);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get()).toEqual({ count: 2 });
  });

  it('最终 gap UPDATE 本身按选中 gap 的 NULL-safe 结构绑定 fail-closed', async () => {
    const { service, database, classifier } = await makeHarness();
    classifier.unitKeys = ['u1', 'u2'];
    const result = await service.ingestSource(source('gap-update-fence-source', '活动A留存和活动A付费都要分析。'));
    const candidates = [...(result.candidates ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    const first = candidates[0]!;
    const second = candidates[1]!;
    const task = service.actOnCandidate(first.id, 'accept', undefined, service.getCandidate(first.id)!.version).task!;
    const linkTaskSource = (service as unknown as {
      linkTaskSource: (taskId: string, sourceEventId: string, relationType: string, timestamp: string, demandUnitId?: string | null) => string;
    }).linkTaskSource;

    database.raw.prepare('DELETE FROM task_source_link WHERE task_id = ? AND source_event_id = ?')
      .run(task.id, first.source_event_id);
    database.raw.prepare(`INSERT INTO task_source_link
      (task_id, source_event_id, demand_unit_id, relation_type, created_at)
      VALUES (?, ?, NULL, 'legacy', ?)`).run(task.id, first.source_event_id, baseTime);
    database.raw.prepare(`INSERT INTO data_integrity_gap
      (id, source_event_id, task_id, record_table, record_id, reason, status, created_at, updated_at)
      VALUES ('gap-update-fence', ?, ?, 'task_source_link', ?, 'missing_or_ambiguous_demand_unit', 'open', ?, ?)`)
      .run(first.source_event_id, task.id, `${task.id}:${first.source_event_id}`, baseTime, baseTime);

    const linkBefore = database.raw.prepare(
      'SELECT task_id, source_event_id, demand_unit_id, relation_type FROM task_source_link WHERE task_id = ? AND source_event_id = ?',
    ).get(task.id, first.source_event_id);
    const gapBefore = database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, record_table, record_id, reason, status, correction_event_id FROM data_integrity_gap WHERE id = ?',
    ).get('gap-update-fence');
    const correctionsBefore = database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, correction_type, visibility, operation FROM correction_event ORDER BY id',
    ).all();

    const raw = database.raw;
    let mutationApplied = false;
    let observedUpdateChanges: number | undefined;
    const wrappedRaw = new Proxy(raw as unknown as Record<PropertyKey, any>, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith('UPDATE data_integrity_gap')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === 'run') {
                  return (...params: any[]) => {
                    if (!mutationApplied) {
                      mutationApplied = true;
                      raw.prepare('UPDATE data_integrity_gap SET demand_unit_id = ? WHERE id = ?')
                        .run(second.demand_unit_id, 'gap-update-fence');
                    }
                    const result = statementTarget.run(...params) as { changes: number };
                    observedUpdateChanges = result.changes;
                    return result;
                  };
                }
                const value = statementTarget[statementProperty];
                return typeof value === 'function' ? value.bind(statementTarget) : value;
              },
            });
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as typeof raw;
    const mutableDatabase = database as unknown as { raw: typeof raw };
    mutableDatabase.raw = wrappedRaw;
    try {
      expect(() => database.transaction(() => {
        linkTaskSource.call(service, task.id, first.source_event_id, 'repaired_origin', baseTime, first.demand_unit_id);
      })).toThrow();
    } finally {
      mutableDatabase.raw = raw;
    }

    expect(mutationApplied).toBe(true);
    expect(observedUpdateChanges).toBe(0);
    expect(database.raw.prepare(
      'SELECT task_id, source_event_id, demand_unit_id, relation_type FROM task_source_link WHERE task_id = ? AND source_event_id = ?',
    ).get(task.id, first.source_event_id)).toEqual(linkBefore);
    expect(database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, record_table, record_id, reason, status, correction_event_id FROM data_integrity_gap WHERE id = ?',
    ).get('gap-update-fence')).toEqual(gapBefore);
    expect(database.raw.prepare(
      'SELECT id, task_id, source_event_id, demand_unit_id, correction_type, visibility, operation FROM correction_event ORDER BY id',
    ).all()).toEqual(correctionsBefore);
  });

  it('审计链从四层任一筛选点都收敛到同一完整连通分量，且 API 不暴露原文或外部字段', async () => {
    const { service, database, app } = await makeHarness();
    const result = await service.ingestSource(source('audit-safe-dto', '活动A留存和活动A付费都要分析。'));
    const candidates = [...(result.candidates ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    const accepted = service.actOnCandidate(candidates[0]!.id, 'accept', undefined, service.getCandidate(candidates[0]!.id)!.version);
    const linkTaskSource = (service as unknown as {
      linkTaskSource: (taskId: string, sourceEventId: string, relationType: string, timestamp: string, demandUnitId?: string | null) => string;
    }).linkTaskSource;
    linkTaskSource.call(service, accepted.task!.id, candidates[1]!.source_event_id, 'merged_origin', baseTime, candidates[1]!.demand_unit_id);
    const sourceId = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('audit-safe-dto') as { id: string };
    const firstThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?').get(candidates[0]!.demand_unit_id) as { thread_id: string };
    const secondThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?').get(candidates[1]!.demand_unit_id) as { thread_id: string };
    database.raw.prepare(
      `UPDATE source_event
          SET content = ?, external_id = ?, conversation_id = ?, sender_name = ?, source_url = ?, discovery_reason = ?, metadata_json = ?
        WHERE id = ?`,
    ).run('SOURCE_CONTENT_CANARY', 'EXTERNAL_ID_CANARY', 'CONVERSATION_ID_CANARY', 'SOURCE_SENDER_CANARY', 'https://source-url-canary.invalid', 'SOURCE_DISCOVERY_CANARY', JSON.stringify({ canary: 'METADATA_CANARY' }), sourceId.id);
    database.raw.prepare(`UPDATE source_demand_unit
      SET reason = 'DEMAND_REASON_CANARY', analysis_json = ?
      WHERE id IN (?, ?)`)
      .run(JSON.stringify({ canary: 'DEMAND_ANALYSIS_CANARY' }), candidates[0]!.demand_unit_id, candidates[1]!.demand_unit_id);
    database.raw.prepare(`UPDATE candidate_request
      SET title = 'CANDIDATE_TITLE_CANARY', proposer_name = 'CANDIDATE_PROPOSER_CANARY',
          background = 'CANDIDATE_BACKGROUND_CANARY', validation_question = 'CANDIDATE_QUESTION_CANARY',
          describe = 'CANDIDATE_DESCRIBE_CANARY', analysis_json = ?
      WHERE id IN (?, ?)`)
      .run(JSON.stringify({ canary: 'CANDIDATE_ANALYSIS_CANARY' }), candidates[0]!.id, candidates[1]!.id);
    database.raw.prepare(`UPDATE requirement_thread
      SET title = 'THREAD_TITLE_CANARY', background = 'THREAD_BACKGROUND_CANARY',
          validation_question = 'THREAD_QUESTION_CANARY', describe = 'THREAD_DESCRIBE_CANARY',
          analysis_json = ?, conversation_id = 'THREAD_CONVERSATION_CANARY', participant_ids_json = ?
      WHERE id IN (?, ?)`)
      .run(JSON.stringify({ canary: 'THREAD_ANALYSIS_CANARY' }), JSON.stringify(['THREAD_PARTICIPANT_CANARY']), firstThread.thread_id, secondThread.thread_id);
    database.raw.prepare(`UPDATE task
      SET title = 'TASK_TITLE_CANARY', next_step = 'TASK_NEXT_STEP_CANARY', waiting_reason = 'TASK_WAITING_CANARY'
      WHERE id = ?`).run(accepted.task!.id);
    database.raw.prepare(`UPDATE source_demand_unit_source
      SET source_key = 'SOURCE_KEY_CANARY'
      WHERE demand_unit_id IN (?, ?)`)
      .run(candidates[0]!.demand_unit_id, candidates[1]!.demand_unit_id);
    database.raw.prepare(`UPDATE requirement_thread_unit
      SET evidence_json = ?
      WHERE thread_id IN (?, ?)`)
      .run(JSON.stringify({ canary: 'THREAD_UNIT_EVIDENCE_CANARY' }), firstThread.thread_id, secondThread.thread_id);
    database.raw.prepare(`UPDATE requirement_thread_source
      SET evidence_json = ?, conversation_id = 'THREAD_SOURCE_CONVERSATION_CANARY',
          participant_ids_json = ?, role_reason = 'THREAD_SOURCE_ROLE_REASON_CANARY'
      WHERE thread_id IN (?, ?)`)
      .run(JSON.stringify({ canary: 'THREAD_SOURCE_EVIDENCE_CANARY' }), JSON.stringify(['THREAD_SOURCE_PARTICIPANT_CANARY']), firstThread.thread_id, secondThread.thread_id);
    database.raw.prepare(`UPDATE task_source_link
      SET relation_type = 'TASK_LINK_RELATION_CANARY'
      WHERE task_id = ?`).run(accepted.task!.id);
    database.raw.prepare('UPDATE ai_decision_log SET output_json = ?, provider_request_id = ? WHERE source_event_id = ?')
      .run(JSON.stringify({ canary: 'PROVIDER_PAYLOAD_CANARY' }), 'PROVIDER_REQUEST_CANARY', sourceId.id);
    database.raw.prepare(`UPDATE ai_decision_log
      SET provider = 'AI_PROVIDER_CANARY', model = 'AI_MODEL_CANARY', prompt_version = 'AI_PROMPT_CANARY',
          reason = 'AI_REASON_CANARY'
      WHERE source_event_id = ?`).run(sourceId.id);
    database.raw.prepare(`INSERT INTO owner_decision
      (id, source_event_id, source_revision, candidate_id, thread_id, task_id, action, disposition,
       confidence, summary, reason, provider, model, prompt_version, state, created_at)
      VALUES ('owner-safe-canary', ?, 'owner-safe-canary-revision', ?, ?, ?, 'continue', 'noop', 0.5,
              'OWNER_SUMMARY_CANARY', 'OWNER_REASON_CANARY', 'OWNER_PROVIDER_CANARY', 'OWNER_MODEL_CANARY',
              'OWNER_PROMPT_CANARY', 'queued', ?)`)
      .run(sourceId.id, candidates[1]!.id, secondThread.thread_id, accepted.task!.id, baseTime);
    database.raw.prepare(`UPDATE owner_decision
      SET provider = 'OWNER_PROVIDER_CANARY', model = 'OWNER_MODEL_CANARY', prompt_version = 'OWNER_PROMPT_CANARY',
          reason = 'OWNER_REASON_CANARY', summary = 'OWNER_SUMMARY_CANARY'
      WHERE source_event_id = ?`).run(sourceId.id);
    database.raw.prepare(`UPDATE task_event
      SET summary = 'TASK_EVENT_SUMMARY_CANARY'
      WHERE task_id = ?`).run(accepted.task!.id);
    database.raw.prepare(`UPDATE task_event
      SET before_json = ?, after_json = ?
      WHERE task_id = ?`).run(JSON.stringify({ canary: 'TASK_EVENT_BEFORE_CANARY' }), JSON.stringify({ canary: 'TASK_EVENT_AFTER_CANARY' }), accepted.task!.id);
    const taskEventId = database.raw.prepare(
      'SELECT id FROM task_event WHERE task_id = ? ORDER BY occurred_at ASC, recorded_at ASC, id ASC LIMIT 1',
    ).get(accepted.task!.id) as { id: string } | undefined;
    expect(taskEventId).toBeTruthy();
    database.raw.prepare('UPDATE task_event SET id = ? WHERE id = ?')
      .run('TASK_EVENT_ID_CANARY#', taskEventId!.id);
    database.raw.prepare(`INSERT INTO correction_event
      (id, idempotency_key, task_id, candidate_id, source_event_id, demand_unit_id, correction_type,
       before_json, after_json, note, visibility, operation, created_at)
      VALUES ('audit-safe-correction-canary', 'audit-safe-correction-canary', ?, ?, ?, ?, 'correction_canary',
              ?, ?, 'CORRECTION_NOTE_CANARY', 'private', 'apply', ?)`)
      .run(accepted.task!.id, candidates[1]!.id, sourceId.id, candidates[1]!.demand_unit_id,
        JSON.stringify({ canary: 'CORRECTION_BEFORE_CANARY' }), JSON.stringify({ canary: 'CORRECTION_AFTER_CANARY' }), baseTime);
    database.raw.prepare(`INSERT INTO data_integrity_gap
      (id, source_event_id, demand_unit_id, task_id, record_table, record_id, reason, status, created_at, updated_at)
      VALUES ('audit-safe-gap-canary', ?, ?, ?, 'task_source_link', 'GAP_RECORD_ID_CANARY', 'GAP_REASON_CANARY', 'open', ?, ?)`)
      .run(sourceId.id, candidates[1]!.demand_unit_id, accepted.task!.id, baseTime, baseTime);

    const signatures = [
      service.getAuditChain({ sourceEventId: sourceId.id }),
      service.getAuditChain({ demandUnitId: candidates[1]!.demand_unit_id! }),
      service.getAuditChain({ candidateId: candidates[1]!.id }),
      service.getAuditChain({ threadId: secondThread.thread_id }),
      service.getAuditChain({ taskId: accepted.task!.id }),
    ].map((chain) => JSON.stringify({
      sources: chain.sources.map((item) => item.id),
      demandUnits: chain.demand_units.map((item) => item.id),
      candidates: chain.candidates.map((item) => item.id),
      threads: chain.threads.map((item) => item.id),
      tasks: chain.tasks.map((item) => item.id),
      links: chain.task_source_links.map((item) => [item.task_id, item.source_event_id, item.demand_unit_id]),
    }));
    expect(new Set(signatures).size).toBe(1);

    const response = await app.inject({ method: 'GET', url: `/api/audit-chain?sourceEventId=${sourceId.id}` });
    const safeChain = service.getAuditChain({ sourceEventId: sourceId.id });
    const httpChain = response.json() as Record<string, unknown>;
    const serviceBody = JSON.stringify(safeChain);
    expect(response.statusCode).toBe(200);
    const canaries = [
      'SOURCE_CONTENT_CANARY', 'EXTERNAL_ID_CANARY', 'CONVERSATION_ID_CANARY', 'SOURCE_SENDER_CANARY',
      'SOURCE_DISCOVERY_CANARY', 'source-url-canary.invalid', 'METADATA_CANARY', 'DEMAND_REASON_CANARY',
      'DEMAND_ANALYSIS_CANARY', 'CANDIDATE_TITLE_CANARY', 'CANDIDATE_PROPOSER_CANARY', 'CANDIDATE_BACKGROUND_CANARY',
      'CANDIDATE_QUESTION_CANARY', 'CANDIDATE_DESCRIBE_CANARY', 'CANDIDATE_ANALYSIS_CANARY', 'THREAD_TITLE_CANARY',
      'THREAD_BACKGROUND_CANARY', 'THREAD_QUESTION_CANARY', 'THREAD_DESCRIBE_CANARY', 'THREAD_ANALYSIS_CANARY',
      'THREAD_CONVERSATION_CANARY', 'THREAD_PARTICIPANT_CANARY', 'TASK_TITLE_CANARY', 'TASK_NEXT_STEP_CANARY',
      'TASK_WAITING_CANARY', 'SOURCE_KEY_CANARY', 'THREAD_UNIT_EVIDENCE_CANARY', 'THREAD_SOURCE_EVIDENCE_CANARY',
      'THREAD_SOURCE_CONVERSATION_CANARY', 'THREAD_SOURCE_PARTICIPANT_CANARY', 'THREAD_SOURCE_ROLE_REASON_CANARY',
      'TASK_LINK_RELATION_CANARY', 'PROVIDER_PAYLOAD_CANARY', 'PROVIDER_REQUEST_CANARY', 'AI_PROVIDER_CANARY',
      'AI_MODEL_CANARY', 'AI_PROMPT_CANARY', 'AI_REASON_CANARY', 'OWNER_PROVIDER_CANARY', 'OWNER_MODEL_CANARY',
      'OWNER_PROMPT_CANARY', 'OWNER_REASON_CANARY', 'OWNER_SUMMARY_CANARY', 'TASK_EVENT_SUMMARY_CANARY',
      'TASK_EVENT_BEFORE_CANARY', 'TASK_EVENT_AFTER_CANARY', 'CORRECTION_BEFORE_CANARY', 'CORRECTION_AFTER_CANARY',
      'CORRECTION_NOTE_CANARY', 'GAP_RECORD_ID_CANARY', 'GAP_REASON_CANARY', 'TASK_EVENT_ID_CANARY#',
    ];
    for (const canary of canaries) {
      expect(serviceBody).not.toContain(canary);
      expect(response.body).not.toContain(canary);
    }
    for (const forbiddenKey of [
      'content', 'external_id', 'conversation_id', 'source_url', 'metadata_json', 'output_json', 'provider',
      'model', 'prompt_version', 'reason', 'summary', 'title', 'sender_name', 'discovery_reason',
      'proposer_name', 'next_step', 'record_id', 'before_json', 'after_json', 'note', 'background',
      'validation_question', 'describe', 'waiting_reason', 'role_reason', 'source_key',
    ]) {
      expect(serviceBody).not.toContain(`"${forbiddenKey}"`);
      expect(response.body).not.toContain(`"${forbiddenKey}"`);
    }
    const aiKeys = ['attempts', 'candidate_id', 'confidence', 'created_at', 'demand_unit_id', 'fallback_mode', 'http_status', 'id', 'input_char_count', 'input_hash', 'latency_ms', 'source_event_id', 'source_revision', 'structured_mode', 'used_fallback'];
    const ownerKeys = ['action', 'applied_at', 'applied_task_version', 'applied_thread_version', 'candidate_id', 'confidence', 'created_at', 'demand_unit_id', 'disposition', 'id', 'source_event_id', 'source_revision', 'state', 'task_id', 'thread_id'];
    const taskEventKeys = ['actor_type', 'demand_unit_id', 'event_type', 'id', 'occurred_at', 'recorded_at', 'source_event_id', 'task_id', 'version', 'visibility'];
    const expectedKeys: Record<string, string[]> = {
      filters: ['candidate_id', 'demand_unit_id', 'source_event_id', 'task_id', 'thread_id'],
      sources: ['captured_at', 'completeness', 'id', 'occurred_at', 'owner_mentioned', 'source_type'],
      demand_units: ['ai_decision_id', 'anchor_source_event_id', 'classification_revision', 'created_at', 'id', 'state', 'unit_kind', 'updated_at'],
      candidates: ['accepted_task_id', 'confidence', 'created_at', 'deleted_at', 'demand_unit_id', 'id', 'merged_at', 'merged_into_candidate_id', 'source_event_id', 'state', 'updated_at'],
      threads: ['active_task_id', 'created_at', 'id', 'last_activity_at', 'primary_source_event_id', 'status', 'updated_at', 'version'],
      tasks: ['created_at', 'id', 'planned_due_at', 'planned_start_at', 'record_state', 'risk', 'schedule_at', 'status', 'thread_id', 'updated_at', 'version'],
      source_demand_units: ['created_at', 'demand_unit_id', 'sequence', 'source_event_id', 'source_role'],
      thread_units: ['confidence', 'created_at', 'demand_unit_id', 'relation_type', 'thread_id'],
      thread_sources: ['confidence', 'created_at', 'demand_unit_id', 'relation_type', 'source_event_id', 'source_revision', 'source_role', 'thread_id'],
      task_source_links: ['created_at', 'demand_unit_id', 'relation_type', 'source_event_id', 'task_id'],
      ai_decisions: aiKeys,
      owner_decisions: ownerKeys,
      task_events: taskEventKeys,
      corrections: ['candidate_id', 'correction_type', 'created_at', 'demand_unit_id', 'id', 'operation', 'source_event_id', 'task_id', 'visibility'],
      integrity_gaps: ['candidate_id', 'correction_event_id', 'created_at', 'demand_unit_id', 'gap_code', 'id', 'record_kind', 'source_event_id', 'status', 'task_id', 'thread_id', 'updated_at'],
    };
    for (const [collection, keys] of Object.entries(expectedKeys)) {
      const serviceValue = (safeChain as unknown as Record<string, unknown>)[collection];
      const httpValue = httpChain[collection];
      if (collection === 'filters') {
        expect(Object.keys(serviceValue as Record<string, unknown>).sort()).toEqual([...keys].sort());
        expect(Object.keys(httpValue as Record<string, unknown>).sort()).toEqual([...keys].sort());
        continue;
      }
      const serviceRows = (serviceValue as Array<Record<string, unknown>> | undefined) ?? [];
      const httpRows = (httpValue as Array<Record<string, unknown>> | undefined) ?? [];
      expect(serviceRows.map((row) => Object.keys(row).sort())).toEqual(serviceRows.map(() => [...keys].sort()));
      expect(httpRows.map((row) => Object.keys(row).sort())).toEqual(httpRows.map(() => [...keys].sort()));
    }
    expect(safeChain.task_events.some((row) => row.id === 'unknown')).toBe(true);
    expect(httpChain.task_events).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'unknown' })]));
    expect((await app.inject({ method: 'GET', url: '/api/audit-chain?sourceEventId=%25' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/audit-chain?sourceEventId=${'a'.repeat(201)}` })).statusCode).toBe(400);
  });

  it('批次中两个来源分别属于不同单元时，不会把来源交叉写入两个需求', async () => {
    const { service, database } = await makeHarness();
    const result = await service.ingestSourceBatch([
      source('multi-source-a', '请分析活动A留存。', '2026-08-13T09:00:00.000Z'),
      source('multi-source-b', '请分析活动B付费。', '2026-08-13T09:02:00.000Z'),
    ]);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidateIds).toHaveLength(2);
    expect(result.demandUnitIds).toHaveLength(2);
    expect(result.threadIds).toHaveLength(2);
    const rows = database.raw.prepare(
      `SELECT candidate_request.title, candidate_request.source_event_id, source_event.external_id,
              source_demand_unit.unit_key
       FROM candidate_request
       JOIN source_event ON source_event.id = candidate_request.source_event_id
       JOIN source_demand_unit ON source_demand_unit.id = candidate_request.demand_unit_id
       ORDER BY source_demand_unit.unit_key`,
    ).all() as Array<{ title: string; source_event_id: string; external_id: string; unit_key: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ unit_key: 'u1', external_id: 'multi-source-a' });
    expect(rows[1]).toMatchObject({ unit_key: 'u2', external_id: 'multi-source-b' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_demand_unit_source').get()).toEqual({ count: 2 });
  });

  it('接受一个需求单元不会把同一来源的另一个需求单元一并接受', async () => {
    const { service, database } = await makeHarness();
    const result = await service.ingestSource(source('multi-accept-isolated', '同一条消息包含两个独立分析交付。'));
    const candidates = [...(result.candidates ?? [])].sort((left, right) => left.id.localeCompare(right.id));
    expect(candidates).toHaveLength(2);

    const accepted = service.actOnCandidate(candidates[0]!.id, 'accept', undefined, service.getCandidate(candidates[0]!.id)!.version);
    expect(accepted.task).toBeTruthy();
    const after = service.listCandidates(undefined, 'all');
    const acceptedRow = after.find((candidate) => candidate.id === candidates[0]!.id)!;
    const untouchedRow = after.find((candidate) => candidate.id === candidates[1]!.id)!;
    expect(acceptedRow.accepted_task_id).toBe(accepted.task!.id);
    expect(untouchedRow.state).toBe('pending');
    expect(untouchedRow.accepted_task_id).toBeNull();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task').get()).toEqual({ count: 1 });
  });

  it('同一消息的两个需求都已接受时，关联纠错只移动明确选择的需求单元', async () => {
    const { service, database } = await makeHarness();
    const result = await service.ingestSource(source('multi-correction-isolated', '同一条消息包含留存和付费两个独立需求。'));
    const first = result.candidates!.find((candidate) => candidate.title === '活动A留存分析')!;
    const second = result.candidates!.find((candidate) => candidate.title === '活动B付费分析')!;
    const firstTask = service.actOnCandidate(first.id, 'accept', undefined, service.getCandidate(first.id)!.version).task!;
    const secondTask = service.actOnCandidate(second.id, 'accept', undefined, service.getCandidate(second.id)!.version).task!;
    const targetResult = await service.ingestSource(source('multi-correction-target', '请分析活动C回流。', '2026-08-13T10:00:00.000Z'));
    const targetCandidate = targetResult.candidates![0]!;
    const targetTask = service.actOnCandidate(targetCandidate.id, 'accept', undefined, service.getCandidate(targetCandidate.id)!.version).task!;

    // Both sides start with a nullable historical edge. The explicit owner
    // correction below is the deterministic boundary that repairs both edges.
    database.raw.prepare('DELETE FROM task_source_link WHERE task_id = ? AND source_event_id = ?')
      .run(firstTask.id, first.source_event_id);
    database.raw.prepare(`INSERT INTO task_source_link
      (task_id, source_event_id, demand_unit_id, relation_type, created_at)
      VALUES (?, ?, NULL, 'legacy', ?), (?, ?, NULL, 'legacy', ?)`)
      .run(firstTask.id, first.source_event_id, baseTime, targetTask.id, first.source_event_id, baseTime);
    database.raw.prepare(`INSERT INTO data_integrity_gap
      (id, source_event_id, task_id, record_table, record_id, reason, status, created_at, updated_at)
      VALUES ('gap-wrong-old', ?, ?, 'task_source_link', ?, 'missing_or_ambiguous_demand_unit', 'open', ?, ?),
             ('gap-wrong-target', ?, ?, 'task_source_link', ?, 'missing_or_ambiguous_demand_unit', 'open', ?, ?)`)
      .run(
        first.source_event_id, firstTask.id, `${firstTask.id}:${first.source_event_id}`, baseTime, baseTime,
        first.source_event_id, targetTask.id, `${targetTask.id}:${first.source_event_id}`, baseTime, baseTime,
      );

    service.recordCorrection({
      correctionType: 'wrong_association',
      taskId: firstTask.id,
      targetTaskId: targetTask.id,
      sourceEventId: first.source_event_id,
      demandUnitId: first.demand_unit_id!,
      expectedTaskVersion: firstTask.version,
      expectedTargetTaskVersion: targetTask.version,
      idempotencyKey: 'multi-unit-correction-isolated',
    });

    expect(service.getCandidate(first.id)).toMatchObject({ accepted_task_id: targetTask.id });
    expect(service.getCandidate(second.id)).toMatchObject({ accepted_task_id: secondTask.id });
    expect(database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?').get(first.demand_unit_id))
      .toEqual({ thread_id: targetTask.thread_id });
    expect(database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?').get(second.demand_unit_id))
      .toEqual({ thread_id: secondTask.thread_id });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_source_link WHERE task_id = ?').get(firstTask.id)).toEqual({ count: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_source_link WHERE task_id = ?').get(secondTask.id)).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_source_link WHERE task_id = ?').get(targetTask.id)).toEqual({ count: 2 });
    const closedGaps = database.raw.prepare(`SELECT id, status, correction_event_id
      FROM data_integrity_gap WHERE id IN ('gap-wrong-old', 'gap-wrong-target') ORDER BY id`).all() as Array<{ id: string; status: string; correction_event_id: string }>;
    expect(closedGaps).toHaveLength(2);
    expect(closedGaps.every((gap) => gap.status === 'corrected' && gap.correction_event_id)).toBe(true);
    expect(new Set(closedGaps.map((gap) => gap.correction_event_id)).size).toBe(1);
    expect(database.raw.prepare('SELECT correction_type FROM correction_event WHERE id = ?').get(closedGaps[0]!.correction_event_id))
      .toEqual({ correction_type: 'wrong_association' });
    const correctionCount = database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get();
    const duplicate = service.recordCorrection({
      correctionType: 'wrong_association',
      taskId: firstTask.id,
      targetTaskId: targetTask.id,
      sourceEventId: first.source_event_id,
      demandUnitId: first.demand_unit_id!,
      idempotencyKey: 'multi-unit-correction-isolated',
    });
    expect(duplicate.duplicate).toBe(true);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get()).toEqual(correctionCount);
  });

  it('人工确认已有需求线时只移动当前需求单元，另一需求仍保留原线程', async () => {
    const { service, database } = await makeHarness();
    const result = await service.ingestSource(source('multi-association-isolated', '同一条消息包含两个独立需求。'));
    const selected = result.candidates![0]!;
    const untouched = result.candidates![1]!;
    const selectedThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?')
      .get(selected.demand_unit_id) as { thread_id: string };
    const untouchedThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?')
      .get(untouched.demand_unit_id) as { thread_id: string };
    const targetResult = await service.ingestSource(source('multi-association-target', '请分析活动C回流。', '2026-08-13T10:00:00.000Z'));
    const target = targetResult.candidates![0]!;
    const targetThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?')
      .get(target.demand_unit_id) as { thread_id: string };
    database.raw.prepare("UPDATE requirement_thread SET status = 'needs_confirmation', ambiguity_json = ? WHERE id = ?")
      .run(JSON.stringify([targetThread.thread_id]), selectedThread.thread_id);

    const selectedVersion = service.getCandidate(selected.id)!.version;
    const selectedThreadVersion = (database.raw.prepare('SELECT version FROM requirement_thread WHERE id = ?').get(selectedThread.thread_id) as { version: number }).version;
    const targetThreadVersion = (database.raw.prepare('SELECT version FROM requirement_thread WHERE id = ?').get(targetThread.thread_id) as { version: number }).version;
    const resolved = service.resolveCandidateThreadAssociation(selected.id, targetThread.thread_id, selectedVersion, selectedThreadVersion, targetThreadVersion);

    expect(resolved.threadId).toBe(targetThread.thread_id);
    expect(database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?').get(selected.demand_unit_id))
      .toEqual({ thread_id: targetThread.thread_id });
    expect(database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?').get(untouched.demand_unit_id))
      .toEqual({ thread_id: untouchedThread.thread_id });
  });

  it('同一线程仍有另一个活动需求时，忽略当前需求不会关闭线程', async () => {
    const { service, database } = await makeHarness();
    const result = await service.ingestSource(source('multi-close-isolated', '同一条消息包含两个独立需求。'));
    const ignored = result.candidates![0]!;
    const remaining = result.candidates![1]!;
    const ignoredThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?')
      .get(ignored.demand_unit_id) as { thread_id: string };
    const remainingThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?')
      .get(remaining.demand_unit_id) as { thread_id: string };
    database.raw.prepare('DELETE FROM requirement_thread_unit WHERE demand_unit_id = ?').run(remaining.demand_unit_id);
    database.raw.prepare(
      `INSERT INTO requirement_thread_unit (thread_id, demand_unit_id, relation_type, confidence, evidence_json, created_at)
       VALUES (?, ?, 'supporting', 1, '[]', ?)`,
    ).run(ignoredThread.thread_id, remaining.demand_unit_id, baseTime);
    database.raw.prepare('UPDATE requirement_thread SET status = \'closed\' WHERE id = ?').run(remainingThread.thread_id);

    service.actOnCandidate(ignored.id, 'ignore', undefined, service.getCandidate(ignored.id)!.version);

    expect(database.raw.prepare('SELECT status FROM requirement_thread WHERE id = ?').get(ignoredThread.thread_id)).toEqual({ status: 'open' });
  });

  it('归并组展示线程内全部需求单元，并为共享原消息保留各自标题和单元 ID', async () => {
    const { service, database } = await makeHarness();
    const result = await service.ingestSource(source('multi-group-view', '同一条消息包含两个独立需求。'));
    const primary = result.candidates![0]!;
    const supporting = result.candidates![1]!;
    const primaryThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?')
      .get(primary.demand_unit_id) as { thread_id: string };
    const supportingThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?')
      .get(supporting.demand_unit_id) as { thread_id: string };
    database.raw.prepare('DELETE FROM requirement_thread_unit WHERE demand_unit_id = ?').run(supporting.demand_unit_id);
    database.raw.prepare(
      `INSERT INTO requirement_thread_unit (thread_id, demand_unit_id, relation_type, confidence, evidence_json, created_at)
       VALUES (?, ?, 'supporting', 1, '[]', ?)`,
    ).run(primaryThread.thread_id, supporting.demand_unit_id, baseTime);
    database.raw.prepare('UPDATE candidate_request SET merged_into_candidate_id = ?, merged_at = ? WHERE id = ?')
      .run(primary.id, baseTime, supporting.id);
    database.raw.prepare('UPDATE requirement_thread SET status = \'closed\' WHERE id = ?').run(supportingThread.thread_id);

    const view = service.listCandidates().find((candidate) => candidate.id === primary.id)!.merge_group!;

    expect(view.candidateCount).toBe(2);
    expect(view.sources).toHaveLength(2);
    expect(new Set(view.sources.map((item) => item.demandUnitId)))
      .toEqual(new Set([primary.demand_unit_id, supporting.demand_unit_id]));
    expect(new Set(view.sources.map((item) => item.title)))
      .toEqual(new Set([primary.title, supporting.title]));
  });

  it('相同来源重试不会重复生成需求单元、候选或线程', async () => {
    const { service, database, classifier } = await makeHarness();
    const event = source('multi-retry-idempotent', '同一条消息包含两个独立分析交付。');
    const first = await service.ingestSource(event);
    const firstIds = (first.candidates ?? []).map((candidate) => candidate.id).sort();
    const second = await service.ingestSource(event, undefined, { retryFailed: true });
    const secondIds = (second.candidates ?? []).map((candidate) => candidate.id).sort();

    expect(secondIds).toEqual(firstIds);
    expect(classifier.calls).toBe(1);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_demand_unit').get()).toEqual({ count: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM requirement_thread').get()).toEqual({ count: 2 });
  });

  it('新判断从 u1/u2 变为 u1/u3 时，旧 u2 安全退出活动候选且保留历史', async () => {
    const { service, database, classifier } = await makeHarness();
    const first = await service.ingestSource({ ...source('multi-supersede', '第一版包含两个需求。'), metadata: { sourceVersion: 1 } });
    const oldUnitId = first.candidates!.find((candidate) => candidate.title === '活动B付费分析')!.demand_unit_id!;

    classifier.unitKeys = ['u1', 'u3'];
    const second = await service.ingestSource({ ...source('multi-supersede', '第二版改成留存和回流。'), metadata: { sourceVersion: 2 } });

    expect(second.candidates?.map((candidate) => candidate.title).sort()).toEqual(['活动A留存分析', '活动C回流分析']);
    expect(database.raw.prepare('SELECT state FROM source_demand_unit WHERE id = ?').get(oldUnitId)).toEqual({ state: 'superseded' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_demand_unit_source WHERE demand_unit_id = ?').get(oldUnitId)).toEqual({ count: 0 });
    expect(service.listCandidates().map((candidate) => candidate.title).sort()).toEqual(['活动A留存分析', '活动C回流分析']);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 3 });
  });

  it('旧需求单元已经接受时，新判断淘汰该单元仍保留正式任务和来源审计', async () => {
    const { service, database, classifier } = await makeHarness();
    const first = await service.ingestSource({ ...source('multi-supersede-accepted', '第一版包含两个需求。'), metadata: { sourceVersion: 1 } });
    const acceptedCandidate = first.candidates!.find((candidate) => candidate.title === '活动B付费分析')!;
    const acceptedTask = service.actOnCandidate(acceptedCandidate.id, 'accept', undefined, service.getCandidate(acceptedCandidate.id)!.version).task!;

    classifier.unitKeys = ['u1', 'u3'];
    await service.ingestSource({ ...source('multi-supersede-accepted', '第二版改成留存和回流。'), metadata: { sourceVersion: 2 } });

    expect(service.getTask(acceptedTask.id)).toMatchObject({ id: acceptedTask.id, record_state: 'active' });
    expect(database.raw.prepare('SELECT state FROM source_demand_unit WHERE id = ?').get(acceptedCandidate.demand_unit_id)).toEqual({ state: 'superseded' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM task_source_link WHERE task_id = ?').get(acceptedTask.id)).toEqual({ count: 1 });
  });

  it('已有多个需求单元时模型退回旧版单需求结构会停止覆盖并保留原结果', async () => {
    const { service, database, classifier } = await makeHarness();
    const first = await service.ingestSource({ ...source('multi-fail-closed', '第一版包含两个需求。'), metadata: { sourceVersion: 1 } });
    const originalIds = first.candidateIds!.slice().sort();
    classifier.omitUnits = true;

    await expect(service.ingestSource({ ...source('multi-fail-closed', '第二版仍包含两个需求。'), metadata: { sourceVersion: 2 } }))
      .rejects.toThrow('多个需求单元');

    expect((database.raw.prepare('SELECT id FROM candidate_request ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id)).toEqual(originalIds);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM source_demand_unit WHERE state <> 'superseded'").get()).toEqual({ count: 2 });
  });

  it('多需求模型执行期间来源 revision 变化时首轮零写入并基于新版本重跑', async () => {
    const { service, database, classifier } = await makeHarness();
    classifier.beforeReturn = (_event, call) => {
      if (call !== 1) return;
      const row = database.raw.prepare('SELECT id, metadata_json FROM source_event WHERE external_id = ?').get('multi-revision-fence') as { id: string; metadata_json: string };
      database.raw.prepare('UPDATE source_event SET content = ?, metadata_json = ? WHERE id = ?')
        .run('模型执行期间到达的新版本。', JSON.stringify({ ...JSON.parse(row.metadata_json), sourceVersion: 2 }), row.id);
    };

    const result = await service.ingestSource({ ...source('multi-revision-fence', '最初版本。'), metadata: { sourceVersion: 1 } });

    expect(classifier.calls).toBe(2);
    expect(result.candidateIds).toHaveLength(2);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual({ count: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 2 });
  });

  it('Runtime 完成结果与持久化 checkpoint 都保存兼容单 ID 和三组完整 ID', async () => {
    const { service, database } = await makeHarness();
    const result = await service.ingestSourceBatch([
      source('multi-runtime-a', '请分析活动A留存。', '2026-08-13T09:00:00.000Z'),
      source('multi-runtime-b', '请分析活动B付费。', '2026-08-13T09:02:00.000Z'),
    ]);
    const job = database.raw.prepare("SELECT id, result_json FROM job WHERE job_type = 'classify_source_batch'").get() as { id: string; result_json: string };
    const resultJson = JSON.parse(job.result_json);
    const checkpoint = database.raw.prepare(
      "SELECT state_json FROM runtime_checkpoint WHERE job_id = ? AND step = 'classification_persisted' ORDER BY rowid DESC LIMIT 1",
    ).get(job.id) as { state_json: string };
    const checkpointJson = JSON.parse(checkpoint.state_json);

    for (const value of [resultJson, checkpointJson]) {
      expect(value.candidateId).toBe(result.candidateIds[0]);
      expect(new Set(value.candidateIds)).toEqual(new Set(result.candidateIds));
      expect(new Set(value.demandUnitIds)).toEqual(new Set(result.demandUnitIds));
      expect(new Set(value.threadIds)).toEqual(new Set(result.threadIds));
    }
  });

  it('多需求批次完成后再次进入幂等恢复快路径仍返回 2 个候选、单元和线程', async () => {
    const { service, classifier } = await makeHarness();
    const events = [
      source('multi-fast-path-a', '请分析活动A留存。', '2026-08-13T09:00:00.000Z'),
      source('multi-fast-path-b', '请分析活动B付费。', '2026-08-13T09:02:00.000Z'),
    ];
    const first = await service.ingestSourceBatch(events);
    const second = await service.ingestSourceBatch(events, undefined, { retryFailed: true });

    expect(second.candidateIds.sort()).toEqual(first.candidateIds.sort());
    expect(second.demandUnitIds.sort()).toEqual(first.demandUnitIds.sort());
    expect(second.threadIds.sort()).toEqual(first.threadIds.sort());
    expect(classifier.calls).toBe(1);
  });
});
