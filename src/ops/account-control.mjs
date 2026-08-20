import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { readHistory } from '../lib/history.mjs';
import { readMetricSnapshots } from '../analytics/store.mjs';

const ACCOUNTS_FILE = fileURLToPath(new URL('../../config/accounts.json', import.meta.url));
const ENGAGEMENT_POLICY_FILE = fileURLToPath(new URL('../../config/engagement-policy.json', import.meta.url));
const ACCOUNT_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const TARGETS = new Set(['approval', 'auto', 'pause', 'disabled']);

function controlError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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

function profileComplianceConfirmed(policy = {}, accountId) {
  return new Set(Array.isArray(policy.xAutomationProfileComplianceConfirmedAccounts)
    ? policy.xAutomationProfileComplianceConfirmedAccounts.map(String)
    : []).has(String(accountId));
}

export function assertPostingProfileCompliance({ accountId, account, policy }) {
  if (account?.platform !== 'x') return true;
  if (!profileComplianceConfirmed(policy, accountId)) {
    throw controlError(
      'ACCOUNT_X_PROFILE_COMPLIANCE_REQUIRED',
      `Account "${accountId}" cannot enter a live publishing mode until X automated-profile compliance has been completed and recorded.`
    );
  }
  return true;
}

export function autoPromotionEvidence({ accountId, account, history = [], metrics = [] }) {
  if (account?.enabled !== true || account?.mode !== 'approval') {
    throw controlError('ACCOUNT_AUTO_REQUIRES_APPROVAL_MODE', `Account "${accountId}" must already be enabled in approval mode before promotion to auto.`);
  }
  const published = history.filter((row) => row?.account === accountId && row?.status === 'published' && row?.providerPostId);
  if (!published.length) {
    throw controlError('ACCOUNT_AUTO_PUBLISHED_PROOF_REQUIRED', `Account "${accountId}" needs at least one successful controlled published post before auto mode.`);
  }
  const publishedIds = new Set(published.map((row) => String(row.providerPostId)));
  const matchingMetrics = metrics.filter((row) => row?.account === accountId && publishedIds.has(String(row?.providerPostId || '')));
  if (!matchingMetrics.length) {
    throw controlError('ACCOUNT_AUTO_METRICS_PROOF_REQUIRED', `Account "${accountId}" needs at least one metrics snapshot for a controlled published post before auto mode.`);
  }
  return {
    publishedCount: published.length,
    metricSnapshotCount: matchingMetrics.length,
    latestProviderPostId: String(published.at(-1).providerPostId)
  };
}

export function patchAccountLifecycle({ accountsConfig, policy = {}, accountId, target, history = [], metrics = [] }) {
  if (!ACCOUNT_ID_RE.test(String(accountId || ''))) throw controlError('ACCOUNT_ID_INVALID', 'A valid account id is required.');
  if (!TARGETS.has(String(target || ''))) throw controlError('ACCOUNT_TARGET_INVALID', `Unsupported account lifecycle target "${target}".`);
  const current = accountsConfig?.accounts?.[accountId];
  if (!current) throw controlError('ACCOUNT_UNKNOWN', `Unknown account "${accountId}".`);

  if (target === 'approval' || target === 'auto') assertPostingProfileCompliance({ accountId, account: current, policy });
  let evidence = null;
  if (target === 'auto') evidence = autoPromotionEvidence({ accountId, account: current, history, metrics });

  const next = structuredClone(accountsConfig);
  const account = next.accounts[accountId];
  if (target === 'approval') {
    account.enabled = true;
    account.mode = 'approval';
  } else if (target === 'auto') {
    account.enabled = true;
    account.mode = 'auto';
  } else if (target === 'pause') {
    account.mode = 'pause';
  } else if (target === 'disabled') {
    account.enabled = false;
    account.mode = 'pause';
  }
  return { accountsConfig: next, account: accountId, target, evidence };
}

export async function setAccountLifecycle({ accountId, target }) {
  const [accountsConfig, policy, history, metrics] = await Promise.all([
    readJson(ACCOUNTS_FILE),
    readJson(ENGAGEMENT_POLICY_FILE, {}),
    readHistory(),
    readMetricSnapshots()
  ]);
  const patched = patchAccountLifecycle({ accountsConfig, policy, accountId, target, history, metrics });
  await writeJsonAtomic(ACCOUNTS_FILE, patched.accountsConfig);
  return {
    account: accountId,
    target,
    enabled: patched.accountsConfig.accounts[accountId].enabled === true,
    mode: patched.accountsConfig.accounts[accountId].mode,
    evidence: patched.evidence
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await setAccountLifecycle({ accountId: String(args.account || ''), target: String(args.target || '') });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || null, error: String(error.message || error) }, null, 2));
    process.exitCode = 1;
  }
}

export const __test = { parseArgs, profileComplianceConfirmed, ACCOUNT_ID_RE, TARGETS };
