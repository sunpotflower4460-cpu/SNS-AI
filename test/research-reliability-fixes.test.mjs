import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { hasFatalTrendStatus } from '../src/research/trends.mjs';
import { triageCandidates, estimateTriageMaxOutputTokens, validateTriageShape, __test as triageTest } from '../src/research/triage.mjs';
import { fetchWithSafeRedirects } from '../src/lib/http.mjs';
import { fetchRssSource } from '../src/research/sources/rss.mjs';

const { TRIAGE_MIN_OUTPUT_TOKENS, TRIAGE_MAX_OUTPUT_TOKENS } = triageTest;

const USAGE_STATE = fileURLToPath(new URL('../data/usage-state.json', import.meta.url));
const USAGE_FILE = fileURLToPath(new URL('../data/usage.jsonl', import.meta.url));
const CACHE_FILE = fileURLToPath(new URL('../data/research-cache/reliability-fixes-account.json', import.meta.url));

function saveEnv(...names) { return Object.fromEntries(names.map((n) => [n, process.env[n]])); }
function restoreEnv(saved) { for (const [n, v] of Object.entries(saved)) v === undefined ? delete process.env[n] : process.env[n] = v; }
async function snap(path) { try { return { exists: true, bytes: await readFile(path) }; } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; } }
async function restoreFile(path, saved) { if (!saved.exists) return rm(path, { force: true }); await writeFile(path, saved.bytes); }

// ---------------------------------------------------------------------------
// A-D: hasFatalTrendStatus must fail CI only on a real research failure, never
// on an intended control state.
// ---------------------------------------------------------------------------

test('A: a "failed" entry is treated as fatal (this is what makes the Trend Intelligence CLI exit non-zero)', () => {
  assert.equal(hasFatalTrendStatus([{ account: 'music-tools-x', status: 'failed', error: 'boom' }]), true);
  assert.equal(hasFatalTrendStatus([{ status: 'fresh' }, { status: 'updated' }, { status: 'failed' }]), true, 'one failed entry among healthy ones still trips it');
});

test('B: an "updated" entry alone is not fatal', () => {
  assert.equal(hasFatalTrendStatus([{ account: 'music-tools-x', status: 'updated', mode: 'direct-fetch' }]), false);
});

test('C: "fresh" and "shared" control states are not fatal', () => {
  assert.equal(hasFatalTrendStatus([{ status: 'fresh' }]), false);
  assert.equal(hasFatalTrendStatus([{ status: 'shared' }]), false);
  assert.equal(hasFatalTrendStatus([{ status: 'fresh' }, { status: 'shared' }]), false);
});

test('D: "budget-exhausted" and "circuit-open" are intended control states, not failures', () => {
  assert.equal(hasFatalTrendStatus([{ status: 'budget-exhausted' }]), false);
  assert.equal(hasFatalTrendStatus([{ status: 'circuit-open' }]), false);
});

test('hasFatalTrendStatus tolerates an empty/undefined report', () => {
  assert.equal(hasFatalTrendStatus([]), false);
  assert.equal(hasFatalTrendStatus(undefined), false);
});

// ---------------------------------------------------------------------------
// E: the triage output-token budget must actually scale enough to avoid the
// truncation that caused "Expected ',' or ']' ... position 2538" in production.
// ---------------------------------------------------------------------------

test('E1: estimateTriageMaxOutputTokens scales with candidate count within a bounded floor/ceiling', () => {
  assert.equal(estimateTriageMaxOutputTokens(0), TRIAGE_MIN_OUTPUT_TOKENS);
  assert.equal(estimateTriageMaxOutputTokens(1), TRIAGE_MIN_OUTPUT_TOKENS, 'a single candidate stays at the old cheap default');
  const twenty = estimateTriageMaxOutputTokens(20);
  assert.ok(twenty > 3000, `expected real headroom over the old fixed 1200-token default for 20 candidates, got ${twenty}`);
  assert.ok(twenty <= TRIAGE_MAX_OUTPUT_TOKENS, 'must stay bounded');
  assert.equal(estimateTriageMaxOutputTokens(1000), TRIAGE_MAX_OUTPUT_TOKENS, 'an absurd candidate count clips to the ceiling instead of growing unbounded');
});

function realisticTriageItem(index) {
  return {
    index,
    topic: `Vendor Plugin ${index} - AI-assisted saturation and EQ module release`,
    whyNow: 'Just released this week with an introductory launch discount that overseas producers are discussing',
    angle: 'Compare against mainstream saturation plugins and explain who should consider switching',
    relevance: 70 + (index % 20), novelty: 60 + (index % 15), usefulness: 55 + (index % 10),
    priceValue: 50 + (index % 25), newsworthiness: 45 + (index % 30), japanNovelty: 80 - (index % 10),
    audienceFit: 65 + (index % 12), confidence: 72, risk: 6 + (index % 5)
  };
}

test('E2: triageCandidates requests a scaled token budget from the provider and parses a full 20-candidate response without truncation', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GROQ_API_KEY');
  process.env.GROQ_API_KEY = 'test-groq-key';
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  await rm(CACHE_FILE, { force: true });
  try {
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      sourceId: `src-${i % 4}`, sourceType: 'rss', title: `Candidate ${i}`, vendor: 'Vendor', product: 'Product',
      summary: 'A short summary describing this candidate in enough detail to score it.', url: `https://vendor.example/${i}`,
      publishedAt: new Date().toISOString(), categories: ['plugin']
    }));
    let capturedMaxTokens = null;
    globalThis.fetch = async (url, options = {}) => {
      assert.equal(String(url), 'https://api.groq.com/openai/v1/chat/completions');
      const body = JSON.parse(String(options.body));
      capturedMaxTokens = body.max_tokens;
      const items = Array.from({ length: 20 }, (_, i) => realisticTriageItem(i));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), { status: 200 });
    };
    const account = { budgets: { enabled: true, groqCallsPerDay: 10 }, research: { maxTriageCandidates: 20 } };
    const result = await triageCandidates('reliability-fixes-account', account, candidates);
    assert.equal(capturedMaxTokens, estimateTriageMaxOutputTokens(20));
    assert.equal(result.items.length, 20);
    assert.equal(result.items[0].topic, realisticTriageItem(0).topic);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
    await rm(CACHE_FILE, { force: true });
  }
});

// ---------------------------------------------------------------------------
// F/G: a malformed, truncated, or schema-violating response must never be
// silently accepted - it must fall forward to OpenAI (existing provider
// fallback behavior), and only fail outright when no fallback is available.
// ---------------------------------------------------------------------------

const SIMPLE_CANDIDATES = [
  { sourceId: 's1', sourceType: 'rss', title: 'Candidate A', vendor: 'V', product: 'P', summary: 'summary a', url: 'https://vendor.example/a', publishedAt: null, categories: [] },
  { sourceId: 's1', sourceType: 'rss', title: 'Candidate B', vendor: 'V', product: 'P', summary: 'summary b', url: 'https://vendor.example/b', publishedAt: null, categories: [] }
];

test('validateTriageShape rejects missing fields, wrong types, and out-of-range scores', () => {
  assert.throws(() => validateTriageShape(null), /not a JSON object/);
  assert.throws(() => validateTriageShape({}), /missing an "items" array/);
  assert.throws(() => validateTriageShape({ items: [{ index: 0 }] }), /missing required field/);
  assert.throws(() => validateTriageShape({ items: [{ index: 0, topic: 't', whyNow: 'w', angle: 'a', relevance: 150, novelty: 1, usefulness: 1, priceValue: 1, newsworthiness: 1, japanNovelty: 1, audienceFit: 1, confidence: 1, risk: 1 }] }), /must be a number in 0..100/);
  const valid = { items: [{ index: 0, topic: 't', whyNow: 'w', angle: 'a', relevance: 1, novelty: 1, usefulness: 1, priceValue: 1, newsworthiness: 1, japanNovelty: 1, audienceFit: 1, confidence: 1, risk: 1 }] };
  assert.deepEqual(validateTriageShape(valid), valid);
});

test('F: a truncated (JSON.parse-invalid) Groq response falls forward to OpenAI instead of being treated as a successful triage', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GROQ_API_KEY', 'OPENAI_API_KEY');
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  await rm(CACHE_FILE, { force: true });
  try {
    let groqCalls = 0;
    let openaiCalls = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes('groq.com')) {
        groqCalls += 1;
        // A realistic truncated response: the JSON is cut off mid-object, exactly the shape that
        // produced the real "Expected ',' or ']' after array element" production error.
        const truncated = '{"items":[{"index":0,"topic":"Candidate A","whyNow":"now","angle":"a","relevance":80,"nov';
        return new Response(JSON.stringify({ choices: [{ message: { content: truncated } }] }), { status: 200 });
      }
      openaiCalls += 1;
      const items = [{ index: 0, topic: 'Candidate A', whyNow: 'now', angle: 'a', relevance: 80, novelty: 70, usefulness: 60, priceValue: 50, newsworthiness: 40, japanNovelty: 90, audienceFit: 75, confidence: 65, risk: 5 }];
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items }) }] }] }), { status: 200 });
    };
    const account = { budgets: { enabled: true, groqCallsPerDay: 10, openaiCallsPerDay: 10 } };
    const result = await triageCandidates('reliability-fixes-account', account, SIMPLE_CANDIDATES);
    assert.equal(groqCalls, 1, 'Groq must actually be tried first');
    assert.equal(openaiCalls, 1, 'a truncated Groq response must fall forward to OpenAI, not just fail');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].topic, 'Candidate A');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
    await rm(CACHE_FILE, { force: true });
  }
});

test('G: a Groq response that is valid JSON but violates the triage schema also falls forward to OpenAI', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GROQ_API_KEY', 'OPENAI_API_KEY');
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  await rm(CACHE_FILE, { force: true });
  try {
    let groqCalls = 0;
    let openaiCalls = 0;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes('groq.com')) {
        groqCalls += 1;
        // Syntactically valid JSON, but missing "risk" - exactly the kind of shape Groq's plain
        // json_object mode can produce without OpenAI's strict json_schema guarantee.
        const shapeInvalid = { items: [{ index: 0, topic: 'Candidate A', whyNow: 'now', angle: 'a', relevance: 80, novelty: 70, usefulness: 60, priceValue: 50, newsworthiness: 40, japanNovelty: 90, audienceFit: 75, confidence: 65 }] };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(shapeInvalid) } }] }), { status: 200 });
      }
      openaiCalls += 1;
      const items = [{ index: 1, topic: 'Candidate B', whyNow: 'now', angle: 'b', relevance: 60, novelty: 50, usefulness: 40, priceValue: 30, newsworthiness: 20, japanNovelty: 70, audienceFit: 55, confidence: 45, risk: 10 }];
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items }) }] }] }), { status: 200 });
    };
    const account = { budgets: { enabled: true, groqCallsPerDay: 10, openaiCallsPerDay: 10 } };
    const result = await triageCandidates('reliability-fixes-account', account, SIMPLE_CANDIDATES);
    assert.equal(groqCalls, 1);
    assert.equal(openaiCalls, 1, 'a schema-invalid Groq response must fall forward, never be accepted as-is');
    assert.equal(result.items[0].topic, 'Candidate B');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
    await rm(CACHE_FILE, { force: true });
  }
});

test('F/G without a fallback provider: a malformed response fails the whole triage instead of silently succeeding', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GROQ_API_KEY', 'OPENAI_API_KEY');
  process.env.GROQ_API_KEY = 'test-groq-key';
  delete process.env.OPENAI_API_KEY;
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  await rm(CACHE_FILE, { force: true });
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"items": [{"index": 0, "topic": "cut off' } }] }), { status: 200 });
    const account = { budgets: { enabled: true, groqCallsPerDay: 10 } };
    await assert.rejects(triageCandidates('reliability-fixes-account', account, SIMPLE_CANDIDATES));
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
    await rm(CACHE_FILE, { force: true });
  }
});

// ---------------------------------------------------------------------------
// I: RSS fetch must follow a safe (re-validated) HTTPS redirect, and must
// reject a redirect toward a private/unsafe network destination.
// ---------------------------------------------------------------------------

test('I1: fetchRssSource follows a public HTTPS redirect (fixes the real kvr-news HTTP 301 failure) and normalizes the final feed', async () => {
  const previousFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      const href = String(url);
      if (href === 'https://feed.example/moved.xml') {
        return new Response(null, { status: 301, headers: { location: 'https://feed.example/final.xml' } });
      }
      if (href === 'https://feed.example/final.xml') {
        return new Response('<rss version="2.0"><channel><item><title>Redirected Item</title><link>https://vendor.example/x</link></item></channel></rss>', { status: 200 });
      }
      throw new Error(`unexpected fetch to ${href}`);
    };
    const candidates = await fetchRssSource({ id: 'kvr-like', type: 'rss', url: 'https://feed.example/moved.xml' });
    assert.equal(calls, 2, 'exactly one redirect hop should have been followed');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].title, 'Redirected Item');
  } finally { globalThis.fetch = previousFetch; }
});

test('I2: a redirect toward a private/unsafe network destination is rejected, not followed', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === 'https://feed.example/moved.xml') {
        return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/internal-feed.xml' } });
      }
      throw new Error(`must not follow the redirect to a private destination (attempted fetch to ${href})`);
    };
    await assert.rejects(
      fetchRssSource({ id: 'unsafe-redirect', type: 'rss', url: 'https://feed.example/moved.xml' }),
      /not a public network destination/
    );
  } finally { globalThis.fetch = previousFetch; }
});

test('I3: fetchWithSafeRedirects bounds the number of hops it will follow', async () => {
  const previousFetch = globalThis.fetch;
  try {
    let hops = 0;
    globalThis.fetch = async () => {
      hops += 1;
      return new Response(null, { status: 302, headers: { location: `https://feed.example/hop-${hops}.xml` } });
    };
    await assert.rejects(fetchWithSafeRedirects('https://feed.example/start.xml', {}, 2, 'test'), /Redirect limit exceeded/);
    assert.ok(hops <= 4, `redirect following must be bounded, got ${hops} attempts`);
  } finally { globalThis.fetch = previousFetch; }
});
