import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAutomatedEngagementAllowed } from '../src/engagement/policy.mjs';

const basePolicy = {
  enabled: true,
  allowedAccounts: ['music-tools-x'],
  inboundOnly: true,
  autoReply: true,
  autoDmReply: true,
  approvalRequired: false,
  oneAutomatedResponsePerInteraction: true,
  requireXAiReplyBotApproval: true,
  xAiReplyBotApprovalConfirmed: false
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
