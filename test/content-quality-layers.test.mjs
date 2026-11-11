import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { naturalizationSettings, naturalizeDraft, __test as naturalizeTest } from '../src/content/naturalize.mjs';
import { __test as httpTest } from '../src/lib/http.mjs';
import { __test as qaTest } from '../src/media/qa.mjs';

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));

test('naturalization preserves URLs and hashtags as protected authored tokens', () => {
  const original = '詳しくは https://example.com/a へ。#AI初心者 #今日の学び';
  assert.equal(naturalizeTest.preservesProtectedTokens(original, '詳しくは https://example.com/a へ。#AI初心者 #今日の学び でした。'), true);
  assert.equal(naturalizeTest.preservesProtectedTokens(original, '詳しくは別ページへ。#AI初心者'), false);
});

test('naturalization settings fail safe to bounded defaults instead of producing NaN gates', () => {
  const settings = naturalizationSettings({ generation: { naturalization: {
    minNaturalness: 'not-a-number', maxAiPatternRisk: 999, minVoiceFit: -1, maxIssues: 'bad'
  } } });
  assert.equal(settings.minNaturalness, 72);
  assert.equal(settings.maxAiPatternRisk, 45);
  assert.equal(settings.minVoiceFit, 68);
  assert.equal(settings.maxIssues, 6);
  assert.equal(settings.deepReview, false);
});

test('AI-like local text is flagged for ChatGPT review without making a second API call by default', async () => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('unexpected network call'); };
  try {
    const result = await naturalizeDraft('example-x', {
      platform: 'x',
      generation: { maxChars: 280, duplicateThreshold: 0.72, naturalization: { enabled: true, deepReview: false, maxAiPatternRisk: 10 } },
      safety: { maxLinks: 4, maxHashtags: 4 }
    }, {
      text: '結論から言うと、重要なのはAIを活用することです。ぜひ試してみてください。',
      features: {}
    }, { history: [] });
    assert.equal(fetchCalls, 0);
    assert.equal(result.text.includes('結論から言うと'), true);
    assert.equal(result.naturalization.applied, false);
    assert.equal(result.naturalization.chatReviewRecommended, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('a malformed duplicateThreshold must not let a naturalization edit through an exact repost undetected', async () => {
  // Same fail-open shape as lib/openai.mjs's generatePost duplicate check: Number('not-a-number') is
  // NaN, and every duplicate comparison is `score >= threshold`, so `anything >= NaN` is always false.
  // naturalizeDraft's own near-duplicate rejection (distinct from generatePost's) has to route through
  // safeDuplicateThreshold too, or a malformed per-account config value would silently let the edited
  // text through even when it is a near-exact repost of recent history.
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const repost = 'Check out this new plugin, it is amazing for mixing vocals.';
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://api.openai.com/v1/responses') {
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          action: 'light_edit', naturalnessScore: 40, aiPatternRisk: 80, voiceFitScore: 40,
          issues: ['formulaic'], editedText: repost, reason: 'smoother phrasing'
        })
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const result = await naturalizeDraft('example-x', {
      platform: 'x',
      generation: {
        maxChars: 280, duplicateThreshold: 'not-a-number',
        naturalization: { enabled: true, deepReview: true, maxAiPatternRisk: 1 }
      },
      safety: { maxLinks: 4, maxHashtags: 4 },
      budgets: { openaiCallsPerDay: 100 }
    }, {
      text: '結論から言うと、重要なのはAIを活用することです。ぜひ試してみてください。',
      features: {}
    }, { history: [{ text: repost }] });
    assert.equal(result.naturalization.applied, false, 'the near-exact repost must be rejected, not silently applied');
    assert.match(result.naturalization.rejectedEditReason || '', /too similar to recent history/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('naturalization settings parse reviewAlways as an explicit opt-in', () => {
  assert.equal(naturalizationSettings({ generation: { naturalization: { reviewAlways: true } } }).reviewAlways, true);
  assert.equal(naturalizationSettings({ generation: { naturalization: {} } }).reviewAlways, false);
  assert.equal(naturalizationSettings({ generation: { naturalization: { reviewAlways: 'yes' } } }).reviewAlways, false);
});

test('reviewAlways runs the deep review on a locally-clean draft and applies a guarded light edit', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  let fetchCalls = 0;
  let reviewSystemPrompt = '';
  const editedText = '新しいサンプラー触った。録り逃しがない。作業の流れが止まらないのがいい。';
  globalThis.fetch = async (url, options) => {
    fetchCalls += 1;
    if (String(url) === 'https://api.openai.com/v1/responses') {
      reviewSystemPrompt = JSON.parse(options.body).input[0].content[0].text;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          action: 'light_edit', naturalnessScore: 60, aiPatternRisk: 55, voiceFitScore: 82,
          issues: ['文末のリズムが均一'], editedText, reason: 'AI markers found; light polish applied'
        })
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const result = await naturalizeDraft('example-x', {
      platform: 'x',
      generation: {
        maxChars: 280, duplicateThreshold: 0.72,
        naturalization: { enabled: true, deepReview: true, reviewAlways: true }
      },
      safety: { maxLinks: 4, maxHashtags: 4 },
      budgets: { openaiCallsPerDay: 100 }
    }, {
      text: '新しいサンプラー触った。録り逃しがなくて、作業の流れが止まらないのがいい。',
      features: {}
    }, { history: [], dryRun: true });
    assert.equal(fetchCalls, 1, 'the deep review must run even though the local audit was clean');
    assert.match(reviewSystemPrompt, /Actively hunt for generic-AI markers/);
    assert.match(reviewSystemPrompt, /まとめると/);
    assert.equal(result.text, editedText);
    assert.equal(result.naturalization.applied, true);
    assert.equal(result.naturalization.localOnly, false);
    assert.equal(result.naturalization.reviewAlways, true);
    assert.equal(result.naturalization.action, 'light_edit');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('without reviewAlways, a locally-clean draft still short-circuits without an API call', async () => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('unexpected network call'); };
  try {
    const result = await naturalizeDraft('example-x', {
      platform: 'x',
      generation: { maxChars: 280, duplicateThreshold: 0.72, naturalization: { enabled: true, deepReview: true } },
      safety: { maxLinks: 4, maxHashtags: 4 }
    }, {
      text: '新しいサンプラー触った。録り逃しがなくて、作業の流れが止まらないのがいい。',
      features: {}
    }, { history: [] });
    assert.equal(fetchCalls, 0);
    assert.equal(result.naturalization.applied, false);
    assert.equal(result.naturalization.localOnly, true);
    assert.equal(result.naturalization.chatReviewRecommended, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('reviewAlways still rejects an edit that drops a protected hashtag', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const original = 'このプラグイン、音作りの偶然をそのまま残せる。詳しくは https://example.com/x を見て。 #DTM';
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://api.openai.com/v1/responses') {
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          action: 'light_edit', naturalnessScore: 55, aiPatternRisk: 60, voiceFitScore: 80,
          issues: ['formulaic'], editedText: '音作りの偶然をそのまま残せるプラグイン。詳しくは https://example.com/x を見て。', reason: 'polish'
        })
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const result = await naturalizeDraft('example-x', {
      platform: 'x',
      generation: {
        maxChars: 280, duplicateThreshold: 0.72,
        naturalization: { enabled: true, deepReview: true, reviewAlways: true }
      },
      safety: { maxLinks: 4, maxHashtags: 4 },
      budgets: { openaiCallsPerDay: 100 }
    }, {
      text: original,
      features: {}
    }, { history: [], dryRun: true });
    assert.equal(result.text, original);
    assert.equal(result.naturalization.applied, false);
    assert.match(result.naturalization.rejectedEditReason || '', /protected URL\/hashtag/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('new Japanese AI-ism patterns raise the local audit risk', () => {
  const flagged = naturalizeTest.localNaturalnessAudit('この方法なら誰でも音作りを楽しむことができます。まとめると、とても便利と言えるでしょう。いかがでしょうか。してみてはいかが。');
  assert.ok(flagged.aiPatternRisk >= 48, `expected the new patterns to score, got ${flagged.aiPatternRisk}`);
  assert.ok(flagged.issues.length >= 4);
  const clean = naturalizeTest.localNaturalnessAudit('新しいサンプラー触った。録り逃しがなくて助かる。');
  assert.equal(clean.aiPatternRisk, 0);
});

test('visual QA score threshold is retained as a soft target with bounded config', () => {
  assert.equal(qaTest.qaSettings({ media: { qa: { minScore: 82 } } }).minScore, 82);
  assert.equal(qaTest.qaSettings({ media: { qa: { minScore: 200 } } }).minScore, 75);
  assert.equal(qaTest.qaSettings({ media: { qa: { maxInputBytes: 'bad' } } }).maxInputBytes, 15 * 1024 * 1024);
});

test('DNS target validation rejects a normal-looking hostname that resolves privately', async () => {
  await assert.rejects(
    httpTest.assertPublicHttpsTarget('https://media.example.com/a.png', 'mediaUrl', async () => [{ address: '127.0.0.1', family: 4 }]),
    (error) => error?.code === 'UNSAFE_NETWORK_TARGET' && /non-public address/.test(error.message)
  );
});

test('DNS target validation accepts a hostname only when every returned address is public', async () => {
  const parsed = await httpTest.assertPublicHttpsTarget(
    'https://media.example.com/a.png',
    'mediaUrl',
    async () => [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]
  );
  assert.equal(parsed.hostname, 'media.example.com');
});

test('repository defaults prefer ChatGPT review, keep images enabled, and pause video generation', async () => {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  assert.equal(config.defaults.media.internalImageGeneration, true);
  assert.equal(config.defaults.media.internalVideoGeneration, false);
  assert.equal(config.defaults.generation.naturalization.enabled, true);
  assert.equal(config.defaults.generation.naturalization.deepReview, false);
  assert.equal(config.defaults.media.qa.selectedSemanticReview, false);
});
