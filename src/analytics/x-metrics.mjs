import crypto from 'node:crypto';
import { fetchJson } from '../lib/http.mjs';

const pct = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
function xAuthHeader(method, url, credentials) {
  const required = ['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret'];
  for (const key of required) if (!credentials?.[key]) throw new Error(`X credential is missing "${key}".`);
  const oauth = { oauth_consumer_key: credentials.consumerKey, oauth_nonce: crypto.randomBytes(18).toString('hex'), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: Math.floor(Date.now() / 1000).toString(), oauth_token: credentials.accessToken, oauth_version: '1.0' };
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries(), ...Object.entries(oauth)].map(([k, v]) => [pct(k), pct(v)]).sort(([ak, av], [bk, bv]) => ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk));
  const normalized = params.map(([k, v]) => `${k}=${v}`).join('&'); const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const base = [method.toUpperCase(), pct(baseUrl), pct(normalized)].join('&'); const key = `${pct(credentials.consumerSecret)}&${pct(credentials.accessTokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return `OAuth ${Object.entries(oauth).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ')}`;
}
function sumMediaMetrics(media = [], key) { return media.reduce((sum, item) => sum + Number(item?.public_metrics?.[key] || item?.non_public_metrics?.[key] || 0), 0); }
function normalizeX(body, privateAvailable) {
  const post = body?.data || {}; const pub = post.public_metrics || {}; const priv = post.non_public_metrics || {}; const media = body?.includes?.media || [];
  return { impressions: Number(pub.impression_count || 0), likes: Number(pub.like_count || 0), reposts: Number(pub.retweet_count || 0), replies: Number(pub.reply_count || 0), quotes: Number(pub.quote_count || 0), bookmarks: Number(pub.bookmark_count || 0), urlClicks: Number(priv.url_link_clicks || 0), profileClicks: Number(priv.user_profile_clicks || 0), engagements: Number(priv.engagements || 0), videoViews: sumMediaMetrics(media, 'view_count'), playback25: sumMediaMetrics(media, 'playback_25_count'), playback50: sumMediaMetrics(media, 'playback_50_count'), playback75: sumMediaMetrics(media, 'playback_75_count'), playback100: sumMediaMetrics(media, 'playback_100_count'), privateMetricsAvailable: privateAvailable };
}
async function request(postId, credential, includePrivate) {
  const url = new URL(`https://api.x.com/2/tweets/${encodeURIComponent(postId)}`);
  url.searchParams.set('tweet.fields', includePrivate ? 'created_at,public_metrics,non_public_metrics,organic_metrics,attachments' : 'created_at,public_metrics,attachments');
  url.searchParams.set('expansions', 'attachments.media_keys');
  url.searchParams.set('media.fields', includePrivate ? 'type,duration_ms,public_metrics,non_public_metrics,organic_metrics' : 'type,duration_ms,public_metrics');
  return fetchJson(url.toString(), { headers: { Authorization: xAuthHeader('GET', url.toString(), credential) } });
}
export async function collectXMetrics({ postId, credential }) {
  try { const body = await request(postId, credential, true); return { metrics: normalizeX(body, true), raw: body }; }
  catch (error) { if (![400, 401, 403].includes(Number(error.status))) throw error; const body = await request(postId, credential, false); return { metrics: normalizeX(body, false), raw: body, warning: 'Private X metrics unavailable; collected public metrics only.' }; }
}
