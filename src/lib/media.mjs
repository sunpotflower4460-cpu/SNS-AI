import { consumeUsage } from '../ops/budget.mjs';
import { generateAndHostImageDetailed } from '../media/openai-image.mjs';
import { generateAndHostVideoDetailed } from '../media/openai-video.mjs';
import { assertPublicHttpsUrl } from './http.mjs';

function hashString(value) { let hash = 2166136261; for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return hash >>> 0; }
function poolUrl(media, slotId) { const urls = (media.urls || media.libraryUrls || []).filter(Boolean); return urls.length ? urls[hashString(slotId) % urls.length] : null; }
const dryRunUrl = (decision, mediaType = 'image') => `https://dry-run.invalid/${decision || 'media'}.${mediaType === 'reel' ? 'mp4' : 'png'}`;

async function requestMediaEndpoint(accountId, account, slotId, draft, mode) {
  const endpoint = account.media?.endpoint;
  const endpointUrl = assertPublicHttpsUrl(endpoint, 'media.endpoint');
  await consumeUsage(accountId, account, 'media', { mode, slotId });
  const headers = { 'Content-Type': 'application/json' }; if (process.env.MEDIA_SERVICE_TOKEN) headers.Authorization = `Bearer ${process.env.MEDIA_SERVICE_TOKEN}`;
  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      account: accountId, platform: account.platform, slotId, mode, mediaType: account.media?.type || 'image',
      prompt: draft?.mediaPrompt || '', text: draft?.text || '', features: draft?.features || {}, rationale: draft?.rationale || ''
    })
  });
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error || `Media endpoint failed with HTTP ${response.status}`);
  const returned = body.url || body.mediaUrl;
  const url = assertPublicHttpsUrl(returned, 'Media endpoint URL').toString();
  return { url, altText: String(body.altText || '').slice(0, 1000), qa: body.qa || null };
}

async function generated(accountId, account, slotId, draft, dryRun = false, now = new Date()) {
  const mediaType = account.media?.type || 'image';
  if (account.media?.endpoint) return dryRun
    ? { url: dryRunUrl('generate', mediaType), decision: 'generate', source: 'dry-run-endpoint', altText: '', qa: null }
    : { ...(await requestMediaEndpoint(accountId, account, slotId, draft, 'generate')), decision: 'generate', source: 'endpoint' };

  if (mediaType === 'reel' && account.media?.internalVideoGeneration !== false) {
    return dryRun
      ? { url: dryRunUrl('generate', 'reel'), decision: 'generate', source: 'dry-run-openai-video', altText: '', qa: null }
      : { ...(await generateAndHostVideoDetailed(accountId, account, slotId, draft, { now })), decision: 'generate', source: 'openai-video' };
  }

  if (mediaType === 'image' && account.media?.internalImageGeneration !== false) {
    return dryRun
      ? { url: dryRunUrl('generate', 'image'), decision: 'generate', source: 'dry-run-openai-image', altText: '', qa: null }
      : { ...(await generateAndHostImageDetailed(accountId, account, slotId, draft)), decision: 'generate', source: 'openai-image' };
  }
  return { url: null, decision: 'none', source: null, altText: '', qa: null };
}

export async function resolveMediaDetailed(accountId, account, slotId, draft, { dryRun = false, now = new Date() } = {}) {
  const media = account.media || {}; const strategy = media.strategy || 'none'; const mediaType = media.type || 'image';
  if (strategy === 'none') return { url: null, decision: 'none', source: null, altText: '', qa: null };
  if (strategy === 'fixed' || strategy === 'external') return { url: media.url || null, decision: media.url ? 'library' : 'none', source: strategy, altText: String(media.altText || '').slice(0, 1000), qa: null };
  if (strategy === 'pool') {
    const url = poolUrl(media, slotId);
    return { url, decision: url ? 'library' : 'none', source: 'pool', altText: '', qa: null };
  }
  if (strategy === 'endpoint') {
    const decision = ['search', 'generate'].includes(draft?.features?.mediaDecision) ? draft.features.mediaDecision : 'generate';
    return dryRun
      ? { url: dryRunUrl(decision, mediaType), decision, source: 'dry-run-endpoint', altText: '', qa: null }
      : { ...(await requestMediaEndpoint(accountId, account, slotId, draft, decision)), decision, source: 'endpoint' };
  }
  if (strategy === 'generate') return generated(accountId, account, slotId, draft, dryRun, now);
  if (strategy === 'auto') {
    let decision = draft?.features?.mediaDecision || 'none';
    if (account.platform === 'instagram' && decision === 'none') decision = media.defaultInstagramDecision || 'generate';
    if (decision === 'none') return { url: null, decision: 'none', source: null, altText: '', qa: null };
    if (decision === 'library') {
      const url = poolUrl(media, slotId);
      if (url) return { url, decision: 'library', source: 'pool', altText: '', qa: null };
      return generated(accountId, account, slotId, draft, dryRun, now);
    }
    if (decision === 'search') {
      if (media.endpoint) return dryRun
        ? { url: dryRunUrl('search', mediaType), decision: 'search', source: 'dry-run-endpoint', altText: '', qa: null }
        : { ...(await requestMediaEndpoint(accountId, account, slotId, draft, 'search')), decision: 'search', source: 'endpoint' };
      const fallback = poolUrl(media, slotId);
      if (fallback) return { url: fallback, decision: 'library', source: 'pool-fallback', altText: '', qa: null };
      return generated(accountId, account, slotId, draft, dryRun, now);
    }
    if (decision === 'generate') return generated(accountId, account, slotId, draft, dryRun, now);
  }
  throw new Error(`Unsupported media strategy: ${strategy}`);
}

export async function resolveMedia(accountId, account, slotId, draft, options = {}) {
  return (await resolveMediaDetailed(accountId, account, slotId, draft, options)).url;
}

export function ensureMediaForPlatform(account, mediaUrl) {
  if (account.platform === 'instagram' && !mediaUrl) throw new Error('Instagram requires media. Configure media.strategy as fixed/pool/external/endpoint/generate/auto. Built-in OpenAI image and Reel generation are supported on public repositories.');
}
