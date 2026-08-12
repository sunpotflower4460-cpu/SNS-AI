import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDueCheckpoint } from '../src/analytics/checkpoints.mjs';
import { metricVector, scoreSnapshot } from '../src/analytics/scorer.mjs';
import { buildStrategy } from '../src/learning/learn.mjs';
import { rankCandidates, shouldExplore } from '../src/lib/strategy-rank.mjs';

test('checkpoint advances without duplicating captured stages', () => {
  const now = new Date('2026-08-12T10:00:00Z'); const publishedAt = '2026-08-12T03:00:00Z';
  assert.equal(nextDueCheckpoint({ publishedAt, now, checkpoints: [60, 360, 1440], snapshots: [] }).checkpointMinutes, 60);
  assert.equal(nextDueCheckpoint({ publishedAt, now, checkpoints: [60, 360, 1440], snapshots: [{ checkpointMinutes: 60 }] }).checkpointMinutes, 360);
});

test('metric vector uses rates so account size is not the only signal', () => {
  const v = metricVector({ metrics: { impressions: 1000, reposts: 20, quotes: 5, bookmarks: 10, replies: 10, profileClicks: 20 } });
  assert.equal(v.shareRate, 0.025); assert.equal(v.saveRate, 0.01); assert.equal(v.profileRate, 0.02);
});

test('performance score rewards a post above its own baseline', () => {
  const peers = [{ account: 'a', platform: 'x', providerPostId: 'old', checkpointMinutes: 1440, metrics: { impressions: 1000, reposts: 10, bookmarks: 5, replies: 5, profileClicks: 5, urlClicks: 2 } }];
  const current = { account: 'a', platform: 'x', providerPostId: 'new', checkpointMinutes: 1440, metrics: { impressions: 2000, reposts: 40, bookmarks: 20, replies: 20, profileClicks: 30, urlClicks: 10 } };
  assert.ok(scoreSnapshot(current, peers).score > 50);
});

test('learning aggregates feature lift without changing identity', () => {
  const account = { platform: 'x', timezone: 'Asia/Tokyo', learning: { matureCheckpointMinutes: 1440, minSamplesPerPattern: 1 }, objectives: {} };
  const history = [
    { account: 'a', providerPostId: '1', at: '2026-08-10T00:00:00Z', features: { hook: 'story', topic: 'ai' } },
    { account: 'a', providerPostId: '2', at: '2026-08-11T00:00:00Z', features: { hook: 'question', topic: 'ai' } }
  ];
  const snapshots = [
    { account: 'a', platform: 'x', providerPostId: '1', checkpointMinutes: 1440, metrics: { impressions: 2000, reposts: 50 } },
    { account: 'a', platform: 'x', providerPostId: '2', checkpointMinutes: 1440, metrics: { impressions: 500, reposts: 1 } }
  ];
  const strategy = buildStrategy({ accountId: 'a', account, history, snapshots });
  assert.equal(strategy.sampleSize, 2); assert.ok(strategy.featureStats.hook.story);
});

test('candidate ranking changes between exploit and exploration', () => {
  const strategy = { featureStats: { hook: { proven: { n: 5, averageScore: 90, confidence: 1 }, new: { n: 1, averageScore: 50, confidence: 0.1 } } } };
  const candidates = [
    { text: 'a', spreadPotential: 70, noveltyPotential: 20, features: { hook: 'proven' } },
    { text: 'b', spreadPotential: 72, noveltyPotential: 100, features: { hook: 'new' } }
  ];
  assert.equal(rankCandidates(candidates, strategy, { explore: false })[0].text, 'a');
  assert.equal(rankCandidates(candidates, strategy, { explore: true })[0].text, 'b');
  assert.equal(shouldExplore('same-slot', 0), false); assert.equal(shouldExplore('same-slot', 1), true);
});
