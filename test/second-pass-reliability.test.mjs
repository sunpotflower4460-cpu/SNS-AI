import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beginPublishClaim, durableClaimHandled, finishPublishClaim, __test as claimTest } from '../src/lib/durable-claim.mjs';
import { slotHandled } from '../src/lib/state.mjs';
import { effectiveScheduleTimes } from '../src/lib/schedule.mjs';
import { resolveAccount } from '../src/lib/config.mjs';
import { createApprovalIssue, __test as githubTest } from '../src/lib/github.mjs';
import { circuitStatus, recordCircuitFailure } from '../src/ops/circuit.mjs';
import { __test as publishTest } from '../src/publish.mjs';
import { __test as preflightTest } from '../src/ops/live-preflight.mjs';

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

function trustedApprovalIssue(account, slotId, number = 42) {
  const payload = githubTest.markedApprovalPayload({ account, slotId, text: 'draft' }, account, slotId);
  return {
    number,
    title: githubTest.approvalTitle(account, slotId),
    user: { login: 'github-actions[bot]' },
    body: JSON.stringify(payload)
  };
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

test('local durable claim acquisition is atomic for concurrent callers', async () => {
  const env = savedEnv(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY']);
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  await rm(DURABLE_DIR, { recursive: true, force: true });
  claimTest.resetForTests();
  const slotId = 'atomic-claim:2026-08-13:10:31';
  try {
    const results = await Promise.allSettled([
      beginPublishClaim(slotId, { caller: 1 }),
      beginPublishClaim(slotId, { caller: 2 })
    ]);
    assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
    const rejected = results.find((row) => row.status === 'rejected');
    assert.equal(rejected?.reason?.code, 'SLOT_ALREADY_CLAIMED');
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

test('approval issue creation reuses only trusted bot-created marked issues', async () => {
  const env = savedEnv(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY']);
  const previousFetch = global.fetch;
  const calls = [];
  const account = 'acct';
  const slotId = 'acct:2026-08-13:10:00';
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    delete process.env.GH_TOKEN;
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      return new Response(JSON.stringify([trustedApprovalIssue(account, slotId)]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const issue = await createApprovalIssue(account, slotId, { account, slotId });
    assert.equal(issue.number, 42);
    assert.equal(calls.length, 1, 'trusted existing approval must avoid label/create API calls');
    assert.match(calls[0].url, /\/issues\?state=open/);
  } finally {
    global.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('untrusted same-title approval issues are rejected by provenance checks', () => {
  const account = 'acct';
  const slotId = 'acct:slot:untrusted';
  const attacker = {
    number: 99,
    title: githubTest.approvalTitle(account, slotId),
    user: { login: 'attacker' },
    body: JSON.stringify(githubTest.markedApprovalPayload({ account, slotId }, account, slotId))
  };
  const missingMarker = {
    number: 100,
    title: githubTest.approvalTitle(account, slotId),
    user: { login: 'github-actions[bot]' },
    body: JSON.stringify({ account, slotId })
  };
  assert.equal(githubTest.isTrustedApprovalIssue(attacker, account, slotId), false);
  assert.equal(githubTest.isTrustedApprovalIssue(missingMarker, account, slotId), false);
  assert.equal(githubTest.isTrustedApprovalIssue(trustedApprovalIssue(account, slotId), account, slotId), true);
});

test('approval issue lookup paginates recent open issues without relying on search indexing', async () => {
  const env = savedEnv(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY']);
  const previousFetch = global.fetch;
  let calls = 0;
  const account = 'acct';
  const slotId = 'acct:slot:two';
  try {
    process.env.GITHUB_TOKEN = 'test-token';
    delete process.env.GH_TOKEN;
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    global.fetch = async (url) => {
      calls += 1;
      const page = new URL(String(url)).searchParams.get('page');
      const rows = page === '1'
        ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: `other-${index}` }))
        : [trustedApprovalIssue(account, slotId, 501)];
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const issue = await createApprovalIssue(account, slotId, { account, slotId });
    assert.equal(issue.number, 501);
    assert.equal(calls, 2);
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
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'preflight' }), true);
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'media' }), true);
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'media-processing' }), true);
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'create-post', status: 400 }), true);
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'create-post', status: 429 }), true);
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'create-post', status: 500 }), false);
  assert.equal(publishTest.definitiveProviderFailure({ publishStage: 'create-post' }), false);
});

test('provider payload validation rejects known pre-request errors before claims are acquired', () => {
  assert.throws(
    () => publishTest.validateProviderPayload({ platform: 'x' }, { text: '', mediaUrl: null, mediaType: 'image', credential: {} }),
    (error) => error.code === 'PUBLISH_VALIDATION' && error.publishStage === 'preflight'
  );
  assert.throws(
    () => publishTest.validateProviderPayload({ platform: 'instagram' }, { text: 'x', mediaUrl: 'http://invalid', mediaType: 'image', credential: { accessToken: 't', igUserId: '1' } }),
    (error) => error.code === 'PUBLISH_VALIDATION' && error.publishStage === 'preflight'
  );
});

test('dry-run string inputs are normalized instead of using JavaScript truthiness', () => {
  assert.equal(publishTest.boolValue(false), false);
  assert.equal(publishTest.boolValue('false'), false);
  assert.equal(publishTest.boolValue('0'), false);
  assert.equal(publishTest.boolValue(true), true);
  assert.equal(publishTest.boolValue('true'), true);
  assert.equal(publishTest.boolValue('1'), true);
});

test('live preflight proves durable state branch write and cleanup access', async () => {
  const env = savedEnv(['SNS_REQUIRE_DURABLE_STATE', 'SNS_DURABLE_STATE_BRANCH', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']);
  const previousFetch = global.fetch;
  const methods = [];
  try {
    process.env.SNS_REQUIRE_DURABLE_STATE = 'true';
    process.env.SNS_DURABLE_STATE_BRANCH = 'sns-ai-state';
    process.env.GITHUB_TOKEN = 'test-token';
    delete process.env.GH_TOKEN;
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_RUN_ID = '123';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    global.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      methods.push(method);
      if (String(url).includes('/branches/')) return new Response(JSON.stringify({ name: 'sns-ai-state' }), { status: 200 });
      if (method === 'PUT') return new Response(JSON.stringify({ content: { sha: 'probe-sha' } }), { status: 201 });
      if (method === 'DELETE') return new Response(JSON.stringify({ commit: { sha: 'cleanup-sha' } }), { status: 200 });
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };
    const result = await preflightTest.durableStateBranchCheck();
    assert.equal(result.ok, true);
    assert.equal(result.writeVerified, true);
    assert.deepEqual(methods, ['GET', 'PUT', 'DELETE']);
  } finally {
    global.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('live preflight blocks auto mode when durable branch exists but is not writable', async () => {
  const env = savedEnv(['SNS_REQUIRE_DURABLE_STATE', 'SNS_DURABLE_STATE_BRANCH', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY']);
  const previousFetch = global.fetch;
  try {
    process.env.SNS_REQUIRE_DURABLE_STATE = 'true';
    process.env.SNS_DURABLE_STATE_BRANCH = 'sns-ai-state';
    process.env.GITHUB_TOKEN = 'test-token';
    delete process.env.GH_TOKEN;
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('/branches/')) return new Response(JSON.stringify({ name: 'sns-ai-state' }), { status: 200 });
      if ((options.method || 'GET') === 'PUT') return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
      throw new Error(`Unexpected fetch: ${options.method || 'GET'} ${url}`);
    };
    const result = await preflightTest.durableStateBranchCheck();
    assert.equal(result.ok, false);
    assert.equal(result.writeVerified, false);
    assert.match(result.error, /Resource not accessible/);
  } finally {
    global.fetch = previousFetch;
    restoreEnv(env);
  }
});
