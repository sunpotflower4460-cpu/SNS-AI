import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetState, remainingBudget, operationAllowed, classifyCostType, sumKnownUsd, projectedMonthEndCost } from '../src/budget/governor.mjs';
import { reallocate } from '../src/budget/allocation.mjs';
import { decideUrlInvestment, expectedUrlValue } from '../src/budget/url-intelligence.mjs';
import { buildGovernorSnapshot } from '../src/budget/snapshot.mjs';

const policy = {
  monthlyBudgetUsd: 20,
  warningThreshold: 0.7,
  conservativeThreshold: 0.85,
  hardStopThreshold: 0.95
};

test('$20 budget stays healthy in normal operation', () => {
  assert.equal(budgetState(5, policy), 'healthy');
  assert.equal(remainingBudget(5, policy).remainingUsd, 15);
});

test('70% is warning, 85% conservative, 95% critical, 100% stopped', () => {
  assert.equal(budgetState(14, policy), 'warning');
  assert.equal(budgetState(17, policy), 'conservative');
  assert.equal(budgetState(19, policy), 'critical');
  assert.equal(budgetState(20, policy), 'stopped');
  assert.equal(budgetState(21, policy), 'stopped');
});

test('conservative and critical block expensive ops but not safety or free ops', () => {
  assert.equal(operationAllowed({ operation: 'image-generation', state: 'warning' }).allowed, true);
  assert.equal(operationAllowed({ operation: 'image-generation', state: 'conservative' }).allowed, false);
  assert.equal(operationAllowed({ operation: 'web-search', state: 'critical' }).allowed, false);
  assert.equal(operationAllowed({ operation: 'moderation', state: 'stopped' }).allowed, true);
  assert.equal(operationAllowed({ operation: 'entity-verification', state: 'stopped' }).allowed, true);
  assert.equal(operationAllowed({ operation: 'brand-card', state: 'stopped' }).allowed, true);
  assert.equal(operationAllowed({ operation: 'openai-generation', state: 'stopped' }).allowed, false);
  assert.equal(operationAllowed({ operation: 'paid-ai-generation', state: 'stopped' }).allowed, false);
  assert.equal(operationAllowed({ operation: 'post-generation', state: 'stopped' }).allowed, false);
  assert.equal(operationAllowed({ operation: 'post-generation', state: 'critical' }).allowed, true);
  assert.equal(operationAllowed({ operation: 'paid-ai-generation', state: 'critical' }).allowed, true);
  assert.equal(operationAllowed({ operation: 'balanced-model', state: 'critical' }).allowed, true);
  assert.equal(operationAllowed({ operation: 'high-model', state: 'critical' }).allowed, false);
  assert.equal(operationAllowed({ operation: 'critical-model', state: 'conservative' }).allowed, false);
});

test('actual, estimated, and unknown cost types stay distinct', () => {
  assert.equal(classifyCostType({ actualUsd: 3 }).costType, 'actual');
  assert.equal(classifyCostType({ estimatedUsd: 4 }).costType, 'estimated');
  assert.equal(classifyCostType({ unknown: true }).costType, 'unknown');
  const summed = sumKnownUsd([
    { usd: 3, costType: 'actual' },
    { usd: 4, costType: 'estimated' },
    { usd: 0, costType: 'unknown' }
  ]);
  assert.equal(summed.actualUsd, 3);
  assert.equal(summed.estimatedUsd, 4);
  assert.equal(summed.accountedUsd, 7);
  assert.equal(summed.unknownCount, 1);
});

test('governor snapshot prices cost-report readOperations as Posts Read $0.005', () => {
  const snapshot = buildGovernorSnapshot({
    policy: { monthlyBudgetUsd: 8, warningThreshold: 0.7, conservativeThreshold: 0.85, hardStopThreshold: 0.95 },
    pricing: { monthlyBaseFeeUsd: 0, costPerUrlPostUsd: 0.20, costPerNonUrlPostUsd: 0.015, costPerReadOperationUsd: 0.005 },
    usageByAccount: { 'music-tools-x': { brandId: 'plugin-radar', platform: 'x' } },
    xByAccount: { 'music-tools-x': { urlPosts: 1, nonUrlPosts: 2, readOperations: 4 } },
    brands: [{ brandId: 'plugin-radar' }]
  });
  // 0.20 + 2*0.015 + 4*0.005 = 0.25
  assert.equal(snapshot.totalEstimatedUsd, 0.25);
  assert.equal(snapshot.monthlyBudgetUsd, 8);
  assert.equal(snapshot.budgetState, 'healthy');
});

test('zero pricing is unknown rather than a fabricated rate', () => {
  const snapshot = buildGovernorSnapshot({
    policy,
    pricing: { monthlyBaseFeeUsd: 0, costPerUrlPostUsd: 0, costPerNonUrlPostUsd: 0, costPerReadOperationUsd: 0 },
    usageByAccount: { 'music-tools-x': { brandId: 'plugin-radar', platform: 'x', openai: 2 } },
    xByAccount: { 'music-tools-x': { urlPosts: 2, nonUrlPosts: 4, readOperations: 1 } },
    brands: [{ brandId: 'plugin-radar' }, { brandId: 'artist' }, { brandId: 'brand-c' }]
  });
  assert.equal(snapshot.budgetState, 'healthy');
  assert.equal(snapshot.unknownCount > 0, true);
  assert.equal(snapshot.totalActualUsd, 0);
});

test('URL budget over cap converts or defers instead of blindly posting the URL', () => {
  const now = new Date('2026-08-31T12:00:00Z');
  const account = { schedule: { timezone: 'UTC' }, linkPolicy: { maxUrlPostsPerWeek: 1, maxUrlPostsPerDay: 1, purposes: [] } };
  const history = [{ account: 'music-tools-x', status: 'published', text: 'hello https://a.example', at: '2026-08-31T01:00:00Z' }];
  const over = decideUrlInvestment({
    accountId: 'music-tools-x',
    account,
    history,
    draft: { text: '続きはこちら https://b.example', features: { linkRequired: true, linkPurpose: 'highValueDiscovery' } },
    now
  });
  assert.equal(over.action === 'convert-to-no-link' || over.action === 'defer', true);
  assert.ok(expectedUrlValue({ predictedScore: 80, purpose: 'highValueDiscovery' }) > 40);
});

test('brand allocation cannot dump the whole budget on one brand', () => {
  const shares = reallocate({
    brands: [{ brandId: 'plugin-radar' }, { brandId: 'artist' }, { brandId: 'brand-c' }],
    scores: { 'plugin-radar': 100, artist: 1, 'brand-c': 1 },
    minExplorationShare: 0.15,
    maxBrandShare: 0.7
  });
  assert.ok(shares['plugin-radar'] <= 0.7 + 1e-9);
  assert.ok(shares.artist >= 0.15 / 3 - 1e-9);
  assert.ok(shares['brand-c'] >= 0.15 / 3 - 1e-9);
  const total = Object.values(shares).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 0.02);
});

test('month-end projection scales from elapsed days', () => {
  assert.equal(projectedMonthEndCost({ usedUsd: 10, elapsedDays: 15, monthDays: 30 }), 20);
});
