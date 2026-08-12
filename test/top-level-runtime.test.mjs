import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAutopilot } from '../src/orchestrate.mjs';
import { publish } from '../src/publish.mjs';
import { runLivePreflight } from '../src/ops/live-preflight.mjs';
import { collectMetrics } from '../src/analytics/collector.mjs';
import { readMetricSnapshots } from '../src/analytics/store.mjs';

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const MUTABLE_FILES = [
  '../data/audit.jsonl',
  '../data/history.jsonl',
  '../data/metrics.jsonl',
  '../data/usage.jsonl',
  '../data/usage-state.json',
  '../data/runtime-health.json',
  '../data/brakes.json',
  '../data/state.json',
  '../data/x-oauth2-state.json'
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

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

async function snapshot(path) {
  try { return { exists: true, bytes: await readFile(path) }; }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: null };
    throw error;
  }
}

async function restore(path, saved) {
  if (!saved.exists) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, saved.bytes);
}

test('top-level autonomous runtime wires generation, publishing, preflight, and metrics safely', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'OPENAI_MODEL', 'SOCIAL_CREDENTIALS_JSON', 'X_OAUTH2_STATE_KEY');
  const tracked = [CONFIG_FILE, ...MUTABLE_FILES];
  const savedFiles = new Map();
  for (const path of tracked) savedFiles.set(path, await snapshot(path));

  try {
    const config = JSON.parse((await readFile(CONFIG_FILE, 'utf8')));
    config.accounts['example-x'] = {
      ...config.accounts['example-x'],
      enabled: true,
      mode: 'auto',
      generation: {
        ...(config.accounts['example-x'].generation || {}),
        model: 'gpt-5',
        candidateCount: 1,
        maxAttempts: 1,
        maxOutputTokens: 1200
      },
      learning: { enabled: false, exploreRate: 0 },
      experiments: { enabled: false },
      research: { webSearch: false, trendIntelligence: false },
      analytics: { enabled: true, checkpointsMinutes: [1], maxAgeDays: 30 },
      safety: {
        moderation: false,
        maxPostsPerDay: 6,
        minMinutesBetweenPosts: 0,
        anomalyBrake: { enabled: false }
      },
      media: { strategy: 'none' }
    };
    config.accounts['example-instagram'].enabled = false;
    config.accounts['example-instagram'].mode = 'pause';
    await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    for (const path of MUTABLE_FILES) await rm(path, { force: true });

    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'gpt-5';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'example-x': {
        consumerKey: 'consumer-key',
        consumerSecret: 'consumer-secret',
        accessToken: 'access-token',
        accessTokenSecret: 'access-token-secret'
      }
    });

    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      calls.push({ target, method: options.method || 'GET' });

      if (target === 'https://api.openai.com/v1/responses') {
        return jsonResponse({
          output_text: JSON.stringify({
            candidates: [{
              text: 'Top-level integration test post.',
              mediaPrompt: '',
              rationale: 'Exercises the autonomous runtime wiring.',
              spreadPotential: 62,
              noveltyPotential: 58,
              features: {
                topic: 'testing',
                angle: 'runtime wiring',
                hook: 'specific',
                emotion: 'neutral',
                format: 'short',
                cta: 'none',
                mediaDecision: 'none',
                trendUsed: false
              }
            }]
          })
        });
      }
      if (target === 'https://api.openai.com/v1/moderations') {
        return jsonResponse({ results: [{ flagged: false, categories: {} }] });
      }
      if (target === 'https://api.openai.com/v1/models/gpt-5') {
        return jsonResponse({ id: 'gpt-5', owned_by: 'openai' });
      }
      if (target === 'https://api.x.com/2/users/me?user.fields=id,name,username') {
        return jsonResponse({ data: { id: 'user-1', username: 'example', name: 'Example' } });
      }
      if (target.startsWith('https://api.x.com/2/tweets/post-123?')) {
        return jsonResponse({
          data: {
            id: 'post-123',
            public_metrics: {
              impression_count: 1200,
              like_count: 45,
              retweet_count: 8,
              reply_count: 4,
              quote_count: 2,
              bookmark_count: 6
            },
            non_public_metrics: {
              url_link_clicks: 11,
              user_profile_clicks: 13,
              engagements: 89
            }
          },
          includes: { media: [] }
        });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const now = new Date('2026-08-13T00:00:00.000Z');
    const autopilot = await runAutopilot({ accountFilter: 'example-x', force: true, dryRun: true, now });
    assert.equal(autopilot.length, 1);
    assert.equal(autopilot[0].status, 'dry-run');
    assert.equal(autopilot[0].payload.text, 'Top-level integration test post.');
    assert.equal(autopilot[0].payload.mediaResolution.decision, 'none');

    const dryPublished = await publish({
      account: 'example-x',
      text: 'Dry-run publish path.',
      dryRun: true,
      source: 'integration-test',
      slotId: 'example-x:test:dry-run'
    });
    assert.equal(dryPublished.dryRun, true);
    assert.equal(dryPublished.platform, 'x');

    const preflight = await runLivePreflight({ accountFilter: 'example-x' });
    assert.equal(preflight.ok, true);
    assert.equal(preflight.state, 'ready');
    assert.equal(preflight.openai.ok, true);
    assert.equal(preflight.accounts[0].identity.id, 'user-1');

    const historyFile = fileURLToPath(new URL('../data/history.jsonl', import.meta.url));
    const publishedAt = new Date(now.getTime() - 2 * 60_000).toISOString();
    await mkdir(dirname(historyFile), { recursive: true });
    await writeFile(historyFile, `${JSON.stringify({
      at: publishedAt,
      account: 'example-x',
      platform: 'x',
      status: 'published',
      providerPostId: 'post-123',
      text: 'Synthetic published post.',
      mediaType: 'image'
    })}\n`, 'utf8');

    const metricsReport = await collectMetrics({ accountFilter: 'example-x', now });
    assert.equal(metricsReport.some((row) => row.status === 'failed'), false);
    const collected = metricsReport.find((row) => row.status === 'collected');
    assert.equal(collected?.providerPostId, 'post-123');
    assert.equal(collected?.checkpointMinutes, 1);

    const metricRows = await readMetricSnapshots();
    const metric = metricRows.find((row) => row.providerPostId === 'post-123');
    assert.equal(metric?.metrics?.impressions, 1200);
    assert.equal(metric?.metrics?.likes, 45);
    assert.equal(metric?.metrics?.privateMetricsAvailable, true);

    assert.equal(calls.some((row) => row.target === 'https://api.openai.com/v1/responses'), true);
    assert.equal(calls.some((row) => row.target === 'https://api.openai.com/v1/moderations'), true);
    assert.equal(calls.some((row) => row.target.includes('/tweets/post-123?')), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    for (const path of tracked.reverse()) await restore(path, savedFiles.get(path));
  }
});
