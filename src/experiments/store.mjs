import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';

function safe(accountId) { return String(accountId).replace(/[^a-zA-Z0-9._-]/g, '_'); }
function pathFor(accountId) { return fileURLToPath(new URL(`../../data/experiments/${safe(accountId)}.json`, import.meta.url)); }

export async function loadExperimentState(accountId) {
  return await readJson(pathFor(accountId), { account: accountId, active: null, completed: [] }) || { account: accountId, active: null, completed: [] };
}

export async function saveExperimentState(accountId, state) {
  const next = { account: accountId, active: state?.active || null, completed: (state?.completed || []).slice(-50) };
  await writeJsonAtomic(pathFor(accountId), next);
  return next;
}
