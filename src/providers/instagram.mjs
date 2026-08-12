import { fetchJson } from '../lib/http.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authHeaders(accessToken) {
  if (!accessToken) throw new Error('Instagram credential is missing "accessToken".');
  return { Authorization: `Bearer ${accessToken}` };
}

async function waitForContainer({ base, containerId, accessToken }) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const status = await fetchJson(`${base}/${containerId}?fields=status_code,status`, {
      headers: authHeaders(accessToken)
    });
    if (status.status_code === 'FINISHED') return status;
    if (['ERROR', 'EXPIRED'].includes(status.status_code)) {
      throw new Error(`Instagram container failed: ${status.status || status.status_code}`);
    }
    await sleep(Math.min(1000 * (attempt + 1), 5000));
  }
  throw new Error('Instagram container did not finish processing in time.');
}

export async function verifyInstagramCredential({ credential, apiVersion = 'v23.0' }) {
  if (!credential?.igUserId) throw new Error('Instagram credential is missing "igUserId".');
  const base = `https://graph.instagram.com/${apiVersion}`;
  const body = await fetchJson(`${base}/${credential.igUserId}?fields=id,username`, {
    method: 'GET',
    headers: authHeaders(credential.accessToken)
  });
  if (!body?.id) throw new Error('Instagram credential check returned no account id.');
  return { id: body.id, username: body.username || null };
}

export async function publishInstagram({ text = '', mediaUrl, mediaType = 'image', credential, apiVersion = 'v23.0', dryRun = false }) {
  if (!mediaUrl) throw new Error('Instagram publishing requires mediaUrl.');
  if (!/^https:\/\//i.test(mediaUrl)) throw new Error('Instagram mediaUrl must be a public https:// URL.');
  if (!credential?.igUserId) throw new Error('Instagram credential is missing "igUserId".');
  if (!['image', 'reel'].includes(mediaType)) throw new Error('Instagram mediaType must be "image" or "reel".');

  if (dryRun) {
    return { dryRun: true, platform: 'instagram', text, mediaUrl, mediaType, apiVersion };
  }

  const base = `https://graph.instagram.com/${apiVersion}`;
  const createUrl = `${base}/${credential.igUserId}/media`;
  const params = new URLSearchParams();
  if (text) params.set('caption', text);
  if (mediaType === 'reel') {
    params.set('media_type', 'REELS');
    params.set('video_url', mediaUrl);
  } else {
    params.set('image_url', mediaUrl);
  }

  const created = await fetchJson(createUrl, {
    method: 'POST',
    headers: {
      ...authHeaders(credential.accessToken),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });
  const containerId = created?.id;
  if (!containerId) throw new Error(`Instagram returned no container id: ${JSON.stringify(created)}`);

  await waitForContainer({ base, containerId, accessToken: credential.accessToken });

  const publishUrl = `${base}/${credential.igUserId}/media_publish`;
  const publishParams = new URLSearchParams({ creation_id: String(containerId) });
  const published = await fetchJson(publishUrl, {
    method: 'POST',
    headers: {
      ...authHeaders(credential.accessToken),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: publishParams
  });

  return {
    platform: 'instagram',
    postId: published?.id,
    containerId,
    mediaType,
    raw: published
  };
}
