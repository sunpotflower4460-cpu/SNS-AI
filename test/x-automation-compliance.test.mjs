import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertAutomatedEngagementAllowed } from '../src/engagement/policy.mjs';
import { clearXReplyIntent, hardHumanCategory, withRequiredXOptOut } from '../src/engagement/ai.mjs';
import {
  assertXEngagementCredential,
  assertXEngagementPlatformCompliance
} from '../src/engagement/readiness.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const account = { id: 'music-tools-x', platform: 'x' };
const basePolicy = {
  enabled: true,
  allowedAccounts: ['music-tools-x'],
  liveAccounts: [],
  inboundOnly: true,
  autoReply: true,
  autoDmReply: true,
  approvalRequired: false,
  oneAutomatedResponsePerInteraction: true,
  requireXAiReplyBotApproval: true,
  xAiReplyBotApprovalConfirmed: false,
  requireXAutomatedAccountLabel: true,
  xAutomatedAccountLabelConfirmed: false,
  requireXAutomatedResponseOptOut: true,
  xAutomatedResponseOptOutText: '自動返信停止は「自動返信不要」でOKです。',
  requireXClearReplyIntent: true
};

const readyIdentity = {
  session: {
    scope: 'tweet.read users.read tweet.write dm.read dm.write offline.access',
    hasRefreshToken: true
  }
};

test('X public AI replies are one-time platform gated while DMs are not turned into per-message approvals', () => {
  const publicReply = assertAutomatedEngagementAllowed({
    account,
    globalPolicy: basePolicy,
    event: { platform: 'x', kind: 'reply', inbound: true }
  });
  assert.equal(publicReply.platformApprovalRequired, true);
  assert.equal(publicReply.approvalRequired, true);

  const approvedReply = assertAutomatedEngagementAllowed({
    account,
    globalPolicy: { ...basePolicy, xAiReplyBotApprovalConfirmed: true },
    event: { platform: 'x', kind: 'reply', inbound: true }
  });
  assert.equal(approvedReply.platformApprovalRequired, false);
  assert.equal(approvedReply.approvalRequired, false);

  const dm = assertAutomatedEngagementAllowed({
    account,
    globalPolicy: basePolicy,
    event: { platform: 'x', kind: 'dm', inbound: true }
  });
  assert.equal(dm.platformApprovalRequired, false);
  assert.equal(dm.approvalRequired, false);
});

test('X readiness fails closed until the automated-account label and AI reply approval are confirmed', () => {
  assert.throws(
    () => assertXEngagementPlatformCompliance(basePolicy),
    (error) => error.code === 'ENGAGEMENT_X_AUTOMATED_LABEL_NOT_READY'
  );

  const labeled = { ...basePolicy, xAutomatedAccountLabelConfirmed: true };
  assert.throws(
    () => assertXEngagementPlatformCompliance(labeled),
    (error) => error.code === 'ENGAGEMENT_X_AI_REPLY_APPROVAL_NOT_READY'
  );

  const ready = { ...labeled, xAiReplyBotApprovalConfirmed: true };
  assert.equal(assertXEngagementPlatformCompliance(ready).ok, true);
  assert.equal(assertXEngagementCredential(readyIdentity, ready).platformCompliance.ok, true);
});

test('DM-only X automation does not require the AI public-reply approval but still requires account transparency', () => {
  const dmOnly = {
    ...basePolicy,
    autoReply: false,
    autoDmReply: true,
    xAutomatedAccountLabelConfirmed: true
  };
  assert.equal(assertXEngagementPlatformCompliance(dmOnly).ok, true);
  assert.doesNotThrow(() => assertXEngagementCredential(readyIdentity, dmOnly));
});

test('required X opt-out notice fails closed and is appended exactly once to replies and DMs', () => {
  const missing = { ...basePolicy, xAutomatedAccountLabelConfirmed: true, xAiReplyBotApprovalConfirmed: true, xAutomatedResponseOptOutText: '' };
  assert.throws(
    () => assertXEngagementPlatformCompliance(missing),
    (error) => error.code === 'ENGAGEMENT_X_OPTOUT_NOTICE_MISSING'
  );
  assert.throws(
    () => assertAutomatedEngagementAllowed({ account, globalPolicy: missing, event: { platform: 'x', kind: 'dm', inbound: true } }),
    (error) => error.code === 'ENGAGEMENT_X_OPTOUT_NOTICE_MISSING'
  );

  const notice = basePolicy.xAutomatedResponseOptOutText;
  const reply = withRequiredXOptOut('ありがとうございます。確認します。', { platform: 'x', kind: 'reply' }, basePolicy);
  assert.equal(reply.split(notice).length - 1, 1);
  const duplicateSafe = withRequiredXOptOut(reply, { platform: 'x', kind: 'reply' }, basePolicy);
  assert.equal(duplicateSafe.split(notice).length - 1, 1);
  const dm = withRequiredXOptOut('DMありがとうございます。', { platform: 'x', kind: 'dm' }, basePolicy);
  assert.equal(dm.split(notice).length - 1, 1);
  assert.equal(withRequiredXOptOut('ok', { platform: 'instagram', kind: 'reply' }, basePolicy), 'ok');
});

test('X public auto-replies require clear user response intent instead of a mention alone', () => {
  assert.equal(clearXReplyIntent('このプラグイン、どこで買えますか？'), true);
  assert.equal(clearXReplyIntent('おすすめを教えてください'), true);
  assert.equal(clearXReplyIntent('Can you explain the difference?'), true);
  assert.equal(clearXReplyIntent('今日このアカウント見かけた'), false);
  assert.equal(clearXReplyIntent('すごい！'), false);
  assert.equal(clearXReplyIntent('これは微妙だった'), false);
});

test('medical dosage questions remain deterministic human escalations', () => {
  assert.equal(hardHumanCategory('この薬は一日に何錠服用すればいいですか？'), 'medical');
});

test('manual engagement dry-runs do not publish detailed interaction output to Actions or ChatOps issues', async () => {
  const chatops = await readFile(`${ROOT}.github/workflows/chatops.yml`, 'utf8');
  const engagement = await readFile(`${ROOT}.github/workflows/engagement.yml`, 'utf8');
  assert.match(chatops, /sns-engagement-dry-run-private\.txt/);
  assert.match(chatops, /Detailed interaction output is intentionally suppressed/);
  assert.doesNotMatch(chatops, /engagement\/run\.mjs[^\n]*--dry-run[^\n]*tee\s+"\$COMMAND_OUTPUT"/);
  assert.match(engagement, /sns-engagement-dry-run-private\.txt/);
  assert.match(engagement, /detailed interaction output is intentionally suppressed/i);
});

test('production X engagement policy stays non-live until one-time external gates are completed', async () => {
  const config = JSON.parse(await readFile(`${ROOT}config/engagement-policy.json`, 'utf8'));
  assert.deepEqual(config.liveAccounts, []);
  assert.equal(config.requireXAiReplyBotApproval, true);
  assert.equal(config.xAiReplyBotApprovalConfirmed, false);
  assert.equal(config.requireXAutomatedAccountLabel, true);
  assert.equal(config.xAutomatedAccountLabelConfirmed, false);
  assert.equal(config.requireXAutomatedResponseOptOut, true);
  assert.equal(config.requireXClearReplyIntent, true);
  assert.match(config.xAutomatedResponseOptOutText, /自動返信不要/);
});
