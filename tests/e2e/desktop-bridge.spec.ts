import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

type SetupConfig = {
  setupComplete: boolean;
  launchAtLogin: boolean;
  logRetentionDays: number;
  feishu: {
    appId: string;
    externalEnabled: boolean;
    domain: string;
    eventMode: string;
    oauthRedirectUri: string;
    oauthScopes: string;
    scanEnabled: boolean;
    scanIntervalSeconds: number;
    groupIds: string[];
  };
  llm: { provider: string; model: string; apiBase: string; timeoutMs: number; maxRetries: number };
  workspace: { readEnabled: boolean; allowedPaths: string[] };
  secretState: Record<string, boolean>;
};

async function installBrowserBridgeMock(page: Page, initial: SetupConfig) {
  await page.addInitScript((config) => {
    (window as any).__savedSetupConfig = null;
    (window as any).__setupRelaunchCalls = 0;
    (window as any).aiPmDesktop = {
      api: { request: async () => ({ status: 200, body: {} }) },
      app: {
        info: async () => ({ version: 'test', platform: 'win32', packaged: true }),
        relaunch: async () => { (window as any).__setupRelaunchCalls += 1; },
      },
      config: {
        get: async () => config,
        save: async (input: any) => {
          const { secrets: _secrets, ...saved } = input;
          (window as any).__savedSetupConfig = saved;
          return { ...saved, secretState: config.secretState };
        },
      },
      feishu: { authorize: async () => ({ opened: true }) },
      workspace: { pickDirectory: async () => null },
      diagnostics: { export: async () => ({ saved: false }) },
    };
  }, initial);
}

const initialConfig = (overrides: Partial<SetupConfig['feishu']> = {}): SetupConfig => ({
  setupComplete: false,
  launchAtLogin: false,
  logRetentionDays: 30,
  feishu: {
    appId: '',
    externalEnabled: false,
    domain: 'feishu',
    eventMode: 'websocket',
    oauthRedirectUri: 'http://127.0.0.1:4311/oauth/feishu/callback',
    oauthScopes: '',
    scanEnabled: false,
    scanIntervalSeconds: 60,
    groupIds: [],
    ...overrides,
  },
  llm: { provider: 'deepseek', model: 'deepseek-v4-flash', apiBase: 'https://api.deepseek.com', timeoutMs: 30000, maxRetries: 2 },
  workspace: { readEnabled: false, allowedPaths: [] },
  secretState: {
    feishuAppSecret: false,
    feishuUserAccessToken: false,
    feishuRefreshToken: false,
    llmApiKey: true,
    feishuUserToken: false,
  },
});

test.describe('L4 本地 browser bridge Mock（不等于 Electron L5）', () => {
  test('首次配置会保留并规范化用户填写的 DeepSeek Provider', async ({ page }) => {
    await installBrowserBridgeMock(page, initialConfig());

    await page.goto('/');
    await expect(page.getByRole('heading', { name: '配置你的个人数据 PM' })).toBeVisible();
    await expect(page.getByLabel('Provider')).toHaveValue('deepseek');
    await page.getByLabel('Provider').fill('  deepseek  ');
    await page.getByText('飞书权限开通指南', { exact: true }).click();
    await page.getByRole('button', { name: '填入程序的 OAuth scope' }).click();
    await page.getByRole('button', { name: '保存并进入连接检查' }).click();

    const saved = await page.evaluate(() => ({
      provider: (window as any).__savedSetupConfig?.llm?.provider,
      model: (window as any).__savedSetupConfig?.llm?.model,
      oauthScopes: (window as any).__savedSetupConfig?.feishu?.oauthScopes,
      relaunchCalls: (window as any).__setupRelaunchCalls,
    }));
    expect(saved.provider).toBe('deepseek');
    expect(saved.model).toBe('deepseek-v4-flash');
    expect(saved.oauthScopes).toContain('docx:document:readonly');
    expect(saved.relaunchCalls).toBe(1);
  });

  test('首次配置选择安全模拟模式会明确关闭真实飞书连接', async ({ page }) => {
    await installBrowserBridgeMock(page, initialConfig({
      appId: 'cli_test',
      externalEnabled: true,
      oauthScopes: 'offline_access',
      scanEnabled: true,
      groupIds: ['oc_optional'],
    }));

    await page.goto('/');
    await page.getByRole('button', { name: '先用安全模拟模式' }).click();
    const saved = await page.evaluate(() => (window as any).__savedSetupConfig);
    expect(saved.llm.provider).toBe('rule_mock');
    expect(saved.feishu.externalEnabled).toBe(false);
    expect(saved.feishu.scanEnabled).toBe(false);
  });
});
