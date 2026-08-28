import { runGroqTask } from './groq.mjs';
import { runOpenAiTask } from './openai-task.mjs';

const PROVIDERS = { groq: runGroqTask, openai: runOpenAiTask };
const DEFAULT_ORDER = ['groq', 'openai'];

// Which providers to try, and in what order, for a given account/task. Per-task overrides
// (account.ai.tasks.<task>.providers) win over the account-wide order (account.ai.providers), which
// wins over the repository default (Groq first, OpenAI as the quality/availability fallback). Unknown
// provider names are dropped rather than thrown on, so a config typo degrades to "use the rest of the
// list" instead of hard-failing every AI task.
export function providerOrderFor(account, task) {
  const config = account?.ai || {};
  const perTask = config.tasks?.[task]?.providers;
  const accountWide = config.providers;
  const order = Array.isArray(perTask) && perTask.length
    ? perTask
    : (Array.isArray(accountWide) && accountWide.length ? accountWide : DEFAULT_ORDER);
  return order.filter((name) => PROVIDERS[name]);
}

// Runs one AI task (e.g. "research-triage") through the account's configured provider order, falling
// forward to the next provider only on failure - a missing GROQ_API_KEY, an exhausted 'groq' daily
// budget, or a transient Groq outage all fall through to OpenAI (or whatever is configured next) rather
// than failing the whole research pipeline. account.ai.allowFallback === false disables that behavior
// for callers that need a specific provider or nothing (e.g. to deliberately measure Groq alone), and
// each provider still enforces its own budget independently - falling forward can never bypass a
// configured cap, only move the spend to a different, still-budgeted provider.
export async function runAiTask(accountId, account, task, params = {}) {
  const order = providerOrderFor(account, task);
  if (!order.length) throw new Error(`No AI provider configured for task "${task}".`);
  let lastError;
  for (const name of order) {
    try {
      const result = await PROVIDERS[name](accountId, account, task, params);
      return { ...result, provider: name };
    } catch (error) {
      lastError = error;
      if (account?.ai?.allowFallback === false) throw error;
    }
  }
  throw lastError || new Error(`AI task "${task}" failed on all configured providers.`);
}

export const __test = { PROVIDERS, DEFAULT_ORDER };
