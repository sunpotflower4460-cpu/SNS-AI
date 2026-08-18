import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertAutomatedEngagementAllowed } from '../src/engagement/policy.mjs';
import { hardHumanCategory, withRequiredXOptOut } from '../src/engagement/ai.mjs';
import { __test as runTest } from '../src/engagement/run.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const basePolicy = {
  enabled: true,
  allowedAccounts: ['music-tools-x'],
  inboundOnly: true,
  autoReply: true,
  autoDmReply: true,
  approvalRequired: false,
  oneAutomatedResponsePerInteraction: true,
  requireXAiReplyBotApproval: true,
  xAiReplyBotApprovalConfirmed: false,
  xAutomatedResponseOptOutText: '自動返信停止は「自動返信不要」でOKです。'
};

const account = { id: 'music-tools-x' };

test('X AI public replies stay human-gated until one-time X approval is confirmed', () => {
  const waiting = assertAutomatedEngagementAllowed({
    account,
    globalPolicy: basePolicy,
    event: { platform: 'x', kind: 'reply', inbound: true }
  });
  assert.equal(waiting.allowed, true);
  assert.equal(waiting.platformApprovalRequired, true);
  assert.equal(waiting.approvalRequired, true);

  const approved = assertAutomatedEngagementAllowed({
    account,
    globalPolicy: { ...basePolicy, xAiReplyBotApprovalConfirmed: true },
    event: { platform: 'x', kind: 'reply', inbound: true }
  });
  assert.equal(approved.platformApprovalRequired, false);
  assert.equal(approved.approvalRequired, false);
});

test('the X public-reply approval gate does not turn inbound DM replies into per-message approval', () => {
  const dm = assertAutomatedEngagementAllowed({
    account,
    globalPolicy: basePolicy,
    event: { platform: 'x', kind: 'dm', inbound: true }
  });
  assert.equal(dm.platformApprovalRequired, false);
  assert.equal(dm.approvalRequired, false);
});

test('X automated responses always carry one clear opt-out notice after generation', () => {
  const notice = basePolicy.xAutomatedResponseOptOutText;
  const reply = withRequiredXOptOut('ありがとうございます。確認します。', { platform: 'x', kind: 'reply' }, basePolicy);
  assert.match(reply, /自動返信不要/);
  assert.equal(reply.split(notice).length - 1, 1);

  const alreadyPresent = withRequiredXOptOut(`ありがとうございます。\n\n${notice}`, { platform: 'x', kind: 'dm' }, basePolicy);
  assert.equal(alreadyPresent.split(notice).length - 1, 1);

  const instagram = withRequiredXOptOut('ありがとうございます。', { platform: 'instagram', kind: 'reply' }, basePolicy);
  assert.equal(instagram, 'ありがとうございます。');
});

test('medical-advice requests are deterministically escalated before model judgment', () => {
  assert.equal(hardHumanCategory('この薬は一日に何錠服用すればいいですか？'), 'medical');
});

test('private human escalation cannot persist AI paraphrases of the private DM', () => {
  const safe = runTest.privacySafeHumanFields(
    { platform: 'x', kind: 'dm', public: false },
    {
      reason: 'ユーザーは秘密のパスワード ABC123 を相談しています',
      humanSummary: 'DMには住所 東京都... が書かれています',
      humanQuestion: '電話番号 090-0000-0000 へ連絡しますか？'
    }
  );
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes('ABC123'), false);
  assert.equal(serialized.includes('東京都'), false);
  assert.equal(serialized.includes('090-0000-0000'), false);
  assert.match(safe.summary, /内容は公開リポジトリへ転記していません/);
});

test('engagement dry-run details are kept out of public Actions and ChatOps output', async () => {
  const chatops = await readFile(`${ROOT}.github/workflows/chatops.yml`, 'utf8');
  const engagement = await readFile(`${ROOT}.github/workflows/engagement.yml`, 'utf8');
  assert.match(chatops, /sns-engagement-dry-run-private\.txt/);
  assert.match(chatops, /Detailed interaction output is intentionally suppressed/);
  assert.match(engagement, /sns-engagement-dry-run-private\.txt/);
  assert.match(engagement, /detailed interaction output is intentionally suppressed/i);
  assert.doesNotMatch(chatops, /engagement\/run\.mjs[^\n]*--dry-run[^\n]*tee\s+"\$COMMAND_OUTPUT"/);
});
