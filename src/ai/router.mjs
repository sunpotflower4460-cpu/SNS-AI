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
    cascaded,
    escalationReason: reasons[0] || null
  };
}

export function constrainRouteForBudget(route, state = 'healthy', account = {}) {
  if (state === 'stopped') {
    return { ...route, allowed: false, constrained: true, constraintReason: 'budget-stopped' };
  }
  if ((state === 'conservative' || state === 'critical') && (route?.tier === 'high' || route?.tier === 'critical')) {
    const config = defaultRouterConfig(account);
    const balanced = config.balanced || {};
    return {
      tier: 'balanced',
      provider: balanced.provider || 'openai',
      model: balanced.model || account?.ai?.openaiTriageModel || null,
      reasons: route.reasons || [],
      cascaded: route.cascaded || false,
      escalationReason: route.escalationReason || null,
      allowed: true,
      constrained: true,
      constraintReason: `budget-${state}-downgrade-from-${route.tier}`,
      originalTier: route.tier
    };
  }
  return { ...route, allowed: true, constrained: false, constraintReason: null };
}

export function modelForOpenAiGeneration(account, task = 'post-generation', options = {}) {
  const route = constrainRouteForBudget(
    resolveRoute(account, task, options),
    options.budgetState || 'healthy',
    account
  );
  if (route.provider === 'openai' && route.model) return { ...route };
  return {
    ...route,
    provider: 'openai',
    model: account?.generation?.model || process.env.OPENAI_MODEL || null
  };
}

export function resolveGenerationModel(account, context = {}) {
  const base = context.route || resolveRoute(account, context.task || 'post-generation', {
    escalateReasons: context.escalateReasons || []
  });
  const route = constrainRouteForBudget(base, context.budgetState || 'healthy', account);
  const model = route.model || account?.generation?.model || process.env.OPENAI_MODEL || 'gpt-5';
  return {
    route: {
      ...route,
      provider: route.provider || 'openai',
      model
    },
    model
  };
}

export const __test = { TIERS, TASK_TIER, ESCALATION };
