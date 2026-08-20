import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import type { NormalizedSourceEvent } from '../src/domain.js';
import { createAdapters } from '../src/integrations.js';
import { PmService } from '../src/service.js';

const databases: AppDatabase[] = [];
const tempDirectories: string[] = [];

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    FEISHU_EXTERNAL_ENABLED: 'false',
    FEISHU_GROUP_IDS: 'allowed-group',
  });
}

function event(externalId: string, overrides: Partial<NormalizedSourceEvent> = {}): NormalizedSourceEvent {
  return {
    externalId,
    sourceType: 'group',
    conversationId: 'allowed-group',
    senderId: 'requester-open',
    senderName: '需求方',
    content: `请分析活动留存数据：${externalId}`,
    occurredAt: '2026-08-18T10:00:00.000Z',
    ownerMentioned: true,
    completeness: 'partial',
    discoveryReason: '明确授权的补充需求群',
    metadata: {
      sourceScope: 'bot_supplement',
      ownerScope: 'primary',
      chatType: 'group',
      messageType: 'text',
    },
    ...overrides,
  };
}

function service(database: AppDatabase, config = testConfig()) {
  return new PmService(database, createAdapters(config), config);
}

function persistOnly(tested: PmService, input: NormalizedSourceEvent) {
  return (tested as unknown as {
    persistSourceEvent: (event: NormalizedSourceEvent) => {
      row: { id: string; external_id: string; source_type: string; conversation_id: string; owner_scope: string; metadata_json: string; content: string };
      deduplicated: boolean;
    };
  }).persistSourceEvent(input);
}

afterEach(async () => {
  // captureFeishuBotEvent intentionally returns after the inbox commit while
  // classification continues asynchronously. Let that bounded work settle
  // before closing the synthetic database.
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const database of databases.splice(0)) {
    try { database.close(); } catch { /* already closed */ }
  }
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('FSH-03 durable inbox before Feishu acknowledgement', () => {
  it('rejects before-commit database failure and leaves no inbox row', async () => {
    let failBeforeCommit = false;
    const database = new AppDatabase(':memory:', false, {
      transactionFaults: {
        beforeCommit: () => {
          if (failBeforeCommit) {
            failBeforeCommit = false;
            throw new Error('synthetic commit failure');
          }
        },
      },
    });
    databases.push(database);
    const tested = service(database);
    failBeforeCommit = true;

    await expect(tested.captureFeishuBotEvent(event('before-commit-failure'))).rejects.toThrow('synthetic commit failure');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE external_id = ?').get('before-commit-failure')).toEqual({ count: 0 });
  });

  it('returns the same durable receipt after a post-commit retry', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const tested = service(database);

    const first = await tested.captureFeishuBotEvent(event('post-commit-retry'));
    const second = await tested.captureFeishuBotEvent(event('post-commit-retry'));

    expect(first).toMatchObject({ externalId: 'post-commit-retry', deduplicated: false });
    expect(second).toMatchObject({ externalId: 'post-commit-retry', sourceEventId: first.sourceEventId, deduplicated: true });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE external_id = ?').get('post-commit-retry')).toEqual({ count: 1 });
  });

  it('rejects an owner history row colliding with a primary WebSocket event before any mutation or acknowledgement', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const tested = service(database);
    persistOnly(tested, event('namespace-owner-history', {
      sourceType: 'owner_dm',
      conversationId: 'owner-history-chat',
      metadata: { sourceScope: 'owner_dm', ownerScope: 'primary', historyRead: true },
    }));
    const before = database.raw.prepare('SELECT source_type, conversation_id, owner_scope, metadata_json, content FROM source_event WHERE external_id = ?').get('namespace-owner-history');

    await expect(tested.captureFeishuBotEvent(event('namespace-owner-history'))).rejects.toThrow('external_id');

    expect(database.raw.prepare('SELECT source_type, conversation_id, owner_scope, metadata_json, content FROM source_event WHERE external_id = ?').get('namespace-owner-history')).toEqual(before);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE external_id = ?').get('namespace-owner-history')).toEqual({ count: 1 });
  });

  it('rejects a foreign-owner row colliding with a primary WebSocket event before any mutation or acknowledgement', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const tested = service(database);
    persistOnly(tested, event('namespace-foreign-owner', {
      metadata: { sourceScope: 'bot_supplement', ownerScope: 'foreign-owner' },
    }));
    const before = database.raw.prepare('SELECT source_type, conversation_id, owner_scope, metadata_json, content FROM source_event WHERE external_id = ?').get('namespace-foreign-owner');

    await expect(tested.captureFeishuBotEvent(event('namespace-foreign-owner'))).rejects.toThrow('external_id');

    expect(database.raw.prepare('SELECT source_type, conversation_id, owner_scope, metadata_json, content FROM source_event WHERE external_id = ?').get('namespace-foreign-owner')).toEqual(before);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE external_id = ?').get('namespace-foreign-owner')).toEqual({ count: 1 });
  });

  it('preserves immutable WebSocket provenance while enriching a compatible duplicate', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const tested = service(database);
    const first = await tested.captureFeishuBotEvent(event('compatible-provenance'));
    const before = database.raw.prepare('SELECT source_type, conversation_id, owner_scope, metadata_json FROM source_event WHERE external_id = ?').get('compatible-provenance') as {
      source_type: string; conversation_id: string; owner_scope: string; metadata_json: string;
    };
    const second = await tested.captureFeishuBotEvent(event('compatible-provenance', {
      content: '更完整的授权消息正文。',
      completeness: 'complete',
      metadata: { sourceScope: 'bot_supplement', ownerScope: 'primary', messageType: 'text', sourceUpdatedAt: '2026-08-18T10:01:00.000Z' },
    }));
    const after = database.raw.prepare('SELECT source_type, conversation_id, owner_scope, metadata_json FROM source_event WHERE external_id = ?').get('compatible-provenance') as {
      source_type: string; conversation_id: string; owner_scope: string; metadata_json: string;
    };

    expect(second).toMatchObject({ sourceEventId: first.sourceEventId, deduplicated: true });
    expect(after.source_type).toBe(before.source_type);
    expect(after.conversation_id).toBe(before.conversation_id);
    expect(after.owner_scope).toBe('primary');
    expect(JSON.parse(after.metadata_json)).toMatchObject({ sourceScope: 'bot_supplement', ownerScope: 'primary' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE external_id = ?').get('compatible-provenance')).toEqual({ count: 1 });
  });

  it('serializes concurrent duplicate deliveries to one source row and one first receipt', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const tested = service(database);

    const receipts = await Promise.all(Array.from({ length: 8 }, () => tested.captureFeishuBotEvent(event('concurrent-duplicate'))));

    expect(new Set(receipts.map((receipt) => receipt.sourceEventId)).size).toBe(1);
    expect(receipts.filter((receipt) => !receipt.deduplicated)).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.deduplicated)).toHaveLength(7);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event WHERE external_id = ?').get('concurrent-duplicate')).toEqual({ count: 1 });
  });

  it('keeps out-of-order deliveries as separate durable facts ordered by occurred_at', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const tested = service(database);

    await tested.captureFeishuBotEvent(event('later-delivery', { occurredAt: '2026-08-18T10:02:00.000Z' }));
    await tested.captureFeishuBotEvent(event('earlier-delivery', { occurredAt: '2026-08-18T10:01:00.000Z' }));

    expect(database.raw.prepare(
      "SELECT external_id FROM source_event WHERE conversation_id = 'allowed-group' ORDER BY occurred_at, external_id",
    ).all()).toEqual([{ external_id: 'earlier-delivery' }, { external_id: 'later-delivery' }]);
  });

  it('recovers a committed source whose Runtime job was never created after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feishu-durable-ack-'));
    tempDirectories.push(directory);
    const databasePath = join(directory, 'recovery.sqlite');
    const firstDatabase = new AppDatabase(databasePath, false);
    const firstService = service(firstDatabase);
    const persisted = (firstService as unknown as { persistSourceEvent: (input: NormalizedSourceEvent) => { row: { id: string } } }).persistSourceEvent(event('orphan-after-restart'));
    firstDatabase.close();

    const secondDatabase = new AppDatabase(databasePath, false);
    databases.push(secondDatabase);
    const secondService = service(secondDatabase);
    await expect(secondService.resumeRuntimeJobs()).resolves.toMatchObject({ processed: 0 });

    expect(secondDatabase.raw.prepare('SELECT id FROM source_event WHERE external_id = ?').get('orphan-after-restart')).toEqual({ id: persisted.row.id });
    expect(secondDatabase.raw.prepare(
      `SELECT COUNT(*) AS count
       FROM job_source_link
       JOIN job ON job.id = job_source_link.job_id
       WHERE job_source_link.source_event_id = ?
         AND job.job_type = 'classify_source'
         AND job.status = 'completed'`,
    ).get(persisted.row.id)).toEqual({ count: 1 });
  });

  it('keeps a namespace collision fail-closed after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feishu-durable-collision-'));
    tempDirectories.push(directory);
    const databasePath = join(directory, 'collision.sqlite');
    const firstDatabase = new AppDatabase(databasePath, false);
    const firstService = service(firstDatabase);
    persistOnly(firstService, event('collision-after-restart', {
      sourceType: 'owner_dm',
      conversationId: 'owner-history-chat',
      metadata: { sourceScope: 'owner_dm', ownerScope: 'primary', historyRead: true },
    }));
    const before = firstDatabase.raw.prepare('SELECT source_type, conversation_id, owner_scope, metadata_json, content FROM source_event WHERE external_id = ?').get('collision-after-restart');
    firstDatabase.close();

    const secondDatabase = new AppDatabase(databasePath, false);
    databases.push(secondDatabase);
    const secondService = service(secondDatabase);
    await expect(secondService.captureFeishuBotEvent(event('collision-after-restart'))).rejects.toThrow('external_id');
    expect(secondDatabase.raw.prepare('SELECT source_type, conversation_id, owner_scope, metadata_json, content FROM source_event WHERE external_id = ?').get('collision-after-restart')).toEqual(before);
  });

  it('rejects foreign source/owner scope before any durable write', async () => {
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const tested = service(database);

    await expect(tested.captureFeishuBotEvent(event('foreign-scope', {
      metadata: { sourceScope: 'owner_messages', ownerScope: 'foreign-owner' },
    }))).rejects.toThrow('来源或主人范围不匹配');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });

    await expect(tested.captureFeishuBotEvent(event('foreign-group', { conversationId: 'not-allowed', ownerMentioned: false }))).rejects.toThrow('不属于已授权');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
  });
});
