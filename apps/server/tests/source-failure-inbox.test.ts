import { afterEach, describe, expect, it } from 'vitest';
import type { ClassificationResult, ClassifierAdapter } from '../src/integration-contracts.js';
import type { NormalizedSourceEvent } from '../src/domain.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { RuleMockClassifier } from '../src/integrations/llm.js';
import { PmRuntime } from '../src/runtime.js';
import { PmService } from '../src/service.js';

class FlakyClassifier implements ClassifierAdapter {
  readonly kind = 'rule_mock' as const;
  readonly provider = 'synthetic-failure';
  readonly model = 'synthetic-failure-model';
  readonly promptVersion = 'synthetic-failure-v1';
  fail = true;
  private readonly success = new RuleMockClassifier();

  async testConnection() {
    return { ok: true, status: 'mock' as const, message: '合成失败恢复测试。', checkedAt: new Date().toISOString() };
  }

  async classify(event: NormalizedSourceEvent): Promise<ClassificationResult> {
    if (this.fail) {
      return {
        outcome: 'recoverable_error',
        isDataRequest: true,
        draft: null,
        reason: '合成模型结构失败；不得把来源正文复制为摘要。',
        relatedTaskHint: null,
        importantDates: [],
        deliverables: [],
        commitments: [],
        usedFallback: true,
        errorCode: 'MODEL_OUTPUT_INVALID',
        metadata: {
          fallbackMode: 'rule_fallback',
          structuredMode: 'json_object',
          attempts: 1,
          retry: {
            category: 'rate_limit',
            providerKey: 'synthetic-failure',
            cooldownKey: 'synthetic-failure',
            retryable: true,
            retryAt: null,
            retryAfterMs: null,
            status: 429,
            code: 'rate_limit',
          },
        },
      };
    }
    return {
      ...(await this.success.classify(event)),
      outcome: 'rule_final',
      errorCode: undefined,
    };
  }
}

function event(externalId: string, content = '请整理活动留存数据并验证是否继续投入。'): NormalizedSourceEvent {
  return {
    externalId,
    sourceType: 'owner_dm',
    conversationId: 'synthetic-chat',
    senderId: 'synthetic-user',
    senderName: '合成需求方',
    content,
    occurredAt: '2026-08-16T09:00:00.000Z',
    completeness: 'complete',
    discoveryReason: '合成失败来源测试',
  };
}

function forgedFailureRecord() {
  return {
    id: 'failure_deadbeefdeadbeefdeadbeef',
    source_revision: 'a'.repeat(64),
    source_event_ids: ['src-forged'],
    job_id: 'job-forged',
    stage: 'classification',
    error_code: 'MODEL_OUTPUT_INVALID',
    error_message: '模型输出未通过结构校验，来源已保留，等待安全重试。',
    status: 'open',
    retryable: true,
    attempts: 1,
    max_attempts: 3,
    first_failed_at: '2026-08-16T09:00:00.000Z',
    last_failed_at: '2026-08-16T09:00:00.000Z',
    next_retry_at: null,
    resolved_at: null,
    ignored_at: null,
    updated_at: '2026-08-16T09:00:00.000Z',
  } as const;
}

const relationSnapshotTables = [
  'source_event',
  'job',
  'job_source_link',
  'candidate_request',
  'candidate_revision',
  'task',
  'task_update_proposal',
  'task_event',
  'requirement_thread',
  'correction_event',
] as const;

function databaseSnapshot(database: AppDatabase) {
  return Object.fromEntries(relationSnapshotTables.map((table) => [
    table,
    JSON.stringify(database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
  ]));
}

class FailAfterFirstClassifier extends RuleMockClassifier {
  private calls = 0;

  override async classify(event: NormalizedSourceEvent, guidance?: string) {
    this.calls += 1;
    if (this.calls > 1) throw new Error('合成重新整理失败。');
    return super.classify(event, guidance);
  }
}

function businessSnapshot(database: AppDatabase) {
  const { job: _job, job_source_link: _links, ...snapshot } = databaseSnapshot(database) as Record<string, string>;
  return snapshot;
}

async function assertInvalidFailureActions(fixtureApp: Awaited<ReturnType<typeof buildApp>>, fixtureDatabase: AppDatabase, failureId: string, canary: string) {
  for (const action of ['retry', 'archive', 'ignore'] as const) {
    const before = databaseSnapshot(fixtureDatabase);
    const response = await fixtureApp.inject({ method: 'POST', url: `/api/source-failures/${failureId}/${action}`, payload: {} });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: '失败来源不存在。' });
    expect(JSON.stringify(response.json())).not.toContain(canary);
    expect(databaseSnapshot(fixtureDatabase)).toEqual(before);
  }
}

describe('Issue #46 failed source inbox', () => {
  let database: AppDatabase | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    database?.close();
  });

  async function setupFailureFixture(externalId: string) {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const fixtureDatabase = new AppDatabase(':memory:', false);
    const classifier = new FlakyClassifier();
    const service = new PmService(fixtureDatabase, { ...createAdapters(config), classifier }, config);
    const fixtureApp = await buildApp(service, { serveWeb: false });
    database = fixtureDatabase;
    app = fixtureApp;
    await service.ingestSource(event(externalId));
    const source = fixtureDatabase.raw.prepare('SELECT * FROM source_event WHERE external_id = ?').get(externalId) as { id: string; metadata_json: string };
    const job = fixtureDatabase.raw.prepare('SELECT * FROM job WHERE source_event_id = ? ORDER BY created_at DESC LIMIT 1').get(source.id) as { id: string; payload_json: string };
    const failure = (await fixtureApp.inject({ method: 'GET', url: '/api/source-failures?status=all' })).json().items.find((item: { source_event_id: string }) => item.source_event_id === source.id) as { id: string } | undefined;
    expect(failure).toBeDefined();
    return { config, fixtureDatabase, fixtureApp, service, source, job, failure: failure! };
  }

  it('keeps a redacted failure visible, retries idempotently, and resolves after recovery', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    database = new AppDatabase(':memory:', false);
    const classifier = new FlakyClassifier();
    const adapters = { ...createAdapters(config), classifier };
    const service = new PmService(database, adapters, config);
    app = await buildApp(service, { serveWeb: false });

    const initial = await service.ingestSource(event('issue46-failure-1'));
    expect(initial.candidate).toBeNull();
    expect(initial.classificationDeferred).toBe(true);
    const firstJob = database.raw.prepare(
      "SELECT status, retryable, available_at, updated_at, lease_owner FROM job WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'issue46-failure-1') ORDER BY created_at DESC LIMIT 1",
    ).get() as { status: string; retryable: number; available_at: string; updated_at: string; lease_owner: string | null };
    expect(firstJob).toMatchObject({ status: 'queued', retryable: 1, lease_owner: null });
    expect(Date.parse(firstJob.available_at)).toBeGreaterThan(Date.parse(firstJob.updated_at));

    const visible = await app.inject({ method: 'GET', url: '/api/source-failures?status=active' });
    expect(visible.statusCode).toBe(200);
    const failure = visible.json().items[0];
    expect(failure).toMatchObject({
      source_type: 'owner_dm',
      stage: 'classification',
      error_code: 'MODEL_OUTPUT_INVALID',
      status: 'retrying',
      retryable: true,
    });
    expect(JSON.stringify(failure)).not.toContain('请整理活动留存数据');

    const duplicateRetries = await Promise.all([
      app.inject({ method: 'POST', url: `/api/source-failures/${failure.id}/retry`, payload: {} }),
      app.inject({ method: 'POST', url: `/api/source-failures/${failure.id}/retry`, payload: {} }),
    ]);
    expect(duplicateRetries.every((response) => response.statusCode === 200)).toBe(true);
    expect(new Set(duplicateRetries.map((response) => response.json().status))).toEqual(new Set(['queued']));

    classifier.fail = false;
    // Current schema v3 keeps this retry bounded per job. The shared provider
    // cooldown remains parked until #38 supplies the next migration version.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await service.resumeRuntimeJobs();
    const resolved = await app.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(resolved.json().items[0]).toMatchObject({ id: failure.id, status: 'resolved', retryable: false });
    expect((await app.inject({ method: 'GET', url: '/api/candidates?deleted=all' })).json().items).toHaveLength(1);

    const audit = database.raw.prepare("SELECT correction_type, operation FROM correction_event WHERE source_event_id = (SELECT id FROM source_event WHERE external_id = 'issue46-failure-1') ORDER BY created_at ASC").all();
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ correction_type: 'source_failure', operation: 'retry_waiting' }),
      expect.objectContaining({ correction_type: 'source_failure', operation: 'resolved' }),
    ]));
  });

  it('archives a failed source with a compare-and-swap guard', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    database = new AppDatabase(':memory:', false);
    const classifier = new FlakyClassifier();
    const service = new PmService(database, { ...createAdapters(config), classifier }, config);
    app = await buildApp(service, { serveWeb: false });
    await service.ingestSource(event('issue46-failure-2'));

    const failure = (await app.inject({ method: 'GET', url: '/api/source-failures?status=active' })).json().items[0];
    const archived = await app.inject({ method: 'POST', url: `/api/source-failures/${failure.id}/archive`, payload: {} });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ status: 'ignored' });
    expect((await app.inject({ method: 'GET', url: '/api/source-failures?status=active' })).json().items).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: `/api/source-failures/${failure.id}/retry`, payload: {} })).statusCode).toBe(409);
  });

  it('strips externally supplied failure_inbox metadata on new and enriched sources', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    database = new AppDatabase(':memory:', false);
    const classifier = new FlakyClassifier();
    const service = new PmService(database, { ...createAdapters(config), classifier }, config);
    app = await buildApp(service, { serveWeb: false });
    const forged = forgedFailureRecord();

    await service.ingestSource({ ...event('issue46-metadata-new'), metadata: { failure_inbox: [forged] } });
    const firstRow = database.raw.prepare("SELECT * FROM source_event WHERE external_id = 'issue46-metadata-new'").get() as { id: string; metadata_json: string };
    const firstMetadata = JSON.parse(firstRow.metadata_json) as Record<string, unknown>;
    expect(Array.isArray(firstMetadata.failure_inbox) && firstMetadata.failure_inbox.some((item) => (item as { id?: string })?.id === forged.id)).toBe(false);

    const firstFailure = (await app.inject({ method: 'GET', url: '/api/source-failures?status=all' })).json().items.find((item: { source_event_id: string }) => item.source_event_id === firstRow.id);
    expect(firstFailure).toBeDefined();

    await service.ingestSource({
      ...event('issue46-metadata-new', '补充后的授权来源内容。'),
      metadata: { sourceVersion: 2, failure_inbox: [forged] },
    });
    const enriched = await app.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(enriched.statusCode).toBe(200);
    expect(enriched.json().items.some((item: { id: string }) => item.id === forged.id)).toBe(false);
    expect(enriched.json().items.some((item: { id: string }) => item.id === firstFailure.id)).toBe(true);
  });

  it('ignores malformed persisted failure_inbox items without 500 or forged DTOs', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    database = new AppDatabase(':memory:', false);
    const service = new PmService(database, createAdapters(config), config);
    app = await buildApp(service, { serveWeb: false });
    await service.ingestSource(event('issue46-malformed-metadata'));
    const row = database.raw.prepare("SELECT id, metadata_json FROM source_event WHERE external_id = 'issue46-malformed-metadata'").get() as { id: string; metadata_json: string };
    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    metadata.failure_inbox = [
      { id: 'failure_bad', source_revision: 'not-a-revision', error_message: '数据库正文泄漏' },
      { ...forgedFailureRecord(), source_event_ids: 'not-an-array' },
    ];
    database.raw.prepare('UPDATE source_event SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), row.id);

    const listed = await app.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([]);
    expect(JSON.stringify(listed.json())).not.toContain('数据库正文泄漏');
  });

  it('rejects a source A failure record that points to source B before retry writes', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    database = new AppDatabase(':memory:', false);
    const classifier = new FlakyClassifier();
    const service = new PmService(database, { ...createAdapters(config), classifier }, config);
    app = await buildApp(service, { serveWeb: false });
    await service.ingestSource(event('issue46-relation-a'));
    await service.ingestSource(event('issue46-relation-b'));

    const sourceA = database.raw.prepare("SELECT * FROM source_event WHERE external_id = 'issue46-relation-a'").get() as { id: string; metadata_json: string };
    const sourceB = database.raw.prepare("SELECT * FROM source_event WHERE external_id = 'issue46-relation-b'").get() as { id: string; metadata_json: string };
    const jobB = database.raw.prepare('SELECT * FROM job WHERE source_event_id = ? ORDER BY created_at DESC LIMIT 1').get(sourceB.id) as { id: string };
    const listed = (await app.inject({ method: 'GET', url: '/api/source-failures?status=all' })).json().items as Array<{ id: string; source_event_id: string }>;
    const failureA = listed.find((item) => item.source_event_id === sourceA.id)!;
    expect(failureA).toBeDefined();

    const metadata = JSON.parse(sourceA.metadata_json) as { failure_inbox: Array<Record<string, unknown>> };
    metadata.failure_inbox = metadata.failure_inbox.map((record) => ({ ...record, job_id: jobB.id }));
    database.raw.prepare('UPDATE source_event SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), sourceA.id);
    const before = databaseSnapshot(database);

    const listedAfterCorruption = await app.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(listedAfterCorruption.statusCode).toBe(200);
    expect(listedAfterCorruption.json().items.some((item: { id: string }) => item.id === failureA.id)).toBe(false);

    const response = await app.inject({ method: 'POST', url: `/api/source-failures/${failureA.id}/retry`, payload: {} });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: '失败来源不存在。' });
    expect(JSON.stringify(response.json())).not.toContain(jobB.id);
    expect(databaseSnapshot(database)).toEqual(before);
  });

  it('fails closed when a record names a missing linked source', async () => {
    const fixture = await setupFailureFixture('issue46-relation-missing-source');
    const metadata = JSON.parse(fixture.source.metadata_json) as { failure_inbox: Array<Record<string, unknown>> };
    metadata.failure_inbox = metadata.failure_inbox.map((record) => ({ ...record, source_event_ids: [fixture.source.id, 'source_missing_relation'] }));
    fixture.fixtureDatabase.raw.prepare('UPDATE source_event SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), fixture.source.id);
    const payload = JSON.parse(fixture.job.payload_json) as Record<string, unknown>;
    payload.sourceEventIds = [fixture.source.id, 'source_missing_relation'];
    fixture.fixtureDatabase.raw.prepare('UPDATE job SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), fixture.job.id);

    const listed = await fixture.fixtureApp.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([]);
    await assertInvalidFailureActions(fixture.fixtureApp, fixture.fixtureDatabase, fixture.failure.id, 'source_missing_relation');
  });

  it('fails closed when the persisted failure id is not derived from its owning source', async () => {
    const fixture = await setupFailureFixture('issue46-relation-wrong-id');
    const metadata = JSON.parse(fixture.source.metadata_json) as { failure_inbox: Array<Record<string, unknown>> };
    metadata.failure_inbox = metadata.failure_inbox.map((record) => ({ ...record, id: `failure_${'c'.repeat(24)}` }));
    fixture.fixtureDatabase.raw.prepare('UPDATE source_event SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), fixture.source.id);

    const listed = await fixture.fixtureApp.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([]);
    await assertInvalidFailureActions(fixture.fixtureApp, fixture.fixtureDatabase, fixture.failure.id, 'source-relation-id-canary');
  });

  it('fails closed when Runtime payload revision differs from the record revision', async () => {
    const fixture = await setupFailureFixture('issue46-relation-revision');
    const payload = JSON.parse(fixture.job.payload_json) as Record<string, unknown>;
    payload.sourceRevision = 'b'.repeat(64);
    fixture.fixtureDatabase.raw.prepare('UPDATE job SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), fixture.job.id);

    const listed = await fixture.fixtureApp.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([]);
    await assertInvalidFailureActions(fixture.fixtureApp, fixture.fixtureDatabase, fixture.failure.id, 'source-relation-revision-canary');
  });

  it('fails closed when Runtime payload source ids differ from the record source set', async () => {
    const fixture = await setupFailureFixture('issue46-relation-source-set');
    await fixture.service.ingestSource(event('issue46-relation-source-set-other'));
    const otherSource = fixture.fixtureDatabase.raw.prepare("SELECT id FROM source_event WHERE external_id = 'issue46-relation-source-set-other'").get() as { id: string };
    const payload = JSON.parse(fixture.job.payload_json) as Record<string, unknown>;
    payload.sourceEventIds = [otherSource.id];
    fixture.fixtureDatabase.raw.prepare('UPDATE job SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), fixture.job.id);

    const listed = await fixture.fixtureApp.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.some((item: { id: string }) => item.id === fixture.failure.id)).toBe(false);
    await assertInvalidFailureActions(fixture.fixtureApp, fixture.fixtureDatabase, fixture.failure.id, otherSource.id);
  });

  it('fails closed when job_source_link does not represent the Runtime source set', async () => {
    const fixture = await setupFailureFixture('issue46-relation-link');
    fixture.fixtureDatabase.raw.prepare('DELETE FROM job_source_link WHERE job_id = ? AND source_event_id = ?').run(fixture.job.id, fixture.source.id);

    const listed = await fixture.fixtureApp.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([]);
    await assertInvalidFailureActions(fixture.fixtureApp, fixture.fixtureDatabase, fixture.failure.id, 'source-relation-link-canary');
  });

  it('fails closed when a classify_source Runtime job has no owning source', async () => {
    const fixture = await setupFailureFixture('issue46-relation-null-owner');
    fixture.fixtureDatabase.raw.prepare('UPDATE job SET source_event_id = NULL WHERE id = ?').run(fixture.job.id);

    const before = databaseSnapshot(fixture.fixtureDatabase);
    const listed = await fixture.fixtureApp.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([]);
    expect(databaseSnapshot(fixture.fixtureDatabase)).toEqual(before);
    await assertInvalidFailureActions(fixture.fixtureApp, fixture.fixtureDatabase, fixture.failure.id, 'source-relation-null-owner-canary');
    expect(databaseSnapshot(fixture.fixtureDatabase)).toEqual(before);
  });

  it('fails closed when a classify_source_batch Runtime job has no owning source', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    database = new AppDatabase(':memory:', false);
    const classifier = new FlakyClassifier();
    const service = new PmService(database, { ...createAdapters(config), classifier }, config);
    app = await buildApp(service, { serveWeb: false });
    await service.ingestSourceBatch([
      event('issue46-relation-null-batch-a', '请整理批次来源 A 的活动留存数据。'),
      event('issue46-relation-null-batch-b', '请整理批次来源 B 的活动付费数据。'),
    ]);

    const batchJob = database.raw.prepare(
      "SELECT id FROM job WHERE job_type = 'classify_source_batch' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string };
    const failures = (await app.inject({ method: 'GET', url: '/api/source-failures?status=all' })).json().items as Array<{ id: string }>;
    expect(batchJob).toBeDefined();
    expect(failures).toHaveLength(2);
    database.raw.prepare('UPDATE job SET source_event_id = NULL WHERE id = ?').run(batchJob.id);

    const before = databaseSnapshot(database);
    const listed = await app.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([]);
    expect(databaseSnapshot(database)).toEqual(before);
    for (const failure of failures) {
      await assertInvalidFailureActions(app, database, failure.id, 'source-relation-null-batch-owner-canary');
    }
    expect(databaseSnapshot(database)).toEqual(before);
  });

  it('keeps a relation-valid older revision visible as stale without retrying it', async () => {
    const fixture = await setupFailureFixture('issue46-relation-stale');
    fixture.fixtureDatabase.raw.prepare('UPDATE source_event SET content = ? WHERE id = ?').run('更新后的合成来源内容。', fixture.source.id);

    const listed = await fixture.fixtureApp.inject({ method: 'GET', url: '/api/source-failures?status=all' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([expect.objectContaining({ id: fixture.failure.id, status: 'stale', stale: true })]);
    const before = databaseSnapshot(fixture.fixtureDatabase);
    const response = await fixture.fixtureApp.inject({ method: 'POST', url: `/api/source-failures/${fixture.failure.id}/retry`, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: '来源内容或背景已经变化，这条失败记录已陈旧，请等待新的分类结果。' });
    expect(databaseSnapshot(fixture.fixtureDatabase)).toEqual(before);
  });

  it('does not write failure or candidate state for non-classification Runtime failures', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    database = new AppDatabase(':memory:', false);
    const classifier = new FailAfterFirstClassifier();
    const service = new PmService(database, { ...createAdapters(config), classifier }, config);
    app = await buildApp(service, { serveWeb: false });
    const result = await service.ingestSource(event('issue46-non-classification-runtime'));
    const source = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('issue46-non-classification-runtime') as { id: string };
    const sourceRevision = 'a'.repeat(64);
    const runtime = new PmRuntime(database);
    const owner = runtime.begin({
      jobType: 'owner_decision',
      payload: { sourceEventId: source.id, sourceEventIds: [source.id], sourceRevision, decisionId: 'missing-owner-decision' },
      idempotencyKey: 'issue46-owner-decision-failure',
      sourceEventId: source.id,
    });
    const reprocess = runtime.begin({
      jobType: 'reprocess_candidate',
      payload: { candidateId: result.candidate!.id, sourceEventId: source.id, sourceEventIds: [source.id], sourceRevision },
      idempotencyKey: 'issue46-reprocess-failure',
      sourceEventId: source.id,
    });
    for (const job of [owner, reprocess]) {
      database.raw.prepare(
        "UPDATE job SET status = 'queued', available_at = ?, locked_until = NULL, lease_owner = NULL WHERE id = ?",
      ).run(new Date(Date.now() - 1_000).toISOString(), job.id);
    }
    const before = businessSnapshot(database);
    await expect(service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 2, recovered: 0 });
    expect(businessSnapshot(database)).toEqual(before);
    expect((await app.inject({ method: 'GET', url: '/api/source-failures?status=all' })).json().items).toEqual([]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM correction_event').get()).toEqual({ count: 0 });
  });

  it.each([
    ['source set', (payload: Record<string, unknown>, sourceId: string) => { payload.sourceEventIds = [sourceId, 'source_missing_issue46']; }],
    ['duplicate source ids', (payload: Record<string, unknown>, sourceId: string) => { payload.sourceEventIds = [sourceId, sourceId]; }],
    ['revision', (payload: Record<string, unknown>) => { payload.sourceRevision = 'b'.repeat(64); }],
    ['link', (_payload: Record<string, unknown>, sourceId: string, fixture: Awaited<ReturnType<typeof setupFailureFixture>>) => {
      fixture.fixtureDatabase.raw.prepare('DELETE FROM job_source_link WHERE job_id = ? AND source_event_id = ?').run(fixture.job.id, sourceId);
    }],
  ] as const)('keeps classify_source failure relation errors zero-write (%s)', async (_name, mutate) => {
    const fixture = await setupFailureFixture(`issue46-zero-write-${_name}`);
    const metadata = JSON.parse(fixture.source.metadata_json) as Record<string, unknown>;
    delete metadata.failure_inbox;
    fixture.fixtureDatabase.raw.prepare('UPDATE source_event SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), fixture.source.id);
    const payload = JSON.parse(fixture.job.payload_json) as Record<string, unknown>;
    mutate(payload, fixture.source.id, fixture);
    fixture.fixtureDatabase.raw.prepare('UPDATE job SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), fixture.job.id);
    fixture.fixtureDatabase.raw.prepare(
      "UPDATE job SET status = 'queued', available_at = ?, locked_until = NULL, lease_owner = NULL WHERE id = ?",
    ).run(new Date(Date.now() - 1_000).toISOString(), fixture.job.id);
    const before = businessSnapshot(fixture.fixtureDatabase);
    await expect(fixture.service.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 1, recovered: 0 });
    expect(businessSnapshot(fixture.fixtureDatabase)).toEqual(before);
    expect((await fixture.fixtureApp.inject({ method: 'GET', url: '/api/source-failures?status=all' })).json().items).toEqual([]);
  });

  it('records a valid classify_source_batch failure once per source with redacted audit', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    database = new AppDatabase(':memory:', false);
    const classifier = new FlakyClassifier();
    const service = new PmService(database, { ...createAdapters(config), classifier }, config);
    app = await buildApp(service, { serveWeb: false });
    const result = await service.ingestSourceBatch([
      event('issue46-valid-batch-a', '请整理批次来源 A 的活动留存数据。'),
      event('issue46-valid-batch-b', '请整理批次来源 B 的活动付费数据。'),
    ]);
    expect(result.classificationFailures).toBe(1);
    const sourceRows = database.raw.prepare(
      "SELECT id, metadata_json FROM source_event WHERE external_id IN ('issue46-valid-batch-a','issue46-valid-batch-b') ORDER BY external_id",
    ).all() as Array<{ id: string; metadata_json: string }>;
    const sourceIds = sourceRows.map((row) => row.id);
    const failures = (await app.inject({ method: 'GET', url: '/api/source-failures?status=all' })).json().items as Array<{ source_event_id: string; source_event_ids: string[]; error_message: string }>;
    expect(failures).toHaveLength(2);
    expect(failures.every((failure) => JSON.stringify(failure).includes('MODEL_OUTPUT_INVALID'))).toBe(true);
    expect(failures.every((failure) => JSON.stringify(failure).includes('模型输出未通过结构校验'))).toBe(true);
    expect(failures.every((failure) => JSON.stringify(failure).includes('批次来源') === false)).toBe(true);
    const persistedSourceIds = sourceRows.map((row) => {
      const failureInbox = (JSON.parse(row.metadata_json) as { failure_inbox?: Array<{ source_event_ids: string[] }> }).failure_inbox ?? [];
      return failureInbox[0]?.source_event_ids ?? [];
    });
    expect(persistedSourceIds.every((ids) => JSON.stringify(ids) === JSON.stringify(sourceIds))).toBe(true);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'source_failure'").get()).toEqual({ count: 2 });
    expect(sourceRows.every((row) => (JSON.parse(row.metadata_json) as { failure_inbox?: unknown[] }).failure_inbox?.length === 1)).toBe(true);
  });
});
