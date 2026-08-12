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

export async function verifyInstagramCredential({ credential, apiVersion = 'v25.0' }) {
  if (!credential?.igUserId) throw new Error('Instagram credential is missing "igUserId".');
  const base = `https://graph.instagram.com/${apiVersion}`;
  const body = await fetchJson(`${base}/${credential.igUserId}?fields=id,username`, {
    method: 'GET',
    headers: authHeaders(credential.accessToken)
  });
  if (!body?.id) throw new Error('Instagram credential check returned no account id.');
  return { id: body.id, username: body.username || null };
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
  const created = await fetchJson(createUrl, {
    method: 'POST',
    headers: authHeaders(credential.accessToken),
    body: mediaContainerForm({ text, mediaUrl, mediaType })
  });
  const containerId = created?.id;
  if (!containerId) throw new Error(`Instagram returned no container id: ${JSON.stringify(created)}`);

  await waitForContainer({
    base,
    containerId,
    accessToken: credential.accessToken,
    timeoutMinutes: credential.containerTimeoutMinutes ?? 5,
    pollSeconds: credential.containerPollSeconds ?? 3
  });

  const publishUrl = `${base}/${credential.igUserId}/media_publish`;
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
}

export const __test = { mediaContainerForm, publishContainerForm };
