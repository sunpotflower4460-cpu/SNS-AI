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
  const { data } = await runAiTask(accountId, account, 'research-triage', { ...prompt, schema: TRIAGE_SCHEMA });

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

export const __test = { TRIAGE_SCHEMA, triagePrompt };
