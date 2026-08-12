import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publishInstagram } from '../src/providers/instagram.mjs';
import { publishX } from '../src/providers/x.mjs';
import { runAutopilot } from '../src/orchestrate.mjs';
import { collectMetrics } from '../src/analytics/collector.mjs';
import { loadAccounts } from '../src/lib/config.mjs';
import { recordUsage } from '../src/ops/budget.mjs';
import { circuitStatus } from '../src/ops/circuit.mjs';

const CONFIG = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const DATA = [
  '../data/history.jsonl', '../data/metrics.jsonl', '../data/audit.jsonl', '../data/state.json',
  '../data/runtime-health.json', '../data/brakes.json', '../data/usage.jsonl', '../data/usage-state.json',
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
  catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
}

async function restore(path, saved) {
  if (!saved.exists) return rm(path, { force: true });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, saved.bytes);
}

async function isolated(paths, fn) {
  const saved = new Map();
  for (const path of paths) saved.set(path, await snapshot(path));
  try {
    for (const path of paths.filter((path) => path !== CONFIG)) await rm(path, { force: true });
    return await fn();
  } finally {
    for (const path of [...paths].reverse()) await restore(path, saved.get(path));
  }
}

async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function runtimeAccount(id, overrides = {}) {
  return {
    platform: 'x', enabled: true, mode: 'auto', credentialKey: id, displayName: id,
    profile: { identity: 'Failure-path test account', goal: 'test runtime safety', audience: 'test runner', topics: ['testing'], style: ['clear'], avoid: ['fabrication'] },
    instructions: 'Generate a simple test post.',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 1, candidateCount: 1, maxOutputTokens: 1000 },
    safety: { moderation: false, maxPostsPerDay: 20, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false }, research: { webSearch: false, trendIntelligence: false },
    resilience: { enabled: true, failureThreshold: 1, cooldownMinutes: 60 }, budgets: { enabled: false },
    experiments: { enabled: false }, media: { strategy: 'none', type: 'image' },
    ...overrides
  };
}

async function addAccounts(rows) {
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  Object.assign(config.accounts, rows);
  await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

test('Instagram processing ERROR aborts before media_publish and surfaces the provider failure', async () => {
  const previousFetch = globalThis.fetch;
  let publishAttempted = false;
  try {
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://graph.instagram.com/v25.0/ig-test/media' && options.method === 'POST') {
        return jsonResponse({ id: 'container-error' });
      }
      if (target === 'https://graph.instagram.com/v25.0/container-error?fields=status_code,status') {
        return jsonResponse({ status_code: 'ERROR', status: 'Synthetic processing rejection' });
      }
      if (target === 'https://graph.instagram.com/v25.0/ig-test/media_publish') publishAttempted = true;
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    await assert.rejects(
      publishInstagram({
        text: 'caption', mediaUrl: 'https://cdn.example/image.png', mediaType: 'image',
        credential: { accessToken: 'ig-token', igUserId: 'ig-test', containerPollSeconds: 1 }
      }),
      /Instagram container failed: Synthetic processing rejection/
    );
    assert.equal(publishAttempted, false, 'a failed container must never be published');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('X Reel processing failure aborts before tweet creation and returns the processing error', async () => {
  const previousFetch = globalThis.fetch;
  let tweetAttempted = false;
  try {
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://cdn.example/failed-video.mp4') {
        return new Response(Buffer.from('synthetic-video'), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (target === 'https://api.x.com/2/media/upload/initialize') return jsonResponse({ data: { id: 'failed-media' } });
      if (target === 'https://api.x.com/2/media/upload/failed-media/append') return jsonResponse({});
      if (target === 'https://api.x.com/2/media/upload/failed-media/finalize') {
        return jsonResponse({ data: { processing_info: { state: 'failed', error: { code: 99, message: 'Synthetic transcode failure' } } } });
      }
      if (target === 'https://api.x.com/2/tweets') tweetAttempted = true;
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    await assert.rejects(
      publishX({
        text: 'must not post', mediaUrl: 'https://cdn.example/failed-video.mp4', mediaType: 'reel',
        credential: { oauth2AccessToken: 'x-oauth2-test' }
      }),
      /X video processing failed.*Synthetic transcode failure/
    );
    assert.equal(tweetAttempted, false, 'failed video processing must never create a tweet');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('autopilot maps exhausted AI budget without opening the circuit, while malformed AI output fails closed and opens it', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  await isolated([CONFIG, ...DATA], async () => {
    try {
      await addAccounts({
        'budget-x': runtimeAccount('budget-x', { budgets: { enabled: true, openaiCallsPerDay: 1 } }),
        'invalid-ai-x': runtimeAccount('invalid-ai-x')
      });
      process.env.OPENAI_API_KEY = 'runtime-test-key';
      process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({});

      const accounts = await loadAccounts();
      await recordUsage('budget-x', accounts['budget-x'], 'openai', { seed: true });
      globalThis.fetch = async () => { throw new Error('network must not be reached after budget exhaustion'); };
      const budgetReport = await runAutopilot({ accountFilter: 'budget-x', force: true, now: new Date('2026-08-13T01:00:00+09:00') });
      assert.equal(budgetReport.length, 1);
      assert.equal(budgetReport[0].status, 'budget-exhausted');
      assert.match(budgetReport[0].error, /budget exhausted/i);
      assert.equal((await circuitStatus('budget-x', 'autopilot', accounts['budget-x'].resilience)).open, false);

      let aiCalls = 0;
      globalThis.fetch = async (url) => {
        const target = String(url);
        if (target === 'https://api.openai.com/v1/responses') {
          aiCalls += 1;
          return jsonResponse({ output_text: 'this is not valid JSON' });
        }
        throw new Error(`Unexpected mocked URL: ${target}`);
      };
      const failedReport = await runAutopilot({ accountFilter: 'invalid-ai-x', force: true, now: new Date('2026-08-13T01:05:00+09:00') });
      assert.equal(failedReport.length, 1);
      assert.equal(failedReport[0].status, 'failed');
      assert.match(failedReport[0].error, /valid JSON/);
      assert.equal(aiCalls, 1);
      const circuit = await circuitStatus('invalid-ai-x', 'autopilot', accounts['invalid-ai-x'].resilience);
      assert.equal(circuit.open, true);
      assert.match(circuit.lastError, /valid JSON/);
      const audit = await readFile(fileURLToPath(new URL('../data/audit.jsonl', import.meta.url)), 'utf8');
      assert.match(audit, /"code":"BUDGET_EXHAUSTED"/);
      assert.match(audit, /"stage":"autopilot-error"/);
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv(env);
    }
  });
});

test('metrics failure opens the analytics circuit, stops remaining posts, and the next run skips external calls', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('SOCIAL_CREDENTIALS_JSON');
  await isolated([CONFIG, ...DATA], async () => {
    try {
      await addAccounts({
        'metrics-x': runtimeAccount('metrics-x', {
          enabled: false, mode: 'pause',
          analytics: { enabled: true, checkpointsMinutes: [1], maxAgeDays: 30 },
          resilience: { enabled: true, failureThreshold: 1, cooldownMinutes: 60 }
        })
      });
      process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
        'metrics-x': { consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as' }
      });
      const historyPath = fileURLToPath(new URL('../data/history.jsonl', import.meta.url));
      await writeJsonl(historyPath, [
        { at: '2026-08-13T00:55:00+09:00', account: 'metrics-x', platform: 'x', status: 'published', providerPostId: 'metrics-fail-1', text: 'one' },
        { at: '2026-08-13T00:56:00+09:00', account: 'metrics-x', platform: 'x', status: 'published', providerPostId: 'metrics-must-not-run', text: 'two' }
      ]);

      let metricsCalls = 0;
      globalThis.fetch = async (url) => {
        const target = String(url);
        if (target.startsWith('https://api.x.com/2/tweets/metrics-fail-1?')) {
          metricsCalls += 1;
          return jsonResponse({ title: 'Synthetic metrics failure' }, 404);
        }
        if (target.includes('metrics-must-not-run')) throw new Error('collector should stop after opening the circuit');
        throw new Error(`Unexpected mocked URL: ${target}`);
      };

      const first = await collectMetrics({ accountFilter: 'metrics-x', now: new Date('2026-08-13T01:00:00+09:00') });
      assert.equal(first[0].status, 'failed');
      assert.equal(first[0].providerPostId, 'metrics-fail-1');
      assert.equal(first[1].status, 'circuit-open');
      assert.equal(metricsCalls, 1);
      const account = (await loadAccounts())['metrics-x'];
      assert.equal((await circuitStatus('metrics-x', 'analytics', account.resilience)).open, true);

      globalThis.fetch = async () => { throw new Error('open analytics circuit must skip all external calls'); };
      const second = await collectMetrics({ accountFilter: 'metrics-x', now: new Date('2026-08-13T01:01:00+09:00') });
      assert.equal(second.length, 1);
      assert.equal(second[0].status, 'circuit-open');
      const audit = await readFile(fileURLToPath(new URL('../data/audit.jsonl', import.meta.url)), 'utf8');
      assert.match(audit, /"stage":"metrics-error"/);
      assert.match(audit, /"providerPostId":"metrics-fail-1"/);
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv(env);
    }
  });
});
