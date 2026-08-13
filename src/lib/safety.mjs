import { postsToday } from './history.mjs';

export function platformTextLimit(account) {
  if (account.generation?.maxChars) return Number(account.generation.maxChars);
  return account.platform === 'x' ? 280 : 2200;
}

function urlsIn(text) {
  return [...String(text || '').matchAll(/https?:\/\/[^\s<>]+/gi)].map((match) => {
    try { return new URL(match[0].replace(/[),.;!?]+$/, '')); } catch { return null; }
  }).filter(Boolean);
}

export function validateDraftText(account, text, { requireNonEmpty = true } = {}) {
  const value = String(text || '').trim();
  if (!value) {
    if (requireNonEmpty) throw new Error('AI generated an empty post.');
  } else {
    const limit = platformTextLimit(account);
    if (value.length > limit) throw new Error(`Generated text is ${value.length} characters, over configured limit ${limit}.`);
  }

  const safety = account.safety || {};
  const blocked = safety.blockedPhrases || [];
  const hit = blocked.find((phrase) => phrase && value.includes(phrase));
  if (hit) throw new Error(`Generated text contains blocked phrase: ${hit}`);

  const required = (safety.requiredPhrases || []).filter(Boolean);
  const missing = required.filter((phrase) => !value.includes(phrase));
  if (missing.length) throw new Error(`Generated text is missing required phrase(s): ${missing.join(', ')}`);

  const requiredAny = (safety.requiredAnyPhrases || []).filter(Boolean);
  if (requiredAny.length && !requiredAny.some((phrase) => value.includes(phrase))) {
    throw new Error(`Generated text must contain at least one required disclosure/phrase: ${requiredAny.join(' | ')}`);
  }

  const hashtags = value.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || [];
  const maxHashtags = Number(safety.maxHashtags);
  if (Number.isFinite(maxHashtags) && maxHashtags >= 0 && hashtags.length > maxHashtags) {
    throw new Error(`Generated text has ${hashtags.length} hashtags, over configured maximum ${maxHashtags}.`);
  }

  const urls = urlsIn(value);
  const maxLinks = Number(safety.maxLinks);
  if (Number.isFinite(maxLinks) && maxLinks >= 0 && urls.length > maxLinks) throw new Error(`Generated text has ${urls.length} links, over configured maximum ${maxLinks}.`);

  const blockedDomains = new Set((safety.blockedDomains || []).map((x) => String(x).toLowerCase()));
  const allowedDomains = new Set((safety.allowedDomains || []).map((x) => String(x).toLowerCase()));
  for (const url of urls) {
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if ([...blockedDomains].some((domain) => host === domain || host.endsWith(`.${domain}`))) throw new Error(`Generated text links to blocked domain: ${host}`);
    if (allowedDomains.size && ![...allowedDomains].some((domain) => host === domain || host.endsWith(`.${domain}`))) throw new Error(`Generated text links to non-allowlisted domain: ${host}`);
  }
  return value;
}

export function checkRateLimits(accountId, account, history, now = new Date()) {
  const timeZone = account.schedule?.timezone || 'Asia/Tokyo';
  const maxPostsPerDay = Number(account.safety?.maxPostsPerDay ?? 10);
  const today = postsToday(history, accountId, timeZone, now);
  if (today.length >= maxPostsPerDay) return { ok: false, reason: `daily limit reached (${today.length}/${maxPostsPerDay})` };

  const minMinutes = Number(account.safety?.minMinutesBetweenPosts ?? 15);
  const latest = (history || [])
    .filter((entry) => entry.account === accountId && entry.status === 'published' && entry.at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];

  if (latest) {
    const elapsed = (now.getTime() - Date.parse(latest.at)) / 60000;
    if (!Number.isFinite(elapsed) || elapsed < minMinutes) {
      return { ok: false, reason: Number.isFinite(elapsed) ? `minimum interval not met (${Math.floor(elapsed)}m < ${minMinutes}m)` : 'last post timestamp is unparseable' };
    }
  }
  return { ok: true };
}
