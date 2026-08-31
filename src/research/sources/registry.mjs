import { readFile } from 'node:fs/promises';

const REGISTRY_FILE = new URL('../../../config/research-sources.json', import.meta.url);
export const VALID_SOURCE_TYPES = new Set(['rss', 'atom', 'github-releases']);

export async function loadResearchSources() {
  let raw;
  try {
    raw = await readFile(REGISTRY_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export function validateResearchSources(registry) {
  const errors = [];
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return ['research-sources registry must be an object keyed by account id'];
  for (const [accountId, sources] of Object.entries(registry)) {
    if (!Array.isArray(sources)) { errors.push(`${accountId}: sources must be an array`); continue; }
    const ids = new Set();
    for (const [index, source] of sources.entries()) {
      const label = `${accountId}[${index}]`;
      if (!source || typeof source !== 'object' || Array.isArray(source)) { errors.push(`${label} must be an object`); continue; }
      if (!source.id || typeof source.id !== 'string') errors.push(`${label}.id is required`);
      else if (ids.has(source.id)) errors.push(`${label}.id duplicates "${source.id}"`);
      else ids.add(source.id);
      if (!VALID_SOURCE_TYPES.has(source.type)) errors.push(`${label}.type must be one of ${[...VALID_SOURCE_TYPES].join(', ')}`);
      if (source.type === 'github-releases') {
        if (!source.owner || !source.repo) errors.push(`${label}: github-releases source requires owner and repo`);
      } else if (source.type === 'rss' || source.type === 'atom') {
        if (!source.url || !/^https:\/\//i.test(source.url)) errors.push(`${label}.url must be an https:// URL`);
      }
      if (source.enabled != null && typeof source.enabled !== 'boolean') errors.push(`${label}.enabled must be a boolean`);
      if (source.sourceRole != null && !['discovery', 'primary', 'verification', 'community'].includes(source.sourceRole)) {
        errors.push(`${label}.sourceRole must be discovery, primary, verification, or community`);
      }
      if (source.maxItems != null && (typeof source.maxItems !== 'number' || !Number.isInteger(source.maxItems) || source.maxItems <= 0)) {
        errors.push(`${label}.maxItems must be a positive integer`);
      }
      if (source.categories != null && !Array.isArray(source.categories)) errors.push(`${label}.categories must be an array`);
    }
  }
  return [...new Set(errors)];
}

// Enabled sources for one account, highest priority first. A source with no explicit priority sorts
// after every explicitly prioritized one rather than being treated as priority 0, so an operator adding
// a new source without setting priority yet does not accidentally jump ahead of curated sources.
export function sourcesForAccount(registry, accountId, extraKeys = []) {
  const keys = [accountId, ...extraKeys].filter(Boolean);
  const collected = [];
  const seen = new Set();
  for (const key of keys) {
    for (const source of registry?.[key] || []) {
      if (!source || source.enabled === false) continue;
      const id = source.id || JSON.stringify(source);
      if (seen.has(id)) continue;
      seen.add(id);
      collected.push(source);
    }
  }
  return collected
    .slice()
    .sort((a, b) => (b.priority ?? -Infinity) - (a.priority ?? -Infinity));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const registry = await loadResearchSources();
  const errors = validateResearchSources(registry);
  if (errors.length) {
    console.error(errors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Research sources OK: ${Object.keys(registry).length} account(s) configured.`);
  }
}
