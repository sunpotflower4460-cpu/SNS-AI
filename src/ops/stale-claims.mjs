import { githubContext, githubRequest } from '../lib/github.mjs';

const STATE_BRANCH = process.env.SNS_DURABLE_STATE_BRANCH || 'sns-ai-state';
const CLAIMS_DIR = 'data/durable-claims/';
const STUCK_STATUSES = new Set(['publishing', 'publish_unknown']);

function decodeBlob(blob) {
  const decoded = Buffer.from(String(blob.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  return JSON.parse(decoded);
}

// Uses the Git Trees API (recursive) rather than the Contents API directory listing: the Contents API
// caps a single directory listing at 1,000 entries, and nothing in this codebase ever deletes a claim
// file, so data/durable-claims/ is expected to keep growing for the lifetime of the repository - a
// stuck-claim report that silently stopped covering older files past that cap would defeat its own
// purpose. The Trees API supports up to 100,000 entries per request (reporting `truncated: true` if
// even that is exceeded, which this surfaces rather than silently dropping).
async function listClaimBlobs(owner, repo) {
  const branch = await githubRequest(`/repos/${owner}/${repo}/branches/${encodeURIComponent(STATE_BRANCH)}`);
  const treeSha = branch?.commit?.commit?.tree?.sha;
  if (!treeSha) throw new Error(`Could not resolve the tree for branch "${STATE_BRANCH}".`);
  const tree = await githubRequest(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  const blobs = (tree?.tree || []).filter((entry) => entry.type === 'blob' && entry.path.startsWith(CLAIMS_DIR) && entry.path.endsWith('.json'));
  return { blobs, truncated: Boolean(tree?.truncated) };
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

  let blobs;
  let truncated = false;
  try {
    ({ blobs, truncated } = await listClaimBlobs(owner, repo));
  } catch (error) {
    if (error.status === 404) return { skipped: false, maxAgeHours: normalizedMaxAgeHours, stuck: [], truncated: false };
    throw error;
  }

  const stuck = [];
  for (const entry of blobs) {
    const file = entry.path.slice(CLAIMS_DIR.length);
    let claim;
    try {
      const blob = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
      claim = decodeBlob(blob);
    } catch (error) {
      stuck.push({ file, status: 'unreadable', error: String(error.message || error).slice(0, 300) });
      continue;
    }
    if (!STUCK_STATUSES.has(claim?.status)) continue;
    const updatedAt = Date.parse(claim.updatedAt || claim.createdAt || '');
    const stale = !Number.isFinite(updatedAt) || updatedAt < cutoff;
    if (!stale) continue;
    stuck.push({
      file,
      slotId: claim.slotId || null,
      account: claim.account || null,
      platform: claim.platform || null,
      status: claim.status,
      updatedAt: claim.updatedAt || null,
      ageHours: Number.isFinite(updatedAt) ? Math.round(((Date.now() - updatedAt) / 3_600_000) * 10) / 10 : null
    });
  }
  return { skipped: false, maxAgeHours: normalizedMaxAgeHours, stuck, truncated };
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
