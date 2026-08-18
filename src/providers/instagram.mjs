import { fetchJson } from '../lib/http.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authHeaders(accessToken) {
  if (!accessToken) throw new Error('Instagram credential is missing "accessToken".');
  return { Authorization: `Bearer ${accessToken}` };
}

function mediaContainerForm({ text = '', mediaUrl, mediaType = 'image' }) {
  const form = new FormData();
  if (text) form.set('caption', text);
  if (mediaType === 'reel') {
    form.set('media_type', 'REELS');
    form.set('video_url', mediaUrl);
  } else {
    form.set('image_url', mediaUrl);
  }
  return form;
}

function publishContainerForm(containerId) {
  const form = new FormData();
  form.set('creation_id', String(containerId));
  return form;
}

async function waitForContainer({ base, containerId, accessToken, timeoutMinutes = 5, pollSeconds = 3 }) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMinutes)) * 60_000;
  while (Date.now() < deadline) {
    const status = await fetchJson(`${base}/${containerId}?fields=status_code,status`, {
      headers: authHeaders(accessToken)
    });
    if (status.status_code === 'FINISHED') return status;
    if (['ERROR', 'EXPIRED'].includes(status.status_code)) {
      throw new Error(`Instagram container failed: ${status.status || status.status_code}`);
    }
    await sleep(Math.max(1, Number(pollSeconds)) * 1000);
  }
  throw new Error(`Instagram container did not finish processing within ${Math.max(1, Number(timeoutMinutes))} minute(s).`);
}

// `fields=id,username` is satisfied by instagram_business_basic alone, so the old check proved only
// that the token was valid - not that the account is Professional, and not that
// instagram_business_content_publish was ever granted. Both only surfaced at the first real publish,
// after a full paid generation had already been spent.
//
// content_publishing_limit is the right probe: it is read-only, costs nothing, requires the publish
// permission, and returns the account's remaining 24h quota, which is worth seeing anyway. Its failure
// is classified rather than assumed - only an explicit permission/OAuth error is treated as proof of a
// missing scope, because a false blocker here would stop a working account from launching.
const PROFESSIONAL_ACCOUNT_TYPES = new Set(['BUSINESS', 'MEDIA_CREATOR', 'CREATOR']);

function permissionDenied(error) {
  const code = Number(error?.body?.error?.code);
  if (code === 10 || code === 200 || (code >= 200 && code <= 299)) return true;
  return /permission|scope|not authorized|insufficient/i.test(String(error?.message || ''));
}

async function accountProfile(base, credential) {
  try {
    return await fetchJson(`${base}/${credential.igUserId}?fields=id,username,account_type`, {
      method: 'GET',
      headers: authHeaders(credential.accessToken)
    });
  } catch (error) {
    // account_type is not guaranteed on every API variant; never let an unknown field break the
    // identity check the rest of preflight depends on.
    if (Number(error?.status) !== 400) throw error;
    return fetchJson(`${base}/${credential.igUserId}?fields=id,username`, {
      method: 'GET',
      headers: authHeaders(credential.accessToken)
    });
  }
}

export async function verifyInstagramCredential({ credential, apiVersion = 'v25.0' }) {
  if (!credential?.igUserId) throw new Error('Instagram credential is missing "igUserId".');
  const base = `https://graph.instagram.com/${apiVersion}`;
  const body = await accountProfile(base, credential);
  if (!body?.id) throw new Error('Instagram credential check returned no account id.');

  const accountType = body.account_type ? String(body.account_type).toUpperCase() : null;
  if (accountType && !PROFESSIONAL_ACCOUNT_TYPES.has(accountType)) {
    throw new Error(`Instagram account_type is ${accountType}; content publishing requires a Professional (Business or Creator) account.`);
  }

  let publishAccess = { checked: true, ok: true, quota: null, error: null };
  try {
    const limit = await fetchJson(`${base}/${credential.igUserId}/content_publishing_limit?fields=config,quota_usage`, {
      method: 'GET',
      headers: authHeaders(credential.accessToken)
    });
    const row = Array.isArray(limit?.data) ? limit.data[0] : limit;
    publishAccess = {
      checked: true,
      ok: true,
      quota: row ? { used: row.quota_usage ?? null, total: row.config?.quota_total ?? null } : null,
      error: null
    };
  } catch (error) {
    if (permissionDenied(error)) {
      throw new Error(`Instagram token cannot read content_publishing_limit, which requires instagram_business_content_publish: ${error.message}`);
    }
    publishAccess = { checked: true, ok: false, quota: null, error: error.message };
  }

  return { id: body.id, username: body.username || null, accountType, publishAccess };
}

export async function publishInstagram({ text = '', mediaUrl, mediaType = 'image', credential, apiVersion = 'v25.0', dryRun = false }) {
  if (!mediaUrl) throw new Error('Instagram publishing requires mediaUrl.');
  if (!/^https:\/\//i.test(mediaUrl)) throw new Error('Instagram mediaUrl must be a public https:// URL.');
  if (!credential?.igUserId) throw new Error('Instagram credential is missing "igUserId".');
  if (!['image', 'reel'].includes(mediaType)) throw new Error('Instagram mediaType must be "image" or "reel".');

  if (dryRun) {
    return { dryRun: true, platform: 'instagram', text, mediaUrl, mediaType, apiVersion };
  }

  const base = `https://graph.instagram.com/${apiVersion}`;
  const createUrl = `${base}/${credential.igUserId}/media`;
  let containerId;
  try {
    const created = await fetchJson(createUrl, {
      method: 'POST',
      headers: authHeaders(credential.accessToken),
      body: mediaContainerForm({ text, mediaUrl, mediaType })
    });
    containerId = created?.id;
    if (!containerId) throw new Error(`Instagram returned no container id: ${JSON.stringify(created)}`);
  } catch (error) {
    error.publishStage ||= 'media-container';
    throw error;
  }

  try {
    await waitForContainer({
      base,
      containerId,
      accessToken: credential.accessToken,
      timeoutMinutes: credential.containerTimeoutMinutes ?? 5,
      pollSeconds: credential.containerPollSeconds ?? 3
    });
  } catch (error) {
    error.publishStage ||= 'media-processing';
    throw error;
  }

  const publishUrl = `${base}/${credential.igUserId}/media_publish`;
  try {
    const published = await fetchJson(publishUrl, {
      method: 'POST',
      headers: authHeaders(credential.accessToken),
      body: publishContainerForm(containerId)
    });

    return {
      platform: 'instagram',
      postId: published?.id,
      containerId,
      mediaType,
      raw: published
    };
  } catch (error) {
    error.publishStage ||= 'publish';
    throw error;
  }
}

export const __test = { mediaContainerForm, publishContainerForm };
