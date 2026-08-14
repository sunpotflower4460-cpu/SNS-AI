import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertAffiliateTrust, __test as trustTest } from '../src/monetization/trust.mjs';
import { loadAccounts } from '../src/lib/config.mjs';
import { __test as xTest } from '../src/providers/x.mjs';

const DISCLOSURE = '広告・アフィリエイトリンクを含みます。';
const account = () => ({
  platform: 'x',
  monetization: {
    affiliate: {
      enabled: true,
      maxShare: 0.2,
      minOrganicPostsBeforeFirst: 4,
      minOrganicPostsBetween: 4,
      cooldownHours: 48,
      requireExplicitDisclosure: true,
      requireBalancedRecommendation: true,
      requireAlternativeConsideration: true,
      requireXPaidPartnership: true,
      allowCommissionInRanking: false
    }
  }
});
const commercial = (extra={}) => ({
  affiliate: true,
  disclosure: DISCLOSURE,
  balancedRecommendation: true,
  alternativeConsidered: true,
  paidPartnership: true,
  ...extra
});
const published = (index, affiliate=false) => ({
  timestamp: new Date(Date.UTC(2026,7,1+index)).toISOString(),
  status: 'published',
  commercial: affiliate ? commercial() : { affiliate: false }
});

test('affiliate trust guard requires explicit disclosure', () => {
  assert.throws(() => assertAffiliateTrust({ accountId: 'music-tools-x', account: account(), text: 'no disclosure', commercial: commercial({ disclosure: '' }), history: [published(0),published(1),published(2),published(3)], now: new Date('2026-08-10T00:00:00.000Z') }), /disclosure/i);
});

test('affiliate trust guard enforces organic runway and spacing', () => {
  assert.throws(() => assertAffiliateTrust({ accountId: 'music-tools-x', account: account(), text: DISCLOSURE, commercial: commercial(), history: [published(0),published(1)], now: new Date('2026-08-10T00:00:00.000Z') }), /organic/i);
  const history = [published(0),published(1),published(2),published(3),published(4,true),published(5)];
  assert.throws(() => assertAffiliateTrust({ accountId: 'music-tools-x', account: account(), text: DISCLOSURE, commercial: commercial(), history, now: new Date('2026-08-07T00:00:00.000Z') }), /organic/i);
});

test('affiliate trust guard enforces cooldown and share cap', () => {
  const cooldown = [published(0),published(1),published(2),published(3),published(4,true),published(5),published(6),published(7),published(8)];
  assert.throws(() => assertAffiliateTrust({ accountId: 'music-tools-x', account: account(), text: DISCLOSURE, commercial: commercial(), history: cooldown, now: new Date('2026-08-06T00:00:00.000Z') }), /cooldown/i);
  const share = Array.from({length:10},(_,i)=>published(i,i===0||i===5));
  assert.throws(() => assertAffiliateTrust({ accountId: 'music-tools-x', account: account(), text: DISCLOSURE, commercial: commercial(), history: share, now: new Date('2026-08-20T00:00:00.000Z') }), /share/i);
});

test('affiliate trust guard requires balance and alternative consideration', () => {
  const history=[published(0),published(1),published(2),published(3)];
  assert.throws(() => assertAffiliateTrust({ accountId:'music-tools-x',account:account(),text:DISCLOSURE,commercial:commercial({balancedRecommendation:false}),history,now:new Date('2026-08-10T00:00:00.000Z') }), /balanced/i);
  assert.throws(() => assertAffiliateTrust({ accountId:'music-tools-x',account:account(),text:DISCLOSURE,commercial:commercial({alternativeConsidered:false}),history,now:new Date('2026-08-10T00:00:00.000Z') }), /alternative/i);
});

test('affiliate trust guard requires X paid partnership flag', () => {
  const history=[published(0),published(1),published(2),published(3)];
  assert.throws(() => assertAffiliateTrust({ accountId:'music-tools-x',account:account(),text:DISCLOSURE,commercial:commercial({paidPartnership:false}),history,now:new Date('2026-08-10T00:00:00.000Z') }), /paid partnership/i);
});

test('affiliate ranking never consumes commission fields', () => {
  assert.equal(trustTest.commissionRankingAllowed(account()), false);
  assert.equal(trustTest.commissionRankingAllowed({ monetization: { affiliate: { ...account().monetization.affiliate, allowCommissionInRanking: true } } }), false);
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

  // The Hub integration wraps the public publish entrypoint, while the original
  // publish implementation is preserved byte-for-byte in publish-core.mjs.
  // Keep this source-level regression assertion pointed at the implementation
  // that actually performs the affiliate trust check.
  const publishCoreSource = await readFile(new URL('../src/publish-core.mjs', import.meta.url), 'utf8');
  assert.match(publishCoreSource, /assertAffiliateTrust/);
  assert.match(publishCoreSource, /paidPartnership/);
});
