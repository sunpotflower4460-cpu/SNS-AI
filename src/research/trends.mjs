import { fileURLToPath } from 'node:url';
import { loadAccounts } from '../lib/config.mjs';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { generateTrendBrief } from '../lib/openai.mjs';
import { assertCircuitClosed, recordCircuitFailure, recordCircuitSuccess } from '../ops/circuit.mjs';
import { loadResearchSources } from './sources/registry.mjs';
import { runDirectFetch } from './fetch-pipeline.mjs';
import { triageCandidates } from './triage.mjs';

function pathFor(accountId) { return fileURLToPath(new URL(`../../data/trends/${encodeURIComponent(accountId)}.json`, import.meta.url)); }
export async function loadTrendBrief(accountId) { return readJson(pathFor(accountId), null); }
function fresh(brief, hours) { return brief?.generatedAt && Date.now() - new Date(brief.generatedAt).getTime() < hours * 3600000; }

// Backward-compatible ranking: an item with no japanNovelty/audienceFit (the shape OpenAI Web Search
// trend briefs have always produced) keeps the exact original weighting so every existing account's
// numbers are unchanged. Only items scored by the new direct-fetch triage path (src/research/triage.mjs),
// which does provide those fields, use the richer weighting that also rewards Japan-market novelty and
// audience fit per the music-tools-x "buy or skip" editorial goal.
function opportunityScore(item) {
  const relevance = Number(item.relevance || 0);
  const novelty = Number(item.novelty || 0);
  const saturation = Number(item.saturation || 0);
  const risk = Number(item.risk || 0);
  if (item.japanNovelty == null && item.audienceFit == null) {
    return Math.round((relevance * 0.45 + novelty * 0.30 + (100 - saturation) * 0.15 + (100 - risk) * 0.10) * 10) / 10;
  }
  const japanNovelty = Number(item.japanNovelty ?? novelty);
  const audienceFit = Number(item.audienceFit ?? relevance);
  return Math.round((relevance * 0.25 + novelty * 0.15 + japanNovelty * 0.20 + audienceFit * 0.20 + (100 - saturation) * 0.10 + (100 - risk) * 0.10) * 10) / 10;
}

// Low-cost-first research: try Tier 1 direct fetch (RSS/Atom/GitHub Releases, see
// src/research/fetch-pipeline.mjs) plus cheap AI triage (src/research/triage.mjs) before ever calling
// OpenAI Web Search. Web Search runs only when direct fetch is disabled for the account, produced too
// few fresh candidates to be a useful brief on its own (account.research.minDirectCandidates), or the
// direct-fetch/triage attempt itself failed - it is a fallback, never the default entry point.
async function buildResearchResult(accountId, account) {
  if (account.research?.directFetch !== true) {
    return { result: await generateTrendBrief(accountId, account), mode: 'web-search', direct: null };
  }
  const registry = await loadResearchSources();
  const direct = await runDirectFetch(accountId, registry);
  const minCandidates = Number(account.research?.minDirectCandidates ?? 3);
  if (direct.candidates.length < minCandidates) {
    const result = await generateTrendBrief(accountId, account);
    return { result, mode: 'web-search-fallback', direct };
  }
  const result = await triageCandidates(accountId, account, direct.candidates);
  return { result, mode: 'direct-fetch', direct };
}

export async function refreshTrends({ accountFilter, force = false } = {}) {
  const accounts = await loadAccounts(); const report = [];
  if (accountFilter && !accounts[accountFilter]) throw new Error(`Unknown account "${accountFilter}".`);
  for (const [accountId, account] of Object.entries(accounts)) {
    if (accountFilter && accountFilter !== accountId) continue;
    if (!account.enabled || account.research?.trendIntelligence !== true) continue;
    const current = await loadTrendBrief(accountId); const refreshHours = Number(account.research?.trendRefreshHours ?? 6);
    if (!force && fresh(current, refreshHours)) { report.push({ account: accountId, status: 'fresh' }); continue; }
    try {
      await assertCircuitClosed(accountId, 'research', account.resilience);
      const { result, mode, direct } = await buildResearchResult(accountId, account);
      const ranked = (result.items || []).map((item) => ({ ...item, opportunityScore: opportunityScore(item) })).sort((a, b) => b.opportunityScore - a.opportunityScore);
      const sources = (result.citations || []).slice(0, 30);
      const research = direct ? {
        mode,
        fetchedCount: direct.fetchedCount,
        freshCount: direct.freshCount,
        duplicateCount: direct.duplicateCount,
        totalSources: direct.totalSources,
        failedSources: direct.failedSources,
        sourceResults: direct.sourceResults
      } : { mode };
      const brief = { account: accountId, generatedAt: new Date().toISOString(), summary: result.summary || '', items: ranked, sources, research };
      await writeJsonAtomic(pathFor(accountId), brief);
      await recordCircuitSuccess(accountId, 'research', account.resilience);
      await appendAudit({ account: accountId, stage: 'trend-updated', mode, count: ranked.length, sourceCount: sources.length, top: ranked.slice(0, 3).map((x) => ({ topic: x.topic, opportunityScore: x.opportunityScore })) });
      report.push({ account: accountId, status: 'updated', mode, top: ranked.slice(0, 3), sourceCount: sources.length });
    } catch (error) {
      if (!['BUDGET_EXHAUSTED', 'CIRCUIT_OPEN'].includes(error.code)) await recordCircuitFailure(accountId, 'research', error, account.resilience);
      await appendAudit({ account: accountId, stage: 'trend-error', code: error.code || null, error: String(error.message || error).slice(0, 500) });
      report.push({ account: accountId, status: error.code === 'BUDGET_EXHAUSTED' ? 'budget-exhausted' : error.code === 'CIRCUIT_OPEN' ? 'circuit-open' : 'failed', error: error.message });
    }
  }
  return report;
}
const idx = process.argv.indexOf('--account');
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await refreshTrends({ accountFilter: idx >= 0 ? process.argv[idx + 1] : undefined, force: process.argv.includes('--force') }), null, 2));

export const __test = { opportunityScore, buildResearchResult };