import { postsToday } from './history.mjs';

const X_TRANSFORMED_URL_LENGTH = 23;
const X_WEIGHT_ONE_RANGES = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247]
];
const X_EMOJI_CLUSTER = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;
const X_INVALID_CHARS = /[\uFFFE\uFEFF\uFFFF]/u;
const X_GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });
const URL_CANDIDATE = /(?:https?:\/\/[^\s<>]+|(?:(?:www\.)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[\p{L}\p{N}-]{2,59})(?::\d{1,5})?(?:\/[^\s<>]*)?))/giu;
const URL_TRAILING_PUNCTUATION = /[),.;!?…。、，．！？：；）】」』〉》\]}]+$/u;

function positiveConfiguredLimit(value, fallback, label) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    // Keep the long-standing outward error wording for API/test compatibility while enforcing the
    // stricter integer-only runtime rule internally.
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

function urlEntities(text) {
  const value = String(text || '');
  const entities = [];
  for (const match of value.matchAll(URL_CANDIDATE)) {
    const raw = match[0];
    const hasScheme = /^https?:\/\//i.test(raw);
    const previous = match.index > 0 ? value[match.index - 1] : '';
    // twitter-text does not interpret the domain portion of an email/identifier as a URL.
    if (!hasScheme && previous && /[\p{L}\p{M}\p{N}_@&]/u.test(previous)) continue;
    const urlText = raw.replace(URL_TRAILING_PUNCTUATION, '');
    if (!urlText) continue;
    const normalized = hasScheme ? urlText : `https://${urlText}`;
    let url;
    try { url = new URL(normalized); } catch { continue; }
    if (!url.hostname || !url.hostname.includes('.')) continue;
    entities.push({
      start: match.index,
      end: match.index + urlText.length,
      text: urlText,
      url
    });
  }
  return entities;
}

function urlsIn(text) {
  return urlEntities(text).map((entity) => entity.url);
}

function xUrlSpans(text) {
  return urlEntities(text).map(({ start, end }) => ({ start, end }));
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

function hashtagsIn(text) {
  const pattern = /(^|[^\p{L}\p{M}\p{N}_&])([#＃])([\p{L}\p{M}\p{N}_]*[\p{L}\p{M}_][\p{L}\p{M}\p{N}_]*)/gu;
  return [...String(text || '').matchAll(pattern)];
}

export function validateDraftText(account, text, { requireNonEmpty = true } = {}) {
  const value = String(text || '').trim();
  if (!value) {
    if (requireNonEmpty) throw new Error('AI generated an empty post.');
  } else {
    if (account.platform === 'x' && X_INVALID_CHARS.test(value)) {
      throw new Error('Generated X text contains a character that X does not accept.');
    }
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

  const hashtags = hashtagsIn(value);
  const maxHashtags = optionalNonNegativeInteger(safety.maxHashtags, 'safety.maxHashtags');
  if (maxHashtags != null && hashtags.length > maxHashtags) {
    throw new Error(`Generated text has ${hashtags.length} hashtags, over configured maximum ${maxHashtags}.`);
  }

  const urls = urlsIn(value);
  const maxLinks = optionalNonNegativeInteger(safety.maxLinks, 'safety.maxLinks');
  if (maxLinks != null && urls.length > maxLinks) throw new Error(`Generated text has ${urls.length} links, over configured maximum ${maxLinks}.`);

  const blockedDomains = new Set((safety.blockedDomains || []).map((x) => String(x).toLowerCase().replace(/^www\./, '')));
  const allowedDomains = new Set((safety.allowedDomains || []).map((x) => String(x).toLowerCase().replace(/^www\./, '')));
  for (const url of urls) {
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if ([...blockedDomains].some((domain) => host === domain || host.endsWith(`.${domain}`))) throw new Error(`Generated text links to blocked domain: ${host}`);
    if (allowedDomains.size && ![...allowedDomains].some((domain) => host === domain || host.endsWith(`.${domain}`))) throw new Error(`Generated text links to non-allowlisted domain: ${host}`);
  }
  return value;
}

// A malformed runtime safety knob must not silently disable posting limits. Standard GitHub Actions
// also run strict config validation first; these fallbacks are defense in depth for direct invocation.
function safeMaxPostsPerDay(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
function safeMinMinutesBetweenPosts(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
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

export const __test = { urlEntities, hashtagsIn };
