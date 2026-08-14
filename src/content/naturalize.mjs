import { findNearDuplicate } from '../lib/duplicate.mjs';
import { moderateText, openaiRequest } from '../lib/openai.mjs';
import { validateDraftText } from '../lib/safety.mjs';

const NATURALIZATION_VERSION = 'naturalize-v2-chat-preferred';
const AIISH_PATTERNS = [
  /結論から(?:言う|いう)と/gu,
  /(?:ポイント|理由|コツ)は[0-9０-９一二三四五六七八九十]+つ/gu,
  /大切なのは/gu,
  /重要なのは/gu,
  /実は[、,]/gu,
  /つまり[、,]/gu,
  /要するに[、,]/gu,
  /〜だけではありません/gu,
  /だけではありません/gu,
  /いかがでしたか/gu,
  /ぜひ(?:試して|活用して|チェックして)みてください/gu,
  /(?:一緒に|まずは).{0,12}していきましょう/gu,
  /(?:圧倒的|革命的|劇的)に/gu,
  /^(?:Here'?s|Let'?s dive|In today'?s|The key is)\b/gimu,
  /\b(?:game[- ]changer|unlock the power|in conclusion|it'?s important to note)\b/gimu
];

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['action', 'naturalnessScore', 'aiPatternRisk', 'voiceFitScore', 'issues', 'editedText', 'reason'],
  properties: {
    action: { type: 'string', enum: ['keep', 'light_edit'] },
    naturalnessScore: { type: 'number', minimum: 0, maximum: 100 },
    aiPatternRisk: { type: 'number', minimum: 0, maximum: 100 },
    voiceFitScore: { type: 'number', minimum: 0, maximum: 100 },
    issues: { type: 'array', maxItems: 8, items: { type: 'string' } },
    editedText: { type: 'string' }, reason: { type: 'string' }
  }
};

function outputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  for (const item of response?.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
  }
  return '';
}
function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
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
    enabled: cfg.enabled === true,
    // Deep API editing is an explicit fallback only. The normal path is local detection + ChatGPT
    // conversational review when a human/editor wants a semantic judgment.
    deepReview: cfg.deepReview === true,
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

export function localNaturalnessAudit(text) {
  const value = String(text || '').trim();
  if (!value) return { aiPatternRisk: 100, naturalnessScore: 0, issues: ['empty text'] };
  const issues = []; let risk = 0;
  for (const pattern of AIISH_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = [...value.matchAll(pattern)];
    if (!matches.length) continue;
    risk += Math.min(24, 12 * matches.length);
    issues.push(`formulaic phrase: ${matches[0][0]}`);
  }
  const nonEmptyLines = value.split('\n').map((line) => line.trim()).filter(Boolean);
  const labelLines = nonEmptyLines.filter((line) => /^(?:[0-9０-９]+[.)、]|[-・●■✓✅]|#{1,3}\s)/u.test(line)).length;
  if (nonEmptyLines.length >= 6 && labelLines / nonEmptyLines.length >= 0.65) { risk += 12; issues.push('highly templated list rhythm'); }
  const rhetorical = (value.match(/[?？]/gu) || []).length;
  if (rhetorical >= 3) { risk += 8; issues.push('repetitive rhetorical-question rhythm'); }
  const normalizedRisk = Math.max(0, Math.min(100, risk));
  return { aiPatternRisk: normalizedRisk, naturalnessScore: Math.max(0, 100 - normalizedRisk), issues: issues.slice(0, 8) };
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
    'Detect generic AI-writing patterns and make only small edits when clearly better.',
    'Preserve quirks, fragments, casual rhythm, uneven sentence lengths, account voice, meaning, facts, URLs, hashtags, disclosures, and calls to action.',
    'Never invent personal experience, results, credentials, emotions, numbers, facts, certainty, or a sales angle.',
    'Choose keep unless a light edit is meaningfully better. This is a soft quality layer, not a rejection gate.'
  ].join('\n');
  const user = JSON.stringify({
    version: NATURALIZATION_VERSION, platform: account.platform, profile: account.profile || {},
    accountInstructions: account.instructions || '', originalText: draft.text,
    localAudit: localNaturalnessAudit(draft.text), features: draft.features || {}, rationale: draft.rationale || '',
    recentPosts, newestHumanFeedback: (context.humanFeedback || []).slice(0, 12)
  }, null, 2);
  const body = {
    model: settings.model, store: false, max_output_tokens: 1200,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: user }] }
    ],
    text: { format: { type: 'json_schema', name: 'post_naturalization_review', schema: REVIEW_SCHEMA, strict: true } }
  };
  const meta = { accountId, account, operation: 'post-naturalization', retries: 1, dryRun };
  let response;
  try { response = await openaiRequest('/responses', body, meta); }
  catch (error) {
    if (Number(error.status) !== 400) throw error;
    const fallback = structuredClone(body); delete fallback.text;
    fallback.input[0].content[0].text += '\nReturn only one JSON object matching the requested review fields.';
    response = await openaiRequest('/responses', fallback, { ...meta, operation: 'post-naturalization-fallback' });
  }
  return parseJson(outputText(response));
}

export async function naturalizeDraft(accountId, account, draft, context = {}) {
  const settings = naturalizationSettings(account);
  if (!settings.enabled) return { ...draft, naturalization: { skipped: true, applied: false, version: NATURALIZATION_VERSION, reason: 'disabled' } };

  const original = validateDraftText(account, draft?.text || '');
  const local = localNaturalnessAudit(original);
  const suspicious = local.aiPatternRisk > settings.maxAiPatternRisk;
  if (!suspicious || !settings.deepReview) {
    return {
      ...draft, text: original,
      naturalization: {
        version: NATURALIZATION_VERSION, applied: false, action: 'keep', localOnly: true,
        naturalnessScore: local.naturalnessScore, aiPatternRisk: local.aiPatternRisk, voiceFitScore: null,
        issues: local.issues,
        chatReviewRecommended: suspicious,
        reason: suspicious
          ? 'Local audit found strong AI-like patterns. Preserve the draft for ChatGPT/editorial review instead of silently rewriting it with a second API call.'
          : 'Local audit found no strong generic-AI pattern; preserving the authored voice.'
      }
    };
  }

  let review;
  try { review = await requestReview(accountId, account, { ...draft, text: original }, context, settings, Boolean(context.dryRun)); }
  catch (error) {
    return {
      ...draft, text: original,
      naturalization: {
        version: NATURALIZATION_VERSION, applied: false, fallback: true, chatReviewRecommended: true,
        naturalnessScore: local.naturalnessScore, aiPatternRisk: local.aiPatternRisk, issues: local.issues,
        reason: `deep review unavailable; original preserved: ${String(error?.message || error).slice(0, 240)}`
      }
    };
  }

  const naturalnessScore = safeScore(review.naturalnessScore);
  const aiPatternRisk = safeScore(review.aiPatternRisk);
  const voiceFitScore = safeScore(review.voiceFitScore);
  const issues = (Array.isArray(review.issues) ? review.issues : []).map(String).slice(0, settings.maxIssues);
  const wantsEdit = review.action === 'light_edit'
    && (naturalnessScore < settings.minNaturalness || aiPatternRisk > settings.maxAiPatternRisk || voiceFitScore < settings.minVoiceFit);
  let finalText = original; let applied = false; let rejectedEditReason = null;
  if (wantsEdit && String(review.editedText || '').trim()) {
    try {
      const edited = validateDraftText(account, review.editedText);
      if (!preservesProtectedTokens(original, edited)) throw new Error('edit changed or removed a protected URL/hashtag');
      const duplicate = findNearDuplicate(edited, context.history || [], Number(account.generation?.duplicateThreshold ?? 0.72));
      if (duplicate) throw new Error('edit became too similar to recent history');
      finalText = edited; applied = finalText !== original;
    } catch (error) { rejectedEditReason = String(error?.message || error).slice(0, 300); finalText = original; }
  }
  if (applied && !context.dryRun) {
    try { await moderateText(finalText, account, accountId); }
    catch (error) {
      rejectedEditReason = `edited version failed moderation: ${String(error?.message || error).slice(0, 220)}`;
      finalText = original; applied = false;
    }
  }
  return {
    ...draft, text: finalText,
    naturalization: {
      version: NATURALIZATION_VERSION, applied, action: review.action === 'light_edit' ? 'light_edit' : 'keep',
      localOnly: false, naturalnessScore, aiPatternRisk, voiceFitScore, issues,
      chatReviewRecommended: !applied && aiPatternRisk > settings.maxAiPatternRisk,
      reason: String(review.reason || '').slice(0, 600), rejectedEditReason
    }
  };
}

export const __test = { protectedTokens, preservesProtectedTokens, safeScore, finiteSetting, localNaturalnessAudit };
