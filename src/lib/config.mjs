import { readFile } from 'node:fs/promises';

const ACCOUNTS_FILE = new URL('../../config/accounts.json', import.meta.url);

export async function loadAccounts() {
  const raw = await readFile(ACCOUNTS_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed?.accounts || typeof parsed.accounts !== 'object') {
    throw new Error('config/accounts.json must contain an "accounts" object.');
  }
  return parsed.accounts;
}

export function loadCredentials() {
  const raw = process.env.SOCIAL_CREDENTIALS_JSON;
  if (!raw) {
    throw new Error('Missing SOCIAL_CREDENTIALS_JSON. Add it as a GitHub Actions repository secret.');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`SOCIAL_CREDENTIALS_JSON is not valid JSON: ${error.message}`);
  }

  return parsed;
}

export async function resolveAccount(accountId) {
  if (!accountId) throw new Error('Missing account ID.');

  const accounts = await loadAccounts();
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Unknown account "${accountId}". Add it to config/accounts.json.`);
  }
  if (!account.enabled) {
    throw new Error(`Account "${accountId}" is disabled in config/accounts.json.`);
  }
  if (!['x', 'instagram'].includes(account.platform)) {
    throw new Error(`Unsupported platform "${account.platform}" for account "${accountId}".`);
  }

  const credentials = loadCredentials();
  const credentialKey = account.credentialKey || accountId;
  const credential = credentials[credentialKey];
  if (!credential) {
    throw new Error(`No credentials found for key "${credentialKey}" in SOCIAL_CREDENTIALS_JSON.`);
  }

  return { id: accountId, ...account, credential };
}
