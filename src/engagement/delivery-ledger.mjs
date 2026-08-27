import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { githubContext, githubRequest } from '../lib/github.mjs';

const LOCAL_FILE = fileURLToPath(new URL('../../data/engagement-delivery-ledger.json', import.meta.url));
const STATE_BRANCH = process.env.SNS_DURABLE_STATE_BRANCH || 'sns-ai-state';
const REMOTE_PATH = 'data/engagement-delivery-ledger.json';
// run.mjs ignores inbound interactions older than 30 days. Keep resolved delivery guards slightly
// longer than that complete processing window so a compacted engagement-state entry cannot cause an
// older-but-still-processable provider event to be sent twice.
const RESOLVED_RETENTION_MS = 35 * 24 * 60 * 60_000;
const BLOCKING_STATUSES = new Set(['sending', 'sent', 'unknown', 'handled']);
const UNRESOLVED_STATUSES = new Set(['sending', 'unknown']);
// `failed` must outrank `sending` so a definitive local failure whose remote write was lost is not
// permanently blocked by a stale remote `sending` claim on the next beginDelivery merge.
// `unknown` stays above `failed` so ambiguity (possible provider accept) is never demoted to retryable.
const STATUS_RANK = { sending: 0, failed: 1, unknown: 2, sent: 3, handled: 3 };
const PROTECTED_DELIVERY_STATUSES = new Set(['sent', 'handled', 'unknown']);
let mutationQueue = Promise.resolve();

function serializeMutation(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

function hasGithubRuntime() {
  return Boolean((process.env.GITHUB_TOKEN || process.env.GH_TOKEN) && process.env.GITHUB_REPOSITORY);
}

function emptyLedger() {
  return { schemaVersion: 1, records: {} };
}

function normalizedLedger(value) {
  const ledger = value && typeof value === 'object' ? value : emptyLedger();
  ledger.schemaVersion = 1;
  ledger.records = ledger.records && typeof ledger.records === 'object' && !Array.isArray(ledger.records) ? ledger.records : {};
  return ledger;
}

function preferRecord(local, remote) {
  if (!local) return remote || null;
  if (!remote) return local;
  const localRank = STATUS_RANK[String(local.status || '')] ?? -1;
  const remoteRank = STATUS_RANK[String(remote.status || '')] ?? -1;
  if (localRank > remoteRank) return local;
  if (remoteRank > localRank) return remote;
  return String(local.updatedAt || '') >= String(remote.updatedAt || '') ? local : remote;
}

// Remote reads can lag local terminal outcomes (especially a just-marked `sent` that has not yet
// completed its Contents API write). Blindly saveLocal(remote) would demote those guards back to
// `sending` and reopen duplicate-send / false-ambiguity paths on later events in the same run.
function mergeLedgers(remote, local) {
  const merged = emptyLedger();
  const keys = new Set([
    ...Object.keys(remote?.records || {}),
    ...Object.keys(local?.records || {})
  ]);
  for (const key of keys) {
    const preferred = preferRecord(local?.records?.[key], remote?.records?.[key]);
    if (preferred) merged.records[key] = preferred;
  }
  return merged;
}

function validKey(key) {
  const value = String(key || '').trim();
  if (!/^[a-f0-9]{32}$/.test(value)) throw new Error('Engagement delivery ledger requires a 32-character hexadecimal event key.');
  return value;
}

function compactRecords(records = {}, now = Date.now()) {
  const unresolved = [];
  const resolved = [];
  for (const [key, row] of Object.entries(records)) {
    if (UNRESOLVED_STATUSES.has(String(row?.status || ''))) {
      unresolved.push([key, row]);
      continue;
    }
    const at = Date.parse(row?.updatedAt || row?.createdAt || '');
    if (Number.isFinite(at) && now - at <= RESOLVED_RETENTION_MS) resolved.push([key, row]);
  }
  // Do not add a count-based slice here. A hard record cap could evict a 9-30-day-old `sent`
  // guard while the provider event is still inside run.mjs's 30-day ingestion window, reopening a
  // duplicate-send path during high-volume periods. Resolved rows are time-bounded instead; unresolved
  // `sending`/`unknown` rows are intentionally retained until a human resolves the ambiguity.
  resolved.sort(([, a], [, b]) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')));
  return Object.fromEntries([...unresolved, ...resolved]);
}

async function loadLocal() {
  return normalizedLedger(await readJson(LOCAL_FILE, emptyLedger()));
}

async function saveLocal(ledger) {
  ledger.records = compactRecords(ledger.records);
  await writeJsonAtomic(LOCAL_FILE, ledger);
  return ledger;
}

async function readRemote() {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  try {
    const row = await githubRequest(`/repos/${owner}/${repo}/contents/${REMOTE_PATH}?ref=${encodeURIComponent(STATE_BRANCH)}`);
    const decoded = Buffer.from(String(row.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
    return { ledger: normalizedLedger(JSON.parse(decoded)), sha: row.sha || null };
  } catch (error) {
    if (Number(error?.status) === 404) return { ledger: emptyLedger(), sha: null };
    throw error;
  }
}

async function writeRemote(ledger, sha) {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  ledger.records = compactRecords(ledger.records);
  const body = {
    message: 'chore: persist engagement delivery guard',
    content: Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`, 'utf8').toString('base64'),
    branch: STATE_BRANCH
  };
  if (sha) body.sha = sha;
  return githubRequest(`/repos/${owner}/${repo}/contents/${REMOTE_PATH}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
}

function conflict(error) {
  return [409, 422].includes(Number(error?.status));
}

function nextSendingRecord(previous, detail = {}) {
  const now = new Date().toISOString();
  return {
    account: String(detail.accountId || previous?.account || ''),
    platform: String(detail.platform || previous?.platform || ''),
    kind: String(detail.kind || previous?.kind || ''),
    publicInteraction: detail.publicInteraction === true,
    status: 'sending',
    attempts: Number(previous?.attempts || 0) + 1,
    createdAt: previous?.createdAt || now,
    startedAt: now,
    updatedAt: now,
    issueNumber: null
  };
}

export async function getDeliveryRecord(key) {
  const ledger = await loadLocal();
  return ledger.records?.[validKey(key)] || null;
}

export function deliveryBlocksSend(record) {
  return BLOCKING_STATUSES.has(String(record?.status || ''));
}

export function deliveryNeedsHuman(record) {
  return UNRESOLVED_STATUSES.has(String(record?.status || ''));
}

export async function beginDelivery({ key, accountId, platform, kind, publicInteraction = false } = {}) {
  const normalizedKey = validKey(key);
  const detail = { accountId, platform, kind, publicInteraction };

  return serializeMutation(async () => {
    if (!hasGithubRuntime()) {
      const ledger = await loadLocal();
      const previous = ledger.records[normalizedKey] || null;
      if (deliveryBlocksSend(previous)) return { claimed: false, record: previous };
      ledger.records[normalizedKey] = nextSendingRecord(previous, detail);
      await saveLocal(ledger);
      return { claimed: true, record: ledger.records[normalizedKey] };
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { ledger, sha } = await readRemote();
      const local = await loadLocal();
      const merged = mergeLedgers(ledger, local);
      const previous = merged.records[normalizedKey] || null;
      if (deliveryBlocksSend(previous)) {
        await saveLocal(merged);
        return { claimed: false, record: previous };
      }
      merged.records[normalizedKey] = nextSendingRecord(previous, detail);
      try {
        await writeRemote(merged, sha);
        await saveLocal(merged);
        return { claimed: true, record: merged.records[normalizedKey] };
      } catch (error) {
        if (conflict(error) && attempt < 4) continue;
        throw error;
      }
    }
    throw new Error('Could not acquire durable engagement delivery claim.');
  });
}

function applyDeliveryStatus(previous = {}, normalizedStatus, detail = {}, now = new Date().toISOString()) {
  // Terminal successes and unresolved ambiguity must never be demoted by a concurrent/stale
  // markDelivery('failed') (or unknown→failed). Cross-runner races can observe a remote `sent`/`unknown`
  // after another process already completed or escalated; blindly overwriting that guard reopens
  // duplicate-send / false-retry paths that mergeLedgers alone cannot stop.
  const previousRank = STATUS_RANK[String(previous.status || '')] ?? -1;
  const nextRank = STATUS_RANK[String(normalizedStatus || '')] ?? -1;
  if (previousRank > nextRank && PROTECTED_DELIVERY_STATUSES.has(String(previous.status || ''))) {
    return {
      ...previous,
      updatedAt: previous.updatedAt || now,
      issueNumber: detail.issueNumber ?? previous.issueNumber ?? null,
      failureCode: previous.failureCode || null
    };
  }
  return {
    ...previous,
    status: normalizedStatus,
    updatedAt: now,
    completedAt: normalizedStatus === 'sent' || normalizedStatus === 'handled' ? (previous.completedAt || now) : previous.completedAt || null,
    issueNumber: detail.issueNumber ?? previous.issueNumber ?? null,
    failureCode: detail.failureCode ? String(detail.failureCode).slice(0, 80) : (previous.failureCode || null)
  };
}

export async function markDelivery(key, status, detail = {}, { durable = true } = {}) {
  const normalizedKey = validKey(key);
  const normalizedStatus = String(status || '').trim();
  if (!['sent', 'unknown', 'failed', 'handled'].includes(normalizedStatus)) throw new Error(`Unsupported engagement delivery status "${normalizedStatus}".`);
  const now = new Date().toISOString();

  const update = (ledger) => {
    const previous = ledger.records[normalizedKey] || {};
    ledger.records[normalizedKey] = applyDeliveryStatus(previous, normalizedStatus, detail, now);
    return ledger;
  };

  return serializeMutation(async () => {
    // Merge remote first when durable so a local stale `sending`/`unknown` cannot demote a remote
    // `sent` that another runner already persisted.
    if (durable && hasGithubRuntime()) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { ledger, sha } = await readRemote();
        const local = await loadLocal();
        const merged = update(mergeLedgers(ledger, local));
        try {
          await writeRemote(merged, sha);
          await saveLocal(merged);
          return merged.records[normalizedKey];
        } catch (error) {
          if (conflict(error) && attempt < 4) continue;
          throw error;
        }
      }
      throw new Error('Could not persist engagement delivery status.');
    }

    const local = update(await loadLocal());
    await saveLocal(local);
    return local.records[normalizedKey];
  });
}

export function definitiveDeliveryFailure(error) {
  const status = Number(error?.status);
  if (!Number.isFinite(status)) return false;
  return status >= 400 && status < 500 && ![408, 409, 425].includes(status);
}

export const __test = {
  compactRecords,
  normalizedLedger,
  mergeLedgers,
  preferRecord,
  applyDeliveryStatus,
  definitiveDeliveryFailure,
  deliveryBlocksSend,
  deliveryNeedsHuman,
  hasGithubRuntime,
  RESOLVED_RETENTION_MS,
  STATUS_RANK
};
