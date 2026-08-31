import { randomUUID } from 'node:crypto';

export const ACTION_TYPES = [
  'asset_request',
  'taste_confirmation',
  'context_request',
  'story_request',
  'capture_request',
  'approval_request'
];

const MIN_REQUEST_CONFIDENCE = 0.6;

export function hybridEnabled(account = {}) {
  return account?.artist?.hybridMode === true;
}

export function createCreatorAction({
  type,
  priority = 'normal',
  requestedAssetType = null,
  song = null,
  topic = null,
  orientation = null,
  durationRange = null,
  quantity = 1,
  reason,
  evidence = [],
  confidence,
  expiresAt = null,
  now = new Date()
} = {}) {
  if (!ACTION_TYPES.includes(type)) throw new Error(`unknown creator action type: ${type}`);
  return {
    requestId: `ca-${randomUUID()}`,
    type,
    priority,
    requestedAssetType,
    song: song || null,
    topic: topic || null,
    orientation,
    durationRange,
    quantity: Number(quantity || 1),
    reason: String(reason || ''),
    evidence: [...(evidence || [])],
    confidence: Number(confidence),
    expiresAt,
    createdAt: now.toISOString()
  };
}

export function maybeAssetRequest({
  hybridMode,
  shortage,
  evidence = [],
  confidence,
  requestedAssetType,
  song = null,
  reason,
  now = new Date()
} = {}) {
  if (hybridMode !== true) return { requested: false, reason: 'hybrid-mode-off' };
  if (!shortage) return { requested: false, reason: 'no-shortage' };
  if (!(Number(confidence) >= MIN_REQUEST_CONFIDENCE) || !evidence.length) {
    return { requested: false, reason: 'low-confidence-or-no-evidence' };
  }
  return {
    requested: true,
    action: createCreatorAction({
      type: 'asset_request',
      priority: Number(confidence) >= 0.8 ? 'high' : 'normal',
      requestedAssetType,
      song,
      orientation: 'portrait',
      durationRange: '8-30s',
      quantity: 2,
      reason,
      evidence,
      confidence,
      now
    })
  };
}

export function applyTasteConfirmation({ currentLevel = 'taste_match', response, evidenceId = null } = {}) {
  const answer = String(response || '').toLowerCase();
  if (answer === 'yes') {
    return {
      promoted: currentLevel === 'taste_match' || currentLevel === 'external_discovery',
      nextLevel: 'confirmed_personal',
      avoid: false,
      evidenceId,
      event: 'taste-confirmation-yes'
    };
  }
  if (answer === 'no') {
    return {
      promoted: false,
      nextLevel: currentLevel,
      avoid: true,
      evidenceId,
      event: 'taste-confirmation-no'
    };
  }
  return {
    promoted: false,
    nextLevel: currentLevel === 'confirmed_personal' ? 'confirmed_personal' : 'taste_match',
    avoid: false,
    evidenceId,
    event: 'taste-confirmation-neutral'
  };
}

export function tasteConfirmationAction({ work, confidence, hybridMode, now = new Date() } = {}) {
  if (hybridMode !== true) return { requested: false, reason: 'hybrid-mode-off' };
  return {
    requested: true,
    action: createCreatorAction({
      type: 'taste_confirmation',
      reason: `「${work}」は好みに合いそう。実際に好きですか？ Yes / No / Neutral`,
      evidence: [{ kind: 'taste_match', work }],
      confidence,
      topic: work,
      now
    })
  };
}

export const __test = { MIN_REQUEST_CONFIDENCE };
