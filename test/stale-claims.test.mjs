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

test('findStuckClaims reports no stuck claims when the durable state branch does not exist yet', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY');
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  try {
    globalThis.fetch = async () => jsonResponse({ message: 'Not Found' }, 404);
    const report = await findStuckClaims({ maxAgeHours: 3 });
    assert.equal(report.skipped, false);
    assert.deepEqual(report.stuck, []);
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
