import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  extractFeishuErrorDetails,
  FeishuApiError,
  feishuScopeUpdateOf,
  feishuApiErrorCategoryOf,
  feishuErrorDiagnostic,
  feishuUnixSeconds,
  isFeishuBusinessError,
  isFeishuDetailBlockingError,
  isFeishuRetryableError,
  LiveFeishuAdapter,
  createDurableFeishuEventHandler,
  normalizeFeishuScopeUpdate,
  normalizeFeishuTimestamp,
} from '../src/integrations/feishu.js';

type SharedVaultState = {
  values: Map<string, string>;
  generation: number;
  leases: Map<string, { status: 'active' | 'completed' | 'failed'; phase: 'claimed' | 'provider_started' | 'response_pending' | 'retryable_failed' | 'recovery_required' | 'completed'; leaseId: string; ownerId: string; ownerPid: number; fencingToken: number; generation: number; tokenFingerprint: string | null; expiresAt: number; resultExpiresAt: string | null }>;
  leaseTail: Promise<void>;
};

class Vault {
  private readonly state: SharedVaultState;
  beforeSnapshotReturn?: () => Promise<void>;
  constructor(state?: SharedVaultState) {
    this.state = state ?? { values: new Map(), generation: 0, leases: new Map(), leaseTail: Promise.resolve() };
  }
  get values() { return this.state.values; }
  get generation() { return this.state.generation; }
  private fingerprint(value: string | null) { return value === null ? null : createHash('sha256').update(value, 'utf8').digest('hex'); }
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); this.state.generation += 1; }
  async setMany(values: Record<string, string>) { for (const [key, value] of Object.entries(values)) this.values.set(key, value); this.state.generation += 1; }
  async readSnapshot() {
    const snapshot = {
      generation: this.generation,
      accessToken: this.values.get('FEISHU_USER_ACCESS_TOKEN') ?? null,
      refreshToken: this.values.get('FEISHU_REFRESH_TOKEN') ?? null,
      expiresAt: this.values.get('FEISHU_TOKEN_EXPIRES_AT') ?? null,
      grantedScopes: this.values.get('FEISHU_GRANTED_SCOPES') ?? null,
    };
    const hook = this.beforeSnapshotReturn;
    this.beforeSnapshotReturn = undefined;
    if (hook) await hook();
    return snapshot;
  }
  async setManyAtomic(values: Record<string, string | null>, expectedGeneration: number, refreshFence?: { identityKey: string; leaseId: string; fencingToken: number; tokenFingerprint: string | null; resultExpiresAt?: string | null }) {
    if (expectedGeneration !== this.generation) return { accepted: false, generation: this.generation };
    if (refreshFence) {
      const lease = this.state.leases.get(refreshFence.identityKey);
      if (!lease || lease.status !== 'active' || lease.leaseId !== refreshFence.leaseId || lease.fencingToken !== refreshFence.fencingToken || lease.generation !== expectedGeneration || lease.tokenFingerprint !== refreshFence.tokenFingerprint || this.fingerprint(this.values.get('FEISHU_REFRESH_TOKEN') ?? null) !== refreshFence.tokenFingerprint || (refreshFence.resultExpiresAt !== undefined && lease.phase !== 'response_pending')) return { accepted: false, generation: this.generation };
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === null) this.values.delete(key);
      else this.values.set(key, value);
    }
    this.state.generation += 1;
    return { accepted: true, generation: this.generation };
  }
  async acquireRefreshLease(identityKey: string, waitForResult = false) {
    const previousTail = this.state.leaseTail;
    let release!: () => void;
    this.state.leaseTail = new Promise<void>((resolve) => { release = resolve; });
    await previousTail;
    try {
      const snapshot = await this.readSnapshot();
      const previous = this.state.leases.get(identityKey);
      const currentFingerprint = this.fingerprint(snapshot.refreshToken);
      const recoveryCredentialReplaced = previous?.status === 'failed'
        && previous.phase === 'recovery_required'
        && snapshot.generation > previous.generation
        && typeof snapshot.refreshToken === 'string'
        && snapshot.refreshToken.trim().length > 0
        && currentFingerprint !== previous.tokenFingerprint;
      if (previous?.status === 'active' && previous.expiresAt > Date.now()) return { status: 'busy' as const, generation: this.generation, snapshot, phase: previous.phase };
      if (previous?.status === 'active' && previous.expiresAt <= Date.now() && (previous.phase === 'provider_started' || previous.phase === 'response_pending')) {
        previous.status = 'failed';
        previous.phase = 'recovery_required';
        previous.expiresAt = Date.now() + 60_000;
        previous.resultExpiresAt = null;
        return { status: 'failed' as const, generation: this.generation, snapshot, phase: previous.phase };
      }
      if (previous?.status === 'failed' && previous.phase === 'recovery_required' && !recoveryCredentialReplaced) return { status: 'failed' as const, generation: this.generation, snapshot, phase: previous.phase };
      if (previous && previous.status !== 'active' && waitForResult && !recoveryCredentialReplaced) return { status: previous.status, generation: this.generation, snapshot, ownerId: previous.ownerId, fencingToken: previous.fencingToken, tokenFingerprint: previous.tokenFingerprint, resultExpiresAt: previous.resultExpiresAt } as const;
      this.state.leases.delete(identityKey);
      const leaseId = `lease-${Math.random().toString(16).slice(2)}`;
      const ownerId = `owner-${Math.random().toString(16).slice(2)}`;
      const fencingToken = (previous?.fencingToken ?? 0) + 1;
      const tokenFingerprint = this.fingerprint(snapshot.refreshToken);
      this.state.leases.set(identityKey, { status: 'active', phase: 'claimed', leaseId, ownerId, ownerPid: process.pid, fencingToken, generation: this.generation, tokenFingerprint, expiresAt: Date.now() + 30_000, resultExpiresAt: null });
      return { status: 'acquired' as const, generation: this.generation, snapshot, phase: 'claimed' as const, leaseId, ownerId, fencingToken, tokenFingerprint };
    } finally {
      release();
    }
  }
  async renewRefreshLease(identityKey: string, leaseId: string, fencingToken?: number, phase: 'claimed' | 'provider_started' | 'response_pending' = 'claimed') {
    const lease = this.state.leases.get(identityKey);
    if (!lease || lease.status !== 'active' || lease.leaseId !== leaseId || (fencingToken !== undefined && lease.fencingToken !== fencingToken)) return false;
    lease.expiresAt = Date.now() + 30_000;
    lease.phase = phase;
    return true;
  }
  async releaseRefreshLease(identityKey: string, leaseId: string, result: { status: 'completed' | 'failed'; generation: number; expiresAt?: string | null; phase?: 'retryable_failed' | 'recovery_required' }, fencingToken?: number) {
    const lease = this.state.leases.get(identityKey);
    if (!lease || lease.status !== 'active' || lease.leaseId !== leaseId || (fencingToken !== undefined && lease.fencingToken !== fencingToken)) throw new Error('lease lost');
    this.state.leases.set(identityKey, { ...lease, status: result.status, phase: result.status === 'completed' ? 'completed' : (result.phase ?? 'retryable_failed'), generation: result.generation, expiresAt: Date.now() + 60_000, resultExpiresAt: result.expiresAt ?? null });
  }
}

class BeforeProviderFailureVault extends Vault {
  failProviderStart = true;

  override async renewRefreshLease(
    identityKey: string,
    leaseId: string,
    fencingToken?: number,
    phase: 'claimed' | 'provider_started' | 'response_pending' = 'claimed',
  ) {
    if (phase === 'provider_started' && this.failProviderStart) {
      this.failProviderStart = false;
      return false;
    }
    return super.renewRefreshLease(identityKey, leaseId, fencingToken, phase);
  }
}

class LegacyVault {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); }
}

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: ':memory:',
    FEISHU_EXTERNAL_ENABLED: 'true',
    FEISHU_APP_ID: 'app-test',
    FEISHU_APP_SECRET: 'secret-test',
    FEISHU_OAUTH_REDIRECT_URI: 'http://127.0.0.1:4311/oauth/feishu/callback',
    FEISHU_GROUP_IDS: 'group-allowed',
  }).feishu;
}

describe('LiveFeishuAdapter 契约', () => {
  it('实时事件只有在耐久收件回执完成后才返回确认结果', async () => {
    const order: string[] = [];
    const event = {
      message: {
        message_id: 'ws-durable-1',
        chat_id: 'chat-1',
        chat_type: 'p2p',
        sender: { sender_id: 'user-1', sender_name: '需求方' },
        content: JSON.stringify({ text: '请分析活动留存。' }),
        msg_type: 'text',
      },
    };
    let release!: () => void;
    const durable = new Promise<void>((resolve) => { release = resolve; });
    const callback = createDurableFeishuEventHandler({
      normalize: (value) => ({
        externalId: String((value as any).message.message_id),
        sourceType: 'bot_dm',
        conversationId: 'chat-1',
        senderId: 'user-1',
        senderName: '需求方',
        content: '请分析活动留存。',
        occurredAt: '2026-08-18T00:00:00.000Z',
        metadata: { sourceScope: 'bot_supplement', ownerScope: 'primary' },
      }),
      shouldAccept: () => true,
      handle: async (source) => {
        order.push(`handle-start:${source.externalId}`);
        await durable;
        order.push('durable-commit');
        return { externalId: source.externalId, sourceEventId: 'src-1', deduplicated: false, capturedAt: '2026-08-18T00:00:00.001Z' };
      },
    });
    let settled = false;
    const pending = callback(event).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(order).toEqual(['handle-start:ws-durable-1']);
    release();
    await pending;
    expect(settled).toBe(true);
    expect(order).toEqual(['handle-start:ws-durable-1', 'durable-commit']);
  });

  it('耐久收件失败时拒绝确认，允许平台重投', async () => {
    const callback = createDurableFeishuEventHandler({
      normalize: () => ({
        externalId: 'ws-fail-1', sourceType: 'bot_dm', conversationId: 'chat-1', senderId: 'user-1', senderName: '需求方', content: 'x', occurredAt: '2026-08-18T00:00:00.000Z',
      }),
      shouldAccept: () => true,
      handle: async () => { throw new Error('durable inbox unavailable'); },
    });
    await expect(callback({})).rejects.toThrow('durable inbox unavailable');
  });

  it('重复 WebSocket 投递保留同一个 durable receipt 并只允许一次分类调度', async () => {
    const calls: string[] = [];
    const callback = createDurableFeishuEventHandler({
      normalize: () => ({
        externalId: 'ws-duplicate-1', sourceType: 'bot_dm', conversationId: 'chat-1', senderId: 'user-1', senderName: '需求方', content: 'x', occurredAt: '2026-08-18T00:00:00.000Z',
      }),
      shouldAccept: () => true,
      handle: async (source) => {
        const duplicate = calls.includes(source.externalId);
        calls.push(source.externalId);
        return { externalId: source.externalId, sourceEventId: 'src-duplicate-1', deduplicated: duplicate, capturedAt: '2026-08-18T00:00:00.001Z' };
      },
    });
    await callback({});
    await callback({});
    expect(calls).toEqual(['ws-duplicate-1', 'ws-duplicate-1']);
  });

  it('无效耐久回执时拒绝确认', async () => {
    const callback = createDurableFeishuEventHandler({
      normalize: () => ({
        externalId: 'ws-invalid-receipt', sourceType: 'bot_dm', conversationId: 'chat-1', senderId: 'user-1', senderName: '需求方', content: 'x', occurredAt: '2026-08-18T00:00:00.000Z',
      }),
      shouldAccept: () => true,
      handle: async () => ({ externalId: 'other', sourceEventId: '', deduplicated: false, capturedAt: '' }),
    });
    await expect(callback({})).rejects.toThrow('未取得有效耐久收件回执');
  });

  it('scope 合同区分省略、显式空集合和具体值', () => {
    expect(feishuScopeUpdateOf(undefined)).toEqual({ kind: 'omitted' });
    expect(feishuScopeUpdateOf('')).toEqual({ kind: 'set', scopes: [] });
    expect(feishuScopeUpdateOf('im:message, calendar:calendar im:message')).toEqual({ kind: 'set', scopes: ['im:message', 'calendar:calendar'] });
    expect(() => feishuScopeUpdateOf(null)).toThrow('FEISHU_SCOPE_INVALID');
    expect(() => feishuScopeUpdateOf(['im:message', null])).toThrow('FEISHU_SCOPE_INVALID');
    expect(() => feishuScopeUpdateOf('access/token')).toThrow('FEISHU_SCOPE_INVALID');
    expect(normalizeFeishuScopeUpdate({ kind: 'omitted' })).toEqual({ kind: 'omitted' });
    expect(normalizeFeishuScopeUpdate({ kind: 'set', scopes: [] })).toEqual({ kind: 'set', scopes: [] });
    expect(() => normalizeFeishuScopeUpdate({ kind: 'omitted', scopes: ['scope:unexpected'] })).toThrow('FEISHU_SCOPE_INVALID');
    expect(() => normalizeFeishuScopeUpdate({ kind: 'set', scopes: [], extra: true })).toThrow('FEISHU_SCOPE_INVALID');
  });

  it('按飞书接口契约转换查询时间和消息时间戳', () => {
    expect(feishuUnixSeconds('2026-08-10T00:00:00.000Z')).toBe('1786320000');
    expect(feishuUnixSeconds('1786320000000')).toBe('1786320000');
    expect(normalizeFeishuTimestamp('1786320000')).toBe('2026-08-10T00:00:00.000Z');
    expect(normalizeFeishuTimestamp('1786320000000')).toBe('2026-08-10T00:00:00.000Z');
  });

  it('从嵌套响应提取真实飞书错误，不被外层成功码或通用错误覆盖', () => {
    expect(extractFeishuErrorDetails({
      code: 0,
      message: 'request failed',
      response: {
        status: 400,
        data: { code: 230027, msg: 'permission approval required', request_id: 'req-nested-1' },
      },
    })).toEqual({
      code: '230027',
      codeState: 'error',
      statusCode: 400,
      message: 'permission approval required',
      requestId: 'req-nested-1',
    });
  });

  it('中央分类只把真实传输 Error 识别为 transient，非法响应 code 仍 fail-closed', () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const timeoutCause = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });
    const caused = Object.assign(new Error('request failed'), { cause: timeoutCause });
    const fetchFailed = new TypeError('fetch failed');
    const aborted = Object.assign(new Error('request aborted'), { name: 'AbortError' });
    const responseLikeReset = { code: 'ECONNRESET' };
    const malicious = { code: ' access_token=should-not-appear ' };
    const longCode = { code: '9'.repeat(80) };

    for (const error of [reset, caused, fetchFailed, aborted]) {
      expect(feishuApiErrorCategoryOf(error)).toBe('transient');
      expect(isFeishuRetryableError(error)).toBe(true);
      expect(isFeishuBusinessError(error)).toBe(false);
      expect(isFeishuDetailBlockingError(error)).toBe(true);
      expect(feishuErrorDiagnostic(error)).toBe('FEISHU_API_ERROR code=UNKNOWN category=transient');
    }
    expect(feishuApiErrorCategoryOf(responseLikeReset)).toBe('business');
    expect(isFeishuRetryableError(responseLikeReset)).toBe(false);
    expect(isFeishuBusinessError(responseLikeReset)).toBe(true);
    expect(isFeishuDetailBlockingError(responseLikeReset)).toBe(true);
    expect(feishuErrorDiagnostic(responseLikeReset)).toBe('FEISHU_API_ERROR code=UNKNOWN category=business');
    for (const response of [malicious, longCode]) {
      expect(feishuApiErrorCategoryOf(response)).toBe('business');
      expect(isFeishuRetryableError(response)).toBe(false);
      expect(isFeishuBusinessError(response)).toBe(true);
      expect(isFeishuDetailBlockingError(response)).toBe(true);
      expect(feishuErrorDiagnostic(response)).not.toContain('access_token');
      expect(extractFeishuErrorDetails(response).message).not.toContain('access_token');
    }

    expect(feishuApiErrorCategoryOf(Object.assign(new Error('rate limited'), { code: 99991400 }))).toBe('rate_limit');
    expect(isFeishuRetryableError(Object.assign(new Error('rate limited'), { code: 99991400 }))).toBe(true);
    expect(feishuApiErrorCategoryOf(Object.assign(new Error('unauthorized'), { code: 99991663 }))).toBe('authorization');
    expect(feishuApiErrorCategoryOf(Object.assign(new Error('permission denied'), { code: 230027 }))).toBe('permission');
    expect(feishuApiErrorCategoryOf({ statusCode: 503 })).toBe('transient');
    expect(isFeishuRetryableError({ statusCode: 503 })).toBe(true);
  });

  it('exported diagnostic boundary never returns raw plain Error refresh_token or secret canaries', () => {
    const canaries = [
      'refresh_token=synthetic-refresh-token-canary',
      'app_secret=synthetic-app-secret-canary',
      'client_secret: synthetic-client-secret-canary',
    ];
    for (const canary of canaries) {
      const diagnostic = feishuErrorDiagnostic(new Error(`provider failed: ${canary}`));
      expect(diagnostic).toBe('FEISHU_API_ERROR code=UNKNOWN category=business');
      expect(diagnostic).not.toContain(canary);
    }
    expect(feishuErrorDiagnostic('opaque refresh_token=synthetic-string-canary')).toBe('FEISHU_API_ERROR code=UNKNOWN category=business');
  });

  it('OpenAPI 业务码只接受可规范化的安全整数', () => {
    expect(extractFeishuErrorDetails({ code: 0 })).toMatchObject({ code: null, codeState: 'success' });
    expect(extractFeishuErrorDetails({ code: '0' })).toMatchObject({ code: null, codeState: 'success' });
    expect(extractFeishuErrorDetails({ code: '000230027' })).toMatchObject({ code: '230027', codeState: 'error' });
    expect(extractFeishuErrorDetails({})).toMatchObject({ code: null, codeState: 'missing' });
    expect(extractFeishuErrorDetails({ code: ' access_token=should-not-appear ' })).toMatchObject({ code: null, codeState: 'invalid' });
    expect(extractFeishuErrorDetails({ code: '9'.repeat(80) })).toMatchObject({ code: null, codeState: 'invalid' });
  });

  it('HTTP 200 业务错误在读取列表数据前统一失败，且诊断不包含飞书原始说明', async () => {
    let chatCalls = 0;
    let messageCalls = 0;
    const messageResponses = [
      { code: 230027, statusCode: 503, msg: '不透明本地化说明', request_id: 'req-message-app', data: { items: [], has_more: false } },
      { code: 99991400, msg: 'opaque', request_id: 'req-message-auto', data: { items: [], has_more: false } },
      { code: 230027, request_id: 'req-message-owner', data: { items: [], has_more: false } },
    ];
    const fakeClient = {
      im: {
        v1: {
          chat: {
            list: async () => chatCalls++ === 0
              ? { code: 0, data: { items: [{ chat_id: 'chat-1' }], has_more: true, page_token: 'chat-page-2' } }
              : { code: 230027, msg: 'permission approval required', request_id: 'req-chat-2', data: { items: [], has_more: false } },
          },
          message: {
            list: async () => messageResponses[messageCalls++],
          },
        },
      },
    };
    const vault = new Vault();
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: fakeClient as never });

    await expect(adapter.listChats()).rejects.toMatchObject({
      errorCode: 'FEISHU_API_ERROR',
      code: 230027,
      category: 'permission',
      requestId: 'req-chat-2',
      retryable: false,
      message: 'FEISHU_API_ERROR code=230027 category=permission request_id=req-chat-2',
    });
    expect(chatCalls).toBe(2);
    await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'app' })).rejects.toMatchObject({
      errorCode: 'FEISHU_API_ERROR',
      code: 230027,
      category: 'permission',
      requestId: 'req-message-app',
      retryable: false,
    });
    await expect(adapter.listMessages({ chatId: 'group-allowed' })).rejects.toMatchObject({
      errorCode: 'FEISHU_API_ERROR',
      code: 99991400,
      category: 'rate_limit',
      requestId: 'req-message-auto',
      retryable: true,
      message: 'FEISHU_API_ERROR code=99991400 category=rate_limit request_id=req-message-auto',
    });
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'user-token');
    await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'owner' })).rejects.toMatchObject({
      errorCode: 'FEISHU_API_ERROR',
      code: 230027,
      category: 'permission',
      requestId: 'req-message-owner',
    });
  });

  it('未知或非法业务码不依赖 msg 分类，也不会进入错误摘要', async () => {
    const responses = [
      { code: 777777, msg: 'permission denied', request_id: 'req-unknown' },
      { code: 888888, statusCode: 503, msg: 'permission denied', request_id: 'req-transient' },
      { code: ' access_token=should-not-appear ', msg: 'permission denied', request_id: 'req-malicious' },
      { code: '9'.repeat(80), msg: 'rate limit exceeded', request_id: 'req-long' },
    ];
    let calls = 0;
    const adapter = new LiveFeishuAdapter(config(), { client: {
      im: { v1: { message: { list: async () => responses[calls++] } } },
    } as never });

    await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'app' })).rejects.toMatchObject({
      code: 777777,
      category: 'business',
      message: 'FEISHU_API_ERROR code=777777 category=business request_id=req-unknown',
    });
    await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'app' })).rejects.toMatchObject({
      code: 888888,
      category: 'transient',
      retryable: true,
      message: 'FEISHU_API_ERROR code=888888 category=transient request_id=req-transient',
    });
    await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'app' })).rejects.toMatchObject({
      code: undefined,
      category: 'business',
      message: 'FEISHU_API_ERROR code=UNKNOWN category=business request_id=req-malicious',
    });
    await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'app' })).rejects.toMatchObject({
      code: undefined,
      category: 'business',
      message: 'FEISHU_API_ERROR code=UNKNOWN category=business request_id=req-long',
    });
  });

  it('提取供应商错误时使用统一文本脱敏', () => {
    const details = extractFeishuErrorDetails({
      response: {
        status: 401,
        data: {
          code: 99991663,
          msg: 'Authorization: Bearer synthetic-feishu-bearer-32 callback https://example.invalid/cb?code=synthetic-feishu-query-32',
        },
      },
    });
    expect(details.message).not.toContain('synthetic-feishu-bearer-32');
    expect(details.message).not.toContain('synthetic-feishu-query-32');
    expect(details.message).toContain('<redacted>');
    expect(details.message).toContain('<url>');
  });

  it('OAuth 授权地址不包含密钥或不匹配的 PKCE 参数，且 refresh token 轮换走原子 vault', async () => {
    const vault = new Vault();
    let exchangeInput: { codeVerifier?: string; redirectUri?: string } | undefined;
    const fakeClient = {
      accessToken: {
        retrieveByAuthorizationCode: async (input: { codeVerifier?: string; redirectUri?: string }) => {
          exchangeInput = input;
          return { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 };
        },
        refresh: async () => ({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 3600 }),
      },
    };
    const tested = new LiveFeishuAdapter(config(), { tokenVault: vault, client: fakeClient as never });
    const state = '11111111-1111-4111-8111-111111111111';
    const url = await tested.buildAuthorizationUrl(state);
    expect(url).toContain('client_id=app-test');
    expect(url).toContain('state=' + state);
    expect(url).not.toContain('code_challenge=');
    expect(url).not.toContain('code_challenge_method=');
    expect(url).toContain('accounts.feishu.cn');
    expect(new URL(url).searchParams.get('scope')?.split(' ')).toContain('offline_access');
    expect(url).not.toContain('secret-test');
    await tested.exchangeCode('code-1', state);
    expect(exchangeInput?.codeVerifier).toBeUndefined();
    expect(exchangeInput?.redirectUri).toBe('http://127.0.0.1:4311/oauth/feishu/callback');
    expect(vault.values.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-1');
    await tested.refreshToken();
    expect(vault.values.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-2');
    expect(vault.values.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-2');
  });

  it('没有 atomic generation/CAS 的旧 vault 会 fail-closed，不覆盖任何 token', async () => {
    const vault = new LegacyVault();
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: {
      accessToken: { retrieveByAuthorizationCode: async () => ({ accessToken: 'should-not-save', refreshToken: 'should-not-save', expiresIn: 3600 }) },
    } as never });
    const state = '44444444-4444-4444-8444-444444444444';
    await adapter.buildAuthorizationUrl(state);
    await expect(adapter.exchangeCode('code', state)).rejects.toThrow('generation/CAS');
    expect(vault.values.size).toBe(0);
  });

  it('OAuth scope 省略保留旧值，显式空值清空本地门禁，具体值替换旧值', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_GRANTED_SCOPES', 'old:scope');
    let refreshCount = 0;
    const tested = new LiveFeishuAdapter(config(), { tokenVault: vault, client: {
      accessToken: {
        retrieveByAuthorizationCode: async () => ({ accessToken: 'access-exchange', refreshToken: 'refresh-exchange', expiresIn: 3600, scope: '' }),
        refresh: async () => ({ accessToken: `access-refresh-${++refreshCount}`, refreshToken: `refresh-refresh-${refreshCount}`, expiresIn: 3600 }),
      },
    } as never });
    const state = '33333333-3333-4333-8333-333333333333';
    await tested.buildAuthorizationUrl(state);
    await tested.exchangeCode('code', state);
    expect(await tested.getGrantedScopeUpdate()).toEqual({ kind: 'set', scopes: [] });
    await tested.refreshToken();
    expect(await tested.getGrantedScopes()).toEqual([]);
    await vault.set('FEISHU_GRANTED_SCOPES', 'old:scope');
    await tested.refreshToken();
    expect(await tested.getGrantedScopes()).toEqual(['old:scope']);
  });

  it('同一 vault 与身份的并发 refresh 只调用一次 provider，并保留轮换 token', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    let resolveRefresh!: (value: { accessToken: string; refreshToken: string; expiresIn: number }) => void;
    const pending = new Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>((resolve) => { resolveRefresh = resolve; });
    let calls = 0;
    const tested = new LiveFeishuAdapter(config(), { tokenVault: vault, client: {
      accessToken: { refresh: async () => { calls += 1; return pending; } },
    } as never });
    const first = tested.refreshToken();
    const second = tested.refreshToken();
    await vi.waitFor(() => expect(calls).toBe(1));
    resolveRefresh({ accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600 });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(await vault.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-new');
    expect(await vault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-new');
  });

  it('两个独立 vault/adapter 实例共享目录时只发生一次 provider 交换', async () => {
    const sharedState: SharedVaultState = { values: new Map(), generation: 0, leases: new Map(), leaseTail: Promise.resolve() };
    const firstVault = new Vault(sharedState);
    const secondVault = new Vault(sharedState);
    await firstVault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    let resolveRefresh!: (value: { accessToken: string; refreshToken: string; expiresIn: number }) => void;
    const pending = new Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>((resolve) => { resolveRefresh = resolve; });
    let calls = 0;
    const client = { accessToken: { refresh: async () => { calls += 1; return pending; } } } as never;
    const first = new LiveFeishuAdapter(config(), { tokenVault: firstVault, client });
    const second = new LiveFeishuAdapter(config(), { tokenVault: secondVault, client });
    const firstRefresh = first.refreshToken();
    await vi.waitFor(() => expect(calls).toBe(1));
    const secondRefresh = second.refreshToken();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    resolveRefresh({ accessToken: 'access-new', refreshToken: 'refresh-rotated', expiresIn: 3600 });
    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toHaveLength(2);
    expect(await firstVault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-rotated');
    expect(await secondVault.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-new');
  });

  it('provider_started 过期 lease 进入 recovery_required，迟到响应不能写入或触发第二次 provider', async () => {
    const sharedState: SharedVaultState = { values: new Map(), generation: 0, leases: new Map(), leaseTail: Promise.resolve() };
    const firstVault = new Vault(sharedState);
    const secondVault = new Vault(sharedState);
    await firstVault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    let resolveFirst!: (value: { accessToken: string; refreshToken: string; expiresIn: number }) => void;
    const firstPending = new Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>((resolve) => { resolveFirst = resolve; });
    let calls = 0;
    const client = { accessToken: { refresh: async () => { calls += 1; return firstPending; } } } as never;
    const first = new LiveFeishuAdapter(config(), { tokenVault: firstVault, client });
    const second = new LiveFeishuAdapter(config(), { tokenVault: secondVault, client });
    const stale = first.refreshToken();
    await vi.waitFor(() => expect(calls).toBe(1));
    const active = sharedState.leases.get('owner:primary');
    if (!active) throw new Error('missing active lease');
    active.expiresAt = Date.now() - 1;
    active.ownerPid = 999999;
    const winner = second.refreshToken();
    await expect(winner).rejects.toThrow('状态不确定');
    expect(calls).toBe(1);
    resolveFirst({ accessToken: 'access-stale', refreshToken: 'refresh-stale', expiresIn: 3600 });
    await expect(stale).rejects.toThrow('lease');
    expect(await secondVault.get('FEISHU_USER_ACCESS_TOKEN')).toBeNull();
    expect(await secondVault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-old');
    expect(calls).toBe(1);
  });

  it('重新授权写入新 generation/fingerprint 后可恢复一次，旧 provider 响应仍被拒绝', async () => {
    const sharedState: SharedVaultState = { values: new Map(), generation: 0, leases: new Map(), leaseTail: Promise.resolve() };
    const firstVault = new Vault(sharedState);
    const secondVault = new Vault(sharedState);
    await firstVault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    let resolveFirst!: (value: { accessToken: string; refreshToken: string; expiresIn: number }) => void;
    const firstPending = new Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>((resolve) => { resolveFirst = resolve; });
    let calls = 0;
    const client = { accessToken: { refresh: async () => {
      calls += 1;
      if (calls === 1) return firstPending;
      return { accessToken: 'access-new', refreshToken: 'refresh-rotated', expiresIn: 3600 };
    } } } as never;
    const first = new LiveFeishuAdapter(config(), { tokenVault: firstVault, client });
    const second = new LiveFeishuAdapter(config(), { tokenVault: secondVault, client });
    const stale = first.refreshToken();
    await vi.waitFor(() => expect(calls).toBe(1));
    const active = sharedState.leases.get('owner:primary');
    if (!active) throw new Error('missing active lease');
    active.expiresAt = Date.now() - 1;
    active.ownerPid = 999999;
    await expect(second.refreshToken()).rejects.toThrow('状态不确定');
    expect(calls).toBe(1);

    await secondVault.set('FEISHU_REFRESH_TOKEN', 'refresh-reauthorized');
    await expect(second.refreshToken()).resolves.toBeDefined();
    expect(calls).toBe(2);
    expect(await secondVault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-rotated');
    expect(await secondVault.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-new');

    resolveFirst({ accessToken: 'access-stale', refreshToken: 'refresh-stale', expiresIn: 3600 });
    await expect(stale).rejects.toThrow('lease');
    expect(calls).toBe(2);
    expect(await secondVault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-rotated');
    expect(await secondVault.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-new');
  });

  it('不确定 transport failure 将 lease 固定为 recovery_required，后续调用不重复旋转 token', async () => {
    const state: SharedVaultState = { values: new Map(), generation: 0, leases: new Map(), leaseTail: Promise.resolve() };
    const firstVault = new Vault(state);
    const secondVault = new Vault(state);
    await firstVault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    let calls = 0;
    const client = { accessToken: { refresh: async () => {
      calls += 1;
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    } } } as never;
    const first = new LiveFeishuAdapter(config(), { tokenVault: firstVault, client });
    const second = new LiveFeishuAdapter(config(), { tokenVault: secondVault, client });

    await expect(first.refreshToken()).rejects.toThrow('socket hang up');
    expect(calls).toBe(1);
    expect(state.leases.get('owner:primary')?.phase).toBe('recovery_required');
    await expect(second.refreshToken()).rejects.toThrow('状态不确定');
    expect(calls).toBe(1);
    expect(await secondVault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-old');
  });

  it('recovery_required rejects empty and whitespace refresh credentials without provider calls or lease replacement', async () => {
    const refreshToken = 'refresh-old';
    const state: SharedVaultState = {
      values: new Map([['FEISHU_REFRESH_TOKEN', refreshToken]]),
      generation: 1,
      leases: new Map([['owner:primary', {
        status: 'failed',
        phase: 'recovery_required',
        leaseId: 'lease-old',
        ownerId: 'owner-old',
        ownerPid: 999999,
        fencingToken: 7,
        generation: 1,
        tokenFingerprint: createHash('sha256').update(refreshToken, 'utf8').digest('hex'),
        expiresAt: Date.now() + 60_000,
        resultExpiresAt: null,
      }]]),
      leaseTail: Promise.resolve(),
    };
    const vault = new Vault(state);
    let calls = 0;
    const client = { accessToken: { refresh: async () => { calls += 1; return { accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600 }; } } } as never;
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client });
    const beforeLease = JSON.stringify([...state.leases.entries()]);

    await vault.set('FEISHU_REFRESH_TOKEN', '');
    await expect(adapter.refreshToken()).rejects.toThrow('状态不确定');
    expect(calls).toBe(0);
    expect(JSON.stringify([...state.leases.entries()])).toBe(beforeLease);

    await vault.set('FEISHU_REFRESH_TOKEN', '   ');
    await expect(adapter.refreshToken()).rejects.toThrow('状态不确定');
    expect(calls).toBe(0);
    expect(JSON.stringify([...state.leases.entries()])).toBe(beforeLease);
  });

  it('recovery_required rejects each blank or unrelated config change without provider calls', async () => {
    const scenarios = [
      { name: 'empty refresh token', key: 'FEISHU_REFRESH_TOKEN', value: '' },
      { name: 'space-only refresh token', key: 'FEISHU_REFRESH_TOKEN', value: ' ' },
      { name: 'tab-only refresh token', key: 'FEISHU_REFRESH_TOKEN', value: '\t' },
      { name: 'newline-only refresh token', key: 'FEISHU_REFRESH_TOKEN', value: '\n' },
      { name: 'access token only', key: 'FEISHU_USER_ACCESS_TOKEN', value: 'access-unrelated' },
      { name: 'scope only', key: 'FEISHU_GRANTED_SCOPES', value: 'scope:unrelated' },
      { name: 'expiry only', key: 'FEISHU_TOKEN_EXPIRES_AT', value: '2026-08-18T00:00:00.000Z' },
      { name: 'app secret only', key: 'FEISHU_APP_SECRET', value: 'app-secret-unrelated' },
    ] as const;

    for (const scenario of scenarios) {
      const refreshToken = 'refresh-old';
      const state: SharedVaultState = {
        values: new Map([
          ['FEISHU_REFRESH_TOKEN', refreshToken],
          ['FEISHU_USER_ACCESS_TOKEN', 'access-old'],
          ['FEISHU_GRANTED_SCOPES', 'scope:old'],
          ['FEISHU_TOKEN_EXPIRES_AT', '2026-08-17T00:00:00.000Z'],
          ['FEISHU_APP_SECRET', 'app-secret-old'],
        ]),
        generation: 1,
        leases: new Map([['owner:primary', {
          status: 'failed',
          phase: 'recovery_required',
          leaseId: 'lease-old',
          ownerId: 'owner-old',
          ownerPid: 999999,
          fencingToken: 7,
          generation: 1,
          tokenFingerprint: createHash('sha256').update(refreshToken, 'utf8').digest('hex'),
          expiresAt: Date.now() + 60_000,
          resultExpiresAt: null,
        }]]),
        leaseTail: Promise.resolve(),
      };
      const vault = new Vault(state);
      let calls = 0;
      const client = { accessToken: { refresh: async () => {
        calls += 1;
        return { accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600 };
      } } } as never;
      const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client });
      const beforeLease = JSON.stringify([...state.leases.entries()]);
      const beforeRecord = state.leases.get('owner:primary');
      const beforeFingerprint = beforeRecord?.tokenFingerprint;
      await vault.set(scenario.key, scenario.value);

      await expect(adapter.refreshToken(), scenario.name).rejects.toThrow('状态不确定');
      expect(calls, scenario.name).toBe(0);
      expect(JSON.stringify([...state.leases.entries()]), scenario.name).toBe(beforeLease);
      expect(state.leases.get('owner:primary')?.status, scenario.name).toBe('failed');
      expect(state.leases.get('owner:primary')?.phase, scenario.name).toBe('recovery_required');
      expect(state.leases.get('owner:primary')?.fencingToken, scenario.name).toBe(7);
      expect(state.leases.get('owner:primary')?.tokenFingerprint, scenario.name).toBe(beforeFingerprint);
      expect(state.generation, scenario.name).toBe(2);
      expect(vault.values.get('FEISHU_REFRESH_TOKEN'), scenario.name).toBe(
        scenario.key === 'FEISHU_REFRESH_TOKEN' ? scenario.value : refreshToken,
      );
    }
  });

  it.each([
    {
      name: 'HTTP 5xx transient',
      error: () => new FeishuApiError({ code: null, codeState: 'missing', statusCode: 503, message: 'synthetic 5xx', requestId: null }),
    },
    {
      name: 'rate limit',
      error: () => new FeishuApiError({ code: '99991400', codeState: 'error', statusCode: null, message: 'synthetic rate limit', requestId: null }),
    },
    {
      name: 'authorization',
      error: () => new FeishuApiError({ code: '99991663', codeState: 'error', statusCode: null, message: 'synthetic authorization failure', requestId: null }),
    },
    {
      name: 'business',
      error: () => new FeishuApiError({ code: '123456', codeState: 'error', statusCode: null, message: 'synthetic business failure', requestId: null }),
    },
    {
      name: 'plain error',
      error: () => new Error('synthetic provider failure'),
    },
    {
      name: 'transport error',
      error: () => Object.assign(new Error('synthetic socket failure'), { code: 'ECONNRESET' }),
    },
  ])('provider_started $name is recovery_required and cannot call provider twice', async ({ error }) => {
    const state: SharedVaultState = { values: new Map(), generation: 0, leases: new Map(), leaseTail: Promise.resolve() };
    const firstVault = new Vault(state);
    const secondVault = new Vault(state);
    await firstVault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    let calls = 0;
    const client = { accessToken: { refresh: async () => {
      calls += 1;
      throw error();
    } } } as never;
    const first = new LiveFeishuAdapter(config(), { tokenVault: firstVault, client });
    const second = new LiveFeishuAdapter(config(), { tokenVault: secondVault, client });
    const valuesBefore = [...state.values.entries()];
    const generationBefore = state.generation;

    await expect(first.refreshToken()).rejects.toThrow();
    expect(calls).toBe(1);
    expect(state.leases.get('owner:primary')?.status).toBe('failed');
    expect(state.leases.get('owner:primary')?.phase).toBe('recovery_required');
    const leaseAfterFirst = JSON.stringify([...state.leases.entries()]);

    await expect(second.refreshToken()).rejects.toThrow('状态不确定');
    expect(calls).toBe(1);
    expect([...state.values.entries()]).toEqual(valuesBefore);
    expect(state.generation).toBe(generationBefore);
    expect(JSON.stringify([...state.leases.entries()])).toBe(leaseAfterFirst);
  });

  it('provider 调用前失去 lease 可标记 retryable_failed，下一次可受控重试', async () => {
    const state: SharedVaultState = { values: new Map(), generation: 0, leases: new Map(), leaseTail: Promise.resolve() };
    const vault = new BeforeProviderFailureVault(state);
    await vault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    let calls = 0;
    const client = { accessToken: { refresh: async () => {
      calls += 1;
      return { accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600 };
    } } } as never;
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client });

    await expect(adapter.refreshToken()).rejects.toThrow('lease');
    expect(calls).toBe(0);
    expect(state.leases.get('owner:primary')?.phase).toBe('retryable_failed');
    await expect(adapter.refreshToken()).resolves.toBeDefined();
    expect(calls).toBe(1);
    expect(await vault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-new');
  });

  it('refresh 使用同一原子快照取得 generation 与 refresh token，CAS 失败不吞掉赢家 token', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    vault.beforeSnapshotReturn = async () => {
      await vault.setManyAtomic({ FEISHU_REFRESH_TOKEN: 'refresh-winner' }, vault.generation);
    };
    let presentedRefresh = '';
    const tested = new LiveFeishuAdapter(config(), { tokenVault: vault, client: {
      accessToken: {
        refresh: async ({ refreshToken }: { refreshToken: string }) => {
          presentedRefresh = refreshToken;
          return { accessToken: 'access-stale', refreshToken: 'refresh-stale', expiresIn: 3600 };
        },
      },
    } as never });

    await expect(tested.refreshToken()).rejects.toThrow('刷新结果未写入');
    expect(presentedRefresh).toBe('refresh-old');
    expect(await vault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-winner');
    expect(await vault.get('FEISHU_USER_ACCESS_TOKEN')).toBeNull();
  });

  it('迟到的 OAuth exchange 响应不能读取新 generation 后覆盖更晚的 refresh token', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => { markExchangeStarted = resolve; });
    let resolveExchange!: (value: { accessToken: string; refreshToken: string; expiresIn: number }) => void;
    const exchangeResponse = new Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>((resolve) => { resolveExchange = resolve; });
    const tested = new LiveFeishuAdapter(config(), { tokenVault: vault, client: {
      accessToken: {
        retrieveByAuthorizationCode: async () => {
          markExchangeStarted();
          return exchangeResponse;
        },
        refresh: async () => ({ accessToken: 'access-newer', refreshToken: 'refresh-newer', expiresIn: 3600 }),
      },
    } as never });
    const state = '55555555-5555-4555-8555-555555555555';
    await tested.buildAuthorizationUrl(state);
    const exchange = tested.exchangeCode('stale-code', state);
    await exchangeStarted;
    const rejectedExchange = expect(exchange).rejects.toThrow();

    await tested.refreshToken();
    resolveExchange({ accessToken: 'access-stale', refreshToken: 'refresh-stale', expiresIn: 3600 });

    await rejectedExchange;
    expect(await vault.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-newer');
    expect(await vault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-newer');
  });

  it('OAuth state 只能使用一次，且新授权会废弃旧浏览器页', async () => {
    let exchanges = 0;
    const fakeClient = {
      accessToken: {
        retrieveByAuthorizationCode: async () => {
          exchanges += 1;
          return { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 };
        },
      },
    };
    const tested = new LiveFeishuAdapter(config(), { tokenVault: new Vault(), client: fakeClient as never });
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    await tested.buildAuthorizationUrl(first);
    await tested.buildAuthorizationUrl(second);
    await expect(tested.exchangeCode('old-code', first)).rejects.toThrow('状态已失效');
    await tested.exchangeCode('new-code', second);
    await expect(tested.exchangeCode('replayed-code', second)).rejects.toThrow('状态已失效');
    expect(exchanges).toBe(1);
  });

  it('刷新 Token 未返回 scope 时保留已验证的旧 scope', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    await vault.set('FEISHU_GRANTED_SCOPES', 'im:chat:read im:message:readonly');
    const fakeClient = {
      accessToken: {
        refresh: async () => ({ accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600 }),
      },
    };
    const tested = new LiveFeishuAdapter(config(), { tokenVault: vault, client: fakeClient as never });

    await tested.refreshToken();

    expect(await tested.getGrantedScopes()).toEqual(['im:chat:read', 'im:message:readonly']);
    expect(await vault.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-new');
    expect(await vault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-new');
  });

  it('用户接口收到 99991663 时只刷新一次并重试成功', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'access-old');
    await vault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    let requests = 0;
    let refreshes = 0;
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: {
      accessToken: { refresh: async () => {
        refreshes += 1;
        return { accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600 };
      } },
      im: { v1: { message: { list: async () => ++requests === 1
        ? { code: 99991663, msg: '本地化说明' }
        : { code: 0, data: { items: [{ message_id: 'm-after-refresh' }], has_more: false } },
      } } },
    } as never });

    await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'owner' })).resolves.toMatchObject({
      items: [{ message_id: 'm-after-refresh' }],
    });
    expect({ requests, refreshes }).toEqual({ requests: 2, refreshes: 1 });
    expect(await vault.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-new');
    expect(await vault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-new');
  });

  it('用户接口刷新失败时直接返回刷新错误，不循环请求', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'access-old');
    await vault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    const before = [...vault.values.entries()];
    let requests = 0;
    let refreshes = 0;
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: {
      accessToken: { refresh: async () => {
        refreshes += 1;
        throw Object.assign(new Error('refresh rejected'), { code: 99991664 });
      } },
      im: { v1: { message: { list: async () => {
        requests += 1;
        return { code: 99991664 };
      } } } },
    } as never });

    await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'owner' })).rejects.toMatchObject({
      name: 'FeishuAuthError',
      diagnostic: { stage: 'token_refresh', category: 'authorization', code: '99991664' },
    });
    expect({ requests, refreshes }).toEqual({ requests: 1, refreshes: 1 });
    expect([...vault.values.entries()]).toEqual(before);
  });

  it('刷新后仍未授权时返回第二次错误，不再次刷新', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'access-old');
    await vault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
    let requests = 0;
    let refreshes = 0;
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: {
      accessToken: { refresh: async () => {
        refreshes += 1;
        return { accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600 };
      } },
      im: { v1: { message: { list: async () => ({ code: ++requests === 1 ? 99991663 : 99991664 }) } } },
    } as never });

    await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'owner' })).rejects.toMatchObject({
      name: 'FeishuApiError',
      code: 99991664,
      category: 'authorization',
    });
    expect({ requests, refreshes }).toEqual({ requests: 2, refreshes: 1 });
    expect(await vault.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-new');
    expect(await vault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-new');
  });

  it('即将过期时预刷新已消耗预算，后续未授权不再请求或刷新', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-14T12:00:00.000Z'));
    try {
      const vault = new Vault();
      await vault.set('FEISHU_USER_ACCESS_TOKEN', 'access-old');
      await vault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
      await vault.set('FEISHU_TOKEN_EXPIRES_AT', '2026-08-14T12:00:30.000Z');
      await vault.set('FEISHU_GRANTED_SCOPES', 'im:message:readonly');
      let requests = 0;
      let refreshes = 0;
      const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: {
        accessToken: { refresh: async () => {
          refreshes += 1;
          return { accessToken: 'access-new', refreshToken: 'refresh-new', expiresIn: 3600 };
        } },
        im: { v1: { message: { list: async () => {
          requests += 1;
          return { code: 99991664 };
        } } } },
      } as never });

      await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'owner' })).rejects.toMatchObject({
        name: 'FeishuApiError',
        code: 99991664,
        category: 'authorization',
      });
      expect({ requests, refreshes }).toEqual({ requests: 1, refreshes: 1 });
      expect(await vault.get('FEISHU_USER_ACCESS_TOKEN')).toBe('access-new');
      expect(await vault.get('FEISHU_REFRESH_TOKEN')).toBe('refresh-new');
      expect(await vault.get('FEISHU_TOKEN_EXPIRES_AT')).toBe('2026-08-14T13:00:00.000Z');
      expect(await vault.get('FEISHU_GRANTED_SCOPES')).toBe('im:message:readonly');
    } finally {
      now.mockRestore();
    }
  });

  it('即将过期时预刷新失败，不调用 API 且旧 vault 完全不变', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-14T12:00:00.000Z'));
    try {
      const vault = new Vault();
      await vault.set('FEISHU_USER_ACCESS_TOKEN', 'access-old');
      await vault.set('FEISHU_REFRESH_TOKEN', 'refresh-old');
      await vault.set('FEISHU_TOKEN_EXPIRES_AT', '2026-08-14T12:00:30.000Z');
      await vault.set('FEISHU_GRANTED_SCOPES', 'im:message:readonly');
      const before = [...vault.values.entries()];
      let requests = 0;
      let refreshes = 0;
      const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: {
        accessToken: { refresh: async () => {
          refreshes += 1;
          throw Object.assign(new Error('refresh rejected'), { code: 99991664 });
        } },
        im: { v1: { message: { list: async () => {
          requests += 1;
          return { code: 0, data: { items: [], has_more: false } };
        } } } },
      } as never });

      await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'owner' })).rejects.toMatchObject({
        name: 'FeishuAuthError',
        diagnostic: { stage: 'token_refresh', category: 'authorization', code: '99991664' },
      });
      expect({ requests, refreshes }).toEqual({ requests: 0, refreshes: 1 });
      expect([...vault.values.entries()]).toEqual(before);
    } finally {
      now.mockRestore();
    }
  });

  it('过期 OAuth state 在本机拒绝，不会调用飞书换 Token', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    let exchanges = 0;
    const fakeClient = {
      accessToken: {
        retrieveByAuthorizationCode: async () => {
          exchanges += 1;
          return { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 };
        },
      },
    };
    try {
      const tested = new LiveFeishuAdapter(config(), { tokenVault: new Vault(), client: fakeClient as never });
      const state = '33333333-3333-4333-8333-333333333333';
      await tested.buildAuthorizationUrl(state);
      now.mockReturnValue(1_000_000 + 11 * 60 * 1000);
      await expect(tested.exchangeCode('expired-code', state)).rejects.toThrow('状态已失效');
      expect(exchanges).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it('主人会话历史强制使用用户 OAuth，机器人补充扫描保留应用身份', async () => {
    const vault = new Vault();
    const getRequests: unknown[] = [];
    const listRequests: Array<{ request: any; options: unknown }> = [];
    const fakeClient = {
      im: {
        v1: {
          message: {
            list: async (request: unknown, options: unknown) => { listRequests.push({ request, options }); return { data: { items: [{ message_id: 'm1' }], has_more: true, page_token: 'next' } }; },
            search: async () => ({ data: { items: [{ id: 's1' }], has_more: false } }),
            get: async (request: unknown) => { getRequests.push(request); return { data: { items: [{ message_id: 'm1' }] } }; },
          },
        },
      },
    };
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: fakeClient as never });
    await adapter.listMessages({ chatId: 'group-bot', authMode: 'app' });
    expect(listRequests[0]?.options).toBeUndefined();
    await expect(adapter.listMessages({ chatId: 'group-allowed', authMode: 'owner' })).rejects.toThrow('用户 OAuth');
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'user-token');
    const page = await adapter.listMessages({ chatId: 'group-allowed', startTime: '1786320000', endTime: '1786323600', sortType: 'asc', pageSize: 99, pageToken: 'cursor-1', authMode: 'owner' }) as { items: unknown[]; page_token: string };
    expect(page.items).toHaveLength(1);
    expect(page.page_token).toBe('next');
    expect(listRequests[1]?.request.params).toMatchObject({
      container_id_type: 'chat',
      container_id: 'group-allowed',
      start_time: '1786320000',
      end_time: '1786323600',
      sort_type: 'ByCreateTimeAsc',
      page_size: 50,
      page_token: 'cursor-1',
      with_sender_name: true,
    });
    expect(listRequests[1]?.options).toBeTruthy();
    const search = await adapter.searchMessages({ query: '数据' }) as { items: unknown[] };
    expect(search.items).toHaveLength(1);
    await adapter.getMessage('m1');
    expect((getRequests[0] as any).params).toMatchObject({ user_id_type: 'open_id', with_sender_name: true });
  });

  it('按最近私聊或姓名发现人员，并用 open_id 解析现有 P2P 会话', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'user-token');
    const chatRequests: Array<{ request: any; options: unknown }> = [];
    const rawRequests: Array<{ request: any; options: unknown }> = [];
    const fakeClient = {
      im: { v1: { chat: { list: async (request: unknown, options: unknown) => {
        chatRequests.push({ request, options });
        return { data: { items: [{ chat_id: 'p2p-chat', chat_mode: 'p2p', p2p_target_id: 'person-open' }], has_more: false } };
      } } } },
      request: async (request: any, options: unknown) => {
        rawRequests.push({ request, options });
        if (String(request.url).includes('/contact/v3/users/search')) {
          return { code: 0, data: { items: [{ id: 'person-open', meta_data: { chat_id: 'p2p-chat' } }], has_more: false } };
        }
        return { code: 0, data: { p2p_chats: [{ chat_id: 'p2p-chat' }] } };
      },
    };
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: fakeClient as never });

    expect((await adapter.listOwnerChats({ types: 'p2p', pageSize: 99 }) as { items: unknown[] }).items).toHaveLength(1);
    expect(chatRequests[0]?.request.params).toMatchObject({ types: 'p2p', page_size: 50, sort_type: 'ByActiveTimeDesc', user_id_type: 'open_id' });
    expect(chatRequests[0]?.options).toBeTruthy();

    expect((await adapter.searchOwnerUsers({ query: '张三', hasChatted: true }) as { items: unknown[] }).items).toHaveLength(1);
    expect(rawRequests[0]?.request).toMatchObject({
      method: 'POST',
      url: '/open-apis/contact/v3/users/search',
      params: { page_size: 30 },
      data: { query: '张三', filter: { has_contact: true } },
    });
    await expect(adapter.searchOwnerUsers()).rejects.toThrow('姓名关键词');

    expect(await adapter.resolveP2PChats(['person-open'])).toMatchObject({ p2p_chats: [{ chat_id: 'p2p-chat' }] });
    expect(rawRequests[1]?.request).toMatchObject({
      method: 'POST',
      url: '/open-apis/im/v1/chat_p2p/batch_query',
      params: { chatter_id_type: 'open_id' },
      data: { chatter_ids: ['person-open'] },
    });
    expect(rawRequests.every((item) => Boolean(item.options))).toBe(true);
  });

  it('空白消息搜索在本地被拒绝，主人同步不能再用空关键词冒充全量扫描', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'user-token');
    const requests: unknown[] = [];
    const fakeClient = {
      im: { v1: { message: { search: async (request: unknown) => { requests.push(request); return { data: { items: [], has_more: false } }; } } } },
    };
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: fakeClient as never });
    await expect(adapter.searchMessages()).rejects.toThrow('非空关键词');
    await expect(adapter.searchMessages({ query: '   ' })).rejects.toThrow('非空关键词');
    await expect(adapter.searchOwnerMessages({ scope: 'owner_dm', startTime: '1786320000', endTime: '1786323600' })).rejects.toThrow('不能用空关键词');
    expect(requests).toHaveLength(0);
  });

  it('连接检查区分外部开关、应用凭证和用户授权状态', async () => {
    const fakeClient = {
      auth: { v3: { tenantAccessToken: { internal: async () => ({ code: 0, msg: 'ok', data: { tenant_access_token: 'tenant-token' } }) } } },
    };
    const adapter = new LiveFeishuAdapter(config(), { client: fakeClient as never });
    const result = await adapter.testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('尚未完成用户 OAuth');
  });

  it('租户探针业务错误不得 ready，已批准发送失败不得增加计数', async () => {
    const fakeClient = {
      auth: { v3: { tenantAccessToken: { internal: async () => ({ code: 230027, msg: 'opaque', request_id: 'req-probe' }) } } },
      im: { v1: { message: { create: async () => ({ code: 99991400, msg: 'opaque', request_id: 'req-send' }) } } },
    };
    const adapter = new LiveFeishuAdapter(config(), { client: fakeClient as never });

    await expect(adapter.testConnection()).resolves.toMatchObject({
      ok: false,
      status: 'unavailable',
      details: { category: 'permission', code: '230027' },
    });
    await expect(adapter.sendApproved({ receiveId: 'chat-test', content: 'synthetic' })).rejects.toMatchObject({
      code: 99991400,
      category: 'rate_limit',
      retryable: true,
    });
    expect(adapter.sentCount).toBe(0);
  });

  it('OAuth 换 Token 失败时保留飞书官方错误码，但不暴露凭证', async () => {
    const vault = new Vault();
    const fakeClient = {
      accessToken: {
        retrieveByAuthorizationCode: async () => {
          throw Object.assign(new Error('invalid_grant: authorization code expired'), {
            statusCode: 400,
            code: 99991663,
            error: 'invalid_grant',
            errorDescription: 'authorization code expired',
          });
        },
      },
    };
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: fakeClient as never });
    const state = '22222222-2222-4222-8222-222222222222';
    await adapter.buildAuthorizationUrl(state);
    await expect(adapter.exchangeCode('authorization-code', state)).rejects.toMatchObject({
      name: 'FeishuAuthError',
      diagnostic: { stage: 'token_exchange', category: 'authorization', statusCode: 400, code: '99991663' },
    });
  });

  it('日历和会议纪要读取都要求用户 OAuth，并沿用 SDK 分页接口', async () => {
    const vault = new Vault();
    const calendarDetailRequests: unknown[] = [];
    const minuteRequests: unknown[] = [];
    const fakeClient = {
      calendar: { v4: {
        calendar: { primary: async () => ({ data: { calendars: [{ calendar: { calendar_id: 'cal-1' } }] } }) },
        calendarEvent: {
          list: async () => ({ data: { items: [{ event_id: 'event-1' }], has_more: false } }),
          get: async (request: unknown) => {
            calendarDetailRequests.push(request);
            return { data: { event: { event_id: 'event-1', attendees: [{ attendee_id: 'owner-open' }] } } };
          },
        },
      } },
      minutes: { v1: {
        minute: {
          search: async () => ({ data: { items: [{ token: 'minute-1' }], has_more: false } }),
          get: async (request: unknown) => {
            minuteRequests.push(request);
            return { data: { minute: { token: 'minute-1', owner_id: 'owner-open', title: '需求会' } } };
          },
          artifacts: async (request: unknown) => {
            minuteRequests.push(request);
            return { data: { summary: '讨论留存需求', minute_todos: [{ content: '补齐留存指标' }] } };
          },
        },
        minuteTranscript: { get: async () => ({ getReadableStream: () => undefined }) },
      } },
    };
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: fakeClient as never });
    await expect(adapter.primaryCalendar()).rejects.toThrow('用户 OAuth');
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'user-token');
    expect((await adapter.primaryCalendar()).calendars).toHaveLength(1);
    expect((await adapter.listCalendarEvents({ calendarId: 'cal-1' })).items).toHaveLength(1);
    const calendarDetail = await adapter.getCalendarEvent({ calendarId: 'cal-1', eventId: 'event-1' }) as { event?: { event_id?: string } };
    expect(calendarDetail.event?.event_id).toBe('event-1');
    expect(calendarDetailRequests[0]).toMatchObject({
      path: { calendar_id: 'cal-1', event_id: 'event-1' },
      params: { need_attendee: true, max_attendee_num: 100, user_id_type: 'open_id' },
    });
    expect((await adapter.searchMinutes({ query: '需求' })).items).toHaveLength(1);
    expect(await adapter.getMinute('minute-1')).toMatchObject({ minute: { token: 'minute-1', title: '需求会' } });
    expect(await adapter.getMinuteArtifacts('minute-1')).toMatchObject({ summary: '讨论留存需求', minute_todos: [{ content: '补齐留存指标' }] });
    expect(minuteRequests).toEqual([
      { path: { minute_token: 'minute-1' }, params: { user_id_type: 'open_id' } },
      { path: { minute_token: 'minute-1' } },
    ]);
    expect(await adapter.getMinuteTranscript('minute-1')).toMatchObject({ available: false });
  });

  it('飞书文档与知识库背景固定使用系统主人 user_access_token', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'user-token');
    const requests: Array<{ kind: string; request: unknown; options: unknown }> = [];
    const fakeClient = {
      docx: { v1: { document: {
        get: async (request: unknown, options: unknown) => {
          requests.push({ kind: 'docx.get', request, options });
          return { data: { document: { document_id: 'doc-1', revision_id: 3, title: '需求背景' } } };
        },
        rawContent: async (request: unknown, options: unknown) => {
          requests.push({ kind: 'docx.raw', request, options });
          return { data: { content: '需要验证活动留存。' } };
        },
      } } },
      wiki: { v2: { space: {
        getNode: async (request: unknown, options: unknown) => {
          requests.push({ kind: 'wiki.node', request, options });
          return { data: { node: { node_token: 'wiki-1', obj_type: 'docx', obj_token: 'doc-1' } } };
        },
      } } },
    };
    const tested = new LiveFeishuAdapter(config(), { tokenVault: vault, client: fakeClient as never });
    await expect(tested.getDocxDocument('doc-1')).resolves.toMatchObject({ document: { revision_id: 3 } });
    await expect(tested.getDocxRawContent('doc-1')).resolves.toEqual({ content: '需要验证活动留存。' });
    await expect(tested.getWikiNode('wiki-1')).resolves.toMatchObject({ node: { obj_type: 'docx', obj_token: 'doc-1' } });
    expect(requests.map((item) => item.kind)).toEqual(['docx.get', 'docx.raw', 'wiki.node']);
    expect(requests[0]!.request).toEqual({ path: { document_id: 'doc-1' } });
    expect(requests[1]!.request).toEqual({ path: { document_id: 'doc-1' }, params: { lang: 0 } });
    expect(requests[2]!.request).toEqual({ params: { token: 'wiki-1' } });
    expect(requests.every((item) => Boolean(item.options))).toBe(true);
  });

  it('用户 OAuth 建立系统主人身份，并用 mentions 判断群消息是否 @主人', async () => {
    const vault = new Vault();
    await vault.set('FEISHU_USER_ACCESS_TOKEN', 'user-token');
    const fakeClient = {
      authen: { v1: { userInfo: { get: async () => ({ data: { open_id: 'owner-open', union_id: 'owner-union', user_id: 'owner-user', name: '系统主人', tenant_key: 'tenant-1' } }) } } },
    };
    const adapter = new LiveFeishuAdapter(config(), { tokenVault: vault, client: fakeClient as never });
    await expect(adapter.getCurrentUser()).resolves.toMatchObject({ openId: 'owner-open', name: '系统主人', tenantKey: 'tenant-1' });
    const event = adapter.normalizeMessageRecord({
      message_id: 'mention-1',
      chat_id: 'group-new',
      chat_type: 'group',
      msg_type: 'text',
      create_time: '1786276800000',
      sender: { id: 'requester-1', sender_name: '需求方' },
      mentions: [{ id: { open_id: 'owner-open' } }],
      message_app_link: 'https://example.invalid/open-message',
      update_time: '1786276860000',
      body: { content: JSON.stringify({ text: '@系统主人 请帮忙看一下留存数据。' }) },
    });
    expect(event).toMatchObject({ sourceType: 'group', ownerMentioned: true, discoveryReason: '群聊中提及系统主人', sourceUrl: 'https://example.invalid/open-message' });
    expect(event?.metadata).toMatchObject({ mentionCount: 1, sourceUpdatedAt: '2026-08-09T12:01:00.000Z', deleted: false });
    const deleted = adapter.normalizeMessageRecord({
      message_id: 'mention-deleted', chat_id: 'group-new', chat_type: 'group', deleted: true,
      sender: { id: 'requester-1', sender_name: '需求方' }, create_time: '1786276800000',
    });
    expect(deleted).toMatchObject({ content: '[飞书消息已撤回或删除，正文不再保留]', completeness: 'limited' });
    expect(deleted?.metadata).toMatchObject({ deleted: true, fullBodyAvailable: false });
  });
});
