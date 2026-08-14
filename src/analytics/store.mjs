import { fileURLToPath } from 'node:url';
import { appendJsonl, readJsonlStrict } from '../lib/json-store.mjs';

const METRICS_FILE = fileURLToPath(new URL('../../data/metrics.jsonl', import.meta.url));

export async function readMetricSnapshots() {
  return readJsonlStrict(METRICS_FILE, 'data/metrics.jsonl');
}

export async function appendMetricSnapshot(snapshot) {
  const row = { collectedAt: new Date().toISOString(), ...snapshot };
  await appendJsonl(METRICS_FILE, row);
  return row;
}

export function snapshotsForPost(entries, account, providerPostId) {
  return (entries || []).filter((row) => row.account === account && String(row.providerPostId) === String(providerPostId));
}

export function latestSnapshots(entries) {
  const map = new Map();
  for (const row of entries || []) {
    const key = `${row.account}:${row.providerPostId}`;
    const previous = map.get(key);
    if (!previous || new Date(row.collectedAt) > new Date(previous.collectedAt)) map.set(key, row);
  }
  return [...map.values()];
}
