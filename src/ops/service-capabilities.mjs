import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveArtistOsMode, MODE_MANAGED } from './artist-os-mode.mjs';

// Capability snapshot shaped like the Artist OS service-health contract v1. No HTTP, no secrets:
// only mode flags and static capability names are emitted.
//
// inboundReplyExecution derivation (standalone only): true when the engagement policy is `enabled`
// AND lists at least one `liveAccounts` entry, i.e. a live send is actually reachable. Managed mode
// always yields false and never lists any `reply.*.execute` capability.

const pkgVersion = async () => JSON.parse(await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version;

export function buildServiceCapabilities({ env = process.env, policy, engagementPolicy, now = new Date(), version = null } = {}) {
  const { mode, modeInvalid } = resolveArtistOsMode(env, policy);
  const managed = mode === MODE_MANAGED;
  const sendPossible = !managed
    && engagementPolicy?.enabled === true
    && Array.isArray(engagementPolicy.liveAccounts)
    && engagementPolicy.liveAccounts.length > 0;
  const capabilities = ['recommendation.read', 'strategy.read'];
  if (sendPossible) capabilities.push('reply.x.execute', 'reply.instagram.execute');
  const out = {
    contractVersion: 1,
    service: 'sns-ai',
    version,
    status: modeInvalid ? 'degraded' : 'healthy',
    ...(modeInvalid ? { degradedReason: 'ARTIST_OS_MODE has an unrecognised value; failing closed to artist_os_managed.' } : {}),
    capabilities,
    checkedAt: new Date(now).toISOString(),
    runtimeMode: mode,
    modeInvalid,
    ownership: { inboundReplyExecution: sendPossible, recommendation: true }
  };
  return out;
}

export async function loadCapabilitySnapshot({ env = process.env, now = new Date() } = {}) {
  const { loadRuntimePolicy } = await import('./manual-only.mjs');
  const { loadEngagementPolicy } = await import('../engagement/policy.mjs');
  let policy = null; let engagementPolicy = null; let loadError = null;
  try { policy = await loadRuntimePolicy(); } catch (error) { loadError = `runtime policy unreadable: ${error.message}`; }
  try { engagementPolicy = await loadEngagementPolicy(); } catch { engagementPolicy = null; }
  const snapshot = buildServiceCapabilities({ env, policy, engagementPolicy, now, version: await pkgVersion() });
  if (loadError && snapshot.status === 'healthy') { snapshot.status = 'degraded'; snapshot.degradedReason = loadError.slice(0, 200); }
  return snapshot;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await loadCapabilitySnapshot(), null, 2));
}
