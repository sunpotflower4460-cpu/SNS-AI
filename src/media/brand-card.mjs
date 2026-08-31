function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const BADGES = new Set(['NEW', 'FREE', 'UPDATE', 'SALE']);

export function normalizeBadge(value) {
  const badge = String(value || 'NEW').trim().toUpperCase();
  return BADGES.has(badge) ? badge : 'NEW';
}

export function renderBrandCard({
  badge = 'NEW',
  productName,
  vendor,
  oneLiner = '',
  audience = '',
  width = 1080,
  height = 1080
} = {}) {
  const name = String(productName || '').trim();
  const maker = String(vendor || '').trim();
  if (!name || !maker) {
    return { ok: false, reason: 'missing-product-or-vendor', svg: null };
  }

  const label = normalizeBadge(badge);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(`${label} ${name} by ${maker}`)}">
  <rect width="100%" height="100%" fill="#111111"/>
  <rect x="48" y="48" width="${width - 96}" height="${height - 96}" fill="none" stroke="#F2EDE6" stroke-width="4"/>
  <rect x="80" y="96" width="220" height="64" rx="8" fill="#F2EDE6"/>
  <text x="190" y="140" text-anchor="middle" font-family="sans-serif" font-size="32" font-weight="700" fill="#111111">${escapeXml(label)}</text>
  <text x="80" y="280" font-family="sans-serif" font-size="28" fill="#B9B3AB">PLUGIN RADAR</text>
  <text x="80" y="400" font-family="sans-serif" font-size="64" font-weight="700" fill="#F2EDE6">${escapeXml(name.slice(0, 42))}</text>
  <text x="80" y="480" font-family="sans-serif" font-size="36" fill="#D7D0C7">${escapeXml(maker.slice(0, 48))}</text>
  <text x="80" y="640" font-family="sans-serif" font-size="32" fill="#F2EDE6">${escapeXml(String(oneLiner).slice(0, 80))}</text>
  <text x="80" y="740" font-family="sans-serif" font-size="28" fill="#B9B3AB">${escapeXml(audience ? `誰向け: ${String(audience).slice(0, 60)}` : '')}</text>
  <text x="80" y="980" font-family="sans-serif" font-size="22" fill="#7A746C">Information card. Not a product screenshot or invented UI.</text>
</svg>
`;

  return {
    ok: true,
    format: 'svg',
    badge: label,
    productName: name,
    vendor: maker,
    inventsProductUi: false,
    altersOfficialLogo: false,
    svg
  };
}

export const __test = { escapeXml, BADGES };
