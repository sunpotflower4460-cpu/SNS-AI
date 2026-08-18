import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  beginDelivery,
  getDeliveryRecord,
  markDelivery,
  __test as deliveryTest
} from '../src/engagement/delivery-ledger.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LEDGER = `${ROOT}data/engagement-delivery-ledger.json`;

async function readMaybe(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function withLedgerSandbox(task) {
  const before = await readMaybe(LEDGER);
  const savedEnv = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    SNS_DURABLE_STATE_BRANCH: process.env.SNS_DURABLE_STATE_BRANCH
  };
  const realFetch = globalThis.fetch;
  try {
    await rm(LEDGER, { force: true });
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.SNS_DURABLE_STATE_BRANCH;
    return await task();
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    if (before == null) await rm(LEDGER, { force: true });
    else await writeFile(LEDGER, before, 'utf8');
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('local delivery claim is at-most-once and definitive failures can be retried', async () => {
  await withLedgerSandbox(async () => {
    const sentKey = 'a'.repeat(32);
    const first = await beginDelivery({ key: sentKey, accountId: 'music-tools-x', platform: 'x', kind: 'reply', publicInteraction: true });
    assert.equal(first.claimed, true);
    assert.equal(first.record.status, 'sending');
    assert.equal(first.record.attempts, 1);

    const duplicateBeforeSendCompletes = await beginDelivery({ key: sentKey, accountId: 'music-tools-x', platform: 'x', kind: 'reply', publicInteraction: true });
    assert.equal(duplicateBeforeSendCompletes.claimed, false);
    assert.equal(duplicateBeforeSendCompletes.record.status, 'sending');

    await markDelivery(sentKey, 'sent');
    const duplicateAfterSuccess = await beginDelivery({ key: sentKey, accountId: 'music-tools-x', platform: 'x', kind: 'reply', publicInteraction: true });
    assert.equal(duplicateAfterSuccess.claimed, false);
    assert.equal(duplicateAfterSuccess.record.status, 'sent');
    assert.equal((await getDeliveryRecord(sentKey)).status, 'sent');

    const failedKey = 'b'.repeat(32);
    assert.equal((await beginDelivery({ key: failedKey, accountId: 'music-tools-x', platform: 'x', kind: 'dm' })).claimed, true);
    await markDelivery(failedKey, 'failed', { failureCode: 'HTTP_400' });
    const retry = await beginDelivery({ key: failedKey, accountId: 'music-tools-x', platform: 'x', kind: 'dm' });
    assert.equal(retry.claimed, true);
    assert.equal(retry.record.attempts, 2);

    await assert.rejects(() => getDeliveryRecord('not-a-key'), /32-character hexadecimal/);
    await assert.rejects(() => markDelivery(sentKey, 'invented'), /Unsupported engagement delivery status/);
  });
});

test('delivery ledger compaction never evicts unresolved ambiguity records', () => {
  const now = Date.parse('2026-08-18T00:00:00Z');
  const records = {
    unresolved_old: { status: 'unknown', updatedAt: '2020-01-01T00:00:00Z' },
    sending_old: { status: 'sending', updatedAt: '2020-01-01T00:00:00Z' },
    resolved_old: { status: 'sent', updatedAt: '2020-01-01T00:00:00Z' },
    resolved_recent: { status: 'sent', updatedAt: '2026-08-17T00:00:00Z' }
  };
  const compacted = deliveryTest.compactRecords(records, now);
  assert.ok(compacted.unresolved_old);
  assert.ok(compacted.sending_old);
  assert.ok(compacted.resolved_recent);
  assert.equal(compacted.resolved_old, undefined);

  const manyResolved = {};
  for (let i = 0; i < deliveryTest.MAX_RESOLVED_RECORDS + 25; i += 1) {
    manyResolved[`k${i}`] = { status: 'sent', updatedAt: new Date(now - i * 1000).toISOString() };
  }
  assert.equal(Object.keys(deliveryTest.compactRecords(manyResolved, now)).length, deliveryTest.MAX_RESOLVED_RECORDS);
});

test('delivery failure classification retries only provider-confirmed non-acceptance', () => {
  assert.equal(deliveryTest.definitiveDeliveryFailure({ status: 400 }), true);
  assert.equal(deliveryTest.definitiveDeliveryFailure({ status: 401 }), true);
  assert.equal(deliveryTest.definitiveDeliveryFailure({ status: 429 }), true);
  assert.equal(deliveryTest.definitiveDeliveryFailure({ status: 408 }), false);
  assert.equal(deliveryTest.definitiveDeliveryFailure({ status: 409 }), false);
  assert.equal(deliveryTest.definitiveDeliveryFailure({ status: 425 }), false);
  assert.equal(deliveryTest.definitiveDeliveryFailure({ status: 500 }), false);
  assert.equal(deliveryTest.definitiveDeliveryFailure(new Error('network failed')), false);
  assert.equal(deliveryTest.deliveryBlocksSend({ status: 'sending' }), true);
  assert.equal(deliveryTest.deliveryBlocksSend({ status: 'failed' }), false);
  assert.equal(deliveryTest.deliveryNeedsHuman({ status: 'unknown' }), true);
  assert.equal(deliveryTest.deliveryNeedsHuman({ status: 'sent' }), false);
});

test('remote delivery claim uses sns-ai-state CAS and stores privacy-safe metadata only', async () => {
  await withLedgerSandbox(async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.SNS_DURABLE_STATE_BRANCH = 'sns-ai-state';

    let remote = null;
    let sha = null;
    let putCount = 0;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      const method = String(options.method || 'GET').toUpperCase();
      assert.equal(target.includes('/contents/data/engagement-delivery-ledger.json'), true);
      if (method === 'GET') {
        if (!remote) return jsonResponse({ message: 'Not Found' }, 404);
        return jsonResponse({ content: Buffer.from(`${JSON.stringify(remote)}\n`).toString('base64'), sha });
      }
      assert.equal(method, 'PUT');
      putCount += 1;
      if (putCount === 1) return jsonResponse({ message: 'conflict' }, 409);
      const request = JSON.parse(options.body);
      assert.equal(request.branch, 'sns-ai-state');
      remote = JSON.parse(Buffer.from(request.content, 'base64').toString('utf8'));
      sha = `sha-${putCount}`;
      return jsonResponse({ content: { sha } });
    };

    const key = 'c'.repeat(32);
    const claimed = await beginDelivery({ key, accountId: 'music-tools-x', platform: 'x', kind: 'dm', publicInteraction: false });
    assert.equal(claimed.claimed, true);
    assert.equal(putCount, 2);
    assert.equal(remote.records[key].status, 'sending');
    assert.deepEqual(Object.keys(remote.records[key]).sort(), [
      'account', 'attempts', 'createdAt', 'issueNumber', 'kind', 'platform', 'publicInteraction', 'startedAt', 'status', 'updatedAt'
    ].sort());
    assert.equal(JSON.stringify(remote.records[key]).includes('participant'), false);
    assert.equal(JSON.stringify(remote.records[key]).includes('response'), false);

    await markDelivery(key, 'unknown', { issueNumber: 123, failureCode: 'NETWORK' }, { durable: true });
    assert.equal(remote.records[key].status, 'unknown');
    assert.equal(remote.records[key].issueNumber, 123);
    assert.equal(remote.records[key].failureCode, 'NETWORK');

    const replay = await beginDelivery({ key, accountId: 'music-tools-x', platform: 'x', kind: 'dm' });
    assert.equal(replay.claimed, false);
    assert.equal(replay.record.status, 'unknown');
  });
});

test('run path reserves durable delivery before provider send and never stores private payload in ledger', async () => {
  const run = await readFile(`${ROOT}src/engagement/run.mjs`, 'utf8');
  const ledger = await readFile(`${ROOT}src/engagement/delivery-ledger.mjs`, 'utf8');
  const fnStart = run.indexOf('async function sendResponseWithDeliveryGuard');
  const fnEnd = run.indexOf('async function collectEvents', fnStart);
  const guarded = run.slice(fnStart, fnEnd);
  assert.ok(fnStart >= 0 && fnEnd > fnStart);
  assert.ok(guarded.indexOf('beginDelivery') < guarded.indexOf('sendResponse(account, event, text, false)'));
  assert.match(guarded, /ENGAGEMENT_DELIVERY_UNKNOWN|deliveryUnknownError/);
  assert.match(run, /\[engagement-delivery-unknown\]/);
  assert.doesNotMatch(ledger, /event\.text|participantId|responseText|decision\.response/);
});
