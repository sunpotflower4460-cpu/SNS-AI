import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDueSlots } from '../src/lib/schedule.mjs';
import { readJson, writeJsonAtomic } from '../src/lib/json-store.mjs';

test('schedule window crossing midnight is attributed to the previous local day', () => {
  const account = {
    schedule: {
      timezone: 'Asia/Tokyo',
      days: ['wed'],
      times: ['23:50'],
      windowMinutes: 30
    },
    learning: { adaptiveSchedule: false }
  };
  const slots = findDueSlots('late-account', account, new Date('2026-08-12T15:05:00Z'));
  assert.equal(slots.length, 1);
  assert.equal(slots[0].localDate, '2026-08-12');
  assert.equal(slots[0].slotId, 'late-account:2026-08-12:23:50');
});

test('DST fall-back repeated local time maps to the same slot id', () => {
  const account = {
    schedule: {
      timezone: 'America/New_York',
      days: ['sun'],
      times: ['01:30'],
      windowMinutes: 30
    },
    learning: { adaptiveSchedule: false }
  };
  const first = findDueSlots('dst-account', account, new Date('2026-11-01T05:30:00Z'));
  const second = findDueSlots('dst-account', account, new Date('2026-11-01T06:30:00Z'));
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].slotId, second[0].slotId);
});

test('duplicate configured schedule times cannot produce duplicate slots', () => {
  const account = {
    schedule: {
      timezone: 'Asia/Tokyo',
      days: ['thu'],
      times: ['09:00', '09:00', '09:00'],
      windowMinutes: 30
    },
    learning: { adaptiveSchedule: false }
  };
  const slots = findDueSlots('dedupe-account', account, new Date('2026-08-13T00:05:00Z'));
  assert.equal(slots.length, 1);
});

test('concurrent atomic JSON writes do not collide or leave temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sns-ai-atomic-'));
  const path = join(dir, 'state.json');
  try {
    await Promise.all(Array.from({ length: 24 }, (_, id) => writeJsonAtomic(path, { id, payload: 'x'.repeat(128) })));
    const result = await readJson(path);
    assert.equal(Number.isInteger(result.id), true);
    assert.equal(result.payload.length, 128);
    const files = await readdir(dir);
    assert.deepEqual(files, ['state.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
