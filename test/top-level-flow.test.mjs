import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runAutopilot } from '../src/orchestrate.mjs';
import { collectMetrics } from '../src/analytics/collector.mjs';
import { runLivePreflight } from '../src/ops/live-preflight.mjs';

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
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
    if (bytes === null) await rm(path, { force: true });
    else await writeFile(path, bytes);
  }
}

function integrationAccount() {
  return {
    platform: 'x',
    enabled: true,
    mode: 'auto',
    credentialKey: 'integration-x',
    displayName: 'Integration X',
    profile: {
      identity: 'Automated test account',
      goal: 'Verify end-to-end orchestration',
      audience: 'test runner',
      topics: ['testing'],
      style: ['clear'],
      avoid: ['fabrication']
    },
    instructions: 'Generate one factual test post.',
    schedule: {
      timezone: 'Asia/Tokyo',
      days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      times: ['08:00'],
      windowMinutes: 30
    },
    generation: {
      model: 'gpt-5', maxChars: 280, historyWindow: 5,
      duplicateThreshold: 0.72, maxAttempts: 1, candidateCount: 1, maxOutputTokens: 1000
    },
    safety: {
      moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0,
      anomalyBrake: { enabled: false }
    },
    analytics: { enabled: true, checkpointsMinutes: [1], maxAgeDays: 30 },
    learning: { enabled: false, humanFeedbackWindow: 5 },
    research: { webSearch: false, trendIntelligence: false },
    resilience: { enabled: true, failureThreshold: 3, cooldownMinutes: 60 },
    budgets: { enabled: false },
    experiments: { enabled: false },
    media: { strategy: 'none', type: 'image' }
  };
}

async function installIntegrationAccount() {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts['integration-x'] = integrationAccount();
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function credentials() {
  return {
    consumerKey: 'test-consumer-key',
    consumerSecret: 'test-consumer-secret',
    accessToken: 'test-user-token',
    accessTokenSecret: 'test-user-secret'
  };
}

function generationResponse() {
  return {
    output_text: JSON.stringify({
      candidates: [{
        text: 'Automated integration test post.',
        mediaPrompt: '',
        rationale: 'Exercises the complete autonomous publish path.',
        spreadPotential: 60,
        noveltyPotential: 55,
        features: {
          topic: 'testing', angle: 'integration', hook: 'statement', emotion: 'neutral',
          format: 'short', cta: 'none', mediaDecision: 'none', trendUsed: false
        }
      }]
    })
  };
}

test('autopilot publishes through X and the metrics collector captures the first checkpoint', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await installIntegrationAccount();
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'integration-x': credentials() });

    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      calls.push({ target, options });
      if (target === 'https://api.openai.com/v1/responses') return jsonResponse(generationResponse());
      if (target === 'https://api.x.com/2/tweets' && options.method === 'POST') {
        assert.match(String(options.headers.Authorization), /^OAuth /);
        assert.equal(JSON.parse(options.body).text, 'Automated integration test post.');
        return jsonResponse({ data: { id: 'post-integration', text: 'Automated integration test post.' } });
      }
      if (target.startsWith('https://api.x.com/2/tweets/post-integration?')) {
        assert.match(String(options.headers.Authorization), /^OAuth /);
        return jsonResponse({
          data: {
            id: 'post-integration',
            public_metrics: {
              impression_count: 1200, like_count: 40, retweet_count: 5,
              reply_count: 3, quote_count: 1, bookmark_count: 7
            },
            non_public_metrics: { url_link_clicks: 9, user_profile_clicks: 11, engagements: 75 }
          },
          includes: { media: [] }
        });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const autopilot = await runAutopilot({
      accountFilter: 'integration-x', force: true, dryRun: false, now: new Date('2026-08-13T00:00:00+09:00')
    });
    assert.equal(autopilot.length, 1);
    assert.equal(autopilot[0].status, 'published');
    assert.equal(autopilot[0].result.postId, 'post-integration');

    const historyText = await readFile(DATA_FILES[0], 'utf8');
    assert.match(historyText, /"providerPostId":"post-integration"/);
    assert.match(historyText, /"status":"published"/);

    const metricsReport = await collectMetrics({
      accountFilter: 'integration-x', now: new Date(Date.now() + 2 * 60_000)
    });
    const collected = metricsReport.find((row) => row.status === 'collected');
    assert.ok(collected);
    assert.equal(collected.providerPostId, 'post-integration');
    assert.equal(collected.checkpointMinutes, 1);

    const metricsText = await readFile(DATA_FILES[1], 'utf8');
    assert.match(metricsText, /"providerPostId":"post-integration"/);
    assert.match(metricsText, /"impressions":1200/);
    assert.equal(calls.some((row) => row.target === 'https://api.openai.com/v1/responses'), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});

test('Live Preflight validates OpenAI model visibility and the authenticated X identity without posting', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    await installIntegrationAccount();
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'integration-x': credentials() });

    let postAttempted = false;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/moderations') {
        return jsonResponse({ results: [{ flagged: false, categories: {} }] });
      }
      if (target === 'https://api.openai.com/v1/models/gpt-5') {
        assert.equal(options.headers.Authorization, 'Bearer test-openai-key');
        return jsonResponse({ id: 'gpt-5', owned_by: 'openai' });
      }
      if (target === 'https://api.x.com/2/users/me?user.fields=id,name,username') {
        assert.match(String(options.headers.Authorization), /^OAuth /);
        return jsonResponse({ data: { id: 'user-1', username: 'integration_test', name: 'Integration Test' } });
      }
      if (target === 'https://api.x.com/2/tweets') postAttempted = true;
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const report = await runLivePreflight({ accountFilter: 'integration-x' });
    assert.equal(report.ok, true);
    assert.equal(report.state, 'ready');
    assert.equal(report.openai.ok, true);
    assert.equal(report.openai.models[0].model, 'gpt-5');
    assert.equal(report.accounts[0].identity.username, 'integration_test');
    assert.equal(postAttempted, false, 'preflight must never publish');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});

test('Live Preflight blocks the account when a configured OpenAI model is unavailable', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    await installIntegrationAccount();
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'integration-x': credentials() });

    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/moderations') {
        return jsonResponse({ results: [{ flagged: false, categories: {} }] });
      }
      if (target === 'https://api.openai.com/v1/models/gpt-5') {
        return jsonResponse({ error: { message: 'model unavailable' } }, 404);
      }
      if (target === 'https://api.x.com/2/users/me?user.fields=id,name,username') {
        assert.match(String(options.headers.Authorization), /^OAuth /);
        return jsonResponse({ data: { id: 'user-1', username: 'integration_test' } });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const report = await runLivePreflight({ accountFilter: 'integration-x' });
    assert.equal(report.ok, false);
    assert.equal(report.state, 'blocked');
    assert.equal(report.openai.models[0].ok, false);
    assert.match(report.openai.models[0].error, /model unavailable/);
    assert.equal(report.accounts[0].ok, false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});
