import test from 'node:test';
import assert from 'node:assert/strict';

import { findStuckClaims } from '../src/ops/stale-claims.mjs';

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
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function encodeClaim(claim) {
  return Buffer.from(`${JSON.stringify(claim)}\n`, 'utf8').toString('base64');
}
function branchResponse(treeSha) {
  return jsonResponse({ name: 'sns-ai-state', commit: { sha: 'commit-sha', commit: { tree: { sha: treeSha } } } });
}

test('findStuckClaims rejects a non-positive or non-numeric maxAgeHours instead of silently using a nonsensical cutoff', async () => {
  await assert.rejects(findStuckClaims({ maxAgeHours: 0 }), /maxAgeHours must be a positive number/);
  await assert.rejects(findStuckClaims({ maxAgeHours: -3 }), /maxAgeHours must be a positive number/);
  await assert.rejects(findStuckClaims({ maxAgeHours: 'abc' }), /maxAgeHours must be a positive number/);
  await assert.rejects(findStuckClaims({ maxAgeHours: NaN }), /maxAgeHours must be a positive number/);
});

test('findStuckClaims propagates a non-404 GitHub API error (e.g. rate-limited/forbidden) instead of silently returning an empty report', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY');
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  try {
    // A 403 (e.g. secondary rate limit, insufficient token scope) is a genuinely different failure
    // mode from "the branch doesn't exist yet" (404) - it must surface as a loud failure too, not be
    // swallowed the same way a 404 used to be.
    globalThis.fetch = async () => jsonResponse({ message: 'API rate limit exceeded' }, 403);
    await assert.rejects(
      findStuckClaims({ maxAgeHours: 3 }),
      (error) => error.status === 403
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('findStuckClaims skips cleanly when there is no GitHub runtime available', async () => {
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY');
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  try {
    const report = await findStuckClaims();
    assert.equal(report.skipped, true);
    assert.deepEqual(report.stuck, []);
  } finally {
    restoreEnv(env);
  }
});

test('findStuckClaims fails loudly instead of silently reporting "no stuck claims" when the durable state branch does not exist', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY');
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  try {
    // The sns-ai-state branch is a documented go-live precondition (docs/GO_LIVE_CHECKLIST.md): without
    // it, no durable claim is ever recorded and duplicate-publish protection is not active at all. A
    // missing branch must surface as a hard failure a human has to act on, not collapse into an empty,
    // falsely-reassuring "no stuck claims" report.
    globalThis.fetch = async () => jsonResponse({ message: 'Not Found' }, 404);
    await assert.rejects(
      findStuckClaims({ maxAgeHours: 3 }),
      (error) => error.code === 'DURABLE_STATE_BRANCH_MISSING' && /sns-ai-state/.test(error.message)
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('findStuckClaims only flags publishing/publish_unknown claims older than the threshold, ignoring fresh, published, failed, and unreadable ones appropriately', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY');
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  const now = Date.now();
  const hoursAgo = (h) => new Date(now - h * 3_600_000).toISOString();

  const files = {
    'aged-publishing.json': { slotId: 'acct-a:2026-08-01:08:00', account: 'acct-a', platform: 'x', status: 'publishing', createdAt: hoursAgo(10), updatedAt: hoursAgo(10) },
    'fresh-publishing.json': { slotId: 'acct-a:2026-08-13:08:00', account: 'acct-a', platform: 'x', status: 'publishing', createdAt: hoursAgo(0.1), updatedAt: hoursAgo(0.1) },
    'aged-publish-unknown.json': { slotId: 'acct-b:2026-08-01:08:00', account: 'acct-b', platform: 'instagram', status: 'publish_unknown', createdAt: hoursAgo(20), updatedAt: hoursAgo(20) },
    'aged-published.json': { slotId: 'acct-a:2026-08-01:09:00', account: 'acct-a', platform: 'x', status: 'published', createdAt: hoursAgo(50), updatedAt: hoursAgo(50) },
    'aged-failed.json': { slotId: 'acct-a:2026-08-01:10:00', account: 'acct-a', platform: 'x', status: 'failed', createdAt: hoursAgo(50), updatedAt: hoursAgo(50) },
    'corrupt.json': null
  };
  const shaFor = (name) => `blob-${name}`;

  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.github.com/repos/owner/repo/branches/sns-ai-state') return branchResponse('tree-sha');
      if (target === 'https://api.github.com/repos/owner/repo/git/trees/tree-sha?recursive=1') {
        return jsonResponse({
          truncated: false,
          tree: [
            ...Object.keys(files).map((name) => ({ path: `data/durable-claims/${name}`, type: 'blob', sha: shaFor(name) })),
            { path: 'data/durable-claims/.preflight-abc.json', type: 'blob', sha: 'blob-preflight-probe' },
            { path: 'data/history.jsonl', type: 'blob', sha: 'blob-unrelated' },
            { path: 'data/durable-claims', type: 'tree', sha: 'tree-durable-claims' }
          ]
        });
      }
      const blobMatch = target.match(/\/git\/blobs\/blob-(.+)$/);
      if (blobMatch) {
        const name = blobMatch[1];
        if (name === 'preflight-probe' || name === 'unrelated') return jsonResponse({ content: encodeClaim({ probe: true }) });
        if (name === 'corrupt.json') return jsonResponse({ content: Buffer.from('not-json', 'utf8').toString('base64') });
        return jsonResponse({ content: encodeClaim(files[name]) });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const report = await findStuckClaims({ maxAgeHours: 3 });
    assert.equal(report.skipped, false);
    assert.equal(report.truncated, false);
    const bySlot = Object.fromEntries(report.stuck.filter((row) => row.slotId).map((row) => [row.slotId, row]));

    assert.ok(bySlot['acct-a:2026-08-01:08:00'], 'aged publishing claim must be reported');
    assert.ok(bySlot['acct-b:2026-08-01:08:00'], 'aged publish_unknown claim must be reported');
    assert.equal(Object.values(bySlot).length, 2, 'fresh publishing, published, and failed claims must not be reported');

    const unreadable = report.stuck.find((row) => row.file === 'corrupt.json');
    assert.ok(unreadable, 'a claim file that fails to decode must still be surfaced, not silently dropped');
    assert.equal(unreadable.status, 'unreadable');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('findStuckClaims surfaces truncated:true instead of silently under-reporting when the state branch tree exceeds the Trees API single-request limit', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY');
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.github.com/repos/owner/repo/branches/sns-ai-state') return branchResponse('huge-tree-sha');
      if (target === 'https://api.github.com/repos/owner/repo/git/trees/huge-tree-sha?recursive=1') {
        return jsonResponse({ truncated: true, tree: [] });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    const report = await findStuckClaims({ maxAgeHours: 3 });
    assert.equal(report.truncated, true, 'a truncated Trees API response must be surfaced, not silently swallowed');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('findStuckClaims fetches claim blobs with bounded concurrency, not one at a time', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY', 'STALE_CLAIMS_BLOB_CONCURRENCY');
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  process.env.STALE_CLAIMS_BLOB_CONCURRENCY = '4';
  const BLOB_COUNT = 20;
  let inFlight = 0;
  let maxInFlight = 0;
  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.github.com/repos/owner/repo/branches/sns-ai-state') return branchResponse('tree-sha');
      if (target === 'https://api.github.com/repos/owner/repo/git/trees/tree-sha?recursive=1') {
        return jsonResponse({
          truncated: false,
          tree: Array.from({ length: BLOB_COUNT }, (_, i) => ({ path: `data/durable-claims/claim-${i}.json`, type: 'blob', sha: `blob-${i}` }))
        });
      }
      const blobMatch = target.match(/\/git\/blobs\/blob-(\d+)$/);
      if (blobMatch) {
        // As data/durable-claims/ grows into the thousands (nothing ever deletes a claim file), a fully
        // sequential one-request-per-blob loop would eventually exhaust the GitHub API rate limit on its
        // own. This asserts requests genuinely overlap (bounded concurrency), not just that the final
        // report is correct - a naive "await in a for loop" would still pass a correctness-only test.
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return jsonResponse({ content: encodeClaim({ status: 'published' }) });
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const report = await findStuckClaims({ maxAgeHours: 3 });
    assert.equal(report.skipped, false);
    assert.deepEqual(report.stuck, []);
    assert.ok(maxInFlight > 1, `expected overlapping blob requests, saw max concurrency ${maxInFlight}`);
    assert.ok(maxInFlight <= 4, `expected concurrency capped at 4, saw max concurrency ${maxInFlight}`);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('a malformed or oversized STALE_CLAIMS_BLOB_CONCURRENCY falls back to a safe default instead of silently skipping every claim, and actually bounds concurrency (not just correctness with a single blob)', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY', 'STALE_CLAIMS_BLOB_CONCURRENCY');
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  const BLOB_COUNT = 20;
  const stuckClaimFor = (i) => ({ slotId: `acct-a:2026-08-01:08:${String(i).padStart(2, '0')}`, account: 'acct-a', platform: 'x', status: 'publishing', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
  // A single-blob mock cannot distinguish "concurrency correctly bounded" from "concurrency silently
  // unbounded" - with only one item, any positive worker count processes it identically. Multiple blobs
  // with an artificial per-request delay are needed to actually observe how many requests run at once.
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFor = async (url) => {
    const target = String(url);
    if (target === 'https://api.github.com/repos/owner/repo/branches/sns-ai-state') return branchResponse('tree-sha');
    if (target === 'https://api.github.com/repos/owner/repo/git/trees/tree-sha?recursive=1') {
      return jsonResponse({
        truncated: false,
        tree: Array.from({ length: BLOB_COUNT }, (_, i) => ({ path: `data/durable-claims/claim-${i}.json`, type: 'blob', sha: `blob-${i}` }))
      });
    }
    const blobMatch = target.match(/\/git\/blobs\/blob-(\d+)$/);
    if (blobMatch) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return jsonResponse({ content: encodeClaim(stuckClaimFor(Number(blobMatch[1]))) });
    }
    throw new Error(`Unexpected mocked URL: ${target}`);
  };
  try {
    globalThis.fetch = fetchFor;
    // Number('abc') is NaN, and Math.max(1, NaN) is ALSO NaN (NaN poisons the comparison) - this used
    // to flow straight into Array.from({length: NaN}), which silently creates ZERO workers. Every blob
    // would go unevaluated and the report would come back "stuck: []" even though genuinely stuck
    // claims exist in the tree - a silent no-op is worse than a crash here, since it masks a real
    // problem as "all clear".
    process.env.STALE_CLAIMS_BLOB_CONCURRENCY = 'abc';
    maxInFlight = 0;
    const malformed = await findStuckClaims({ maxAgeHours: 3 });
    assert.equal(malformed.stuck.length, BLOB_COUNT, 'a malformed concurrency setting must still fall back to a safe default and evaluate every blob');
    assert.ok(maxInFlight > 1 && maxInFlight <= 8, `expected the default concurrency (bounded, not serial), saw max concurrency ${maxInFlight}`);

    process.env.STALE_CLAIMS_BLOB_CONCURRENCY = '0';
    maxInFlight = 0;
    const zero = await findStuckClaims({ maxAgeHours: 3 });
    assert.equal(zero.stuck.length, BLOB_COUNT, 'a zero concurrency setting must also fall back to the default, not spawn zero workers');
    assert.ok(maxInFlight > 1 && maxInFlight <= 8, `expected the default concurrency, saw max concurrency ${maxInFlight}`);

    // An oversized value must be capped, not taken at face value - otherwise a mistyped env var (e.g. an
    // extra zero) could fire one concurrent request per accumulated claim and defeat the whole point of
    // bounding the fetch loop. Asserting maxInFlight > 8 here (not just <= 16) proves the cap actually
    // raised concurrency above the plain default - a test that only checked "<= 16" would also pass if
    // this input were silently clamped down to the same default as the malformed/zero cases above.
    process.env.STALE_CLAIMS_BLOB_CONCURRENCY = '100000';
    maxInFlight = 0;
    const oversized = await findStuckClaims({ maxAgeHours: 3 });
    assert.equal(oversized.stuck.length, BLOB_COUNT, 'an oversized concurrency setting must still evaluate every blob (capped internally, not rejected)');
    assert.ok(maxInFlight > 8 && maxInFlight <= 16, `expected concurrency raised above the default and capped at 16, saw max concurrency ${maxInFlight}`);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});
