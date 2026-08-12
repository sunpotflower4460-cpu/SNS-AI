import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { latestSnapshots } from '../analytics/store.mjs';
import { scoreSnapshot } from '../analytics/scorer.mjs';

const FILE = fileURLToPath(new URL('../../data/brakes.json', import.meta.url));

function settings(account) {
  const cfg = account.safety?.anomalyBrake || {};
  return {
    enabled: cfg.enabled !== false,
    matureCheckpointMinutes: Number(cfg.matureCheckpointMinutes ?? account.learning?.matureCheckpointMinutes ?? 1440),
    minBaselinePosts: Number(cfg.minBaselinePosts ?? 5),
    minConfidence: Number(cfg.minConfidence ?? 0.55),
    minExposure: Number(cfg.minExposure ?? 500),
    severeScoreThreshold: Number(cfg.severeScoreThreshold ?? 12),
    lowScoreThreshold: Number(cfg.lowScoreThreshold ?? 25),
    consecutiveLowPosts: Number(cfg.consecutiveLowPosts ?? 2),
    conversationSpikeMultiplier: Number(cfg.conversationSpikeMultiplier ?? 5),
    minimumConversationRate: Number(cfg.minimumConversationRate ?? 0.02),
    cooldownHours: Number(cfg.cooldownHours ?? 12)
  };
}

async function loadState() {
  return await readJson(FILE, { accounts: {} }) || { accounts: {} };
}

async function saveState(state) {
  await writeJsonAtomic(FILE, state);
}

export async function brakeStatus(accountId) {
  const state = await loadState();
  const row = state.accounts?.[accountId] || null;
  if (!row) return { open: false };
  if (row.open && row.openUntil && Date.now() >= Date.parse(row.openUntil)) {
    row.open = false;
    row.closedAt = new Date().toISOString();
    row.closedReason = 'cooldown_elapsed';
    state.accounts[accountId] = row;
    await saveState(state);
  }
  return { ...row, open: Boolean(row.open) };
}

export async function assertAutonomyBrakeClear(accountId, account) {
  const cfg = settings(account);
  if (!cfg.enabled) return { open: false, disabled: true };
  const status = await brakeStatus(accountId);
  if (!status.open) return status;
  const error = new Error(`Autonomous publishing is temporarily paused by the anomaly brake until ${status.openUntil || 'manual recovery'}.`);
  error.code = 'AUTONOMY_BRAKE';
  error.openUntil = status.openUntil || null;
  error.reason = status.reason || null;
  throw error;
}

function eligibleRows(accountId, account, snapshots) {
  const cfg = settings(account);
  return latestSnapshots(snapshots)
    .filter((row) => row.account === accountId && Number(row.checkpointMinutes) >= cfg.matureCheckpointMinutes)
    .map((row) => ({ row, scored: scoreSnapshot(row, snapshots, account.objectives?.weights || {}) }))
    .filter(({ scored }) => scored.baselineCount >= cfg.minBaselinePosts
      && scored.confidence >= cfg.minConfidence
      && scored.vector.exposure >= cfg.minExposure)
    .sort((a, b) => Date.parse(a.row.publishedAt || a.row.collectedAt || 0) - Date.parse(b.row.publishedAt || b.row.collectedAt || 0));
}

export async function evaluateAnomalyBrake(accountId, account, snapshots) {
  const cfg = settings(account);
  if (!cfg.enabled) return { opened: false, disabled: true };
  const rows = eligibleRows(accountId, account, snapshots);
  if (!rows.length) return { opened: false, reason: 'insufficient_baseline' };

  const latest = rows.at(-1);
  const recent = rows.slice(-Math.max(1, cfg.consecutiveLowPosts));
  const consecutiveCollapse = recent.length >= cfg.consecutiveLowPosts
    && recent.every(({ scored }) => scored.score <= cfg.lowScoreThreshold);
  const severeCollapse = latest.scored.score <= cfg.severeScoreThreshold;
  const baselineConversation = Number(latest.scored.baseline?.conversationRate || 0);
  const currentConversation = Number(latest.scored.vector?.conversationRate || 0);
  const conversationSpike = latest.scored.score <= cfg.lowScoreThreshold
    && currentConversation >= cfg.minimumConversationRate
    && currentConversation >= Math.max(cfg.minimumConversationRate, baselineConversation * cfg.conversationSpikeMultiplier);

  if (!severeCollapse && !consecutiveCollapse && !conversationSpike) return {
    opened: false,
    latestScore: latest.scored.score,
    confidence: latest.scored.confidence
  };

  const state = await loadState();
  state.accounts ||= {};
  const existing = state.accounts[accountId];
  if (existing?.open && (!existing.openUntil || Date.now() < Date.parse(existing.openUntil))) {
    return { opened: false, alreadyOpen: true, ...existing };
  }

  const reason = severeCollapse ? 'severe_performance_collapse'
    : conversationSpike ? 'low_score_with_conversation_spike'
      : 'consecutive_low_performance';
  const openedAt = new Date().toISOString();
  const openUntil = new Date(Date.now() + Math.max(1, cfg.cooldownHours) * 3600000).toISOString();
  const evidence = {
    providerPostId: latest.row.providerPostId,
    score: latest.scored.score,
    confidence: latest.scored.confidence,
    exposure: latest.scored.vector.exposure,
    conversationRate: currentConversation,
    baselineConversationRate: baselineConversation,
    recentScores: recent.map(({ scored }) => scored.score)
  };
  const row = { open: true, openedAt, openUntil, reason, evidence };
  state.accounts[accountId] = row;
  await saveState(state);
  return { opened: true, ...row };
}

export async function clearBrake(accountId, reason = 'manual_clear') {
  const state = await loadState();
  state.accounts ||= {};
  const row = state.accounts[accountId] || {};
  state.accounts[accountId] = { ...row, open: false, closedAt: new Date().toISOString(), closedReason: reason };
  await saveState(state);
  return state.accounts[accountId];
}
