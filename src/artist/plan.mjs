import { collectHumanAnchors, manualActivityCount } from './anchor.mjs';
import { proposeOrbit } from './orbit.mjs';
import { diagnoseFunnel } from './funnel-repair.mjs';
import { applyLearnedMix, chooseLane, maxDirectPromotionShare, resolveArtistMix } from './mix.mjs';
import { maybeAssetRequest, hybridEnabled } from './actions.mjs';
import { campaignOrbit } from './campaign.mjs';
import { rejectDuplicateFinishedPost } from './assets.mjs';
import { shortTermReuseForbidden } from './fatigue.mjs';

export function applyFunnelMix(baseMix, funnel, account) {
  const resolved = applyLearnedMix(baseMix || resolveArtistMix(account), baseMix, account);
  if (!funnel?.changeStrategy || !funnel.recommendedLane || !(funnel.recommendedLane in resolved)) {
    return resolved;
  }
  const boost = 0.12;
  const next = { ...resolved };
  const keys = Object.keys(next);
  next[funnel.recommendedLane] = Math.min(0.7, next[funnel.recommendedLane] + boost);
  const rest = keys.filter((key) => key !== funnel.recommendedLane && key !== 'directArtistPromotion');
  const restTotal = rest.reduce((sum, key) => sum + next[key], 0) || 1;
  const remaining = Math.max(0, 1 - next.directArtistPromotion - next[funnel.recommendedLane]);
  for (const key of rest) next[key] = remaining * (next[key] / restTotal);
  const cap = maxDirectPromotionShare(account);
  if (next.directArtistPromotion > cap) next.directArtistPromotion = cap;
  return next;
}

export function decideNoPost({
  anchors = [],
  budgetState = 'healthy',
  assets = [],
  overlapAction = null,
  campaign = null,
  account = {},
  now = new Date()
} = {}) {
  const reasons = [];
  const manualsToday = manualActivityCount({ anchors }, { hours: 24, now });
  const maxPosts = Number(account.artist?.aiMaxPostsPerDay ?? 2);
  if (budgetState === 'stopped') reasons.push('budget-stopped');
  if (manualsToday >= maxPosts) reasons.push('human-already-posted-enough');
  if (overlapAction === 'delay' || overlapAction === 'skip') reasons.push(`overlap-${overlapAction}`);
  if (campaign?.decision === 'defer-to-human-anchor') reasons.push('campaign-human-owns-the-wave');
  if (campaign?.decision === 'wait-for-asset') reasons.push('no-safe-asset-for-campaign');
  const usable = (assets || []).filter((asset) => !shortTermReuseForbidden(asset, { now }));
  if ((account.contentStrategy === 'artist-support') && assets.length && usable.length === 0 && account.platform === 'instagram') {
    reasons.push('no-safe-asset');
  }
  if (!reasons.length) return { skip: false, action: null, why: [] };
  return {
    skip: true,
    action: reasons.includes('overlap-skip') ? 'skip' : 'delay',
    why: reasons
  };
}

export function planArtistSlot({
  account = {},
  history = [],
  events = [],
  metrics = {},
  assets = [],
  library = null,
  campaignEvent = null,
  ingestConnected = false,
  budgetState = 'healthy',
  slotId = 'slot',
  now = new Date()
} = {}) {
  const hybridMode = hybridEnabled(account);
  const collected = collectHumanAnchors({
    history,
    events,
    accountId: account.id,
    lookbackHours: Number(account.artist?.manualOverlap?.lookbackHours ?? 72),
    now,
    ingestConnected: hybridMode && ingestConnected
  });
  const funnel = diagnoseFunnel({ metrics, mix: account.artist?.mix });
  const mix = applyFunnelMix(resolveArtistMix(account), funnel, account);
  const lane = chooseLane(slotId, mix, account);
  const campaign = campaignEvent ? campaignOrbit({
    event: campaignEvent,
    now,
    metrics,
    availableAssets: assets,
    humanPostedToday: manualActivityCount(collected, { hours: 24, now }) > 0
  }) : { active: false };
  const orbit = proposeOrbit({
    anchor: collected.anchors[0] || null,
    library,
    assets
  });
  const noPost = decideNoPost({
    anchors: collected.anchors,
    budgetState,
    assets,
    overlapAction: null,
    campaign,
    account,
    now
  });

  const request = maybeAssetRequest({
    hybridMode,
    shortage: assets.length === 0 && lane.lane === 'musicAndCreation',
    evidence: funnel.changeStrategy ? [{ kind: 'funnel', bottleneck: funnel.currentBottleneck, confidence: funnel.confidence }] : [],
    confidence: funnel.confidence,
    requestedAssetType: 'short-video',
    song: collected.anchors[0]?.entityName || null,
    reason: funnel.reason,
    now
  });

  const why = [
    noPost.skip
      ? `no-post: ${noPost.why.join(', ')}`
      : `lane=${lane.lane} because ${funnel.recommendedLane ? funnel.reason : 'prior mix; funnel confidence too low to swing.'}`,
    orbit.why,
    collected.note,
    `hybridMode=${hybridMode}`
  ];

  if (noPost.skip) {
    return {
      decision: 'no-post',
      proceed: false,
      action: noPost.action,
      hybridMode,
      funnel,
      mix: lane.mix,
      lane: lane.lane,
      orbit,
      campaign,
      anchors: collected,
      request,
      why,
      ingestConnected: Boolean(hybridMode && ingestConnected)
    };
  }

  return {
    decision: 'generate',
    proceed: true,
    action: orbit.active ? 'reframe' : null,
    hybridMode,
    funnel,
    mix: lane.mix,
    lane: lane.lane,
    orbit,
    campaign,
    anchors: collected,
    request,
    why,
    ingestConnected: Boolean(hybridMode && ingestConnected),
    forbiddenParaphrases: collected.anchors.map((row) => row.text).filter(Boolean)
  };
}

export function filterAssetCandidate(candidate, recent, now = new Date()) {
  return rejectDuplicateFinishedPost({ candidate, recent, now });
}

export const __test = {};
