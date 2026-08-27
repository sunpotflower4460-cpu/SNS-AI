import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const RUNTIME_POLICY_FILE = fileURLToPath(new URL('../../config/runtime-policy.json', import.meta.url));

export async function loadRuntimePolicy(path = RUNTIME_POLICY_FILE) {
  const policy = JSON.parse(await readFile(path, 'utf8'));
  if (policy?.schemaVersion !== 1 || typeof policy.manualOnly !== 'boolean') throw new Error('Runtime policy is missing schemaVersion:1 or boolean manualOnly.');
  return policy;
}

export function manualOnlyError(operation) {
  const error = new Error(`Manual-Only policy blocks ${operation}. Change config/runtime-policy.json through code review before enabling automation.`);
  error.code = 'MANUAL_ONLY_BLOCKED';
  return error;
}

export function assertLifecycleTransitionAllowed(policy, target) {
  if (policy?.manualOnly === true && ['approval', 'auto'].includes(String(target))) throw manualOnlyError(`account transition to ${target}`);
  // After Manual-Only is lifted, allowAutomaticAccountActivation remains a separate reviewed switch.
  // Without runtime enforcement it was audit-only, so a single config edit flipping manualOnly:false
  // while leaving allowAutomaticAccountActivation:false would still permit ChatOps promotion to
  // approval/auto - the opposite of the flag's documented meaning.
  if (['approval', 'auto'].includes(String(target)) && policy?.allowAutomaticAccountActivation !== true && policy?.manualOnly !== true) {
    throw manualOnlyError(`account transition to ${target} while allowAutomaticAccountActivation is not true`);
  }
}

export function assertEngagementActivationAllowed(policy, active) {
  if (policy?.manualOnly === true && active === true) throw manualOnlyError('engagement activation');
  // Mirror allowScheduledProviderPolling: this flag must gate runtime activation, not only CI audit.
  if (active === true && policy?.allowAutomaticEngagement !== true && policy?.manualOnly !== true) {
    throw manualOnlyError('engagement activation while allowAutomaticEngagement is not true');
  }
}

export function assertAutomaticEngagementAllowed(policy, { dryRun = false } = {}) {
  if (dryRun) return true;
  // Under Manual-Only, live engagement still requires SNS_MANUAL_INVOCATION + liveAccounts and is
  // blocked from ChatOps activation. This flag is the post-Manual-Only reviewed switch that must
  // keep unattended/automatic engagement inert even if liveAccounts were left populated.
  if (policy?.manualOnly === true) return true;
  if (policy?.allowAutomaticEngagement !== true) {
    throw manualOnlyError('automatic engagement while allowAutomaticEngagement is not true');
  }
  return true;
}

export function isExplicitManualInvocation() {
  return process.env.SNS_MANUAL_INVOCATION === 'true';
}

export function assertProviderMutationAllowed(policy, { dryRun = false, source } = {}) {
  if (dryRun || policy?.manualOnly !== true) return true;
  // requireExplicitManualInvocation used to gate this independently of manualOnly, so a config edit
  // that dropped or flipped just that one field (leaving manualOnly:true untouched, still reading as
  // fully locked) silently removed the SNS_MANUAL_INVOCATION requirement - the one thing that actually
  // distinguishes a human-run workflow_dispatch from an unattended call. manual-only-audit.mjs already
  // requires this field to be true at the CI-config layer; that must not be the only place enforcing
  // it, since code invoked outside that workflow step (e.g. a direct `node src/publish.mjs` run) never
  // executes the audit script. The explicit-invocation marker is now required unconditionally whenever
  // manualOnly is true, regardless of this field's value - it is not a separate, independently
  // disable-able knob.
  if (!isExplicitManualInvocation()) throw manualOnlyError(`an unattended provider mutation (source: ${source || 'unknown'})`);
  return true;
}
