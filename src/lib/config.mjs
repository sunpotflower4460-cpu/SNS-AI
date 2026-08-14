import { readFile } from 'node:fs/promises';

const ACCOUNTS_FILE = new URL('../../config/accounts.json', import.meta.url);
const NESTED_SECTION_KEYS = {
  safety: ['anomalyBrake'],
  generation: ['naturalization'],
  media: ['qa'],
  monetization: ['affiliate']
};

export async function loadConfig() {
  const raw = await readFile(ACCOUNTS_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed?.accounts || typeof parsed.accounts !== 'object') {
    throw new Error('config/accounts.json must contain an "accounts" object.');
  }
  return { defaults: parsed.defaults || {}, accounts: parsed.accounts };
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeSection(defaults, account, key) {
  const base = defaults?.[key] || {};
  const override = account?.[key] || {};
  const result = { ...base, ...override };
  for (const nestedKey of NESTED_SECTION_KEYS[key] || []) {
    if (plainObject(base[nestedKey]) && plainObject(override[nestedKey])) {
      result[nestedKey] = { ...base[nestedKey], ...override[nestedKey] };
    }
  }
  return result;
}

export async function loadAccounts() {
  const config = await loadConfig();
  const output = {};
  for (const [id, account] of Object.entries(config.accounts)) {
    output[id] = {
      timezone: config.defaults.timezone || 'Asia/Tokyo',
      mode: config.defaults.mode || 'pause',
      ...account,
      // Treat only literal true as enabled even if a caller deliberately bypasses npm run validate.
      enabled: account.enabled === true,
      safety: mergeSection(config.defaults, account, 'safety'),
      generation: mergeSection(config.defaults, account, 'generation'),
      analytics: mergeSection(config.defaults, account, 'analytics'),
      learning: mergeSection(config.defaults, account, 'learning'),
      research: mergeSection(config.defaults, account, 'research'),
      resilience: mergeSection(config.defaults, account, 'resilience'),
      budgets: mergeSection(config.defaults, account, 'budgets'),
      experiments: mergeSection(config.defaults, account, 'experiments'),
      maintenance: mergeSection(config.defaults, account, 'maintenance'),
      objectives: mergeSection(config.defaults, account, 'objectives'),
      media: mergeSection(config.defaults, account, 'media'),
      monetization: mergeSection(config.defaults, account, 'monetization'),
      schedule: account.schedule
        ? { timezone: account.schedule.timezone || config.defaults.timezone || 'Asia/Tokyo', ...account.schedule }
        : account.schedule
    };
  }
  return output;
}

export function loadCredentials() {
  const raw = process.env.SOCIAL_CREDENTIALS_JSON;
  if (!raw) throw new Error('Missing SOCIAL_CREDENTIALS_JSON. Add it as a GitHub Actions repository secret.');
  // Never interpolate the JSON.parse error message here: V8 embeds a literal excerpt of the input
  // around the parse failure, and this input is real credential material. That excerpt would then
  // flow into audit logs, CLI/Action output, and committed reports - all of which bypass GitHub's
  // secret masking (which only redacts exact known secret values, not arbitrary substrings).
  try { return JSON.parse(raw); }
  catch { throw new Error('SOCIAL_CREDENTIALS_JSON is not valid JSON.'); }
}

export async function resolveAccount(accountId, { allowDisabled = false } = {}) {
  if (!accountId) throw new Error('Missing account ID.');
  const accounts = await loadAccounts();
  const account = accounts[accountId];
  if (!account) throw new Error(`Unknown account "${accountId}". Add it to config/accounts.json.`);
  if (!allowDisabled && account.enabled !== true) throw new Error(`Account "${accountId}" is disabled in config/accounts.json.`);
  if (!['x', 'instagram'].includes(account.platform)) {
    throw new Error(`Unsupported platform "${account.platform}" for account "${accountId}".`);
  }
  const credentials = loadCredentials();
  const credentialKey = account.credentialKey || accountId;
  const credential = credentials[credentialKey];
  if (!credential) throw new Error(`No credentials found for key "${credentialKey}" in SOCIAL_CREDENTIALS_JSON.`);
  const resolvedCredential = account.platform === 'x'
    ? { ...credential, oauth2StateId: credential.oauth2StateId || credentialKey }
    : credential;
  return { id: accountId, ...account, credential: resolvedCredential };
}

export const __test = { mergeSection, plainObject };
