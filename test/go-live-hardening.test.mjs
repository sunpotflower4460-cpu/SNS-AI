import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { trustedApprovalPayload, __test as githubTest } from '../src/lib/github.mjs';
import { validateStrictConfig } from '../src/validate-strict-config.mjs';
import { __test as openaiTest } from '../src/lib/openai.mjs';
import { validateDraftText, xWeightedLength } from '../src/lib/safety.mjs';

const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

// Regression coverage for the go-live audit: the gaps that would let an operator complete every
// documented manual step and still end up with a system that silently does nothing.

test('the approval issue body tells the operator that the "approved" label is what publishes', () => {
  const account = 'music-tools-x';
  const slotId = 'music-tools-x:2026-08-18:09:00';
  const payload = githubTest.markedApprovalPayload({ account, slotId, text: 'draft text' }, account, slotId);
  const body = JSON.stringify(payload, null, 2);

  // publish.yml and trustedApprovalPayload both run JSON.parse over the WHOLE body, so the operator
  // instructions must live inside the JSON - appending prose after it would break every approval.
  assert.doesNotThrow(() => JSON.parse(body), 'the approval issue body must stay valid JSON');

  const issue = {
    title: `[approval] ${account} ${slotId}`,
    body,
    user: { login: 'github-actions[bot]' }
  };
  const trusted = trustedApprovalPayload(issue);
  assert.ok(trusted, 'the instruction field must not break provenance validation');
  assert.equal(trusted.account, account);
  assert.equal(trusted.slotId, slotId);
  assert.equal(trusted.text, 'draft text');

  assert.match(body, /approved/, 'the body must name the label that triggers publishing');
  // The instruction must be the first thing a human sees, not buried under the draft metadata.
  assert.ok(Object.keys(payload)[0] === '_howToPublish', 'instructions must render first in the issue body');
});

test('the scheduled health report runs the readiness doctor in --strict mode so it can actually fail', async () => {
  // doctor only sets a non-zero exit code when --strict is passed (see the CLI block in
  // src/ops/doctor-strict.mjs). health.yml is the daily alarm: Failure Watch turns a failed run into a
  // GitHub issue, so without --strict a readiness BLOCKER (expired/revoked credential, missing secret,
  // deprecated media backend) left the job green and the operator was never told.
  //
  // Deliberately scoped to health.yml. ci.yml runs doctor WITHOUT --strict on purpose - it has no
  // production secrets, so once a real account is enabled a strict readiness check there would always
  // fail on "missing credentials" and block every PR. maintenance.yml is a data-compaction job whose
  // doctor call only refreshes the report; failing it would skip its cleanup push and duplicate the
  // alert health.yml already raises.
  const yaml = await readFile(`${WORKFLOWS_DIR}health.yml`, 'utf8');
  assert.match(yaml, /npm run doctor/, 'health.yml is expected to run the readiness doctor');
  assert.match(
    yaml,
    /npm run doctor[^\n]*--strict/,
    'health.yml must invoke the readiness doctor with --strict, otherwise a blocker can never fail the job'
  );
});

test('strict config validation rejects non-numeric rate-limit knobs that would silently block every post', () => {
  // safeMaxPostsPerDay/safeMinMinutesBetweenPosts in src/lib/safety.mjs are fail-closed: a non-number
  // becomes 0 posts/day or an infinite cooldown. checkRateLimits then returns `rate-limited`, which is
  // NOT in FATAL_STATUSES, so the run exits 0 and every workflow stays green while nothing publishes.
  // The loose validator only does Number(), which accepts "2" and 15.5-as-string alike.
  const config = (safety) => ({
    defaults: {},
    accounts: { acct: { enabled: true, platform: 'x', credentialKey: 'acct', safety } }
  });

  const stringCap = validateStrictConfig(config({ maxPostsPerDay: '2', minMinutesBetweenPosts: 360 }));
  assert.ok(
    stringCap.some((error) => error.includes('safety.maxPostsPerDay')),
    'a string maxPostsPerDay must be rejected, not coerced to a zero-post cap at runtime'
  );

  const stringInterval = validateStrictConfig(config({ maxPostsPerDay: 2, minMinutesBetweenPosts: '360' }));
  assert.ok(
    stringInterval.some((error) => error.includes('safety.minMinutesBetweenPosts')),
    'a string minMinutesBetweenPosts must be rejected, not coerced to an infinite cooldown at runtime'
  );

  // A fractional interval is legitimate (unlike a post count), so only the integer knob rejects it.
  const fractional = validateStrictConfig(config({ maxPostsPerDay: 2, minMinutesBetweenPosts: 0.5 }));
  assert.ok(
    !fractional.some((error) => error.includes('safety.minMinutesBetweenPosts')),
    'a fractional minute interval is valid and must not be rejected'
  );

  const good = validateStrictConfig(config({ maxPostsPerDay: 2, minMinutesBetweenPosts: 360 }));
  assert.ok(
    !good.some((error) => error.includes('safety.maxPostsPerDay') || error.includes('safety.minMinutesBetweenPosts')),
    'the real music-tools-x shape must stay valid'
  );
});

test('the generation prompt states X weighted length, so a Japanese account is not asked for 280 real characters', () => {
  const account = {
    platform: 'x',
    generation: { maxChars: 280 },
    profile: {},
    safety: {}
  };
  const prompt = openaiTest.generationPrompt('music-tools-x', account, [], {}, '');
  const payload = JSON.parse(prompt.user);

  // The raw maxChars is still in the payload (other logic reads it); what matters is that the model is
  // also told how X actually counts, and what that leaves in real Japanese characters.
  assert.equal(payload.lengthBudget.unit, 'X weighted characters');
  assert.equal(payload.lengthBudget.limit, 280);
  assert.equal(payload.lengthBudget.approximateFullWidthCharacterBudget, 140);
  assert.match(prompt.system, /weighted characters/);

  // The stated budget must agree with the validator that actually enforces it - if these ever diverge the
  // model is being sent to a limit that will reject its output.
  const atBudget = 'あ'.repeat(payload.lengthBudget.approximateFullWidthCharacterBudget);
  assert.equal(xWeightedLength(atBudget), 280);
  assert.doesNotThrow(() => validateDraftText(account, atBudget), 'a draft at the advertised budget must pass');
  assert.throws(
    () => validateDraftText(account, `${atBudget}あ`),
    /weighted characters/,
    'one character over the advertised budget must be rejected - proving the budget is the real limit'
  );

  // A non-X account keeps plain character counting; the X rules must not leak into Instagram prompts.
  const ig = openaiTest.generationPrompt('ig', { platform: 'instagram', generation: { maxChars: 2200 }, profile: {} }, [], {}, '');
  assert.equal(JSON.parse(ig.user).lengthBudget.unit, 'characters');
  assert.doesNotMatch(ig.system, /weighted characters/);
});

test('readiness is not vacuously true when no account is enabled', async () => {
  // enabledRows.every(...) on an empty array is true, so doctor reported ready:true and live-preflight
  // returned ok:true before a single credential existed - while checking nothing at all. The go-live
  // checklist asks the operator to confirm "Doctor ready" and "Live Preflight ready", so both boxes
  // ticked themselves. This is the committed state of the repo today (all three accounts disabled).
  const { buildReadinessReport } = await import('../src/ops/doctor.mjs');
  const { buildStrictReadinessReport } = await import('../src/ops/doctor-strict.mjs');
  const { runLivePreflight } = await import('../src/ops/live-preflight.mjs');

  const config = JSON.parse(await readFile(fileURLToPath(new URL('../config/accounts.json', import.meta.url)), 'utf8'));
  const enabled = Object.values(config.accounts || {}).filter((account) => account?.enabled === true && account.mode !== 'pause');
  assert.equal(enabled.length, 0, 'this test describes the dormant repo state; re-check it once an account is enabled');

  const report = await buildReadinessReport();
  assert.equal(report.ready, false, 'readiness with zero enabled accounts must not be reported as ready');
  assert.equal(report.state, 'waiting_for_accounts');

  const strict = await buildStrictReadinessReport();
  assert.equal(strict.ready, false);
  assert.equal(strict.state, 'waiting_for_accounts');

  const preflight = await runLivePreflight();
  assert.equal(preflight.ok, false, 'preflight proves nothing with no account selected, so it must not claim ok');
  assert.equal(preflight.state, 'nothing_enabled');
  assert.equal(preflight.openai.checked, false);
  assert.equal(preflight.durableState.checked, false);

  // But a dormant repo is NOT an alarm: health.yml runs `doctor --strict` daily, and failing it here
  // would have Failure Watch open an issue every day about a repo that is intentionally not live yet.
  // Only `blocked` - a config error, or an enabled-but-broken account - may fail the strict exit.
  assert.notEqual(strict.state, 'blocked');
});

test('X credential verification rejects a read-only access token instead of passing preflight', async () => {
  // A token minted while the X app was still set to "Read" authenticates perfectly against
  // GET /2/users/me, which for a text-only account is the ENTIRE preflight. The failure only appears at
  // the first real POST /2/tweets as a 403 with no error.code, which trips the resilience circuit.
  const { verifyXCredential } = await import('../src/providers/x.mjs');
  const previousFetch = globalThis.fetch;
  const credential = {
    consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'ats'
  };
  const respond = (accessLevel) => async () => new Response(
    JSON.stringify({ data: { id: 'u1', username: 'example', name: 'Example' } }),
    { status: 200, headers: accessLevel ? { 'content-type': 'application/json', 'x-access-level': accessLevel } : { 'content-type': 'application/json' } }
  );
  try {
    globalThis.fetch = respond('read');
    await assert.rejects(verifyXCredential(credential), /not read-write/, 'a read-only token must fail preflight');
    await assert.rejects(verifyXCredential(credential), /REGENERATE/, 'the fix - regenerating the token - must be in the message');

    globalThis.fetch = respond('read-write');
    const rw = await verifyXCredential(credential);
    assert.equal(rw.writeVerified, true);
    assert.equal(rw.accessLevel, 'read-write');

    // The header is not a documented part of the v2 contract, so its absence must never block a
    // working account - it is reported as unknown and nothing else changes.
    globalThis.fetch = respond(null);
    const unknown = await verifyXCredential(credential);
    assert.equal(unknown.writeVerified, null);
    assert.equal(unknown.accessLevel, 'unknown');
    assert.equal(unknown.id, 'u1');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Instagram credential verification proves the publish permission and a Professional account', async () => {
  // fields=id,username is satisfied by instagram_business_basic alone, so the old check proved neither
  // that content publishing was granted nor that the account is Professional. Both would first surface
  // at the real publish, after a paid generation.
  const { verifyInstagramCredential } = await import('../src/providers/instagram.mjs');
  const previousFetch = globalThis.fetch;
  const credential = { igUserId: 'ig-1', accessToken: 'token' };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  try {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes('content_publishing_limit')) return json({ data: [{ quota_usage: 2, config: { quota_total: 100 } }] });
      return json({ id: 'ig-1', username: 'shop', account_type: 'BUSINESS' });
    };
    const ok = await verifyInstagramCredential({ credential });
    assert.equal(ok.accountType, 'BUSINESS');
    assert.deepEqual(ok.publishAccess.quota, { used: 2, total: 100 });

    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes('content_publishing_limit')) return json({ error: { message: 'Application does not have permission for this action', code: 10 } }, 403);
      return json({ id: 'ig-1', username: 'shop', account_type: 'BUSINESS' });
    };
    await assert.rejects(
      verifyInstagramCredential({ credential }),
      /instagram_business_content_publish/,
      'a token without the publish permission must fail preflight, not the first real post'
    );

    globalThis.fetch = async () => json({ id: 'ig-1', username: 'me', account_type: 'PERSONAL' });
    await assert.rejects(verifyInstagramCredential({ credential }), /Professional/, 'a personal account cannot publish via the API');

    // A transient/unclassifiable failure must not be mistaken for a missing permission.
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes('content_publishing_limit')) return json({ error: { message: 'Please reduce the amount of data', code: 1 } }, 500);
      return json({ id: 'ig-1', username: 'shop', account_type: 'MEDIA_CREATOR' });
    };
    const degraded = await verifyInstagramCredential({ credential });
    assert.equal(degraded.publishAccess.ok, false);
    assert.match(degraded.publishAccess.error, /reduce the amount of data/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('the preflight workflow can verify the approval channel it depends on', async () => {
  // approval mode does POST /labels then POST /issues after a full paid generation. preflight.yml
  // granted only `contents: write`, so the channel was structurally unverifiable; Issues being disabled
  // on the repository produced the same silent dead end.
  const yaml = await readFile(`${WORKFLOWS_DIR}preflight.yml`, 'utf8');
  assert.match(yaml, /permissions:[\s\S]*?issues:\s*write/, 'preflight needs issues: write to verify the approval channel');

  const names = (await readdir(WORKFLOWS_DIR)).filter((name) => name.endsWith('.yml'));
  assert.ok(names.includes('publish.yml'), 'sanity: the workflow directory resolved correctly');
});

test('a fractional resilience.failureThreshold cannot open the circuit on the first failure', async () => {
  // `failures >= failureThreshold` compares against an integer count, so 0.5 was satisfied immediately
  // and paused the account for a full cooldown on a single transient failure.
  const { circuitSettings } = await import('../src/ops/circuit.mjs');
  assert.equal(circuitSettings({ failureThreshold: 0.5 }).failureThreshold, 1);
  assert.equal(circuitSettings({ failureThreshold: 2.9 }).failureThreshold, 2);
  assert.equal(circuitSettings({ failureThreshold: 3 }).failureThreshold, 3);
  assert.equal(circuitSettings({}).failureThreshold, 3);
  // A cooldown is a duration, so a fractional value there stays legitimate.
  assert.equal(circuitSettings({ cooldownMinutes: 0.5 }).cooldownMinutes, 0.5);
});

test('a budget config typo reports a config error instead of tripping the resilience circuit', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/orchestrate.mjs', import.meta.url)), 'utf8');
  const line = source.split('\n').find((row) => row.includes('const nonCircuitCodes'));
  assert.ok(line, 'nonCircuitCodes must still exist');
  // BUDGET_CONFIG_INVALID is thrown by src/ops/budget.mjs for a malformed budgets block. Opening the
  // circuit for it pauses the account for a cooldown and buries the actual cause.
  assert.match(line, /BUDGET_CONFIG_INVALID/);
});

test('config validation catches the media traps that only surface at publish time', () => {
  const base = (account) => ({ defaults: {}, accounts: { acct: { enabled: true, credentialKey: 'acct', ...account } } });

  // An X account may host up to 15 MB by default while X itself rejects anything over 5 MB: the image
  // is generated, QA'd and hosted, and only then rejected by the provider.
  const oversize = validateStrictConfig(base({
    platform: 'x',
    media: { strategy: 'generate', type: 'image', maxHostedImageBytes: 15 * 1024 * 1024 }
  }));
  assert.ok(oversize.some((error) => error.includes('maxHostedImageBytes')), 'an X image budget above 5 MB must be rejected');

  const withinLimit = validateStrictConfig(base({
    platform: 'x',
    media: { strategy: 'generate', type: 'image', maxHostedImageBytes: 5 * 1024 * 1024 }
  }));
  assert.ok(!withinLimit.some((error) => error.includes('maxHostedImageBytes')));

  // A text-only X account never uploads an image, so the hosting default must not be flagged for it.
  const textOnly = validateStrictConfig(base({
    platform: 'x',
    media: { strategy: 'none', maxHostedImageBytes: 15 * 1024 * 1024 }
  }));
  assert.ok(!textOnly.some((error) => error.includes('maxHostedImageBytes')));

  // A typo in defaultInstagramDecision falls through every branch in resolveMedia and resurfaces as the
  // misleading "Unsupported media strategy: auto".
  const typo = validateStrictConfig(base({ platform: 'instagram', media: { strategy: 'auto', defaultInstagramDecision: 'genrate' } }));
  assert.ok(typo.some((error) => error.includes('defaultInstagramDecision')));
  const valid = validateStrictConfig(base({ platform: 'instagram', media: { strategy: 'auto', defaultInstagramDecision: 'generate' } }));
  assert.ok(!valid.some((error) => error.includes('defaultInstagramDecision')));
});

test('two accounts cannot silently share one credential', () => {
  const shared = validateStrictConfig({
    defaults: {},
    accounts: {
      first: { enabled: true, platform: 'x', credentialKey: 'shared-key' },
      second: { enabled: true, platform: 'x', credentialKey: 'shared-key' }
    }
  });
  assert.ok(
    shared.some((error) => error.includes('shared by') && error.includes('shared-key')),
    'a shared credentialKey posts both accounts through one provider identity'
  );

  const distinct = validateStrictConfig({
    defaults: {},
    accounts: {
      first: { enabled: true, platform: 'x', credentialKey: 'first-key' },
      second: { enabled: true, platform: 'x', credentialKey: 'second-key' }
    }
  });
  assert.ok(!distinct.some((error) => error.includes('shared by')));

  const wrongType = validateStrictConfig({ defaults: {}, accounts: { first: { enabled: true, platform: 'x', credentialKey: 42 } } });
  assert.ok(wrongType.some((error) => error.includes('credentialKey')));
});

test('expiring a stale approval clears the slot, but never overwrites a real publish', async (t) => {
  // Closing the issue used to leave the slot at approval_pending forever, so data/state.json claimed a
  // draft was still awaiting review long after the issue was closed.
  const { markSlotIfUnhandled, markSlot, getSlot } = await import('../src/lib/state.mjs');
  const slotId = `go-live-hardening:${process.pid}:expiry`;
  const publishedSlot = `go-live-hardening:${process.pid}:published`;
  const guard = { handledStatuses: ['published', 'publishing', 'publish_unknown', 'skipped'] };

  // These write to the real data/state.json (the repo-wide convention here, which is also why the test
  // runner is pinned to --test-concurrency=1); snapshot and restore it so the committed file is
  // untouched.
  const statePath = fileURLToPath(new URL('../data/state.json', import.meta.url));
  const savedState = await readFile(statePath, 'utf8');
  t.after(async () => { await writeFile(statePath, savedState, 'utf8'); });

  await markSlot(slotId, 'approval_pending', { account: 'acct', issue: 1 });
  const expired = await markSlotIfUnhandled(slotId, 'expired', { account: 'acct' }, guard);
  assert.equal(expired.applied, true, 'approval_pending must be supersedable once the issue is closed');
  assert.equal((await getSlot(slotId))?.status, 'expired');

  await markSlot(publishedSlot, 'published', { account: 'acct', providerPostId: 'p1' });
  const refused = await markSlotIfUnhandled(publishedSlot, 'expired', { account: 'acct' }, guard);
  assert.equal(refused.applied, false, 'a slot that really published must never be downgraded to expired');
  assert.equal((await getSlot(publishedSlot))?.status, 'published');

  // The default guard is unchanged for every other caller: approval_pending still blocks a stale skip.
  await markSlot(slotId, 'approval_pending', { account: 'acct', issue: 2 });
  const defaultGuard = await markSlotIfUnhandled(slotId, 'skipped', { account: 'acct' });
  assert.equal(defaultGuard.applied, false);
});

test("an image over X's 5 MB ceiling is classified as a config problem, not a provider outage", async () => {
  // Without a code this threw a bare Error, which counted toward the resilience circuit and paused the
  // account for a pure config mismatch (15 MB hosting budget vs a 5 MB provider ceiling).
  // MEDIA_HOSTING_TOO_LARGE is in both nonCircuitCodes and TERMINAL_SKIP_CODES, so the slot is skipped
  // once instead of re-paying for generation on every poll.
  const { __test: xTest } = await import('../src/providers/x.mjs');
  const previousFetch = globalThis.fetch;
  try {
    const oversized = new Uint8Array(6 * 1024 * 1024);
    globalThis.fetch = async () => new Response(oversized, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(oversized.byteLength) }
    });
    const error = await xTest.uploadImage('https://media.example/large.png', {}).then(() => null, (thrown) => thrown);
    assert.ok(error, 'an oversized image must not be uploaded');
    assert.equal(error.code, 'MEDIA_HOSTING_TOO_LARGE');
    assert.match(error.message, /5 MB/);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const source = await readFile(fileURLToPath(new URL('../src/orchestrate.mjs', import.meta.url)), 'utf8');
  assert.match(source, /nonCircuitCodes = \[[^\]]*MEDIA_HOSTING_TOO_LARGE/, 'the code must actually be excluded from the circuit');
});
