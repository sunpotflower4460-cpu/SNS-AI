import { pathToFileURL } from 'node:url';
import { resolveAccount } from '../lib/config.mjs';
import { writeDurableClaim } from '../lib/durable-claim.mjs';
import { githubContext, githubRequest } from '../lib/github.mjs';
import { syncPublishedHubBacklink } from './publish-hooks.mjs';

const STATE_BRANCH = process.env.SNS_DURABLE_STATE_BRANCH || 'sns-ai-state';
const CLAIMS_DIR = 'data/durable-claims/';
const DEFAULT_LIMIT = 20;
const DEFAULT_CONCURRENCY = 8;

function decodeBlob(blob) {
  return JSON.parse(Buffer.from(String(blob?.content || '').replace(/\n/g, ''), 'base64').toString('utf8'));
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function needsHubBacklinkReconcile(claim) {
  if (claim?.status !== 'published' || claim?.hub?.required !== true) return false;
  if (!claim.slotId || !claim.account || !claim.providerPostId || !validDate(claim.publishedAt)) return false;
  return !validDate(claim.hubBacklinkSyncedAt);
}

function claimTime(claim) {
  return Date.parse(claim.publishedAt || claim.updatedAt || claim.createdAt || '') || Number.MAX_SAFE_INTEGER;
}

export function selectPendingHubClaims(claims, limit = DEFAULT_LIMIT) {
  const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 100) : DEFAULT_LIMIT;
  const pending = claims.filter(needsHubBacklinkReconcile).sort((a, b) => claimTime(a) - claimTime(b));
  return { total: pending.length, selected: pending.slice(0, safeLimit) };
}

export async function loadHubClaims({ request = githubRequest, context = githubContext, concurrency = DEFAULT_CONCURRENCY } = {}) {
  const { repository } = context();
  const [owner, repo] = String(repository || '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is required for Hub reconciliation.');
  const branch = await request(`/repos/${owner}/${repo}/branches/${encodeURIComponent(STATE_BRANCH)}`);
  const treeSha = branch?.commit?.commit?.tree?.sha;
  if (!treeSha) throw new Error(`Could not resolve durable state tree for ${STATE_BRANCH}.`);
  const tree = await request(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  if (tree?.truncated) {
    const error = new Error('Durable state tree is truncated; refusing partial Hub reconciliation.');
    error.code = 'HUB_RECONCILE_TREE_TRUNCATED';
    throw error;
  }
  const entries = (tree?.tree || []).filter((entry) => entry.type === 'blob' && entry.path.startsWith(CLAIMS_DIR) && entry.path.endsWith('.json'));
  const rows = await mapWithConcurrency(entries, Math.max(1, Math.min(Number(concurrency) || DEFAULT_CONCURRENCY, 16)), async (entry) => {
    try {
      return { claim: decodeBlob(await request(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`)), file: entry.path };
    } catch (error) {
      return { error: String(error?.message || error).slice(0, 300), file: entry.path };
    }
  });
  return {
    claims: rows.filter((row) => row.claim).map((row) => row.claim),
    unreadable: rows.filter((row) => row.error)
  };
}

export async function reconcilePendingHubClaim(claim, {
  resolve = resolveAccount,
  sync = syncPublishedHubBacklink,
  writeClaim = writeDurableClaim,
  now = () => new Date()
} = {}) {
  if (!needsHubBacklinkReconcile(claim)) return { skipped: true, slotId: claim?.slotId || null };
  const account = await resolve(claim.account);
  const synced = await sync({
    payload: { account: claim.account, hub: claim.hub },
    account,
    claim,
    postId: claim.providerPostId,
    publishedAt: claim.publishedAt,
    result: null
  });
  const syncedAt = now().toISOString();
  await writeClaim(claim.slotId, 'published', {
    hub: claim.hub,
    hubBacklinkSyncedAt: syncedAt,
    hubBacklinkUrl: synced?.url || null
  });
  return { skipped: false, slotId: claim.slotId, account: claim.account, platform: account.platform, syncedAt, changed: Boolean(synced?.sync?.changed) };
}

export async function runHubReconcile({
  limit = Number(process.env.HUB_RECONCILE_MAX_PER_RUN || DEFAULT_LIMIT),
  load = loadHubClaims,
  reconcile = reconcilePendingHubClaim
} = {}) {
  const loaded = await load();
  if (loaded.unreadable?.length) {
    return { state: 'degraded', totalPending: 0, attempted: 0, repaired: [], errors: loaded.unreadable };
  }
  const { total, selected } = selectPendingHubClaims(loaded.claims || [], limit);
  if (!total) return { state: 'clean', totalPending: 0, attempted: 0, repaired: [], errors: [] };
  const repaired = [];
  const errors = [];
  for (const claim of selected) {
    try {
      repaired.push(await reconcile(claim));
    } catch (error) {
      errors.push({ slotId: claim.slotId, account: claim.account, error: String(error?.message || error).slice(0, 500) });
    }
  }
  const state = errors.length ? 'degraded' : total > selected.length ? 'partial' : 'ok';
  return { state, totalPending: total, attempted: selected.length, repaired, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runHubReconcile();
    console.log(JSON.stringify(report, null, 2));
    if (report.state === 'degraded') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ state: 'degraded', error: error.message, code: error.code || null }, null, 2));
    process.exitCode = 1;
  }
}

export const __test = { decodeBlob, mapWithConcurrency, validDate, claimTime, DEFAULT_LIMIT, DEFAULT_CONCURRENCY };
