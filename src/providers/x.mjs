import crypto from 'node:crypto';
import { fetchJson, downloadMedia } from '../lib/http.mjs';

const CREATE_POST_URL = 'https://api.x.com/2/tweets';
const MEDIA_UPLOAD_URL = 'https://api.x.com/2/media/upload';
const MEDIA_METADATA_URL = 'https://api.x.com/2/media/metadata';
const VERIFY_USER_URL = 'https://api.x.com/2/users/me?user.fields=id,name,username';

const pct = (value) => encodeURIComponent(String(value))
  .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function oauthHeader(method, url, credentials) {
  const required = ['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret'];
  for (const key of required) if (!credentials[key]) throw new Error(`X credential is missing "${key}".`);

  const oauth = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: crypto.randomBytes(18).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0'
  };

  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries(), ...Object.entries(oauth)]
    .map(([k, v]) => [pct(k), pct(v)])
    .sort(([ak, av], [bk, bv]) => ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk));
  const normalized = params.map(([k, v]) => `${k}=${v}`).join('&');
  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const signatureBase = [method.toUpperCase(), pct(baseUrl), pct(normalized)].join('&');
  const signingKey = `${pct(credentials.consumerSecret)}&${pct(credentials.accessTokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');

  return `OAuth ${Object.entries(oauth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
    .join(', ')}`;
}

function mediaMetadataPayload(mediaId, text) {
  return { id: String(mediaId), metadata: { alt_text: { text: String(text || '').trim().slice(0, 1000) } } };
}

async function setAltText(mediaId, text, credentials) {
  const payload = mediaMetadataPayload(mediaId, text);
  if (!payload.metadata.alt_text.text) return;
  await fetchJson(MEDIA_METADATA_URL, {
    method: 'POST',
    headers: {
      Authorization: oauthHeader('POST', MEDIA_METADATA_URL, credentials),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

async function uploadImage(mediaUrl, credentials, mediaAltText = '') {
  const maxBytes = 5 * 1024 * 1024;
  const { bytes, contentType } = await downloadMedia(mediaUrl, { maxBytes });
  if (!contentType.startsWith('image/')) throw new Error(`X publisher currently accepts image media only; got ${contentType}.`);
  if (bytes.byteLength > maxBytes) throw new Error('X image exceeds the 5 MB API upload limit.');

  const form = new FormData();
  form.set('media_category', 'tweet_image');
  form.set('media_type', contentType);
  form.set('media', new Blob([bytes], { type: contentType }), `upload.${contentType.split('/')[1] || 'bin'}`);

  const body = await fetchJson(MEDIA_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: oauthHeader('POST', MEDIA_UPLOAD_URL, credentials) },
    body: form
  });

  const mediaId = body?.data?.id || body?.data?.id_str || body?.media_id_string;
  if (!mediaId) throw new Error(`X media upload succeeded but returned no media id: ${JSON.stringify(body)}`);
  if (mediaAltText) await setAltText(mediaId, mediaAltText, credentials);
  return String(mediaId);
}

export async function verifyXCredential(credential) {
  const body = await fetchJson(VERIFY_USER_URL, {
    method: 'GET',
    headers: { Authorization: oauthHeader('GET', VERIFY_USER_URL, credential) }
  });
  if (!body?.data?.id) throw new Error('X credential check returned no authenticated user.');
  return { id: body.data.id, username: body.data.username || null, name: body.data.name || null };
}

export async function publishX({ text = '', mediaUrl, mediaAltText = '', credential, dryRun = false }) {
  if (!text && !mediaUrl) throw new Error('X requires text or mediaUrl.');
  if (dryRun) return { dryRun: true, platform: 'x', text, mediaUrl: mediaUrl || null, mediaAltText: mediaAltText || null };

  const payload = {};
  if (text) payload.text = text;
  if (mediaUrl) {
    const mediaId = await uploadImage(mediaUrl, credential, mediaAltText);
    payload.media = { media_ids: [mediaId] };
  }

  const body = await fetchJson(CREATE_POST_URL, {
    method: 'POST',
    headers: {
      Authorization: oauthHeader('POST', CREATE_POST_URL, credential),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  return { platform: 'x', postId: body?.data?.id, text: body?.data?.text ?? text, raw: body };
}

export const __test = { pct, mediaMetadataPayload };
