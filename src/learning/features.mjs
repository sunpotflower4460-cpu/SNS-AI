export const FEATURE_DIMENSIONS = ['topic', 'angle', 'hook', 'emotion', 'format', 'cta', 'mediaDecision', 'postingHour'];
export function historyFeatures(entry, timeZone = 'Asia/Tokyo') {
  const features = { ...(entry.features || {}) };
  if (!features.mediaDecision) features.mediaDecision = entry.mediaUrl ? 'library' : 'none';
  if (entry.at) {
    const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(entry.at));
    features.postingHour = `${hour}:00`;
  }
  return features;
}
