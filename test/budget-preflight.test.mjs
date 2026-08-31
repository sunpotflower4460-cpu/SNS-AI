import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateReservation, reservationAuditFields, RESERVATION_NOTE } from '../src/budget/reservation.mjs';
import { operationForTier, preflightPaidGeneration, selectGenerationRoute, buildGenerationPreflight, loadBudgetSnapshot } from '../src/budget/preflight.mjs';
import { operationAllowed } from '../src/budget/governor.mjs';

const policy = {
  operationEstimatesUsd: {
    openaiCall: { usd: 0, costType: 'unknown' },
    groqCall: { usd: 0, costType: 'unknown' },
    webSearch: { usd: 0.02, costType: 'estimated' }
  }
};

test('reservation is estimated, never an actual billing hold', () => {
  const unknown = estimateReservation({ operation: 'post-generation', policy, route: { provider: 'openai', tier: 'balanced' } });
  assert.equal(unknown.reservationKind, 'estimated');
  assert.equal(unknown.billingApi, false);
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.estimatedUsd, null);
  assert.match(unknown.note, /not an actual billing API/);
  const priced = estimateReservation({ operation: 'web-search', policy });
  assert.equal(priced.costType, 'estimated');
  assert.equal(priced.estimatedUsd, 0.02);
  const audit = reservationAuditFields(priced);
  assert.equal(audit.reservationKind, 'estimated');
  assert.equal(reservationAuditFields(null).reservationKind, null);
  assert.equal(RESERVATION_NOTE.includes('Estimated'), true);
});

test('preflight blocks paid generation at 100% and expensive tiers at 95% before any API call', () => {
  assert.equal(operationForTier('high'), 'high-model');
  assert.equal(operationForTier('critical'), 'critical-model');
  assert.equal(operationForTier('balanced'), 'balanced-model');
  assert.throws(
    () => preflightPaidGeneration({ state: 'stopped', route: { tier: 'balanced' } }),
    { code: 'BUDGET_GOVERNOR_BLOCKED' }
  );
  assert.throws(
    () => preflightPaidGeneration({ state: 'critical', route: { tier: 'high' } }),
    { code: 'BUDGET_GOVERNOR_BLOCKED' }
  );
  const ok = preflightPaidGeneration({ state: 'critical', route: { tier: 'balanced' }, webSearch: true });
  assert.equal(ok.allowed, true);
  assert.equal(ok.allowWebSearch, false);
  const healthySearch = preflightPaidGeneration({ state: 'healthy', route: { tier: 'balanced' }, webSearch: true });
  assert.equal(healthySearch.allowWebSearch, true);
  assert.throws(
    () => preflightPaidGeneration({ state: 'conservative', route: { tier: 'balanced' }, imageGeneration: true }),
    { code: 'BUDGET_GOVERNOR_BLOCKED' }
  );
});

test('model selection happens after budget preflight and does not pick expensive options when critical', () => {
  const account = {
    generation: { model: 'gpt-5' },
    ai: { groqModel: 'llama-3.1-8b-instant', openaiTriageModel: 'gpt-5-mini' }
  };
  const healthy = selectGenerationRoute(account, { escalateReasons: ['high-value-url-post'], budgetState: 'healthy' });
  assert.equal(healthy.tier, 'high');
  const critical = selectGenerationRoute(account, { escalateReasons: ['high-value-url-post'], budgetState: 'critical' });
  assert.equal(critical.tier, 'balanced');
  assert.equal(critical.model, 'gpt-5-mini');
  assert.throws(
    () => selectGenerationRoute(account, { budgetState: 'stopped' }),
    { code: 'BUDGET_GOVERNOR_BLOCKED' }
  );
  const built = buildGenerationPreflight(account, { budget: { state: 'warning', policy }, webSearch: true });
  assert.deepEqual(built.order, ['budget-preflight', 'estimated-reservation', 'model-selection', 'generation']);
  assert.equal(built.route.tier, 'balanced');
  assert.equal(built.reservation.billingApi, false);
});

test('loadBudgetSnapshot reads accounted estimates without inventing actuals', async () => {
  const snap = await loadBudgetSnapshot();
  assert.ok(['healthy', 'warning', 'conservative', 'critical', 'stopped'].includes(snap.state));
  assert.equal(typeof snap.usedUsd, 'number');
});

test('safety operations remain allowed when generation is stopped', () => {
  assert.equal(operationAllowed({ operation: 'moderation', state: 'stopped' }).allowed, true);
  assert.equal(operationAllowed({ operation: 'factual-verification', state: 'stopped' }).allowed, true);
  assert.equal(operationAllowed({ operation: 'manual-controls', state: 'stopped' }).allowed, true);
});
