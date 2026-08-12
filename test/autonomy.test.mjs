import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveScheduleTimes } from '../src/lib/schedule.mjs';
import { validateDraftText } from '../src/lib/safety.mjs';
import { resolveMediaDetailed } from '../src/lib/media.mjs';
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

test('enabled Instagram auto account can rely on built-in image generation', () => {
  const config = {
    defaults: {
      timezone: 'Asia/Tokyo',
      generation: { historyWindow: 30, duplicateThreshold: 0.72, maxAttempts: 3, candidateCount: 5, maxOutputTokens: 3000 },
      learning: { strategyWindowDays: 60, matureCheckpointMinutes: 1440, fullConfidencePosts: 20 },
      resilience: { failureThreshold: 3, cooldownMinutes: 60 },
      budgets: { enabled: true, openaiCallsPerDay: 10, webSearchCallsPerDay: 2, mediaCallsPerDay: 2, imageGenerationsPerDay: 2 },
      experiments: { minSamplesPerVariant: 3, maxDays: 14, minimumStrategySamples: 6 },
      maintenance: { historyRetentionDays: 365, metricsRetentionDays: 120, usageRetentionDays: 90, auditRetentionDays: 180, quarantineRetentionDays: 30, generatedMediaRetentionDays: 90 },
      media: { internalImageGeneration: true, imageModel: 'gpt-image-2', imageSize: '1024x1024', imageQuality: 'medium', maxDownloadBytes: 1000, maxHostedImageBytes: 1000 }
    },
    accounts: {
      ig: {
        platform: 'instagram', enabled: true, mode: 'auto',
        schedule: { times: ['18:00'] },
        media: { strategy: 'auto', type: 'image', urls: [], endpoint: '' }
      }
    }
  };
  assert.deepEqual(validateConfig(config), []);
});

test('dry-run media generation never calls external endpoint or OpenAI image API', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network should not be called during media dry-run'); };
  try {
    const endpointAccount = { platform: 'instagram', media: { strategy: 'auto', type: 'image', endpoint: 'https://media.example/generate' } };
    const endpointResult = await resolveMediaDetailed('ig', endpointAccount, 'slot-1', { mediaPrompt: 'diagram', features: { mediaDecision: 'generate' } }, { dryRun: true });
    assert.equal(endpointResult.source, 'dry-run-endpoint');
    assert.match(endpointResult.url, /^https:\/\/dry-run\.invalid\//);

    const internalAccount = { platform: 'instagram', media: { strategy: 'auto', type: 'image', internalImageGeneration: true, defaultInstagramDecision: 'generate' } };
    const internalResult = await resolveMediaDetailed('ig', internalAccount, 'slot-2', { mediaPrompt: 'illustration', features: { mediaDecision: 'generate' } }, { dryRun: true });
    assert.equal(internalResult.source, 'dry-run-openai-image');
    assert.match(internalResult.url, /^https:\/\/dry-run\.invalid\//);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('repository source contains no obvious literal secrets', async () => {
  assert.deepEqual(await scanSecrets(), []);
});
