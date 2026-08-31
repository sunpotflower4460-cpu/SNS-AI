import { readFile } from 'node:fs/promises';
import { readJson } from '../lib/json-store.mjs';

const POLICY_FILE = new URL('../../config/budget-policy.json', import.meta.url);
const X_PRICING_FILE = new URL('../../config/x-api-pricing.json', import.meta.url);

export const BUDGET_STATES = ['healthy', 'warning', 'conservative', 'critical', 'stopped'];

const EXPENSIVE = new Set(['image-generation', 'video-generation', 'web-search', 'high-model', 'critical-model', 'url-post', 'openai-generation']);
const PROTECTED = new Set(['safety', 'moderation', 'entity-verification', 'duplicate-check', 'factual-verification', 'manual-controls']);
const FREE = new Set(['direct-fetch', 'cache-hit', 'brand-card', 'entity-verification', 'duplicate-check']);

export async function loadBudgetPolicy() {
  return JSON.parse(await readFile(POLICY_FILE, 'utf8'));
}

export async function loadXPricing() {
  return readJson(X_PRICING_FILE, {
    monthlyBaseFeeUsd: 0,
    costPerUrlPostUsd: 0,
    costPerNonUrlPostUsd: 0,
    costPerReadOperationUsd: 0
  });
}

function line(amount, costType, source = null) {
  const usd = Number(amount);
  const finite = Number.isFinite(usd) ? usd : 0;
  return { usd: finite, costType, source, unknown: costType === 'unknown' };
}

export function classifyCostType({ actualUsd = null, estimatedUsd = null, unknown = false } = {}) {
  if (unknown) return line(0, 'unknown');
  if (actualUsd != null && Number.isFinite(Number(actualUsd))) return line(actualUsd, 'actual');
  if (estimatedUsd != null && Number.isFinite(Number(estimatedUsd))) return line(estimatedUsd, 'estimated');
  return line(0, 'unknown');
}

export function budgetState(usedUsd, policy) {
  const cap = Number(policy?.monthlyBudgetUsd);
  if (!Number.isFinite(cap) || cap <= 0) {
    const error = new Error('monthlyBudgetUsd must be a positive number.');
    error.code = 'BUDGET_POLICY_INVALID';
    throw error;
  }
  const ratio = usedUsd / cap;
  if (ratio >= 1) return 'stopped';
  if (ratio >= Number(policy.hardStopThreshold ?? 0.95)) return 'critical';
  if (ratio >= Number(policy.conservativeThreshold ?? 0.85)) return 'conservative';
  if (ratio >= Number(policy.warningThreshold ?? 0.7)) return 'warning';
  return 'healthy';
}

export function remainingBudget(usedUsd, policy) {
  const cap = Number(policy.monthlyBudgetUsd);
  return {
    capUsd: cap,
    usedUsd,
    remainingUsd: Math.max(0, Math.round((cap - usedUsd) * 100) / 100),
    ratio: cap ? usedUsd / cap : 0,
    state: budgetState(usedUsd, policy)
  };
}

export function projectedMonthEndCost({ usedUsd, elapsedDays, monthDays = 30 }) {
  const elapsed = Math.max(Number(elapsedDays) || 0, 1 / 24);
  const days = Math.max(Number(monthDays) || 30, elapsed);
  return Math.round((usedUsd / elapsed) * days * 100) / 100;
}

export function operationAllowed({ operation, state, costType = 'estimated' }) {
  if (PROTECTED.has(operation)) return { allowed: true, reason: 'protected' };
  if (FREE.has(operation)) return { allowed: true, reason: 'free' };
  if (state === 'stopped') return { allowed: false, reason: 'blocked-new-paid' };
  if (state === 'critical' && EXPENSIVE.has(operation)) return { allowed: false, reason: 'blocked-by-critical' };
  if (state === 'conservative' && EXPENSIVE.has(operation)) return { allowed: false, reason: 'conservative-expensive-block' };
  return { allowed: true, reason: 'within-budget', costType };
}

export function assertOperationAllowed(args) {
  const decision = operationAllowed(args);
  if (decision.allowed) return decision;
  const error = new Error(`Budget governor blocked ${args.operation}: ${decision.reason}.`);
  error.code = 'BUDGET_GOVERNOR_BLOCKED';
  error.reason = decision.reason;
  error.state = args.state;
  throw error;
}

export function sumKnownUsd(lines) {
  let actual = 0;
  let estimated = 0;
  let unknownCount = 0;
  for (const row of lines || []) {
    if (row.costType === 'actual') actual += Number(row.usd || 0);
    else if (row.costType === 'estimated') estimated += Number(row.usd || 0);
    else unknownCount += 1;
  }
  return {
    actualUsd: Math.round(actual * 100) / 100,
    estimatedUsd: Math.round(estimated * 100) / 100,
    accountedUsd: Math.round((actual + estimated) * 100) / 100,
    unknownCount,
    mixed: actual > 0 && estimated > 0
  };
}

export function nextCut(policy, alreadyCut = []) {
  const order = policy?.cutOrder || [];
  return order.find((item) => !alreadyCut.includes(item)) || null;
}

export const __test = { EXPENSIVE, PROTECTED, FREE, line };
