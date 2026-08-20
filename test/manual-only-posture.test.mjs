import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const operationalWorkflows = [
  '.github/workflows/autopilot.yml',
  '.github/workflows/engagement.yml',
  '.github/workflows/engagement-scheduled.yml',
  '.github/workflows/metrics.yml',
  '.github/workflows/learning.yml',
  '.github/workflows/intelligence.yml',
  '.github/workflows/maintenance.yml',
  '.github/workflows/health.yml',
  '.github/workflows/policy.yml',
  '.github/workflows/hub-reconcile.yml',
  '.github/workflows/publish-reconcile.yml'
];

function activeYamlLines(text) {
  return text.split('\n').filter((line) => !/^\s*#/.test(line));
}

test('manual-only posture forbids operational schedule triggers', async () => {
  for (const path of operationalWorkflows) {
    const text = await readFile(path, 'utf8');
    const active = activeYamlLines(text).join('\n');
    assert.match(active, /^\s*workflow_dispatch:/m, `${path} must remain explicitly dispatchable`);
    assert.doesNotMatch(active, /^\s*schedule:/m, `${path} must not have an automatic schedule`);
    assert.doesNotMatch(active, /^\s*-\s*cron:/m, `${path} must not have an active cron`);
  }
});

test('manual-only posture keeps every configured SNS account disabled', async () => {
  const config = JSON.parse(await readFile('config/accounts.json', 'utf8'));
  const entries = Object.entries(config.accounts || {});
  assert.ok(entries.length > 0, 'expected at least one configured account');
  for (const [id, account] of entries) {
    assert.notEqual(account.enabled, true, `${id} must remain disabled in manual-only posture`);
    assert.notEqual(account.mode, 'auto', `${id} must not remain in auto mode in manual-only posture`);
  }
});

test('manual-only posture keeps unattended engagement liveAccounts empty', async () => {
  const policy = JSON.parse(await readFile('config/engagement-policy.json', 'utf8'));
  assert.deepEqual(policy.liveAccounts, []);
  assert.equal(policy.approvalRequired, true);
  assert.equal(policy.autoDmReply, false);
});
