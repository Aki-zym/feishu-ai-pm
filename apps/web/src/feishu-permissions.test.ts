import { describe, expect, it } from 'vitest';
import {
  FEISHU_BATCH_PERMISSION_JSON,
  FEISHU_OWNER_OAUTH_SCOPE_TEXT,
  FEISHU_OWNER_USER_SCOPES,
  FEISHU_TENANT_SCOPES,
  missingOwnerScopes,
  parseScopeText,
} from './feishu-permissions';

describe('飞书权限指南真源', () => {
  it('批量导入 JSON 明确区分 tenant 与 user，且不包含凭证或应用 ID', () => {
    const parsed = JSON.parse(FEISHU_BATCH_PERMISSION_JSON) as { scopes: { tenant: string[]; user: string[] } };
    expect(parsed.scopes.tenant).toEqual(FEISHU_TENANT_SCOPES);
    expect(parsed.scopes.user).toEqual(FEISHU_OWNER_USER_SCOPES);
    expect(FEISHU_BATCH_PERMISSION_JSON).not.toMatch(/cli_|app.?secret|refresh.?token/i);
    expect(parsed.scopes.user).toEqual(expect.arrayContaining([
      'offline_access',
      'contact:user:search',
      'im:message.p2p_msg:get_as_user',
      'docx:document:readonly',
      'wiki:node:read',
    ]));
  });

  it('OAuth scope 只使用 user 权限，并能准确计算 Token 尚未返回的项', () => {
    expect(parseScopeText(FEISHU_OWNER_OAUTH_SCOPE_TEXT)).toEqual(FEISHU_OWNER_USER_SCOPES);
    expect(FEISHU_OWNER_OAUTH_SCOPE_TEXT).not.toContain('im:message:send_as_bot');
    expect(missingOwnerScopes('offline_access  docx:document:readonly offline_access', ['offline_access'])).toEqual(['docx:document:readonly']);
  });
});
