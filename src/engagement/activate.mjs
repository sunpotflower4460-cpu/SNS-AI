import { fileURLToPath } from 'node:url';
import { loadAccounts } from '../lib/config.mjs';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { assertEngagementActivationAllowed, loadOperationMode } from '../ops/operation-mode.mjs';
import { validateEngagementPolicy } from './policy.mjs';

const ACCOUNTS_FILE = fileURLToPath(new URL('../../config/accounts.json', import.meta.url));
const POLICY_FILE = fileURLToPath(new URL('../../config/engagement-policy.json', import.meta.url));
const ACCOUNT_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;

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

function unique(values = []) {
  return [...new Set(values.map(String))];
}

export function patchEngagementActivation({ accountsConfig, policy, accountId, active, operationMode = null }) {
  if (!ACCOUNT_ID_RE.test(String(accountId || ''))) throw new Error('A valid account id is required.');
  if (!accountsConfig?.accounts?.[accountId]) throw new Error(`Unknown account "${accountId}".`);
  if (operationMode) assertEngagementActivationAllowed(active, operationMode);

  const allowed = unique(policy?.allowedAccounts || []);
  if (active && !allowed.includes(accountId)) {
    throw new Error(`Account "${accountId}" is not in engagement allowedAccounts.`);
  }

  const nextAccounts = structuredClone(accountsConfig);
  const nextPolicy = structuredClone(policy);
  const target = nextAccounts.accounts[accountId];
  const currentEngagement = target.engagement && typeof target.engagement === 'object' && !Array.isArray(target.engagement)
    ? target.engagement
    : {};

  target.engagement = {
    ...currentEngagement,
    // Global launch posture remains approvalRequired:true. Only a repository that has deliberately
    // left manual-only mode may activate the narrow per-account override for unattended replies.
    approvalRequired: active ? false : true
  };

  const live = new Set(unique(nextPolicy.liveAccounts || []));
  if (active) live.add(accountId);
  else live.delete(accountId);
  nextPolicy.liveAccounts = [...live];

  validateEngagementPolicy(nextPolicy);
  return { accountsConfig: nextAccounts, policy: nextPolicy };
}

export async function setEngagementActivation({
  accountId,
  active,
  loadResolvedAccounts = loadAccounts,
  loadMode = loadOperationMode,
  read = readJson,
  write = writeJsonAtomic,
  accountsFile = ACCOUNTS_FILE,
  policyFile = POLICY_FILE
}) {
  const [resolvedAccounts, operationMode] = await Promise.all([loadResolvedAccounts(), loadMode()]);
  const resolved = resolvedAccounts[accountId];
  if (!resolved) throw new Error(`Unknown account "${accountId}".`);
  assertEngagementActivationAllowed(active, operationMode);
  if (active && (resolved.enabled !== true || resolved.mode === 'pause')) {
    throw new Error(`Account "${accountId}" must be enabled and not paused before engagement activation.`);
  }

  const [accountsConfig, policy] = await Promise.all([
    read(accountsFile),
    read(policyFile)
  ]);
  const patched = patchEngagementActivation({ accountsConfig, policy, accountId, active, operationMode });

  // Both writes happen only in the ephemeral workflow checkout. They are committed together later by
  // the control workflow, so a runner failure cannot persist a one-file half-activation to the repo.
  await write(accountsFile, patched.accountsConfig);
  await write(policyFile, patched.policy);
  return {
    account: accountId,
    active,
    liveAccounts: patched.policy.liveAccounts,
    approvalRequired: patched.accountsConfig.accounts[accountId]?.engagement?.approvalRequired !== false
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const accountId = String(args.account || '');
  const activate = Boolean(args.activate);
  const deactivate = Boolean(args.deactivate);
  if (activate === deactivate) throw new Error('Specify exactly one of --activate or --deactivate.');
  const result = await setEngagementActivation({ accountId, active: activate });
  console.log(JSON.stringify(result, null, 2));
}

export const __test = { ACCOUNT_ID_RE, unique, parseArgs, ACCOUNTS_FILE, POLICY_FILE };
