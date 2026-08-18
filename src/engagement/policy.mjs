import { readFile } from 'node:fs/promises';
import { xAiReplyApprovalReady, xAiReplyApprovalRequired } from './readiness.mjs';

const POLICY_FILE = new URL('../../config/engagement-policy.json', import.meta.url);
const SUPPORTED_KINDS = new Set(['reply', 'dm']);
const ACCOUNT_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;

function engagementError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.engagementStage = 'policy';
  throw error;
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function strictAccountList(policy, key) {
  const value = policy[key];
  if (!Array.isArray(value)) throw new Error(`config/engagement-policy.json ${key} must be an array.`);
  const normalized = value.map((item) => String(item));
  if (normalized.some((item) => !ACCOUNT_ID_RE.test(item))) {
    throw new Error(`config/engagement-policy.json ${key} contains an invalid account id.`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`config/engagement-policy.json ${key} must not contain duplicate account ids.`);
  }
  return normalized;
}

export const REPLY_SCOPES = new Set(['own-posts', 'all-mentions']);

// Which inbound X mentions are eligible for an automated reply.
//   own-posts    - only mentions inside a thread rooted at one of our own published posts
//   all-mentions - every @-mention, including cold mentions from strangers
// Defaults to the narrow scope, and anything unrecognised also resolves to it, so a typo can never
// widen automated outreach. Broadening is a deliberate, explicit config change.
export function replyScopeFor(policy = {}) {
  const value = String(policy.replyScope || '').trim().toLowerCase();
  return REPLY_SCOPES.has(value) ? value : 'own-posts';
}

// Fail-closed coercion for the three knobs that decide how much automation is allowed to happen.
// Mirrors safeMaxPostsPerDay/safeMinMinutesBetweenPosts in src/lib/safety.mjs: a malformed limit must
// REDUCE automation, never silently remove the limit.
//
// Before this, run.mjs used a bare Number(), so `"twelve"` became NaN and every guard that reads it
// (`sentToday >= maxPerDay`, `confidence < threshold`, `cooldownDue > Date.now()`) evaluated false -
// unlimited automated replies, no confidence floor, and no per-actor cooldown, all from one typo.
//
// The runtime coercion is required IN ADDITION to validateEngagementPolicy, because
// effectiveEngagementPolicy merges an unvalidated per-account `account.engagement` object over the
// validated global policy file - an account-level override never passes through file validation.
export function safeDailyAutomationCap(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function safeCooldownMinutes(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
}

export function safeConfidenceThreshold(value, fallback) {
  if (value == null) return fallback;
  // Confidence is a 0..1 score, so an unreachable threshold routes every candidate to a human instead
  // of auto-sending. Anything outside that range is treated as malformed.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : Number.POSITIVE_INFINITY;
}

function strictLimit(policy, key, { integer = false, min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const value = policy[key];
  if (value == null) return;
  const invalid = typeof value !== 'number'
    || !Number.isFinite(value)
    || value < min
    || value > max
    || (integer && !Number.isInteger(value));
  if (invalid) {
    throw new Error(`config/engagement-policy.json ${key} must be a ${integer ? 'non-negative integer' : `number in ${min}..${max}`}.`);
  }
}

function strictFlag(policy, key) {
  if (policy[key] == null) return;
  if (typeof policy[key] !== 'boolean') throw new Error(`config/engagement-policy.json ${key} must be a boolean.`);
}

export function validateEngagementPolicy(policy) {
  if (!plainObject(policy)) throw new Error('config/engagement-policy.json must contain an object.');
  if (Number(policy.schemaVersion || 0) >= 4) {
    // The automation limits are the safety envelope for unattended operation. Reject a malformed value
    // at load time so the operator sees the typo, rather than discovering it through unlimited replies.
    for (const key of ['enabled', 'inboundOnly', 'autoReply', 'autoDmReply', 'approvalRequired', 'oneAutomatedResponsePerInteraction']) {
      strictFlag(policy, key);
    }
    strictLimit(policy, 'maxAutomatedRepliesPerDay', { integer: true });
    strictLimit(policy, 'maxAutomatedDmRepliesPerDay', { integer: true });
    strictLimit(policy, 'replyCooldownMinutes');
    strictLimit(policy, 'dmCooldownMinutes');
    strictLimit(policy, 'minAutoReplyConfidence', { max: 1 });
    strictLimit(policy, 'maxInboundFetchesPerDay', { integer: true });
    if (policy.replyScope != null && !REPLY_SCOPES.has(String(policy.replyScope))) {
      throw new Error(`config/engagement-policy.json replyScope must be one of ${[...REPLY_SCOPES].join(', ')}.`);
    }
    strictAccountList(policy, 'allowedAccounts');
    strictAccountList(policy, 'liveAccounts');
    strictAccountList(policy, 'xAutomationProfileComplianceConfirmedAccounts');
    const required = strictAccountList(policy, 'xAiReplyBotApprovalRequiredAccounts');
    const confirmed = strictAccountList(policy, 'xAiReplyBotApprovalConfirmedAccounts');
    if (typeof policy.xAutomatedResponseOptOutText !== 'string' || !policy.xAutomatedResponseOptOutText.trim()) {
      throw new Error('config/engagement-policy.json xAutomatedResponseOptOutText must be a non-empty string.');
    }
    const requiredSet = new Set(required);
    const extraConfirmed = confirmed.filter((id) => !requiredSet.has(id));
    if (extraConfirmed.length) {
      throw new Error(`config/engagement-policy.json xAiReplyBotApprovalConfirmedAccounts contains account(s) not listed as required: ${extraConfirmed.join(', ')}.`);
    }
  }
  return policy;
}

export async function loadEngagementPolicy() {
  const raw = await readFile(POLICY_FILE, 'utf8');
  return validateEngagementPolicy(JSON.parse(raw));
}

export function effectiveEngagementPolicy(globalPolicy = {}, account = {}) {
  const accountPolicy = plainObject(account?.engagement) ? account.engagement : {};
  return { ...globalPolicy, ...accountPolicy };
}

export function normalizeEngagementEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) engagementError('ENGAGEMENT_EVENT_INVALID', 'Engagement event must be an object.');
  const kind = String(value.kind || '').trim().toLowerCase();
  if (!SUPPORTED_KINDS.has(kind)) engagementError('ENGAGEMENT_KIND_UNSUPPORTED', `Unsupported engagement kind "${kind}".`);
  return {
    ...value,
    kind,
    inbound: value.inbound === true,
    userOptedOut: value.userOptedOut === true,
    alreadyAutoResponded: value.alreadyAutoResponded === true,
    keywordDiscoveryOnly: value.keywordDiscoveryOnly === true,
    sensitive: value.sensitive === true,
    asksForHuman: value.asksForHuman === true
  };
}

function xAiPublicReplyNeedsApproval(config, accountId, event) {
  return String(event?.platform || '').toLowerCase() === 'x'
    && event?.kind === 'reply'
    && xAiReplyApprovalRequired(config, accountId)
    && !xAiReplyApprovalReady(config, accountId);
}

export function assertAutomatedEngagementAllowed({ account, event, globalPolicy = {} }) {
  const config = effectiveEngagementPolicy(globalPolicy, account);
  const normalized = normalizeEngagementEvent(event);
  const accountId = String(account?.id || '');
  const allowedAccounts = Array.isArray(config.allowedAccounts) ? config.allowedAccounts.map(String) : null;

  if (config.enabled !== true) engagementError('ENGAGEMENT_DISABLED', 'Automated engagement is disabled for this account.');
  if (allowedAccounts && !allowedAccounts.includes(accountId)) {
    engagementError('ENGAGEMENT_ACCOUNT_NOT_ALLOWED', 'Automated engagement is not allowlisted for this account.');
  }
  if (config.inboundOnly !== false && !normalized.inbound) engagementError('ENGAGEMENT_UNSOLICITED', 'Cold or unsolicited automated engagement is not allowed.');
  if (normalized.keywordDiscoveryOnly) engagementError('ENGAGEMENT_KEYWORD_COLD_REPLY', 'Keyword-search-only automated replies are not allowed.');
  if (normalized.userOptedOut) engagementError('ENGAGEMENT_OPTED_OUT', 'The user opted out of automated responses.');
  if (config.oneAutomatedResponsePerInteraction !== false && normalized.alreadyAutoResponded) {
    engagementError('ENGAGEMENT_ALREADY_RESPONDED', 'Only one automated response is allowed per user interaction.');
  }
  if (normalized.sensitive || normalized.asksForHuman) {
    engagementError('ENGAGEMENT_HUMAN_REQUIRED', 'Sensitive or explicitly human-requested interactions require manual handling.');
  }
  if (normalized.kind === 'reply' && config.autoReply !== true) engagementError('ENGAGEMENT_REPLY_DISABLED', 'Automated replies are disabled.');
  if (normalized.kind === 'dm' && config.autoDmReply !== true) engagementError('ENGAGEMENT_DM_DISABLED', 'Automated DM replies are disabled.');

  const platformApprovalRequired = xAiPublicReplyNeedsApproval(config, accountId, normalized);

  return {
    allowed: true,
    kind: normalized.kind,
    approvalRequired: platformApprovalRequired || config.approvalRequired !== false,
    platformApprovalRequired,
    inboundOnly: config.inboundOnly !== false,
    oneAutomatedResponsePerInteraction: config.oneAutomatedResponsePerInteraction !== false
  };
}

export function prohibitedGrowthAutomation(action) {
  return new Set(['auto_follow', 'auto_unfollow', 'cold_keyword_reply', 'unsolicited_bulk_dm', 'duplicate_cross_account_post']).has(String(action || '').trim().toLowerCase());
}

export const __test = { SUPPORTED_KINDS, plainObject, strictAccountList, xAiPublicReplyNeedsApproval, ACCOUNT_ID_RE };
