import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ensureMediaForPlatform, resolveMedia, resolveMediaDetailed } from '../src/lib/media.mjs';

const USAGE_FILES = [
  fileURLToPath(new URL('../data/usage-state.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage.jsonl', import.meta.url))
];

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

const draft = (mediaDecision = 'none') => ({
  text: 'post text', mediaPrompt: 'visual prompt', rationale: 'test', features: { mediaDecision }
});
const qaOff = { enabled: false };

test('media resolver covers fixed, pool, endpoint, generate, auto fallbacks, and platform requirements', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('MEDIA_SERVICE_TOKEN');
  const savedFiles = await snapshotFiles(USAGE_FILES);
  try {
    for (const path of USAGE_FILES) await rm(path, { force: true });

    assert.deepEqual(await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'none', qa: qaOff } }, 's', draft()), {
      url: null, decision: 'none', source: null, altText: '', qa: null
    });

    const fixed = await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'fixed', url: 'https://media.example/fixed.png', altText: 'x'.repeat(1100), qa: qaOff } }, 's', draft());
    assert.equal(fixed.url, 'https://media.example/fixed.png');
    assert.equal(fixed.decision, 'library');
    assert.equal(fixed.source, 'fixed');
    assert.equal(fixed.altText.length, 1000);
    assert.equal((await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'external', qa: qaOff } }, 's', draft())).decision, 'none');

    const poolAccount = { platform: 'x', media: { strategy: 'pool', urls: ['https://media.example/a.png', 'https://media.example/b.png'], qa: qaOff } };
    const pool1 = await resolveMediaDetailed('a', poolAccount, 'stable-slot', draft());
    const pool2 = await resolveMediaDetailed('a', poolAccount, 'stable-slot', draft());
    assert.equal(pool1.url, pool2.url);
    assert.equal(pool1.decision, 'library');
    assert.equal((await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'pool', urls: [], qa: qaOff } }, 's', draft())).decision, 'none');

    const endpointBase = {
      platform: 'x', budgets: { enabled: false },
      media: { strategy: 'endpoint', type: 'image', endpoint: 'https://media-service.example/generate', qa: qaOff }
    };
    const drySearch = await resolveMediaDetailed('a', endpointBase, 's', draft('search'), { dryRun: true });
    assert.equal(drySearch.url, 'https://dry-run.invalid/search.png');
    assert.equal(drySearch.source, 'dry-run-endpoint');
    const dryDefault = await resolveMediaDetailed('a', endpointBase, 's', draft('unexpected'), { dryRun: true });
    assert.equal(dryDefault.decision, 'generate');

    process.env.MEDIA_SERVICE_TOKEN = 'media-token';
    let endpointMode = 'success';
    globalThis.fetch = async (url, options = {}) => {
      assert.equal(String(url), 'https://media-service.example/generate');
      assert.equal(options.headers.Authorization, 'Bearer media-token');
      const body = JSON.parse(options.body);
      assert.equal(body.account, 'a');
      assert.equal(body.slotId, 'slot-real');
      if (endpointMode === 'http-error') return new Response(JSON.stringify({ error: 'provider down' }), { status: 503, headers: { 'content-type': 'application/json' } });
      if (endpointMode === 'bad-url') return new Response(JSON.stringify({ url: 'http://insecure.example/x.png' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ url: 'https://cdn.example/generated.png', altText: 'generated alt', qa: { pass: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const endpointReal = await resolveMediaDetailed('a', endpointBase, 'slot-real', draft('search'));
    assert.equal(endpointReal.url, 'https://cdn.example/generated.png');
    assert.equal(endpointReal.decision, 'search');
    assert.equal(endpointReal.altText, 'generated alt');
    assert.equal(endpointReal.qa.pass, true);

    endpointMode = 'http-error';
    await assert.rejects(resolveMediaDetailed('a', endpointBase, 'slot-real', draft('search')), /provider down/);
    endpointMode = 'bad-url';
    await assert.rejects(resolveMediaDetailed('a', endpointBase, 'slot-real', draft('search')), /must return/);
    await assert.rejects(resolveMediaDetailed('a', { platform: 'x', budgets: { enabled: false }, media: { strategy: 'endpoint', endpoint: 'http://bad.example', qa: qaOff } }, 'slot-real', draft()), /HTTPS media\.endpoint/);

    const endpointGenerate = await resolveMediaDetailed('a', { ...endpointBase, media: { ...endpointBase.media, strategy: 'generate' } }, 's', draft('generate'), { dryRun: true });
    assert.equal(endpointGenerate.source, 'dry-run-endpoint');

    const generatedImage = await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'generate', type: 'image', qa: qaOff } }, 's', draft('generate'), { dryRun: true });
    assert.equal(generatedImage.url, 'https://dry-run.invalid/generate.png');
    assert.equal(generatedImage.source, 'dry-run-openai-image');
    const generatedVideo = await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'generate', type: 'reel', qa: qaOff } }, 's', draft('generate'), { dryRun: true });
    assert.equal(generatedVideo.url, 'https://dry-run.invalid/generate.mp4');
    assert.equal(generatedVideo.source, 'dry-run-openai-video');
    assert.equal((await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'generate', type: 'image', internalImageGeneration: false, qa: qaOff } }, 's', draft())).decision, 'none');
    assert.equal((await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'generate', type: 'reel', internalVideoGeneration: false, qa: qaOff } }, 's', draft())).decision, 'none');

    const autoNone = await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'auto', qa: qaOff } }, 's', draft('none'), { dryRun: true });
    assert.equal(autoNone.decision, 'none');
    const autoInstagram = await resolveMediaDetailed('a', { platform: 'instagram', media: { strategy: 'auto', type: 'image', qa: qaOff } }, 's', draft('none'), { dryRun: true });
    assert.equal(autoInstagram.decision, 'generate');
    assert.equal(autoInstagram.source, 'dry-run-openai-image');

    const autoLibrary = await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'auto', urls: ['https://media.example/library.png'], qa: qaOff } }, 's', draft('library'), { dryRun: true });
    assert.equal(autoLibrary.source, 'pool');
    const autoLibraryFallback = await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'auto', type: 'image', urls: [], qa: qaOff } }, 's', draft('library'), { dryRun: true });
    assert.equal(autoLibraryFallback.source, 'dry-run-openai-image');

    const autoSearchEndpoint = await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'auto', type: 'reel', endpoint: 'https://media-service.example/generate', qa: qaOff } }, 's', draft('search'), { dryRun: true });
    assert.equal(autoSearchEndpoint.url, 'https://dry-run.invalid/search.mp4');
    const autoSearchPool = await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'auto', urls: ['https://media.example/fallback.png'], qa: qaOff } }, 's', draft('search'), { dryRun: true });
    assert.equal(autoSearchPool.source, 'pool-fallback');
    assert.equal(autoSearchPool.decision, 'library');
    const autoSearchGenerate = await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'auto', type: 'image', qa: qaOff } }, 's', draft('search'), { dryRun: true });
    assert.equal(autoSearchGenerate.source, 'dry-run-openai-image');
    const autoGenerate = await resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'auto', type: 'reel', qa: qaOff } }, 's', draft('generate'), { dryRun: true });
    assert.equal(autoGenerate.source, 'dry-run-openai-video');

    assert.equal(await resolveMedia('a', { platform: 'x', media: { strategy: 'fixed', url: 'https://media.example/wrapper.png', qa: qaOff } }, 's', draft()), 'https://media.example/wrapper.png');
    await assert.rejects(resolveMediaDetailed('a', { platform: 'x', media: { strategy: 'unknown', qa: qaOff } }, 's', draft()), /Unsupported media strategy/);

    assert.doesNotThrow(() => ensureMediaForPlatform({ platform: 'x' }, null));
    assert.doesNotThrow(() => ensureMediaForPlatform({ platform: 'instagram' }, 'https://media.example/ok.png'));
    assert.throws(() => ensureMediaForPlatform({ platform: 'instagram' }, null), /Instagram requires media/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(savedFiles);
  }
});
