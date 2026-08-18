import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appendJsonl, readJson, writeJsonAtomic } from '../lib/json-store.mjs';

const STATE_FILE = fileURLToPath(new URL('../../data/engagement-state.json', import.meta.url));
const AUDIT_FILE = fileURLToPath(new URL('../../data/engagement-audit.jsonl', import.meta.url));
const MAX_EVENTS_PER_ACCOUNT = 600;
const MAX_ACTIVE_ACTORS_PER_ACCOUNT = 5000;
const MAX_SENT_LOG_PER_ACCOUNT = 5000;
const SENT_LOG_RETENTION_MS = 8 * 24 * 60 * 60_000;

function hash(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

export function eventKey(accountId, event) {
  return hash([accountId, event.platform || '', event.kind || '', event.id || '']);
}

export function actorKey(accountId, event) {
  const actorId = String(event?.authorId || event?.participantId || event?.username || '').trim();
  if (!actorId) return null;
  return hash([accountId, event.platform || '', 'actor', actorId]);
}

export async function loadEngagementState() {
  return await readJson(STATE_FILE, { schemaVersion: 2, accounts: {} });
}

function compactEvents(events = {}) {
  return Object.fromEntries(Object.entries(events)
    .sort(([, a], [, b]) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
    .slice(0, MAX_EVENTS_PER_ACCOUNT));
}

function compactActors(actors = {}) {
  const entries = Object.entries(actors)
    .sort(([, a], [, b]) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')));
  // An explicit "do not auto-reply" is a durable preference, not disposable cache. Never silently forget
  // it just because the account has interacted with many other people. Only routine cooldown actor state
  // is bounded; opted-out pseudonymous hashes remain until an explicit future opt-in/removal path exists.
  const optedOut = entries.filter(([, row]) => row?.optedOut === true);
  const active = entries.filter(([, row]) => row?.optedOut !== true).slice(0, MAX_ACTIVE_ACTORS_PER_ACCOUNT);
  return Object.fromEntries([...optedOut, ...active]);
}

function compactSentLog(rows = [], now = Date.now()) {
  return rows
    .filter((row) => {
      const at = new Date(row?.at || 0).getTime();
      return Number.isFinite(at) && now - at <= SENT_LOG_RETENTION_MS;
    })
    .slice(-MAX_SENT_LOG_PER_ACCOUNT);
}

function ensureAccount(state, accountId) {
  state.schemaVersion = 2;
  state.accounts ||= {};
  const account = state.accounts[accountId] || {};
  account.events ||= {};
  account.actors ||= {};
  account.sentLog = Array.isArray(account.sentLog) ? account.sentLog : [];
  account.fetchLog = Array.isArray(account.fetchLog) ? account.fetchLog : [];
  state.accounts[accountId] = account;
  return account;
}

// Reading inbound interactions is itself a billed operation on X's pay-per-use pricing, and it is
// billed on every poll whether or not anything new arrived. Nothing else in the system bounds it:
// OpenAI spend is capped inside openaiRequest via the account's budgets, but provider READS go
// straight through xOAuth2FetchJson/fetchJson with no counter at all. This log is what
// maxInboundFetchesPerDay is enforced against.
export async function countFetchesSince(accountId, since) {
  const state = await loadEngagementState();
  const threshold = new Date(since).getTime();
  const rows = state.accounts?.[accountId]?.fetchLog;
  if (!Array.isArray(rows)) return 0;
  return rows.filter((row) => {
    const at = new Date(row?.at || 0).getTime();
    return Number.isFinite(at) && at >= threshold;
  }).length;
}

export async function recordInboundFetch(accountId, detail = {}) {
  const state = await loadEngagementState();
  const account = ensureAccount(state, accountId);
  const now = detail.at || new Date().toISOString();
  account.fetchLog.push({ at: now, channel: detail.channel || null });
  account.fetchLog = compactSentLog(account.fetchLog, new Date(now).getTime());
  await writeJsonAtomic(STATE_FILE, state);
  return account.fetchLog.length;
}

// A single X or Instagram collection can make several distinct provider reads (mentions AND dm_events;
// one comments call per own media id, plus conversations and one call per conversation) - checking and
// recording once per COLLECTION let a configured cap of N permit far more than N real, billed requests.
// This checks and appends in one load/write instead of two, so the check and the record cannot observe
// different states, and it is called immediately before each individual provider-read request rather
// than once before the whole collection.
export async function reserveInboundFetch(accountId, limit, detail = {}) {
  const state = await loadEngagementState();
  const account = ensureAccount(state, accountId);
  const now = detail.at || new Date().toISOString();
  const since = new Date(now).getTime() - 24 * 60 * 60_000;
  const used = account.fetchLog.filter((row) => {
    const at = new Date(row?.at || 0).getTime();
    return Number.isFinite(at) && at >= since;
  }).length;
  if (used >= limit) {
    const error = new Error(`Inbound engagement fetch budget exhausted for ${accountId}: ${used}/${limit} in the last 24h.`);
    error.code = 'ENGAGEMENT_FETCH_BUDGET_EXHAUSTED';
    throw error;
  }
  account.fetchLog.push({ at: now, channel: detail.channel || null });
  account.fetchLog = compactSentLog(account.fetchLog, new Date(now).getTime());
  await writeJsonAtomic(STATE_FILE, state);
  return { allowed: true, used: used + 1, limit };
}

export async function eventStatus(accountId, key) {
  const state = await loadEngagementState();
  return state.accounts?.[accountId]?.events?.[key] || null;
}

export async function actorStatus(accountId, key) {
  if (!key) return null;
  const state = await loadEngagementState();
  return state.accounts?.[accountId]?.actors?.[key] || null;
}

export async function countSentSince(accountId, kind, since) {
  const state = await loadEngagementState();
  const threshold = new Date(since).getTime();
  const account = state.accounts?.[accountId] || {};
  const sentLog = Array.isArray(account.sentLog) ? account.sentLog : [];
  if (sentLog.length) {
    return sentLog.filter((row) => {
      if (row?.kind !== kind || !row?.at) return false;
      const at = new Date(row.at).getTime();
      return Number.isFinite(at) && at >= threshold;
    }).length;
  }
  // Backward-compatible migration path for schemaVersion 1 state.
  return Object.values(account.events || {}).filter((row) => {
    if (row?.status !== 'sent' || row?.kind !== kind || !row?.sentAt) return false;
    const at = new Date(row.sentAt).getTime();
    return Number.isFinite(at) && at >= threshold;
  }).length;
}

export async function markEngagementEvent(accountId, key, detail = {}) {
  const state = await loadEngagementState();
  const account = ensureAccount(state, accountId);
  const now = new Date().toISOString();
  account.events[key] = {
    ...(account.events[key] || {}),
    ...detail,
    updatedAt: now,
    firstSeenAt: account.events[key]?.firstSeenAt || detail.firstSeenAt || now
  };
  account.events = compactEvents(account.events);
  account.actors = compactActors(account.actors);
  account.sentLog = compactSentLog(account.sentLog);
  await writeJsonAtomic(STATE_FILE, state);
  return account.events[key];
}

export async function markActorOptOut(accountId, key) {
  if (!key) return null;
  const state = await loadEngagementState();
  const account = ensureAccount(state, accountId);
  const now = new Date().toISOString();
  account.actors[key] = {
    ...(account.actors[key] || {}),
    optedOut: true,
    optedOutAt: account.actors[key]?.optedOutAt || now,
    updatedAt: now
  };
  account.actors = compactActors(account.actors);
  await writeJsonAtomic(STATE_FILE, state);
  return account.actors[key];
}

export async function markEngagementSent(accountId, key, actor, detail = {}) {
  const state = await loadEngagementState();
  const account = ensureAccount(state, accountId);
  const now = detail.sentAt || new Date().toISOString();
  account.events[key] = {
    ...(account.events[key] || {}),
    ...detail,
    status: 'sent',
    sentAt: now,
    updatedAt: now,
    firstSeenAt: account.events[key]?.firstSeenAt || detail.firstSeenAt || now
  };
  if (actor) {
    const priorActor = account.actors[actor] || {};
    account.actors[actor] = {
      ...priorActor,
      lastSentAt: { ...(priorActor.lastSentAt || {}), [detail.kind]: now },
      updatedAt: now
    };
  }
  account.sentLog.push({ at: now, kind: detail.kind, eventKey: key, actorKey: actor || null });
  account.events = compactEvents(account.events);
  account.actors = compactActors(account.actors);
  account.sentLog = compactSentLog(account.sentLog, new Date(now).getTime());
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

export const __test = {
  compactSentLog,
  compactEvents,
  compactActors,
  MAX_EVENTS_PER_ACCOUNT,
  MAX_ACTIVE_ACTORS_PER_ACCOUNT,
  MAX_SENT_LOG_PER_ACCOUNT
};
