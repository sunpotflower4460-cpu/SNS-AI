import { fileURLToPath } from 'node:url';
import { loadResearchCache, saveResearchCache } from './cache.mjs';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { researchKeyFor } from '../brands/registry.mjs';

function briefPath(key) {
  return fileURLToPath(new URL(`../../data/trends/${encodeURIComponent(key)}.json`, import.meta.url));
}

export function cacheAccountId(brand, accountId) {
  return researchKeyFor(brand, accountId);
}

export async function loadBrandResearchCache(brand, accountId) {
  return loadResearchCache(cacheAccountId(brand, accountId));
}

export async function saveBrandResearchCache(brand, accountId, cache) {
  return saveResearchCache(cacheAccountId(brand, accountId), cache);
}

export async function loadSharedTrendBrief(brand, accountId) {
  const key = cacheAccountId(brand, accountId);
  const shared = await readJson(briefPath(key), null);
  if (shared) return shared;
  if (key !== accountId) return readJson(briefPath(accountId), null);
  return null;
}

export async function saveSharedTrendBrief(brand, accountId, brief) {
  const key = cacheAccountId(brand, accountId);
  const payload = { ...brief, account: accountId, sharedResearchId: key, brandId: brand?.brandId || null };
  await writeJsonAtomic(briefPath(key), payload);
  if (key !== accountId) await writeJsonAtomic(briefPath(accountId), payload);
  return payload;
}

export function sourceLookupKeys(brand, accountId) {
  return [...new Set([accountId, brand?.brandId, brand?.sharedResearchId].filter(Boolean))];
}

export const __test = { briefPath, cacheAccountId };
