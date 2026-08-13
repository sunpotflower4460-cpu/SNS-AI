import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { generateAndHostImageDetailed } from '../src/media/openai-image.mjs';
import { generateAndHostVideoDetailed } from '../src/media/openai-video.mjs';
import { cleanupGeneratedAssets, ensurePublicRelease } from '../src/media/release-host.mjs';

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
function saveEnv(...names) { return Object.fromEntries(names.map((name) => [name, process.env[name]])); }
function restoreEnv(saved) {
  for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value;
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
  for (const [path, bytes] of saved) bytes === null ? await rm(path, { force: true }) : await writeFile(path, bytes);
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
function releaseLookup(target) {
  if (target === 'https://api.github.com/repos/owner/repo') return jsonResponse({ private: false });
  if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') return jsonResponse({ id: 7, assets: [] });
  if (target === 'https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=1') return jsonResponse([]);
  return null;
}

test('image generation retries throttling, regenerates after QA failure, and uploads only the corrected result', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  const files = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });
    const generatedPrompts = [];
    let imageCalls = 0;
    let qaCalls = 0;
    let uploads = 0;

    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      const release = releaseLookup(target);
      if (release) return release;

      if (target === 'https://api.openai.com/v1/images/generations') {
        imageCalls += 1;
        const body = JSON.parse(String(options.body));
        generatedPrompts.push(body.prompt);
        if (imageCalls === 1) return jsonResponse({ error: { message: 'throttled' } }, 429, { 'retry-after': '0.001' });
        const bytes = imageCalls === 2 ? Buffer.from('first-image') : Buffer.from('corrected-image');
        return jsonResponse({ data: [{ b64_json: bytes.toString('base64') }] });
      }
      if (target === 'https://api.openai.com/v1/responses') {
        qaCalls += 1;
        if (qaCalls === 1) {
          return jsonResponse({ output_text: JSON.stringify({
            pass: false,
            score: 42,
            issues: [{ type: 'composition', severity: 'major', detail: 'The focal object is broken.' }],
            altText: '',
            correctionPrompt: 'Repair the broken focal object while preserving the composition.'
          }) });
        }
        return jsonResponse({ output_text: JSON.stringify({
          pass: true, score: 94, issues: [], altText: 'A corrected clean illustration.', correctionPrompt: ''
        }) });
      }
      if (target.startsWith('https://uploads.github.com/repos/owner/repo/releases/7/assets?name=')) {
        uploads += 1;
        assert.equal(Buffer.from(options.body).toString(), 'corrected-image');
        return jsonResponse({ browser_download_url: 'https://downloads.example/corrected.png' }, 201);
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const account = {
      generation: { model: 'gpt-5' },
      media: {
        imageModel: 'gpt-image-1', imageSize: '1024x1024', imageQuality: 'medium',
        maxHostedImageBytes: 1024,
        qa: { enabled: true, model: 'gpt-5', minScore: 75, maxInputBytes: 1024, maxRegenerations: 1 }
      },
      safety: { moderation: false },
      budgets: { enabled: false }
    };

    const result = await generateAndHostImageDetailed('image-retry', account, 'slot-image-retry', {
      mediaPrompt: 'original visual request', text: 'caption'
    });
    assert.equal(result.url, 'https://downloads.example/corrected.png');
    assert.equal(result.attempt, 1);
    assert.equal(result.qa.pass, true);
    assert.equal(result.qa.score, 94);
    assert.equal(imageCalls, 3);
    assert.equal(qaCalls, 2);
    assert.equal(uploads, 1);
    assert.equal(generatedPrompts[0], 'original visual request');
    assert.equal(generatedPrompts[1], 'original visual request');
    assert.match(generatedPrompts[2], /QUALITY CORRECTION FOR RETRY 1/);
    assert.match(generatedPrompts[2], /Repair the broken focal object/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});

test('image generation fails closed before hosting when generated bytes exceed the configured limit', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  const files = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });
    let uploads = 0;
    globalThis.fetch = async (url) => {
      const target = String(url);
      const release = releaseLookup(target);
      if (release) return release;
      if (target === 'https://api.openai.com/v1/images/generations') {
        return jsonResponse({ data: [{ b64_json: Buffer.alloc(20, 1).toString('base64') }] });
      }
      if (target.startsWith('https://uploads.github.com/')) { uploads += 1; return jsonResponse({}); }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    const rejection = await generateAndHostImageDetailed('image-oversize', {
      media: { maxHostedImageBytes: 5, qa: { enabled: false, maxRegenerations: 0 } },
      budgets: { enabled: false }
    }, 'slot-image-oversize', { mediaPrompt: 'large image' }).then(() => null, (error) => error);
    assert.match(rejection.message, /Generated image exceeds hosting limit/);
    // Same reasoning as the video case: a hosting-limit rejection is a config-tuning issue, not a
    // provider outage, and must not count toward the resilience circuit breaker.
    assert.equal(rejection.code, 'MEDIA_HOSTING_TOO_LARGE');
    assert.equal(uploads, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});

test('video generation reuses a recent completed job and falls back from spritesheet to thumbnail QA preview', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  const files = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });
    let postCalls = 0;
    let deleted = 0;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      const release = releaseLookup(target);
      if (release) return release;
      if (target === 'https://api.openai.com/v1/videos?limit=100') {
        return jsonResponse({ data: [{
          id: 'video-reused', status: 'completed', prompt: 'reuse me', model: 'sora-2',
          size: '720x1280', seconds: 8, created_at: Math.floor(Date.now() / 1000)
        }] });
      }
      if (target === 'https://api.openai.com/v1/videos' && options.method === 'POST') {
        postCalls += 1;
        return jsonResponse({ id: 'should-not-create', status: 'completed' });
      }
      if (target === 'https://api.openai.com/v1/videos/video-reused/content?variant=spritesheet') {
        return new Response('spritesheet unavailable', { status: 404 });
      }
      if (target === 'https://api.openai.com/v1/videos/video-reused/content?variant=thumbnail') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (target === 'https://api.openai.com/v1/videos/video-reused/content') {
        return new Response(new Uint8Array([4, 5, 6, 7]), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (target.startsWith('https://uploads.github.com/repos/owner/repo/releases/7/assets?name=')) {
        return jsonResponse({ browser_download_url: 'https://downloads.example/reused.mp4' }, 201);
      }
      if (target === 'https://api.openai.com/v1/videos/video-reused' && options.method === 'DELETE') {
        deleted += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const result = await generateAndHostVideoDetailed('video-reuse', {
      media: {
        videoModel: 'sora-2', videoSize: '720x1280', videoSeconds: 8,
        maxHostedVideoBytes: 1024,
        qa: { enabled: false, maxInputBytes: 1024, maxRegenerations: 0 }
      },
      budgets: { enabled: false }
    }, 'slot-video-reuse', { mediaPrompt: 'reuse me', text: 'caption' });

    assert.equal(result.url, 'https://downloads.example/reused.mp4');
    assert.equal(result.qa.previewVariant, 'thumbnail');
    assert.equal(postCalls, 0);
    assert.equal(deleted, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});

test('video creation retries a throttled create call and then fails fast when the provider reports a failed job', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  const files = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });
    let postCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      const release = releaseLookup(target);
      if (release) return release;
      if (target === 'https://api.openai.com/v1/videos?limit=100') return jsonResponse({ data: [] });
      if (target === 'https://api.openai.com/v1/videos' && options.method === 'POST') {
        postCalls += 1;
        if (postCalls === 1) return jsonResponse({ error: { message: 'slow down' } }, 429, { 'retry-after': '0.001' });
        return jsonResponse({ id: 'video-failed', status: 'failed', error: { message: 'render failed' } });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    await assert.rejects(
      generateAndHostVideoDetailed('video-failed', {
        media: {
          videoModel: 'sora-2', videoSize: '720x1280', videoSeconds: 8,
          qa: { enabled: false, maxRegenerations: 0 }
        },
        budgets: { enabled: false }
      }, 'slot-video-failed', { mediaPrompt: 'fail render' }),
      /OpenAI video generation failed: render failed/
    );
    assert.equal(postCalls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});

test('video hosting rejects an oversized MP4 after a valid QA preview', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  const files = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });
    let uploads = 0;
    let deletes = 0;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      const release = releaseLookup(target);
      if (release) return release;
      if (target === 'https://api.openai.com/v1/videos?limit=100') return jsonResponse({ data: [] });
      if (target === 'https://api.openai.com/v1/videos' && options.method === 'POST') return jsonResponse({ id: 'video-large', status: 'completed' });
      if (target === 'https://api.openai.com/v1/videos/video-large/content?variant=spritesheet') {
        return new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (target === 'https://api.openai.com/v1/videos/video-large/content') {
        return new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '5000' } });
      }
      if (target === 'https://api.openai.com/v1/videos/video-large' && options.method === 'DELETE') { deletes += 1; return new Response(null, { status: 204 }); }
      if (target.startsWith('https://uploads.github.com/')) { uploads += 1; return jsonResponse({}); }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const rejection = await generateAndHostVideoDetailed('video-large', {
      media: {
        videoModel: 'sora-2', videoSize: '720x1280', videoSeconds: 8,
        maxHostedVideoBytes: 10,
        qa: { enabled: false, maxInputBytes: 1024, maxRegenerations: 0 }
      },
      budgets: { enabled: false }
    }, 'slot-video-large', { mediaPrompt: 'large video' }).then(() => null, (error) => error);

    assert.match(rejection.message, /Generated video exceeds limit/);
    // A hosting-limit rejection is a config-tuning issue, not a provider outage: it must carry a
    // distinct code so orchestrate.mjs excludes it from the resilience circuit breaker (the same way
    // MEDIA_QA_FAILED already is), instead of pausing the whole account's autopilot after a few hits.
    assert.equal(rejection.code, 'MEDIA_HOSTING_TOO_LARGE');
    assert.equal(uploads, 0);
    // QA already passed (real generation + moderation cost already sunk) before the oversize download
    // failed - the generated video must still be deleted from the OpenAI account, not leaked.
    assert.equal(deletes, 1, 'an oversized video that already passed QA must still be cleaned up on the OpenAI side');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});

test('generated-media cleanup removes only expired release assets and public hosting refuses private repositories', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  try {
    let privateMode = true;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.github.com/repos/owner/repo') {
        return jsonResponse({ private: privateMode });
      }
      if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') {
        return jsonResponse({ id: 7, assets: [] });
      }
      if (target === 'https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=1') {
        return jsonResponse([
          { id: 11, name: 'old.png', created_at: '2020-01-01T00:00:00.000Z' },
          { id: 12, name: 'new.png', created_at: new Date().toISOString() }
        ]);
      }
      if (target === 'https://api.github.com/repos/owner/repo/releases/assets/11' && options.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    await assert.rejects(ensurePublicRelease(), /requires a public repository/);
    privateMode = false;
    const release = await ensurePublicRelease();
    assert.equal(release.id, 7);
    const cleanup = await cleanupGeneratedAssets({ retentionDays: 90 });
    assert.deepEqual(cleanup, { skipped: false, scanned: 2, deleted: 1 });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});
