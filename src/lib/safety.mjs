import { postsToday } from './history.mjs';

export function platformTextLimit(account) {
  if (account.generation?.maxChars) return Number(account.generation.maxChars);
  return account.platform === 'x' ? 280 : 2200;
}

export function validateDraftText(account, text) {
  const value = String(text || '').trim();
  if (!value) throw new Error('AI generated an empty post.');
  const limit = platformTextLimit(account);
  if (value.length > limit) {
    throw new Error(`Generated text is ${value.length} characters, over configured limit ${limit}.`);
  }

  const blocked = account.safety?.blockedPhrases || [];
  const hit = blocked.find((phrase) => phrase && value.includes(phrase));
  if (hit) throw new Error(`Generated text contains blocked phrase: ${hit}`);
  return value;
}

export function checkRateLimits(accountId, account, history, now = new Date()) {
  const timeZone = account.schedule?.timezone || 'Asia/Tokyo';
  const maxPostsPerDay = Number(account.safety?.maxPostsPerDay ?? 10);
  const today = postsToday(history, accountId, timeZone, now);
  if (today.length >= maxPostsPerDay) {
    return { ok: false, reason: `daily limit reached (${today.length}/${maxPostsPerDay})` };
  }

  const minMinutes = Number(account.safety?.minMinutesBetweenPosts ?? 15);
  const latest = (history || [])
    .filter((entry) => entry.account === accountId && entry.status === 'published' && entry.at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];

  if (latest) {
    const elapsed = (now.getTime() - Date.parse(latest.at)) / 60000;
    if (elapsed < minMinutes) {
      return { ok: false, reason: `minimum interval not met (${Math.floor(elapsed)}m < ${minMinutes}m)` };
    }
  }
  return { ok: true };
}
