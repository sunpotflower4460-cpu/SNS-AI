import { loadAccounts, resolveAccount } from '../lib/config.mjs';
import { openaiRequest } from '../lib/openai.mjs';
import { verifyXCredential, verifyXOAuth2Credential } from '../providers/x.mjs';
import { verifyInstagramCredential } from '../providers/instagram.mjs';
import { effectiveEngagementPolicy, loadEngagementPolicy } from '../engagement/policy.mjs';
import {
  allowedEngagementAccount,
  assertXEngagementCredential,
  liveEngagementAccount,
  requiredXEngagementScopes
} from '../engagement/readiness.mjs';

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

function engagementConfigured(globalPolicy, accountId, account) {
  const policy = effectiveEngagementPolicy(globalPolicy, account);
  return globalPolicy?.enabled === true
    && allowedEngagementAccount(policy, accountId)
    && (policy.autoReply === true || policy.autoDmReply === true);
}

function requiredModels(account) {
  const models = new Set();
  if (['auto', 'approval'].includes(account.mode)) models.add(account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5');
  if (account.research?.webSearch === true || account.research?.trendIntelligence === true) {
    models.add(account.research?.model || account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5');
  }
  const kind = builtInMediaKind(account);
  if (kind === 'image') models.add(account.media?.imageModel || 'gpt-image-2');
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

const MEDIA_RELEASE_TAG = 'sns-ai-media';

async function mediaReleaseProbe(token, repo) {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(MEDIA_RELEASE_TAG)}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }
    });
    if (response.status === 404) {
      return { exists: false, writeVerified: false, note: `Release "${MEDIA_RELEASE_TAG}" does not exist yet; the first media publish creates it. Upload permission is unproven until then.` };
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { exists: null, writeVerified: false, note: body?.message || `Media release lookup failed with ${response.status}` };
    }
    return { exists: true, writeVerified: false, note: `Release "${MEDIA_RELEASE_TAG}" exists and is readable; asset upload permission is still only proven by a real media publish.` };
  } catch (error) {
    return { exists: null, writeVerified: false, note: error.message };
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
    const release = body.private ? null : await mediaReleaseProbe(token, repo);
    return {
      checked: true,
      ok: body.private === false,
      private: Boolean(body.private),
      release,
      error: body.private ? 'Built-in GitHub Release media hosting needs a public repository. Configure media.endpoint/CDN if this repository becomes private.' : null
    };
  } catch (error) {
    return { checked: true, ok: false, private: null, error: error.message };
  }
}

async function approvalChannelCheck(required) {
  if (!required) return { checked: false, ok: null, error: null };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return { checked: true, ok: false, error: 'GitHub runtime metadata/token is unavailable for the approval channel check.' };
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  try {
    const repoResponse = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    const repoBody = await repoResponse.json().catch(() => ({}));
    if (!repoResponse.ok) return { checked: true, ok: false, error: repoBody?.message || `Repository lookup failed with ${repoResponse.status}` };
    if (repoBody.has_issues === false) {
      return { checked: true, ok: false, issuesEnabled: false, labelExists: null, error: 'Issues are disabled on this repository, so approval drafts can never be created. Enable Issues in repository settings.' };
    }
    const labelResponse = await fetch(`https://api.github.com/repos/${repo}/labels/approved`, { headers });
    if (labelResponse.status !== 200 && labelResponse.status !== 404) {
      const labelBody = await labelResponse.json().catch(() => ({}));
      return { checked: true, ok: false, issuesEnabled: true, labelExists: null, error: labelBody?.message || `Label lookup failed with ${labelResponse.status}` };
    }
    const labelExists = labelResponse.status === 200;
    return {
      checked: true,
      ok: true,
      issuesEnabled: true,
      labelExists,
      note: labelExists
        ? 'Adding the "approved" label to a generated approval issue is what publishes it.'
        : 'The "approved" label does not exist yet; the first approval run creates it (this needs `issues: write`).',
      error: null
    };
  } catch (error) {
    return { checked: true, ok: false, error: error.message };
  }
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };
}

async function durableStateBranchCheck() {
  const branch = process.env.SNS_DURABLE_STATE_BRANCH || 'sns-ai-state';
  const required = String(process.env.SNS_REQUIRE_DURABLE_STATE || '').toLowerCase() === 'true';
  if (!required) {
    return {
      checked: false,
      ok: null,
      branch,
      writeVerified: false,
      error: null,
      note: 'Durable state branch verification is deferred. The GitHub Live Preflight workflow enables the mandatory write probe before auto mode.'
    };
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return { checked: true, ok: false, branch, writeVerified: false, error: 'GitHub runtime metadata/token is unavailable for durable state branch check.' };
  const headers = githubHeaders(token);
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`, { headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { checked: true, ok: false, branch, writeVerified: false, error: body?.message || `Durable state branch check failed with ${response.status}` };
    if (body?.name !== branch) return { checked: true, ok: false, branch, writeVerified: false, error: 'GitHub returned a different durable state branch.' };

    const probeId = `${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}-${Date.now()}`;
    const probePath = `data/durable-claims/.preflight-${probeId}.json`;
    const createResponse = await fetch(`https://api.github.com/repos/${repo}/contents/${probePath}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: 'chore: verify SNS durable state write access',
        content: Buffer.from(`${JSON.stringify({ kind: 'sns-ai-preflight-probe', at: new Date().toISOString() })}\n`, 'utf8').toString('base64'),
        branch
      })
    });
    const created = await createResponse.json().catch(() => ({}));
    if (!createResponse.ok || !created?.content?.sha) {
      return { checked: true, ok: false, branch, writeVerified: false, error: created?.message || `Durable state write probe failed with ${createResponse.status}` };
    }

    const deleteResponse = await fetch(`https://api.github.com/repos/${repo}/contents/${probePath}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        message: 'chore: remove SNS durable state preflight probe',
        sha: created.content.sha,
        branch
      })
    });
    const deleted = await deleteResponse.json().catch(() => ({}));
    if (!deleteResponse.ok) {
      return { checked: true, ok: false, branch, writeVerified: true, cleanupFailed: true, error: deleted?.message || `Durable state probe cleanup failed with ${deleteResponse.status}` };
    }
    return { checked: true, ok: true, branch, writeVerified: true, error: null };
  } catch (error) {
    return { checked: true, ok: false, branch, writeVerified: false, error: error.message };
  }
}

export async function runLivePreflight({ accountFilter, includeEngagement = false } = {}) {
  const accounts = await loadAccounts();
  const globalEngagementPolicy = await loadEngagementPolicy();
  const selected = Object.entries(accounts).filter(([id, account]) => accountFilter ? id === accountFilter : account.enabled === true && account.mode !== 'pause');
  if (accountFilter && !accounts[accountFilter]) throw new Error(`Unknown account "${accountFilter}".`);
  if (!selected.length) return { ok: false, state: 'nothing_enabled', accounts: [], openai: { checked: false, models: [] }, mediaHosting: { checked: false }, durableState: { checked: false } };

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
  const approvalChannel = await approvalChannelCheck(selected.some(([, account]) => account.mode === 'approval'));
  const durableState = await durableStateBranchCheck();
  const durableReady = durableState.checked ? durableState.ok === true : true;
  const approvalReady = approvalChannel.checked ? approvalChannel.ok === true : true;

  for (const [id, account] of selected) {
    try {
      const resolved = await resolveAccount(id, { allowDisabled: Boolean(accountFilter) });
      const accountEngagementPolicy = effectiveEngagementPolicy(globalEngagementPolicy, resolved);
      const engagementIsConfigured = engagementConfigured(globalEngagementPolicy, id, resolved);
      const engagementIsLive = engagementIsConfigured && liveEngagementAccount(accountEngagementPolicy, id);
      const checkEngagementCredential = includeEngagement && engagementIsConfigured;
      let identity;
      let oauth2Identity = null;
      let engagementCredential = null;
      if (resolved.platform === 'x') {
        identity = await verifyXCredential(resolved.credential);
        if (xUsesMedia(resolved) || checkEngagementCredential) {
          oauth2Identity = await verifyXOAuth2Credential(resolved.credential);
          if (String(oauth2Identity.id) !== String(identity.id)) throw new Error('X OAuth1 and OAuth2 credentials resolve to different users.');
        }
        if (xUsesMedia(resolved)) {
          const scopes = String(oauth2Identity?.session?.scope || '').split(/\s+/).filter(Boolean);
          const requiredScopes = ['tweet.write', 'users.read', 'media.write', 'offline.access'];
          if (scopes.length) {
            const missing = requiredScopes.filter((scope) => !scopes.includes(scope));
            if (missing.length) throw new Error(`X OAuth2 token is missing required scope(s): ${missing.join(', ')}`);
          }
        }
        if (checkEngagementCredential) {
          engagementCredential = assertXEngagementCredential(oauth2Identity, accountEngagementPolicy);
        }
      } else if (resolved.platform === 'instagram') {
        identity = await verifyInstagramCredential({ credential: resolved.credential, apiVersion: resolved.apiVersion || 'v25.0' });
        if (identity.publishAccess?.ok === false) {
          throw new Error(`Instagram publish-access probe failed: ${identity.publishAccess.error || 'unknown error'}`);
        }
      } else throw new Error(`Unsupported platform: ${resolved.platform}`);
      const kind = builtInMediaKind(account);
      const ownModels = requiredModels(account);
      const ownModelFailures = modelChecks.filter((check) => ownModels.includes(check.model) && !check.ok);
      const mediaReady = !kind || mediaHosting.ok;
      const accountReady = durableReady && mediaReady && ownModelFailures.length === 0 && (account.mode !== 'approval' || approvalReady);
      rows.push({
        account: id,
        platform: resolved.platform,
        ok: Boolean(accountReady),
        identity,
        xOAuth2Identity: oauth2Identity,
        enabled: Boolean(account.enabled),
        mode: account.mode || 'pause',
        engagement: engagementIsConfigured ? {
          configured: true,
          checked: Boolean(includeEngagement),
          live: engagementIsLive,
          credentialReady: checkEngagementCredential && resolved.platform === 'x' ? engagementCredential?.ok === true : null,
          requiredScopes: checkEngagementCredential && resolved.platform === 'x' ? requiredXEngagementScopes(accountEngagementPolicy) : [],
          note: includeEngagement
            ? (engagementIsLive ? 'Inbound engagement is LIVE for this account.' : 'Engagement credentials were checked for activation/readiness.')
            : 'Engagement checks are intentionally deferred during publish-only preflight; run with --engagement before activating inbound automation.'
        } : { configured: false, checked: false, live: false, credentialReady: null, requiredScopes: [] },
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
  const ok = durableReady && approvalReady && !openaiError && !modelFailure && (!mediaHosting.checked || mediaHosting.ok) && rows.every((row) => row.ok);
  return {
    ok,
    state: ok ? 'ready' : 'blocked',
    mode: includeEngagement ? 'publish+engagement' : 'publish',
    openai: { checked: openaiChecked, ok: openaiChecked ? !openaiError && !modelFailure : null, error: openaiError, models: modelChecks },
    mediaHosting,
    approvalChannel,
    durableState,
    accounts: rows
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = await runLivePreflight({ accountFilter: args.account || undefined, includeEngagement: args.engagement === true });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

export const __test = { durableStateBranchCheck, engagementConfigured };
