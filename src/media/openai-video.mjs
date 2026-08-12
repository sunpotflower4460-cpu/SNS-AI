import { createHash } from 'node:crypto';
import { consumeUsage } from '../ops/budget.mjs';
import { ensurePublicRelease, findAsset, uploadReleaseAsset } from './release-host.mjs';
import { correctedMediaPrompt, reviewVisualBytes } from './qa.mjs';

const OPENAI_VIDEOS_URL = 'https://api.openai.com/v1/videos';
const MEDIA_QA_VERSION = 'qa-v2-spritesheet';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safe(value) { return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'video'; }
function digest(value) { return createHash('sha256').update(String(value)).digest('hex').slice(0, 20); }
function apiKey() { const key = process.env.OPENAI_API_KEY; if (!key) throw new Error('Built-in video generation requires OPENAI_API_KEY.'); return key; }
function authHeaders(extra = {}) { return { Authorization: `Bearer ${apiKey()}`, ...extra }; }

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `OpenAI video API failed with ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function findReusableVideo({ prompt, model, size, seconds }) {
  try {
    const body = await fetchJson(`${OPENAI_VIDEOS_URL}?limit=100`, { headers: authHeaders() });
    const cutoff = Math.floor(Date.now() / 1000) - 86400;
    return (body.data || []).find((video) =>
      video.status === 'completed'
      && String(video.prompt || '') === prompt
      && String(video.model || '') === model
      && String(video.size || '') === size
      && Number(video.seconds) === Number(seconds)
      && Number(video.created_at || 0) >= cutoff
    ) || null;
  } catch {
    return null;
  }
}

async function createVideo(accountId, account, prompt) {
  const model = account.media?.videoModel || 'sora-2';
  const size = account.media?.videoSize || '720x1280';
  const seconds = String(Number(account.media?.videoSeconds ?? 8));
  const reusable = await findReusableVideo({ prompt, model, size, seconds });
  if (reusable) return reusable;

  await consumeUsage(accountId, account, 'video', { model, size, seconds: Number(seconds) });
  const body = { model, prompt, size, seconds };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(OPENAI_VIDEOS_URL, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (attempt === 1) throw error;
      await sleep(1500);
      continue;
    }
    const parsed = await response.json().catch(() => ({}));
    if (response.ok) return parsed;
    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 2000);
      continue;
    }
    const error = new Error(parsed?.error?.message || `OpenAI video generation failed with ${response.status}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  throw new Error('OpenAI video generation failed.');
}

async function waitForVideo(video, account) {
  let current = video;
  const timeoutMinutes = Math.max(1, Number(account.media?.videoTimeoutMinutes ?? 15));
  const pollSeconds = Math.max(2, Number(account.media?.videoPollSeconds ?? 8));
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    if (current?.status === 'completed') return current;
    if (current?.status === 'failed') {
      const detail = current?.error?.message || current?.error || current?.status;
      throw new Error(`OpenAI video generation failed: ${detail}`);
    }
    if (!current?.id) throw new Error('OpenAI video job returned no id.');
    await sleep(pollSeconds * 1000);
    current = await fetchJson(`${OPENAI_VIDEOS_URL}/${encodeURIComponent(current.id)}`, { headers: authHeaders() });
  }
  throw new Error(`OpenAI video generation did not complete within ${timeoutMinutes} minute(s).`);
}

async function downloadAsset(videoId, variant, maxBytes) {
  const suffix = variant && variant !== 'video' ? `?variant=${encodeURIComponent(variant)}` : '';
  const response = await fetch(`${OPENAI_VIDEOS_URL}/${encodeURIComponent(videoId)}/content${suffix}`, { headers: authHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`Could not download generated video ${variant || 'video'} (${response.status}): ${body.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  const fallbackType = variant && variant !== 'video' ? 'image/jpeg' : 'video/mp4';
  const contentType = (response.headers.get('content-type') || fallbackType).split(';')[0];
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`Generated ${variant || 'video'} exceeds limit (${maxBytes} bytes).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`Generated ${variant || 'video'} exceeds limit (${maxBytes} bytes).`);
  return { bytes, contentType };
}

async function downloadQaPreview(videoId, maxBytes) {
  try {
    return { ...(await downloadAsset(videoId, 'spritesheet', maxBytes)), variant: 'spritesheet' };
  } catch {
    return { ...(await downloadAsset(videoId, 'thumbnail', maxBytes)), variant: 'thumbnail' };
  }
}

async function deleteVideoQuietly(videoId) {
  if (!videoId) return;
  try { await fetch(`${OPENAI_VIDEOS_URL}/${encodeURIComponent(videoId)}`, { method: 'DELETE', headers: authHeaders() }); } catch { /* best effort */ }
}

export async function generateAndHostVideoDetailed(accountId, account, slotId, draft) {
  const originalPrompt = String(draft?.mediaPrompt || '').trim();
  if (!originalPrompt) throw new Error('AI selected video generation but supplied no mediaPrompt.');
  const model = account.media?.videoModel || 'sora-2';
  const size = account.media?.videoSize || '720x1280';
  const seconds = Number(account.media?.videoSeconds ?? 8);
  const release = await ensurePublicRelease();
  const maxBytes = Number(account.media?.maxHostedVideoBytes ?? 250 * 1024 * 1024);
  const maxPreviewBytes = Number(account.media?.qa?.maxInputBytes ?? 15 * 1024 * 1024);
  const maxRegenerations = Math.max(0, Number(account.media?.qa?.maxRegenerations ?? 1));
  let prompt = originalPrompt;
  let lastQa = null;

  for (let attempt = 0; attempt <= maxRegenerations; attempt += 1) {
    const name = `${safe(accountId)}-${digest(`${MEDIA_QA_VERSION}|${slotId}|${model}|${size}|${seconds}|${prompt}`)}.mp4`;
    const cached = await findAsset(release, name);
    if (cached) return { url: cached, qa: { pass: true, cached: true, score: null, issues: [], previewVariant: 'cached-passed' }, altText: '', attempt, prompt };

    const created = await createVideo(accountId, account, prompt);
    const completed = await waitForVideo(created, account);
    const preview = await downloadQaPreview(completed.id, maxPreviewBytes);
    const qa = await reviewVisualBytes(accountId, account, preview.bytes, preview.contentType, {
      mediaType: `reel-${preview.variant}`, prompt: originalPrompt, postText: draft?.text || ''
    });
    qa.previewVariant = preview.variant;
    if (qa.pass) {
      const video = await downloadAsset(completed.id, 'video', maxBytes);
      const url = await uploadReleaseAsset(release, name, video.bytes, video.contentType || 'video/mp4');
      await deleteVideoQuietly(completed.id);
      return { url, qa, altText: qa.altText || '', attempt, prompt };
    }

    lastQa = qa;
    await deleteVideoQuietly(completed.id);
    if (attempt < maxRegenerations) {
      prompt = correctedMediaPrompt(originalPrompt, qa, attempt + 1);
      continue;
    }
  }

  const error = new Error(`Generated Reel failed pre-publish QA after ${maxRegenerations + 1} attempt(s).`);
  error.code = 'MEDIA_QA_FAILED';
  error.qa = lastQa;
  throw error;
}

export async function generateAndHostVideo(accountId, account, slotId, draft) {
  return (await generateAndHostVideoDetailed(accountId, account, slotId, draft)).url;
}
