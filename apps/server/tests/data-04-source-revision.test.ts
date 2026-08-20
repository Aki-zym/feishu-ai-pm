import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_REPLAY_INTENT, buildApp, createLocalActionCapability } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  AppDatabase,
  PRIVACY_FENCING_MIGRATION_CHECKSUM,
  PRIVACY_MIGRATION_CHECKSUM,
  CURRENT_SCHEMA_VERSION,
  SOURCE_REVISION_MIGRATION_CHECKSUM,
  SOURCE_REVISION_MIGRATION_DESCRIPTOR,
  type MigrationDescriptor,
  type MigrationOperation,
} from '../src/database.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';
import type { NormalizedSourceEvent } from '../src/domain.js';
import { canonicalRevisionHash, canonicalRevisionSetHash, type RevisionSetEntry } from '../src/data04.js';

const roots: string[] = [];

function event(externalId: string, content: string, version: number, recalled = false): NormalizedSourceEvent {
  return {
    externalId,
    sourceType: 'owner_dm',
    conversationId: 'data04-conversation',
    senderId: 'data04-sender',
    senderName: '合成发送者',
    content,
    occurredAt: '2026-08-16T00:00:00.000Z',
    ownerMentioned: false,
    completeness: recalled ? 'limited' : 'complete',
    discoveryReason: 'synthetic-data04',
    metadata: { sourceVersion: version, ...(recalled ? { recalled: true } : {}) },
  };
}

function serviceFixture() {
  const database = new AppDatabase(':memory:', false);
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
  const service = new PmService(database, createAdapters(config), config);
  return { database, service };
}

function downgradeV7ToV5(path: string) {
  const database = new AppDatabase(path, false);
  database.close();
  const raw = new DatabaseSync(path);
  try {
    raw.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS ai_decision_source_revision;
      DROP TABLE IF EXISTS source_event_revision;
      DROP TABLE IF EXISTS audit_replay_capability;
      DROP INDEX IF EXISTS idx_provider_retry_cooldown_retry_at;
      DROP TABLE IF EXISTS provider_retry_cooldown;
      DROP TABLE IF EXISTS privacy_lifecycle_claim;
      DROP TABLE IF EXISTS privacy_backup_cleanup_intent;
      ALTER TABLE source_event DROP COLUMN owner_scope;
      ALTER TABLE source_event DROP COLUMN revision_generation;
      ALTER TABLE source_event DROP COLUMN current_revision_id;
      ALTER TABLE ai_decision_log DROP COLUMN revision_set_hash;
      ALTER TABLE ai_decision_log DROP COLUMN prompt_hash;
      ALTER TABLE ai_decision_log DROP COLUMN model_config_hash;
      ALTER TABLE ai_decision_log DROP COLUMN replay_state;
      ALTER TABLE ai_decision_log DROP COLUMN replay_state_reason;
      ALTER TABLE ai_decision_log DROP COLUMN owner_scope;
      DELETE FROM schema_migration WHERE version IN (6, 7, 8);
      PRAGMA user_version = 5;
      PRAGMA foreign_keys = ON;
    `);
  } finally {
    raw.close();
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Issue #38 DATA-04 immutable source revisions and replay references', () => {
  it('owns the next schema version and upgrades v5 with a stable descriptor/checksum', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(8);
    expect(SOURCE_REVISION_MIGRATION_DESCRIPTOR.version).toBe(7);
    expect(SOURCE_REVISION_MIGRATION_DESCRIPTOR.expectedPostSchemaIdentity).toBe('current-schema-v7');
    expect(SOURCE_REVISION_MIGRATION_CHECKSUM).toMatch(/^[a-f0-9]{64}$/u);
    const directory = mkdtempSync(join(tmpdir(), 'ai-pm-data04-upgrade-'));
    roots.push(directory);
    const path = join(directory, 'data.sqlite');
    downgradeV7ToV5(path);
    const upgraded = new AppDatabase(path, false);
    try {
      expect(upgraded.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
      expect(upgraded.raw.prepare('SELECT version, name, checksum FROM schema_migration WHERE version = 7').get())
        .toEqual({ version: 7, name: 'data-04-source-revisions-replay', checksum: SOURCE_REVISION_MIGRATION_CHECKSUM });
      expect(upgraded.raw.prepare('SELECT checksum FROM schema_migration WHERE version = 5').get())
        .toEqual({ checksum: PRIVACY_MIGRATION_CHECKSUM });
      expect(upgraded.raw.prepare('SELECT checksum FROM schema_migration WHERE version = 6').get())
        .toEqual({ checksum: PRIVACY_FENCING_MIGRATION_CHECKSUM });
      expect(upgraded.raw.prepare('PRAGMA table_info(source_event)').all())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'current_revision_id' })]));
      expect(upgraded.raw.prepare('SELECT COUNT(*) AS count FROM source_event_revision').get()).toEqual({ count: 0 });
      expect(upgraded.raw.prepare('SELECT COUNT(*) AS count FROM audit_replay_capability').get()).toEqual({ count: 0 });
    } finally {
      upgraded.close();
    }
  });

  it('rolls back a failed v7 migration and rejects a partial v7 schema before mutation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-pm-data04-rollback-'));
    roots.push(directory);
    const path = join(directory, 'data.sqlite');
    downgradeV7ToV5(path);
    const first = SOURCE_REVISION_MIGRATION_DESCRIPTOR.orderedOperations[0]!;
    if (first.kind !== 'sql_batch') throw new Error('v7 SQL operation missing');
    const injected: MigrationOperation = {
      id: 'synthetic-v7-failure',
      kind: 'sql_batch',
      statements: ["INSERT INTO __missing_data04_table VALUES ('synthetic')"],
    };
    const descriptor: MigrationDescriptor = {
      ...SOURCE_REVISION_MIGRATION_DESCRIPTOR,
      orderedOperations: [first, injected, ...SOURCE_REVISION_MIGRATION_DESCRIPTOR.orderedOperations.slice(1)],
    };
    expect(() => new AppDatabase(path, false, { migrationDescriptorForTest: descriptor })).toThrowError(expect.objectContaining({ name: 'DatabaseUpgradeError', stage: 'migration' }));
    const restored = new DatabaseSync(path, { readOnly: true });
    try {
      expect(restored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 });
      expect(restored.prepare('SELECT version FROM schema_migration ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 5 });
      expect(restored.prepare('PRAGMA table_info(source_event)').all())
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'current_revision_id' })]));
    } finally {
      restored.close();
    }

    downgradeV7ToV5(path);
    const partial = new DatabaseSync(path);
    try {
      partial.exec('ALTER TABLE source_event ADD COLUMN current_revision_id TEXT;');
    } finally {
      partial.close();
    }
    expect(() => new AppDatabase(path, false)).toThrowError(expect.objectContaining({ name: 'DatabaseUpgradeError' }));
    const rejected = new DatabaseSync(path, { readOnly: true });
    try {
      expect(rejected.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 });
      expect(rejected.prepare('SELECT version FROM schema_migration ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 5 });
    } finally {
      rejected.close();
    }
  });

  it('uses the current schema and appends ingest/edit/recall without overwriting history', async () => {
    const { database, service } = serviceFixture();
    try {
      expect(database.raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      await service.captureSourceBatch([event('data04-source', '第一版正文', 1)]);
      await service.captureSourceBatch([event('data04-source', '第二版正文', 2)]);
      await service.captureSourceBatch([event('data04-source', '', 3, true)]);
      await service.captureSourceBatch([event('data04-source', '', 3, true)]);

      const source = database.raw.prepare('SELECT id, current_revision_id, content FROM source_event WHERE external_id = ?').get('data04-source') as { id: string; current_revision_id: string; content: string };
      const revisions = database.raw.prepare(
        'SELECT revision_number, revision_kind, content FROM source_event_revision WHERE source_event_id = ? ORDER BY revision_number',
      ).all(source.id) as Array<{ revision_number: number; revision_kind: string; content: string }>;
      expect(revisions).toEqual([
        { revision_number: 1, revision_kind: 'ingest', content: '第一版正文' },
        { revision_number: 2, revision_kind: 'edit', content: '第二版正文' },
        { revision_number: 3, revision_kind: 'recall', content: '[飞书消息已撤回或删除，正文不再保留]' },
      ]);
      expect(source.current_revision_id).toBe(
        database.raw.prepare('SELECT id FROM source_event_revision WHERE source_event_id = ? AND revision_number = 3').get(source.id)!.id,
      );
      expect(source.content).toBe('[飞书消息已撤回或删除，正文不再保留]');
    } finally {
      database.close();
    }
  });

  it('binds AI decisions to exact revision IDs and replays the old revision after current content changes', async () => {
    const { database, service } = serviceFixture();
    const capability = createLocalActionCapability();
    const app = await buildApp(service, { serveWeb: false, desktopCapability: capability });
    try {
      await service.ingestSource(event('data04-ai-source', '回放第一版正文', 1));
      const source = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data04-ai-source') as { id: string };
      const decision = database.raw.prepare(
        'SELECT id FROM ai_decision_log WHERE source_event_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      ).get(source.id) as { id: string } | undefined;
      expect(decision).toBeTruthy();
      const reference = database.raw.prepare(
        `SELECT reference.revision_id, revision.content
         FROM ai_decision_source_revision AS reference
         JOIN source_event_revision AS revision ON revision.id = reference.revision_id
         WHERE reference.ai_decision_id = ?`,
      ).get(decision!.id) as { revision_id: string; content: string };
      expect(reference.content).toBe('回放第一版正文');

      await service.captureSourceBatch([event('data04-ai-source', '后来覆盖的正文', 2)]);
      const response = await app.inject({
        method: 'GET',
        url: `/api/audit/ai-decisions/${decision!.id}/replay`,
        headers: {
          origin: 'app://local',
          'x-ai-pm-desktop-capability': capability.token,
          'x-csrf-token': capability.csrfToken,
          'x-ai-pm-privacy-intent': AUDIT_REPLAY_INTENT,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ decisionId: decision!.id, revisionIds: [reference.revision_id] });
      expect(response.body).not.toContain('回放第一版正文');
      expect(response.body).not.toContain('后来覆盖的正文');

      const replayCapability = createLocalActionCapability();
      const replayBinding = service.registerAuditReplayCapability(replayCapability);
      const replay = service.replayAiDecision(decision!.id, replayBinding);
      expect(replay.revisionIds).toEqual([reference.revision_id]);
      expect(replay.sourceEventIds).toEqual([source.id]);
      expect(JSON.stringify(replay)).not.toContain('回放第一版正文');
      expect(JSON.stringify(replay)).not.toContain('后来覆盖的正文');
    } finally {
      await app.close();
      database.close();
    }
  });

  it('requires the durable current capability at the service boundary and fails closed for forged or stale authorization', async () => {
    const { database, service } = serviceFixture();
    const canary = 'service-auth-canary';
    try {
      await service.ingestSource(event('data04-auth-source', canary, 1));
      const source = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data04-auth-source') as { id: string };
      const decision = database.raw.prepare('SELECT id FROM ai_decision_log WHERE source_event_id = ? ORDER BY rowid DESC LIMIT 1').get(source.id) as { id: string };
      const baseline = {
        source: database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get(),
        revisions: database.raw.prepare('SELECT COUNT(*) AS count FROM source_event_revision').get(),
        decisions: database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get(),
        references: database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_source_revision').get(),
      };
      const forged = {
        tokenHash: createHash('sha256').update('forged-token').digest('hex'),
        csrfTokenHash: createHash('sha256').update('forged-csrf').digest('hex'),
        origin: 'app://local' as const,
      };
      expect(() => service.replayAiDecision(decision.id, undefined as never)).toThrow(/凭证无效/u);
      const capability = createLocalActionCapability();
      const binding = service.registerAuditReplayCapability(capability);
      expect(() => service.replayAiDecision(decision.id, forged)).toThrow(/凭证无效/u);
      expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
        .toEqual({ status: 'active' });

      database.raw.prepare('UPDATE audit_replay_capability SET expires_at = ?, updated_at = ? WHERE owner_scope = ? AND intent = ?')
        .run(new Date(Date.now() - 1_000).toISOString(), nowIso(), 'primary', AUDIT_REPLAY_INTENT);
      expect(() => service.replayAiDecision(decision.id, binding)).toThrow(/过期/u);
      expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
        .toEqual({ status: 'active' });

      const revokedCapability = createLocalActionCapability();
      const revokedBinding = service.registerAuditReplayCapability(revokedCapability);
      database.raw.prepare('UPDATE audit_replay_capability SET status = \'revoked\', revoked_at = ?, updated_at = ? WHERE owner_scope = ? AND intent = ?')
        .run(nowIso(), nowIso(), 'primary', AUDIT_REPLAY_INTENT);
      expect(() => service.replayAiDecision(decision.id, revokedBinding)).toThrow(/无效|已使用/u);
      expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
        .toEqual({ status: 'revoked' });

      const currentCapability = createLocalActionCapability();
      const currentBinding = service.registerAuditReplayCapability(currentCapability);
      database.raw.prepare('UPDATE ai_decision_log SET owner_scope = ? WHERE id = ?').run('foreign-owner', decision.id);
      expect(() => service.replayAiDecision(decision.id, currentBinding)).toThrow(/当前系统主人|跨主人/u);
      expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
        .toEqual({ status: 'active' });
      database.raw.prepare('UPDATE ai_decision_log SET owner_scope = ? WHERE id = ?').run('primary', decision.id);
      database.raw.prepare('UPDATE source_event SET owner_scope = ? WHERE id = ?').run('foreign-owner', source.id);
      expect(() => service.replayAiDecision(decision.id, currentBinding)).toThrow(/缺失|跨主人/u);
      expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
        .toEqual({ status: 'active' });
      database.raw.prepare('UPDATE source_event SET owner_scope = ? WHERE id = ?').run('primary', source.id);
      expect(() => service.replayAiDecision('wrong-decision-id', currentBinding)).toThrow(/不存在/u);
      expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
        .toEqual({ status: 'active' });
      expect(service.replayAiDecision(decision.id, currentBinding)).toMatchObject({ decisionId: decision.id });
      expect(() => service.replayAiDecision(decision.id, currentBinding)).toThrow(/无效|已使用/u);
      expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
        .toEqual({ status: 'consumed' });
      expect(JSON.stringify(baseline)).not.toContain(canary);
      expect(database.raw.prepare('SELECT content FROM source_event WHERE id = ?').get(source.id)).toEqual({ content: canary });
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual(baseline.source);
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event_revision').get()).toEqual(baseline.revisions);
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual(baseline.decisions);
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_source_revision').get()).toEqual(baseline.references);
    } finally {
      database.close();
    }
  });

  it('keeps HTTP replay checks and the service invariant on one authorization path', async () => {
    const { database, service } = serviceFixture();
    const capability = createLocalActionCapability();
    const app = await buildApp(service, { serveWeb: false, desktopCapability: capability });
    try {
      await service.ingestSource(event('data04-http-auth-source', 'http auth canary', 1));
      const source = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data04-http-auth-source') as { id: string };
      const decision = database.raw.prepare('SELECT id FROM ai_decision_log WHERE source_event_id = ? ORDER BY rowid DESC LIMIT 1').get(source.id) as { id: string };
      const headers = {
        origin: 'app://local',
        referer: 'app://local/',
        'x-ai-pm-desktop-capability': capability.token,
        'x-csrf-token': capability.csrfToken,
        'x-ai-pm-privacy-intent': AUDIT_REPLAY_INTENT,
      };
      const missing = await app.inject({ method: 'GET', url: `/api/audit/ai-decisions/${decision.id}/replay` });
      expect(missing.statusCode).toBe(401);
      const forged = await app.inject({
        method: 'GET',
        url: `/api/audit/ai-decisions/${decision.id}/replay`,
        headers: { ...headers, 'x-ai-pm-desktop-capability': 'forged-token' },
      });
      expect(forged.statusCode).toBe(403);
      expect(forged.body).not.toContain('http auth canary');
      const wrongCsrf = await app.inject({
        method: 'GET',
        url: `/api/audit/ai-decisions/${decision.id}/replay`,
        headers: { ...headers, 'x-csrf-token': 'forged-csrf' },
      });
      expect(wrongCsrf.statusCode).toBe(403);
      const wrongOrigin = await app.inject({
        method: 'GET',
        url: `/api/audit/ai-decisions/${decision.id}/replay`,
        headers: { ...headers, origin: 'https://evil.invalid', referer: 'https://evil.invalid/' },
      });
      expect(wrongOrigin.statusCode).toBe(403);
      const wrongIntent = await app.inject({
        method: 'GET',
        url: `/api/audit/ai-decisions/${decision.id}/replay`,
        headers: { ...headers, 'x-ai-pm-privacy-intent': 'privacy.deletion.hard-delete.v1' },
      });
      expect(wrongIntent.statusCode).toBe(403);
      expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
        .toEqual({ status: 'active' });
      const valid = await app.inject({ method: 'GET', url: `/api/audit/ai-decisions/${decision.id}/replay`, headers });
      expect(valid.statusCode).toBe(200);
      expect(valid.body).not.toContain('http auth canary');
      const replayed = await app.inject({ method: 'GET', url: `/api/audit/ai-decisions/${decision.id}/replay`, headers });
      expect(replayed.statusCode).toBe(403);
      expect(replayed.body).not.toContain('http auth canary');
      expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
        .toEqual({ status: 'consumed' });
    } finally {
      await app.close();
      database.close();
    }
  });

  it('rejects an incomplete or tampered replay reference without partial writes', async () => {
    const { database, service } = serviceFixture();
    try {
      await service.ingestSource(event('data04-fail-source', '不可伪造的正文', 1));
      const source = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data04-fail-source') as { id: string };
      const decision = database.raw.prepare('SELECT id FROM ai_decision_log WHERE source_event_id = ? LIMIT 1').get(source.id) as { id: string };
      database.raw.prepare('DELETE FROM ai_decision_source_revision WHERE ai_decision_id = ?').run(decision.id);
      const capability = createLocalActionCapability();
      const binding = service.registerAuditReplayCapability(capability);
      expect(() => service.replayAiDecision(decision.id, binding)).toThrow('缺少完整来源修订引用');
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event_revision WHERE source_event_id = ?').get(source.id)).toEqual({ count: 1 });
      expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log WHERE id = ?').get(decision.id)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('backfills a canonical non-placeholder revision hash and marks legacy decisions unreplayable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-pm-data04-legacy-'));
    roots.push(directory);
    const path = join(directory, 'data.sqlite');
    downgradeV7ToV5(path);
    const legacy = new DatabaseSync(path);
    try {
      legacy.prepare(`INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content,
         owner_mentioned, source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at)
        VALUES (?, ?, 'owner_dm', 'legacy-conversation', 'legacy-sender', 'legacy sender', ?, 0, NULL,
                'complete', 'legacy-fixture', ?, ?, ?)`)
        .run('legacy-source', 'legacy-external', 'legacy content', '{"sourceVersion":1}', nowIso(), nowIso());
      legacy.prepare(`INSERT INTO ai_decision_log
        (id, source_event_id, provider, model, prompt_version, is_data_request, reason, output_json,
         latency_ms, created_at)
        VALUES ('legacy-decision', 'legacy-source', 'legacy-provider', 'legacy-model', 'legacy-prompt', 1,
                'legacy reason', '{}', 1, ?)`)
        .run(nowIso());
    } finally {
      legacy.close();
    }
    const upgraded = new AppDatabase(path, false);
    try {
      const revision = upgraded.raw.prepare('SELECT * FROM source_event_revision WHERE source_event_id = ?').get('legacy-source') as {
        owner_scope: string; revision_hash: string; external_id: string; source_event_id: string; source_type: string;
        conversation_id: string; sender_id: string; sender_name: string; content: string; owner_mentioned: number;
        source_url: string | null; completeness: string; discovery_reason: string; metadata_json: string; occurred_at: string; captured_at: string;
      };
      expect(revision.revision_hash).toBe(canonicalRevisionHash({
        ownerScope: 'primary', sourceEventId: revision.source_event_id, revisionNumber: 1, revisionKind: 'migration', externalId: revision.external_id,
        sourceType: revision.source_type, conversationId: revision.conversation_id, senderId: revision.sender_id,
        senderName: revision.sender_name, content: revision.content, ownerMentioned: revision.owner_mentioned,
        sourceUrl: revision.source_url, completeness: revision.completeness, discoveryReason: revision.discovery_reason,
        metadataJson: revision.metadata_json, occurredAt: revision.occurred_at, capturedAt: revision.captured_at,
      }));
      expect(revision.revision_hash).not.toBe('0'.repeat(64));
      expect(upgraded.raw.prepare('SELECT replay_state FROM ai_decision_log WHERE id = ?').get('legacy-decision'))
        .toEqual({ replay_state: 'unreplayable_legacy' });
      const service = new PmService(upgraded, createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: path })), loadConfig({ NODE_ENV: 'test', DATABASE_URL: path }));
      const capability = createLocalActionCapability();
      const binding = service.registerAuditReplayCapability(capability);
      expect(() => service.replayAiDecision('legacy-decision', binding)).toThrow(/不可回放/u);
    } finally {
      upgraded.close();
    }
  });

  it('fails closed for content, source identity, null hash, and owner-scope tampering', async () => {
    const tampered = async (mutate: (database: AppDatabase, decisionId: string, sourceId: string, foreignSourceId: string, revisionId: string) => void, expected: RegExp) => {
      const { database, service } = serviceFixture();
      try {
        await service.ingestSource(event('data04-attack-a', 'attack canary', 1));
        await service.ingestSource(event('data04-attack-b', 'foreign canary', 1));
        const source = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data04-attack-a') as { id: string };
        const foreign = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data04-attack-b') as { id: string };
        const decision = database.raw.prepare('SELECT id FROM ai_decision_log WHERE source_event_id = ? ORDER BY rowid DESC LIMIT 1').get(source.id) as { id: string };
        const reference = database.raw.prepare('SELECT revision_id FROM ai_decision_source_revision WHERE ai_decision_id = ?').get(decision.id) as { revision_id: string };
        mutate(database, decision.id, source.id, foreign.id, reference.revision_id);
        const capability = createLocalActionCapability();
        const binding = service.registerAuditReplayCapability(capability);
        expect(() => service.replayAiDecision(decision.id, binding)).toThrow(expected);
      } finally {
        database.close();
      }
    };
    await tampered((database, _decisionId, _sourceId, _foreignSourceId, revisionId) => {
      database.raw.prepare('UPDATE source_event_revision SET content = ? WHERE id = ?').run('mutated canary', revisionId);
    }, /篡改/u);
    await tampered((database, _decisionId, _sourceId, _foreignSourceId, revisionId) => {
      database.raw.prepare("UPDATE source_event_revision SET revision_kind = 'edit' WHERE id = ?").run(revisionId);
    }, /篡改/u);
    await tampered((database, _decisionId, _sourceId, _foreignSourceId, revisionId) => {
      database.raw.prepare('UPDATE source_event_revision SET revision_number = 2 WHERE id = ?').run(revisionId);
    }, /篡改/u);
    await tampered((database, decisionId, _sourceId, _foreignSourceId, revisionId) => {
      database.raw.prepare('UPDATE ai_decision_source_revision SET revision_hash = NULL WHERE ai_decision_id = ? AND revision_id = ?').run(decisionId, revisionId);
    }, /缺失|篡改/u);
    await tampered((database, decisionId, _sourceId, foreignSourceId, revisionId) => {
      database.raw.prepare('UPDATE ai_decision_source_revision SET source_event_id = ? WHERE ai_decision_id = ? AND revision_id = ?').run(foreignSourceId, decisionId, revisionId);
    }, /缺失|跨主人|篡改/u);
    await tampered((database, decisionId, _sourceId, _foreignSourceId, _revisionId) => {
      database.raw.prepare('UPDATE ai_decision_log SET owner_scope = ? WHERE id = ?').run('foreign-owner', decisionId);
    }, /跨主人|当前系统主人/u);
  });

  it('binds decision, references, sources, demand units, candidates and task lineage to one canonical scope', async () => {
    const { database, service } = serviceFixture();
    try {
      await service.ingestSource(event('data04-scope-a', '请分析活动A留存数据；scope canary A', 1));
      await service.ingestSource(event('data04-scope-b', '请分析活动B付费数据；scope canary B', 1));
      const sourceA = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data04-scope-a') as { id: string };
      const sourceB = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data04-scope-b') as { id: string };
      const decisionA = database.raw.prepare(
        'SELECT id, demand_unit_id, candidate_id FROM ai_decision_log WHERE source_event_id = ? ORDER BY rowid DESC LIMIT 1',
      ).get(sourceA.id) as { id: string; demand_unit_id: string; candidate_id: string };
      const decisionB = database.raw.prepare(
        'SELECT id, demand_unit_id, candidate_id FROM ai_decision_log WHERE source_event_id = ? ORDER BY rowid DESC LIMIT 1',
      ).get(sourceB.id) as { id: string; demand_unit_id: string; candidate_id: string };
      const referenceA = database.raw.prepare(
        'SELECT revision_id, revision_hash FROM ai_decision_source_revision WHERE ai_decision_id = ? LIMIT 1',
      ).get(decisionA.id) as { revision_id: string; revision_hash: string };
      const referenceB = database.raw.prepare(
        'SELECT revision_id, revision_hash FROM ai_decision_source_revision WHERE ai_decision_id = ? LIMIT 1',
      ).get(decisionB.id) as { revision_id: string; revision_hash: string };
      const baseline = {
        sourceCount: database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get(),
        decisionCount: database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get(),
        referenceCount: database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_source_revision').get(),
      };

      const assertRejectedWithoutConsumption = (mutate: () => void, expected: RegExp) => {
        mutate();
        const capability = service.registerAuditReplayCapability(createLocalActionCapability());
        expect(() => service.replayAiDecision(decisionA.id, capability)).toThrow(expected);
        expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
          .toEqual({ status: 'active' });
        expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual(baseline.sourceCount);
        expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual(baseline.decisionCount);
        expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_source_revision').get()).toEqual(baseline.referenceCount);
      };

      assertRejectedWithoutConsumption(
        () => database.raw.prepare('UPDATE ai_decision_log SET source_event_id = ? WHERE id = ?').run(sourceB.id, decisionA.id),
        /主来源|范围|跨主人/u,
      );
      database.raw.prepare('UPDATE ai_decision_log SET source_event_id = ? WHERE id = ?').run(sourceA.id, decisionA.id);
      assertRejectedWithoutConsumption(
        () => database.raw.prepare('UPDATE ai_decision_log SET demand_unit_id = ? WHERE id = ?').run(decisionB.demand_unit_id, decisionA.id),
        /需求单元|范围/u,
      );
      database.raw.prepare('UPDATE ai_decision_log SET demand_unit_id = ? WHERE id = ?').run(decisionA.demand_unit_id, decisionA.id);
      assertRejectedWithoutConsumption(
        () => database.raw.prepare('UPDATE ai_decision_log SET candidate_id = ? WHERE id = ?').run(decisionB.candidate_id, decisionA.id),
        /候选|范围/u,
      );
      database.raw.prepare('UPDATE ai_decision_log SET candidate_id = ? WHERE id = ?').run(decisionA.candidate_id, decisionA.id);
      assertRejectedWithoutConsumption(
        () => database.raw.prepare('UPDATE ai_decision_source_revision SET source_event_id = ? WHERE ai_decision_id = ? AND revision_id = ?')
          .run(sourceB.id, decisionA.id, referenceA.revision_id),
        /引用|缺失|跨主人|篡改/u,
      );
      database.raw.prepare('UPDATE ai_decision_source_revision SET source_event_id = ? WHERE ai_decision_id = ? AND revision_id = ?')
        .run(sourceA.id, decisionA.id, referenceA.revision_id);
      assertRejectedWithoutConsumption(
        () => database.raw.prepare('UPDATE ai_decision_source_revision SET ai_decision_id = ? WHERE ai_decision_id = ? AND revision_id = ?')
          .run(decisionB.id, decisionA.id, referenceA.revision_id),
        /引用|缺失|范围/u,
      );
      database.raw.prepare('UPDATE ai_decision_source_revision SET ai_decision_id = ? WHERE ai_decision_id = ? AND revision_id = ?')
        .run(decisionA.id, decisionB.id, referenceA.revision_id);
      assertRejectedWithoutConsumption(
        () => database.raw.prepare('UPDATE source_event SET owner_scope = ? WHERE id = ?').run('foreign-owner', sourceA.id),
        /跨主人|范围/u,
      );
      database.raw.prepare('UPDATE source_event SET owner_scope = ? WHERE id = ?').run('primary', sourceA.id);

      const multiEntries: RevisionSetEntry[] = [
        { sourceEventId: sourceA.id, revisionId: referenceA.revision_id, revisionHash: referenceA.revision_hash, sourceOrder: 0 },
        { sourceEventId: sourceB.id, revisionId: referenceB.revision_id, revisionHash: referenceB.revision_hash, sourceOrder: 1 },
      ];
      database.raw.prepare(
        `INSERT INTO source_demand_unit_source
          (demand_unit_id, source_event_id, source_key, source_role, sequence, created_at)
         VALUES (?, ?, 's2', 'evidence', 1, ?)`,
      ).run(decisionA.demand_unit_id, sourceB.id, nowIso());
      database.raw.prepare(
        `INSERT INTO ai_decision_source_revision
          (ai_decision_id, source_event_id, revision_id, source_order, revision_hash, owner_scope)
         VALUES (?, ?, ?, 1, ?, 'primary')`,
      ).run(decisionA.id, sourceB.id, referenceB.revision_id, referenceB.revision_hash);
      database.raw.prepare('UPDATE ai_decision_log SET revision_set_hash = ? WHERE id = ?')
        .run(canonicalRevisionSetHash(multiEntries), decisionA.id);
      const multiCapability = service.registerAuditReplayCapability(createLocalActionCapability());
      expect(service.replayAiDecision(decisionA.id, multiCapability)).toMatchObject({
        decisionId: decisionA.id,
        sourceEventIds: [sourceA.id, sourceB.id],
        revisionIds: [referenceA.revision_id, referenceB.revision_id],
      });

      const httpCapability = createLocalActionCapability();
      const app = await buildApp(service, { serveWeb: false, desktopCapability: httpCapability });
      try {
        database.raw.prepare('UPDATE ai_decision_log SET candidate_id = ? WHERE id = ?').run(decisionB.candidate_id, decisionA.id);
        const response = await app.inject({
          method: 'GET',
          url: `/api/audit/ai-decisions/${decisionA.id}/replay`,
          headers: {
            origin: 'app://local',
            'x-ai-pm-desktop-capability': httpCapability.token,
            'x-csrf-token': httpCapability.csrfToken,
            'x-ai-pm-privacy-intent': AUDIT_REPLAY_INTENT,
          },
        });
        expect(response.statusCode).toBe(409);
        expect(response.body).not.toContain('scope canary');
        expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
          .toEqual({ status: 'active' });
      } finally {
        await app.close();
      }
    } finally {
      database.close();
    }
  });

  it('rejects a same-owner task substitution without consuming replay capability', async () => {
    const { database, service } = serviceFixture();
    try {
      await service.ingestSource(event('data04-task-a', '请分析任务范围A；task canary A', 1));
      await service.ingestSource(event('data04-task-b', '请分析任务范围B；task canary B', 1));
      const sourceA = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data04-task-a') as { id: string };
      const sourceB = database.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('data04-task-b') as { id: string };
      const decisionA = database.raw.prepare(
        'SELECT id, candidate_id FROM ai_decision_log WHERE source_event_id = ? ORDER BY rowid DESC LIMIT 1',
      ).get(sourceA.id) as { id: string; candidate_id: string };
      const decisionB = database.raw.prepare(
        'SELECT candidate_id FROM ai_decision_log WHERE source_event_id = ? ORDER BY rowid DESC LIMIT 1',
      ).get(sourceB.id) as { candidate_id: string };
      const acceptedA = service.actOnCandidate(
        decisionA.candidate_id,
        'accept',
        undefined,
        service.getCandidate(decisionA.candidate_id)!.version,
      );
      const acceptedB = service.actOnCandidate(
        decisionB.candidate_id,
        'accept',
        undefined,
        service.getCandidate(decisionB.candidate_id)!.version,
      );
      database.raw.prepare('UPDATE candidate_request SET accepted_task_id = ? WHERE id = ?')
        .run(acceptedB.task!.id, decisionA.candidate_id);

      const capability = service.registerAuditReplayCapability(createLocalActionCapability());
      expect(() => service.replayAiDecision(decisionA.id, capability)).toThrow(/任务|候选|范围/u);
      expect(database.raw.prepare('SELECT status FROM audit_replay_capability WHERE owner_scope = ? AND intent = ?').get('primary', AUDIT_REPLAY_INTENT))
        .toEqual({ status: 'active' });

      database.raw.prepare('UPDATE candidate_request SET accepted_task_id = ? WHERE id = ?')
        .run(acceptedA.task!.id, decisionA.candidate_id);
      const validCapability = service.registerAuditReplayCapability(createLocalActionCapability());
      expect(service.replayAiDecision(decisionA.id, validCapability)).toMatchObject({ decisionId: decisionA.id });
    } finally {
      database.close();
    }
  });
});

function nowIso() {
  return new Date().toISOString();
}
