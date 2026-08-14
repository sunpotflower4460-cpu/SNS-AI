import test from 'node:test';
import assert from 'node:assert/strict';

import { __test as configTest } from '../src/lib/config.mjs';
import { assertPublicHttpsUrl, __test as httpTest } from '../src/lib/http.mjs';
import { __test as mediaTest } from '../src/lib/media.mjs';
import { __test as publishTest } from '../src/publish.mjs';
import { validateStrictConfig } from '../src/validate-strict-config.mjs';

test('private IPv4 embedded in IPv6 forms cannot bypass media target validation', () => {
  for (const url of [
    'https://[::ffff:c0a8:1]/media.png',
    'https://[::ffff:7f00:1]/media.png',
    'https://[::c0a8:1]/media.png',
    'https://[64:ff9b::c0a8:1]/media.png',
    'https://[2002:c0a8:101::]/media.png'
  ]) {
    assert.throws(() => assertPublicHttpsUrl(url), /public network destination/);
  }
  assert.equal(assertPublicHttpsUrl('https://[::ffff:808:808]/media.png').hostname, '[::ffff:808:808]');
});

test('DNS-pinned lookup never asks the resolver again and returns only captured public addresses', async () => {
  const lookup = httpTest.pinnedLookup([
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 }
  ]);
  const one = await new Promise((resolve, reject) => lookup('attacker.example', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(one, { address: '8.8.8.8', family: 4 });
  const all = await new Promise((resolve, reject) => lookup('attacker.example', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(all, [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 }
  ]);
});

test('published history can prove a stuck durable claim was already posted without crossing account/platform provenance', () => {
  const payload = { account: 'acct', slotId: 'acct:2026-08-14:08:00' };
  const account = { platform: 'x' };
  const history = [
    { status: 'published', account: 'other', platform: 'x', slotId: payload.slotId, providerPostId: 'wrong-account' },
    { status: 'published', account: 'acct', platform: 'instagram', slotId: payload.slotId, providerPostId: 'wrong-platform' },
    { status: 'published', account: 'acct', platform: 'x', slotId: payload.slotId, providerPostId: 'old' },
    { status: 'published', account: 'acct', platform: 'x', slotId: payload.slotId, providerPostId: 'latest' }
  ];
  assert.equal(publishTest.publishedHistoryEvidence(payload, account, history)?.providerPostId, 'latest');
  assert.equal(publishTest.publishedHistoryEvidence({ ...payload, slotId: 'missing' }, account, history), null);
});

test('partial nested account overrides preserve hard safety and quality defaults', () => {
  const defaults = {
    safety: { anomalyBrake: { enabled: true, cooldownHours: 12 } },
    generation: { naturalization: { enabled: true, deepReview: false, maxAiPatternRisk: 45 } },
    media: { qa: { enabled: true, selectedSemanticReview: false, minScore: 75 } }
  };
  const account = {
    safety: { anomalyBrake: { cooldownHours: 24 } },
    generation: { naturalization: { maxAiPatternRisk: 35 } },
    media: { qa: { minScore: 82 } }
  };
  assert.deepEqual(configTest.mergeSection(defaults, account, 'safety').anomalyBrake, { enabled: true, cooldownHours: 24 });
  assert.deepEqual(configTest.mergeSection(defaults, account, 'generation').naturalization, { enabled: true, deepReview: false, maxAiPatternRisk: 35 });
  assert.deepEqual(configTest.mergeSection(defaults, account, 'media').qa, { enabled: true, selectedSemanticReview: false, minScore: 82 });
});

test('selected-image QA is enabled by default and only explicit false disables it', () => {
  assert.equal(mediaTest.mediaQaEnabled({ media: {} }), true);
  assert.equal(mediaTest.mediaQaEnabled({ media: { qa: null } }), true);
  assert.equal(mediaTest.mediaQaEnabled({ media: { qa: { minScore: 82 } } }), true);
  assert.equal(mediaTest.mediaQaEnabled({ media: { qa: { enabled: true } } }), true);
  assert.equal(mediaTest.mediaQaEnabled({ media: { qa: { enabled: false } } }), false);
});

test('strict config validates new naturalization and selected-image semantic review settings', () => {
  const errors = validateStrictConfig({
    defaults: {
      mode: 'pause',
      analytics: { enabled: false },
      budgets: { enabled: false },
      safety: { anomalyBrake: { enabled: false } },
      generation: { naturalization: {
        enabled: 'true', deepReview: 'false', minNaturalness: 101,
        maxAiPatternRisk: -1, minVoiceFit: '68', maxIssues: 0, model: 123
      } },
      media: { strategy: 'none', qa: { enabled: true, selectedSemanticReview: 'false' } }
    },
    accounts: { acct: { platform: 'x', enabled: false } }
  });
  for (const expected of [
    'generation.naturalization.enabled must be a boolean',
    'generation.naturalization.deepReview must be a boolean',
    'generation.naturalization.minNaturalness must be a number in 0..100',
    'generation.naturalization.maxAiPatternRisk must be a number in 0..100',
    'generation.naturalization.minVoiceFit must be a number in 0..100',
    'generation.naturalization.maxIssues must be an integer 1..8',
    'generation.naturalization.model must be a string',
    'media.qa.selectedSemanticReview must be a boolean'
  ]) assert.ok(errors.some((error) => error.includes(expected)), `missing validation error: ${expected}`);
});

test('strict config rejects explicit null nested safety and quality objects', () => {
  const errors = validateStrictConfig({
    defaults: {
      mode: 'pause', analytics: { enabled: false }, budgets: { enabled: false },
      safety: { anomalyBrake: null }, generation: { naturalization: null },
      media: { strategy: 'none', qa: null }
    },
    accounts: { acct: { platform: 'x', enabled: false } }
  });
  assert.ok(errors.some((error) => error.includes('safety.anomalyBrake must be an object')));
  assert.ok(errors.some((error) => error.includes('generation.naturalization must be an object')));
  assert.ok(errors.some((error) => error.includes('media.qa must be an object')));
});
