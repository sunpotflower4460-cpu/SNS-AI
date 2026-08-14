import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAffiliateRegistry, matchAffiliatePrograms, programReadiness } from '../src/monetization/affiliate-registry.mjs';
import { buildImpactTrackingLinkRequest } from '../src/monetization/providers/impact.mjs';
import { assertAutomatedEngagementAllowed, prohibitedGrowthAutomation } from '../src/engagement/policy.mjs';

const registryUrl = new URL('../config/affiliate-programs.json', import.meta.url);

test('affiliate program registry is valid and stays application-gated', async () => {
  const registry = JSON.parse(await readFile(registryUrl, 'utf8'));
  assert.deepEqual(validateAffiliateRegistry(registry), []);
  assert.ok(registry.programs.length >= 10);
  assert.equal(registry.programs.some((program) => program.status === 'approved'), false);
  assert.equal(matchAffiliatePrograms(registry, 'Native Instruments')[0]?.provider, 'impact');
});

test('affiliate readiness cannot become live before approval and manual verification', () => {
  const program = {
    id: 'demo', name: 'Demo', provider: 'impact', status: 'application_required',
    requiredSecrets: ['IMPACT_ACCOUNT_SID'], requiredManualValues: ['impactProgramId'], reverifyBeforeActivation: true
  };
  const readiness = programReadiness(program, { env: { IMPACT_ACCOUNT_SID: 'sid' }, manualValues: { demo: { impactProgramId: '42' } } });
  assert.equal(readiness.readyForLiveLinking, false);
  assert.equal(readiness.approved, false);
});

test('Impact request builder produces official media-partner deep-link endpoint without leaking token into URL', () => {
  const request = buildImpactTrackingLinkRequest({
    accountSid: 'account-123', authToken: 'super-secret-token', programId: 'program-456',
    deepLink: 'https://example.com/product?a=1', mediaPartnerPropertyId: '789', subId1: 'post-123'
  });
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://api.impact.com');
  assert.match(url.pathname, /Mediapartners\/account-123\/Programs\/program-456\/TrackingLinks$/);
  assert.equal(url.searchParams.get('DeepLink'), 'https://example.com/product?a=1');
  assert.equal(url.searchParams.get('subId1'), 'post-123');
  assert.equal(request.url.includes('super-secret-token'), false);
  assert.match(request.options.headers.Authorization, /^Basic /);
});

test('engagement guard allows only opted-in inbound interaction when explicitly enabled', () => {
  const account = { engagement: { enabled: true, inboundOnly: true, autoReply: true, autoDmReply: true, approvalRequired: true, oneAutomatedResponsePerInteraction: true } };
  const allowed = assertAutomatedEngagementAllowed({ account, event: { kind: 'reply', inbound: true } });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.approvalRequired, true);
  assert.throws(() => assertAutomatedEngagementAllowed({ account, event: { kind: 'reply', inbound: false } }), { code: 'ENGAGEMENT_UNSOLICITED' });
  assert.throws(() => assertAutomatedEngagementAllowed({ account, event: { kind: 'dm', inbound: true, alreadyAutoResponded: true } }), { code: 'ENGAGEMENT_ALREADY_RESPONDED' });
  assert.throws(() => assertAutomatedEngagementAllowed({ account, event: { kind: 'reply', inbound: true, keywordDiscoveryOnly: true } }), { code: 'ENGAGEMENT_KEYWORD_COLD_REPLY' });
});

test('growth policy explicitly prohibits spam-prone automation', () => {
  assert.equal(prohibitedGrowthAutomation('auto_follow'), true);
  assert.equal(prohibitedGrowthAutomation('auto_unfollow'), true);
  assert.equal(prohibitedGrowthAutomation('cold_keyword_reply'), true);
  assert.equal(prohibitedGrowthAutomation('unsolicited_bulk_dm'), true);
  assert.equal(prohibitedGrowthAutomation('duplicate_cross_account_post'), true);
  assert.equal(prohibitedGrowthAutomation('inbound_reply'), false);
});
