import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { githubContext, githubRequest } from '../lib/github.mjs';

const LOCAL_FILE = fileURLToPath(new URL('../../data/engagement-delivery-ledger.json', import.meta.url));
const STATE_BRANCH = process.env.SNS_DURABLE_STATE_BRANCH || 'sns-ai-state';
const REMOTE_PATH = 'data/engagement-delivery-ledger.json';
const RESOLVED_RETENTION_MS = 8 * 24 * 60 * 60_000;
const MAX_RESOLVED_RECORDS = 2000;
const BLOCKING_STATUSES = new Set(['sending', 'sent', 'unknown', 'handled']);
const UNRESOLVED_STATUSES = new Set(['sending', 'unknown']);

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
  resolved.sort(([, a], [, b]) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')));
  return Object.fromEntries([...unresolved, ...resolved.slice(0, MAX_RESOLVED_RECORDS)]);
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
    const previous = ledger.records[normalizedKey] || null;
    if (deliveryBlocksSend(previous)) {
      await saveLocal(ledger);
      return { claimed: false, record: previous };
    }
    ledger.records[normalizedKey] = nextSendingRecord(previous, detail);
    try {
      await writeRemote(ledger, sha);
      await saveLocal(ledger);
      return { claimed: true, record: ledger.records[normalizedKey] };
    } catch (error) {
      if (conflict(error) && attempt < 4) continue;
      throw error;
    }
  }
  throw new Error('Could not acquire durable engagement delivery claim.');
}

export async function markDelivery(key, status, detail = {}, { durable = false } = {}) {
  const normalizedKey = validKey(key);
  const normalizedStatus = String(status || '').trim();
  if (!['sent', 'unknown', 'failed', 'handled'].includes(normalizedStatus)) throw new Error(`Unsupported engagement delivery status "${normalizedStatus}".`);
  const now = new Date().toISOString();

  const update = (ledger) => {
    const previous = ledger.records[normalizedKey] || {};
    ledger.records[normalizedKey] = {
      ...previous,
      status: normalizedStatus,
      updatedAt: now,
      completedAt: normalizedStatus === 'sent' || normalizedStatus === 'handled' ? (previous.completedAt || now) : previous.completedAt || null,
      issueNumber: detail.issueNumber ?? previous.issueNumber ?? null,
      failureCode: detail.failureCode ? String(detail.failureCode).slice(0, 80) : (previous.failureCode || null)
    };
    return ledger;
  };

  const local = update(await loadLocal());
  await saveLocal(local);
  if (!durable || !hasGithubRuntime()) return local.records[normalizedKey];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { ledger, sha } = await readRemote();
    update(ledger);
    try {
      await writeRemote(ledger, sha);
      await saveLocal(ledger);
      return ledger.records[normalizedKey];
    } catch (error) {
      if (conflict(error) && attempt < 4) continue;
      throw error;
    }
  }
  throw new Error('Could not persist engagement delivery status.');
}

export function definitiveDeliveryFailure(error) {
  const status = Number(error?.status);
  if (!Number.isFinite(status)) return false;
  return status >= 400 && status < 500 && ![408, 409, 425].includes(status);
}

export const __test = {
  compactRecords,
  normalizedLedger,
  definitiveDeliveryFailure,
  deliveryBlocksSend,
  deliveryNeedsHuman,
  hasGithubRuntime,
  MAX_RESOLVED_RECORDS,
  RESOLVED_RETENTION_MS
};
