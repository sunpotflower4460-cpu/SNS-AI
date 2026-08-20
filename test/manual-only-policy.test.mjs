import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { auditManualOnly, OPERATIONAL_WORKFLOWS } from '../src/ops/manual-only-audit.mjs';
import { assertEngagementActivationAllowed, assertLifecycleTransitionAllowed, assertProviderMutationAllowed } from '../src/ops/manual-only.mjs';

const policy = { manualOnly: true, requireExplicitManualInvocation: true };

test('repository is locked to the complete Manual-Only posture', async () => {
  const result = await auditManualOnly();
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(OPERATIONAL_WORKFLOWS.has('engagement.yml'), true);
});

test('Manual-Only blocks activation, auto mode, and unattended provider mutation', () => {
  assert.throws(() => assertLifecycleTransitionAllowed(policy, 'auto'), { code: 'MANUAL_ONLY_BLOCKED' });
  assert.throws(() => assertLifecycleTransitionAllowed(policy, 'approval'), { code: 'MANUAL_ONLY_BLOCKED' });
  assert.throws(() => assertEngagementActivationAllowed(policy, true), { code: 'MANUAL_ONLY_BLOCKED' });
});

test('dry-run never requires credentials or a provider mutation authorization', () => {
  assert.equal(assertProviderMutationAllowed(policy, { dryRun: true }), true);
});

test('live mutation requires the process-start workflow boundary marker', () => {
  assert.equal(assertProviderMutationAllowed(policy, { source: 'manual' }), true);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { assertProviderMutationAllowed } from './src/ops/manual-only.mjs'; try { assertProviderMutationAllowed({manualOnly:true,requireExplicitManualInvocation:true},{source:'autopilot'}); process.exit(9) } catch (e) { if (e.code !== 'MANUAL_ONLY_BLOCKED') throw e }`], {
    cwd: process.cwd(), env: { ...process.env, SNS_MANUAL_INVOCATION: '' }, encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);
});
