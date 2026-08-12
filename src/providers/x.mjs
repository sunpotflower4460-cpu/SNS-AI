import crypto from 'node:crypto';
import { fetchJson, downloadMedia } from '../lib/http.mjs';

const CREATE_POST_URL = 'https://api.x.com/2/tweets';
const MEDIA_UPLOAD_URL = 'https://api.x.com/2/media/upload';
const MEDIA_INIT_URL = 'https://api.x.com/2/media/upload/initialize';
const MEDIA_METADATA_URL = 'https://api.x.com/2/media/metadata';
const VERIFY_USER_URL = 'https://api.x.com/2/users/me?user.fields=id,name,username';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function bearerHeader(credentials) {
  const token = String(credentials.oauth2AccessToken || '').trim();
  if (!token) throw new Error('X video upload requires credential.oauth2AccessToken (OAuth 2.0 user access token).');
  return `Bearer ${token}`;
}

function mediaMetadataPayload(mediaId, text) {
  return { id: String(mediaId), metadata: { alt_text: { text: String(text || '').trim().slice(0, 1000) } } };
}

async function setAltText(mediaId, text, credentials) {
  const payload = mediaMetadataPayload(mediaId, text);
  if (!payload.metadata.alt_text.text) return;
  await fetchJson(MEDIA_METADATA_URL, {
    method: 'POST',
    headers: { Authorization: oauthHeader('POST', MEDIA_METADATA_URL, credentials), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function uploadImage(mediaUrl, credentials, mediaAltText = '') {
  const maxBytes = 5 * 1024 * 1024;
  const { bytes, contentType } = await downloadMedia(mediaUrl, { maxBytes });
  if (!contentType.startsWith('image/')) throw new Error(`X image publisher expected image media; got ${contentType}.`);
  if (bytes.byteLength > maxBytes) throw new Error('X image exceeds the 5 MB API upload limit.');

  const form = new FormData();
  form.set('media_category', 'tweet_image');
  form.set('media_type', contentType);
  form.set('media', new Blob([bytes], { type: contentType }), `upload.${contentType.split('/')[1] || 'bin'}`);
  const body = await fetchJson(MEDIA_UPLOAD_URL, {
    method: 'POST', headers: { Authorization: oauthHeader('POST', MEDIA_UPLOAD_URL, credentials) }, body: form
  });
  const mediaId = body?.data?.id || body?.data?.id_str || body?.media_id_string;
  if (!mediaId) throw new Error(`X media upload succeeded but returned no media id: ${JSON.stringify(body)}`);
  if (mediaAltText) await setAltText(mediaId, mediaAltText, credentials);
  return String(mediaId);
}

async function initializeVideo(bytes, contentType, credentials) {
  const body = await fetchJson(MEDIA_INIT_URL, {
    method: 'POST',
    headers: { Authorization: bearerHeader(credentials), 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_category: 'tweet_video', media_type: contentType || 'video/mp4', shared: false, total_bytes: bytes.byteLength })
  });
  const id = body?.data?.id;
  if (!id) throw new Error('X video initialize returned no media id.');
  return String(id);
}

async function appendVideo(mediaId, bytes, credentials) {
  const chunkBytes = 4 * 1024 * 1024;
  let segment = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes));
    const url = `${MEDIA_UPLOAD_URL}/${encodeURIComponent(mediaId)}/append`;
    await fetchJson(url, {
      method: 'POST',
      headers: { Authorization: bearerHeader(credentials), 'Content-Type': 'application/json' },
      body: JSON.stringify({ media: chunk.toString('base64'), segment_index: segment })
    });
    segment += 1;
  }
}

async function waitVideoProcessing(mediaId, initial, credentials) {
  let info = initial?.data?.processing_info || null;
  const deadline = Date.now() + 10 * 60_000;
  while (info && info.state && info.state !== 'succeeded') {
    if (info.state === 'failed') throw new Error(`X video processing failed: ${JSON.stringify(info.error || info)}`);
    if (Date.now() >= deadline) throw new Error('X video processing did not finish within 10 minutes.');
    await sleep(Math.max(1, Math.min(30, Number(info.check_after_secs || 2))) * 1000);
    const statusUrl = `${MEDIA_UPLOAD_URL}?media_id=${encodeURIComponent(mediaId)}`;
    const status = await fetchJson(statusUrl, { method: 'GET', headers: { Authorization: bearerHeader(credentials) } });
    info = status?.data?.processing_info || null;
    if (!info) return;
  }
}

async function uploadVideo(mediaUrl, credentials) {
  const maxBytes = 512 * 1024 * 1024;
  const { bytes, contentType } = await downloadMedia(mediaUrl, { maxBytes });
  if (!String(contentType || '').startsWith('video/')) throw new Error(`X video publisher expected video media; got ${contentType}.`);
  const mediaId = await initializeVideo(bytes, contentType || 'video/mp4', credentials);
  await appendVideo(mediaId, bytes, credentials);
  const finalizeUrl = `${MEDIA_UPLOAD_URL}/${encodeURIComponent(mediaId)}/finalize`;
  const finalized = await fetchJson(finalizeUrl, { method: 'POST', headers: { Authorization: bearerHeader(credentials) } });
  await waitVideoProcessing(mediaId, finalized, credentials);
  return mediaId;
}

export async function verifyXCredential(credential) {
  const body = await fetchJson(VERIFY_USER_URL, {
    method: 'GET', headers: { Authorization: oauthHeader('GET', VERIFY_USER_URL, credential) }
  });
  if (!body?.data?.id) throw new Error('X credential check returned no authenticated user.');
  return { id: body.data.id, username: body.data.username || null, name: body.data.name || null };
}

export async function verifyXOAuth2Credential(credential) {
  const body = await fetchJson(VERIFY_USER_URL, { method: 'GET', headers: { Authorization: bearerHeader(credential) } });
  if (!body?.data?.id) throw new Error('X OAuth2 credential check returned no authenticated user.');
  return { id: body.data.id, username: body.data.username || null, name: body.data.name || null };
}

export async function publishX({ text = '', mediaUrl, mediaType = 'image', mediaAltText = '', credential, dryRun = false }) {
  if (!text && !mediaUrl) throw new Error('X requires text or mediaUrl.');
  if (dryRun) return { dryRun: true, platform: 'x', text, mediaUrl: mediaUrl || null, mediaType, mediaAltText: mediaAltText || null };

  const payload = {};
  if (text) payload.text = text;
  if (mediaUrl) {
    const mediaId = mediaType === 'reel'
      ? await uploadVideo(mediaUrl, credential)
      : await uploadImage(mediaUrl, credential, mediaAltText);
    payload.media = { media_ids: [mediaId] };
  }

  const body = await fetchJson(CREATE_POST_URL, {
    method: 'POST',
    headers: { Authorization: oauthHeader('POST', CREATE_POST_URL, credential), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  return { platform: 'x', postId: body?.data?.id, text: body?.data?.text ?? text, raw: body };
}

export const __test = { pct, mediaMetadataPayload };
