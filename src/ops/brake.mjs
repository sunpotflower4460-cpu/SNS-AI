import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { latestSnapshots } from '../analytics/store.mjs';
import { scoreSnapshot } from '../analytics/scorer.mjs';

const FILE = fileURLToPath(new URL('../../data/brakes.json', import.meta.url));

function setting(value, fallback, { min = -Infinity, max = Infinity, integer = false, exclusiveMin = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (integer && !Number.isInteger(number)) return fallback;
  if (exclusiveMin ? number <= min : number < min) return fallback;
  if (number > max) return fallback;
  return number;
}

export function brakeSettings(account = {}) {
  const cfg = account.safety?.anomalyBrake || {};
  const lowScoreThreshold = setting(cfg.lowScoreThreshold, 25, { min: 0, max: 100 });
  let severeScoreThreshold = setting(cfg.severeScoreThreshold, 12, { min: 0, max: 100 });
  if (severeScoreThreshold > lowScoreThreshold) severeScoreThreshold = Math.min(12, lowScoreThreshold);
  return {
    enabled: cfg.enabled !== false,
    matureCheckpointMinutes: setting(cfg.matureCheckpointMinutes ?? account.learning?.matureCheckpointMinutes, 1440, { min: 0 }),
    // Explicit zero remains a valid direct-runtime/testing override. Malformed/NaN values still fall
    // back to the protective production defaults; npm run validate rejects zero in normal config.
    minBaselinePosts: setting(cfg.minBaselinePosts, 5, { min: 0, integer: true }),
    minConfidence: setting(cfg.minConfidence, 0.55, { min: 0, max: 1 }),
    minExposure: setting(cfg.minExposure, 500, { min: 0 }),
    severeScoreThreshold,
    lowScoreThreshold,
    consecutiveLowPosts: setting(cfg.consecutiveLowPosts, 2, { min: 0, exclusiveMin: true, integer: true }),
    conversationSpikeMultiplier: setting(cfg.conversationSpikeMultiplier, 5, { min: 0, exclusiveMin: true }),
    minimumConversationRate: setting(cfg.minimumConversationRate, 0.02, { min: 0, max: 1 }),
    cooldownHours: setting(cfg.cooldownHours, 12, { min: 0, exclusiveMin: true })
  };
}

async function loadState() { return await readJson(FILE, { accounts: {} }) || { accounts: {} }; }
async function saveState(state) { await writeJsonAtomic(FILE, state); }

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
  const cfg = brakeSettings(account);
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
  const cfg = brakeSettings(account);
  return latestSnapshots(snapshots)
    .filter((row) => row.account === accountId && Number(row.checkpointMinutes) >= cfg.matureCheckpointMinutes)
    .map((row) => ({ row, scored: scoreSnapshot(row, snapshots, account.objectives?.weights || {}) }))
    .filter(({ scored }) => scored.baselineCount >= cfg.minBaselinePosts
      && scored.confidence >= cfg.minConfidence
      && scored.vector.exposure >= cfg.minExposure)
    .sort((a, b) => Date.parse(a.row.publishedAt || a.row.collectedAt || 0) - Date.parse(b.row.publishedAt || b.row.collectedAt || 0));
}

export function anomalyTrigger(rows, cfg) {
  if (!rows?.length) return { opened: false, reason: 'insufficient_baseline' };
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
  const reason = severeCollapse ? 'severe_performance_collapse'
    : conversationSpike ? 'low_score_with_conversation_spike'
      : 'consecutive_low_performance';
  return {
    opened: true,
    reason,
    evidence: {
      providerPostId: latest.row.providerPostId,
      score: latest.scored.score,
      confidence: latest.scored.confidence,
      exposure: latest.scored.vector.exposure,
      conversationRate: currentConversation,
      baselineConversationRate: baselineConversation,
      recentScores: recent.map(({ scored }) => scored.score)
    }
  };
}

export async function evaluateAnomalyBrake(accountId, account, snapshots) {
  const cfg = brakeSettings(account);
  if (!cfg.enabled) return { opened: false, disabled: true };
  const rows = eligibleRows(accountId, account, snapshots);
  const decision = anomalyTrigger(rows, cfg);
  if (!decision.opened) return decision;

  const state = await loadState();
  state.accounts ||= {};
  const existing = state.accounts[accountId];
  if (existing?.open && (!existing.openUntil || Date.now() < Date.parse(existing.openUntil))) return { opened: false, alreadyOpen: true, ...existing };

  const openedAt = new Date().toISOString();
  const openUntil = new Date(Date.now() + cfg.cooldownHours * 3600000).toISOString();
  const row = { open: true, openedAt, openUntil, reason: decision.reason, evidence: decision.evidence };
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
