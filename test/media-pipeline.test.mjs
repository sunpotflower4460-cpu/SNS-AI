import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generateAndHostImageDetailed } from '../src/media/openai-image.mjs';
import { generateAndHostVideoDetailed } from '../src/media/openai-video.mjs';
import { reviewVisualBytes } from '../src/media/qa.mjs';

const USAGE_FILES = [
  fileURLToPath(new URL('../data/usage-state.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage.jsonl', import.meta.url))
];

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function saveEnv(...names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function snapshotFiles(paths) {
  const saved = new Map();
  for (const path of paths) {
    try { saved.set(path, await readFile(path)); }
    catch (error) { if (error.code === 'ENOENT') saved.set(path, null); else throw error; }
  }
  return saved;
}

async function restoreFiles(saved) {
  for (const [path, bytes] of saved) {
    if (bytes === null) await rm(path, { force: true });
    else await writeFile(path, bytes);
  }
}

function mediaEnv() {
  const saved = saveEnv('GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME', 'OPENAI_API_KEY');
  process.env.GH_TOKEN = 'test-gh-token';
  delete process.env.GITHUB_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  process.env.GITHUB_REF_NAME = 'main';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  return saved;
}

function githubReleaseMock(target) {
  if (target === 'https://api.github.com/repos/owner/repo') return jsonResponse({ private: false });
  if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') return jsonResponse({ id: 7, assets: [] });
  if (target === 'https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=1') return jsonResponse([]);
  return null;
}

test('built-in image generation runs generation, QA gate, and public hosting with mocked providers', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  const files = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });
    const seen = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      seen.push({ target, options });
      const github = githubReleaseMock(target);
      if (github) return github;
      if (target === 'https://api.openai.com/v1/images/generations') {
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'gpt-image-1');
        assert.equal(body.prompt, 'original visual');
        return jsonResponse({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }] });
      }
      if (target.startsWith('https://uploads.github.com/repos/owner/repo/releases/7/assets?name=')) {
        assert.equal(options.headers['Content-Type'], 'image/png');
        return jsonResponse({ browser_download_url: 'https://downloads.example/generated.png' }, 201);
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const account = {
      media: {
        imageModel: 'gpt-image-1', imageSize: '1024x1024', imageQuality: 'medium',
        maxHostedImageBytes: 1024, qa: { enabled: false, maxRegenerations: 0 }
      },
      budgets: { enabled: false }
    };
    const result = await generateAndHostImageDetailed('image-account', account, 'slot-image', {
      mediaPrompt: 'original visual', text: 'caption'
    });
    assert.equal(result.url, 'https://downloads.example/generated.png');
    assert.equal(result.qa.pass, true);
    assert.equal(result.qa.skipped, true);
    assert.equal(seen.some((row) => row.target === 'https://api.openai.com/v1/images/generations'), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});

test('built-in video generation runs Sora job, QA preview, MP4 download, hosting, and cleanup with mocked providers', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  const files = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });
    const seen = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      seen.push({ target, options });
      const github = githubReleaseMock(target);
      if (github) return github;
      if (target === 'https://api.openai.com/v1/videos?limit=100') return jsonResponse({ data: [] });
      if (target === 'https://api.openai.com/v1/videos' && options.method === 'POST') {
        assert.ok(options.body instanceof FormData);
        assert.equal(options.body.get('model'), 'sora-2');
        assert.equal(options.body.get('prompt'), 'vertical video');
        return jsonResponse({ id: 'video-1', status: 'completed' });
      }
      if (target === 'https://api.openai.com/v1/videos/video-1/content?variant=spritesheet') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (target === 'https://api.openai.com/v1/videos/video-1/content') {
        return new Response(new Uint8Array([4, 5, 6, 7]), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (target.startsWith('https://uploads.github.com/repos/owner/repo/releases/7/assets?name=')) {
        assert.equal(options.headers['Content-Type'], 'video/mp4');
        return jsonResponse({ browser_download_url: 'https://downloads.example/generated.mp4' }, 201);
      }
      if (target === 'https://api.openai.com/v1/videos/video-1' && options.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const account = {
      media: {
        videoModel: 'sora-2', videoSize: '720x1280', videoSeconds: 8,
        videoTimeoutMinutes: 1, videoPollSeconds: 2,
        maxHostedVideoBytes: 1024, qa: { enabled: false, maxInputBytes: 1024, maxRegenerations: 0 }
      },
      budgets: { enabled: false }
    };
    const result = await generateAndHostVideoDetailed('video-account', account, 'slot-video', {
      mediaPrompt: 'vertical video', text: 'caption'
    });
    assert.equal(result.url, 'https://downloads.example/generated.mp4');
    assert.equal(result.qa.pass, true);
    assert.equal(result.qa.previewVariant, 'spritesheet');
    assert.equal(seen.some((row) => row.target === 'https://api.openai.com/v1/videos/video-1' && row.options.method === 'DELETE'), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});

test('visual QA passes a safe high-quality image and blocks a moderation-flagged image', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY');
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const files = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });
    const account = {
      generation: { model: 'gpt-5' },
      media: { qa: { enabled: true, model: 'gpt-5', minScore: 75, maxInputBytes: 1024, detail: 'high' } },
      safety: { moderation: true },
      budgets: { enabled: false }
    };

    let moderationCalls = 0;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/moderations') {
        moderationCalls += 1;
        if (moderationCalls === 1) return jsonResponse({ results: [{ flagged: false, categories: {} }] });
        return jsonResponse({ results: [{ flagged: true, categories: { violence: true } }] });
      }
      if (target === 'https://api.openai.com/v1/responses') {
        return jsonResponse({ output_text: JSON.stringify({
          pass: true, score: 92, issues: [], altText: 'A clean blue product illustration.', correctionPrompt: ''
        }) });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const safe = await reviewVisualBytes('qa-account', account, Buffer.from('safe-image'), 'image/png', {
      mediaType: 'image', prompt: 'clean illustration', postText: 'caption'
    });
    assert.equal(safe.pass, true);
    assert.equal(safe.score, 92);
    assert.equal(safe.altText, 'A clean blue product illustration.');

    const blocked = await reviewVisualBytes('qa-account', account, Buffer.from('flagged-image'), 'image/png', {
      mediaType: 'image', prompt: 'clean illustration', postText: 'caption'
    });
    assert.equal(blocked.pass, false);
    assert.equal(blocked.score, 0);
    assert.equal(blocked.issues[0].type, 'moderation');
    assert.equal(blocked.issues[0].severity, 'critical');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});
