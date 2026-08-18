import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compactAuditRows,
  compactEngagementAudit,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_ROWS
} from '../src/engagement/compact-audit.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function row(at, id) {
  return JSON.stringify({ at, schemaVersion: 1, account: 'a', eventKey: id, status: 'sent' });
}

test('engagement audit defaults are bounded but generous for diagnostics', () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 90);
  assert.equal(DEFAULT_MAX_ROWS, 50_000);
});

test('audit compaction drops expired and malformed rows while preserving recent chronological rows', () => {
  const now = Date.parse('2026-08-18T00:00:00Z');
  const result = compactAuditRows([
    row('2026-04-01T00:00:00Z', 'expired'),
    '{bad json',
    row('2026-08-17T00:00:00Z', 'newer'),
    row('2026-07-01T00:00:00Z', 'older')
  ], { now, retentionDays: 90, maxRows: 10 });

  assert.equal(result.before, 4);
  assert.equal(result.after, 2);
  assert.equal(result.expired, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.overflow, 0);
  assert.deepEqual(result.rows.map((value) => value.eventKey), ['older', 'newer']);
});

test('audit row cap keeps the newest valid rows only', () => {
  const now = Date.parse('2026-08-18T00:00:00Z');
  const result = compactAuditRows([
    row('2026-08-10T00:00:00Z', '1'),
    row('2026-08-11T00:00:00Z', '2'),
    row('2026-08-12T00:00:00Z', '3'),
    row('2026-08-13T00:00:00Z', '4')
  ], { now, retentionDays: 90, maxRows: 2 });

  assert.equal(result.overflow, 2);
  assert.deepEqual(result.rows.map((value) => value.eventKey), ['3', '4']);
});

test('audit compaction validates retention controls rather than disabling them on malformed values', () => {
  const now = Date.now();
  assert.throws(() => compactAuditRows([], { now, retentionDays: 0, maxRows: 10 }), /retentionDays/);
  assert.throws(() => compactAuditRows([], { now, retentionDays: 90, maxRows: 0 }), /maxRows/);
  assert.throws(() => compactAuditRows([], { now, retentionDays: 90, maxRows: 1.5 }), /maxRows/);
});

test('file compaction rewrites only the supplied audit file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sns-audit-retention-'));
  const audit = join(dir, 'engagement-audit.jsonl');
  const sentinel = join(dir, 'engagement-state.json');
  try {
    await writeFile(audit, `${row('2026-01-01T00:00:00Z', 'old')}\n${row('2026-08-17T00:00:00Z', 'new')}\n`, 'utf8');
    await writeFile(sentinel, '{"mustRemain":true}\n', 'utf8');
    const result = await compactEngagementAudit({
      path: audit,
      now: Date.parse('2026-08-18T00:00:00Z'),
      retentionDays: 90,
      maxRows: 10
    });
    assert.equal(result.after, 1);
    assert.match(await readFile(audit, 'utf8'), /"eventKey":"new"/);
    assert.equal((await readFile(audit, 'utf8')).includes('"eventKey":"old"'), false);
    assert.equal(await readFile(sentinel, 'utf8'), '{"mustRemain":true}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('durable-state persist compacts audit before copying state branch files', async () => {
  const script = await readFile(`${ROOT}scripts/engagement-durable-state.sh`, 'utf8');
  const compactIndex = script.indexOf('node src/engagement/compact-audit.mjs');
  const worktreeIndex = script.indexOf('git worktree add');
  assert.ok(compactIndex >= 0);
  assert.ok(worktreeIndex > compactIndex);
  assert.match(script, /data\/engagement-state\.json/);
  assert.match(script, /data\/engagement-delivery-ledger\.json/);
  assert.match(script, /data\/x-oauth2-state\.json/);
});
