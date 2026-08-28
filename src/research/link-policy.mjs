import { localDateKey } from '../lib/schedule.mjs';

const URL_PATTERN = /https?:\/\/\S+/i;
const DEFAULT_LINK_POLICY = { preferNoLink: false, maxUrlPostsPerWeek: null, maxUrlPostsPerDay: null, purposes: [] };

export function postHasLink(entry) {
  return URL_PATTERN.test(String(entry?.text || ''));
}

function withinDays(entry, now, days) {
  const at = Date.parse(entry?.at || '');
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at < days * 86_400_000;
}

// Reuses the existing published-post history (src/lib/history.mjs) rather than a new counter file: a
// "URL post" is simply a published entry whose text contains a link, so daily/weekly usage is always
// derived from the one ledger that is already the source of truth for what was actually posted.
export function urlPostUsage(history, accountId, timeZone, now = new Date()) {
  const published = (history || []).filter((entry) => entry.account === accountId && entry.status === 'published' && postHasLink(entry));
  const today = localDateKey(now, timeZone);
  const daily = published.filter((entry) => localDateKey(new Date(entry.at), timeZone) === today).length;
  const weekly = published.filter((entry) => withinDays(entry, now, 7)).length;
  return { daily, weekly };
}

export function resolveLinkPolicy(account) {
  return { ...DEFAULT_LINK_POLICY, ...(account?.linkPolicy || {}) };
}

// The one gate that decides whether a candidate draft is allowed to keep a URL. wantsLink reflects what
// the AI/candidate proposed (either an explicit features.linkRequired judgement, or simply "the text has
// a URL in it" for older candidates that never set that field); this function can only ever narrow that
// down to false, never turn a no-link draft into one with a link. A missing accountId/account.linkPolicy
// resolves to the safe default (preferNoLink:false, no caps), so an account that never configured
// linkPolicy behaves exactly as it always did.
export function decideLinkUsage({ accountId, account, history, wantsLink, purpose = null, now = new Date() }) {
  const policy = resolveLinkPolicy(account);
  if (!wantsLink) return { allowed: false, reason: 'not-requested', policy };
  if (policy.purposes?.length && purpose && !policy.purposes.includes(purpose)) {
    return { allowed: false, reason: `purpose "${purpose}" is not in linkPolicy.purposes`, policy };
  }
  const timeZone = account?.schedule?.timezone || account?.timezone || 'Asia/Tokyo';
  const usage = urlPostUsage(history, accountId, timeZone, now);
  if (policy.maxUrlPostsPerDay != null && usage.daily >= policy.maxUrlPostsPerDay) {
    return { allowed: false, reason: `daily URL post cap reached (${usage.daily}/${policy.maxUrlPostsPerDay})`, policy, usage };
  }
  if (policy.maxUrlPostsPerWeek != null && usage.weekly >= policy.maxUrlPostsPerWeek) {
    return { allowed: false, reason: `weekly URL post cap reached (${usage.weekly}/${policy.maxUrlPostsPerWeek})`, policy, usage };
  }
  return { allowed: true, policy, usage };
}

// Design-only preparation for future affiliate rollout (see docs/LOW_COST_RESEARCH.md): resolves the
// URL to actually attach, preferring an affiliate URL only when the account has one AND affiliate
// monetization is enabled, and always falling back to the official URL otherwise. No affiliate
// application/registration happens here or anywhere else in this change - account.monetization.affiliate
// stays disabled for music-tools-x.
export function resolveLinkUrl({ account, officialUrl, affiliateUrl }) {
  const affiliateEnabled = account?.monetization?.affiliate?.enabled === true;
  if (affiliateEnabled && affiliateUrl) return { url: affiliateUrl, kind: 'affiliate' };
  if (officialUrl) return { url: officialUrl, kind: 'official' };
  return { url: null, kind: 'none' };
}

export const __test = { DEFAULT_LINK_POLICY };
