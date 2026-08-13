import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runAutopilot } from '../src/orchestrate.mjs';
import { VIDEOS_API_DEPRECATION_DATE } from '../src/media/openai-video.mjs';

// Regression coverage for: once the confirmed OpenAI Videos API shutdown date passes, an account whose
// Reel strategy UNCONDITIONALLY reaches built-in video generation (media.strategy: 'generate') was
// still paying for a full generatePost() call on every scheduled run before failing at
// PROVIDER_DEPRECATED deep inside media generation. Because autopilot.yml runs every 10 minutes and
// PROVIDER_DEPRECATED is excluded from the resilience circuit (by design - it must not open a real
// outage circuit for a permanent shutdown), nothing ever stopped this: the same due slot (and every
// future day's slot) would keep re-paying for text generation with zero chance of ever publishing.
// This test fails on the pre-fix code (generatePost is still called) and passes on the fix (the account
// fails fast at zero cost, before any OpenAI call).

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const DURABLE_DIR = fileURLToPath(new URL('../data/durable-claims/', import.meta.url));
const DATA_FILES = [
  fileURLToPath(new URL('../data/history.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/audit.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/state.json', import.meta.url)),
  fileURLToPath(new URL('../data/runtime-health.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage-state.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage.jsonl', import.meta.url))
];

function saveEnv(...names) { return Object.fromEntries(names.map((name) => [name, process.env[name]])); }
function restoreEnv(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
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
    if (bytes === null) await rm(path, { force: true }); else await writeFile(path, bytes);
  }
}

function account(strategy) {
  return {
    platform: 'instagram', enabled: true, mode: 'auto', credentialKey: 'deprecated-media-ig', displayName: 'Deprecated Media IG',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'test', schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5', maxChars: 2000, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 1, candidateCount: 1, maxOutputTokens: 1000 },
    safety: { moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false }, research: { webSearch: false, trendIntelligence: false },
    resilience: { enabled: true, failureThreshold: 3, cooldownMinutes: 60 },
    budgets: { enabled: false }, experiments: { enabled: false },
    media: { strategy, type: 'reel', internalVideoGeneration: true, videoModel: 'sora-2', videoSize: '720x1280', videoSeconds: 8, qa: { enabled: false } }
  };
}

async function installAccount(strategy) {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts['deprecated-media-ig'] = account(strategy);
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

const AFTER_SHUTDOWN = new Date(Date.parse(VIDEOS_API_DEPRECATION_DATE) + 86_400_000);

test('an account whose Reel strategy unconditionally reaches built-in video generation fails fast at zero cost once the Videos API shutdown date has passed', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installAccount('generate');
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'deprecated-media-ig': { accessToken: 'at', igUserId: 'ig' }
    });

    let anyCallMade = false;
    globalThis.fetch = async (url) => {
      anyCallMade = true;
      throw new Error(`No OpenAI/provider call should have been made, but one was attempted: ${String(url)}`);
    };

    const report = await runAutopilot({ accountFilter: 'deprecated-media-ig', force: true, dryRun: false, now: AFTER_SHUTDOWN });
    assert.equal(report[0].status, 'provider-deprecated', `expected an immediate provider-deprecated failure, got: ${JSON.stringify(report[0])}`);
    assert.equal(anyCallMade, false, 'the account must fail before ever calling generatePost() - zero paid API calls, not a failure deep inside generation');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});

test('an "auto" strategy Reel account is NOT pre-emptively blocked - it may still succeed via a non-video mediaDecision', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installAccount('auto');
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'deprecated-media-ig': { accessToken: 'at', igUserId: 'ig' }
    });

    // The AI-chosen candidate picks mediaDecision: 'none', so this run never even attempts built-in
    // video generation - an 'auto' account must still be given the chance to reach this outcome
    // instead of being hard-blocked purely because the strategy COULD have chosen 'generate'.
    let generateCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') {
        generateCalls += 1;
        return new Response(JSON.stringify({ output_text: JSON.stringify({ candidates: [{
          text: 'A post with no media.', mediaPrompt: '', rationale: 'auto strategy without video', spreadPotential: 55, noveltyPotential: 52,
          features: { topic: 'test', angle: 'a', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed: false }
        }] }) }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (target.startsWith('https://graph.instagram.com/') || target.startsWith('https://graph.facebook.com/')) {
        throw new Error(`Unexpected publish-path call for a text-only mediaDecision: ${target}`);
      }
      throw new Error(`Unexpected mocked URL: ${target} ${options.method || 'GET'}`);
    };

    const report = await runAutopilot({ accountFilter: 'deprecated-media-ig', force: true, dryRun: true, now: AFTER_SHUTDOWN });
    assert.notEqual(report[0].status, 'provider-deprecated', `'auto' must not be hard-blocked ahead of generation, got: ${JSON.stringify(report[0])}`);
    assert.equal(generateCalls, 1, 'an auto-strategy account must still be allowed to attempt generation');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});
