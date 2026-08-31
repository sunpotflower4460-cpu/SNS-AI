const IMAGE_META = [
  /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image|og:image:url)["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image|og:image:url)["']/i,
  /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return null; }
}

function absoluteUrl(value, base) {
  try { return new URL(value, base).toString(); }
  catch { return null; }
}

export function extractMediaCandidatesFromHtml(html, {
  pageUrl = null,
  canonicalUrl = null,
  entityName = null,
  vendor = null
} = {}) {
  const found = [];
  const seen = new Set();
  for (const pattern of IMAGE_META) {
    const match = String(html || '').match(pattern);
    if (!match?.[1]) continue;
    const url = absoluteUrl(match[1], pageUrl || canonicalUrl);
    if (!url || seen.has(url) || !/^https:\/\//i.test(url)) continue;
    seen.add(url);
    const sameHost = hostOf(url) && hostOf(pageUrl || canonicalUrl) && hostOf(url) === hostOf(pageUrl || canonicalUrl);
    found.push({
      mediaUrl: url,
      sourceUrl: pageUrl || canonicalUrl || null,
      canonicalUrl: canonicalUrl || pageUrl || null,
      entityName: entityName || null,
      vendor: vendor || null,
      mediaSourceType: sameHost ? 'official_product_page' : 'unknown',
      usageBasis: 'unknown',
      rightsStatus: 'unverified',
      acquiredBy: 'canonical-html-extract',
      retrievedAt: null
    });
  }
  return found;
}

export async function acquireMediaCandidates({
  canonicalUrl = null,
  entityName = null,
  vendor = null,
  fetchHtml = null,
  now = new Date()
} = {}) {
  if (!canonicalUrl) {
    return {
      acquired: false,
      reason: 'no-canonical-url',
      candidates: [],
      capability: 'canonical-html-extract',
      note: 'Media Hunter ranks provided candidates. It does not search the open web for official images.'
    };
  }
  if (typeof fetchHtml !== 'function') {
    return {
      acquired: false,
      reason: 'fetch-adapter-unconnected',
      candidates: [],
      capability: 'canonical-html-extract',
      note: 'Canonical HTML extract is available when a fetch adapter is connected. Unconnected means official pages were not crawled.'
    };
  }
  const html = await fetchHtml(canonicalUrl);
  const candidates = extractMediaCandidatesFromHtml(html, { pageUrl: canonicalUrl, canonicalUrl, entityName, vendor })
    .map((row) => ({ ...row, retrievedAt: now.toISOString() }));
  return {
    acquired: candidates.length > 0,
    reason: candidates.length ? 'canonical-html-extract' : 'no-og-image',
    candidates,
    capability: 'canonical-html-extract',
    note: 'Extracted from a known canonical URL only. Rights/usage remain unverified (usageBasis=unknown) until an operator confirms them.'
  };
}

export const __test = { IMAGE_META, hostOf, absoluteUrl };
