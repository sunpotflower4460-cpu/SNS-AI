import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { countFetchesSince, recordInboundFetch } from '../src/engagement/store.mjs';
import {
  replyScopeFor,
  safeConfidenceThreshold,
  safeCooldownMinutes,
  safeDailyAutomationCap,
  validateEngagementPolicy
} from '../src/engagement/policy.mjs';

function validPolicy() {
  return {
    schemaVersion: 4,
    enabled: true,
    allowedAccounts: ['music-tools-x'],
    liveAccounts: [],
    xAutomationProfileComplianceConfirmedAccounts: [],
    xAiReplyBotApprovalRequiredAccounts: ['music-tools-x'],
    xAiReplyBotApprovalConfirmedAccounts: [],
    xAutomatedResponseOptOutText: '自動返信不要で停止できます。'
  };
}

test('engagement policy v4 requires typed account lists and an opt-out notice', () => {
  const policy = validPolicy();
  assert.equal(validateEngagementPolicy(policy), policy);

  assert.throws(
    () => validateEngagementPolicy({ ...policy, xAiReplyBotApprovalRequiredAccounts: 'music-tools-x' }),
    /must be an array/
  );
  assert.throws(
    () => validateEngagementPolicy({ ...policy, xAutomationProfileComplianceConfirmedAccounts: ['bad account'] }),
    /invalid account id/
  );
  assert.throws(
    () => validateEngagementPolicy({ ...policy, allowedAccounts: ['music-tools-x', 'music-tools-x'] }),
    /must not contain duplicate/
  );
  assert.throws(
    () => validateEngagementPolicy({ ...policy, xAutomatedResponseOptOutText: '   ' }),
    /non-empty string/
  );
});

test('engagement policy v4 rejects approval confirmation for an account not declared as requiring approval', () => {
  const policy = validPolicy();
  assert.throws(
    () => validateEngagementPolicy({ ...policy, xAiReplyBotApprovalConfirmedAccounts: ['other-x'] }),
    /not listed as required/
  );
});

test('legacy engagement policy shapes remain readable for migration compatibility', () => {
  const policy = { schemaVersion: 3, enabled: false };
  assert.equal(validateEngagementPolicy(policy), policy);
});

test('malformed automation limits reduce automation instead of removing the limit', () => {
  // These three knobs are the entire safety envelope for unattended replying. run.mjs used a bare
  // Number(), so "twelve" became NaN and every guard reading it evaluated false: `sentToday >= NaN`,
  // `confidence < NaN` and `cooldownDue > Date.now()` are all false. One typo produced unlimited
  // automated replies, no confidence floor and no per-actor cooldown - failing OPEN, the exact
  // opposite of the posting side's safeMaxPostsPerDay/safeMinMinutesBetweenPosts.
  for (const malformed of ['twelve', '', {}, [], true, Number.NaN, Infinity, -1]) {
    assert.equal(safeDailyAutomationCap(malformed, 12), 0, `daily cap must block on ${JSON.stringify(malformed)}`);
    assert.equal(safeCooldownMinutes(malformed, 30), Number.POSITIVE_INFINITY, `cooldown must defer on ${JSON.stringify(malformed)}`);
    assert.equal(safeConfidenceThreshold(malformed, 0.82), Number.POSITIVE_INFINITY, `threshold must escalate on ${JSON.stringify(malformed)}`);
  }
  // A confidence threshold is a 0..1 score; anything outside that range cannot be honoured.
  assert.equal(safeConfidenceThreshold(1.5, 0.82), Number.POSITIVE_INFINITY);

  // Valid values are untouched, and an unset value falls back to the documented default.
  assert.equal(safeDailyAutomationCap(12, 99), 12);
  assert.equal(safeDailyAutomationCap(0, 99), 0);
  assert.equal(safeCooldownMinutes(30, 99), 30);
  assert.equal(safeCooldownMinutes(0, 99), 0);
  assert.equal(safeConfidenceThreshold(0.82, 0.5), 0.82);
  assert.equal(safeDailyAutomationCap(null, 12), 12);
  assert.equal(safeCooldownMinutes(undefined, 30), 30);
  assert.equal(safeConfidenceThreshold(null, 0.82), 0.82);
});

test('engagement policy validation rejects malformed automation limits at load time', () => {
  const base = () => ({
    schemaVersion: 4,
    allowedAccounts: [], liveAccounts: [],
    xAutomationProfileComplianceConfirmedAccounts: [],
    xAiReplyBotApprovalRequiredAccounts: [], xAiReplyBotApprovalConfirmedAccounts: [],
    xAutomatedResponseOptOutText: 'stop'
  });
  assert.doesNotThrow(() => validateEngagementPolicy(base()));

  assert.throws(() => validateEngagementPolicy({ ...base(), maxAutomatedRepliesPerDay: 'twelve' }), /maxAutomatedRepliesPerDay/);
  assert.throws(() => validateEngagementPolicy({ ...base(), maxAutomatedRepliesPerDay: 1.5 }), /maxAutomatedRepliesPerDay/);
  assert.throws(() => validateEngagementPolicy({ ...base(), maxAutomatedDmRepliesPerDay: -1 }), /maxAutomatedDmRepliesPerDay/);
  assert.throws(() => validateEngagementPolicy({ ...base(), replyCooldownMinutes: '30min' }), /replyCooldownMinutes/);
  assert.throws(() => validateEngagementPolicy({ ...base(), minAutoReplyConfidence: 1.5 }), /minAutoReplyConfidence/);
  assert.throws(() => validateEngagementPolicy({ ...base(), autoReply: 'yes' }), /autoReply/);
  assert.throws(() => validateEngagementPolicy({ ...base(), replyScope: 'everything' }), /replyScope/);

  // A fractional cooldown is a legitimate duration, unlike a fractional post count.
  assert.doesNotThrow(() => validateEngagementPolicy({ ...base(), replyCooldownMinutes: 0.5 }));
});

test('reply scope defaults to our own threads and never widens by accident', () => {
  assert.equal(replyScopeFor({}), 'own-posts', 'unset must not mean "reply to every stranger"');
  assert.equal(replyScopeFor({ replyScope: 'all-mentionz' }), 'own-posts', 'a typo must narrow, not widen');
  assert.equal(replyScopeFor({ replyScope: null }), 'own-posts');
  assert.equal(replyScopeFor({ replyScope: 'own-posts' }), 'own-posts');
  assert.equal(replyScopeFor({ replyScope: 'all-mentions' }), 'all-mentions', 'the broad scope stays available as an explicit opt-in');
});



test('inbound fetch budget counts every provider read and fails closed when malformed', async (t) => {
  // The read itself is the billed event on X's pay-per-use pricing, and it is billed on every poll
  // whether or not anything new arrived. OpenAI spend is already capped inside openaiRequest via the
  // account budgets, but provider reads went straight through xOAuth2FetchJson/fetchJson with no
  // counter at all, so nothing bounded the one cost that accrues even on a completely quiet day.
  const statePath = fileURLToPath(new URL('../data/engagement-state.json', import.meta.url));
  const saved = await readFile(statePath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  t.after(async () => {
    if (saved == null) await rm(statePath, { force: true });
    else await writeFile(statePath, saved, 'utf8');
  });

  const account = `fetch-budget-${process.pid}`;
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  assert.equal(await countFetchesSince(account, since), 0);
  await recordInboundFetch(account, { channel: 'x' });
  await recordInboundFetch(account, { channel: 'x' });
  assert.equal(await countFetchesSince(account, since), 2, 'each provider read must be counted');

  // A read outside the window must not consume the current budget.
  assert.equal(await countFetchesSince(account, new Date(Date.now() + 60_000)), 0);

  // The budget uses the same fail-closed coercion as the reply caps: a malformed value stops polling
  // rather than removing the ceiling.
  assert.equal(safeDailyAutomationCap('lots', 48), 0);
  assert.equal(safeDailyAutomationCap(48, 12), 48);
});
