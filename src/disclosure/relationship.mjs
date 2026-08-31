const RELATIONSHIPS = new Set(['independent', 'affiliate', 'sponsored', 'provided', 'own_product']);

export function normalizeRelationship(value) {
  const kind = String(value || 'independent').trim().toLowerCase();
  if (!RELATIONSHIPS.has(kind)) return null;
  return kind;
}

export function requiredDisclosure(kind) {
  if (kind === 'own_product') return { required: true, text: '運営者が開発した製品です' };
  if (kind === 'affiliate') return { required: true, text: '広告・アフィリエイトリンクを含みます' };
  if (kind === 'sponsored') return { required: true, text: '広告を含みます' };
  if (kind === 'provided') return { required: true, text: '提供を受けた製品です' };
  return { required: false, text: null };
}

export function assertRelationshipDisclosure({ text, relationship, affiliateEnabled = false }) {
  const kind = normalizeRelationship(relationship);
  if (!kind) {
    const error = new Error('Ownership/commercial relationship is unknown; fail closed.');
    error.code = 'RELATIONSHIP_UNKNOWN';
    throw error;
  }
  if (kind === 'affiliate' && affiliateEnabled !== true) {
    const error = new Error('Affiliate relationship cannot be published while affiliate is disabled.');
    error.code = 'AFFILIATE_DISABLED';
    throw error;
  }
  if (kind === 'own_product' && affiliateEnabled === true && relationship === 'affiliate') {
    const error = new Error('own_product and affiliate must not be mixed.');
    error.code = 'RELATIONSHIP_CONFLICT';
    throw error;
  }
  const disclosure = requiredDisclosure(kind);
  if (disclosure.required && !String(text || '').includes(disclosure.text)) {
    const error = new Error(`Post must disclose ${kind}: "${disclosure.text}".`);
    error.code = 'RELATIONSHIP_DISCLOSURE_MISSING';
    error.kind = kind;
    throw error;
  }
  return { ok: true, kind, disclosure };
}

export const __test = { RELATIONSHIPS, requiredDisclosure };
