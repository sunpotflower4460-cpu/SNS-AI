import { trustedApprovalPayload } from '../lib/github.mjs';
import { markSlotIfUnhandled } from '../lib/state.mjs';

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || `GitHub API failed with ${response.status}`);
  return body;
}

export async function expireStaleApprovals({ maxAgeDays = Number(process.env.APPROVAL_MAX_AGE_DAYS || 7) } = {}) {
  if (!token || !repo) return { skipped: true, reason: 'GH_TOKEN or GITHUB_REPOSITORY missing', closed: [] };
  const normalizedMaxAgeDays = Number(maxAgeDays);
  if (!Number.isFinite(normalizedMaxAgeDays) || normalizedMaxAgeDays <= 0) throw new Error('maxAgeDays must be a positive number.');
  const cutoff = Date.now() - normalizedMaxAgeDays * 86_400_000;
  const issues = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await api(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`);
    issues.push(...batch.filter((row) => !row.pull_request));
    if (batch.length < 100) break;
  }
  const stale = issues.filter((issue) => trustedApprovalPayload(issue) && Date.parse(issue.created_at || '') < cutoff);
  const closed = [];
  const expiredSlots = [];
  for (const issue of stale) {
    // Closing the issue used to leave the slot sitting at `approval_pending` in data/state.json forever,
    // so state.json disagreed with reality and the operator reading it believed a draft was still
    // awaiting review. markSlotIfUnhandled is used rather than a plain write so a slot that was actually
    // approved and published in the window between the issue listing and this write is never downgraded.
    //
    // The slot write happens BEFORE the issue is closed, and closing is skipped if it fails. This
    // matters because expireStaleApprovals only ever looks at OPEN issues (state=open above) - once an
    // issue is closed there is no way for a later run to find it again and retry. Closing first and then
    // failing to persist the slot would strand it at whatever state it was in, permanently and silently.
    // Attempting the write first means a transient failure just leaves the issue open for next run.
    const payload = trustedApprovalPayload(issue);
    const slotId = payload?.slotId;
    if (!slotId) continue;
    try {
      const persisted = await markSlotIfUnhandled(slotId, 'expired', {
        account: payload.account, issue: issue.number, reason: `approval expired after ${normalizedMaxAgeDays} day(s)`
      }, { handledStatuses: ['published', 'publishing', 'publish_unknown', 'skipped'] });
      expiredSlots.push({ slotId, issue: issue.number, applied: persisted.applied, currentStatus: persisted.current?.status || null });
    } catch (error) {
      expiredSlots.push({ slotId, issue: issue.number, applied: false, error: String(error.message || error) });
      continue;
    }
    await api(`/repos/${repo}/issues/${issue.number}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: `⏳ SNS-AI automatically expired this approval after ${normalizedMaxAgeDays} day(s). A fresh draft will be generated on a future slot.` }) });
    await api(`/repos/${repo}/issues/${issue.number}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }) });
    closed.push(issue.number);
  }
  // A failed slot write leaves the issue open for retry next run, but maintenance.yml only runs weekly -
  // waiting a week to notice is its own failure. Fail the command now so the workflow step goes red and
  // Actions surfaces it immediately, without losing anything that already succeeded (closed/expiredSlots
  // are still returned to the caller for inspection - see CLI block below).
  const failures = expiredSlots.filter((row) => row.applied === false && row.error);
  if (failures.length) {
    const error = new Error(`Failed to persist expiry for ${failures.length} slot(s): ${failures.map((row) => row.slotId).join(', ')}. Their approval issues were left open for retry.`);
    error.result = { skipped: false, maxAgeDays: normalizedMaxAgeDays, closed, expiredSlots };
    throw error;
  }
  return { skipped: false, maxAgeDays: normalizedMaxAgeDays, closed, expiredSlots };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(await expireStaleApprovals(), null, 2));
  } catch (error) {
    console.error(JSON.stringify(error.result || { error: error.message }, null, 2));
    process.exitCode = 1;
  }
}