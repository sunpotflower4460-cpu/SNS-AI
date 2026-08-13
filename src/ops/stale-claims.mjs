import { pathToFileURL } from 'node:url';
import { githubContext, githubRequest } from '../lib/github.mjs';

const STATE_BRANCH = process.env.SNS_DURABLE_STATE_BRANCH || 'sns-ai-state';
const CLAIMS_DIR = 'data/durable-claims/';
const STUCK_STATUSES = new Set(['publishing', 'publish_unknown']);
// Bounded, not fully sequential: data/durable-claims/ only ever grows (nothing deletes a claim file),
// so a fully sequential one-request-per-blob loop would eventually take longer than the health workflow's
// timeout and would burn through the GitHub API rate limit on its own as the claim count grows into the
// thousands. Bounded to a small constant so this stays a good API citizen rather than firing hundreds of
// concurrent requests at once. Read lazily (not a module-load-time const) so tests can override it.
const DEFAULT_BLOB_FETCH_CONCURRENCY = 8;
const MAX_BLOB_FETCH_CONCURRENCY = 16;
function blobFetchConcurrency() {
  // A malformed value (e.g. "abc") makes Number(...) return NaN. Math.max(1, NaN) is ALSO NaN (NaN
  // poisons any arithmetic comparison), which used to flow into mapWithConcurrency's
  // Array.from({length: NaN}) - that silently produces ZERO workers, so every claim blob would go
  // unevaluated and the report would come back "stuck: []" even with real stuck claims sitting there.
  // Reject anything that isn't a positive integer instead of letting it degrade into a silent no-op, and
  // cap an oversized value so a mistyped env var can't fire hundreds of concurrent requests either.
  const configured = Number(process.env.STALE_CLAIMS_BLOB_CONCURRENCY);
  if (!Number.isInteger(configured) || configured <= 0) return DEFAULT_BLOB_FETCH_CONCURRENCY;
  return Math.min(configured, MAX_BLOB_FETCH_CONCURRENCY);
}

function decodeBlob(blob) {
  const decoded = Buffer.from(String(blob.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  return JSON.parse(decoded);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Uses the Git Trees API (recursive) rather than the Contents API directory listing: the Contents API
// caps a single directory listing at 1,000 entries, and nothing in this codebase ever deletes a claim
// file, so data/durable-claims/ is expected to keep growing for the lifetime of the repository - a
// stuck-claim report that silently stopped covering older files past that cap would defeat its own
// purpose. The Trees API supports up to 100,000 entries per request (reporting `truncated: true` if
// even that is exceeded, which this surfaces rather than silently dropping).
async function listClaimBlobs(owner, repo) {
  let branch;
  try {
    branch = await githubRequest(`/repos/${owner}/${repo}/branches/${encodeURIComponent(STATE_BRANCH)}`);
  } catch (error) {
    if (error.status === 404) {
      // The sns-ai-state branch is a documented go-live precondition (docs/GO_LIVE_CHECKLIST.md), not
      // something that comes and goes normally - the durable-claim CAS guard that prevents duplicate
      // posting cannot even function without it. Reporting "stuck: []" here would read as "everything is
      // fine" when the actual situation is "idempotency protection is not active at all". Fail loudly
      // instead so this surfaces as a health-check failure a human has to act on.
      const missing = new Error(
        `Durable state branch "${STATE_BRANCH}" does not exist. This is a required precondition for `
        + 'duplicate-publish protection (see docs/GO_LIVE_CHECKLIST.md) - without it, no claim is ever '
        + 'durably recorded. Create the branch before trusting any "no stuck claims" result.'
      );
      missing.code = 'DURABLE_STATE_BRANCH_MISSING';
      throw missing;
    }
    throw error;
  }
  const treeSha = branch?.commit?.commit?.tree?.sha;
  if (!treeSha) throw new Error(`Could not resolve the tree for branch "${STATE_BRANCH}".`);
  const tree = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  const blobs = (tree?.tree || []).filter((entry) => entry.type === 'blob' && entry.path.startsWith(CLAIMS_DIR) && entry.path.endsWith('.json'));
  return { blobs, truncated: Boolean(tree?.truncated) };
}

async function evaluateClaimBlob(owner, repo, entry, cutoff) {
  const file = entry.path.slice(CLAIMS_DIR.length);
  let claim;
  try {
    const blob = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
    claim = decodeBlob(blob);
  } catch (error) {
    return { file, status: 'unreadable', error: String(error.message || error).slice(0, 300) };
  }
  if (!STUCK_STATUSES.has(claim?.status)) return null;
  const updatedAt = Date.parse(claim.updatedAt || claim.createdAt || '');
  const stale = !Number.isFinite(updatedAt) || updatedAt < cutoff;
  if (!stale) return null;
  return {
    file,
    slotId: claim.slotId || null,
    account: claim.account || null,
    platform: claim.platform || null,
    status: claim.status,
    updatedAt: claim.updatedAt || null,
    ageHours: Number.isFinite(updatedAt) ? Math.round(((Date.now() - updatedAt) / 3_600_000) * 10) / 10 : null
  };
}

// Durable claims are the single source of truth preventing duplicate publishes: once a slot reaches
// 'publishing' or 'publish_unknown' it is permanently treated as handled (see src/lib/durable-claim.mjs),
// by design, because we can never be certain a provider call that failed ambiguously did not actually
// succeed. Nothing in this codebase automatically resolves a claim stuck in either status - that is
// intentional (auto-retrying could double-post, auto-marking-published could hide a real failure).
// This script only ever *reports* stuck claims older than a threshold so a human can look at the
// provider account and the audit trail and decide; it never mutates a claim.
export async function findStuckClaims({ maxAgeHours = Number(process.env.STUCK_CLAIM_MAX_AGE_HOURS || 3) } = {}) {
  const normalizedMaxAgeHours = Number(maxAgeHours);
  if (!Number.isFinite(normalizedMaxAgeHours) || normalizedMaxAgeHours <= 0) throw new Error('maxAgeHours must be a positive number.');
  let repository;
  try {
    ({ repository } = githubContext());
  } catch (error) {
    return { skipped: true, reason: error.message, stuck: [] };
  }
  const [owner, repo] = repository.split('/');
  const cutoff = Date.now() - normalizedMaxAgeHours * 3_600_000;

  // A missing sns-ai-state branch is deliberately NOT caught here (see listClaimBlobs) - it must
  // propagate as a hard failure, not collapse into an empty, falsely-reassuring report.
  const { blobs, truncated } = await listClaimBlobs(owner, repo);

  const evaluated = await mapWithConcurrency(blobs, blobFetchConcurrency(), (entry) => evaluateClaimBlob(owner, repo, entry, cutoff));
  const stuck = evaluated.filter(Boolean);
  return { skipped: false, maxAgeHours: normalizedMaxAgeHours, stuck, truncated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await findStuckClaims();
  console.log(JSON.stringify(report, null, 2));
  if (report.truncated) {
    console.error(`data/durable-claims/ has grown beyond what a single Git Trees API request can list (100,000 entries) - this report may be missing older claims. Consider archiving/pruning resolved claims.`);
    process.exitCode = 1;
  }
  if (!report.skipped && report.stuck.length) {
    console.error(`${report.stuck.length} durable slot claim(s) are stuck in publishing/publish_unknown for longer than ${report.maxAgeHours}h. Check the provider account and data/audit.jsonl for these slotIds before touching them manually - do not delete or edit a claim file unless you have confirmed with the provider whether the post actually went out.`);
    process.exitCode = 1;
  }
}
