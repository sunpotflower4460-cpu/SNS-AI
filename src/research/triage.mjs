import { runAiTask } from '../ai/provider.mjs';
import { loadResearchCache, saveResearchCache, markEvaluated } from './cache.mjs';

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'topic', 'whyNow', 'angle', 'relevance', 'novelty', 'usefulness', 'priceValue', 'newsworthiness', 'japanNovelty', 'audienceFit', 'confidence', 'risk'],
        properties: {
          index: { type: 'number' },
          topic: { type: 'string' },
          whyNow: { type: 'string' },
          angle: { type: 'string' },
          relevance: { type: 'number', minimum: 0, maximum: 100 },
          novelty: { type: 'number', minimum: 0, maximum: 100 },
          usefulness: { type: 'number', minimum: 0, maximum: 100 },
          priceValue: { type: 'number', minimum: 0, maximum: 100 },
          newsworthiness: { type: 'number', minimum: 0, maximum: 100 },
          japanNovelty: { type: 'number', minimum: 0, maximum: 100 },
          audienceFit: { type: 'number', minimum: 0, maximum: 100 },
          confidence: { type: 'number', minimum: 0, maximum: 100 },
          risk: { type: 'number', minimum: 0, maximum: 100 }
        }
      }
    }
  }
};

// A fixed 1200-token output budget for every triage request - regardless of how many candidates were
// asked about - is what actually caused the JSON parse error observed in production ("Expected ',' or
// ']' after array element ... position 2538"): a realistic full response for a double-digit candidate
// batch (each item carries topic/whyNow/angle strings plus nine 0-100 scores) measures well over 1200
// tokens, so the model's output was cut off mid-object and never formed valid JSON. Scaling the budget
// with candidate count fixes the truncation at its source instead of guessing at retries. The floor
// keeps small batches exactly as cheap as before; the ceiling keeps this bounded rather than unlimited
// (Groq Free stays the primary/cheap path, and a runaway per-call token budget must never become a way
// to quietly work around the OpenAI hard spend limit assumption elsewhere in this repository).
const TRIAGE_BASE_OUTPUT_TOKENS = 200;
const TRIAGE_PER_CANDIDATE_OUTPUT_TOKENS = 160;
const TRIAGE_MIN_OUTPUT_TOKENS = 1200;
const TRIAGE_MAX_OUTPUT_TOKENS = 4000;

export function estimateTriageMaxOutputTokens(candidateCount) {
  const count = Math.max(0, Number(candidateCount) || 0);
  const estimated = TRIAGE_BASE_OUTPUT_TOKENS + count * TRIAGE_PER_CANDIDATE_OUTPUT_TOKENS;
  return Math.min(TRIAGE_MAX_OUTPUT_TOKENS, Math.max(TRIAGE_MIN_OUTPUT_TOKENS, estimated));
}

const REQUIRED_ITEM_FIELDS = ['index', 'topic', 'whyNow', 'angle', 'relevance', 'novelty', 'usefulness', 'priceValue', 'newsworthiness', 'japanNovelty', 'audienceFit', 'confidence', 'risk'];
const NUMERIC_SCORE_FIELDS = ['relevance', 'novelty', 'usefulness', 'priceValue', 'newsworthiness', 'japanNovelty', 'audienceFit', 'confidence', 'risk'];

// JSON.parse succeeding is not the same as the response matching TRIAGE_SCHEMA. OpenAI's strict
// json_schema mode enforces this server-side, but Groq's json_object mode only guarantees syntactically
// valid JSON - a response with missing fields, wrong types, or an out-of-range score would otherwise be
// accepted as if it were a real triage result. This is the one place that actually enforces the shape
// for both providers; wired into src/ai/provider.mjs's runAiTask as a validate callback, a failure here
// falls forward to the next configured provider exactly like any other provider error, instead of either
// crashing the whole research run or silently using malformed data.
export function validateTriageShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Triage response was not a JSON object.');
  }
  if (!Array.isArray(data.items)) {
    throw new Error('Triage response is missing an "items" array.');
  }
  for (const [index, item] of data.items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Triage response items[${index}] is not an object.`);
    }
    for (const field of REQUIRED_ITEM_FIELDS) {
      if (!(field in item)) throw new Error(`Triage response items[${index}] is missing required field "${field}".`);
    }
    if (typeof item.index !== 'number' || !Number.isFinite(item.index)) {
      throw new Error(`Triage response items[${index}].index must be a number.`);
    }
    for (const field of ['topic', 'whyNow', 'angle']) {
      if (typeof item[field] !== 'string') throw new Error(`Triage response items[${index}].${field} must be a string.`);
    }
    for (const field of NUMERIC_SCORE_FIELDS) {
      const value = item[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error(`Triage response items[${index}].${field} must be a number in 0..100.`);
      }
    }
  }
  return data;
}

function triagePrompt(account, candidates) {
  return {
    system: [
      'You triage freshly fetched product/news items for one social account, at low cost, before any expensive generation step.',
      'Score each candidate strictly from the given title/summary/vendor/product/url. Never invent a price, date, feature, or fact that is not present.',
      'relevance/novelty/usefulness/priceValue/newsworthiness/japanNovelty/audienceFit/confidence are 0-100 (higher is better).',
      'japanNovelty: how under-covered this is in Japanese-language feeds specifically. audienceFit: fit for the account\'s stated audience/topics.',
      'risk is 0-100 (misinformation/legal/brand risk; higher is worse). confidence reflects how sure you are given the available text.'
    ].join(' '),
    user: JSON.stringify({
      accountTopics: account.profile?.topics || [],
      accountAudience: account.profile?.audience || account.profile?.identity || '',
      candidates: candidates.map((candidate, index) => ({
        index,
        title: candidate.title,
        vendor: candidate.vendor,
        product: candidate.product,
        summary: (candidate.summary || '').slice(0, 600),
        url: candidate.url,
        publishedAt: candidate.publishedAt,
        categories: candidate.categories,
        sourceType: candidate.sourceType
      }))
    })
  };
}

// Tier 2 of the low-cost research pipeline: score direct-fetch candidates (src/research/fetch-pipeline.mjs)
// through the cheap AI provider abstraction (src/ai/provider.mjs, Groq by default) instead of ever
// calling OpenAI Web Search first. Returns the same { summary, items, citations } shape
// generateTrendBrief() returns (src/lib/openai.mjs), so src/research/trends.mjs can rank/persist either
// path identically.
export async function triageCandidates(accountId, account, candidates) {
  const maxCandidates = Number(account.research?.maxTriageCandidates ?? 20);
  const top = candidates.slice(0, Math.max(1, maxCandidates));
  if (!top.length) return { summary: 'No fresh direct-fetch candidates to triage.', items: [], citations: [] };

  const cache = await loadResearchCache(accountId);
  const prompt = triagePrompt(account, top);
  const { data } = await runAiTask(accountId, account, 'research-triage', {
    ...prompt,
    schema: TRIAGE_SCHEMA,
    maxOutputTokens: estimateTriageMaxOutputTokens(top.length),
    validate: (result) => validateTriageShape(result.data)
  });

  const items = [];
  for (const scored of data?.items || []) {
    const source = top[scored.index];
    if (!source) continue;
    if (source._cacheHash) markEvaluated(cache, source._cacheHash, scored);
    items.push({
      topic: scored.topic || source.title,
      whyNow: scored.whyNow || '',
      angle: scored.angle || '',
      relevance: scored.relevance,
      novelty: scored.novelty,
      usefulness: scored.usefulness,
      priceValue: scored.priceValue,
      newsworthiness: scored.newsworthiness,
      japanNovelty: scored.japanNovelty,
      audienceFit: scored.audienceFit,
      confidence: scored.confidence,
      risk: scored.risk,
      url: source.url,
      sourceId: source.sourceId,
      vendor: source.vendor,
      product: source.product,
      publishedAt: source.publishedAt
    });
  }
  await saveResearchCache(accountId, cache);

  const citations = top.filter((candidate) => candidate.url).map((candidate) => ({ url: candidate.url, title: candidate.title }));
  const sourceCount = new Set(top.map((candidate) => candidate.sourceId)).size;
  return { summary: `Direct-fetch triage of ${top.length} candidate(s) from ${sourceCount} source(s).`, items, citations };
}

export const __test = { TRIAGE_SCHEMA, triagePrompt, TRIAGE_MIN_OUTPUT_TOKENS, TRIAGE_MAX_OUTPUT_TOKENS };
