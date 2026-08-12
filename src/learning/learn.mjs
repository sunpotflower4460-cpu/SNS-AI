import { loadAccounts } from '../lib/config.mjs';
import { readHistory } from '../lib/history.mjs';
import { readMetricSnapshots, latestSnapshots } from '../analytics/store.mjs';
import { scoreSnapshot } from '../analytics/scorer.mjs';
import { FEATURE_DIMENSIONS, historyFeatures } from './features.mjs';
import { saveStrategy } from './store.mjs';

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

export function buildStrategy({ accountId, account, history, snapshots }) {
  const latest = latestSnapshots(snapshots).filter((s) => s.account === accountId && Number(s.checkpointMinutes) >= Number(account.learning?.matureCheckpointMinutes ?? 1440));
  const byPost = new Map(history.filter((h) => h.account === accountId && h.providerPostId).map((h) => [String(h.providerPostId), h]));
  const samples = latest.map((snapshot) => {
    const post = byPost.get(String(snapshot.providerPostId)); if (!post) return null;
    const scored = scoreSnapshot(snapshot, snapshots, account.objectives?.weights || {});
    return { snapshot, post, score: scored.score, confidence: scored.confidence, features: historyFeatures(post, account.timezone) };
  }).filter(Boolean);
  const overall = mean(samples.map((s) => s.score)) || 50;
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
    account: accountId, generatedAt: new Date().toISOString(), sampleSize: samples.length,
    overallScore: Math.round(overall * 10) / 10,
    confidence: Math.round(clamp(samples.length / Number(account.learning?.fullConfidencePosts ?? 20), 0, 1) * 100) / 100,
    exploreRate: Number(account.learning?.exploreRate ?? 0.2), preferred, avoid, featureStats,
    guardrail: 'Treat these as evidence, not identity. Never override profile, safety rules, or explicit human instructions.'
  };
}

export async function learnAll({ accountFilter } = {}) {
  const accounts = await loadAccounts(); const history = await readHistory(); const snapshots = await readMetricSnapshots(); const report = [];
  for (const [accountId, account] of Object.entries(accounts)) {
    if (accountFilter && accountFilter !== accountId) continue; if (account.learning?.enabled === false) continue;
    const strategy = buildStrategy({ accountId, account, history, snapshots }); await saveStrategy(accountId, strategy);
    report.push({ account: accountId, sampleSize: strategy.sampleSize, confidence: strategy.confidence, preferred: strategy.preferred.slice(0, 3) });
  }
  return report;
}
const idx = process.argv.indexOf('--account');
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await learnAll({ accountFilter: idx >= 0 ? process.argv[idx + 1] : undefined }), null, 2));
