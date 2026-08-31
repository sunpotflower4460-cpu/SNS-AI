import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEditorialGuards } from '../src/editorial/guards.mjs';
import { assertConfirmedFacts, draftFactRisks, normalizeSourceRole, preferPrimaryFacts } from '../src/research/source-quality.mjs';
import { sourceLookupKeys, cacheAccountId } from '../src/research/shared.mjs';
import { resolveMediaDetailed } from '../src/lib/media.mjs';

test('unconfirmed prices and sale deadlines fail closed', () => {
  const risks = draftFactRisks('定価 $99、セールは今月末まで', { confirmation: 'unconfirmed' });
  assert.ok(risks.includes('unconfirmed-price'));
  assert.ok(risks.includes('unconfirmed-sale-deadline'));
  assert.throws(() => assertConfirmedFacts('¥12,000', {}), { code: 'UNCONFIRMED_FACTS' });
  assert.equal(normalizeSourceRole('primary'), 'primary');
  const facts = preferPrimaryFacts({ price: '0', version: '2.0' }, [{ sourceRole: 'primary' }]);
  assert.equal(facts.price.confirmation, 'primary');
});

test('editorial guards keep independent Plugin Radar posts and strip surplus URLs', async () => {
  const account = {
    platform: 'x',
    contentStrategy: 'plugin-radar',
    learning: { exploreRate: 0.2 },
    linkPolicy: { maxUrlPostsPerWeek: 0, maxUrlPostsPerDay: 0, purposes: [] },
    monetization: { affiliate: { enabled: false } },
    media: { strategy: 'none' },
    schedule: { timezone: 'UTC' }
  };
  const result = await evaluateEditorialGuards({
    accountId: 'music-tools-x',
    account,
    brand: { strategy: 'plugin-radar', urlBudget: { maxUrlPostsPerWeek: 3 } },
    draft: { text: '空間系を試す価値はある。買い足さなくてよい人もいる。', relationship: 'independent', predictedScore: 60 },
    history: [],
    slotId: 'music-tools-x:test',
    budgetState: 'healthy'
  });
  assert.equal(result.audit.contentStrategy, 'plugin-radar');
  assert.ok(result.route.tier);
});

test('hunter strategy on X with no verified media becomes a no-image post', async () => {
  const resolved = await resolveMediaDetailed('music-tools-x', {
    platform: 'x',
    profile: { audience: 'DTMer' },
    media: { strategy: 'hunter', qa: { enabled: false } }
  }, 'slot', { text: 'hello', entityName: 'Valhalla Supermassive', vendor: 'Valhalla DSP' });
  assert.equal(resolved.decision, 'none');
});

test('Instagram hunter without a hostable card fails closed instead of inventing a product image', async () => {
  await assert.rejects(
    () => resolveMediaDetailed('plugin-radar-instagram', {
      platform: 'instagram',
      media: { strategy: 'hunter', internalImageGeneration: false, qa: { enabled: false } }
    }, 'slot', { text: 'caption only' }),
    (error) => error.code === 'MEDIA_HUNTER_SKIP'
  );
});
test('shared research keys collapse X and Instagram onto one brand cache', () => {
  const brand = { brandId: 'plugin-radar', sharedResearchId: 'plugin-radar-research', accounts: { x: 'music-tools-x', instagram: 'plugin-radar-instagram' } };
  assert.equal(cacheAccountId(brand, 'plugin-radar-instagram'), 'plugin-radar-research');
  assert.deepEqual(sourceLookupKeys(brand, 'plugin-radar-instagram'), ['plugin-radar-instagram', 'plugin-radar', 'plugin-radar-research']);
});
