export function engagementCredentialError(message) {
  const error = new Error(message);
  error.code = 'ENGAGEMENT_CREDENTIALS_NOT_READY';
  return error;
}

export function engagementPlatformApprovalError(accountId) {
  const error = new Error(`X AI-powered automated public replies are not approved for ${accountId}. Record X's prior written and explicit approval before live engagement activation.`);
  error.code = 'ENGAGEMENT_PLATFORM_APPROVAL_REQUIRED';
  return error;
}

export function allowedEngagementAccount(policy = {}, accountId) {
  const allowed = Array.isArray(policy.allowedAccounts) ? new Set(policy.allowedAccounts.map(String)) : null;
  return !allowed || allowed.has(String(accountId));
}

export function xAiReplyApprovalRequired(policy = {}, accountId) {
  const required = new Set(Array.isArray(policy.xAiReplyBotApprovalRequiredAccounts) ? policy.xAiReplyBotApprovalRequiredAccounts.map(String) : []);
  return required.has(String(accountId));
}

export function xAiReplyApprovalReady(policy = {}, accountId) {
  if (!xAiReplyApprovalRequired(policy, accountId)) return true;
  const confirmed = new Set(Array.isArray(policy.xAiReplyBotApprovalConfirmedAccounts) ? policy.xAiReplyBotApprovalConfirmedAccounts.map(String) : []);
  return confirmed.has(String(accountId));
}

export function assertXAiReplyApproval(policy = {}, accountId) {
  if (!xAiReplyApprovalReady(policy, accountId)) throw engagementPlatformApprovalError(accountId);
  return { ok: true, required: xAiReplyApprovalRequired(policy, accountId), confirmed: true };
}

export function liveEngagementAccount(policy = {}, accountId) {
  const live = Array.isArray(policy.liveAccounts)
    ? new Set(policy.liveAccounts.map(String)).has(String(accountId))
    : allowedEngagementAccount(policy, accountId);
  // A misordered rollout must fail loudly instead of silently starting an X AI reply bot or creating
  // one human Issue per inbound interaction. Dry-run callers short-circuit before this predicate.
  if (live) assertXAiReplyApproval(policy, accountId);
  return live;
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
