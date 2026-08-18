import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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
