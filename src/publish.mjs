import { readFile } from 'node:fs/promises';
import { resolveAccount } from './lib/config.mjs';
import { appendHistory, textHash } from './lib/history.mjs';
import { appendAudit } from './lib/audit.mjs';
import { validateDraftText } from './lib/safety.mjs';
import { markSlot } from './lib/state.mjs';
import { beginPublishClaim, finishPublishClaim } from './lib/durable-claim.mjs';
import { assertCircuitClosed, recordCircuitFailure, recordCircuitSuccess } from './ops/circuit.mjs';
import { publishX } from './providers/x.mjs';
import { publishInstagram } from './providers/instagram.mjs';

function parseArgs(argv) { const args = {}; for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token.startsWith('--')) continue; const key = token.slice(2); const next = argv[i + 1]; if (!next || next.startsWith('--')) args[key] = true; else { args[key] = next; i += 1; } } return args; }
function boolValue(value) { return value === true || ['true', '1', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase()); }
async function loadPayload(args) { if (args.file) return JSON.parse(await readFile(args.file, 'utf8')); if (args.json) return JSON.parse(args.json); return { account: args.account, text: args.text || '', mediaUrl: args['media-url'], mediaType: args['media-type'] || 'image', mediaAltText: args['media-alt-text'] || '', dryRun: boolValue(args['dry-run']), source: args.source || 'manual', slotId: args['slot-id'] }; }
function providerPostId(result) { return result?.data?.id || result?.postId || result?.id || result?.mediaId || result?.media_id || result?.creationId || null; }

function validationError(message) {
  const error = new Error(message);
  error.code = 'PUBLISH_VALIDATION';
  error.publishStage = 'preflight';
  return error;
}

function validateProviderPayload(account, common) {
  if (account.platform === 'x') {
    if (!common.text && !common.mediaUrl) throw validationError('X requires text or mediaUrl.');
    if (!common.mediaUrl) {
      for (const key of ['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret']) {
        if (!common.credential?.[key]) throw validationError(`X credential is missing "${key}".`);
      }
    } else if (!common.credential?.oauth2AccessToken && !common.credential?.oauth2RefreshToken) {
      throw validationError('X media publishing requires OAuth2 access or refresh credentials.');
    }
    return;
  }
  if (account.platform === 'instagram') {
    if (!common.mediaUrl) throw validationError('Instagram publishing requires mediaUrl.');
    if (!/^https:\/\//i.test(common.mediaUrl)) throw validationError('Instagram mediaUrl must be a public https:// URL.');
    if (!['image', 'reel'].includes(common.mediaType)) throw validationError('Instagram mediaType must be "image" or "reel".');
    if (!common.credential?.accessToken) throw validationError('Instagram credential is missing "accessToken".');
    if (!common.credential?.igUserId) throw validationError('Instagram credential is missing "igUserId".');
    return;
  }
  throw validationError(`Unsupported platform: ${account.platform}`);
}

function definitiveProviderFailure(error) {
  if (['preflight', 'media', 'media-container', 'media-processing'].includes(error?.publishStage)) return true;
  const status = Number(error?.status);
  if (!Number.isFinite(status)) return false;
  return status >= 400 && status < 500 && ![408, 409, 425].includes(status);
}

async function bestEffort(label, task, warnings) {
  try { return await task(); }
  catch (error) {
    warnings.push({ label, error: String(error?.message || error).slice(0, 500) });
    return null;
  }
}

export async function publish(payload) {
  const account = await resolveAccount(payload.account);
  const text = String(payload.text || '').trim();
  const dryRun = boolValue(payload.dryRun);
  validateDraftText(account, text, { requireNonEmpty: false });
  const common = {
    text,
    mediaUrl: payload.mediaUrl || undefined,
    mediaType: payload.mediaType || 'image',
    mediaAltText: String(payload.mediaAltText || '').slice(0, 1000),
    credential: account.credential,
    dryRun
  };
  validateProviderPayload(account, common);
  if (!dryRun) await assertCircuitClosed(payload.account, 'publish', account.resilience);

  let durable = null;
  if (!dryRun && payload.slotId) {
    durable = await beginPublishClaim(payload.slotId, {
      account: payload.account,
      platform: account.platform,
      source: payload.source || 'manual',
      textHash: textHash(text),
      mediaType: payload.mediaType || null
    });
    if (durable.replay) {
      const replay = {
        platform: account.platform,
        postId: durable.claim?.providerPostId || null,
        idempotentReplay: true,
        durableClaim: durable.claim
      };
      await appendAudit({ account: payload.account, stage: 'publish-idempotent-replay', slotId: payload.slotId, platform: account.platform, providerPostId: replay.postId }).catch(() => {});
      return replay;
    }
  }

  const preWarnings = [];
  await bestEffort('publish-attempt-audit', () => appendAudit({ account: payload.account, stage: dryRun ? 'publish-dry-run' : 'publish-attempt', slotId: payload.slotId || null, platform: account.platform, source: payload.source || 'manual', hasMedia: Boolean(payload.mediaUrl), hasAltText: Boolean(payload.mediaAltText), mediaResolution: payload.mediaResolution || null, sourceCount: (payload.sources || []).length }), preWarnings);

  let result;
  try {
    if (account.platform === 'x') result = await publishX(common);
    else if (account.platform === 'instagram') result = await publishInstagram({ ...common, apiVersion: account.apiVersion || 'v25.0' });
    else throw validationError(`Unsupported platform: ${account.platform}`);
  } catch (error) {
    const failureWarnings = [];
    if (!dryRun && payload.slotId) {
      const claimStatus = definitiveProviderFailure(error) ? 'failed' : 'publish_unknown';
      await bestEffort('durable-claim-failure-state', () => finishPublishClaim(payload.slotId, claimStatus, {
        account: payload.account,
        platform: account.platform,
        source: payload.source || 'manual',
        errorStatus: Number.isFinite(Number(error.status)) ? Number(error.status) : null,
        publishStage: error.publishStage || null,
        lastError: String(error.message || error).slice(0, 500)
      }), failureWarnings);
    }
    if (!dryRun && error.code !== 'CIRCUIT_OPEN') {
      await bestEffort('publish-circuit-failure', () => recordCircuitFailure(payload.account, 'publish', error, account.resilience), failureWarnings);
    }
    await bestEffort('publish-error-audit', () => appendAudit({ account: payload.account, stage: 'publish-error', slotId: payload.slotId || null, platform: account.platform, code: error.code || null, publishStage: error.publishStage || null, error: String(error.message || error).slice(0, 500) }), failureWarnings);
    if (failureWarnings.length) error.bookkeepingWarnings = failureWarnings;
    throw error;
  }

  if (dryRun) return preWarnings.length ? { ...result, bookkeepingWarnings: preWarnings } : result;

  const postId = providerPostId(result);
  const warnings = [...preWarnings];
  if (!postId) warnings.push({ label: 'provider-post-id-missing', error: 'Provider returned success without a post id; automatic metrics may be unavailable.' });
  if (payload.slotId) {
    await bestEffort('durable-claim-published', () => finishPublishClaim(payload.slotId, 'published', {
      account: payload.account,
      platform: account.platform,
      source: payload.source || 'manual',
      providerPostId: postId,
      publishedAt: new Date().toISOString()
    }), warnings);
    await bestEffort('local-slot-published', () => markSlot(payload.slotId, 'published', { account: payload.account, providerPostId: postId }), warnings);
  }

  await bestEffort('history', () => appendHistory({
    account: payload.account, platform: account.platform, status: 'published', source: payload.source || 'manual', slotId: payload.slotId || null,
    text, mediaUrl: payload.mediaUrl || null, mediaType: payload.mediaType || null, mediaAltText: String(payload.mediaAltText || '').slice(0, 1000) || null,
    mediaQa: payload.mediaQa || null, mediaResolution: payload.mediaResolution || null,
    providerPostId: postId, ai: payload.ai || null, features: payload.features || null, rationale: payload.rationale || null,
    predictedScore: payload.predictedScore ?? null, selectionMode: payload.selectionMode || null,
    experiment: payload.experiment || null, sources: (payload.sources || []).slice(0, 30)
  }), warnings);
  await bestEffort('publish-circuit-success', () => recordCircuitSuccess(payload.account, 'publish', account.resilience), warnings);
  await bestEffort('publish-success-audit', () => appendAudit({ account: payload.account, stage: 'publish-success', slotId: payload.slotId || null, platform: account.platform, providerPostId: postId, mediaResolution: payload.mediaResolution || null, mediaQaScore: payload.mediaQa?.score ?? null, experiment: payload.experiment || null, sourceCount: (payload.sources || []).length }), warnings);

  if (warnings.length) {
    await appendAudit({
      account: payload.account,
      stage: 'publish-bookkeeping-warning',
      slotId: payload.slotId || null,
      platform: account.platform,
      providerPostId: postId,
      warnings
    }).catch(() => {});
  }

  return warnings.length ? { ...result, bookkeepingWarnings: warnings } : result;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  try { const payload = await loadPayload(parseArgs(process.argv.slice(2))); const result = await publish(payload); console.log(JSON.stringify({ ok: true, account: payload.account, result }, null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message, status: error.status, code: error.code, bookkeepingWarnings: error.bookkeepingWarnings || [] }, null, 2)); process.exitCode = 1; }
}

export const __test = { providerPostId, definitiveProviderFailure, boolValue, validateProviderPayload };
