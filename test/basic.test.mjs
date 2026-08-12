import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/providers/x.mjs';

test('OAuth percent encoding follows RFC 3986 for reserved punctuation', () => {
  assert.equal(__test.pct("Ladies + Gentlemen"), 'Ladies%20%2B%20Gentlemen');
  assert.equal(__test.pct("An encoded string!"), 'An%20encoded%20string%21');
});
