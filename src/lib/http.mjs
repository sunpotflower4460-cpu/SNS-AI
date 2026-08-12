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

export async function downloadMedia(url, { maxBytes = 25 * 1024 * 1024 } = {}) {
  if (!/^https:\/\//i.test(url)) throw new Error('mediaUrl must be an https:// URL.');
  const response = await fetch(url, { redirect: 'follow' });
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
