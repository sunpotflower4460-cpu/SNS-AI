import { findNearDuplicate } from './duplicate.mjs';
import { validateDraftText } from './safety.mjs';

const OPENAI_BASE = 'https://api.openai.com/v1';

function apiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Missing OPENAI_API_KEY for autonomous content generation.');
  return key;
}

async function openaiRequest(path, body) {
  const response = await fetch(`${OPENAI_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(parsed?.error?.message || `OpenAI API failed with ${response.status}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}

function outputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return '';
}

function parseJsonText(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('AI response was not valid JSON.');
  }
}

function accountPrompt(accountId, account, history, feedback) {
  const recent = history.slice(0, Number(account.generation?.historyWindow ?? 30)).map((entry) => ({
    at: entry.at,
    text: entry.text
  }));

  return {
    system: [
      'You operate one social-media account. Follow only this account profile; never leak style or facts from another account.',
      'Create one publishable post, not an explanation.',
      'Return JSON only with keys: text, mediaPrompt, rationale.',
      'mediaPrompt should be empty when no image is needed.',
      'Do not claim facts, results, personal experiences, affiliations, or product usage that are not supported by the supplied account instructions.',
      'Avoid repeating recent posts in topic, hook, structure, and wording.'
    ].join('\n'),
    user: JSON.stringify({
      accountId,
      platform: account.platform,
      profile: account.profile || {},
      instructions: account.instructions || '',
      generation: account.generation || {},
      recentPosts: recent,
      retryFeedback: feedback || ''
    }, null, 2)
  };
}

export async function moderateText(text, account) {
  if (account.safety?.moderation === false) return { flagged: false };
  const response = await openaiRequest('/moderations', {
    model: account.safety?.moderationModel || 'omni-moderation-latest',
    input: text
  });
  const result = response.results?.[0];
  if (result?.flagged) {
    const flagged = Object.entries(result.categories || {})
      .filter(([, value]) => value)
      .map(([key]) => key);
    throw new Error(`Moderation blocked generated post: ${flagged.join(', ') || 'flagged'}`);
  }
  return { flagged: false };
}

export async function generatePost(accountId, account, history = []) {
  const attempts = Number(account.generation?.maxAttempts ?? 3);
  const threshold = Number(account.generation?.duplicateThreshold ?? 0.72);
  let feedback = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const prompt = accountPrompt(accountId, account, history, feedback);
    const body = {
      model: account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5',
      store: false,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: prompt.system }] },
        { role: 'user', content: [{ type: 'input_text', text: prompt.user }] }
      ]
    };

    if (account.research?.webSearch) body.tools = [{ type: 'web_search' }];

    const response = await openaiRequest('/responses', body);
    const draft = parseJsonText(outputText(response));
    draft.text = validateDraftText(account, draft.text);

    const duplicate = findNearDuplicate(draft.text, history, threshold);
    if (!duplicate) {
      await moderateText(draft.text, account);
      return {
        text: draft.text,
        mediaPrompt: String(draft.mediaPrompt || ''),
        rationale: String(draft.rationale || ''),
        model: body.model,
        attempt
      };
    }

    feedback = `The previous draft was too similar (${duplicate.score.toFixed(2)}) to this recent post: ${duplicate.entry.text}. Choose a different topic angle, hook, structure and wording.`;
  }

  throw new Error(`Could not generate a sufficiently original post after ${attempts} attempts.`);
}
