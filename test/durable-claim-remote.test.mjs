import test from 'node:test';
import assert from 'node:assert/strict';

import { beginPublishClaim, __test as claimTest } from '../src/lib/durable-claim.mjs';

function saveEnv(...names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function encodedClaim(slotId, status, detail = {}) {
  return Buffer.from(`${JSON.stringify({ slotId, status, ...detail })}\n`, 'utf8').toString('base64');
}

test('remote durable claim create conflict is reconciled into SLOT_ALREADY_CLAIMED when another runner won', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY');
  const slotId = 'remote-race:2026-08-13:12:34';
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  claimTest.resetForTests();
  let remoteExists = false;
  let puts = 0;
  try {
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/contents/data/durable-claims/') && (options.method || 'GET') === 'GET') {
        if (!remoteExists) return jsonResponse({ message: 'Not Found' }, 404);
        return jsonResponse({ sha: 'winner-sha', content: encodedClaim(slotId, 'publishing', { account: 'winner' }) });
      }
      if (target.includes('/contents/data/durable-claims/') && options.method === 'PUT') {
        puts += 1;
        remoteExists = true;
        return jsonResponse({ message: 'sha was not supplied' }, 422);
      }
      throw new Error(`Unexpected mocked URL: ${target} (${options.method || 'GET'})`);
    };

    await assert.rejects(
      beginPublishClaim(slotId, { account: 'loser' }),
      (error) => error.code === 'SLOT_ALREADY_CLAIMED' && error.claim?.account === 'winner'
    );
    assert.equal(puts, 1);
  } finally {
    claimTest.resetForTests();
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('remote durable claim create conflict returns an idempotent replay when the winner already published', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY');
  const slotId = 'remote-race:2026-08-13:12:35';
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  claimTest.resetForTests();
  let remoteExists = false;
  try {
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/contents/data/durable-claims/') && (options.method || 'GET') === 'GET') {
        if (!remoteExists) return jsonResponse({ message: 'Not Found' }, 404);
        return jsonResponse({ sha: 'published-sha', content: encodedClaim(slotId, 'published', { providerPostId: 'post-123' }) });
      }
      if (target.includes('/contents/data/durable-claims/') && options.method === 'PUT') {
        remoteExists = true;
        return jsonResponse({ message: 'conflict' }, 409);
      }
      throw new Error(`Unexpected mocked URL: ${target} (${options.method || 'GET'})`);
    };

    const replay = await beginPublishClaim(slotId, { account: 'loser' });
    assert.equal(replay.claimed, false);
    assert.equal(replay.replay, true);
    assert.equal(replay.claim.providerPostId, 'post-123');
  } finally {
    claimTest.resetForTests();
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});
