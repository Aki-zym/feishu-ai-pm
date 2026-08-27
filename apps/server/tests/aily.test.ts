import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AILY_SCAN_INTERVAL_MS, AilyScanScheduler, AilyService, AilyServiceError, ailyTestExports } from '../src/aily.js';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { createCindyAdapters } from '../src/integrations.js';
import { ailySecretKeys, LocalCredentialStore } from '../src/local-credential-store.js';
import { PmService } from '../src/service.js';

function sseText(text: string, status = 'Completed') {
  return [
    'event: start\ndata: {"agent_chat_id":"chat-12345678","session_id":"session-1"}\n\n',
    `event: message_delta\ndata: ${JSON.stringify({ delta: { type: 'content', text } })}\n\n`,
    `event: done\ndata: ${JSON.stringify({ status, finish_reason: 'stop' })}`,
  ].join('');
}

async function* chunks(values: Array<string | Uint8Array>) {
  for (const value of values) yield value;
}

describe('独立 Aily 服务', () => {
  const roots: string[] = [];
  const databases: AppDatabase[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function makeService() {
    const root = await mkdtemp(join(tmpdir(), 'toomanytasks-aily-'));
    roots.push(root);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      CONFIG_ROOT: root,
      AILY_APP_ID: 'cli_test',
      AILY_AGENT_ID: 'agent_test',
      AILY_OAUTH_REDIRECT_URI: 'http://127.0.0.1:4310/oauth/aily/callback',
    });
    const credentials = new LocalCredentialStore(config);
    await credentials.load();
    await credentials.saveConfig({
      appId: 'cli_test',
      agentId: 'agent_test',
      domain: 'feishu',
      oauthRedirectUri: 'http://127.0.0.1:4310/oauth/aily/callback',
      oauthScopes: ['aily:agent_chat:write', 'offline_access'],
      appSecret: 'app-secret',
    });
    const service = new AilyService(credentials);
    const database = new AppDatabase(':memory:', false);
    databases.push(database);
    const pm = new PmService(database, createCindyAdapters(config), config);
    return { service, credentials, pm };
  }

  it('解析跨 UTF-8 和事件边界的 SSE，并接受无尾换行的 Completed 终态', async () => {
    const encoded = new TextEncoder().encode(sseText('窗口里有中文任务。'));
    const splitAt = encoded.findIndex((value) => value >= 0xe0);
    const stream = chunks([
      encoded.slice(0, splitAt + 1),
      encoded.slice(splitAt + 1, splitAt + 3),
      encoded.slice(splitAt + 3, encoded.length - 5),
      encoded.slice(encoded.length - 5),
    ]);
    await expect(ailyTestExports.summarizeSseStream(stream)).resolves.toMatchObject({
      status: 'Completed',
      text: '窗口里有中文任务。',
      agentChatId: 'chat-12345678',
      sessionId: 'session-1',
    });
  });

  it('拒绝缺少 start、缺少 done 和非 Completed 的 SSE', async () => {
    await expect(ailyTestExports.summarizeSseStream(chunks([
      'event: done\ndata: {"status":"Completed"}',
    ]))).rejects.toMatchObject({ code: 'AILY_SSE_MISSING_START' });
    await expect(ailyTestExports.summarizeSseStream(chunks([
      'event: start\ndata: {"agent_chat_id":"chat-1"}',
    ]))).rejects.toMatchObject({ code: 'AILY_SSE_MISSING_DONE' });
    await expect(ailyTestExports.summarizeSseStream(chunks([
      sseText('未完成', 'Failed'),
    ]))).rejects.toMatchObject({ code: 'AILY_NOT_COMPLETED' });
  });

  it('OAuth state 只能使用一次，并把授权码换得的 refresh token 加密保存', async () => {
    const { service, credentials } = await makeService();
    const mockedClient = {
      accessToken: {
        retrieveByAuthorizationCode: async () => ({
          accessToken: 'oauth-access',
          refreshToken: 'oauth-refresh',
          expiresIn: 7200,
          scope: 'aily:agent_chat:write offline_access',
        }),
      },
    };
    Object.assign(service, { client: () => mockedClient });

    const { url } = await service.authorizationUrl();
    const parsed = new URL(url);
    const state = parsed.searchParams.get('state') ?? '';
    expect(parsed.hostname).toBe('accounts.feishu.cn');
    expect(parsed.searchParams.get('scope')).toContain('offline_access');
    await expect(service.completeAuthorization('authorization-code', state)).resolves.toMatchObject({ ok: true });
    expect(await credentials.get(ailySecretKeys.accessToken)).toBe('oauth-access');
    expect(await credentials.get(ailySecretKeys.refreshToken)).toBe('oauth-refresh');
    expect(JSON.stringify(service.status())).not.toContain('oauth-');
    await expect(service.completeAuthorization('authorization-code', state))
      .rejects.toMatchObject({ code: 'AILY_OAUTH_STATE_INVALID' });
  });

  it('过期 Token 自动 refresh，SDK 请求使用刷新后的用户 Token，非空摘要进入 ready inbox 并推进扫描游标', async () => {
    const { service, credentials, pm } = await makeService();
    await credentials.setMany({
      [ailySecretKeys.accessToken]: 'expired-access',
      [ailySecretKeys.refreshToken]: 'refresh-token',
      [ailySecretKeys.expiresAt]: '2020-01-01T00:00:00.000Z',
    });
    let sdkUserToken = '';
    const mockedClient = {
      accessToken: {
        refresh: async () => ({
          accessToken: 'fresh-access',
          refreshToken: 'fresh-refresh',
          expiresIn: 7200,
          scope: 'aily:agent_chat:write offline_access',
        }),
      },
      request: async (_request: unknown, options: { lark: Record<symbol, string> }) => {
        sdkUserToken = Object.getOwnPropertySymbols(options.lark)
          .map((symbol) => options.lark[symbol])
          .find(Boolean) ?? '';
        return chunks([sseText('窗口内有一项需要跟进的任务。')]);
      },
    };
    Object.assign(service, { client: () => mockedClient });

    const result = await service.scan(pm, 'manual');
    expect(result).toMatchObject({
      status: 'summary_ready',
      aily_summary_generated: true,
      inbox: { status: 'ready', summary_ready: true },
    });
    expect(sdkUserToken).toBe('fresh-access');
    if (!('window_end' in result)) throw new Error('Aily 扫描没有返回窗口。');
    expect(pm.intakeWindowCursor().window_end).toBe(result.window_end);
    expect(pm.claimNextAilySummaryInbox()).toMatchObject({
      status: 'ready',
      source: {
        source_kind: 'aily_summary',
        agent_id: 'agent_test',
        text: '窗口内有一项需要跟进的任务。',
      },
    });
  });

  it('空摘要写入 completed 审计记录并推进游标；上游失败保留待重试窗口', async () => {
    const empty = await makeService();
    await empty.credentials.setMany({
      [ailySecretKeys.accessToken]: 'valid-access',
      [ailySecretKeys.refreshToken]: 'valid-refresh',
      [ailySecretKeys.expiresAt]: '2099-01-01T00:00:00.000Z',
    });
    Object.assign(empty.service, {
      client: () => ({ request: async () => chunks([sseText('NO_NEW_INFORMATION')]) }),
    });
    const emptyResult = await empty.service.scan(empty.pm, 'manual') as Record<string, unknown>;
    expect(emptyResult).toMatchObject({
      status: 'completed',
      reason: 'aily_empty',
      inbox: { status: 'completed', summary_ready: false },
    });
    expect(empty.pm.intakeWindowCursor().window_end).toBe(emptyResult.window_end);
    expect(empty.pm.claimNextAilySummaryInbox()).toEqual({ status: 'empty' });

    expect(ailyTestExports.classifySummary('NO_NEW_INFORMATION')).toEqual({ kind: 'empty' });
    expect(ailyTestExports.classifySummary('SEARCH_FAILED: MISSING_SEARCH_MESSAGE')).toEqual({
      kind: 'failed_scope',
      code: 'MISSING_SEARCH_MESSAGE',
    });
    expect(ailyTestExports.buildPrompt({
      window_id: 'w',
      window_start: '2026-08-26T16:00:00.000Z',
      window_end: '2026-08-27T09:00:00.000Z',
      reused: false,
    })).toContain('禁止：列出全部会话后再逐个拉历史');

    const scopeDump = await makeService();
    await scopeDump.credentials.setMany({
      [ailySecretKeys.accessToken]: 'valid-access',
      [ailySecretKeys.refreshToken]: 'valid-refresh',
      [ailySecretKeys.expiresAt]: '2099-01-01T00:00:00.000Z',
    });
    Object.assign(scopeDump.service, {
      client: () => ({ request: async () => chunks([sseText('缺少 search:message 权限，无法检索。NO_NEW_INFORMATION')]) }),
    });
    const scopeResult = await scopeDump.service.scan(scopeDump.pm, 'manual') as Record<string, unknown>;
    expect(scopeResult).toMatchObject({
      status: 'failed',
      aily_error_code: 'AILY_SCOPE_REQUIRED',
      aily_scope_code: 'UNAUTHORIZED',
    });
    expect(scopeDump.pm.intakeWindowCursor()).toEqual({ window_end: null });
    expect(scopeDump.pm.claimNextAilySummaryInbox()).toEqual({ status: 'empty' });

    const failed = await makeService();
    await failed.credentials.setMany({
      [ailySecretKeys.accessToken]: 'valid-access',
      [ailySecretKeys.refreshToken]: 'valid-refresh',
      [ailySecretKeys.expiresAt]: '2099-01-01T00:00:00.000Z',
    });
    Object.assign(failed.service, {
      client: () => ({
        request: async () => {
          const error = new Error('private upstream response with valid-access');
          Object.assign(error, { status: 500 });
          throw error;
        },
      }),
    });
    const first = await failed.service.scan(failed.pm, 'manual') as Record<string, unknown>;
    const second = await failed.service.scan(failed.pm, 'manual') as Record<string, unknown>;
    expect(first).toMatchObject({ status: 'failed', reason: 'aily_failed', aily_error_code: 'AILY_UPSTREAM' });
    expect(JSON.stringify(first)).not.toContain('valid-access');
    expect(second.window_id).toBe(first.window_id);
    expect(second.reused).toBe(true);
    expect(failed.pm.intakeWindowCursor()).toEqual({ window_end: null });
  });

  it('缺少可刷新授权时返回明确的重新连接错误', async () => {
    const { service, pm } = await makeService();
    const result = await service.scan(pm, 'manual');
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'aily_failed',
      aily_error_code: 'AILY_AUTH_REQUIRED',
    });
    expect(() => {
      throw new AilyServiceError('AILY_AUTH_REQUIRED', '请重新连接。');
    }).toThrow('请重新连接。');
  });

  it('刷新临时失败保留长期授权，明确鉴权失败才清除本机 Token', async () => {
    const transient = await makeService();
    await transient.credentials.setMany({
      [ailySecretKeys.accessToken]: 'expired-access',
      [ailySecretKeys.refreshToken]: 'durable-refresh',
      [ailySecretKeys.expiresAt]: '2020-01-01T00:00:00.000Z',
    });
    Object.assign(transient.service, {
      client: () => ({
        accessToken: {
          refresh: async () => {
            const error = new Error('temporary upstream outage');
            Object.assign(error, { status: 503 });
            throw error;
          },
        },
      }),
    });
    await expect(transient.service.scan(transient.pm, 'manual')).resolves.toMatchObject({
      status: 'failed',
      aily_error_code: 'AILY_UPSTREAM',
    });
    expect(await transient.credentials.get(ailySecretKeys.refreshToken)).toBe('durable-refresh');

    const unauthorized = await makeService();
    await unauthorized.credentials.setMany({
      [ailySecretKeys.accessToken]: 'expired-access',
      [ailySecretKeys.refreshToken]: 'revoked-refresh',
      [ailySecretKeys.expiresAt]: '2020-01-01T00:00:00.000Z',
    });
    Object.assign(unauthorized.service, {
      client: () => ({
        accessToken: {
          refresh: async () => {
            const error = new Error('refresh token revoked');
            Object.assign(error, { status: 401 });
            throw error;
          },
        },
      }),
    });
    await expect(unauthorized.service.scan(unauthorized.pm, 'manual')).resolves.toMatchObject({
      status: 'failed',
      aily_error_code: 'AILY_AUTH_REQUIRED',
    });
    expect(await unauthorized.credentials.get(ailySecretKeys.accessToken)).toBeNull();
    expect(await unauthorized.credentials.get(ailySecretKeys.refreshToken)).toBeNull();
  });

  it('后台 scheduler 启动后等待 20 分钟再扫描，停止后不再触发', async () => {
    vi.useFakeTimers();
    const triggerScan = vi.fn(() => ({ status: 'accepted' }));
    const stop = vi.fn(async () => undefined);
    const scheduler = new AilyScanScheduler(
      { triggerScan, stop } as unknown as AilyService,
      {} as PmService,
    );
    scheduler.start();
    expect(triggerScan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AILY_SCAN_INTERVAL_MS);
    expect(triggerScan).toHaveBeenCalledTimes(1);
    expect(triggerScan).toHaveBeenCalledWith(expect.anything(), 'schedule');
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(AILY_SCAN_INTERVAL_MS);
    expect(triggerScan).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('异步手动扫描快速返回并拒绝重叠，stop 会中止当前扫描', async () => {
    const { service, pm } = await makeService();
    let release: (() => void) | undefined;
    Object.assign(service, {
      scan: (_pm: PmService, _trigger: string, signal: AbortSignal) => new Promise((resolve) => {
        release = () => resolve({ status: 'done' });
        signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true });
      }),
    });
    expect(service.triggerScan(pm, 'manual')).toMatchObject({ status: 'accepted', job_id: expect.any(String) });
    expect(service.triggerScan(pm, 'manual')).toMatchObject({ status: 'already_running' });
    await service.stop();
    expect(service.triggerScan(pm, 'manual')).toMatchObject({ status: 'accepted' });
    release?.();
    await service.stop();
  });
});
