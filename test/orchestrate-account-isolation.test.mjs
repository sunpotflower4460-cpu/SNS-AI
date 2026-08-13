import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runAutopilot, hasFatalStatus } from '../src/orchestrate.mjs';

// Regression coverage for: a single account whose schedule.timezone is invalid (a typo, or any config
// change that bypassed npm run validate) used to throw straight out of findDueSlots() with nothing
// catching it in runAutopilot's per-account setup step, aborting the ENTIRE multi-account run and
// discarding results already collected for other accounts - even though every other failure mode in
// this loop (rate limits, circuit breaker, safety brake, budget, state errors...) is isolated per
// account/slot and never takes down the batch. This test fails on the pre-fix code (runAutopilot()
// itself rejects, and the well-configured account never gets processed) and passes on the fix.

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const DURABLE_DIR = fileURLToPath(new URL('../data/durable-claims/', import.meta.url));
const DATA_FILES = [
  fileURLToPath(new URL('../data/history.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/metrics.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/audit.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/state.json', import.meta.url)),
  fileURLToPath(new URL('../data/runtime-health.json', import.meta.url)),
  fileURLToPath(new URL('../data/brakes.json', import.meta.url)),
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

function baseAccount(overrides = {}) {
  return {
    platform: 'x', enabled: true, mode: 'auto', credentialKey: 'isolation-x', displayName: 'Isolation X',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 1, candidateCount: 1, maxOutputTokens: 1000 },
    safety: { moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false, humanFeedbackWindow: 5 },
    research: { webSearch: false, trendIntelligence: false },
    resilience: { enabled: true, failureThreshold: 5, cooldownMinutes: 60 },
    budgets: { enabled: false }, experiments: { enabled: false }, media: { strategy: 'none', type: 'image' },
    ...overrides
  };
}

async function installAccounts() {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts['isolation-broken-timezone'] = baseAccount({
    credentialKey: 'isolation-broken-timezone', displayName: 'Broken Timezone',
    schedule: { timezone: 'Not/A/Real/Zone', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 }
  });
  config.accounts['isolation-healthy'] = baseAccount({ credentialKey: 'isolation-healthy', displayName: 'Healthy' });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function generationResponse(text) {
  return { output_text: JSON.stringify({ candidates: [{
    text, mediaPrompt: '', rationale: 'account isolation coverage', spreadPotential: 55, noveltyPotential: 52,
    features: { topic: 'test', angle: 'isolation', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed: false }
  }] }) };
}

test('a single account with an invalid schedule timezone does not abort processing of other accounts', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installAccounts();
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'isolation-healthy': { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }
    });

    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') return new Response(JSON.stringify(generationResponse('Healthy account post.')), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target === 'https://api.x.com/2/tweets' && options.method === 'POST') return new Response(JSON.stringify({ data: { id: 'isolation-post', text: 'Healthy account post.' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    // force:true so the healthy account's slot is deterministic and doesn't depend on `now` landing in
    // a due window; force mode does not itself validate schedule.timezone (it only labels the slot with
    // it), so this still exercises the broken account through the SAME findDueSlots-adjacent code path
    // that the pre-fix bug crashed in for non-forced runs. What matters here is that runAutopilot()
    // resolves at all and both accounts get a distinct, isolated result.
    const report = await runAutopilot({ force: true, dryRun: false, now: new Date('2026-08-13T00:00:00+09:00') });

    const broken = report.find((row) => row.account === 'isolation-broken-timezone');
    const healthy = report.find((row) => row.account === 'isolation-healthy');
    assert.ok(healthy, 'the healthy account must still appear in the report');
    assert.equal(healthy.status, 'published', `expected the healthy account to publish, got: ${JSON.stringify(healthy)}`);
    if (broken) assert.notEqual(broken.status, 'published');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});

test('a single account with an invalid schedule timezone does not abort a non-forced scheduled run either', async () => {
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installAccounts();
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({});

    // A scheduled (non-forced) run must resolve without throwing even though findDueSlots() for
    // 'isolation-broken-timezone' throws a RangeError deep inside Intl.DateTimeFormat.
    const report = await runAutopilot({ force: false, dryRun: false, now: new Date('2026-08-13T00:00:00+09:00') });
    const broken = report.find((row) => row.account === 'isolation-broken-timezone');
    assert.ok(broken, 'the broken account must still surface an explicit, isolated failure entry');
    assert.equal(broken.status, 'account-error');
    assert.match(broken.error, /time zone/i);
    // Isolating the failure to one account is only half the fix: the CLI entrypoint must still exit
    // non-zero so a scheduled run doesn't look green while silently skipping an account.
    assert.equal(hasFatalStatus(report), true, 'a report containing an account-error must make the CLI exit non-zero');
  } finally {
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});

test('hasFatalStatus flags real per-account/per-slot errors but not intentional control-flow pauses', () => {
  assert.equal(hasFatalStatus([{ status: 'failed' }]), true);
  assert.equal(hasFatalStatus([{ status: 'account-error' }]), true);
  assert.equal(hasFatalStatus([{ status: 'state-error' }]), true);
  assert.equal(hasFatalStatus([{ status: 'approval-reconcile-error' }]), true);
  assert.equal(hasFatalStatus([{ status: 'published' }, { status: 'account-error' }]), true, 'one fatal entry among otherwise-successful ones must still trip the exit code');

  for (const status of ['budget-exhausted', 'circuit-open', 'rate-limited', 'safety-brake', 'media-qa-failed', 'provider-deprecated', 'already-handled', 'published', 'dry-run', 'approval-pending']) {
    assert.equal(hasFatalStatus([{ status }]), false, `${status} is an intentional control-flow outcome and must not fail the CLI`);
  }
  assert.equal(hasFatalStatus([]), false);
});
