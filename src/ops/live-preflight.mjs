import { loadAccounts, resolveAccount } from '../lib/config.mjs';
import { openaiRequest } from '../lib/openai.mjs';
import { verifyXCredential, verifyXOAuth2Credential } from '../providers/x.mjs';
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

function builtInMediaKind(account) {
  const media = account.media || {};
  if (!['auto', 'generate'].includes(media.strategy || 'none')) return null;
  if (/^https:\/\//i.test(media.endpoint || '')) return null;
  const type = media.type || 'image';
  if (type === 'reel' && media.internalVideoGeneration !== false) return 'video';
  if (type === 'image' && media.internalImageGeneration !== false) return 'image';
  return null;
}

function needsOpenAI(account) {
  return ['auto', 'approval'].includes(account.mode)
    || account.research?.webSearch === true
    || account.research?.trendIntelligence === true
    || Boolean(builtInMediaKind(account));
}

async function repositoryHostingCheck(required) {
  if (!required) return { checked: false, ok: null, private: null, error: null };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return { checked: true, ok: false, private: null, error: 'GitHub runtime metadata/token is unavailable for built-in media hosting check.' };
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { checked: true, ok: false, private: null, error: body?.message || `GitHub repository check failed with ${response.status}` };
    return {
      checked: true,
      ok: body.private === false,
      private: Boolean(body.private),
      error: body.private ? 'Built-in GitHub Release media hosting needs a public repository. Configure media.endpoint/CDN if this repository becomes private.' : null
    };
  } catch (error) {
    return { checked: true, ok: false, private: null, error: error.message };
  }
}

export async function runLivePreflight({ accountFilter } = {}) {
  const accounts = await loadAccounts();
  const selected = Object.entries(accounts).filter(([id, account]) => accountFilter ? id === accountFilter : account.enabled === true && account.mode !== 'pause');
  if (accountFilter && !accounts[accountFilter]) throw new Error(`Unknown account "${accountFilter}".`);
  if (!selected.length) return { ok: true, state: 'nothing_enabled', accounts: [], openai: { checked: false }, mediaHosting: { checked: false } };

  const rows = [];
  let openaiChecked = false;
  let openaiError = null;
  if (selected.some(([, account]) => needsOpenAI(account))) {
    openaiChecked = true;
    try {
      await openaiRequest('/moderations', { model: 'omni-moderation-latest', input: 'SNS-AI preflight health check' }, { retries: 1 });
    } catch (error) {
      openaiError = error.message;
    }
  }

  const builtInMediaNeeded = selected.some(([, account]) => Boolean(builtInMediaKind(account)));
  const mediaHosting = await repositoryHostingCheck(builtInMediaNeeded);

  for (const [id, account] of selected) {
    try {
      const resolved = await resolveAccount(id, { allowDisabled: Boolean(accountFilter) });
      let identity;
      let videoIdentity = null;
      if (resolved.platform === 'x') {
        identity = await verifyXCredential(resolved.credential);
        if ((resolved.media?.type || 'image') === 'reel' && resolved.media?.strategy !== 'none') {
          videoIdentity = await verifyXOAuth2Credential(resolved.credential);
          if (String(videoIdentity.id) !== String(identity.id)) throw new Error('X OAuth1 and OAuth2 credentials resolve to different users.');
        }
      } else if (resolved.platform === 'instagram') {
        identity = await verifyInstagramCredential({ credential: resolved.credential, apiVersion: resolved.apiVersion || 'v23.0' });
      } else throw new Error(`Unsupported platform: ${resolved.platform}`);
      const kind = builtInMediaKind(account);
      const mediaReady = !kind || mediaHosting.ok;
      rows.push({
        account: id,
        platform: resolved.platform,
        ok: Boolean(mediaReady),
        identity,
        xVideoOAuth2Identity: videoIdentity,
        enabled: Boolean(account.enabled),
        mode: account.mode || 'pause',
        builtInMedia: kind ? {
          configured: true,
          kind,
          hostingReady: Boolean(mediaHosting.ok),
          qaEnabled: account.media?.qa?.enabled !== false,
          note: `${kind === 'video' ? 'Video' : 'Image'} model access itself is confirmed on the first real generation; preflight deliberately does not spend a generation.`
        } : { configured: false }
      });
    } catch (error) {
      rows.push({ account: id, platform: account.platform, ok: false, error: error.message });
    }
  }

  const ok = !openaiError && (!mediaHosting.checked || mediaHosting.ok) && rows.every((row) => row.ok);
  return {
    ok,
    state: ok ? 'ready' : 'blocked',
    openai: { checked: openaiChecked, ok: openaiChecked ? !openaiError : null, error: openaiError },
    mediaHosting,
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
