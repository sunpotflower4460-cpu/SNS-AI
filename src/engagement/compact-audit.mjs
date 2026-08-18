import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const AUDIT_FILE = fileURLToPath(new URL('../../data/engagement-audit.jsonl', import.meta.url));
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_MAX_ROWS = 50_000;

async function readLines(path = AUDIT_FILE) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function compactAuditRows(lines, {
  now = Date.now(),
  retentionDays = DEFAULT_RETENTION_DAYS,
  maxRows = DEFAULT_MAX_ROWS
} = {}) {
  const days = Number(retentionDays);
  const rowLimit = Number(maxRows);
  if (!Number.isFinite(days) || days < 1) throw new Error('Engagement audit retentionDays must be at least 1.');
  if (!Number.isInteger(rowLimit) || rowLimit < 1) throw new Error('Engagement audit maxRows must be a positive integer.');

  const cutoff = now - days * 86_400_000;
  const valid = [];
  let invalid = 0;
  let expired = 0;

  for (const raw of lines || []) {
    let row;
    try { row = JSON.parse(raw); }
    catch { invalid += 1; continue; }
    const at = Date.parse(row?.at || '');
    if (!Number.isFinite(at)) { invalid += 1; continue; }
    if (at < cutoff) { expired += 1; continue; }
    valid.push({ row, at });
  }

  valid.sort((a, b) => a.at - b.at);
  const overflow = Math.max(0, valid.length - rowLimit);
  const kept = overflow ? valid.slice(overflow) : valid;

  return {
    rows: kept.map(({ row }) => row),
    before: (lines || []).length,
    after: kept.length,
    removed: expired + overflow + invalid,
    expired,
    overflow,
    invalid
  };
}

export async function compactEngagementAudit({
  path = AUDIT_FILE,
  now = Date.now(),
  retentionDays = Number(process.env.SNS_ENGAGEMENT_AUDIT_RETENTION_DAYS || DEFAULT_RETENTION_DAYS),
  maxRows = Number(process.env.SNS_ENGAGEMENT_AUDIT_MAX_ROWS || DEFAULT_MAX_ROWS)
} = {}) {
  const lines = await readLines(path);
  if (!lines.length) return { before: 0, after: 0, removed: 0, expired: 0, overflow: 0, invalid: 0 };
  const result = compactAuditRows(lines, { now, retentionDays, maxRows });
  await writeFile(path, result.rows.length ? `${result.rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '', 'utf8');
  const { rows: _rows, ...summary } = result;
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await compactEngagementAudit();
  console.log(JSON.stringify(result));
}
