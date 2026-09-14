import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { resolveRoute } from '../src/ai/router.mjs';
import { runGroqTask } from '../src/ai/groq.mjs';
import { runAiTask } from '../src/ai/provider.mjs';
import { loadAccounts } from '../src/lib/config.mjs';

const GROQ_MODEL = 'openai/gpt-oss-120b';
const USAGE_STATE = fileURLToPath(new URL('../data/usage-state.json', import.meta.url));
const USAGE_FILE = fileURLToPath(new URL('../data/usage.jsonl', import.meta.url));

function saveEnv(...names) { return Object.fromEntries(names.map((n) => [n, process.env[n]])); }
function restoreEnv(saved) { for (const [n, v] of Object.entries(saved)) v === undefined ? delete process.env[n] : process.env[n] = v; }
async function snap(path) { try { return { exists: true, bytes: await readFile(path) }; } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; } }
async function restoreFile(path, saved) { if (!saved.exists) return rm(path, { force: true }); await writeFile(path, saved.bytes); }

test('cheap tier resolves to Groq with openai/gpt-oss-120b on every production account', async () => {
  const accounts = await loadAccounts();
  const ids = Object.keys(accounts);
  assert.ok(ids.length > 0, 'config/accounts.json must define accounts');
  for (const [id, account] of Object.entries(accounts)) {
    assert.equal(account.ai?.groqModel, GROQ_MODEL, `${id}: defaults.ai.groqModel must be ${GROQ_MODEL}`);
    const route = resolveRoute(account, 'research-triage');
    assert.equal(route.tier, 'cheap');
    assert.equal(route.provider, 'groq');
    assert.equal(route.model, GROQ_MODEL, `${id}: cheap tier must resolve to the configured Groq model`);
  }
});

test('runGroqTask sends the gpt-oss-120b model id to the Groq API on both resolution paths', async () => {
  const env = saveEnv('GROQ_API_KEY');
  process.env.GROQ_API_KEY = 'test-groq-key';
  const previousFetch = globalThis.fetch;
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  const bodies = [];
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://api.groq.com/openai/v1/chat/completions');
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    };
    const accounts = await loadAccounts();
    const account = Object.values(accounts)[0];
    await runGroqTask('acct', account, 'research-triage', { system: 's', user: 'u' });
    assert.equal(bodies[0].model, GROQ_MODEL, 'merged account ai.groqModel must reach the Groq request body');
    await runGroqTask('acct', { budgets: { enabled: true, groqCallsPerDay: 10 } }, 'research-triage', { system: 's', user: 'u' });
    assert.equal(bodies[1].model, GROQ_MODEL, 'repository DEFAULT_MODEL must be gpt-oss-120b when config is absent');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
  }
});

test('Groq API failure still falls forward to OpenAI with gpt-oss-120b configured', async () => {
  const env = saveEnv('GROQ_API_KEY', 'OPENAI_API_KEY');
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const previousFetch = globalThis.fetch;
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  try {
    let openAiCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('groq.com')) return new Response(JSON.stringify({ error: { message: 'upstream model error' } }), { status: 400 });
      openAiCalls += 1;
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] }), { status: 200 });
    };
    const accounts = await loadAccounts();
    const account = Object.values(accounts)[0];
    const result = await runAiTask('acct', { ...account, budgets: { enabled: true, groqCallsPerDay: 10, openaiCallsPerDay: 10 } }, 'research-triage', { system: 's', user: 'u', schema: { type: 'object' } });
    assert.equal(result.provider, 'openai', 'Groq API failure must fall forward to OpenAI');
    assert.equal(openAiCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
  }
});
