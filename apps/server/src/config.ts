import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
  DATABASE_URL: z.string().default(''),
  DATABASE_PROVIDER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  POSTGRES_URL: z.string().default(''),
  TOOMANYTASKS_CONFIG_ROOT: z.string().default(''),
  CONFIG_ROOT: z.string().default(''),
  TOKEN_ENCRYPTION_KEY: z.string().default(''),
  AILY_APP_ID: z.string().default(''),
  AILY_APP_SECRET: z.string().default(''),
  AILY_AGENT_ID: z.string().default(''),
  AILY_DOMAIN: z.enum(['feishu', 'lark']).default('feishu'),
  AILY_OAUTH_REDIRECT_URI: z.string().default(''),
  AILY_OAUTH_SCOPES: z.string().default([
    'aily:agent_chat:write',
    'auth:user.id:read',
    'im:chat:read',
    'im:message:readonly',
    'im:message.group_msg:get_as_user',
    'im:message.p2p_msg:get_as_user',
    'search:message',
    'search:docs:read',
    'calendar:calendar.event:read',
    'offline_access',
  ].join(' ')),
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

function defaultLocalRoot(source: NodeJS.ProcessEnv) {
  const explicitRoot = source.TOOMANYTASKS_CONFIG_ROOT?.trim() || source.CONFIG_ROOT?.trim();
  if (explicitRoot) return resolve(explicitRoot);
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'ai-pm-intake');
  }
  if (process.platform === 'win32') {
    return join(source.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'ai-pm-intake');
  }
  return join(source.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ai-pm-intake');
}

export function isLocalAilyRedirectUri(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '::1'].includes(host)
      && url.pathname === '/oauth/aily/callback'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(source);
  const configRoot = defaultLocalRoot(source);
  const databaseUrl = parsed.DATABASE_URL.trim();
  const sqlitePath = !databaseUrl
    ? join(configRoot, 'ai-pm.sqlite')
    : databaseUrl.startsWith('file:')
      ? resolve(process.cwd(), databaseUrl.slice('file:'.length))
      : databaseUrl;
  const oauthRedirectUri = parsed.AILY_OAUTH_REDIRECT_URI.trim()
    || `http://127.0.0.1:${parsed.PORT}/oauth/aily/callback`;
  if (!isLocalAilyRedirectUri(oauthRedirectUri)) {
    throw new Error('AILY_OAUTH_REDIRECT_URI 必须是本机 HTTP 回环地址，路径固定为 /oauth/aily/callback。');
  }

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
      url: databaseUrl || `file:${sqlitePath}`,
      sqlitePath,
      postgresUrl: parsed.POSTGRES_URL,
    },
    configRoot,
    tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY,
    aily: {
      appId: parsed.AILY_APP_ID.trim(),
      appSecret: parsed.AILY_APP_SECRET,
      agentId: parsed.AILY_AGENT_ID.trim(),
      domain: parsed.AILY_DOMAIN,
      oauthRedirectUri,
      oauthScopes: parsed.AILY_OAUTH_SCOPES.split(/\s+/u).map((value) => value.trim()).filter(Boolean),
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
