import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { assertAccountLifecycleAllowed, assertEngagementActivationAllowed, loadOperationMode } from '../src/ops/operation-mode.mjs';

const WORKFLOW_DIR = '.github/workflows';

const allowedEventsByWorkflow = {
  'account-control.yml': ['issues'],
  'autopilot.yml': ['workflow_dispatch'],
  'chatops.yml': ['issues'],
  'ci.yml': ['pull_request', 'push', 'workflow_dispatch'],
  'compliance-attestation.yml': ['issues'],
  'engagement-control.yml': ['issues'],
  'engagement-scheduled.yml': ['workflow_dispatch'],
  'engagement.yml': ['workflow_dispatch'],
  'failure-watch.yml': ['workflow_run'],
  'feedback.yml': ['issues', 'workflow_dispatch'],
  'health.yml': ['workflow_dispatch'],
  'hub-reconcile.yml': ['workflow_dispatch'],
  'intelligence.yml': ['workflow_dispatch'],
  'learning.yml': ['workflow_dispatch'],
  'maintenance.yml': ['workflow_dispatch'],
  'metrics.yml': ['workflow_dispatch'],
  'policy.yml': ['workflow_dispatch'],
  'preflight.yml': ['workflow_dispatch'],
  'publish-reconcile.yml': ['workflow_dispatch'],
  'publish.yml': ['issues', 'workflow_dispatch']
};

function activeYaml(text) {
  return text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
}

function workflowEvents(text, filename) {
  const active = activeYaml(text);
  assert.match(active, /^on:\s*$/m, `${filename} must use an explicit multiline on: block`);
  const lines = active.split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  assert.notEqual(start, -1, `${filename} is missing on:`);
  const events = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[^\s]/.test(line)) break;
    const match = line.match(/^\s{2}([A-Za-z0-9_-]+):(?:\s*.*)?$/);
    if (match) events.push(match[1]);
  }
  return [...new Set(events)].sort();
}

test('manual-only operation lock is explicit and fail-closed', async () => {
  const mode = await loadOperationMode();
  assert.equal(mode.schemaVersion, 1);
  assert.equal(mode.mode, 'manual-only');
  assert.equal(mode.allowAutoPromotion, false);
  assert.equal(mode.allowUnattendedEngagement, false);

  assert.throws(
    () => assertAccountLifecycleAllowed('auto', mode),
    (error) => error?.code === 'MANUAL_ONLY_AUTO_PROMOTION_BLOCKED'
  );
  assert.doesNotThrow(() => assertAccountLifecycleAllowed('approval', mode));
  assert.doesNotThrow(() => assertAccountLifecycleAllowed('pause', mode));
  assert.doesNotThrow(() => assertAccountLifecycleAllowed('disabled', mode));

  assert.throws(
    () => assertEngagementActivationAllowed(true, mode),
    (error) => error?.code === 'MANUAL_ONLY_ENGAGEMENT_ACTIVATION_BLOCKED'
  );
  assert.doesNotThrow(() => assertEngagementActivationAllowed(false, mode));
});

test('every workflow is classified and exposes only its approved manual/safety trigger surface', async () => {
  const files = (await readdir(WORKFLOW_DIR)).filter((name) => name.endsWith('.yml')).sort();
  const classified = Object.keys(allowedEventsByWorkflow).sort();
  assert.deepEqual(files, classified, 'Any new or removed workflow must be explicitly reviewed in the manual-only trigger allowlist');

  for (const filename of files) {
    const text = await readFile(`${WORKFLOW_DIR}/${filename}`, 'utf8');
    const actual = workflowEvents(text, filename);
    const expected = [...allowedEventsByWorkflow[filename]].sort();
    assert.deepEqual(actual, expected, `${filename} has an unexpected automatic trigger`);
  }
});

test('no workflow can smuggle in schedule/dispatch/server-side automation while manual-only', async () => {
  const forbiddenEvents = [
    'schedule',
    'repository_dispatch',
    'workflow_call',
    'pull_request_target',
    'issue_comment',
    'discussion',
    'discussion_comment',
    'check_run',
    'check_suite',
    'release',
    'deployment',
    'deployment_status',
    'registry_package',
    'page_build',
    'status'
  ];

  for (const filename of Object.keys(allowedEventsByWorkflow)) {
    const active = activeYaml(await readFile(`${WORKFLOW_DIR}/${filename}`, 'utf8'));
    for (const event of forbiddenEvents) {
      assert.doesNotMatch(active, new RegExp(`^\\s{2}${event}:`, 'm'), `${filename} must not enable ${event}`);
    }
    assert.doesNotMatch(active, /^\s*-\s*cron:/m, `${filename} must not contain an active cron`);
  }
});

test('automatic GitHub-only safety workflows cannot reach social/provider credentials', async () => {
  const ci = await readFile(`${WORKFLOW_DIR}/ci.yml`, 'utf8');
  const failureWatch = await readFile(`${WORKFLOW_DIR}/failure-watch.yml`, 'utf8');
  for (const [name, text] of [['ci.yml', ci], ['failure-watch.yml', failureWatch]]) {
    assert.doesNotMatch(text, /SOCIAL_CREDENTIALS_JSON/);
    assert.doesNotMatch(text, /X_OAUTH2_STATE_KEY/);
    assert.doesNotMatch(text, /MEDIA_SERVICE_TOKEN/);
    assert.doesNotMatch(text, /OPENAI_API_KEY/);
    assert.doesNotMatch(text, /secrets\./, `${name} must not receive repository secrets`);
  }
  assert.match(ci, /contents:\s*read/);
  assert.doesNotMatch(ci, /contents:\s*write/);
  assert.match(failureWatch, /contents:\s*read/);
  assert.doesNotMatch(failureWatch, /contents:\s*write/);
});

test('manual-only lock is wired into every persisted autonomy escalation path', async () => {
  const accountControl = await readFile('src/ops/account-control.mjs', 'utf8');
  const engagementActivation = await readFile('src/engagement/activate.mjs', 'utf8');
  assert.match(accountControl, /loadOperationMode/);
  assert.match(accountControl, /assertAccountLifecycleAllowed/);
  assert.match(accountControl, /operationMode/);
  assert.match(engagementActivation, /loadOperationMode/);
  assert.match(engagementActivation, /assertEngagementActivationAllowed/);
  assert.match(engagementActivation, /operationMode/);
});

test('current live-state cannot accidentally satisfy unattended operation gates', async () => {
  const accounts = JSON.parse(await readFile('config/accounts.json', 'utf8'));
  const policy = JSON.parse(await readFile('config/engagement-policy.json', 'utf8'));
  for (const [id, account] of Object.entries(accounts.accounts || {})) {
    assert.notEqual(account.enabled, true, `${id} must remain disabled until a deliberate manual approval-mode launch`);
    assert.notEqual(account.mode, 'auto', `${id} must not be auto while manual-only is locked`);
    assert.notEqual(account.engagement?.approvalRequired, false, `${id} must not have unattended engagement approval bypass`);
  }
  assert.deepEqual(policy.liveAccounts, []);
  assert.equal(policy.approvalRequired, true);
  assert.equal(policy.autoDmReply, false);
});
