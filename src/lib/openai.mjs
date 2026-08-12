import { findNearDuplicate } from './duplicate.mjs';
import { validateDraftText } from './safety.mjs';
import { rankCandidates, shouldExplore } from './strategy-rank.mjs';

const OPENAI_BASE = 'https://api.openai.com/v1';
function apiKey() { const key = process.env.OPENAI_API_KEY; if (!key) throw new Error('Missing OPENAI_API_KEY for autonomous content generation.'); return key; }
export async function openaiRequest(path, body) {
  const response = await fetch(`${OPENAI_BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(parsed?.error?.message || `OpenAI API failed with ${response.status}`); error.status = response.status; error.body = parsed; throw error; }
  return parsed;
}
function outputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output || []) if (item.type === 'message') for (const content of item.content || []) if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
  return '';
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

async function responseJson({ model, system, user, webSearch = false, schema = CANDIDATE_SCHEMA, name = 'social_output' }) {
  const body = { model, store: false, input: [
    { role: 'system', content: [{ type: 'input_text', text: system }] },
    { role: 'user', content: [{ type: 'input_text', text: user }] }
  ], text: { format: { type: 'json_schema', name, schema, strict: true } } };
  if (webSearch) body.tools = [{ type: 'web_search', search_context_size: 'medium' }];
  try { return parseJsonText(outputText(await openaiRequest('/responses', body))); }
  catch (error) {
    if (Number(error.status) !== 400) throw error;
    delete body.text;
    return parseJsonText(outputText(await openaiRequest('/responses', body)));
  }
}

export async function moderateText(text, account) {
  if (account.safety?.moderation === false) return { flagged: false };
  const response = await openaiRequest('/moderations', { model: account.safety?.moderationModel || 'omni-moderation-latest', input: text });
  const result = response.results?.[0];
  if (result?.flagged) {
    const flagged = Object.entries(result.categories || {}).filter(([, value]) => value).map(([key]) => key);
    throw new Error(`Moderation blocked generated post: ${flagged.join(', ') || 'flagged'}`);
  }
  return { flagged: false };
}

function generationPrompt(accountId, account, history, context, feedback) {
  const recent = history.slice(0, Number(account.generation?.historyWindow ?? 30)).map((entry) => ({ at: entry.at, text: entry.text, features: entry.features || null }));
  const humanFeedback = (context.humanFeedback || []).slice(0, 40).map((row) => ({
    at: row.at, action: row.action, note: row.note, dimension: row.dimension || null, value: row.value || null
  }));
  return {
    system: [
      'You operate exactly one social-media account. Never leak identity, facts, voice, or goals from another account.',
      'Generate several genuinely different publishable candidates and estimate their spread potential conservatively.',
      'Use trend information only when relevant and factual. Never fabricate personal experience, results, affiliations, or product usage.',
      'Explicit account identity/instructions and active human feedback outrank learned strategy. Learned strategy is only probabilistic evidence.',
      'Never let performance optimization override explicit human feedback, account identity, safety rules, or factual accuracy.',
      'mediaDecision: none when text alone is best; library for existing account assets; search only for a licensed/trusted media service; generate for a new original visual.',
      'Avoid repeating recent posts in topic, hook, structure, and wording.'
    ].join('\n'),
    user: JSON.stringify({
      accountId, platform: account.platform, profile: account.profile || {}, instructions: account.instructions || '', generation: account.generation || {},
      objectives: account.objectives || {}, recentPosts: recent, humanFeedback, learnedStrategy: context.strategy || null, trendBrief: context.trends || null,
      candidateCount: Number(account.generation?.candidateCount ?? 5), retryFeedback: feedback || ''
    }, null, 2)
  };
}

export async function generatePost(accountId, account, history = [], context = {}) {
  const attempts = Number(account.generation?.maxAttempts ?? 3); const threshold = Number(account.generation?.duplicateThreshold ?? 0.72);
  const model = account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5'; const explore = shouldExplore(context.slotId || new Date().toISOString(), account.learning?.exploreRate ?? context.strategy?.exploreRate ?? 0.2);
  let feedback = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const prompt = generationPrompt(accountId, account, history, context, feedback);
    const generated = await responseJson({ model, system: prompt.system, user: prompt.user, webSearch: Boolean(account.research?.webSearch) });
    const valid = [];
    for (const candidate of generated.candidates || []) {
      try {
        candidate.text = validateDraftText(account, candidate.text);
        const duplicate = findNearDuplicate(candidate.text, history, threshold); if (duplicate) continue;
        valid.push(candidate);
      } catch { /* discard invalid candidate */ }
    }
    const ranked = rankCandidates(valid, context.strategy, { explore });
    if (ranked.length) {
      const winner = ranked[0]; await moderateText(winner.text, account);
      return { text: winner.text, mediaPrompt: String(winner.mediaPrompt || ''), rationale: String(winner.rationale || ''),
        features: winner.features || {}, predictedScore: winner.predictedScore, selectionMode: explore ? 'explore' : 'exploit',
        model, attempt, candidatesConsidered: ranked.length };
    }
    feedback = 'All previous candidates were invalid, repetitive, or too similar to recent posts. Change the topic angle, hook, structure, and wording substantially.';
  }
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
  return responseJson({ model, webSearch: true, schema: TREND_SCHEMA, name: 'trend_brief',
    system: 'Research current public information for one social account. Prefer recent, credible sources. Return trends that are actually relevant; do not force a trend. Risk includes misinformation, sensitivity, legal, and brand risk.',
    user: JSON.stringify({ accountId, platform: account.platform, profile: account.profile || {}, instructions: account.instructions || '', topics: account.profile?.topics || [] }, null, 2) });
}
