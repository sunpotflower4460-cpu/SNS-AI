import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditManualOnly, INFRASTRUCTURE_WORKFLOWS, OPERATIONAL_WORKFLOWS } from '../src/ops/manual-only-audit.mjs';
import { assertEngagementActivationAllowed, assertLifecycleTransitionAllowed, assertProviderMutationAllowed } from '../src/ops/manual-only.mjs';

const policy = { manualOnly: true, requireExplicitManualInvocation: true };
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

async function makeAuditFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sns-ai-manual-only-'));
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, '.github'), { recursive: true });
  for (const name of ['runtime-policy.json', 'accounts.json', 'engagement-policy.json']) {
    await cp(join(REPO_ROOT, 'config', name), join(root, 'config', name));
  }
  await cp(join(REPO_ROOT, '.github', 'workflows'), join(root, '.github', 'workflows'), { recursive: true });
  return root;
}

async function withAuditFixture(run) {
  const root = await makeAuditFixture();
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('repository is locked to the complete Manual-Only posture', async () => {
  const result = await auditManualOnly();
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(OPERATIONAL_WORKFLOWS.has('engagement.yml'), true);
  assert.equal(OPERATIONAL_WORKFLOWS.has('feedback.yml'), true);
  assert.deepEqual([...INFRASTRUCTURE_WORKFLOWS.keys()].sort(), ['ci.yml', 'failure-watch.yml']);
});

test('Manual-Only allows a reviewed enabled approval account but rejects auto mode', async () => {
  await withAuditFixture(async (root) => {
    const file = join(root, 'config', 'accounts.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    const [accountId] = Object.keys(config.accounts);
    assert.ok(accountId);
    config.accounts[accountId].enabled = true;
    config.accounts[accountId].mode = 'approval';
    await writeFile(file, JSON.stringify(config, null, 2));
    const approvalResult = await auditManualOnly(root);
    assert.equal(approvalResult.ok, true, approvalResult.errors.join('\n'));

    config.accounts[accountId].mode = 'auto';
    await writeFile(file, JSON.stringify(config, null, 2));
    const autoResult = await auditManualOnly(root);
    assert.equal(autoResult.ok, false);
    assert.match(autoResult.errors.join('\n'), /must not use auto mode/);
  });
});

test('Manual-Only rejects unclassified workflows and stale Issue event dependencies', async () => {
  await withAuditFixture(async (root) => {
    const workflows = join(root, '.github', 'workflows');
    await writeFile(join(workflows, 'unreviewed.yml'), 'name: surprise\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs: {}\n');
    const unknownResult = await auditManualOnly(root);
    assert.equal(unknownResult.ok, false);
    assert.match(unknownResult.errors.join('\n'), /unclassified workflow/);

    await rm(join(workflows, 'unreviewed.yml'));
    const healthFile = join(workflows, 'health.yml');
    const health = await readFile(healthFile, 'utf8');
    await writeFile(healthFile, `${health}\n# stale reference: ${{ github.event.issue.title }}\n`);
    const staleResult = await auditManualOnly(root);
    assert.equal(staleResult.ok, false);
    assert.match(staleResult.errors.join('\n'), /event payload that workflow_dispatch cannot provide/);
  });
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
