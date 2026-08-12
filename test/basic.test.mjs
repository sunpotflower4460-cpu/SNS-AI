import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../src/providers/x.mjs';

test('OAuth percent encoding follows RFC 3986 for reserved punctuation', () => {
  assert.equal(__test.pct("Ladies + Gentlemen"), 'Ladies%20%2B%20Gentlemen');
  assert.equal(__test.pct("An encoded string!"), 'An%20encoded%20string%21');
});

test('X media metadata payload carries image alt text and enforces 1000-character cap', () => {
  const payload = __test.mediaMetadataPayload('12345', `  ${'a'.repeat(1100)}  `);
  assert.equal(payload.id, '12345');
  assert.equal(payload.metadata.alt_text.text.length, 1000);
  assert.equal(payload.metadata.alt_text.text, 'a'.repeat(1000));
});
