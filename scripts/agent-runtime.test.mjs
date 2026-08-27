import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_OAUTH_SCOPES, parseAilyConfig, readIntegrationToken, redactAilyStatus, runtimePaths, serverEnvironment } from './agent-runtime.mjs';

test('Agent Aily 配置默认使用当前用户独立应用所需的 scope', () => {
  const config = parseAilyConfig({
    appId: 'cli_user_app',
    appSecret: 'user-secret',
    agentId: 'agent_user_123',
  });
  assert.equal(config.domain, 'feishu');
  assert.equal(config.oauthRedirectUri, 'http://127.0.0.1:4310/oauth/aily/callback');
  assert.deepEqual(config.oauthScopes, DEFAULT_OAUTH_SCOPES);
  assert.equal(config.oauthScopes.includes('search:message'), true);
});

test('Agent 配置拒绝非法 Agent 标识、缺失 scope，并去重 scope', () => {
  assert.throws(() => parseAilyConfig({
    appId: 'cli_user_app',
    appSecret: 'user-secret',
    agentId: 'agent user',
  }), /Agent ID/);
  assert.throws(() => parseAilyConfig({
    appId: 'cli_user_app',
    appSecret: 'user-secret',
    agentId: 'agent_user_123',
    oauthScopes: ['search:message'],
  }), /scope 配置不完整/);
  const config = parseAilyConfig({
    appId: 'cli_user_app',
    appSecret: 'user-secret',
    agentId: 'agent_user_123',
    oauthScopes: [...DEFAULT_OAUTH_SCOPES, 'search:message'],
  });
  assert.deepEqual(config.oauthScopes, DEFAULT_OAUTH_SCOPES);
});

test('状态输出只保留计数和缺失 scope，不回显任何凭证', () => {
  const result = redactAilyStatus({
    authStatus: 'connected',
    connected: true,
    refreshAvailable: true,
    appId: 'cli_user_app',
    agentId: 'agent_user_123',
    appSecretSaved: true,
    grantedScopes: ['aily:agent_chat:write', 'offline_access'],
    accessToken: 'private-access-token',
    refreshToken: 'private-refresh-token',
  });
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal(result.grantedScopeCount, 2);
  assert.equal(result.missingScopes.includes('search:message'), true);
});

test('Agent 运行目录默认落在本机配置目录，且自定义目录优先', () => {
  const paths = runtimePaths({
    TOOMANYTASKS_CONFIG_ROOT: '/tmp/toomanytasks-agent-test',
    CONFIG_ROOT: '/tmp/legacy',
    PORT: '4399',
  });
  assert.equal(paths.configRoot, '/tmp/toomanytasks-agent-test');
  assert.equal(paths.baseUrl, 'http://127.0.0.1:4399');
  assert.match(paths.pidFile, /\.agent-runtime\/server\.pid$/u);
});

test('自定义配置目录会传给后台进程，避免令牌写到另一套安装', () => {
  const paths = runtimePaths({
    TOOMANYTASKS_CONFIG_ROOT: '/tmp/toomanytasks-agent-test',
    PORT: '4399',
  });
  const environment = serverEnvironment(paths, { PATH: '/usr/bin', AILY_OAUTH_REDIRECT_URI: '' });
  assert.equal(environment.TOOMANYTASKS_CONFIG_ROOT, '/tmp/toomanytasks-agent-test');
  assert.equal(environment.PORT, '4399');
  assert.equal(environment.AILY_OAUTH_REDIRECT_URI, 'http://127.0.0.1:4399/oauth/aily/callback');
});

test('Agent 的首次扫描使用 TooManyTasks 自动生成的本机集成令牌', async () => {
  const paths = runtimePaths({ TOOMANYTASKS_CONFIG_ROOT: '/tmp/toomanytasks-agent-test' });
  await assert.rejects(() => readIntegrationToken(paths), /尚未生成本机 Cindy 集成令牌/);
});
