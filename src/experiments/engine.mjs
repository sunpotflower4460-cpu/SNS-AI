import { createHash } from 'node:crypto';
import { latestSnapshots } from '../analytics/store.mjs';
import { scoreSnapshot } from '../analytics/scorer.mjs';
import { loadExperimentState, saveExperimentState } from './store.mjs';

const DEFAULT_VARIANTS = {
  hook: ['question', 'statement'],
  format: ['short', 'structured'],
  cta: ['none', 'soft'],
  mediaDecision: ['library', 'generate']
};

function hashInt(value) {
  return Number.parseInt(createHash('sha256').update(String(value)).digest('hex').slice(0, 8), 16) >>> 0;
}

function variantsFor(account, dimension) {
  if (dimension === 'mediaDecision' && account.platform === 'x') return ['none', 'generate'];
  return DEFAULT_VARIANTS[dimension] || ['A', 'B'];
}

export function assignmentForSlot(experiment, slotId) {
  if (!experiment || experiment.status !== 'active') return null;
  const index = hashInt(`${experiment.id}:${slotId}`) % experiment.variants.length;
  return { id: experiment.id, dimension: experiment.dimension, variant: experiment.variants[index], index };
}

export async function ensureExperiment(accountId, account, strategy) {
  if (account.experiments?.enabled === false) return null;
  const state = await loadExperimentState(accountId);
  if (state.active?.status === 'active') return state.active;
  if (Number(strategy?.sampleSize || 0) < Number(account.experiments?.minimumStrategySamples ?? 6)) return null;
  const dimensions = (account.experiments?.dimensions || Object.keys(DEFAULT_VARIANTS)).filter((d) => DEFAULT_VARIANTS[d]);
  if (!dimensions.length) return null;
  const round = state.completedCount ?? (state.completed || []).length;
  const dimension = dimensions[round % dimensions.length];
  const variants = variantsFor(account, dimension);
  const active = {
    id: `${accountId}-${dimension}-${new Date().toISOString().slice(0, 10)}-${round + 1}`,
    status: 'active',
    dimension,
    variants,
    startedAt: new Date().toISOString(),
    minSamplesPerVariant: Number(account.experiments?.minSamplesPerVariant ?? 3),
    maxDays: Number(account.experiments?.maxDays ?? 14)
  };
  await saveExperimentState(accountId, { ...state, active });
  return active;
}

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }

export async function evaluateExperiment(accountId, account, history, snapshots) {
  const state = await loadExperimentState(accountId);
  const experiment = state.active;
  if (!experiment?.id) return { status: 'none' };
  const latest = latestSnapshots(snapshots).filter((s) => s.account === accountId && Number(s.checkpointMinutes) >= Number(account.learning?.matureCheckpointMinutes ?? 1440));
  const byPost = new Map(history.filter((h) => h.account === accountId && h.providerPostId).map((h) => [String(h.providerPostId), h]));
  const groups = Object.fromEntries(experiment.variants.map((variant) => [variant, []]));
  for (const snapshot of latest) {
    const post = byPost.get(String(snapshot.providerPostId));
    if (!post || post.experiment?.id !== experiment.id || post.experiment?.applied === false || !groups[post.experiment.variant]) continue;
    groups[post.experiment.variant].push(scoreSnapshot(snapshot, snapshots, account.objectives?.weights || {}).score);
  }
  const stats = Object.fromEntries(Object.entries(groups).map(([variant, scores]) => [variant, {
    n: scores.length,
    averageScore: Math.round(mean(scores) * 10) / 10
  }]));
  const enough = Object.values(stats).every((row) => row.n >= Number(experiment.minSamplesPerVariant || 3));
  const ageDays = (Date.now() - Date.parse(experiment.startedAt)) / 86_400_000;
  if (!enough && ageDays < Number(experiment.maxDays || 14)) return { status: 'active', experiment, stats };

  const ranked = Object.entries(stats).sort((a, b) => b[1].averageScore - a[1].averageScore);
  const winner = enough && ranked.length >= 2 ? ranked[0][0] : null;
  const gap = enough && ranked.length >= 2 ? ranked[0][1].averageScore - ranked[1][1].averageScore : 0;
  const completed = {
    ...experiment,
    status: enough ? 'completed' : 'expired',
    completedAt: new Date().toISOString(),
    stats,
    winner,
    scoreGap: Math.round(gap * 10) / 10,
    confidence: enough ? Math.min(1, Math.round((Math.min(...Object.values(stats).map((x) => x.n)) / Math.max(3, experiment.minSamplesPerVariant * 2)) * 100) / 100) : 0
  };
  await saveExperimentState(accountId, {
    account: accountId,
    active: null,
    completed: [...(state.completed || []), completed],
    completedCount: (state.completedCount ?? (state.completed || []).length) + 1
  });
  return { status: completed.status, experiment: completed, stats };
}
