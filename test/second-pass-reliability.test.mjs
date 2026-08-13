import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beginPublishClaim, durableClaimHandled, finishPublishClaim, __test as claimTest } from '../src/lib/durable-claim.mjs';
import { slotHandled } from '../src/lib/state.mjs';
import { effectiveScheduleTimes } from '../src/lib/schedule.mjs';
import { resolveAccount } from '../src/lib/config.mjs';
import { createApprovalIssue } from '../src/lib/github.mjs';
import { circuitStatus, recordCircuitFailure } from '../src/ops/circuit.mjs';
import { __test as publishTest } from '../src/publish.mjs';

const RUNTIME_HEALTH = fileURLToPath(new URL('../data/runtime-health.json', import.meta.url));
const DURABLE_DIR = fileURLToPath(new URL('../data/durable-claims/', import.meta.url));

function savedEnv(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(saved) {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function snapshotFile(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function restoreFile(path, bytes) {
  if (bytes === null) await rm(path, { force: true });
  else await writeFile(path, bytes);
}

test('durable publish claims block duplicate retries but allow explicit failed retries', async () => {
  const env = savedEnv(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY']);
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  await rm(DURABLE_DIR, { recursive: true, force: true });
  claimTest.resetForTests();
  const slotId = 'claim-account:2026-08-13:10:30';
  try {
    const first = await beginPublishClaim(slotId, { account: 'claim-account' });
    assert.equal(first.claimed, true);
    assert.equal(await durableClaimHandled(slotId), true);
    assert.equal(await slotHandled(slotId), true, 'slotHandled must consult the durable claim ledger');

    await assert.rejects(
      beginPublishClaim(slotId, { account: 'claim-account' }),
      (error) => error.code === 'SLOT_ALREADY_CLAIMED'
    );

    await finishPublishClaim(slotId, 'failed', { lastError: 'definitive 400' });
    claimTest.resetForTests();
    assert.equal(await durableClaimHandled(slotId), false);
    const retry = await beginPublishClaim(slotId, { account: 'claim-account' });
    assert.equal(retry.claimed, true);

    await finishPublishClaim(slotId, 'published', { providerPostId: 'post-123' });
    claimTest.resetForTests();
    const replay = await beginPublishClaim(slotId, { account: 'claim-account' });
    assert.equal(replay.replay, true);
    assert.equal(replay.claim.providerPostId, 'post-123');
  } finally {
    claimTest.resetForTests();
    await rm(DURABLE_DIR, { recursive: true, force: true });
    restoreEnv(env);
  }
});

test('adaptive scheduling preserves a legitimate learned score of zero', () => {
  const account = {
    schedule: {
      times: ['08:00'],
      adaptiveCandidateTimes: ['08:00', '09:00']
    },
    learning: {
      adaptiveSchedule: true,
      adaptiveScheduleMinConfidence: 0,
      adaptiveScheduleKeepAtLeast: 1
    }
  };
  const strategy = {
    confidence: 1,
    featureStats: {
      postingHour: {
        '08:00': { averageScore: 0, confidence: 1 },
        '09:00': { averageScore: 10, confidence: 1 }
      }
    }
  };
  assert.deepEqual(effectiveScheduleTimes(account, strategy), ['09:00']);
});

test('X account resolution injects a stable OAuth2 state id from the credential key', async () => {
  const env = savedEnv(['SOCIAL_CREDENTIALS_JSON']);
  try {
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'example-x': {
        consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as'
      }
    });
    const resolved = await resolveAccount('example-x', { allowDisabled: true });
    assert.equal(resolved.credential.oauth2StateId, 'example-x');
  } finally {
    restoreEnv(env);
  }
});

test('approval issue creation is idempotent when the exact issue already exists', async () => {
  const env = savedEnv(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY']);
  const previousFetch = global.fetch;
  const calls = [];
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    delete process.env.GH_TOKEN;
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      return new Response(JSON.stringify([
        { number: 42, title: '[approval] acct acct:2026-08-13:10:00' }
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const issue = await createApprovalIssue('acct', 'acct:2026-08-13:10:00', { account: 'acct' });
    assert.equal(issue.number, 42);
    assert.equal(calls.length, 1, 'existing approval must avoid label/create API calls');
    assert.match(calls[0].url, /\/issues\?state=all/);
  } finally {
    global.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('circuit failure increments are not lost under concurrent mutations', async () => {
  const saved = await snapshotFile(RUNTIME_HEALTH);
  try {
    await rm(RUNTIME_HEALTH, { force: true });
    const config = { enabled: true, failureThreshold: 100, cooldownMinutes: 30 };
    await Promise.all(Array.from({ length: 16 }, (_, index) =>
      recordCircuitFailure('concurrent-account', 'publish', new Error(`failure-${index}`), config)
    ));
    const status = await circuitStatus('concurrent-account', 'publish', config);
    assert.equal(status.failures, 16);
    assert.equal(status.open, false);
  } finally {
    await restoreFile(RUNTIME_HEALTH, saved);
  }
});

test('provider failure classification retries only outcomes known not to have published', () => {
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'media' }), true);
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'media-processing' }), true);
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'create-post', status: 400 }), true);
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'create-post', status: 429 }), true);
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'create-post', status: 500 }), false);
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'create-post' }), false);
});
