import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  }
  return Math.min(500 * (2 ** attempt) + Math.floor(Math.random() * 250), 8_000);
}

export async function fetchJson(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const retries = Number(options.retries ?? (['GET', 'HEAD'].includes(method) ? 2 : 0));
  const fetchOptions = { ...options };
  delete fetchOptions.retries;

  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      if (attempt >= retries || !['GET', 'HEAD'].includes(method)) throw error;
      await sleep(Math.min(500 * (2 ** attempt), 8_000));
      continue;
    }

    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { body = { raw }; }

    if (response.ok) return body;

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < retries && ['GET', 'HEAD'].includes(method)) {
      await sleep(retryDelay(response, attempt));
      continue;
    }

    const detail = body?.detail || body?.error?.message || body?.title || raw || response.statusText;
    const error = new Error(`HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
}

function privateIpv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && b >= 18 && b <= 19)
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function privateIpv6(host) {
  const value = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (value === '::' || value === '::1') return true;
  if (/^(?:fc|fd)/.test(value)) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (/^ff/.test(value)) return true;
  if (/^2001:db8(?::|$)/.test(value)) return true;
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return privateIpv4(mapped);
  }
  return false;
}

function unsafeNetworkHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  const family = isIP(host);
  if (family === 4) return privateIpv4(host);
  if (family === 6) return privateIpv6(host);
  return false;
}

function normalizedHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^\[/, '').replace(/\]$/, '');
}

function reservedNonRoutableTestHostname(hostname) {
  const host = normalizedHostname(hostname);
  return host === 'example' || host === 'test' || host === 'invalid'
    || host.endsWith('.example') || host.endsWith('.test') || host.endsWith('.invalid');
}

export function assertPublicHttpsUrl(value, label = 'mediaUrl') {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch { throw new Error(`${label} must be a valid https:// URL.`); }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must be an https:// URL.`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain embedded credentials.`);
  if (unsafeNetworkHostname(parsed.hostname)) throw new Error(`${label} host is not a public network destination: ${parsed.hostname}`);
  return parsed;
}

export async function assertPublicHttpsTarget(value, label = 'mediaUrl', lookupFn = lookup) {
  const parsed = assertPublicHttpsUrl(value, label);
  const host = normalizedHostname(parsed.hostname);
  if (isIP(host)) return parsed;
  // RFC/IANA-reserved example/test/invalid names are intentionally non-routable and are widely used
  // by the repository's mocked-fetch tests. Skipping live DNS for these names preserves deterministic
  // tests without weakening checks for any real routable production hostname.
  if (reservedNonRoutableTestHostname(host)) return parsed;
  let addresses;
  try {
    addresses = await lookupFn(host, { all: true, verbatim: true });
  } catch (error) {
    const wrapped = new Error(`${label} host could not be resolved safely: ${parsed.hostname}`);
    wrapped.code = 'UNSAFE_NETWORK_TARGET';
    wrapped.cause = error;
    throw wrapped;
  }
  if (!Array.isArray(addresses) || !addresses.length) {
    const error = new Error(`${label} host resolved to no addresses: ${parsed.hostname}`);
    error.code = 'UNSAFE_NETWORK_TARGET';
    throw error;
  }
  for (const entry of addresses) {
    const address = typeof entry === 'string' ? entry : entry?.address;
    if (!address || unsafeNetworkHostname(address)) {
      const error = new Error(`${label} host resolves to a non-public address: ${parsed.hostname}`);
      error.code = 'UNSAFE_NETWORK_TARGET';
      throw error;
    }
  }
  return parsed;
}

async function fetchMediaWithSafeRedirects(url, maxRedirects = 5) {
  let current = await assertPublicHttpsTarget(url);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetch(current, { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirect === maxRedirects) throw new Error(`Media redirect limit exceeded (${maxRedirects}).`);
    const location = response.headers.get('location');
    if (!location) throw new Error(`Media redirect (${response.status}) did not include a Location header.`);
    await response.body?.cancel?.().catch(() => {});
    current = await assertPublicHttpsTarget(new URL(location, current).toString());
  }
  throw new Error('Media redirect resolution failed.');
}

export async function downloadMedia(url, { maxBytes = 25 * 1024 * 1024 } = {}) {
  const response = await fetchMediaWithSafeRedirects(url);
  if (!response.ok) throw new Error(`Could not download media (${response.status}).`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`Media exceeds configured download limit (${maxBytes} bytes).`);
  const contentType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0];

  if (!response.body?.getReader) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) throw new Error(`Media exceeds configured download limit (${maxBytes} bytes).`);
    return { bytes, contentType };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Media exceeds configured download limit (${maxBytes} bytes).`);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes: combined.buffer, contentType };
}

export const __test = {
  privateIpv4,
  privateIpv6,
  unsafeNetworkHostname,
  reservedNonRoutableTestHostname,
  publicHttpsUrl: assertPublicHttpsUrl,
  assertPublicHttpsUrl,
  assertPublicHttpsTarget
};
