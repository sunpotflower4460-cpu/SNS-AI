import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { candidateHash } from './sources/normalize.mjs';

function pathFor(accountId) { return fileURLToPath(new URL(`../../data/research-cache/${encodeURIComponent(accountId)}.json`, import.meta.url)); }

function emptyCache() { return { schemaVersion: 1, entries: {} }; }

export async function loadResearchCache(accountId) {
  const state = await readJson(pathFor(accountId), null);
  if (!state || typeof state !== 'object' || !state.entries || typeof state.entries !== 'object') return emptyCache();
  return { schemaVersion: 1, entries: state.entries };
}

export async function saveResearchCache(accountId, cache) {
  await writeJsonAtomic(pathFor(accountId), cache);
  return cache;
}

// AI cost control, not freshness control: once a piece of content (identified by candidateHash, which
// changes on a real version/URL/title change - see sources/normalize.mjs) has been evaluated, it must
// never be re-sent to paid AI triage again on a later poll, no matter how many hours have passed. A
// 6-hourly re-evaluation of the same unread article/release is exactly the cost the low-cost research
// pipeline exists to eliminate.
export function dedupeCandidates(candidates, cache) {
  const fresh = [];
  const duplicates = [];
  const seenInBatch = new Set();
  for (const candidate of candidates || []) {
    const hash = candidateHash(candidate);
    if (seenInBatch.has(hash)) { duplicates.push({ candidate, hash, reason: 'duplicate-in-batch' }); continue; }
    seenInBatch.add(hash);
    const cached = cache?.entries?.[hash];
    if (cached?.evaluatedAt) { duplicates.push({ candidate, hash, reason: 'already-evaluated' }); continue; }
    fresh.push({ candidate, hash });
  }
  return { fresh, duplicates };
}

export function markSeen(cache, hash, now = new Date()) {
  cache.entries ||= {};
  const existing = cache.entries[hash] || {};
  cache.entries[hash] = { ...existing, firstSeenAt: existing.firstSeenAt || now.toISOString(), lastSeenAt: now.toISOString() };
  return cache;
}

export function markEvaluated(cache, hash, evaluation, now = new Date()) {
  cache.entries ||= {};
  const existing = cache.entries[hash] || {};
  cache.entries[hash] = {
    ...existing,
    firstSeenAt: existing.firstSeenAt || now.toISOString(),
    lastSeenAt: now.toISOString(),
    evaluatedAt: now.toISOString(),
    evaluation: evaluation || null
  };
  return cache;
}

export function pruneResearchCache(cache, maxAgeDays = 90, now = new Date()) {
  const cutoff = now.getTime() - Math.max(1, Number(maxAgeDays)) * 86_400_000;
  const entries = {};
  for (const [hash, entry] of Object.entries(cache?.entries || {})) {
    const at = Date.parse(entry?.evaluatedAt || entry?.lastSeenAt || entry?.firstSeenAt || '');
    if (Number.isFinite(at) && at >= cutoff) entries[hash] = entry;
  }
  return { schemaVersion: 1, entries };
}
