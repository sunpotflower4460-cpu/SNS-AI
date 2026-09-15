import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { generatePost } from '../src/lib/openai.mjs';
import { runAutopilot } from '../src/orchestrate.mjs';
import { readAudit } from '../src/lib/audit.mjs';

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const RUNTIME_POLICY_FILE = fileURLToPath(new URL('../config/runtime-policy.json', import.meta.url));
const BUDGET_POLICY_FILE = fileURLToPath(new URL('../config/budget-policy.json', import.meta.url));
const DURABLE_DIR = fileURLToPath(new URL('../data/durable-claims/', import.meta.url));
const DATA_FILE_NAMES = ['history.jsonl', 'metrics.jsonl', 'audit.jsonl', 'state.json', 'runtime-health.json', 'brakes.json', 'usage-state.json', 'usage.jsonl'];
const DATA_FILES = DATA_FILE_NAMES.map((name) => fileURLToPath(new URL(`../data/${name}`, import.meta.url)));

function saveEnv(...names) { return Object.fromEntries(names.map((n) => [n, process.env[n]])); }
function restoreEnv(saved) { for (const [n, v] of Object.entries(saved)) v === undefined ? delete process.env[n] : process.env[n] = v; }
async function snapshotFiles(paths) {
  const saved = new Map();
  for (const path of paths) { try { saved.set(path, await readFile(path)); } catch (e) { if (e.code === 'ENOENT') saved.set(path, null); else throw e; } }
  return saved;
}
async function restoreFiles(saved) { for (const [path, bytes] of saved) { if (bytes === null) await rm(path, { force: true }); else await writeFile(path, bytes); } }

// The exact real SNS Autopilot #338 scenario (Issue #98): the winning candidate is "FRCTL Audio GRN
// 4.0", correctly bound (via trendEvidenceIndex) to its own Rekkerd article, but the model's Web Search
// citations also included an entirely unrelated product ("Polarity Glue") that ended up in the published
// payload.sources anyway - a provenance-contamination bug, not a missing-evidence bug like the earlier
// "OXO Steps" case this same file's evidence-binding tests already cover.
const TREND_BRIEF = {
  account: 'music-tools-x', generatedAt: new Date().toISOString(), summary: 'test brief',
  items: [
    { topic: 'FRCTL Audio GRN 4.0：新エンジン搭載のグラニュラーエフェクト更新', whyNow: 'now', angle: 'update', relevance: 90, novelty: 80, url: 'https://rekkerd.org/frctl-audio-updates-grn-granular-effect-to-v4-0-0-incl-new-engine/', sourceId: 'rekkerd' },
    { topic: 'SKR4CH waveform designer', whyNow: 'now', angle: 'a', relevance: 80, novelty: 70, url: 'https://vendor.example/skr4ch', sourceId: 'bpb' },
    { topic: 'KVEIK', whyNow: 'now', angle: 'c', relevance: 80, novelty: 70, url: 'https://vendor.example/kveik', sourceId: 'rekkerd' }
  ],
  sources: []
};
const GRN_INDEX = 0;
const GRN_URL = TREND_BRIEF.items[GRN_INDEX].url;
const POLARITY_GLUE_URL = 'https://polarity.productions/polarity-glue/?utm_source=openai';

function pluginRadarAccount(overrides = {}) {
  return {
    platform: 'x', contentStrategy: 'plugin-radar', research: { webSearch: true },
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    safety: { moderation: false, maxLinks: 1, maxHashtags: 2 },
    generation: { model: 'gpt-5.6-luna', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 3, candidateCount: 1, maxOutputTokens: 1000 },
    learning: { enabled: false, exploreRate: 0 },
    budgets: { enabled: false },
    ...overrides
  };
}

function grnCandidateResponse() {
  const base = {
    candidates: [{
      text: 'FRCTL Audio GRN 4.0 post.', mediaPrompt: '', rationale: 'source contamination regression coverage',
      spreadPotential: 60, noveltyPotential: 60,
      features: { topic: 'FRCTL Audio GRN 4.0', angle: 'update', hook: 'new engine', emotion: 'anticipation', format: 'update', cta: 'check the changelog', mediaDecision: 'none', trendUsed: true, trendEvidenceIndex: GRN_INDEX }
    }]
  };
  const outputText = JSON.stringify(base);
  return {
    output_text: outputText,
    output: [{ type: 'message', content: [{ type: 'output_text', text: outputText, annotations: [
      { type: 'url_citation', url: GRN_URL, title: 'FRCTL Audio GRN 4.0' },
      { type: 'url_citation', url: POLARITY_GLUE_URL, title: 'Polarity Glue' }
    ] }] }]
  };
}

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

// -----------------------------------------------------------------------------------------------
// generatePost()-level reproduction of the exact #338 scenario.
// -----------------------------------------------------------------------------------------------
test('#338 reproduction: winner=FRCTL Audio GRN, correctly bound to its own article, but the model also cited an unrelated "Polarity Glue" URL - final sources must contain the GRN article only', async () => {
  const account = pluginRadarAccount();
  await withMockedGeneration([grnCandidateResponse()], async (calls) => {
    const result = await generatePost('music-tools-x', account, [], { trends: TREND_BRIEF });
    assert.equal(result.text, 'FRCTL Audio GRN 4.0 post.');
    assert.equal(result.features.trendEvidenceUrl, GRN_URL, 'the winner is still correctly bound to its own GRN evidence');
    assert.deepEqual(result.sources.map((s) => s.url), [GRN_URL], 'sources must be exactly [GRN article] - the unrelated Polarity Glue citation must never appear');
    assert.ok(!result.sources.some((s) => s.url === POLARITY_GLUE_URL), 'the unrelated Polarity Glue URL must never leak into sources');
    assert.equal(calls(), 1, 'no extra AI call needed');
  });
});

test('boundEvidenceCount and the resulting source count are consistent: exactly 1 bound evidence -> exactly 1 source', async () => {
  const account = pluginRadarAccount();
  await withMockedGeneration([grnCandidateResponse()], async () => {
    const result = await generatePost('music-tools-x', account, [], { trends: TREND_BRIEF });
    const boundEvidenceCount = result.features?.trendEvidenceUrl ? 1 : 0;
    assert.equal(boundEvidenceCount, 1);
    assert.equal(result.sources.length, boundEvidenceCount, 'sourceCount must equal boundEvidenceCount for a Plugin Radar trendUsed:true candidate');
  });
});

test('non-Plugin-Radar accounts are unaffected: the same unrelated citation is still carried through as a Web Search supplement', async () => {
  const account = pluginRadarAccount({ contentStrategy: 'artist-support' });
  await withMockedGeneration([grnCandidateResponse()], async () => {
    const result = await generatePost('some-account', account, [], { trends: TREND_BRIEF });
    const urls = result.sources.map((s) => s.url);
    assert.ok(urls.includes(GRN_URL));
    assert.ok(urls.includes(POLARITY_GLUE_URL), 'existing non-Plugin-Radar citation behavior must not be changed by this fix');
  });
});

// -----------------------------------------------------------------------------------------------
// orchestrate.mjs end-to-end: audit trail records the contamination-free source list, and every
// safety invariant (Manual-Only, budgets, account posture) remains untouched.
// -----------------------------------------------------------------------------------------------
async function installContaminationAccount(accountId, overrides = {}) {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts[accountId] = {
    platform: 'x', enabled: true, mode: 'auto', credentialKey: accountId, displayName: accountId,
    contentStrategy: 'plugin-radar',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5.6-luna', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 3, candidateCount: 1, maxOutputTokens: 1000 },
    safety: { moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false, exploreRate: 0, humanFeedbackWindow: 5 },
    research: { webSearch: true, trendIntelligence: true, trendRefreshHours: 6 },
    resilience: { enabled: true, failureThreshold: 5, cooldownMinutes: 60 },
    budgets: { enabled: false }, experiments: { enabled: false }, media: { strategy: 'none', type: 'image' },
    ...overrides
  };
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function writeTrendFile(accountId, brief) {
  const path = fileURLToPath(new URL(`../data/trends/${accountId}.json`, import.meta.url));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...brief, account: accountId }, null, 2)}\n`, 'utf8');
  return path;
}

test('orchestrate.mjs end-to-end: candidate-selected audit for the #338 scenario records a contamination-free sourceCount that matches boundEvidenceCount', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const trendPath = fileURLToPath(new URL('../data/trends/contamination-gate-account.json', import.meta.url));
  const files = await snapshotFiles([CONFIG_FILE, trendPath, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installContaminationAccount('contamination-gate-account');
    await writeTrendFile('contamination-gate-account', TREND_BRIEF);
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({});
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') {
        return new Response(JSON.stringify(grnCandidateResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (target === 'https://api.openai.com/v1/moderations') {
        return new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const report = await runAutopilot({ accountFilter: 'contamination-gate-account', force: true, dryRun: true, now: new Date('2026-09-15T00:00:00+09:00') });
    assert.equal(report[0].status, 'dry-run');

    const audit = await readAudit();
    const row = audit.find((r) => r.account === 'contamination-gate-account' && r.stage === 'candidate-selected');
    assert.ok(row, 'a candidate-selected audit row must exist');
    assert.equal(row.trendEvidenceUrl, GRN_URL);
    assert.equal(row.boundEvidenceCount, 1);
    assert.equal(row.sourceCount, 1, 'sourceCount must equal boundEvidenceCount - the unrelated Polarity Glue citation must not inflate it');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});

test('safety invariants: Manual-Only posture, monthly budget cap, and every account posture remain untouched by this fix', async () => {
  const runtimePolicy = JSON.parse(await readFile(RUNTIME_POLICY_FILE, 'utf8'));
  assert.equal(runtimePolicy.manualOnly, true);
  assert.equal(runtimePolicy.requireExplicitManualInvocation, true);
  assert.equal(runtimePolicy.allowAutomaticAccountActivation, false);
  assert.equal(runtimePolicy.allowAutomaticEngagement, false);
  assert.equal(runtimePolicy.allowScheduledProviderPolling, false);

  const budgetPolicy = JSON.parse(await readFile(BUDGET_POLICY_FILE, 'utf8'));
  assert.equal(Number(budgetPolicy.monthlyBudgetUsd), 8);

  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  const musicToolsX = config.accounts['music-tools-x'];
  assert.equal(musicToolsX.enabled, true);
  assert.equal(musicToolsX.mode, 'approval');
  const others = Object.entries(config.accounts).filter(([id]) => id !== 'music-tools-x');
  assert.equal(others.length, 7, 'expected exactly 7 other accounts');
  for (const [id, otherAccount] of others) {
    assert.equal(otherAccount.enabled, false, `${id} must stay disabled`);
    assert.equal(otherAccount.mode, 'pause', `${id} must stay paused`);
  }
});
