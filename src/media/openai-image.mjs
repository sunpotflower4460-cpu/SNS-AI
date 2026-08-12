import { createHash } from 'node:crypto';
import { consumeUsage } from '../ops/budget.mjs';
import { cleanupGeneratedAssets, ensurePublicRelease, findAsset, uploadReleaseAsset } from './release-host.mjs';

const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safe(value) { return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'media'; }
function digest(value) { return createHash('sha256').update(String(value)).digest('hex').slice(0, 20); }

async function generateImage(accountId, account, prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Built-in image generation requires OPENAI_API_KEY.');
  await consumeUsage(accountId, account, 'image', { model: account.media?.imageModel || 'gpt-image-2' });
  const body = {
    model: account.media?.imageModel || 'gpt-image-2',
    prompt,
    size: account.media?.imageSize || '1024x1024',
    quality: account.media?.imageQuality || 'medium',
    output_format: 'png',
    n: 1
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(OPENAI_IMAGES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (attempt === 1) throw error;
      await sleep(1000);
      continue;
    }
    const parsed = await response.json().catch(() => ({}));
    if (response.ok) {
      const encoded = parsed?.data?.[0]?.b64_json;
      if (!encoded) throw new Error('OpenAI image generation returned no base64 image.');
      return Buffer.from(encoded, 'base64');
    }
    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 1500);
      continue;
    }
    const error = new Error(parsed?.error?.message || `OpenAI image generation failed with ${response.status}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  throw new Error('OpenAI image generation failed.');
}

export async function generateAndHostImage(accountId, account, slotId, draft) {
  const prompt = String(draft?.mediaPrompt || '').trim();
  if (!prompt) throw new Error('AI selected image generation but supplied no mediaPrompt.');
  const release = await ensurePublicRelease();
  const name = `${safe(accountId)}-${digest(`${slotId}|${prompt}`)}.png`;
  const cached = await findAsset(release, name);
  if (cached) return cached;
  const bytes = await generateImage(accountId, account, prompt);
  const maxBytes = Number(account.media?.maxHostedImageBytes ?? 15 * 1024 * 1024);
  if (bytes.byteLength > maxBytes) throw new Error(`Generated image exceeds hosting limit (${maxBytes} bytes).`);
  return uploadReleaseAsset(release, name, bytes, 'image/png');
}

export async function cleanupGeneratedMedia({ retentionDays = 90 } = {}) {
  return cleanupGeneratedAssets({ retentionDays });
}
