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

export function parseJsonText(text) {
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
          required: ['topic', 'angle', 'hook', 'emotion', 'format', 'cta', 'mediaDecision', 'trendUsed', 'trendEvidenceIndex'],
          properties: {
            topic: { type: 'string' }, angle: { type: 'string' }, hook: { type: 'string' }, emotion: { type: 'string' }, format: { type: 'string' }, cta: { type: 'string' }, mediaDecision: { type: 'string', enum: ['none', 'library', 'search', 'generate'] }, trendUsed: { type: 'boolean' },
            // Nullable rather than omittable: OpenAI's strict json_schema mode requires every property to
            // be listed in `required`, so "no trend item was used" is expressed as trendEvidenceIndex:null,
            // not by leaving the field out. Points at the evidenceIndex trendBrief.items were annotated
            // with in generationPrompt() below - a stable position reference, never a product name/id, so
            // this mechanism works identically for any account and any product.
            trendEvidenceIndex: { type: ['integer', 'null'], minimum: 0 }
          }
        }
      }
    }}
  }
};

function responseUsageMetadata(response) {
  const usage = response?.usage || {};
  const outputTokens = Number(usage.output_tokens);
  const reasoningTokens = Number(usage.output_tokens_details?.reasoning_tokens);
  return {
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
    reasoningTokens: Number.isFinite(reasoningTokens) ? reasoningTokens : null
  };
}

// The Responses API's own top-level `status` is ground truth for whether output_text is even meant to be
// complete JSON - checked BEFORE ever calling JSON.parse on it. Fixes the real production failure
// ("Expected ',' or ']' after array element in JSON at position 2659...") where a cut-off/failed response
// was fed straight into JSON.parse and surfaced as an opaque, untyped SyntaxError instead of a
// diagnosable provider error. A missing/unrecognized status (every existing mocked test response, which
// predates this check and never sets one) falls through unchanged to the parse path below - this can only
// ever catch MORE failures than before, never reject a response that used to parse successfully.
function assertResponseComplete(response, body) {
  if (response?.status === 'incomplete') {
    const usage = responseUsageMetadata(response);
    const reason = response.incomplete_details?.reason || null;
    const error = new Error(`OpenAI response was incomplete${reason ? ` (${reason})` : ''}.`);
    error.code = 'OPENAI_RESPONSE_INCOMPLETE';
    error.responseStatus = 'incomplete';
    error.incompleteReason = reason;
    error.requestedMaxOutputTokens = Number.isFinite(body?.max_output_tokens) ? body.max_output_tokens : null;
    error.outputTokens = usage.outputTokens;
    error.reasoningTokens = usage.reasoningTokens;
    throw error;
  }
  if (response?.status === 'failed') {
    const error = new Error(response.error?.message || 'OpenAI response failed.');
    error.code = 'OPENAI_RESPONSE_FAILED';
    error.responseStatus = 'failed';
    error.providerErrorCode = response.error?.code || null;
    throw error;
  }
}

async function requestAndParse(body, meta) {
  const response = await openaiRequest('/responses', body, meta);
  assertResponseComplete(response, body);
  let parsed;
  try {
    parsed = parseJsonText(outputText(response));
  } catch {
    // JSON.parse succeeding is not guaranteed just because status was "completed" - never let the raw
    // SyntaxError (which carries no actionable metadata) escape as-is. structuredMode records what format
    // was actually requested for THIS call, so a fallback retry (see responseJson below) reports its own
    // mode correctly rather than always claiming "json_schema".
    const error = new Error('OpenAI structured output was not valid JSON.');
    error.code = 'OPENAI_STRUCTURED_OUTPUT_INVALID';
    error.responseStatus = response?.status || null;
    error.structuredMode = body?.text?.format?.type || 'text';
    throw error;
  }
  return { ...parsed, citations: extractUrlCitations(response) };
}

// A 400 does not, by itself, mean "this model/endpoint cannot do Structured Outputs" - it can just as
// easily mean a bad prompt, an invalid model id, or a moderation-adjacent rejection, none of which get
// fixed by dropping the schema. Only fall back when the error specifically names the structured-output
// request shape (text.format/response_format) as the problem.
function unsupportedStructuredOutputError(error) {
  const param = error?.body?.error?.param;
  if (param === 'text.format' || param === 'response_format') return true;
  const message = String(error?.body?.error?.message || error?.message || '');
  return /\b(response_format|json_schema|structured output)\b/i.test(message) && /not support|unsupported|invalid/i.test(message);
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
    // Plugin Radar's entity<->evidence binding (features.trendEvidenceIndex - see generatePost() below)
    // depends on the model actually returning the schema-enforced shape; silently dropping the schema for
    // this account would defeat that safety net entirely, so it always fails closed on any 400 instead of
    // guessing at an unstructured fallback.
    if (account?.contentStrategy === 'plugin-radar') throw error;
    if (!unsupportedStructuredOutputError(error)) throw error;
    // Keep at least JSON validity even without the full schema (json_object mode still guarantees
    // parseable JSON) rather than dropping to fully unstructured free-text output.
    body.text = { format: { type: 'json_object' } };
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

// Plugin Radar (music-tools-x, contentStrategy: "plugin-radar") specific factual/category precision
// rules. This is a GENERAL rule for the whole account's content, never a patch for one product: it must
// never reference a specific product name (e.g. "SKR4CH") or ban a specific word (e.g. "音源") outright -
// see the real production case this guards against in docs/PLUGIN_RADAR_QUALITY_GATE.md, where "音源その
// ものを増やしたいなら" overstated a browser waveform/wavetable/sample DESIGN tool as if it added a new
// instrument/sound source itself. No extra OpenAI call is added for this (the repository's $3/month hard
// limit stays intact) - this only strengthens grounding inside the existing single generation call.
const PLUGIN_RADAR_CATEGORY_PRECISION_RULES = [
  'Product/entity type is a factual claim, not a marketing choice: preserve the type/function actually supported by the sources.',
  'A browser/web tool must not be called a VST/plugin/instrument unless the sources say so.',
  'A waveform, wavetable, preset, or sample material must not be described as a new instrument/sound source itself.',
  'A utility/editor/designer must not be promoted into a synth/effect/plugin category without evidence.',
  'If the exact category is uncertain, use a neutral term such as "ツール" instead of guessing.',
  'Distinguish tool / plugin / instrument / synth / effect / sample / waveform / wavetable / preset / service / web app - keep this distinction in Japanese output too.',
  'Do not convert "creates material for an existing synth" into "adds a new synth/sound source".',
  'Never change or blur the product category to make it sound more exciting.',
  'Prefer narrower, source-supported wording over a more exciting unsupported claim.',
  // Guards the second real production case: a generated post added "DAW内で完結したい人には対象外" (not
  // for people who want to stay inside their DAW) about OXO Steps - an inferred limitation the bound
  // source never actually stated. Compatibility/limitation claims are exactly as factual as the category
  // claims above, so they get the same "only if the evidence says so, otherwise omit" rule.
  'Compatibility, limitation, and "not for X" claims (not compatible, unsupported, cannot, only works with X, requires X, not for people who want Y) are factual claims: state one only when the selected/bound evidence explicitly confirms it, never as an inferred conclusion.',
  'Do not infer an unstated limitation from a positive fact (evidence saying a product supports macOS does not, by itself, support a claim that it lacks Windows support) unless the evidence explicitly states the limitation.',
  'When the evidence does not explicitly support a negative/limitation claim, omit that claim rather than guessing.'
];

// One deliberately bounded, non-exaggerating instruction for the low-predictedScore retry in
// generatePost() below. Explicitly forbids every way a model could "cheat" the score up instead of
// actually writing something better - see the quality floor comment on generatePost() for why this
// exists and why it must never ask for more excitement/urgency instead of more substance.
function lowScoreRetryFeedback(topScore, requiredScore) {
  return [
    `The best candidate scored ${topScore}, below the required minimum of ${requiredScore}.`,
    'Regenerate with genuinely stronger substance: a sharper and more specific angle, a clearer answer to why this matters to this reader now, and more concrete, source-grounded detail.',
    'Do NOT raise the score through exaggeration, clickbait, false urgency, fabricated benefits, fabricated personal experience, or unsupported comparisons - only real substance counts.'
  ].join(' ');
}

// Feedback for the two recoverable response-reliability errors from responseJson() (see
// assertResponseComplete/requestAndParse above): the provider either cut the response off before it
// finished (OPENAI_RESPONSE_INCOMPLETE) or returned "completed" output that was not valid JSON
// (OPENAI_STRUCTURED_OUTPUT_INVALID). Both are told to the model as a request to comply with the schema
// and keep the output compact - never as an instruction to write worse/shorter *content*, and never
// implying the token budget has changed (generatePost() does not alter maxOutputTokens based on this).
function recoverableResponseFeedback(error) {
  if (error.code === 'OPENAI_RESPONSE_INCOMPLETE') {
    return [
      'The previous response was cut off before it finished and could not be used.',
      'Keep candidates concise and return strictly valid, complete JSON matching the schema - do not pad rationale or mediaPrompt fields.'
    ].join(' ');
  }
  return [
    'The previous response completed but was not valid JSON and could not be used.',
    'Return strictly valid JSON that exactly matches the requested schema, with no trailing or malformed elements.'
  ].join(' ');
}

// Entity <-> evidence binding. Fixes the real production case where a music-tools-x candidate selected
// "OXO Steps" as its topic but payload.sources only carried OTHER products' trend URLs (SKR4CH, FRCTL
// Audio GRN, KVEIK) - the winning candidate and its "evidence" were for different entities. trendIndex is
// a stable ARRAY POSITION reference into trendBrief.items, never a product name/id, so this mechanism is
// entirely general and works identically for any product.
function trendEvidenceItems(trends) {
  return Array.isArray(trends?.items) ? trends.items : [];
}

// Annotates each trend item with the evidenceIndex the model is asked to reference back - done once, on
// the copy actually sent to the model, so the index the model returns always lines up with what
// resolveTrendEvidence() below re-derives from the SAME context.trends the candidate was generated from.
function trendBriefForPrompt(trends) {
  if (!trends) return null;
  const items = trendEvidenceItems(trends).map((item, index) => ({ ...item, evidenceIndex: index }));
  return { ...trends, items };
}

// Resolves features.trendEvidenceIndex back to the real trend item it names, or null if the index is
// missing, out of range, malformed, or points at an item with no usable (https) URL. This is the single
// source of truth both the Plugin Radar validation below and the source-binding on the winning candidate
// use, so they can never disagree about what counts as "a valid reference."
function resolveTrendEvidence(candidate, trends) {
  const items = trendEvidenceItems(trends);
  const index = candidate?.features?.trendEvidenceIndex;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= items.length) return null;
  const item = items[index];
  if (!item || typeof item.url !== 'string' || !/^https:\/\//i.test(item.url)) return null;
  return { index, url: item.url, title: item.topic || null };
}

// Plugin Radar only (contentStrategy: "plugin-radar"): a candidate that claims to have used a trend
// (features.trendUsed: true) but cannot be bound to a real, URL-bearing trend item is rejected here -
// through the SAME per-candidate validation path text/duplicate checks already use (see the try/catch
// around this call in generatePost()), so a mismatch costs no extra API call and is bounded by the
// existing `attempts` retry loop exactly like any other invalid candidate, never an unbounded retry.
function assertPluginRadarTrendEvidence(candidate, trends) {
  if (candidate?.features?.trendUsed !== true) return;
  if (!resolveTrendEvidence(candidate, trends)) {
    throw new Error('trendUsed candidate did not reference a valid trend evidence item (features.trendEvidenceIndex must point at a real trendBrief.items entry with a URL).');
  }
}

function dedupeSources(sources) {
  const seen = new Set();
  const result = [];
  for (const source of sources || []) {
    if (!source?.url || seen.has(source.url)) continue;
    seen.add(source.url);
    result.push(source);
  }
  return result;
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
      experiment ? `Controlled experiment: candidates should use features.${experiment.dimension} exactly as "${experiment.variant}" while keeping other choices natural.` : '',
      context.trends
        ? 'trendBrief.items each carry an evidenceIndex. When features.trendUsed is true, set features.trendEvidenceIndex to the evidenceIndex of the ONE specific trend item you actually used as your primary factual basis for this candidate - not a different item, and not an item about a different product. Set it to null when trendUsed is false or no single trend item was the basis.'
        : '',
      account.contentStrategy === 'plugin-radar' ? PLUGIN_RADAR_CATEGORY_PRECISION_RULES.join('\n') : ''
    ].filter(Boolean).join('\n'),
    user: JSON.stringify({
      promptVersion: PROMPT_VERSION,
      accountId, platform: account.platform, profile: account.profile || {}, instructions: account.instructions || '', generation: account.generation || {},
      lengthBudget: lengthBudgetBrief(account),
      objectives: account.objectives || {}, recentPosts: recent, humanFeedback, learnedStrategy: context.strategy || null, trendBrief: trendBriefForPrompt(context.trends),
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
// to account.generation.model → OPENAI_MODEL → gpt-5.6-luna so existing mocks keep working.
export async function generatePost(accountId, account, history = [], context = {}) {
  const attempts = Number(account.generation?.maxAttempts ?? 3); const threshold = safeDuplicateThreshold(account.generation?.duplicateThreshold, 0.72);
  // Publish-quality floor (opt-in, per-account - see docs/PLUGIN_RADAR_QUALITY_GATE.md): predictedScore
  // is a RANKING score (spreadPotential/noveltyPotential/learned score - src/lib/strategy-rank.mjs), not
  // a factual-accuracy score, so this floor only stops "ranked[0] anyway" from publishing a candidate
  // that is weak by every account signal, not a fact-checker. minPredictedScore defaults to 0, which
  // makes belowQualityFloor below always false - a complete no-op for every account that has not opted
  // in. lowScoreRetryCount bounds how many of the EXISTING `attempts` iterations may be spent specifically
  // on a quality-floor miss; it can only ever consume attempts generatePost already had budgeted, never
  // add a call beyond `attempts`.
  const minScore = Number(account.generation?.minPredictedScore ?? 0);
  const lowScoreRetryLimit = Math.max(0, Number(account.generation?.lowScoreRetryCount ?? 0));
  const resolved = resolveGenerationModel(account, context);
  const route = resolved.route;
  const model = resolved.model;
  const explore = shouldExplore(context.slotId || new Date().toISOString(), account.learning?.exploreRate ?? context.strategy?.exploreRate ?? 0.2);
  const experiment = context.experimentAssignment || null;
  const dryRun = Boolean(context.dryRun);
  const webSearch = Boolean(account.research?.webSearch) && context.allowWebSearch !== false;
  let feedback = '';
  let lastFallback = [];
  let qualityRetriesUsed = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const prompt = generationPrompt(accountId, account, history, { ...context, route }, feedback);
    let generated;
    try {
      generated = await responseJson({ model, system: prompt.system, user: prompt.user, webSearch, accountId, account, operation: 'post-generation', dryRun });
    } catch (error) {
      // OPENAI_RESPONSE_INCOMPLETE and OPENAI_STRUCTURED_OUTPUT_INVALID mean the provider failed to hand
      // back usable structured output on this attempt, not that the provider is down (that's
      // OPENAI_RESPONSE_FAILED, and everything else) - so, exactly like the quality-floor retry below, a
      // retry may only consume an iteration this loop already had budgeted by `attempts`, never schedule a
      // call beyond it. Any other error, or running out of attempts, propagates immediately.
      if ((error.code === 'OPENAI_RESPONSE_INCOMPLETE' || error.code === 'OPENAI_STRUCTURED_OUTPUT_INVALID') && attempt < attempts) {
        feedback = recoverableResponseFeedback(error);
        continue;
      }
      throw error;
    }
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
        if (account.contentStrategy === 'plugin-radar') assertPluginRadarTrendEvidence(candidate, context.trends);
        valid.push(candidate);
      } catch (error) { discardReasons.add(String(error?.message || 'invalid candidate')); }
    }
    lastFallback = valid;
    const experimentMatched = experiment ? valid.filter((candidate) => String(candidate.features?.[experiment.dimension] || '') === String(experiment.variant)) : valid;
    const pool = experiment && experimentMatched.length ? experimentMatched : (!experiment || attempt === attempts ? valid : []);
    const ranked = rankCandidates(pool, context.strategy, { explore });
    if (ranked.length) {
      const winner = ranked[0];
      const belowQualityFloor = Number(winner.predictedScore) < minScore;
      if (belowQualityFloor && qualityRetriesUsed < lowScoreRetryLimit && attempt < attempts) {
        // Exactly one (or account.generation.lowScoreRetryCount) extra chance, spent from the SAME
        // attempts budget the loop already has - not an additional API call beyond `attempts`.
        qualityRetriesUsed += 1;
        feedback = lowScoreRetryFeedback(winner.predictedScore, minScore);
        continue;
      }
      if (belowQualityFloor) {
        // Retry budget (or remaining attempts) is exhausted and the best candidate is still below the
        // floor: this is an intentional editorial "No Post" for this slot, not a system failure - it must
        // never be treated as a provider outage/circuit failure (see orchestrate.mjs's nonCircuitCodes).
        const error = new Error(`Best candidate scored ${winner.predictedScore}, below the required minimum of ${minScore}.`);
        error.code = 'CONTENT_QUALITY_BELOW_THRESHOLD';
        error.predictedScore = winner.predictedScore;
        error.requiredScore = minScore;
        error.qualityRetriesUsed = qualityRetriesUsed;
        error.selectionMode = explore ? 'explore' : 'exploit';
        error.selectedModel = model;
        throw error;
      }
      if (!dryRun) await moderateText(winner.text, account, accountId);
      // Bound trend evidence (Plugin Radar only, since assertPluginRadarTrendEvidence above already
      // guarantees any trendUsed:true winner has one) is the entity the candidate is actually about.
      // generated.citations are NOT merged in for Plugin Radar: they are only known to be relevant to
      // this account's topics in general, never independently verified to correspond to the specific
      // selected candidate's entity - the real production bug (SNS Autopilot #338): a "FRCTL Audio GRN"
      // candidate shipped with its correct bound evidence PLUS an unrelated Web Search citation for a
      // completely different product ("Polarity Glue"). Task 4 originally kept unrelated citations as
      // "supplements" (see git history), which is exactly the provenance-contamination bug #338
      // reproduced - so Plugin Radar's sources are now restricted to ONLY the bound evidence (0 or 1
      // entries). If a verified citation source is ever added here, it must be independently checked
      // against the winning candidate's specific entity first; an unverifiable citation must never be
      // included. Non-Plugin-Radar accounts are unaffected: boundEvidence is always null for them, so
      // mergedSources is exactly generated.citations, deduped, same as before.
      const boundEvidence = account.contentStrategy === 'plugin-radar' ? resolveTrendEvidence(winner, context.trends) : null;
      const mergedSources = account.contentStrategy === 'plugin-radar'
        ? dedupeSources(boundEvidence ? [{ url: boundEvidence.url, title: boundEvidence.title }] : [])
        : dedupeSources(generated.citations || []);
      return { text: winner.text, mediaPrompt: String(winner.mediaPrompt || ''), rationale: String(winner.rationale || ''),
        features: { ...(winner.features || {}), trendEvidenceUrl: boundEvidence?.url || null },
        predictedScore: winner.predictedScore, selectionMode: explore ? 'explore' : 'exploit',
        sources: mergedSources, promptVersion: PROMPT_VERSION,
        experimentApplied: Boolean(experiment && String(winner.features?.[experiment.dimension] || '') === String(experiment.variant)),
        model, attempt, candidatesConsidered: ranked.length, qualityRetriesUsed,
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
  const model = account.research?.model || account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5.6-luna';
  return responseJson({ model, webSearch: true, schema: TREND_SCHEMA, name: 'trend_brief', accountId, account, operation: 'trend-intelligence',
    system: 'Research current public information for one social account. Prefer recent, credible sources. Return trends that are actually relevant; do not force a trend. Risk includes misinformation, sensitivity, legal, and brand risk.',
    user: JSON.stringify({ promptVersion: PROMPT_VERSION, accountId, platform: account.platform, profile: account.profile || {}, instructions: account.instructions || '', topics: account.profile?.topics || [] }, null, 2) });
}

export const __test = {
  generationPrompt, lengthBudgetBrief, lowScoreRetryFeedback, PLUGIN_RADAR_CATEGORY_PRECISION_RULES,
  trendBriefForPrompt, resolveTrendEvidence, assertPluginRadarTrendEvidence, dedupeSources,
  assertResponseComplete, unsupportedStructuredOutputError, responseUsageMetadata, recoverableResponseFeedback
};
