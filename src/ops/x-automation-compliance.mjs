import { loadAccounts } from '../lib/config.mjs';
import { allowedEngagementAccount, xAiReplyApprovalReady, xAiReplyApprovalRequired } from '../engagement/readiness.mjs';
import { effectiveEngagementPolicy, loadEngagementPolicy } from '../engagement/policy.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function confirmedProfileCompliance(policy = {}, accountId) {
  const confirmed = new Set(Array.isArray(policy.xAutomationProfileComplianceConfirmedAccounts)
    ? policy.xAutomationProfileComplianceConfirmedAccounts.map(String)
    : []);
  return confirmed.has(String(accountId));
}

function engagementConfigured(policy = {}, accountId) {
  return policy.enabled === true
    && allowedEngagementAccount(policy, accountId)
    && (policy.autoReply === true || policy.autoDmReply === true);
}

function automationIntended(account = {}, policy = {}, accountId) {
  return ['auto', 'approval'].includes(String(account.mode || 'pause')) || engagementConfigured(policy, accountId);
}

export function xAutomationComplianceRow(accountId, account, globalPolicy) {
  if (account.platform !== 'x') return { account: accountId, platform: account.platform, checked: false, ok: true, blockers: [] };
  const policy = effectiveEngagementPolicy(globalPolicy, account);
  if (!automationIntended(account, policy, accountId)) {
    return { account: accountId, platform: 'x', checked: false, ok: true, blockers: [] };
  }

  const blockers = [];
  if (!confirmedProfileCompliance(policy, accountId)) {
    blockers.push({
      code: 'X_AUTOMATION_PROFILE_COMPLIANCE_UNCONFIRMED',
      message: 'Confirm the X Automated profile label, bot/operator disclosure in bio, and linkage to a human-managed account, then record this account in xAutomationProfileComplianceConfirmedAccounts.'
    });
  }
  if (policy.autoReply === true && xAiReplyApprovalRequired(policy, accountId) && !xAiReplyApprovalReady(policy, accountId)) {
    blockers.push({
      code: 'X_AI_REPLY_APPROVAL_UNCONFIRMED',
      message: 'Obtain X prior written and explicit approval for the AI-powered automated public reply bot, then record this account in xAiReplyBotApprovalConfirmedAccounts.'
    });
  }

  return {
    account: accountId,
    platform: 'x',
    checked: true,
    ok: blockers.length === 0,
    profileComplianceConfirmed: confirmedProfileCompliance(policy, accountId),
    aiReplyApprovalRequired: policy.autoReply === true && xAiReplyApprovalRequired(policy, accountId),
    aiReplyApprovalConfirmed: xAiReplyApprovalReady(policy, accountId),
    blockers
  };
}

export async function runXAutomationCompliance({ accountFilter } = {}) {
  const accounts = await loadAccounts();
  if (accountFilter && !accounts[accountFilter]) throw new Error(`Unknown account "${accountFilter}".`);
  const globalPolicy = await loadEngagementPolicy();
  const selected = Object.entries(accounts).filter(([id, account]) => accountFilter ? id === accountFilter : account.enabled === true && account.mode !== 'pause');
  if (!selected.length) return { ok: false, state: 'nothing_enabled', accounts: [] };
  const rows = selected.map(([id, account]) => xAutomationComplianceRow(id, account, globalPolicy));
  const ok = rows.every((row) => row.ok);
  return { ok, state: ok ? 'ready' : 'blocked', accounts: rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = await runXAutomationCompliance({ accountFilter: args.account || undefined });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
    process.exitCode = 1;
  }
}

export const __test = { confirmedProfileCompliance, engagementConfigured, automationIntended };
