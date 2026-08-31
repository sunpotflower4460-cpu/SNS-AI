const SOURCE_ROLES = new Set(['discovery', 'primary', 'verification', 'community']);
const FACT_KEYS = ['price', 'releaseDate', 'saleEnd', 'systemRequirements', 'compatibility', 'license', 'version'];

export function normalizeSourceRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return SOURCE_ROLES.has(role) ? role : 'discovery';
}

export function annotateSource(source) {
  if (!source || typeof source !== 'object') return source;
  return { ...source, sourceRole: normalizeSourceRole(source.sourceRole) };
}

export function sourcesByRole(sources, role) {
  return (sources || []).filter((source) => normalizeSourceRole(source?.sourceRole) === role);
}

export function preferPrimaryFacts(facts, primarySources = []) {
  const confirmed = {};
  for (const key of FACT_KEYS) {
    const value = facts?.[key];
    if (value == null || value === '') {
      confirmed[key] = { value: null, confirmation: 'unconfirmed', sourceRole: null };
      continue;
    }
    const fromPrimary = primarySources.length > 0;
    confirmed[key] = {
      value,
      confirmation: fromPrimary ? 'primary' : 'unconfirmed',
      sourceRole: fromPrimary ? 'primary' : null
    };
  }
  return confirmed;
}

const PRICE_CLAIM = /(?:¥|￥|\$|usd|eur|€|定価|価格|円|\d+\s?%?\s?off|セール終了|until\s+\d)/i;
const DEADLINE_CLAIM = /(?:まで|締め切り|sale ends?|deadline|本日まで|今月末)/i;

export function draftFactRisks(text, facts = {}) {
  const body = String(text || '');
  const risks = [];
  const priceConfirmed = facts.price?.confirmation === 'primary' || facts.confirmation === 'primary';
  const saleConfirmed = facts.saleEnd?.confirmation === 'primary' || facts.confirmation === 'primary';
  if (PRICE_CLAIM.test(body) && !priceConfirmed) risks.push('unconfirmed-price');
  if (DEADLINE_CLAIM.test(body) && !saleConfirmed) risks.push('unconfirmed-sale-deadline');
  return risks;
}

export function assertConfirmedFacts(text, facts = {}) {
  const risks = draftFactRisks(text, facts);
  if (!risks.length) return { ok: true, risks };
  const error = new Error(`Fail-closed on unconfirmed commercial facts: ${risks.join(', ')}.`);
  error.code = 'UNCONFIRMED_FACTS';
  error.risks = risks;
  throw error;
}

export const __test = { SOURCE_ROLES, FACT_KEYS, PRICE_CLAIM, DEADLINE_CLAIM };
