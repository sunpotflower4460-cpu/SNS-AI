import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts } from '../lib/config.mjs';
import { readHistory } from '../lib/history.mjs';
import { readAudit } from '../lib/audit.mjs';
import { loadTrendBrief } from '../research/trends.mjs';
import { usageToday } from '../ops/budget.mjs';
import { postHasLink } from '../research/link-policy.mjs';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { loadGovernorInputs, buildGovernorSnapshot } from '../budget/snapshot.mjs';
import { loadBrandsFile } from '../brands/registry.mjs';

const JSON_PATH = fileURLToPath(new URL('../../data/reports/cost.json', import.meta.url));
const MD_PATH = fileURLToPath(new URL('../../data/reports/cost.md', import.meta.url));
const PRICING_PATH = fileURLToPath(new URL('../../config/x-api-pricing.json', import.meta.url));
const DEFAULT_PRICING = { monthlyBaseFeeUsd: 0, costPerUrlPostUsd: 0, costPerNonUrlPostUsd: 0, costPerReadOperationUsd: 0 };
const DAY = 86_400_000;

async function loadPricing() {
  return readJson(PRICING_PATH, DEFAULT_PRICING);
}

function withinLastDays(atValue, nowMs, days) {
  const at = Date.parse(atValue || '');
  return Number.isFinite(at) && nowMs - at < days * DAY;
}

function sourceTypeCount(sourceResults, types) {
  return (sourceResults || [])
    .filter((row) => types.includes(row.type) && row.status === 'ok')
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
}

// Answers "what is actually costing money" (see requirement: 情報収集・AI処理・X API利用のコスト可視化):
// research fetch/dedup counts from the last persisted trend brief (src/research/trends.mjs), today's AI
// provider usage from the existing budget ledger (src/ops/budget.mjs), and an X API usage/estimated-cost
// summary derived from published post history (src/lib/history.mjs) plus an operator-maintained pricing
// model (config/x-api-pricing.json). Nothing here invents numbers X itself does not expose. The pricing
// file is an operator-maintained estimate (currently 2026-09-02 X Pay-Per-Use); missing-file fallback is zero.
export async function buildCostReport({ accountFilter, now = new Date() } = {}) {
  const accounts = await loadAccounts();
  if (accountFilter && !accounts[accountFilter]) throw new Error(`Unknown account "${accountFilter}".`);
  const history = await readHistory();
  const audit = await readAudit();
  const pricing = await loadPricing();
  const nowMs = now.getTime();
  const result = { generatedAt: now.toISOString(), pricingModel: pricing, accounts: {} };

  for (const [accountId, account] of Object.entries(accounts)) {
    if (accountFilter && accountId !== accountFilter) continue;
    const brief = await loadTrendBrief(accountId);
    const research = brief?.research || null;
    const sourceFailuresRecorded = audit.filter((row) => row.account === accountId && row.stage === 'research-source-failed').length;

    const aiUsageToday = {
      groqRequests: await usageToday(accountId, account, 'groq'),
      openaiRequests: await usageToday(accountId, account, 'openai'),
      webSearchRequests: await usageToday(accountId, account, 'webSearch'),
      mediaRequests: await usageToday(accountId, account, 'media'),
      imageGenerations: await usageToday(accountId, account, 'image'),
      videoGenerations: await usageToday(accountId, account, 'video')
    };

    let xApi = null;
    if (account.platform === 'x') {
      const published = history.filter((entry) => entry.account === accountId && entry.status === 'published' && withinLastDays(entry.at, nowMs, 30));
      const urlPosts = published.filter(postHasLink).length;
      const nonUrlPosts = published.length - urlPosts;
      const readOperations = audit.filter((row) => row.account === accountId && row.stage === 'metrics-collected' && withinLastDays(row.at, nowMs, 30)).length;
      const estimatedMonthlyCostUsd = Math.round((
        Number(pricing.monthlyBaseFeeUsd || 0)
        + urlPosts * Number(pricing.costPerUrlPostUsd || 0)
        + nonUrlPosts * Number(pricing.costPerNonUrlPostUsd || 0)
        + readOperations * Number(pricing.costPerReadOperationUsd || 0)
      ) * 100) / 100;
      xApi = { periodDays: 30, urlPosts, nonUrlPosts, readOperations, estimatedMonthlyCostUsd };
    }

    result.accounts[accountId] = {
      platform: account.platform,
      brandId: account.brandId || null,
      research: research ? {
        mode: research.mode,
        directFetchCount: research.fetchedCount ?? 0,
        freshCount: research.freshCount ?? 0,
        duplicateDrops: research.duplicateCount ?? 0,
        rssFetchCount: sourceTypeCount(research.sourceResults, ['rss', 'atom']),
        githubFetchCount: sourceTypeCount(research.sourceResults, ['github-releases']),
        totalSources: research.totalSources ?? 0,
        failedSources: research.failedSources ?? 0,
        sourceFailuresRecorded
      } : null,
      aiUsageToday,
      xApi
    };
  }

  const { policy } = await loadGovernorInputs();
  const brandsFile = await loadBrandsFile();
  const usageByAccount = {};
  const xByAccount = {};
  for (const [accountId, row] of Object.entries(result.accounts)) {
    usageByAccount[accountId] = {
      brandId: row.brandId,
      platform: row.platform,
      openai: row.aiUsageToday.openaiRequests,
      groq: row.aiUsageToday.groqRequests,
      webSearch: row.aiUsageToday.webSearchRequests,
      media: row.aiUsageToday.mediaRequests,
      image: row.aiUsageToday.imageGenerations,
      video: row.aiUsageToday.videoGenerations
    };
    if (row.xApi) xByAccount[accountId] = row.xApi;
  }
  result.governor = buildGovernorSnapshot({
    policy,
    pricing,
    month: now.toISOString().slice(0, 7),
    usageByAccount,
    xByAccount,
    brands: Object.entries(brandsFile.brands || {}).map(([brandId, brand]) => ({ brandId, ...brand })),
    elapsedDays: now.getUTCDate(),
    now
  });
  result.costTypesNote = 'actual = live billing API (none wired). estimated = operator-maintained model. unknown = unpriced, not a fabricated rate.';

  await writeJsonAtomic(JSON_PATH, result);
  const lines = [
    '# SNS-AI Cost & Usage Visibility', '', `Generated: ${result.generatedAt}`, '',
    '> pricingModel values are operator-maintained estimates (config/x-api-pricing.json), not real X billing data.',
    `> Global budget: $${result.governor.monthlyBudgetUsd} | accounted $${result.governor.accountedUsd} | remaining $${result.governor.remainingUsd} | projected month-end $${result.governor.projectedMonthEndUsd} | state **${result.governor.budgetState}**`,
    `> ${result.costTypesNote}`, ''
  ];
  for (const [id, row] of Object.entries(result.accounts)) {
    lines.push(`## ${id} (${row.platform})`);
    lines.push(`- AI usage today: Groq ${row.aiUsageToday.groqRequests}, OpenAI ${row.aiUsageToday.openaiRequests}, Web Search ${row.aiUsageToday.webSearchRequests}, media ${row.aiUsageToday.mediaRequests}, image gen ${row.aiUsageToday.imageGenerations}, video gen ${row.aiUsageToday.videoGenerations}`);
    if (row.research) {
      lines.push(`- Research (mode: ${row.research.mode || 'n/a'}): direct-fetched ${row.research.directFetchCount}, fresh ${row.research.freshCount}, duplicates dropped ${row.research.duplicateDrops}, RSS items ${row.research.rssFetchCount}, GitHub release items ${row.research.githubFetchCount}, source failures ${row.research.failedSources}/${row.research.totalSources}`);
    }
    if (row.xApi) {
      lines.push(`- X API (last ${row.xApi.periodDays}d): URL posts ${row.xApi.urlPosts}, non-URL posts ${row.xApi.nonUrlPosts}, read ops ${row.xApi.readOperations}, estimated monthly cost $${row.xApi.estimatedMonthlyCostUsd}`);
    }
    if (row.brandId) lines.push(`- Brand: ${row.brandId}`);
    lines.push('');
  }
  lines.push('## Global governor', '');
  lines.push(`- Month: ${result.governor.month}`);
  lines.push(`- Total estimated USD: ${result.governor.totalEstimatedUsd}`);
  lines.push(`- Total actual USD: ${result.governor.totalActualUsd} (none unless a billing API is wired)`);
  lines.push(`- Remaining: ${result.governor.remainingUsd} / ${result.governor.monthlyBudgetUsd}`);
  lines.push(`- Projected month-end: ${result.governor.projectedMonthEndUsd}`);
  lines.push(`- State: ${result.governor.budgetState}`);
  lines.push('');
  await mkdir(dirname(MD_PATH), { recursive: true });
  await writeFile(MD_PATH, `${lines.join('\n')}\n`, 'utf8');
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const idx = process.argv.indexOf('--account');
  console.log(JSON.stringify(await buildCostReport({ accountFilter: idx >= 0 ? process.argv[idx + 1] : undefined }), null, 2));
}

export const __test = { withinLastDays, sourceTypeCount, DEFAULT_PRICING };
