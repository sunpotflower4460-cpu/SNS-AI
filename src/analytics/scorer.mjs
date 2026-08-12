const DEFAULT_WEIGHTS = {
  x: { exposure: 0.20, shareRate: 0.25, saveRate: 0.15, conversationRate: 0.10, profileRate: 0.15, clickRate: 0.15 },
  instagram: { exposure: 0.20, shareRate: 0.25, saveRate: 0.20, conversationRate: 0.10, followRate: 0.10, watchQuality: 0.15 }
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const safeRate = (value, exposure) => exposure > 0 ? Number(value || 0) / exposure : 0;

export function metricVector(snapshot) {
  const m = snapshot?.metrics || {};
  const exposure = Number(m.impressions || m.reach || m.views || 0);
  const share = Number(m.reposts || 0) + Number(m.quotes || 0) + Number(m.shares || 0);
  const saves = Number(m.bookmarks || 0) + Number(m.saved || 0);
  const conversation = Number(m.replies || 0) + Number(m.comments || 0);
  const profile = Number(m.profileClicks || 0) + Number(m.profileVisits || 0);
  const clicks = Number(m.urlClicks || 0);
  const follows = Number(m.follows || 0);
  const completion = Number(m.videoViews || 0) > 0 ? Number(m.playback100 || 0) / Number(m.videoViews || 1) : 0;
  const skipQuality = m.reelSkipRate ? 1 - clamp(Number(m.reelSkipRate), 0, 1) : 0;
  return {
    exposure, shareRate: safeRate(share, exposure), saveRate: safeRate(saves, exposure),
    conversationRate: safeRate(conversation, exposure), profileRate: safeRate(profile, exposure),
    clickRate: safeRate(clicks, exposure), followRate: safeRate(follows, exposure),
    watchQuality: Math.max(completion, skipQuality)
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function baselineVector(snapshot, peers) {
  const sameBucket = (peers || []).filter((row) => row.account === snapshot.account
    && row.platform === snapshot.platform
    && Number(row.checkpointMinutes) === Number(snapshot.checkpointMinutes)
    && String(row.providerPostId) !== String(snapshot.providerPostId));
  const fallback = sameBucket.length ? sameBucket : (peers || []).filter((row) => row.account === snapshot.account
    && row.platform === snapshot.platform && String(row.providerPostId) !== String(snapshot.providerPostId));
  const vectors = fallback.map(metricVector);
  const keys = Object.keys(metricVector(snapshot));
  return { count: vectors.length, vector: Object.fromEntries(keys.map((key) => [key, median(vectors.map((v) => v[key]))])) };
}

function relativeScore(value, baseline) {
  if (baseline <= 0) return value > 0 ? 65 : 50;
  if (value <= 0) return 15;
  return clamp(50 + 22 * Math.log2(value / baseline), 0, 100);
}

export function scoreSnapshot(snapshot, peers = [], configuredWeights = {}) {
  const vector = metricVector(snapshot);
  const baseline = baselineVector(snapshot, peers);
  const defaults = DEFAULT_WEIGHTS[snapshot.platform] || DEFAULT_WEIGHTS.x;
  const weights = { ...defaults, ...(configuredWeights || {}) };
  let weighted = 0;
  let weightSum = 0;
  const components = {};
  for (const [key, weight] of Object.entries(weights)) {
    if (!(key in vector) || !Number.isFinite(Number(weight)) || Number(weight) <= 0) continue;
    const component = relativeScore(vector[key], baseline.vector[key] || 0);
    components[key] = component;
    weighted += component * Number(weight);
    weightSum += Number(weight);
  }
  const score = weightSum ? weighted / weightSum : 50;
  const baselineConfidence = clamp(baseline.count / 10, 0, 1);
  const exposureConfidence = clamp(Math.log10(vector.exposure + 1) / 4, 0, 1);
  return {
    score: Math.round(score * 10) / 10,
    confidence: Math.round((baselineConfidence * 0.7 + exposureConfidence * 0.3) * 100) / 100,
    vector, baseline: baseline.vector, baselineCount: baseline.count, components
  };
}
