import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';

const STATE_FILE = fileURLToPath(new URL('../../data/engagement-state.json', import.meta.url));
const MAX_EVENT_AGE_MS = 45 * 24 * 60 * 60 * 1000;

export function eventFingerprint(accountId, platform, kind, eventId) {
  return createHash('sha256')
    .update(`${String(accountId)}:${String(platform)}:${String(kind)}:${String(eventId)}`)
    .digest('hex')
    .slice(0, 32);
}

export function deterministicDelayMinutes(fingerprint, range = {}) {
  const min = Math.max(0, Math.floor(Number(range.min) || 0));
  const max = Math.max(min, Math.floor(Number(range.max) || min));
  if (max === min) return min;
  const seed = Number.parseInt(String(fingerprint).slice(0, 8), 16);
  return min + (seed % (max - min + 1));
}

export function responseDueAt(createdAt, fingerprint, range) {
  const base = Date.parse(createdAt || '');
  const start = Number.isFinite(base) ? base : Date.now();
  return new Date(start + deterministicDelayMinutes(fingerprint, range) * 60_000);
}

export async function loadEngagementState() {
  return await readJson(STATE_FILE, { schemaVersion: 1, events: {}, counters: {} })
    || { schemaVersion: 1, events: {}, counters: {} };
}

function dateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function counterKey(accountId, kind, now = new Date()) {
  return `${dateKey(now)}:${accountId}:${kind}`;
}

export function countFor(state, accountId, kind, now = new Date()) {
  return Number(state?.counters?.[counterKey(accountId, kind, now)] || 0);
}

export function alreadyHandled(state, fingerprint) {
  return Boolean(state?.events?.[fingerprint]?.status);
}

export function recordHandled(state, fingerprint, detail = {}, now = new Date()) {
  state.schemaVersion = 1;
  state.events ||= {};
  state.counters ||= {};
  state.events[fingerprint] = {
    status: detail.status || 'handled',
    account: detail.account || null,
    platform: detail.platform || null,
    kind: detail.kind || null,
    category: detail.category || null,
    issueNumber: detail.issueNumber || null,
    at: now.toISOString()
  };
  if (detail.incrementCounter && detail.account && detail.kind) {
    const key = counterKey(detail.account, detail.kind, now);
    state.counters[key] = Number(state.counters[key] || 0) + 1;
  }
  return state.events[fingerprint];
}

export function pruneEngagementState(state, now = new Date()) {
  const cutoff = now.getTime() - MAX_EVENT_AGE_MS;
  for (const [key, row] of Object.entries(state.events || {})) {
    const at = Date.parse(row?.at || '');
    if (!Number.isFinite(at) || at < cutoff) delete state.events[key];
  }
  const keepDates = new Set(Array.from({ length: 8 }, (_, offset) => {
    const d = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }));
  for (const key of Object.keys(state.counters || {})) {
    if (!keepDates.has(key.slice(0, 10))) delete state.counters[key];
  }
  return state;
}

export async function saveEngagementState(state) {
  pruneEngagementState(state);
  await writeJsonAtomic(STATE_FILE, state);
  return state;
}

export const __test = { STATE_FILE, dateKey, counterKey, MAX_EVENT_AGE_MS };
