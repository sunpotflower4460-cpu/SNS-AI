import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEngagementPolicy } from '../src/engagement/policy.mjs';

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
