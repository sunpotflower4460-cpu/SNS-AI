import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
function pathFor(accountId) { return fileURLToPath(new URL(`../../data/strategies/${encodeURIComponent(accountId)}.json`, import.meta.url)); }
export async function loadStrategy(accountId) { return readJson(pathFor(accountId), null); }
export async function saveStrategy(accountId, strategy) { await writeJsonAtomic(pathFor(accountId), strategy); return strategy; }
