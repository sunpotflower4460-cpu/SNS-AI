import { createHash } from 'node:crypto';
import { consumeUsage } from '../ops/budget.mjs';

const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
const RELEASE_TAG = 'sns-ai-media';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safe(value) { return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'media'; }
function digest(value) { return createHash('sha256').update(String(value)).digest('hex').slice(0, 20); }
function githubToken() { return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''; }
function repoName() { return process.env.GITHUB_REPOSITORY || ''; }

async function githubApi(path, options = {}) {
  const token = githubToken();
  const repo = repoName();
  if (!token || !repo) throw new Error('Built-in media hosting requires GITHUB_TOKEN/GH_TOKEN and GITHUB_REPOSITORY.');
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.message || `GitHub API failed with ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function ensurePublicRelease() {
  const repo = repoName();
  const metadata = await githubApi(`/repos/${repo}`);
  if (metadata.private) throw new Error('Built-in GitHub media hosting requires a public repository. For a private repository, configure media.endpoint/CDN instead.');
  try {
    return await githubApi(`/repos/${repo}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    return githubApi(`/repos/${repo}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: RELEASE_TAG,
        target_commitish: process.env.GITHUB_REF_NAME || 'main',
        name: 'SNS-AI generated media',
        body: 'Automatically generated media assets used by SNS-AI. Managed by GitHub Actions.',
        draft: false,
        prerelease: false
      })
    });
  }
}

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
      await sleep(1500);
      continue;
    }
    const error = new Error(parsed?.error?.message || `OpenAI image generation failed with ${response.status}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  throw new Error('OpenAI image generation failed.');
}

async function findAsset(release, name) {
  const existing = (release.assets || []).find((asset) => asset.name === name);
  if (existing?.browser_download_url) return existing.browser_download_url;
  const repo = repoName();
  const assets = await githubApi(`/repos/${repo}/releases/${release.id}/assets?per_page=100`);
  return assets.find((asset) => asset.name === name)?.browser_download_url || null;
}

async function uploadReleaseAsset(release, name, bytes) {
  const token = githubToken();
  const repo = repoName();
  const url = `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.byteLength),
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: bytes
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || `GitHub release asset upload failed with ${response.status}`);
  if (!body.browser_download_url) throw new Error('GitHub release asset upload returned no public download URL.');
  return body.browser_download_url;
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
  return uploadReleaseAsset(release, name, bytes);
}

export async function cleanupGeneratedMedia({ retentionDays = 90 } = {}) {
  if (!githubToken() || !repoName()) return { skipped: true, reason: 'GitHub runtime credentials unavailable', deleted: 0 };
  let release;
  try { release = await githubApi(`/repos/${repoName()}/releases/tags/${encodeURIComponent(RELEASE_TAG)}`); }
  catch (error) { if (error.status === 404) return { skipped: true, reason: 'No generated-media release exists', deleted: 0 }; throw error; }
  const cutoff = Date.now() - Math.max(1, Number(retentionDays)) * 86_400_000;
  let deleted = 0;
  for (let page = 1; page <= 20; page += 1) {
    const assets = await githubApi(`/repos/${repoName()}/releases/${release.id}/assets?per_page=100&page=${page}`);
    for (const asset of assets) {
      if (Date.parse(asset.created_at || '') < cutoff) {
        const response = await fetch(`https://api.github.com/repos/${repoName()}/releases/assets/${asset.id}`, {
          method: 'DELETE',
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${githubToken()}`, 'X-GitHub-Api-Version': '2022-11-28' }
        });
        if (!response.ok && response.status !== 404) throw new Error(`Could not delete old generated media asset ${asset.id}: HTTP ${response.status}`);
        deleted += 1;
      }
    }
    if (assets.length < 100) break;
  }
  return { skipped: false, deleted };
}
