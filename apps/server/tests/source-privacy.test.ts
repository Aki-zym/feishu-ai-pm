import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';
import {
  candidateReprocessDtoSchema,
  candidateSourceRetryDtoSchema,
  correctionActionDtoSchema,
  correctionListDtoSchema,
  dashboardDtoSchema,
  minimalCandidateDtoSchema,
  minimalSourceDtoSchema,
  ownerInformationDtoSchema,
  taskDetailDtoSchema,
  taskDtoSchema,
  taskListDtoSchema,
  taskUpdateProposalDtoSchema,
  threadDetailDtoSchema,
  threadListDtoSchema,
} from '../src/source-privacy.js';
import { registerSimulatedMessageRoute } from './support/simulated-message-route.js';

describe('PROD-01 默认来源最小化与主人核验', () => {
  const databases: AppDatabase[] = [];
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const database of databases.splice(0)) database.close();
  });

  async function fixture() {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const service = new PmService(database, createAdapters(config), config);
    const app = await buildApp(service, { serveWeb: false });
    apps.push(app);
    registerSimulatedMessageRoute(app, service, {
      testOnly: true,
      nodeEnv: config.nodeEnv,
      databaseProvider: config.database.provider,
      databaseUrl: config.database.url,
    });
    return { app, database, service };
  }

  it('默认候选/任务来源 DTO 只返回白名单字段，不携带正文、外部 ID 或 provider', async () => {
    const { app, database } = await fixture();
    const externalId = 'prod-01-synthetic-external-id';
    const secretText = 'prod-01-synthetic-source-body-never-default';
    const created = await app.inject({
      method: 'POST',
      url: '/api/dev/simulate-message',
      payload: {
        externalId,
        sourceType: 'owner_dm',
        conversationId: 'synthetic-chat',
        senderId: 'synthetic-sender',
        senderName: '合成需求方',
        content: `想看一下新活动的留存数据，验证是否值得继续投入。${secretText}`,
        occurredAt: '2026-08-16T00:00:00.000Z',
      },
    });
    expect(created.statusCode).toBe(200);
    const listed = await app.inject({ method: 'GET', url: '/api/candidates?state=pending' });
    expect(listed.statusCode).toBe(200);
    const candidate = listed.json().items[0] as Record<string, unknown>;
    const candidateVersion = (database.raw.prepare('SELECT version FROM candidate_request WHERE id = ?').get(String(candidate.id)) as { version: number }).version;
    expect(candidate).not.toHaveProperty('source_event_id');
    expect(candidate).not.toHaveProperty('source_url');
    expect(candidate).not.toHaveProperty('ai_provider');
    expect(candidate).not.toHaveProperty('ai_model');
    expect(candidate).not.toHaveProperty('prompt_version');
    expect((candidate.analysis as Record<string, unknown>).timeRange).toMatchObject({ sourceText: null });
    expect(JSON.stringify(candidate)).not.toContain(externalId);
    expect(JSON.stringify(candidate)).not.toContain(secretText);

    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${String(candidate.id)}/action`, payload: { action: 'accept', expectedVersion: candidateVersion } });
    const taskId = String(accepted.json().task.id);
    database.raw.prepare(
      `INSERT INTO reference_binding (id, task_id, label, reference_path, access_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('reference-prod-01', taskId, '合成参考', 'workspace://prod-01-secret-path', 'reference_only', '2026-08-16T00:00:00.000Z');
    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(detail.statusCode).toBe(200);
    const source = detail.json().sources[0] as Record<string, unknown>;
    expect(Object.keys(source).sort()).toEqual(['completeness', 'occurred_at', 'source_scope', 'source_type', 'summary_available']);
    expect(JSON.stringify(detail.json())).not.toContain(externalId);
    expect(JSON.stringify(detail.json())).not.toContain(secretText);
    expect(JSON.stringify(detail.json())).not.toContain('provider');
    expect(JSON.stringify(detail.json())).not.toContain('workspace://prod-01-secret-path');
    expect(detail.json().references[0]).toMatchObject({ id: 'reference-prod-01', label: '合成参考', path_bound: true });

    const rejected = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/sources/${String(source.source_scope)}/verify`, payload: { confirmed: false } });
    expect(rejected.statusCode).toBe(400);
    const verified = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/sources/${String(source.source_scope)}/verify`, payload: { confirmed: true } });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      status: 'local_snapshot_verified',
      reason: 'available',
      provider_status: 'unknown',
      excerpt_redacted: true,
      external_action: 'none',
    });
    expect(verified.json().message).toContain('本地保存的来源快照');
    expect(verified.json().message).toContain('不代表当前 provider');
    expect(verified.json()).not.toHaveProperty('external_id');
    expect(verified.json()).not.toHaveProperty('provider');
    const verificationAudit = database.raw.prepare("SELECT event_type, context_json FROM app_log WHERE event_type = 'source.verification.completed'").get() as { event_type: string; context_json: string } | undefined;
    expect(verificationAudit?.event_type).toBe('source.verification.completed');
    expect(verificationAudit?.context_json).not.toContain(String(source.source_scope));
    expect(verificationAudit?.context_json).toContain('relationFingerprint');
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count).toBe(0);
  });

  it('来源 DTO schema 对未知字段 fail-closed', () => {
    expect(() => minimalSourceDtoSchema.parse({
      source_scope: 'src_scope_00000000000000000000000000000000',
      source_type: 'owner_dm',
      completeness: 'complete',
      occurred_at: '2026-08-16T00:00:00.000Z',
      summary_available: false,
      content: 'must reject',
    })).toThrow();
  });

  it('短来源 canary 与原始同步错误不会进入 candidate/task/owner 默认响应', async () => {
    const { app, database } = await fixture();
    const shortCanary = 'ZX7K9';
    const proposerCanary = 'PROPOSER_IDENTITY_CANARY';
    const crossWhitespaceCanary = 'ZX 7 K9';
    const caseCanary = 'zx7k9';
    const unicodeCanary = 'e\u0301';
    const ownerErrorCanary = 'OWNER_RAW_ERROR_CANARY token=secret-value';
    const created = await app.inject({
      method: 'POST',
      url: '/api/dev/simulate-message',
      payload: {
        externalId: 'prod-01-short-canary',
        sourceType: 'owner_dm',
        conversationId: 'synthetic-chat-short',
        senderId: 'synthetic-sender-short',
        senderName: proposerCanary,
        content: `请分析活动效果 ${shortCanary} é`,
        occurredAt: '2026-08-16T01:00:00.000Z',
      },
    });
    expect(created.statusCode).toBe(200);
    const candidateId = String(created.json().candidate.id);
    const candidateVersion = (created.json().candidate as { version: number }).version;
    database.raw.prepare(
      `UPDATE candidate_request
       SET title = ?, proposer_name = ?, background = ?, validation_question = ?, describe = ?,
           analysis_json = ?
       WHERE id = ?`,
    ).run(
      `标题 ${shortCanary} ${crossWhitespaceCanary}`,
      proposerCanary,
      `背景 ${unicodeCanary}`,
      `问题 ${shortCanary}`,
      `摘要 ${crossWhitespaceCanary}`,
      JSON.stringify({
        recognitionEvidence: [`依据 ${shortCanary}`],
        ownerAction: { required: true, summary: `动作 ${crossWhitespaceCanary}`, role: `role ${unicodeCanary}`, basis: `basis ${caseCanary}`, confidence: 0.9 },
        note: `备注 ${shortCanary}`,
        nextStepSuggestion: `下一步 ${shortCanary}`,
        waitingReasonSuggestion: `等待 ${shortCanary}`,
        statusSuggestion: `status ${shortCanary}`,
        linkedDocuments: [{ documentType: `docx ${shortCanary}`, status: shortCanary, freshness: caseCanary, completeness: unicodeCanary, truncated: false }],
      }),
      candidateId,
    );
    database.raw.prepare(
      `UPDATE information_source_state SET status = 'error', last_error = ? WHERE source_kind = 'owner_dm'`,
    ).run(ownerErrorCanary);

    const listed = await app.inject({ method: 'GET', url: '/api/candidates?state=pending' });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).not.toContain(shortCanary);
    expect(() => minimalCandidateDtoSchema.parse(listed.json().items[0])).not.toThrow();

    const pendingDashboard = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(pendingDashboard.statusCode).toBe(200);
    expect(JSON.stringify(pendingDashboard.json())).not.toContain(shortCanary);
    expect(() => dashboardDtoSchema.parse(pendingDashboard.json())).not.toThrow();

    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${candidateId}/action`, payload: { action: 'accept', expectedVersion: candidateVersion } });
    expect(accepted.statusCode).toBe(200);
    const taskId = String(accepted.json().task.id);
    database.raw.prepare('UPDATE task_event SET summary = ?, before_json = ?, after_json = ? WHERE task_id = ?')
      .run(`事件 ${crossWhitespaceCanary}`, JSON.stringify({ note: shortCanary }), JSON.stringify({ note: unicodeCanary }), taskId);
    database.raw.prepare('INSERT INTO reference_binding (id, task_id, label, reference_path, access_mode, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('prod-01-canary-reference', taskId, `参考 ${shortCanary}`, 'workspace://synthetic-canary', 'reference_only', new Date().toISOString());
    const thread = database.raw.prepare('SELECT thread_id FROM task WHERE id = ?').get(taskId) as { thread_id: string | null };
    if (thread.thread_id) {
      database.raw.prepare('UPDATE requirement_thread SET title = ?, background = ?, validation_question = ?, describe = ? WHERE id = ?')
        .run(`线程 ${shortCanary}`, `背景 ${crossWhitespaceCanary}`, `问题 ${caseCanary}`, `摘要 ${unicodeCanary}`, thread.thread_id);
    }
    database.raw.prepare('UPDATE job SET last_error = ? WHERE task_id = ? OR source_event_id IN (SELECT source_event_id FROM task_source_link WHERE task_id = ?)')
      .run(`runtime ${ownerErrorCanary}`, taskId, taskId);
    database.raw.prepare('UPDATE memory_projection SET last_error = ? WHERE task_id = ?')
      .run(`memory ${ownerErrorCanary}`, taskId);
    const taskRow = database.raw.prepare(
      'SELECT version, thread_id FROM task WHERE id = ?',
    ).get(taskId) as { version: number; thread_id: string | null };
    const sourceRow = database.raw.prepare(
      'SELECT source_event_id FROM task_source_link WHERE task_id = ? LIMIT 1',
    ).get(taskId) as { source_event_id: string };
    const proposalId = 'prod-01-canary-proposal';
    database.raw.prepare(
      `INSERT INTO task_update_proposal
        (id, task_id, thread_id, source_event_id, base_task_version, patch_json, reason, evidence_json,
         provider, model, prompt_version, policy_version, policy_reason, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      proposalId,
      taskId,
      taskRow.thread_id,
      sourceRow.source_event_id,
      taskRow.version,
      JSON.stringify({ title: `提案 ${shortCanary}`, status: 'planned', risk: 'high' }),
      `原因 ${crossWhitespaceCanary}`,
      JSON.stringify([`证据 ${caseCanary}`]),
      `provider ${shortCanary}`,
      `model ${unicodeCanary}`,
      `prompt ${shortCanary}`,
      `policy-version ${shortCanary}`,
      `policy ${ownerErrorCanary}`,
      proposalId,
      new Date().toISOString(),
    );
    database.raw.prepare(
      `UPDATE task
       SET title = ?, proposer_name = ?, describe = ?, next_step = ?, waiting_reason = ?,
           status = 'planned', planned_due_at = ?
       WHERE id = ?`,
    ).run(
      `任务 ${shortCanary}`,
      proposerCanary,
      `任务摘要 ${caseCanary}`,
      `下一步 ${unicodeCanary}`,
      `等待 ${shortCanary}`,
      new Date().toISOString(),
      taskId,
    );

    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(detail.statusCode).toBe(200);
    const detailJson = JSON.stringify(detail.json());
    for (const canary of [shortCanary, crossWhitespaceCanary, caseCanary, unicodeCanary, ownerErrorCanary, proposerCanary]) {
      expect(detailJson).not.toContain(canary);
    }
    expect(() => taskDetailDtoSchema.parse(detail.json())).not.toThrow();

    const tasks = await app.inject({ method: 'GET', url: '/api/tasks?recordState=all&deleted=all' });
    expect(tasks.statusCode).toBe(200);
    expect(JSON.stringify(tasks.json())).not.toContain(shortCanary);
    expect(tasks.json().items[0]).not.toHaveProperty('thread_id');
    expect(() => taskListDtoSchema.parse(tasks.json())).not.toThrow();

    const taskDashboard = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(taskDashboard.statusCode).toBe(200);
    expect(JSON.stringify(taskDashboard.json())).not.toContain(shortCanary);
    expect(() => dashboardDtoSchema.parse(taskDashboard.json())).not.toThrow();

    const threadList = await app.inject({ method: 'GET', url: '/api/threads' });
    expect(threadList.statusCode).toBe(200);
    expect(() => threadListDtoSchema.parse(threadList.json())).not.toThrow();
    expect(JSON.stringify(threadList.json())).not.toContain(shortCanary);
    expect(JSON.stringify(threadList.json())).not.toContain(ownerErrorCanary);
    if (thread.thread_id) {
      const threadDetail = await app.inject({ method: 'GET', url: `/api/threads/${thread.thread_id}` });
      expect(threadDetail.statusCode).toBe(200);
      expect(() => threadDetailDtoSchema.parse(threadDetail.json())).not.toThrow();
      const threadText = JSON.stringify(threadDetail.json());
      for (const canary of [shortCanary, crossWhitespaceCanary, caseCanary, unicodeCanary, ownerErrorCanary, proposerCanary]) {
        expect(threadText).not.toContain(canary);
      }
    }

    const calendar = await app.inject({ method: 'GET', url: '/api/calendar' });
    expect(calendar.statusCode).toBe(200);
    expect(JSON.stringify(calendar.json())).not.toContain(shortCanary);

    const notifications = await app.inject({ method: 'GET', url: '/api/notifications' });
    expect(notifications.statusCode).toBe(200);
    expect(JSON.stringify(notifications.json())).not.toContain(shortCanary);

    const proposalList = await app.inject({ method: 'GET', url: '/api/task-update-proposals?state=awaiting_approval' });
    expect(proposalList.statusCode).toBe(200);
    const publicProposal = proposalList.json().items.find((item: { id: string }) => item.id === proposalId);
    expect(() => taskUpdateProposalDtoSchema.parse(publicProposal)).not.toThrow();
    const proposalDetail = await app.inject({ method: 'GET', url: `/api/task-update-proposals/${proposalId}` });
    expect(proposalDetail.statusCode).toBe(200);
    expect(() => taskUpdateProposalDtoSchema.parse(proposalDetail.json())).not.toThrow();
    expect(proposalDetail.json()).toMatchObject({ policy_version: 'unknown', policy_reason: '服务端策略门禁已记录。' });
    for (const response of [proposalList.json(), proposalDetail.json()]) {
      const text = JSON.stringify(response);
      for (const canary of [shortCanary, crossWhitespaceCanary, caseCanary, unicodeCanary, ownerErrorCanary, proposerCanary]) {
        expect(text).not.toContain(canary);
      }
      for (const forbidden of ['provider', 'model', 'prompt_version', 'evidence_json', 'before_snapshot_json', 'after_snapshot_json']) {
        expect(text).not.toContain(forbidden);
      }
    }

    const rejectedProposal = await app.inject({ method: 'POST', url: `/api/task-update-proposals/${proposalId}/reject` });
    expect(rejectedProposal.statusCode).toBe(200);
    expect(() => taskDetailDtoSchema.parse(rejectedProposal.json())).not.toThrow();
    const rejectedProposalText = JSON.stringify(rejectedProposal.json());
    for (const canary of [shortCanary, crossWhitespaceCanary, caseCanary, unicodeCanary, ownerErrorCanary, proposerCanary]) {
      expect(rejectedProposalText).not.toContain(canary);
    }

    const corrected = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: {
        correctionType: 'describe_incomplete',
        taskId,
        expectedTaskVersion: detail.json().version,
        replacementValue: `补充摘要 ${shortCanary}`,
        note: `private note ${ownerErrorCanary}`,
      },
    });
    expect(corrected.statusCode).toBe(200);
    expect(JSON.stringify(corrected.json())).not.toContain(shortCanary);
    expect(JSON.stringify(corrected.json())).not.toContain(ownerErrorCanary);
    expect(() => correctionActionDtoSchema.parse(corrected.json())).not.toThrow();

    const corrections = await app.inject({ method: 'GET', url: '/api/corrections' });
    expect(corrections.statusCode).toBe(200);
    expect(JSON.stringify(corrections.json())).not.toContain(shortCanary);
    expect(JSON.stringify(corrections.json())).not.toContain(ownerErrorCanary);
    expect(corrections.json().items[0]).not.toHaveProperty('source_event_id');
    expect(corrections.json().items[0]).not.toHaveProperty('before_json');
    expect(corrections.json().items[0]).not.toHaveProperty('after_json');
    expect(corrections.json().items[0]).not.toHaveProperty('note');
    expect(() => correctionListDtoSchema.parse(corrections.json())).not.toThrow();

    const reprocessed = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidateId}/reprocess`,
      payload: { guidance: '按已确认的安全边界重新整理。', expectedVersion: (database.raw.prepare('SELECT version FROM candidate_request WHERE id = ?').get(candidateId) as { version: number }).version },
    });
    expect(reprocessed.statusCode).toBe(200);
    expect(JSON.stringify(reprocessed.json())).not.toContain(shortCanary);
    expect(reprocessed.json()).not.toHaveProperty('reason');
    expect(() => candidateReprocessDtoSchema.parse(reprocessed.json())).not.toThrow();

    const owner = await app.inject({ method: 'GET', url: '/api/owner-information' });
    expect(owner.statusCode).toBe(200);
    expect(JSON.stringify(owner.json())).not.toContain(ownerErrorCanary);
    expect(owner.json().sources.find((source: { kind: string }) => source.kind === 'owner_dm')).toMatchObject({
      status: 'error',
      issue: { code: 'sync_failed', message: '最近同步失败；详细诊断已脱敏保留。' },
    });
    expect(() => ownerInformationDtoSchema.parse(owner.json())).not.toThrow();
  });

  it('派生摘要保留共享业务词，只有有界原文片段或秘密 canary 才降级', async () => {
    const { app, database } = await fixture();
    const sourceText = '请分析新活动上线后的留存表现';
    const safeTitle = '留存分析';
    const safeBackground = '分析新活动留存表现';
    const safeQuestion = 'How will launch retention change?';
    const safeDescribe = 'Evaluate retention after the launch.';

    const create = async (externalId: string, content: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/dev/simulate-message',
        payload: {
          externalId,
          sourceType: 'owner_dm',
          conversationId: `${externalId}-chat`,
          senderId: `${externalId}-sender`,
          senderName: '合成需求方',
          content,
          occurredAt: '2026-08-16T03:00:00.000Z',
        },
      });
      expect(response.statusCode).toBe(200);
      return String(response.json().candidate.id);
    };
    const sourceAndThread = (candidateId: string) => {
      const row = database.raw.prepare(
        `SELECT candidate_request.*, source_event.id AS source_id,
                requirement_thread_source.thread_id
         FROM candidate_request
         JOIN source_event ON source_event.id = candidate_request.source_event_id
         LEFT JOIN requirement_thread_source ON requirement_thread_source.source_event_id = source_event.id
         WHERE candidate_request.id = ?`,
      ).get(candidateId) as Record<string, unknown>;
      return row;
    };
    const updateNarrative = (candidateId: string, values: { title: string; background: string; validationQuestion: string; describe: string }) => {
      database.raw.prepare(
        `UPDATE candidate_request
         SET title = ?, background = ?, validation_question = ?, describe = ?
         WHERE id = ?`,
      ).run(values.title, values.background, values.validationQuestion, values.describe, candidateId);
    };
    const publicCandidate = async (candidateId: string) => {
      const response = await app.inject({ method: 'GET', url: '/api/candidates?state=pending' });
      expect(response.statusCode).toBe(200);
      return response.json().items.find((item: { id: string }) => item.id === candidateId) as Record<string, any>;
    };

    const candidateId = await create('prod-01-summary-positive', sourceText);
    const candidateRow = sourceAndThread(candidateId);
    database.raw.prepare('UPDATE source_event SET content = ? WHERE id = ?').run(sourceText, String(candidateRow.source_id));
    updateNarrative(candidateId, {
      title: safeTitle,
      background: safeBackground,
      validationQuestion: safeQuestion,
      describe: safeDescribe,
    });

    const listed = await publicCandidate(candidateId);
    expect(listed).toMatchObject({ title: safeTitle, background: safeBackground, validation_question: safeQuestion, describe: safeDescribe });
    expect(JSON.stringify(listed)).not.toContain(sourceText);

    const shortSourceCandidateId = await create('prod-01-summary-short-source', '请分析活动效果并评估留存');
    const shortSourceRow = sourceAndThread(shortSourceCandidateId);
    database.raw.prepare('UPDATE source_event SET content = ? WHERE id = ?').run('活动', String(shortSourceRow.source_id));
    updateNarrative(shortSourceCandidateId, {
      title: '活动分析',
      background: '分析活动留存表现',
      validationQuestion: '活动上线后表现如何？',
      describe: '评估活动上线后的留存与参与。',
    });
    const shortSourceView = await publicCandidate(shortSourceCandidateId);
    expect(shortSourceView).toMatchObject({ title: '活动分析', background: '分析活动留存表现' });

    const negativeCases = [
      sourceText,
      '请 分析 新活动 上线 后 的 留存 表现',
      '请分析新活动上线后留存表现',
      '新活动上线后的留存表现',
      'ＺＸ７Ｋ９',
      'Authorization: Bearer secret-value',
      'ou_synthetic_owner_123',
      'doxcnSyntheticDocumentToken123',
      '550e8400-e29b-41d4-a716-446655440000',
    ];
    for (const [index, value] of negativeCases.entries()) {
      database.raw.prepare('UPDATE candidate_request SET title = ? WHERE id = ?').run(value, candidateId);
      const item = await publicCandidate(candidateId);
      expect(item.title, `negative case ${index}`).toBe('候选标题已生成；来源正文默认隐藏。');
      expect(JSON.stringify(item)).not.toContain(value);
    }
    updateNarrative(candidateId, { title: safeTitle, background: safeBackground, validationQuestion: safeQuestion, describe: safeDescribe });

    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${candidateId}/action`, payload: { action: 'accept', expectedVersion: (database.raw.prepare('SELECT version FROM candidate_request WHERE id = ?').get(candidateId) as { version: number }).version } });
    expect(accepted.statusCode).toBe(200);
    const taskId = String(accepted.json().task.id);
    expect(accepted.json().task).toMatchObject({ title: safeTitle, describe: safeDescribe });
    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ title: safeTitle, describe: safeDescribe });
    expect(JSON.stringify(detail.json())).not.toContain(sourceText);

    const targetThreadId = String((database.raw.prepare('SELECT thread_id FROM task WHERE id = ?').get(taskId) as { thread_id: string }).thread_id);
    database.raw.prepare('UPDATE requirement_thread SET title = ?, background = ?, validation_question = ?, describe = ? WHERE id = ?')
      .run(safeTitle, safeBackground, safeQuestion, safeDescribe, targetThreadId);
    const associationCandidateId = await create('prod-01-summary-association', '请分析另一项活动上线后的留存表现');
    const associationRow = sourceAndThread(associationCandidateId);
    updateNarrative(associationCandidateId, {
      title: '另一项活动留存分析',
      background: '分析另一项活动留存表现',
      validationQuestion: 'How will the second launch retain users?',
      describe: 'Evaluate retention for the second launch.',
    });
    database.raw.prepare("UPDATE requirement_thread SET status = 'needs_confirmation', ambiguity_json = ? WHERE id = ?")
      .run(JSON.stringify([targetThreadId]), String(associationRow.thread_id));
    const associationView = await publicCandidate(associationCandidateId);
    expect(associationView.thread_association.options[0]).toMatchObject({ title: safeTitle });
    const associationMutation = await app.inject({
      method: 'POST',
      url: `/api/candidates/${associationCandidateId}/thread-association`,
      payload: {
        targetThreadId,
        expectedVersion: (database.raw.prepare('SELECT version FROM candidate_request WHERE id = ?').get(associationCandidateId) as { version: number }).version,
        expectedThreadVersion: (database.raw.prepare('SELECT version FROM requirement_thread WHERE id = ?').get(String(associationRow.thread_id)) as { version: number }).version,
        expectedTargetThreadVersion: (database.raw.prepare('SELECT version FROM requirement_thread WHERE id = ?').get(targetThreadId) as { version: number }).version,
      },
    });
    expect(associationMutation.statusCode).toBe(200);
    expect(JSON.stringify(associationMutation.json())).toContain('另一项活动留存分析');
    expect(JSON.stringify(associationMutation.json())).not.toContain('请分析另一项活动上线后的留存表现');

    const mergeCurrentId = await create('prod-01-summary-merge-current', sourceText);
    const mergeTargetId = await create('prod-01-summary-merge-target', '请分析新活动上线后的付费表现');
    const mergeCurrent = sourceAndThread(mergeCurrentId);
    const mergeTarget = sourceAndThread(mergeTargetId);
    updateNarrative(mergeCurrentId, {
      title: '新活动留存分析',
      background: safeBackground,
      validationQuestion: safeQuestion,
      describe: safeDescribe,
    });
    updateNarrative(mergeTargetId, {
      title: '新活动付费分析',
      background: '分析新活动付费表现',
      validationQuestion: 'How will launch monetization change?',
      describe: 'Evaluate monetization after the launch.',
    });
    const snapshotRevision = (row: Record<string, unknown>, thread: Record<string, unknown>) => createHash('sha256').update(JSON.stringify({
      candidateId: row.id,
      candidateUpdatedAt: row.updated_at,
      candidateState: row.state,
      candidateDeletedAt: row.deleted_at,
      candidateMergedInto: row.merged_into_candidate_id,
      threadId: thread.id,
      threadVersion: thread.version,
      threadStatus: thread.status,
      threadPrimarySourceEventId: thread.primary_source_event_id,
    })).digest('hex');
    const groupVersionHash = (...rows: Array<Record<string, unknown>>) => createHash('sha256').update(JSON.stringify(rows.map((row) => ({
      id: row.id,
      version: row.version,
      updatedAt: row.updated_at,
    })).sort((left, right) => String(left.id).localeCompare(String(right.id))))).digest('hex');
    const currentThread = database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(String(mergeCurrent.thread_id)) as Record<string, unknown>;
    const targetThread = database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(String(mergeTarget.thread_id)) as Record<string, unknown>;
    const currentAnalysis = JSON.parse(String(mergeCurrent.analysis_json || '{}')) as Record<string, unknown>;
    currentAnalysis.candidateMergeSuggestion = {
      suggestionVersion: 1,
      suggestionId: 'prod-01-safe-summary-merge',
      currentCandidateId: mergeCurrentId,
      currentRootCandidateId: mergeCurrentId,
      currentThreadId: mergeCurrent.thread_id,
      currentThreadVersion: currentThread.version,
      currentSnapshotRevision: snapshotRevision(mergeCurrent, currentThread),
      currentGroupMemberIds: [mergeCurrentId],
      currentGroupVersionHash: groupVersionHash(mergeCurrent),
      targetCandidateId: mergeTargetId,
      targetRootCandidateId: mergeTargetId,
      targetThreadId: mergeTarget.thread_id,
      targetThreadVersion: targetThread.version,
      targetSnapshotRevision: snapshotRevision(mergeTarget, targetThread),
      targetGroupMemberIds: [mergeTargetId],
      targetGroupVersionHash: groupVersionHash(mergeTarget),
      confidence: 0.9,
      primary: 'current',
      primaryConfidence: 0.9,
      currentRole: 'owner_delivery',
      targetRole: 'background',
      reason: '共享业务目标，保留主人确认。',
      evidence: ['新活动留存表现'],
      candidateSetHash: 'prod-01-safe-summary-set',
    };
    database.raw.prepare('UPDATE candidate_request SET analysis_json = ? WHERE id = ?').run(JSON.stringify(currentAnalysis), mergeCurrentId);
    const mergeView = await publicCandidate(mergeCurrentId);
    expect(mergeView.merge_group.suggestion.target).toMatchObject({ title: '新活动付费分析' });
    const mergeMutation = await app.inject({
      method: 'POST',
      url: `/api/candidates/${mergeCurrentId}/merge/reject`,
      payload: {
        targetCandidateId: mergeTargetId,
        suggestionId: 'prod-01-safe-summary-merge',
        expectedVersion: (database.raw.prepare('SELECT version FROM candidate_request WHERE id = ?').get(mergeCurrentId) as { version: number }).version,
        expectedTargetVersion: (database.raw.prepare('SELECT version FROM candidate_request WHERE id = ?').get(mergeTargetId) as { version: number }).version,
        expectedGroupVersionHash: groupVersionHash(mergeCurrent, mergeTarget),
      },
    });
    expect(mergeMutation.statusCode).toBe(200);
    expect(mergeMutation.json().candidate).toMatchObject({ title: '新活动留存分析' });
    expect(mergeMutation.json().targetCandidate).toMatchObject({ title: '新活动付费分析' });
    expect(JSON.stringify(mergeMutation.json())).not.toContain(sourceText);
  });

  it('跨来源 demand-unit/merge/association/task 闭包统一阻断 secondary 原文', async () => {
    const { app, database } = await fixture();
    const create = async (externalId: string, content: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/dev/simulate-message',
        payload: {
          externalId,
          sourceType: 'owner_dm',
          conversationId: `${externalId}-chat`,
          senderId: `${externalId}-sender`,
          senderName: '合成需求方',
          content,
          occurredAt: '2026-08-16T05:00:00.000Z',
        },
      });
      expect(response.statusCode).toBe(200);
      return String(response.json().candidate.id);
    };
    const rootId = await create('prod-01-closure-root', '请分析活动参与和留存，并验证根需求 A 的投入价值。');
    const secondaryId = await create('prod-01-closure-secondary', '请分析活动参与和留存，并验证 secondary 需求 B 的投入价值。');
    const associationId = await create('prod-01-closure-association', '请分析活动参与和留存，并验证 association 需求 C 的投入价值。');
    const readCandidate = (id: string) => database.raw.prepare(
      `SELECT candidate_request.*, requirement_thread_source.thread_id
       FROM candidate_request
       LEFT JOIN requirement_thread_source ON requirement_thread_source.source_event_id = candidate_request.source_event_id
       WHERE candidate_request.id = ?`,
    ).get(id) as Record<string, any>;
    const root = readCandidate(rootId);
    const secondary = readCandidate(secondaryId);
    const association = readCandidate(associationId);
    expect(root.demand_unit_id).toBeTruthy();
    expect(secondary.thread_id).toBeTruthy();
    expect(association.thread_id).toBeTruthy();

    const secondaryRaw = 'B_ONLY_RAW_CANARY';
    const thirdRaw = 'C_THIRD_RAW_CANARY';
    database.raw.prepare('UPDATE source_event SET content = ? WHERE id = ?').run('来源 A：根需求正文。', root.source_event_id);
    database.raw.prepare('UPDATE source_event SET content = ? WHERE id = ?').run(`来源 B：${secondaryRaw}`, secondary.source_event_id);
    database.raw.prepare('UPDATE source_event SET content = ? WHERE id = ?').run(`来源 C：${thirdRaw}`, association.source_event_id);
    database.raw.prepare(
      `INSERT OR IGNORE INTO source_demand_unit_source
         (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
       VALUES (?, ?, ?, 'evidence', ?, ?)`,
    ).run(root.demand_unit_id, secondary.source_event_id, 'secondary', 1, '2026-08-16T05:01:00.000Z');
    database.raw.prepare(
      `INSERT OR IGNORE INTO source_demand_unit_source
         (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
       VALUES (?, ?, ?, 'evidence', ?, ?)`,
    ).run(root.demand_unit_id, association.source_event_id, 'association', 2, '2026-08-16T05:02:00.000Z');
    database.raw.prepare(
      'UPDATE candidate_request SET title = ?, describe = ?, analysis_json = ? WHERE id = ?',
    ).run('根需求摘要', '根需求派生摘要', JSON.stringify({ recognitionEvidence: ['根需求依据'] }), rootId);
    database.raw.prepare(
      'UPDATE candidate_request SET title = ?, describe = ?, analysis_json = ? WHERE id = ?',
    ).run(secondaryRaw, secondaryRaw, JSON.stringify({ recognitionEvidence: [secondaryRaw] }), secondaryId);
    database.raw.prepare(
      'UPDATE candidate_request SET title = ?, describe = ?, analysis_json = ? WHERE id = ?',
    ).run('第三来源摘要', thirdRaw, JSON.stringify({ recognitionEvidence: [secondaryRaw, thirdRaw] }), associationId);

    const rootThread = database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(root.thread_id) as Record<string, any>;
    const secondaryThread = database.raw.prepare('SELECT * FROM requirement_thread WHERE id = ?').get(secondary.thread_id) as Record<string, any>;
    const snapshotRevision = (candidate: Record<string, any>, thread: Record<string, any>) => createHash('sha256').update(JSON.stringify({
      candidateId: candidate.id,
      candidateUpdatedAt: candidate.updated_at,
      candidateState: candidate.state,
      candidateDeletedAt: candidate.deleted_at,
      candidateMergedInto: candidate.merged_into_candidate_id,
      threadId: thread.id,
      threadVersion: thread.version,
      threadStatus: thread.status,
      threadPrimarySourceEventId: thread.primary_source_event_id,
    })).digest('hex');
    const groupVersionHash = (candidate: Record<string, any>) => createHash('sha256').update(JSON.stringify([{
      id: candidate.id,
      version: candidate.version,
      updatedAt: candidate.updated_at,
    }])).digest('hex');
    database.raw.prepare('UPDATE candidate_request SET analysis_json = ? WHERE id = ?').run(JSON.stringify({
      candidateMergeSuggestion: {
        suggestionVersion: 1,
        suggestionId: 'prod-01-cross-source-merge',
        currentCandidateId: rootId,
        currentRootCandidateId: rootId,
        currentThreadId: rootThread.id,
        currentThreadVersion: rootThread.version,
        currentSnapshotRevision: snapshotRevision(root, rootThread),
        currentGroupMemberIds: [rootId],
        currentGroupVersionHash: groupVersionHash(root),
        targetCandidateId: secondaryId,
        targetRootCandidateId: secondaryId,
        targetThreadId: secondaryThread.id,
        targetThreadVersion: secondaryThread.version,
        targetSnapshotRevision: snapshotRevision(secondary, secondaryThread),
        targetGroupMemberIds: [secondaryId],
        targetGroupVersionHash: groupVersionHash(secondary),
        confidence: 0.9,
        primary: 'current',
        primaryConfidence: 0.9,
        currentRole: 'owner_delivery',
        targetRole: 'background',
        reason: '需要主人确认的归并建议',
        evidence: [secondaryRaw],
        candidateSetHash: 'prod-01-cross-source-set',
      },
    }), rootId);

    const listed = await app.inject({ method: 'GET', url: '/api/candidates?state=pending' });
    expect(listed.statusCode).toBe(200);
    const listedText = JSON.stringify(listed.json());
    expect(listedText).not.toContain(secondaryRaw);
    expect(listedText).not.toContain(thirdRaw);
    const rootView = listed.json().items.find((item: { id: string }) => item.id === rootId) as Record<string, any>;
    expect(rootView.merge_group.suggestion.target.title).toBe('目标候选摘要已保留；来源正文默认隐藏。');
    expect(rootView.merge_group.sources.some((source: { title: string }) => source.title === secondaryRaw)).toBe(false);

    const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(dashboard.statusCode).toBe(200);
    expect(JSON.stringify(dashboard.json())).not.toContain(secondaryRaw);
    expect(JSON.stringify(dashboard.json())).not.toContain(thirdRaw);

    database.raw.prepare('UPDATE requirement_thread SET title = ? WHERE id = ?').run(secondaryRaw, secondary.thread_id);
    database.raw.prepare('UPDATE requirement_thread SET status = \'needs_confirmation\', ambiguity_json = ? WHERE id = ?')
      .run(JSON.stringify([secondary.thread_id]), association.thread_id);
    const associationListed = await app.inject({ method: 'GET', url: '/api/candidates?state=pending' });
    expect(associationListed.statusCode).toBe(200);
    const associationView = associationListed.json().items.find((item: { id: string }) => item.id === associationId) as Record<string, any>;
    expect(associationView.thread_association.options[0].title).toBe('候选线程摘要已保留；来源正文默认隐藏。');
    expect(JSON.stringify(associationView)).not.toContain(secondaryRaw);

    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${rootId}/action`, payload: { action: 'accept', expectedVersion: (database.raw.prepare('SELECT version FROM candidate_request WHERE id = ?').get(rootId) as { version: number }).version } });
    expect(accepted.statusCode).toBe(200);
    const taskId = String(accepted.json().task.id);
    database.raw.prepare('UPDATE task SET title = ?, describe = ? WHERE id = ?').run(secondaryRaw, secondaryRaw, taskId);
    database.raw.prepare('UPDATE task_event SET summary = ? WHERE task_id = ?').run(secondaryRaw, taskId);
    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(detail.json())).not.toContain(secondaryRaw);
    expect(JSON.stringify(detail.json())).not.toContain(thirdRaw);
  });

  it('candidate/task/owner 顶层 DTO 均拒绝未知字段', () => {
    expect(() => minimalCandidateDtoSchema.parse({ unexpected: true })).toThrow();
    expect(() => taskDtoSchema.parse({ unexpected: true })).toThrow();
    expect(() => taskDetailDtoSchema.parse({ unexpected: true })).toThrow();
    expect(() => ownerInformationDtoSchema.parse({ owner: null, sources: [], unexpected: true })).toThrow();
    expect(() => candidateSourceRetryDtoSchema.parse({ status: 'queued', message: '已排队。', sourceEventId: 'must-reject' })).toThrow();
    expect(() => correctionListDtoSchema.parse({ items: [], unexpected: true })).toThrow();
  });

  it('候选来源重试只接受候选范围 opaque scope，并返回无来源 ID 的严格回执', async () => {
    const { app, database } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/api/dev/simulate-message',
      payload: {
        externalId: 'prod-01-candidate-source-retry-scope',
        sourceType: 'owner_dm',
        conversationId: 'synthetic-chat-candidate-source-retry-scope',
        senderId: 'synthetic-sender-candidate-source-retry-scope',
        senderName: '合成需求方',
        content: '请分析活动参与和留存，验证是否值得继续投入。',
        occurredAt: '2026-08-16T01:30:00.000Z',
      },
    });
    expect(created.statusCode).toBe(200);
    const candidateId = String(created.json().candidate.id);
    const listed = await app.inject({ method: 'GET', url: '/api/candidates?state=pending' });
    expect(listed.statusCode).toBe(200);
    const candidate = listed.json().items.find((item: { id: string }) => item.id === candidateId) as { id: string; version: number; source_scope: string };
    const sourceId = String((database.raw.prepare('SELECT source_event_id FROM candidate_request WHERE id = ?').get(candidate.id) as { source_event_id: string }).source_event_id);
    expect(candidate.source_scope).toMatch(/^src_scope_[a-f0-9]{32}$/u);
    expect(candidate).not.toHaveProperty('source_event_id');

    const wrongScope = `src_scope_${'0'.repeat(32)}`;
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/source-retry`,
      payload: { sourceScope: wrongScope, expectedVersion: candidate.version },
    });
    expect(rejected.statusCode).toBe(404);
    expect(rejected.json()).toEqual({ error: '来源范围无效。' });
    expect(JSON.stringify(rejected.json())).not.toContain(sourceId);

    const retried = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/source-retry`,
      payload: { sourceScope: candidate.source_scope, expectedVersion: candidate.version },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(Object.keys(retried.json()).sort()).toEqual(['message', 'status']);
    expect(candidateSourceRetryDtoSchema.parse(retried.json())).toEqual(retried.json());
    expect(JSON.stringify(retried.json())).not.toContain('sourceEventId');
    expect(JSON.stringify(retried.json())).not.toContain(sourceId);

    database.raw.prepare('UPDATE candidate_request SET version = version + 1 WHERE id = ?').run(candidate.id);
    const stale = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/source-retry`,
      payload: { sourceScope: candidate.source_scope, expectedVersion: candidate.version },
    });
    expect(stale.statusCode).toBe(409);
    expect(JSON.stringify(stale.json())).not.toContain('sourceEventId');
    expect(JSON.stringify(stale.json())).not.toContain(sourceId);
  });

  it('主人来源核验以受控五态返回，不把撤回、权限、损坏或不可用误报为成功', async () => {
    const { app, database } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/api/dev/simulate-message',
      payload: {
        externalId: 'prod-01-verification-states',
        sourceType: 'owner_dm',
        conversationId: 'synthetic-chat-verification',
        senderId: 'synthetic-sender-verification',
        senderName: '合成需求方',
        content: '请分析这项活动是否值得继续。',
        occurredAt: '2026-08-16T02:00:00.000Z',
      },
    });
    const candidateId = String(created.json().candidate.id);
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${candidateId}/action`, payload: { action: 'accept', expectedVersion: (created.json().candidate as { version: number }).version } });
    const taskId = String(accepted.json().task.id);
    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    const scope = String(detail.json().sources[0].source_scope);
    const sourceId = String((database.raw.prepare('SELECT source_event_id FROM task_source_link WHERE task_id = ? LIMIT 1').get(taskId) as { source_event_id: string }).source_event_id);

    const cases = [
      { metadataJson: JSON.stringify({ withdrawn: true }), content: '', status: 'local_snapshot_unavailable', reason: 'snapshot_marked_revoked', provider_status: 'unknown', message: '本地保存的来源快照标记为已撤回或删除；未执行实时 provider 核验，当前状态未知。' },
      { metadataJson: JSON.stringify({ permissionDenied: true }), content: 'permission secret', status: 'local_snapshot_unavailable', reason: 'snapshot_permission_unavailable', provider_status: 'unknown', message: '本地保存的来源快照标记为权限不可用；未执行实时 provider 核验，当前状态未知。' },
      { metadataJson: '{malformed', content: 'corrupt source secret', status: 'local_snapshot_unavailable', reason: 'snapshot_content_corrupt', provider_status: 'unknown', message: '本地保存的来源快照内容损坏；未执行实时 provider 核验，当前状态未知。' },
      { metadataJson: JSON.stringify({}), content: '', status: 'local_snapshot_unavailable', reason: 'snapshot_content_missing', provider_status: 'unknown', message: '本地保存的来源快照没有可用正文；未执行实时 provider 核验，当前状态未知。' },
      { metadataJson: JSON.stringify({ lastKnownProviderStatus: 'permission_denied', lastKnownProviderStatusAt: '2026-08-15T08:00:00.000Z' }), content: 'safe verification text', status: 'local_snapshot_verified', reason: 'available', provider_status: 'last_known_permission_denied', provider_status_at: '2026-08-15T08:00:00.000Z', message: '已核验本地保存的来源快照片段；不代表当前 provider 权限或撤回状态。' },
    ] as const;
    for (const item of cases) {
      database.raw.prepare('UPDATE source_event SET content = ?, metadata_json = ? WHERE id = ?')
        .run(item.content, item.metadataJson, sourceId);
      const verified = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/sources/${scope}/verify`, payload: { confirmed: true } });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({ status: item.status, reason: item.reason, provider_status: item.provider_status, message: item.message, external_action: 'none' });
      if ('provider_status_at' in item) expect(verified.json().provider_status_at).toBe(item.provider_status_at);
      expect(verified.json().content_excerpt === null).toBe(item.status !== 'local_snapshot_verified');
      if (item.reason === 'snapshot_content_corrupt') expect(JSON.stringify(verified.json())).not.toContain('corrupt source secret');
    }
    expect((database.raw.prepare("SELECT COUNT(*) AS count FROM app_log WHERE event_type = 'source.verification.failed'").get() as { count: number }).count).toBe(4);
  });

  it('来源正文损坏和审计写入失败均 fail-closed，不返回正文或伪造 completed 审计', async () => {
    const { app, database } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/api/dev/simulate-message',
      payload: {
        externalId: 'prod-01-verification-rollback',
        sourceType: 'owner_dm',
        conversationId: 'synthetic-chat-rollback',
        senderId: 'synthetic-sender-rollback',
        senderName: '合成需求方',
        content: '请分析这项活动的参与、留存和付费效果，并验证是否值得继续投入。',
        occurredAt: '2026-08-16T02:30:00.000Z',
      },
    });
    const candidateId = String(created.json().candidate.id);
    const accepted = await app.inject({ method: 'POST', url: `/api/candidates/${candidateId}/action`, payload: { action: 'accept', expectedVersion: (created.json().candidate as { version: number }).version } });
    const taskId = String(accepted.json().task.id);
    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    const scope = String(detail.json().sources[0].source_scope);
    const sourceId = String((database.raw.prepare('SELECT source_event_id FROM task_source_link WHERE task_id = ? LIMIT 1').get(taskId) as { source_event_id: string }).source_event_id);

    database.raw.prepare('UPDATE source_event SET content = ?, metadata_json = ? WHERE id = ?')
      .run('CORRUPT_CONTENT_CANARY secret-value', '{not-json', sourceId);
    const corrupt = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/sources/${scope}/verify`, payload: { confirmed: true } });
    expect(corrupt.statusCode).toBe(200);
    expect(corrupt.json()).toMatchObject({ status: 'local_snapshot_unavailable', reason: 'snapshot_content_corrupt', provider_status: 'unknown', content_excerpt: null, external_action: 'none' });
    expect(JSON.stringify(corrupt.json())).not.toContain('CORRUPT_CONTENT_CANARY');
    expect((database.raw.prepare("SELECT COUNT(*) AS count FROM app_log WHERE event_type = 'source.verification.completed'").get() as { count: number }).count).toBe(0);
    expect((database.raw.prepare("SELECT COUNT(*) AS count FROM app_log WHERE event_type = 'source.verification.failed'").get() as { count: number }).count).toBe(1);

    database.raw.prepare('UPDATE source_event SET content = ?, metadata_json = ? WHERE id = ?')
      .run('AUDIT_ROLLBACK_CANARY secret-value', '{}', sourceId);
    database.raw.exec(`CREATE TRIGGER fail_source_verification_audit
      BEFORE INSERT ON app_log
      WHEN NEW.event_type LIKE 'source.verification.%'
      BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
    const failed = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/sources/${scope}/verify`, payload: { confirmed: true } });
    expect(failed.statusCode).toBe(409);
    expect(JSON.stringify(failed.json())).not.toContain('AUDIT_ROLLBACK_CANARY');
    expect((database.raw.prepare("SELECT COUNT(*) AS count FROM app_log WHERE event_type LIKE 'source.verification.%'").get() as { count: number }).count).toBe(1);
    expect((database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count).toBe(0);
    database.raw.exec('DROP TRIGGER fail_source_verification_audit');
  });

  it('任务修改回执保留完整详情，结构化排期不会被正文清洗破坏', async () => {
    const { app } = await fixture();
    const conversationId = 'prod-01-structured-schedule';
    const initial = await app.inject({
      method: 'POST',
      url: '/api/dev/simulate-message',
      payload: {
        externalId: 'prod-01-structured-schedule-initial',
        sourceType: 'owner_dm',
        conversationId,
        senderId: 'synthetic-schedule-requester',
        senderName: '合成排期需求方',
        content: '请用数据验证活动参与和留存，并建立一项正式任务。',
        occurredAt: '2026-08-16T03:00:00.000Z',
      },
    });
    const candidateId = String(initial.json().candidate.id);
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidateId}/action`,
      payload: { action: 'accept', expectedVersion: (initial.json().candidate as { version: number }).version },
    });
    const taskId = String(accepted.json().task.id);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: {
        plannedStartAt: '2030-08-15T01:00:00.000Z',
        plannedDueAt: '2030-08-15T03:00:00.000Z',
        status: 'planned',
        expectedVersion: 1,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id: taskId,
      planned_start_at: '2030-08-15T01:00:00.000Z',
      planned_due_at: '2030-08-15T03:00:00.000Z',
      update_proposals: [],
      sources: expect.any(Array),
      events: expect.any(Array),
    });

    const followUp = await app.inject({
      method: 'POST',
      url: '/api/dev/simulate-message',
      payload: {
        externalId: 'prod-01-structured-schedule-follow-up',
        sourceType: 'owner_dm',
        conversationId,
        senderId: 'synthetic-schedule-requester',
        senderName: '合成排期需求方',
        content: '补充：请继续分析付费维度，计划在2030年8月16日前完成。',
        occurredAt: '2026-08-16T03:05:00.000Z',
        metadata: { parentId: 'prod-01-structured-schedule-initial' },
      },
    });
    expect(followUp.statusCode).toBe(200);
    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().update_proposals[0].patch.plannedDueAt).toBe('2030-08-16T15:59:59.999Z');
  });
});
