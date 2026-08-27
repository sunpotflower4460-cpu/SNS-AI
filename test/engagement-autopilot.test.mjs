import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertAutomatedEngagementAllowed } from '../src/engagement/policy.mjs';
import {
  liveEngagementAccount,
  xAiReplyApprovalReady,
  xAiReplyApprovalRequired
} from '../src/engagement/readiness.mjs';
import { actorKey, eventKey, __test as storeTest } from '../src/engagement/store.mjs';
import { hardHumanCategory, __test as aiTest } from '../src/engagement/ai.mjs';
import { __test as runTest } from '../src/engagement/run.mjs';
import { runXAutomationCompliance, xAutomationComplianceRow } from '../src/ops/x-automation-compliance.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const account = { id: 'music-tools-x', platform: 'x', mode: 'approval' };
const policy = {
  enabled: true,
  allowedAccounts: ['music-tools-x'],
  liveAccounts: [],
  inboundOnly: true,
  autoReply: true,
  autoDmReply: true,
  approvalRequired: false,
  oneAutomatedResponsePerInteraction: true
};

test('allowlisted inbound replies can run without routine approval', () => {
  const result = assertAutomatedEngagementAllowed({
    account,
    globalPolicy: policy,
    event: { kind: 'reply', inbound: true, platform: 'x' }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.approvalRequired, false);
});

test('X AI public replies remain gated per account until explicit platform approval is recorded', () => {
  const gatedPolicy = {
    ...policy,
    xAiReplyBotApprovalRequiredAccounts: ['music-tools-x'],
    xAiReplyBotApprovalConfirmedAccounts: []
  };
  assert.equal(xAiReplyApprovalRequired(gatedPolicy, 'music-tools-x'), true);
  assert.equal(xAiReplyApprovalReady(gatedPolicy, 'music-tools-x'), false);
  assert.equal(xAiReplyApprovalReady(gatedPolicy, 'other'), true);

  const gated = assertAutomatedEngagementAllowed({
    account,
    globalPolicy: gatedPolicy,
    event: { kind: 'reply', inbound: true, platform: 'x' }
  });
  assert.equal(gated.allowed, true);
  assert.equal(gated.platformApprovalRequired, true);
  assert.equal(gated.approvalRequired, true);

  const approvedPolicy = { ...gatedPolicy, xAiReplyBotApprovalConfirmedAccounts: ['music-tools-x'] };
  const approved = assertAutomatedEngagementAllowed({
    account,
    globalPolicy: approvedPolicy,
    event: { kind: 'reply', inbound: true, platform: 'x' }
  });
  assert.equal(approved.platformApprovalRequired, false);
  assert.equal(approved.approvalRequired, false);

  const dm = assertAutomatedEngagementAllowed({
    account,
    globalPolicy: gatedPolicy,
    event: { kind: 'dm', inbound: true, platform: 'x' }
  });
  assert.equal(dm.platformApprovalRequired, false);
  assert.equal(dm.approvalRequired, false);
});

test('live engagement fails closed if an X AI reply account is activated before approval', () => {
  const gatedPolicy = {
    ...policy,
    liveAccounts: ['music-tools-x'],
    xAiReplyBotApprovalRequiredAccounts: ['music-tools-x'],
    xAiReplyBotApprovalConfirmedAccounts: []
  };
  assert.throws(() => liveEngagementAccount(gatedPolicy, 'music-tools-x'), (error) => error.code === 'ENGAGEMENT_PLATFORM_APPROVAL_REQUIRED');
  assert.equal(liveEngagementAccount({ ...gatedPolicy, xAiReplyBotApprovalConfirmedAccounts: ['music-tools-x'] }, 'music-tools-x'), true);
  assert.equal(liveEngagementAccount({ allowedAccounts: ['music-tools-x'] }, 'music-tools-x'), false, 'missing liveAccounts must fail closed');
  assert.equal(liveEngagementAccount({ allowedAccounts: ['music-tools-x'], liveAccounts: null }, 'music-tools-x'), false);
});

test('X automation compliance preflight blocks missing profile disclosure and AI reply approval', async () => {
  const gatedPolicy = {
    ...policy,
    xAutomationProfileComplianceConfirmedAccounts: [],
    xAiReplyBotApprovalRequiredAccounts: ['music-tools-x'],
    xAiReplyBotApprovalConfirmedAccounts: []
  };
  const blocked = xAutomationComplianceRow('music-tools-x', account, gatedPolicy);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blockers.map((row) => row.code), [
    'X_AUTOMATION_PROFILE_COMPLIANCE_UNCONFIRMED',
    'X_AI_REPLY_APPROVAL_UNCONFIRMED'
  ]);

  const ready = xAutomationComplianceRow('music-tools-x', account, {
    ...gatedPolicy,
    xAutomationProfileComplianceConfirmedAccounts: ['music-tools-x'],
    xAiReplyBotApprovalConfirmedAccounts: ['music-tools-x']
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.profileComplianceConfirmed, true);
  assert.equal(ready.aiReplyApprovalConfirmed, true);

  const instagram = xAutomationComplianceRow('ig', { id: 'ig', platform: 'instagram', mode: 'auto' }, gatedPolicy);
  assert.equal(instagram.checked, false);
  assert.equal(instagram.ok, true);

  const realConfigReport = await runXAutomationCompliance({ accountFilter: 'music-tools-x' });
  assert.equal(realConfigReport.ok, false);
  assert.equal(realConfigReport.accounts[0].account, 'music-tools-x');
  await assert.rejects(() => runXAutomationCompliance({ accountFilter: 'missing-account' }), /Unknown account/);
});

test('configured X opt-out notice is appended exactly once and not added off X', () => {
  const notice = '自動返信を止めたい場合は「自動返信不要」と送ってください。';
  const cfg = { xAutomatedResponseOptOutText: notice };
  assert.equal(aiTest.withRequiredXOptOut('ありがとうございます！', { platform: 'x', kind: 'reply' }, cfg), `ありがとうございます！\n\n${notice}`);
  assert.equal(aiTest.withRequiredXOptOut(`ありがとうございます！\n\n${notice}`, { platform: 'x', kind: 'reply' }, cfg), `ありがとうございます！\n\n${notice}`);
  assert.equal(aiTest.withRequiredXOptOut('ありがとうございます！', { platform: 'instagram', kind: 'reply' }, cfg), 'ありがとうございます！');
});

test('cold engagement and non-allowlisted accounts remain fail-closed', () => {
  assert.throws(() => assertAutomatedEngagementAllowed({ account, globalPolicy: policy, event: { kind: 'reply', inbound: false } }), /unsolicited/i);
  assert.throws(() => assertAutomatedEngagementAllowed({ account: { id: 'other', platform: 'x' }, globalPolicy: policy, event: { kind: 'reply', inbound: true } }), /allowlisted/i);
});

test('deterministic delay stays human-like and stable for an interaction', () => {
  const config = { replyDelayMinutes: [8, 35], dmDelayMinutes: [12, 50] };
  const a = runTest.deterministicDelayMinutes('abc', 'reply', config);
  const b = runTest.deterministicDelayMinutes('abc', 'reply', config);
  assert.equal(a, b);
  assert.ok(a >= 8 && a <= 35);
  const dm = runTest.deterministicDelayMinutes('abc', 'dm', config);
  assert.ok(dm >= 12 && dm <= 50);
});

test('privacy-safe event and actor keys do not embed provider ids or message text', () => {
  const event = { platform: 'x', kind: 'dm', id: '123456789', authorId: '998877', text: 'private message' };
  const eKey = eventKey('music-tools-x', event);
  const aKey = actorKey('music-tools-x', event);
  assert.match(eKey, /^[a-f0-9]{32}$/);
  assert.match(aKey, /^[a-f0-9]{32}$/);
  assert.equal(eKey.includes('123456789'), false);
  assert.equal(aKey.includes('998877'), false);
  assert.equal(eKey.includes('private'), false);
});

test('opt-out phrases are detected before generation', () => {
  assert.equal(runTest.optedOut('自動返信は不要です'), true);
  assert.equal(runTest.optedOut("don't reply again"), true);
  assert.equal(runTest.optedOut('ありがとう！'), false);
});

test('actor compaction preserves opted-out actors ahead of routine actor state', () => {
  const actors = {
    normal: { optedOut: false, updatedAt: '2099-01-02T00:00:00Z' },
    opted: { optedOut: true, updatedAt: '2020-01-01T00:00:00Z' }
  };
  const compacted = storeTest.compactActors(actors);
  assert.equal(Object.keys(compacted)[0], 'opted');
});

test('sent-log compaction drops stale rows while retaining recent cap evidence', () => {
  const now = Date.parse('2026-08-18T00:00:00Z');
  const rows = [
    { at: '2026-08-01T00:00:00Z', kind: 'reply' },
    { at: '2026-08-17T00:00:00Z', kind: 'reply' }
  ];
  assert.deepEqual(storeTest.compactSentLog(rows, now), [{ at: '2026-08-17T00:00:00Z', kind: 'reply' }]);
});

test('deterministic high-risk categories force human handling before model judgment', () => {
  assert.equal(hardHumanCategory('返金トラブルについて確認したいです'), 'refund_or_payment_dispute');
  assert.equal(hardHumanCategory('医師として診断して薬を教えてください'), 'medical');
  assert.equal(hardHumanCategory('カードの不正決済トラブルです'), 'financial_dispute');
  assert.equal(hardHumanCategory('アカウントが乗っ取られて二段階認証で困っています'), 'account_security');
  assert.equal(hardHumanCategory('契約書を送るのでスポンサー契約したいです'), 'legal');
  assert.equal(hardHumanCategory('普通におすすめを教えてください'), null);
});

test('business keywords escalate only when they actually request a commitment', () => {
  assert.equal(hardHumanCategory('この案件についてどう思いますか？'), null);
  assert.equal(hardHumanCategory('スポンサー機能って何ですか？'), null);
  assert.equal(hardHumanCategory('最近の企業提携ニュースをどう見ますか？'), null);
  assert.equal(hardHumanCategory('案件の依頼をしたいので条件を相談できますか？'), 'binding_partnership_or_contract');
  assert.equal(hardHumanCategory('スポンサー契約の相談をしたいです'), 'binding_partnership_or_contract');
  assert.equal(hardHumanCategory('We would like to partner with you.'), 'binding_partnership_or_contract');
});

test('AI parser accepts strict JSON and extracts fenced JSON fallback', () => {
  assert.deepEqual(aiTest.parseJson('{"action":"ignore"}'), { action: 'ignore' });
  assert.deepEqual(aiTest.parseJson('```json\n{"action":"reply"}\n```'), { action: 'reply' });
  const normalized = aiTest.normalizeResult({ action: 'human', confidence: 5, humanSummary: 'summary', humanQuestion: 'question' });
  assert.equal(normalized.action, 'human');
  assert.equal(normalized.confidence, 1);
  assert.equal(normalized.humanSummary, 'summary');
});

test('X engagement readiness requires write/read/DM/offline scopes and a refresh token', () => {
  assert.deepEqual(new Set(runTest.xRequiredScopes({ autoReply: true, autoDmReply: true })), new Set(['tweet.read', 'users.read', 'offline.access', 'tweet.write', 'dm.read', 'dm.write']));
  assert.throws(() => runTest.assertXEngagementCredential({ session: { scope: 'tweet.read users.read tweet.write', hasRefreshToken: true } }, policy), /missing required scopes/i);
  assert.throws(() => runTest.assertXEngagementCredential({ session: { scope: 'tweet.read users.read tweet.write dm.read dm.write offline.access', hasRefreshToken: false } }, policy), /refresh token/i);
  assert.doesNotThrow(() => runTest.assertXEngagementCredential({ session: { scope: 'tweet.read users.read tweet.write dm.read dm.write offline.access', hasRefreshToken: true } }, policy));
});

test('private dry-run decisions and failures omit free-text/provider details', () => {
  const event = { public: false, kind: 'dm' };
  const safe = runTest.privateSafeDecision(event, {
    action: 'human', confidence: 0.4, category: 'privacy_or_personal_data', response: 'secret response', reason: 'phone 090...', humanSummary: 'private name', humanQuestion: 'private question'
  });
  assert.deepEqual(safe, { action: 'human', confidence: 0.4, category: 'privacy_or_personal_data', privateContentOmitted: true });
  const error = Object.assign(new Error('failed for participant 123 and private@example.com'), { code: 'SEND_FAIL' });
  const safeError = runTest.safeEventError(error, event);
  assert.doesNotMatch(safeError, /123|private@example/);
  assert.match(safeError, /SEND_FAIL/);
});

test('X event normalization excludes the account itself and keeps inbound routes ephemeral', () => {
  // The mention here sits in a thread rooted at our own post 'own-1', which is what makes it eligible
  // at all - see the cold-mention test below.
  const events = runTest.xEvents('music-tools-x', '1', {
    data: [
      { id: '10', author_id: '2', text: 'hello', created_at: '2026-08-18T00:00:00Z', conversation_id: 'own-1' },
      { id: '11', author_id: '1', text: 'self', created_at: '2026-08-18T00:00:00Z', conversation_id: 'own-1' }
    ],
    includes: { users: [{ id: '2', username: 'listener' }] }
  }, {
    data: [
      { id: '20', event_type: 'MessageCreate', sender_id: '3', text: 'private', created_at: '2026-08-18T00:00:00Z' },
      { id: '21', event_type: 'MessageCreate', sender_id: '1', text: 'self dm', created_at: '2026-08-18T00:00:00Z' }
    ]
  }, { ownPostIds: new Set(['own-1']) });
  assert.equal(events.length, 2);
  assert.equal(events[0].public, true);
  assert.equal(events[1].public, false);
  assert.equal(events[1].participantId, '3');
});

test('X mentions outside our own threads are discarded instead of auto-replied', () => {
  // The mentions timeline returns every @-mention. Auto-replying to a stranger who never touched our
  // content is unsolicited outreach, which this repo's own policy lists under
  // prohibitedGrowthAutomation as "cold_keyword_reply". collectEvents already had `history` available
  // but the X branch ignored it, so cold mentions were being turned into reply events.
  const mentions = {
    data: [
      { id: '30', author_id: '2', text: 'reply on our post', created_at: '2026-08-18T00:00:00Z', conversation_id: 'own-1' },
      { id: '31', author_id: '2', text: 'deeper in our thread', created_at: '2026-08-18T00:00:00Z', conversation_id: 'own-1', referenced_tweets: [{ type: 'replied_to', id: '30' }] },
      { id: '32', author_id: '4', text: 'direct reply to our post', created_at: '2026-08-18T00:00:00Z', referenced_tweets: [{ type: 'replied_to', id: 'own-2' }] },
      { id: '33', author_id: '5', text: 'hey @us check out my thing', created_at: '2026-08-18T00:00:00Z', conversation_id: 'stranger-root' }
    ],
    includes: { users: [] }
  };
  const ownPostIds = new Set(['own-1', 'own-2']);

  const scoped = runTest.xEvents('music-tools-x', '1', mentions, { data: [] }, { ownPostIds });
  assert.deepEqual(scoped.map((event) => event.id), ['30', '31', '32'], 'only mentions inside our own threads are eligible');

  // With no published posts yet there is nothing to be a reply to, so nothing is eligible.
  const noHistory = runTest.xEvents('music-tools-x', '1', mentions, { data: [] }, { ownPostIds: new Set() });
  assert.deepEqual(noHistory, [], 'an account with no published posts must not auto-reply to anyone');

  // The broad scope stays available, but only as a deliberate opt-in.
  const broad = runTest.xEvents('music-tools-x', '1', mentions, { data: [] }, { ownPostIds, replyScope: 'all-mentions' });
  assert.deepEqual(broad.map((event) => event.id), ['30', '31', '32', '33']);
});

test('own X post ids come from published history only', () => {
  const ids = runTest.xOwnPostIds([
    { account: 'music-tools-x', status: 'published', providerPostId: 'a' },
    { account: 'other-account', status: 'published', providerPostId: 'b' },
    { account: 'music-tools-x', status: 'failed', providerPostId: 'c' },
    { account: 'music-tools-x', status: 'published', providerPostId: null },
    { account: 'music-tools-x', status: 'published', providerPostId: 'd' }
  ], 'music-tools-x');
  assert.deepEqual([...ids].sort(), ['a', 'd'], 'other accounts, failed posts and missing ids are excluded');
});

test('Instagram media discovery deduplicates recent published provider ids', () => {
  const ids = runTest.instagramMediaIds([
    { account: 'music-tools-x', status: 'published', providerPostId: '1' },
    { account: 'other', status: 'published', providerPostId: '2' },
    { account: 'music-tools-x', status: 'published', providerPostId: '1' },
    { account: 'music-tools-x', status: 'published', providerPostId: '3' }
  ], 'music-tools-x');
  assert.deepEqual(ids, ['3', '1']);
});

test('engagement workflow persists only privacy-safe state files', async () => {
  const workflow = await readFile(`${ROOT}.github/workflows/engagement.yml`, 'utf8');
  assert.match(workflow, /data\/engagement-state\.json/);
  assert.match(workflow, /data\/engagement-audit\.jsonl/);
  assert.doesNotMatch(workflow, /engagement-inbox|dm-body|message-body/i);
});

test('ChatOps stays provider-offline and cannot execute engagement mutations', async () => {
  const workflow = await readFile(`${ROOT}.github/workflows/chatops.yml`, 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /options: \[preflight\]/);
  assert.match(workflow, /INPUT_COMMAND: \$\{\{ inputs\.command \}\}/);
  assert.match(workflow, /INPUT_ACCOUNT: \$\{\{ inputs\.account \}\}/);
  assert.match(workflow, /if: inputs\.command == 'preflight'/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(workflow, /SOCIAL_CREDENTIALS_JSON|OPENAI_API_KEY|SNS_MANUAL_INVOCATION/);
  // ChatOps must not run a generation preview at all - it needs OPENAI_API_KEY, which this
  // keyless surface deliberately never receives (see docs/CHATOPS.md; the working dry-run
  // preview lives on SNS Autopilot, which already carries that credential).
  assert.doesNotMatch(workflow, /orchestrate\.mjs/);
  assert.doesNotMatch(workflow, /engagement-dry-run|engagement-run|engagement-resolve/);
  assert.doesNotMatch(workflow, /live-preflight\.mjs|x-posting-compliance\.mjs|x-automation-compliance\.mjs/);
  assert.doesNotMatch(workflow, /git add data\/|git push|durable-usage-state/);
  assert.doesNotMatch(workflow, /github\.event\.issue/);
  assert.match(workflow, /REDACTED_OPENAI_KEY/);
});

test('publish-only Live Preflight does not run the engagement automation compliance gate', async () => {
  const workflow = await readFile(`${ROOT}.github/workflows/preflight.yml`, 'utf8');
  assert.match(workflow, /x-posting-compliance\.mjs/);
  assert.doesNotMatch(workflow, /node src\/ops\/x-automation-compliance\.mjs/);

  const engagementControl = await readFile(`${ROOT}.github/workflows/engagement-control.yml`, 'utf8');
  assert.match(engagementControl, /x-automation-compliance\.mjs/);
});
