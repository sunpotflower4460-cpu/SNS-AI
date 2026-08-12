import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refreshTrends, loadTrendBrief } from '../src/research/trends.mjs';
import { runPolicyWatch } from '../src/research/policy-watch.mjs';

const CONFIG = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const FILES = [
  '../data/trends/example-x.json', '../data/policies/x.json', '../data/policies/instagram.json',
  '../data/usage.jsonl', '../data/usage-state.json', '../data/audit.jsonl', '../data/runtime-health.json'
].map((p) => fileURLToPath(new URL(p, import.meta.url)));

function saveEnv(...names) { return Object.fromEntries(names.map((n) => [n, process.env[n]])); }
function restoreEnv(saved) { for (const [n, v] of Object.entries(saved)) v === undefined ? delete process.env[n] : process.env[n] = v; }
async function snap(path) { try { return { exists: true, bytes: await readFile(path) }; } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; } }
async function restore(path, saved) { if (!saved.exists) return rm(path, { force: true }); await mkdir(dirname(path), { recursive: true }); await writeFile(path, saved.bytes); }
async function isolated(fn) {
  const tracked = [CONFIG, ...FILES]; const saved = new Map();
  for (const path of tracked) saved.set(path, await snap(path));
  try { for (const path of FILES) await rm(path, { force: true }); return await fn(); }
  finally { for (const path of tracked.reverse()) await restore(path, saved.get(path)); }
}
function responseWithJson(value, citation) {
  return new Response(JSON.stringify({
    output: [{ type: 'message', content: [{
      type: 'output_text', text: JSON.stringify(value),
      annotations: citation ? [{ type: 'url_citation', url: citation.url, title: citation.title }] : []
    }] }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('trend intelligence updates, ranks cited trends, persists them, and skips a fresh brief', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'OPENAI_MODEL');
  process.env.OPENAI_API_KEY = 'test-openai'; process.env.OPENAI_MODEL = 'gpt-5';
  try {
    await isolated(async () => {
      const config = JSON.parse(await readFile(CONFIG, 'utf8'));
      config.accounts['example-x'] = {
        ...config.accounts['example-x'], enabled: true,
        research: { webSearch: true, trendIntelligence: true, trendRefreshHours: 6, model: 'gpt-5' },
        budgets: { ...(config.accounts['example-x'].budgets || {}), enabled: true, openaiCallsPerDay: 20, webSearchCallsPerDay: 20 }
      };
      config.accounts['example-instagram'].enabled = false;
      await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

      let calls = 0;
      globalThis.fetch = async (url, options = {}) => {
        assert.equal(String(url), 'https://api.openai.com/v1/responses'); calls += 1;
        const body = JSON.parse(String(options.body));
        assert.equal(body.text.format.name, 'trend_brief');
        assert.equal(body.tools[0].type, 'web_search');
        return responseWithJson({
          summary: 'Two relevant trends.',
          items: [
            { topic: 'High opportunity', whyNow: 'now', angle: 'specific', relevance: 95, novelty: 90, saturation: 20, risk: 10 },
            { topic: 'Lower opportunity', whyNow: 'now', angle: 'generic', relevance: 60, novelty: 40, saturation: 80, risk: 30 }
          ]
        }, { url: 'https://docs.x.com/example-trend', title: 'Official source' });
      };

      const updated = await refreshTrends({ accountFilter: 'example-x', force: true });
      assert.equal(updated[0].status, 'updated');
      assert.equal(updated[0].top[0].topic, 'High opportunity');
      assert.equal(updated[0].sourceCount, 1);
      const brief = await loadTrendBrief('example-x');
      assert.equal(brief.items[0].opportunityScore > brief.items[1].opportunityScore, true);
      assert.equal(brief.sources[0].url, 'https://docs.x.com/example-trend');

      const fresh = await refreshTrends({ accountFilter: 'example-x', force: false });
      assert.equal(fresh[0].status, 'fresh');
      assert.equal(calls, 1);
    });
  } finally { globalThis.fetch = previousFetch; restoreEnv(env); }
});

test('policy watch accepts only official-domain sources and requests review when official evidence is absent', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'OPENAI_MODEL');
  process.env.OPENAI_API_KEY = 'test-openai'; process.env.OPENAI_MODEL = 'gpt-5';
  try {
    await isolated(async () => {
      globalThis.fetch = async (url, options = {}) => {
        assert.equal(String(url), 'https://api.openai.com/v1/responses');
        const body = JSON.parse(String(options.body));
        const system = body.input?.[0]?.content?.[0]?.text || '';
        if (system.includes('current official x ')) {
          return responseWithJson({
            summary: 'X policy summary',
            rules: [{ id: 'x-automation', rule: 'Use approved API automation.', impact: 'Keep publishing API-based.' }],
            actionItems: [], requiresHumanReview: false,
            sourceUrls: ['https://docs.x.com/x-api/posts']
          }, { url: 'https://help.x.com/en/rules-and-policies/x-automation', title: 'X automation' });
        }
        if (system.includes('current official instagram ')) {
          return responseWithJson({
            summary: 'Instagram policy summary',
            rules: [{ id: 'ig-publish', rule: 'Publishing permissions are required.', impact: 'Validate token permissions.' }],
            actionItems: [], requiresHumanReview: false,
            sourceUrls: ['https://thirdparty.example/instagram-policy']
          }, { url: 'https://thirdparty.example/instagram-policy', title: 'Untrusted' });
        }
        throw new Error('Unexpected policy prompt');
      };

      const results = await runPolicyWatch();
      assert.equal(results.length, 2);
      const x = results.find((row) => row.platform === 'x');
      const instagram = results.find((row) => row.platform === 'instagram');
      assert.equal(x.status, 'updated');
      assert.equal(x.report.sources.length, 2);
      assert.equal(x.report.sources.every((s) => /(?:help|docs)\.x\.com/.test(new URL(s.url).hostname)), true);
      assert.equal(x.report.requiresHumanReview, false);
      assert.equal(instagram.status, 'updated');
      assert.equal(instagram.report.sources.length, 0);
      assert.equal(instagram.report.requiresHumanReview, true);
      assert.equal(instagram.report.actionItems.some((x) => x.includes('No validated official-domain source URL')), true);
    });
  } finally { globalThis.fetch = previousFetch; restoreEnv(env); }
});
