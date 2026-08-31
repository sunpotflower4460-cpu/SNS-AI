const STAGES = [
  'exposure',
  'engagement',
  'profile-visit',
  'follow',
  'music-discovery',
  'music-click',
  'repeat-interaction',
  'fan'
];

const LANE_FOR_BOTTLENECK = {
  'profile-visit': 'worldview',
  follow: 'tasteDiscovery',
  'music-discovery': 'musicAndCreation',
  'music-click': 'musicAndCreation',
  'repeat-interaction': 'tasteDiscovery',
  exposure: 'worldview',
  engagement: 'worldview'
};

function ratio(numerator, denominator) {
  if (numerator == null || denominator == null || !(denominator > 0)) return { value: null, available: false };
  return { value: numerator / denominator, available: true };
}

export function funnelSnapshot({ metrics = {}, now = new Date() } = {}) {
  const impressions = metrics.impressions ?? metrics.reach ?? null;
  const profileVisits = metrics.profileVisits ?? metrics.profileClicks ?? null;
  const follows = metrics.follows ?? null;
  const musicClicks = metrics.musicClicks ?? metrics.urlClicks ?? null;
  const engagement = metrics.engagement ?? null;
  const unknown = [];
  for (const [key, value] of Object.entries({ impressions, profileVisits, follows, musicClicks, engagement })) {
    if (value == null) unknown.push(key);
  }
  return {
    stages: STAGES,
    metrics: {
      impressions: impressions == null ? { value: null, available: false } : { value: impressions, available: true },
      engagement: engagement == null ? { value: null, available: false } : { value: engagement, available: true },
      profileVisits: profileVisits == null ? { value: null, available: false } : { value: profileVisits, available: true },
      follows: follows == null ? { value: null, available: false } : { value: follows, available: true },
      musicClicks: musicClicks == null ? { value: null, available: false } : { value: musicClicks, available: true }
    },
    unknown,
    costType: 'actual-if-present',
    note: 'Missing metrics stay unknown. Estimates are never treated as actual.',
    at: now.toISOString()
  };
}

export function diagnoseFunnel({
  metrics = {},
  mix = null,
  recentContentMix = null,
  confidenceFloor = 0.45
} = {}) {
  const snap = funnelSnapshot({ metrics });
  const impressions = snap.metrics.impressions;
  const profile = snap.metrics.profileVisits;
  const music = snap.metrics.musicClicks;
  const follows = snap.metrics.follows;

  let bottleneck = null;
  let recommendedLane = null;
  let recommendedObjective = null;
  let reason = 'insufficient metrics; keep current mix';
  let confidence = 0;

  const visitRate = ratio(profile.value, impressions.value);
  const musicRate = ratio(music.value, profile.value);
  const followRate = ratio(follows.value, music.value);

  if (impressions.available && profile.available && visitRate.available && visitRate.value < 0.02 && impressions.value >= 200) {
    bottleneck = 'profile-visit';
    recommendedLane = 'worldview';
    recommendedObjective = 'identity-worldview-entry';
    reason = 'reach/impressions are relatively high while profile visits are low; add personality / worldview / identity entries, not more direct promo.';
    confidence = impressions.value >= 500 ? 0.7 : 0.5;
  } else if (profile.available && music.available && musicRate.available && musicRate.value < 0.05 && profile.value >= 20) {
    bottleneck = 'music-click';
    recommendedLane = 'musicAndCreation';
    recommendedObjective = 'music-entry';
    reason = 'profile visits arrive but music clicks/listens are low; add music-entry posts, not mechanical direct promo volume.';
    confidence = profile.value >= 40 ? 0.68 : 0.5;
  } else if (music.available && follows.available && followRate.available && followRate.value < 0.05 && music.value >= 10) {
    bottleneck = 'follow';
    recommendedLane = 'tasteDiscovery';
    recommendedObjective = 'taste-series-identity';
    reason = 'music clicks happen but follows stay low; increase Taste / series / recurring identity, not a hard promo spike.';
    confidence = music.value >= 20 ? 0.62 : 0.48;
  }

  const changeStrategy = Boolean(bottleneck) && confidence >= confidenceFloor;
  return {
    snapshot: snap,
    currentBottleneck: bottleneck,
    recommendedObjective: changeStrategy ? recommendedObjective : null,
    recommendedLane: changeStrategy ? (recommendedLane || LANE_FOR_BOTTLENECK[bottleneck] || null) : null,
    reason: changeStrategy
      ? reason
      : (bottleneck
        ? `${reason} Confidence ${confidence} < ${confidenceFloor}; keep current mix.`
        : reason),
    confidence,
    changeStrategy,
    recentContentMix: recentContentMix || mix || null,
    doNotIncreaseDirectPromo: true
  };
}

export const __test = { STAGES, LANE_FOR_BOTTLENECK, ratio };
