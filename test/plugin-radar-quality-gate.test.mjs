import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { generatePost, __test as openaiTest } from '../src/lib/openai.mjs';
import { runAutopilot, hasFatalStatus, autopilotErrorStatus } from '../src/orchestrate.mjs';
import { getSlot, slotHandled } from '../src/lib/state.mjs';
import { circuitStatus } from '../src/ops/circuit.mjs';
import { readAudit } from '../src/lib/audit.mjs';

const { generationPrompt, PLUGIN_RADAR_CATEGORY_PRECISION_RULES } = openaiTest;

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const RUNTIME_POLICY_FILE = fileURLToPath(new URL('../config/runtime-policy.json', import.meta.url));
const DURABLE_DIR = fileURLToPath(new URL('../data/durable-claims/', import.meta.url));
const DATA_FILES = [
  'history.jsonl', 'metrics.jsonl', 'audit.jsonl', 'state.json', 'runtime-health.json',
  'brakes.json', 'usage-state.json', 'usage.jsonl'
].map((name) => fileURLToPath(new URL(`../data/${name}`, import.meta.url)));

function saveEnv(...names) { return Object.fromEntries(names.map((n) => [n, process.env[n]])); }
function restoreEnv(saved) { for (const [n, v] of Object.entries(saved)) v === undefined ? delete process.env[n] : process.env[n] = v; }
async function snapshotFiles(paths) {
  const saved = new Map();
  for (const path of paths) { try { saved.set(path, await readFile(path)); } catch (e) { if (e.code === 'ENOENT') saved.set(path, null); else throw e; } }
  return saved;
}
async function restoreFiles(saved) { for (const [path, bytes] of saved) { if (bytes === null) await rm(path, { force: true }); else await writeFile(path, bytes); } }

// -----------------------------------------------------------------------------------------------
// K: hasFatalStatus must never treat an intentional editorial No Post as a bug to alert on.
// -----------------------------------------------------------------------------------------------
test('K: hasFatalStatus does not flag "quality-no-post" as fatal', () => {
  assert.equal(hasFatalStatus([{ status: 'quality-no-post' }]), false);
  assert.equal(hasFatalStatus([{ status: 'published' }, { status: 'quality-no-post' }]), false);
});

test('autopilotErrorStatus maps CONTENT_QUALITY_BELOW_THRESHOLD to its own distinct status', () => {
  const error = new Error('low score'); error.code = 'CONTENT_QUALITY_BELOW_THRESHOLD';
  assert.equal(autopilotErrorStatus(error), 'quality-no-post');
});

// -----------------------------------------------------------------------------------------------
// L/M: Plugin Radar category-precision rules only apply to contentStrategy === 'plugin-radar'.
// -----------------------------------------------------------------------------------------------
test('L: generationPrompt injects Plugin Radar category-precision rules for contentStrategy "plugin-radar"', () => {
  const account = { platform: 'x', contentStrategy: 'plugin-radar', profile: {}, generation: {} };
  const prompt = generationPrompt('music-tools-x', account, [], {}, '');
  for (const rule of PLUGIN_RADAR_CATEGORY_PRECISION_RULES) assert.ok(prompt.system.includes(rule), `missing rule: ${rule}`);
});

test('M: generationPrompt does not inject Plugin Radar rules for other accounts', () => {
  const account = { platform: 'x', contentStrategy: 'artist-support', profile: {}, generation: {} };
  const prompt = generationPrompt('some-other-account', account, [], {}, '');
  assert.equal(prompt.system.includes(PLUGIN_RADAR_CATEGORY_PRECISION_RULES[0]), false);
  const noStrategyAccount = { platform: 'x', profile: {}, generation: {} };
  const prompt2 = generationPrompt('example-x', noStrategyAccount, [], {}, '');
  assert.equal(prompt2.system.includes(PLUGIN_RADAR_CATEGORY_PRECISION_RULES[0]), false);
});

// -----------------------------------------------------------------------------------------------
// N/O: the config change is scoped to music-tools-x only; every other account/posture is untouched.
// -----------------------------------------------------------------------------------------------
test('N: music-tools-x config sets minPredictedScore=35 and lowScoreRetryCount=1', async () => {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  const generation = config.accounts['music-tools-x'].generation;
  assert.equal(generation.minPredictedScore, 35);
  assert.equal(generation.lowScoreRetryCount, 1);
  assert.equal(config.defaults.generation?.minPredictedScore, undefined, 'the floor must not become a global default');
});

test('O: Manual-Only posture and every other account remain untouched', async () => {
  const runtimePolicy = JSON.parse(await readFile(RUNTIME_POLICY_FILE, 'utf8'));
  assert.equal(runtimePolicy.manualOnly, true);
  assert.equal(runtimePolicy.requireExplicitManualInvocation, true);
  assert.equal(runtimePolicy.allowAutomaticAccountActivation, false);
  assert.equal(runtimePolicy.allowAutomaticEngagement, false);
  assert.equal(runtimePolicy.allowScheduledProviderPolling, false);

  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  const musicToolsX = config.accounts['music-tools-x'];
  assert.equal(musicToolsX.enabled, true);
  assert.equal(musicToolsX.mode, 'approval');
  const others = Object.entries(config.accounts).filter(([id]) => id !== 'music-tools-x');
  assert.equal(others.length, 7, 'expected exactly 7 other accounts');
  for (const [id, account] of others) {
    assert.equal(account.enabled, false, `${id} must stay disabled`);
    assert.equal(account.mode, 'pause', `${id} must stay paused`);
    assert.equal(account.generation?.minPredictedScore, undefined, `${id} must not inherit the Plugin Radar quality floor`);
  }
});

// -----------------------------------------------------------------------------------------------
// A-G: generatePost()'s low-score gate, in isolation.
// -----------------------------------------------------------------------------------------------
function qualityGateAccount(overrides = {}) {
  return {
    platform: 'x', contentStrategy: 'plugin-radar',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    safety: { moderation: false, maxLinks: 1, maxHashtags: 2 },
    generation: { model: 'gpt-5.6-luna', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 3, candidateCount: 1, maxOutputTokens: 1000 },
    learning: { enabled: false, exploreRate: 0 },
    research: { webSearch: false },
    budgets: { enabled: false },
    ...overrides
  };
}

function candidateResponse(text, spreadPotential, noveltyPotential) {
  return { output_text: JSON.stringify({ candidates: [{
    text, mediaPrompt: '', rationale: 'quality gate coverage', spreadPotential, noveltyPotential,
    features: { topic: 'test', angle: 'gate', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed: false }
  }] }) };
}

// With explore forced off (learning.exploreRate: 0) and no learned strategy, rankCandidates()'s formula
// is exactly spreadPotential*0.55 + 50*0.40 + noveltyPotential*0.05 (see src/lib/strategy-rank.mjs) -
// these helpers pick spread/novelty pairs that land on a clean predictedScore for deterministic tests.
const LOW = { spreadPotential: 10, noveltyPotential: 10 }; // -> predictedScore 26.0
const AT_30 = { spreadPotential: 10, noveltyPotential: 90 }; // -> predictedScore 30.0 exactly
const HIGH = { spreadPotential: 50, noveltyPotential: 50 }; // -> predictedScore 50.0

async function withMockedGeneration(responses, fn) {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  let calls = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target === 'https://api.openai.com/v1/responses') {
      const response = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target === 'https://api.openai.com/v1/moderations') {
      return new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected mocked URL: ${target}`);
  };
  try { return await fn(() => calls); }
  finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey; }
}

test('A: minPredictedScore unset behaves exactly as before (no gate at all)', async () => {
  const account = qualityGateAccount({ generation: { ...qualityGateAccount().generation } });
  await withMockedGeneration([candidateResponse('Low score but unset floor.', LOW.spreadPotential, LOW.noveltyPotential)], async (calls) => {
    const result = await generatePost('music-tools-x', account, [], {});
    assert.equal(result.text, 'Low score but unset floor.');
    assert.equal(calls(), 1, 'no retry when there is no floor to miss');
  });
});

test('B: predictedScore exactly at the threshold passes', async () => {
  const account = qualityGateAccount({ generation: { ...qualityGateAccount().generation, minPredictedScore: 30, lowScoreRetryCount: 1 } });
  await withMockedGeneration([candidateResponse('Exactly at floor.', AT_30.spreadPotential, AT_30.noveltyPotential)], async (calls) => {
    const result = await generatePost('music-tools-x', account, [], {});
    assert.equal(result.predictedScore, 30.0);
    assert.equal(result.text, 'Exactly at floor.');
    assert.equal(calls(), 1);
  });
});

test('C: predictedScore above the threshold passes', async () => {
  const account = qualityGateAccount({ generation: { ...qualityGateAccount().generation, minPredictedScore: 30, lowScoreRetryCount: 1 } });
  await withMockedGeneration([candidateResponse('Above floor.', HIGH.spreadPotential, HIGH.noveltyPotential)], async (calls) => {
    const result = await generatePost('music-tools-x', account, [], {});
    assert.equal(result.predictedScore, 50.0);
    assert.equal(calls(), 1);
  });
});

test('D: a low first attempt gets exactly one regeneration chance, and a passing second attempt is returned', async () => {
  const account = qualityGateAccount({ generation: { ...qualityGateAccount().generation, minPredictedScore: 35, lowScoreRetryCount: 1 } });
  await withMockedGeneration([
    candidateResponse('Weak first draft.', LOW.spreadPotential, LOW.noveltyPotential),
    candidateResponse('Stronger second draft.', HIGH.spreadPotential, HIGH.noveltyPotential)
  ], async (calls) => {
    const result = await generatePost('music-tools-x', account, [], {});
    assert.equal(result.text, 'Stronger second draft.');
    assert.equal(result.predictedScore, 50.0);
    assert.equal(result.qualityRetriesUsed, 1);
    assert.equal(calls(), 2, 'exactly one regeneration call, not more');
  });
});

test('E/F: two low attempts in a row (retry budget of 1) reject as CONTENT_QUALITY_BELOW_THRESHOLD without publishing anything', async () => {
  const account = qualityGateAccount({ generation: { ...qualityGateAccount().generation, maxAttempts: 3, minPredictedScore: 35, lowScoreRetryCount: 1 } });
  await withMockedGeneration([
    candidateResponse('Weak first draft.', LOW.spreadPotential, LOW.noveltyPotential),
    candidateResponse('Still weak second draft.', LOW.spreadPotential, LOW.noveltyPotential),
    candidateResponse('Would have been a third draft.', HIGH.spreadPotential, HIGH.noveltyPotential)
  ], async (calls) => {
    await assert.rejects(generatePost('music-tools-x', account, [], {}), (error) => {
      assert.equal(error.code, 'CONTENT_QUALITY_BELOW_THRESHOLD');
      assert.equal(error.predictedScore, 26.0);
      assert.equal(error.requiredScore, 35);
      assert.equal(error.qualityRetriesUsed, 1, 'the low-score retry budget (lowScoreRetryCount:1) was spent exactly once');
      return true;
    });
    // Even though maxAttempts allows a 3rd call, the retry budget (lowScoreRetryCount:1) is exhausted
    // after the 2nd - it must never spend a 3rd paid attempt chasing the score alone.
    assert.equal(calls(), 2, 'must not consume a 3rd attempt once the low-score retry budget is exhausted');
  });
});

test('G: an oversized lowScoreRetryCount still never exceeds maxAttempts worth of API calls', async () => {
  const account = qualityGateAccount({ generation: { ...qualityGateAccount().generation, maxAttempts: 2, minPredictedScore: 35, lowScoreRetryCount: 5 } });
  await withMockedGeneration([
    candidateResponse('Low 1.', LOW.spreadPotential, LOW.noveltyPotential),
    candidateResponse('Low 2.', LOW.spreadPotential, LOW.noveltyPotential)
  ], async (calls) => {
    await assert.rejects(generatePost('music-tools-x', account, [], {}), (error) => {
      assert.equal(error.code, 'CONTENT_QUALITY_BELOW_THRESHOLD');
      return true;
    });
    assert.equal(calls(), 2, 'must be bounded by maxAttempts (2), never by the larger lowScoreRetryCount (5)');
  });
});

// -----------------------------------------------------------------------------------------------
// H/I/J: orchestrate.mjs's handling of CONTENT_QUALITY_BELOW_THRESHOLD end-to-end.
// -----------------------------------------------------------------------------------------------
function baseQualityAccount(overrides = {}) {
  return {
    platform: 'x', enabled: true, mode: 'auto', credentialKey: 'quality-gate-x', displayName: 'Quality Gate X',
    contentStrategy: 'plugin-radar',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5.6-luna', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 3, candidateCount: 1, maxOutputTokens: 1000, minPredictedScore: 35, lowScoreRetryCount: 1 },
    safety: { moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false, exploreRate: 0, humanFeedbackWindow: 5 },
    research: { webSearch: false, trendIntelligence: false },
    resilience: { enabled: true, failureThreshold: 5, cooldownMinutes: 60 },
    budgets: { enabled: false }, experiments: { enabled: false }, media: { strategy: 'none', type: 'image' },
    ...overrides
  };
}

async function installQualityAccount(accountId, overrides) {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts[accountId] = baseQualityAccount({ credentialKey: accountId, displayName: accountId, ...overrides });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function alwaysLowGenerationFetch({ onIssuesGet, onIssuesPost } = {}) {
  return async (url, options = {}) => {
    const target = String(url);
    if (target === 'https://api.openai.com/v1/responses') {
      return new Response(JSON.stringify({ output_text: JSON.stringify({ candidates: [{
        text: 'Persistently weak draft.', mediaPrompt: '', rationale: 'always low', spreadPotential: 10, noveltyPotential: 10,
        features: { topic: 't', angle: 'a', hook: 'h', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed: false }
      }] }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // When GITHUB_TOKEN/GITHUB_REPOSITORY are set (needed for the approval-issue check below),
    // src/lib/state.mjs's slotHandled() falls through to src/lib/durable-claim.mjs's remote check for
    // any slot not already terminal in LOCAL state.json - a 404 here is the real GitHub API's own way of
    // saying "no durable claim exists yet", not an error.
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/data\/durable-claims\//.test(target)) {
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/issues\?/.test(target) && (options.method || 'GET') === 'GET') {
      if (onIssuesGet) onIssuesGet();
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/issues$/.test(target) && options.method === 'POST') {
      if (onIssuesPost) onIssuesPost();
      return new Response(JSON.stringify({ number: 1 }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/labels\//.test(target)) {
      return new Response(JSON.stringify({}), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected mocked URL: ${target} (${options.method || 'GET'})`);
  };
}

test('H: quality-no-post never opens the resilience circuit', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installQualityAccount('quality-gate-circuit', { mode: 'auto' });
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({});
    globalThis.fetch = alwaysLowGenerationFetch();

    const report = await runAutopilot({ accountFilter: 'quality-gate-circuit', force: true, dryRun: false, now: new Date('2026-08-13T00:00:00+09:00') });
    assert.equal(report[0].status, 'quality-no-post');

    const status = await circuitStatus('quality-gate-circuit', 'autopilot', { enabled: true, failureThreshold: 5, cooldownMinutes: 60 });
    assert.equal(status.open, false);
    assert.equal(Number(status.failures || 0), 0, 'a quality-gated No Post must never increment the autopilot circuit failure count');

    const audit = await readAudit();
    const qualityRow = audit.find((row) => row.account === 'quality-gate-circuit' && row.stage === 'candidate-quality-no-post');
    assert.ok(qualityRow, 'a dedicated candidate-quality-no-post audit row must be recorded');
    assert.equal(qualityRow.requiredScore, 35);
    assert.equal(qualityRow.qualityRetriesUsed, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});

test('I: a dry-run quality-no-post never changes slot state', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installQualityAccount('quality-gate-dry-run', { mode: 'auto' });
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({});
    globalThis.fetch = alwaysLowGenerationFetch();

    const now = new Date('2026-08-13T00:00:00+09:00');
    const report = await runAutopilot({ accountFilter: 'quality-gate-dry-run', force: true, dryRun: true, now });
    assert.equal(report[0].status, 'quality-no-post');

    const slotId = `quality-gate-dry-run:manual:${now.toISOString().slice(0, 16)}`;
    const slot = await getSlot(slotId);
    assert.equal(slot, null, 'dry-run must never persist any slot state, not even a terminal skip');
    assert.equal(await slotHandled(slotId), false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});

test('J: a live approval-mode quality-no-post creates no approval issue and terminally skips the slot', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installQualityAccount('quality-gate-approval', { mode: 'approval' });
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({});
    process.env.GITHUB_TOKEN = 'test-github-token';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    let issuesPosted = 0;
    globalThis.fetch = alwaysLowGenerationFetch({ onIssuesPost: () => { issuesPosted += 1; } });

    // A real 10-minute scheduled poll uses force:false and the SAME due slot (schedule.times, matched
    // by findDueSlots) on every run within its windowMinutes - not force:true's synthetic ":manual:"
    // slotId, which exists to let an operator dispatch on demand and deliberately bypasses the
    // slotHandled() idempotency check below. now=08:05 sits inside the 08:00 slot's 30-minute window.
    const now = new Date('2026-08-13T08:05:00+09:00');
    const report = await runAutopilot({ accountFilter: 'quality-gate-approval', force: false, dryRun: false, now });
    assert.equal(report[0].status, 'quality-no-post');
    assert.equal(issuesPosted, 0, 'no approval issue may be created for a quality-gated No Post');

    const slotId = report[0].slot;
    assert.match(slotId, /^quality-gate-approval:2026-08-13:08:00$/);
    const slot = await getSlot(slotId);
    assert.equal(slot?.status, 'skipped');
    assert.equal(await slotHandled(slotId), true);

    // Terminal means terminal: the SAME due slot polled again 10 minutes later (still force:false,
    // still inside the window) must not re-pay for generation - this is the actual production concern
    // (autopilot.yml runs every 10 minutes without --force).
    let secondRunGenerationCalls = 0;
    globalThis.fetch = async (url, options) => {
      if (String(url) === 'https://api.openai.com/v1/responses') { secondRunGenerationCalls += 1; }
      return alwaysLowGenerationFetch()(url, options);
    };
    const secondReport = await runAutopilot({ accountFilter: 'quality-gate-approval', force: false, dryRun: false, now });
    assert.equal(secondReport[0].status, 'already-handled');
    assert.equal(secondRunGenerationCalls, 0, 'a terminally-skipped slot must not trigger another paid generation call');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});
