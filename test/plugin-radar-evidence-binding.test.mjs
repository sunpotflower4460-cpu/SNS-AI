import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { generatePost, __test as openaiTest } from '../src/lib/openai.mjs';
import { runAutopilot } from '../src/orchestrate.mjs';
import { readAudit } from '../src/lib/audit.mjs';

const { resolveTrendEvidence, assertPluginRadarTrendEvidence, dedupeSources, trendBriefForPrompt } = openaiTest;

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const RUNTIME_POLICY_FILE = fileURLToPath(new URL('../config/runtime-policy.json', import.meta.url));
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

// A reproduction of the real production trend brief: three unrelated products (SKR4CH, FRCTL Audio GRN,
// KVEIK) plus the one the real bug's winning candidate was actually about (OXO Steps) but shipped with
// none of its own evidence for.
const TREND_BRIEF = {
  account: 'music-tools-x', generatedAt: new Date().toISOString(), summary: 'test brief',
  items: [
    { topic: 'SKR4CH waveform designer', whyNow: 'now', angle: 'a', relevance: 80, novelty: 70, url: 'https://vendor.example/skr4ch', sourceId: 'bpb' },
    { topic: 'FRCTL Audio GRN 4.0', whyNow: 'now', angle: 'b', relevance: 80, novelty: 70, url: 'https://vendor.example/grn', sourceId: 'rekkerd' },
    { topic: 'KVEIK', whyNow: 'now', angle: 'c', relevance: 80, novelty: 70, url: 'https://vendor.example/kveik', sourceId: 'rekkerd' },
    { topic: 'OXO Steps：無料の6トラックMIDIステップシーケンサー', whyNow: 'now', angle: 'd', relevance: 90, novelty: 85, url: 'https://bedroomproducersblog.com/2026/09/12/oxo-steps-midi-sequencer/', sourceId: 'bpb' }
  ],
  sources: []
};
const OXO_INDEX = 3;
const OXO_URL = TREND_BRIEF.items[OXO_INDEX].url;

function pluginRadarAccount(overrides = {}) {
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

function candidateResponse(text, { spreadPotential = 60, noveltyPotential = 60, trendUsed = false, trendEvidenceIndex = null } = {}) {
  return { output_text: JSON.stringify({ candidates: [{
    text, mediaPrompt: '', rationale: 'evidence binding coverage', spreadPotential, noveltyPotential,
    features: { topic: 'test', angle: 'gate', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed, trendEvidenceIndex }
  }] }) };
}

function citationsResponse(text, opts, citationUrls) {
  const base = candidateResponse(text, opts);
  return { ...base, output: [{ type: 'message', content: [{ type: 'output_text', text: base.output_text, annotations: citationUrls.map((url) => ({ type: 'url_citation', url, title: url })) }] }] };
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
// resolveTrendEvidence / assertPluginRadarTrendEvidence / dedupeSources: pure helper coverage.
// -----------------------------------------------------------------------------------------------
test('trendBriefForPrompt annotates each item with a stable evidenceIndex (array position, never a product id)', () => {
  const annotated = trendBriefForPrompt(TREND_BRIEF);
  assert.equal(annotated.items[OXO_INDEX].evidenceIndex, OXO_INDEX);
  assert.equal(annotated.items[0].evidenceIndex, 0);
  assert.equal(trendBriefForPrompt(null), null);
});

test('resolveTrendEvidence resolves a valid index and rejects missing/out-of-range/malformed ones', () => {
  const valid = resolveTrendEvidence({ features: { trendEvidenceIndex: OXO_INDEX } }, TREND_BRIEF);
  assert.equal(valid.url, OXO_URL);
  assert.equal(resolveTrendEvidence({ features: { trendEvidenceIndex: null } }, TREND_BRIEF), null);
  assert.equal(resolveTrendEvidence({ features: { trendEvidenceIndex: 99 } }, TREND_BRIEF), null);
  assert.equal(resolveTrendEvidence({ features: { trendEvidenceIndex: -1 } }, TREND_BRIEF), null);
  assert.equal(resolveTrendEvidence({ features: { trendEvidenceIndex: 1.5 } }, TREND_BRIEF), null);
  assert.equal(resolveTrendEvidence({ features: {} }, null), null);
});

test('assertPluginRadarTrendEvidence only enforces when trendUsed is true', () => {
  assert.doesNotThrow(() => assertPluginRadarTrendEvidence({ features: { trendUsed: false, trendEvidenceIndex: 999 } }, TREND_BRIEF));
  assert.throws(() => assertPluginRadarTrendEvidence({ features: { trendUsed: true, trendEvidenceIndex: null } }, TREND_BRIEF), /valid trend evidence/);
  assert.doesNotThrow(() => assertPluginRadarTrendEvidence({ features: { trendUsed: true, trendEvidenceIndex: OXO_INDEX } }, TREND_BRIEF));
});

test('dedupeSources removes exact URL duplicates while preserving order', () => {
  const result = dedupeSources([{ url: 'https://a.example' }, { url: 'https://b.example' }, { url: 'https://a.example' }]);
  assert.deepEqual(result.map((s) => s.url), ['https://a.example', 'https://b.example']);
});

// -----------------------------------------------------------------------------------------------
// A-E: generatePost()'s plugin-radar evidence-binding validation, in isolation.
// -----------------------------------------------------------------------------------------------
test('A: a valid evidence index passes, and the winner carries its bound URL', async () => {
  const account = pluginRadarAccount();
  await withMockedGeneration([candidateResponse('OXO Steps post.', { trendUsed: true, trendEvidenceIndex: OXO_INDEX })], async (calls) => {
    const result = await generatePost('music-tools-x', account, [], { trends: TREND_BRIEF });
    assert.equal(result.text, 'OXO Steps post.');
    assert.equal(result.features.trendEvidenceUrl, OXO_URL);
    assert.equal(result.sources[0].url, OXO_URL);
    assert.equal(calls(), 1, 'no extra AI call needed for a valid reference');
  });
});

test('B: trendUsed:true with no evidence is rejected and bounded-retried within the existing attempts budget', async () => {
  const account = pluginRadarAccount({ generation: { ...pluginRadarAccount().generation, maxAttempts: 3 } });
  await withMockedGeneration([
    candidateResponse('No evidence draft.', { trendUsed: true, trendEvidenceIndex: null }),
    candidateResponse('OXO Steps post, take two.', { trendUsed: true, trendEvidenceIndex: OXO_INDEX })
  ], async (calls) => {
    const result = await generatePost('music-tools-x', account, [], { trends: TREND_BRIEF });
    assert.equal(result.text, 'OXO Steps post, take two.');
    assert.equal(calls(), 2, 'exactly one bounded retry, reusing the existing attempts budget');
  });
});

test('C: an out-of-range evidence index is rejected on every attempt and generatePost fails closed, never publishing', async () => {
  const account = pluginRadarAccount({ generation: { ...pluginRadarAccount().generation, maxAttempts: 2 } });
  await withMockedGeneration([
    candidateResponse('Bad index 1.', { trendUsed: true, trendEvidenceIndex: 99 }),
    candidateResponse('Bad index 2.', { trendUsed: true, trendEvidenceIndex: -1 })
  ], async (calls) => {
    await assert.rejects(generatePost('music-tools-x', account, [], { trends: TREND_BRIEF }));
    assert.equal(calls(), 2, 'bounded by maxAttempts (2), never more');
  });
});

test('D: trendUsed:false never requires evidence binding, even with a malformed index', async () => {
  const account = pluginRadarAccount();
  await withMockedGeneration([candidateResponse('No trend used.', { trendUsed: false, trendEvidenceIndex: 999 })], async () => {
    const result = await generatePost('music-tools-x', account, [], { trends: TREND_BRIEF });
    assert.equal(result.text, 'No trend used.');
    assert.equal(result.features.trendEvidenceUrl, null);
  });
});

test('E: non-plugin-radar accounts are completely unaffected (existing behavior preserved)', async () => {
  for (const account of [
    pluginRadarAccount({ contentStrategy: 'artist-support' }),
    pluginRadarAccount({ contentStrategy: undefined })
  ]) {
    await withMockedGeneration([candidateResponse('Unenforced account.', { trendUsed: true, trendEvidenceIndex: 999 })], async (calls) => {
      const result = await generatePost('some-account', account, [], { trends: TREND_BRIEF });
      assert.equal(result.text, 'Unenforced account.');
      assert.equal(calls(), 1, 'no rejection, no retry - contentStrategy !== "plugin-radar" never enforces evidence binding');
    });
  }
});

// -----------------------------------------------------------------------------------------------
// F-I: the winning candidate's bound URL ends up in sources - first, deduped, cap-preserving.
// -----------------------------------------------------------------------------------------------
test('F/G: the winner\'s bound trend URL is included even when Web Search citations are all for OTHER entities (the real bug)', async () => {
  const account = pluginRadarAccount({ research: { webSearch: true } });
  const response = citationsResponse('OXO Steps post.', { trendUsed: true, trendEvidenceIndex: OXO_INDEX }, [
    'https://vendor.example/skr4ch', 'https://vendor.example/grn', 'https://vendor.example/kveik'
  ]);
  await withMockedGeneration([response], async () => {
    const result = await generatePost('music-tools-x', account, [], { trends: TREND_BRIEF });
    assert.ok(result.sources.some((s) => s.url === OXO_URL), 'the bound OXO Steps source must be present');
    assert.equal(result.sources[0].url, OXO_URL, 'the bound trend source is primary, listed before unrelated citations');
    // The original bug: the OTHER products' URLs alone, with no OXO Steps URL, would have been accepted.
    assert.ok(result.sources.some((s) => s.url === 'https://vendor.example/skr4ch'), 'unrelated citations are kept as supplements, not discarded');
  });
});

test('H: an identical URL in both the bound evidence and Web Search citations is deduplicated', async () => {
  const account = pluginRadarAccount({ research: { webSearch: true } });
  const response = citationsResponse('OXO Steps post.', { trendUsed: true, trendEvidenceIndex: OXO_INDEX }, [OXO_URL, 'https://vendor.example/skr4ch']);
  await withMockedGeneration([response], async () => {
    const result = await generatePost('music-tools-x', account, [], { trends: TREND_BRIEF });
    const oxoCount = result.sources.filter((s) => s.url === OXO_URL).length;
    assert.equal(oxoCount, 1, 'the bound URL must not appear twice just because it was also cited');
  });
});

test('I: the existing max-30-sources cap (enforced downstream in orchestrate.mjs) still keeps the bound URL, since it is placed first', async () => {
  const account = pluginRadarAccount({ research: { webSearch: true } });
  const manyCitations = Array.from({ length: 35 }, (_, i) => `https://vendor.example/citation-${i}`);
  const response = citationsResponse('OXO Steps post.', { trendUsed: true, trendEvidenceIndex: OXO_INDEX }, manyCitations);
  await withMockedGeneration([response], async () => {
    const result = await generatePost('music-tools-x', account, [], { trends: TREND_BRIEF });
    // generatePost() itself does not cap (orchestrate.mjs's unmodified `.slice(0, 30)` does) - what
    // matters here is that the bound URL survives that downstream cap because it is sorted first.
    const capped = result.sources.slice(0, 30);
    assert.ok(capped.some((s) => s.url === OXO_URL), 'the bound URL must survive the existing 30-source cap');
    assert.equal(capped.length, 30);
  });
});

// -----------------------------------------------------------------------------------------------
// K/L/M: no additional AI calls, existing quality-floor config/behavior preserved.
// -----------------------------------------------------------------------------------------------
test('K: a single valid candidate costs exactly one generation call - no extra fact-check/review call added', async () => {
  const account = pluginRadarAccount();
  await withMockedGeneration([candidateResponse('OXO Steps post.', { trendUsed: true, trendEvidenceIndex: OXO_INDEX })], async (calls) => {
    await generatePost('music-tools-x', account, [], { trends: TREND_BRIEF });
    assert.equal(calls(), 1);
  });
});

test('L: music-tools-x config still sets minPredictedScore=35 and lowScoreRetryCount=1', async () => {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  const generation = config.accounts['music-tools-x'].generation;
  assert.equal(generation.minPredictedScore, 35);
  assert.equal(generation.lowScoreRetryCount, 1);
});

test('M: the low-score quality gate still functions for a candidate with otherwise-valid evidence binding', async () => {
  const account = pluginRadarAccount({ generation: { ...pluginRadarAccount().generation, maxAttempts: 3, minPredictedScore: 90, lowScoreRetryCount: 0 } });
  await withMockedGeneration([candidateResponse('Valid evidence but too low a score.', { spreadPotential: 10, noveltyPotential: 10, trendUsed: true, trendEvidenceIndex: OXO_INDEX })], async (calls) => {
    await assert.rejects(generatePost('music-tools-x', account, [], { trends: TREND_BRIEF }), (error) => {
      assert.equal(error.code, 'CONTENT_QUALITY_BELOW_THRESHOLD');
      return true;
    });
    assert.equal(calls(), 1, 'lowScoreRetryCount:0 means no retry - evidence binding did not add one either');
  });
});

// -----------------------------------------------------------------------------------------------
// J/N/O/P: orchestrate.mjs end-to-end - audit fields, and every safety invariant preserved.
// -----------------------------------------------------------------------------------------------
async function installEvidenceAccount(accountId, overrides = {}) {
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
    research: { webSearch: false, trendIntelligence: true, trendRefreshHours: 6 },
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

test('J: candidate-selected audit records trendEvidenceIndex/trendEvidenceUrl/boundEvidenceCount', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const trendPath = fileURLToPath(new URL('../data/trends/evidence-gate-account.json', import.meta.url));
  const files = await snapshotFiles([CONFIG_FILE, trendPath, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installEvidenceAccount('evidence-gate-account');
    await writeTrendFile('evidence-gate-account', TREND_BRIEF);
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({});
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') {
        return new Response(JSON.stringify(candidateResponse('OXO Steps audit post.', { trendUsed: true, trendEvidenceIndex: OXO_INDEX })), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (target === 'https://api.openai.com/v1/moderations') {
        return new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const report = await runAutopilot({ accountFilter: 'evidence-gate-account', force: true, dryRun: true, now: new Date('2026-09-14T00:00:00+09:00') });
    assert.equal(report[0].status, 'dry-run');

    const audit = await readAudit();
    const row = audit.find((r) => r.account === 'evidence-gate-account' && r.stage === 'candidate-selected');
    assert.ok(row, 'a candidate-selected audit row must exist');
    assert.equal(row.trendEvidenceIndex, OXO_INDEX);
    assert.equal(row.trendEvidenceUrl, OXO_URL);
    assert.equal(row.boundEvidenceCount, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});

test('N: Manual-Only posture is untouched', async () => {
  const runtimePolicy = JSON.parse(await readFile(RUNTIME_POLICY_FILE, 'utf8'));
  assert.equal(runtimePolicy.manualOnly, true);
  assert.equal(runtimePolicy.requireExplicitManualInvocation, true);
  assert.equal(runtimePolicy.allowAutomaticAccountActivation, false);
  assert.equal(runtimePolicy.allowAutomaticEngagement, false);
  assert.equal(runtimePolicy.allowScheduledProviderPolling, false);
});

test('O: music-tools-x stays enabled:true / mode:approval', async () => {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  assert.equal(config.accounts['music-tools-x'].enabled, true);
  assert.equal(config.accounts['music-tools-x'].mode, 'approval');
});

test('P: every other account remains disabled', async () => {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  const others = Object.entries(config.accounts).filter(([id]) => id !== 'music-tools-x');
  assert.equal(others.length, 7, 'expected exactly 7 other accounts');
  for (const [id, account] of others) {
    assert.equal(account.enabled, false, `${id} must stay disabled`);
    assert.equal(account.mode, 'pause', `${id} must stay paused`);
  }
});
