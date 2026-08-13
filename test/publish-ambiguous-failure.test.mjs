import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { publish } from '../src/publish.mjs';
import { getDurableClaim } from '../src/lib/durable-claim.mjs';

// Regression/adversarial coverage for the single most important safety property in this codebase:
// when the FINAL mutating call to a provider (the actual tweet-create / media_publish request) fails
// in a way that gives no proof it didn't already succeed server-side - a raw network exception
// (ECONNRESET/timeout equivalent), as opposed to a clean HTTP error response - the system must:
//   1. record the durable claim as 'publish_unknown' (ambiguous), never 'failed' (which would be
//      treated as safe to retry) and never silently 'published',
//   2. block every subsequent publish() attempt for that exact slot with SLOT_ALREADY_CLAIMED,
//      so nothing ever automatically retries and risks a duplicate real-world post.
// This exact scenario (Step 3, Cases D/E of the independent audit) had zero test coverage anywhere in
// the suite before this file - every existing test either simulated a clean HTTP error response or
// never drove a real network-level exception through the real publish() -> publishX() -> fetchJson()
// stack.

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const DURABLE_DIR = fileURLToPath(new URL('../data/durable-claims/', import.meta.url));
const DATA_FILES = [
  fileURLToPath(new URL('../data/history.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/audit.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/state.json', import.meta.url)),
  fileURLToPath(new URL('../data/runtime-health.json', import.meta.url))
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

function xAccount(credentialKey) {
  return {
    platform: 'x', enabled: true, mode: 'auto', credentialKey, displayName: 'Ambiguous Failure X',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'test', schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { maxChars: 280 }, safety: {}, resilience: { enabled: false }, budgets: { enabled: false },
    media: { strategy: 'none', type: 'image' }
  };
}

async function installAccount(id, credentialKey) {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts[id] = xAccount(credentialKey);
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function withLocalOfflineFixture(accountId, run) {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY', 'OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  await rm(DURABLE_DIR, { recursive: true, force: true });
  for (const path of DATA_FILES) await rm(path, { force: true });
  try {
    await installAccount(accountId, accountId);
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      [accountId]: { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }
    });
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
}

test('a raw network exception on the tweet-create call marks the claim publish_unknown and blocks any retry', async () => {
  const slotId = 'ambiguous-failure:2026-08-13:08:00';
  let createPostCalls = 0;
  await withLocalOfflineFixture('ambiguous-x', async () => {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.x.com/2/tweets') {
        createPostCalls += 1;
        // A raw thrown exception, not an HTTP error response - simulates a dropped connection or
        // timeout where X's server may or may not have already accepted the post before the client
        // gave up waiting for a response.
        throw new TypeError('fetch failed: socket hang up');
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    await assert.rejects(
      () => publish({ account: 'ambiguous-x', text: 'Will this post or not?', source: 'test', slotId }),
      /socket hang up/
    );
    assert.equal(createPostCalls, 1, 'the provider must have been called exactly once so far');

    const claim = await getDurableClaim(slotId, { fresh: true });
    assert.equal(claim?.status, 'publish_unknown', `an ambiguous provider failure must never be recorded as 'failed' (which would allow an automatic retry) or silently 'published'; got: ${JSON.stringify(claim)}`);

    // The second attempt (e.g. a retried CI run, a re-triggered workflow_dispatch, an operator
    // manually re-running the same slot) must be blocked before it ever reaches the provider again.
    await assert.rejects(
      () => publish({ account: 'ambiguous-x', text: 'Will this post or not?', source: 'test', slotId }),
      (error) => error.code === 'SLOT_ALREADY_CLAIMED'
    );
    assert.equal(createPostCalls, 1, 'a retry for the same slot must never re-invoke the provider while the claim is publish_unknown');
  });
});

test('an unambiguous 4xx provider rejection (never reached the provider) is marked failed and CAN be retried', async () => {
  const slotId = 'definitive-failure:2026-08-13:08:00';
  let createPostCalls = 0;
  await withLocalOfflineFixture('definitive-x', async () => {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.x.com/2/tweets') {
        createPostCalls += 1;
        if (createPostCalls === 1) {
          return new Response(JSON.stringify({ errors: [{ message: 'text field is required' }] }), { status: 422, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ data: { id: 'retry-succeeded' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (target.startsWith('https://api.x.com/2/tweets/retry-succeeded?')) {
        return new Response(JSON.stringify({ data: { id: 'retry-succeeded', public_metrics: {}, non_public_metrics: {} }, includes: { media: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    await assert.rejects(() => publish({ account: 'definitive-x', text: 'First attempt', source: 'test', slotId }));
    const claimAfterFailure = await getDurableClaim(slotId, { fresh: true });
    assert.equal(claimAfterFailure?.status, 'failed', 'a definitive, never-mutated provider rejection must be marked failed, not stuck as ambiguous');

    const result = await publish({ account: 'definitive-x', text: 'First attempt', source: 'test', slotId });
    assert.equal(result.postId, 'retry-succeeded');
    assert.equal(createPostCalls, 2, 'a definitive failure must allow exactly one real retry, not be blocked forever');
  });
});
