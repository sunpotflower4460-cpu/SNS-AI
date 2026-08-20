import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { patchEngagementActivation } from '../src/engagement/activate.mjs';
import { mostRecentOwnPublish, safeRecentPostWindowMinutes, scheduledAccountDecision } from '../src/engagement/scheduled.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function fixture() {
  return {
    accountsConfig: {
      defaults: { mode: 'pause' },
      accounts: {
        alpha: { enabled: true, mode: 'approval', engagement: { autoReply: true } },
        beta: { enabled: true, mode: 'approval' }
      }
    },
    policy: {
      schemaVersion: 4,
      enabled: true,
      allowedAccounts: ['alpha'],
      liveAccounts: [],
      xAutomationProfileComplianceConfirmedAccounts: [],
      xAiReplyBotApprovalRequiredAccounts: [],
      xAiReplyBotApprovalConfirmedAccounts: [],
      xAutomatedResponseOptOutText: 'stop'
    }
  };
}

test('activation is account-scoped and makes routine replies automatic only for the activated account', () => {
  const { accountsConfig, policy } = fixture();
  const active = patchEngagementActivation({ accountsConfig, policy, accountId: 'alpha', active: true });
  assert.deepEqual(active.policy.liveAccounts, ['alpha']);
  assert.equal(active.accountsConfig.accounts.alpha.engagement.approvalRequired, false);
  assert.equal(accountsConfig.accounts.alpha.engagement.approvalRequired, undefined, 'input must not be mutated');

  const inactive = patchEngagementActivation({
    accountsConfig: active.accountsConfig,
    policy: active.policy,
    accountId: 'alpha',
    active: false
  });
  assert.deepEqual(inactive.policy.liveAccounts, []);
  assert.equal(inactive.accountsConfig.accounts.alpha.engagement.approvalRequired, true, 'deactivation must fail closed');
});

test('activation refuses an account outside the engagement allowlist', () => {
  const { accountsConfig, policy } = fixture();
  assert.throws(
    () => patchEngagementActivation({ accountsConfig, policy, accountId: 'beta', active: true }),
    /not in engagement allowedAccounts/
  );
});

test('scheduled public engagement polls only inside the recent-own-post window', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  const account = { enabled: true, mode: 'auto', engagement: { autoReply: true, autoDmReply: false } };
  const globalPolicy = { enabled: true, liveAccounts: ['alpha'], autoReply: true, autoDmReply: false };
  const recent = [{ account: 'alpha', status: 'published', at: '2026-08-20T10:00:00Z', providerPostId: '1' }];
  const stale = [{ account: 'alpha', status: 'published', at: '2026-08-20T01:00:00Z', providerPostId: '1' }];

  assert.equal(mostRecentOwnPublish(recent, 'alpha'), new Date('2026-08-20T10:00:00Z').getTime());
  assert.deepEqual(scheduledAccountDecision({ accountId: 'alpha', account, history: recent, globalPolicy, now }).due, true);
  assert.deepEqual(scheduledAccountDecision({ accountId: 'alpha', account, history: stale, globalPolicy, now }).reason, 'outside-recent-post-window');
  assert.deepEqual(scheduledAccountDecision({ accountId: 'beta', account, history: recent, globalPolicy, now }).reason, 'not-live');
});

test('scheduled polling fails closed on malformed windows and permits explicit DM polling', () => {
  assert.equal(safeRecentPostWindowMinutes('six hours'), 0);
  assert.equal(safeRecentPostWindowMinutes(-1), 0);
  assert.equal(safeRecentPostWindowMinutes(360), 360);

  const now = new Date('2026-08-20T12:00:00Z');
  const basePolicy = { enabled: true, liveAccounts: ['alpha'], autoReply: true, autoDmReply: false };
  const account = {
    enabled: true,
    mode: 'auto',
    engagement: { autoReply: true, autoDmReply: false, scheduledPolling: { recentPostWindowMinutes: 'bad' } }
  };
  assert.equal(scheduledAccountDecision({ accountId: 'alpha', account, history: [], globalPolicy: basePolicy, now }).reason, 'invalid-polling-config');

  const dmAccount = { enabled: true, mode: 'auto', engagement: { autoReply: false, autoDmReply: true } };
  assert.equal(scheduledAccountDecision({ accountId: 'alpha', account: dmAccount, history: [], globalPolicy: basePolicy, now }).reason, 'dm-enabled');
});

test('scheduled and control workflows expose only bounded engagement automation', async () => {
  const scheduled = await readFile(`${ROOT}.github/workflows/engagement-scheduled.yml`, 'utf8');
  assert.match(scheduled, /cron:\s*'7,37 \* \* \* \*'/);
  assert.match(scheduled, /node src\/engagement\/scheduled\.mjs/);
  assert.match(scheduled, /maxInboundFetchesPerDay/);

  const control = await readFile(`${ROOT}.github/workflows/engagement-control.yml`, 'utf8');
  assert.match(control, /\[engagement-activate\]/);
  assert.match(control, /\[engagement-deactivate\]/);
  assert.match(control, /live-preflight\.mjs --account/);
  assert.match(control, /x-automation-compliance\.mjs --account/);
  assert.match(control, /--activate/);
  assert.match(control, /--deactivate/);
});
