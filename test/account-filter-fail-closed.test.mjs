import test from 'node:test';
import assert from 'node:assert/strict';

import { runAutopilot } from '../src/orchestrate.mjs';
import { collectMetrics } from '../src/analytics/collector.mjs';
import { learnAll } from '../src/learning/learn.mjs';
import { refreshTrends } from '../src/research/trends.mjs';

test('account-filtered batch operations reject an unknown account before external work', async () => {
  const previousFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('network must not be called for an unknown account');
  };
  try {
    const operations = [
      ['autopilot', () => runAutopilot({ accountFilter: 'does-not-exist', force: true, dryRun: true })],
      ['metrics', () => collectMetrics({ accountFilter: 'does-not-exist' })],
      ['learning', () => learnAll({ accountFilter: 'does-not-exist' })],
      ['trends', () => refreshTrends({ accountFilter: 'does-not-exist', force: true })]
    ];
    for (const [name, operation] of operations) {
      await assert.rejects(operation(), /Unknown account "does-not-exist"/, `${name} should fail closed`);
    }
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
