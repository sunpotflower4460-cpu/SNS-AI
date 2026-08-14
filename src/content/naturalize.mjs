import { findNearDuplicate } from '../lib/duplicate.mjs';
import { moderateText, openaiRequest } from '../lib/openai.mjs';
import { validateDraftText } from '../lib/safety.mjs';

const NATURALIZATION_VERSION = 'naturalize-v1';

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'naturalnessScore', 'aiPatternRisk', 'voiceFitScore', 'issues', 'editedText', 'reason'],
  properties: {
    action: { type: 'string', enum: ['keep', 'light_edit'] },
    naturalnessScore: { type: 'number', minimum: 0, maximum: 100 },
    aiPatternRisk: { type: 'number', minimum: 0, maximum: 100 },
    voiceFitScore: { type: 'number', minimum: 0, maximum: 100 },
    issues: { type: 'array', maxItems: 8, items: { type: 'string' } },
    editedText: { type: 'string' },
    reason: { type: 'string' }
  }
};

function outputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  for (const item of response?.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Naturalization review was not valid JSON.');
  }
}

function finiteSetting(value, fallback, { min = 0, max = 100 } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

export function naturalizationSettings(account = {}) {
  const cfg = account.generation?.naturalization || {};
  return {
    // Opt in explicitly at the merged config level. The repository defaults do this for real
    // accounts, while minimal low-level callers/tests that construct partial account objects do not
    // unexpectedly trigger another paid Responses call.
    enabled: cfg.enabled === true,
    model: cfg.model || account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5',
    minNaturalness: finiteSetting(cfg.minNaturalness, 72),
    maxAiPatternRisk: finiteSetting(cfg.maxAiPatternRisk, 45),
    minVoiceFit: finiteSetting(cfg.minVoiceFit, 68),
    maxIssues: Math.max(1, Math.min(8, Math.trunc(finiteSetting(cfg.maxIssues, 6, { min: 1, max: 8 }))))
  };
}

function safeScore(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

function protectedTokens(text) {
  const value = String(text || '');
  const urls = value.match(/https?:\/\/\S+/gi) || [];
  const hashtags = value.match(/[#＃][\p{L}\p{M}\p{N}_]+/gu) || [];
  return [...new Set([...urls, ...hashtags])];
}

function preservesProtectedTokens(original, edited) {
  return protectedTokens(original).every((token) => String(edited || '').includes(token));
}

async function requestReview(accountId, account, draft, context, settings, dryRun) {
  const recentPosts = (context.history || []).slice(0, 12).map((row) => String(row?.text || '')).filter(Boolean);
  const system = [
    'You are a restrained final editor for one social-media account.',
    'Your job is to detect writing that feels generically AI-produced and make only small edits when they clearly improve human naturalness.',
    'Do NOT optimize every post toward one house style. Preserve intentional quirks, short fragments, casual rhythm, uneven sentence lengths, and account-specific voice when they work.',
    'AI-pattern risk includes: generic throat-clearing, over-explaining, symmetrical three-part structures used mechanically, canned contrast phrases, repetitive rhetorical questions, vague hype, excessive signposting, needless summaries, generic motivational endings, and polished-but-empty wording.',
    'Do not treat correct grammar, lists, emojis, headings, or concise explanations as AI-like by themselves.',
    'Never invent personal experience, results, product use, credentials, emotions, facts, numbers, or certainty that are not already present.',
    'Preserve the original meaning, factual claims, URLs, hashtags, disclosures, and calls to action. Do not add a sales angle.',
    'Choose keep unless a light edit is meaningfully better. This is a soft quality layer, not a rejection gate.',
    'If editing, editedText must be a complete publishable replacement, not commentary.'
  ].join('\n');
  const user = JSON.stringify({
    version: NATURALIZATION_VERSION,
    platform: account.platform,
    profile: account.profile || {},
    accountInstructions: account.instructions || '',
    originalText: draft.text,
    features: draft.features || {},
    rationale: draft.rationale || '',
    recentPosts,
    newestHumanFeedback: (context.humanFeedback || []).slice(0, 12)
  }, null, 2);
  const body = {
    model: settings.model,
    store: false,
    max_output_tokens: 1200,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: user }] }
    ],
    text: { format: { type: 'json_schema', name: 'post_naturalization_review', schema: REVIEW_SCHEMA, strict: true } }
  };
  const meta = { accountId, account, operation: 'post-naturalization', retries: 1, dryRun };
  let response;
  try {
    response = await openaiRequest('/responses', body, meta);
  } catch (error) {
    if (Number(error.status) !== 400) throw error;
    const fallback = structuredClone(body);
    delete fallback.text;
    fallback.input[0].content[0].text += '\nReturn only one JSON object matching the requested review fields.';
    response = await openaiRequest('/responses', fallback, { ...meta, operation: 'post-naturalization-fallback' });
  }
  return parseJson(outputText(response));
}

export async function naturalizeDraft(accountId, account, draft, context = {}) {
  const settings = naturalizationSettings(account);
  // Disabled means truly zero additional work/cost. Do this before validation so generic media-only
  // callers with no post text are unaffected by the optional editor.
  if (!settings.enabled) {
    return { ...draft, naturalization: { skipped: true, applied: false, version: NATURALIZATION_VERSION } };
  }

  const original = validateDraftText(account, draft?.text || '');
  let review;
  try {
    review = await requestReview(accountId, account, { ...draft, text: original }, context, settings, Boolean(context.dryRun));
  } catch (error) {
    return {
      ...draft,
      text: original,
      naturalization: {
        version: NATURALIZATION_VERSION,
        applied: false,
        fallback: true,
        reason: `review unavailable: ${String(error?.message || error).slice(0, 300)}`
      }
    };
  }

  const naturalnessScore = safeScore(review.naturalnessScore);
  const aiPatternRisk = safeScore(review.aiPatternRisk);
  const voiceFitScore = safeScore(review.voiceFitScore);
  const issues = (Array.isArray(review.issues) ? review.issues : []).map(String).slice(0, settings.maxIssues);
  const wantsEdit = review.action === 'light_edit'
    && (naturalnessScore < settings.minNaturalness || aiPatternRisk > settings.maxAiPatternRisk || voiceFitScore < settings.minVoiceFit);

  let finalText = original;
  let applied = false;
  let rejectedEditReason = null;
  if (wantsEdit && String(review.editedText || '').trim()) {
    try {
      const edited = validateDraftText(account, review.editedText);
      if (!preservesProtectedTokens(original, edited)) throw new Error('edit changed or removed a protected URL/hashtag');
      const duplicate = findNearDuplicate(edited, context.history || [], Number(account.generation?.duplicateThreshold ?? 0.72));
      if (duplicate) throw new Error('edit became too similar to recent history');
      finalText = edited;
      applied = finalText !== original;
    } catch (error) {
      rejectedEditReason = String(error?.message || error).slice(0, 300);
      finalText = original;
    }
  }

  if (applied && !context.dryRun) {
    try {
      await moderateText(finalText, account, accountId);
    } catch (error) {
      rejectedEditReason = `edited version failed moderation: ${String(error?.message || error).slice(0, 220)}`;
      finalText = original;
      applied = false;
    }
  }

  return {
    ...draft,
    text: finalText,
    naturalization: {
      version: NATURALIZATION_VERSION,
      applied,
      action: review.action === 'light_edit' ? 'light_edit' : 'keep',
      naturalnessScore,
      aiPatternRisk,
      voiceFitScore,
      issues,
      reason: String(review.reason || '').slice(0, 600),
      rejectedEditReason
    }
  };
}

export const __test = { protectedTokens, preservesProtectedTokens, safeScore, finiteSetting };
