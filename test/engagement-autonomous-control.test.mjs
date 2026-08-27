import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { patchEngagementActivation, setEngagementActivation, __test as activateTest } from '../src/engagement/activate.mjs';
import {
  mostRecentOwnPublish,
  runScheduledEngagement,
  safeRecentPostWindowMinutes,
  scheduledAccountDecision,
  __test as scheduledTest
} from '../src/engagement/scheduled.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const allowScheduledRuntime = async () => ({ schemaVersion: 1, manualOnly: false, allowScheduledProviderPolling: true });
const blockScheduledRuntime = async () => ({ schemaVersion: 1, manualOnly: true, allowScheduledProviderPolling: false });

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

test('activation validates identifiers, known accounts, and the engagement allowlist', () => {
  const { accountsConfig, policy } = fixture();
  assert.throws(
    () => patchEngagementActivation({ accountsConfig, policy, accountId: 'bad account', active: true }),
    /valid account id/
  );
  assert.throws(
    () => patchEngagementActivation({ accountsConfig, policy, accountId: 'missing', active: false }),
    /Unknown account/
  );
  assert.throws(
    () => patchEngagementActivation({ accountsConfig, policy, accountId: 'beta', active: true }),
    /not in engagement allowedAccounts/
  );
});

test('activation orchestrator checks resolved live state and writes both configs with injected dependencies', async () => {
  const { accountsConfig, policy } = fixture();
  const writes = [];
  const read = async (path) => path === 'accounts.json' ? structuredClone(accountsConfig) : structuredClone(policy);
  const write = async (path, value) => writes.push({ path, value });

  const result = await setEngagementActivation({
    accountId: 'alpha',
    active: true,
    loadResolvedAccounts: async () => ({ alpha: { enabled: true, mode: 'approval' } }),
    read,
    write,
    accountsFile: 'accounts.json',
    policyFile: 'policy.json',
    loadPolicy: async () => ({ manualOnly: false })
  });
  assert.equal(result.account, 'alpha');
  assert.equal(result.active, true);
  assert.equal(result.approvalRequired, false);
  assert.deepEqual(result.liveAccounts, ['alpha']);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].value.accounts.alpha.engagement.approvalRequired, false);
  assert.deepEqual(writes[1].value.liveAccounts, ['alpha']);

  await assert.rejects(
    setEngagementActivation({
      accountId: 'missing', active: true,
      loadResolvedAccounts: async () => ({}), read, write,
      accountsFile: 'accounts.json', policyFile: 'policy.json'
    }),
    /Unknown account/
  );
  await assert.rejects(
    setEngagementActivation({
      accountId: 'alpha', active: true,
      loadResolvedAccounts: async () => ({ alpha: { enabled: false, mode: 'approval' } }), read, write,
      accountsFile: 'accounts.json', policyFile: 'policy.json'
    }),
    /must be enabled/
  );
});

test('activation CLI parsing is bounded and deterministic', () => {
  assert.deepEqual(activateTest.parseArgs(['--account', 'alpha', '--activate']), { account: 'alpha', activate: true });
  assert.deepEqual(activateTest.parseArgs(['noise', '--deactivate', '--account', 'alpha']), { deactivate: true, account: 'alpha' });
  assert.equal(activateTest.ACCOUNT_ID_RE.test('alpha_1.test'), true);
  assert.deepEqual(activateTest.unique(['a', 'a', 2]), ['a', '2']);
});

test('scheduled public engagement polls only inside the recent-own-post window', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  const account = { enabled: true, mode: 'auto', engagement: { autoReply: true, autoDmReply: false } };
  const globalPolicy = { enabled: true, liveAccounts: ['alpha'], autoReply: true, autoDmReply: false };
  const recent = [{ account: 'alpha', status: 'published', at: '2026-08-20T10:00:00Z', providerPostId: '1' }];
  const stale = [{ account: 'alpha', status: 'published', at: '2026-08-20T01:00:00Z', providerPostId: '1' }];

  assert.equal(mostRecentOwnPublish(recent, 'alpha'), new Date('2026-08-20T10:00:00Z').getTime());
  assert.equal(mostRecentOwnPublish([{ account: 'alpha', status: 'draft', at: now.toISOString() }], 'alpha'), null);
  assert.equal(scheduledAccountDecision({ accountId: 'alpha', account, history: recent, globalPolicy, now }).due, true);
  assert.equal(scheduledAccountDecision({ accountId: 'alpha', account, history: stale, globalPolicy, now }).reason, 'outside-recent-post-window');
  assert.equal(scheduledAccountDecision({ accountId: 'beta', account, history: recent, globalPolicy, now }).reason, 'not-live');
});

test('scheduled decision fails closed across disabled, invalid, and no-channel cases', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  const policy = { enabled: true, liveAccounts: ['alpha'], autoReply: true, autoDmReply: false };
  assert.equal(scheduledAccountDecision({ accountId: 'alpha', account: null, globalPolicy: policy, now }).reason, 'account-disabled');
  assert.equal(scheduledAccountDecision({ accountId: 'alpha', account: { enabled: false }, globalPolicy: policy, now }).reason, 'account-disabled');
  assert.equal(scheduledAccountDecision({
    accountId: 'alpha', account: { enabled: true, mode: 'auto', engagement: { scheduledPolling: { enabled: false } } },
    globalPolicy: policy, now
  }).reason, 'scheduled-polling-disabled');
  assert.equal(scheduledAccountDecision({
    accountId: 'alpha', account: { enabled: true, mode: 'auto', engagement: { scheduledPolling: { enabled: 'yes' } } },
    globalPolicy: policy, now
  }).reason, 'invalid-polling-config');
  assert.equal(scheduledAccountDecision({
    accountId: 'alpha', account: { enabled: true, mode: 'auto', engagement: { autoReply: false, autoDmReply: false } },
    globalPolicy: { ...policy, autoReply: false }, now
  }).reason, 'no-live-channel');
  assert.equal(scheduledAccountDecision({
    accountId: 'alpha', account: { enabled: true, mode: 'auto', engagement: { autoReply: true } },
    globalPolicy: policy, history: [], now
  }).reason, 'no-own-publish');
  assert.equal(scheduledAccountDecision({
    accountId: 'alpha', account: { enabled: true, mode: 'auto', engagement: { autoReply: true } },
    globalPolicy: policy,
    history: [{ account: 'alpha', status: 'published', at: '2026-08-20T13:00:00Z' }], now
  }).reason, 'invalid-publish-time');
});

test('scheduled polling fails closed on malformed windows and permits explicit DM polling', () => {
  assert.equal(safeRecentPostWindowMinutes(undefined), 360);
  assert.equal(safeRecentPostWindowMinutes('six hours'), 0);
  assert.equal(safeRecentPostWindowMinutes(-1), 0);
  assert.equal(safeRecentPostWindowMinutes(360), 360);
  assert.equal(safeRecentPostWindowMinutes(10081), 0);
  assert.equal(scheduledTest.plainObject({}), true);
  assert.equal(scheduledTest.plainObject([]), false);

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

test('scheduled runner returns disabled and nothing-due without provider work', async () => {
  const policyBlocked = await runScheduledEngagement({
    loadRuntime: blockScheduledRuntime,
    loadPolicy: async () => ({ enabled: true, liveAccounts: ['alpha'], autoReply: true }),
    loadAccountConfig: async () => ({ alpha: { enabled: true, mode: 'auto', engagement: { autoReply: true } } }),
    loadPublishedHistory: async () => [{ account: 'alpha', status: 'published', at: '2026-08-20T11:00:00Z' }],
    run: async () => { throw new Error('must not run'); }
  });
  assert.equal(policyBlocked.state, 'disabled');
  assert.equal(policyBlocked.reason, 'manual-only');

  const flagBlocked = await runScheduledEngagement({
    loadRuntime: async () => ({ schemaVersion: 1, manualOnly: false, allowScheduledProviderPolling: false }),
    loadPolicy: async () => ({ enabled: true, liveAccounts: ['alpha'], autoReply: true }),
    loadAccountConfig: async () => ({ alpha: { enabled: true, mode: 'auto', engagement: { autoReply: true } } }),
    loadPublishedHistory: async () => [{ account: 'alpha', status: 'published', at: '2026-08-20T11:00:00Z' }],
    run: async () => { throw new Error('must not run'); }
  });
  assert.equal(flagBlocked.state, 'disabled');
  assert.equal(flagBlocked.reason, 'scheduled-polling-disallowed');

  const disabled = await runScheduledEngagement({
    loadRuntime: allowScheduledRuntime,
    loadPolicy: async () => ({ enabled: false }),
    loadAccountConfig: async () => ({ alpha: { enabled: true, mode: 'auto' } }),
    loadPublishedHistory: async () => [],
    run: async () => { throw new Error('must not run'); }
  });
  assert.equal(disabled.state, 'disabled');

  const nothingDue = await runScheduledEngagement({
    now: new Date('2026-08-20T12:00:00Z'),
    loadRuntime: allowScheduledRuntime,
    loadPolicy: async () => ({ enabled: true, liveAccounts: ['alpha'], autoReply: true, autoDmReply: false }),
    loadAccountConfig: async () => ({ alpha: { enabled: true, mode: 'auto', engagement: { autoReply: true } } }),
    loadPublishedHistory: async () => [],
    run: async () => { throw new Error('must not run'); }
  });
  assert.equal(nothingDue.state, 'nothing_due');
  assert.equal(nothingDue.skipped[0].reason, 'no-own-publish');

  const nothingEnabled = await runScheduledEngagement({
    loadRuntime: allowScheduledRuntime,
    loadPolicy: async () => ({ enabled: true, liveAccounts: [], autoReply: true }),
    loadAccountConfig: async () => ({ alpha: { enabled: true, mode: 'auto' } }),
    loadPublishedHistory: async () => [],
    run: async () => { throw new Error('must not run'); }
  });
  assert.equal(nothingEnabled.state, 'nothing_enabled');
});

test('scheduled runner executes due accounts sequentially and reports healthy/degraded states', async () => {
  const now = new Date('2026-08-20T12:00:00Z');
  const policy = { enabled: true, liveAccounts: ['alpha', 'beta'], autoReply: true, autoDmReply: false };
  const accounts = {
    alpha: { enabled: true, mode: 'auto', engagement: { autoReply: true } },
    beta: { enabled: true, mode: 'auto', engagement: { autoReply: true } }
  };
  const history = [
    { account: 'alpha', status: 'published', at: '2026-08-20T11:00:00Z' },
    { account: 'beta', status: 'published', at: '2026-08-20T11:30:00Z' }
  ];
  const calls = [];
  const healthy = await runScheduledEngagement({
    now,
    loadRuntime: allowScheduledRuntime,
    loadPolicy: async () => policy,
    loadAccountConfig: async () => accounts,
    loadPublishedHistory: async () => history,
    run: async (args) => { calls.push(args.accountFilter); return { state: 'ok', accounts: [{ state: 'ok' }] }; }
  });
  assert.equal(healthy.state, 'ok');
  assert.deepEqual(calls, ['alpha', 'beta']);
  assert.equal(healthy.accounts.length, 2);

  const degraded = await runScheduledEngagement({
    now,
    loadRuntime: allowScheduledRuntime,
    loadPolicy: async () => ({ ...policy, liveAccounts: ['alpha'] }),
    loadAccountConfig: async () => ({ alpha: accounts.alpha }),
    loadPublishedHistory: async () => history,
    run: async () => ({ state: 'ok', accounts: [{ state: 'waiting_for_engagement_credentials' }] })
  });
  assert.equal(degraded.state, 'degraded');
});

test('Manual-Only keeps scheduled engagement inert and exposes bounded manual control', async () => {
  const scheduled = await readFile(`${ROOT}.github/workflows/engagement-scheduled.yml`, 'utf8');
  const activeScheduled = scheduled.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.match(activeScheduled, /^\s*workflow_dispatch:/m);
  assert.doesNotMatch(activeScheduled, /^\s*schedule:/m);
  assert.doesNotMatch(activeScheduled, /^\s*-\s*cron:/m);
  // The workflow calls the real scheduled engagement module; inertness under Manual-Only is
  // enforced at runtime by allowScheduledProviderPolling/manualOnly (not audit-only), plus
  // engagement-policy.json (enabled:false / liveAccounts:[]).
  assert.match(scheduled, /node src\/engagement\/scheduled\.mjs/);
  assert.match(scheduled, /npm run manual-only-audit/);
  assert.match(scheduled, /SNS_MANUAL_INVOCATION:\s*'true'/);

  const control = await readFile(`${ROOT}.github/workflows/engagement-control.yml`, 'utf8');
  assert.match(control, /workflow_dispatch:/);
  assert.match(control, /options: \[activate, deactivate\]/);
  assert.match(control, /live-preflight\.mjs --account/);
  assert.match(control, /x-automation-compliance\.mjs --account/);
  assert.match(control, /--activate/);
  assert.match(control, /--deactivate/);
  assert.doesNotMatch(control, /github\.event\.issue/);
});
