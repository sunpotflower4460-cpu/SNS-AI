import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { postingComplianceRow } from '../src/ops/x-posting-compliance.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const executable = (script) => new RegExp(`^\\s*node\\s+${script.replaceAll('/', '\\/').replaceAll('.', '\\.')}(?:\\s|$)`, 'm');

test('routine publish preflight defers engagement OAuth and AI-reply approval while activation requires both', async () => {
  const chatops = await readFile(`${ROOT}.github/workflows/chatops.yml`, 'utf8');
  const accountControl = await readFile(`${ROOT}.github/workflows/account-control.yml`, 'utf8');
  const engagementControl = await readFile(`${ROOT}.github/workflows/engagement-control.yml`, 'utf8');
  const manualPreflight = await readFile(`${ROOT}.github/workflows/preflight.yml`, 'utf8');

  assert.match(chatops, /live-preflight\.mjs --account "\$\{\{ steps\.command\.outputs\.account \}\}"/);
  assert.doesNotMatch(chatops, /live-preflight\.mjs --account "\$\{\{ steps\.command\.outputs\.account \}\}" --engagement/);
  assert.match(chatops, executable('src/ops/x-posting-compliance.mjs'));
  assert.doesNotMatch(chatops, executable('src/ops/x-automation-compliance.mjs'));

  assert.match(accountControl, /live-preflight\.mjs --account/);
  assert.doesNotMatch(accountControl, /live-preflight\.mjs --account[^\n]*--engagement/);

  assert.match(manualPreflight, executable('src/ops/x-posting-compliance.mjs'));
  assert.doesNotMatch(manualPreflight, executable('src/ops/x-automation-compliance.mjs'));

  assert.match(engagementControl, /live-preflight\.mjs --account "\$account" --engagement/);
  assert.match(engagementControl, executable('src/ops/x-automation-compliance.mjs'));
});

test('posting compliance requires X automated-profile transparency but not AI-reply approval', () => {
  const account = { platform: 'x', mode: 'approval' };
  const policy = {
    xAutomationProfileComplianceConfirmedAccounts: ['alpha'],
    xAiReplyBotApprovalRequiredAccounts: ['alpha'],
    xAiReplyBotApprovalConfirmedAccounts: []
  };
  assert.equal(postingComplianceRow('alpha', account, policy).ok, true);
  const blocked = postingComplianceRow('beta', account, policy);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.profileComplianceConfirmed, false);
});
