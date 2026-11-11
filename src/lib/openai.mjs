import { findNearDuplicate, safeDuplicateThreshold } from './duplicate.mjs';
import { platformTextLimit, validateDraftText, xWeightedLength } from './safety.mjs';
import { rankCandidates, shouldExplore } from './strategy-rank.mjs';
import { consumeUsage } from '../ops/budget.mjs';
import { resolveGenerationModel } from '../ai/router.mjs';

const OPENAI_BASE = 'https://api.openai.com/v1';
export const PROMPT_VERSION = 'sns-ai-2026-08-v3';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function apiKey() { const key = process.env.OPENAI_API_KEY; if (!key) throw new Error('Missing OPENAI_API_KEY for autonomous content generation.'); return key; }

export async function openaiRequest(path, body, meta = {}) {
  const retries = Number(meta.retries ?? 2);
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
    // Charge once per logical call, matching image/video generation. Retrying a 429/5xx/network
    // failure inside the loop used to re-consumeUsage and either block the one safe retry when a
    // single unit remained, or burn 2–3× budget for one generation under rate limit.
    await consumeUsage(budgetAccountId, meta.account, 'openai', { operation: meta.operation || path, dryRun: Boolean(meta.dryRun) });
    if (meta.webSearch) await consumeUsage(budgetAccountId, meta.account, 'webSearch', { operation: meta.operation || path, dryRun: Boolean(meta.dryRun) });
  }
  for (let attempt = 0; ; attempt += 1) {
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

export function outputText(response) {
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

// Truncation salvage, used only after the plain parse and the brace-slice above have both failed.
// Model output cut off mid-stream (token cap, dropped connection) ends inside a string or with
// containers still open, and the brace-slice makes it worse by assuming the top level is an object
// (a top-level array response is corrupted by slicing first '{' to last '}'). Walk the text once,
// tracking string/escape state and, per open container, whether a key, a colon, a value, or a
// separator is expected next. Every position where a value has DEFINITELY completed (closing quote
// of a value string, closing bracket, or a scalar ended by a delimiter - a trailing number/literal
// is never trusted, it may be half of a longer token) is recorded together with the closers the
// still-open containers would need. The longest such prefix, closed in reverse order, is the most
// that can be recovered without inventing data; downstream validation (schema-shaped candidate
// checks in generatePost) still decides whether the salvaged value is usable.
function salvageTruncatedJson(text) {
  const start = text.search(/[{[]/);
  if (start < 0) return undefined;
  const stack = []; // frames: { open: '{'|'[', state: 'key'|'colon'|'value'|'after' }
  let inString = false;
  let escaped = false;
  let cut = -1;
  let cutClosers = '';
  const top = () => stack[stack.length - 1];
  const noteCut = (end) => {
    cut = end;
    cutClosers = stack.map((frame) => (frame.open === '{' ? '}' : ']')).reverse().join('');
  };
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') {
        inString = false;
        const frame = top();
        if (!frame) return undefined;
        if (frame.open === '{' && frame.state === 'key') frame.state = 'colon';
        else { frame.state = 'after'; noteCut(i + 1); }
      }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push({ open: ch, state: ch === '{' ? 'key' : 'value' }); continue; }
    if (ch === '}' || ch === ']') {
      stack.pop();
      const frame = top();
      if (!frame) {
        // Root value is complete and only trailing junk follows; earlier attempts own most of
        // these, but a clean root prefix is still recoverable here.
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
      }
      frame.state = 'after';
      noteCut(i + 1);
      continue;
    }
    if (ch === ':') { const frame = top(); if (frame) frame.state = 'value'; continue; }
    if (ch === ',') { const frame = top(); if (frame) frame.state = frame.open === '{' ? 'key' : 'value'; continue; }
    if (/\s/.test(ch)) continue;
    // Scalar (number / true / false / null) run: it only counts as complete when a real delimiter
    // ends it; running into end-of-text means the token itself may be truncated, so drop it.
    let j = i;
    while (j < text.length && !/[\s,\]}{[":]/.test(text[j])) j += 1;
    if (j >= text.length) break;
    if (/[\s,\]}]/.test(text[j])) { const frame = top(); if (frame) { frame.state = 'after'; noteCut(j); } }
    i = j - 1;
  }
  if (cut < 0) return undefined;
  try { return JSON.parse(text.slice(start, cut) + cutClosers); } catch { return undefined; }
}

export function parseJsonText(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { /* fall through to the recovery attempts below */ }
  const s = cleaned.indexOf('{'); const e = cleaned.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(cleaned.slice(s, e + 1)); } catch { /* fall through to truncation salvage */ }
  }
  const salvaged = salvageTruncatedJson(cleaned);
  if (salvaged !== undefined) return salvaged;
  throw new Error('AI response was not valid JSON.');
}

// Parse failures from parseJsonText all surface as the 'AI response was not valid JSON.' error
// above; a raw SyntaxError is accepted too so any other JSON.parse in the response path counts.
function isJsonParseError(error) {
  return error instanceof SyntaxError || /not valid JSON/i.test(String(error?.message || ''));
}

const CANDIDATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidates'], properties: {
    candidates: { type: 'array', minItems: 1, maxItems: 8, items: {
      type: 'object', additionalProperties: false,
      required: ['text', 'mediaPrompt', 'rationale', 'spreadPotential', 'noveltyPotential', 'features', 'sourceUrl'],
      properties: {
        text: { type: 'string' }, mediaPrompt: { type: 'string' }, rationale: { type: 'string' },
        spreadPotential: { type: 'number', minimum: 0, maximum: 100 }, noveltyPotential: { type: 'number', minimum: 0, maximum: 100 },
        features: { type: 'object', additionalProperties: false,
          required: ['topic', 'angle', 'hook', 'emotion', 'format', 'cta', 'mediaDecision', 'trendUsed'],
          properties: { topic: { type: 'string' }, angle: { type: 'string' }, hook: { type: 'string' }, emotion: { type: 'string' }, format: { type: 'string' }, cta: { type: 'string' }, mediaDecision: { type: 'string', enum: ['none', 'library', 'search', 'generate'] }, trendUsed: { type: 'boolean' } }
        },
        // The official product page this candidate is about, copied from the candidate's own web
        // research - reported separately instead of embedded in the text so accounts that opt in
        // via linkPolicy.includeSourceUrl can attach it deterministically (see attachSourceUrl).
        // Null when the candidate is not about one specific product page or none was verified.
        sourceUrl: { type: ['string', 'null'] }
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
    // Why this order: a 400 here is usually the schema + web_search COMBINATION being rejected,
    // not the schema itself. The old fallback deleted body.text first, silently downgrading every
    // such call to free-form output - which smaller models then return as malformed JSON (the
    // 2026-11-11 dry-run failures). Retry without the tool but WITH the schema; only a second 400
    // earns the schema drop, as a last resort. The tool-less retries also stop charging web-search
    // budget for calls that no longer carry the tool.
    let activeMeta = meta;
    if (webSearch) {
      delete body.tools;
      activeMeta = { ...meta, webSearch: false };
      try { return await requestAndParse(body, activeMeta); }
      catch (retryError) {
        if (Number(retryError.status) !== 400) throw retryError;
      }
    }
    delete body.text;
    return requestAndParse(body, activeMeta);
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

// Accounts that opt in via linkPolicy.includeSourceUrl carry the researched product page URL on
// every post where it fits: the model reports the URL per candidate (sourceUrl, from its own web
// research) instead of embedding it in the text, and the URL is appended deterministically here -
// inside the candidate validation loop, so validateDraftText's weighted length check (a URL costs
// exactly 23 on X) always sees the final text and an over-limit body is discarded/regenerated by
// the existing attempts flow rather than silently overflowing. The append itself is best-effort:
// when the appended version would not validate (usually length), the candidate keeps its natural
// text and goes out without the URL - the post can still carry the product image via the media
// hunter (which reads the same URL as the draft's canonicalUrl), and squeezing a link in is never
// worth an awkward forced rewrite. A URL the model already embedded is never duplicated.
export function candidateSourceUrl(candidate) {
  const raw = typeof candidate?.sourceUrl === 'string' ? candidate.sourceUrl.trim() : '';
  if (!/^https:\/\/\S+$/i.test(raw)) return null;
  try { new URL(raw); } catch { return null; }
  return raw;
}

export function attachSourceUrl(account, candidate) {
  const text = String(candidate?.text || '');
  if (account?.linkPolicy?.includeSourceUrl !== true) return { text, sourceUrl: null };
  const url = candidateSourceUrl(candidate);
  if (!url) return { text, sourceUrl: null };
  if (text.includes(url)) return { text, sourceUrl: url };
  try {
    return { text: validateDraftText(account, `${text.trim()}\n${url}`), sourceUrl: url };
  } catch {
    return { text, sourceUrl: null };
  }
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
      account.linkPolicy?.includeSourceUrl === true
        ? 'For every candidate, set sourceUrl to the official product page URL (from your web research) that the candidate is about, or null when the candidate is not about one specific verified product page. Write text WITHOUT the URL - it is appended for you - and leave weighted room for it (the URL counts as 23 plus a line break), so keep the body comfortably under the limit.'
        : '',
      experiment ? `Controlled experiment: candidates should use features.${experiment.dimension} exactly as "${experiment.variant}" while keeping other choices natural.` : ''
    ].filter(Boolean).join('\n'),
    user: JSON.stringify({
      promptVersion: PROMPT_VERSION,
      accountId, platform: account.platform, profile: account.profile || {}, instructions: account.instructions || '', generation: account.generation || {},
      lengthBudget: lengthBudgetBrief(account),
      objectives: account.objectives || {}, recentPosts: recent, humanFeedback, learnedStrategy: context.strategy || null, trendBrief: context.trends || null,
      experiment,
      brand: account.brand ? { brandId: account.brand.brandId, strategy: account.brand.strategy, sharedResearchId: account.brand.sharedResearchId } : null,
      contentStrategy: account.contentStrategy || null,
      artistVoice: account.contentStrategy === 'artist-support' ? {
        confirmedPersonalMayUseExperience: true,
        tasteMatchMustNotClaimExperience: true,
        externalDiscoveryObjectiveOnly: true
      } : null,
      artistPlan: context.artistPlan ? {
        lane: context.artistPlan.lane || null,
        orbit: context.artistPlan.orbit || null,
        forbiddenParaphrases: context.artistPlan.forbiddenParaphrases || [],
        funnel: context.artistPlan.funnel ? {
          bottleneck: context.artistPlan.funnel.currentBottleneck,
          recommendedLane: context.artistPlan.funnel.recommendedLane,
          reason: context.artistPlan.funnel.reason
        } : null,
        why: context.artistPlan.why || []
      } : null,
      selectedRoute: context.route ? {
        tier: context.route.tier,
        provider: context.route.provider,
        model: context.route.model,
        escalationReason: context.route.escalationReason || context.route.reasons?.[0] || null
      } : null,
      candidateCount: Number(account.generation?.candidateCount ?? 5), retryFeedback: feedback || ''
    }, null, 2)
  };
}

// Model comes from the AI router route decided BEFORE this call (budget preflight → reservation →
// route → generation). A later silent fallback to a different default is forbidden when route.model
// is set. If the route has no model (synthetic test accounts without ai.openaiTriageModel), fall back
// to account.generation.model → OPENAI_MODEL → gpt-5 so existing mocks keep working.
export async function generatePost(accountId, account, history = [], context = {}) {
  const attempts = Number(account.generation?.maxAttempts ?? 3); const threshold = safeDuplicateThreshold(account.generation?.duplicateThreshold, 0.72);
  const resolved = resolveGenerationModel(account, context);
  const route = resolved.route;
  const model = resolved.model;
  const explore = shouldExplore(context.slotId || new Date().toISOString(), account.learning?.exploreRate ?? context.strategy?.exploreRate ?? 0.2);
  const experiment = context.experimentAssignment || null;
  const dryRun = Boolean(context.dryRun);
  const webSearch = Boolean(account.research?.webSearch) && context.allowWebSearch !== false;
  let feedback = '';
  let lastFallback = [];
  let lastParseError = null;
  let parseErrorAttempts = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const prompt = generationPrompt(accountId, account, history, { ...context, route }, feedback);
    let generated;
    try {
      generated = await responseJson({ model, system: prompt.system, user: prompt.user, webSearch, accountId, account, operation: 'post-generation', dryRun });
    } catch (error) {
      // A malformed-JSON response used to abort the whole slot on the spot, even though a fresh
      // generation usually parses (the 2026-11-11 dry-run failures were exactly this, twice in a
      // row). The attempts budget already exists for retries, so spend it - and tell the model
      // precisely what went wrong instead of re-rolling blind. Non-parse errors (budget, network,
      // provider) still abort immediately; they are not fixed by asking again.
      if (!isJsonParseError(error)) throw error;
      lastParseError = error;
      parseErrorAttempts += 1;
      feedback = 'Previous response was not valid JSON; return compact strict JSON only.';
      continue;
    }
    const valid = [];
    // Why the discard reasons are kept: when every candidate is rejected the retry prompt used to say only
    // "they were invalid or repetitive", so the model had no idea WHICH rule it broke and typically broke it
    // again on all remaining attempts. Telling it the actual validator message makes the retry informative
    // instead of a paid re-roll.
    const discardReasons = new Set();
    for (const candidate of generated.candidates || []) {
      try {
        candidate.text = validateDraftText(account, attachSourceUrl(account, candidate).text);
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
      // rankCandidates returns copies ({...candidate, predictedScore}), so the winner's source URL
      // is re-derived from what survives the copy: the candidate's own sourceUrl field, counted as
      // attached only when the final validated text really carries it (attachSourceUrl leaves the
      // URL in the text only when it appended successfully or the model had already embedded it).
      const candidateUrl = candidateSourceUrl(winner);
      const winnerSourceUrl = candidateUrl && winner.text.includes(candidateUrl) ? candidateUrl : null;
      return { text: winner.text, mediaPrompt: String(winner.mediaPrompt || ''), rationale: String(winner.rationale || ''),
        // The linkRequired/linkPurpose stamp is what lets the appended URL survive the downstream
        // link gates (editorial guards + link-gate) under the account's linkPolicy; canonicalUrl is
        // the media hunter's acquisition target for the product image. Both are set only when the
        // final text really carries the URL.
        features: winnerSourceUrl
          ? { ...(winner.features || {}), linkRequired: true, linkPurpose: 'product' }
          : (winner.features || {}),
        ...(winnerSourceUrl ? { sourceUrl: winnerSourceUrl, canonicalUrl: winnerSourceUrl } : {}),
        predictedScore: winner.predictedScore, selectionMode: explore ? 'explore' : 'exploit',
        sources: generated.citations || [], promptVersion: PROMPT_VERSION,
        experimentApplied: Boolean(experiment && String(winner.features?.[experiment.dimension] || '') === String(experiment.variant)),
        model, attempt, candidatesConsidered: ranked.length,
        route: {
          tier: route.tier,
          provider: route.provider,
          model,
          reasons: route.reasons || [],
          escalationReason: route.escalationReason || route.reasons?.[0] || null,
          constrained: Boolean(route.constrained),
          constraintReason: route.constraintReason || null
        }
      };
    }
    const rejections = [...discardReasons].slice(0, 3);
    feedback = [
      experiment
        ? `Generate original candidates that satisfy the controlled experiment exactly: features.${experiment.dimension} must equal "${experiment.variant}". Also avoid recent duplicates.`
        : 'All previous candidates were invalid, repetitive, or too similar to recent posts. Change the topic angle, hook, structure, and wording substantially.',
      rejections.length ? `Previous candidates were rejected for: ${rejections.join(' | ')}` : ''
    ].filter(Boolean).join(' ');
  }
  // When every attempt died on malformed JSON, surface that root cause rather than the generic
  // exhaustion message: the model never produced a single parseable response, which points at the
  // model/route, not at the candidate rules.
  if (lastParseError && parseErrorAttempts === attempts) throw lastParseError;
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

export const __test = { generationPrompt, lengthBudgetBrief, attachSourceUrl, candidateSourceUrl };
