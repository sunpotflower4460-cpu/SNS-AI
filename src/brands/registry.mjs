import { readFile } from 'node:fs/promises';

const BRANDS_FILE = new URL('../../config/brands.json', import.meta.url);
const VALID_STRATEGIES = new Set(['plugin-radar', 'artist-support', 'scaffold']);

export async function loadBrandsFile() {
  const raw = await readFile(BRANDS_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed?.brands || typeof parsed.brands !== 'object' || Array.isArray(parsed.brands)) {
    throw new Error('config/brands.json must contain a "brands" object.');
  }
  return parsed;
}

export function brandEntries(file) {
  return Object.entries(file?.brands || {});
}

export function accountIdsForBrand(brand) {
  const accounts = brand?.accounts || {};
  return [accounts.x, accounts.instagram].filter((id) => typeof id === 'string' && id.trim());
}

export function indexBrands(file) {
  const byId = {};
  const byAccountId = {};
  for (const [brandId, brand] of brandEntries(file)) {
    const record = { brandId, ...brand };
    byId[brandId] = record;
    for (const accountId of accountIdsForBrand(brand)) {
      byAccountId[accountId] = record;
    }
  }
  return { byId, byAccountId };
}

export function resolveBrandForAccount(file, accountId, account = {}) {
  const { byId, byAccountId } = indexBrands(file);
  if (account.brandId && byId[account.brandId]) return byId[account.brandId];
  return byAccountId[accountId] || null;
}

export function siblingAccountId(brand, platform) {
  if (!brand?.accounts) return null;
  if (platform === 'x') return brand.accounts.instagram || null;
  if (platform === 'instagram') return brand.accounts.x || null;
  return null;
}

export function researchKeyFor(brand, accountId) {
  return brand?.sharedResearchId || accountId;
}

export function validateBrands(file, accountIds = []) {
  const errors = [];
  if (!file?.brands || typeof file.brands !== 'object' || Array.isArray(file.brands)) {
    return ['brands.json must contain a brands object'];
  }
  const knownAccounts = new Set(accountIds);
  const claimed = new Map();
  for (const [brandId, brand] of brandEntries(file)) {
    if (!brand || typeof brand !== 'object' || Array.isArray(brand)) {
      errors.push(`${brandId}: brand must be an object`);
      continue;
    }
    if (brand.enabled != null && typeof brand.enabled !== 'boolean') errors.push(`${brandId}: enabled must be a boolean`);
    if (brand.strategy && !VALID_STRATEGIES.has(brand.strategy)) errors.push(`${brandId}: unsupported strategy "${brand.strategy}"`);
    if (brand.strategy === 'scaffold' && brand.enabled === true) {
      errors.push(`${brandId}: scaffold brands must remain disabled until an operator defines them`);
    }
    for (const accountId of accountIdsForBrand(brand)) {
      if (knownAccounts.size && !knownAccounts.has(accountId)) {
        errors.push(`${brandId}: account "${accountId}" is not in config/accounts.json`);
      }
      if (claimed.has(accountId)) errors.push(`account "${accountId}" is claimed by both ${claimed.get(accountId)} and ${brandId}`);
      else claimed.set(accountId, brandId);
    }
  }
  return [...new Set(errors)];
}

export const __test = { VALID_STRATEGIES, brandEntries, accountIdsForBrand };
