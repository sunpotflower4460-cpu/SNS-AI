import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadAccounts } from '../src/lib/config.mjs';
import { assertAffiliateTrust, normalizeCommercial } from '../src/monetization/trust-guard.mjs';
import { __test as xTest } from '../src/providers/x.mjs';

const DISCLOSURE = '広告・アフィリエイトリンクを含みます';
const GOOD_RECOMMENDATION = {
  pros: ['用途が明確な人には便利'],
  cons: ['既存製品を持っている人には重複しうる'],
  alternativesConsidered: ['無料または非アフィリエイトの代替候補']
};

function account(overrides = {}) {
  return {
    platform: 'x',
    monetization: {
      affiliate: {
        enabled: true,
        maxShare: 0.2,
        windowPosts: 20,
        minOrganicPostsBeforeFirst: 4,
        minOrganicPostsBetween: 4,
        cooldownHours: 48,
        requireExplicitDisclosure: true,
        disclosureText: DISCLOSURE,
        requireBalancedRecommendation: true,
        requireAlternativeConsideration: true,
        requireXPaidPartnership: true,
        allowCommissionInRanking: false,
        ...overrides
      }
    }
  };
}

function commercial(overrides = {}) {
  return { kind: 'affiliate', recommendation: GOOD_RECOMMENDATION, ...overrides };
}

function published(index, kind = 'organic', at = `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`) {
  return { account: 'music-tools-x', status: 'published', at, commercial: { kind } };
}

function expectCode(code, fn) {
  assert.throws(fn, (error) => error?.code === code && error?.publishStage === 'preflight');
}

test('commercial metadata defaults to organic and rejects malformed kinds', () => {
  assert.deepEqual(normalizeCommercial(), { kind: 'organic', paidPartnership: false });
  expectCode('COMMERCIAL_METADATA_INVALID', () => normalizeCommercial([]));
  expectCode('COMMERCIAL_KIND_INVALID', () => normalizeCommercial({ kind: 'mystery' }));
});

test('organic publishing never becomes a paid partnership', () => {
  const result = assertAffiliateTrust({ accountId: 'music-tools-x', account: account(), text: '通常投稿', commercial: null });
  assert.equal(result.kind, 'organic');
  assert.equal(result.paidPartnership, false);
});

test('affiliate publishing fails closed while disabled or when commission can influence ranking', () => {
  expectCode('AFFILIATE_DISABLED', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account({ enabled: false }), text: DISCLOSURE, commercial: commercial(), history: [] }));
  expectCode('AFFILIATE_RANKING_UNSAFE', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account({ allowCommissionInRanking: true }), text: DISCLOSURE, commercial: commercial(), history: [] }));
});

test('affiliate disclosure must be explicit in the post itself', () => {
  expectCode('AFFILIATE_DISCLOSURE_CONFIG', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account({ disclosureText: '' }), text: '紹介', commercial: commercial(), history: [] }));
  expectCode('AFFILIATE_DISCLOSURE_MISSING', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account(), text: '便利そうなプラグインを紹介', commercial: commercial(), history: [] }));
});

test('affiliate recommendations must include benefits, trade-offs, and alternatives', () => {
  expectCode('AFFILIATE_BALANCE_MISSING', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account({ maxShare: 1 }), text: DISCLOSURE, commercial: commercial({ recommendation: { pros: [], cons: ['弱点'], alternativesConsidered: ['代替'] } }), history: [] }));
  expectCode('AFFILIATE_BALANCE_MISSING', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account({ maxShare: 1 }), text: DISCLOSURE, commercial: commercial({ recommendation: { pros: ['利点'], cons: [], alternativesConsidered: ['代替'] } }), history: [] }));
  expectCode('AFFILIATE_ALTERNATIVE_MISSING', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account({ maxShare: 1 }), text: DISCLOSURE, commercial: commercial({ recommendation: { pros: ['利点'], cons: ['弱点'], alternativesConsidered: [] } }), history: [] }));
});

test('invalid affiliate numeric limits fail closed', () => {
  expectCode('AFFILIATE_CONFIG_INVALID', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account({ maxShare: 'not-a-number' }), text: DISCLOSURE, commercial: commercial(), history: [] }));
  expectCode('AFFILIATE_CONFIG_INVALID', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account({ maxShare: 1, windowPosts: 1.5 }), text: DISCLOSURE, commercial: commercial(), history: [] }));
});

test('first affiliate post requires an organic foundation and stays below configured share', () => {
  const threeOrganic = [published(0), published(1), published(2)];
  expectCode('AFFILIATE_SHARE_LIMIT', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account(), text: DISCLOSURE, commercial: commercial(), history: threeOrganic }));
  expectCode('AFFILIATE_ORGANIC_FOUNDATION', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account({ maxShare: 1, minOrganicPostsBeforeFirst: 4 }), text: DISCLOSURE, commercial: commercial(), history: threeOrganic }));

  const fourOrganic = [...threeOrganic, published(3)];
  const result = assertAffiliateTrust({ accountId: 'music-tools-x', account: account(), text: `${DISCLOSURE}\n用途が合う人向けに紹介`, commercial: commercial(), history: fourOrganic, now: new Date('2026-08-10T00:00:00.000Z') });
  assert.equal(result.kind, 'affiliate');
  assert.equal(result.paidPartnership, true);
});

test('subsequent affiliate posts require organic spacing and cooldown', () => {
  const firstAffiliate = published(0, 'affiliate', '2026-08-10T00:00:00.000Z');
  const twoOrganic = [firstAffiliate, published(1), published(2)];
  expectCode('AFFILIATE_ORGANIC_GAP', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account({ maxShare: 1 }), text: DISCLOSURE, commercial: commercial(), history: twoOrganic, now: new Date('2026-08-13T00:00:00.000Z') }));

  const enoughOrganic = [firstAffiliate];
  for (let index = 1; index <= 8; index += 1) enoughOrganic.push(published(index, 'organic', `2026-08-10T${String(index).padStart(2, '0')}:00:00.000Z`));
  expectCode('AFFILIATE_COOLDOWN', () => assertAffiliateTrust({ accountId: 'music-tools-x', account: account(), text: DISCLOSURE, commercial: commercial(), history: enoughOrganic, now: new Date('2026-08-11T00:00:00.000Z') }));

  const result = assertAffiliateTrust({ accountId: 'music-tools-x', account: account(), text: DISCLOSURE, commercial: commercial(), history: enoughOrganic, now: new Date('2026-08-13T00:00:00.000Z') });
  assert.equal(result.paidPartnership, true);
});

test('non-X affiliate can pass trust guard without X paid partnership flag', () => {
  const instagram = { ...account(), platform: 'instagram' };
  const history = [published(0), published(1), published(2), published(3)];
  const result = assertAffiliateTrust({ accountId: 'music-tools-x', account: instagram, text: DISCLOSURE, commercial: commercial(), history, now: new Date('2026-08-10T00:00:00.000Z') });
  assert.equal(result.paidPartnership, false);
});

test('X create-post payload emits official paid_partnership only when requested', () => {
  assert.deepEqual(xTest.createPostPayload({ text: 'organic' }), { text: 'organic' });
  assert.deepEqual(xTest.createPostPayload({ text: 'affiliate', mediaIds: ['123'], paidPartnership: true }), {
    text: 'affiliate',
    media: { media_ids: ['123'] },
    paid_partnership: true
  });
});

test('music-tools-x inherits trust defaults but remains commercially disabled', async () => {
  const accounts = await loadAccounts();
  const affiliate = accounts['music-tools-x'].monetization.affiliate;
  assert.equal(affiliate.enabled, false);
  assert.equal(affiliate.maxShare, 0.2);
  assert.equal(affiliate.minOrganicPostsBeforeFirst, 4);
  assert.equal(affiliate.minOrganicPostsBetween, 4);
  assert.equal(affiliate.cooldownHours, 48);
  assert.equal(affiliate.requireExplicitDisclosure, true);
  assert.equal(affiliate.requireBalancedRecommendation, true);
  assert.equal(affiliate.requireAlternativeConsideration, true);
  assert.equal(affiliate.requireXPaidPartnership, true);
  assert.equal(affiliate.allowCommissionInRanking, false);

  const publishCoreSource = await readFile(new URL('../src/publish-core.mjs', import.meta.url), 'utf8');
  assert.match(publishCoreSource, /assertAffiliateTrust/);
  assert.match(publishCoreSource, /paidPartnership/);
});
