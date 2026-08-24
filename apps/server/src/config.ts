import { resolve } from 'node:path';
import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4310),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  APP_VERSION: z.string().default('0.2.0'),
  BUILD_IDENTITY: z.string().default(''),
  DATABASE_URL: z.string().default('file:./var/ai-pm.sqlite'),
  DATABASE_PROVIDER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  POSTGRES_URL: z.string().default(''),
  FEISHU_APP_ID: z.string().default(''),
  FEISHU_APP_SECRET: z.string().default(''),
  FEISHU_DOMAIN: z.enum(['feishu', 'lark']).default('feishu'),
  FEISHU_EVENT_MODE: z.enum(['websocket', 'webhook']).default('websocket'),
  FEISHU_OAUTH_REDIRECT_URI: z.string().default(''),
  FEISHU_OAUTH_SCOPES: z.string().default(''),
  FEISHU_ENCRYPT_KEY: z.string().default(''),
  FEISHU_VERIFICATION_TOKEN: z.string().default(''),
  FEISHU_EXTERNAL_ENABLED: booleanFromEnv,
  FEISHU_GROUP_IDS: z.string().default(''),
  FEISHU_SCAN_ENABLED: booleanFromEnv,
  FEISHU_SCAN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  FEISHU_SCAN_OVERLAP_SECONDS: z.coerce.number().int().nonnegative().default(300),
  FEISHU_SCAN_PAGE_SIZE: z.coerce.number().int().min(1).max(50).default(50),
  TOKEN_ENCRYPTION_KEY: z.string().default(''),
  LLM_PROVIDER: z.string().default('rule_mock'),
  LLM_MODEL: z.string().default(''),
  LLM_API_BASE: z.string().default(''),
  LLM_API_KEY: z.string().default(''),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  WORKSPACE_MODE: z.enum(['reference_only', 'readonly_bridge']).default('reference_only'),
  WORKSPACE_READ_ENABLED: booleanFromEnv,
  WORKSPACE_WRITE_ENABLED: booleanFromEnv,
  WORKSPACE_ALLOWED_PATHS: z.string().default('[]'),
  TASK_MEMORY_ROOT: z.string().default(''),
  CINDY_INTEGRATION_TOKEN: z.string().default(''),
});

export type AppConfig = ReturnType<typeof loadConfig>;

function parseAllowedPaths(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 20);
  } catch {
    return value.split(';').map((item) => item.trim()).filter(Boolean).slice(0, 20);
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(source);
  const sqlitePath = parsed.DATABASE_URL.startsWith('file:')
    ? resolve(process.cwd(), parsed.DATABASE_URL.slice('file:'.length))
    : parsed.DATABASE_URL;

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    webOrigin: parsed.WEB_ORIGIN,
    logging: {
      retentionDays: parsed.LOG_RETENTION_DAYS,
    },
    release: {
      appVersion: parsed.APP_VERSION,
      buildIdentity: parsed.BUILD_IDENTITY || null,
    },
    database: {
      provider: parsed.DATABASE_PROVIDER,
      url: parsed.DATABASE_URL,
      sqlitePath,
      postgresUrl: parsed.POSTGRES_URL,
    },
    feishu: {
      appId: parsed.FEISHU_APP_ID,
      appSecret: parsed.FEISHU_APP_SECRET,
      domain: parsed.FEISHU_DOMAIN,
      eventMode: parsed.FEISHU_EVENT_MODE,
      oauthRedirectUri: parsed.FEISHU_OAUTH_REDIRECT_URI,
      oauthScopes: parsed.FEISHU_OAUTH_SCOPES,
      encryptKey: parsed.FEISHU_ENCRYPT_KEY,
      verificationToken: parsed.FEISHU_VERIFICATION_TOKEN,
      externalEnabled: parsed.FEISHU_EXTERNAL_ENABLED,
      groupIds: parsed.FEISHU_GROUP_IDS.split(',').map((value) => value.trim()).filter(Boolean),
      scanEnabled: parsed.FEISHU_SCAN_ENABLED,
      scanIntervalSeconds: parsed.FEISHU_SCAN_INTERVAL_SECONDS,
      scanOverlapSeconds: parsed.FEISHU_SCAN_OVERLAP_SECONDS,
      scanPageSize: parsed.FEISHU_SCAN_PAGE_SIZE,
      tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY,
    },
    llm: {
      provider: parsed.LLM_PROVIDER,
      model: parsed.LLM_MODEL,
      apiBase: parsed.LLM_API_BASE,
      apiKey: parsed.LLM_API_KEY,
      timeoutMs: parsed.LLM_TIMEOUT_MS,
      maxRetries: parsed.LLM_MAX_RETRIES,
    },
    workspace: {
      mode: parsed.WORKSPACE_MODE,
      readEnabled: parsed.WORKSPACE_READ_ENABLED,
      writeEnabled: parsed.WORKSPACE_WRITE_ENABLED,
      allowedPaths: parseAllowedPaths(parsed.WORKSPACE_ALLOWED_PATHS),
    },
    taskMemoryRoot: parsed.TASK_MEMORY_ROOT ? resolve(parsed.TASK_MEMORY_ROOT) : resolve(process.cwd(), 'tmp', 'task-memory'),
    cindyIntegrationToken: parsed.CINDY_INTEGRATION_TOKEN,
  };
}
