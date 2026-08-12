import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveScheduleTimes } from '../src/lib/schedule.mjs';
import { validateDraftText } from '../src/lib/safety.mjs';
import { resolveMediaDetailed } from '../src/lib/media.mjs';
import { correctedMediaPrompt } from '../src/media/qa.mjs';
import { anomalyTrigger, brakeSettings } from '../src/ops/brake.mjs';
import { assignmentForSlot } from '../src/experiments/engine.mjs';
import { scanSecrets } from '../src/ops/secret-scan.mjs';
import { validateConfig } from '../src/validate-config.mjs';

test('adaptive schedule stays inside human-provided candidate times', () => {
  const account = {
    schedule: { times: ['08:00', '20:00'], adaptiveCandidateTimes: ['08:00', '12:00', '20:00'] },
    learning: { adaptiveSchedule: true, adaptiveScheduleMinConfidence: 0.4, adaptiveScheduleKeepAtLeast: 1 }
  };
  const strategy = {
    confidence: 0.9,
    featureStats: { postingHour: {
      '08:00': { averageScore: 70, confidence: 0.8 },
      '12:00': { averageScore: 92, confidence: 0.8 },
      '20:00': { averageScore: 45, confidence: 0.8 }
    } }
  };
  assert.deepEqual(effectiveScheduleTimes(account, strategy), ['08:00', '12:00']);
});

test('adaptive schedule does nothing without approved candidate-time expansion', () => {
  const account = { schedule: { times: ['08:00', '20:00'] }, learning: { adaptiveSchedule: true } };
  assert.deepEqual(effectiveScheduleTimes(account, { confidence: 1, featureStats: {} }), ['08:00', '20:00']);
});

test('experiment assignments are deterministic and use both variants over many slots', () => {
  const experiment = { id: 'exp-1', status: 'active', dimension: 'hook', variants: ['question', 'statement'] };
  const first = assignmentForSlot(experiment, 'slot-1');
  assert.deepEqual(first, assignmentForSlot(experiment, 'slot-1'));
  const variants = new Set(Array.from({ length: 50 }, (_, i) => assignmentForSlot(experiment, `slot-${i}`)?.variant));
  assert.deepEqual([...variants].sort(), ['question', 'statement']);
});

test('safety rules enforce required disclosure and domain allowlist', () => {
  const account = {
    platform: 'x',
    generation: { maxChars: 280 },
    safety: { requiredAnyPhrases: ['PR', '広告'], allowedDomains: ['example.jp'], maxLinks: 1, maxHashtags: 2 }
  };
  assert.equal(validateDraftText(account, 'PR 新しい記事です https://shop.example.jp/item #AI'), 'PR 新しい記事です https://shop.example.jp/item #AI');
  assert.throws(() => validateDraftText(account, '新しい記事です https://shop.example.jp/item'), /required disclosure/);
  assert.throws(() => validateDraftText(account, '広告 https://other.example/item'), /non-allowlisted domain/);
});

function baseConfig() {
  return {
    defaults: {
      timezone: 'Asia/Tokyo',
      generation: { historyWindow: 30, duplicateThreshold: 0.72, maxAttempts: 3, candidateCount: 5, maxOutputTokens: 3000 },
      learning: { strategyWindowDays: 60, matureCheckpointMinutes: 1440, fullConfidencePosts: 20 },
      resilience: { failureThreshold: 3, cooldownMinutes: 60 },
      budgets: { enabled: true, openaiCallsPerDay: 10, webSearchCallsPerDay: 2, mediaCallsPerDay: 2, imageGenerationsPerDay: 2, videoGenerationsPerDay: 1 },
      experiments: { minSamplesPerVariant: 3, maxDays: 14, minimumStrategySamples: 6 },
      maintenance: { historyRetentionDays: 365, metricsRetentionDays: 120, usageRetentionDays: 90, auditRetentionDays: 180, quarantineRetentionDays: 30, generatedMediaRetentionDays: 90 },
      media: {
        internalImageGeneration: true, internalVideoGeneration: true,
        imageModel: 'gpt-image-1', imageSize: '1024x1024', imageQuality: 'medium',
        videoModel: 'sora-2', videoSize: '720x1280', videoSeconds: 8, videoTimeoutMinutes: 15, videoPollSeconds: 8,
        maxDownloadBytes: 1000, maxHostedImageBytes: 1000, maxHostedVideoBytes: 2000,
        qa: { enabled: true, minScore: 75, maxRegenerations: 1, maxInputBytes: 1000, detail: 'high' }
      }
    },
    accounts: {}
  };
}

test('enabled Instagram auto account can rely on built-in image generation', () => {
  const config = baseConfig();
  config.accounts.ig = {
    platform: 'instagram', enabled: true, mode: 'auto', schedule: { times: ['18:00'] },
    media: { strategy: 'auto', type: 'image', urls: [], endpoint: '' }
  };
  assert.deepEqual(validateConfig(config), []);
});

test('enabled Instagram Reel account can rely on built-in OpenAI video generation', () => {
  const config = baseConfig();
  config.accounts.reel = {
    platform: 'instagram', enabled: true, mode: 'auto', schedule: { times: ['18:00'] },
    media: { strategy: 'generate', type: 'reel', internalVideoGeneration: true, urls: [], endpoint: '' }
  };
  assert.deepEqual(validateConfig(config), []);
});

test('enabled X Reel account can rely on built-in OpenAI video generation', () => {
  const config = baseConfig();
  config.accounts.xreel = {
    platform: 'x', enabled: true, mode: 'auto', schedule: { times: ['18:00'] },
    media: { strategy: 'generate', type: 'reel', internalVideoGeneration: true, urls: [], endpoint: '' }
  };
  assert.deepEqual(validateConfig(config), []);
});

test('dry-run media generation never calls external endpoint, image API, or video API', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network should not be called during media dry-run'); };
  try {
    const endpointAccount = { platform: 'instagram', media: { strategy: 'auto', type: 'image', endpoint: 'https://media.example/generate' } };
    const endpointResult = await resolveMediaDetailed('ig', endpointAccount, 'slot-1', { mediaPrompt: 'diagram', features: { mediaDecision: 'generate' } }, { dryRun: true });
    assert.equal(endpointResult.source, 'dry-run-endpoint');

    const imageAccount = { platform: 'instagram', media: { strategy: 'auto', type: 'image', internalImageGeneration: true, defaultInstagramDecision: 'generate' } };
    const imageResult = await resolveMediaDetailed('ig', imageAccount, 'slot-2', { mediaPrompt: 'illustration', features: { mediaDecision: 'generate' } }, { dryRun: true });
    assert.equal(imageResult.source, 'dry-run-openai-image');
    assert.match(imageResult.url, /\.png$/);

    const reelAccount = { platform: 'instagram', media: { strategy: 'generate', type: 'reel', internalVideoGeneration: true } };
    const reelResult = await resolveMediaDetailed('reel', reelAccount, 'slot-3', { mediaPrompt: 'vertical short video', features: { mediaDecision: 'generate' } }, { dryRun: true });
    assert.equal(reelResult.source, 'dry-run-openai-video');
    assert.match(reelResult.url, /\.mp4$/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('media QA retry prompt preserves concept and includes only the reported correction', () => {
  const prompt = correctedMediaPrompt('A clean product photo', { correctionPrompt: 'Fix the garbled label text.' }, 1);
  assert.match(prompt, /A clean product photo/);
  assert.match(prompt, /Fix the garbled label text/);
  assert.match(prompt, /RETRY 1/);
});

test('anomaly brake ignores ordinary underperformance but catches severe collapse', () => {
  const cfg = brakeSettings({ safety: { anomalyBrake: { enabled: true } } });
  const normal = anomalyTrigger([{ row: { providerPostId: 'a' }, scored: { score: 40, confidence: 0.8, vector: { exposure: 2000, conversationRate: 0.01 }, baseline: { conversationRate: 0.008 } } }], cfg);
  assert.equal(normal.opened, false);

  const severe = anomalyTrigger([{ row: { providerPostId: 'b' }, scored: { score: 8, confidence: 0.9, vector: { exposure: 3000, conversationRate: 0.01 }, baseline: { conversationRate: 0.008 } } }], cfg);
  assert.equal(severe.opened, true);
  assert.equal(severe.reason, 'severe_performance_collapse');
});

test('repository source contains no obvious literal secrets', async () => {
  assert.deepEqual(await scanSecrets(), []);
});
