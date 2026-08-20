import { pathToFileURL } from 'node:url';
import { loadAccounts } from '../lib/config.mjs';
import { loadEngagementPolicy } from '../engagement/policy.mjs';
import { assertPostingProfileCompliance } from './account-control.mjs';

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

export function postingComplianceRow(accountId, account, policy = {}) {
  if (account?.platform !== 'x') {
    return { account: accountId, platform: account?.platform || null, checked: false, ok: true, blockers: [] };
  }
  if (!['auto', 'approval'].includes(String(account?.mode || 'pause'))) {
    return { account: accountId, platform: 'x', checked: false, ok: true, blockers: [] };
  }
  try {
    assertPostingProfileCompliance({ accountId, account, policy });
    return {
      account: accountId,
      platform: 'x',
      checked: true,
      ok: true,
      profileComplianceConfirmed: true,
      blockers: []
    };
  } catch (error) {
    return {
      account: accountId,
      platform: 'x',
      checked: true,
      ok: false,
      profileComplianceConfirmed: false,
      blockers: [{ code: error.code || 'X_POSTING_COMPLIANCE_BLOCKED', message: String(error.message || error) }]
    };
  }
}

export async function runXPostingCompliance({ accountFilter } = {}) {
  const accounts = await loadAccounts();
  if (accountFilter && !accounts[accountFilter]) throw new Error(`Unknown account "${accountFilter}".`);
  const policy = await loadEngagementPolicy();
  const selected = Object.entries(accounts).filter(([id, account]) => accountFilter ? id === accountFilter : account.enabled === true && account.mode !== 'pause');
  if (!selected.length) return { ok: false, state: 'nothing_enabled', accounts: [] };
  const rows = selected.map(([id, account]) => postingComplianceRow(id, account, policy));
  const ok = rows.every((row) => row.ok);
  return { ok, state: ok ? 'ready' : 'blocked', accounts: rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = await runXPostingCompliance({ accountFilter: args.account || undefined });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
    process.exitCode = 1;
  }
}

export const __test = { parseArgs };
