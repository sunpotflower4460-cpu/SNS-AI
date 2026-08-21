export function githubContext() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) {
    throw new Error('Approval mode requires GITHUB_TOKEN/GH_TOKEN and GITHUB_REPOSITORY.');
  }
  return { token, repository };
}

export async function githubRequest(path, options = {}) {
  const { token } = githubContext();
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `GitHub API failed with ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

// This label is cosmetic only - no workflow triggers on it (see approvalInstructions below for the
// actual publish mechanism). Kept so an operator can still mark issues for their own tracking.
export async function ensureApprovalLabel() {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  try {
    return await githubRequest(`/repos/${owner}/${repo}/labels/approved`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  return githubRequest(`/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'approved',
      description: 'Operator tracking marker only - does not trigger publishing. See the issue body for how to publish.',
      color: '2da44e'
    })
  });
}

function approvalTitle(accountId, slotId) {
  return `[approval] ${accountId} ${slotId}`;
}

function approvalMarker(accountId, slotId) {
  return { kind: 'sns-ai-approval', version: 1, account: String(accountId), slotId: String(slotId) };
}

// publish.yml is workflow_dispatch-only under the repo's Manual-Only posture (see
// docs/MANUAL_ONLY_MODE.md and docs/MANUAL_SETUP_CHECKLIST.md) - there is no `issues: [labeled]` (or
// any other) server-side trigger anywhere in .github/workflows/ that fires on this issue. Adding a
// label, commenting, or closing the issue does NOT publish anything; GitHub has nothing listening for
// it. The `approved` label (still created by ensureApprovalLabel below) is now a purely cosmetic
// visual marker an operator may apply by hand for their own tracking - it triggers no workflow.
//
// The only way to actually publish this draft is to manually run the "Publish social post" Action
// (workflow_dispatch) with the account/text/media below, `dry_run: false`, and `confirm_live: true`.
// Since the whole issue body must stay JSON.parse-able (trustedApprovalPayload and stale-approvals.mjs
// both parse it in full), these operator instructions live INSIDE the JSON as a leading field rather
// than as prose appended after it. Declared first so it renders at the top of the issue, where a human
// actually looks.
function approvalInstructions(payload) {
  return [
    'TO PUBLISH: manually run the "Publish social post" GitHub Action (workflow_dispatch) with these inputs:',
    `  account: ${payload.account}`,
    `  text: (copy the "text" field below exactly)`,
    payload.mediaUrl ? `  media_url: ${payload.mediaUrl}` : '  media_url: (leave blank; no media on this draft)',
    payload.mediaUrl ? `  media_type: ${payload.mediaType || 'image'}` : '  media_type: (leave as default; no media on this draft)',
    '  dry_run: false',
    '  confirm_live: true',
    'Adding a label, commenting, or closing this issue does NOT publish anything - nothing listens for it.',
    'TO REJECT: close this issue without running the workflow. No action is required to reject.',
    'Only the repository owner, or a user listed in the SNS_COMMAND_ADMINS repository variable, can run that Action.',
    'Everything below is the generated draft and its provenance metadata; do not edit it.'
  ];
}

function markedApprovalPayload(payload, accountId, slotId) {
  return { _howToPublish: approvalInstructions(payload), ...payload, _snsAi: approvalMarker(accountId, slotId) };
}

export function trustedApprovalPayload(issue) {
  if (!issue || issue.pull_request || String(issue.user?.login || '') !== 'github-actions[bot]') return null;
  try {
    const payload = JSON.parse(issue.body || '{}');
    const accountId = payload?.account;
    const slotId = payload?.slotId;
    const marker = payload?._snsAi;
    if (!accountId || !slotId) return null;
    if (issue.title !== approvalTitle(accountId, slotId)) return null;
    if (marker?.kind !== 'sns-ai-approval' || Number(marker?.version) !== 1) return null;
    if (String(marker?.account) !== String(accountId) || String(marker?.slotId) !== String(slotId)) return null;
    return payload;
  } catch {
    return null;
  }
}

function isTrustedApprovalIssue(issue, accountId, slotId) {
  const payload = trustedApprovalPayload(issue);
  return Boolean(payload
    && String(payload.account) === String(accountId)
    && String(payload.slotId) === String(slotId));
}

export async function findApprovalIssue(accountId, slotId) {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  for (let page = 1; page <= 5; page += 1) {
    const issues = await githubRequest(`/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}&sort=created&direction=desc`);
    const match = (issues || []).find((item) => isTrustedApprovalIssue(item, accountId, slotId));
    if (match) return match;
    if (!Array.isArray(issues) || issues.length < 100) break;
  }
  return null;
}

export async function createApprovalIssue(accountId, slotId, payload, { skipLookup = false } = {}) {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  if (!skipLookup) {
    const existing = await findApprovalIssue(accountId, slotId);
    if (existing) return existing;
  }
  await ensureApprovalLabel();
  const marked = markedApprovalPayload(payload, accountId, slotId);
  return githubRequest(`/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: approvalTitle(accountId, slotId),
      body: JSON.stringify(marked, null, 2)
    })
  });
}

export const __test = { approvalTitle, approvalMarker, markedApprovalPayload, isTrustedApprovalIssue, trustedApprovalPayload };
