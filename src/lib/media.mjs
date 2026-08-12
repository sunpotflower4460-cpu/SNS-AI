import { consumeUsage } from '../ops/budget.mjs';
import { generateAndHostImage } from '../media/openai-image.mjs';

function hashString(value) { let hash = 2166136261; for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return hash >>> 0; }
function poolUrl(media, slotId) { const urls = (media.urls || media.libraryUrls || []).filter(Boolean); return urls.length ? urls[hashString(slotId) % urls.length] : null; }

async function requestMediaEndpoint(accountId, account, slotId, draft, mode) {
  const endpoint = account.media?.endpoint;
  if (!endpoint || !/^https:\/\//i.test(endpoint)) throw new Error('Media generation/search requires an HTTPS media.endpoint.');
  await consumeUsage(accountId, account, 'media', { mode, slotId });
  const headers = { 'Content-Type': 'application/json' }; if (process.env.MEDIA_SERVICE_TOKEN) headers.Authorization = `Bearer ${process.env.MEDIA_SERVICE_TOKEN}`;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({
    account: accountId, platform: account.platform, slotId, mode, mediaType: account.media?.type || 'image',
    prompt: draft?.mediaPrompt || '', text: draft?.text || '', features: draft?.features || {}, rationale: draft?.rationale || ''
  }) });
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error || `Media endpoint failed with HTTP ${response.status}`);
  const url = body.url || body.mediaUrl; if (!/^https:\/\//i.test(url || '')) throw new Error('Media endpoint must return { "url": "https://..." }.'); return url;
}

async function generated(accountId, account, slotId, draft) {
  if (account.media?.endpoint) return { url: await requestMediaEndpoint(accountId, account, slotId, draft, 'generate'), decision: 'generate', source: 'endpoint' };
  if (account.media?.internalImageGeneration !== false && (account.media?.type || 'image') === 'image') {
    return { url: await generateAndHostImage(accountId, account, slotId, draft), decision: 'generate', source: 'openai-image' };
  }
  return { url: null, decision: 'none', source: null };
}

export async function resolveMediaDetailed(accountId, account, slotId, draft) {
  const media = account.media || {}; const strategy = media.strategy || 'none';
  if (strategy === 'none') return { url: null, decision: 'none', source: null };
  if (strategy === 'fixed' || strategy === 'external') return { url: media.url || null, decision: media.url ? 'library' : 'none', source: strategy };
  if (strategy === 'pool') {
    const url = poolUrl(media, slotId);
    return { url, decision: url ? 'library' : 'none', source: 'pool' };
  }
  if (strategy === 'endpoint') {
    const decision = ['search', 'generate'].includes(draft?.features?.mediaDecision) ? draft.features.mediaDecision : 'generate';
    return { url: await requestMediaEndpoint(accountId, account, slotId, draft, decision), decision, source: 'endpoint' };
  }
  if (strategy === 'auto') {
    let decision = draft?.features?.mediaDecision || 'none';
    if (account.platform === 'instagram' && decision === 'none') decision = media.defaultInstagramDecision || 'generate';
    if (decision === 'none') return { url: null, decision: 'none', source: null };
    if (decision === 'library') {
      const url = poolUrl(media, slotId);
      if (url) return { url, decision: 'library', source: 'pool' };
      return generated(accountId, account, slotId, draft);
    }
    if (decision === 'search') {
      if (media.endpoint) return { url: await requestMediaEndpoint(accountId, account, slotId, draft, 'search'), decision: 'search', source: 'endpoint' };
      const fallback = poolUrl(media, slotId);
      if (fallback) return { url: fallback, decision: 'library', source: 'pool-fallback' };
      return generated(accountId, account, slotId, draft);
    }
    if (decision === 'generate') return generated(accountId, account, slotId, draft);
  }
  throw new Error(`Unsupported media strategy: ${strategy}`);
}

export async function resolveMedia(accountId, account, slotId, draft) {
  return (await resolveMediaDetailed(accountId, account, slotId, draft)).url;
}

export function ensureMediaForPlatform(account, mediaUrl) {
  if (account.platform === 'instagram' && !mediaUrl) throw new Error('Instagram requires media. Configure media.strategy as fixed/pool/external/endpoint/auto; auto can use built-in OpenAI image generation on a public repository.');
}
