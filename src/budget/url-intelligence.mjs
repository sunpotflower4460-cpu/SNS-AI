import { decideLinkUsage, postHasLink } from '../research/link-policy.mjs';

export function expectedUrlValue({
  predictedScore = 50,
  purpose = null,
  recentUrlAverage = null,
  remainingWeekly = null
} = {}) {
  let score = Number(predictedScore) || 0;
  if (['highValueDiscovery', 'sale', 'release', 'musicDiscovery'].includes(purpose)) score += 10;
  if (Number.isFinite(Number(recentUrlAverage))) score = (score + Number(recentUrlAverage)) / 2;
  if (remainingWeekly === 0) score = 0;
  return Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
}

export function urlMeaningDependsOnLink(text) {
  const body = String(text || '');
  if (!postHasLink({ text: body })) return false;
  return /(詳しくはこちら|リンクから|check( this)? out|listen here|公式はこちら)/i.test(body);
}

export function decideUrlInvestment({
  accountId,
  account,
  history,
  draft,
  brandUrlBudget = null,
  predictedScore = 50,
  recentUrlAverage = null,
  now = new Date()
} = {}) {
  const mergedAccount = brandUrlBudget
    ? {
      ...account,
      linkPolicy: {
        ...(account?.linkPolicy || {}),
        maxUrlPostsPerWeek: account?.linkPolicy?.maxUrlPostsPerWeek ?? brandUrlBudget.maxUrlPostsPerWeek,
        maxUrlPostsPerDay: account?.linkPolicy?.maxUrlPostsPerDay ?? brandUrlBudget.maxUrlPostsPerDay
      }
    }
    : account;

  const wantsLink = Boolean(draft?.features?.linkRequired) || postHasLink(draft);
  const gate = decideLinkUsage({
    accountId,
    account: mergedAccount,
    history,
    wantsLink,
    purpose: draft?.features?.linkPurpose || null,
    now
  });

  const usage = gate.usage || { daily: 0, weekly: 0 };
  const weeklyCap = mergedAccount?.linkPolicy?.maxUrlPostsPerWeek;
  const remainingWeekly = weeklyCap == null ? null : Math.max(0, weeklyCap - usage.weekly);
  const value = expectedUrlValue({
    predictedScore,
    purpose: draft?.features?.linkPurpose || null,
    recentUrlAverage,
    remainingWeekly
  });

  if (!wantsLink) return { action: 'no-link', gate, value };
  if (gate.allowed && value >= 40) return { action: 'publish-url', gate, value };

  if (urlMeaningDependsOnLink(draft?.text)) {
    return { action: 'defer', gate, value, reason: 'url-is-load-bearing' };
  }
  if (!gate.allowed) return { action: 'convert-to-no-link', gate, value, reason: gate.reason };
  return { action: 'convert-to-no-link', gate, value, reason: 'low-expected-value' };
}

export const __test = { expectedUrlValue, urlMeaningDependsOnLink };
