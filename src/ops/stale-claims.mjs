import { githubContext, githubRequest } from '../lib/github.mjs';

const STATE_BRANCH = process.env.SNS_DURABLE_STATE_BRANCH || 'sns-ai-state';
const CLAIMS_DIR = 'data/durable-claims';
const STUCK_STATUSES = new Set(['publishing', 'publish_unknown']);

function decodeClaim(row) {
  const decoded = Buffer.from(String(row.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
  return JSON.parse(decoded);
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

  let entries;
  try {
    entries = await githubRequest(`/repos/${owner}/${repo}/contents/${CLAIMS_DIR}?ref=${encodeURIComponent(STATE_BRANCH)}`);
  } catch (error) {
    if (error.status === 404) return { skipped: false, maxAgeHours: normalizedMaxAgeHours, stuck: [] };
    throw error;
  }

  const files = (Array.isArray(entries) ? entries : []).filter((entry) => entry.type === 'file' && entry.name.endsWith('.json'));
  const stuck = [];
  for (const file of files) {
    let claim;
    try {
      const row = await githubRequest(`/repos/${owner}/${repo}/contents/${CLAIMS_DIR}/${file.name}?ref=${encodeURIComponent(STATE_BRANCH)}`);
      claim = decodeClaim(row);
    } catch (error) {
      stuck.push({ file: file.name, status: 'unreadable', error: String(error.message || error).slice(0, 300) });
      continue;
    }
    if (!STUCK_STATUSES.has(claim?.status)) continue;
    const updatedAt = Date.parse(claim.updatedAt || claim.createdAt || '');
    const stale = !Number.isFinite(updatedAt) || updatedAt < cutoff;
    if (!stale) continue;
    stuck.push({
      file: file.name,
      slotId: claim.slotId || null,
      account: claim.account || null,
      platform: claim.platform || null,
      status: claim.status,
      updatedAt: claim.updatedAt || null,
      ageHours: Number.isFinite(updatedAt) ? Math.round(((Date.now() - updatedAt) / 3_600_000) * 10) / 10 : null
    });
  }
  return { skipped: false, maxAgeHours: normalizedMaxAgeHours, stuck };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await findStuckClaims();
  console.log(JSON.stringify(report, null, 2));
  if (!report.skipped && report.stuck.length) {
    console.error(`${report.stuck.length} durable slot claim(s) are stuck in publishing/publish_unknown for longer than ${report.maxAgeHours}h. Check the provider account and data/audit.jsonl for these slotIds before touching them manually - do not delete or edit a claim file unless you have confirmed with the provider whether the post actually went out.`);
    process.exitCode = 1;
  }
}
