const X_FIELDS = {
  impressions: 'impressions',
  likes: 'likes',
  reposts: 'reposts',
  replies: 'replies',
  quotes: 'quotes',
  bookmarks: 'bookmarks',
  urlClicks: 'urlClicks',
  profileClicks: 'profileClicks',
  videoViews: 'videoViews',
  playback100: 'playback100'
};

const IG_FIELDS = {
  views: 'views',
  reach: 'reach',
  likes: 'likes',
  comments: 'comments',
  shares: 'shares',
  saved: 'saved',
  follows: 'follows',
  profileVisits: 'profileVisits',
  reelAvgWatchTimeMs: 'reelAvgWatchTimeMs'
};

export function presentNumber(metrics, key) {
  if (!metrics || typeof metrics !== 'object' || !(key in metrics) || metrics[key] == null) return { value: null, available: false };
  const value = Number(metrics[key]);
  if (!Number.isFinite(value)) return { value: null, available: false };
  return { value, available: true };
}

export function normalizeGrowthMetrics(snapshot = {}) {
  const platform = snapshot.platform;
  const raw = snapshot.metrics || {};
  const fieldMap = platform === 'instagram' ? IG_FIELDS : X_FIELDS;
  const available = {};
  const unavailable = [];
  for (const [from, to] of Object.entries(fieldMap)) {
    const parsed = presentNumber(raw, from);
    if (parsed.available) available[to] = parsed.value;
    else unavailable.push(to);
  }

  const impressions = available.impressions ?? available.reach ?? available.views ?? null;
  const likes = available.likes ?? null;
  const shares = (available.reposts || 0) + (available.quotes || 0) + (available.shares || 0);
  const saves = (available.bookmarks || 0) + (available.saved || 0);
  const conversation = (available.replies || 0) + (available.comments || 0);
  const profileVisits = available.profileClicks ?? available.profileVisits ?? null;
  const follows = available.follows ?? null;
  const urlClicks = available.urlClicks ?? null;

  return {
    platform,
    costType: 'actual',
    available,
    unavailable,
    normalized: {
      impressions,
      likes,
      shares: (available.reposts != null || available.quotes != null || available.shares != null) ? shares : null,
      saves: (available.bookmarks != null || available.saved != null) ? saves : null,
      conversation: (available.replies != null || available.comments != null) ? conversation : null,
      profileVisits,
      follows,
      urlClicks,
      videoCompletion: available.playback100 ?? null
    }
  };
}

export const __test = { X_FIELDS, IG_FIELDS, presentNumber };
