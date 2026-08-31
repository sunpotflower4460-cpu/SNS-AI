const VERIFIED = 'verified';
const REJECTED_STATUSES = new Set(['rejected', 'mismatch', 'unknown', 'ai_generated', 'vendor_visual_only', 'unverified']);
const AI_SOURCE_TYPES = new Set(['ai_generated', 'openai-image', 'openai-video', 'generated', 'synthetic']);
const VENDOR_ONLY_TYPES = new Set(['vendor_logo', 'vendor_wordmark', 'brand_mark']);

function fold(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
}

function tokens(value) {
  return fold(value).split(' ').filter((part) => part.length >= 2);
}

export function namesMatch(a, b) {
  const left = fold(a);
  const right = fold(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) {
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length <= right.length ? right : left;
    // "valhalla" matching "valhalla supermassive" is vendor-level, not product-level.
    if (shorter.split(' ').length < 2 && longer.split(' ').length >= 2 && longer.startsWith(`${shorter} `)) return false;
    return shorter.length >= 6;
  }
  const leftTokens = new Set(tokens(a));
  const rightTokens = new Set(tokens(b));
  if (!leftTokens.size || !rightTokens.size) return false;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap >= Math.min(leftTokens.size, rightTokens.size) && overlap >= 2;
}

function sameVendor(target, media) {
  const a = fold(target?.vendor);
  const b = fold(media?.vendor);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

export function classifyMediaSourceType(media = {}) {
  const type = String(media.mediaSourceType || media.sourceType || '').trim().toLowerCase();
  if (AI_SOURCE_TYPES.has(type) || media.aiGenerated === true) return 'ai_generated';
  if (VENDOR_ONLY_TYPES.has(type)) return 'vendor_logo';
  return type || 'unknown';
}

export function verifyMediaEntity(target = {}, media = {}) {
  const entityName = target.entityName || target.name || null;
  const mediaEntity = media.entityName || media.product || media.name || null;
  const sourceType = classifyMediaSourceType(media);
  const base = {
    entityName,
    vendor: target.vendor || null,
    canonicalUrl: target.canonicalUrl || media.canonicalUrl || null,
    sourceUrl: media.sourceUrl || null,
    mediaUrl: media.mediaUrl || media.url || null,
    mediaSourceType: sourceType,
    evidenceUrls: [...new Set([...(media.evidenceUrls || []), media.sourceUrl, media.canonicalUrl].filter(Boolean))],
    license: media.license || media.usageNote || null,
    usageNote: media.usageNote || media.license || null,
    usageBasis: media.usageBasis || 'unknown'
  };

  if (!entityName || !mediaEntity) {
    return { ...base, verificationStatus: 'unknown', verificationConfidence: 0, acceptedAsProductImage: false, reason: 'entity-unknown' };
  }
  if (sourceType === 'ai_generated') {
    return { ...base, verificationStatus: 'ai_generated', verificationConfidence: 0, acceptedAsProductImage: false, reason: 'ai-generated-ui' };
  }
  if (sourceType === 'vendor_logo') {
    return { ...base, verificationStatus: 'vendor_visual_only', verificationConfidence: sameVendor(target, media) ? 0.6 : 0, acceptedAsProductImage: false, reason: 'vendor-visual-only' };
  }
  if (!namesMatch(entityName, mediaEntity)) {
    return { ...base, verificationStatus: 'mismatch', verificationConfidence: 0, acceptedAsProductImage: false, reason: 'entity-mismatch' };
  }
  if (target.vendor && media.vendor && !sameVendor(target, media)) {
    return { ...base, verificationStatus: 'mismatch', verificationConfidence: 0, acceptedAsProductImage: false, reason: 'vendor-mismatch' };
  }

  const usageKnown = ['owned', 'official_press_asset', 'official_product_asset', 'licensed'].includes(base.usageBasis);
  const confidence = usageKnown ? 0.9 : 0.7;
  return {
    ...base,
    verificationStatus: VERIFIED,
    verificationConfidence: confidence,
    acceptedAsProductImage: true,
    reason: 'entity-match'
  };
}

export function acceptAsProductImage(verification) {
  return verification?.verificationStatus === VERIFIED && verification?.acceptedAsProductImage === true;
}

export function rejectReason(verification) {
  if (acceptAsProductImage(verification)) return null;
  return verification?.reason || verification?.verificationStatus || 'unverified';
}

export const __test = { fold, tokens, REJECTED_STATUSES, AI_SOURCE_TYPES, VENDOR_ONLY_TYPES, namesMatch };
