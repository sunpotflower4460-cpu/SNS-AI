import test from 'node:test';
import assert from 'node:assert/strict';

import { __test as analyticsTest } from '../src/analytics/collector.mjs';
import { assertPublicHttpsUrl } from '../src/lib/http.mjs';
import { resolveMediaDetailed } from '../src/lib/media.mjs';
import { brakeSettings } from '../src/ops/brake.mjs';
import { assertUsageBudget } from '../src/ops/budget.mjs';
import { circuitSettings } from '../src/ops/circuit.mjs';
import { validateStrictConfig } from '../src/validate-strict-config.mjs';

test('public HTTPS validation rejects local and private media targets', () => {
  for (const url of [
    'https://localhost/media',
    'https://127.0.0.1/media',
    'https://10.1.2.3/media',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/media'
  ]) {
    assert.throws(() => assertPublicHttpsUrl(url), /public network destination/);
  }
  assert.equal(assertPublicHttpsUrl('https://cdn.example.com/media.png').hostname, 'cdn.example.com');
});

test('media endpoint private target is rejected before any request or budget mutation', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('fetch must not run'); };
  try {
    await assert.rejects(
      resolveMediaDetailed('acct', {
        platform: 'x',
        budgets: { enabled: false },
        media: { strategy: 'endpoint', endpoint: 'https://127.0.0.1/generate', type: 'image' }
      }, 'slot-private-endpoint', { text: 'hello', features: { mediaDecision: 'generate' } }),
      /public network destination/
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('invalid or missing enabled budget limits fail closed instead of becoming unlimited', async () => {
  await assert.rejects(
    assertUsageBudget('acct', { schedule: { timezone: 'UTC' }, budgets: { enabled: true, openaiCallsPerDay: 'oops' } }, 'openai'),
    (error) => error?.code === 'BUDGET_CONFIG_INVALID'
  );
  await assert.rejects(
    assertUsageBudget('acct', { schedule: { timezone: 'UTC' }, budgets: { enabled: true } }, 'openai'),
    (error) => error?.code === 'BUDGET_CONFIG_INVALID'
  );
  const disabled = await assertUsageBudget('acct', { schedule: { timezone: 'UTC' }, budgets: { enabled: false } }, 'openai');
  assert.equal(disabled.disabled, true);
});

test('circuit breaker malformed settings fall back to protective defaults', () => {
  assert.deepEqual(circuitSettings({ failureThreshold: 'oops', cooldownMinutes: NaN }), {
    failureThreshold: 3,
    cooldownMinutes: 60
  });
  assert.deepEqual(circuitSettings({ failureThreshold: -1, cooldownMinutes: 0 }), {
    failureThreshold: 3,
    cooldownMinutes: 60
  });
});

test('anomaly brake malformed numeric settings fall back to safe defaults', () => {
  const cfg = brakeSettings({
    learning: { matureCheckpointMinutes: 'oops' },
    safety: { anomalyBrake: {
      minBaselinePosts: 'oops', minConfidence: 4, minExposure: NaN,
      severeScoreThreshold: NaN, lowScoreThreshold: 'oops', consecutiveLowPosts: 0,
      conversationSpikeMultiplier: -2, minimumConversationRate: 5, cooldownHours: NaN
    } }
  });
  assert.equal(cfg.matureCheckpointMinutes, 1440);
  assert.equal(cfg.minBaselinePosts, 5);
  assert.equal(cfg.minConfidence, 0.55);
  assert.equal(cfg.minExposure, 500);
  assert.equal(cfg.severeScoreThreshold, 12);
  assert.equal(cfg.lowScoreThreshold, 25);
  assert.equal(cfg.consecutiveLowPosts, 2);
  assert.equal(cfg.conversationSpikeMultiplier, 5);
  assert.equal(cfg.minimumConversationRate, 0.02);
  assert.equal(cfg.cooldownHours, 12);
});

test('analytics malformed or empty timing settings use protective runtime defaults', () => {
  assert.equal(analyticsTest.positiveSetting('oops', 30), 30);
  assert.equal(analyticsTest.positiveSetting(-1, 30), 30);
  assert.deepEqual(analyticsTest.checkpointSettings([]), [60, 360, 1440, 4320, 10080]);
  assert.deepEqual(analyticsTest.checkpointSettings(['oops']), [60, 360, 1440, 4320, 10080]);
  assert.deepEqual(analyticsTest.checkpointSettings([30, 60]), [30, 60]);
});

test('strict config rejects private media endpoints and analytics that silently disable collection', () => {
  const errors = validateStrictConfig({
    defaults: {
      mode: 'pause',
      analytics: { enabled: true, checkpointsMinutes: [], maxAgeDays: -1 },
      budgets: { enabled: false },
      media: { strategy: 'none' }
    },
    accounts: {
      acct: {
        platform: 'x',
        enabled: false,
        media: { strategy: 'endpoint', endpoint: 'https://127.0.0.1/generate' }
      }
    }
  });
  assert.ok(errors.some((error) => error.includes('analytics.checkpointsMinutes must contain at least one')));
  assert.ok(errors.some((error) => error.includes('analytics.maxAgeDays')));
  assert.ok(errors.some((error) => error.includes('media.endpoint must be a valid public HTTPS URL')));
});
