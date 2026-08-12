function hashString(value) { let hash = 2166136261; for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return hash >>> 0; }
function poolUrl(media, slotId) { const urls = (media.urls || media.libraryUrls || []).filter(Boolean); return urls.length ? urls[hashString(slotId) % urls.length] : null; }

async function requestMediaEndpoint(accountId, account, slotId, draft, mode) {
  const endpoint = account.media?.endpoint;
  if (!endpoint || !/^https:\/\//i.test(endpoint)) throw new Error('Media generation/search requires an HTTPS media.endpoint.');
  const headers = { 'Content-Type': 'application/json' }; if (process.env.MEDIA_SERVICE_TOKEN) headers.Authorization = `Bearer ${process.env.MEDIA_SERVICE_TOKEN}`;
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({
    account: accountId, platform: account.platform, slotId, mode, mediaType: account.media?.type || 'image',
    prompt: draft?.mediaPrompt || '', text: draft?.text || '', features: draft?.features || {}, rationale: draft?.rationale || ''
  }) });
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error || `Media endpoint failed with HTTP ${response.status}`);
  const url = body.url || body.mediaUrl; if (!/^https:\/\//i.test(url || '')) throw new Error('Media endpoint must return { "url": "https://..." }.'); return url;
}

export async function resolveMedia(accountId, account, slotId, draft) {
  const media = account.media || {}; const strategy = media.strategy || 'none';
  if (strategy === 'none') return null;
  if (strategy === 'fixed' || strategy === 'external') return media.url || null;
  if (strategy === 'pool') return poolUrl(media, slotId);
  if (strategy === 'endpoint') return requestMediaEndpoint(accountId, account, slotId, draft, draft?.features?.mediaDecision || 'generate');
  if (strategy === 'auto') {
    let decision = draft?.features?.mediaDecision || 'none';
    if (account.platform === 'instagram' && decision === 'none') decision = media.defaultInstagramDecision || 'library';
    if (decision === 'none') return null;
    if (decision === 'library') {
      const url = poolUrl(media, slotId); if (url) return url;
      if (media.endpoint) return requestMediaEndpoint(accountId, account, slotId, draft, 'generate');
      return null;
    }
    if (['search', 'generate'].includes(decision)) {
      if (media.endpoint) return requestMediaEndpoint(accountId, account, slotId, draft, decision);
      const fallback = poolUrl(media, slotId); if (fallback) return fallback;
      return null;
    }
  }
  throw new Error(`Unsupported media strategy: ${strategy}`);
}
export function ensureMediaForPlatform(account, mediaUrl) {
  if (account.platform === 'instagram' && !mediaUrl) throw new Error('Instagram requires media. Configure media.strategy as fixed/pool/external/endpoint/auto and provide a public HTTPS media source.');
}
