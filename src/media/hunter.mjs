import { verifyMediaEntity, acceptAsProductImage } from './entity-verify.mjs';
import { renderBrandCard } from './brand-card.mjs';

const PRIORITY = [
  'owned',
  'asset-library',
  'official-product-page',
  'official-press-kit',
  'official-github-release',
  'licensed-official',
  'brand-template',
  'skip'
];

const SOURCE_TYPE_TO_PRIORITY = {
  owned: 'owned',
  user_owned: 'owned',
  asset_library: 'asset-library',
  official_product_asset: 'official-product-page',
  official_product_page: 'official-product-page',
  official_press_asset: 'official-press-kit',
  official_press_kit: 'official-press-kit',
  official_github_release: 'official-github-release',
  github_release: 'official-github-release',
  licensed: 'licensed-official',
  brand_template: 'brand-template',
  brand_card: 'brand-template'
};

function rank(candidate) {
  const key = SOURCE_TYPE_TO_PRIORITY[candidate?.mediaSourceType] || SOURCE_TYPE_TO_PRIORITY[candidate?.usageBasis] || 'skip';
  const index = PRIORITY.indexOf(key);
  return index < 0 ? PRIORITY.length : index;
}

export function sortHunterCandidates(candidates) {
  return [...(candidates || [])].sort((a, b) => rank(a) - rank(b));
}

export function usageAllowsInstagram(usageBasis) {
  return ['owned', 'official_press_asset', 'official_product_asset', 'licensed'].includes(usageBasis);
}

export async function huntMedia({
  target,
  platform,
  candidates = [],
  allowBrandCard = true,
  brandCardInput = null,
  now = new Date()
} = {}) {
  const inspected = [];
  for (const candidate of sortHunterCandidates(candidates)) {
    const verification = verifyMediaEntity(target, candidate);
    const record = {
      ...candidate,
      retrievedAt: candidate.retrievedAt || now.toISOString(),
      sourceUrl: candidate.sourceUrl || null,
      assetUrl: candidate.mediaUrl || candidate.url || null,
      sourceType: candidate.mediaSourceType || candidate.sourceType || 'unknown',
      usageBasis: candidate.usageBasis || 'unknown',
      verification
    };
    inspected.push(record);
    if (acceptAsProductImage(verification) && (platform !== 'instagram' || usageAllowsInstagram(record.usageBasis))) {
      return {
        decision: 'verified-product-image',
        media: record,
        verification,
        inspected
      };
    }
  }

  const vendorVisual = inspected.find((row) => row.verification?.verificationStatus === 'vendor_visual_only' && row.verification?.vendor);
  if (platform === 'instagram' && vendorVisual && usageAllowsInstagram(vendorVisual.usageBasis)) {
    return {
      decision: 'verified-brand-visual',
      media: vendorVisual,
      verification: vendorVisual.verification,
      inspected
    };
  }

  if (platform === 'instagram' && allowBrandCard) {
    const card = renderBrandCard(brandCardInput || {
      badge: target?.badge || 'NEW',
      productName: target?.entityName || target?.name,
      vendor: target?.vendor,
      oneLiner: target?.oneLiner || '',
      audience: target?.audience || ''
    });
    if (card.ok) {
      return {
        decision: 'brand-card',
        media: {
          mediaSourceType: 'brand_card',
          usageBasis: 'owned',
          sourceUrl: null,
          assetUrl: null,
          retrievedAt: now.toISOString(),
          brandCard: card
        },
        verification: {
          verificationStatus: 'brand_card',
          acceptedAsProductImage: false,
          reason: 'brand-card-fallback'
        },
        inspected
      };
    }
    return { decision: 'skip', media: null, verification: { verificationStatus: 'rejected', reason: 'brand-card-unavailable' }, inspected };
  }

  if (platform === 'x') {
    return { decision: 'none', media: null, verification: { verificationStatus: 'unverified', reason: 'x-allows-no-media' }, inspected };
  }

  return { decision: 'skip', media: null, verification: { verificationStatus: 'rejected', reason: 'no-verified-media' }, inspected };
}

export const __test = { PRIORITY, SOURCE_TYPE_TO_PRIORITY, rank, sortHunterCandidates };
