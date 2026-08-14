import { loadAffiliateRegistry, registryReadiness } from './affiliate-registry.mjs';

export async function buildAffiliateReadinessReport({ env = process.env, manualValues = {} } = {}) {
  const registry = await loadAffiliateRegistry();
  const programs = registryReadiness(registry, { env, manualValues });
  const summary = {
    totalPrograms: programs.length,
    approvedPrograms: programs.filter((program) => program.approved).length,
    readyForLiveLinking: programs.filter((program) => program.readyForLiveLinking).length,
    applicationRequired: programs.filter((program) => program.status === 'application_required').length
  };
  return { generatedAt: new Date().toISOString(), lastVerifiedAt: registry.lastVerifiedAt || null, summary, programs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const report = await buildAffiliateReadinessReport();
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
