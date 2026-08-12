import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateAndHostImageDetailed } from '../src/media/openai-image.mjs';
import { generateAndHostVideoDetailed } from '../src/media/openai-video.mjs';
import { cleanupGeneratedAssets } from '../src/media/release-host.mjs';

const USAGE = fileURLToPath(new URL('../data/usage.jsonl', import.meta.url));
const USAGE_STATE = fileURLToPath(new URL('../data/usage-state.json', import.meta.url));

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
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

async function isolatedUsage(fn) {
  const paths = [USAGE, USAGE_STATE];
  const saved = new Map();
  for (const path of paths) saved.set(path, await snapshot(path));
  try {
    for (const path of paths) await rm(path, { force: true });
    return await fn();
  } finally {
    for (const path of paths.reverse()) await restore(path, saved.get(path));
  }
}

function mediaAccount(media = {}) {
  return {
    timezone: 'UTC', schedule: { timezone: 'UTC' }, budgets: { enabled: false },
    media: { qa: { enabled: true, maxRegenerations: 0 }, ...media }
  };
}

function installHostingEnv() {
  process.env.GH_TOKEN = 'generated-media-gh-token';
  delete process.env.GITHUB_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  process.env.GITHUB_REF_NAME = 'main';
  process.env.OPENAI_API_KEY = 'generated-media-openai-key';
}

function hostingRoutes(target) {
  if (target === 'https://api.github.com/repos/owner/repo') return jsonResponse({ private: false });
  if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') return jsonResponse({ id: 11, assets: [] });
  if (target === 'https://api.github.com/repos/owner/repo/releases/11/assets?per_page=100&page=1') return jsonResponse([]);
  return null;
}

test('built-in image generation fails closed when OpenAI returns no image bytes', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME');
  try {
    installHostingEnv();
    await isolatedUsage(async () => {
      let generationCalls = 0;
      globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        const hosted = hostingRoutes(target);
        if (hosted) return hosted;
        if (target === 'https://api.openai.com/v1/images/generations') {
          generationCalls += 1;
          assert.equal(options.method, 'POST');
          assert.equal(options.headers.Authorization, 'Bearer generated-media-openai-key');
          return jsonResponse({ data: [{}] });
        }
        throw new Error(`Unexpected mocked URL: ${target}`);
      };
      await assert.rejects(
        generateAndHostImageDetailed('image-failure', mediaAccount(), 'slot-image-failure', { text: 'post', mediaPrompt: 'a safe original diagram' }),
        /returned no base64 image/
      );
      assert.equal(generationCalls, 1);
      assert.match(await readFile(USAGE, 'utf8'), /"kind":"image"/);
    });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('built-in video generation fails closed immediately when the OpenAI job reports failed', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME');
  try {
    installHostingEnv();
    await isolatedUsage(async () => {
      let createCalls = 0;
      globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        const hosted = hostingRoutes(target);
        if (hosted) return hosted;
        if (target === 'https://api.openai.com/v1/videos?limit=100') return jsonResponse({ data: [] });
        if (target === 'https://api.openai.com/v1/videos' && options.method === 'POST') {
          createCalls += 1;
          assert.equal(options.headers.Authorization, 'Bearer generated-media-openai-key');
          return jsonResponse({ id: 'failed-video-job', status: 'failed', error: { message: 'Synthetic generation rejection' } });
        }
        throw new Error(`Unexpected mocked URL: ${target}`);
      };
      await assert.rejects(
        generateAndHostVideoDetailed('video-failure', mediaAccount({ videoSeconds: 4 }), 'slot-video-failure', { text: 'post', mediaPrompt: 'a safe short scene' }),
        /OpenAI video generation failed: Synthetic generation rejection/
      );
      assert.equal(createCalls, 1);
      assert.match(await readFile(USAGE, 'utf8'), /"kind":"video"/);
    });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('generated-media cleanup deletes only expired release assets and tolerates already-deleted assets', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY');
  try {
    process.env.GH_TOKEN = 'cleanup-token';
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    const deleted = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') {
        return jsonResponse({ id: 77 });
      }
      if (target === 'https://api.github.com/repos/owner/repo/releases/77/assets?per_page=100&page=1') {
        return jsonResponse([
          { id: 1, name: 'old-a.png', created_at: '2020-01-01T00:00:00.000Z' },
          { id: 2, name: 'old-b.mp4', created_at: '2020-01-02T00:00:00.000Z' },
          { id: 3, name: 'recent.png', created_at: new Date().toISOString() }
        ]);
      }
      if (target === 'https://api.github.com/repos/owner/repo/releases/assets/1' && options.method === 'DELETE') {
        deleted.push(1);
        return new Response(null, { status: 204 });
      }
      if (target === 'https://api.github.com/repos/owner/repo/releases/assets/2' && options.method === 'DELETE') {
        deleted.push(2);
        return new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    const result = await cleanupGeneratedAssets({ retentionDays: 30 });
    assert.deepEqual(deleted, [1, 2]);
    assert.deepEqual(result, { skipped: false, scanned: 3, deleted: 2 });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});
