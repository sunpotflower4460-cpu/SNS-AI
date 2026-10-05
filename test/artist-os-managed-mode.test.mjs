import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveArtistOsMode, assertInboundReplyExecutionAllowed } from '../src/ops/artist-os-mode.mjs';
import { buildServiceCapabilities } from '../src/ops/service-capabilities.mjs';
import { loadRuntimePolicy } from '../src/ops/manual-only.mjs';
import { sendXReply, sendXDirectMessage } from '../src/engagement/providers/x.mjs';
import { sendInstagramCommentReply, sendInstagramDm, sendInstagramPrivateReply } from '../src/engagement/providers/instagram.mjs';
import { sendResponseWithDeliveryGuard } from '../src/engagement/run.mjs';
import { getDeliveryRecord } from '../src/engagement/delivery-ledger.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LEDGER = `${ROOT}data/engagement-delivery-ledger.json`;
const CODE = 'MANAGED_MODE_INBOUND_REPLY_BLOCKED';

async function withEnv(value, task) {
  const saved = process.env.ARTIST_OS_MODE;
  const savedFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), method: options?.method }); return new Response(JSON.stringify({ id: '1', data: { id: '1' } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  if (value === undefined) delete process.env.ARTIST_OS_MODE; else process.env.ARTIST_OS_MODE = value;
  try { return await task(calls); }
  finally {
    globalThis.fetch = savedFetch;
    if (saved === undefined) delete process.env.ARTIST_OS_MODE; else process.env.ARTIST_OS_MODE = saved;
  }
}

const blocked = (fn) => assert.rejects(fn, (error) => error.code === CODE);
const xCredential = { accessToken: 'stub-token', expiresAt: new Date(Date.now() + 3600_000).toISOString() };

test('mode resolution table fails closed and honors the most restrictive source', () => {
  const cases = [
    [{}, undefined, 'standalone', false],
    [{ ARTIST_OS_MODE: '' }, undefined, 'standalone', false],
    [{ ARTIST_OS_MODE: 'standalone' }, undefined, 'standalone', false],
    [{ ARTIST_OS_MODE: 'artist_os_managed' }, undefined, 'artist_os_managed', false],
    [{ ARTIST_OS_MODE: 'managed' }, undefined, 'artist_os_managed', true],
    [{ ARTIST_OS_MODE: 'off' }, undefined, 'artist_os_managed', true],
    [{}, { artistOsMode: 'artist_os_managed' }, 'artist_os_managed', false],
    [{ ARTIST_OS_MODE: 'standalone' }, { artistOsMode: 'artist_os_managed' }, 'artist_os_managed', false],
    [{ ARTIST_OS_MODE: 'artist_os_managed' }, { artistOsMode: 'standalone' }, 'artist_os_managed', false],
    [{}, { artistOsMode: 'bogus' }, 'artist_os_managed', true]
  ];
  for (const [env, policy, mode, modeInvalid] of cases) assert.deepEqual(resolveArtistOsMode(env, policy), { mode, modeInvalid }, JSON.stringify([env, policy]));
});

test('assertInboundReplyExecutionAllowed throws only in managed mode for live sends', () => {
  assert.throws(() => assertInboundReplyExecutionAllowed({ env: { ARTIST_OS_MODE: 'artist_os_managed' }, dryRun: false }), (e) => e.code === CODE);
  assert.throws(() => assertInboundReplyExecutionAllowed({ env: { ARTIST_OS_MODE: 'zzz' } }), (e) => e.code === CODE);
  assert.doesNotThrow(() => assertInboundReplyExecutionAllowed({ env: { ARTIST_OS_MODE: 'artist_os_managed' }, dryRun: true }));
  assert.doesNotThrow(() => assertInboundReplyExecutionAllowed({ env: {}, dryRun: false }));
});

test('loadRuntimePolicy validates optional artistOsMode', async () => {
  const path = `${ROOT}data/.tmp-runtime-policy-test.json`;
  const base = { schemaVersion: 1, manualOnly: true };
  try {
    await writeFile(path, JSON.stringify({ ...base, artistOsMode: 'artist_os_managed' }));
    assert.equal((await loadRuntimePolicy(path)).artistOsMode, 'artist_os_managed');
    await writeFile(path, JSON.stringify({ ...base, artistOsMode: 'nope' }));
    await assert.rejects(() => loadRuntimePolicy(path), /artistOsMode/);
  } finally { await rm(path, { force: true }); }
});

test('managed mode blocks all provider send functions with zero network calls', async () => {
  await withEnv('artist_os_managed', async (calls) => {
    await blocked(() => sendXReply({ credential: xCredential, postId: '123', text: 'hi', dryRun: false }));
    await blocked(() => sendXDirectMessage({ credential: xCredential, participantId: '456', text: 'hi', dryRun: false }));
    await blocked(() => sendInstagramCommentReply({ accessToken: 't', commentId: '1', message: 'hi', dryRun: false }));
    await blocked(() => sendInstagramDm({ accessToken: 't', igUserId: '2', recipientId: '3', message: 'hi', dryRun: false }));
    await blocked(() => sendInstagramPrivateReply({ accessToken: 't', igUserId: '2', commentId: '1', message: 'hi', dryRun: false }));
    assert.equal(calls.length, 0);
    // dry-run (the recommendation path) still works
    assert.equal((await sendXReply({ credential: xCredential, postId: '123', text: 'hi', dryRun: true })).dryRun, true);
    assert.equal((await sendInstagramDm({ accessToken: 't', igUserId: '2', recipientId: '3', message: 'hi', dryRun: true })).dryRun, true);
    assert.equal(calls.length, 0);
  });
});

test('invalid ARTIST_OS_MODE also blocks provider sends', async () => {
  await withEnv('garbage', async (calls) => {
    await blocked(() => sendInstagramCommentReply({ accessToken: 't', commentId: '1', message: 'hi', dryRun: false }));
    assert.equal(calls.length, 0);
  });
});

test('standalone live send still reaches the provider stub', async () => {
  await withEnv(undefined, async (calls) => {
    await sendInstagramCommentReply({ accessToken: 't', commentId: '1', message: 'hi', dryRun: false });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/1\/replies$/);
  });
});

test('managed mode delivery guard creates no ledger record and sends nothing', async () => {
  const before = await readFile(LEDGER, 'utf8').catch(() => null);
  try {
    await rm(LEDGER, { force: true });
    await withEnv('artist_os_managed', async (calls) => {
      const key = 'c'.repeat(32);
      const event = { platform: 'instagram', kind: 'reply', commentId: '9', public: true };
      const account = { credential: { accessToken: 't', igUserId: '2' } };
      const out = await sendResponseWithDeliveryGuard({ accountId: 'x', account, event, key, text: 'hi', dryRun: false });
      assert.equal(out.state, 'managed-blocked');
      assert.equal(calls.length, 0);
      assert.equal(await getDeliveryRecord(key), null);
      const dry = await sendResponseWithDeliveryGuard({ accountId: 'x', account, event, key, text: 'hi', dryRun: true });
      assert.equal(dry.state, 'dry-run');
    });
  } finally {
    if (before == null) await rm(LEDGER, { force: true }); else await writeFile(LEDGER, before, 'utf8');
  }
});

test('capability snapshot reflects mode, ownership and never leaks secrets', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const live = { enabled: true, liveAccounts: ['a'] };
  const managed = buildServiceCapabilities({ env: { ARTIST_OS_MODE: 'artist_os_managed' }, engagementPolicy: live, now, version: '1.2.3' });
  assert.equal(managed.contractVersion, 1);
  assert.equal(managed.service, 'sns-ai');
  assert.equal(managed.status, 'healthy');
  assert.equal(managed.runtimeMode, 'artist_os_managed');
  assert.equal(managed.ownership.inboundReplyExecution, false);
  assert.equal(managed.ownership.recommendation, true);
  assert.ok(!managed.capabilities.some((c) => /^reply\..*\.execute$/.test(c)));
  assert.ok(managed.capabilities.includes('recommendation.read') && managed.capabilities.includes('strategy.read'));
  assert.equal(managed.checkedAt, now.toISOString());

  const invalid = buildServiceCapabilities({ env: { ARTIST_OS_MODE: 'oops' }, engagementPolicy: live, now });
  assert.equal(invalid.status, 'degraded');
  assert.ok(invalid.degradedReason);
  assert.equal(invalid.modeInvalid, true);
  assert.equal(invalid.ownership.inboundReplyExecution, false);

  const standaloneLive = buildServiceCapabilities({ env: {}, engagementPolicy: live, now });
  assert.equal(standaloneLive.runtimeMode, 'standalone');
  assert.equal(standaloneLive.ownership.inboundReplyExecution, true);
  assert.ok(standaloneLive.capabilities.includes('reply.x.execute'));
  const standaloneOff = buildServiceCapabilities({ env: {}, engagementPolicy: { enabled: false, liveAccounts: [] }, now });
  assert.equal(standaloneOff.ownership.inboundReplyExecution, false);
  assert.ok(!standaloneOff.capabilities.some((c) => c.includes('.execute')));
  assert.doesNotMatch(JSON.stringify([managed, invalid, standaloneLive]), /token|secret|password/i);
});

test('static: managed guard precedes beginDelivery in run.mjs and is inside each provider', async () => {
  const run = await readFile(`${ROOT}src/engagement/run.mjs`, 'utf8');
  const start = run.indexOf('async function sendResponseWithDeliveryGuard');
  const guarded = run.slice(start, run.indexOf('async function collectEvents', start));
  assert.ok(guarded.indexOf('assertInboundReplyExecutionAllowed') >= 0);
  assert.ok(guarded.indexOf('assertInboundReplyExecutionAllowed') < guarded.indexOf('beginDelivery'));
  for (const file of ['x', 'instagram']) {
    const src = await readFile(`${ROOT}src/engagement/providers/${file}.mjs`, 'utf8');
    const fn = src.slice(src.indexOf('async function assertLiveMutationAllowed'));
    assert.ok(fn.indexOf('assertInboundReplyExecutionAllowed') >= 0 && fn.indexOf('assertInboundReplyExecutionAllowed') < fn.indexOf('assertProviderMutationAllowed'));
  }
});
