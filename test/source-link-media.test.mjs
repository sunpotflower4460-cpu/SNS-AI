import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePost, __test as openaiTest } from '../src/lib/openai.mjs';
import { xWeightedLength } from '../src/lib/safety.mjs';
import { decideUrlInvestment } from '../src/budget/url-intelligence.mjs';
import { applyLinkPolicy } from '../src/content/link-gate.mjs';
import { naturalizeDraft } from '../src/content/naturalize.mjs';
import { resolveMediaDetailed } from '../src/lib/media.mjs';

// --- Source URL attachment + product image (owner direction 2026-11-11) -----------------------
// Plugin Radar posts should carry the maker's real product image when the media hunter can obtain
// one, and the researched product page URL when it fits naturally. Text-only becomes the rare
// exception. These tests pin the pipeline mechanics behind that posture for opted-in accounts
// (linkPolicy.includeSourceUrl) and the unchanged behaviour for everyone else.

const PRODUCT_URL = 'https://vendor.example/products/wave-theory';

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function saveEnv(...names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function candidateFixture(text, sourceUrl) {
  return {
    text, mediaPrompt: '', rationale: 'source link coverage', spreadPotential: 55, noveltyPotential: 52,
    sourceUrl,
    features: { topic: 'Wave Theory', angle: 'angle', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed: false }
  };
}

function generationAccount(overrides = {}) {
  return {
    platform: 'x', enabled: true, mode: 'auto', credentialKey: 'source-link-x', displayName: 'Source Link X',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 3, candidateCount: 1, maxOutputTokens: 1000 },
    safety: { moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, maxLinks: 1, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false },
    research: { webSearch: false, trendIntelligence: false },
    resilience: { enabled: true, failureThreshold: 2, cooldownMinutes: 60 },
    budgets: { enabled: false },
    experiments: { enabled: false }, media: { strategy: 'none', type: 'image' },
    ...overrides
  };
}

const LINKED_ACCOUNT = { linkPolicy: { includeSourceUrl: true, purposes: ['product'], maxUrlPostsPerDay: null, maxUrlPostsPerWeek: null } };

async function withMockedGeneration(candidates, run) {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY');
  process.env.OPENAI_API_KEY = 'test-openai-key';
  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target !== 'https://api.openai.com/v1/responses') throw new Error(`Unexpected mocked URL: ${target}`);
      return jsonResponse({ output_text: JSON.stringify({ candidates }) });
    };
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
}

test('attachSourceUrl appends the source URL on its own line for opted-in accounts', () => {
  const account = generationAccount(LINKED_ACCOUNT);
  const { text, sourceUrl } = openaiTest.attachSourceUrl(account, { text: 'Wave Theoryは面白いMIDIプラグイン。', sourceUrl: PRODUCT_URL });
  assert.equal(sourceUrl, PRODUCT_URL);
  assert.equal(text, `Wave Theoryは面白いMIDIプラグイン。\n${PRODUCT_URL}`);
  assert.ok(xWeightedLength(text) <= 280, 'the appended text still validates against the weighted limit (URL counts 23)');
});

test('attachSourceUrl never duplicates a URL the text already carries, and rejects unusable source URLs', () => {
  const account = generationAccount(LINKED_ACCOUNT);
  const already = openaiTest.attachSourceUrl(account, { text: `詳細はこちら ${PRODUCT_URL}`, sourceUrl: PRODUCT_URL });
  assert.equal(already.sourceUrl, PRODUCT_URL);
  assert.equal(already.text.match(/https:\/\//g).length, 1, 'exactly one URL in the final text');

  for (const bad of [null, undefined, '', 'not a url', 'http://vendor.example/insecure', 'https://vendor.example/has space']) {
    const result = openaiTest.attachSourceUrl(account, { text: '本文です。', sourceUrl: bad });
    assert.equal(result.sourceUrl, null, `unusable sourceUrl ${JSON.stringify(bad)} attaches nothing`);
    assert.equal(result.text, '本文です。');
  }
});

test('attachSourceUrl keeps the natural text when the URL would break the length limit', () => {
  const account = generationAccount(LINKED_ACCOUNT);
  const body = 'あ'.repeat(135); // weighted length 270; + line break (1) + URL (23) = 294 > 280
  const { text, sourceUrl } = openaiTest.attachSourceUrl(account, { text: body, sourceUrl: PRODUCT_URL });
  assert.equal(sourceUrl, null, 'no URL is attached when it cannot fit');
  assert.equal(text, body, 'the original text is preserved verbatim instead of being force-shortened');
});

test('attachSourceUrl is a no-op for accounts that did not opt in', () => {
  const account = generationAccount();
  const { text, sourceUrl } = openaiTest.attachSourceUrl(account, { text: '本文です。', sourceUrl: PRODUCT_URL });
  assert.equal(sourceUrl, null);
  assert.equal(text, '本文です。');
});

test('generatePost attaches the product URL, stamps link features and exposes the canonical URL', async () => {
  const account = generationAccount(LINKED_ACCOUNT);
  const result = await withMockedGeneration(
    [candidateFixture('Wave TheoryはウェーブテーブルからMIDIメロディを作るプラグイン。', PRODUCT_URL)],
    () => generatePost('source-link-x', account, [], { dryRun: true })
  );
  assert.ok(result.text.endsWith(`\n${PRODUCT_URL}`), 'final draft text carries the product page URL');
  assert.ok(xWeightedLength(result.text) <= 280);
  assert.equal(result.features.linkRequired, true);
  assert.equal(result.features.linkPurpose, 'product');
  assert.equal(result.sourceUrl, PRODUCT_URL);
  assert.equal(result.canonicalUrl, PRODUCT_URL, 'the media hunter reads canonicalUrl to acquire the product image');
});

test('generatePost leaves drafts untouched for accounts without the source-URL opt-in', async () => {
  const account = generationAccount();
  const result = await withMockedGeneration(
    [candidateFixture('リンクなしで出す投稿です。', PRODUCT_URL)],
    () => generatePost('source-link-x', account, [], { dryRun: true })
  );
  assert.equal(result.text, 'リンクなしで出す投稿です。');
  assert.equal(result.features.linkRequired, undefined);
  assert.equal('canonicalUrl' in result, false);
  assert.equal('sourceUrl' in result, false);
});

test('generatePost does not append when the candidate reports no verified source URL', async () => {
  const account = generationAccount(LINKED_ACCOUNT);
  const result = await withMockedGeneration(
    [candidateFixture('製品ページを確認できなかった投稿です。', null)],
    () => generatePost('source-link-x', account, [], { dryRun: true })
  );
  assert.equal(result.text, '製品ページを確認できなかった投稿です。');
  assert.equal(result.features.linkRequired, undefined);
  assert.equal('canonicalUrl' in result, false);
});

test('the appended URL survives naturalization as a protected token', async () => {
  const account = generationAccount({
    ...LINKED_ACCOUNT,
    generation: {
      model: 'gpt-5', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 3, candidateCount: 1, maxOutputTokens: 1000,
      naturalization: { enabled: true, deepReview: false }
    }
  });
  const draft = { text: `Wave Theoryは面白いプラグイン。\n${PRODUCT_URL}`, features: { linkRequired: true, linkPurpose: 'product' }, canonicalUrl: PRODUCT_URL };
  const result = await naturalizeDraft('source-link-x', account, draft, { history: [], dryRun: true });
  assert.ok(result.text.includes(PRODUCT_URL), 'naturalization preserves the URL verbatim');
  assert.equal(result.canonicalUrl, PRODUCT_URL, 'canonicalUrl survives the naturalization spread');
});

test('decideUrlInvestment keeps the source URL for opted-in accounts even below the value threshold', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  const draft = { text: `本文です ${PRODUCT_URL}`, features: { linkRequired: true, linkPurpose: 'product' } };

  const optedIn = decideUrlInvestment({
    accountId: 'music-tools-x', history: [], draft, predictedScore: 10, now,
    account: { schedule: { timezone: 'UTC' }, linkPolicy: { includeSourceUrl: true, purposes: ['product'], maxUrlPostsPerDay: null, maxUrlPostsPerWeek: null } }
  });
  assert.equal(optedIn.action, 'publish-url', 'a low predicted score no longer strips the source URL');

  const notOptedIn = decideUrlInvestment({
    accountId: 'music-tools-x', history: [], draft, predictedScore: 10, now,
    account: { schedule: { timezone: 'UTC' }, linkPolicy: { purposes: ['product'], maxUrlPostsPerDay: null, maxUrlPostsPerWeek: null } }
  });
  assert.equal(notOptedIn.action, 'convert-to-no-link', 'accounts without the opt-in keep the old value rationing');

  const gateDenied = decideUrlInvestment({
    accountId: 'music-tools-x', history: [], draft, predictedScore: 10, now,
    account: { schedule: { timezone: 'UTC' }, linkPolicy: { includeSourceUrl: true, purposes: ['other'], maxUrlPostsPerDay: null, maxUrlPostsPerWeek: null } }
  });
  assert.notEqual(gateDenied.action, 'publish-url', 'an explicit link-gate denial (purpose) still wins over the opt-in');
});

test('applyLinkPolicy keeps the source URL under the opted-in policy regardless of past URL volume', () => {
  const now = new Date('2026-08-28T12:00:00Z');
  const account = { schedule: { timezone: 'UTC' }, linkPolicy: { includeSourceUrl: true, purposes: ['product'], maxUrlPostsPerDay: null, maxUrlPostsPerWeek: null } };
  const history = Array.from({ length: 5 }, (_, i) => ({ account: 'music-tools-x', status: 'published', text: `past https://a.example/${i}`, at: '2026-08-28T01:00:00Z' }));
  const draft = { text: `本文です\n${PRODUCT_URL}`, features: { linkRequired: true, linkPurpose: 'product' } };
  const { draft: kept, decision } = applyLinkPolicy({ accountId: 'music-tools-x', account, draft, history, now });
  assert.equal(decision.allowed, true);
  assert.ok(kept.text.includes(PRODUCT_URL));
});

// --- Media hunter: product image from the canonical (product) page ----------------------------

const PRODUCT_PAGE = 'https://vendor.example/products/wave-theory';
const PRODUCT_IMAGE = 'https://vendor.example/images/wave-theory.png';

async function withMockedPages(pages, run) {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      const html = pages[target];
      if (html === 'THROW') throw new Error('network down');
      if (html == null) return { ok: false, status: 404, text: async () => '', headers: new Headers() };
      return { ok: true, status: 200, text: async () => html, headers: new Headers() };
    };
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function hunterAccount(overrides = {}) {
  return {
    platform: 'x',
    media: { strategy: 'hunter', type: 'image', acquireFromCanonical: true, internalImageGeneration: false },
    ...overrides
  };
}

const HUNTER_DRAFT = { text: 'Wave Theoryの投稿', features: { topic: 'Wave Theory' }, canonicalUrl: PRODUCT_PAGE };

test('media hunter attaches the verified product image extracted from the canonical page og:image', async () => {
  const html = `<html><head><meta property="og:image" content="${PRODUCT_IMAGE}"></head><body>Wave Theory</body></html>`;
  const resolved = await withMockedPages({ [PRODUCT_PAGE]: html }, () =>
    resolveMediaDetailed('music-tools-x', hunterAccount(), 'slot-1', HUNTER_DRAFT, { dryRun: true }));
  assert.equal(resolved.decision, 'verified-product-image');
  assert.equal(resolved.url, PRODUCT_IMAGE);
});

test('media hunter falls back to no media (not a failed post) when the page has no usable image', async () => {
  const resolved = await withMockedPages({ [PRODUCT_PAGE]: '<html><head><title>Wave Theory</title></head></html>' }, () =>
    resolveMediaDetailed('music-tools-x', hunterAccount(), 'slot-2', HUNTER_DRAFT, { dryRun: true }));
  assert.equal(resolved.decision, 'none');
  assert.equal(resolved.url, null);
});

test('media hunter falls back to no media when the canonical page cannot be fetched', async () => {
  const resolved = await withMockedPages({ [PRODUCT_PAGE]: 'THROW' }, () =>
    resolveMediaDetailed('music-tools-x', hunterAccount(), 'slot-3', HUNTER_DRAFT, { dryRun: true }));
  assert.equal(resolved.decision, 'none');
  assert.equal(resolved.url, null);
});

test('media hunter does not fetch the canonical page without acquireFromCanonical (existing behaviour preserved)', async () => {
  let fetched = false;
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { fetched = true; throw new Error('must not be called'); };
    const account = hunterAccount({ media: { strategy: 'hunter', type: 'image', internalImageGeneration: false } });
    const resolved = await resolveMediaDetailed('plugin-radar-instagram', account, 'slot-4', HUNTER_DRAFT, { dryRun: true });
    assert.equal(resolved.decision, 'none');
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
