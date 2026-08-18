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
