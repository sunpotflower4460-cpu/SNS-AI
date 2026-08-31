const PLUGIN_RADAR = [
  'follow_conversion',
  'profile_visits',
  'bookmarks_saves',
  'repost_share',
  'replies',
  'link_clicks',
  'affiliate_conversions',
  'raw_likes'
];

const ARTIST = [
  'profile_visits',
  'follows',
  'repeat_engagement',
  'video_completion',
  'saves',
  'shares',
  'music_link_clicks',
  'music_discovery',
  'replies',
  'raw_likes'
];

const POST_TYPE_OBJECTIVES = {
  discovery: ['profile_visits', 'follow_conversion', 'saves'],
  comparison: ['saves', 'link_clicks', 'replies'],
  freebie: ['saves', 'shares', 'follow_conversion'],
  sale: ['link_clicks', 'affiliate_conversions'],
  taste: ['profile_visits', 'repeat_engagement', 'music_discovery'],
  promotion: ['music_link_clicks', 'follows', 'profile_visits'],
  worldview: ['profile_visits', 'replies', 'repeat_engagement']
};

export function objectivesForStrategy(strategy) {
  if (strategy === 'artist-support') return [...ARTIST];
  if (strategy === 'plugin-radar') return [...PLUGIN_RADAR];
  return ['profile_visits', 'follow_conversion', 'raw_likes'];
}

export function objectivesForPostType(postType, strategy) {
  const specific = POST_TYPE_OBJECTIVES[postType] || [];
  const fallback = objectivesForStrategy(strategy);
  return [...new Set([...specific, ...fallback])];
}

export const __test = { PLUGIN_RADAR, ARTIST, POST_TYPE_OBJECTIVES };
