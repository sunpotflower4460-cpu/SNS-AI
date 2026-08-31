const TIERS = ['cheap', 'balanced', 'high', 'critical'];

const TASK_TIER = {
  'research-triage': 'cheap',
  'format-conversion': 'cheap',
  'platform-adapt': 'cheap',
  'post-generation': 'balanced',
  ranking: 'balanced',
  'final-review': 'high',
  'weekly-strategy': 'critical',
  'editorial-decision': 'critical'
};

const ESCALATION = new Set([
  'high-value-url-post',
  'major-product-launch',
  'weak-confidence',
  'conflicting-sources',
  'high-factual-risk',
  'important-artist-release',
  'experimental-high-potential',
  'weekly-strategy-review'
]);

export function defaultRouterConfig(account = {}) {
  return {
    cheap: { provider: 'groq', model: account.ai?.groqModel || null },
    balanced: { provider: 'openai', model: account.ai?.openaiTriageModel || null },
    high: { provider: 'openai', model: account.generation?.model || null },
    critical: { provider: 'openai', model: account.generation?.model || null },
    ...(account.ai?.router || {})
  };
}

export function tierForTask(task, { escalateReasons = [] } = {}) {
  const reasons = (escalateReasons || []).filter((reason) => ESCALATION.has(reason));
  let tier = TASK_TIER[task] || 'balanced';
  if (reasons.length && tier === 'cheap') tier = 'balanced';
  if (reasons.some((reason) => ['weekly-strategy-review', 'major-product-launch', 'important-artist-release'].includes(reason))) {
    tier = 'critical';
  } else if (reasons.length && (tier === 'balanced' || tier === 'cheap')) {
    tier = 'high';
  }
  return { tier, reasons, cascaded: reasons.length > 0 };
}

export function resolveRoute(account, task, options = {}) {
  const { tier, reasons, cascaded } = tierForTask(task, options);
  const config = defaultRouterConfig(account);
  const route = config[tier] || config.balanced;
  return {
    tier,
    provider: route.provider || null,
    model: route.model || null,
    reasons,
    cascaded
  };
}

export function modelForOpenAiGeneration(account, task = 'post-generation', options = {}) {
  const route = resolveRoute(account, task, options);
  if (route.provider === 'openai' && route.model) return { ...route };
  return {
    ...route,
    provider: 'openai',
    model: account?.generation?.model || process.env.OPENAI_MODEL || null
  };
}

export const __test = { TIERS, TASK_TIER, ESCALATION };
