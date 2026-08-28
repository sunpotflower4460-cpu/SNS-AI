import { consumeUsage } from '../ops/budget.mjs';
import { parseJsonText } from '../lib/openai.mjs';

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'llama-3.1-8b-instant';

function apiKey() {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    const error = new Error('Missing GROQ_API_KEY.');
    error.code = 'GROQ_KEY_MISSING';
    throw error;
  }
  return key;
}

// Groq is the account's default low-cost provider for triage-style tasks (summarize/classify/extract -
// see docs/LOW_COST_RESEARCH.md). It intentionally goes through the SAME budget guard
// (src/ops/budget.mjs consumeUsage) as every OpenAI call, under its own 'groq' kind/budgets.groqCallsPerDay
// limit, so an account can never spend an unbounded number of cheap-provider calls just because they are
// individually inexpensive.
export async function runGroqTask(accountId, account, task, { system, user, schema, model, maxOutputTokens } = {}) {
  apiKey(); // Fail before consuming budget if the key is simply absent - a missing key is not a spend.
  await consumeUsage(accountId, account, 'groq', { operation: `groq:${task}` });

  const body = {
    model: model || account?.ai?.groqModel || DEFAULT_MODEL,
    temperature: 0,
    max_tokens: Number(maxOutputTokens || 1200),
    messages: [
      { role: 'system', content: String(system || '') },
      { role: 'user', content: String(user || '') }
    ]
  };
  if (schema) body.response_format = { type: 'json_object' };

  const response = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(parsed?.error?.message || `Groq API failed with ${response.status}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  const text = parsed?.choices?.[0]?.message?.content || '';
  return schema ? { data: parseJsonText(text), raw: parsed } : { text, raw: parsed };
}

export const __test = { apiKey, DEFAULT_MODEL };
