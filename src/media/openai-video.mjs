import { createHash } from 'node:crypto';
import { consumeUsage } from '../ops/budget.mjs';
import { ensurePublicRelease, findAsset, uploadReleaseAsset } from './release-host.mjs';

const OPENAI_VIDEOS_URL = 'https://api.openai.com/v1/videos';
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
  const seconds = Number(account.media?.videoSeconds ?? 8);
  const reusable = await findReusableVideo({ prompt, model, size, seconds });
  if (reusable) return reusable;

  await consumeUsage(accountId, account, 'video', { model, size, seconds });
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
    if (current?.status === 'failed' || current?.status === 'cancelled') {
      const detail = current?.error?.message || current?.error || current?.status;
      throw new Error(`OpenAI video generation ${current.status}: ${detail}`);
    }
    if (!current?.id) throw new Error('OpenAI video job returned no id.');
    await sleep(pollSeconds * 1000);
    current = await fetchJson(`${OPENAI_VIDEOS_URL}/${encodeURIComponent(current.id)}`, { headers: authHeaders() });
  }
  throw new Error(`OpenAI video generation did not complete within ${timeoutMinutes} minute(s).`);
}

async function downloadVideo(videoId, maxBytes) {
  const response = await fetch(`${OPENAI_VIDEOS_URL}/${encodeURIComponent(videoId)}/content`, { headers: authHeaders() });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Could not download generated video (${response.status}): ${body.slice(0, 300)}`);
  }
  const contentType = (response.headers.get('content-type') || 'video/mp4').split(';')[0];
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`Generated video exceeds hosting limit (${maxBytes} bytes).`);

  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Generated video exceeds hosting limit (${maxBytes} bytes).`);
    return { bytes, contentType };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Generated video exceeds hosting limit (${maxBytes} bytes).`);
    }
    chunks.push(Buffer.from(value));
  }
  return { bytes: Buffer.concat(chunks), contentType };
}

export async function generateAndHostVideo(accountId, account, slotId, draft) {
  const prompt = String(draft?.mediaPrompt || '').trim();
  if (!prompt) throw new Error('AI selected video generation but supplied no mediaPrompt.');
  const model = account.media?.videoModel || 'sora-2';
  const size = account.media?.videoSize || '720x1280';
  const seconds = Number(account.media?.videoSeconds ?? 8);
  const release = await ensurePublicRelease();
  const name = `${safe(accountId)}-${digest(`${slotId}|${model}|${size}|${seconds}|${prompt}`)}.mp4`;
  const cached = await findAsset(release, name);
  if (cached) return cached;

  const created = await createVideo(accountId, account, prompt);
  const completed = await waitForVideo(created, account);
  const maxBytes = Number(account.media?.maxHostedVideoBytes ?? 250 * 1024 * 1024);
  const { bytes, contentType } = await downloadVideo(completed.id, maxBytes);
  return uploadReleaseAsset(release, name, bytes, contentType || 'video/mp4');
}
