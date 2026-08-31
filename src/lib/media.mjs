import { consumeUsage } from '../ops/budget.mjs';
import { generateAndHostImageDetailed } from '../media/openai-image.mjs';
import { generateAndHostVideoDetailed } from '../media/openai-video.mjs';
import { reviewVisualUrl } from '../media/qa.mjs';
import { huntMedia } from '../media/hunter.mjs';
import { assertPublicHttpsTarget, assertPublicHttpsUrl, fetchPublicHttps } from './http.mjs';
import { assertOperationAllowed } from '../budget/governor.mjs';

function hashString(value) { let hash = 2166136261; for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } return hash >>> 0; }
function poolUrl(media, slotId) { const urls = (media.urls || media.libraryUrls || []).filter(Boolean); return urls.length ? urls[hashString(slotId) % urls.length] : null; }
const dryRunUrl = (decision, mediaType = 'image') => `https://dry-run.invalid/${decision || 'media'}.${mediaType === 'reel' ? 'mp4' : 'png'}`;

async function requestMediaEndpoint(accountId, account, slotId, draft, mode) {
  const endpoint = account.media?.endpoint;
  if (!endpoint || !/^https:\/\//i.test(endpoint)) throw new Error('Media generation/search requires an HTTPS media.endpoint.');
  const endpointUrl = await assertPublicHttpsTarget(endpoint, 'media.endpoint');
  await consumeUsage(accountId, account, 'media', { mode, slotId });
  const headers = { 'Content-Type': 'application/json' }; if (process.env.MEDIA_SERVICE_TOKEN) headers.Authorization = `Bearer ${process.env.MEDIA_SERVICE_TOKEN}`;
  const response = await fetchPublicHttps(endpointUrl, {
    method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      account: accountId, platform: account.platform, slotId, mode, mediaType: account.media?.type || 'image',
      prompt: draft?.mediaPrompt || '', text: draft?.text || '', features: draft?.features || {}, rationale: draft?.rationale || ''
    })
  }, 'media.endpoint');
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error || `Media endpoint failed with HTTP ${response.status}`);
  const returned = body.url || body.mediaUrl;
  if (!/^https:\/\//i.test(returned || '')) throw new Error('Media endpoint must return { "url": "https://..." }.');
  const url = assertPublicHttpsUrl(returned, 'Media endpoint URL').toString();
  // Preserve endpoint-provided QA for compatibility/audit, but never use it to bypass SNS-AI's own
  // hard safety review. endpointQa makes that provenance explicit.
  const endpointQa = body.qa || null;
  return { url, altText: String(body.altText || '').slice(0, 1000), qa: endpointQa, endpointQa };
}

async function generated(accountId, account, slotId, draft, dryRun = false, now = new Date(), budgetState = 'healthy') {
  const mediaType = account.media?.type || 'image';
  if (account.media?.endpoint) return dryRun
    ? { url: dryRunUrl('generate', mediaType), decision: 'generate', source: 'dry-run-endpoint', altText: '', qa: null }
    : { ...(await requestMediaEndpoint(accountId, account, slotId, draft, 'generate')), decision: 'generate', source: 'endpoint' };
  if (mediaType === 'reel' && account.media?.internalVideoGeneration !== false) {
    if (!dryRun) assertOperationAllowed({ operation: 'video-generation', state: budgetState, costType: 'estimated' });
    return dryRun
      ? { url: dryRunUrl('generate', 'reel'), decision: 'generate', source: 'dry-run-openai-video', altText: '', qa: null }
      : { ...(await generateAndHostVideoDetailed(accountId, account, slotId, draft, { now })), decision: 'generate', source: 'openai-video' };
  }
  if (mediaType === 'image' && account.media?.internalImageGeneration !== false) {
    if (!dryRun) assertOperationAllowed({ operation: 'image-generation', state: budgetState, costType: 'estimated' });
    return dryRun
      ? { url: dryRunUrl('generate', 'image'), decision: 'generate', source: 'dry-run-openai-image', altText: '', qa: null }
      : { ...(await generateAndHostImageDetailed(accountId, account, slotId, draft)), decision: 'generate', source: 'openai-image' };
  }
  return { url: null, decision: 'none', source: null, altText: '', qa: null };
}

async function resolveRawMediaDetailed(accountId, account, slotId, draft, { dryRun = false, now = new Date(), budgetState = 'healthy' } = {}) {
  const media = account.media || {}; const strategy = media.strategy || 'none'; const mediaType = media.type || 'image';
  if (strategy === 'none') return { url: null, decision: 'none', source: null, altText: '', qa: null };
  if (strategy === 'hunter') {
    const libraryCandidates = (media.urls || media.libraryUrls || []).filter(Boolean).map((url) => ({
      mediaUrl: url,
      sourceUrl: url,
      usageBasis: 'owned',
      mediaSourceType: 'asset_library',
      entityName: draft?.entityName || draft?.features?.topic,
      vendor: draft?.vendor,
      retrievedAt: now.toISOString()
    }));
    const hunted = await huntMedia({
      target: {
        entityName: draft?.entityName || draft?.features?.topic,
        vendor: draft?.vendor,
        canonicalUrl: draft?.canonicalUrl,
        oneLiner: draft?.rationale,
        audience: account.profile?.primaryPersona?.summary || account.profile?.audience,
        badge: draft?.features?.badge
      },
      platform: account.platform,
      candidates: [...(media.ownedAssets || []), ...(media.libraryAssets || []), ...libraryCandidates],
      allowBrandCard: account.platform === 'instagram',
      now,
      acquireFromCanonical: media.acquireFromCanonical === true
    });
    if (hunted.decision === 'skip') {
      const error = new Error('Media Hunter skipped: no verified product image and no usable brand card.');
      error.code = 'MEDIA_HUNTER_SKIP';
      throw error;
    }
    if (hunted.decision === 'none') {
      return { url: null, decision: 'none', source: 'hunter', altText: '', qa: null, verification: hunted.verification };
    }
    if (hunted.decision === 'brand-card') {
      if (dryRun) {
        return {
          url: 'https://dry-run.invalid/brand-card.svg',
          decision: 'brand-card',
          source: 'brand-card',
          altText: `${hunted.media.brandCard.badge} ${hunted.media.brandCard.productName}`,
          qa: null,
          verification: hunted.verification,
          brandCard: hunted.media.brandCard
        };
      }
      const error = new Error('Brand card is generated as SVG locally; Instagram publish requires a hosted raster URL. Skip rather than invent a product image.');
      error.code = 'MEDIA_HUNTER_SKIP';
      throw error;
    }
    return {
      url: hunted.media.assetUrl || hunted.media.mediaUrl || hunted.media.url || null,
      decision: hunted.decision,
      source: 'hunter',
      altText: String(hunted.media.altText || '').slice(0, 1000),
      qa: null,
      verification: hunted.verification
    };
  }
  if (strategy === 'fixed' || strategy === 'external') return { url: media.url || null, decision: media.url ? 'library' : 'none', source: strategy, altText: String(media.altText || '').slice(0, 1000), qa: null };
  if (strategy === 'pool') { const url = poolUrl(media, slotId); return { url, decision: url ? 'library' : 'none', source: 'pool', altText: '', qa: null }; }
  if (strategy === 'endpoint') {
    const decision = ['search', 'generate'].includes(draft?.features?.mediaDecision) ? draft.features.mediaDecision : 'generate';
    return dryRun ? { url: dryRunUrl(decision, mediaType), decision, source: 'dry-run-endpoint', altText: '', qa: null }
      : { ...(await requestMediaEndpoint(accountId, account, slotId, draft, decision)), decision, source: 'endpoint' };
  }
  if (strategy === 'generate') return generated(accountId, account, slotId, draft, dryRun, now, budgetState);
  if (strategy === 'auto') {
    let decision = draft?.features?.mediaDecision || 'none';
    if (account.platform === 'instagram' && decision === 'none') decision = media.defaultInstagramDecision || 'generate';
    if (decision === 'none') return { url: null, decision: 'none', source: null, altText: '', qa: null };
    if (decision === 'library') {
      const url = poolUrl(media, slotId);
      if (url) return { url, decision: 'library', source: 'pool', altText: '', qa: null };
      return generated(accountId, account, slotId, draft, dryRun, now, budgetState);
    }
    if (decision === 'search') {
      if (media.endpoint) return dryRun ? { url: dryRunUrl('search', mediaType), decision: 'search', source: 'dry-run-endpoint', altText: '', qa: null }
        : { ...(await requestMediaEndpoint(accountId, account, slotId, draft, 'search')), decision: 'search', source: 'endpoint' };
      const fallback = poolUrl(media, slotId);
      if (fallback) return { url: fallback, decision: 'library', source: 'pool-fallback', altText: '', qa: null };
      return generated(accountId, account, slotId, draft, dryRun, now, budgetState);
    }
    if (decision === 'generate') return generated(accountId, account, slotId, draft, dryRun, now, budgetState);
  }
  throw new Error(`Unsupported media strategy: ${strategy}`);
}

function mediaQaEnabled(account = {}) {
  return account.media?.qa?.enabled !== false;
}

async function reviewSelectedImage(accountId, account, slotId, draft, resolved, { dryRun = false, now = new Date(), budgetState = 'healthy' } = {}) {
  const mediaType = account.media?.type || 'image';
  if (!mediaQaEnabled(account) || dryRun || mediaType !== 'image' || !resolved.url || (resolved.source === 'openai-image' && resolved.qa)) return resolved;

  // Selected/library images get hard moderation here, while subjective relevance/"does this really
  // fit the post?" is deliberately left to ChatGPT/editorial review by default. Auto accounts may opt
  // back into API semantic review with media.qa.selectedSemanticReview=true.
  const qa = await reviewVisualUrl(accountId, account, resolved.url, {
    mediaType: 'image', prompt: draft?.mediaPrompt || '', postText: draft?.text || '',
    semanticReview: account.media?.qa?.selectedSemanticReview === true,
    softOnReviewError: true
  });
  if (qa.pass) {
    return {
      ...resolved,
      qa,
      endpointQa: resolved.endpointQa || (resolved.source === 'endpoint' ? resolved.qa : null),
      altText: qa.altText || resolved.altText || '',
      suitabilityReviewed: !qa.moderationOnly,
      chatReviewRecommended: Boolean(qa.chatReviewRecommended)
    };
  }
  if (account.platform === 'x') return {
    url: null, decision: 'none', source: `${resolved.source || 'media'}-qa-omitted`, altText: '', qa,
    endpointQa: resolved.endpointQa || null, suitabilityReviewed: true, omittedUnsafeVisual: true
  };
  if (account.platform === 'instagram' && resolved.decision !== 'generate' && account.media?.internalImageGeneration !== false) {
    const fallback = await generated(accountId, account, slotId, draft, false, now, budgetState);
    if (fallback.url) return { ...fallback, fallbackFrom: resolved.source || resolved.decision, priorQa: qa };
  }
  const error = new Error('Selected image failed hard pre-publish visual QA.');
  error.code = 'MEDIA_QA_FAILED'; error.qa = qa; throw error;
}

export async function resolveMediaDetailed(accountId, account, slotId, draft, options = {}) {
  const resolved = await resolveRawMediaDetailed(accountId, account, slotId, draft, options);
  return reviewSelectedImage(accountId, account, slotId, draft, resolved, options);
}
export async function resolveMedia(accountId, account, slotId, draft, options = {}) { return (await resolveMediaDetailed(accountId, account, slotId, draft, options)).url; }
export function ensureMediaForPlatform(account, mediaUrl, resolved = {}) {
  if (account.platform === 'instagram' && !mediaUrl && resolved.decision !== 'brand-card') {
    throw new Error('Instagram requires media. Configure media.strategy as fixed/pool/external/endpoint/generate/auto/hunter. Built-in OpenAI image generation is supported on public repositories.');
  }
}
export const __test = { reviewSelectedImage, resolveRawMediaDetailed, mediaQaEnabled };
