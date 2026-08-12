import { fileURLToPath } from 'node:url';
import { appendJsonl, readJsonl } from './json-store.mjs';

const FILE = fileURLToPath(new URL('../../data/audit.jsonl', import.meta.url));

export async function appendAudit(event) {
  const row = {
    at: new Date().toISOString(),
    schemaVersion: 1,
    ...event
  };
  await appendJsonl(FILE, row);
  return row;
}

export async function readAudit() {
  return readJsonl(FILE);
}

export function recentAudit(rows, accountId, limit = 50) {
  return (rows || []).filter((row) => !accountId || row.account === accountId).slice(-limit).reverse();
}
