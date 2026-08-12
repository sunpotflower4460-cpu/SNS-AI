function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function requestMediaEndpoint(accountId, account, slotId, draft) {
  const endpoint = account.media?.endpoint;
  if (!endpoint || !/^https:\/\//i.test(endpoint)) {
    throw new Error('media.strategy "endpoint" requires an HTTPS media.endpoint.');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.MEDIA_SERVICE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.MEDIA_SERVICE_TOKEN}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      account: accountId,
      platform: account.platform,
      slotId,
      mediaType: account.media?.type || 'image',
      prompt: draft?.mediaPrompt || '',
      text: draft?.text || ''
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error || `Media endpoint failed with HTTP ${response.status}`);
  }
  const url = body.url || body.mediaUrl;
  if (!/^https:\/\//i.test(url || '')) {
    throw new Error('Media endpoint must return { "url": "https://..." }.');
  }
  return url;
}

export async function resolveMedia(accountId, account, slotId, draft) {
  const media = account.media || {};
  const strategy = media.strategy || 'none';

  if (strategy === 'none') return null;
  if (strategy === 'fixed') return media.url || null;
  if (strategy === 'pool') {
    const urls = (media.urls || []).filter(Boolean);
    if (!urls.length) return null;
    return urls[hashString(slotId) % urls.length];
  }
  if (strategy === 'external') return media.url || null;
  if (strategy === 'endpoint') return requestMediaEndpoint(accountId, account, slotId, draft);

  throw new Error(`Unsupported media strategy: ${strategy}`);
}

export function ensureMediaForPlatform(account, mediaUrl) {
  if (account.platform === 'instagram' && !mediaUrl) {
    throw new Error(
      'Instagram requires media. Configure media.strategy as fixed/pool/external/endpoint with a public HTTPS URL.'
    );
  }
}
