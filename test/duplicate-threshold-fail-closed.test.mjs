import test from 'node:test';
import assert from 'node:assert/strict';
import { findNearDuplicate, safeDuplicateThreshold } from '../src/lib/duplicate.mjs';

// A malformed generation.duplicateThreshold (wrong type, NaN, or out of the valid 0..1 range) used to
// flow straight into `Number(...)`, producing NaN. Every duplicate comparison is `score >= threshold`,
// and `anything >= NaN` is always false in JS, so a single bad config value silently disabled
// duplicate detection entirely - the account could repost byte-identical text on every slot forever.
// safeDuplicateThreshold must fail closed to the strictest value (0, which flags virtually everything
// as a duplicate and blocks generation until the config is fixed) instead of failing open.

test('safeDuplicateThreshold uses the configured value when it is a valid 0..1 number', () => {
  assert.equal(safeDuplicateThreshold(0.72, 0.5), 0.72);
  assert.equal(safeDuplicateThreshold(0, 0.5), 0);
  assert.equal(safeDuplicateThreshold(1, 0.5), 1);
});

test('safeDuplicateThreshold falls back to the default only when the value is absent', () => {
  assert.equal(safeDuplicateThreshold(null, 0.72), 0.72);
  assert.equal(safeDuplicateThreshold(undefined, 0.72), 0.72);
});

test('safeDuplicateThreshold fails closed to 0 (strictest) for any malformed present value, never to "disabled"', () => {
  assert.equal(safeDuplicateThreshold('high', 0.72), 0);
  assert.equal(safeDuplicateThreshold(NaN, 0.72), 0);
  assert.equal(safeDuplicateThreshold(-1, 0.72), 0);
  assert.equal(safeDuplicateThreshold(1.5, 0.72), 0);
  assert.equal(safeDuplicateThreshold(Infinity, 0.72), 0);
  assert.equal(safeDuplicateThreshold({}, 0.72), 0);
});

test('a malformed threshold must still flag an exact repost as a duplicate, not silently allow it', () => {
  const history = [{ text: 'Check out this new plugin, it is amazing for mixing vocals.' }];
  const repost = 'Check out this new plugin, it is amazing for mixing vocals.';

  // The pre-fix code path: Number('not-a-number') -> NaN -> `score >= NaN` is always false.
  const brokenThreshold = Number('not-a-number');
  assert.equal(findNearDuplicate(repost, history, brokenThreshold), null, 'sanity: this demonstrates the bug the fix must route around');

  // The fixed path: safeDuplicateThreshold coerces the same malformed input to 0, so the exact repost
  // is still caught.
  const fixedThreshold = safeDuplicateThreshold('not-a-number', 0.72);
  assert.ok(findNearDuplicate(repost, history, fixedThreshold), 'a malformed threshold must not let an exact repost through undetected');
});
