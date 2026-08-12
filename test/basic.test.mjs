import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as xTest } from '../src/providers/x.mjs';
import { __test as instagramTest } from '../src/providers/instagram.mjs';
import { __test as videoTest } from '../src/media/openai-video.mjs';

test('OAuth percent encoding follows RFC 3986 for reserved punctuation', () => {
  assert.equal(xTest.pct("Ladies + Gentlemen"), 'Ladies%20%2B%20Gentlemen');
  assert.equal(xTest.pct("An encoded string!"), 'An%20encoded%20string%21');
});

test('X media metadata payload carries image alt text and enforces 1000-character cap', () => {
  const payload = xTest.mediaMetadataPayload('12345', `  ${'a'.repeat(1100)}  `);
  assert.equal(payload.id, '12345');
  assert.equal(payload.metadata.alt_text.text.length, 1000);
  assert.equal(payload.metadata.alt_text.text, 'a'.repeat(1000));
});

test('X v2 image upload payload uses base64 media and tweet_image category', () => {
  const payload = xTest.imageUploadPayload(Buffer.from('abc'), 'image/png');
  assert.deepEqual(payload, {
    media: Buffer.from('abc').toString('base64'), media_category: 'tweet_image', media_type: 'image/png', shared: false
  });
});

test('X video initialize payload normalizes release octet-stream to MP4', () => {
  const bytes = Buffer.alloc(1234);
  assert.deepEqual(xTest.videoInitializePayload(bytes, 'application/octet-stream'), {
    media_category: 'tweet_video', media_type: 'video/mp4', shared: false, total_bytes: 1234
  });
});

test('OpenAI Video create uses multipart fields expected by Sora API', () => {
  const form = videoTest.createVideoForm({ model: 'sora-2', prompt: 'a calm ocean', size: '720x1280', seconds: 8 });
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model'), 'sora-2');
  assert.equal(form.get('prompt'), 'a calm ocean');
  assert.equal(form.get('size'), '720x1280');
  assert.equal(form.get('seconds'), '8');
});

test('Instagram image and Reel containers use multipart form fields', () => {
  const image = instagramTest.mediaContainerForm({ text: 'caption', mediaUrl: 'https://example.com/a.png', mediaType: 'image' });
  assert.ok(image instanceof FormData);
  assert.equal(image.get('caption'), 'caption');
  assert.equal(image.get('image_url'), 'https://example.com/a.png');
  assert.equal(image.get('video_url'), null);

  const reel = instagramTest.mediaContainerForm({ text: 'caption', mediaUrl: 'https://example.com/a.mp4', mediaType: 'reel' });
  assert.equal(reel.get('media_type'), 'REELS');
  assert.equal(reel.get('video_url'), 'https://example.com/a.mp4');
  assert.equal(reel.get('image_url'), null);

  const publish = instagramTest.publishContainerForm('container-1');
  assert.ok(publish instanceof FormData);
  assert.equal(publish.get('creation_id'), 'container-1');
});
