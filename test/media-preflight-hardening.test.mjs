import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureMediaForPlatform, resolveMedia, resolveMediaDetailed } from '../src/lib/media.mjs';
import { publishX } from '../src/providers/x.mjs';
import { runLivePreflight } from '../src/ops/live-preflight.mjs';

const CONFIG = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const USAGE = fileURLToPath(new URL('../data/usage.jsonl', import.meta.url));
const USAGE_STATE = fileURLToPath(new URL('../data/usage-state.json', import.meta.url));
const X_OAUTH2_STATE = fileURLToPath(new URL('../data/x-oauth2-state.json', import.meta.url));
const qaOff = { enabled: false };

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

async function snapshot(path) {
  try { return { exists: true, bytes: await readFile(path) }; }
  catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
}

async function restore(path, saved) {
  if (!saved.exists) return rm(path, { force: true });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, saved.bytes);
}

async function withFiles(paths, fn) {
  const saved = new Map();
  for (const path of paths) saved.set(path, await snapshot(path));
  try { return await fn(); }
  finally {
    for (const path of [...paths].reverse()) await restore(path, saved.get(path));
  }
}

test('media resolver covers fixed, pool, endpoint, auto fallbacks, usage accounting, and platform requirements', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('MEDIA_SERVICE_TOKEN');
  await withFiles([USAGE, USAGE_STATE], async () => {
    try {
      await rm(USAGE, { force: true });
      await rm(USAGE_STATE, { force: true });

      const fixed = await resolveMediaDetailed('fixed', {
        platform: 'x', media: { strategy: 'fixed', url: 'https://cdn.example/fixed.png', altText: 'a'.repeat(1200), qa: qaOff }
      }, 'slot-fixed', {});
      assert.equal(fixed.url, 'https://cdn.example/fixed.png');
      assert.equal(fixed.decision, 'library');
      assert.equal(fixed.source, 'fixed');
      assert.equal(fixed.altText.length, 1000);
      assert.equal(await resolveMedia('fixed', { platform: 'x', media: { strategy: 'external', url: 'https://cdn.example/external.png', qa: qaOff } }, 'slot-external', {}), 'https://cdn.example/external.png');

      const poolAccount = { platform: 'x', media: { strategy: 'pool', urls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'], qa: qaOff } };
      const pooledA = await resolveMediaDetailed('pool', poolAccount, 'stable-slot', {});
      const pooledB = await resolveMediaDetailed('pool', poolAccount, 'stable-slot', {});
      assert.equal(pooledA.url, pooledB.url, 'pool selection must be deterministic for a slot');
      assert.equal(pooledA.source, 'pool');
      assert.equal((await resolveMediaDetailed('pool-empty', { platform: 'x', media: { strategy: 'pool', urls: [], qa: qaOff } }, 'slot', {})).decision, 'none');

      process.env.MEDIA_SERVICE_TOKEN = 'media-service-test-token';
      let endpointBody = null;
      globalThis.fetch = async (url, options = {}) => {
        assert.equal(String(url), 'https://media.example/api');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Authorization, 'Bearer media-service-test-token');
        endpointBody = JSON.parse(options.body);
        return jsonResponse({ url: 'https://cdn.example/generated.png', altText: 'generated alt', qa: { pass: true, score: 91 } });
      };
      const endpoint = await resolveMediaDetailed('endpoint-account', {
        platform: 'instagram',
        schedule: { timezone: 'UTC' },
        budgets: { enabled: false },
        media: { strategy: 'endpoint', type: 'image', endpoint: 'https://media.example/api', qa: qaOff }
      }, 'slot-endpoint', {
        text: 'caption', mediaPrompt: 'clean diagram', rationale: 'visual explanation', features: { mediaDecision: 'search', topic: 'testing' }
      });
      assert.equal(endpoint.url, 'https://cdn.example/generated.png');
      assert.equal(endpoint.decision, 'search');
      assert.equal(endpoint.source, 'endpoint');
      assert.equal(endpoint.altText, 'generated alt');
      assert.equal(endpoint.qa.score, 91);
      assert.equal(endpointBody.mode, 'search');
      assert.equal(endpointBody.mediaType, 'image');
      assert.equal(endpointBody.prompt, 'clean diagram');
      assert.match(await readFile(USAGE, 'utf8'), /"kind":"media"/);

      globalThis.fetch = async () => { throw new Error('network should not be needed for pool fallback'); };
      const searchFallback = await resolveMediaDetailed('auto-search', {
        platform: 'x', media: { strategy: 'auto', type: 'image', urls: ['https://cdn.example/library.png'], qa: qaOff }
      }, 'slot-search', { features: { mediaDecision: 'search' } });
      assert.equal(searchFallback.source, 'pool-fallback');
      assert.equal(searchFallback.decision, 'library');

      const libraryFallback = await resolveMediaDetailed('auto-library', {
        platform: 'x', media: { strategy: 'auto', type: 'image', urls: [], internalImageGeneration: true, qa: qaOff }
      }, 'slot-library', { features: { mediaDecision: 'library' } }, { dryRun: true });
      assert.equal(libraryFallback.source, 'dry-run-openai-image');
      assert.match(libraryFallback.url, /\.png$/);

      const instagramDefault = await resolveMediaDetailed('ig-default', {
        platform: 'instagram', media: { strategy: 'auto', type: 'image', defaultInstagramDecision: 'generate', internalImageGeneration: true, qa: qaOff }
      }, 'slot-instagram', { features: { mediaDecision: 'none' } }, { dryRun: true });
      assert.equal(instagramDefault.decision, 'generate');
      assert.equal(instagramDefault.source, 'dry-run-openai-image');

      await assert.rejects(
        resolveMediaDetailed('bad-endpoint', { platform: 'x', media: { strategy: 'endpoint', endpoint: 'http://insecure.example', qa: qaOff } }, 'slot', { features: { mediaDecision: 'generate' } }),
        /HTTPS media\.endpoint/
      );
      await assert.rejects(
        resolveMediaDetailed('unsupported', { platform: 'x', media: { strategy: 'mystery', qa: qaOff } }, 'slot', {}),
        /Unsupported media strategy/
      );
      assert.throws(() => ensureMediaForPlatform({ platform: 'instagram' }, null), /Instagram requires media/);
      assert.doesNotThrow(() => ensureMediaForPlatform({ platform: 'x' }, null));
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv(env);
    }
  });
});

test('X Reel publishing runs video download, initialize, append, finalize, processing, and post creation end-to-end', async () => {
  const previousFetch = globalThis.fetch;
  await withFiles([X_OAUTH2_STATE], async () => {
    await rm(X_OAUTH2_STATE, { force: true });
    const credential = {
      consumerKey: 'video-consumer', accessToken: 'video-oauth1-token',
      oauth2AccessToken: 'video-oauth2-token'
    };
    const calls = [];
    try {
      globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        calls.push({ target, options });
        if (target === 'https://cdn.example/video.mp4') {
          const bytes = Buffer.from('synthetic-video-bytes');
          return new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.byteLength) } });
        }
        if (target === 'https://api.x.com/2/media/upload/initialize') {
          assert.equal(options.headers.Authorization, 'Bearer video-oauth2-token');
          const payload = JSON.parse(options.body);
          assert.equal(payload.media_category, 'tweet_video');
          assert.equal(payload.media_type, 'video/mp4');
          assert.equal(payload.total_bytes, Buffer.byteLength('synthetic-video-bytes'));
          return jsonResponse({ data: { id: 'video-media-1' } });
        }
        if (target === 'https://api.x.com/2/media/upload/video-media-1/append') {
          assert.equal(options.headers.Authorization, 'Bearer video-oauth2-token');
          const payload = JSON.parse(options.body);
          assert.equal(payload.segment_index, 0);
          assert.ok(payload.media.length > 0);
          return jsonResponse({});
        }
        if (target === 'https://api.x.com/2/media/upload/video-media-1/finalize') {
          assert.equal(options.headers.Authorization, 'Bearer video-oauth2-token');
          return jsonResponse({ data: { processing_info: { state: 'succeeded' } } });
        }
        if (target === 'https://api.x.com/2/tweets') {
          assert.equal(options.headers.Authorization, 'Bearer video-oauth2-token');
          const payload = JSON.parse(options.body);
          assert.deepEqual(payload.media.media_ids, ['video-media-1']);
          assert.equal(payload.text, 'Video integration post');
          return jsonResponse({ data: { id: 'video-post-1', text: 'Video integration post' } });
        }
        throw new Error(`Unexpected mocked URL: ${target}`);
      };

      const result = await publishX({
        text: 'Video integration post', mediaUrl: 'https://cdn.example/video.mp4', mediaType: 'reel', credential
      });
      assert.equal(result.postId, 'video-post-1');
      assert.equal(result.text, 'Video integration post');
      assert.equal(calls.some((call) => call.target.endsWith('/initialize')), true);
      assert.equal(calls.some((call) => call.target.endsWith('/append')), true);
      assert.equal(calls.some((call) => call.target.endsWith('/finalize')), true);

      globalThis.fetch = async (url) => {
        if (String(url) === 'https://cdn.example/not-video') {
          return new Response(Buffer.from('image-ish'), { status: 200, headers: { 'content-type': 'image/png' } });
        }
        throw new Error(`Unexpected mocked URL: ${url}`);
      };
      await assert.rejects(
        publishX({ text: 'bad video', mediaUrl: 'https://cdn.example/not-video', mediaType: 'reel', credential }),
        /expected video media/
      );
      await assert.rejects(publishX({ credential }), /requires text or mediaUrl/);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test('Instagram Live Preflight validates identity, OpenAI models, and public hosting and blocks private hosting', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY');
  await withFiles([CONFIG], async () => {
    try {
      const config = JSON.parse(await readFile(CONFIG, 'utf8'));
      config.accounts['example-x'].enabled = false;
      config.accounts['example-x'].mode = 'pause';
      config.accounts['example-instagram'] = {
        ...config.accounts['example-instagram'],
        enabled: true,
        mode: 'auto',
        media: {
          strategy: 'auto', type: 'image', urls: [], endpoint: '',
          internalImageGeneration: true, defaultInstagramDecision: 'generate',
          qa: { enabled: true, model: 'gpt-5' }
        }
      };
      await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

      process.env.OPENAI_API_KEY = 'preflight-openai-key';
      process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
        'example-instagram': { accessToken: 'ig-access-token', igUserId: 'ig-user-123' }
      });
      delete process.env.GH_TOKEN;
      process.env.GITHUB_TOKEN = 'github-test-token';
      process.env.GITHUB_REPOSITORY = 'sunpotflower4460-cpu/SNS-AI';

      let privateRepo = false;
      let postAttempted = false;
      let publishLimitStatus = 200;
      globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target === 'https://api.openai.com/v1/moderations') {
          assert.equal(options.headers.Authorization, 'Bearer preflight-openai-key');
          return jsonResponse({ results: [{ flagged: false, categories: {} }] });
        }
        if (target === 'https://api.openai.com/v1/models/gpt-5') return jsonResponse({ id: 'gpt-5', owned_by: 'openai' });
        if (target === 'https://api.openai.com/v1/models/gpt-image-2') return jsonResponse({ id: 'gpt-image-2', owned_by: 'openai' });
        if (target === 'https://api.github.com/repos/sunpotflower4460-cpu/SNS-AI') {
          assert.equal(options.headers.Authorization, 'Bearer github-test-token');
          return jsonResponse({ private: privateRepo });
        }
        if (target === 'https://graph.instagram.com/v25.0/ig-user-123?fields=id,username,account_type') {
          assert.equal(options.headers.Authorization, 'Bearer ig-access-token');
          return jsonResponse({ id: 'ig-user-123', username: 'integration_ig', account_type: 'BUSINESS' });
        }
        if (target === 'https://graph.instagram.com/v25.0/ig-user-123/content_publishing_limit?fields=config,quota_usage') {
          assert.equal(options.headers.Authorization, 'Bearer ig-access-token');
          if (publishLimitStatus !== 200) {
            return jsonResponse({ error: { message: 'Please reduce the amount of data you\'re asking for', code: 1 } }, publishLimitStatus);
          }
          return jsonResponse({ data: [{ quota_usage: 3, config: { quota_total: 100 } }] });
        }
        if (target.includes('/media_publish') || target.endsWith('/media')) postAttempted = true;
        throw new Error(`Unexpected mocked URL: ${target}`);
      };

      const ready = await runLivePreflight({ accountFilter: 'example-instagram' });
      assert.equal(ready.ok, true);
      assert.equal(ready.state, 'ready');
      assert.equal(ready.openai.ok, true);
      assert.equal(ready.mediaHosting.checked, true);
      assert.equal(ready.mediaHosting.ok, true);
      assert.equal(ready.mediaHosting.private, false);
      assert.equal(ready.accounts[0].identity.username, 'integration_ig');
      assert.equal(ready.accounts[0].identity.accountType, 'BUSINESS');
      assert.deepEqual(ready.accounts[0].identity.publishAccess.quota, { used: 3, total: 100 });
      assert.equal(ready.accounts[0].builtInMedia.kind, 'image');
      assert.equal(ready.accounts[0].builtInMedia.hostingReady, true);
      assert.equal(postAttempted, false, 'preflight must never publish');

      privateRepo = true;
      const blocked = await runLivePreflight({ accountFilter: 'example-instagram' });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.state, 'blocked');
      assert.equal(blocked.mediaHosting.ok, false);
      assert.equal(blocked.mediaHosting.private, true);
      assert.match(blocked.mediaHosting.error, /public repository/);
      assert.equal(blocked.accounts[0].ok, false);
      privateRepo = false;

      // A publish-access probe failure that can't be classified as a missing scope (rate limit,
      // transient 5xx) must still block readiness - publishing capability was never actually proven -
      // without being misreported as "grant instagram_business_content_publish" when the operator
      // already has that permission and the real cause is unrelated.
      publishLimitStatus = 500;
      const publishAccessBlocked = await runLivePreflight({ accountFilter: 'example-instagram' });
      assert.equal(publishAccessBlocked.ok, false);
      assert.equal(publishAccessBlocked.accounts[0].ok, false);
      assert.match(publishAccessBlocked.accounts[0].error, /publish-access probe failed/);
      assert.equal(postAttempted, false, 'preflight must never publish');
    } finally {
      globalThis.fetch = previousFetch;
      restoreEnv(env);
    }
  });
});
