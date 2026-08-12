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

test('X v2 image upload payload uses base64 media and tweet_image category', () => {
  const payload = __test.imageUploadPayload(Buffer.from('abc'), 'image/png');
  assert.deepEqual(payload, {
    media: Buffer.from('abc').toString('base64'), media_category: 'tweet_image', media_type: 'image/png', shared: false
  });
});

test('X video initialize payload normalizes release octet-stream to MP4', () => {
  const bytes = Buffer.alloc(1234);
  assert.deepEqual(__test.videoInitializePayload(bytes, 'application/octet-stream'), {
    media_category: 'tweet_video', media_type: 'video/mp4', shared: false, total_bytes: 1234
  });
});
