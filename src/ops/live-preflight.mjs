import { loadAccounts, resolveAccount } from '../lib/config.mjs';
import { openaiRequest } from '../lib/openai.mjs';
import { verifyXCredential } from '../providers/x.mjs';
import { verifyInstagramCredential } from '../providers/instagram.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

function needsOpenAI(account) {
  return ['auto', 'approval'].includes(account.mode)
    || account.research?.webSearch === true
    || account.research?.trendIntelligence === true;
}

export async function runLivePreflight({ accountFilter } = {}) {
  const accounts = await loadAccounts();
  const selected = Object.entries(accounts).filter(([id, account]) => {
    if (accountFilter) return id === accountFilter;
    return account.enabled === true && account.mode !== 'pause';
  });
  if (accountFilter && !accounts[accountFilter]) throw new Error(`Unknown account "${accountFilter}".`);
  if (!selected.length) return { ok: true, state: 'nothing_enabled', accounts: [], openai: { checked: false } };

  const rows = [];
  let openaiChecked = false;
  let openaiError = null;
  if (selected.some(([, account]) => needsOpenAI(account))) {
    openaiChecked = true;
    try {
      await openaiRequest('/moderations', { model: 'omni-moderation-latest', input: 'SNS-AI preflight health check' });
    } catch (error) {
      openaiError = error.message;
    }
  }

  for (const [id, account] of selected) {
    try {
      const resolved = await resolveAccount(id);
      let identity;
      if (resolved.platform === 'x') identity = await verifyXCredential(resolved.credential);
      else if (resolved.platform === 'instagram') identity = await verifyInstagramCredential({ credential: resolved.credential, apiVersion: resolved.apiVersion || 'v23.0' });
      else throw new Error(`Unsupported platform: ${resolved.platform}`);
      rows.push({ account: id, platform: resolved.platform, ok: true, identity });
    } catch (error) {
      rows.push({ account: id, platform: account.platform, ok: false, error: error.message });
    }
  }

  const ok = !openaiError && rows.every((row) => row.ok);
  return {
    ok,
    state: ok ? 'ready' : 'blocked',
    openai: { checked: openaiChecked, ok: openaiChecked ? !openaiError : null, error: openaiError },
    accounts: rows
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = await runLivePreflight({ accountFilter: args.account || undefined });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
