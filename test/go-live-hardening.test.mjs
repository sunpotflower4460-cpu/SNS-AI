import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { trustedApprovalPayload, __test as githubTest } from '../src/lib/github.mjs';
import { validateStrictConfig } from '../src/validate-strict-config.mjs';
import { __test as openaiTest } from '../src/lib/openai.mjs';
import { validateDraftText, xWeightedLength } from '../src/lib/safety.mjs';
import { OPERATIONAL_WORKFLOWS } from '../src/ops/manual-only-audit.mjs';

const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

// Regression coverage for the go-live audit: the gaps that would let an operator complete every
// documented manual step and still end up with a system that silently does nothing.

test('the approval issue body tells the operator how to actually publish under Manual-Only', () => {
  // publish.yml is workflow_dispatch-only (see docs/MANUAL_ONLY_MODE.md) - there is no `issues:
  // [labeled]` or any other server-side trigger anywhere in .github/workflows/ that fires on this
  // issue. The instructions must therefore point at the real mechanism (manually running the
  // "Publish social post" Action with confirm_live=true), not at a label that nothing listens for.
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

  const instructions = payload._howToPublish.join('\n');
  assert.match(instructions, /Publish social post/, 'must name the actual Action that publishes');
  assert.match(instructions, /workflow_dispatch/i, 'must say how that Action is triggered');
  assert.match(instructions, /confirm_live:\s*true/, 'must state the explicit live-confirmation input required');
  assert.match(instructions, new RegExp(`account:\\s*${account}`), 'must tell the operator the exact account input to use');
  assert.match(instructions, /does NOT publish anything/i, 'must explicitly say the label/comment/close path does nothing');
  // The instruction must be the first thing a human sees, not buried under the draft metadata.
  assert.ok(Object.keys(payload)[0] === '_howToPublish', 'instructions must render first in the issue body');
});

test('publish.yml really has no label/issue trigger, so the approval instructions are not describing a dead mechanism the other way around either', async () => {
  const yaml = await readFile(`${WORKFLOWS_DIR}publish.yml`, 'utf8');
  const onBlock = /\non:\n((?:[ \t]+[^\n]*\n)*)/.exec(yaml);
  assert.ok(onBlock, 'publish.yml must have an on: block');
  assert.doesNotMatch(onBlock[1], /issues:/, 'publish.yml must not gain an issues:[labeled] trigger without updating the approval-issue instructions to match');
  assert.match(onBlock[1], /workflow_dispatch:/);
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

test('readiness is not vacuously true when no account is enabled', async (t) => {
  // enabledRows.every(...) on an empty array is true, so doctor reported ready:true and live-preflight
  // returned ok:true before a single credential existed - while checking nothing at all. The go-live
  // checklist asks the operator to confirm "Doctor ready" and "Live Preflight ready", so both boxes
  // ticked themselves.
  //
  // This writes a synthetic all-disabled config rather than asserting on the committed
  // config/accounts.json directly: the rule under test is about the zero-enabled-accounts CASE, not
  // about today's config contents. The operator is expected to flip music-tools-x's `enabled` to true
  // as part of go-live, and this test must keep passing (proving the rule still holds for whatever
  // OTHER accounts remain disabled) rather than failing the moment that happens.
  const { buildReadinessReport } = await import('../src/ops/doctor.mjs');
  const { buildStrictReadinessReport } = await import('../src/ops/doctor-strict.mjs');
  const { runLivePreflight } = await import('../src/ops/live-preflight.mjs');

  const configPath = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
  const savedConfig = await readFile(configPath, 'utf8');
  t.after(async () => { await writeFile(configPath, savedConfig, 'utf8'); });

  const original = JSON.parse(savedConfig);
  const allDisabled = {
    ...original,
    accounts: Object.fromEntries(
      Object.entries(original.accounts || {}).map(([id, account]) => [id, { ...account, enabled: false, mode: 'pause' }])
    )
  };
  await writeFile(configPath, `${JSON.stringify(allDisabled, null, 2)}\n`, 'utf8');

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
  // originally granted only `contents: write`, so the channel was structurally unverifiable; Issues
  // being disabled on the repository produced the same silent dead end.
  //
  // approvalChannelCheck (src/ops/live-preflight.mjs) only ever issues GET requests - it verifies Issues
  // are enabled and reads the `approved` label, it never creates either - so the fix is `issues: read`,
  // not `write`. The actual create still happens later in autopilot.yml, which keeps `issues: write`.
  //
  // The permissions regex is anchored to indented lines directly under `permissions:` so it cannot match
  // text outside that block - including this test file's own prose, or a comment in the workflow file
  // that happens to mention "issues: write" (autopilot.yml's permission is referenced in a comment right
  // next to this one, which a loose `[\s\S]*?` match would have matched instead of the real key).
  const yaml = await readFile(`${WORKFLOWS_DIR}preflight.yml`, 'utf8');
  const permissionsBlock = /permissions:\n((?:[ \t]+[^\n]*\n)*)/.exec(yaml);
  assert.ok(permissionsBlock, 'preflight.yml must have a permissions: block');
  assert.match(permissionsBlock[1], /^[ \t]+issues:[ \t]*read\s*$/m, 'preflight only reads Issues state; it must not hold issues: write');
  assert.doesNotMatch(permissionsBlock[1], /^[ \t]+issues:[ \t]*write\s*$/m, 'preflight never creates a label or issue, so it must not be granted issues: write');

  const autopilot = await readFile(`${WORKFLOWS_DIR}autopilot.yml`, 'utf8');
  const autopilotPermissions = /permissions:\n((?:[ \t]+[^\n]*\n)*)/.exec(autopilot);
  assert.ok(autopilotPermissions, 'autopilot.yml must have a permissions: block');
  assert.match(autopilotPermissions[1], /^[ \t]+issues:[ \t]*write\s*$/m, 'autopilot creates the approval issue/label and still needs issues: write');

  const names = (await readdir(WORKFLOWS_DIR)).filter((name) => name.endsWith('.yml'));
  assert.ok(names.includes('publish.yml'), 'sanity: the workflow directory resolved correctly');
});

// account-control.yml (when target is approval/auto) and engagement-control.yml (when action is
// activate) both call live-preflight.mjs the same way preflight.yml does, but neither was given the
// issues: read permission preflight.yml needed for the identical approvalChannelCheck call. Without it,
// GitHub silently denies the GET (an explicit permissions: block sets every unlisted scope to none),
// approvalChannel.ok becomes false, and the workflow that exists to enable an account/activate
// engagement fails closed on its own dependency - not unsafe, but a real functional break.
test('account-control.yml and engagement-control.yml carry the same issues: read grant preflight.yml needed for its approval-channel check', async () => {
  for (const name of ['account-control.yml', 'engagement-control.yml']) {
    const yaml = await readFile(`${WORKFLOWS_DIR}${name}`, 'utf8');
    const permissionsBlock = /permissions:\n((?:[ \t]+[^\n]*\n)*)/.exec(yaml);
    assert.ok(permissionsBlock, `${name} must have a permissions: block`);
    assert.match(permissionsBlock[1], /^[ \t]+issues:[ \t]*read\s*$/m, `${name} calls live-preflight.mjs, which reads the approval label/Issues state - it needs issues: read`);
  }
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

  // A malformed maxHostedImageBytes (wrong type, unparseable string) must be rejected on its own -
  // Number("15MB") is NaN, and `NaN > X_MAX_IMAGE_BYTES` is false, so the size guard above would
  // silently pass a value the runtime can't interpret at all.
  const malformed = validateStrictConfig(base({
    platform: 'x',
    media: { strategy: 'generate', type: 'image', maxHostedImageBytes: '15MB' }
  }));
  assert.ok(malformed.some((error) => error.includes('media.maxHostedImageBytes') && error.includes('non-negative integer')));
  assert.ok(!malformed.some((error) => error.includes("above X's")), 'a malformed value is a type error, not a size comparison');

  const nullValue = validateStrictConfig(base({
    platform: 'x',
    media: { strategy: 'generate', type: 'image', maxHostedImageBytes: null }
  }));
  assert.ok(!nullValue.some((error) => error.includes('maxHostedImageBytes')), 'null defers to the configured default and is not itself an error');
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

  // At runtime (src/ops/doctor.mjs) an account with no explicit credentialKey resolves to one keyed by
  // its own account id: `account.credentialKey || id`. An account named "alpha" with no credentialKey
  // and a second account whose explicit credentialKey is "alpha" therefore share one provider identity
  // even though only one of them names a credentialKey in config - grouping by the literal field alone
  // missed this collision entirely.
  const implicitCollision = validateStrictConfig({
    defaults: {},
    accounts: {
      alpha: { enabled: true, platform: 'x' },
      second: { enabled: true, platform: 'x', credentialKey: 'alpha' }
    }
  });
  assert.ok(
    implicitCollision.some((error) => error.includes('shared by') && error.includes('alpha')),
    'an explicit credentialKey colliding with another account\'s implicit (id-based) key must be caught'
  );

  // Two accounts that both fall back to their own distinct ids must not collide with each other.
  const distinctImplicit = validateStrictConfig({
    defaults: {},
    accounts: {
      alpha: { enabled: true, platform: 'x' },
      beta: { enabled: true, platform: 'x' }
    }
  });
  assert.ok(!distinctImplicit.some((error) => error.includes('shared by')));
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

test('a failed slot write leaves the approval issue open for retry, instead of closing it first', async (t) => {
  // The issue used to be closed BEFORE the slot write was attempted. expireStaleApprovals only ever
  // looks at OPEN issues, so a write failure after that close permanently stranded the slot - no later
  // run could ever find that issue again to retry. The fix reorders the two: the durable write happens
  // first, and the issue is only closed once it succeeds.
  //
  // Root bypasses ordinary chmod-based permission denial, so the immutable filesystem attribute is used
  // to force the write to fail, exactly as in test/deprecated-media-skip.test.mjs's state-error case -
  // verified with a real round-trip probe since chattr support isn't guaranteed in every environment.
  const STATE_FILE = fileURLToPath(new URL('../data/state.json', import.meta.url));
  const probePath = fileURLToPath(new URL('../data/.chattr-probe-stale-approvals.tmp', import.meta.url));
  let chattrSupported = false;
  try {
    await writeFile(probePath, 'probe', 'utf8');
    execFileSync('chattr', ['+i', probePath]);
    try { await writeFile(probePath, 'should fail', 'utf8'); }
    catch { chattrSupported = true; }
  } catch { chattrSupported = false; }
  finally {
    try { execFileSync('chattr', ['-i', probePath]); } catch { /* ignore */ }
    await rm(probePath, { force: true });
  }
  if (!chattrSupported) { t.skip('chattr immutable-attribute is not enforced in this environment'); return; }

  const previousFetch = globalThis.fetch;
  const savedEnv = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY };
  const savedState = await readFile(STATE_FILE, 'utf8');
  t.after(async () => {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    try { execFileSync('chattr', ['-i', STATE_FILE]); } catch { /* already cleared */ }
    await writeFile(STATE_FILE, savedState, 'utf8');
  });

  process.env.GH_TOKEN = 'gh-test-token';
  delete process.env.GITHUB_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';

  const trustedBody = JSON.stringify({
    account: 'example-x', slotId: 'stuck-slot',
    _snsAi: { kind: 'sns-ai-approval', version: 1, account: 'example-x', slotId: 'stuck-slot' }
  });
  let closeAttempted = false;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('/issues?state=open')) {
      return new Response(JSON.stringify([
        { number: 42, title: '[approval] example-x stuck-slot', body: trustedBody, user: { login: 'github-actions[bot]' }, created_at: '2020-01-01T00:00:00.000Z' }
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.endsWith('/issues/42/comments') || (target.endsWith('/issues/42') && options.method === 'PATCH')) {
      closeAttempted = true;
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected mocked URL: ${target}`);
  };

  await writeFile(STATE_FILE, `${JSON.stringify({ slots: {} }, null, 2)}\n`, 'utf8');
  execFileSync('chattr', ['+i', STATE_FILE]);

  const { expireStaleApprovals } = await import(`../src/ops/stale-approvals.mjs?active=${Date.now()}`);
  const error = await expireStaleApprovals({ maxAgeDays: 7 }).then(() => null, (thrown) => thrown);

  assert.ok(error, 'expireStaleApprovals must fail loudly instead of silently swallowing the write failure');
  assert.match(error.message, /stuck-slot/);
  assert.equal(closeAttempted, false, 'the issue must stay open for retry - it must not be closed before the slot write succeeded');
  assert.deepEqual(error.result?.closed, [], 'nothing was actually closed');
  assert.equal(error.result?.expiredSlots?.[0]?.applied, false);
  assert.ok(error.result?.expiredSlots?.[0]?.error, 'the failure reason must be attached for diagnosis');
});

// hub-reconcile.yml and publish-reconcile.yml write authoritative provider-confirmed state back to
// main and finalize durable claims, yet - unlike every other write-capable operational workflow
// (publish.yml, account-control.yml, engagement-control.yml, compliance-attestation.yml,
// chatops.yml, feedback.yml) - they had no actor check at all: any repository collaborator with
// generic write access, not just the owner or SNS_COMMAND_ADMINS, could trigger them.
//
// engagement.yml is a sharper case of the same bug: it unconditionally sets
// SNS_MANUAL_INVOCATION: 'true' in its job env, which is the exact token
// assertProviderMutationAllowed() (src/ops/manual-only.mjs) treats as proof a human deliberately
// ran this as a manual workflow_dispatch. publish.yml hands out that same token under an actor
// check plus an explicit confirm_live input; engagement.yml handed it out to any workflow_dispatch
// caller with no actor check and no second confirmation. Today that gap is inert only because
// config/engagement-policy.json's approvalRequired:true and empty liveAccounts (both enforced by
// manual-only-audit.mjs) route every reply through a human-approval issue first - the same kind of
// "safe only because an unrelated config layer happens to also block it" gap already fixed for
// requireExplicitManualInvocation in src/ops/manual-only.mjs. Any workflow that grants this
// specific credential must gate who can grant it, independent of what else currently blocks misuse.
test('every workflow that sets SNS_MANUAL_INVOCATION or writes state back to main gates on the authorized-actor check', async () => {
  const files = (await readdir(WORKFLOWS_DIR)).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, 'expected to find workflow files to check');

  const hasActorGate = (yaml) => /name:\s*Authorize command actor/.test(yaml) && /SNS_COMMAND_ADMINS/.test(yaml) && /github\.repository_owner/.test(yaml);

  const mustGate = ['hub-reconcile.yml', 'publish-reconcile.yml'];
  for (const name of mustGate) {
    const yaml = await readFile(`${WORKFLOWS_DIR}${name}`, 'utf8');
    assert.ok(hasActorGate(yaml), `${name} writes authoritative state back to main but has no "Authorize command actor" step`);
  }

  for (const name of files) {
    const yaml = await readFile(`${WORKFLOWS_DIR}${name}`, 'utf8');
    if (!/SNS_MANUAL_INVOCATION/.test(yaml)) continue;
    assert.ok(hasActorGate(yaml), `${name} sets SNS_MANUAL_INVOCATION (grants the explicit-manual-invocation credential) but has no "Authorize command actor" step`);
  }
});

test('autopilot live path requires SNS_MANUAL_INVOCATION, confirm_live, and manual-only-audit', async () => {
  const yaml = await readFile(`${WORKFLOWS_DIR}autopilot.yml`, 'utf8');
  assert.match(yaml, /SNS_MANUAL_INVOCATION:.*workflow_dispatch/);
  assert.match(yaml, /confirm_live:/);
  assert.match(yaml, /npm run manual-only-audit/);
  assert.match(yaml, /dry_run=false and confirm_live=true/);
});

// engagement-scheduled.yml was hardened to gate SNS_MANUAL_INVOCATION behind
// `github.event_name == 'workflow_dispatch'`, so a future schedule: trigger could never inherit the
// explicit-manual-invocation credential. autopilot.yml, engagement.yml, engagement-resolve.yml, and
// publish.yml grant the exact same credential but originally hardcoded 'true' unconditionally - safe
// today only because every operational workflow is currently workflow_dispatch-only (a fact enforced
// by manual-only-audit.mjs as a backstop, not by these workflows' own code). The hardening applied to
// one workflow must be applied to every workflow granting this credential, not left to a separate audit
// script to catch after the fact.
test('every workflow granting SNS_MANUAL_INVOCATION gates it on workflow_dispatch, not a bare true', async () => {
  for (const name of ['autopilot.yml', 'engagement.yml', 'engagement-resolve.yml', 'engagement-scheduled.yml', 'publish.yml']) {
    const yaml = await readFile(`${WORKFLOWS_DIR}${name}`, 'utf8');
    const line = /^\s*SNS_MANUAL_INVOCATION:.*$/m.exec(yaml)?.[0];
    assert.ok(line, `${name} must set SNS_MANUAL_INVOCATION`);
    assert.doesNotMatch(line, /SNS_MANUAL_INVOCATION:\s*'true'\s*$/, `${name} must not hardcode SNS_MANUAL_INVOCATION to 'true' unconditionally`);
    assert.match(line, /github\.event_name == 'workflow_dispatch'/, `${name} must gate SNS_MANUAL_INVOCATION on workflow_dispatch`);
  }
});

// Every write-capable operational workflow is expected to run all four static safety guards together:
// `npm run validate`, `npm run check`, `npm run secret-scan`, and `npm run manual-only-audit` (the one
// check that verifies the Manual-Only posture itself - config/runtime-policy.json, account modes,
// engagement policy, and every workflow's trigger shape - hasn't drifted). Two historical gaps: several
// workflows ran validate/check/secret-scan but not manual-only-audit, and feedback.yml ran only
// validate + manual-only-audit while silently skipping check and secret-scan entirely. A workflow that
// runs SOME of these guards but not all loses defense-in-depth silently, with nothing in CI to say so -
// so this asserts all-or-nothing per workflow, not just a pairwise check.
test('every operational workflow that runs any static safety guard runs all four of them', async () => {
  const GUARDS = [
    ['npm run validate', /npm run validate\b/],
    ['npm run check', /npm run check\b/],
    ['npm run secret-scan', /npm run secret-scan\b/],
    ['npm run manual-only-audit', /npm run manual-only-audit\b/]
  ];
  for (const name of OPERATIONAL_WORKFLOWS) {
    const yaml = await readFile(`${WORKFLOWS_DIR}${name}`, 'utf8');
    const present = GUARDS.filter(([, pattern]) => pattern.test(yaml)).map(([label]) => label);
    if (!present.length) continue;
    const missing = GUARDS.filter(([, pattern]) => !pattern.test(yaml)).map(([label]) => label);
    assert.deepEqual(missing, [], `${name} runs ${present.join(', ')} but is missing: ${missing.join(', ')}`);
  }
});

// Every "[engagement-human] <account> <event-key>" escalation Issue told the operator to resolve it
// through "[engagement-resolve]" - a bracket-command Issue-title syntax that, exactly like the old
// "approved" label, nothing in .github/workflows/ ever listened for. src/engagement/run.mjs already
// implements the resolve logic (resolveHumanEngagement, reachable via `--resolve-file`), but no
// workflow called it, so a human who did everything the Issue told them to do could still never
// actually send the reply or dismiss the escalation.
test('a human-escalation engagement Issue points at a real, existing workflow instead of a dead bracket command', async () => {
  const runSource = await readFile(fileURLToPath(new URL('../src/engagement/run.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(runSource, /\[engagement-resolve\]/, 'the dead bracket-command reference must be gone');
  assert.match(runSource, /SNS Engagement Resolve/, 'the resolution text must name the real Action');
  assert.match(runSource, /event_key:/, 'the resolution text must tell the operator the event_key input to use');
  assert.match(runSource, /does NOT reply or dismiss anything/i, 'must explicitly say the label/comment/close path does nothing');

  const workflow = await readFile(`${WORKFLOWS_DIR}engagement-resolve.yml`, 'utf8');
  const onBlock = /\non:\n((?:[ \t]+[^\n]*\n)*)/.exec(workflow);
  assert.ok(onBlock, 'engagement-resolve.yml must have an on: block');
  assert.match(onBlock[1], /workflow_dispatch:/);
  assert.doesNotMatch(onBlock[1], /schedule:|issues:|issue_comment:/, 'must stay workflow_dispatch-only under Manual-Only');
  assert.match(workflow, /name:\s*Authorize command actor/);
  assert.match(workflow, /SNS_COMMAND_ADMINS/);
  assert.match(workflow, /confirm_live/);
  assert.match(workflow, /run\.mjs --resolve-file/, 'must actually invoke the resolve entrypoint');
});

// docs/CHATOPS.md and docs/CHATOPS_ACCOUNT_LIFECYCLE.md used to describe an Issue-title-triggered
// command system ("[preflight] <id>", "[account-approval] ACCOUNT_ID", etc.) that has never existed
// in any workflow trigger - every operational workflow is workflow_dispatch-only. Docs describing a
// control surface that does not exist are worse than no docs: an operator who follows them exactly
// ends up with an Issue GitHub never acts on and no idea why nothing happened.
test('ChatOps docs describe the real workflow_dispatch interface, not a dead Issue-title command system', async () => {
  const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));
  const chatops = await readFile(`${DOCS_DIR}CHATOPS.md`, 'utf8');
  const lifecycle = await readFile(`${DOCS_DIR}CHATOPS_ACCOUNT_LIFECYCLE.md`, 'utf8');

  for (const doc of [chatops, lifecycle]) {
    assert.doesNotMatch(doc, /\[preflight\]|\[dry-run\]|\[engagement-dry-run\]|\[engagement-run\]|\[account-approval\]|\[account-auto\]|\[account-pause\]|\[account-disable\]/, 'must not describe dead bracket-command Issue titles');
    assert.doesNotMatch(doc, /[Cc]reate an Issue with/, 'must not instruct the operator to create a command Issue');
    assert.match(doc, /workflow_dispatch/, 'must name the actual trigger mechanism');
  }

  assert.match(chatops, /SNS_COMMAND_ADMINS/);
  assert.match(chatops, /engagement-resolve\.yml/i, 'must document the workflow that actually resolves escalations');

  assert.match(lifecycle, /manualOnly.*true|Manual-Only is active/i);
  assert.match(lifecycle, /account-control\.yml/i);
});

// GO_LIVE_CHECKLIST.md, ACCOUNT_MUSIC_TOOLS_X.md, and README.md predate the Manual-Only pivot and
// still described a scheduled/`approved`-label operating model that no longer exists: Autopilot,
// Metrics, Intelligence, Learning, and Policy Watch all claimed fixed cron cadences (10-min polling,
// hourly, every 6h, daily) when every one of those workflows is workflow_dispatch-only with no
// schedule trigger, and the go-live checklist told the operator the same dead "add the approved
// label" instruction already fixed in src/lib/github.mjs for the approval-issue payload itself.
test('go-live docs describe the current Manual-Only posture, not the old scheduled/approved-label model', async () => {
  const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));
  const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
  const goLive = await readFile(`${DOCS_DIR}GO_LIVE_CHECKLIST.md`, 'utf8');
  const musicToolsX = await readFile(`${DOCS_DIR}ACCOUNT_MUSIC_TOOLS_X.md`, 'utf8');
  const readme = await readFile(`${REPO_ROOT}README.md`, 'utf8');

  for (const doc of [goLive, musicToolsX, readme]) {
    assert.doesNotMatch(doc, /\[preflight\]|\[dry-run\]|\[engagement-dry-run\]/, `${doc === goLive ? 'GO_LIVE_CHECKLIST.md' : doc === musicToolsX ? 'ACCOUNT_MUSIC_TOOLS_X.md' : 'README.md'} must not describe dead bracket-command Issue titles`);
    assert.doesNotMatch(doc, /10分ごと|— 毎時|6時間ごと|— 毎日/, 'must not claim a fixed automatic cadence for a workflow_dispatch-only workflow');
    assert.match(doc, /[Mm]anual-Only|manualOnly/, 'must mention the current Manual-Only posture');
  }

  assert.doesNotMatch(goLive, /labelを付ける」ことだけです/, 'must not tell the operator that a label triggers publishing');
  assert.match(goLive, /confirm_live/, 'must name the real live-publish confirmation input');
  assert.match(goLive, /engagement-resolve\.yml|SNS Engagement Resolve/i, 'must point at the workflow that actually resolves engagement escalations');

  assert.doesNotMatch(musicToolsX, /adding the `approved` label to its approval Issue/i);
});

// docs/CHATOPS.md documented chatops.yml's "dry-run" command as a working, provider-offline
// preview - but chatops.yml never sets OPENAI_API_KEY, and orchestrate.mjs's dry-run path
// deliberately still calls the real OpenAI Responses API (see the comment on openaiRequest() in
// src/lib/openai.mjs: "dry-run previews still call the real Responses API so an operator can
// actually see what would be posted"). Every dispatch of that command would have failed with a
// missing-credential error - CodeRabbit caught the contradiction between the "provider-offline"
// framing and the dry-run command actually needing a provider credential it never receives. Fixed
// by dropping the broken dry-run command from ChatOps entirely and pointing operators at SNS
// Autopilot's dry_run input instead, which already carries the required credential.
test('ChatOps does not advertise a dry-run command it structurally cannot run', async () => {
  const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
  const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));
  const chatops = await readFile(`${WORKFLOWS_DIR}chatops.yml`, 'utf8');
  const chatopsDoc = await readFile(`${DOCS_DIR}CHATOPS.md`, 'utf8');

  assert.doesNotMatch(chatops, /options:.*dry-run/, 'chatops.yml must not offer a command it cannot actually run without a credential it never receives');
  assert.doesNotMatch(chatops, /if:\s*inputs\.command == 'dry-run'/);
  assert.doesNotMatch(chatops, /orchestrate\.mjs/);
  assert.match(chatops, /options:\s*\[preflight\]/);

  assert.doesNotMatch(chatopsDoc, /`preflight` or `dry-run`/i);
  assert.match(chatopsDoc, /SNS Autopilot/, 'must point operators at the workflow that can actually preview a generation');

  // MANUAL_SETUP_CHECKLIST.md separately described ChatOps as having "explicit preflight/dry-run/
  // manual engagement commands" - stale from an earlier ChatOps design, and contradicting both
  // chatops.yml's single `preflight` choice and CHATOPS.md's own accurate description above.
  const setupChecklist = await readFile(`${DOCS_DIR}MANUAL_SETUP_CHECKLIST.md`, 'utf8');
  assert.doesNotMatch(setupChecklist, /preflight\/dry-run\/manual engagement commands/i);
});

// failure-watch.yml's `on: workflow_run: workflows:` list matches by each workflow's exact `name:`
// field, not its filename - GitHub silently drops any entry that doesn't match a real workflow name,
// with no error. publish.yml used to be named "Publish social post" (missing the "SNS " prefix every
// other workflow uses) while failure-watch.yml's list already said "Publish social post" - so renaming
// either side alone, or letting them drift, would silently stop failure-watch from ever firing on that
// workflow's failures. Assert every workflow's name is actually present in the watch list, so a rename
// on one side without the other fails a test instead of failing silently in production.
test('every workflow\'s name is present in failure-watch.yml\'s workflow_run watch list', async () => {
  const names = new Map();
  const files = (await readdir(WORKFLOWS_DIR)).filter((name) => name.endsWith('.yml'));
  for (const file of files) {
    const yaml = await readFile(`${WORKFLOWS_DIR}${file}`, 'utf8');
    const match = /^name:\s*(.+)\s*$/m.exec(yaml);
    assert.ok(match, `${file} must declare a name:`);
    names.set(file, match[1].trim());
  }
  const failureWatch = await readFile(`${WORKFLOWS_DIR}failure-watch.yml`, 'utf8');
  const listBlock = /workflows:\n((?:[ \t]+-[^\n]*\n)*)/.exec(failureWatch)?.[1] || '';
  const watched = new Set([...listBlock.matchAll(/^[ \t]+-\s*(.+?)\s*$/gm)].map((m) => m[1]));
  for (const [file, name] of names) {
    if (file === 'failure-watch.yml') continue;
    assert.ok(watched.has(name), `${file}'s name "${name}" is not in failure-watch.yml's workflow_run watch list`);
  }
});

// publish.yml used to be the only operational workflow without the "SNS " prefix every sibling
// workflow carries - it was named plain "Publish social post" while README.md, GO_LIVE_CHECKLIST.md,
// ACCOUNT_MUSIC_TOOLS_X.md, and CHATOPS.md all referred to it as "SNS Publish social post", so an
// operator searching the Actions tab for the name every doc used would not find an exact match.
test('publish.yml carries the "SNS " prefix every other operational workflow uses, matching how every doc refers to it', async () => {
  const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));
  const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
  const yaml = await readFile(`${WORKFLOWS_DIR}publish.yml`, 'utf8');
  assert.match(yaml, /^name:\s*SNS Publish social post\s*$/m);

  for (const path of [
    `${REPO_ROOT}README.md`,
    `${DOCS_DIR}GO_LIVE_CHECKLIST.md`,
    `${DOCS_DIR}ACCOUNT_MUSIC_TOOLS_X.md`,
    `${DOCS_DIR}CHATOPS.md`,
    `${DOCS_DIR}MANUAL_SETUP_CHECKLIST.md`
  ]) {
    const doc = await readFile(path, 'utf8');
    assert.match(doc, /SNS Publish social post/, `${path} must refer to the workflow by its actual name`);
  }
});

// A second CodeRabbit pass on this same PR caught three more accuracy gaps in the just-rewritten
// docs: the engagement descriptions said automatic sending only depended on liveAccounts/confidence,
// omitting that approvalRequired:true (required today by manual-only-audit) routes every reply to a
// human Issue regardless of those two; the go-live checklist implied lifting Manual-Only alone
// restores engagement.yml's automatic polling, when the cron trigger itself lives in the workflow
// YAML and needs its own edit; and README's Manual-Only framing said "all workflows"/"all execution"
// while documenting ci.yml/failure-watch.yml as automatic exceptions two lines later.
test('engagement/schedule docs do not overstate what liveAccounts, Manual-Only, or "all workflows" alone accomplish', async () => {
  const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));
  const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
  const chatopsDoc = await readFile(`${DOCS_DIR}CHATOPS.md`, 'utf8');
  const musicToolsX = await readFile(`${DOCS_DIR}ACCOUNT_MUSIC_TOOLS_X.md`, 'utf8');
  const goLive = await readFile(`${DOCS_DIR}GO_LIVE_CHECKLIST.md`, 'utf8');
  const readme = await readFile(`${REPO_ROOT}README.md`, 'utf8');

  for (const doc of [chatopsDoc, musicToolsX]) {
    assert.match(doc, /approvalRequired/, 'engagement auto-send description must mention approvalRequired, not just liveAccounts/confidence');
  }

  assert.match(goLive, /workflowファイルへ`schedule:`を追加|YAML自体に書く/, 'must say the workflow YAML itself needs a schedule: edit, not just the runtime policy');
  assert.match(goLive, /engagement-scheduled\.yml/, 'scheduled polling schedule belongs on engagement-scheduled.yml, not engagement.yml');

  assert.match(readme, /operator workflow/, 'must scope the Manual-Only claim to operator workflows, excluding the documented CI/Failure-Watch exceptions');
  // Both places that claim "all workflows are workflow_dispatch-only" must mention the ci.yml/
  // failure-watch.yml exception in the same breath, not just further down the document.
  const introBanner = readme.slice(readme.indexOf('Manual-Onlyでロックされています'), readme.indexOf('## 主な自動化'));
  assert.match(introBanner, /ci\.yml/, 'the intro Manual-Only banner must name its own automatic-workflow exceptions, not just the GitHub Actions section further down');
  const actionsSection = readme.slice(readme.indexOf('## GitHub Actions'), readme.indexOf('## GitHub Actions') + 600);
  assert.match(actionsSection, /ci\.yml/, 'the GitHub Actions section opener must name its automatic-workflow exceptions inline');
});

// A second, independent re-audit (run after PR #83 merged) found four more docs the earlier passes
// never touched: docs/MANUAL_EXTERNAL_SETUP_QUEUE.md and docs/ENGAGEMENT_AUTOMATION.md still told
// operators to "ask ChatGPT" to create Issues titled `[compliance-x-profile] ACCOUNT_ID`,
// `[account-approval] ACCOUNT_ID`, `[engagement-activate] ACCOUNT_ID`, etc. - the exact same dead
// bracket-command pattern already fixed everywhere else, just missed because these two docs weren't
// in the original audit's file list. docs/OPERATIONS.md and docs/AUTONOMY.md independently drifted
// the OTHER way: they describe the pre-Manual-Only scheduled/autonomous architecture as the system's
// current live behavior (confirmed against .github/workflows/engagement-scheduled.yml, which is now
// a workflow_dispatch-only scheduled runner wired to scheduled.mjs, inert under Manual-Only, not the
// "runs every 30 minutes" polling both docs originally described as current behavior).
test('docs beyond the first audit pass do not describe dead bracket commands or claim schedules that do not exist', async () => {
  const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));
  const setupQueue = await readFile(`${DOCS_DIR}MANUAL_EXTERNAL_SETUP_QUEUE.md`, 'utf8');
  const engagementAutomation = await readFile(`${DOCS_DIR}ENGAGEMENT_AUTOMATION.md`, 'utf8');
  const operations = await readFile(`${DOCS_DIR}OPERATIONS.md`, 'utf8');
  const autonomy = await readFile(`${DOCS_DIR}AUTONOMY.md`, 'utf8');

  for (const doc of [setupQueue, engagementAutomation]) {
    assert.doesNotMatch(doc, /\[compliance-x-profile\]|\[compliance-x-ai-reply\]|\[compliance-revoke-|\[account-approval\]|\[engagement-activate\]|\[engagement-deactivate\]|\[engagement-dry-run\]/, 'must not describe dead bracket-command Issue titles');
    assert.match(doc, /[Mm]anual-Only/, 'must mention the current Manual-Only posture');
  }
  assert.match(setupQueue, /compliance-attestation\.yml|SNS Compliance Attestation/i);
  assert.match(engagementAutomation, /engagement-control\.yml|SNS Engagement Control/i);
  assert.match(engagementAutomation, /inert|fail-closed|allowScheduledProviderPolling/i, 'must say SNS Engagement Scheduled is inert under Manual-Only, not live 30-minute polling');
  assert.doesNotMatch(engagementAutomation, /prints an explanation|is not called by any workflow/i, 'must not claim the pre-#85 print-only stub behavior');

  for (const doc of [operations, autonomy]) {
    assert.match(doc, /[Mm]anual-Only/, 'must mention the current Manual-Only posture instead of presenting the scheduled/autonomous design as current behavior');
  }
  assert.doesNotMatch(operations, /^\*\*SNS Autopilot\*\*は10分ごとに起動します。Scheduled runはliveです。/m, 'must not claim Autopilot is currently live-scheduled');
});

// The same independent re-audit flagged an inconsistency, not a bug in itself: autopilot.yml,
// health.yml, intelligence.yml, learning.yml, maintenance.yml, metrics.yml, and policy.yml all carry
// contents:write (metrics.yml also carries SOCIAL_CREDENTIALS_JSON) yet, unlike every other
// write-capable operational workflow, had no "Authorize command actor" step - any repository
// collaborator with plain GitHub write access, not just the owner or SNS_COMMAND_ADMINS, could spend
// OpenAI budget, create Issues, or trigger a real provider read on any of these. None of them reach
// live-mutation capability on their own (that still requires publish.yml/engagement-resolve.yml's
// separate confirm_live gate), but leaving some operational workflows gated and others not is exactly
// the kind of inconsistency this repo has repeatedly closed elsewhere in this same effort.
test('every write-capable or secret-bearing operational workflow gates on the authorized-actor check', async () => {
  const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
  const files = (await readdir(WORKFLOWS_DIR)).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, 'expected to find workflow files to check');

  // ci.yml and failure-watch.yml are the two reviewed GitHub-internal automatic exceptions (see
  // manual-only-audit.mjs's INFRASTRUCTURE_WORKFLOWS) - they must never receive SNS/provider secrets
  // and are intentionally not actor-gated.
  const exempt = new Set(['ci.yml', 'failure-watch.yml']);

  const missing = [];
  for (const name of files) {
    if (exempt.has(name)) continue;
    const yaml = await readFile(`${WORKFLOWS_DIR}${name}`, 'utf8');
    const grantsWrite = /^\s*contents:\s*write\s*$/m.test(yaml);
    // Any secrets.* reference is treated as sensitive by default, except the one GitHub-managed
    // token that isn't a repo-configured credential - this way a future workflow that introduces a
    // new provider/credential secret is caught automatically instead of requiring this test to be
    // updated in lockstep with every new secret name.
    const NON_SENSITIVE_SECRETS = new Set(['GITHUB_TOKEN']);
    const secretNames = [...yaml.matchAll(/secrets\.([A-Z0-9_]+)\b/g)].map((match) => match[1]);
    const carriesSecret = secretNames.some((secretName) => !NON_SENSITIVE_SECRETS.has(secretName));
    if (!grantsWrite && !carriesSecret) continue;
    if (!/name:\s*Authorize command actor/.test(yaml) || !/SNS_COMMAND_ADMINS/.test(yaml)) missing.push(name);
  }

  assert.deepEqual(missing, [], `workflow(s) grant write access or a provider/OpenAI secret without gating on the authorized-actor check:\n${JSON.stringify(missing, null, 2)}`);
});

// CodeRabbit's review of this same PR caught a real, pre-existing bug in the "Authorize command
// actor" pattern itself (present since publish.yml's original gate, and multiplied by adding the
// same pattern to 8 more workflows in this PR): every step read `github.actor`, which GitHub
// deliberately keeps pinned to the ORIGINAL dispatcher across a workflow re-run - a documented
// anti-escalation feature for GitHub's own token/permission scoping, not something available to
// gate a custom authorization check on. Any repository collaborator with plain "write" access (a
// materially lower bar than being listed in SNS_COMMAND_ADMINS) can click "Re-run all jobs" on any
// historical run the owner originally dispatched, and the actor check would still read the owner's
// name and pass - even though this collaborator, not the owner, is who actually caused this
// execution to spend OpenAI budget, touch provider secrets, or write to the repo. `github.triggering_actor`
// is the field GitHub updates to reflect who actually triggered the current execution, including
// re-runs, and is identical to github.actor for a normal (non-re-run) dispatch - see
// https://github.blog/changelog/2022-07-19-differentiating-triggering-actor-from-executing-actor/.
test('every "Authorize command actor" step reads github.triggering_actor, not the re-run-stale github.actor', async () => {
  const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
  const files = (await readdir(WORKFLOWS_DIR)).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, 'expected to find workflow files to check');

  const wrong = [];
  for (const name of files) {
    const yaml = await readFile(`${WORKFLOWS_DIR}${name}`, 'utf8');
    if (!/name:\s*Authorize command actor/.test(yaml)) continue;
    if (/ACTOR:\s*\$\{\{\s*github\.actor\s*\}\}/.test(yaml)) wrong.push(name);
    else if (!/ACTOR:\s*\$\{\{\s*github\.triggering_actor\s*\}\}/.test(yaml)) wrong.push(`${name} (unexpected ACTOR source)`);
  }

  assert.deepEqual(wrong, [], `workflow(s) gate on the re-run-stale github.actor instead of github.triggering_actor:\n${JSON.stringify(wrong, null, 2)}`);
});

// PR #86-88 added a confirm_live two-factor live gate to engagement.yml (matching publish.yml and
// engagement-resolve.yml), but docs/CHATOPS.md's SNS Engagement Autopilot entry still only listed
// `account` and `dry_run`, omitting the now-required `confirm_live` input entirely - an operator
// reading only that doc would not know a live send needs both dry_run:false and confirm_live:true.
test('docs/CHATOPS.md documents engagement.yml\'s confirm_live two-factor live gate', async () => {
  const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url));
  const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
  const chatopsDoc = await readFile(`${DOCS_DIR}CHATOPS.md`, 'utf8');
  const engagementWorkflow = await readFile(`${WORKFLOWS_DIR}engagement.yml`, 'utf8');

  assert.match(engagementWorkflow, /confirm_live/, 'sanity: engagement.yml must actually have this input for the test to mean anything');

  const section = chatopsDoc.slice(chatopsDoc.indexOf('SNS Engagement Autopilot'), chatopsDoc.indexOf('SNS Engagement Resolve'));
  assert.match(section, /confirm_live/, 'must document the confirm_live input');
  assert.match(section, /dry_run:\s*false.*confirm_live:\s*true|confirm_live:\s*true.*dry_run:\s*false/is, 'must document that both dry_run:false and confirm_live:true are required together');
});
