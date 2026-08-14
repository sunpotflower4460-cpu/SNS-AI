import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { readMetricSnapshots } from '../src/analytics/store.mjs';
import { readJsonl } from '../src/lib/json-store.mjs';

const METRICS_FILE = fileURLToPath(new URL('../data/metrics.jsonl', import.meta.url));

async function snapshotFile(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function restoreFile(path, bytes) {
  if (bytes === null) await rm(path, { force: true });
  else await writeFile(path, bytes);
}

test('metrics safety data fails closed on malformed JSONL while generic JSONL reading remains tolerant', async () => {
  const saved = await snapshotFile(METRICS_FILE);
  try {
    await writeFile(METRICS_FILE, '{"account":"acct","providerPostId":"1","collectedAt":"2026-08-14T00:00:00.000Z"}\n{broken-json\n', 'utf8');

    await assert.rejects(
      readMetricSnapshots(),
      (error) => error?.code === 'JSONL_CORRUPT' && error?.line === 2 && /data\/metrics\.jsonl/.test(error.message)
    );

    const tolerant = await readJsonl(METRICS_FILE);
    assert.equal(tolerant.length, 1, 'generic JSONL reader stays tolerant for maintenance/reporting paths that intentionally skip malformed rows');
  } finally {
    await restoreFile(METRICS_FILE, saved);
  }
});
