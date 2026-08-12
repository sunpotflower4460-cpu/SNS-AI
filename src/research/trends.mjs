import { fileURLToPath } from 'node:url';
import { loadAccounts } from '../lib/config.mjs';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { generateTrendBrief } from '../lib/openai.mjs';

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
      const result = await generateTrendBrief(accountId, account);
      const ranked = (result.items || []).map((item) => ({ ...item,
        opportunityScore: Math.round((Number(item.relevance || 0) * 0.45 + Number(item.novelty || 0) * 0.30 + (100 - Number(item.saturation || 0)) * 0.15 + (100 - Number(item.risk || 0)) * 0.10) * 10) / 10
      })).sort((a, b) => b.opportunityScore - a.opportunityScore);
      const brief = { account: accountId, generatedAt: new Date().toISOString(), summary: result.summary || '', items: ranked };
      await writeJsonAtomic(pathFor(accountId), brief); report.push({ account: accountId, status: 'updated', top: ranked.slice(0, 3) });
    } catch (error) { report.push({ account: accountId, status: 'failed', error: error.message }); }
  }
  return report;
}
const idx = process.argv.indexOf('--account');
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await refreshTrends({ accountFilter: idx >= 0 ? process.argv[idx + 1] : undefined, force: process.argv.includes('--force') }), null, 2));
