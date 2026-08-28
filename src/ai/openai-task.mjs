import { openaiRequest, outputText, parseJsonText } from '../lib/openai.mjs';

const DEFAULT_MODEL = 'gpt-5-mini';

// The OpenAI-side implementation of the same cheap-task interface Groq implements
// (src/ai/groq.mjs) - a smaller/cheaper OpenAI model for triage-style work, reusing the existing
// openaiRequest transport so budget consumption, retries and error shape stay identical to every other
// OpenAI call in this repository (see src/lib/openai.mjs). This is deliberately NOT a new OpenAI client;
// it is a thin, purpose-specific wrapper around the one that already exists.
export async function runOpenAiTask(accountId, account, task, { system, user, schema, model, maxOutputTokens } = {}) {
  const body = {
    model: model || account?.ai?.openaiTriageModel || DEFAULT_MODEL,
    store: false,
    max_output_tokens: Number(maxOutputTokens || 1200),
    input: [
      { role: 'system', content: [{ type: 'input_text', text: String(system || '') }] },
      { role: 'user', content: [{ type: 'input_text', text: String(user || '') }] }
    ]
  };
  if (schema) body.text = { format: { type: 'json_schema', name: 'ai_task', schema, strict: true } };

  const response = await openaiRequest('/responses', body, { accountId, account, operation: `openai-task:${task}` });
  const text = outputText(response);
  return schema ? { data: parseJsonText(text) } : { text };
}

export const __test = { DEFAULT_MODEL };
