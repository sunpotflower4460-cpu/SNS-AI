import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative as relativePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts, loadConfig } from '../lib/config.mjs';
import { readJson, writeJsonAtomic } from '../lib/json-store.mjs';
import { cleanupGeneratedMedia } from '../media/openai-image.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARCHIVE = fileURLToPath(new URL('../../data/archive/monthly-summary.json', import.meta.url));
const QUARANTINE = fileURLToPath(new URL('../../data/quarantine/invalid-jsonl.jsonl', import.meta.url));

const SPECS = [
  ['data/history.jsonl', 'historyRetentionDays', 'at', 'history'],
  ['data/metrics.jsonl', 'metricsRetentionDays', 'collectedAt', 'metrics'],
  ['data/usage.jsonl', 'usageRetentionDays', 'at', 'usage'],
  ['data/audit.jsonl', 'auditRetentionDays', 'at', 'audit']
];

// Dry-run preview usage rows are recorded under a synthetic "<accountId>::dry-run-preview" account key
// (see src/lib/openai.mjs) so preview cost never shares a budget bucket with the real account. That
// key is not a real entry in config/accounts.json, though - without stripping the suffix here, every
// preview row would silently fall back to the global default retention regardless of what the real
// account's own maintenance.usageRetentionDays says, which could retain preview cost-tracking data far
// longer than an operator who intentionally shortened retention (e.g. for a data-sensitivity reason)
// would expect.
function baseAccountId(accountId) { return String(accountId || '').replace(/::dry-run-preview$/, ''); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function monthOf(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 7); }
function keyFor(row, type) { return `${monthOf(row.at || row.collectedAt)}|${type}|${row.account || '_global'}|${row.status || row.kind || row.stage || '_'}`; }
async function rawLines(path) { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }

async function compactFile(path, retentionForRow, dateKey, type, archive) {
  const lines = await rawLines(path);
  if (!lines.length) return { type, before: 0, after: 0, removed: 0, invalid: 0, duplicates: 0, quarantine: [] };
  const seen = new Set(); const keep = []; const quarantine = []; let duplicates = 0; let removed = 0;
  for (const raw of lines) {
    let row;
    try { row = JSON.parse(raw); }
    catch { quarantine.push({ quarantinedAt: new Date().toISOString(), file: relativePath(ROOT, path), raw: raw.slice(0, 4000) }); continue; }
    const fingerprint = hash(JSON.stringify(row));
    if (seen.has(fingerprint)) { duplicates += 1; continue; }
    seen.add(fingerprint);
    const timestamp = Date.parse(row?.[dateKey] || '');
    const rawRetention = Number(retentionForRow(row));
    const retentionDays = Math.max(1, Number.isFinite(rawRetention) ? rawRetention : 180);
    const cutoff = Date.now() - retentionDays * 86_400_000;
    if (Number.isFinite(timestamp) && timestamp < cutoff) {
      removed += 1;
      const summaryKey = keyFor(row, type);
      archive[summaryKey] ||= { month: monthOf(row[dateKey]), type, account: row.account || null, category: row.status || row.kind || row.stage || null, count: 0 };
      archive[summaryKey].count += 1;
      continue;
    }
    keep.push(row);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, keep.length ? `${keep.map((row) => JSON.stringify(row)).join('\n')}\n` : '', 'utf8');
  return { type, before: lines.length, after: keep.length, removed, invalid: quarantine.length, duplicates, quarantine };
}

export async function runMaintenance() {
  const config = await loadConfig(); const accounts = await loadAccounts(); const defaults = config.defaults?.maintenance || {};
  const archiveFile = await readJson(ARCHIVE, { schemaVersion: 1, buckets: {} }) || { schemaVersion: 1, buckets: {} }; const archive = archiveFile.buckets || {};
  const results = []; const quarantined = [];
  for (const [relative, retentionKey, dateKey, type] of SPECS) {
    const path = join(ROOT, relative);
    const retentionForRow = (row) => {
      const account = row?.account && accounts[baseAccountId(row.account)];
      return account?.maintenance?.[retentionKey] != null ? account.maintenance[retentionKey] : (defaults[retentionKey] ?? 180);
    };
    const result = await compactFile(path, retentionForRow, dateKey, type, archive);
    results.push({ ...result, quarantine: undefined }); quarantined.push(...result.quarantine);
  }
  await writeJsonAtomic(ARCHIVE, { schemaVersion: 1, updatedAt: new Date().toISOString(), buckets: archive });
  await mkdir(dirname(QUARANTINE), { recursive: true });
  const existing = await rawLines(QUARANTINE); const cutoff = Date.now() - Number(defaults.quarantineRetentionDays ?? 30) * 86_400_000;
  const validExisting = existing.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((row) => row && Date.parse(row.quarantinedAt || '') >= cutoff);
  const rows = [...validExisting, ...quarantined];
  await writeFile(QUARANTINE, rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '', 'utf8');
  const media = await cleanupGeneratedMedia({ retentionDays: Number(defaults.generatedMediaRetentionDays ?? 90) });
  return { at: new Date().toISOString(), results, quarantined: quarantined.length, generatedMedia: media };
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await runMaintenance(), null, 2));
