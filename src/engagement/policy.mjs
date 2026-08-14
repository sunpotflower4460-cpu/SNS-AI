const SUPPORTED_KINDS = new Set(['reply', 'dm']);

function engagementError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.engagementStage = 'policy';
  throw error;
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

export function assertAutomatedEngagementAllowed({ account, event }) {
  const config = account?.engagement || {};
  const normalized = normalizeEngagementEvent(event);

  if (config.enabled !== true) engagementError('ENGAGEMENT_DISABLED', 'Automated engagement is disabled for this account.');
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

  return {
    allowed: true,
    kind: normalized.kind,
    approvalRequired: config.approvalRequired !== false,
    inboundOnly: config.inboundOnly !== false,
    oneAutomatedResponsePerInteraction: config.oneAutomatedResponsePerInteraction !== false
  };
}

export function prohibitedGrowthAutomation(action) {
  return new Set(['auto_follow', 'auto_unfollow', 'cold_keyword_reply', 'unsolicited_bulk_dm', 'duplicate_cross_account_post']).has(String(action || '').trim().toLowerCase());
}

export const __test = { SUPPORTED_KINDS };
