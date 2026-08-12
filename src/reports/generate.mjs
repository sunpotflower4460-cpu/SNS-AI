import { fileURLToPath } from 'node:url';
import { loadAccounts } from '../lib/config.mjs';
import { readHistory } from '../lib/history.mjs';
import { readMetricSnapshots, latestSnapshots } from '../analytics/store.mjs';
import { scoreSnapshot } from '../analytics/scorer.mjs';
import { loadStrategy } from '../learning/store.mjs';
import { loadTrendBrief } from '../research/trends.mjs';
import { writeJsonAtomic } from '../lib/json-store.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const JSON_PATH = fileURLToPath(new URL('../../data/reports/latest.json', import.meta.url));
const MD_PATH = fileURLToPath(new URL('../../data/reports/latest.md', import.meta.url));

export async function generateReport() {
  const accounts = await loadAccounts(); const history = await readHistory(); const snapshots = await readMetricSnapshots(); const latest = latestSnapshots(snapshots);
  const result = { generatedAt: new Date().toISOString(), accounts: {} };
  for (const [accountId, account] of Object.entries(accounts)) {
    const posts = history.filter((h) => h.account === accountId && h.status === 'published').slice(-10).reverse(); const latestMetrics = latest.filter((s) => s.account === accountId);
    const scored = latestMetrics.map((s) => ({ providerPostId: s.providerPostId, checkpointMinutes: s.checkpointMinutes, ...scoreSnapshot(s, snapshots, account.objectives?.weights || {}) })).sort((a, b) => b.score - a.score);
    const strategy = await loadStrategy(accountId); const trends = await loadTrendBrief(accountId);
    result.accounts[accountId] = {
      platform: account.platform, enabled: Boolean(account.enabled), mode: account.mode || 'pause', postCount: posts.length,
      lastPost: posts[0] || null, bestRecent: scored[0] || null, strategy: strategy ? { sampleSize: strategy.sampleSize, confidence: strategy.confidence, preferred: strategy.preferred, avoid: strategy.avoid } : null,
      trends: trends ? { generatedAt: trends.generatedAt, summary: trends.summary, top: trends.items?.slice(0, 5) || [] } : null
    };
  }
  await writeJsonAtomic(JSON_PATH, result);
  const lines = ['# SNS-AI Current Report', '', `Generated: ${result.generatedAt}`, ''];
  for (const [id, row] of Object.entries(result.accounts)) {
    lines.push(`## ${id} (${row.platform})`, `- State: ${row.enabled ? 'enabled' : 'disabled'} / ${row.mode}`, `- Recent posts in memory: ${row.postCount}`);
    if (row.bestRecent) lines.push(`- Best recent performance score: ${row.bestRecent.score} (confidence ${row.bestRecent.confidence})`);
    if (row.strategy) { lines.push(`- Learning samples: ${row.strategy.sampleSize}, confidence ${row.strategy.confidence}`); if (row.strategy.preferred?.length) lines.push(`- Current winning signals: ${row.strategy.preferred.slice(0, 3).map((x) => `${x.dimension}=${x.value} (${x.lift >= 0 ? '+' : ''}${x.lift})`).join(', ')}`); }
    if (row.trends?.top?.length) lines.push(`- Current trend candidates: ${row.trends.top.slice(0, 3).map((x) => `${x.topic} (${x.opportunityScore})`).join(', ')}`);
    lines.push('');
  }
  await mkdir(dirname(MD_PATH), { recursive: true }); await writeFile(MD_PATH, `${lines.join('\n')}\n`, 'utf8'); return result;
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await generateReport(), null, 2));
