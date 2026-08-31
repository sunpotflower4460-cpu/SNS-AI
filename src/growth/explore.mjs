const SHARED = [
  'topic', 'hook', 'format', 'cta', 'media', 'url', 'postingTime', 'length',
  'educational', 'opinion', 'discovery', 'comparison', 'freebie', 'story'
];

const PLUGIN_RADAR = [...SHARED];
const ARTIST = [...SHARED, 'tasteRecommendation'];

export const EXPLORE_DIMENSIONS = {
  'plugin-radar': PLUGIN_RADAR,
  'artist-support': ARTIST,
  scaffold: SHARED
};

export const EXPERIMENT_DIMENSIONS = new Set([
  'hook', 'format', 'cta', 'mediaDecision',
  ...SHARED,
  'tasteRecommendation'
]);

export function exploreDimensionsFor(strategy) {
  return EXPLORE_DIMENSIONS[strategy] || SHARED;
}

export function shouldExplore(slotId, rate = 0.2) {
  let hash = 2166136261;
  for (const char of String(slotId || '')) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const bounded = Math.min(1, Math.max(0, Number(rate)));
  return (hash >>> 0) % 10000 < Math.round(bounded * 10000);
}

export function exploreAssignment(slotId, strategy, rate = 0.2) {
  const explore = shouldExplore(slotId, rate);
  if (!explore) return { mode: 'exploit', dimension: null, rate };
  const dimensions = exploreDimensionsFor(strategy);
  let hash = 2166136261;
  for (const char of String(`dim:${slotId}`)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const dimension = dimensions[(hash >>> 0) % dimensions.length];
  return { mode: 'explore', dimension, rate };
}

export const __test = { SHARED, PLUGIN_RADAR, ARTIST };
