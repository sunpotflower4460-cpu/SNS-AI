import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts } from '../lib/config.mjs';
import { readHistory } from '../lib/history.mjs';
import { readAudit } from '../lib/audit.mjs';
import { readMetricSnapshots, latestSnapshots } from '../analytics/store.mjs';
import { scoreSnapshot } from '../analytics/scorer.mjs';
import { loadStrategy } from '../learning/store.mjs';
import { loadExperimentState } from '../experiments/store.mjs';
import { writeJsonAtomic } from '../lib/json-store.mjs';

const JSON_PATH = fileURLToPath(new URL('../../data/reports/weekly/latest.json', import.meta.url));
const MD_PATH = fileURLToPath(new URL('../../data/reports/weekly/latest.md', import.meta.url));
const DAY = 86_400_000;

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function round(value) { return value == null ? null : Math.round(value * 10) / 10; }
function within(value, from, to) { const at = Date.parse(value || ''); return Number.isFinite(at) && at >= from && at < to; }

function periodSummary({ accountId, account, history, snapshots, from, to }) {
  const posts = history.filter((row) => row.account === accountId && row.status === 'published' && within(row.at, from, to));
  const postIds = new Set(posts.map((row) => String(row.providerPostId || '')).filter(Boolean));
  const mature = latestSnapshots(snapshots).filter((row) => row.account === accountId && postIds.has(String(row.providerPostId)) && Number(row.checkpointMinutes) >= Number(account.learning?.matureCheckpointMinutes ?? 1440));
  const scores = mature.map((row) => ({ row, scored: scoreSnapshot(row, snapshots, account.objectives?.weights || {}) }));
  const averageScore = round(mean(scores.map((x) => x.scored.score)));
  const best = scores.sort((a, b) => b.scored.score - a.scored.score)[0];
  const bestPost = best ? posts.find((post) => String(post.providerPostId) === String(best.row.providerPostId)) : null;
  return {
    postCount: posts.length,
    maturedPostCount: scores.length,
    averagePerformanceScore: averageScore,
    best: best ? {
      providerPostId: best.row.providerPostId,
      score: best.scored.score,
      text: bestPost?.text || null,
      features: bestPost?.features || null,
      at: bestPost?.at || null
    } : null
  };
}

export async function generateWeeklyReport({ now = new Date() } = {}) {
  const accounts = await loadAccounts();
  const history = await readHistory();
  const snapshots = await readMetricSnapshots();
  const audit = await readAudit();
  const end = now.getTime();
  const currentStart = end - 7 * DAY;
  const previousStart = end - 14 * DAY;
  const result = { generatedAt: now.toISOString(), periodDays: 7, accounts: {} };

  for (const [accountId, account] of Object.entries(accounts)) {
    const current = periodSummary({ accountId, account, history, snapshots, from: currentStart, to: end });
    const previous = periodSummary({ accountId, account, history, snapshots, from: previousStart, to: currentStart });
    const strategy = await loadStrategy(accountId);
    const experiments = await loadExperimentState(accountId);
    const errors = audit.filter((row) => row.account === accountId && String(row.stage || '').includes('error') && within(row.at, currentStart, end));
    const scoreDelta = current.averagePerformanceScore != null && previous.averagePerformanceScore != null
      ? round(current.averagePerformanceScore - previous.averagePerformanceScore)
      : null;
    result.accounts[accountId] = {
      platform: account.platform,
      enabled: Boolean(account.enabled),
      mode: account.mode || 'pause',
      current,
      previous,
      changes: {
        postCount: current.postCount - previous.postCount,
        averagePerformanceScore: scoreDelta,
        errorCount: errors.length
      },
      currentStrategy: strategy ? {
        sampleSize: strategy.sampleSize,
        confidence: strategy.confidence,
        preferred: strategy.preferred?.slice(0, 5) || [],
        avoid: strategy.avoid?.slice(0, 5) || []
      } : null,
      experiment: experiments.active || null,
      recentlyCompletedExperiments: (experiments.completed || []).filter((row) => within(row.completedAt, currentStart, end)).slice(-5).reverse()
    };
  }

  await writeJsonAtomic(JSON_PATH, result);
  const lines = ['# SNS-AI Weekly Review', '', `Generated: ${result.generatedAt}`, ''];
  for (const [id, row] of Object.entries(result.accounts)) {
    lines.push(`## ${id} (${row.platform})`);
    lines.push(`- Posts: ${row.current.postCount} (previous ${row.previous.postCount}, delta ${row.changes.postCount >= 0 ? '+' : ''}${row.changes.postCount})`);
    if (row.current.averagePerformanceScore != null) lines.push(`- Average mature performance: ${row.current.averagePerformanceScore}${row.changes.averagePerformanceScore == null ? '' : ` (delta ${row.changes.averagePerformanceScore >= 0 ? '+' : ''}${row.changes.averagePerformanceScore})`}`);
    if (row.current.best) lines.push(`- Best: ${row.current.best.score} — ${String(row.current.best.text || '').slice(0, 160)}`);
    if (row.currentStrategy?.preferred?.length) lines.push(`- Current winning signals: ${row.currentStrategy.preferred.slice(0, 3).map((x) => `${x.dimension}=${x.value}`).join(', ')}`);
    if (row.experiment) lines.push(`- Active experiment: ${row.experiment.dimension}: ${row.experiment.variants.join(' vs ')}`);
    if (row.recentlyCompletedExperiments.length) lines.push(`- Experiments completed this week: ${row.recentlyCompletedExperiments.length}`);
    if (row.changes.errorCount) lines.push(`- Errors this week: ${row.changes.errorCount}`);
    lines.push('');
  }
  await mkdir(dirname(MD_PATH), { recursive: true });
  await writeFile(MD_PATH, `${lines.join('\n')}\n`, 'utf8');
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await generateWeeklyReport(), null, 2));
