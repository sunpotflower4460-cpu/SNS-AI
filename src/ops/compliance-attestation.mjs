import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';

const ACCOUNTS_FILE = fileURLToPath(new URL('../../config/accounts.json', import.meta.url));
const POLICY_FILE = fileURLToPath(new URL('../../config/engagement-policy.json', import.meta.url));
const ACCOUNT_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const KINDS = new Set(['x-profile', 'x-ai-reply']);

function complianceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(String))];
}

function setMembership(values, accountId, confirmed) {
  const set = new Set(unique(values));
  if (confirmed) set.add(accountId);
  else set.delete(accountId);
  return [...set];
}

export function patchComplianceAttestation({ accountsConfig, policy, accountId, kind, confirmed }) {
  if (!ACCOUNT_ID_RE.test(String(accountId || ''))) throw complianceError('COMPLIANCE_ACCOUNT_ID_INVALID', 'A valid account id is required.');
  if (!KINDS.has(String(kind || ''))) throw complianceError('COMPLIANCE_KIND_INVALID', `Unsupported compliance attestation "${kind}".`);
  if (typeof confirmed !== 'boolean') throw complianceError('COMPLIANCE_VALUE_INVALID', 'confirmed must be boolean.');
  const account = accountsConfig?.accounts?.[accountId];
  if (!account) throw complianceError('COMPLIANCE_ACCOUNT_UNKNOWN', `Unknown account "${accountId}".`);
  if (account.platform !== 'x') throw complianceError('COMPLIANCE_X_ONLY', `Compliance attestation "${kind}" only applies to X accounts.`);

  const nextAccounts = structuredClone(accountsConfig);
  const nextPolicy = structuredClone(policy || {});
  if (kind === 'x-profile') {
    nextPolicy.xAutomationProfileComplianceConfirmedAccounts = setMembership(nextPolicy.xAutomationProfileComplianceConfirmedAccounts, accountId, confirmed);
  } else {
    const required = new Set(unique(nextPolicy.xAiReplyBotApprovalRequiredAccounts));
    if (confirmed && !required.has(accountId)) {
      throw complianceError('COMPLIANCE_AI_REPLY_NOT_REQUIRED', `Account "${accountId}" is not configured as requiring X AI-reply written approval.`);
    }
    nextPolicy.xAiReplyBotApprovalConfirmedAccounts = setMembership(nextPolicy.xAiReplyBotApprovalConfirmedAccounts, accountId, confirmed);
  }

  // Revocation is a safety event, not a bookkeeping-only change. It must immediately remove the
  // unattended engagement gate. Revoking profile compliance also pauses publishing automation.
  if (!confirmed) {
    nextPolicy.liveAccounts = unique(nextPolicy.liveAccounts).filter((id) => id !== accountId);
    const target = nextAccounts.accounts[accountId];
    target.engagement = {
      ...(target.engagement && typeof target.engagement === 'object' && !Array.isArray(target.engagement) ? target.engagement : {}),
      approvalRequired: true
    };
    if (kind === 'x-profile') target.mode = 'pause';
  }

  return { accountsConfig: nextAccounts, policy: nextPolicy, account: accountId, kind, confirmed };
}

export async function setComplianceAttestation({ accountId, kind, confirmed }) {
  const [accountsConfig, policy] = await Promise.all([
    readJson(ACCOUNTS_FILE),
    readJson(POLICY_FILE, {})
  ]);
  const patched = patchComplianceAttestation({ accountsConfig, policy, accountId, kind, confirmed });
  await Promise.all([
    writeJsonAtomic(ACCOUNTS_FILE, patched.accountsConfig),
    writeJsonAtomic(POLICY_FILE, patched.policy)
  ]);
  return {
    account: accountId,
    kind,
    confirmed,
    mode: patched.accountsConfig.accounts[accountId].mode,
    engagementLive: unique(patched.policy.liveAccounts).includes(accountId)
  };
}

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const confirm = Boolean(args.confirm);
    const revoke = Boolean(args.revoke);
    if (confirm === revoke) throw complianceError('COMPLIANCE_ACTION_INVALID', 'Specify exactly one of --confirm or --revoke.');
    const result = await setComplianceAttestation({
      accountId: String(args.account || ''),
      kind: String(args.kind || ''),
      confirmed: confirm
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || null, error: String(error.message || error) }, null, 2));
    process.exitCode = 1;
  }
}

export const __test = { unique, setMembership, parseArgs, ACCOUNT_ID_RE, KINDS };
