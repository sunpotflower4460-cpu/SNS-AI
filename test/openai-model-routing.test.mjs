import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { resolveRoute, resolveGenerationModel, constrainRouteForBudget } from '../src/ai/router.mjs';
import { runOpenAiTask } from '../src/ai/openai-task.mjs';
import { runAiTask } from '../src/ai/provider.mjs';
import { generateTrendBrief } from '../src/lib/openai.mjs';
import { loadAccounts } from '../src/lib/config.mjs';

const GROQ_MODEL = 'openai/gpt-oss-120b';
const LUNA = 'gpt-5.6-luna';
const TERRA = 'gpt-5.6-terra';
const SOL = 'gpt-5.6-sol';
const USAGE_STATE = fileURLToPath(new URL('../data/usage-state.json', import.meta.url));
const USAGE_FILE = fileURLToPath(new URL('../data/usage.jsonl', import.meta.url));

function saveEnv(...names) { return Object.fromEntries(names.map((n) => [n, process.env[n]])); }
function restoreEnv(saved) { for (const [n, v] of Object.entries(saved)) v === undefined ? delete process.env[n] : process.env[n] = v; }
async function snap(path) { try { return { exists: true, bytes: await readFile(path) }; } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; } }
async function restoreFile(path, saved) { if (!saved.exists) return rm(path, { force: true }); await writeFile(path, saved.bytes); }
async function firstAccount() {
  const accounts = await loadAccounts();
  const account = Object.values(accounts)[0];
  assert.equal(account.ai?.openaiTriageModel, LUNA);
  assert.equal(account.ai?.openaiHighModel, TERRA);
  assert.equal(account.ai?.openaiCriticalModel, SOL);
  assert.equal(account.generation?.model, LUNA);
  return account;
}

test('A: research-triage routes cheap -> groq -> openai/gpt-oss-120b on production config', async () => {
  const account = await firstAccount();
  const route = resolveRoute(account, 'research-triage');
  assert.equal(route.tier, 'cheap');
  assert.equal(route.provider, 'groq');
  assert.equal(route.model, GROQ_MODEL);
});

test('B: Groq failure falls forward to OpenAI triage on gpt-5.6-luna', async () => {
  const env = saveEnv('GROQ_API_KEY', 'OPENAI_API_KEY');
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const previousFetch = globalThis.fetch;
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  try {
    const bodies = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('groq.com')) return new Response(JSON.stringify({ error: { message: 'groq unavailable' } }), { status: 500 });
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] }), { status: 200 });
    };
    const account = await firstAccount();
    const result = await runAiTask('acct', { ...account, budgets: { enabled: true, groqCallsPerDay: 10, openaiCallsPerDay: 10 } }, 'research-triage', { system: 's', user: 'u', schema: { type: 'object' } });
    assert.equal(result.provider, 'openai');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].model, LUNA, 'OpenAI triage fallback must run on gpt-5.6-luna');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
  }
});

test('C: post-generation normally routes balanced -> openai -> gpt-5.6-luna', async () => {
  const account = await firstAccount();
  const route = resolveRoute(account, 'post-generation');
  assert.equal(route.tier, 'balanced');
  assert.equal(route.provider, 'openai');
  assert.equal(route.model, LUNA);
  const resolved = resolveGenerationModel(account, { task: 'post-generation', budgetState: 'healthy' });
  assert.equal(resolved.model, LUNA);
  assert.equal(resolved.route.tier, 'balanced');
});

test('D: high-value-url-post escalates post-generation to high -> openai -> gpt-5.6-terra', async () => {
  const account = await firstAccount();
  const route = resolveRoute(account, 'post-generation', { escalateReasons: ['high-value-url-post'] });
  assert.equal(route.tier, 'high');
  assert.equal(route.provider, 'openai');
  assert.equal(route.model, TERRA);
  const resolved = resolveGenerationModel(account, { task: 'post-generation', escalateReasons: ['high-value-url-post'], budgetState: 'healthy' });
  assert.equal(resolved.model, TERRA);
});

test('E: critical escalation reasons route to critical -> openai -> gpt-5.6-sol', async () => {
  const account = await firstAccount();
  const weekly = resolveRoute(account, 'weekly-strategy', { escalateReasons: ['weekly-strategy-review'] });
  assert.equal(weekly.tier, 'critical');
  assert.equal(weekly.provider, 'openai');
  assert.equal(weekly.model, SOL);
  const launch = resolveRoute(account, 'post-generation', { escalateReasons: ['major-product-launch'] });
  assert.equal(launch.tier, 'critical');
  assert.equal(launch.provider, 'openai');
  assert.equal(launch.model, SOL);
});

test('F: conservative/critical budget state downgrades high and critical routes to balanced -> gpt-5.6-luna', async () => {
  const account = await firstAccount();
  const high = resolveRoute(account, 'post-generation', { escalateReasons: ['high-value-url-post'] });
  for (const state of ['conservative', 'critical']) {
    const downgraded = constrainRouteForBudget(high, state, account);
    assert.equal(downgraded.tier, 'balanced');
    assert.equal(downgraded.provider, 'openai');
    assert.equal(downgraded.model, LUNA, `${state} budget must downgrade to the balanced model`);
    assert.equal(downgraded.constrained, true);
  }
  const critical = resolveRoute(account, 'weekly-strategy', { escalateReasons: ['weekly-strategy-review'] });
  const downgradedCritical = constrainRouteForBudget(critical, 'conservative', account);
  assert.equal(downgradedCritical.tier, 'balanced');
  assert.equal(downgradedCritical.model, LUNA);
});

test('G: missing config falls back safely to gpt-5.6-luna, never to gpt-5.6-sol', async () => {
  const env = saveEnv('OPENAI_API_KEY', 'OPENAI_MODEL');
  process.env.OPENAI_API_KEY = 'test-openai-key';
  delete process.env.OPENAI_MODEL;
  const previousFetch = globalThis.fetch;
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  try {
    const bodies = [];
    globalThis.fetch = async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] }), { status: 200 });
    };
    await runOpenAiTask('acct', { budgets: { enabled: true, openaiCallsPerDay: 10 } }, 'research-triage', { system: 's', user: 'u' });
    assert.equal(bodies[0].model, LUNA, 'openai-task DEFAULT_MODEL must be gpt-5.6-luna when config is missing');
    const bare = resolveGenerationModel({ budgets: { enabled: false } }, { task: 'post-generation' });
    assert.equal(bare.model, LUNA, 'last-resort generation default must be gpt-5.6-luna, not gpt-5.6-sol');
    const synthetic = resolveGenerationModel({ generation: { model: LUNA } }, { task: 'post-generation' });
    assert.equal(synthetic.model, LUNA, 'synthetic accounts without a route fall back to generation.model (gpt-5.6-luna)');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
  }
});

test('Trend Brief web-search fallback uses gpt-5.6-luna via generation.model, not terra/sol', async () => {
  const env = saveEnv('OPENAI_API_KEY', 'OPENAI_MODEL');
  process.env.OPENAI_API_KEY = 'test-openai-key';
  delete process.env.OPENAI_MODEL;
  const previousFetch = globalThis.fetch;
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  try {
    const bodies = [];
    globalThis.fetch = async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items: [], summary: 'ok' }) }] }] }), { status: 200 });
    };
    const account = await firstAccount();
    const brief = await generateTrendBrief('acct', { ...account, budgets: { enabled: true, webSearchCallsPerDay: 10, openaiCallsPerDay: 10 } });
    assert.ok(brief);
    assert.equal(bodies[0].model, LUNA, 'generateTrendBrief must keep using the Luna-class generation model');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
  }
});
