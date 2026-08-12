import { fileURLToPath } from 'node:url';
import { appendJsonl, readJsonl } from '../lib/json-store.mjs';

const FEEDBACK_FILE = fileURLToPath(new URL('../../data/human-feedback.jsonl', import.meta.url));
const ACTIONS = new Set(['prefer', 'avoid', 'correct', 'pin', 'note']);

export async function readHumanFeedback() {
  return readJsonl(FEEDBACK_FILE);
}

export async function recentHumanFeedback(accountId, limit = 40) {
  const rows = (await readHumanFeedback()).filter((row) => row.account === accountId && row.active !== false);
  const pinned = rows.filter((row) => row.action === 'pin');
  const rolling = rows.filter((row) => row.action !== 'pin').slice(-Math.max(1, Number(limit) || 40));
  const deduped = new Map();
  for (const row of [...pinned, ...rolling]) {
    const key = `${row.at || ''}|${row.action || ''}|${row.note || ''}|${row.dimension || ''}|${row.value || ''}`;
    deduped.set(key, row);
  }
  return [...deduped.values()].sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
}

export async function recordHumanFeedback(input = {}) {
  const account = String(input.account || '').trim();
  const note = String(input.note || '').trim();
  const action = String(input.action || 'note').trim().toLowerCase();
  if (!account) throw new Error('Human feedback requires account.');
  if (!note) throw new Error('Human feedback requires note.');
  if (!ACTIONS.has(action)) throw new Error(`Unsupported feedback action: ${action}`);

  const row = {
    at: new Date().toISOString(),
    account,
    action,
    note: note.slice(0, 4000),
    dimension: input.dimension ? String(input.dimension).slice(0, 80) : null,
    value: input.value == null ? null : String(input.value).slice(0, 300),
    source: String(input.source || 'human').slice(0, 80),
    active: input.active !== false
  };
  await appendJsonl(FEEDBACK_FILE, row);
  return row;
}
