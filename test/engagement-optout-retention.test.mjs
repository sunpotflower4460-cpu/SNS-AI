import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as storeTest } from '../src/engagement/store.mjs';

test('persistent opt-outs are never evicted when routine actor cooldown cache exceeds its cap', () => {
  const actors = {
    oldOptOut: { optedOut: true, updatedAt: '2020-01-01T00:00:00.000Z' }
  };
  for (let i = 0; i < storeTest.MAX_ACTIVE_ACTORS_PER_ACCOUNT + 25; i += 1) {
    actors[`active-${i}`] = {
      optedOut: false,
      updatedAt: new Date(Date.parse('2026-08-18T00:00:00.000Z') + i * 1000).toISOString()
    };
  }

  const compacted = storeTest.compactActors(actors);
  assert.equal(compacted.oldOptOut?.optedOut, true);
  assert.equal(
    Object.values(compacted).filter((row) => row?.optedOut !== true).length,
    storeTest.MAX_ACTIVE_ACTORS_PER_ACCOUNT
  );
});

test('terminal engagement event guards survive active-event compaction', () => {
  const now = Date.parse('2026-08-20T00:00:00Z');
  const events = {
    humanOld: { status: 'human', updatedAt: '2026-07-20T00:00:00Z' },
    ignoredRecent: { status: 'ignored', updatedAt: '2026-08-19T00:00:00Z' },
    sentRecent: { status: 'sent', updatedAt: '2026-08-18T00:00:00Z' },
    expiredTerminal: { status: 'human', updatedAt: '2026-06-01T00:00:00Z' }
  };
  for (let i = 0; i < storeTest.MAX_EVENTS_PER_ACCOUNT + 40; i += 1) {
    events[`pending-${i}`] = {
      status: 'pending',
      updatedAt: new Date(now - i * 1000).toISOString()
    };
  }
  const compacted = storeTest.compactEvents(events, now);
  assert.equal(compacted.humanOld?.status, 'human');
  assert.equal(compacted.ignoredRecent?.status, 'ignored');
  assert.equal(compacted.sentRecent?.status, 'sent');
  assert.equal(compacted.expiredTerminal, undefined);
  assert.equal(
    Object.values(compacted).filter((row) => row?.status === 'pending').length,
    storeTest.MAX_EVENTS_PER_ACCOUNT
  );
});
