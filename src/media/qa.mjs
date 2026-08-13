import { openaiRequest } from '../lib/openai.mjs';

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
    throw new Error('Media QA response was not valid JSON.');
  }
}

const QA_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['pass', 'score', 'issues', 'altText', 'correctionPrompt'],
  properties: {
    pass: { type: 'boolean' },
    score: { type: 'number', minimum: 0, maximum: 100 },
    issues: { type: 'array', maxItems: 8, items: {
      type: 'object', additionalProperties: false, required: ['type', 'severity', 'detail'],
      properties: {
        type: { type: 'string' },
        severity: { type: 'string', enum: ['minor', 'major', 'critical'] },
        detail: { type: 'string' }
      }
    } },
    altText: { type: 'string' },
    correctionPrompt: { type: 'string' }
  }
};

function qaSettings(account) {
  return {
    enabled: account.media?.qa?.enabled !== false,
    model: account.media?.qa?.model || account.generation?.model || process.env.OPENAI_MODEL || 'gpt-5',
    detail: account.media?.qa?.detail || 'high',
    minScore: Number(account.media?.qa?.minScore ?? 75),
    maxInputBytes: Number(account.media?.qa?.maxInputBytes ?? 15 * 1024 * 1024)
  };
}

function dataUrl(bytes, contentType) {
  return `data:${contentType || 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`;
}

async function moderateImage(accountId, account, imageUrl) {
  if (account.safety?.moderation === false) return { flagged: false, categories: [] };
  const response = await openaiRequest('/moderations', {
    model: account.safety?.moderationModel || 'omni-moderation-latest',
    input: [{ type: 'image_url', image_url: { url: imageUrl } }]
  }, { accountId, account, operation: 'media-moderation', retries: 1 });
  const result = response.results?.[0];
  if (!result) throw new Error('Image moderation returned no result.');
  return {
    flagged: Boolean(result.flagged),
    categories: Object.entries(result.categories || {}).filter(([, value]) => value).map(([key]) => key)
  };
}

async function requestQa(accountId, account, body) {
  try {
    return await openaiRequest('/responses', body, { accountId, account, operation: 'media-qa', retries: 1 });
  } catch (error) {
    if (Number(error.status) !== 400 || !body.text) throw error;
    const fallback = structuredClone(body);
    delete fallback.text;
    const firstText = fallback.input?.[0]?.content?.find((part) => part.type === 'input_text');
    if (firstText) firstText.text += '\nReturn ONLY one JSON object with keys: pass(boolean), score(0-100 number), issues(array of {type,severity,detail}), altText(string), correctionPrompt(string).';
    return openaiRequest('/responses', fallback, { accountId, account, operation: 'media-qa-fallback', retries: 1 });
  }
}

async function reviewImageUrl(accountId, account, imageUrl, context = {}) {
  const settings = qaSettings(account);
  if (!settings.enabled) return { pass: true, score: 100, issues: [], altText: '', correctionPrompt: '', skipped: true };

  const moderation = await moderateImage(accountId, account, imageUrl);
  if (moderation.flagged) {
    return {
      pass: false,
      score: 0,
      issues: [{ type: 'moderation', severity: 'critical', detail: `Image moderation flagged: ${moderation.categories.join(', ') || 'flagged'}` }],
      altText: '',
      correctionPrompt: 'Remove unsafe or policy-sensitive visual content and replace it with a clearly safe visual that preserves the intended communication.'
    };
  }

  const body = {
    model: settings.model,
    store: false,
    max_output_tokens: 1200,
    input: [{ role: 'user', content: [
      { type: 'input_text', text: [
        'You are the final visual QA gate for an autonomous social-media publisher.',
        'Judge only problems serious enough to make automatic publication undesirable.',
        'Check: corrupted/broken rendering, obvious anatomy/object failures, unintended or garbled visible text, unwanted watermark/logo, severe crop/composition failure, and clear mismatch with the requested visual or post.',
        'Do not reject merely because you would prefer a different style. Be conservative about blocking publication.',
        'Write useful objective alt text describing what is actually visible. Do not include hashtags, promotional copy, or "image of" boilerplate.',
        `Requested media type: ${context.mediaType || 'image'}`,
        `Original visual request: ${String(context.prompt || '').slice(0, 5000)}`,
        `Associated post text: ${String(context.postText || '').slice(0, 3000)}`
      ].join('\n') },
      { type: 'input_image', image_url: imageUrl, detail: settings.detail }
    ] }],
    text: { format: { type: 'json_schema', name: 'sns_media_qa', schema: QA_SCHEMA, strict: true } }
  };

  const response = await requestQa(accountId, account, body);
  const parsed = parseJson(outputText(response));
  const issues = Array.isArray(parsed.issues) ? parsed.issues.slice(0, 8) : [];
  const score = Math.max(0, Math.min(100, Number(parsed.score) || 0));
  const critical = issues.some((issue) => issue.severity === 'critical');
  return {
    pass: Boolean(parsed.pass) && score >= settings.minScore && !critical,
    score,
    issues,
    altText: String(parsed.altText || '').trim().slice(0, 1000),
    correctionPrompt: String(parsed.correctionPrompt || '').trim().slice(0, 3000),
    model: settings.model,
    threshold: settings.minScore
  };
}

export async function reviewVisualBytes(accountId, account, bytes, contentType, context = {}) {
  const settings = qaSettings(account);
  if (!settings.enabled) return { pass: true, score: 100, issues: [], altText: '', correctionPrompt: '', skipped: true };
  if (!bytes?.byteLength) throw new Error('Media QA received empty image bytes.');
  if (bytes.byteLength > settings.maxInputBytes) {
    const error = new Error(`Media QA input exceeds ${settings.maxInputBytes} bytes.`);
    error.code = 'MEDIA_QA_INPUT_TOO_LARGE';
    throw error;
  }
  return reviewImageUrl(accountId, account, dataUrl(bytes, contentType), context);
}

export async function reviewVisualUrl(accountId, account, imageUrl, context = {}) {
  if (!/^https:\/\//i.test(String(imageUrl || ''))) throw new Error('Media QA URL must be public HTTPS.');
  return reviewImageUrl(accountId, account, imageUrl, context);
}

export function correctedMediaPrompt(originalPrompt, qa, attempt) {
  const correction = String(qa?.correctionPrompt || qa?.issues?.map((x) => x.detail).join('; ') || '').trim();
  if (!correction) return `${originalPrompt}\nRetry ${attempt}: make the result clean, coherent, visually intact, and faithful to the request.`;
  return `${originalPrompt}\n\nQUALITY CORRECTION FOR RETRY ${attempt}: ${correction}\nKeep the original concept and only fix the identified visual problems.`;
}
