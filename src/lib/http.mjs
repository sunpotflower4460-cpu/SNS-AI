export async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }

  if (!response.ok) {
    const detail = body?.detail || body?.error?.message || body?.title || raw || response.statusText;
    const error = new Error(`HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

export async function downloadMedia(url) {
  if (!/^https:\/\//i.test(url)) {
    throw new Error('mediaUrl must be an https:// URL.');
  }
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Could not download media (${response.status}).`);
  const contentType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
  const bytes = await response.arrayBuffer();
  return { bytes, contentType };
}
