import crypto from 'node:crypto';
import { fetchJson, downloadMedia } from '../lib/http.mjs';
import { assertProviderMutationAllowed, loadRuntimePolicy } from '../ops/manual-only.mjs';
import { xOAuth2FetchJson, verifyXOAuth2Session } from './x-oauth2.mjs';

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

function mediaMetadataPayload(mediaId, text) {
  return { id: String(mediaId), metadata: { alt_text: { text: String(text || '').trim().slice(0, 1000) } } };
}

function imageUploadPayload(bytes, contentType) {
  return {
    media: Buffer.from(bytes).toString('base64'),
    media_category: 'tweet_image',
    media_type: contentType,
    shared: false
  };
}

function videoInitializePayload(bytes, contentType) {
  const normalizedType = !contentType || contentType === 'application/octet-stream' ? 'video/mp4' : contentType;
  return { media_category: 'tweet_video', media_type: normalizedType, shared: false, total_bytes: bytes.byteLength };
}

function imageInitializePayload(bytes, contentType) {
  return { media_category: 'tweet_image', media_type: contentType, shared: false, total_bytes: bytes.byteLength };
}

function createPostPayload({ text = '', mediaIds = [], paidPartnership = false }) {
  const payload = {};
  if (text) payload.text = text;
  if (mediaIds.length) payload.media = { media_ids: mediaIds.map(String) };
  if (paidPartnership) payload.paid_partnership = true;
  return payload;
}

async function assertLiveMutationAllowed(source) {
  const runtimePolicy = await loadRuntimePolicy();
  assertProviderMutationAllowed(runtimePolicy, { dryRun: false, source });
}

async function setAltText(mediaId, text, credentials) {
  const payload = mediaMetadataPayload(mediaId, text);
  if (!payload.metadata.alt_text.text) return;
  await assertLiveMutationAllowed('publish:x:media-metadata');
  await xOAuth2FetchJson(MEDIA_METADATA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, credentials);
}

export const X_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function oversizedImage(message) {
  const error = new Error(message);
  error.code = 'MEDIA_HOSTING_TOO_LARGE';
  return error;
}

function isOAuth2AuthError(error) {
  // Only authentication/authorization failures justify abandoning OAuth2: an HTTP
  // 401/403 status, or X's OAuth2 token-endpoint error code (unauthorized_client),
  // which is what a rejected token refresh surfaces as. Anything else (5xx, network
  // errors, malformed responses) keeps failing on the OAuth2 path instead of
  // silently switching auth schemes mid-publish.
  if (Number(error?.status) === 401 || Number(error?.status) === 403) return true;
  const detail = `${error?.message || ''} ${JSON.stringify(error?.body || '')}`;
  return /unauthorized_client/i.test(detail);
}

async function uploadImageChunkedOAuth1(bytes, contentType, credentials) {
  // Chunked upload (initialize/append/finalize) signed with OAuth 1.0a. Verified
  // live on 2026-11-12: the single-request POST /2/media/upload refuses this
  // app's uploads with HTTP 403 under BOTH OAuth2 bearer and OAuth1 signing,
  // while the chunked endpoints accept OAuth1 and return a media id. This
  // mirrors the video chunk flow, but every step is OAuth1-signed because the
  // OAuth2 session is exactly what is broken when this path runs.
  const buffer = Buffer.from(bytes);
  await assertLiveMutationAllowed('publish:x:image-initialize');
  const initBody = await fetchJson(MEDIA_INIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: oauthHeader('POST', MEDIA_INIT_URL, credentials) },
    body: JSON.stringify(imageInitializePayload(buffer, contentType))
  });
  const mediaId = initBody?.data?.id || initBody?.data?.id_str || initBody?.media_id_string;
  if (!mediaId) throw new Error('X image initialize returned no media id.');
  const chunkBytes = 4 * 1024 * 1024;
  let segment = 0;
  for (let offset = 0; offset < buffer.byteLength; offset += chunkBytes) {
    const chunk = buffer.subarray(offset, Math.min(buffer.byteLength, offset + chunkBytes));
    const url = `${MEDIA_UPLOAD_URL}/${encodeURIComponent(mediaId)}/append`;
    await assertLiveMutationAllowed('publish:x:image-append');
    await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: oauthHeader('POST', url, credentials) },
      body: JSON.stringify({ media: chunk.toString('base64'), segment_index: segment })
    });
    segment += 1;
  }
  const finalizeUrl = `${MEDIA_UPLOAD_URL}/${encodeURIComponent(mediaId)}/finalize`;
  await assertLiveMutationAllowed('publish:x:image-finalize');
  await fetchJson(finalizeUrl, {
    method: 'POST',
    headers: { Authorization: oauthHeader('POST', finalizeUrl, credentials) }
  });
  return String(mediaId);
}

async function uploadImageWithAuth(mediaUrl, credentials, mediaAltText = '') {
  const maxBytes = X_MAX_IMAGE_BYTES;
  let bytes;
  let contentType;
  try {
    ({ bytes, contentType } = await downloadMedia(mediaUrl, { maxBytes }));
  } catch (error) {
    if (/too large|exceeds/i.test(String(error?.message || ''))) throw oversizedImage(`X image exceeds the 5 MB API upload limit: ${error.message}`);
    throw error;
  }
  if (!contentType.startsWith('image/')) throw new Error(`X image publisher expected image media; got ${contentType}.`);
  if (bytes.byteLength > maxBytes) throw oversizedImage('X image exceeds the 5 MB API upload limit.');

  await assertLiveMutationAllowed('publish:x:image-upload');
  const request = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(imageUploadPayload(bytes, contentType))
  };
  let mediaId;
  let authMode = 'oauth2';
  try {
    const body = await xOAuth2FetchJson(MEDIA_UPLOAD_URL, request, credentials);
    mediaId = body?.data?.id || body?.data?.id_str || body?.media_id_string;
    if (!mediaId) throw new Error(`X media upload succeeded but returned no media id: ${JSON.stringify(body)}`);
  } catch (error) {
    if (!isOAuth2AuthError(error)) throw error;
    // OAuth2 is configured but X is rejecting it (e.g. the token refresh is failing
    // with 401 unauthorized_client, or the bearer token gets a 403 from the upload
    // endpoint). Retrying the same single-request endpoint with OAuth1 signing does
    // not help — it refuses OAuth1 too (verified live 2026-11-12) — but the chunked
    // endpoints accept OAuth1, so the fallback uploads in chunks signed with OAuth1.
    // authMode tells publishX to create the post with the scheme that actually
    // uploaded the media.
    mediaId = await uploadImageChunkedOAuth1(bytes, contentType, credentials);
    authMode = 'oauth1';
  }
  if (mediaAltText) await setAltText(mediaId, mediaAltText, credentials);
  return { mediaId: String(mediaId), authMode };
}

async function uploadImage(mediaUrl, credentials, mediaAltText = '') {
  const { mediaId } = await uploadImageWithAuth(mediaUrl, credentials, mediaAltText);
  return mediaId;
}

async function initializeVideo(bytes, contentType, credentials) {
  await assertLiveMutationAllowed('publish:x:video-initialize');
  const body = await xOAuth2FetchJson(MEDIA_INIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(videoInitializePayload(bytes, contentType))
  }, credentials);
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
    await assertLiveMutationAllowed('publish:x:video-append');
    await xOAuth2FetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media: chunk.toString('base64'), segment_index: segment })
    }, credentials);
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
    const status = await xOAuth2FetchJson(statusUrl, { method: 'GET' }, credentials);
    info = status?.data?.processing_info || null;
    if (!info) return;
  }
}

async function uploadVideo(mediaUrl, credentials) {
  const maxBytes = 512 * 1024 * 1024;
  const downloaded = await downloadMedia(mediaUrl, { maxBytes });
  const bytes = Buffer.from(downloaded.bytes);
  const contentType = downloaded.contentType || 'video/mp4';
  if (!contentType.startsWith('video/') && contentType !== 'application/octet-stream') throw new Error(`X video publisher expected video media; got ${contentType}.`);
  const mediaId = await initializeVideo(bytes, contentType, credentials);
  await appendVideo(mediaId, bytes, credentials);
  const finalizeUrl = `${MEDIA_UPLOAD_URL}/${encodeURIComponent(mediaId)}/finalize`;
  await assertLiveMutationAllowed('publish:x:video-finalize');
  const finalized = await xOAuth2FetchJson(finalizeUrl, { method: 'POST' }, credentials);
  await waitVideoProcessing(mediaId, finalized, credentials);
  return mediaId;
}

function readAccessLevel(headerValue) {
  const value = String(headerValue || '').trim().toLowerCase();
  if (!value) return { level: 'unknown', canWrite: null };
  return { level: value, canWrite: value.includes('write') };
}

export async function verifyXCredential(credential) {
  let accessLevel = { level: 'unknown', canWrite: null };
  const body = await fetchJson(VERIFY_USER_URL, {
    method: 'GET',
    headers: { Authorization: oauthHeader('GET', VERIFY_USER_URL, credential) },
    onResponse: (response) => { accessLevel = readAccessLevel(response.headers?.get?.('x-access-level')); }
  });
  if (!body?.data?.id) throw new Error('X credential check returned no authenticated user.');
  if (accessLevel.canWrite === false) {
    throw new Error(`X access token is ${accessLevel.level}, not read-write. Set the app to "Read and write" and then REGENERATE the access token and secret - changing the permission alone does not upgrade an existing token.`);
  }
  return { id: body.data.id, username: body.data.username || null, name: body.data.name || null, accessLevel: accessLevel.level, writeVerified: accessLevel.canWrite };
}

export async function verifyXOAuth2Credential(credential) {
  const body = await xOAuth2FetchJson(VERIFY_USER_URL, { method: 'GET' }, credential);
  if (!body?.data?.id) throw new Error('X OAuth2 credential check returned no authenticated user.');
  const session = await verifyXOAuth2Session(credential);
  return { id: body.data.id, username: body.data.username || null, name: body.data.name || null, session };
}

export async function publishX({ text = '', mediaUrl, mediaType = 'image', mediaAltText = '', credential, dryRun = false, paidPartnership = false }) {
  if (!text && !mediaUrl) throw new Error('X requires text or mediaUrl.');
  if (dryRun) return { dryRun: true, platform: 'x', text, mediaUrl: mediaUrl || null, mediaType, mediaAltText: mediaAltText || null, paidPartnership: Boolean(paidPartnership) };

  await assertLiveMutationAllowed('publish:x');
  const payload = createPostPayload({ text, paidPartnership });
  let mediaAuthMode = null;
  if (mediaUrl) {
    try {
      if (mediaType === 'reel') {
        payload.media = { media_ids: [await uploadVideo(mediaUrl, credential)] };
      } else {
        const uploaded = await uploadImageWithAuth(mediaUrl, credential, mediaAltText);
        mediaAuthMode = uploaded.authMode;
        payload.media = { media_ids: [uploaded.mediaId] };
      }
    } catch (error) {
      error.publishStage ||= 'media';
      throw error;
    }
  }

  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  try {
    await assertLiveMutationAllowed('publish:x:create-post');
    // Media posts are created with the same auth scheme that uploaded the media:
    // while OAuth2 auth is broken (the situation the upload fallback exists for),
    // an OAuth2 create would fail on the same credentials, so a post whose image
    // went up via OAuth1 is also created via OAuth1.
    const createWithOAuth1 = () => fetchJson(CREATE_POST_URL, { ...options, headers: { ...options.headers, Authorization: oauthHeader('POST', CREATE_POST_URL, credential) } });
    let body;
    if (mediaUrl && mediaAuthMode !== 'oauth1') {
      try {
        body = await xOAuth2FetchJson(CREATE_POST_URL, options, credential);
      } catch (error) {
        if (!isOAuth2AuthError(error)) throw error;
        // The media-upload endpoint accepts this app's OAuth2 bearer, but POST
        // /2/tweets rejects it with an empty-body 403 (the same rejection seen on
        // GET /2/users/me). The audit log for 2026-11-12 shows every publish that
        // day passing the media stage and failing at create-post for exactly this
        // reason. A media id is scoped to the user, not the auth scheme, so retry
        // the create signed with OAuth1. A 403 means the post was not created, so
        // the retry cannot duplicate it.
        body = await createWithOAuth1();
      }
    } else {
      body = await createWithOAuth1();
    }
    return { platform: 'x', postId: body?.data?.id, text: body?.data?.text ?? text, raw: body };
  } catch (error) {
    error.publishStage ||= 'create-post';
    throw error;
  }
}

export const __test = { pct, mediaMetadataPayload, imageUploadPayload, videoInitializePayload, imageInitializePayload, createPostPayload, uploadImage, uploadImageWithAuth, uploadImageChunkedOAuth1, isOAuth2AuthError, readAccessLevel };
