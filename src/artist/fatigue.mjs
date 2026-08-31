const DEFAULTS = {
  minDaysSinceLastUse: 180,
  requireNewAngle: true,
  requireDifferentClip: true,
  sameClipReusePenalty: 0.35,
  sameAngleReusePenalty: 0.25,
  captionSimilarityPenalty: 0.2
};

export function winnerResurfaceConfig(account = {}) {
  return { ...DEFAULTS, ...(account.artist?.winnerResurface || {}) };
}

export function daysBetween(from, to = new Date()) {
  const start = Date.parse(from || '');
  if (!Number.isFinite(start)) return Infinity;
  return Math.max(0, (to.getTime() - start) / 86400_000);
}

export function fatigueScore({
  timesUsed = 0,
  lastUsedAt = null,
  sameClipReuse = 0,
  sameAngleReuse = 0,
  sameCaptionSimilarity = 0,
  remainingAngles = 0,
  now = new Date()
} = {}) {
  const days = daysBetween(lastUsedAt, now);
  const recency = Number.isFinite(days) && days < Infinity ? Math.max(0, 1 - days / 60) : 0;
  const useLoad = Math.min(1, Number(timesUsed) / 8);
  const clip = Math.min(1, Number(sameClipReuse));
  const angle = Math.min(1, Number(sameAngleReuse));
  const caption = Math.min(1, Number(sameCaptionSimilarity));
  const leftover = remainingAngles > 0 ? 0 : 0.15;
  return Math.round((0.25 * useLoad + 0.3 * recency + 0.2 * clip + 0.15 * angle + 0.1 * caption + leftover) * 1000) / 1000;
}

export function canResurfaceWinner({
  asset,
  candidate,
  config = DEFAULTS,
  audienceGrowthSinceLastUse = 0,
  now = new Date()
} = {}) {
  if (!asset) return { ok: false, reason: 'no-asset' };
  const days = daysBetween(asset.lastUsedAt, now);
  if (days < Number(config.minDaysSinceLastUse || DEFAULTS.minDaysSinceLastUse)) {
    return { ok: false, reason: 'cooldown' };
  }
  const newAngle = candidate?.angle && candidate.angle !== asset.lastAngle;
  const differentClip = candidate?.clipStart !== asset.clipStart || candidate?.clipEnd !== asset.clipEnd;
  if (config.requireNewAngle && !newAngle) return { ok: false, reason: 'need-new-angle' };
  if (config.requireDifferentClip && !differentClip) return { ok: false, reason: 'need-different-clip' };
  if (candidate?.caption && candidate.caption === asset.lastCaption) {
    return { ok: false, reason: 'same-finished-caption' };
  }
  const winner = Boolean(asset.performanceSummary?.winner) || Number(asset.performanceSummary?.rank) === 1
    || Number(asset.performanceSummary?.score || 0) >= Number(asset.performanceSummary?.winnerThreshold || 80);
  if (!winner) return { ok: false, reason: 'not-a-winner' };
  return {
    ok: true,
    reason: 'winner-resurface',
    why: `${Math.floor(days)}日経過、新しいangle、異なるclip。audienceGrowth=${audienceGrowthSinceLastUse}。同じ完成投稿ではない。`
  };
}

export function shortTermReuseForbidden(asset, { now = new Date(), minDays = 21 } = {}) {
  const days = daysBetween(asset?.lastUsedAt, now);
  return Number(asset?.timesUsed || 0) > 0 && days < minDays;
}

export const __test = { DEFAULTS };
