import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDraftText, xWeightedLength } from '../src/lib/safety.mjs';

const JP = String.fromCodePoint(0x3042);
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';

test('X weighted length handles Latin and CJK text', () => {
  assert.equal(xWeightedLength('a'.repeat(280)), 280);
  assert.equal(xWeightedLength(JP.repeat(140)), 280);
  assert.equal(xWeightedLength(JP.repeat(141)), 282);
});

test('X weighted length treats emoji grapheme clusters as weight two', () => {
  assert.equal(xWeightedLength(FAMILY), 2);
  assert.equal(xWeightedLength(FAMILY.repeat(140)), 280);
});

test('X weighted length normalizes text to NFC', () => {
  assert.equal(xWeightedLength('e\u0301'), 1);
});

test('X draft validation rejects text over the weighted limit', () => {
  const account = { platform: 'x', generation: {}, safety: {} };
  assert.equal(validateDraftText(account, JP.repeat(140)), JP.repeat(140));
  assert.throws(() => validateDraftText(account, JP.repeat(141)), /282 weighted characters/);
});
