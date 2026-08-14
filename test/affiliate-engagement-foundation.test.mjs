import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAffiliateRegistry, matchAffiliatePrograms, programReadiness, registryReadiness } from '../src/monetization/affiliate-registry.mjs';
import { buildAffiliateReadinessReport } from '../src/monetization/affiliate-readiness.mjs';
import { buildImpactTrackingLinkRequest } from '../src/monetization/providers/impact.mjs';
import { assertAutomatedEngagementAllowed, prohibitedGrowthAutomation, normalizeEngagementEvent, loadEngagementPolicy, effectiveEngagementPolicy } from '../src/engagement/policy.mjs';
import { buildXMentionsUrl, buildXDmEventsUrl, buildXReplyPayload, buildXDmPayload, sendXReply, sendXDirectMessage } from '../src/engagement/providers/x.mjs';
import { buildInstagramCommentsUrl, buildInstagramCommentReplyPayload, buildInstagramPrivateReplyPayload, buildInstagramDmPayload, sendInstagramCommentReply, sendInstagramPrivateReply, sendInstagramDm } from '../src/engagement/providers/instagram.mjs';

const registryUrl = new URL('../config/affiliate-programs.json', import.meta.url);

test('affiliate program registry is valid and stays application-gated', async () => {
  const registry = JSON.parse(await readFile(registryUrl, 'utf8'));
  assert.deepEqual(validateAffiliateRegistry(registry), []);
  assert.ok(registry.programs.length >= 10);
  assert.equal(registry.programs.some((program) => program.status === 'approved'), false);
  assert.equal(matchAffiliatePrograms(registry, 'Native Instruments')[0]?.provider, 'impact');
  assert.equal(matchAffiliatePrograms(registry, 'not-a-real-brand').length, 0);
  assert.equal(registryReadiness(registry, { env: {}, manualValues: {} }).length, registry.programs.length);
});

test('affiliate readiness cannot become live before approval and manual verification', async () => {
  const program = {
    id: 'demo', name: 'Demo', provider: 'impact', status: 'application_required',
    requiredSecrets: ['IMPACT_ACCOUNT_SID'], requiredManualValues: ['impactProgramId'], reverifyBeforeActivation: true
  };
  const readiness = programReadiness(program, { env: { IMPACT_ACCOUNT_SID: 'sid' }, manualValues: { demo: { impactProgramId: '42' } } });
  assert.equal(readiness.readyForLiveLinking, false);
  assert.equal(readiness.approved, false);
  const report = await buildAffiliateReadinessReport({ env: {}, manualValues: {} });
  assert.equal(report.summary.readyForLiveLinking, 0);
  assert.equal(report.summary.approvedPrograms, 0);
  assert.equal(report.summary.applicationRequired, report.summary.totalPrograms);
});

test('affiliate registry validator rejects unsupported providers and duplicate ids', () => {
  const bad = { programs: [
    { id: 'x', provider: 'bad', status: 'application_required', brands: ['X'], officialProgramUrl: 'http://bad', requiredSecrets: [], requiredManualValues: [] },
    { id: 'x', provider: 'manual', status: 'mystery', brands: [], officialProgramUrl: '', requiredSecrets: 'no', requiredManualValues: 'no' }
  ] };
  const errors = validateAffiliateRegistry(bad);
  assert.ok(errors.some((error) => error.includes('provider')));
  assert.ok(errors.some((error) => error.includes('duplicates')));
  assert.ok(errors.some((error) => error.includes('status')));
});

test('Impact request builder produces official media-partner deep-link endpoint without leaking token into URL', () => {
  const request = buildImpactTrackingLinkRequest({
    accountSid: 'account-123', authToken: 'super-secret-token', programId: 'program-456',
    deepLink: 'https://example.com/product?a=1', mediaPartnerPropertyId: '789', subId1: 'post-123', sharedId: 'slot-1'
  });
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://api.impact.com');
  assert.match(url.pathname, /Mediapartners\/account-123\/Programs\/program-456\/TrackingLinks$/);
  assert.equal(url.searchParams.get('DeepLink'), 'https://example.com/product?a=1');
  assert.equal(url.searchParams.get('subId1'), 'post-123');
  assert.equal(url.searchParams.get('sharedId'), 'slot-1');
  assert.equal(request.url.includes('super-secret-token'), false);
  assert.match(request.options.headers.Authorization, /^Basic /);
  assert.throws(() => buildImpactTrackingLinkRequest({ accountSid: 'a', authToken: 'b', programId: 'c', deepLink: 'http://example.com' }), /HTTPS/);
});

test('global engagement policy is fail-closed and can be overridden only explicitly per account', async () => {
  const globalPolicy = await loadEngagementPolicy();
  assert.equal(globalPolicy.enabled, false);
  assert.equal(globalPolicy.inboundOnly, true);
  assert.equal(globalPolicy.autoReply, false);
  assert.equal(globalPolicy.autoDmReply, false);
  const effective = effectiveEngagementPolicy(globalPolicy, { engagement: { enabled: true, autoReply: true } });
  assert.equal(effective.enabled, true);
  assert.equal(effective.autoReply, true);
  assert.equal(effective.autoDmReply, false);
  assert.equal(effective.inboundOnly, true);
});

test('engagement guard allows only opted-in inbound interaction when explicitly enabled', () => {
  const account = { engagement: { enabled: true, inboundOnly: true, autoReply: true, autoDmReply: true, approvalRequired: true, oneAutomatedResponsePerInteraction: true } };
  const allowed = assertAutomatedEngagementAllowed({ account, event: { kind: 'reply', inbound: true } });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.approvalRequired, true);
  assert.equal(normalizeEngagementEvent({ kind: 'dm', inbound: true }).kind, 'dm');
  assert.throws(() => assertAutomatedEngagementAllowed({ account, event: { kind: 'reply', inbound: false } }), { code: 'ENGAGEMENT_UNSOLICITED' });
  assert.throws(() => assertAutomatedEngagementAllowed({ account, event: { kind: 'dm', inbound: true, alreadyAutoResponded: true } }), { code: 'ENGAGEMENT_ALREADY_RESPONDED' });
  assert.throws(() => assertAutomatedEngagementAllowed({ account, event: { kind: 'reply', inbound: true, keywordDiscoveryOnly: true } }), { code: 'ENGAGEMENT_KEYWORD_COLD_REPLY' });
  assert.throws(() => assertAutomatedEngagementAllowed({ account, event: { kind: 'dm', inbound: true, sensitive: true } }), { code: 'ENGAGEMENT_HUMAN_REQUIRED' });
  assert.throws(() => assertAutomatedEngagementAllowed({ account: { engagement: { enabled: false } }, event: { kind: 'reply', inbound: true } }), { code: 'ENGAGEMENT_DISABLED' });
});

test('growth policy explicitly prohibits spam-prone automation', () => {
  assert.equal(prohibitedGrowthAutomation('auto_follow'), true);
  assert.equal(prohibitedGrowthAutomation('auto_unfollow'), true);
  assert.equal(prohibitedGrowthAutomation('cold_keyword_reply'), true);
  assert.equal(prohibitedGrowthAutomation('unsolicited_bulk_dm'), true);
  assert.equal(prohibitedGrowthAutomation('duplicate_cross_account_post'), true);
  assert.equal(prohibitedGrowthAutomation('inbound_reply'), false);
});

test('X engagement adapters build inbound lookup and dry-run send requests without network mutation', async () => {
  const mentions = new URL(buildXMentionsUrl({ userId: '123', sinceId: '456', maxResults: 200 }));
  assert.equal(mentions.pathname, '/2/users/123/mentions');
  assert.equal(mentions.searchParams.get('max_results'), '100');
  assert.equal(mentions.searchParams.get('since_id'), '456');
  const dms = new URL(buildXDmEventsUrl({ maxResults: 0 }));
  assert.equal(dms.pathname, '/2/dm_events');
  assert.equal(buildXReplyPayload({ postId: '99', text: 'Thanks!' }).reply.in_reply_to_tweet_id, '99');
  assert.equal(buildXDmPayload({ text: 'Hello' }).text, 'Hello');
  const dryReply = await sendXReply({ postId: '99', text: 'Thanks!' });
  assert.equal(dryReply.dryRun, true);
  const dryDm = await sendXDirectMessage({ participantId: '100', text: 'Hello' });
  assert.equal(dryDm.dryRun, true);
});

test('Instagram engagement adapters build comments, public replies, private replies and DMs as dry-runs', async () => {
  const comments = new URL(buildInstagramCommentsUrl({ mediaId: '123', apiVersion: 'v25.0', after: 'cursor' }));
  assert.equal(comments.pathname, '/v25.0/123/comments');
  assert.equal(comments.searchParams.get('after'), 'cursor');
  assert.deepEqual(buildInstagramCommentReplyPayload({ message: 'Thanks!' }), { message: 'Thanks!' });
  assert.equal(buildInstagramPrivateReplyPayload({ commentId: '456', message: 'DM' }).recipient.comment_id, '456');
  assert.equal(buildInstagramDmPayload({ recipientId: '789', message: 'Hello' }).recipient.id, '789');
  assert.equal((await sendInstagramCommentReply({ commentId: '456', message: 'Thanks!' })).dryRun, true);
  assert.equal((await sendInstagramPrivateReply({ igUserId: '1', commentId: '456', message: 'DM' })).dryRun, true);
  assert.equal((await sendInstagramDm({ igUserId: '1', recipientId: '789', message: 'Hello' })).dryRun, true);
});
