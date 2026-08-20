export type PublicDesktopConfig = {
  setupComplete: boolean;
  launchAtLogin: boolean;
  logRetentionDays: number;
  feishu: {
    appId: string;
    externalEnabled: boolean;
    domain: 'feishu' | 'lark';
    eventMode: 'websocket' | 'webhook';
    oauthRedirectUri: string;
    oauthScopes: string;
    scanEnabled: boolean;
    scanIntervalSeconds: number;
    groupIds: string[];
  };
  llm: {
    provider: string;
    model: string;
    apiBase: string;
    timeoutMs: number;
    maxRetries: number;
  };
  workspace: { readEnabled: boolean; allowedPaths: string[] };
  secretState: {
    feishuAppSecret: boolean;
    feishuUserAccessToken: boolean;
    feishuRefreshToken: boolean;
    llmApiKey: boolean;
    feishuUserToken: boolean;
  };
};

export type DesktopConfigInput = PublicDesktopConfig & {
  secrets?: { feishuAppSecret?: string; llmApiKey?: string; clearFeishuAppSecret?: boolean; clearLlmApiKey?: boolean };
};

export type DesktopBridge = {
  api: {
    request(input: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; body?: unknown }): Promise<{
      status: number;
      body: unknown;
    }>;
  };
  app: {
    info(): Promise<{ version: string; platform: string; packaged: boolean }>;
    relaunch(): Promise<void>;
  };
  config: {
    get(): Promise<PublicDesktopConfig>;
    save(input: DesktopConfigInput): Promise<PublicDesktopConfig>;
  };
  feishu: { authorize(): Promise<OpenExternalUrlResult> };
  externalLinks: {
    open(input: OpenExternalUrlInput & { purpose: 'feishu_document' }): Promise<OpenExternalUrlResult>;
    onResult(listener: (result: OpenExternalUrlResult) => void): () => void;
  };
  workspace: { pickDirectory(): Promise<string | null> };
  taskMemory: { open(taskId: string): Promise<{ opened: true }> };
  diagnostics: { export(): Promise<{ saved: boolean; path?: string }> };
};

declare global {
  interface Window {
    aiPmDesktop?: DesktopBridge;
  }
}

export const desktopBridge = () => window.aiPmDesktop;
import type { OpenExternalUrlInput, OpenExternalUrlResult } from '@ai-pm/url-policy';
