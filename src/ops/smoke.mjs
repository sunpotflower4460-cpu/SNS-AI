import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { validateConfig } from '../validate-config.mjs';
import { scoreSnapshot } from '../analytics/scorer.mjs';
import { rankCandidates } from '../lib/strategy-rank.mjs';

export async function runKeylessSmoke() {
  const config = await loadConfig();
  const configErrors = validateConfig(config);
  assert.deepEqual(configErrors, [], `Config errors: ${configErrors.join('; ')}`);

  const peers = [
    { account: 'demo', platform: 'x', providerPostId: 'a', checkpointMinutes: 1440, metrics: { impressions: 1000, reposts: 10, bookmarks: 5, replies: 4 } },
    { account: 'demo', platform: 'x', providerPostId: 'b', checkpointMinutes: 1440, metrics: { impressions: 1200, reposts: 12, bookmarks: 6, replies: 5 } }
  ];
  const snapshot = { account: 'demo', platform: 'x', providerPostId: 'c', checkpointMinutes: 1440, metrics: { impressions: 2200, reposts: 40, bookmarks: 22, replies: 15 } };
  const scored = scoreSnapshot(snapshot, peers);
  assert.ok(scored.score > 50, 'A clearly stronger synthetic post should score above baseline.');

  const strategy = { featureStats: { hook: { curiosity: { n: 5, averageScore: 78, confidence: 0.9 }, generic: { n: 5, averageScore: 42, confidence: 0.9 } } } };
  const ranked = rankCandidates([
    { text: 'A', spreadPotential: 70, noveltyPotential: 55, features: { hook: 'generic' } },
    { text: 'B', spreadPotential: 70, noveltyPotential: 55, features: { hook: 'curiosity' } }
  ], strategy, { explore: false });
  assert.equal(ranked[0].text, 'B', 'Learned strategy should influence candidate ranking.');

  return {
    ok: true,
    checks: ['config', 'relative-performance-scoring', 'learned-candidate-ranking'],
    syntheticScore: scored.score,
    winner: ranked[0].text
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { console.log(JSON.stringify(await runKeylessSmoke(), null, 2)); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
