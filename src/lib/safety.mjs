import { postsToday } from './history.mjs';

const X_TRANSFORMED_URL_LENGTH = 23;
const X_WEIGHT_ONE_RANGES = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247]
];
const X_EMOJI_CLUSTER = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;
const X_GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

function positiveConfiguredLimit(value, fallback, label) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}

function optionalNonNegativeInteger(value, label) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

export function platformTextLimit(account) {
  const fallback = account.platform === 'x' ? 280 : 2200;
  return positiveConfiguredLimit(account.generation?.maxChars, fallback, 'generation.maxChars');
}

function urlsIn(text) {
  return [...String(text || '').matchAll(/https?:\/\/[^\s<>]+/gi)].map((match) => {
    try { return new URL(match[0].replace(/[),.;!?]+$/, '')); } catch { return null; }
  }).filter(Boolean);
}

function xUrlSpans(text) {
  const spans = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>]+/gi)) {
    const raw = match[0];
    const urlText = raw.replace(/[),.;!?]+$/, '');
    if (!urlText) continue;
    try { new URL(urlText); } catch { continue; }
    spans.push({ start: match.index, end: match.index + urlText.length });
  }
  return spans;
}

function xCodePointWeight(codePoint) {
  return X_WEIGHT_ONE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end) ? 1 : 2;
}

function xWeightedNonUrlText(text) {
  let total = 0;
  for (const { segment } of X_GRAPHEMES.segment(text)) {
    if (X_EMOJI_CLUSTER.test(segment)) {
      total += 2;
      continue;
    }
    for (const character of segment) total += xCodePointWeight(character.codePointAt(0));
  }
  return total;
}

export function xWeightedLength(text) {
  const normalized = String(text || '').normalize('NFC');
  const spans = xUrlSpans(normalized);
  let total = 0;
  let cursor = 0;
  for (const span of spans) {
    total += xWeightedNonUrlText(normalized.slice(cursor, span.start));
    total += X_TRANSFORMED_URL_LENGTH;
    cursor = span.end;
  }
  total += xWeightedNonUrlText(normalized.slice(cursor));
  return total;
}

function platformTextLength(account, value) {
  return account.platform === 'x' ? xWeightedLength(value) : value.length;
}

export function validateDraftText(account, text, { requireNonEmpty = true } = {}) {
  const value = String(text || '').trim();
  if (!value) {
    if (requireNonEmpty) throw new Error('AI generated an empty post.');
  } else {
    const limit = platformTextLimit(account);
    const length = platformTextLength(account, value);
    if (length > limit) {
      const unit = account.platform === 'x' ? 'weighted characters' : 'characters';
      throw new Error(`Generated text is ${length} ${unit}, over configured limit ${limit}.`);
    }
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
  const maxHashtags = optionalNonNegativeInteger(safety.maxHashtags, 'safety.maxHashtags');
  if (maxHashtags != null && hashtags.length > maxHashtags) {
    throw new Error(`Generated text has ${hashtags.length} hashtags, over configured maximum ${maxHashtags}.`);
  }

  const urls = urlsIn(value);
  const maxLinks = optionalNonNegativeInteger(safety.maxLinks, 'safety.maxLinks');
  if (maxLinks != null && urls.length > maxLinks) throw new Error(`Generated text has ${urls.length} links, over configured maximum ${maxLinks}.`);

  const blockedDomains = new Set((safety.blockedDomains || []).map((x) => String(x).toLowerCase()));
  const allowedDomains = new Set((safety.allowedDomains || []).map((x) => String(x).toLowerCase()));
  for (const url of urls) {
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if ([...blockedDomains].some((domain) => host === domain || host.endsWith(`.${domain}`))) throw new Error(`Generated text links to blocked domain: ${host}`);
    if (allowedDomains.size && ![...allowedDomains].some((domain) => host === domain || host.endsWith(`.${domain}`))) throw new Error(`Generated text links to non-allowlisted domain: ${host}`);
  }
  return value;
}

// A non-finite safety knob (a typo, a bad merge, or any config that bypassed npm run validate) must
// never silently disable the guardrail it configures: `n >= NaN` and `n < NaN` are both always false,
// so `Number(garbage)` compared directly would fail OPEN (unlimited posting) instead of falling back
// to the safe default. A negative maxPostsPerDay is left as-is: `today.length(>=0) >= negative` is
// already always true, i.e. it already fails closed (blocks every post) on its own. A negative
// minMinutesBetweenPosts has no equivalent natural fail-closed comparison (`elapsed < negative` is
// always false, disabling the cooldown entirely), so it also falls back to the safe default.
// `value == null` (unset/explicit null) is checked BEFORE Number() conversion in both: Number(null) is
// 0, not NaN, so without this check an explicit null would silently become "block every post" /
// "no cooldown at all" instead of "use the default" - the same class of bug for a different reason.
function safeMaxPostsPerDay(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function safeMinMinutesBetweenPosts(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function checkRateLimits(accountId, account, history, now = new Date()) {
  const timeZone = account.schedule?.timezone || 'Asia/Tokyo';
  const maxPostsPerDay = safeMaxPostsPerDay(account.safety?.maxPostsPerDay, 10);
  const today = postsToday(history, accountId, timeZone, now);
  if (today.length >= maxPostsPerDay) return { ok: false, reason: `daily limit reached (${today.length}/${maxPostsPerDay})` };

  const minMinutes = safeMinMinutesBetweenPosts(account.safety?.minMinutesBetweenPosts, 15);
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
