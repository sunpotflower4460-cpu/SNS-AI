import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadRuntimePolicy } from './manual-only.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const OPERATIONAL_WORKFLOWS = new Set([
  'account-control.yml', 'autopilot.yml', 'chatops.yml', 'compliance-attestation.yml',
  'engagement-control.yml', 'engagement-scheduled.yml', 'engagement.yml', 'health.yml',
  'hub-reconcile.yml', 'intelligence.yml', 'learning.yml', 'maintenance.yml', 'metrics.yml',
  'policy.yml', 'preflight.yml', 'publish-reconcile.yml', 'publish.yml'
]);

export async function auditManualOnly(root = ROOT) {
  const errors = [];
  const runtime = await loadRuntimePolicy(join(root, 'config/runtime-policy.json'));
  if (runtime.manualOnly !== true) errors.push('config/runtime-policy.json must set manualOnly:true');
  for (const key of ['requireExplicitManualInvocation']) if (runtime[key] !== true) errors.push(`${key} must be true`);
  for (const key of ['allowAutomaticAccountActivation', 'allowAutomaticEngagement', 'allowScheduledProviderPolling']) if (runtime[key] !== false) errors.push(`${key} must be false`);

  const accounts = JSON.parse(await readFile(join(root, 'config/accounts.json'), 'utf8'));
  for (const [id, account] of Object.entries(accounts.accounts || {})) if (account.enabled !== false) errors.push(`account ${id} must be disabled`);
  const engagement = JSON.parse(await readFile(join(root, 'config/engagement-policy.json'), 'utf8'));
  if (engagement.enabled !== false || engagement.autoReply !== false || engagement.autoDmReply !== false || engagement.approvalRequired !== true) errors.push('engagement must be disabled, non-automatic, and approval-required');
  if (!Array.isArray(engagement.liveAccounts) || engagement.liveAccounts.length) errors.push('engagement liveAccounts must be []');

  const workflowDir = join(root, '.github/workflows');
  for (const name of await readdir(workflowDir)) {
    if (!OPERATIONAL_WORKFLOWS.has(name)) continue;
    const yaml = await readFile(join(workflowDir, name), 'utf8');
    const onBlock = yaml.match(/^on:\s*\n([\s\S]*?)^permissions:/m)?.[1] || '';
    const triggers = [...onBlock.matchAll(/^  ([A-Za-z_]+):/gm)].map((match) => match[1]).filter((name) => name !== 'inputs');
    if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') errors.push(`${name} operational trigger must be workflow_dispatch only (found: ${triggers.join(', ') || 'none'})`);
    if (/^\s*(?:schedule|cron|push|pull_request|workflow_run|repository_dispatch|workflow_call|issues):/m.test(onBlock)) errors.push(`${name} contains an unattended trigger`);
  }
  return { ok: errors.length === 0, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await auditManualOnly();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
