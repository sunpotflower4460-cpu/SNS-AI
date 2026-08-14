const ORGANIC = 'organic';
const AFFILIATE = 'affiliate';
const COMMERCIAL_KINDS = new Set([ORGANIC, AFFILIATE]);

function trustError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.publishStage = 'preflight';
  throw error;
}

function nonEmptyList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function kindOf(row) {
  const kind = String(row?.commercial?.kind || ORGANIC).trim().toLowerCase();
  return COMMERCIAL_KINDS.has(kind) ? kind : ORGANIC;
}

function publishedForAccount(history, accountId) {
  return (Array.isArray(history) ? history : []).filter((row) => row?.status === 'published' && row?.account === accountId);
}

function configNumber(value, fallback, label, { min = 0, max = Number.POSITIVE_INFINITY, integer = false } = {}) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    trustError('AFFILIATE_CONFIG_INVALID', `Invalid affiliate configuration for ${label}.`);
  }
  return number;
}

export function normalizeCommercial(value) {
  if (value == null) return { kind: ORGANIC, paidPartnership: false };
  if (typeof value !== 'object' || Array.isArray(value)) trustError('COMMERCIAL_METADATA_INVALID', 'commercial metadata must be an object.');
  const kind = String(value.kind || ORGANIC).trim().toLowerCase();
  if (!COMMERCIAL_KINDS.has(kind)) trustError('COMMERCIAL_KIND_INVALID', `Unsupported commercial kind "${kind}".`);
  return { ...value, kind, paidPartnership: Boolean(value.paidPartnership) };
}

export function assertAffiliateTrust({ accountId, account, text, commercial, history = [], now = new Date() }) {
  const normalized = normalizeCommercial(commercial);
  if (normalized.kind === ORGANIC) return { ...normalized, paidPartnership: false };

  const config = account?.monetization?.affiliate || {};
  if (config.enabled !== true) trustError('AFFILIATE_DISABLED', `Affiliate publishing is disabled for account "${accountId}".`);
  if (config.allowCommissionInRanking !== false) {
    trustError('AFFILIATE_RANKING_UNSAFE', 'Affiliate commission must not influence recommendation ranking.');
  }

  const disclosureText = String(config.disclosureText || '').trim();
  if (config.requireExplicitDisclosure !== false) {
    if (!disclosureText) trustError('AFFILIATE_DISCLOSURE_CONFIG', 'Affiliate disclosureText must be configured when explicit disclosure is required.');
    if (!String(text || '').includes(disclosureText)) {
      trustError('AFFILIATE_DISCLOSURE_MISSING', `Affiliate post must visibly include the configured disclosure: ${disclosureText}`);
    }
  }

  if (config.requireBalancedRecommendation !== false) {
    const recommendation = normalized.recommendation || {};
    if (nonEmptyList(recommendation.pros).length === 0) trustError('AFFILIATE_BALANCE_MISSING', 'Affiliate recommendation must record at least one concrete benefit.');
    if (nonEmptyList(recommendation.cons).length === 0) trustError('AFFILIATE_BALANCE_MISSING', 'Affiliate recommendation must record at least one limitation or trade-off.');
    if (config.requireAlternativeConsideration !== false && nonEmptyList(recommendation.alternativesConsidered).length === 0) {
      trustError('AFFILIATE_ALTERNATIVE_MISSING', 'Affiliate recommendation must consider at least one non-affiliate or alternative option.');
    }
  }

  const rows = publishedForAccount(history, accountId);
  const maxShare = configNumber(config.maxShare, 0.2, 'maxShare', { min: 0.01, max: 1 });
  const windowPosts = configNumber(config.windowPosts, 20, 'windowPosts', { min: 1, integer: true });
  const recent = rows.slice(-windowPosts);
  const affiliateCount = recent.filter((row) => kindOf(row) === AFFILIATE).length;
  const prospectiveShare = (affiliateCount + 1) / (recent.length + 1);
  if (prospectiveShare > maxShare) {
    trustError('AFFILIATE_SHARE_LIMIT', `Affiliate share would be ${(prospectiveShare * 100).toFixed(1)}%, above the configured ${(maxShare * 100).toFixed(1)}% limit.`);
  }

  let lastAffiliateIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (kindOf(rows[index]) === AFFILIATE) { lastAffiliateIndex = index; break; }
  }

  if (lastAffiliateIndex < 0) {
    const minimum = configNumber(config.minOrganicPostsBeforeFirst ?? config.minOrganicPostsBetween, 4, 'minOrganicPostsBeforeFirst', { min: 0, integer: true });
    const organicCount = rows.filter((row) => kindOf(row) === ORGANIC).length;
    if (organicCount < minimum) trustError('AFFILIATE_ORGANIC_FOUNDATION', `At least ${minimum} organic published posts are required before the first affiliate post.`);
  } else {
    const minimum = configNumber(config.minOrganicPostsBetween, 4, 'minOrganicPostsBetween', { min: 0, integer: true });
    const organicSince = rows.slice(lastAffiliateIndex + 1).filter((row) => kindOf(row) === ORGANIC).length;
    if (organicSince < minimum) trustError('AFFILIATE_ORGANIC_GAP', `At least ${minimum} organic published posts are required between affiliate posts.`);

    const cooldownHours = configNumber(config.cooldownHours, 48, 'cooldownHours', { min: 0 });
    const lastAt = Date.parse(rows[lastAffiliateIndex]?.at || '');
    const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (cooldownHours > 0 && Number.isFinite(lastAt) && Number.isFinite(current) && current - lastAt < cooldownHours * 60 * 60 * 1000) {
      trustError('AFFILIATE_COOLDOWN', `Affiliate cooldown of ${cooldownHours} hours has not elapsed.`);
    }
  }

  return {
    ...normalized,
    paidPartnership: account?.platform === 'x' && config.requireXPaidPartnership !== false
  };
}

export const __test = { kindOf, nonEmptyList, publishedForAccount, configNumber };
