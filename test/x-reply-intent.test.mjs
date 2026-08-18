import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAndDraftEngagement, xPublicReplyIntentLikely } from '../src/engagement/ai.mjs';

const account = {
  id: 'music-tools-x',
  platform: 'x',
  generation: { maxChars: 280 },
  safety: { maxLinks: 1, maxHashtags: 2, bannedPhrases: [], moderation: false },
  research: { webSearch: false }
};

test('X public reply intent gate accepts clear questions/requests and ignores bare mentions', () => {
  assert.equal(xPublicReplyIntentLikely({ platform: 'x', kind: 'reply', public: true, text: 'このプラグインどう思いますか？' }), true);
  assert.equal(xPublicReplyIntentLikely({ platform: 'x', kind: 'reply', public: true, text: 'おすすめを教えて' }), true);
  assert.equal(xPublicReplyIntentLikely({ platform: 'x', kind: 'reply', public: true, text: 'Could you explain this plugin' }), true);
  assert.equal(xPublicReplyIntentLikely({ platform: 'x', kind: 'reply', public: true, text: '今日も制作中' }), false);
  assert.equal(xPublicReplyIntentLikely({ platform: 'instagram', kind: 'reply', public: true, text: '今日も制作中' }), true);
  assert.equal(xPublicReplyIntentLikely({ platform: 'x', kind: 'dm', public: false, text: '今日も制作中' }), true);
});

test('obvious non-request X mention is ignored before any OpenAI call', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('OpenAI must not be called'); };
  try {
    const result = await classifyAndDraftEngagement({
      accountId: 'music-tools-x',
      account,
      event: { platform: 'x', kind: 'reply', public: true, text: '今日も制作中', createdAt: new Date().toISOString() },
      policy: { humanRequiredCategories: [] },
      dryRun: true
    });
    assert.equal(result.action, 'ignore');
    assert.equal(result.category, 'no_clear_reply_intent');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('high-risk X mention still escalates even when it is not phrased as a question', async () => {
  const result = await classifyAndDraftEngagement({
    accountId: 'music-tools-x',
    account,
    event: { platform: 'x', kind: 'reply', public: true, text: '返金トラブルについて正式に対応してください' },
    policy: { humanRequiredCategories: [] },
    dryRun: true
  });
  assert.equal(result.action, 'human');
  assert.equal(result.category, 'refund_or_payment_dispute');
});
