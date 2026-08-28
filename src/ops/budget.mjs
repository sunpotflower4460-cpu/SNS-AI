import { fileURLToPath } from 'node:url';
import { appendJsonl, readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { localDateKey } from '../lib/schedule.mjs';
import { githubContext, githubRequest } from '../lib/github.mjs';

const FILE = fileURLToPath(new URL('../../data/usage.jsonl', import.meta.url));
const STATE_FILE = fileURLToPath(new URL('../../data/usage-state.json', import.meta.url));
const DURABLE_PATH = 'data/durable-usage-state.json';
const DURABLE_STATE_BRANCH = () => process.env.SNS_DURABLE_STATE_BRANCH || 'sns-ai-state';
const LIMIT_KEYS = {
  openai: 'openaiCallsPerDay',
  webSearch: 'webSearchCallsPerDay',
  media: 'mediaCallsPerDay',
  image: 'imageGenerationsPerDay',
  video: 'videoGenerationsPerDay',
  groq: 'groqCallsPerDay'
};
let mutationQueue = Promise.resolve();

function serializeMutation(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function durableBudgetRequested() {
  return truthy(process.env.SNS_DURABLE_BUDGETS);
}

function durableBudgetEnabled() {
  if (!durableBudgetRequested()) return false;
  // An explicitly requested durable counter must never silently fall back to a runner-local file.
  // Falling back would make separate workflows believe they each have an independent daily budget.
  githubContext();
  return true;
}

function dateFor(account) {
  const timeZone = account?.schedule?.timezone || account?.timezone || 'Asia/Tokyo';
  return localDateKey(new Date(), timeZone);
}

function emptyState() {
  return { schemaVersion: 1, accounts: {} };
}

function normalizedState(value) {
  const state = value && typeof value === 'object' ? value : emptyState();
  state.schemaVersion = 1;
  state.accounts = state.accounts && typeof state.accounts === 'object' && !Array.isArray(state.accounts) ? state.accounts : {};
  return state;
}

async function loadLocalState() {
  return normalizedState(await readJson(STATE_FILE, emptyState()));
}

function currentRow(state, accountId, account) {
  const today = dateFor(account);
  const previous = state.accounts?.[accountId];
  if (!previous || previous.localDate !== today) return { localDate: today, counts: {} };
  return { localDate: previous.localDate, counts: { ...(previous.counts || {}) } };
}

function configuredLimit(accountId, account, kind) {
  const limitKey = LIMIT_KEYS[kind];
  if (!limitKey) return null;
  const raw = account?.budgets?.[limitKey];
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit < 0) {
    const error = new Error(`Invalid daily ${kind} budget for ${accountId}: budgets.${limitKey} must be a non-negative number.`);
    error.code = 'BUDGET_CONFIG_INVALID';
    error.kind = kind;
    error.limitKey = limitKey;
    throw error;
  }
  return limit;
}

function budgetStatusFromState(state, accountId, account, kind) {
  if (account?.budgets?.enabled === false) return { allowed: true, disabled: true };
  const limitKey = LIMIT_KEYS[kind];
  if (!limitKey) return { allowed: true };
  const limit = configuredLimit(accountId, account, kind);
  const row = currentRow(state, accountId, account);
  const used = Number(row.counts?.[kind] || 0);
  if (used >= limit) {
    const error = new Error(`Daily ${kind} budget exhausted for ${accountId}: ${used}/${limit}.`);
    error.code = 'BUDGET_EXHAUSTED';
    error.kind = kind;
    error.used = used;
    error.limit = limit;
    throw error;
  }
  return { allowed: true, used, limit, remaining: limit - used };
}

function incrementState(state, accountId, account, kind, detail = {}) {
  state.accounts ||= {};
  const rowState = currentRow(state, accountId, account);
  rowState.counts[kind] = Number(rowState.counts[kind] || 0) + 1;
  state.accounts[accountId] = rowState;
  state.schemaVersion = 1;
  state.updatedAt = new Date().toISOString();
  return {
    at: state.updatedAt,
    localDate: rowState.localDate,
    account: accountId,
    kind,
    countToday: rowState.counts[kind],
    ...detail
  };
}

async function recordLocalUsageFromState(state, accountId, account, kind, detail = {}) {
  const row = incrementState(state, accountId, account, kind, detail);
  await writeJsonAtomic(STATE_FILE, state);
  await appendJsonl(FILE, row);
  return row;
}

async function readDurableState() {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  const branch = DURABLE_STATE_BRANCH();
  try {
    const remote = await githubRequest(`/repos/${owner}/${repo}/contents/${DURABLE_PATH}?ref=${encodeURIComponent(branch)}`);
    const decoded = Buffer.from(String(remote.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
    return { state: normalizedState(JSON.parse(decoded)), sha: remote.sha || null, bootstrapped: false };
  } catch (error) {
    if (Number(error?.status) === 404) {
      // First migration to the durable counter must not reset today's already-recorded local usage to
      // zero. Seed the first durable write/read from the tracked legacy state; once the durable file
      // exists it becomes authoritative for every connected workflow.
      return { state: await loadLocalState(), sha: null, bootstrapped: true };
    }
    throw error;
  }
}

async function writeDurableState(state, sha) {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  const body = {
    message: 'chore: reserve shared SNS usage budget',
    content: Buffer.from(`${JSON.stringify(normalizedState(state), null, 2)}\n`, 'utf8').toString('base64'),
    branch: DURABLE_STATE_BRANCH()
  };
  if (sha) body.sha = sha;
  return githubRequest(`/repos/${owner}/${repo}/contents/${DURABLE_PATH}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
}

function remoteConflict(error) {
  return [409, 422].includes(Number(error?.status));
}

async function mutateDurableUsage(accountId, account, kind, detail = {}, { enforce = false } = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { state, sha } = await readDurableState();
    const status = enforce ? budgetStatusFromState(state, accountId, account, kind) : null;
    const row = incrementState(state, accountId, account, kind, detail);
    try {
      await writeDurableState(state, sha);
      // Keep the existing JSONL as a best-effort local trace for workflows that already persist it.
      // The authoritative daily counter is the CAS-protected durable state above, not this file.
      await appendJsonl(FILE, row).catch(() => {});
      return { row, status };
    } catch (error) {
      if (remoteConflict(error) && attempt < 5) continue;
      throw error;
    }
  }
  throw new Error('Could not reserve durable SNS usage budget after repeated state conflicts.');
}

async function loadAuthoritativeState() {
  if (durableBudgetEnabled()) return (await readDurableState()).state;
  return loadLocalState();
}

export async function usageToday(accountId, account, kind) {
  // Do not read a stale snapshot while a same-process durable/local mutation is still in flight.
  await mutationQueue.catch(() => {});
  const state = await loadAuthoritativeState();
  const row = currentRow(state, accountId, account);
  return Number(row.counts?.[kind] || 0);
}

export async function assertUsageBudget(accountId, account, kind) {
  await mutationQueue.catch(() => {});
  return budgetStatusFromState(await loadAuthoritativeState(), accountId, account, kind);
}

export async function recordUsage(accountId, account, kind, detail = {}) {
  return serializeMutation(async () => {
    if (durableBudgetEnabled()) return (await mutateDurableUsage(accountId, account, kind, detail)).row;
    return recordLocalUsageFromState(await loadLocalState(), accountId, account, kind, detail);
  });
}

export async function consumeUsage(accountId, account, kind, detail = {}) {
  return serializeMutation(async () => {
    if (durableBudgetEnabled()) return (await mutateDurableUsage(accountId, account, kind, detail, { enforce: true })).status;
    const state = await loadLocalState();
    const status = budgetStatusFromState(state, accountId, account, kind);
    await recordLocalUsageFromState(state, accountId, account, kind, detail);
    return status;
  });
}

export const __test = {
  configuredLimit,
  budgetStatusFromState,
  currentRow,
  durableBudgetRequested,
  durableBudgetEnabled,
  emptyState,
  normalizedState,
  incrementState,
  remoteConflict,
  DURABLE_PATH
};
