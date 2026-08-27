import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { fetchJson } from '../lib/http.mjs';

const STATE_FILE = fileURLToPath(new URL('../../data/x-oauth2-state.json', import.meta.url));
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const REFRESH_SKEW_MS = 5 * 60_000;
const memory = new Map();
const refreshQueues = new Map();

function credentialId(credential) {
  if (credential?.oauth2StateId) return String(credential.oauth2StateId);
  const stable = `${credential?.consumerKey || ''}:${credential?.accessToken || ''}`;
  return createHash('sha256').update(stable).digest('hex').slice(0, 24);
}

function withRefreshLock(credential, task) {
  const id = credentialId(credential);
  const previous = refreshQueues.get(id) || Promise.resolve();
  const run = previous.then(task, task);
  refreshQueues.set(id, run.then(() => undefined, () => undefined));
  return run;
}

function encryptionKey() {
  const secret = String(process.env.X_OAUTH2_STATE_KEY || '');
  if (secret.length < 32) throw new Error('X media automation requires X_OAUTH2_STATE_KEY (at least 32 random characters) to persist refreshed OAuth2 tokens securely.');
  return createHash('sha256').update(secret).digest();
}

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decrypt(entry) {
  if (!entry?.iv || !entry?.tag || !entry?.ciphertext) return null;
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(entry.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  const clear = Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(clear.toString('utf8'));
}

async function readPersisted(credential) {
  const id = credentialId(credential);
  if (memory.has(id)) return memory.get(id);
  const file = await readJson(STATE_FILE, { schemaVersion: 1, accounts: {} }) || { schemaVersion: 1, accounts: {} };
  const encrypted = file.accounts?.[id];
  if (!encrypted) return null;
  const session = decrypt(encrypted);
  memory.set(id, session);
  return session;
}

async function persist(credential, session) {
  const id = credentialId(credential);
  const file = await readJson(STATE_FILE, { schemaVersion: 1, accounts: {} }) || { schemaVersion: 1, accounts: {} };
  file.schemaVersion = 1;
  file.updatedAt = new Date().toISOString();
  file.accounts ||= {};
  file.accounts[id] = { ...encrypt(session), updatedAt: file.updatedAt };
  await writeJsonAtomic(STATE_FILE, file);
  memory.set(id, session);
}

function initialSession(credential) {
  return {
    accessToken: String(credential?.oauth2AccessToken || ''),
    refreshToken: String(credential?.oauth2RefreshToken || ''),
    expiresAt: credential?.oauth2ExpiresAt || null,
    scope: credential?.oauth2Scope || null
  };
}

function refreshHeaders(credential) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (credential?.oauth2ClientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${credential.oauth2ClientId}:${credential.oauth2ClientSecret}`).toString('base64')}`;
  }
  return headers;
}

export async function refreshXOAuth2(credential, { force = false, staleAccessToken = null, allowReuse = true, requirePersist = false } = {}) {
  return withRefreshLock(credential, async () => {
    // Re-read under the lock so a concurrent refresh that already rotated the token is reused
    // instead of burning the previous refresh token a second time.
    memory.delete(credentialId(credential));
    const persisted = await readPersisted(credential);
    const current = persisted || initialSession(credential);
    const refreshToken = String(current.refreshToken || credential?.oauth2RefreshToken || '');
    const clientId = String(credential?.oauth2ClientId || '');
    if (!refreshToken) throw new Error('X OAuth2 refresh requires credential.oauth2RefreshToken from offline.access authorization.');
    if (!clientId) throw new Error('X OAuth2 refresh requires credential.oauth2ClientId.');

    const expires = Date.parse(current.expiresAt || '');
    const stillFresh = Boolean(current.accessToken)
      && Number.isFinite(expires)
      && expires > Date.now() + REFRESH_SKEW_MS;
    // requirePersist only forces the FIRST bootstrap write. Once another waiter already persisted a
    // fresh session under this lock, reuse it - otherwise two concurrent first-run bootstraps both
    // pass allowReuse:false from outside the lock and the second call burns the rotated refresh token.
    const mayReuse = allowReuse || (requirePersist && Boolean(persisted));
    if (mayReuse && stillFresh) {
      if (!force) return current;
      // 401-forced refresh: reuse only when another waiter already rotated past the stale token.
      if (staleAccessToken && current.accessToken !== staleAccessToken) return current;
    }

    const params = new URLSearchParams({ refresh_token: refreshToken, grant_type: 'refresh_token' });
    if (!credential?.oauth2ClientSecret) params.set('client_id', clientId);
    const body = await fetchJson(TOKEN_URL, {
      method: 'POST',
      headers: refreshHeaders(credential),
      body: params.toString()
    });
    if (!body?.access_token) throw new Error('X OAuth2 refresh returned no access_token.');
    const expiresIn = Number(body.expires_in || 7200);
    const session = {
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token || refreshToken),
      expiresAt: new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString(),
      scope: body.scope || current.scope || null,
      tokenType: body.token_type || 'bearer'
    };
    await persist(credential, session);
    return session;
  });
}

export async function getXOAuth2Session(credential, { forceRefresh = false } = {}) {
  const persisted = await readPersisted(credential);
  const session = persisted || initialSession(credential);
  const expires = Date.parse(session.expiresAt || '');
  const needsBootstrap = !persisted && Boolean(session.refreshToken);
  const expiring = Number.isFinite(expires) && expires <= Date.now() + REFRESH_SKEW_MS;
  if (forceRefresh || needsBootstrap || !session.accessToken || expiring) {
    return refreshXOAuth2(credential, {
      force: forceRefresh,
      staleAccessToken: forceRefresh ? session.accessToken : null,
      // First-run bootstrap must hit the token endpoint so the encrypted state file is created,
      // even when the credential payload already carries a not-yet-expired access token. Re-check
      // under the refresh lock (requirePersist) so a concurrent bootstrap does not refresh twice.
      allowReuse: !needsBootstrap,
      requirePersist: needsBootstrap
    });
  }
  return session;
}

export async function xOAuth2FetchJson(url, options = {}, credential) {
  let session = await getXOAuth2Session(credential);
  const request = (token) => fetchJson(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  try {
    return await request(session.accessToken);
  } catch (error) {
    if (Number(error.status) !== 401) throw error;
    session = await getXOAuth2Session(credential, { forceRefresh: true });
    return request(session.accessToken);
  }
}

export async function verifyXOAuth2Session(credential) {
  const session = await getXOAuth2Session(credential);
  return {
    expiresAt: session.expiresAt || null,
    hasRefreshToken: Boolean(session.refreshToken),
    scope: session.scope || null
  };
}

export const __test = { credentialId };
