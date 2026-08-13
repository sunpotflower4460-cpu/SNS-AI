import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';

const FILE = fileURLToPath(new URL('../../data/runtime-health.json', import.meta.url));
const keyFor = (accountId, stage) => `${accountId}:${stage}`;
let mutationQueue = Promise.resolve();

function serializeMutation(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function load() {
  return await readJson(FILE, { circuits: {} }) || { circuits: {} };
}

export async function circuitStatus(accountId, stage, config = {}) {
  if (config?.enabled === false) return { open: false, disabled: true };
  const state = await load();
  const row = state.circuits?.[keyFor(accountId, stage)] || null;
  const openUntil = row?.openUntil ? Date.parse(row.openUntil) : 0;
  return { ...row, open: Boolean(openUntil && openUntil > Date.now()) };
}

export async function assertCircuitClosed(accountId, stage, config = {}) {
  const status = await circuitStatus(accountId, stage, config);
  if (status.open) {
    const error = new Error(`Circuit open for ${accountId}/${stage} until ${status.openUntil}. Last error: ${status.lastError || 'unknown'}`);
    error.code = 'CIRCUIT_OPEN';
    error.openUntil = status.openUntil;
    throw error;
  }
  return status;
}

export async function recordCircuitSuccess(accountId, stage, config = {}) {
  if (config?.enabled === false) return;
  return serializeMutation(async () => {
    const state = await load();
    state.circuits ||= {};
    state.circuits[keyFor(accountId, stage)] = {
      failures: 0,
      lastSuccess: new Date().toISOString(),
      openUntil: null,
      lastError: null
    };
    await writeJsonAtomic(FILE, state);
    return state.circuits[keyFor(accountId, stage)];
  });
}

export async function recordCircuitFailure(accountId, stage, error, config = {}) {
  if (config?.enabled === false) return;
  const threshold = Math.max(1, Number(config?.failureThreshold ?? 3));
  const cooldownMinutes = Math.max(1, Number(config?.cooldownMinutes ?? 60));
  return serializeMutation(async () => {
    const state = await load();
    state.circuits ||= {};
    const key = keyFor(accountId, stage);
    const previous = state.circuits[key] || {};
    const failures = Number(previous.failures || 0) + 1;
    state.circuits[key] = {
      failures,
      lastFailure: new Date().toISOString(),
      lastSuccess: previous.lastSuccess || null,
      lastError: String(error?.message || error || 'unknown').slice(0, 500),
      openUntil: failures >= threshold ? new Date(Date.now() + cooldownMinutes * 60_000).toISOString() : null
    };
    await writeJsonAtomic(FILE, state);
    return state.circuits[key];
  });
}
