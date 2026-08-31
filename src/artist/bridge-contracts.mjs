import { stripPrivateAssetFields } from './assets.mjs';

export const PROPOSED_BRIDGE_CONTRACTS = [
  'CreatorActionRecommendation',
  'CreatorActionResponse',
  'ArtistAssetNeedSignal',
  'ArtistContextEvent',
  'ArtistFunnelSnapshot',
  'PublishedPostSnapshot'
];

export function creatorActionRecommendation(action) {
  return stripPrivateAssetFields({
    kind: 'CreatorActionRecommendation',
    requestId: action.requestId,
    type: action.type,
    priority: action.priority,
    requestedAssetType: action.requestedAssetType,
    song: action.song,
    topic: action.topic,
    orientation: action.orientation,
    durationRange: action.durationRange,
    quantity: action.quantity,
    reason: action.reason,
    evidence: action.evidence,
    confidence: action.confidence,
    expiresAt: action.expiresAt || null
  });
}

export function artistFunnelSnapshotContract(snapshot) {
  return {
    kind: 'ArtistFunnelSnapshot',
    bottleneck: snapshot.currentBottleneck,
    recommendedLane: snapshot.recommendedLane,
    recommendedObjective: snapshot.recommendedObjective,
    confidence: snapshot.confidence,
    unknownMetrics: snapshot.snapshot?.unknown || [],
    reason: snapshot.reason
  };
}

export function artistContextEvent(event) {
  return {
    kind: 'ArtistContextEvent',
    type: event.type || event.anchorType,
    at: event.at,
    entityName: event.entityName || null,
    summary: event.summary || event.text || null,
    source: event.source || 'human'
  };
}

export function assertNoPrivateStorage(payload) {
  const json = JSON.stringify(payload);
  if (/signedUrl|privateStorage|privateUrl|X-Amz-Signature/i.test(json)) {
    const error = new Error('Bridge contracts must not carry private or signed storage URLs.');
    error.code = 'BRIDGE_PRIVATE_URL';
    throw error;
  }
  return true;
}

export const __test = { PROPOSED_BRIDGE_CONTRACTS };
