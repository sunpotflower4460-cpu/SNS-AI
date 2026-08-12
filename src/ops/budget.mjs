import { fileURLToPath } from 'node:url';
import { appendJsonl, readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { localDateKey } from '../lib/schedule.mjs';

const FILE = fileURLToPath(new URL('../../data/usage.jsonl', import.meta.url));
const STATE_FILE = fileURLToPath(new URL('../../data/usage-state.json', import.meta.url));
const LIMIT_KEYS = {
  openai: 'openaiCallsPerDay',
  webSearch: 'webSearchCallsPerDay',
  media: 'mediaCallsPerDay',
  image: 'imageGenerationsPerDay',
  video: 'videoGenerationsPerDay'
};

function dateFor(account) {
  const timeZone = account?.schedule?.timezone || account?.timezone || 'Asia/Tokyo';
  return localDateKey(new Date(), timeZone);
}

async function loadState() {
  return await readJson(STATE_FILE, { accounts: {} }) || { accounts: {} };
}

function currentRow(state, accountId, account) {
  const today = dateFor(account);
  const previous = state.accounts?.[accountId];
  if (!previous || previous.localDate !== today) return { localDate: today, counts: {} };
  return { localDate: previous.localDate, counts: { ...(previous.counts || {}) } };
}

export async function usageToday(accountId, account, kind) {
  const state = await loadState();
  const row = currentRow(state, accountId, account);
  return Number(row.counts?.[kind] || 0);
}

export async function assertUsageBudget(accountId, account, kind) {
  if (account?.budgets?.enabled === false) return { allowed: true, disabled: true };
  const limitKey = LIMIT_KEYS[kind];
  if (!limitKey) return { allowed: true };
  const limit = Number(account?.budgets?.[limitKey]);
  if (!Number.isFinite(limit) || limit <= 0) return { allowed: true, unlimited: true };
  const used = await usageToday(accountId, account, kind);
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

export async function recordUsage(accountId, account, kind, detail = {}) {
  const state = await loadState();
  state.accounts ||= {};
  const rowState = currentRow(state, accountId, account);
  rowState.counts[kind] = Number(rowState.counts[kind] || 0) + 1;
  state.accounts[accountId] = rowState;
  await writeJsonAtomic(STATE_FILE, state);

  const row = {
    at: new Date().toISOString(),
    localDate: rowState.localDate,
    account: accountId,
    kind,
    countToday: rowState.counts[kind],
    ...detail
  };
  await appendJsonl(FILE, row);
  return row;
}

export async function consumeUsage(accountId, account, kind, detail = {}) {
  const status = await assertUsageBudget(accountId, account, kind);
  await recordUsage(accountId, account, kind, detail);
  return status;
}
