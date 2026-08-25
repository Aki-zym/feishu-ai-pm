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
  test('桌面桥接配置未完成时仍进入任务台，不显示旧首配页', async ({ page }) => {
    await installBrowserBridgeMock(page, initialConfig());

    await page.goto('/');
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '配置 TooManyTasks' })).toHaveCount(0);
    await expect(page.getByText('连接我的飞书', { exact: true })).toHaveCount(0);
  });
});
