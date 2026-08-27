import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { isLocalAilyRedirectUri, type AppConfig } from './config.js';

const publicSchema = z.object({
  appId: z.string().trim().max(200),
  agentId: z.string().trim().max(160),
  domain: z.enum(['feishu', 'lark']),
  oauthRedirectUri: z.string().trim().max(2048).refine(
    isLocalAilyRedirectUri,
    'OAuth 回调地址必须是本机 HTTP 回环地址，路径固定为 /oauth/aily/callback。',
  ),
  oauthScopes: z.array(z.string().trim().min(1).max(200)).max(48),
});

type SecretMap = Record<string, string>;

export const ailySecretKeys = {
  appSecret: 'AILY_APP_SECRET',
  accessToken: 'AILY_USER_ACCESS_TOKEN',
  refreshToken: 'AILY_REFRESH_TOKEN',
  expiresAt: 'AILY_TOKEN_EXPIRES_AT',
  grantedScopes: 'AILY_GRANTED_SCOPES',
  oauthState: 'AILY_OAUTH_STATE',
  oauthStateAt: 'AILY_OAUTH_STATE_AT',
} as const;

export type AilyManagedConfig = z.infer<typeof publicSchema> & {
  appSecret: string;
};

export type AilyPublicConfig = z.infer<typeof publicSchema> & {
  appSecretSaved: boolean;
  connected: boolean;
  refreshAvailable: boolean;
  expiresAt: string | null;
  grantedScopes: string[];
};

export class LocalCredentialStore {
  readonly root: string;
  readonly integrationTokenPath: string;
  private readonly publicPath: string;
  private readonly secretPath: string;
  private readonly keyPath: string;
  private publicValues: z.infer<typeof publicSchema>;
  private secrets: SecretMap = {};

  constructor(private readonly baseConfig: AppConfig) {
    this.root = baseConfig.configRoot;
    this.publicPath = resolve(this.root, 'aily-settings.json');
    this.secretPath = resolve(this.root, 'aily-secrets.bin');
    this.keyPath = resolve(this.root, 'master.key');
    this.integrationTokenPath = resolve(this.root, 'cindy-integration-token');
    this.publicValues = publicSchema.parse(baseConfig.aily);
  }

  async load() {
    this.publicValues = await this.readPublic();
    this.secrets = await this.readSecrets();
    if (this.baseConfig.aily.appSecret && !this.secrets[ailySecretKeys.appSecret]) {
      this.secrets[ailySecretKeys.appSecret] = this.baseConfig.aily.appSecret;
      await this.writeSecrets(this.secrets);
    }
    return this.current();
  }

  current(): AilyManagedConfig {
    return {
      ...this.publicValues,
      appSecret: this.secrets[ailySecretKeys.appSecret] ?? '',
    };
  }

  publicConfig(): AilyPublicConfig {
    const expiresAt = this.secrets[ailySecretKeys.expiresAt] || null;
    const grantedScopes = (this.secrets[ailySecretKeys.grantedScopes] || '')
      .split(/[\s,]+/u)
      .map((value) => value.trim())
      .filter(Boolean);
    return {
      ...this.publicValues,
      appSecretSaved: Boolean(this.secrets[ailySecretKeys.appSecret]),
      connected: Boolean(this.secrets[ailySecretKeys.refreshToken] || this.secrets[ailySecretKeys.accessToken]),
      refreshAvailable: Boolean(this.secrets[ailySecretKeys.refreshToken]),
      expiresAt,
      grantedScopes,
    };
  }

  async saveConfig(input: {
    appId: string;
    agentId: string;
    domain: 'feishu' | 'lark';
    oauthRedirectUri: string;
    oauthScopes: string[];
    appSecret?: string;
    clearAppSecret?: boolean;
  }) {
    const nextPublic = publicSchema.parse(input);
    const appIdentityChanged = nextPublic.appId !== this.publicValues.appId
      || nextPublic.domain !== this.publicValues.domain
      || nextPublic.oauthRedirectUri !== this.publicValues.oauthRedirectUri;
    const nextSecrets = { ...this.secrets };
    if (input.clearAppSecret) delete nextSecrets[ailySecretKeys.appSecret];
    if (input.appSecret?.trim()) nextSecrets[ailySecretKeys.appSecret] = input.appSecret.trim();
    if (appIdentityChanged || input.clearAppSecret || input.appSecret?.trim()) {
      for (const key of [
        ailySecretKeys.accessToken,
        ailySecretKeys.refreshToken,
        ailySecretKeys.expiresAt,
        ailySecretKeys.grantedScopes,
        ailySecretKeys.oauthState,
        ailySecretKeys.oauthStateAt,
      ]) {
        delete nextSecrets[key];
      }
    }
    await this.ensureRoot();
    await this.atomicWrite(this.publicPath, JSON.stringify(nextPublic, null, 2), 'utf8');
    this.publicValues = nextPublic;
    this.secrets = nextSecrets;
    await this.writeSecrets(nextSecrets);
    return this.publicConfig();
  }

  async get(key: string) {
    return this.secrets[key] ?? null;
  }

  async set(key: string, value: string) {
    await this.setMany({ [key]: value });
  }

  async setMany(values: Record<string, string>) {
    const next = { ...this.secrets };
    for (const [key, value] of Object.entries(values)) {
      if (value) next[key] = value;
      else delete next[key];
    }
    this.secrets = next;
    await this.writeSecrets(next);
  }

  async clearAilyAuthorization() {
    await this.setMany({
      [ailySecretKeys.accessToken]: '',
      [ailySecretKeys.refreshToken]: '',
      [ailySecretKeys.expiresAt]: '',
      [ailySecretKeys.grantedScopes]: '',
      [ailySecretKeys.oauthState]: '',
      [ailySecretKeys.oauthStateAt]: '',
    });
  }

  async ensureIntegrationToken(preferred = '') {
    await this.ensureRoot();
    if (preferred.trim()) {
      await this.atomicWrite(this.integrationTokenPath, `${preferred.trim()}\n`, 'utf8');
      await chmod(this.integrationTokenPath, 0o600);
      return preferred.trim();
    }
    if (existsSync(this.integrationTokenPath)) {
      const existing = (await readFile(this.integrationTokenPath, 'utf8')).trim();
      if (existing) return existing;
    }
    const token = `toomanytasks-${randomUUID()}-${randomBytes(24).toString('hex')}`;
    await this.atomicWrite(this.integrationTokenPath, `${token}\n`, 'utf8');
    await chmod(this.integrationTokenPath, 0o600);
    return token;
  }

  private async readPublic() {
    if (!existsSync(this.publicPath)) return this.publicValues;
    try {
      return publicSchema.parse(JSON.parse(await readFile(this.publicPath, 'utf8')));
    } catch {
      return this.publicValues;
    }
  }

  private async encryptionKey() {
    if (this.baseConfig.tokenEncryptionKey) {
      return createHash('sha256').update(this.baseConfig.tokenEncryptionKey).digest();
    }
    await this.ensureRoot();
    if (!existsSync(this.keyPath)) {
      await writeFile(this.keyPath, randomBytes(32), { mode: 0o600 });
      await chmod(this.keyPath, 0o600);
    }
    return createHash('sha256').update(await readFile(this.keyPath)).digest();
  }

  private async readSecrets(): Promise<SecretMap> {
    if (!existsSync(this.secretPath)) return {};
    try {
      const envelope = JSON.parse(await readFile(this.secretPath, 'utf8')) as {
        iv: string;
        tag: string;
        data: string;
      };
      const decipher = createDecipheriv(
        'aes-256-gcm',
        await this.encryptionKey(),
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const parsed = JSON.parse(plaintext) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as SecretMap
        : {};
    } catch {
      throw new Error('TooManyTasks 的本地 Aily 凭证无法解密；请确认 TOKEN_ENCRYPTION_KEY 未变化。');
    }
  }

  private async writeSecrets(secrets: SecretMap) {
    if (!Object.keys(secrets).length) {
      if (existsSync(this.secretPath)) await unlink(this.secretPath);
      return;
    }
    await this.ensureRoot();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.encryptionKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(secrets), 'utf8'),
      cipher.final(),
    ]);
    const envelope = JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    });
    await this.atomicWrite(this.secretPath, envelope, 'utf8');
    await chmod(this.secretPath, 0o600);
  }

  private async atomicWrite(path: string, content: string, encoding: BufferEncoding) {
    await this.ensureRoot();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, content, { encoding, mode: 0o600 });
    await rename(temp, path);
  }

  private async ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }
}
