// Pre-generation escalation derives escalation reasons ONLY from research data that already exists:
// the direct-fetch/Groq triage path (src/research/triage.mjs) scores every candidate with confidence
// (0-100, higher is better) and risk (0-100, higher is worse), and refreshTrends() persists items
// sorted by opportunityScore descending - so trends.items[0] is the top opportunity the generation
// step is about to build on. No new AI call is made here; the thresholds are deterministic. Web
// Search brief items may lack confidence entirely, which simply disables the confidence rule.

const WEAK_CONFIDENCE_MAX = 55;
const HIGH_FACTUAL_RISK_MIN = 65;

function score(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Returns escalation reasons for the AI router (src/ai/router.mjs ESCALATION set). Today only
// weak-confidence / high-factual-risk are derived; both escalate a balanced post-generation route
// to high (gpt-5.6-terra). Nothing here maps to critical - Sol is never auto-selected.
export function deriveResearchEscalationReasons(trends) {
  const items = trends?.items;
  if (!Array.isArray(items) || !items.length) return [];
  const top = items[0];
  if (!top || typeof top !== 'object') return [];
  const reasons = [];
  const confidence = score(top.confidence);
  if (confidence != null && confidence <= WEAK_CONFIDENCE_MAX) reasons.push('weak-confidence');
  const risk = score(top.risk);
  if (risk != null && risk >= HIGH_FACTUAL_RISK_MIN) reasons.push('high-factual-risk');
  return reasons;
}

export const __test = { WEAK_CONFIDENCE_MAX, HIGH_FACTUAL_RISK_MIN };
