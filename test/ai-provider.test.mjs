import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runAiTask, providerOrderFor } from '../src/ai/provider.mjs';

const USAGE_STATE = fileURLToPath(new URL('../data/usage-state.json', import.meta.url));
const USAGE_FILE = fileURLToPath(new URL('../data/usage.jsonl', import.meta.url));

function saveEnv(...names) { return Object.fromEntries(names.map((n) => [n, process.env[n]])); }
function restoreEnv(saved) { for (const [n, v] of Object.entries(saved)) v === undefined ? delete process.env[n] : process.env[n] = v; }
async function snap(path) { try { return { exists: true, bytes: await readFile(path) }; } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; } }
async function restoreFile(path, saved) { if (!saved.exists) return rm(path, { force: true }); await writeFile(path, saved.bytes); }

test('providerOrderFor resolves per-task override, then account-wide order, then the repository default', () => {
  assert.deepEqual(providerOrderFor({}, 'anything'), ['groq', 'openai']);
  assert.deepEqual(providerOrderFor({ ai: { providers: ['openai'] } }, 'anything'), ['openai']);
  assert.deepEqual(providerOrderFor({ ai: { providers: ['openai'], tasks: { triage: { providers: ['groq'] } } } }, 'triage'), ['groq']);
  assert.deepEqual(providerOrderFor({ ai: { providers: ['openai'], tasks: { triage: { providers: ['groq'] } } } }, 'other'), ['openai']);
  assert.deepEqual(providerOrderFor({ ai: { providers: ['bogus', 'openai'] } }, 'x'), ['openai'], 'unknown provider names are dropped, not fatal');
});

test('runAiTask uses the first configured provider and tags the result with which one ran', async () => {
  const env = saveEnv('GROQ_API_KEY');
  process.env.GROQ_API_KEY = 'test-groq-key';
  const previousFetch = globalThis.fetch;
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  try {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://api.groq.com/openai/v1/chat/completions');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [] }) } }] }), { status: 200 });
    };
    const account = { budgets: { enabled: true, groqCallsPerDay: 10 } };
    const result = await runAiTask('acct', account, 'research-triage', { system: 's', user: 'u', schema: { type: 'object' } });
    assert.equal(result.provider, 'groq');
    assert.deepEqual(result.data, { items: [] });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
  }
});

test('runAiTask falls forward to OpenAI when Groq has no API key configured', async () => {
  const env = saveEnv('GROQ_API_KEY', 'OPENAI_API_KEY');
  delete process.env.GROQ_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const previousFetch = globalThis.fetch;
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  try {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items: [] }) }] }] }), { status: 200 });
    };
    const account = { budgets: { enabled: true, openaiCallsPerDay: 10 } };
    const result = await runAiTask('acct', account, 'research-triage', { system: 's', user: 'u', schema: { type: 'object' } });
    assert.equal(result.provider, 'openai');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
  }
});

test('runAiTask falls forward to OpenAI when the Groq daily budget is exhausted, without exceeding the configured cap', async () => {
  const env = saveEnv('GROQ_API_KEY', 'OPENAI_API_KEY');
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const previousFetch = globalThis.fetch;
  const usageBefore = await snap(USAGE_STATE);
  const jsonlBefore = await snap(USAGE_FILE);
  try {
    let groqCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('groq.com')) { groqCalls += 1; return new Response('{}', { status: 200 }); }
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items: [] }) }] }] }), { status: 200 });
    };
    const account = { budgets: { enabled: true, groqCallsPerDay: 0, openaiCallsPerDay: 10 } };
    const result = await runAiTask('budget-acct', account, 'research-triage', { system: 's', user: 'u', schema: { type: 'object' } });
    assert.equal(result.provider, 'openai');
    assert.equal(groqCalls, 0, 'an exhausted budget must block the call before it is ever made, not just after');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFile(USAGE_STATE, usageBefore);
    await restoreFile(USAGE_FILE, jsonlBefore);
  }
});

test('runAiTask with allowFallback:false throws on the first provider failure instead of trying the next one', async () => {
  const env = saveEnv('GROQ_API_KEY', 'OPENAI_API_KEY');
  delete process.env.GROQ_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  try {
    const account = { ai: { allowFallback: false }, budgets: { enabled: true } };
    await assert.rejects(
      runAiTask('acct', account, 'research-triage', { system: 's', user: 'u', schema: { type: 'object' } }),
      /GROQ_API_KEY/
    );
  } finally { restoreEnv(env); }
});
