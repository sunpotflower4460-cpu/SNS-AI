import { fileURLToPath } from 'node:url';
import { appendJsonl, readJsonl } from '../lib/json-store.mjs';
import { localDateKey } from '../lib/schedule.mjs';

const FILE = fileURLToPath(new URL('../../data/usage.jsonl', import.meta.url));
const LIMIT_KEYS = {
  openai: 'openaiCallsPerDay',
  webSearch: 'webSearchCallsPerDay',
  media: 'mediaCallsPerDay',
  image: 'imageGenerationsPerDay'
};

export async function usageToday(accountId, account, kind) {
  const rows = await readJsonl(FILE);
  const timeZone = account?.schedule?.timezone || account?.timezone || 'Asia/Tokyo';
  const today = localDateKey(new Date(), timeZone);
  return rows.filter((row) => row.account === accountId && row.kind === kind && row.localDate === today).length;
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
  const timeZone = account?.schedule?.timezone || account?.timezone || 'Asia/Tokyo';
  const row = {
    at: new Date().toISOString(),
    localDate: localDateKey(new Date(), timeZone),
    account: accountId,
    kind,
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
