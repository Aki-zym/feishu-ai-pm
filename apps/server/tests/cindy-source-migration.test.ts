import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveCindyAuthContext } from '../src/cindy-source.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/database.js';
import { createCindyAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

describe('Cindy trusted source v9 migration', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('旧 v8 source_event 前向迁移为 legacy_read_only，重新读取稳定身份才签发新 receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'cindy-source-v9-'));
    roots.push(root);
    const path = join(root, 'pm.sqlite');
    const oldDatabase = new AppDatabase(path, false, { targetSchemaVersionForTest: 8 });
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: `file:${path}` });
    const oldService = new PmService(oldDatabase, createCindyAdapters(config), config);
    oldService.processCindyIntake({
      window_id: 'legacy-window',
      window_start: '2026-08-24T00:00:00.000Z',
      window_end: '2026-08-24T00:05:00.000Z',
      sources: [{ source_key: 'legacy-key', occurred_at: '2026-08-24T00:01:00.000Z', text: '旧来源正文。' }],
      proposals: [],
    });
    const legacy = oldDatabase.raw.prepare('SELECT id, current_revision_id FROM source_event').get() as { id: string; current_revision_id: string };
    const metadata = JSON.stringify({ provider: 'synthetic', sourceKind: 'synthetic_message', stableMessageId: 'legacy-message-1' });
    oldDatabase.raw.prepare('UPDATE source_event SET metadata_json = ? WHERE id = ?').run(metadata, legacy.id);
    oldDatabase.raw.prepare('UPDATE source_event_revision SET metadata_json = ? WHERE id = ?').run(metadata, legacy.current_revision_id);
    oldDatabase.close();

    const database = new AppDatabase(path, false);
    expect((database.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(database.raw.prepare('SELECT ingest_state FROM source_event WHERE id = ?').get(legacy.id)).toEqual({ ingest_state: 'legacy_read_only' });
    expect(database.raw.prepare('SELECT processing_status, receipt_digest FROM source_event_revision WHERE id = ?').get(legacy.current_revision_id))
      .toEqual({ processing_status: 'legacy_read_only', receipt_digest: null });
    expect(database.raw.prepare('SELECT state, current_revision_id FROM cindy_source_identity WHERE source_event_id = ?').get(legacy.id))
      .toEqual({ state: 'legacy_read_only', current_revision_id: legacy.current_revision_id });

    const service = new PmService(database, createCindyAdapters(config), config);
    const result = service.saveCindySources(deriveCindyAuthContext('migration-test-token'), {
      save_request_id: 'save-legacy-reread',
      sources: [{
        client_ref: 'legacy',
        provider: 'synthetic',
        source_kind: 'synthetic_message',
        stable_message_id: 'legacy-message-1',
        occurred_at: '2026-08-24T00:01:00.000Z',
        text: '重新读取后的可信来源。',
        revision: { sequence: 1 },
      }],
    });
    expect(result.sources[0]).toMatchObject({ source_status: 'pending_decision', revision: { generation: 2 } });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE id = ?').get(legacy.id)).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT ingest_state, revision_generation FROM source_event WHERE id = ?').get(legacy.id))
      .toEqual({ ingest_state: 'trusted_current', revision_generation: 2 });
    database.close();
  });

  it('无法形成稳定身份的旧来源继续只读隔离', () => {
    const database = new AppDatabase(':memory:', false);
    const timestamp = '2026-08-24T00:00:00.000Z';
    database.raw.prepare(
      `INSERT INTO source_event
        (id, external_id, source_type, conversation_id, sender_id, sender_name, content, owner_mentioned,
         source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at,
         owner_scope, revision_generation, current_revision_id)
       VALUES ('legacy-unmapped', 'legacy-unmapped', 'manual', 'legacy', 'legacy', 'legacy', 'legacy', 0,
               NULL, 'complete', '', '{}', ?, ?, 'primary', 0, NULL)`,
    ).run(timestamp, timestamp);
    expect(database.raw.prepare('SELECT ingest_state FROM source_event WHERE id = ?').get('legacy-unmapped')).toEqual({ ingest_state: 'legacy_read_only' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM cindy_source_identity WHERE source_event_id = ?').get('legacy-unmapped')).toEqual({ count: 0 });
    database.close();
  });
});
