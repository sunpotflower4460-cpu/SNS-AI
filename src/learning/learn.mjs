import { loadAccounts } from '../lib/config.mjs';
import { readHistory } from '../lib/history.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { readMetricSnapshots, latestSnapshots } from '../analytics/store.mjs';
import { scoreSnapshot } from '../analytics/scorer.mjs';
import { FEATURE_DIMENSIONS, historyFeatures } from './features.mjs';
import { saveStrategy } from './store.mjs';
import { ensureExperiment, evaluateExperiment } from '../experiments/engine.mjs';

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

export function buildStrategy({ accountId, account, history, snapshots, now = new Date() }) {
  const windowDays = Math.max(1, Number(account.learning?.strategyWindowDays ?? 60));
  const cutoff = now.getTime() - windowDays * 86_400_000;
  const recentHistory = history.filter((h) => h.account === accountId && h.providerPostId && Date.parse(h.at || '') >= cutoff);
  const allowedPostIds = new Set(recentHistory.map((h) => String(h.providerPostId)));
  const windowSnapshots = snapshots.filter((s) => s.account === accountId && allowedPostIds.has(String(s.providerPostId)));
  const latest = latestSnapshots(windowSnapshots).filter((s) => Number(s.checkpointMinutes) >= Number(account.learning?.matureCheckpointMinutes ?? 1440));
  const byPost = new Map(recentHistory.map((h) => [String(h.providerPostId), h]));
  const timeZone = account.schedule?.timezone || account.timezone || 'Asia/Tokyo';
  const samples = latest.map((snapshot) => {
    const post = byPost.get(String(snapshot.providerPostId)); if (!post) return null;
    const scored = scoreSnapshot(snapshot, windowSnapshots, account.objectives?.weights || {});
    return { snapshot, post, score: scored.score, confidence: scored.confidence, features: historyFeatures(post, timeZone) };
  }).filter(Boolean);
  const sampleScores = samples.map((s) => s.score);
  const overall = sampleScores.length ? mean(sampleScores) : 50;
  const featureStats = {};
  for (const dimension of FEATURE_DIMENSIONS) {
    const groups = new Map();
    for (const sample of samples) {
      const value = String(sample.features?.[dimension] || '').trim(); if (!value) continue;
      if (!groups.has(value)) groups.set(value, []); groups.get(value).push(sample.score);
    }
    featureStats[dimension] = Object.fromEntries([...groups.entries()].map(([value, scores]) => [value, {
      n: scores.length, averageScore: Math.round(mean(scores) * 10) / 10,
      lift: Math.round((mean(scores) - overall) * 10) / 10,
      confidence: Math.round(clamp(scores.length / 6, 0, 1) * 100) / 100
    }]));
  }
  const minSamples = Number(account.learning?.minSamplesPerPattern ?? 2);
  const ranked = [];
  for (const [dimension, values] of Object.entries(featureStats)) {
    for (const [value, stat] of Object.entries(values)) if (stat.n >= minSamples) ranked.push({ dimension, value, ...stat });
  }
  ranked.sort((a, b) => b.lift - a.lift);
  const preferred = ranked.filter((x) => x.lift > 0).slice(0, 8);
  const avoid = ranked.filter((x) => x.lift < 0).sort((a, b) => a.lift - b.lift).slice(0, 6);
  return {
    account: accountId, generatedAt: now.toISOString(), strategyWindowDays: windowDays, sampleSize: samples.length,
    overallScore: Math.round(overall * 10) / 10,
    confidence: Math.round(clamp(samples.length / Number(account.learning?.fullConfidencePosts ?? 20), 0, 1) * 100) / 100,
    exploreRate: Number(account.learning?.exploreRate ?? 0.2), preferred, avoid, featureStats,
    guardrail: 'Treat these as recent evidence, not identity. Never override profile, safety rules, or explicit human instructions.'
  };
}

export async function learnAll({ accountFilter } = {}) {
  const accounts = await loadAccounts();
  if (accountFilter && !accounts[accountFilter]) throw new Error(`Unknown account "${accountFilter}".`);
  const history = await readHistory(); const snapshots = await readMetricSnapshots(); const report = [];
  for (const [accountId, account] of Object.entries(accounts)) {
    if (accountFilter && accountFilter !== accountId) continue; if (account.learning?.enabled === false) continue;
    const strategy = buildStrategy({ accountId, account, history, snapshots }); await saveStrategy(accountId, strategy);
    const experimentResult = account.experiments?.enabled === false ? { status: 'disabled' } : await evaluateExperiment(accountId, account, history, snapshots);
    const activeExperiment = account.experiments?.enabled === false ? null : await ensureExperiment(accountId, account, strategy);
    await appendAudit({ account: accountId, stage: 'strategy-updated', sampleSize: strategy.sampleSize, strategyWindowDays: strategy.strategyWindowDays, confidence: strategy.confidence, preferred: strategy.preferred.slice(0, 5), experimentEvaluation: experimentResult.status, activeExperiment: activeExperiment?.id || null });
    report.push({ account: accountId, sampleSize: strategy.sampleSize, strategyWindowDays: strategy.strategyWindowDays, confidence: strategy.confidence, preferred: strategy.preferred.slice(0, 3), experiment: { evaluation: experimentResult.status, active: activeExperiment || null } });
  }
  return report;
}
const idx = process.argv.indexOf('--account');
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await learnAll({ accountFilter: idx >= 0 ? process.argv[idx + 1] : undefined }), null, 2));