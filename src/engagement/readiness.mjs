export function engagementCredentialError(message) {
  const error = new Error(message);
  error.code = 'ENGAGEMENT_CREDENTIALS_NOT_READY';
  return error;
}

export function allowedEngagementAccount(policy = {}, accountId) {
  const allowed = Array.isArray(policy.allowedAccounts) ? new Set(policy.allowedAccounts.map(String)) : null;
  return !allowed || allowed.has(String(accountId));
}

export function liveEngagementAccount(policy = {}, accountId) {
  if (Array.isArray(policy.liveAccounts)) return new Set(policy.liveAccounts.map(String)).has(String(accountId));
  // Backward compatibility for policies created before schemaVersion 3. New production policy always
  // declares liveAccounts explicitly so a config upgrade cannot accidentally activate engagement.
  return allowedEngagementAccount(policy, accountId);
}

export function requiredXEngagementScopes(policy = {}) {
  const required = new Set();
  if (policy.autoReply === true || policy.autoDmReply === true) {
    required.add('tweet.read');
    required.add('users.read');
    required.add('offline.access');
  }
  if (policy.autoReply === true) required.add('tweet.write');
  if (policy.autoDmReply === true) {
    required.add('dm.read');
    required.add('dm.write');
  }
  return [...required];
}

export function assertXEngagementCredential(identity, policy = {}) {
  const scopes = new Set(String(identity?.session?.scope || '').split(/\s+/).filter(Boolean));
  const missing = requiredXEngagementScopes(policy).filter((scope) => !scopes.has(scope));
  if (missing.length) throw engagementCredentialError(`X engagement OAuth2 is missing required scopes: ${missing.join(', ')}.`);
  if ((policy.autoReply === true || policy.autoDmReply === true) && identity?.session?.hasRefreshToken !== true) {
    throw engagementCredentialError('X engagement automation requires an offline.access refresh token for unattended long-running operation.');
  }
  return { ok: true, scopes: [...scopes], refreshTokenReady: identity?.session?.hasRefreshToken === true };
}
