import { createHash } from 'node:crypto';

export const MEDIA_TYPES = [
  'acoustic-performance',
  'live-performance',
  'mv',
  'rehearsal',
  'studio',
  'photo',
  'artwork',
  'short-video',
  'instrument-footage',
  'nature-location',
  'spoken-clip'
];

export const ANGLES = [
  'vocal', 'lyric', 'guitar', 'songwriting', 'production', 'atmosphere', 'story',
  'beginner-entry', 'artist-personality', 'music-discovery', 'taste-connection',
  'live-energy', 'quiet-performance', 'technical'
];

const PRIVATE_KEYS = ['storageUrl', 'signedUrl', 'privateUrl', 'privateStorageUrl', 'localPath'];

export function stripPrivateAssetFields(record = {}) {
  const out = { ...record };
  for (const key of PRIVATE_KEYS) delete out[key];
  return out;
}

export function transformationFingerprint({
  masterAssetId,
  clipStart = null,
  clipEnd = null,
  crop = null,
  orientation = null,
  subtitleMode = null,
  angle = null
} = {}) {
  const payload = JSON.stringify({
    masterAssetId, clipStart, clipEnd, crop, orientation, subtitleMode, angle
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

export function createMasterAsset(input = {}) {
  const mediaType = MEDIA_TYPES.includes(input.mediaType) ? input.mediaType : (input.mediaType || 'photo');
  const assetId = input.assetId || input.masterAssetId;
  if (!assetId) throw new Error('master asset requires assetId');
  return stripPrivateAssetFields({
    assetId,
    masterAssetId: input.masterAssetId || assetId,
    mediaType,
    source: input.source || 'artist-library',
    ownershipBasis: input.ownershipBasis || 'createdByArtist',
    songId: input.songId || null,
    capturedAt: input.capturedAt || null,
    duration: input.duration ?? null,
    orientation: input.orientation || 'unknown',
    tags: [...(input.tags || [])],
    availablePlatforms: [...(input.availablePlatforms || ['x', 'instagram'])],
    rightsStatus: input.rightsStatus || 'owned',
    createdByArtist: input.createdByArtist !== false,
    timesUsed: Number(input.timesUsed || 0),
    lastUsedAt: input.lastUsedAt || null,
    performanceSummary: input.performanceSummary || null,
    fatigueScore: Number(input.fatigueScore || 0),
    remainingAngles: [...(input.remainingAngles || ANGLES)]
  });
}

export function deriveVariant(master, spec = {}) {
  const masterAssetId = master.masterAssetId || master.assetId;
  const fingerprint = transformationFingerprint({
    masterAssetId,
    clipStart: spec.clipStart ?? null,
    clipEnd: spec.clipEnd ?? null,
    crop: spec.crop ?? null,
    orientation: spec.orientation || master.orientation,
    subtitleMode: spec.subtitleMode ?? null,
    angle: spec.angle || null
  });
  return stripPrivateAssetFields({
    variantId: spec.variantId || `var-${fingerprint}`,
    masterAssetId,
    clipStart: spec.clipStart ?? null,
    clipEnd: spec.clipEnd ?? null,
    crop: spec.crop ?? null,
    orientation: spec.orientation || master.orientation,
    subtitleMode: spec.subtitleMode ?? null,
    angle: spec.angle || null,
    transformationFingerprint: fingerprint,
    caption: spec.caption || null
  });
}

export function variantsNearDuplicate(a, b, { captionSimilarity = null } = {}) {
  if (!a || !b) return false;
  if (a.masterAssetId !== b.masterAssetId) return false;
  if (a.transformationFingerprint && a.transformationFingerprint === b.transformationFingerprint) {
    if (a.caption && b.caption && a.caption === b.caption) return true;
    if (!a.caption && !b.caption) return true;
  }
  const sameClip = a.clipStart === b.clipStart && a.clipEnd === b.clipEnd;
  const sameAngle = a.angle && a.angle === b.angle;
  const sameCaption = a.caption && a.caption === b.caption;
  if (sameClip && sameCaption) return true;
  if (sameClip && sameAngle && (captionSimilarity == null || captionSimilarity >= 0.9)) return true;
  return false;
}

export function rejectDuplicateFinishedPost({ candidate, recent = [], minDays = 21, now = new Date() }) {
  const cutoff = now.getTime() - minDays * 86400_000;
  for (const prior of recent) {
    const usedAt = Date.parse(prior.lastUsedAt || prior.at || '');
    const recentEnough = Number.isFinite(usedAt) ? usedAt >= cutoff : true;
    if (!recentEnough) continue;
    if (variantsNearDuplicate(candidate, prior) || variantsNearDuplicate(candidate, prior.variant || prior)) {
      return { reject: true, reason: 'same-finished-post-reuse' };
    }
    if (candidate.masterAssetId === prior.masterAssetId && candidate.caption && candidate.caption === prior.caption && candidate.clipStart === prior.clipStart) {
      return { reject: true, reason: 'same-master-clip-caption' };
    }
  }
  return { reject: false, reason: null };
}

export function platformAdaptVariant(variant, platform) {
  if (platform === 'x') {
    return { ...variant, orientation: variant.orientation || 'landscape', captionMode: 'hook-conversational', copyPasteFrom: null };
  }
  return { ...variant, orientation: variant.orientation === 'landscape' ? 'portrait' : (variant.orientation || 'portrait'), captionMode: 'visual-first', copyPasteFrom: null };
}

export const __test = { PRIVATE_KEYS };
