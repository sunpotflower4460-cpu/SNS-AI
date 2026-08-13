import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runAutopilot } from '../src/orchestrate.mjs';
import { usageToday } from '../src/ops/budget.mjs';

// Regression coverage for: dry-run previews used to call the real, paid OpenAI Responses API and
// Moderation API and charge them against the SAME daily budget counter as live posting. That meant
// (a) every "safe" dry-run preview cost real money, and (b) repeated previews earlier in the day could
// exhaust openaiCallsPerDay and cause a legitimate LATER scheduled live post to fail with
// BUDGET_EXHAUSTED. This test fails on the pre-fix code (a live run right after a dry run for the same
// account, sharing a budget of 2 calls/day, hits BUDGET_EXHAUSTED) and passes on the fix.

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const DURABLE_DIR = fileURLToPath(new URL('../data/durable-claims/', import.meta.url));
const DATA_FILES = [
  fileURLToPath(new URL('../data/history.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/metrics.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/audit.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/state.json', import.meta.url)),
  fileURLToPath(new URL('../data/runtime-health.json', import.meta.url)),
  fileURLToPath(new URL('../data/brakes.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage-state.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage.jsonl', import.meta.url))
];

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function saveEnv(...names) { return Object.fromEntries(names.map((name) => [name, process.env[name]])); }
function restoreEnv(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
async function snapshotFiles(paths) {
  const saved = new Map();
  for (const path of paths) {
    try { saved.set(path, await readFile(path)); }
    catch (error) { if (error.code === 'ENOENT') saved.set(path, null); else throw error; }
  }
  return saved;
}
async function restoreFiles(saved) {
  for (const [path, bytes] of saved) {
    if (bytes === null) await rm(path, { force: true }); else await writeFile(path, bytes);
  }
}

function tightBudgetAccount() {
  return {
    platform: 'x', enabled: true, mode: 'auto', credentialKey: 'dry-budget-x', displayName: 'Dry Budget X',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 1, candidateCount: 1, maxOutputTokens: 1000 },
    // moderation stays ON and is deliberately NOT mocked below, so this test also fails loudly if a
    // dry run ever calls moderateText() again.
    safety: { moderation: true, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false, humanFeedbackWindow: 5 },
    research: { webSearch: false, trendIntelligence: false },
    resilience: { enabled: true, failureThreshold: 2, cooldownMinutes: 60 },
    // The whole point of this fixture: a tight daily OpenAI budget shared by the account. A live post
    // needs 2 units (generation + moderation); a dry-run preview needs only 1 (moderation is skipped).
    budgets: { enabled: true, openaiCallsPerDay: 2 },
    experiments: { enabled: false }, media: { strategy: 'none', type: 'image' }
  };
}

async function installAccount() {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts['dry-budget-x'] = tightBudgetAccount();
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function generationResponse(text) {
  return { output_text: JSON.stringify({ candidates: [{
    text, mediaPrompt: '', rationale: 'dry-run budget isolation coverage', spreadPotential: 55, noveltyPotential: 52,
    features: { topic: 'test', angle: 'dry-run', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed: false }
  }] }) };
}

test('a dry-run preview does not consume the account\'s live daily OpenAI budget or call moderation', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installAccount();
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'dry-budget-x': { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }
    });

    let responsesCalls = 0;
    let xCalled = false;
    // Deliberately no mock for /v1/moderations: if generatePost's dry-run path ever calls
    // moderateText() again, this mock throws "Unexpected mocked URL" and fails the test loudly.
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') {
        responsesCalls += 1;
        return jsonResponse(generationResponse('Dry-run preview text.'));
      }
      if (target.startsWith('https://api.x.com/')) xCalled = true;
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const account = tightBudgetAccount();
    const dryReport = await runAutopilot({ accountFilter: 'dry-budget-x', force: true, dryRun: true, now: new Date('2026-08-13T00:00:00+09:00') });
    assert.equal(dryReport[0].status, 'dry-run');
    assert.equal(dryReport[0].payload.dryRun, true);
    assert.equal(xCalled, false, 'dry-run must never call the publisher');
    assert.equal(responsesCalls, 1, 'dry-run should still preview real generated text');

    // The account's LIVE openai budget (what a real scheduled run would check) must be untouched by
    // the preview above - it shares the same 1-call/day cap the live run below will also draw from.
    const liveUsageAfterDryRun = await usageToday('dry-budget-x', account, 'openai');
    assert.equal(liveUsageAfterDryRun, 0, 'dry-run generation must not be counted against the live daily budget');

    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') {
        responsesCalls += 1;
        return jsonResponse(generationResponse('Live post text.'));
      }
      if (target === 'https://api.openai.com/v1/moderations') {
        return jsonResponse({ results: [{ flagged: false, categories: {} }] });
      }
      if (target === 'https://api.x.com/2/tweets' && options.method === 'POST') {
        return jsonResponse({ data: { id: 'dry-budget-post', text: 'Live post text.' } });
      }
      if (target.startsWith('https://api.x.com/2/tweets/dry-budget-post?')) {
        return jsonResponse({ data: { id: 'dry-budget-post', public_metrics: {}, non_public_metrics: {} }, includes: { media: [] } });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    // With the fix, this live run still has its full 2/2 daily allowance available, because the dry
    // run above was billed against a separate preview bucket. On the pre-fix code this throws
    // BUDGET_EXHAUSTED because the dry run already spent one of the account's two daily OpenAI calls.
    const liveReport = await runAutopilot({ accountFilter: 'dry-budget-x', force: true, dryRun: false, now: new Date('2026-08-13T00:05:00+09:00') });
    assert.equal(liveReport[0].status, 'published', `expected a live publish, got: ${JSON.stringify(liveReport[0])}`);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});
