import { readFile } from 'node:fs/promises';

const REGISTRY_FILE = new URL('../../config/affiliate-programs.json', import.meta.url);
const VALID_PROVIDERS = new Set(['impact', 'postaffiliatepro', 'affiliatly', 'manual']);
const VALID_STATUSES = new Set(['application_required', 'applied', 'approved', 'rejected', 'paused']);

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateAffiliateRegistry(registry) {
  const errors = [];
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return ['affiliate registry must be an object'];
  if (!Array.isArray(registry.programs)) return ['affiliate registry programs must be an array'];
  const ids = new Set();
  for (const [index, program] of registry.programs.entries()) {
    const label = `programs[${index}]`;
    if (!program || typeof program !== 'object' || Array.isArray(program)) { errors.push(`${label} must be an object`); continue; }
    if (!program.id || typeof program.id !== 'string') errors.push(`${label}.id is required`);
    else if (ids.has(program.id)) errors.push(`${label}.id duplicates "${program.id}"`);
    else ids.add(program.id);
    if (!VALID_PROVIDERS.has(program.provider)) errors.push(`${label}.provider is unsupported`);
    if (!VALID_STATUSES.has(program.status)) errors.push(`${label}.status is unsupported`);
    if (!Array.isArray(program.brands) || program.brands.length === 0) errors.push(`${label}.brands must contain at least one brand`);
    if (!/^https:\/\//i.test(program.officialProgramUrl || '')) errors.push(`${label}.officialProgramUrl must be HTTPS`);
    if (!Array.isArray(program.requiredSecrets)) errors.push(`${label}.requiredSecrets must be an array`);
    if (!Array.isArray(program.requiredManualValues)) errors.push(`${label}.requiredManualValues must be an array`);
    if (program.status === 'approved' && program.reverifyBeforeActivation !== true) errors.push(`${label}: approved programs must still be reverified before activation`);
  }
  return [...new Set(errors)];
}

export async function loadAffiliateRegistry() {
  const raw = await readFile(REGISTRY_FILE, 'utf8');
  const registry = JSON.parse(raw);
  const errors = validateAffiliateRegistry(registry);
  if (errors.length) throw new Error(`Invalid affiliate registry:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  return registry;
}

export function matchAffiliatePrograms(registry, brandOrMerchant) {
  const needle = normalized(brandOrMerchant);
  if (!needle) return [];
  return registry.programs.filter((program) => program.brands.some((brand) => {
    const candidate = normalized(brand);
    return candidate === needle || candidate.includes(needle) || needle.includes(candidate);
  }));
}

export function programReadiness(program, { env = process.env, manualValues = {} } = {}) {
  const missingSecrets = (program.requiredSecrets || []).filter((name) => !String(env[name] || '').trim());
  const values = manualValues[program.id] || {};
  const missingManualValues = (program.requiredManualValues || []).filter((name) => !String(values[name] || '').trim());
  const approved = program.status === 'approved';
  return {
    id: program.id,
    name: program.name,
    provider: program.provider,
    status: program.status,
    approved,
    missingSecrets,
    missingManualValues,
    reverifyBeforeActivation: program.reverifyBeforeActivation === true,
    readyForLiveLinking: approved && missingSecrets.length === 0 && missingManualValues.length === 0 && program.reverifyBeforeActivation === false
  };
}

export function registryReadiness(registry, options = {}) {
  return registry.programs.map((program) => programReadiness(program, options));
}

export const __test = { normalized, VALID_PROVIDERS, VALID_STATUSES };
