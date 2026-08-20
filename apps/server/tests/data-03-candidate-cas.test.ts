import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';
import { registerSimulatedMessageRoute } from './support/simulated-message-route.js';

describe('Issue #37 DATA-03 candidate CAS contract', () => {
  let database: AppDatabase;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let service: PmService;

  beforeEach(async () => {
    database = new AppDatabase(':memory:', false);
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    service = new PmService(database, createAdapters(config), config);
    app = await buildApp(service, { serveWeb: false });
    registerSimulatedMessageRoute(app, service, {
      testOnly: true,
      nodeEnv: config.nodeEnv,
      databaseProvider: config.database.provider,
      databaseUrl: config.database.url,
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  const simulate = async (externalId: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/dev/simulate-message',
      payload: {
        externalId,
        sourceType: 'owner_dm',
        conversationId: 'data03-chat',
        senderId: 'data03-owner',
        senderName: '合成需求方',
        content: '请分析活动留存并确认是否继续投入。',
        occurredAt: '2026-08-16T00:00:00.000Z',
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json().candidate as { id: string; version: number };
  };

  const makeMergedGroup = (root: { id: string }, member: { id: string }) => {
    const rootCandidate = database.raw.prepare('SELECT demand_unit_id FROM candidate_request WHERE id = ?').get(root.id) as { demand_unit_id: string | null };
    const memberCandidate = database.raw.prepare('SELECT demand_unit_id, source_event_id FROM candidate_request WHERE id = ?').get(member.id) as { demand_unit_id: string | null; source_event_id: string };
    const rootThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?').get(rootCandidate.demand_unit_id) as { thread_id: string };
    const memberThread = database.raw.prepare('SELECT thread_id FROM requirement_thread_unit WHERE demand_unit_id = ?').get(memberCandidate.demand_unit_id) as { thread_id: string };
    database.raw.prepare('UPDATE requirement_thread_unit SET thread_id = ? WHERE thread_id = ? AND demand_unit_id = ?')
      .run(rootThread.thread_id, memberThread.thread_id, memberCandidate.demand_unit_id);
    database.raw.prepare('UPDATE requirement_thread_source SET thread_id = ? WHERE thread_id = ? AND source_event_id = ?')
      .run(rootThread.thread_id, memberThread.thread_id, memberCandidate.source_event_id);
    database.raw.prepare('UPDATE candidate_request SET merged_into_candidate_id = ?, merged_at = updated_at WHERE id = ?')
      .run(root.id, member.id);
    database.raw.prepare("UPDATE requirement_thread SET status = 'closed' WHERE id = ?").run(memberThread.thread_id);
    return rootThread.thread_id;
  };

  it('requires expectedVersion, increments the canonical version, and returns a safe 409 DTO', async () => {
    const candidate = await simulate('data03-cas-one');
    const missing = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/action`,
      payload: { action: 'snooze' },
    });
    expect(missing.statusCode).toBe(400);

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/action`,
      payload: { action: 'snooze', expectedVersion: candidate.version },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().candidate.version).toBe(candidate.version + 1);

    const before = database.raw.prepare('SELECT state, snoozed_until, version, accepted_task_id FROM candidate_request WHERE id = ?').get(candidate.id);
    const stale = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/action`,
      payload: { action: 'ignore', expectedVersion: candidate.version },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error_code: 'CONFLICT', current: { id: candidate.id, version: candidate.version + 1 } });
    expect(database.raw.prepare('SELECT state, snoozed_until, version, accepted_task_id FROM candidate_request WHERE id = ?').get(candidate.id)).toEqual(before);
  });

  it('rejects a direct service mutation that omits expectedVersion before any write', async () => {
    const candidate = await simulate('data03-service-required-version');
    const before = database.raw.prepare('SELECT state, version, updated_at FROM candidate_request WHERE id = ?').get(candidate.id);
    const missingVersionMutation = service.actOnCandidate as unknown as (candidateId: string, action: 'snooze') => unknown;
    expect(() => missingVersionMutation.call(service, candidate.id, 'snooze')).toThrow('候选已被其他操作更新');
    expect(database.raw.prepare('SELECT state, version, updated_at FROM candidate_request WHERE id = ?').get(candidate.id)).toEqual(before);
  });

  it('rejects direct delete/restore calls without expectedVersion before any write', async () => {
    const candidate = await simulate('data03-service-delete-restore-version');
    const before = database.raw.prepare('SELECT deleted_at, version, updated_at FROM candidate_request WHERE id = ?').get(candidate.id);
    const deleteWithoutVersion = service.deleteCandidate as unknown as (candidateId: string) => unknown;
    expect(() => deleteWithoutVersion.call(service, candidate.id)).toThrow('候选已被其他操作更新');
    expect(database.raw.prepare('SELECT deleted_at, version, updated_at FROM candidate_request WHERE id = ?').get(candidate.id)).toEqual(before);
    const restoreWithoutVersion = service.restoreCandidate as unknown as (candidateId: string) => unknown;
    expect(() => restoreWithoutVersion.call(service, candidate.id)).toThrow('候选已被其他操作更新');
    expect(database.raw.prepare('SELECT deleted_at, version, updated_at FROM candidate_request WHERE id = ?').get(candidate.id)).toEqual(before);
  });

  it('rejects source retry without the bound candidate version before touching Runtime or failure state', async () => {
    const candidate = await simulate('data03-service-source-retry-version');
    const source = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data03-service-source-retry-version') as { id: string };
    const before = {
      candidate: database.raw.prepare('SELECT processing_state, processing_job_id, version FROM candidate_request WHERE id = ?').get(candidate.id),
      jobs: database.raw.prepare('SELECT id, status, attempts, updated_at FROM job ORDER BY id').all(),
      sources: database.raw.prepare('SELECT id, metadata_json FROM source_event ORDER BY id').all(),
    };
    expect(() => service.retrySourceClassification(source.id)).toThrow('候选变更需要提供当前候选版本');
    expect({
      candidate: database.raw.prepare('SELECT processing_state, processing_job_id, version FROM candidate_request WHERE id = ?').get(candidate.id),
      jobs: database.raw.prepare('SELECT id, status, attempts, updated_at FROM job ORDER BY id').all(),
      sources: database.raw.prepare('SELECT id, metadata_json FROM source_event ORDER BY id').all(),
    }).toEqual(before);
    expect(() => service.retrySourceClassification(source.id, undefined, undefined, { candidateId: candidate.id, expectedVersion: candidate.version - 1 })).toThrow('候选已被其他操作更新');
    expect(database.raw.prepare('SELECT processing_state, processing_job_id, version FROM candidate_request WHERE id = ?').get(candidate.id)).toEqual(before.candidate);
  });

  it('returns the safe conflict DTO for a stale source-classification retry', async () => {
    const candidate = await simulate('data03-http-source-retry-conflict');
    const source = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data03-http-source-retry-conflict') as { id: string };
    database.raw.prepare('UPDATE candidate_request SET version = version + 1 WHERE id = ?').run(candidate.id);
    const response = await app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/classification/retry`,
      payload: { expectedVersion: candidate.version },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error_code: 'CONFLICT',
      outcome: 'failure',
      current: { id: candidate.id, version: candidate.version + 1 },
      current_version: candidate.version + 1,
    });
  });

  it('fences delete and restore with the same candidate revision', async () => {
    const candidate = await simulate('data03-cas-delete');
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/candidates/${candidate.id}`,
      payload: { expectedVersion: candidate.version },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ id: candidate.id, version: candidate.version + 1, deleted_at: expect.any(String) });

    const staleRestore = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/restore`,
      payload: { expectedVersion: candidate.version },
    });
    expect(staleRestore.statusCode).toBe(409);
    expect(staleRestore.json()).toMatchObject({ error_code: 'CONFLICT', current: { version: candidate.version + 1 } });

    const restored = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/restore`,
      payload: { expectedVersion: candidate.version + 1 },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: candidate.id, version: candidate.version + 2, deleted_at: null });
  });

  it('fences every member of a merged candidate group and rolls back the group on a stale member', async () => {
    const first = await simulate('data03-cas-group-a');
    const second = await simulate('data03-cas-group-b');
    database.raw.prepare(
      "UPDATE candidate_request SET merged_into_candidate_id = ?, merged_at = updated_at WHERE id = ?",
    ).run(first.id, second.id);
    const groupedView = (await app.inject({ method: 'GET', url: '/api/candidates?deleted=all' })).json().items.find((item: { id: string }) => item.id === first.id) as { merge_group?: { groupVersionHash: string } };
    expect(groupedView.merge_group?.groupVersionHash).toEqual(expect.any(String));
    database.raw.prepare('UPDATE candidate_request SET version = 99 WHERE id = ?').run(second.id);
    const groupedRows = database.raw.prepare('SELECT id, merged_into_candidate_id, version FROM candidate_request WHERE id IN (?, ?)').all(first.id, second.id) as Array<{ id: string; merged_into_candidate_id: string | null; version: number }>;
    expect(groupedRows.find((row) => row.id === first.id)).toMatchObject({ merged_into_candidate_id: null });
    expect(groupedRows.find((row) => row.id === second.id)).toMatchObject({ merged_into_candidate_id: first.id, version: 99 });
    const before = database.raw.prepare('SELECT id, state, version, snoozed_until FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(first.id, second.id);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/candidates/${first.id}/action`,
      payload: { action: 'snooze', expectedVersion: first.version, expectedGroupVersionHash: groupedView.merge_group!.groupVersionHash },
    });
    expect(stale.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT id, state, version, snoozed_until FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(first.id, second.id)).toEqual(before);
  });

  it('deletes and restores every unaccepted merged-group member from a non-root entry and archives matching notifications', async () => {
    const root = await simulate('data03-delete-group-root');
    const second = await simulate('data03-delete-group-second');
    const third = await simulate('data03-delete-group-third');
    makeMergedGroup(root, second);
    makeMergedGroup(root, third);
    const insertNotification = database.raw.prepare(
      `INSERT INTO notification
        (id, candidate_id, notification_type, dedupe_key, reason, created_at)
       VALUES (?, ?, 'immediate', ?, '合成候选提醒', ?)`,
    );
    for (const candidate of [root, second, third]) {
      insertNotification.run(`data03-notice-${candidate.id}`, candidate.id, `data03-notice-key-${candidate.id}`, '2026-08-16T00:00:00.000Z');
    }
    const groupedView = (await app.inject({ method: 'GET', url: '/api/candidates?deleted=all' })).json().items.find((item: { id: string }) => item.id === root.id) as { merge_group: { groupVersionHash: string } };
    const before = database.raw.prepare('SELECT id, deleted_at, version, merged_into_candidate_id FROM candidate_request WHERE id IN (?, ?, ?) ORDER BY id').all(root.id, second.id, third.id) as Array<{ id: string; deleted_at: string | null; version: number; merged_into_candidate_id: string | null }>;
    const memberBeforeDelete = before.find((row) => row.id === second.id)!;
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/candidates/${second.id}`,
      payload: { expectedVersion: memberBeforeDelete.version, expectedGroupVersionHash: groupedView.merge_group.groupVersionHash },
    });
    expect(deleted.statusCode).toBe(200);
    const afterDelete = database.raw.prepare('SELECT id, deleted_at, version, merged_into_candidate_id FROM candidate_request WHERE id IN (?, ?, ?) ORDER BY id').all(root.id, second.id, third.id) as typeof before;
    expect(afterDelete.every((row) => row.deleted_at !== null)).toBe(true);
    expect(afterDelete.map((row) => row.version)).toEqual(before.map((row) => row.version + 1));
    expect(afterDelete.map((row) => row.merged_into_candidate_id)).toEqual(before.map((row) => row.merged_into_candidate_id));
    expect(database.raw.prepare('SELECT candidate_id, archived_at FROM notification WHERE dedupe_key IN (?, ?, ?) ORDER BY candidate_id').all(`data03-notice-key-${root.id}`, `data03-notice-key-${second.id}`, `data03-notice-key-${third.id}`)).toEqual(
      [root.id, second.id, third.id].sort().map((candidateId) => ({ candidate_id: candidateId, archived_at: expect.any(String) })),
    );

    const deletedView = (await app.inject({ method: 'GET', url: '/api/candidates?deleted=all' })).json().items.find((item: { id: string }) => item.id === root.id) as { version: number; merge_group: { groupVersionHash: string } };
    const deletedMember = afterDelete.find((row) => row.id === second.id)!;
    const restored = await app.inject({
      method: 'POST',
      url: `/api/candidates/${second.id}/restore`,
      payload: { expectedVersion: deletedMember.version, expectedGroupVersionHash: deletedView.merge_group.groupVersionHash },
    });
    expect(restored.statusCode).toBe(200);
    const afterRestore = database.raw.prepare('SELECT id, deleted_at, version, merged_into_candidate_id FROM candidate_request WHERE id IN (?, ?, ?) ORDER BY id').all(root.id, second.id, third.id) as typeof before;
    expect(afterRestore.every((row) => row.deleted_at === null)).toBe(true);
    expect(afterRestore.map((row) => row.version)).toEqual(before.map((row) => row.version + 2));
    expect(afterRestore.map((row) => row.merged_into_candidate_id)).toEqual(before.map((row) => row.merged_into_candidate_id));
  });

  it('binds non-root delete and restore CAS to the requested member version and leaves all state unchanged on wrong versions', async () => {
    const root = await simulate('data03-requested-member-root');
    const member = await simulate('data03-requested-member-member');
    makeMergedGroup(root, member);
    database.raw.prepare('UPDATE candidate_request SET version = version + 3 WHERE id = ?').run(member.id);
    const insertNotification = database.raw.prepare(
      `INSERT INTO notification
        (id, candidate_id, notification_type, dedupe_key, reason, created_at)
       VALUES (?, ?, 'immediate', ?, '合成候选提醒', ?)`,
    );
    insertNotification.run('data03-requested-member-root-notice', root.id, 'data03-requested-member-root-key', '2026-08-16T00:00:00.000Z');
    insertNotification.run('data03-requested-member-member-notice', member.id, 'data03-requested-member-member-key', '2026-08-16T00:00:00.000Z');

    const groupedView = (await app.inject({ method: 'GET', url: '/api/candidates?deleted=all' })).json().items.find((item: { id: string }) => item.id === root.id) as { merge_group: { groupVersionHash: string } };
    const rows = database.raw.prepare('SELECT id, deleted_at, version FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(root.id, member.id) as Array<{ id: string; deleted_at: string | null; version: number }>;
    const rootRow = rows.find((row) => row.id === root.id)!;
    const memberRow = rows.find((row) => row.id === member.id)!;
    expect(memberRow.version).not.toBe(rootRow.version);
    const stateSnapshot = () => ({
      candidates: database.raw.prepare('SELECT id, deleted_at, version, merged_into_candidate_id, accepted_task_id, updated_at FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(root.id, member.id),
      notifications: database.raw.prepare('SELECT candidate_id, archived_at FROM notification WHERE candidate_id IN (?, ?) ORDER BY candidate_id').all(root.id, member.id),
      threads: database.raw.prepare('SELECT id, status, version, updated_at FROM requirement_thread ORDER BY id').all(),
      revisions: database.raw.prepare('SELECT thread_id, state, decided_at FROM requirement_thread_revision ORDER BY thread_id, id').all(),
      relations: database.raw.prepare('SELECT thread_id, source_event_id, demand_unit_id FROM requirement_thread_source ORDER BY thread_id, source_event_id').all(),
      audit: database.raw.prepare('SELECT id, task_id, event_type, source_event_id, version FROM task_event ORDER BY id').all(),
      corrections: database.raw.prepare('SELECT id, correction_type, candidate_id, created_at FROM correction_event ORDER BY id').all(),
    });
    const beforeDelete = stateSnapshot();

    const wrongRootDelete = await app.inject({
      method: 'DELETE',
      url: `/api/candidates/${member.id}`,
      payload: { expectedVersion: rootRow.version, expectedGroupVersionHash: groupedView.merge_group.groupVersionHash },
    });
    expect(wrongRootDelete.statusCode).toBe(409);
    expect(stateSnapshot()).toEqual(beforeDelete);

    const wrongMemberDelete = await app.inject({
      method: 'DELETE',
      url: `/api/candidates/${member.id}`,
      payload: { expectedVersion: memberRow.version + 1, expectedGroupVersionHash: groupedView.merge_group.groupVersionHash },
    });
    expect(wrongMemberDelete.statusCode).toBe(409);
    expect(stateSnapshot()).toEqual(beforeDelete);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/candidates/${member.id}`,
      payload: { expectedVersion: memberRow.version, expectedGroupVersionHash: groupedView.merge_group.groupVersionHash },
    });
    expect(deleted.statusCode).toBe(200);
    const deletedRows = database.raw.prepare('SELECT id, deleted_at, version FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(root.id, member.id) as Array<{ id: string; deleted_at: string | null; version: number }>;
    const deletedRoot = deletedRows.find((row) => row.id === root.id)!;
    const deletedMember = deletedRows.find((row) => row.id === member.id)!;
    expect(deletedRoot.deleted_at).toEqual(expect.any(String));
    expect(deletedMember.deleted_at).toEqual(expect.any(String));
    const deletedGroupedView = (await app.inject({ method: 'GET', url: '/api/candidates?deleted=all' })).json().items.find((item: { id: string }) => item.id === root.id) as { merge_group: { groupVersionHash: string } };
    const beforeRestore = stateSnapshot();

    const wrongRootRestore = await app.inject({
      method: 'POST',
      url: `/api/candidates/${member.id}/restore`,
      payload: { expectedVersion: deletedRoot.version, expectedGroupVersionHash: deletedGroupedView.merge_group.groupVersionHash },
    });
    expect(wrongRootRestore.statusCode).toBe(409);
    expect(stateSnapshot()).toEqual(beforeRestore);

    const wrongMemberRestore = await app.inject({
      method: 'POST',
      url: `/api/candidates/${member.id}/restore`,
      payload: { expectedVersion: deletedMember.version + 1, expectedGroupVersionHash: deletedGroupedView.merge_group.groupVersionHash },
    });
    expect(wrongMemberRestore.statusCode).toBe(409);
    expect(stateSnapshot()).toEqual(beforeRestore);

    const restored = await app.inject({
      method: 'POST',
      url: `/api/candidates/${member.id}/restore`,
      payload: { expectedVersion: deletedMember.version, expectedGroupVersionHash: deletedGroupedView.merge_group.groupVersionHash },
    });
    expect(restored.statusCode).toBe(200);
    const restoredRows = database.raw.prepare('SELECT id, deleted_at, version, merged_into_candidate_id FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(root.id, member.id) as Array<{ id: string; deleted_at: string | null; version: number; merged_into_candidate_id: string | null }>;
    expect(restoredRows.every((row) => row.deleted_at === null)).toBe(true);
    expect(restoredRows.find((row) => row.id === root.id)?.version).toBe(deletedRoot.version + 1);
    expect(restoredRows.find((row) => row.id === member.id)?.version).toBe(deletedMember.version + 1);
    expect(restoredRows.find((row) => row.id === member.id)?.merged_into_candidate_id).toBe(root.id);
  });

  it('rejects a stale member group hash and a member changes=0 without archiving or partially deleting the group', async () => {
    const root = await simulate('data03-delete-group-stale-root');
    const member = await simulate('data03-delete-group-stale-member');
    makeMergedGroup(root, member);
    database.raw.prepare(
      `INSERT INTO notification
        (id, candidate_id, notification_type, dedupe_key, reason, created_at)
       VALUES (?, ?, 'immediate', ?, '合成候选提醒', ?)`,
    ).run('data03-delete-group-stale-notice', member.id, 'data03-delete-group-stale-key', '2026-08-16T00:00:00.000Z');
    const groupedView = (await app.inject({ method: 'GET', url: '/api/candidates?deleted=all' })).json().items.find((item: { id: string }) => item.id === root.id) as { merge_group: { groupVersionHash: string } };
    const before = database.raw.prepare('SELECT id, deleted_at, version, updated_at, merged_into_candidate_id FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(root.id, member.id);
    database.raw.prepare('UPDATE candidate_request SET version = version + 1 WHERE id = ?').run(member.id);
    const stale = await app.inject({
      method: 'DELETE',
      url: `/api/candidates/${root.id}`,
      payload: { expectedVersion: root.version, expectedGroupVersionHash: groupedView.merge_group.groupVersionHash },
    });
    expect(stale.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT id, deleted_at, version, updated_at, merged_into_candidate_id FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(root.id, member.id)).toEqual(
      (before as Array<{ id: string; deleted_at: string | null; version: number; updated_at: string; merged_into_candidate_id: string | null }>).map((row) => row.id === member.id ? { ...row, version: row.version + 1 } : row),
    );
    expect(database.raw.prepare('SELECT archived_at FROM notification WHERE candidate_id = ?').get(member.id)).toEqual({ archived_at: null });

    const freshRoot = await simulate('data03-delete-group-trigger-root');
    const freshMember = await simulate('data03-delete-group-trigger-member');
    makeMergedGroup(freshRoot, freshMember);
    database.raw.prepare(
      `INSERT INTO notification
        (id, candidate_id, notification_type, dedupe_key, reason, created_at)
       VALUES (?, ?, 'immediate', ?, '合成候选提醒', ?)`,
    ).run('data03-delete-group-trigger-notice', freshRoot.id, 'data03-delete-group-trigger-key', '2026-08-16T00:00:00.000Z');
    const freshView = (await app.inject({ method: 'GET', url: '/api/candidates?deleted=all' })).json().items.find((item: { id: string }) => item.id === freshRoot.id) as { merge_group: { groupVersionHash: string } };
    const triggerName = 'data03_delete_group_ignore_member';
    database.raw.exec(`CREATE TRIGGER ${triggerName} BEFORE UPDATE OF deleted_at ON candidate_request WHEN OLD.id = '${freshMember.id}' BEGIN SELECT RAISE(IGNORE); END`);
    const triggerBefore = database.raw.prepare('SELECT id, deleted_at, version, updated_at FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(freshRoot.id, freshMember.id);
    const ignored = await app.inject({
      method: 'DELETE',
      url: `/api/candidates/${freshRoot.id}`,
      payload: { expectedVersion: freshRoot.version, expectedGroupVersionHash: freshView.merge_group.groupVersionHash },
    });
    expect(ignored.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT id, deleted_at, version, updated_at FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(freshRoot.id, freshMember.id)).toEqual(triggerBefore);
    expect(database.raw.prepare('SELECT archived_at FROM notification WHERE candidate_id = ?').get(freshRoot.id)).toEqual({ archived_at: null });
    database.raw.exec(`DROP TRIGGER ${triggerName}`);
  });

  it('requires candidate CAS for correction writes and does not apply a stale correction', async () => {
    const candidate = await simulate('data03-cas-correction');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: { correctionType: 'describe_incomplete', candidateId: candidate.id, replacementValue: '合成修正' },
    });
    expect(missing.statusCode).toBe(400);
    const first = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: {
        correctionType: 'describe_incomplete',
        candidateId: candidate.id,
        expectedCandidateVersion: candidate.version,
        replacementValue: '合成修正',
        idempotencyKey: 'data03-correction-one',
      },
    });
    expect(first.statusCode).toBe(200);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/corrections',
      payload: {
        correctionType: 'describe_incomplete',
        candidateId: candidate.id,
        expectedCandidateVersion: candidate.version,
        replacementValue: '不应写入',
        idempotencyKey: 'data03-correction-two',
      },
    });
    expect(stale.statusCode).toBe(409);
    expect((database.raw.prepare('SELECT describe, version FROM candidate_request WHERE id = ?').get(candidate.id) as { describe: string; version: number })).toEqual({ describe: '合成修正', version: candidate.version + 1 });
  });

  it('rejects stale reprocess before creating a new candidate revision', async () => {
    const candidate = await simulate('data03-cas-reprocess');
    const before = database.raw.prepare(
      'SELECT analysis_json, processing_state, processing_job_id, version FROM candidate_request WHERE id = ?',
    ).get(candidate.id);
    database.raw.prepare('UPDATE candidate_request SET version = version + 1 WHERE id = ?').run(candidate.id);
    const stale = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/reprocess`,
      payload: { expectedVersion: candidate.version, guidance: '不应执行' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error_code: 'CONFLICT', current: { id: candidate.id, version: candidate.version + 1 } });
    expect(database.raw.prepare(
      'SELECT analysis_json, processing_state, processing_job_id, version FROM candidate_request WHERE id = ?',
    ).get(candidate.id)).toMatchObject({
      analysis_json: (before as { analysis_json: string }).analysis_json,
      processing_state: (before as { processing_state: string }).processing_state,
      processing_job_id: (before as { processing_job_id: string | null }).processing_job_id,
      version: candidate.version + 1,
    });
  });

  it('requires candidate and provisional/target thread revisions for association writes', async () => {
    const candidate = await simulate('data03-cas-thread');
    const missingThreadVersion = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/thread-association`,
      payload: { targetThreadId: null, expectedVersion: candidate.version },
    });
    expect(missingThreadVersion.statusCode).toBe(400);
    const resolveWithoutThreadVersion = service.resolveCandidateThreadAssociation as unknown as (candidateId: string, targetThreadId: null, expectedVersion: number) => unknown;
    expect(() => resolveWithoutThreadVersion.call(service, candidate.id, null, candidate.version)).toThrow('候选已被其他操作更新');
  });

  it('rejects stale merge-primary thread versions before candidate/thread/audit/notification writes', async () => {
    const root = await simulate('data03-primary-root');
    const member = await simulate('data03-primary-member');
    const threadId = makeMergedGroup(root, member);
    const listed = (await app.inject({ method: 'GET', url: '/api/candidates?deleted=all' })).json().items.find((item: { id: string }) => item.id === root.id) as { merge_group: { groupVersionHash: string; threadVersion: number } };
    const missingThreadVersion = await app.inject({
      method: 'POST',
      url: `/api/candidates/${root.id}/merge/primary`,
      payload: { primaryCandidateId: member.id, expectedVersion: root.version, expectedGroupVersionHash: listed.merge_group.groupVersionHash },
    });
    expect(missingThreadVersion.statusCode).toBe(400);
    database.raw.prepare('UPDATE requirement_thread SET version = version + 1 WHERE id = ?').run(threadId);
    const before = {
      candidates: database.raw.prepare('SELECT id, merged_into_candidate_id, version, updated_at FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(root.id, member.id),
      thread: database.raw.prepare('SELECT id, version, primary_source_event_id, updated_at FROM requirement_thread WHERE id = ?').get(threadId),
      corrections: database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'candidate_primary_changed'").get(),
      notifications: database.raw.prepare("SELECT COUNT(*) AS count FROM notification WHERE candidate_id = ?").get(member.id),
    };
    const response = await app.inject({
      method: 'POST',
      url: `/api/candidates/${root.id}/merge/primary`,
      payload: {
        primaryCandidateId: member.id,
        expectedVersion: root.version,
        expectedThreadVersion: listed.merge_group.threadVersion,
        expectedGroupVersionHash: listed.merge_group.groupVersionHash,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT id, merged_into_candidate_id, version, updated_at FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(root.id, member.id)).toEqual(before.candidates);
    expect(database.raw.prepare('SELECT id, version, primary_source_event_id, updated_at FROM requirement_thread WHERE id = ?').get(threadId)).toEqual(before.thread);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'candidate_primary_changed'").get()).toEqual(before.corrections);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM notification WHERE candidate_id = ?").get(member.id)).toEqual(before.notifications);
  });

  it('rejects stale split thread versions before moving candidate relations or creating a second thread', async () => {
    const root = await simulate('data03-split-root');
    const member = await simulate('data03-split-member');
    const threadId = makeMergedGroup(root, member);
    const listed = (await app.inject({ method: 'GET', url: '/api/candidates?deleted=all' })).json().items.find((item: { id: string }) => item.id === root.id) as { merge_group: { groupVersionHash: string; threadVersion: number } };
    const missingThreadVersion = await app.inject({
      method: 'POST',
      url: `/api/candidates/${member.id}/merge/split`,
      payload: { expectedVersion: member.version, expectedGroupVersionHash: listed.merge_group.groupVersionHash },
    });
    expect(missingThreadVersion.statusCode).toBe(400);
    const before = {
      candidates: database.raw.prepare('SELECT id, merged_into_candidate_id, version, updated_at FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(root.id, member.id),
      threads: database.raw.prepare('SELECT id, status, version FROM requirement_thread ORDER BY id').all(),
      relations: database.raw.prepare('SELECT thread_id, source_event_id, demand_unit_id FROM requirement_thread_source ORDER BY thread_id, source_event_id').all(),
      corrections: database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'candidate_split'").get(),
    };
    database.raw.prepare('UPDATE requirement_thread SET version = version + 1 WHERE id = ?').run(threadId);
    const response = await app.inject({
      method: 'POST',
      url: `/api/candidates/${member.id}/merge/split`,
      payload: {
        expectedVersion: member.version,
        expectedThreadVersion: listed.merge_group.threadVersion,
        expectedGroupVersionHash: listed.merge_group.groupVersionHash,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(database.raw.prepare('SELECT id, merged_into_candidate_id, version, updated_at FROM candidate_request WHERE id IN (?, ?) ORDER BY id').all(root.id, member.id)).toEqual(before.candidates);
    const expectedThreads = (before.threads as Array<{ id: string; status: string; version: number }>).map((row) => row.id === threadId ? { ...row, version: row.version + 1 } : row);
    expect(database.raw.prepare('SELECT id, status, version FROM requirement_thread ORDER BY id').all()).toEqual(expectedThreads);
    expect(database.raw.prepare('SELECT thread_id, source_event_id, demand_unit_id FROM requirement_thread_source ORDER BY thread_id, source_event_id').all()).toEqual(before.relations);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM correction_event WHERE correction_type = 'candidate_split'").get()).toEqual(before.corrections);
  });
});
