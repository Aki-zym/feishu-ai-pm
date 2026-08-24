import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AppDatabase } from './database.js';
import { canonicalRevisionHash } from './data04.js';

export const CINDY_SOURCE_PROVIDERS = ['feishu', 'synthetic'] as const;
export const CINDY_SOURCE_KINDS = ['im_message', 'im_thread_message', 'im_reaction_context', 'synthetic_message'] as const;
export const CINDY_SOURCE_STATUSES = ['pending_decision', 'processed', 'retryable', 'skipped', 'legacy_read_only', 'superseded', 'revoked', 'invalid'] as const;
export const CINDY_MESSAGE_TYPES = ['text', 'post', 'image', 'file', 'audio', 'video', 'sticker', 'interactive', 'system', 'unknown'] as const;
export const CINDY_OWNER_REACTION_CATEGORIES = ['acknowledge', 'approve', 'done'] as const;

export type CindySourceProvider = typeof CINDY_SOURCE_PROVIDERS[number];
export type CindySourceKind = typeof CINDY_SOURCE_KINDS[number];
export type CindySourceStatus = typeof CINDY_SOURCE_STATUSES[number];
export type CindyMessageType = typeof CINDY_MESSAGE_TYPES[number];
export type CindyOwnerReactionCategory = typeof CINDY_OWNER_REACTION_CATEGORIES[number];

export type CindyAuthContext = {
  ownerScope: string;
  accountAnchor: string;
  receiptSecret: string;
};

export type CindyAuthMaterial = {
  accountAnchor: string;
  receiptSecret: string;
};

export type CindySourceRelationInput = {
  kind: 'reply_to' | 'thread_parent';
  client_ref?: string;
  source_receipt?: string;
};

export type CindySourceInput = {
  client_ref: string;
  provider: CindySourceProvider;
  source_kind: CindySourceKind;
  stable_message_id: string;
  occurred_at: string;
  text: string;
  sender_id: string;
  display_name?: unknown;
  chat_id: string;
  thread_id?: string;
  mentioned_owner: boolean;
  sender_is_owner: boolean;
  message_type: CindyMessageType;
  reactions?: Array<{
    type: string;
    actor_is_owner: boolean;
  }>;
  revision?: {
    modified_at?: string;
    sequence?: number;
  };
  relations?: CindySourceRelationInput[];
};

export type CindySaveSourcesInput = {
  save_request_id: string;
  sources: CindySourceInput[];
};

export type CindySavedSource = {
  client_ref: string;
  source_receipt: string;
  source_status: CindySourceStatus;
  revision: {
    generation: number;
    modified_at?: string;
    sequence?: number;
  };
};

export type CindySaveSourcesResult = {
  save_request_id: string;
  duplicate: boolean;
  sources: CindySavedSource[];
};

type SourceIdentityRow = {
  id: string;
  owner_scope: string;
  account_anchor: string;
  provider: CindySourceProvider;
  source_kind: CindySourceKind;
  stable_id_hash: string;
  source_event_id: string;
  current_revision_id: string | null;
  state: 'active' | 'legacy_read_only' | 'revoked' | 'invalid';
};

type SourceRevisionRow = {
  id: string;
  source_event_id: string;
  owner_scope: string;
  revision_number: number;
  revision_hash: string;
  processing_status: CindySourceStatus;
  trusted_payload_hash: string | null;
  provider_revision_modified_at_ms: number | null;
  provider_revision_sequence: number | null;
  receipt_nonce: string | null;
  receipt_digest: string | null;
  retry_count: number;
  occurred_at: string;
  sender_ref: string | null;
  display_name: string | null;
  chat_ref: string | null;
  thread_ref: string | null;
  mentioned_owner: number | null;
  sender_is_owner: number | null;
  message_type: CindyMessageType | null;
  owner_reacted: number | null;
  owner_reaction_category: CindyOwnerReactionCategory | null;
};

type ReplayMapItem = Omit<CindySavedSource, 'source_receipt'> & { revision_id: string };

export class CindySourceContractError extends Error {
  constructor(
    readonly errorCode: 'INVALID_INPUT' | 'CONFLICT' | 'STALE_REVISION' | 'SOURCE_REVISION_AMBIGUOUS' | 'INVALID_SOURCE_RECEIPT',
    message: string,
    readonly statusCode: 400 | 403 | 409 = errorCode === 'INVALID_INPUT' ? 400 : errorCode === 'INVALID_SOURCE_RECEIPT' ? 403 : 409,
  ) {
    super(message);
    this.name = 'CindySourceContractError';
  }
}

const clientRefPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const requestIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const unsafeIdentityCharacterPattern = /[\p{Cc}\p{Cf}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const bidiCharacterPattern = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const ownerReactionMap = new Map<string, CindyOwnerReactionCategory>([
  ['OK', 'acknowledge'],
  ['THUMBSUP', 'acknowledge'],
  ['THUMBS_UP', 'acknowledge'],
  ['APPROVE', 'approve'],
  ['APPROVED', 'approve'],
  ['DONE', 'done'],
  ['CHECK_MARK', 'done'],
  ['CHECKMARK', 'done'],
]);

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function normalizedText(value: string, field: string, maxLength: number) {
  if (typeof value !== 'string') throw new CindySourceContractError('INVALID_INPUT', `${field} 必须是字符串。`);
  const normalized = value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
  if (!normalized || normalized.length > maxLength) throw new CindySourceContractError('INVALID_INPUT', `${field} 为空或过长。`);
  return normalized;
}

const DISPLAY_NAME_MAX_GRAPHEMES = 80;
// Candidate proposer_name is the strictest downstream projection (160 UTF-16
// units); staying within it also satisfies SQLite/private-source limits (320).
const DISPLAY_NAME_MAX_CODE_UNITS = 160;
const stringifiedObjectDisplayNamePattern = /^\[\s*object\s+object\s*\]$/iu;
const feishuTechnicalDisplayNamePattern = /^(?:ou|oc)_[a-z0-9_-]{6,}$/iu;

function visiblePrefix(value: string, graphemeLimit: number, codeUnitLimit: number) {
  let output = '';
  let graphemes = 0;
  for (const part of new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(value)) {
    if (graphemes >= graphemeLimit || output.length + part.segment.length > codeUnitLimit) break;
    output += part.segment;
    graphemes += 1;
  }
  return output;
}

export function sanitizeCindyDisplayName(value: unknown) {
  if (typeof value !== 'string') return '需求方';
  const cleaned = value.normalize('NFC')
    .replace(bidiCharacterPattern, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned || stringifiedObjectDisplayNamePattern.test(cleaned) || feishuTechnicalDisplayNamePattern.test(cleaned)) {
    return '需求方';
  }
  return visiblePrefix(cleaned, DISPLAY_NAME_MAX_GRAPHEMES, DISPLAY_NAME_MAX_CODE_UNITS) || '需求方';
}

function normalizedTechnicalId(value: unknown, field: string, maxLength = 500) {
  if (typeof value !== 'string') throw new CindySourceContractError('INVALID_INPUT', `${field} 必须是字符串。`);
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maxLength || unsafeIdentityCharacterPattern.test(normalized)) {
    throw new CindySourceContractError('INVALID_INPUT', `${field} 为空、过长或包含不安全字符。`);
  }
  return normalized;
}

function internalRef(auth: CindyAuthContext, kind: 'sender' | 'chat' | 'thread', rawId: string) {
  return `cindy:${kind}:${sha256(`${kind}\u0000${auth.ownerScope}\u0000${auth.accountAnchor}\u0000${rawId}`)}`;
}

function normalizedOwnerReaction(reactions: CindySourceInput['reactions']) {
  if (reactions === undefined) return { ownerReacted: false, category: null as CindyOwnerReactionCategory | null };
  if (!Array.isArray(reactions) || reactions.length > 20) {
    throw new CindySourceContractError('INVALID_INPUT', 'reactions 必须是最多 20 项的数组。');
  }
  const matched = new Set<CindyOwnerReactionCategory>();
  for (const reaction of reactions) {
    if (!reaction || typeof reaction !== 'object' || Array.isArray(reaction)) {
      throw new CindySourceContractError('INVALID_INPUT', 'reaction 必须是对象。');
    }
    if (typeof reaction.actor_is_owner !== 'boolean') {
      throw new CindySourceContractError('INVALID_INPUT', 'reaction.actor_is_owner 必须是布尔值。');
    }
    const type = normalizedText(reaction.type, 'reaction.type', 80).toUpperCase().replace(/[\s-]+/gu, '_');
    const category = ownerReactionMap.get(type);
    if (reaction.actor_is_owner && category) matched.add(category);
  }
  const category: CindyOwnerReactionCategory | null = matched.has('done')
    ? 'done'
    : matched.has('approve')
      ? 'approve'
      : matched.has('acknowledge') ? 'acknowledge' : null;
  return { ownerReacted: category !== null, category };
}

type NormalizedCindySource = {
  occurredAt: string;
  occurredAtMs: number;
  text: string;
  senderRef: string;
  displayName: string;
  chatRef: string;
  threadRef: string | null;
  mentionedOwner: boolean;
  senderIsOwner: boolean;
  messageType: CindyMessageType;
  ownerReacted: boolean;
  ownerReactionCategory: CindyOwnerReactionCategory | null;
  revision: ReturnType<typeof normalizedRevision>;
};

function normalizeSource(auth: CindyAuthContext, source: CindySourceInput): NormalizedCindySource {
  const occurred = normalizedIso(source.occurred_at, `${source.client_ref}.occurred_at`);
  const senderId = normalizedTechnicalId(source.sender_id, `${source.client_ref}.sender_id`);
  const chatId = normalizedTechnicalId(source.chat_id, `${source.client_ref}.chat_id`);
  const threadId = source.thread_id === undefined ? null : normalizedTechnicalId(source.thread_id, `${source.client_ref}.thread_id`);
  const reaction = normalizedOwnerReaction(source.reactions);
  return {
    occurredAt: occurred.iso,
    occurredAtMs: occurred.milliseconds,
    text: normalizedText(source.text, `${source.client_ref}.text`, 20_000),
    senderRef: internalRef(auth, 'sender', senderId),
    displayName: sanitizeCindyDisplayName(source.display_name),
    chatRef: internalRef(auth, 'chat', chatId),
    threadRef: threadId ? internalRef(auth, 'thread', threadId) : null,
    mentionedOwner: source.mentioned_owner,
    senderIsOwner: source.sender_is_owner,
    messageType: source.message_type,
    ownerReacted: reaction.ownerReacted,
    ownerReactionCategory: reaction.category,
    revision: normalizedRevision(source),
  };
}

function normalizedIso(value: string, field: string) {
  const normalized = normalizedText(value, field, 80);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) throw new CindySourceContractError('INVALID_INPUT', `${field} 不是有效时间。`);
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function normalizedRevision(source: CindySourceInput) {
  const modified = source.revision?.modified_at === undefined
    ? undefined
    : normalizedIso(source.revision.modified_at, `${source.client_ref}.revision.modified_at`);
  const sequence = source.revision?.sequence;
  if (sequence !== undefined && (!Number.isInteger(sequence) || sequence < 0)) {
    throw new CindySourceContractError('INVALID_INPUT', `${source.client_ref}.revision.sequence 必须是非负整数。`);
  }
  return {
    comparable: modified !== undefined || sequence !== undefined,
    modifiedAt: modified?.iso,
    modifiedAtMs: modified?.milliseconds ?? null,
    sequence: sequence ?? null,
  };
}

export function deriveCindyAuthContext(material: CindyAuthMaterial): CindyAuthContext {
  const accountAnchor = material.accountAnchor.trim();
  const receiptSecret = material.receiptSecret.trim();
  if (!accountAnchor || !receiptSecret) {
    throw new CindySourceContractError('INVALID_INPUT', 'Cindy 稳定账号锚点或 receipt 密钥尚未配置。');
  }
  return {
    // M1 is a single-owner local product. Bearer authentication is checked by
    // the HTTP route, while these separately persisted plugin secrets bind the
    // durable connected account and receipt signature across bearer rotation.
    ownerScope: 'primary',
    accountAnchor: `cindy_account_${sha256(`connected-account\u0000${accountAnchor}`)}`,
    receiptSecret,
  };
}

function receiptForNonce(auth: CindyAuthContext, nonce: string) {
  return createHmac('sha256', auth.receiptSecret).update(`source-receipt\u0000${nonce}`, 'utf8').digest('base64url');
}

function receiptDigest(receipt: string) {
  return sha256(`source-receipt-digest\u0000${receipt}`);
}

function identityHash(auth: CindyAuthContext, source: CindySourceInput) {
  void auth;
  return sha256(normalizedText(source.stable_message_id, `${source.client_ref}.stable_message_id`, 500));
}

function assertProviderKind(source: CindySourceInput) {
  const valid = source.provider === 'synthetic'
    ? source.source_kind === 'synthetic_message'
    : source.source_kind !== 'synthetic_message';
  if (!valid) throw new CindySourceContractError('INVALID_INPUT', `${source.client_ref} 的 provider 与 source_kind 不匹配。`);
}

function topologicalClientRefs(sources: CindySourceInput[]) {
  const byRef = new Map(sources.map((source) => [source.client_ref, source]));
  const state = new Map<string, 0 | 1 | 2>();
  const ordered: string[] = [];
  const visit = (clientRef: string) => {
    const current = state.get(clientRef) ?? 0;
    if (current === 1) throw new CindySourceContractError('INVALID_INPUT', '批内来源关系不能成环。');
    if (current === 2) return;
    state.set(clientRef, 1);
    for (const relation of byRef.get(clientRef)?.relations ?? []) {
      if (relation.client_ref) visit(relation.client_ref);
    }
    state.set(clientRef, 2);
    ordered.push(clientRef);
  };
  sources.forEach((source) => visit(source.client_ref));
  return ordered;
}

function validateInput(input: CindySaveSourcesInput) {
  if (!requestIdPattern.test(input.save_request_id)) throw new CindySourceContractError('INVALID_INPUT', 'save_request_id 格式无效。');
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 500) {
    throw new CindySourceContractError('INVALID_INPUT', 'sources 数量必须在 1 到 500 之间。');
  }
  const refs = new Set<string>();
  for (const source of input.sources) {
    if (!clientRefPattern.test(source.client_ref) || refs.has(source.client_ref)) {
      throw new CindySourceContractError('INVALID_INPUT', 'client_ref 格式无效或在请求内重复。');
    }
    refs.add(source.client_ref);
    assertProviderKind(source);
    normalizedText(source.stable_message_id, `${source.client_ref}.stable_message_id`, 500);
    normalizedIso(source.occurred_at, `${source.client_ref}.occurred_at`);
    normalizedText(source.text, `${source.client_ref}.text`, 20_000);
    normalizedTechnicalId(source.sender_id, `${source.client_ref}.sender_id`);
    normalizedTechnicalId(source.chat_id, `${source.client_ref}.chat_id`);
    if (source.thread_id !== undefined) normalizedTechnicalId(source.thread_id, `${source.client_ref}.thread_id`);
    if (typeof source.mentioned_owner !== 'boolean' || typeof source.sender_is_owner !== 'boolean') {
      throw new CindySourceContractError('INVALID_INPUT', `${source.client_ref} 的主人事实必须是布尔值。`);
    }
    if (!CINDY_MESSAGE_TYPES.includes(source.message_type)) {
      throw new CindySourceContractError('INVALID_INPUT', `${source.client_ref}.message_type 无效。`);
    }
    normalizedOwnerReaction(source.reactions);
    normalizedRevision(source);
    if ((source.relations?.length ?? 0) > 20) throw new CindySourceContractError('INVALID_INPUT', `${source.client_ref}.relations 过多。`);
  }
  for (const source of input.sources) {
    const relationKeys = new Set<string>();
    for (const relation of source.relations ?? []) {
      const targets = Number(Boolean(relation.client_ref)) + Number(Boolean(relation.source_receipt));
      if (targets !== 1) throw new CindySourceContractError('INVALID_INPUT', '每个关系必须且只能引用 client_ref 或 source_receipt。');
      if (relation.client_ref && (!clientRefPattern.test(relation.client_ref) || !refs.has(relation.client_ref))) {
        throw new CindySourceContractError('INVALID_INPUT', '批内关系引用了未知 client_ref。');
      }
      if (relation.source_receipt && relation.source_receipt.length > 200) {
        throw new CindySourceContractError('INVALID_INPUT', 'source_receipt 格式无效。');
      }
      const key = `${relation.kind}:${relation.client_ref ?? relation.source_receipt}`;
      if (relationKeys.has(key)) throw new CindySourceContractError('INVALID_INPUT', '同一来源不能重复声明相同关系。');
      relationKeys.add(key);
    }
  }
  topologicalClientRefs(input.sources);
}

function canonicalSaveRequest(input: CindySaveSourcesInput) {
  return {
    save_request_id: input.save_request_id,
    sources: input.sources.map((source) => {
      const revision = normalizedRevision(source);
      const relations = (source.relations ?? []).map((relation) => ({
        kind: relation.kind,
        client_ref: relation.client_ref ?? null,
        source_receipt: relation.source_receipt ?? null,
      })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
      return {
        client_ref: source.client_ref,
        provider: source.provider,
        source_kind: source.source_kind,
        stable_message_id: normalizedText(source.stable_message_id, `${source.client_ref}.stable_message_id`, 500),
        occurred_at: normalizedIso(source.occurred_at, `${source.client_ref}.occurred_at`).iso,
        sender_id: normalizedTechnicalId(source.sender_id, `${source.client_ref}.sender_id`),
        display_name: sanitizeCindyDisplayName(source.display_name),
        chat_id: normalizedTechnicalId(source.chat_id, `${source.client_ref}.chat_id`),
        thread_id: source.thread_id === undefined ? null : normalizedTechnicalId(source.thread_id, `${source.client_ref}.thread_id`),
        mentioned_owner: source.mentioned_owner,
        sender_is_owner: source.sender_is_owner,
        message_type: source.message_type,
        owner_reaction: normalizedOwnerReaction(source.reactions),
        text: normalizedText(source.text, `${source.client_ref}.text`, 20_000),
        revision: revision.comparable ? {
          modified_at_ms: revision.modifiedAtMs,
          sequence: revision.sequence,
        } : null,
        relations,
      };
    }),
  };
}

function revisionResult(row: SourceRevisionRow) {
  const result: CindySavedSource['revision'] = { generation: row.revision_number };
  if (row.provider_revision_modified_at_ms !== null) result.modified_at = new Date(row.provider_revision_modified_at_ms).toISOString();
  if (row.provider_revision_sequence !== null) result.sequence = row.provider_revision_sequence;
  return result;
}

export function issueCindySourceReceipt(auth: CindyAuthContext, row: SourceRevisionRow) {
  if (!row.receipt_nonce || !row.receipt_digest) throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '来源没有可用 receipt。');
  const receipt = receiptForNonce(auth, row.receipt_nonce);
  if (receiptDigest(receipt) !== row.receipt_digest) throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '来源 receipt 无法通过当前认证上下文验证。');
  return receipt;
}

export function issueCindySourceReceiptForRevision(database: AppDatabase, auth: CindyAuthContext, revisionId: string) {
  const row = database.raw.prepare(
    `SELECT revision.* FROM source_event_revision AS revision
      JOIN cindy_source_identity AS identity ON identity.current_revision_id = revision.id
     WHERE revision.id = ? AND identity.owner_scope = ? AND identity.account_anchor = ? AND identity.state = 'active'`,
  ).get(revisionId, auth.ownerScope, auth.accountAnchor) as SourceRevisionRow | undefined;
  if (!row) throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '来源 revision 已变化或不属于当前认证上下文。');
  return issueCindySourceReceipt(auth, row);
}

function resolveReceiptRow(database: AppDatabase, auth: CindyAuthContext, receipt: string, forDecision = false) {
  if (typeof receipt !== 'string' || receipt.length < 32 || receipt.length > 200) {
    throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '来源 receipt 无效。');
  }
  const row = database.raw.prepare(
    `SELECT revision.*
       FROM source_event_revision AS revision
       JOIN cindy_source_identity AS identity ON identity.current_revision_id = revision.id
       JOIN source_event AS source ON source.id = identity.source_event_id
      WHERE revision.receipt_digest = ?
        AND identity.owner_scope = ?
        AND identity.account_anchor = ?
        AND identity.state = 'active'
        AND source.ingest_state = 'trusted_current'`,
  ).get(receiptDigest(receipt), auth.ownerScope, auth.accountAnchor) as SourceRevisionRow | undefined;
  if (!row || !row.receipt_nonce || receiptForNonce(auth, row.receipt_nonce) !== receipt) {
    throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '来源 receipt 未知、跨 owner、已失效或不是当前 revision。');
  }
  if (['superseded', 'revoked', 'invalid', 'legacy_read_only'].includes(row.processing_status)) {
    throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '来源 receipt 已失效或不可用于当前操作。');
  }
  if (forDecision && !['pending_decision', 'retryable'].includes(row.processing_status)) {
    throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '来源 receipt 已完成处理，不能重复进入决策。');
  }
  return row;
}

export function resolveCindyDecisionReceipt(database: AppDatabase, auth: CindyAuthContext, receipt: string) {
  return resolveReceiptRow(database, auth, receipt, true);
}

export function resolveCindyCurrentReceipt(database: AppDatabase, auth: CindyAuthContext, receipt: string) {
  return resolveReceiptRow(database, auth, receipt, false);
}

function assertRelationContext(
  source: Pick<NormalizedCindySource, 'chatRef' | 'threadRef'>,
  target: Pick<SourceRevisionRow, 'chat_ref' | 'thread_ref'> | Pick<NormalizedCindySource, 'chatRef' | 'threadRef'>,
) {
  const targetChatRef = 'chat_ref' in target ? target.chat_ref : target.chatRef;
  const targetThreadRef = 'thread_ref' in target ? target.thread_ref : target.threadRef;
  if (!targetChatRef || source.chatRef !== targetChatRef) {
    throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '来源关系必须属于同一授权会话。');
  }
  if ((source.threadRef ?? null) !== (targetThreadRef ?? null)) {
    throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '来源关系不能跨 thread。');
  }
}

type ContextFact = {
  key: string;
  chatRef: string;
  threadRef: string | null;
  occurredAtMs: number;
  ownerEvidence: boolean;
};

function externalReceiptContext(database: AppDatabase, auth: CindyAuthContext, target: SourceRevisionRow) {
  const rows = database.raw.prepare(
    `WITH RECURSIVE chain(revision_id) AS (
       SELECT ?
       UNION
       SELECT relation.target_revision_id
         FROM cindy_source_relation AS relation
         JOIN chain ON chain.revision_id = relation.source_revision_id
     )
     SELECT revision.*, identity.account_anchor AS identity_account_anchor,
            identity.state AS identity_state, identity.current_revision_id AS identity_current_revision_id
       FROM chain
       JOIN source_event_revision AS revision ON revision.id = chain.revision_id
       LEFT JOIN cindy_source_identity AS identity ON identity.source_event_id = revision.source_event_id`,
  ).all(target.id) as Array<SourceRevisionRow & {
    identity_account_anchor: string | null;
    identity_state: string | null;
    identity_current_revision_id: string | null;
  }>;
  if (!rows.length || rows.some((row) => (
    row.owner_scope !== auth.ownerScope
    || row.identity_account_anchor !== auth.accountAnchor
    || row.identity_state !== 'active'
    || row.identity_current_revision_id !== row.id
    || !row.chat_ref
    || !Number.isFinite(Date.parse(row.occurred_at))
    || ['superseded', 'revoked', 'invalid', 'legacy_read_only'].includes(row.processing_status)
  ))) {
    throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '跨批关系上下文包含失效或跨账号 revision。');
  }
  return rows;
}

function validateContextBounds(
  input: CindySaveSourcesInput,
  normalizedByRef: Map<string, NormalizedCindySource>,
  externalContexts: Map<string, SourceRevisionRow[]>,
) {
  const parent = new Map<string, string>();
  const ensure = (key: string) => { if (!parent.has(key)) parent.set(key, key); };
  const find = (key: string): string => {
    ensure(key);
    const current = parent.get(key)!;
    if (current === key) return key;
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  const batchKey = (clientRef: string) => `batch:${clientRef}`;
  for (const source of input.sources) ensure(batchKey(source.client_ref));
  for (const source of input.sources) {
    for (const relation of source.relations ?? []) {
      if (relation.client_ref) union(batchKey(source.client_ref), batchKey(relation.client_ref));
      if (relation.source_receipt) {
        const targetRows = externalContexts.get(relation.source_receipt)!;
        for (const row of targetRows) {
          ensure(`revision:${row.id}`);
          union(batchKey(source.client_ref), `revision:${row.id}`);
        }
      }
    }
  }

  const threadRoots = new Map<string, string>();
  const bindThread = (nodeKey: string, chatRef: string, threadRef: string | null) => {
    if (!threadRef) return;
    const threadKey = `${chatRef}\u0000${threadRef}`;
    const existing = threadRoots.get(threadKey);
    if (existing) union(nodeKey, existing);
    else threadRoots.set(threadKey, nodeKey);
  };
  for (const source of input.sources) {
    const normalized = normalizedByRef.get(source.client_ref)!;
    bindThread(batchKey(source.client_ref), normalized.chatRef, normalized.threadRef);
  }
  for (const rows of externalContexts.values()) {
    for (const row of rows) bindThread(`revision:${row.id}`, row.chat_ref!, row.thread_ref);
  }

  const referenced = new Set(input.sources.flatMap((source) => (source.relations ?? []).flatMap((relation) => relation.client_ref ? [relation.client_ref] : [])));
  const groups = new Map<string, { structured: boolean; facts: Map<string, ContextFact> }>();
  const add = (groupKey: string, structured: boolean, fact: ContextFact) => {
    const group = groups.get(groupKey) ?? { structured, facts: new Map<string, ContextFact>() };
    group.structured ||= structured;
    group.facts.set(fact.key, fact);
    groups.set(groupKey, group);
  };
  for (const source of input.sources) {
    const normalized = normalizedByRef.get(source.client_ref)!;
    const structured = normalized.threadRef !== null || (source.relations?.length ?? 0) > 0 || referenced.has(source.client_ref);
    const groupKey = structured ? `structured:${find(batchKey(source.client_ref))}` : `plain:${normalized.chatRef}`;
    add(groupKey, structured, {
      key: batchKey(source.client_ref),
      chatRef: normalized.chatRef,
      threadRef: normalized.threadRef,
      occurredAtMs: normalized.occurredAtMs,
      ownerEvidence: normalized.mentionedOwner || normalized.senderIsOwner || normalized.ownerReacted,
    });
  }
  for (const rows of externalContexts.values()) {
    for (const row of rows) {
      add(`structured:${find(`revision:${row.id}`)}`, true, {
        key: `revision:${row.id}`,
        chatRef: row.chat_ref!,
        threadRef: row.thread_ref,
        occurredAtMs: Date.parse(row.occurred_at),
        ownerEvidence: Boolean(row.mentioned_owner || row.sender_is_owner || row.owner_reacted),
      });
    }
  }

  for (const group of groups.values()) {
    const facts = [...group.facts.values()];
    const limit = group.structured ? 100 : 20;
    const maximumSpan = group.structured ? 4 * 60 * 60 * 1000 : 60 * 60 * 1000;
    if (facts.length > limit) throw new CindySourceContractError('INVALID_INPUT', `单次上下文超过 ${limit} 条限制。`);
    const times = facts.map((fact) => fact.occurredAtMs);
    if (Math.max(...times) - Math.min(...times) > maximumSpan) {
      throw new CindySourceContractError('INVALID_INPUT', group.structured ? 'thread/reply 上下文超过 4 小时限制。' : '无 thread/reply 上下文超过 60 分钟限制。');
    }
    if (!group.structured && !facts.some((fact) => fact.ownerEvidence)) {
      throw new CindySourceContractError('INVALID_INPUT', '无 thread/reply 上下文必须包含明确主人证据。');
    }
  }
}

function compareRevisionTuple(
  left: { modifiedAtMs: number | null; sequence: number | null },
  right: { modifiedAtMs: number | null; sequence: number | null },
) {
  const leftModified = left.modifiedAtMs ?? -1;
  const rightModified = right.modifiedAtMs ?? -1;
  if (leftModified !== rightModified) return leftModified < rightModified ? -1 : 1;
  const leftSequence = left.sequence ?? -1;
  const rightSequence = right.sequence ?? -1;
  return leftSequence === rightSequence ? 0 : leftSequence < rightSequence ? -1 : 1;
}

export function saveCindySources(
  database: AppDatabase,
  auth: CindyAuthContext,
  input: CindySaveSourcesInput,
  now = new Date(),
): CindySaveSourcesResult {
  validateInput(input);
  const requestHash = sha256(stableJson(canonicalSaveRequest(input)));
  const normalizedByRef = new Map(input.sources.map((source) => [source.client_ref, normalizeSource(auth, source)]));
  return database.transaction(() => {
    const replay = database.raw.prepare(
      `SELECT request_hash, response_map_json FROM cindy_save_request
        WHERE owner_scope = ? AND account_anchor = ? AND save_request_id = ?`,
    ).get(auth.ownerScope, auth.accountAnchor, input.save_request_id) as { request_hash: string; response_map_json: string } | undefined;
    if (replay) {
      if (replay.request_hash !== requestHash) throw new CindySourceContractError('CONFLICT', 'save_request_id 已绑定到不同请求。');
      const stored = JSON.parse(replay.response_map_json) as ReplayMapItem[];
      const sources = stored.map((item) => {
        const row = database.raw.prepare('SELECT * FROM source_event_revision WHERE id = ?').get(item.revision_id) as SourceRevisionRow | undefined;
        if (!row) throw new CindySourceContractError('CONFLICT', '保存请求的幂等记录不完整。');
        const identity = database.raw.prepare(
          `SELECT current_revision_id, state FROM cindy_source_identity
            WHERE owner_scope = ? AND account_anchor = ? AND source_event_id = ?`,
        ).get(auth.ownerScope, auth.accountAnchor, row.source_event_id) as { current_revision_id: string | null; state: string } | undefined;
        const sourceStatus = identity?.state === 'active' && identity.current_revision_id === row.id
          ? row.processing_status
          : 'superseded';
        return { ...item, source_status: sourceStatus, source_receipt: issueCindySourceReceipt(auth, row) };
      }).map(({ revision_id: _revisionId, ...item }) => item);
      return { save_request_id: input.save_request_id, duplicate: true, sources };
    }

    const timestamp = now.toISOString();
    const byRef = new Map(input.sources.map((source) => [source.client_ref, source]));
    const revisionByRef = new Map<string, SourceRevisionRow>();
    const outputByRef = new Map<string, CindySavedSource>();
    const replayItems = new Map<string, ReplayMapItem>();
    const externalRelationTargets = new Map<string, SourceRevisionRow>();
    const externalContexts = new Map<string, SourceRevisionRow[]>();

    for (const source of input.sources) {
      const normalized = normalizedByRef.get(source.client_ref)!;
      for (const relation of source.relations ?? []) {
        if (relation.client_ref) {
          assertRelationContext(normalized, normalizedByRef.get(relation.client_ref)!);
        } else {
          const receipt = relation.source_receipt!;
          const target = externalRelationTargets.get(receipt) ?? resolveReceiptRow(database, auth, receipt);
          assertRelationContext(normalized, target);
          externalRelationTargets.set(receipt, target);
          externalContexts.set(receipt, externalContexts.get(receipt) ?? externalReceiptContext(database, auth, target));
        }
      }
    }
    validateContextBounds(input, normalizedByRef, externalContexts);

    for (const clientRef of topologicalClientRefs(input.sources)) {
      const source = byRef.get(clientRef)!;
      const normalized = normalizedByRef.get(clientRef)!;
      const relationRows = (source.relations ?? []).map((relation) => {
        const target = relation.client_ref
          ? revisionByRef.get(relation.client_ref)
          : externalRelationTargets.get(relation.source_receipt!);
        if (!target) throw new CindySourceContractError('INVALID_INPUT', '批内关系引用未解析。');
        return { kind: relation.kind, targetRevisionId: target.id };
      }).sort((left, right) => `${left.kind}:${left.targetRevisionId}`.localeCompare(`${right.kind}:${right.targetRevisionId}`));
      const trustedPayloadHash = sha256(stableJson({
        provider: source.provider,
        source_kind: source.source_kind,
        stable_id_hash: identityHash(auth, source),
        occurred_at: normalized.occurredAt,
        text: normalized.text,
        sender_ref: normalized.senderRef,
        display_name: normalized.displayName,
        chat_ref: normalized.chatRef,
        thread_ref: normalized.threadRef,
        mentioned_owner: normalized.mentionedOwner,
        sender_is_owner: normalized.senderIsOwner,
        message_type: normalized.messageType,
        owner_reacted: normalized.ownerReacted,
        owner_reaction_category: normalized.ownerReactionCategory,
        revision: {
          modified_at_ms: normalized.revision.modifiedAtMs,
          sequence: normalized.revision.sequence,
        },
        relations: relationRows,
      }));
      const stableIdHash = identityHash(auth, source);
      let identity = database.raw.prepare(
        `SELECT * FROM cindy_source_identity
          WHERE owner_scope = ? AND provider = ? AND source_kind = ? AND stable_id_hash = ?`,
      ).get(auth.ownerScope, source.provider, source.source_kind, stableIdHash) as SourceIdentityRow | undefined;

      if (identity && ['revoked', 'invalid'].includes(identity.state)) {
        throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '来源身份已撤回或失效。');
      }
      if (identity && identity.state === 'active' && identity.account_anchor !== auth.accountAnchor) {
        throw new CindySourceContractError('INVALID_SOURCE_RECEIPT', '来源身份不属于当前连接账号。');
      }
      const wasExistingIdentity = Boolean(identity);

      const exact = identity ? database.raw.prepare(
        `SELECT * FROM source_event_revision
          WHERE source_event_id = ?
            AND provider_revision_modified_at_ms IS ?
            AND provider_revision_sequence IS ?
            AND trusted_payload_hash IS NOT NULL
          ORDER BY revision_number DESC LIMIT 1`,
      ).get(identity.source_event_id, normalized.revision.modifiedAtMs, normalized.revision.sequence) as SourceRevisionRow | undefined : undefined;
      if (exact) {
        if (exact.trusted_payload_hash !== trustedPayloadHash) {
          if (!normalized.revision.comparable) {
            throw new CindySourceContractError('SOURCE_REVISION_AMBIGUOUS', '来源没有可比较 revision，异内容更新已安全拒绝。');
          }
          throw new CindySourceContractError('CONFLICT', '相同 provider revision 对应了不同 canonical payload。');
        }
        const status = identity?.current_revision_id === exact.id ? exact.processing_status : 'superseded';
        const saved = {
          client_ref: clientRef,
          source_receipt: issueCindySourceReceipt(auth, exact),
          source_status: status as CindySourceStatus,
          revision: revisionResult(exact),
        };
        revisionByRef.set(clientRef, exact);
        outputByRef.set(clientRef, saved);
        replayItems.set(clientRef, { client_ref: clientRef, source_status: saved.source_status, revision: saved.revision, revision_id: exact.id });
        continue;
      }

      const current = identity?.current_revision_id
        ? database.raw.prepare('SELECT * FROM source_event_revision WHERE id = ?').get(identity.current_revision_id) as SourceRevisionRow | undefined
        : undefined;
      if (identity?.state === 'active' && current?.trusted_payload_hash) {
        if (!normalized.revision.comparable) {
          throw new CindySourceContractError('SOURCE_REVISION_AMBIGUOUS', '来源没有可比较 revision，异内容更新已安全拒绝。');
        }
        const currentComparable = current.provider_revision_modified_at_ms !== null || current.provider_revision_sequence !== null;
        if (currentComparable) {
          const comparison = compareRevisionTuple(
            { modifiedAtMs: normalized.revision.modifiedAtMs, sequence: normalized.revision.sequence },
            { modifiedAtMs: current.provider_revision_modified_at_ms, sequence: current.provider_revision_sequence },
          );
          if (comparison < 0) throw new CindySourceContractError('STALE_REVISION', '来源 revision 低于当前 generation。');
          if (comparison === 0) throw new CindySourceContractError('CONFLICT', '相同 provider revision 对应了不同 canonical payload。');
        }
      }

      const sourceEventId = identity?.source_event_id ?? `source_cindy_${randomUUID()}`;
      const sourceExternalId = `cindy:${stableIdHash}`;
      const conversationId = normalized.chatRef;
      const senderId = normalized.senderRef;
      const metadataJson = stableJson({
        accountAnchor: auth.accountAnchor,
        ownerScope: auth.ownerScope,
        provider: source.provider,
        sourceKind: source.source_kind,
        stableIdHash,
        threadRef: normalized.threadRef,
        senderIsOwner: normalized.senderIsOwner,
        messageType: normalized.messageType,
        ownerReactionCategory: normalized.ownerReactionCategory,
      });
      const generation = (current?.revision_number ?? 0) + 1;
      const revisionId = `source_revision_cindy_${randomUUID()}`;
      const nonce = randomBytes(32).toString('base64url');
      const receipt = receiptForNonce(auth, nonce);
      const digest = receiptDigest(receipt);
      const revisionHash = canonicalRevisionHash({
        ownerScope: auth.ownerScope,
        sourceEventId,
        revisionNumber: generation,
        revisionKind: identity ? 'edit' : 'ingest',
        externalId: sourceExternalId,
        sourceType: 'manual',
        conversationId,
        senderId,
        senderName: normalized.displayName,
        content: normalized.text,
        ownerMentioned: normalized.mentionedOwner ? 1 : 0,
        sourceUrl: null,
        completeness: 'complete',
        discoveryReason: 'Cindy 已授权来源先保存。',
        metadataJson,
        occurredAt: normalized.occurredAt,
        capturedAt: timestamp,
      });

      if (!identity) {
        database.raw.prepare(
          `INSERT INTO source_event
            (id, external_id, source_type, conversation_id, sender_id, sender_name, content, owner_mentioned,
             source_url, completeness, discovery_reason, metadata_json, occurred_at, captured_at,
             owner_scope, revision_generation, current_revision_id, ingest_state)
           VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, NULL, 'complete', ?, ?, ?, ?, ?, ?, ?, 'trusted_current')`,
        ).run(
          sourceEventId, sourceExternalId, conversationId, senderId, normalized.displayName, normalized.text, normalized.mentionedOwner ? 1 : 0,
          'Cindy 已授权来源先保存。', metadataJson, normalized.occurredAt, timestamp, auth.ownerScope, generation, revisionId,
        );
        identity = {
          id: `cindy_source_${randomUUID()}`,
          owner_scope: auth.ownerScope,
          account_anchor: auth.accountAnchor,
          provider: source.provider,
          source_kind: source.source_kind,
          stable_id_hash: stableIdHash,
          source_event_id: sourceEventId,
          current_revision_id: revisionId,
          state: 'active',
        };
      } else {
        database.raw.prepare(
          `UPDATE source_event
              SET content = ?, sender_id = ?, sender_name = ?, owner_mentioned = ?, conversation_id = ?, metadata_json = ?, occurred_at = ?,
                  captured_at = ?, owner_scope = ?, revision_generation = ?, current_revision_id = ?, ingest_state = 'trusted_current'
            WHERE id = ?`,
        ).run(
          normalized.text, senderId, normalized.displayName, normalized.mentionedOwner ? 1 : 0, conversationId, metadataJson,
          normalized.occurredAt, timestamp, auth.ownerScope, generation, revisionId, sourceEventId,
        );
        if (current && current.processing_status !== 'legacy_read_only') {
          database.raw.prepare(
            `UPDATE source_event_revision SET processing_status = 'superseded'
              WHERE id = ? AND processing_status NOT IN ('revoked','invalid')`,
          ).run(current.id);
          database.raw.prepare(
            `UPDATE cindy_owner_decision
                SET status = 'superseded', version = version + 1, updated_at = ?, last_error = NULL
              WHERE owner_scope = ? AND account_anchor = ? AND status = 'pending'
                AND EXISTS (
                  SELECT 1 FROM cindy_owner_decision_source AS decision_source
                   WHERE decision_source.decision_id = cindy_owner_decision.id
                     AND decision_source.source_revision_id = ?
                )`,
          ).run(timestamp, auth.ownerScope, auth.accountAnchor, current.id);
        }
      }

      database.raw.prepare(
        `INSERT INTO source_event_revision
          (id, source_event_id, revision_number, revision_kind, external_id, source_type, conversation_id,
           sender_id, sender_name, content, owner_mentioned, source_url, completeness, discovery_reason,
           metadata_json, occurred_at, captured_at, owner_scope, revision_hash, created_at,
           processing_status, trusted_payload_hash, provider_revision_modified_at_ms, provider_revision_sequence,
           receipt_nonce, receipt_digest, retry_count, sender_ref, display_name, chat_ref, thread_ref,
           mentioned_owner, sender_is_owner, message_type, owner_reacted, owner_reaction_category)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, NULL, 'complete', ?, ?, ?, ?, ?, ?, ?,
                 'pending_decision', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        revisionId, sourceEventId, generation, wasExistingIdentity ? 'edit' : 'ingest', sourceExternalId,
        conversationId, senderId, normalized.displayName, normalized.text, normalized.mentionedOwner ? 1 : 0,
        'Cindy 已授权来源先保存。', metadataJson, normalized.occurredAt, timestamp, auth.ownerScope, revisionHash, timestamp,
        trustedPayloadHash, normalized.revision.modifiedAtMs, normalized.revision.sequence, nonce, digest,
        normalized.senderRef, normalized.displayName, normalized.chatRef, normalized.threadRef,
        normalized.mentionedOwner ? 1 : 0, normalized.senderIsOwner ? 1 : 0, normalized.messageType,
        normalized.ownerReacted ? 1 : 0, normalized.ownerReactionCategory,
      );
      if (wasExistingIdentity) {
        database.raw.prepare(
          `UPDATE cindy_source_identity
              SET account_anchor = ?, current_revision_id = ?, state = 'active', updated_at = ?
            WHERE id = ?`,
        ).run(auth.accountAnchor, revisionId, timestamp, identity.id);
      } else {
        database.raw.prepare(
          `INSERT INTO cindy_source_identity
            (id, owner_scope, account_anchor, provider, source_kind, stable_id_hash, source_event_id,
             current_revision_id, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).run(
          identity.id, auth.ownerScope, auth.accountAnchor, source.provider, source.source_kind, stableIdHash,
          sourceEventId, revisionId, timestamp, timestamp,
        );
      }
      for (const relation of relationRows) {
        database.raw.prepare(
          `INSERT INTO cindy_source_relation
            (source_revision_id, relation_kind, target_revision_id, owner_scope, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(revisionId, relation.kind, relation.targetRevisionId, auth.ownerScope, timestamp);
      }
      const row = database.raw.prepare('SELECT * FROM source_event_revision WHERE id = ?').get(revisionId) as SourceRevisionRow;
      const saved: CindySavedSource = {
        client_ref: clientRef,
        source_receipt: receipt,
        source_status: 'pending_decision',
        revision: revisionResult(row),
      };
      revisionByRef.set(clientRef, row);
      outputByRef.set(clientRef, saved);
      replayItems.set(clientRef, { client_ref: clientRef, source_status: saved.source_status, revision: saved.revision, revision_id: row.id });
    }

    // A later source in this same batch may have superseded a receipt that an
    // earlier source used as a relation target. Re-resolve every external
    // relation before commit so the whole batch remains current-or-zero-write.
    for (const source of input.sources) {
      for (const relation of source.relations ?? []) {
        if (relation.source_receipt) resolveReceiptRow(database, auth, relation.source_receipt);
      }
    }

    const sources = input.sources.map((source) => outputByRef.get(source.client_ref)!);
    const stored = input.sources.map((source) => replayItems.get(source.client_ref)!);
    database.raw.prepare(
      `INSERT INTO cindy_save_request
        (owner_scope, account_anchor, save_request_id, request_hash, response_map_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(auth.ownerScope, auth.accountAnchor, input.save_request_id, requestHash, JSON.stringify(stored), timestamp);
    return { save_request_id: input.save_request_id, duplicate: false, sources };
  });
}

export function hashCindyDecisionRequest(value: unknown) {
  return sha256(stableJson(value));
}

export function cindyDecisionReplay(
  database: AppDatabase,
  auth: CindyAuthContext,
  decisionRequestId: string,
  requestHash: string,
) {
  const row = database.raw.prepare(
    `SELECT request_hash, response_json FROM cindy_decision_request
      WHERE owner_scope = ? AND account_anchor = ? AND decision_request_id = ?`,
  ).get(auth.ownerScope, auth.accountAnchor, decisionRequestId) as { request_hash: string; response_json: string } | undefined;
  if (!row) return undefined;
  if (row.request_hash !== requestHash) throw new CindySourceContractError('CONFLICT', 'decision_request_id 已绑定到不同请求。');
  return JSON.parse(row.response_json) as unknown;
}

export function recordCindyDecisionRequest(
  database: AppDatabase,
  auth: CindyAuthContext,
  decisionRequestId: string,
  requestHash: string,
  result: unknown,
  timestamp: string,
) {
  database.raw.prepare(
    `INSERT INTO cindy_decision_request
      (owner_scope, account_anchor, decision_request_id, request_hash, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(auth.ownerScope, auth.accountAnchor, decisionRequestId, requestHash, JSON.stringify(result), timestamp);
}
