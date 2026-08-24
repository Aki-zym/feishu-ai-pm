import type { OpenExternalUrlInput, OpenExternalUrlResult } from '@ai-pm/url-policy';

export type { OpenExternalUrlInput, OpenExternalUrlResult } from '@ai-pm/url-policy';

export type DesktopRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body?: unknown;
};

export type DesktopResponse = {
  status: number;
  body: unknown;
};

export type OpenTaskMemoryResult = {
  opened: true;
};

export type ExternalLinkResultListener = (result: OpenExternalUrlResult) => void;
export type OpenDocumentUrlInput = OpenExternalUrlInput & { purpose: 'feishu_document' };

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
  workspace: {
    readEnabled: boolean;
    allowedPaths: string[];
  };
  secretState: {
    feishuAppSecret: boolean;
    feishuUserAccessToken: boolean;
    feishuRefreshToken: boolean;
    llmApiKey: boolean;
    feishuUserToken: boolean;
  };
};

export type DesktopConfigInput = PublicDesktopConfig & {
  secrets?: {
    feishuAppSecret?: string;
    llmApiKey?: string;
    clearFeishuAppSecret?: boolean;
    clearLlmApiKey?: boolean;
  };
};
