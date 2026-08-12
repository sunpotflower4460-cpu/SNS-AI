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

function xUsesMedia(account) {
  return account.platform === 'x' && (account.media?.strategy || 'none') !== 'none';
}

function requiredModels(account) {
  const models = new Set();
  if (['auto', 'approval'].includes(account.mode)) models.add(account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5');
  if (account.research?.webSearch === true || account.research?.trendIntelligence === true) {
    models.add(account.research?.model || account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5');
  }
  const kind = builtInMediaKind(account);
  if (kind === 'image') models.add(account.media?.imageModel || 'gpt-image-1');
  if (kind === 'video') models.add(account.media?.videoModel || 'sora-2');
  if (kind && account.media?.qa?.enabled !== false) models.add(account.media?.qa?.model || account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5');
  return [...models];
}

async function checkOpenAIModel(model) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { model, ok: false, error: 'OPENAI_API_KEY is missing.' };
  try {
    const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { model, ok: false, error: body?.error?.message || `OpenAI model lookup failed with ${response.status}` };
    return { model, ok: body?.id === model, owner: body?.owned_by || null, error: body?.id === model ? null : 'OpenAI returned a different model id.' };
  } catch (error) {
    return { model, ok: false, error: error.message };
  }
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
  if (!selected.length) return { ok: true, state: 'nothing_enabled', accounts: [], openai: { checked: false, models: [] }, mediaHosting: { checked: false } };

  const rows = [];
  let openaiChecked = false;
  let openaiError = null;
  const modelNames = [...new Set(selected.flatMap(([, account]) => requiredModels(account)))];
  let modelChecks = [];
  if (selected.some(([, account]) => needsOpenAI(account))) {
    openaiChecked = true;
    try {
      await openaiRequest('/moderations', { model: 'omni-moderation-latest', input: 'SNS-AI preflight health check' }, { retries: 1 });
    } catch (error) {
      openaiError = error.message;
    }
    modelChecks = await Promise.all(modelNames.map(checkOpenAIModel));
  }

  const builtInMediaNeeded = selected.some(([, account]) => Boolean(builtInMediaKind(account)));
  const mediaHosting = await repositoryHostingCheck(builtInMediaNeeded);

  for (const [id, account] of selected) {
    try {
      const resolved = await resolveAccount(id, { allowDisabled: Boolean(accountFilter) });
      let identity;
      let oauth2Identity = null;
      if (resolved.platform === 'x') {
        identity = await verifyXCredential(resolved.credential);
        if (xUsesMedia(resolved)) {
          oauth2Identity = await verifyXOAuth2Credential(resolved.credential);
          if (String(oauth2Identity.id) !== String(identity.id)) throw new Error('X OAuth1 and OAuth2 credentials resolve to different users.');
          const scopes = String(oauth2Identity.session?.scope || '').split(/\s+/).filter(Boolean);
          const required = ['tweet.write', 'users.read', 'media.write', 'offline.access'];
          if (scopes.length) {
            const missing = required.filter((scope) => !scopes.includes(scope));
            if (missing.length) throw new Error(`X OAuth2 token is missing required scope(s): ${missing.join(', ')}`);
          }
        }
      } else if (resolved.platform === 'instagram') {
        identity = await verifyInstagramCredential({ credential: resolved.credential, apiVersion: resolved.apiVersion || 'v25.0' });
      } else throw new Error(`Unsupported platform: ${resolved.platform}`);
      const kind = builtInMediaKind(account);
      const ownModels = requiredModels(account);
      const ownModelFailures = modelChecks.filter((check) => ownModels.includes(check.model) && !check.ok);
      const mediaReady = !kind || mediaHosting.ok;
      const accountReady = mediaReady && ownModelFailures.length === 0;
      rows.push({
        account: id,
        platform: resolved.platform,
        ok: Boolean(accountReady),
        identity,
        xOAuth2Identity: oauth2Identity,
        enabled: Boolean(account.enabled),
        mode: account.mode || 'pause',
        openaiModels: ownModels.map((model) => modelChecks.find((check) => check.model === model)).filter(Boolean),
        builtInMedia: kind ? {
          configured: true,
          kind,
          hostingReady: Boolean(mediaHosting.ok),
          qaEnabled: account.media?.qa?.enabled !== false,
          note: 'Preflight verifies configured OpenAI model availability and GitHub hosting without spending an image/video generation. The first controlled generation remains the endpoint-specific proof.'
        } : { configured: false }
      });
    } catch (error) {
      rows.push({ account: id, platform: account.platform, ok: false, error: error.message });
    }
  }

  const modelFailure = modelChecks.some((check) => !check.ok);
  const ok = !openaiError && !modelFailure && (!mediaHosting.checked || mediaHosting.ok) && rows.every((row) => row.ok);
  return {
    ok,
    state: ok ? 'ready' : 'blocked',
    openai: { checked: openaiChecked, ok: openaiChecked ? !openaiError && !modelFailure : null, error: openaiError, models: modelChecks },
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
