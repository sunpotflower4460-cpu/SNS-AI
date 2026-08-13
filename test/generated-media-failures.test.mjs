import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { generateAndHostImageDetailed } from '../src/media/openai-image.mjs';
import { generateAndHostVideoDetailed, assertVideosApiStillAvailable, VIDEOS_API_DEPRECATION_DATE } from '../src/media/openai-video.mjs';
import { cleanupGeneratedAssets, ensurePublicRelease } from '../src/media/release-host.mjs';

const USAGE_FILES = [
  fileURLToPath(new URL('../data/usage-state.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage.jsonl', import.meta.url))
];

// Every video test in this file that is NOT specifically testing the deprecation guard itself must
// pin `now` well before VIDEOS_API_DEPRECATION_DATE - otherwise, once the real wall clock crosses that
// date, these tests (which exercise retry/QA/hosting/cleanup behavior, nothing to do with the
// deprecation guard) would all start failing at the guard instead of testing what they're named for.
const PRE_DEPRECATION_NOW = { now: new Date('2026-01-01T00:00:00Z') };

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
// Mirrors the private safe()/digest() naming in src/media/openai-video.mjs exactly, so a test can
// pre-populate a release asset that generateAndHostVideoDetailed will actually recognize as a cache hit.
function cachedVideoAssetName(accountId, slotId, model, size, seconds, prompt) {
  const digest = createHash('sha256').update(`qa-v2-spritesheet|${slotId}|${model}|${size}|${seconds}|${prompt}`).digest('hex').slice(0, 20);
  const safeAccountId = String(accountId || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'video';
  return `${safeAccountId}-${digest}.mp4`;
}

test('the OpenAI Videos API deprecation guard fails closed on/after the confirmed shutdown date, not before', () => {
  // OpenAI's official deprecations page confirms the entire Videos API (every sora-2/sora-2-pro model
  // alias) is shut down on this date with no replacement model listed. Verified against a primary
  // source, not just secondary reporting - see the commit message / audit notes for the citation.
  assert.doesNotThrow(() => assertVideosApiStillAvailable(new Date(Date.parse(VIDEOS_API_DEPRECATION_DATE) - 1)));
  assert.throws(
    () => assertVideosApiStillAvailable(new Date(VIDEOS_API_DEPRECATION_DATE)),
    (error) => error.code === 'PROVIDER_DEPRECATED' && /shut down/.test(error.message)
  );
  assert.throws(
    () => assertVideosApiStillAvailable(new Date(Date.parse(VIDEOS_API_DEPRECATION_DATE) + 86_400_000)),
    (error) => error.code === 'PROVIDER_DEPRECATED'
  );
});

test('video generation fails closed before any OpenAI Videos API call once the deprecation date has passed, but still serves an already-cached video', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  try {
    // The deprecation guard is enforced only AFTER the release-cache lookup (see
    // src/media/openai-video.mjs) - ensurePublicRelease()/findAsset() are GitHub calls, not OpenAI
    // Videos API calls, so they must still be allowed to run even past the shutdown date. Any request
    // to api.openai.com/v1/videos, however, must never happen.
    globalThis.fetch = async (url) => {
      const target = String(url);
      const release = releaseLookup(target);
      if (release) return release;
      if (target.startsWith('https://api.openai.com/v1/videos')) throw new Error(`No OpenAI Videos API call should have been made: ${target}`);
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    await assert.rejects(
      generateAndHostVideoDetailed('video-deprecated', {
        media: { videoModel: 'sora-2', videoSize: '720x1280', videoSeconds: 8, qa: { enabled: false, maxRegenerations: 0 } },
        budgets: { enabled: false }
      }, 'slot-video-deprecated', { mediaPrompt: 'a scene' }, { now: new Date(Date.parse(VIDEOS_API_DEPRECATION_DATE) + 86_400_000) }),
      (error) => error.code === 'PROVIDER_DEPRECATED'
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('a cache hit for an already-approved video is still served after the OpenAI Videos API shutdown date, with zero Videos API calls', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  try {
    const accountId = 'video-cached-after-deprecation';
    const slotId = 'slot-video-cached';
    const model = 'sora-2';
    const size = '720x1280';
    const seconds = 8;
    const prompt = 'a previously approved cached scene';
    const name = cachedVideoAssetName(accountId, slotId, model, size, seconds, prompt);

    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.github.com/repos/owner/repo') return jsonResponse({ private: false });
      if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') {
        return jsonResponse({ id: 7, assets: [{ name, browser_download_url: 'https://downloads.example/cached.mp4' }] });
      }
      if (target.startsWith('https://api.openai.com/v1/videos')) throw new Error(`No OpenAI Videos API call should have been made: ${target}`);
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const result = await generateAndHostVideoDetailed(accountId, {
      media: { videoModel: model, videoSize: size, videoSeconds: seconds, qa: { enabled: false, maxRegenerations: 0 } },
      budgets: { enabled: false }
    }, slotId, { mediaPrompt: prompt }, { now: new Date(Date.parse(VIDEOS_API_DEPRECATION_DATE) + 86_400_000) });

    assert.equal(result.url, 'https://downloads.example/cached.mp4');
    assert.equal(result.qa.cached, true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('a QA-processing failure (not a definitive QA rejection) still deletes the OpenAI-side video job exactly once', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  const files = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });
    let deletes = 0;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      const release = releaseLookup(target);
      if (release) return release;
      if (target === 'https://api.openai.com/v1/videos?limit=100') return jsonResponse({ data: [] });
      if (target === 'https://api.openai.com/v1/videos' && options.method === 'POST') {
        return jsonResponse({ id: 'video-qa-crash', status: 'completed' });
      }
      if (target === 'https://api.openai.com/v1/videos/video-qa-crash/content?variant=spritesheet') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      // Moderation runs before the vision QA call and fails outright here - a transient QA-pipeline
      // error, not a definitive "QA reviewed the video and rejected it" outcome. It must still clean up
      // the OpenAI-side job exactly like a QA rejection or an oversize download already does.
      if (target === 'https://api.openai.com/v1/moderations') {
        return jsonResponse({ error: { message: 'moderation pipeline crashed' } }, 400);
      }
      if (target === 'https://api.openai.com/v1/videos/video-qa-crash' && options.method === 'DELETE') {
        deletes += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    await assert.rejects(
      generateAndHostVideoDetailed('video-qa-crash', {
        media: {
          videoModel: 'sora-2', videoSize: '720x1280', videoSeconds: 8,
          qa: { enabled: true, maxInputBytes: 1024, maxRegenerations: 0, minScore: 75 }
        },
        budgets: { enabled: false }
      }, 'slot-video-qa-crash', { mediaPrompt: 'a scene that will crash QA' }, PRE_DEPRECATION_NOW),
      /moderation pipeline crashed/
    );
    assert.equal(deletes, 1, 'a QA-processing exception (not a QA rejection) must still delete the OpenAI-side video job exactly once');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});

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

test('image generation never retries a network exception or a 5xx response, only an explicit 429', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  const files = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });
    let imageCalls = 0;
    globalThis.fetch = async (url) => {
      const target = String(url);
      const release = releaseLookup(target);
      if (release) return release;
      if (target === 'https://api.openai.com/v1/images/generations') {
        imageCalls += 1;
        // A network-level failure gives no proof the first call was not already accepted
        // server-side; retrying it would risk a second, silently paid generation.
        throw new TypeError('fetch failed: socket hang up');
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    await assert.rejects(
      generateAndHostImageDetailed('image-network-exception', {
        media: { qa: { enabled: false, maxRegenerations: 0 } }, budgets: { enabled: false }
      }, 'slot-image-network', { mediaPrompt: 'a diagram' }),
      /socket hang up/
    );
    assert.equal(imageCalls, 1, 'a network exception on the generation POST must never be retried');
    const usage = (await readFile(USAGE_FILES[1], 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(usage.length, 1, 'exactly one real attempt was made, so exactly one usage row must be recorded');

    imageCalls = 0;
    globalThis.fetch = async (url) => {
      const target = String(url);
      const release = releaseLookup(target);
      if (release) return release;
      if (target === 'https://api.openai.com/v1/images/generations') {
        imageCalls += 1;
        // A 5xx can occur after the request was already accepted for processing, unlike a 429
        // rate-limit rejection - it must be treated as ambiguous too, not retried.
        return jsonResponse({ error: { message: 'internal error' } }, 500);
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    await assert.rejects(
      generateAndHostImageDetailed('image-5xx', {
        media: { qa: { enabled: false, maxRegenerations: 0 } }, budgets: { enabled: false }
      }, 'slot-image-5xx', { mediaPrompt: 'a diagram' })
    );
    assert.equal(imageCalls, 1, 'a 5xx response on the generation POST must never be retried');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
  }
});

test('video generation never retries a network exception or a 5xx response, only an explicit 429', async () => {
  const previousFetch = globalThis.fetch;
  const env = mediaEnv();
  const files = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });
    let videoCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      const release = releaseLookup(target);
      if (release) return release;
      if (target === 'https://api.openai.com/v1/videos?limit=100') return jsonResponse({ data: [] });
      if (target === 'https://api.openai.com/v1/videos' && options.method === 'POST') {
        videoCalls += 1;
        throw new TypeError('fetch failed: socket hang up');
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    await assert.rejects(
      generateAndHostVideoDetailed('video-network-exception', {
        media: { videoModel: 'sora-2', videoSize: '720x1280', videoSeconds: 8, qa: { enabled: false, maxRegenerations: 0 } },
        budgets: { enabled: false }
      }, 'slot-video-network', { mediaPrompt: 'a scene' }, PRE_DEPRECATION_NOW),
      /socket hang up/
    );
    assert.equal(videoCalls, 1, 'a network exception on the video-create POST must never be retried');
    const usage = (await readFile(USAGE_FILES[1], 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(usage.length, 1, 'exactly one real attempt was made, so exactly one usage row must be recorded');

    videoCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      const release = releaseLookup(target);
      if (release) return release;
      if (target === 'https://api.openai.com/v1/videos?limit=100') return jsonResponse({ data: [] });
      if (target === 'https://api.openai.com/v1/videos' && options.method === 'POST') {
        videoCalls += 1;
        return jsonResponse({ error: { message: 'internal error' } }, 500);
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    await assert.rejects(
      generateAndHostVideoDetailed('video-5xx', {
        media: { videoModel: 'sora-2', videoSize: '720x1280', videoSeconds: 8, qa: { enabled: false, maxRegenerations: 0 } },
        budgets: { enabled: false }
      }, 'slot-video-5xx', { mediaPrompt: 'a scene' }, PRE_DEPRECATION_NOW)
    );
    assert.equal(videoCalls, 1, 'a 5xx response on the video-create POST must never be retried');
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
    }, 'slot-video-reuse', { mediaPrompt: 'reuse me', text: 'caption' }, PRE_DEPRECATION_NOW);

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
      }, 'slot-video-failed', { mediaPrompt: 'fail render' }, PRE_DEPRECATION_NOW),
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
    }, 'slot-video-large', { mediaPrompt: 'large video' }, PRE_DEPRECATION_NOW).then(() => null, (error) => error);

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
