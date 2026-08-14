import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDraftText } from '../src/lib/safety.mjs';

test('runtime count limits reject malformed values', () => {
  assert.throws(
    () => validateDraftText({ platform: 'x', generation: { maxChars: '280' }, safety: {} }, 'hello'),
    /generation\.maxChars must be a positive number/
  );
  assert.throws(
    () => validateDraftText({ platform: 'x', generation: {}, safety: { maxLinks: '1' } }, 'hello'),
    /safety\.maxLinks must be a non-negative integer/
  );
  assert.throws(
    () => validateDraftText({ platform: 'x', generation: {}, safety: { maxHashtags: '2' } }, '#one'),
    /safety\.maxHashtags must be a non-negative integer/
  );
});
