import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refreshTrends, loadTrendBrief } from '../src/research/trends.mjs';

const CONFIG = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const SOURCES_CONFIG = fileURLToPath(new URL('../config/research-sources.json', import.meta.url));
const FILES = [
  '../data/trends/example-x.json',
  '../data/research-cache/example-x.json',
  '../data/usage.jsonl', '../data/usage-state.json', '../data/audit.jsonl', '../data/runtime-health.json'
].map((p) => fileURLToPath(new URL(p, import.meta.url)));

function saveEnv(...names) { return Object.fromEntries(names.map((n) => [n, process.env[n]])); }
function restoreEnv(saved) { for (const [n, v] of Object.entries(saved)) v === undefined ? delete process.env[n] : process.env[n] = v; }
async function snap(path) { try { return { exists: true, bytes: await readFile(path) }; } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; } }
async function restore(path, saved) { if (!saved.exists) return rm(path, { force: true }); await mkdir(dirname(path), { recursive: true }); await writeFile(path, saved.bytes); }
async function isolated(fn) {
  const tracked = [CONFIG, SOURCES_CONFIG, ...FILES]; const saved = new Map();
  for (const path of tracked) saved.set(path, await snap(path));
  try { for (const path of FILES) await rm(path, { force: true }); return await fn(); }
  finally { for (const path of tracked.reverse()) await restore(path, saved.get(path)); }
}

const RSS_XML = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>Item A</title><link>https://vendor.example/a</link><pubDate>Wed, 26 Aug 2026 10:00:00 GMT</pubDate><description>Summary A</description></item>
  <item><title>Item B</title><link>https://vendor.example/b</link><pubDate>Wed, 26 Aug 2026 11:00:00 GMT</pubDate><description>Summary B</description></item>
  <item><title>Item C</title><link>https://vendor.example/c</link><pubDate>Wed, 26 Aug 2026 12:00:00 GMT</pubDate><description>Summary C</description></item>
</channel></rss>`;

async function withAccountConfig(overrides, sources, fn) {
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  config.accounts['example-x'] = { ...config.accounts['example-x'], enabled: true, ...overrides };
  config.accounts['example-instagram'].enabled = false;
  await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await mkdir(dirname(SOURCES_CONFIG), { recursive: true });
  await writeFile(SOURCES_CONFIG, `${JSON.stringify(sources, null, 2)}\n`, 'utf8');
  return fn();
}

test('direct-fetch path is used (and Web Search is never called) when enough fresh candidates exist', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'GROQ_API_KEY');
  process.env.OPENAI_API_KEY = 'test-openai';
  process.env.GROQ_API_KEY = 'test-groq';
  try {
    await isolated(async () => {
      await withAccountConfig({
        research: { webSearch: true, trendIntelligence: true, trendRefreshHours: 6, directFetch: true, minDirectCandidates: 2, maxTriageCandidates: 10 },
        budgets: { enabled: true, openaiCallsPerDay: 20, webSearchCallsPerDay: 20, groqCallsPerDay: 20 }
      }, { 'example-x': [{ id: 'vendor-feed', type: 'rss', url: 'https://feed.example/rss.xml' }] }, async () => {
        let webSearchCalled = false;
        globalThis.fetch = async (url, options = {}) => {
          const href = String(url);
          if (href === 'https://feed.example/rss.xml') return new Response(RSS_XML, { status: 200 });
          if (href === 'https://api.groq.com/openai/v1/chat/completions') {
            const body = JSON.parse(String(options.body));
            assert.equal(body.messages[1].role, 'user');
            return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
              items: [
                { index: 0, topic: 'Item A', whyNow: 'now', angle: 'a', relevance: 90, novelty: 80, usefulness: 70, priceValue: 60, newsworthiness: 50, japanNovelty: 85, audienceFit: 75, confidence: 70, risk: 5 },
                { index: 1, topic: 'Item B', whyNow: 'now', angle: 'b', relevance: 40, novelty: 30, usefulness: 20, priceValue: 20, newsworthiness: 20, japanNovelty: 20, audienceFit: 20, confidence: 40, risk: 40 }
              ]
            }) } }] }), { status: 200 });
          }
          if (href === 'https://api.openai.com/v1/responses') { webSearchCalled = true; return new Response('{}', { status: 200 }); }
          throw new Error(`unexpected fetch to ${href}`);
        };

        const report = await refreshTrends({ accountFilter: 'example-x', force: true });
        assert.equal(report[0].status, 'updated');
        assert.equal(report[0].mode, 'direct-fetch');
        assert.equal(webSearchCalled, false, 'Web Search must not be called when direct-fetch already produced enough candidates');
        const brief = await loadTrendBrief('example-x');
        assert.equal(brief.research.mode, 'direct-fetch');
        assert.equal(brief.items[0].topic, 'Item A');
        assert.ok(brief.items[0].opportunityScore > brief.items[1].opportunityScore);
      });
    });
  } finally { globalThis.fetch = previousFetch; restoreEnv(env); }
});

test('falls back to Web Search when direct-fetch produces too few fresh candidates', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'GROQ_API_KEY');
  process.env.OPENAI_API_KEY = 'test-openai';
  delete process.env.GROQ_API_KEY;
  try {
    await isolated(async () => {
      await withAccountConfig({
        research: { webSearch: true, trendIntelligence: true, trendRefreshHours: 6, directFetch: true, minDirectCandidates: 10, maxTriageCandidates: 10 },
        budgets: { enabled: true, openaiCallsPerDay: 20, webSearchCallsPerDay: 20 }
      }, { 'example-x': [{ id: 'vendor-feed', type: 'rss', url: 'https://feed.example/rss.xml' }] }, async () => {
        let webSearchCalled = false;
        globalThis.fetch = async (url) => {
          const href = String(url);
          if (href === 'https://feed.example/rss.xml') return new Response(RSS_XML, { status: 200 });
          if (href === 'https://api.openai.com/v1/responses') {
            webSearchCalled = true;
            return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: 'ws', items: [] }) }] }] }), { status: 200 });
          }
          throw new Error(`unexpected fetch to ${href}`);
        };

        const report = await refreshTrends({ accountFilter: 'example-x', force: true });
        assert.equal(report[0].status, 'updated');
        assert.equal(report[0].mode, 'web-search-fallback');
        assert.equal(webSearchCalled, true, 'Web Search fallback must run when direct-fetch is insufficient');
        const brief = await loadTrendBrief('example-x');
        assert.equal(brief.research.mode, 'web-search-fallback');
        assert.equal(brief.research.freshCount, 3, 'direct-fetch still ran and reported its (insufficient) candidate count');
      });
    });
  } finally { globalThis.fetch = previousFetch; restoreEnv(env); }
});

test('an account without research.directFetch enabled uses Web Search exactly as before (no behavior change)', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY');
  process.env.OPENAI_API_KEY = 'test-openai';
  try {
    await isolated(async () => {
      await withAccountConfig({
        research: { webSearch: true, trendIntelligence: true, trendRefreshHours: 6 },
        budgets: { enabled: true, openaiCallsPerDay: 20, webSearchCallsPerDay: 20 }
      }, {}, async () => {
        globalThis.fetch = async (url) => {
          assert.equal(String(url), 'https://api.openai.com/v1/responses');
          return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: 'ws', items: [] }) }] }] }), { status: 200 });
        };
        const report = await refreshTrends({ accountFilter: 'example-x', force: true });
        assert.equal(report[0].mode, 'web-search');
        const brief = await loadTrendBrief('example-x');
        assert.equal(brief.research.mode, 'web-search');
      });
    });
  } finally { globalThis.fetch = previousFetch; restoreEnv(env); }
});
