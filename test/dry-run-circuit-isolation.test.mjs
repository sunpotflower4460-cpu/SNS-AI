import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runAutopilot } from '../src/orchestrate.mjs';
import { circuitStatus, recordCircuitFailure } from '../src/ops/circuit.mjs';

// Regression coverage for: a successful dry-run decision path called recordCircuitSuccess(), which
// unconditionally resets failures/openUntil/lastError in data/runtime-health.json - a file
// autopilot.yml commits whenever it changes, dry run or not. A dry run never calls the publisher (and,
// as of the dry-run budget-isolation fix, never even runs moderation) - it proves nothing about
// whether a real publish would succeed, and must not have the power to silently erase real prior
// failure history that a legitimate circuit breaker is tracking. This test fails on the pre-fix code
// (a dry run resets the failure count to 0) and passes on the fix.

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

function account() {
  return {
    platform: 'x', enabled: true, mode: 'auto', credentialKey: 'circuit-dry-x', displayName: 'Circuit Dry X',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'test', schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 1, candidateCount: 1, maxOutputTokens: 1000 },
    safety: { moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false }, research: { webSearch: false, trendIntelligence: false },
    // threshold 3: one real failure must not open the circuit on its own, so a dry run right after it
    // can still legitimately reach the 'dry-run' decision branch instead of being stopped earlier by
    // assertCircuitClosed - keeping this test focused on recordCircuitSuccess specifically.
    resilience: { enabled: true, failureThreshold: 3, cooldownMinutes: 60 },
    budgets: { enabled: false }, experiments: { enabled: false }, media: { strategy: 'none', type: 'image' }
  };
}

async function installAccount() {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts['circuit-dry-x'] = account();
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function generationResponse() {
  return { output_text: JSON.stringify({ candidates: [{
    text: 'Dry-run preview text.', mediaPrompt: '', rationale: 'circuit isolation coverage', spreadPotential: 55, noveltyPotential: 52,
    features: { topic: 'test', angle: 'dry-run', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed: false }
  }] }) };
}

test('a successful dry-run decision never resets real prior failure history on the resilience circuit', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installAccount();
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'circuit-dry-x': { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }
    });

    const acct = account();
    // One real production failure - below the threshold of 3, so it does not open the circuit, but it
    // must remain on record.
    await recordCircuitFailure('circuit-dry-x', 'autopilot', new Error('one real production failure'), acct.resilience);
    const beforeDryRun = await circuitStatus('circuit-dry-x', 'autopilot', acct.resilience);
    assert.equal(beforeDryRun.open, false, 'one failure alone must not open the circuit (threshold is 3)');
    assert.equal(beforeDryRun.failures, 1);

    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') return new Response(JSON.stringify(generationResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const dryReport = await runAutopilot({ accountFilter: 'circuit-dry-x', force: true, dryRun: true, now: new Date('2026-08-13T00:00:00+09:00') });
    assert.equal(dryReport[0].status, 'dry-run', `expected a dry-run decision to be reached, got: ${JSON.stringify(dryReport[0])}`);

    const afterDryRun = await circuitStatus('circuit-dry-x', 'autopilot', acct.resilience);
    assert.equal(afterDryRun.failures, 1, 'a dry run must not reset the real failure count a prior genuine failure recorded');
    assert.equal(afterDryRun.lastError, 'one real production failure', 'a dry run must not clear the real lastError either');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});
