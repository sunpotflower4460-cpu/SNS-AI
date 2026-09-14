import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { deriveResearchEscalationReasons } from '../src/research/escalation.mjs';
import { selectGenerationRoute } from '../src/budget/preflight.mjs';
import { runAutopilot } from '../src/orchestrate.mjs';

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const TRENDS_FILE = fileURLToPath(new URL('../data/trends/escalation-x.json', import.meta.url));
const AUDIT_FILE = fileURLToPath(new URL('../data/audit.jsonl', import.meta.url));
const DURABLE_DIR = fileURLToPath(new URL('../data/durable-claims/', import.meta.url));
const DATA_FILES = [
  fileURLToPath(new URL('../data/history.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/metrics.jsonl', import.meta.url)),
  AUDIT_FILE,
  fileURLToPath(new URL('../data/state.json', import.meta.url)),
  fileURLToPath(new URL('../data/runtime-health.json', import.meta.url)),
  fileURLToPath(new URL('../data/brakes.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage-state.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage.jsonl', import.meta.url))
];

function productionAi() {
  return {
    providers: ['groq', 'openai'],
    allowFallback: true,
    groqModel: 'openai/gpt-oss-120b',
    openaiTriageModel: 'gpt-5.6-luna',
    openaiHighModel: 'gpt-5.6-terra',
    openaiCriticalModel: 'gpt-5.6-sol'
  };
}

function accountWithAi() {
  return { generation: { model: 'gpt-5.6-luna' }, ai: productionAi() };
}

function routeFor(trends, budgetState = 'healthy') {
  return selectGenerationRoute(accountWithAi(), { escalateReasons: deriveResearchEscalationReasons(trends), budgetState });
}

function item(overrides = {}) {
  return { topic: 't', confidence: 90, risk: 10, ...overrides };
}

test('A: no trends -> no reasons -> balanced / gpt-5.6-luna', () => {
  for (const trends of [null, undefined, {}, { items: [] }, { items: null }]) {
    assert.deepEqual(deriveResearchEscalationReasons(trends), []);
    const route = routeFor(trends);
    assert.equal(route.tier, 'balanced');
    assert.equal(route.model, 'gpt-5.6-luna');
  }
});

test('B: top confidence 55 -> weak-confidence -> high / gpt-5.6-terra', () => {
  const trends = { items: [item({ confidence: 55 }), item({ confidence: 20 })] };
  assert.deepEqual(deriveResearchEscalationReasons(trends), ['weak-confidence']);
  const route = routeFor(trends);
  assert.equal(route.tier, 'high');
  assert.equal(route.provider, 'openai');
  assert.equal(route.model, 'gpt-5.6-terra');
  assert.equal(route.escalationReason, 'weak-confidence');
});

test('C: top confidence 56 -> no escalation -> balanced / gpt-5.6-luna', () => {
  const trends = { items: [item({ confidence: 56 })] };
  assert.deepEqual(deriveResearchEscalationReasons(trends), []);
  const route = routeFor(trends);
  assert.equal(route.tier, 'balanced');
  assert.equal(route.model, 'gpt-5.6-luna');
});

test('D: top risk 65 -> high-factual-risk -> high / gpt-5.6-terra', () => {
  const trends = { items: [item({ risk: 65 }), item({ risk: 90 })] };
  assert.deepEqual(deriveResearchEscalationReasons(trends), ['high-factual-risk']);
  const route = routeFor(trends);
  assert.equal(route.tier, 'high');
  assert.equal(route.model, 'gpt-5.6-terra');
  assert.equal(route.escalationReason, 'high-factual-risk');
});

test('E: top risk 64 -> no escalation -> balanced / gpt-5.6-luna', () => {
  const trends = { items: [item({ risk: 64 })] };
  assert.deepEqual(deriveResearchEscalationReasons(trends), []);
  const route = routeFor(trends);
  assert.equal(route.tier, 'balanced');
  assert.equal(route.model, 'gpt-5.6-luna');
});

test('F: weak confidence AND high risk -> one high escalation -> gpt-5.6-terra, never critical/sol', () => {
  const trends = { items: [item({ confidence: 40, risk: 80 })] };
  assert.deepEqual(deriveResearchEscalationReasons(trends), ['weak-confidence', 'high-factual-risk']);
  const route = routeFor(trends);
  assert.equal(route.tier, 'high', 'both reasons still escalate exactly one tier, not to critical');
  assert.equal(route.model, 'gpt-5.6-terra');
  assert.notEqual(route.model, 'gpt-5.6-sol', 'Sol must never be auto-selected');
});

test('G: budget governor overrides escalation -> conservative/critical downgrade to balanced / gpt-5.6-luna; stopped blocks', () => {
  const trends = { items: [item({ confidence: 40, risk: 80 })] };
  for (const state of ['conservative', 'critical']) {
    const route = routeFor(trends, state);
    assert.equal(route.tier, 'balanced');
    assert.equal(route.model, 'gpt-5.6-luna', `${state} budget must downgrade the escalated route to Luna`);
    assert.equal(route.constrained, true);
  }
  assert.throws(
    () => routeFor(trends, 'stopped'),
    { code: 'BUDGET_GOVERNOR_BLOCKED' }
  );
});

test('top item only: a weak second item must not escalate; non-numeric confidence is ignored', () => {
  assert.deepEqual(
    deriveResearchEscalationReasons({ items: [item({ confidence: 90, risk: 10 }), item({ confidence: 10 })] }),
    [],
    'only trends.items[0] (top opportunity) is considered'
  );
  assert.deepEqual(
    deriveResearchEscalationReasons({ items: [item({ confidence: 'high', risk: 70 })] }),
    ['high-factual-risk'],
    'a non-numeric confidence (e.g. web-search briefs) disables only the confidence rule'
  );
  assert.deepEqual(deriveResearchEscalationReasons({ items: [item({ confidence: null, risk: null })] }), []);
  assert.deepEqual(deriveResearchEscalationReasons({ items: ['not-an-object'] }), []);
});

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

function escalationAccount(overrides = {}) {
  return {
    platform: 'x', enabled: true, mode: 'auto', credentialKey: 'escalation-x', displayName: 'Escalation X',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5.6-luna', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 1, candidateCount: 1, maxOutputTokens: 1000 },
    ai: productionAi(),
    safety: { moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false, humanFeedbackWindow: 5 },
    research: { webSearch: false, trendIntelligence: true },
    resilience: { enabled: true, failureThreshold: 5, cooldownMinutes: 60 },
    budgets: { enabled: false }, experiments: { enabled: false }, media: { strategy: 'none', type: 'image' },
    ...overrides
  };
}

function trendBrief(top) {
  return {
    account: 'escalation-x', generatedAt: new Date().toISOString(), summary: 'fixture',
    items: [top, item({ topic: 'second', confidence: 10, risk: 90 })],
    sources: []
  };
}

function generationResponse(text) {
  return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ candidates: [{
    text, mediaPrompt: '', rationale: 'escalation coverage', spreadPotential: 55, noveltyPotential: 52,
    features: { topic: 'test', angle: 'escalation', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed: false }
  }] }) }] }] };
}

async function installAccount() {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts['escalation-x'] = escalationAccount();
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function runWithBrief(top) {
  const bodies = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === 'https://api.openai.com/v1/responses') {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify(generationResponse('Escalation coverage post.')), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected mocked URL: ${target}`);
  };
  try {
    await writeFile(TRENDS_FILE, `${JSON.stringify(trendBrief(top), null, 2)}\n`, 'utf8');
    const report = await runAutopilot({ force: true, dryRun: true, now: new Date('2026-08-13T00:00:00+09:00') });
    return { report, bodies };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function decisionStartAudit() {
  const rows = (await readFile(AUDIT_FILE, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const matches = rows.filter((row) => row.account === 'escalation-x' && row.stage === 'decision-start');
  return matches[matches.length - 1];
}

test('autopilot pre-generation escalation: weak top confidence escalates the live generation call to gpt-5.6-terra and audits the reasons', async () => {
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installAccount();
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'escalation-x': { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }
    });

    const { report, bodies } = await runWithBrief({ topic: 'top', confidence: 50, risk: 20 });
    assert.equal(report.find((row) => row.account === 'escalation-x')?.status, 'dry-run');
    assert.equal(bodies.length, 1, 'a single generation call must happen');
    assert.equal(bodies[0].model, 'gpt-5.6-terra', 'the escalated preflight route must drive the live generation model');

    const audit = await decisionStartAudit();
    assert.ok(audit, 'decision-start audit must be recorded');
    assert.equal(audit.selectedModelTier, 'high');
    assert.equal(audit.selectedProvider, 'openai');
    assert.equal(audit.selectedModel, 'gpt-5.6-terra');
    assert.equal(audit.reasonForEscalation, 'weak-confidence');
    assert.deepEqual(audit.escalationReasons, ['weak-confidence']);
  } finally {
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await rm(TRENDS_FILE, { force: true });
  }
});

test('autopilot pre-generation escalation: a confident low-risk top item keeps the generation call on gpt-5.6-luna', async () => {
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installAccount();
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'escalation-x': { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }
    });

    const { report, bodies } = await runWithBrief({ topic: 'top', confidence: 90, risk: 10 });
    assert.equal(report.find((row) => row.account === 'escalation-x')?.status, 'dry-run');
    assert.equal(bodies[0].model, 'gpt-5.6-luna', 'no escalation reason must keep the generation call on Luna');

    const audit = await decisionStartAudit();
    assert.equal(audit.selectedModelTier, 'balanced');
    assert.equal(audit.selectedModel, 'gpt-5.6-luna');
    assert.equal(audit.reasonForEscalation, null);
    assert.deepEqual(audit.escalationReasons, []);
  } finally {
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await rm(TRENDS_FILE, { force: true });
  }
});
