function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function ngrams(text, n = 3) {
  const value = normalize(text);
  if (!value) return new Set();
  if (value.length <= n) return new Set([value]);
  const grams = new Set();
  for (let index = 0; index <= value.length - n; index += 1) {
    grams.add(value.slice(index, index + n));
  }
  return grams;
}

export function similarity(a, b) {
  const left = ngrams(a);
  const right = ngrams(b);
  if (!left.size || !right.size) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

// A malformed threshold must not silently disable duplicate detection. threshold is a MINIMUM
// similarity score to flag a duplicate, so a higher value is more permissive (lets more near-repeats
// through) - failing closed here means the strictest value (0), which flags virtually everything as a
// duplicate and blocks generation until the config is fixed, mirroring safeMaxPostsPerDay in
// src/lib/safety.mjs (fail closed to "nothing allowed", never to "everything allowed").
export function safeDuplicateThreshold(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

export function findNearDuplicate(text, history, threshold = 0.72) {
  let best = null;
  for (const entry of history || []) {
    if (!entry?.text) continue;
    const score = similarity(text, entry.text);
    if (!best || score > best.score) best = { score, entry };
  }
  return best && best.score >= threshold ? best : null;
}
