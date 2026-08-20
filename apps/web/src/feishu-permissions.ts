export const FEISHU_TENANT_SCOPES = [
  'im:message:send_as_bot',
  'im:message:readonly',
  'im:message.group_msg',
  'im:message.group_at_msg:readonly',
  'im:message.p2p_msg:readonly',
  'im:chat:read',
] as const;

export const FEISHU_OWNER_USER_SCOPES = [
  'offline_access',
  'contact:user:search',
  'im:chat:read',
  'im:message:readonly',
  'im:message.p2p_msg:get_as_user',
  'im:message.group_msg:get_as_user',
  'calendar:calendar:readonly',
  'minutes:minutes.search:read',
  'minutes:minutes.basic:read',
  'minutes:minutes.artifacts:read',
  'minutes:minutes.transcript:export',
  'docx:document:readonly',
  'wiki:node:read',
] as const;

export const FEISHU_OWNER_OAUTH_SCOPE_TEXT = FEISHU_OWNER_USER_SCOPES.join(' ');

export const FEISHU_BATCH_PERMISSION_JSON = JSON.stringify({
  scopes: {
    tenant: FEISHU_TENANT_SCOPES,
    user: FEISHU_OWNER_USER_SCOPES,
  },
}, null, 2);

export function parseScopeText(value: string) {
  return [...new Set(value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
}

export function missingOwnerScopes(requested: string, granted: string[]) {
  const grantedSet = new Set(granted);
  return parseScopeText(requested).filter((scope) => !grantedSet.has(scope));
}
