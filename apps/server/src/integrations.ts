import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import type { NormalizedSourceEvent } from './domain.js';
import type { DurableEventReceipt } from './integration-contracts.js';
import type {
  AdapterOptions,
  ClassifierAdapter,
  FeishuAdapter,
  IntegrationCheck,
  WorkspaceReferenceAdapter,
} from './types-internal.js';
import { OpenAICompatibleClassifier, RuleMockClassifier } from './integrations/llm.js';
import { LiveFeishuAdapter } from './integrations/feishu.js';
import { ReadonlyWorkspaceAdapter } from './integrations/workspace.js';

export type { ClassifierAdapter, TokenVault } from './integration-contracts.js';

function disabled(message = '真实飞书连接尚未配置；系统不会发起网络请求。'): never {
  throw new Error(message);
}

export class DisabledFeishuAdapter implements FeishuAdapter {
  readonly kind = 'disabled' as const;
  readonly sentCount = 0;

  async buildAuthorizationUrl(): Promise<string> {
    return disabled('请先开启“允许真实飞书连接”，填写 App ID 和 App Secret，并保存配置后再授权。');
  }
  async exchangeCode(): Promise<{ expiresAt: string }> { return disabled(); }
  async refreshToken(): Promise<{ expiresAt: string }> { return disabled(); }
  async testConnection(): Promise<IntegrationCheck> {
    return { ok: false, status: 'not_configured', message: '请先填写飞书 App ID 和 App Secret。', checkedAt: new Date().toISOString() };
  }
  async start(_handler?: (event: NormalizedSourceEvent) => Promise<DurableEventReceipt>) {}
  async stop() {}
  async listChats(): Promise<unknown[]> { return []; }
  async listMessages(): Promise<unknown[]> { return []; }
  async searchMessages(): Promise<unknown[]> { return []; }
  async getCurrentUser() { return disabled(); }
  async primaryCalendar(): Promise<unknown> { return disabled(); }
  async listCalendarEvents(): Promise<unknown> { return disabled(); }
  async getCalendarEvent(): Promise<unknown> { return disabled(); }
  async searchMinutes(): Promise<unknown> { return disabled(); }
  async getMinute(): Promise<unknown> { return disabled(); }
  async getMinuteArtifacts(): Promise<unknown> { return disabled(); }
  async getMinuteTranscript(): Promise<unknown> { return disabled(); }
  async getDocxDocument(): Promise<unknown> { return disabled('尚未完成系统主人 OAuth，无法读取飞书文档背景。'); }
  async getDocxRawContent(): Promise<unknown> { return disabled('尚未完成系统主人 OAuth，无法读取飞书文档背景。'); }
  async getWikiNode(): Promise<unknown> { return disabled('尚未完成系统主人 OAuth，无法读取飞书知识库背景。'); }
  async listOwnerChats(): Promise<unknown> { return disabled('尚未完成系统主人 OAuth，无法发现个人会话。'); }
  async searchOwnerUsers(): Promise<unknown> { return disabled('尚未完成系统主人 OAuth，无法搜索联系人。'); }
  async resolveP2PChats(): Promise<unknown> { return disabled('尚未完成系统主人 OAuth，无法解析个人单聊。'); }
  normalizeSource(input: NormalizedSourceEvent) { return input; }
  async sendApproved(): Promise<{ externalId: string }> { return disabled(); }
}

export class ReferenceOnlyWorkspaceAdapter implements WorkspaceReferenceAdapter {
  readonly kind = 'reference_only' as const;
  async inspect(referencePath: string) {
    return {
      state: 'not_enabled' as const,
      referencePath,
      entries: [],
      truncated: false,
      inspectedAt: new Date().toISOString(),
    };
  }
}

export type AdapterSet = {
  feishu: FeishuAdapter;
  classifier: ClassifierAdapter;
  workspace: WorkspaceReferenceAdapter;
};

export function createAdapters(config: AppConfig = loadConfig(), options: AdapterOptions = {}): AdapterSet {
  const feishu = config.feishu.externalEnabled && config.feishu.appId && config.feishu.appSecret
    ? new LiveFeishuAdapter(config.feishu, options)
    : new DisabledFeishuAdapter();
  const classifier =
    config.llm.provider !== 'rule_mock' && config.llm.apiKey && config.llm.apiBase && config.llm.model
      ? new OpenAICompatibleClassifier(config.llm)
      : new RuleMockClassifier();
  const workspace = config.workspace.readEnabled ? new ReadonlyWorkspaceAdapter(config.workspace) : new ReferenceOnlyWorkspaceAdapter();
  return { feishu, classifier, workspace };
}
