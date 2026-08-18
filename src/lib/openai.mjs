import { findNearDuplicate } from './duplicate.mjs';
import { platformTextLimit, validateDraftText, xWeightedLength } from './safety.mjs';
import { rankCandidates, shouldExplore } from './strategy-rank.mjs';
import { consumeUsage } from '../ops/budget.mjs';

const OPENAI_BASE = 'https://api.openai.com/v1';
export const PROMPT_VERSION = 'sns-ai-2026-08-v3';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function apiKey() { const key = process.env.OPENAI_API_KEY; if (!key) throw new Error('Missing OPENAI_API_KEY for autonomous content generation.'); return key; }

export async function openaiRequest(path, body, meta = {}) {
  const retries = Number(meta.retries ?? 2);
  for (let attempt = 0; ; attempt += 1) {
    if (meta.accountId && meta.account) {
      // Deliberate design decision (see docs/GO_LIVE_CHECKLIST.md and PR history): dry-run previews
      // still call the real Responses API so an operator can actually see what would be posted before
      // enabling live mode - a preview that never shows real generated text has limited value, and
      // "exercises the full decision path" is an explicit test expectation (see
      // test/top-level-branches.test.mjs). Every OTHER side effect a real publish has is eliminated for
      // dry-run: no moderation call, no media generation, no approval issue, no state/history/circuit
      // mutation (see orchestrate.mjs and moderateText() below) - and the one unavoidable cost (the
      // preview generation call itself) is billed against a separate per-day counter so repeated
      // previews can never exhaust or interact with the account's live posting budget.
      // Defense in depth on top of validate-config.mjs's reserved-suffix check: account IDs are
      // free-form config keys used directly as budget-state object keys, so a real account literally
      // named "<x>::dry-run-preview" would otherwise collide with account <x>'s preview counter and
      // defeat the isolation this is meant to provide.
      if (String(meta.accountId).includes('::dry-run-preview')) {
        throw new Error(`Account id "${meta.accountId}" uses the reserved "::dry-run-preview" suffix; rename it in config/accounts.json.`);
      }
      const budgetAccountId = meta.dryRun ? `${meta.accountId}::dry-run-preview` : meta.accountId;
      await consumeUsage(budgetAccountId, meta.account, 'openai', { operation: meta.operation || path, attempt: attempt + 1, dryRun: Boolean(meta.dryRun) });
      if (meta.webSearch) await consumeUsage(budgetAccountId, meta.account, 'webSearch', { operation: meta.operation || path, attempt: attempt + 1, dryRun: Boolean(meta.dryRun) });
    }
    let response;
    try {
      response = await fetch(`${OPENAI_BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(Math.min(750 * (2 ** attempt), 8_000));
      continue;
    }
    const parsed = await response.json().catch(() => ({}));
    if (response.ok) return parsed;
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : Math.min(750 * (2 ** attempt), 8_000));
      continue;
    }
    const error = new Error(parsed?.error?.message || `OpenAI API failed with ${response.status}`); error.status = response.status; error.body = parsed; throw error;
  }
}

function outputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output || []) if (item.type === 'message') for (const content of item.content || []) if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
  return '';
}

function extractUrlCitations(response) {
  const found = new Map();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    const citation = value.type === 'url_citation' ? value : value.url_citation;
    const url = citation?.url || (value.type === 'url_citation' ? value.url : null);
    const title = citation?.title || (value.type === 'url_citation' ? value.title : null);
    if (typeof url === 'string' && /^https:\/\//i.test(url)) found.set(url, { url, title: typeof title === 'string' ? title : null });
    for (const child of Object.values(value)) visit(child);
  };
  visit(response?.output || []);
  return [...found.values()].slice(0, 30);
}

function parseJsonText(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { const s = cleaned.indexOf('{'); const e = cleaned.lastIndexOf('}'); if (s >= 0 && e > s) return JSON.parse(cleaned.slice(s, e + 1)); throw new Error('AI response was not valid JSON.'); }
}

const CANDIDATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidates'], properties: {
    candidates: { type: 'array', minItems: 1, maxItems: 8, items: {
      type: 'object', additionalProperties: false,
      required: ['text', 'mediaPrompt', 'rationale', 'spreadPotential', 'noveltyPotential', 'features'],
      properties: {
        text: { type: 'string' }, mediaPrompt: { type: 'string' }, rationale: { type: 'string' },
        spreadPotential: { type: 'number', minimum: 0, maximum: 100 }, noveltyPotential: { type: 'number', minimum: 0, maximum: 100 },
        features: { type: 'object', additionalProperties: false,
          required: ['topic', 'angle', 'hook', 'emotion', 'format', 'cta', 'mediaDecision', 'trendUsed'],
          properties: { topic: { type: 'string' }, angle: { type: 'string' }, hook: { type: 'string' }, emotion: { type: 'string' }, format: { type: 'string' }, cta: { type: 'string' }, mediaDecision: { type: 'string', enum: ['none', 'library', 'search', 'generate'] }, trendUsed: { type: 'boolean' } }
        }
      }
    }}
  }
};

async function requestAndParse(body, meta) {
  const response = await openaiRequest('/responses', body, meta);
  const parsed = parseJsonText(outputText(response));
  return { ...parsed, citations: extractUrlCitations(response) };
}

async function responseJson({ model, system, user, webSearch = false, schema = CANDIDATE_SCHEMA, name = 'social_output', accountId, account, operation, dryRun = false }) {
  const body = { model, store: false, max_output_tokens: Number(account?.generation?.maxOutputTokens ?? 3000), input: [
    { role: 'system', content: [{ type: 'input_text', text: system }] },
    { role: 'user', content: [{ type: 'input_text', text: user }] }
  ], text: { format: { type: 'json_schema', name, schema, strict: true } } };
  if (webSearch) body.tools = [{ type: 'web_search', search_context_size: 'medium' }];
  const meta = { accountId, account, webSearch, operation: operation || name, dryRun };
  try { return await requestAndParse(body, meta); }
  catch (error) {
    if (Number(error.status) !== 400) throw error;
    delete body.text;
    return requestAndParse(body, meta);
  }
}

export async function moderateText(text, account, accountId) {
  if (account.safety?.moderation === false) return { flagged: false };
  const response = await openaiRequest('/moderations', { model: account.safety?.moderationModel || 'omni-moderation-latest', input: text }, { accountId, account, operation: 'moderation', retries: 1 });
  const result = response.results?.[0];
  if (!result) throw new Error('Moderation returned no result.');
  if (result.flagged) {
    const flagged = Object.entries(result.categories || {}).filter(([, value]) => value).map(([key]) => key);
    throw new Error(`Moderation blocked generated post: ${flagged.join(', ') || 'flagged'}`);
  }
  return { flagged: false };
}

// X does not count characters the way a human (or a model) counts them: CJK and other full-width
// characters weigh 2, and every URL is counted as a fixed 23 no matter how long it really is. The prompt
// used to hand the model the raw `generation.maxChars` (280), so for a Japanese account the model aimed at
// 280 Japanese characters while validateDraftText rejected anything over ~140. Every candidate was then
// discarded, all `maxAttempts` burned real Responses calls, the slot failed, and the resilience circuit
// opened - for a purely cosmetic misunderstanding. The weights below are derived from xWeightedLength
// itself rather than restated, so the prompt can never drift from the validator that enforces it.
const CJK_PROBE_WEIGHT = xWeightedLength('あ');
const URL_PROBE_WEIGHT = xWeightedLength('https://example.com');

function lengthBudgetBrief(account) {
  const limit = platformTextLimit(account);
  if (account.platform !== 'x') return { unit: 'characters', limit };
  return {
    unit: 'X weighted characters',
    limit,
    rules: [
      `Japanese/Chinese/Korean and other full-width characters each count as ${CJK_PROBE_WEIGHT}.`,
      'Latin letters, digits, spaces and ASCII punctuation each count as 1.',
      `Every URL counts as exactly ${URL_PROBE_WEIGHT}, whatever its real length.`
    ],
    approximateFullWidthCharacterBudget: Math.floor(limit / CJK_PROBE_WEIGHT),
    note: 'A candidate over this budget is discarded before publishing. Stay inside it.'
  };
}

function generationPrompt(accountId, account, history, context, feedback) {
  const recent = history.slice(0, Number(account.generation?.historyWindow ?? 30)).map((entry) => ({ at: entry.at, text: entry.text, features: entry.features || null }));
  const humanFeedback = (context.humanFeedback || []).map((row) => ({
    at: row.at, action: row.action, note: row.note, dimension: row.dimension || null, value: row.value || null
  }));
  const experiment = context.experimentAssignment || null;
  return {
    system: [
      'You operate exactly one social-media account. Never leak identity, facts, voice, or goals from another account.',
      'Generate several genuinely different publishable candidates and estimate their spread potential conservatively.',
      'Use trend information only when relevant and factual. Never fabricate personal experience, results, affiliations, or product usage.',
      'Explicit account identity/instructions and active human feedback outrank learned strategy. Learned strategy is only probabilistic evidence.',
      'Human feedback is ordered newest first. If human feedback conflicts, follow the newest applicable instruction; pinned instructions remain persistent unless a newer instruction explicitly supersedes them.',
      'Never let performance optimization override explicit human feedback, account identity, safety rules, or factual accuracy.',
      'mediaDecision: none when text alone is best; library for existing account assets; search only for a licensed/trusted media service; generate for a new original visual.',
      'Avoid repeating recent posts in topic, hook, structure, and wording.',
      account.platform === 'x'
        ? `Length is measured in X weighted characters, not raw characters: full-width/CJK characters count as ${CJK_PROBE_WEIGHT} and every URL counts as ${URL_PROBE_WEIGHT}. Respect lengthBudget, not the raw character count.`
        : '',
      experiment ? `Controlled experiment: candidates should use features.${experiment.dimension} exactly as "${experiment.variant}" while keeping other choices natural.` : ''
    ].filter(Boolean).join('\n'),
    user: JSON.stringify({
      promptVersion: PROMPT_VERSION,
      accountId, platform: account.platform, profile: account.profile || {}, instructions: account.instructions || '', generation: account.generation || {},
      lengthBudget: lengthBudgetBrief(account),
      objectives: account.objectives || {}, recentPosts: recent, humanFeedback, learnedStrategy: context.strategy || null, trendBrief: context.trends || null,
      experiment,
      candidateCount: Number(account.generation?.candidateCount ?? 5), retryFeedback: feedback || ''
    }, null, 2)
  };
}

// Model precedence is account.generation.model -> OPENAI_MODEL -> 'gpt-5'. Note that
// config/accounts.json sets defaults.generation.model and loadConfig merges defaults into every
// account, so in practice the first branch always wins and the OPENAI_MODEL repository variable has no
// effect. To change the model, edit config (per account, or defaults.generation.model) - not the
// variable. The env fallback is kept for direct/local invocation against a config without that default.
export async function generatePost(accountId, account, history = [], context = {}) {
  const attempts = Number(account.generation?.maxAttempts ?? 3); const threshold = Number(account.generation?.duplicateThreshold ?? 0.72);
  const model = account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5'; const explore = shouldExplore(context.slotId || new Date().toISOString(), account.learning?.exploreRate ?? context.strategy?.exploreRate ?? 0.2);
  const experiment = context.experimentAssignment || null;
  const dryRun = Boolean(context.dryRun);
  let feedback = '';
  let lastFallback = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const prompt = generationPrompt(accountId, account, history, context, feedback);
    const generated = await responseJson({ model, system: prompt.system, user: prompt.user, webSearch: Boolean(account.research?.webSearch), accountId, account, operation: 'post-generation', dryRun });
    const valid = [];
    // Why the discard reasons are kept: when every candidate is rejected the retry prompt used to say only
    // "they were invalid or repetitive", so the model had no idea WHICH rule it broke and typically broke it
    // again on all remaining attempts. Telling it the actual validator message makes the retry informative
    // instead of a paid re-roll.
    const discardReasons = new Set();
    for (const candidate of generated.candidates || []) {
      try {
        candidate.text = validateDraftText(account, candidate.text);
        const duplicate = findNearDuplicate(candidate.text, history, threshold); if (duplicate) continue;
        valid.push(candidate);
      } catch (error) { discardReasons.add(String(error?.message || 'invalid candidate')); }
    }
    lastFallback = valid;
    const experimentMatched = experiment ? valid.filter((candidate) => String(candidate.features?.[experiment.dimension] || '') === String(experiment.variant)) : valid;
    const pool = experiment && experimentMatched.length ? experimentMatched : (!experiment || attempt === attempts ? valid : []);
    const ranked = rankCandidates(pool, context.strategy, { explore });
    if (ranked.length) {
      const winner = ranked[0]; if (!dryRun) await moderateText(winner.text, account, accountId);
      return { text: winner.text, mediaPrompt: String(winner.mediaPrompt || ''), rationale: String(winner.rationale || ''),
        features: winner.features || {}, predictedScore: winner.predictedScore, selectionMode: explore ? 'explore' : 'exploit',
        sources: generated.citations || [], promptVersion: PROMPT_VERSION,
        experimentApplied: Boolean(experiment && String(winner.features?.[experiment.dimension] || '') === String(experiment.variant)),
        model, attempt, candidatesConsidered: ranked.length };
    }
    const rejections = [...discardReasons].slice(0, 3);
    feedback = [
      experiment
        ? `Generate original candidates that satisfy the controlled experiment exactly: features.${experiment.dimension} must equal "${experiment.variant}". Also avoid recent duplicates.`
        : 'All previous candidates were invalid, repetitive, or too similar to recent posts. Change the topic angle, hook, structure, and wording substantially.',
      rejections.length ? `Previous candidates were rejected for: ${rejections.join(' | ')}` : ''
    ].filter(Boolean).join(' ');
  }
  if (lastFallback.length) throw new Error('Candidates existed but none could satisfy ranking/experiment constraints.');
  throw new Error(`Could not generate a sufficiently original post after ${attempts} attempts.`);
}

const TREND_SCHEMA = { type: 'object', additionalProperties: false, required: ['items', 'summary'], properties: {
  summary: { type: 'string' }, items: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false,
    required: ['topic', 'whyNow', 'angle', 'relevance', 'novelty', 'saturation', 'risk'], properties: {
      topic: { type: 'string' }, whyNow: { type: 'string' }, angle: { type: 'string' }, relevance: { type: 'number', minimum: 0, maximum: 100 },
      novelty: { type: 'number', minimum: 0, maximum: 100 }, saturation: { type: 'number', minimum: 0, maximum: 100 }, risk: { type: 'number', minimum: 0, maximum: 100 }
    } } }
} };
export async function generateTrendBrief(accountId, account) {
  const model = account.research?.model || account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5';
  return responseJson({ model, webSearch: true, schema: TREND_SCHEMA, name: 'trend_brief', accountId, account, operation: 'trend-intelligence',
    system: 'Research current public information for one social account. Prefer recent, credible sources. Return trends that are actually relevant; do not force a trend. Risk includes misinformation, sensitivity, legal, and brand risk.',
    user: JSON.stringify({ promptVersion: PROMPT_VERSION, accountId, platform: account.platform, profile: account.profile || {}, instructions: account.instructions || '', topics: account.profile?.topics || [] }, null, 2) });
}

export const __test = { generationPrompt, lengthBudgetBrief };
