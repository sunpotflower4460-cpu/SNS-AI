import { createHash } from 'node:crypto';

// The common shape every Tier 1 direct-fetch adapter (RSS/Atom, GitHub Releases, future web-page/API
// adapters) must normalize into before it reaches caching, deduplication, or AI triage. Keeping this in
// one place means a new adapter can never accidentally omit a field the rest of the research pipeline
// depends on.
export function normalizeCandidate(raw = {}) {
  return {
    sourceId: String(raw.sourceId || ''),
    sourceType: String(raw.sourceType || ''),
    title: String(raw.title || '').trim(),
    url: raw.url || null,
    publishedAt: raw.publishedAt || null,
    fetchedAt: raw.fetchedAt || new Date().toISOString(),
    vendor: raw.vendor || null,
    product: raw.product || null,
    summary: String(raw.summary || '').trim().slice(0, 4000),
    rawText: String(raw.rawText || '').slice(0, 20000),
    categories: Array.isArray(raw.categories) ? raw.categories.map(String) : [],
    metadata: raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? raw.metadata : {}
  };
}

// Identity for cache/dedup purposes. Deliberately keyed on URL/title/product/vendor/version rather than
// the full summary text: a vendor blog fixing a typo in an article's body must not be treated as a brand
// new item and re-billed to AI triage, but a version bump on the exact same release/article must.
export function candidateHash(candidate) {
  const canonical = JSON.stringify({
    url: candidate.url || '',
    title: candidate.title || '',
    product: candidate.product || '',
    vendor: candidate.vendor || '',
    version: candidate.metadata?.version || candidate.metadata?.releaseTag || candidate.metadata?.guid || ''
  });
  return createHash('sha256').update(canonical).digest('hex');
}
