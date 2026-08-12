import { fileURLToPath } from 'node:url';
import { loadAccounts } from '../lib/config.mjs';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { generateTrendBrief } from '../lib/openai.mjs';
import { assertCircuitClosed, recordCircuitFailure, recordCircuitSuccess } from '../ops/circuit.mjs';

function pathFor(accountId) { return fileURLToPath(new URL(`../../data/trends/${encodeURIComponent(accountId)}.json`, import.meta.url)); }
export async function loadTrendBrief(accountId) { return readJson(pathFor(accountId), null); }
function fresh(brief, hours) { return brief?.generatedAt && Date.now() - new Date(brief.generatedAt).getTime() < hours * 3600000; }

export async function refreshTrends({ accountFilter, force = false } = {}) {
  const accounts = await loadAccounts(); const report = [];
  for (const [accountId, account] of Object.entries(accounts)) {
    if (accountFilter && accountFilter !== accountId) continue;
    if (!account.enabled || account.research?.trendIntelligence !== true) continue;
    const current = await loadTrendBrief(accountId); const refreshHours = Number(account.research?.trendRefreshHours ?? 6);
    if (!force && fresh(current, refreshHours)) { report.push({ account: accountId, status: 'fresh' }); continue; }
    try {
      await assertCircuitClosed(accountId, 'research', account.resilience);
      const result = await generateTrendBrief(accountId, account);
      const ranked = (result.items || []).map((item) => ({ ...item,
        opportunityScore: Math.round((Number(item.relevance || 0) * 0.45 + Number(item.novelty || 0) * 0.30 + (100 - Number(item.saturation || 0)) * 0.15 + (100 - Number(item.risk || 0)) * 0.10) * 10) / 10
      })).sort((a, b) => b.opportunityScore - a.opportunityScore);
      const sources = (result.citations || []).slice(0, 30);
      const brief = { account: accountId, generatedAt: new Date().toISOString(), summary: result.summary || '', items: ranked, sources };
      await writeJsonAtomic(pathFor(accountId), brief);
      await recordCircuitSuccess(accountId, 'research', account.resilience);
      await appendAudit({ account: accountId, stage: 'trend-updated', count: ranked.length, sourceCount: sources.length, top: ranked.slice(0, 3).map((x) => ({ topic: x.topic, opportunityScore: x.opportunityScore })) });
      report.push({ account: accountId, status: 'updated', top: ranked.slice(0, 3), sourceCount: sources.length });
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
