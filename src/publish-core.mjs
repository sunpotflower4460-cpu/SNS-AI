import { readFile } from 'node:fs/promises';
import { resolveAccount } from './lib/config.mjs';
import { appendHistory, readHistory, textHash } from './lib/history.mjs';
import { appendAudit } from './lib/audit.mjs';
import { checkRateLimits, validateDraftText } from './lib/safety.mjs';
import { markSlot } from './lib/state.mjs';
import { beginPublishClaim, finishPublishClaim, getDurableClaim } from './lib/durable-claim.mjs';
import { assertCircuitClosed, recordCircuitFailure, recordCircuitSuccess } from './ops/circuit.mjs';
import { assertAffiliateTrust, normalizeCommercial } from './monetization/trust-guard.mjs';
import { publishX } from './providers/x.mjs';
import { publishInstagram } from './providers/instagram.mjs';
import { assertProviderMutationAllowed, loadRuntimePolicy } from './ops/manual-only.mjs';

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

function assertClaimProvenance(payload, account, claim) {
  if (!claim) return;
  const needsIdentity = ['published', 'publishing', 'publish_unknown'].includes(String(claim.status || ''));
  if (needsIdentity && (!claim.account || !claim.platform)) {
    throw validationError(`Durable claim missing account/platform provenance for slot "${payload.slotId}".`);
  }
  if (claim.account && String(claim.account) !== String(payload.account)) {
    throw validationError(`Durable claim account mismatch for slot "${payload.slotId}".`);
  }
  if (claim.platform && String(claim.platform) !== String(account.platform)) {
    throw validationError(`Durable claim platform mismatch for slot "${payload.slotId}".`);
  }
}

function publishedHistoryEvidence(payload, account, history) {
  if (!payload.slotId) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index];
    if (row?.status !== 'published' || row?.slotId !== payload.slotId) continue;
    // Missing account/platform on a history row must fail closed. Treating absence as a wildcard
    // lets a corrupt/legacy row authorize cross-account claim repair.
    if (!row.account || String(row.account) !== String(payload.account)) continue;
    if (!row.platform || String(row.platform) !== String(account.platform)) continue;
    return row;
  }
  return null;
}

async function reconcilePublishedReplay(payload, account, claim) {
  assertClaimProvenance(payload, account, claim);

  const history = await readHistory();
  const postId = claim?.providerPostId || null;
  const alreadyRecorded = history.some((row) => row.status === 'published'
    && ((payload.slotId && row.slotId === payload.slotId) || (postId && String(row.providerPostId) === String(postId)))
    && row.account && String(row.account) === String(payload.account)
    && row.platform && String(row.platform) === String(account.platform));
  let recovered = false;
  let recoveryIncomplete = false;

  if (!alreadyRecorded) {
    const suppliedText = String(payload.text || '').trim();
    const storedText = typeof claim?.text === 'string' ? claim.text : '';
    const suppliedMatches = Boolean(claim?.textHash) && textHash(suppliedText) === claim.textHash;
    const canonicalText = storedText || (suppliedMatches ? suppliedText : '');
    recoveryIncomplete = !canonicalText && Boolean(claim?.textHash);
    await appendHistory({
      at: claim?.publishedAt || claim?.updatedAt || new Date().toISOString(),
      account: payload.account,
      platform: account.platform,
      status: 'published',
      source: claim?.source || payload.source || 'manual',
      slotId: payload.slotId || null,
      text: canonicalText,
      textHash: claim?.textHash || textHash(canonicalText),
      mediaUrl: claim?.mediaUrl ?? payload.mediaUrl ?? null,
      mediaType: claim?.mediaType ?? payload.mediaType ?? null,
      mediaAltText: (claim?.mediaAltText ?? String(payload.mediaAltText || '').slice(0, 1000)) || null,
      commercial: claim?.commercial ?? payload.commercial ?? null,
      providerPostId: postId,
      recoveredFromDurableClaim: true,
      recoveryIncomplete
    });
    recovered = true;
  }

  if (payload.slotId) await markSlot(payload.slotId, 'published', { account: payload.account, providerPostId: postId, recoveredFromDurableClaim: recovered });
  await appendAudit({
    account: payload.account,
    stage: 'publish-idempotent-replay',
    slotId: payload.slotId,
    platform: account.platform,
    providerPostId: postId,
    bookkeepingRecovered: recovered,
    recoveryIncomplete
  }).catch(() => {});

  return {
    platform: account.platform,
    postId,
    idempotentReplay: true,
    durableClaim: claim,
    bookkeepingRecovered: recovered,
    recoveryIncomplete
  };
}

async function recoverHandledClaimFromHistory(payload, account, claim) {
  if (!claim || !['publishing', 'publish_unknown'].includes(claim.status) || !payload.slotId) return null;
  assertClaimProvenance(payload, account, claim);
  const history = await readHistory();
  const evidence = publishedHistoryEvidence(payload, account, history);
  if (!evidence) return null;

  const repaired = {
    ...claim,
    status: 'published',
    account: payload.account,
    platform: account.platform,
    source: evidence.source || claim.source || payload.source || 'manual',
    providerPostId: evidence.providerPostId || claim.providerPostId || null,
    publishedAt: evidence.at || claim.publishedAt || claim.updatedAt || new Date().toISOString(),
    text: typeof evidence.text === 'string' ? evidence.text : claim.text,
    textHash: evidence.textHash || claim.textHash || textHash(evidence.text || ''),
    mediaUrl: evidence.mediaUrl ?? claim.mediaUrl ?? payload.mediaUrl ?? null,
    mediaType: evidence.mediaType ?? claim.mediaType ?? payload.mediaType ?? null,
    mediaAltText: evidence.mediaAltText ?? claim.mediaAltText ?? (String(payload.mediaAltText || '').slice(0, 1000) || null),
    commercial: evidence.commercial ?? claim.commercial ?? payload.commercial ?? null,
    recoveredFromHistory: true
  };

  const warnings = [];
  const persisted = await bestEffort('durable-claim-history-repair', () => finishPublishClaim(payload.slotId, 'published', repaired), warnings);
  const result = await reconcilePublishedReplay(payload, account, persisted || repaired);
  if (warnings.length) result.bookkeepingWarnings = warnings;
  result.durableRecoveredFromHistory = true;
  return result;
}

export async function publish(payload) {
  const runtimePolicy = await loadRuntimePolicy();
  const account = await resolveAccount(payload.account);
  const text = String(payload.text || '').trim();
  const dryRun = boolValue(payload.dryRun);
  assertProviderMutationAllowed(runtimePolicy, { dryRun, source: payload.source || 'manual' });
  validateDraftText(account, text, { requireNonEmpty: false });

  const normalizedCommercial = normalizeCommercial(payload.commercial);
  const commercialHistory = normalizedCommercial.kind === 'affiliate' ? await readHistory() : [];
  const commercial = assertAffiliateTrust({
    accountId: payload.account,
    account,
    text,
    commercial: normalizedCommercial,
    history: commercialHistory,
    now: new Date()
  });

  const common = {
    text,
    mediaUrl: payload.mediaUrl || undefined,
    mediaType: payload.mediaType || 'image',
    mediaAltText: String(payload.mediaAltText || '').slice(0, 1000),
    credential: account.credential,
    dryRun,
    paidPartnership: Boolean(commercial.paidPartnership)
  };
  validateProviderPayload(account, common);

  // A published durable claim is the source of truth. Reconcile missing main-branch bookkeeping
  // before applying pause/rate-limit checks because this path performs no new provider mutation.
  if (!dryRun && payload.slotId) {
    const existing = await getDurableClaim(payload.slotId, { fresh: true });
    if (existing?.status === 'published') return reconcilePublishedReplay(payload, account, existing);
    // If the provider succeeded and main history persisted but the durable transition itself failed,
    // the old `publishing`/`publish_unknown` claim must not block forever. Published history is enough
    // evidence to repair the claim without ever calling the provider again.
    const recovered = await recoverHandledClaimFromHistory(payload, account, existing);
    if (recovered) return recovered;
  }

  if (!dryRun && account.mode === 'pause') {
    throw validationError(`Account "${payload.account}" is paused; live publishing is disabled until mode is changed.`);
  }

  if (!dryRun) {
    // Re-check hard posting frequency limits at the final publish boundary. Autopilot checks earlier,
    // but approval/manual/Issue routes and time spent awaiting approval must not bypass these limits.
    const currentHistory = await readHistory();
    const rate = checkRateLimits(payload.account, account, currentHistory, new Date());
    if (!rate.ok) throw validationError(`Publish blocked by posting frequency guard: ${rate.reason}`);
    await assertCircuitClosed(payload.account, 'publish', account.resilience);
  }

  let durable = null;
  if (!dryRun && payload.slotId) {
    durable = await beginPublishClaim(payload.slotId, {
      account: payload.account,
      platform: account.platform,
      source: payload.source || 'manual',
      text,
      textHash: textHash(text),
      mediaUrl: payload.mediaUrl || null,
      mediaType: payload.mediaType || null,
      mediaAltText: String(payload.mediaAltText || '').slice(0, 1000) || null,
      commercial
    });
    if (durable.replay) return reconcilePublishedReplay(payload, account, durable.claim);
  }

  const preWarnings = [];
  await bestEffort('publish-attempt-audit', () => appendAudit({ account: payload.account, stage: dryRun ? 'publish-dry-run' : 'publish-attempt', slotId: payload.slotId || null, platform: account.platform, source: payload.source || 'manual', hasMedia: Boolean(payload.mediaUrl), hasAltText: Boolean(payload.mediaAltText), mediaResolution: payload.mediaResolution || null, sourceCount: (payload.sources || []).length, commercialKind: commercial.kind, paidPartnership: Boolean(commercial.paidPartnership) }), preWarnings);

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
    await bestEffort('publish-error-audit', () => appendAudit({ account: payload.account, stage: 'publish-error', slotId: payload.slotId || null, platform: account.platform, code: error.code || null, publishStage: error.publishStage || null, error: String(error.message || error).slice(0, 500), commercialKind: commercial.kind }), failureWarnings);
    if (failureWarnings.length) error.bookkeepingWarnings = failureWarnings;
    throw error;
  }

  if (dryRun) return preWarnings.length ? { ...result, commercial, bookkeepingWarnings: preWarnings } : { ...result, commercial };

  const postId = providerPostId(result);
  const warnings = [...preWarnings];
  if (!postId) warnings.push({ label: 'provider-post-id-missing', error: 'Provider returned success without a post id; automatic metrics may be unavailable.' });
  const publishedAt = new Date().toISOString();
  if (payload.slotId) {
    await bestEffort('durable-claim-published', () => finishPublishClaim(payload.slotId, 'published', {
      account: payload.account,
      platform: account.platform,
      source: payload.source || 'manual',
      providerPostId: postId,
      publishedAt
    }), warnings);
    await bestEffort('local-slot-published', () => markSlot(payload.slotId, 'published', { account: payload.account, providerPostId: postId }), warnings);
  }

  await bestEffort('history', () => appendHistory({
    at: publishedAt,
    account: payload.account, platform: account.platform, status: 'published', source: payload.source || 'manual', slotId: payload.slotId || null,
    text, mediaUrl: payload.mediaUrl || null, mediaType: payload.mediaType || null, mediaAltText: String(payload.mediaAltText || '').slice(0, 1000) || null,
    mediaQa: payload.mediaQa || null, mediaResolution: payload.mediaResolution || null, commercial,
    providerPostId: postId, ai: payload.ai || null, features: payload.features || null, rationale: payload.rationale || null,
    predictedScore: payload.predictedScore ?? null, selectionMode: payload.selectionMode || null,
    experiment: payload.experiment || null, sources: (payload.sources || []).slice(0, 30)
  }), warnings);
  await bestEffort('publish-circuit-success', () => recordCircuitSuccess(payload.account, 'publish', account.resilience), warnings);
  await bestEffort('publish-success-audit', () => appendAudit({ account: payload.account, stage: 'publish-success', slotId: payload.slotId || null, platform: account.platform, providerPostId: postId, mediaResolution: payload.mediaResolution || null, mediaQaScore: payload.mediaQa?.score ?? null, experiment: payload.experiment || null, sourceCount: (payload.sources || []).length, commercialKind: commercial.kind, paidPartnership: Boolean(commercial.paidPartnership) }), warnings);

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

  return warnings.length ? { ...result, commercial, bookkeepingWarnings: warnings } : { ...result, commercial };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  try { const payload = await loadPayload(parseArgs(process.argv.slice(2))); const result = await publish(payload); console.log(JSON.stringify({ ok: true, account: payload.account, result }, null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message, status: error.status, code: error.code, bookkeepingWarnings: error.bookkeepingWarnings || [] }, null, 2)); process.exitCode = 1; }
}

export const __test = { providerPostId, definitiveProviderFailure, boolValue, validateProviderPayload, assertClaimProvenance, publishedHistoryEvidence, reconcilePublishedReplay, recoverHandledClaimFromHistory };
