import { sourcesForAccount } from './sources/registry.mjs';
import { fetchRssSource } from './sources/rss.mjs';
import { fetchGithubReleasesSource } from './sources/github-releases.mjs';
import { loadResearchCache, saveResearchCache, dedupeCandidates, markSeen } from './cache.mjs';
import { appendAudit } from '../lib/audit.mjs';

const FETCHERS = {
  rss: fetchRssSource,
  atom: fetchRssSource,
  'github-releases': fetchGithubReleasesSource
};

// Tier 1 of the low-cost research pipeline: pull directly from configured free/near-free sources
// (RSS/Atom, GitHub Releases) before ever spending an AI call. One dead source (a 404 feed, a DNS
// failure, a GitHub rate limit) must never take down the whole account's research run - every source is
// isolated in its own try/catch, and a failure is recorded to audit rather than thrown.
export async function runDirectFetch(accountId, registry, { audit = appendAudit, sourceKeys = [], cacheAccountId = accountId } = {}) {
  const sources = sourcesForAccount(registry, accountId, sourceKeys.filter((key) => key !== accountId));
  const sourceResults = [];
  const collected = [];

  for (const source of sources) {
    const fetcher = FETCHERS[source.type];
    if (!fetcher) { sourceResults.push({ id: source.id, type: source.type, status: 'unsupported-type' }); continue; }
    try {
      const items = await fetcher(source);
      collected.push(...items);
      sourceResults.push({ id: source.id, type: source.type, status: 'ok', count: items.length });
    } catch (error) {
      sourceResults.push({ id: source.id, type: source.type, status: 'failed', error: String(error?.message || error).slice(0, 300) });
      await audit({ account: accountId, stage: 'research-source-failed', sourceId: source.id, sourceType: source.type, error: String(error?.message || error).slice(0, 300) }).catch(() => {});
    }
  }

  const cache = await loadResearchCache(cacheAccountId);
  const { fresh, duplicates } = dedupeCandidates(collected, cache);
  for (const { hash } of [...fresh, ...duplicates]) markSeen(cache, hash);
  await saveResearchCache(cacheAccountId, cache);

  return {
    sourceResults,
    totalSources: sources.length,
    failedSources: sourceResults.filter((row) => row.status === 'failed').length,
    fetchedCount: collected.length,
    freshCount: fresh.length,
    duplicateCount: duplicates.length,
    candidates: fresh.map((entry) => ({ ...entry.candidate, _cacheHash: entry.hash }))
  };
}

export const __test = { FETCHERS };
