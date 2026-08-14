import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { naturalizationSettings, __test as naturalizeTest } from '../src/content/naturalize.mjs';
import { __test as httpTest } from '../src/lib/http.mjs';
import { __test as qaTest } from '../src/media/qa.mjs';

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));

test('naturalization preserves URLs and hashtags as protected authored tokens', () => {
  const original = '詳しくは https://example.com/a へ。#AI初心者 #今日の学び';
  assert.equal(naturalizeTest.preservesProtectedTokens(original, '詳しくは https://example.com/a へ。#AI初心者 #今日の学び でした。'), true);
  assert.equal(naturalizeTest.preservesProtectedTokens(original, '詳しくは別ページへ。#AI初心者'), false);
});

test('naturalization settings fail safe to bounded defaults instead of producing NaN gates', () => {
  const settings = naturalizationSettings({ generation: { naturalization: {
    minNaturalness: 'not-a-number', maxAiPatternRisk: 999, minVoiceFit: -1, maxIssues: 'bad'
  } } });
  assert.equal(settings.minNaturalness, 72);
  assert.equal(settings.maxAiPatternRisk, 45);
  assert.equal(settings.minVoiceFit, 68);
  assert.equal(settings.maxIssues, 6);
});

test('visual QA score threshold is retained as a soft target with bounded config', () => {
  assert.equal(qaTest.qaSettings({ media: { qa: { minScore: 82 } } }).minScore, 82);
  assert.equal(qaTest.qaSettings({ media: { qa: { minScore: 200 } } }).minScore, 75);
  assert.equal(qaTest.qaSettings({ media: { qa: { maxInputBytes: 'bad' } } }).maxInputBytes, 15 * 1024 * 1024);
});

test('DNS target validation rejects a normal-looking hostname that resolves privately', async () => {
  await assert.rejects(
    httpTest.assertPublicHttpsTarget('https://media.example.com/a.png', 'mediaUrl', async () => [{ address: '127.0.0.1', family: 4 }]),
    (error) => error?.code === 'UNSAFE_NETWORK_TARGET' && /non-public address/.test(error.message)
  );
});

test('DNS target validation accepts a hostname only when every returned address is public', async () => {
  const parsed = await httpTest.assertPublicHttpsTarget(
    'https://media.example.com/a.png',
    'mediaUrl',
    async () => [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]
  );
  assert.equal(parsed.hostname, 'media.example.com');
});

test('built-in video generation is paused by default while image generation remains enabled', async () => {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  assert.equal(config.defaults.media.internalImageGeneration, true);
  assert.equal(config.defaults.media.internalVideoGeneration, false);
  assert.equal(config.defaults.generation.naturalization.enabled, true);
});
