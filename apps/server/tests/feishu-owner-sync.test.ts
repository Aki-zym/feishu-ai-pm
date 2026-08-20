import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { LiveFeishuAdapter } from '../src/integrations/feishu.js';
import { FeishuOwnerSyncRunner } from '../src/integrations/feishu-owner-sync.js';
import { RuleMockClassifier, timeRangeFromSource } from '../src/integrations/llm.js';
import { createAdapters } from '../src/integrations.js';
import { syncSourceOutcome } from '../src/observability.js';
import { PmService } from '../src/service.js';
import type { CandidateDraft } from '../src/domain.js';
import type { ClassificationResult } from '../src/integration-contracts.js';

type Page = { items?: unknown[]; p2p_chats?: unknown[]; has_more?: boolean; page_token?: string };

class ScriptedAdapter extends LiveFeishuAdapter {
  readonly chatCalls: Array<{ pageToken?: string; types?: string }> = [];
  readonly historyCalls: Array<{ chatId: string; startTime?: string; endTime?: string; pageToken?: string; sortType?: string; authMode?: string }> = [];
  readonly resolveCalls: string[][] = [];
  private readonly chatIndexes = new Map<string, number>();
  private readonly historyIndexes = new Map<string, number>();
  private resolutionIndex = 0;

  constructor(
    private readonly scripts: {
      histories?: Record<string, Array<Page | Error>>;
      chats?: Array<Page | Error>;
      chatsByType?: Partial<Record<'p2p' | 'group', Array<Page | Error>>>;
      resolutions?: Array<Page | Error>;
    },
    adapterConfig = config().feishu,
  ) {
    super(adapterConfig, { client: {} as never });
  }

  override async listMessages(input: Record<string, unknown> = {}): Promise<any> {
    const chatId = String(input.chatId ?? '');
    this.historyCalls.push({
      chatId,
      startTime: input.startTime ? String(input.startTime) : undefined,
      endTime: input.endTime ? String(input.endTime) : undefined,
      pageToken: input.pageToken ? String(input.pageToken) : undefined,
      sortType: input.sortType ? String(input.sortType) : undefined,
      authMode: input.authMode ? String(input.authMode) : undefined,
    });
    // Normal incremental reads and bounded background backfills use separate
    // Feishu pagination queries. Keep their scripted cursors independent so a
    // backfill cannot consume a later incremental page in the fake adapter.
    const historyKey = `${chatId}\u0000${String(input.sortType ?? 'unsorted')}`;
    const index = this.historyIndexes.get(historyKey) ?? 0;
    this.historyIndexes.set(historyKey, index + 1);
    const item = this.scripts.histories?.[chatId]?.[index] ?? { items: [], has_more: false };
    if (item instanceof Error) throw item;
    return item;
  }

  override async listOwnerChats(input: { types?: 'p2p' | 'group' | 'p2p,group'; pageToken?: string; pageSize?: number } = {}): Promise<any> {
    this.chatCalls.push({ pageToken: input.pageToken, types: input.types });
    const key = input.types ?? 'all';
    const index = this.chatIndexes.get(key) ?? 0;
    this.chatIndexes.set(key, index + 1);
    const script = input.types === 'p2p' || input.types === 'group' ? this.scripts.chatsByType?.[input.types] : this.scripts.chats;
    const item = script?.[index] ?? this.scripts.chats?.[index] ?? { items: [], has_more: false };
    if (item instanceof Error) throw item;
    return item;
  }

  override async resolveP2PChats(openIds: string[]): Promise<any> {
    this.resolveCalls.push(openIds);
    const item = this.scripts.resolutions?.[this.resolutionIndex++] ?? { p2p_chats: [] };
    if (item instanceof Error) throw item;
    return item;
  }
}

class CountingRuleClassifier extends RuleMockClassifier {
  readonly inputs: Array<{ content: string; classificationSources?: Array<{ content: string }> }> = [];

  override async classify(event: Parameters<RuleMockClassifier['classify']>[0], guidance?: string) {
    this.inputs.push({ content: event.content, classificationSources: event.classificationSources });
    return super.classify(event, guidance);
  }
}

/**
 * A deterministic stand-in for the model in a real alternating conversation.
 * It deliberately makes its decision from the bounded owner background and
 * the server-provided existing-task candidates, rather than from a synthetic
 * parentId on every message.
 */
class AlternatingConversationClassifier extends RuleMockClassifier {
  readonly inputs: Array<{
    content: string;
    conversationContext: string[];
    candidateCount: number;
  }> = [];

  override async classify(event: Parameters<RuleMockClassifier['classify']>[0], guidance?: string): Promise<ClassificationResult> {
    const context = (event.conversationContext ?? []).map((item) => item.content);
    this.inputs.push({
      content: event.content,
      conversationContext: context,
      candidateCount: event.classificationContext?.candidates.length ?? 0,
    });
    const result = await super.classify(event, guidance);
    if (!result.draft) {
      const draft: CandidateDraft = {
        title: '活动埋点需求',
        proposerName: event.senderName,
        background: '需要根据沟通内容完成活动埋点和数据验证。',
        validationQuestion: '活动数据是否满足需求方的验证目标？',
        describe: '完成活动埋点需求并对齐交付时间。',
        confidence: 0.97,
        analysis: {
          timeRange: timeRangeFromSource(event.content, event.occurredAt),
          fieldBasis: { background: 'fact', validationQuestion: 'inferred', describe: 'fact' },
          recognitionEvidence: ['完整交替对话中的需求来源被识别为同一任务。'],
        },
      };
      result.isDataRequest = true;
      result.draft = draft;
      result.outcome = 'valid';
    }
    const target = event.classificationContext?.candidates[0];
    if (!target || !result.draft?.analysis) return result;
    result.threadAssociation = {
      targetThreadId: target.threadId,
      targetTaskId: target.taskId,
      confidence: 0.99,
      scores: event.classificationContext!.candidates.map((candidate, index) => ({
        threadId: candidate.threadId,
        taskId: candidate.taskId,
        confidence: index === 0 ? 0.99 : 0.2,
      })),
      reason: '同一私聊、主人上下文和当前需求内容共同指向唯一任务。',
      evidence: ['同一私聊中的主人承接和时间确认与当前消息连续。'],
      candidateSetHash: event.classificationContext!.candidateSetHash,
      candidateSetComplete: event.classificationContext!.candidateSetComplete,
    };
    result.draft.analysis.threadAssociation = result.threadAssociation;
    if (context.some((item) => item.includes('我来做吧')) && context.some((item) => item.includes('策划案在哪'))) {
      result.draft.analysis.statusSuggestion = 'waiting';
      result.draft.analysis.waitingReasonSuggestion = '等待需求方提供策划案。';
      result.draft.analysis.nextStepSuggestion = '收到策划案后对齐具体需求。';
      result.draft.analysis.updateConfidence = 0.99;
    } else if (context.some((item) => item.includes('我来做吧')) && event.content.includes('下周一')) {
      result.draft.analysis.statusSuggestion = 'in_progress';
      result.draft.analysis.nextStepSuggestion = '先对齐具体需求并等待策划案。';
      result.draft.analysis.timeRange = timeRangeFromSource(event.content, event.occurredAt);
      result.draft.analysis.updateConfidence = 0.99;
    }
    return result;
  }
}

const fixedNow = new Date('2026-08-10T12:00:00.000Z');

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    FEISHU_EXTERNAL_ENABLED: 'true',
    FEISHU_APP_ID: 'test-app',
    FEISHU_APP_SECRET: 'test-secret',
    FEISHU_SCAN_ENABLED: 'true',
    FEISHU_SCAN_OVERLAP_SECONDS: '0',
    FEISHU_GROUP_IDS: 'group-chat',
    ...overrides,
  });
}

const OWNER_MESSAGE_SCOPES = [
  'im:chat:read',
  'im:message:readonly',
  'im:message.p2p_msg:get_as_user',
  'im:message.group_msg:get_as_user',
];

function seedOwner(
  database: AppDatabase,
  oauthStatus: 'authorized' | 'expired' | 'revoked' = 'authorized',
  grantedScopes: string[] = OWNER_MESSAGE_SCOPES,
) {
  const timestamp = fixedNow.toISOString();
  database.raw.prepare(
    `INSERT INTO owner_profile
      (id, open_id, union_id, user_id, name, tenant_key, oauth_status, granted_scopes_json, last_synced_at, created_at, updated_at)
     VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('owner-open', 'owner-union', 'owner-user', '系统主人', 'tenant-test', oauthStatus, JSON.stringify(grantedScopes), timestamp, timestamp, timestamp);
}

function message(messageId: string, options: { text?: string; mentioned?: boolean; senderId?: string; chatId?: string; createTime?: string; updateTime?: string; deleted?: boolean } = {}) {
  const text = options.text ?? '请分析活动留存数据。';
  return {
    message_id: messageId,
    chat_id: options.chatId ?? 'group-chat',
    chat_type: 'group',
    msg_type: 'text',
    create_time: options.createTime ?? '1786363200000',
    update_time: options.updateTime,
    deleted: options.deleted,
    sender: { id: options.senderId ?? 'requester-open', sender_name: options.senderId === 'owner-open' ? '系统主人' : '需求方' },
    mentions: options.mentioned ? [{ id: { open_id: 'owner-open' }, name: '系统主人' }] : [],
    body: { content: JSON.stringify({ text }) },
  };
}

function p2pMessage(messageId: string, options: { text?: string; senderId?: string; chatId?: string; createTime?: string } = {}) {
  const item = message(messageId, { ...options, chatId: options.chatId ?? 'p2p-chat' });
  return { ...item, chat_type: 'p2p', mentions: [] };
}

function seedTarget(database: AppDatabase, kind: 'person' | 'group', options: { id?: string; key?: string; chatId?: string | null; name?: string; enabled?: boolean } = {}) {
  const targetId = options.id ?? (kind === 'person' ? 'target-person' : 'target-group');
  const targetKey = options.key ?? (kind === 'person' ? 'requester-open' : 'group-chat');
  const chatId = options.chatId === undefined ? (kind === 'person' ? 'p2p-chat' : targetKey) : options.chatId;
  const timestamp = fixedNow.toISOString();
  database.raw.prepare(
    `INSERT INTO feishu_monitor_target
      (id, owner_open_id, target_kind, target_key, resolved_chat_id, display_name, secondary_label, enabled,
       read_policy, selection_source, access_status, last_discovered_at, last_resolved_at, last_success_at,
       last_error, metadata_json, created_at, updated_at)
     VALUES (?, 'owner-open', ?, ?, ?, ?, NULL, ?, ?, 'chat_list', ?, ?, ?, NULL, NULL, '{}', ?, ?)`,
  ).run(
    targetId,
    kind,
    targetKey,
    chatId,
    options.name ?? (kind === 'person' ? '需求方' : '需求群'),
    options.enabled === false ? 0 : 1,
    kind === 'person' ? 'incoming_only' : 'owner_mentions',
    chatId ? 'readable' : 'unknown',
    timestamp,
    chatId ? timestamp : null,
    timestamp,
    timestamp,
  );
  return targetId;
}

function seedCursor(database: AppDatabase, kind: 'owner_dm' | 'owner_mentions', targetId: string, watermark = '2026-08-10T11:00:00.000Z') {
  database.raw.prepare(
    `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
     VALUES ('feishu_owner', ?, ?, ?, NULL, ?)`,
  ).run(`messages:${kind}:${targetId}`, JSON.stringify({ version: 1, watermark, filterMode: kind === 'owner_dm' ? 'p2p_selected' : 'group_selected_mentions' }), fixedNow.toISOString(), fixedNow.toISOString());
}

function liveService(database: AppDatabase, adapter: ScriptedAdapter, liveConfig = config()) {
  return new PmService(database, { ...createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' })), feishu: adapter }, liveConfig);
}

describe('FeishuOwnerSyncRunner 主人个人信息流契约', () => {
  beforeEach(() => vi.useFakeTimers({ now: fixedNow }));
  afterEach(() => vi.useRealTimers());

  it('只读取主人明确选择的个人单聊，忽略主人自己发送的消息且不产生外发', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    seedTarget(database, 'person');
    const adapter = new ScriptedAdapter({
      chatsByType: { p2p: [{ items: [{ chat_id: 'p2p-chat', chat_mode: 'p2p', p2p_target_id: 'requester-open', name: '需求方' }], has_more: false }] },
      histories: { 'p2p-chat': [{ items: [p2pMessage('dm-1'), p2pMessage('dm-owner', { senderId: 'owner-open' })], has_more: false }] },
    });
    const service = liveService(database, adapter);

    const response = await service.syncFeishuSource('owner_dm');

    expect(response).toMatchObject({ outcome: 'success', messages: 2, failures: 0, sources: [{ source: 'owner_dm', status: 'success', counts: { messages: 2 } }] });
    expect(adapter.chatCalls).toEqual([{ pageToken: undefined, types: 'p2p' }]);
    expect(adapter.historyCalls.map((call) => call.chatId)).toEqual(['p2p-chat']);
    expect(database.raw.prepare('SELECT external_id, source_type, discovery_reason FROM source_event').all()).toEqual([
      { external_id: 'dm-1', source_type: 'owner_dm', discovery_reason: '系统自动发现的主人个人单聊中新收到的对方消息' },
      { external_id: 'dm-owner', source_type: 'owner_dm', discovery_reason: '为后续需求判断保留的系统主人对话背景' },
    ]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT status, requires_bot_in_chat FROM information_source_state WHERE source_kind = 'owner_dm'").get()).toEqual({ status: 'ready', requires_bot_in_chat: 0 });
    database.close();
  });

  it('自动发现的新 P2P 默认不启用，也不会在同轮读取消息', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const adapter = new ScriptedAdapter({
      chatsByType: { p2p: [{ items: [{ chat_id: 'p2p-new', chat_mode: 'p2p', p2p_target_id: 'person-new', name: '新需求方' }], has_more: false }] },
      histories: { 'p2p-new': [{ items: [p2pMessage('dm-new', { chatId: 'p2p-new', createTime: '1786363195000' })], has_more: false }] },
    });
    const service = liveService(database, adapter);

    const response = await service.syncFeishuSource('owner_dm');

    expect(response).toMatchObject({ outcome: 'success', failures: 0, sources: [{ source: 'owner_dm', counts: { newChats: 1 } }] });
    expect(database.raw.prepare("SELECT enabled, manual_excluded FROM feishu_monitor_target WHERE target_key = 'person-new'").get()).toEqual({ enabled: 0, manual_excluded: 0 });
    expect(database.raw.prepare("SELECT external_id FROM source_event WHERE external_id = 'dm-new'").get()).toBeUndefined();
    expect(adapter.historyCalls).toHaveLength(0);
    database.close();
  });

  it('长分页期间发现的新私聊仍保持默认关闭，不会读取正文', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    class SlowDiscoveryAdapter extends ScriptedAdapter {
      private calls = 0;
      override async listOwnerChats(input: { types?: 'p2p' | 'group' | 'p2p,group'; pageToken?: string; pageSize?: number } = {}) {
        const result = await super.listOwnerChats(input);
        this.calls += 1;
        if (this.calls === 1) vi.setSystemTime(new Date('2026-08-10T12:06:00.000Z'));
        return result;
      }
    }
    const adapter = new SlowDiscoveryAdapter({
      chatsByType: { p2p: [
        { items: [], has_more: true, page_token: 'p2' },
        { items: [], has_more: false },
        { items: [{ chat_id: 'p2p-during-scan', chat_mode: 'p2p', p2p_target_id: 'person-during-scan', name: '分页期间联系人' }], has_more: false },
      ] },
      histories: { 'p2p-during-scan': [{ items: [p2pMessage('dm-during-scan', { chatId: 'p2p-during-scan', createTime: '1786363320000' })], has_more: false }] },
    });
    const received: string[] = [];
    const runner = new FeishuOwnerSyncRunner(config().feishu, database, adapter, async (event) => { received.push(event.externalId); return {}; });

    await runner.runOnce('owner_dm');
    const discovery = database.raw.prepare("SELECT cursor, last_success_at FROM sync_cursor WHERE scope_key = 'discover:owner_dm:owner-open'").get() as { cursor: string; last_success_at: string };
    expect(discovery.last_success_at).toBe('2026-08-10T12:00:00.000Z');
    expect(JSON.parse(discovery.cursor)).toMatchObject({ scanStartedAt: '2026-08-10T12:00:00.000Z', completedAt: '2026-08-10T12:06:00.000Z' });

    vi.setSystemTime(new Date('2026-08-10T12:07:00.000Z'));
    await runner.runOnce('owner_dm');
    expect(received).toEqual([]);
    expect(adapter.historyCalls).toHaveLength(0);
    expect(database.raw.prepare("SELECT enabled FROM feishu_monitor_target WHERE target_key = 'person-during-scan'").get()).toEqual({ enabled: 0 });
    database.close();
  });

  it('重新启用人员后不补收硬起点之前的排除期消息', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const targetId = seedTarget(database, 'person', { enabled: false });
    database.raw.prepare('UPDATE feishu_monitor_target SET manual_excluded = 1 WHERE id = ?').run(targetId);
    seedCursor(database, 'owner_dm', targetId, '2026-08-10T10:00:00.000Z');
    const chatPage = { items: [{ chat_id: 'p2p-chat', chat_mode: 'p2p', p2p_target_id: 'requester-open', name: '需求方' }], has_more: false };
    const adapter = new ScriptedAdapter({
      chatsByType: { p2p: [chatPage, chatPage] },
      histories: { 'p2p-chat': [{ items: [
        p2pMessage('dm-before-reenable', { createTime: '1786363140000' }),
        p2pMessage('dm-after-reenable', { createTime: '1786363210000' }),
      ], has_more: false }] },
    });
    const service = liveService(database, adapter, config({ FEISHU_SCAN_OVERLAP_SECONDS: '300' }));
    service.updateFeishuMonitoringScope({ personChanges: [{ id: targetId, selected: true }], groupIds: [] });

    const deferred = await service.syncFeishuSource('owner_dm');
    expect(deferred).toMatchObject({ outcome: 'success', failures: 0 });
    expect(adapter.historyCalls).toHaveLength(0);

    vi.setSystemTime(new Date('2026-08-10T12:00:20.000Z'));
    const synchronized = await service.syncFeishuSource('owner_dm');
    expect(synchronized).toMatchObject({ outcome: 'success', failures: 0, messages: 1 });
    expect(database.raw.prepare('SELECT external_id FROM source_event ORDER BY external_id').all()).toEqual([{ external_id: 'dm-after-reenable' }]);
    const cursor = JSON.parse((database.raw.prepare("SELECT cursor FROM sync_cursor WHERE scope_key = ?").get(`messages:owner_dm:${targetId}`) as { cursor: string }).cursor);
    expect(cursor.hardStart).toBeUndefined();
    database.close();
  });

  it('关注超过 50 个私聊时兼顾近期会话与最久未扫描会话，并明确标记部分扫描', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const chats = Array.from({ length: 60 }, (_, index) => ({
      chat_id: `p2p-${index}`,
      chat_mode: 'p2p',
      p2p_target_id: `person-${index}`,
      name: `联系人${index}`,
    }));
    const page = { items: chats, has_more: false };
    const adapter = new ScriptedAdapter({ chatsByType: { p2p: [page, page, page] } });
    const service = liveService(database, adapter);

    await service.syncFeishuSource('owner_dm');
    expect(adapter.historyCalls).toHaveLength(0);
    const discovered = service.feishuMonitoringScope();
    service.updateFeishuMonitoringScope({ personChanges: discovered.people.map((item) => ({ id: item.id, selected: true })) });
    vi.setSystemTime(new Date(Date.now() + 20_000));
    await service.syncFeishuSource('owner_dm');
    expect(adapter.historyCalls).toHaveLength(50);
    expect(adapter.historyCalls.slice(0, 50).map((call) => call.chatId)).toEqual(chats.slice(0, 50).map((item) => item.chat_id));
    const firstState = database.raw.prepare("SELECT status, details_json FROM information_source_state WHERE source_kind = 'owner_dm'").get() as { status: string; details_json: string };
    expect(firstState.status).toBe('partial');
    expect(JSON.parse(firstState.details_json)).toMatchObject({ historyScanTruncated: true, scannedTargetCount: 50, selectedCount: 60, realTenantValidated: false });

    await service.syncFeishuSource('owner_dm');
    expect(adapter.historyCalls.slice(50).map((call) => call.chatId)).toEqual([
      ...chats.slice(0, 40).map((item) => item.chat_id),
      ...chats.slice(50, 60).map((item) => item.chat_id),
    ]);
    database.close();
  });

  it('没有 OAuth、授权过期或撤销时，@我 安全跳过且不读取群列表', async () => {
    for (const status of ['none', 'expired', 'revoked'] as const) {
      const database = new AppDatabase(':memory:', false);
      const adapter = new ScriptedAdapter({ chats: [{ items: [{ chat_id: 'group-chat' }], has_more: false }] });
      if (status !== 'none') seedOwner(database, status);
      const runner = new FeishuOwnerSyncRunner(config().feishu, database, adapter, async () => undefined);

      const result = await runner.runOnce('owner_mentions');

      expect(result).toMatchObject({ skipped: true, reason: 'owner_oauth_required' });
      expect(adapter.chatCalls).toHaveLength(0);
      expect(adapter.historyCalls).toHaveLength(0);
      database.close();
    }
  });

  it('跨分页收齐同一联系人连续消息后只提交一次耐久批次，并按时间稳定排序', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    seedTarget(database, 'person');
    seedCursor(database, 'owner_dm', 'target-person');
    const adapter = new ScriptedAdapter({
      chatsByType: { p2p: [{ items: [{ chat_id: 'p2p-chat', chat_mode: 'p2p', p2p_target_id: 'requester-open', name: '需求方' }], has_more: false }] },
      histories: { 'p2p-chat': [
        { items: [p2pMessage('dm-later', { createTime: '1786363020000', text: '另外补充付费维度。' })], has_more: true, page_token: 'p2' },
        { items: [p2pMessage('dm-first', { createTime: '1786362900000', text: '请分析活动留存数据。' })], has_more: false },
      ] },
    });
    const batches: string[][] = [];
    const runner = new FeishuOwnerSyncRunner(
      config().feishu,
      database,
      adapter,
      async () => { throw new Error('有 batch handler 时不应走单条入口。'); },
      undefined,
      async () => undefined,
      async (events) => {
        batches.push(events.map((event) => event.externalId));
        return { deduplicated: 0 };
      },
    );

    const result = await runner.runOnce('owner_dm');

    expect(result).toMatchObject({ failures: 0, messages: 2, owner: { dm: 2 } });
    expect(batches).toEqual([['dm-first', 'dm-later']]);
    expect(adapter.historyCalls).toHaveLength(2);
    database.close();
  });

  it('完整交替对话会把主人承接、截止时间和等待资料纳入同一任务维护链', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    seedTarget(database, 'person');
    const classifier = new AlternatingConversationClassifier();
    const liveConfig = config();
    const adapter = new ScriptedAdapter({
      chatsByType: { p2p: [{ items: [{ chat_id: 'p2p-chat', chat_mode: 'p2p', p2p_target_id: 'requester-open', name: '需求方' }], has_more: false }] },
      histories: {
        'p2p-chat': [
          { items: [p2pMessage('dialog-1', { text: '想做一个活动埋点需求，先看下数据效果。', senderId: 'requester-open', createTime: '1786362900000' })], has_more: false },
          { items: [p2pMessage('dialog-2', { text: '算了，我来做吧。这个任务什么时候要？', senderId: 'owner-open', createTime: '1786362960000' })], has_more: false },
          { items: [p2pMessage('dialog-3', { text: '希望下周一能给到吗？', senderId: 'requester-open', createTime: '1786363020000' })], has_more: false },
          { items: [p2pMessage('dialog-4', { text: '可以的，我们后面先对一下具体需求。策划案在哪？', senderId: 'owner-open', createTime: '1786363080000' })], has_more: false },
          { items: [p2pMessage('dialog-5', { text: '一会儿给我。', senderId: 'requester-open', createTime: '1786363140000' })], has_more: false },
        ],
      },
    }, liveConfig.feishu);
    const adapters = createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' }));
    const service = new PmService(database, { ...adapters, feishu: adapter, classifier }, liveConfig);

    const sync = async () => service.syncFeishuSource('owner_dm');
    const firstSync = await sync();
    expect(firstSync).toMatchObject({ outcome: 'success', failures: 0, messages: 1 });
    const firstCandidate = database.raw.prepare('SELECT id FROM candidate_request LIMIT 1').get() as { id: string };
    const accepted = service.actOnCandidate(firstCandidate.id, 'accept', undefined, service.getCandidate(firstCandidate.id)!.version);
    expect(accepted.task).toBeTruthy();
    await sync(); // 主人承接：先作为背景保存
    expect(service.getTask(accepted.task!.id)).toMatchObject({ status: 'unplanned', planned_due_at: null });
    const deadlineSync = await sync(); // 需求方给出截止时间：触发第一次维护
    expect(deadlineSync).toMatchObject({ outcome: 'success', failures: 0, messages: 1 });
    expect(service.getTask(accepted.task!.id)).toMatchObject({
      status: 'in_progress',
      planned_due_at: '2026-08-17T15:59:59.999Z',
    });
    await sync(); // 主人询问策划案：作为背景保存
    expect(service.getTask(accepted.task!.id)).toMatchObject({ status: 'in_progress' });
    const materialSync = await sync(); // 需求方承诺补资料：触发第二次维护
    expect(materialSync).toMatchObject({ outcome: 'success', failures: 0, messages: 1 });
    const sources = database.raw.prepare(
      "SELECT external_id, sender_id, content FROM source_event WHERE conversation_id = 'p2p-chat' ORDER BY occurred_at",
    ).all() as Array<{ external_id: string; sender_id: string; content: string }>;
    expect(sources.map((row) => row.external_id)).toEqual(['dialog-1', 'dialog-2', 'dialog-3', 'dialog-4', 'dialog-5']);
    expect(sources.filter((row) => row.sender_id === 'owner-open')).toHaveLength(2);
    expect(database.raw.prepare('SELECT COUNT(DISTINCT accepted_task_id) AS tasks FROM candidate_request WHERE state = \'accepted\'').get()).toEqual({ tasks: 1 });
    expect(classifier.inputs.some((input) => input.conversationContext.includes('算了，我来做吧。这个任务什么时候要？'))).toBe(true);
    expect(classifier.inputs.some((input) => input.conversationContext.includes('可以的，我们后面先对一下具体需求。策划案在哪？'))).toBe(true);
    expect(service.getTask(accepted.task!.id)).toMatchObject({
      status: 'waiting',
      planned_due_at: expect.any(String),
      waiting_reason: '等待需求方提供策划案。',
      next_step: '收到策划案后对齐具体需求。',
    });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM task_event WHERE task_id = ? AND event_type = 'task_auto_updated'").get(accepted.task!.id)).toEqual({ count: 2 });
  });

  it('疑似补充消息只在已启用会话内有界向前补扫，且不推进正常同步游标', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const targetId = seedTarget(database, 'person');
    seedCursor(database, 'owner_dm', targetId, '2026-08-10T11:00:00.000Z');
    const cursorBefore = database.raw.prepare('SELECT cursor, last_success_at FROM sync_cursor WHERE scope_key = ?').get(`messages:owner_dm:${targetId}`);
    const adapter = new ScriptedAdapter({
      histories: { 'p2p-chat': [
        { items: [p2pMessage('backfill-second', { createTime: '1786362960000', text: '需要按区服拆分。' })], has_more: true, page_token: 'p2' },
        { items: [p2pMessage('backfill-first', { createTime: '1786362900000', text: '请做海外大客户 ID 看板。' })], has_more: false },
      ] },
    });
    const runner = new FeishuOwnerSyncRunner(config().feishu, database, adapter, async () => undefined);

    const result = await runner.backfillBeforeSource({
      sourceEventId: 'src-trigger',
      sourceExternalId: 'backfill-trigger',
      conversationId: 'p2p-chat',
      sourceType: 'owner_dm',
      occurredAt: '2026-08-10T12:00:00.000Z',
      monitorTargetId: targetId,
    });

    expect(result).toMatchObject({ complete: true, truncated: false, pages: 2, reason: null });
    expect(result.events.map((event) => event.externalId)).toEqual(['backfill-first', 'backfill-second']);
    expect(result.events.every((event) => event.metadata?.historyBackfill === true)).toBe(true);
    expect(adapter.historyCalls.map((call) => ({ pageToken: call.pageToken, sortType: call.sortType, authMode: call.authMode }))).toEqual([
      { pageToken: undefined, sortType: 'desc', authMode: 'owner' },
      { pageToken: 'p2', sortType: 'desc', authMode: 'owner' },
    ]);
    expect(database.raw.prepare('SELECT cursor, last_success_at FROM sync_cursor WHERE scope_key = ?').get(`messages:owner_dm:${targetId}`)).toEqual(cursorBefore);
    database.close();
  });

  it('历史补扫达到三页上限或硬起点时返回背景不完整，并仍不推进游标', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const targetId = seedTarget(database, 'person');
    const hardStart = '2026-08-10T11:30:00.000Z';
    const cursorKey = `messages:owner_dm:${targetId}`;
    database.raw.prepare(
      `INSERT INTO sync_cursor (integration, scope_key, cursor, last_success_at, last_error, updated_at)
       VALUES ('feishu_owner', ?, ?, ?, NULL, ?)`,
    ).run(cursorKey, JSON.stringify({ version: 1, watermark: hardStart, filterMode: 'p2p_selected', hardStart }), fixedNow.toISOString(), fixedNow.toISOString());
    const cursorBefore = database.raw.prepare('SELECT cursor, last_success_at FROM sync_cursor WHERE scope_key = ?').get(cursorKey);
    const adapter = new ScriptedAdapter({ histories: { 'p2p-chat': [
      { items: [p2pMessage('backfill-page-1')], has_more: true, page_token: 'p2' },
      { items: [p2pMessage('backfill-page-2')], has_more: true, page_token: 'p3' },
      { items: [p2pMessage('backfill-page-3')], has_more: true, page_token: 'p4' },
    ] } });
    const runner = new FeishuOwnerSyncRunner(config().feishu, database, adapter, async () => undefined);

    const result = await runner.backfillBeforeSource({
      sourceEventId: 'src-trigger',
      sourceExternalId: 'backfill-trigger',
      conversationId: 'p2p-chat',
      sourceType: 'owner_dm',
      occurredAt: '2026-08-10T12:00:00.000Z',
      monitorTargetId: targetId,
    });

    expect(result).toMatchObject({ complete: false, truncated: true, pages: 3 });
    expect(result.reason).toContain('安全上限');
    expect(adapter.historyCalls).toHaveLength(3);
    expect(database.raw.prepare('SELECT cursor, last_success_at FROM sync_cursor WHERE scope_key = ?').get(cursorKey)).toEqual(cursorBefore);
    database.close();
  });

  it('批量 ingest 会把补扫后的可分类来源合入同一分类输入，并按来源去重', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const targetId = seedTarget(database, 'person');
    seedCursor(database, 'owner_dm', targetId);
    const adapter = new ScriptedAdapter({
      histories: {
        'p2p-chat': [{
          items: [p2pMessage('backfill-batch-source', { createTime: '1786363140000', text: '请分析活动留存数据。' })],
          has_more: false,
        }],
      },
    });
    const classifier = new CountingRuleClassifier();
    const localConfig = config();
    const base = createAdapters(loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' }));
    const service = new PmService(database, { ...base, feishu: adapter, classifier }, localConfig);

    const result = await service.ingestSourceBatch([{
      externalId: 'batch-backfill-trigger',
      sourceType: 'owner_dm',
      conversationId: 'p2p-chat',
      senderId: 'requester-open',
      senderName: '需求方',
      content: '补充：还需要按区服拆分。',
      occurredAt: fixedNow.toISOString(),
      metadata: { monitorTargetId: targetId },
    }]);

    expect(result).toMatchObject({ messages: 1, deduplicated: 0, classifications: 1, classificationFailures: 0 });
    expect(classifier.inputs).toHaveLength(1);
    expect(classifier.inputs[0]?.classificationSources?.map((source) => source.content)).toEqual([
      '请分析活动留存数据。',
      '补充：还需要按区服拆分。',
    ]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 2 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual({ count: 1 });
    database.close();
  });

  it('缺少来源所需 scope 时不调用飞书 API、不推进游标，并独立标记来源受限', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database, 'authorized', ['offline_access', 'im:chat:read', 'im:message:readonly']);
    const personId = seedTarget(database, 'person');
    const groupId = seedTarget(database, 'group');
    seedCursor(database, 'owner_dm', personId);
    seedCursor(database, 'owner_mentions', groupId);
    const adapter = new ScriptedAdapter({
      chatsByType: {
        p2p: [{ items: [{ chat_id: 'should-not-read', p2p_target_id: 'requester-open' }], has_more: false }],
        group: [{ items: [{ chat_id: 'should-not-read-group' }], has_more: false }],
      },
      histories: {
        'p2p-chat': [{ items: [p2pMessage('should-not-read-message')], has_more: false }],
        'group-chat': [{ items: [message('should-not-read-mention', { mentioned: true })], has_more: false }],
      },
    });
    const service = liveService(database, adapter);

    const dm = await service.syncFeishuSource('owner_dm');
    expect(dm).toMatchObject({ outcome: 'skipped', skipped: true, failures: 0, messages: 0, sources: [{ error_code: 'FEISHU_SCOPE_REQUIRED' }] });
    expect(adapter.chatCalls).toHaveLength(0);
    expect(adapter.historyCalls).toHaveLength(0);
    expect(database.raw.prepare('SELECT cursor, last_success_at FROM sync_cursor WHERE scope_key = ?').get(`messages:owner_dm:${personId}`)).toMatchObject({
      cursor: expect.any(String),
      last_success_at: fixedNow.toISOString(),
    });
    expect(database.raw.prepare("SELECT status, last_error FROM information_source_state WHERE source_kind = 'owner_dm'").get()).toMatchObject({
      status: 'admin_required',
      last_error: expect.stringContaining('im:message.p2p_msg:get_as_user'),
    });
    expect(database.raw.prepare('SELECT access_status, last_error FROM feishu_monitor_target WHERE id = ?').get(personId)).toMatchObject({
      access_status: 'restricted',
      last_error: expect.stringContaining('im:message.p2p_msg:get_as_user'),
    });

    const mentions = await service.syncFeishuSource('owner_mentions');
    expect(mentions).toMatchObject({ outcome: 'skipped', skipped: true, failures: 0, messages: 0, sources: [{ error_code: 'FEISHU_SCOPE_REQUIRED' }] });
    expect(adapter.chatCalls).toHaveLength(0);
    expect(adapter.historyCalls).toHaveLength(0);
    expect(database.raw.prepare("SELECT status, last_error FROM information_source_state WHERE source_kind = 'owner_mentions'").get()).toMatchObject({
      status: 'admin_required',
      last_error: expect.stringContaining('im:message.group_msg:get_as_user'),
    });
    expect(database.raw.prepare('SELECT access_status FROM feishu_monitor_target WHERE id = ?').get(groupId)).toEqual({ access_status: 'restricted' });
    database.close();
  });

  it('只有一个主人来源缺 scope 时聚合结果为真实 partial，不生成矛盾 skip reason', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database, 'authorized', [
      'im:chat:read',
      'im:message:readonly',
      'im:message.p2p_msg:get_as_user',
    ]);
    seedTarget(database, 'person');
    seedTarget(database, 'group');
    const adapter = new ScriptedAdapter({
      chatsByType: { p2p: [{ items: [{ chat_id: 'p2p-chat', chat_mode: 'p2p', p2p_target_id: 'requester-open', name: '需求方' }], has_more: false }] },
      histories: { 'p2p-chat': [{ items: [p2pMessage('dm-partial')], has_more: false }] },
    });
    const result = await new FeishuOwnerSyncRunner(config().feishu, database, adapter, async () => ({})).runOnce();

    expect(result).toMatchObject({ messages: 1, failures: 1, skipped: false, reason: 'sync_failed' });
    expect(syncSourceOutcome('owner_messages', result, 1)).toMatchObject({
      status: 'partial_success',
      counts: { messages: 1, failures: 1 },
      error_code: 'FEISHU_SYNC_PARTIAL',
    });
    database.close();
  });

  it('只读取数据库中明确选择的群，并仅持久化真正 @主人的消息', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    seedTarget(database, 'group');
    const liveConfig = config({ FEISHU_GROUP_IDS: 'group-other' });
    const adapter = new ScriptedAdapter({
      chatsByType: { group: [
        { items: [{ chat_id: 'group-chat', name: '需求群' }], has_more: true, page_token: 'chat-p2' },
        { items: [{ chat_id: 'group-other', name: '机器人补充群' }], has_more: false },
      ] },
      histories: {
        'group-chat': [
          { items: [message('plain'), message('mentioned-1', { mentioned: true }), message('owner-message', { mentioned: true, senderId: 'owner-open' })], has_more: true, page_token: 'message-p2' },
          { items: [message('mentioned-1', { mentioned: true }), message('mentioned-2', { mentioned: true })], has_more: false },
        ],
        'group-other': [{ items: [message('must-not-read', { mentioned: true, chatId: 'group-other' })], has_more: false }],
      },
    }, liveConfig.feishu);
    const service = liveService(database, adapter, liveConfig);

    const response = await service.syncFeishuSource('owner_mentions');

    expect(response).toMatchObject({ outcome: 'success', messages: 3, failures: 0, sources: [{ source: 'owner_mentions', counts: { messages: 3, newChats: 1 } }] });
    expect(adapter.chatCalls).toEqual([{ pageToken: undefined, types: 'group' }, { pageToken: 'chat-p2', types: 'group' }]);
    expect(adapter.historyCalls.map((call) => ({ chatId: call.chatId, pageToken: call.pageToken, sortType: call.sortType, authMode: call.authMode }))).toEqual([
      { chatId: 'group-chat', pageToken: undefined, sortType: 'asc', authMode: 'owner' },
      { chatId: 'group-chat', pageToken: 'message-p2', sortType: 'asc', authMode: 'owner' },
    ]);
    expect(database.raw.prepare('SELECT external_id, owner_mentioned, discovery_reason FROM source_event ORDER BY external_id').all()).toEqual([
      { external_id: 'mentioned-1', owner_mentioned: 1, discovery_reason: '系统主人明确选择的群聊中提及系统主人' },
      { external_id: 'mentioned-2', owner_mentioned: 1, discovery_reason: '系统主人明确选择的群聊中提及系统主人' },
      { external_id: 'owner-message', owner_mentioned: 1, discovery_reason: '为后续需求判断保留的系统主人对话背景' },
    ]);
    const details = JSON.parse((database.raw.prepare("SELECT details_json FROM information_source_state WHERE source_kind = 'owner_mentions'").get() as { details_json: string }).details_json);
    expect(details).toMatchObject({ discoveredCount: 2, selectedCount: 1, messages: 3, failures: 0 });
    expect(adapter.historyCalls.some((call) => call.chatId === 'group-other')).toBe(false);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 });
    database.close();
  });

  it('未选择群时只做群发现，新群默认不启用且不读取正文', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const liveConfig = config();
    const adapter = new ScriptedAdapter({ chatsByType: { group: [{ items: [{ chat_id: 'group-chat', name: '新群' }], has_more: false }] } }, liveConfig.feishu);
    const service = liveService(database, adapter, liveConfig);

    const response = await service.syncFeishuSource('owner_mentions');

    expect(response).toMatchObject({ outcome: 'success', failures: 0, sources: [{ source: 'owner_mentions', status: 'success', counts: { newChats: 1 } }] });
    expect(adapter.historyCalls).toHaveLength(0);
    expect(database.raw.prepare("SELECT target_kind, enabled FROM feishu_monitor_target WHERE target_key = 'group-chat'").get()).toEqual({ target_kind: 'group', enabled: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM sync_cursor WHERE scope_key LIKE 'messages:owner_mentions:%'").get()).toEqual({ count: 0 });
    const state = database.raw.prepare("SELECT status, last_error, details_json FROM information_source_state WHERE source_kind = 'owner_mentions'").get() as { status: string; last_error: string | null; details_json: string };
    expect(state.status).toBe('partial');
    expect(state.last_error).toBeNull();
    expect(JSON.parse(state.details_json)).toMatchObject({ selectedCount: 0, discoveredCount: 1, newDiscoveredCount: 1 });
    database.close();
  });

  it('第二页失败时保留原游标，已落库来源不丢失且错误可重试', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const targetId = seedTarget(database, 'group');
    seedCursor(database, 'owner_mentions', targetId);
    const cursorKey = `messages:owner_mentions:${targetId}`;
    const before = database.raw.prepare('SELECT cursor, last_success_at FROM sync_cursor WHERE scope_key = ?').get(cursorKey) as { cursor: string; last_success_at: string };
    const adapter = new ScriptedAdapter({
      chatsByType: { group: [{ items: [{ chat_id: 'group-chat' }], has_more: false }] },
      histories: { 'group-chat': [
        { items: [message('mentioned-1', { mentioned: true })], has_more: true, page_token: 'p2' },
        new Error('429 rate limited'), new Error('429 rate limited'), new Error('429 rate limited'),
      ] },
    });
    const classified: string[] = [];
    const captured: string[] = [];
    const runner = new FeishuOwnerSyncRunner(
      config().feishu,
      database,
      adapter,
      async (event) => { classified.push(event.externalId); return {}; },
      undefined,
      async () => undefined,
      async (events) => { classified.push(...events.map((event) => event.externalId)); return {}; },
      async (events) => { captured.push(...events.map((event) => event.externalId)); return {}; },
    );

    const result = await runner.runOnce('owner_mentions');

    expect(result.failures).toBe(1);
    expect(captured).toEqual(['mentioned-1']);
    expect(classified).toEqual([]);
    const after = database.raw.prepare('SELECT cursor, last_success_at, last_error FROM sync_cursor WHERE scope_key = ?').get(cursorKey) as { cursor: string; last_success_at: string; last_error: string };
    expect(after.cursor).toBe(before.cursor);
    expect(after.last_success_at).toBe(before.last_success_at);
    expect(after.last_error).toContain('429');
    database.close();
  });

  it('ingest 失败时不推进游标，重叠窗口可再次处理同一 message_id', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const targetId = seedTarget(database, 'group');
    seedCursor(database, 'owner_mentions', targetId);
    const cursorKey = `messages:owner_mentions:${targetId}`;
    const oldCursor = (database.raw.prepare('SELECT cursor FROM sync_cursor WHERE scope_key = ?').get(cursorKey) as { cursor: string }).cursor;
    const adapter = new ScriptedAdapter({
      chatsByType: { group: [{ items: [{ chat_id: 'group-chat' }], has_more: false }] },
      histories: { 'group-chat': [{ items: [message('m1', { mentioned: true }), message('m2', { mentioned: true })], has_more: false }] },
    });
    const runner = new FeishuOwnerSyncRunner(config().feishu, database, adapter, async (event) => {
      if (event.externalId === 'm2') throw new Error('主链暂时不可用');
      return {};
    });

    const result = await runner.runOnce('owner_mentions');

    expect(result.failures).toBe(1);
    expect((database.raw.prepare('SELECT cursor FROM sync_cursor WHERE scope_key = ?').get(cursorKey) as { cursor: string }).cursor).toBe(oldCursor);
    database.close();
  });

  it('官方限流码重试成功后只处理一次，并保存所选群独立游标', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const targetId = seedTarget(database, 'group');
    const limited = Object.assign(new Error('FEISHU_99991400: request trigger frequency limit'), { code: 99991400 });
    const adapter = new ScriptedAdapter({
      chatsByType: { group: [{ items: [{ chat_id: 'group-chat' }], has_more: false }] },
      histories: { 'group-chat': [limited, { items: [message('m-retry', { mentioned: true })], has_more: false }] },
    });
    const received: string[] = [];
    const runner = new FeishuOwnerSyncRunner(config().feishu, database, adapter, async (event) => { received.push(event.externalId); return {}; }, undefined, async () => undefined);

    const result = await runner.runOnce('owner_mentions');

    expect(result.failures).toBe(0);
    expect(received).toEqual(['m-retry']);
    expect(adapter.historyCalls).toHaveLength(2);
    const cursor = JSON.parse((database.raw.prepare('SELECT cursor FROM sync_cursor WHERE scope_key = ?').get(`messages:owner_mentions:${targetId}`) as { cursor: string }).cursor);
    expect(cursor.filterMode).toBe('group_selected_mentions');
    database.close();
  });

  it('真实网络错误按统一重试策略处理：成功只 ingest 一次，耗尽则保留旧游标', async () => {
    const successDatabase = new AppDatabase(':memory:', false);
    seedOwner(successDatabase);
    const successTargetId = seedTarget(successDatabase, 'group');
    seedCursor(successDatabase, 'owner_mentions', successTargetId);
    const transportError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const successAdapter = new ScriptedAdapter({
      chatsByType: { group: [{ items: [{ chat_id: 'group-chat' }], has_more: false }] },
      histories: { 'group-chat': [transportError, { items: [message('m-transport-retry', { mentioned: true })], has_more: false }] },
    });
    const received: string[] = [];
    const successRunner = new FeishuOwnerSyncRunner(
      config().feishu,
      successDatabase,
      successAdapter,
      async (event) => { received.push(event.externalId); return {}; },
      undefined,
      async () => undefined,
    );

    const success = await successRunner.runOnce('owner_mentions');

    expect(success.failures).toBe(0);
    expect(received).toEqual(['m-transport-retry']);
    expect(successAdapter.historyCalls).toHaveLength(2);
    expect(JSON.parse((successDatabase.raw.prepare('SELECT cursor FROM sync_cursor WHERE scope_key = ?').get(`messages:owner_mentions:${successTargetId}`) as { cursor: string }).cursor)).toMatchObject({ filterMode: 'group_selected_mentions' });
    successDatabase.close();

    const failureDatabase = new AppDatabase(':memory:', false);
    seedOwner(failureDatabase);
    const failureTargetId = seedTarget(failureDatabase, 'group');
    seedCursor(failureDatabase, 'owner_mentions', failureTargetId);
    const before = failureDatabase.raw.prepare('SELECT cursor, last_success_at FROM sync_cursor WHERE scope_key = ?').get(`messages:owner_mentions:${failureTargetId}`) as { cursor: string; last_success_at: string | null };
    const failureAdapter = new ScriptedAdapter({
      chatsByType: { group: [{ items: [{ chat_id: 'group-chat' }], has_more: false }] },
      histories: { 'group-chat': [
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      ] },
    });
    const failureRunner = new FeishuOwnerSyncRunner(config().feishu, failureDatabase, failureAdapter, async () => ({}), undefined, async () => undefined);

    const failure = await failureRunner.runOnce('owner_mentions');

    expect(failure.failures).toBeGreaterThan(0);
    expect(failureAdapter.historyCalls).toHaveLength(3);
    const after = failureDatabase.raw.prepare('SELECT cursor, last_success_at FROM sync_cursor WHERE scope_key = ?').get(`messages:owner_mentions:${failureTargetId}`) as { cursor: string; last_success_at: string | null };
    expect(after.cursor).toBe(before.cursor);
    expect(after.last_success_at).toBe(before.last_success_at);
    failureDatabase.close();
  });

  it('首次读取失败会固定起始水位，跨过初始回看期后仍从原处重试', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const targetId = seedTarget(database, 'group');
    const firstAdapter = new ScriptedAdapter({
      chatsByType: { group: [{ items: [{ chat_id: 'group-chat' }], has_more: false }] },
      histories: { 'group-chat': [new Error('network failed'), new Error('network failed'), new Error('network failed')] },
    });
    await new FeishuOwnerSyncRunner(config().feishu, database, firstAdapter, async () => ({}), undefined, async () => undefined).runOnce('owner_mentions');
    const saved = database.raw.prepare('SELECT cursor, last_success_at FROM sync_cursor WHERE scope_key = ?').get(`messages:owner_mentions:${targetId}`) as { cursor: string; last_success_at: string | null };
    const originalWatermark = (JSON.parse(saved.cursor) as { watermark: string }).watermark;
    expect(saved.last_success_at).toBeNull();

    vi.setSystemTime(new Date('2026-08-12T12:00:00.000Z'));
    const secondAdapter = new ScriptedAdapter({
      chatsByType: { group: [{ items: [{ chat_id: 'group-chat' }], has_more: false }] },
      histories: { 'group-chat': [{ items: [], has_more: false }] },
    });
    await new FeishuOwnerSyncRunner(config().feishu, database, secondAdapter, async () => ({})).runOnce('owner_mentions');
    expect(Number(secondAdapter.historyCalls[0]?.startTime)).toBe(Math.floor(Date.parse(originalWatermark) / 1000));
    database.close();
  });

  it('首次 P2P 解析失败也会先固定水位，恢复后不会从新的 24 小时窗口起算', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const targetId = seedTarget(database, 'person', { chatId: null });
    const firstAdapter = new ScriptedAdapter({
      chatsByType: { p2p: [{ items: [], has_more: false }] },
      resolutions: [Object.assign(new Error('permission denied'), { code: 403 })],
    });
    await new FeishuOwnerSyncRunner(config().feishu, database, firstAdapter, async () => ({})).runOnce('owner_dm');
    const saved = database.raw.prepare('SELECT cursor, last_success_at FROM sync_cursor WHERE scope_key = ?').get(`messages:owner_dm:${targetId}`) as { cursor: string; last_success_at: string | null };
    const originalWatermark = (JSON.parse(saved.cursor) as { watermark: string }).watermark;
    expect(saved.last_success_at).toBeNull();

    vi.setSystemTime(new Date('2026-08-12T12:00:00.000Z'));
    database.raw.prepare("UPDATE feishu_monitor_target SET access_status = 'unknown', last_error = NULL WHERE id = ?").run(targetId);
    const secondAdapter = new ScriptedAdapter({
      chatsByType: { p2p: [{ items: [], has_more: false }] },
      resolutions: [{ p2p_chats: [{ chat_id: 'resolved-p2p' }] }],
      histories: { 'resolved-p2p': [{ items: [], has_more: false }] },
    });
    await new FeishuOwnerSyncRunner(config().feishu, database, secondAdapter, async () => ({})).runOnce('owner_dm');

    expect(Number(secondAdapter.historyCalls[0]?.startTime)).toBe(Math.floor(Date.parse(originalWatermark) / 1000));
    database.close();
  });

  it('消息页在途时取消选择会安全中止，不落库也不推进游标', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const targetId = seedTarget(database, 'group');
    let releasePage!: () => void;
    let markPageStarted!: () => void;
    const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
    const pageStarted = new Promise<void>((resolve) => { markPageStarted = resolve; });
    class BlockingAdapter extends ScriptedAdapter {
      override async listMessages(input: Record<string, unknown> = {}) {
        markPageStarted();
        await pageGate;
        return super.listMessages(input);
      }
    }
    const adapter = new BlockingAdapter({
      chatsByType: { group: [{ items: [{ chat_id: 'group-chat' }], has_more: false }] },
      histories: { 'group-chat': [{ items: [message('must-not-ingest', { mentioned: true })], has_more: false }] },
    });
    const received: string[] = [];
    const service = liveService(database, adapter);

    const running = service.syncFeishuSource('owner_mentions');
    await pageStarted;
    database.raw.prepare('UPDATE feishu_monitor_target SET enabled = 0, selection_version = selection_version + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), targetId);
    releasePage();
    const result = await running;

    expect(result.failures).toBe(0);
    expect(received).toEqual([]);
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 0 });
    const cursor = database.raw.prepare('SELECT last_success_at, last_error FROM sync_cursor WHERE scope_key = ?').get(`messages:owner_mentions:${targetId}`) as { last_success_at: string | null; last_error: string | null };
    expect(cursor).toEqual({ last_success_at: null, last_error: null });
    expect(database.raw.prepare('SELECT last_success_at, last_error FROM feishu_monitor_target WHERE id = ?').get(targetId)).toEqual({ last_success_at: null, last_error: null });
    const sourceState = database.raw.prepare("SELECT status, last_success_at, details_json FROM information_source_state WHERE source_kind = 'owner_mentions'").get() as { status: string; last_success_at: string | null; details_json: string };
    expect(sourceState.status).toBe('partial');
    expect(sourceState.last_success_at).toBeNull();
    expect(JSON.parse(sourceState.details_json)).toMatchObject({ canceledTargets: 1 });
    database.close();
  });

  it('会话发现页在途时主人授权变化会丢弃旧列表且不重建发现游标', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    let releasePage!: () => void;
    let markPageStarted!: () => void;
    const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
    const pageStarted = new Promise<void>((resolve) => { markPageStarted = resolve; });
    class BlockingDiscoveryAdapter extends ScriptedAdapter {
      override async listOwnerChats(input: { types?: 'p2p' | 'group' | 'p2p,group'; pageToken?: string; pageSize?: number } = {}) {
        markPageStarted();
        await pageGate;
        return super.listOwnerChats(input);
      }
    }
    const adapter = new BlockingDiscoveryAdapter({
      chatsByType: { group: [{ items: [{ chat_id: 'group-late', name: '旧主人群' }], has_more: false }] },
    });
    const runner = new FeishuOwnerSyncRunner(config().feishu, database, adapter, async () => ({}));

    const running = runner.runOnce('owner_mentions');
    await pageStarted;
    database.raw.prepare("UPDATE owner_profile SET oauth_status = 'unknown', updated_at = ? WHERE id = 'primary'").run(new Date().toISOString());
    releasePage();
    const result = await running;

    expect(result).toMatchObject({ failures: 0, messages: 0, newChats: 0 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM feishu_monitor_target').get()).toEqual({ count: 0 });
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM sync_cursor WHERE integration = 'feishu_owner' AND scope_key LIKE 'discover:%'").get()).toEqual({ count: 0 });
    database.close();
  });

  it('明确的用户授权失效会更新主人状态，临时网络错误不会', async () => {
    for (const scenario of [
      { errors: [Object.assign(new Error('FEISHU_99991663: user access token expired'), { code: 99991663 })], expected: 'expired' },
      { errors: [new Error('network failed'), new Error('network failed'), new Error('network failed')], expected: 'authorized' },
    ]) {
      const database = new AppDatabase(':memory:', false);
      seedOwner(database);
      seedTarget(database, 'group');
      const adapter = new ScriptedAdapter({
        chatsByType: { group: [{ items: [{ chat_id: 'group-chat' }], has_more: false }] },
        histories: { 'group-chat': scenario.errors },
      });
      const runner = new FeishuOwnerSyncRunner(config().feishu, database, adapter, async () => ({}), undefined, async () => undefined);

      const result = await runner.runOnce('owner_mentions');

      expect(result.failures).toBe(1);
      expect(database.raw.prepare("SELECT oauth_status FROM owner_profile WHERE id = 'primary'").get()).toEqual({ oauth_status: scenario.expected });
      database.close();
    }
  });

  it('群发现成功不会覆盖随后发生的 @我 历史读取错误', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    seedTarget(database, 'group');
    const adapter = new ScriptedAdapter({
      chatsByType: { group: [{ items: [{ chat_id: 'group-chat' }], has_more: false }] },
      histories: { 'group-chat': [new Error('network failed'), new Error('network failed'), new Error('network failed')] },
    });
    const liveConfig = config();
    liveService(database, adapter, liveConfig);
    await new FeishuOwnerSyncRunner(liveConfig.feishu, database, adapter, async () => ({}), undefined, async () => undefined).runOnce('owner_mentions');
    const state = database.raw.prepare("SELECT status, last_error, details_json FROM information_source_state WHERE source_kind = 'owner_mentions'").get() as { status: string; last_error: string; details_json: string };

    expect(state.status).toBe('error');
    expect(state.last_error).toContain('network failed');
    expect(JSON.parse(state.details_json)).toMatchObject({ discoveredCount: 1, selectedCount: 1, failures: 1 });
    database.close();
  });

  it('联系人只有 open_id 时自动解析 P2P chat_id，用户无需填写 chat_id', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    const targetId = seedTarget(database, 'person', { chatId: null });
    const adapter = new ScriptedAdapter({
      chatsByType: { p2p: [{ items: [], has_more: false }] },
      resolutions: [{ p2p_chats: [{ chat_id: 'resolved-p2p' }] }],
      histories: { 'resolved-p2p': [{ items: [p2pMessage('resolved-message', { chatId: 'resolved-p2p' })], has_more: false }] },
    });
    const received: string[] = [];
    const runner = new FeishuOwnerSyncRunner(config().feishu, database, adapter, async (event) => { received.push(event.externalId); return {}; });

    const result = await runner.runOnce('owner_dm');

    expect(result).toMatchObject({ failures: 0, owner: { dm: 1 } });
    expect(adapter.resolveCalls).toEqual([['requester-open']]);
    expect(received).toEqual(['resolved-message']);
    expect(database.raw.prepare('SELECT resolved_chat_id, access_status FROM feishu_monitor_target WHERE id = ?').get(targetId)).toEqual({ resolved_chat_id: 'resolved-p2p', access_status: 'readable' });
    database.close();
  });

  it('一个已选群失败不会阻塞其他已选群，也不会合并游标', async () => {
    const database = new AppDatabase(':memory:', false);
    seedOwner(database);
    seedTarget(database, 'group', { id: 'target-failed', key: 'group-failed', chatId: 'group-failed' });
    seedTarget(database, 'group', { id: 'target-ok', key: 'group-ok', chatId: 'group-ok' });
    const adapter = new ScriptedAdapter({
      chatsByType: { group: [{ items: [{ chat_id: 'group-failed' }, { chat_id: 'group-ok' }], has_more: false }] },
      histories: {
        'group-failed': [Object.assign(new Error('permission denied'), { code: 403 })],
        'group-ok': [{ items: [message('ok-message', { mentioned: true, chatId: 'group-ok' })], has_more: false }],
      },
    });
    const received: string[] = [];
    const runner = new FeishuOwnerSyncRunner(config().feishu, database, adapter, async (event) => { received.push(event.externalId); return {}; });

    const result = await runner.runOnce('owner_mentions');

    expect(result).toMatchObject({ messages: 1, failures: 1, owner: { mentions: 1 } });
    expect(received).toEqual(['ok-message']);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM sync_cursor WHERE scope_key = 'messages:owner_mentions:target-ok'").get()).toEqual({ count: 1 });
    expect(database.raw.prepare("SELECT last_error FROM feishu_monitor_target WHERE id = 'target-failed'").get()).toMatchObject({ last_error: expect.stringContaining('permission denied') });
    database.close();
  });

  it('同一 message_id 后续拿到完整正文时升级原来源，不重复建候选', async () => {
    const database = new AppDatabase(':memory:', false);
    const localConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createAdapters(localConfig), localConfig);
    const first = await service.ingestSource({
      externalId: 'message-upgrade', sourceType: 'group', conversationId: 'group-chat', senderId: 'unknown-sender', senderName: '飞书用户',
      content: '请分析数据。', occurredAt: fixedNow.toISOString(), completeness: 'limited', ownerMentioned: false, metadata: { fullBodyAvailable: false },
    });
    const second = await service.ingestSource({
      externalId: 'message-upgrade', sourceType: 'group', conversationId: 'group-chat', senderId: 'requester-open', senderName: '真实需求方',
      content: '@系统主人 请分析活动留存数据，验证是否继续投入。', occurredAt: fixedNow.toISOString(), completeness: 'complete', ownerMentioned: true,
      sourceUrl: 'https://example.invalid/message-upgrade', metadata: { fullBodyAvailable: true },
    });
    expect(second).toMatchObject({ deduplicated: true, upgraded: true, sourceEventId: first.sourceEventId });
    expect(database.raw.prepare('SELECT content, sender_name, owner_mentioned, completeness, source_url FROM source_event WHERE external_id = ?').get('message-upgrade')).toEqual({
      content: '@系统主人 请分析活动留存数据，验证是否继续投入。', sender_name: '真实需求方', owner_mentioned: 1, completeness: 'complete', source_url: 'https://example.invalid/message-upgrade',
    });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    database.close();
  });

  it('模型首次失败后同一来源可以耐久重试，最终只生成一条决策和候选', async () => {
    const database = new AppDatabase(':memory:', false);
    const localConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const base = createAdapters(localConfig);
    let attempts = 0;
    const classifier = {
      kind: 'rule_mock' as const, provider: 'rule_mock' as const, model: 'deterministic_rules' as const, promptVersion: 'demand_intake_v1' as const,
      async classify() {
        attempts += 1;
        if (attempts === 1) throw new Error('模型暂时不可用');
        return { isDataRequest: true, draft: { title: '活动留存分析', proposerName: '需求方', background: '需要验证活动效果', validationQuestion: '是否继续投入', describe: '分析活动留存并支持投入判断。', confidence: 0.9 }, reason: '识别到明确的数据验证请求。', relatedTaskHint: null, importantDates: [], deliverables: [], commitments: [], usedFallback: false };
      },
      async testConnection() { return { ok: true, status: 'mock' as const, message: 'ok', checkedAt: fixedNow.toISOString() }; },
    };
    const service = new PmService(database, { ...base, classifier }, localConfig);
    const event = { externalId: 'durable-ai-retry', sourceType: 'owner_dm' as const, conversationId: 'dm-chat', senderId: 'requester-open', senderName: '需求方', content: '请分析活动留存数据。', occurredAt: fixedNow.toISOString(), completeness: 'complete' as const };
    await expect(service.ingestSource(event)).rejects.toThrow('模型暂时不可用');
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM source_event').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual({ count: 0 });
    const waiting = await service.ingestSource(event);
    expect(waiting).toMatchObject({ deduplicated: true, candidate: null });
    expect(database.raw.prepare("SELECT attempts, status FROM job WHERE job_type = 'classify_source'").get()).toEqual({ attempts: 1, status: 'queued' });
    const retryPromise = service.ingestSource(event, undefined, { retryFailed: true });
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = await retryPromise;
    expect(retry).toMatchObject({ deduplicated: true });
    expect(retry.candidate).toBeTruthy();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM ai_decision_log').get()).toEqual({ count: 1 });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    database.close();
  });

  it('同完整度的消息编辑会更新正文，撤回后会清除旧正文', async () => {
    const database = new AppDatabase(':memory:', false);
    const localConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createAdapters(localConfig), localConfig);
    const baseEvent = { externalId: 'message-edited', sourceType: 'owner_dm' as const, conversationId: 'dm-chat', senderId: 'requester-open', senderName: '需求方', occurredAt: fixedNow.toISOString(), completeness: 'complete' as const };
    await service.ingestSource({ ...baseEvent, content: '请分析活动数据。', metadata: { sourceUpdatedAt: '2026-08-10T10:00:00.000Z' } });
    await service.ingestSource({ ...baseEvent, content: '请分析活动留存和付费数据。', metadata: { sourceUpdatedAt: '2026-08-10T11:00:00.000Z' } });
    expect((database.raw.prepare('SELECT content FROM source_event WHERE external_id = ?').get('message-edited') as { content: string }).content).toBe('请分析活动留存和付费数据。');
    await service.ingestSource({ ...baseEvent, content: '', completeness: 'limited', metadata: { sourceUpdatedAt: '2026-08-10T12:00:00.000Z', deleted: true, fullBodyAvailable: false } });
    const deleted = database.raw.prepare('SELECT content, completeness, metadata_json FROM source_event WHERE external_id = ?').get('message-edited') as { content: string; completeness: string; metadata_json: string };
    expect(deleted.content).toBe('[飞书消息已撤回或删除，正文不再保留]');
    expect(deleted.completeness).toBe('limited');
    expect(JSON.parse(deleted.metadata_json)).toMatchObject({ deleted: true, fullBodyAvailable: false });
    database.close();
  });

  it('来源在模型判断期间更新时，旧结果不会覆盖新正文和新候选', async () => {
    const database = new AppDatabase(':memory:', false);
    const localConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const base = createAdapters(localConfig);
    let releaseOld!: () => void;
    let markOldStarted!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const oldStarted = new Promise<void>((resolve) => { markOldStarted = resolve; });
    const classifier = {
      kind: 'rule_mock' as const, provider: 'rule_mock' as const, model: 'deterministic_rules' as const, promptVersion: 'demand_intake_v1' as const,
      async classify(source: { content: string }) {
        const isOld = source.content.includes('旧需求');
        if (isOld) { markOldStarted(); await oldGate; }
        const label = isOld ? '旧需求' : '新需求';
        return { isDataRequest: true, draft: { title: `${label}标题`, proposerName: '需求方', background: `${label}背景`, validationQuestion: `${label}问题`, describe: `${label}摘要`, confidence: 0.9 }, reason: `识别到${label}。`, relatedTaskHint: null, importantDates: [], deliverables: [], commitments: [], usedFallback: false };
      },
      async testConnection() { return { ok: true, status: 'mock' as const, message: 'ok', checkedAt: fixedNow.toISOString() }; },
    };
    const service = new PmService(database, { ...base, classifier }, localConfig);
    const common = { externalId: 'concurrent-update', sourceType: 'owner_dm' as const, conversationId: 'dm-chat', senderId: 'requester-open', senderName: '需求方', occurredAt: fixedNow.toISOString(), completeness: 'complete' as const };
    const oldIngest = service.ingestSource({ ...common, content: '旧需求：请分析活动数据。', metadata: { sourceUpdatedAt: '2026-08-10T10:00:00.000Z' } });
    await oldStarted;
    const newIngest = await service.ingestSource({ ...common, content: '新需求：请分析活动留存数据。', metadata: { sourceUpdatedAt: '2026-08-10T11:00:00.000Z' } });
    releaseOld();
    await oldIngest;
    expect(newIngest).toMatchObject({ deduplicated: true, upgraded: true });
    expect(database.raw.prepare('SELECT content FROM source_event WHERE external_id = ?').get('concurrent-update')).toEqual({ content: '新需求：请分析活动留存数据。' });
    expect(database.raw.prepare('SELECT title, describe FROM candidate_request').get()).toEqual({ title: '新需求标题', describe: '新需求摘要' });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM candidate_request').get()).toEqual({ count: 1 });
    database.close();
  });

  it('正式任务来源更新时只生成私人复核提醒，不自动修改任务或创建 Outbox', async () => {
    const database = new AppDatabase(':memory:', false);
    const localConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: ':memory:' });
    const service = new PmService(database, createAdapters(localConfig), localConfig);
    const baseEvent = { externalId: 'accepted-source-update', sourceType: 'owner_dm' as const, conversationId: 'dm-chat', senderId: 'requester-open', senderName: '需求方', occurredAt: fixedNow.toISOString(), completeness: 'complete' as const };
    const first = await service.ingestSource({ ...baseEvent, content: '请分析活动留存数据，验证是否继续投入。', metadata: { sourceUpdatedAt: '2026-08-10T10:00:00.000Z' } });
    const accepted = service.actOnCandidate(first.candidate!.id, 'accept', undefined, service.getCandidate(first.candidate!.id)!.version);
    const taskBefore = accepted.task!;
    const updated = await service.ingestSource({ ...baseEvent, content: '请补充活动付费数据，并复核原来的投入判断。', metadata: { sourceUpdatedAt: '2026-08-10T11:00:00.000Z' } });
    expect(updated).toMatchObject({ deduplicated: true, upgraded: true });
    expect(service.getTask(taskBefore.id)).toEqual(taskBefore);
    expect(database.raw.prepare("SELECT task_id FROM notification WHERE task_id = ? AND reason LIKE '%原始来源发生更新%'").get(taskBefore.id)).toEqual({ task_id: taskBefore.id });
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 });
    database.close();
  });
});
