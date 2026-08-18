import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appendJsonl, readJson, writeJsonAtomic } from '../lib/json-store.mjs';

const STATE_FILE = fileURLToPath(new URL('../../data/engagement-state.json', import.meta.url));
const AUDIT_FILE = fileURLToPath(new URL('../../data/engagement-audit.jsonl', import.meta.url));
const MAX_EVENTS_PER_ACCOUNT = 600;

export function eventKey(accountId, event) {
  return createHash('sha256')
    .update(`${accountId}|${event.platform || ''}|${event.kind || ''}|${event.id || ''}`)
    .digest('hex')
    .slice(0, 32);
}

export async function loadEngagementState() {
  return await readJson(STATE_FILE, { schemaVersion: 1, accounts: {} });
}

function compactEvents(events = {}) {
  return Object.fromEntries(Object.entries(events)
    .sort(([, a], [, b]) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
    .slice(0, MAX_EVENTS_PER_ACCOUNT));
}

export async function eventStatus(accountId, key) {
  const state = await loadEngagementState();
  return state.accounts?.[accountId]?.events?.[key] || null;
}

export async function countSentSince(accountId, kind, since) {
  const state = await loadEngagementState();
  const threshold = new Date(since).getTime();
  return Object.values(state.accounts?.[accountId]?.events || {}).filter((row) => {
    if (row?.status !== 'sent' || row?.kind !== kind || !row?.sentAt) return false;
    const at = new Date(row.sentAt).getTime();
    return Number.isFinite(at) && at >= threshold;
  }).length;
}

export async function markEngagementEvent(accountId, key, detail = {}) {
  const state = await loadEngagementState();
  state.schemaVersion = 1;
  state.accounts ||= {};
  const account = state.accounts[accountId] || { events: {} };
  account.events ||= {};
  const now = new Date().toISOString();
  account.events[key] = {
    ...(account.events[key] || {}),
    ...detail,
    updatedAt: now,
    firstSeenAt: account.events[key]?.firstSeenAt || detail.firstSeenAt || now
  };
  account.events = compactEvents(account.events);
  state.accounts[accountId] = account;
  await writeJsonAtomic(STATE_FILE, state);
  return account.events[key];
}

export async function appendEngagementAudit(entry) {
  return appendJsonl(AUDIT_FILE, {
    at: new Date().toISOString(),
    schemaVersion: 1,
    ...entry
  });
}

export const __test = { compactEvents, MAX_EVENTS_PER_ACCOUNT };
