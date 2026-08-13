import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewVisualUrl } from '../src/media/qa.mjs';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('image moderation fails closed when the provider returns no usable result', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'unit-test-key';
  try {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://api.openai.com/v1/moderations');
      return jsonResponse({ results: [] });
    };
    await assert.rejects(
      reviewVisualUrl('image-moderation-empty', {
        media: { qa: { enabled: true } },
        safety: {},
        budgets: { enabled: false }
      }, 'https://example.com/image.png'),
      /Image moderation returned no result/
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
