import { fetchJson } from '../lib/http.mjs';
const BASE_METRICS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'follows', 'profile_visits'];
const REEL_METRICS = ['ig_reels_video_view_total_time', 'ig_reels_avg_watch_time', 'reels_skip_rate'];
function authHeaders(accessToken) { if (!accessToken) throw new Error('Instagram credential is missing accessToken.'); return { Authorization: `Bearer ${accessToken}` }; }
function metricValue(item) { const values = item?.values || []; if (!values.length) return 0; const value = values.at(-1)?.value; return typeof value === 'number' ? value : Number(value || 0); }
async function fetchMetric(base, postId, metric, accessToken) { const url = new URL(`${base}/${encodeURIComponent(postId)}/insights`); url.searchParams.set('metric', metric); const body = await fetchJson(url.toString(), { headers: authHeaders(accessToken) }); return body?.data?.[0] || null; }
export async function collectInstagramMetrics({ postId, credential, apiVersion = 'v23.0', mediaType = 'image' }) {
  if (!credential?.accessToken) throw new Error('Instagram credential is missing accessToken.'); const base = `https://graph.instagram.com/${apiVersion}`;
  const wanted = [...BASE_METRICS, ...(mediaType === 'reel' ? REEL_METRICS : [])]; const found = {}; const unavailable = [];
  for (const metric of wanted) { try { const item = await fetchMetric(base, postId, metric, credential.accessToken); if (item) found[metric] = metricValue(item); } catch (error) { if ([400, 404].includes(Number(error.status))) unavailable.push(metric); else throw error; } }
  return { metrics: { views: Number(found.views || 0), reach: Number(found.reach || 0), likes: Number(found.likes || 0), comments: Number(found.comments || 0), shares: Number(found.shares || 0), saved: Number(found.saved || 0), totalInteractions: Number(found.total_interactions || 0), follows: Number(found.follows || 0), profileVisits: Number(found.profile_visits || 0), reelWatchTimeMs: Number(found.ig_reels_video_view_total_time || 0), reelAvgWatchTimeMs: Number(found.ig_reels_avg_watch_time || 0), reelSkipRate: Number(found.reels_skip_rate || 0) }, unavailable };
}
