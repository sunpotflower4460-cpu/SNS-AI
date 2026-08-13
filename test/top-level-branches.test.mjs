import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runAutopilot } from '../src/orchestrate.mjs';
import { publish } from '../src/publish.mjs';
import { collectXMetrics } from '../src/analytics/x-metrics.mjs';
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

function xAccount(mode = 'auto') {
  return {
    platform: 'x', enabled: true, mode, credentialKey: 'branch-x', displayName: 'Branch X',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon','tue','wed','thu','fri','sat','sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 1, candidateCount: 1, maxOutputTokens: 1000 },
    safety: { moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: true, checkpointsMinutes: [1], maxAgeDays: 30 },
    learning: { enabled: false, humanFeedbackWindow: 5 },
    research: { webSearch: false, trendIntelligence: false },
    resilience: { enabled: true, failureThreshold: 2, cooldownMinutes: 60 },
    budgets: { enabled: false }, experiments: { enabled: false }, media: { strategy: 'none', type: 'image' }
  };
}
function igAccount() {
  return {
    platform: 'instagram', enabled: true, mode: 'manual', credentialKey: 'branch-ig', displayName: 'Branch IG', apiVersion: 'v25.0',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon'], times: ['08:00'], windowMinutes: 30 },
    generation: { maxChars: 1800 }, safety: { moderation: false }, resilience: { enabled: true, failureThreshold: 2, cooldownMinutes: 60 },
    media: { strategy: 'fixed', type: 'image', url: 'https://media.example/a.png' }
  };
}
async function installAccounts({ xMode = 'auto', includeX = true, includeIg = false } = {}) {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  if (includeX) config.accounts['branch-x'] = xAccount(xMode);
  if (includeIg) config.accounts['branch-ig'] = igAccount();
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
function xCreds() {
  return { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' };
}
function generationResponse() {
  return { output_text: JSON.stringify({ candidates: [{
    text: 'Branch integration post.', mediaPrompt: '', rationale: 'branch coverage', spreadPotential: 55, noveltyPotential: 52,
    features: { topic: 'test', angle: 'branch', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed: false }
  }] }) };
}

test('autopilot dry-run exercises the full decision path without calling a publisher', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await installAccounts();
    process.env.OPENAI_API_KEY = 'test-key';
    let xCalled = false;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') return jsonResponse(generationResponse());
      if (target.startsWith('https://api.x.com/')) xCalled = true;
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    const report = await runAutopilot({ accountFilter: 'branch-x', force: true, dryRun: true, now: new Date('2026-08-13T00:00:00+09:00') });
    assert.equal(report[0].status, 'dry-run');
    assert.equal(report[0].payload.dryRun, true);
    assert.equal(xCalled, false);
  } finally {
    globalThis.fetch = previousFetch; restoreEnv(env); await restoreFiles(files);
  }
});

test('approval mode creates one trusted approval issue and force retry recovers it without regenerating', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await installAccounts({ xMode: 'approval' });
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.GITHUB_TOKEN = 'test-github-token';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    const calls = [];
    let createdIssue = null;
    let generationCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url); calls.push({ target, options });
      if (target === 'https://api.openai.com/v1/responses') {
        generationCalls += 1;
        return jsonResponse(generationResponse());
      }
      if (target.startsWith('https://api.github.com/repos/owner/repo/issues?state=open') && !options.method) {
        return jsonResponse(createdIssue ? [createdIssue] : []);
      }
      if (target === 'https://api.github.com/repos/owner/repo/labels/approved' && !options.method) return jsonResponse({ message: 'Not Found' }, 404);
      if (target === 'https://api.github.com/repos/owner/repo/labels' && options.method === 'POST') return jsonResponse({ name: 'approved' }, 201);
      if (target === 'https://api.github.com/repos/owner/repo/issues' && options.method === 'POST') {
        const request = JSON.parse(options.body);
        createdIssue = { number: 42, title: request.title, body: request.body, user: { login: 'github-actions[bot]' } };
        return jsonResponse(createdIssue, 201);
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    const now = new Date('2026-08-13T00:00:00+09:00');
    const first = await runAutopilot({ accountFilter: 'branch-x', force: true, dryRun: false, now });
    assert.equal(first[0].status, 'approval-pending');
    assert.equal(first[0].issue, 42);

    const second = await runAutopilot({ accountFilter: 'branch-x', force: true, dryRun: false, now });
    assert.equal(second[0].status, 'approval-pending-recovered');
    assert.equal(second[0].issue, 42);
    assert.equal(generationCalls, 1);
    assert.equal(calls.filter((row) => row.target.endsWith('/issues') && row.options.method === 'POST').length, 1);
  } finally {
    globalThis.fetch = previousFetch; restoreEnv(env); await restoreFiles(files);
  }
});

test('publish supports Instagram dry-run and records no published history', async () => {
  const env = saveEnv('SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await installAccounts({ includeX: false, includeIg: true });
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'branch-ig': { accessToken: 'ig-token', igUserId: 'ig-user' } });
    const result = await publish({ account: 'branch-ig', text: 'caption', mediaUrl: 'https://media.example/a.png', mediaType: 'image', dryRun: true, source: 'test' });
    assert.equal(result.dryRun, true);
    assert.equal(result.platform, 'instagram');
    await assert.rejects(readFile(DATA_FILES[0], 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    restoreEnv(env); await restoreFiles(files);
  }
});

test('publish records provider failures and opens the publish circuit at its threshold', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await installAccounts();
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'branch-x': xCreds() });
    globalThis.fetch = async (url) => {
      if (String(url) === 'https://api.x.com/2/tweets') return jsonResponse({ error: { message: 'provider down' } }, 503);
      throw new Error(`Unexpected mocked URL: ${url}`);
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        publish({ account: 'branch-x', text: `failure ${attempt}`, dryRun: false, source: 'test' }),
        /provider down/
      );
    }
    await assert.rejects(
      publish({ account: 'branch-x', text: 'blocked by circuit', dryRun: false, source: 'test' }),
      (error) => error.code === 'CIRCUIT_OPEN'
    );
  } finally {
    globalThis.fetch = previousFetch; restoreEnv(env); await restoreFiles(files);
  }
});

test('X metrics falls back to public fields when private metrics are forbidden', async () => {
  const previousFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (url, options = {}) => {
      calls += 1;
      assert.match(String(options.headers.Authorization), /^OAuth /);
      const target = String(url);
      if (calls === 1) {
        assert.match(target, /non_public_metrics/);
        return jsonResponse({ title: 'Forbidden' }, 403);
      }
      assert.equal(target.includes('non_public_metrics'), false);
      return jsonResponse({ data: { public_metrics: { impression_count: 500, like_count: 12 } }, includes: { media: [] } });
    };
    const result = await collectXMetrics({ postId: 'post-1', credential: xCreds() });
    assert.equal(calls, 2);
    assert.equal(result.metrics.privateMetricsAvailable, false);
    assert.equal(result.metrics.impressions, 500);
    assert.match(result.warning, /public metrics only/);
  } finally { globalThis.fetch = previousFetch; }
});

test('preflight handles nothing-enabled and unknown-account branches without external calls', async () => {
  const previousFetch = globalThis.fetch;
  const files = await snapshotFiles([CONFIG_FILE]);
  try {
    globalThis.fetch = async () => { throw new Error('network must not be called'); };
    const nothing = await runLivePreflight();
    assert.equal(nothing.state, 'nothing_enabled');
    assert.equal(nothing.accounts.length, 0);
    await assert.rejects(runLivePreflight({ accountFilter: 'does-not-exist' }), /Unknown account/);
  } finally { globalThis.fetch = previousFetch; await restoreFiles(files); }
});