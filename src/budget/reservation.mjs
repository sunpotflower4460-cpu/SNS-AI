const OPERATION_ESTIMATE_KEY = {
  'post-generation': 'openaiCall',
  'openai-generation': 'openaiCall',
  'paid-ai-generation': 'openaiCall',
  'cheap-model': 'groqCall',
  'balanced-model': 'openaiCall',
  'high-model': 'openaiCall',
  'critical-model': 'openaiCall',
  'web-search': 'webSearch',
  'image-generation': 'imageGeneration',
  'video-generation': 'videoGeneration',
  'url-post': 'xUrlPost'
};

export const RESERVATION_NOTE = 'Estimated reservation only; not an actual billing API hold. Zero or missing unit price is unknown, not free.';

function estimateRow(policy, operation, route = null) {
  const estimates = policy?.operationEstimatesUsd || {};
  const key = route?.provider === 'groq' && (operation === 'post-generation' || operation === 'paid-ai-generation' || operation === 'cheap-model')
    ? 'groqCall'
    : (OPERATION_ESTIMATE_KEY[operation] || 'openaiCall');
  return { key, row: estimates[key] || null };
}

export function estimateReservation({ operation = 'post-generation', policy = {}, route = null } = {}) {
  const { key, row } = estimateRow(policy, operation, route);
  const usd = Number(row?.usd);
  const costType = row?.costType || 'unknown';
  const priced = costType !== 'unknown' && Number.isFinite(usd) && usd > 0;
  return {
    reservationKind: 'estimated',
    billingApi: false,
    operation,
    estimateKey: key,
    costType: priced ? 'estimated' : (costType || 'unknown'),
    estimatedUsd: priced ? usd : null,
    unknown: !priced,
    note: RESERVATION_NOTE,
    source: row?.source || 'config/budget-policy.json'
  };
}

export function reservationAuditFields(reservation) {
  if (!reservation) return { reservationKind: null, reservedCostType: null, reservedEstimatedUsd: null };
  return {
    reservationKind: reservation.reservationKind,
    reservedCostType: reservation.costType,
    reservedEstimatedUsd: reservation.estimatedUsd,
    reservationUnknown: Boolean(reservation.unknown),
    reservationNote: reservation.note
  };
}

export const __test = { OPERATION_ESTIMATE_KEY, estimateRow };
