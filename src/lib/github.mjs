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
      description: 'Publish an SNS-AI approval draft',
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

function markedApprovalPayload(payload, accountId, slotId) {
  return { ...payload, _snsAi: approvalMarker(accountId, slotId) };
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
