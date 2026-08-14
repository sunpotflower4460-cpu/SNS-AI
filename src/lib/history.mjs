import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDateKey } from './schedule.mjs';

const HISTORY_FILE = fileURLToPath(new URL('../../data/history.jsonl', import.meta.url));

export async function readHistory() {
  try {
    const raw = await readFile(HISTORY_FILE, 'utf8');
    const rows = [];
    for (const [index, line] of raw.split('\n').entries()) {
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        const error = new Error(`data/history.jsonl is malformed at line ${index + 1}; refusing to continue with incomplete posting history.`);
        error.code = 'HISTORY_CORRUPT';
        throw error;
      }
    }
    return rows;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function recentHistory(accountId, limit = 30) {
  const all = await readHistory();
  return all.filter((entry) => entry.account === accountId).slice(-limit).reverse();
}

export function textHash(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 20);
}

export async function appendHistory(entry) {
  await mkdir(dirname(HISTORY_FILE), { recursive: true });
  const row = {
    at: new Date().toISOString(),
    ...entry,
    textHash: entry.textHash || textHash(entry.text)
  };
  await appendFile(HISTORY_FILE, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

export function postsToday(entries, accountId, timeZone, now = new Date()) {
  const today = localDateKey(now, timeZone);
  return (entries || []).filter((entry) => {
    if (entry.account !== accountId || entry.status !== 'published' || !entry.at) return false;
    const at = new Date(entry.at);
    if (Number.isNaN(at.getTime())) return false;
    return localDateKey(at, timeZone) === today;
  });
}
