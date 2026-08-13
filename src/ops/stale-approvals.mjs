import { trustedApprovalPayload } from '../lib/github.mjs';

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
  for (const issue of stale) {
    await api(`/repos/${repo}/issues/${issue.number}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: `⏳ SNS-AI automatically expired this approval after ${normalizedMaxAgeDays} day(s). A fresh draft will be generated on a future slot.` }) });
    await api(`/repos/${repo}/issues/${issue.number}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }) });
    closed.push(issue.number);
  }
  return { skipped: false, maxAgeDays: normalizedMaxAgeDays, closed };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await expireStaleApprovals(), null, 2));