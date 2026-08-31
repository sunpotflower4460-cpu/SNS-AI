import { fileURLToPath } from 'node:url';
import { readJson } from '../lib/json-store.mjs';
import {
  assertOperationAllowed,
  loadBudgetPolicy,
  operationAllowed,
  remainingBudget
} from './governor.mjs';
import { estimateReservation } from './reservation.mjs';
import { constrainRouteForBudget, resolveRoute } from '../ai/router.mjs';

const COST_FILE = fileURLToPath(new URL('../../data/reports/cost.json', import.meta.url));

export function operationForTier(tier) {
  if (tier === 'high') return 'high-model';
  if (tier === 'critical') return 'critical-model';
  if (tier === 'cheap') return 'cheap-model';
  return 'balanced-model';
}

export async function loadBudgetSnapshot() {
  const policy = await loadBudgetPolicy();
  const prior = await readJson(COST_FILE, null);
  const usedUsd = Number(prior?.governor?.accountedUsd || 0);
  const remaining = remainingBudget(usedUsd, policy);
  return { policy, usedUsd, remaining, state: remaining.state };
}

export function preflightPaidGeneration({
  state = 'healthy',
  route = null,
  webSearch = false,
  imageGeneration = false,
  videoGeneration = false
} = {}) {
  const paid = assertOperationAllowed({ operation: 'paid-ai-generation', state, costType: 'estimated' });
  const tierOp = operationForTier(route?.tier || 'balanced');
  const model = assertOperationAllowed({ operation: tierOp, state, costType: 'estimated' });
  const search = webSearch
    ? operationAllowed({ operation: 'web-search', state, costType: 'estimated' })
    : { allowed: true, reason: 'not-requested' };
  if (webSearch && !search.allowed) {
    // Web search is expensive; generation may continue without it.
  }
  if (imageGeneration) assertOperationAllowed({ operation: 'image-generation', state, costType: 'estimated' });
  if (videoGeneration) assertOperationAllowed({ operation: 'video-generation', state, costType: 'estimated' });
  return {
    allowed: true,
    state,
    paid,
    model,
    webSearch: search,
    allowWebSearch: Boolean(webSearch && search.allowed)
  };
}

export function selectGenerationRoute(account, {
  task = 'post-generation',
  escalateReasons = [],
  budgetState = 'healthy'
} = {}) {
  const resolved = resolveRoute(account, task, { escalateReasons });
  const constrained = constrainRouteForBudget(resolved, budgetState, account);
  if (constrained.allowed === false) {
    const error = new Error(`Budget governor blocked generation: ${constrained.constraintReason}.`);
    error.code = 'BUDGET_GOVERNOR_BLOCKED';
    error.reason = constrained.constraintReason;
    error.state = budgetState;
    throw error;
  }
  return constrained;
}

export function buildGenerationPreflight(account, {
  budget,
  escalateReasons = [],
  webSearch = false
} = {}) {
  const state = budget?.state || 'healthy';
  const route = selectGenerationRoute(account, { budgetState: state, escalateReasons });
  const gate = preflightPaidGeneration({
    state,
    route,
    webSearch: Boolean(webSearch)
  });
  const reservation = estimateReservation({
    operation: 'post-generation',
    policy: budget?.policy || {},
    route
  });
  return {
    state,
    route,
    reservation,
    allowWebSearch: gate.allowWebSearch,
    order: ['budget-preflight', 'estimated-reservation', 'model-selection', 'generation']
  };
}

export const __test = { COST_FILE };
