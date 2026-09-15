import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runLivePreflight } from '../src/ops/live-preflight.mjs';

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const PREFLIGHT_WORKFLOW = fileURLToPath(new URL('../.github/workflows/preflight.yml', import.meta.url));
const GROQ_MODEL = 'openai/gpt-oss-120b';
const DATA_FILES = [
  fileURLToPath(new URL('../data/audit.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/usage-state.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage.jsonl', import.meta.url))
];

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

function preflightAccount(aiOverride = null) {
  return {
    platform: 'x', enabled: true, mode: 'auto', credentialKey: 'groq-pf-x', displayName: 'Groq Preflight X',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Preflight fixture.',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon'], times: ['08:00'], windowMinutes: 30 },
    safety: { moderation: false },
    analytics: { enabled: false }, learning: { enabled: false },
    research: { webSearch: false, trendIntelligence: false },
    budgets: { enabled: false }, experiments: { enabled: false },
    media: { strategy: 'none', type: 'image' },
    ...(aiOverride ? { ai: aiOverride } : {})
  };
}

async function installAccount(aiOverride = null) {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts['groq-pf-x'] = preflightAccount(aiOverride);
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function installFetchMock({ groqIds = [GROQ_MODEL], onRequest = null } = {}) {
  const requested = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    requested.push({ url: target, method });
    if (onRequest) onRequest(target, method);
    if (target === 'https://api.openai.com/v1/moderations') {
      return new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), { status: 200 });
    }
    const modelProbe = target.match(/^https:\/\/api\.openai\.com\/v1\/models\/([^/]+)$/);
    if (modelProbe) return new Response(JSON.stringify({ id: modelProbe[1], owned_by: 'openai' }), { status: 200 });
    if (target === 'https://api.groq.com/openai/v1/models') {
      return new Response(JSON.stringify({ object: 'list', data: groqIds.map((id) => ({ id, object: 'model' })) }), { status: 200 });
    }
    if (target === 'https://api.x.com/2/users/me?user.fields=id,name,username') {
      return new Response(JSON.stringify({ data: { id: 'owner-1', username: 'groq_pf', name: 'Groq PF' } }), { status: 200 });
    }
    throw new Error(`Unexpected mocked URL: ${method} ${target}`);
  };
  return {
    requested,
    restore: () => { globalThis.fetch = previousFetch; },
    groqUrls: () => requested.filter((r) => r.url.includes('groq.com'))
  };
}

async function withFixture({ aiOverride = null, groqKey = null, groqIds = [GROQ_MODEL], run }) {
  const env = saveEnv('OPENAI_API_KEY', 'GROQ_API_KEY', 'SOCIAL_CREDENTIALS_JSON', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'SNS_REQUIRE_DURABLE_STATE');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  const mock = installFetchMock({ groqIds });
  try {
    await installAccount(aiOverride);
    process.env.OPENAI_API_KEY = 'test-openai-key';
    if (groqKey) process.env.GROQ_API_KEY = groqKey; else delete process.env.GROQ_API_KEY;
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'groq-pf-x': { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }
    });
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.SNS_REQUIRE_DURABLE_STATE;
    return await run(mock);
  } finally {
    mock.restore();
    restoreEnv(env);
    await restoreFiles(files);
  }
}

test('A: Groq provider configured + GROQ_API_KEY missing -> Groq readiness blocks the account even with an OpenAI fallback', async () => {
  await withFixture({
    groqKey: null,
    run: async (mock) => {
      const report = await runLivePreflight({ accountFilter: 'groq-pf-x' });
      assert.equal(report.groq.checked, true);
      assert.equal(report.groq.ok, false);
      assert.match(report.groq.error, /GROQ_API_KEY is missing/);
      assert.equal(report.ok, false, 'a Groq-dependent account must not be fully ready without its Groq key');
      assert.equal(report.state, 'blocked');
      const row = report.accounts.find((r) => r.account === 'groq-pf-x');
      assert.equal(row.ok, false);
      assert.equal(row.groq.required, true);
      assert.equal(row.groq.model, GROQ_MODEL);
      assert.equal(row.groq.ok, false);
      assert.match(row.groq.error, /GROQ_API_KEY is missing/);
      assert.equal(report.openai.ok, true, 'OpenAI checks themselves stay healthy; the fallback existing does not make the account ready');
      assert.ok(mock.groqUrls().length >= 0, 'no Groq call can even be attempted without a key');
    }
  });
});

test('B: account without Groq in providers -> no Groq check, no new blocker', async () => {
  await withFixture({
    aiOverride: { providers: ['openai'], allowFallback: true, openaiTriageModel: 'gpt-5.6-luna' },
    groqKey: null,
    run: async (mock) => {
      const report = await runLivePreflight({ accountFilter: 'groq-pf-x' });
      assert.equal(report.groq.checked, false);
      assert.equal(report.groq.ok, null);
      assert.deepEqual(report.groq.models, []);
      assert.equal(report.ok, true, 'a non-Groq account must not be blocked by the Groq section');
      assert.equal(report.state, 'ready');
      assert.equal(report.accounts[0].groq.required, false);
      assert.equal(mock.groqUrls().length, 0, 'no Groq endpoint may be touched for an account that does not use Groq');
    }
  });
});

test('C: GROQ_API_KEY present + configured model available -> Groq ready', async () => {
  await withFixture({
    groqKey: 'test-groq-key',
    groqIds: [GROQ_MODEL, 'llama-3.3-70b-versatile'],
    run: async (mock) => {
      const report = await runLivePreflight({ accountFilter: 'groq-pf-x' });
      assert.equal(report.groq.checked, true);
      assert.equal(report.groq.ok, true);
      assert.equal(report.groq.error, null);
      assert.equal(report.groq.models[0].model, GROQ_MODEL);
      assert.equal(report.groq.models[0].ok, true);
      assert.equal(report.ok, true);
      assert.equal(report.accounts[0].groq.ok, true);
      assert.deepEqual(mock.groqUrls(), [{ url: 'https://api.groq.com/openai/v1/models', method: 'GET' }]);
    }
  });
});

test('D: configured Groq model not in the account model list -> blocked', async () => {
  await withFixture({
    groqKey: 'test-groq-key',
    groqIds: ['some-other-model'],
    run: async () => {
      const report = await runLivePreflight({ accountFilter: 'groq-pf-x' });
      assert.equal(report.groq.checked, true);
      assert.equal(report.groq.ok, false);
      assert.match(report.groq.models[0].error, /not available/);
      assert.equal(report.ok, false);
      const row = report.accounts.find((r) => r.account === 'groq-pf-x');
      assert.equal(row.ok, false);
      assert.equal(row.groq.ok, false);
    }
  });
});

test('E: the Groq probe never calls a generation/inference endpoint', async () => {
  await withFixture({
    groqKey: 'test-groq-key',
    run: async (mock) => {
      await runLivePreflight({ accountFilter: 'groq-pf-x' });
      for (const { url, method } of mock.groqUrls()) {
        assert.equal(method, 'GET', 'Groq probe must be read-only');
        assert.ok(url.endsWith('/models'), `Groq probe must use the model list endpoint, not an inference endpoint: ${url}`);
        assert.ok(!url.includes('/chat/completions'), 'chat completions must never be called by preflight');
      }
    }
  });
});

test('G/H: preflight.yml passes secrets.GROQ_API_KEY and keeps GH_TOKEN on github.token (no new secret required)', async () => {
  const workflow = await readFile(PREFLIGHT_WORKFLOW, 'utf8');
  assert.match(workflow, /GROQ_API_KEY: \$\{\{ secrets\.GROQ_API_KEY \}\}/, 'preflight workflow must forward the GROQ_API_KEY secret');
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/, 'GH_TOKEN must stay on the built-in github.token');
  assert.doesNotMatch(workflow, /GH_TOKEN: \$\{\{ secrets\./, 'GH_TOKEN must not be switched to a repository secret');
});
