const DEFAULT_MIX = {
  tasteDiscovery: 0.4,
  musicAndCreation: 0.25,
  worldview: 0.2,
  directArtistPromotion: 0.15
};

const MIX_KEYS = Object.keys(DEFAULT_MIX);

export function resolveArtistMix(account) {
  const mix = { ...DEFAULT_MIX, ...(account?.artist?.mix || {}) };
  const total = MIX_KEYS.reduce((sum, key) => sum + Number(mix[key] || 0), 0);
  if (!(total > 0)) return { ...DEFAULT_MIX };
  const normalized = {};
  for (const key of MIX_KEYS) normalized[key] = Number(mix[key] || 0) / total;
  return normalized;
}

export function maxDirectPromotionShare(account) {
  const configured = Number(account?.artist?.maxDirectPromotionShare);
  if (Number.isFinite(configured) && configured >= 0 && configured <= 1) return configured;
  return 0.2;
}

export function applyLearnedMix(baseMix, learnedShare, account) {
  const mix = { ...resolveArtistMix({ artist: { mix: baseMix } }) };
  const hardCap = maxDirectPromotionShare(account);
  let direct = Number(learnedShare?.directArtistPromotion ?? mix.directArtistPromotion);
  if (direct > hardCap) direct = hardCap;
  mix.directArtistPromotion = direct;
  const restKeys = MIX_KEYS.filter((key) => key !== 'directArtistPromotion');
  const restTotal = restKeys.reduce((sum, key) => sum + mix[key], 0) || 1;
  const remaining = Math.max(0, 1 - direct);
  for (const key of restKeys) mix[key] = remaining * (mix[key] / restTotal);
  return mix;
}

export function chooseLane(slotId, mix, account) {
  const resolved = applyLearnedMix(mix || resolveArtistMix(account), mix, account);
  let hash = 2166136261;
  for (const char of String(slotId || '')) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const unit = ((hash >>> 0) % 10000) / 10000;
  let cursor = 0;
  for (const key of MIX_KEYS) {
    cursor += resolved[key];
    if (unit < cursor) return { lane: key, mix: resolved };
  }
  return { lane: 'tasteDiscovery', mix: resolved };
}

export const __test = { DEFAULT_MIX, MIX_KEYS };
