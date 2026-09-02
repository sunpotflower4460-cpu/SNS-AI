import { loadBudgetPolicy, loadXPricing, remainingBudget, projectedMonthEndCost, sumKnownUsd, classifyCostType } from './governor.mjs';
import { reallocate } from './allocation.mjs';

function estimateFromPricing(pricing, { urlPosts = 0, nonUrlPosts = 0, reads = 0, readOperations = 0 } = {}) {
  const url = Number(pricing.costPerUrlPostUsd || 0);
  const nonUrl = Number(pricing.costPerNonUrlPostUsd || 0);
  const read = Number(pricing.costPerReadOperationUsd || 0);
  const base = Number(pricing.monthlyBaseFeeUsd || 0);
  const readCount = Number(reads || readOperations || 0);
  const allZero = url === 0 && nonUrl === 0 && read === 0 && base === 0;
  return classifyCostType({
    estimatedUsd: base + urlPosts * url + nonUrlPosts * nonUrl + readCount * read,
    unknown: allZero
  });
}

function emptyOps() {
  return {
    openai: { count: 0, usd: 0, costType: 'unknown' },
    groq: { count: 0, usd: 0, costType: 'unknown' },
    webSearch: { count: 0, usd: 0, costType: 'unknown' },
    media: { count: 0, usd: 0, costType: 'unknown' },
    image: { count: 0, usd: 0, costType: 'unknown' },
    video: { count: 0, usd: 0, costType: 'unknown' },
    xPosting: { urlPosts: 0, nonUrlPosts: 0, usd: 0, costType: 'estimated' },
    xReads: { count: 0, usd: 0, costType: 'estimated' }
  };
}

export function buildGovernorSnapshot({
  policy,
  pricing,
  month,
  usageByAccount = {},
  xByAccount = {},
  brands = [],
  elapsedDays = 1,
  now = new Date()
} = {}) {
  const operations = emptyOps();
  const perBrand = {};
  const perPlatform = { x: 0, instagram: 0 };
  const lines = [];

  for (const [accountId, usage] of Object.entries(usageByAccount)) {
    operations.openai.count += Number(usage.openai || 0);
    operations.groq.count += Number(usage.groq || 0);
    operations.webSearch.count += Number(usage.webSearch || 0);
    operations.media.count += Number(usage.media || 0);
    operations.image.count += Number(usage.image || 0);
    operations.video.count += Number(usage.video || 0);
    const x = xByAccount[accountId] || {};
    operations.xPosting.urlPosts += Number(x.urlPosts || 0);
    operations.xPosting.nonUrlPosts += Number(x.nonUrlPosts || 0);
    operations.xReads.count += Number(x.readOperations || 0);
    const platform = usage.platform || x.platform || 'x';
    const xCost = estimateFromPricing(pricing, x);
    lines.push({ accountId, brandId: usage.brandId || null, platform, ...xCost });
    if (!perBrand[usage.brandId || accountId]) perBrand[usage.brandId || accountId] = { estimatedUsd: 0, actualUsd: 0 };
    if (xCost.costType === 'estimated') perBrand[usage.brandId || accountId].estimatedUsd += xCost.usd;
    if (xCost.costType === 'actual') perBrand[usage.brandId || accountId].actualUsd += xCost.usd;
    perPlatform[platform] = (perPlatform[platform] || 0) + (xCost.costType === 'unknown' ? 0 : xCost.usd);
  }

  const totals = sumKnownUsd(lines);
  const remaining = remainingBudget(totals.accountedUsd, policy);
  const projected = projectedMonthEndCost({ usedUsd: totals.accountedUsd, elapsedDays });
  const allocation = reallocate({
    brands: brands.map((brand) => ({ brandId: brand.brandId || brand.id })),
    scores: Object.fromEntries(Object.entries(perBrand).map(([id, row]) => [id, (row.estimatedUsd || 0) + (row.actualUsd || 0) + 1])),
    minExplorationShare: policy?.allocation?.minExplorationShare,
    maxBrandShare: policy?.allocation?.maxBrandShare
  });

  return {
    month: month || now.toISOString().slice(0, 7),
    totalEstimatedUsd: totals.estimatedUsd,
    totalActualUsd: totals.actualUsd,
    accountedUsd: totals.accountedUsd,
    unknownCount: totals.unknownCount,
    remainingUsd: remaining.remainingUsd,
    projectedMonthEndUsd: projected,
    budgetState: remaining.state,
    monthlyBudgetUsd: policy.monthlyBudgetUsd,
    operations,
    perBrand,
    perPlatform,
    allocation,
    pricingNote: 'operator-maintained estimates; zero means unpriced, not a fabricated rate'
  };
}

export async function loadGovernorInputs() {
  const [policy, pricing] = await Promise.all([loadBudgetPolicy(), loadXPricing()]);
  return { policy, pricing };
}

export const __test = { estimateFromPricing, emptyOps };
