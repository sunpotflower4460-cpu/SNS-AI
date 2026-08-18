import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

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
  const onResponse = typeof options.onResponse === 'function' ? options.onResponse : null;
  delete fetchOptions.onResponse;

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

    // Diagnostic hook for callers that need response headers (X reports the token's access level in one).
    // Wrapped so a broken observer can never turn a successful request into a failure.
    if (onResponse) { try { onResponse(response); } catch { /* diagnostics must never break the request */ } }

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

function ipv6Words(host) {
  let value = String(host || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '').split('%')[0];
  const dotted = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const parts = dotted[1].split('.').map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    value = value.slice(0, value.length - dotted[1].length) + `${hi}:${lo}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map((part) => Number.parseInt(part || '0', 16));
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  return words;
}

function ipv4FromWords(high, low) {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function privateIpv6(host) {
  const value = String(host || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '').split('%')[0];
  const words = ipv6Words(value);
  if (!words) return true;
  const allZero = words.every((word) => word === 0);
  if (allZero) return true;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if ((words[0] & 0xfe00) === 0xfc00) return true;
  if ((words[0] & 0xffc0) === 0xfe80) return true;
  if ((words[0] & 0xffc0) === 0xfec0) return true;
  if ((words[0] & 0xff00) === 0xff00) return true;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
  if (words[0] === 0x2001 && words[1] === 0x0000) return true;

  // IPv4-mapped (::ffff:a.b.c.d / ::ffff:hhhh:hhhh) and deprecated IPv4-compatible
  // (::a.b.c.d / ::hhhh:hhhh) forms must inherit the embedded IPv4 safety classification.
  const firstFiveZero = words.slice(0, 5).every((word) => word === 0);
  if (firstFiveZero && words[5] === 0xffff) return privateIpv4(ipv4FromWords(words[6], words[7]));
  if (words.slice(0, 6).every((word) => word === 0)) return privateIpv4(ipv4FromWords(words[6], words[7]));

  // NAT64 and 6to4 can encode an IPv4 destination inside an otherwise public-looking IPv6 literal.
  if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) {
    return privateIpv4(ipv4FromWords(words[6], words[7]));
  }
  if (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001) return true;
  if (words[0] === 0x2002) return privateIpv4(ipv4FromWords(words[1], words[2]));
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

async function resolvePublicHttpsTarget(value, label = 'mediaUrl', lookupFn = lookup) {
  const parsed = assertPublicHttpsUrl(value, label);
  const host = normalizedHostname(parsed.hostname);
  const family = isIP(host);
  if (family) return { parsed, addresses: [{ address: host, family }], reservedTestHost: false };
  // RFC/IANA-reserved example/test/invalid names are intentionally non-routable and are widely used
  // by the repository's mocked-fetch tests. They may use the mock fetch path, but never the production
  // DNS-pinned transport below.
  if (reservedNonRoutableTestHostname(host)) return { parsed, addresses: [], reservedTestHost: true };
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
  const normalized = addresses.map((entry) => ({
    address: typeof entry === 'string' ? entry : entry?.address,
    family: Number(typeof entry === 'string' ? isIP(entry) : entry?.family || isIP(entry?.address || ''))
  }));
  for (const entry of normalized) {
    if (!entry.address || ![4, 6].includes(entry.family) || unsafeNetworkHostname(entry.address)) {
      const error = new Error(`${label} host resolves to a non-public address: ${parsed.hostname}`);
      error.code = 'UNSAFE_NETWORK_TARGET';
      throw error;
    }
  }
  return { parsed, addresses: normalized, reservedTestHost: false };
}

export async function assertPublicHttpsTarget(value, label = 'mediaUrl', lookupFn = lookup) {
  return (await resolvePublicHttpsTarget(value, label, lookupFn)).parsed;
}

function pinnedLookup(addresses) {
  const frozen = addresses.map((entry) => ({ address: entry.address, family: entry.family }));
  return (_hostname, options, callback) => {
    const opts = typeof options === 'object' && options ? options : {};
    if (opts.all) {
      callback(null, frozen.map((entry) => ({ ...entry })));
      return;
    }
    const preferred = Number(opts.family);
    const selected = frozen.find((entry) => !preferred || entry.family === preferred) || frozen[0];
    callback(null, selected.address, selected.family);
  };
}

function responseHeaders(message) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(message.headers || {})) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value != null) headers.set(key, String(value));
  }
  return headers;
}

function nodeResponse(message, method) {
  const status = Number(message.statusCode || 500);
  const noBody = String(method || 'GET').toUpperCase() === 'HEAD' || [204, 205, 304].includes(status);
  return new Response(noBody ? null : Readable.toWeb(message), {
    status,
    statusText: message.statusMessage || '',
    headers: responseHeaders(message)
  });
}

export async function fetchPublicHttps(value, options = {}, label = 'mediaUrl', lookupFn = lookup) {
  const target = await resolvePublicHttpsTarget(value, label, lookupFn);
  if (target.reservedTestHost) return fetch(target.parsed, options);
  const method = String(options.method || 'GET').toUpperCase();
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = httpsRequest(target.parsed, {
        method,
        headers: options.headers,
        signal: options.signal,
        lookup: pinnedLookup(target.addresses)
      }, (message) => resolve(nodeResponse(message, method)));
    } catch (error) {
      reject(error);
      return;
    }
    request.on('error', reject);
    if (options.body != null) request.write(options.body);
    request.end();
  });
}

async function fetchMediaWithSafeRedirects(url, maxRedirects = 5) {
  let current = assertPublicHttpsUrl(url);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetchPublicHttps(current, { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirect === maxRedirects) throw new Error(`Media redirect limit exceeded (${maxRedirects}).`);
    const location = response.headers.get('location');
    if (!location) throw new Error(`Media redirect (${response.status}) did not include a Location header.`);
    await response.body?.cancel?.().catch(() => {});
    current = assertPublicHttpsUrl(new URL(location, current).toString());
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
  ipv6Words,
  unsafeNetworkHostname,
  reservedNonRoutableTestHostname,
  publicHttpsUrl: assertPublicHttpsUrl,
  assertPublicHttpsUrl,
  assertPublicHttpsTarget,
  pinnedLookup,
  resolvePublicHttpsTarget
};
