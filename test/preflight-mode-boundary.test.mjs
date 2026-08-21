import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { postingComplianceRow } from '../src/ops/x-posting-compliance.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const executable = (script) => new RegExp(`^\\s*node\\s+${script.replaceAll('/', '\\/').replaceAll('.', '\\.')}(?:\\s|$)`, 'm');

test('manual preflight boundaries keep chatops provider-offline and isolate engagement compliance', async () => {
  const chatops = await readFile(`${ROOT}.github/workflows/chatops.yml`, 'utf8');
  const accountControl = await readFile(`${ROOT}.github/workflows/account-control.yml`, 'utf8');
  const engagementControl = await readFile(`${ROOT}.github/workflows/engagement-control.yml`, 'utf8');
  const manualPreflight = await readFile(`${ROOT}.github/workflows/preflight.yml`, 'utf8');

  // ChatOps is a keyless/manual convenience surface only. It can run static preflight
  // and a dry-run, but it must not receive provider credentials or run live/provider checks.
  assert.match(chatops, /workflow_dispatch:/);
  assert.doesNotMatch(chatops, /issue_comment:/);
  assert.doesNotMatch(chatops, /schedule:/);
  assert.match(chatops, /INPUT_ACCOUNT:\s*\$\{\{ github\.event\.inputs\.account \}\}/);
  assert.match(chatops, /orchestrate\.mjs --account "\$INPUT_ACCOUNT" --force --dry-run/);
  assert.doesNotMatch(chatops, /SOCIAL_CREDENTIALS_JSON/);
  assert.doesNotMatch(chatops, /OPENAI_API_KEY/);
  assert.doesNotMatch(chatops, executable('src/ops/live-preflight.mjs'));
  assert.doesNotMatch(chatops, executable('src/ops/x-posting-compliance.mjs'));
  assert.doesNotMatch(chatops, executable('src/ops/x-automation-compliance.mjs'));

  // Account activation has its own publish-oriented live preflight, but never the
  // engagement-specific preflight/compliance path.
  assert.match(accountControl, /live-preflight\.mjs --account "\$INPUT_ACCOUNT"/);
  assert.doesNotMatch(accountControl, /live-preflight\.mjs --account[^\n]*--engagement/);
  assert.doesNotMatch(accountControl, executable('src/ops/x-automation-compliance.mjs'));

  // The explicit manual publish preflight checks posting transparency only.
  assert.match(manualPreflight, /workflow_dispatch:/);
  assert.match(manualPreflight, executable('src/ops/x-posting-compliance.mjs'));
  assert.doesNotMatch(manualPreflight, executable('src/ops/x-automation-compliance.mjs'));

  // Engagement activation is a separate control surface and is the only one here
  // that runs engagement preflight plus X automation compliance.
  assert.match(engagementControl, /live-preflight\.mjs --account "\$INPUT_ACCOUNT" --engagement/);
  assert.match(engagementControl, executable('src/ops/x-automation-compliance.mjs'));
  assert.match(engagementControl, /if:\s*inputs\.action == 'activate'/);
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
