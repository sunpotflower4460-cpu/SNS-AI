import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runAutopilot } from '../src/orchestrate.mjs';
import { getSlot, markSlot, markSlotIfUnhandled } from '../src/lib/state.mjs';

// Regression coverage for: once the confirmed OpenAI Videos API shutdown date passes, an account whose
// Reel strategy unconditionally reaches built-in video generation (media.strategy: 'generate') hits a
// permanent PROVIDER_DEPRECATED failure deep inside media generation - a failure that is, by design,
// excluded from the resilience circuit (a permanent shutdown must not look like a transient provider
// outage). With nothing else to stop it, the same due slot would keep re-paying for a full
// generatePost() call on every subsequent poll within its scheduling window (autopilot.yml runs every
// 10 minutes) with zero chance of ever publishing.
//
// An earlier version of this fix added an orchestrate-level guard that skipped generatePost() entirely
// ahead of time - but that also silently broke two other things: (a) dry-run previews, which must still
// exercise the full decision path even for a permanently-deprecated backend (documented design), and
// (b) the media-generation cache-hit path, since the cache key depends on the AI-generated mediaPrompt
// that only exists AFTER generatePost() has run - an early guard made an already-cached, QA-approved
// video permanently unreachable through the normal autopilot entrypoint. The actual fix instead lets
// the (single) live failure happen normally and then persists a terminal 'skipped' state for the slot,
// bounding the waste to at most one paid attempt per slot per scheduling window.
//
// This test fails on the pre-fix code (the second poll within the same window re-attempts generation)
// and passes on the fix (the second poll sees 'already-handled' and never calls generatePost again).

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const DURABLE_DIR = fileURLToPath(new URL('../data/durable-claims/', import.meta.url));
const DATA_FILES = [
  fileURLToPath(new URL('../data/history.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/audit.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/state.json', import.meta.url)),
  fileURLToPath(new URL('../data/runtime-health.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage-state.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage.jsonl', import.meta.url))
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
const DURABLE_SNAPSHOT_DIR = fileURLToPath(new URL('../data/.durable-claims-test-snapshot/', import.meta.url));
// Unlike DATA_FILES (individually snapshotted/restored above), the whole durable-claims directory was
// previously just rm -rf'd at test start/end with no backup - destroying any pre-existing claim files
// (e.g. real local development artifacts, or leftovers from a differently-ordered test run) with no way
// to recover them.
async function snapshotAndClearDurableClaims() {
  await rm(DURABLE_SNAPSHOT_DIR, { recursive: true, force: true });
  try { await cp(DURABLE_DIR, DURABLE_SNAPSHOT_DIR, { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(DURABLE_DIR, { recursive: true, force: true });
}
async function restoreDurableClaims() {
  await rm(DURABLE_DIR, { recursive: true, force: true });
  try { await cp(DURABLE_SNAPSHOT_DIR, DURABLE_DIR, { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rm(DURABLE_SNAPSHOT_DIR, { recursive: true, force: true });
}
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function account(strategy) {
  return {
    platform: 'instagram', enabled: true, mode: 'auto', credentialKey: 'deprecated-media-ig', displayName: 'Deprecated Media IG',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'test', schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5', maxChars: 2000, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 1, candidateCount: 1, maxOutputTokens: 1000 },
    safety: { moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false }, research: { webSearch: false, trendIntelligence: false },
    resilience: { enabled: true, failureThreshold: 3, cooldownMinutes: 60 },
    budgets: { enabled: false }, experiments: { enabled: false },
    media: { strategy, type: 'reel', internalVideoGeneration: true, videoModel: 'sora-2', videoSize: '720x1280', videoSeconds: 8, qa: { enabled: false } }
  };
}

async function installAccount(strategy) {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts['deprecated-media-ig'] = account(strategy);
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function generationResponse(mediaDecision) {
  return jsonResponse({ output_text: JSON.stringify({ candidates: [{
    text: 'A post needing a Reel.', mediaPrompt: 'a scene', rationale: 'deprecated-media-skip coverage', spreadPotential: 55, noveltyPotential: 52,
    features: { topic: 'test', angle: 'a', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision, trendUsed: false }
  }] }) });
}

// A local date/time whose UTC instant is past the confirmed shutdown date, but whose Asia/Tokyo local
// time still falls inside the account's 08:00-08:30 schedule window - so the SAME slotId is due at both
// FIRST_POLL and SECOND_POLL, exactly like two real autopilot.yml runs 10 minutes apart would see.
const FIRST_POLL = new Date('2026-09-24T23:15:00Z'); // 2026-09-25 08:15 JST
const SECOND_POLL = new Date('2026-09-24T23:25:00Z'); // 2026-09-25 08:25 JST
// Same two-polls-in-one-window trick, but BEFORE the shutdown date - needed for scenarios (QA-input
// oversize, the persistence-failure test) that must reach past the deprecation guard to hit a different
// deterministic failure, which a post-shutdown `now` would short-circuit before ever getting there.
const FIRST_POLL_PRE_SHUTDOWN = new Date('2026-08-13T23:15:00Z'); // 2026-08-14 08:15 JST
const SECOND_POLL_PRE_SHUTDOWN = new Date('2026-08-13T23:25:00Z'); // 2026-08-14 08:25 JST

test('a live PROVIDER_DEPRECATED failure marks the slot skipped, so the next poll within the same window does not re-pay for generation', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await snapshotAndClearDurableClaims();
    await installAccount('generate');
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'deprecated-media-ig': { accessToken: 'at', igUserId: 'ig' } });
    process.env.GH_TOKEN = 'test-gh-token';
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_REF_NAME = 'main';

    let generateCalls = 0;
    let videosApiCalls = 0;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') { generateCalls += 1; return generationResponse('generate'); }
      if (target === 'https://api.github.com/repos/owner/repo') return jsonResponse({ private: false });
      if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') return jsonResponse({ id: 7, assets: [] });
      if (target === 'https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=1') return jsonResponse([]);
      if (target.startsWith('https://api.openai.com/v1/videos')) { videosApiCalls += 1; throw new Error(`No OpenAI Videos API call should ever succeed past the shutdown date: ${target}`); }
      if (target.startsWith('https://api.github.com/repos/owner/repo/contents/data/durable-claims/')) return jsonResponse({ message: 'Not Found' }, 404);
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const firstReport = await runAutopilot({ accountFilter: 'deprecated-media-ig', dryRun: false, now: FIRST_POLL });
    assert.equal(firstReport[0].status, 'provider-deprecated', `expected the first poll to fail with provider-deprecated, got: ${JSON.stringify(firstReport[0])}`);
    assert.equal(generateCalls, 1, 'the first poll must still attempt generation once (dry-run/cache-reuse must not be broken by an early guard)');
    assert.equal(videosApiCalls, 0, 'the Videos API itself must never actually be called, only OpenAI billed for the text generation');

    const secondReport = await runAutopilot({ accountFilter: 'deprecated-media-ig', dryRun: false, now: SECOND_POLL });
    assert.equal(secondReport[0].status, 'already-handled', `expected the second poll (same due window) to see the slot already handled, got: ${JSON.stringify(secondReport[0])}`);
    assert.equal(generateCalls, 1, 'the second poll within the same scheduling window must NOT pay for a second generatePost() call');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await restoreDurableClaims();
  }
});

test('an oversized QA preview (a deterministic config problem, not a content-quality one) also marks the slot skipped', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await snapshotAndClearDurableClaims();
    const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    config.accounts['deprecated-media-ig'] = {
      ...account('generate'),
      media: { ...account('generate').media, qa: { enabled: true, maxInputBytes: 10, maxRegenerations: 0 } }
    };
    await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'deprecated-media-ig': { accessToken: 'at', igUserId: 'ig' } });
    process.env.GH_TOKEN = 'test-gh-token';
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_REF_NAME = 'main';

    let generateCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') { generateCalls += 1; return generationResponse('generate'); }
      if (target === 'https://api.github.com/repos/owner/repo') return jsonResponse({ private: false });
      if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') return jsonResponse({ id: 7, assets: [] });
      if (target === 'https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=1') return jsonResponse([]);
      if (target.startsWith('https://api.github.com/repos/owner/repo/contents/data/durable-claims/')) return jsonResponse({ message: 'Not Found' }, 404);
      if (target === 'https://api.openai.com/v1/videos?limit=100') return jsonResponse({ data: [] });
      if (target === 'https://api.openai.com/v1/videos' && options.method === 'POST') return jsonResponse({ id: 'video-qa-oversize-e2e', status: 'completed' });
      // Both preview variants exceed the tiny maxInputBytes above - a deterministic config-tuning
      // failure (raise qa.maxInputBytes), not a content-quality rejection that might pass on retry.
      if (target === 'https://api.openai.com/v1/videos/video-qa-oversize-e2e/content?variant=spritesheet') {
        return new Response(new Uint8Array(50), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (target === 'https://api.openai.com/v1/videos/video-qa-oversize-e2e/content?variant=thumbnail') {
        return new Response(new Uint8Array(50), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (target === 'https://api.openai.com/v1/videos/video-qa-oversize-e2e' && options.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`Unexpected mocked URL: ${target} ${options.method || 'GET'}`);
    };

    const firstReport = await runAutopilot({ accountFilter: 'deprecated-media-ig', dryRun: false, now: FIRST_POLL_PRE_SHUTDOWN });
    assert.equal(firstReport[0].status, 'media-qa-failed', `expected the first poll to fail with media-qa-failed, got: ${JSON.stringify(firstReport[0])}`);
    assert.equal(generateCalls, 1);

    const secondReport = await runAutopilot({ accountFilter: 'deprecated-media-ig', dryRun: false, now: SECOND_POLL_PRE_SHUTDOWN });
    assert.equal(secondReport[0].status, 'already-handled', `expected the second poll to see the slot already handled, got: ${JSON.stringify(secondReport[0])}`);
    assert.equal(generateCalls, 1, 'the second poll must NOT pay for a second generatePost() call for a deterministic QA-input-size failure');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await restoreDurableClaims();
  }
});

test('if persisting the terminal skip itself fails, the run surfaces a fatal state-error instead of silently finishing green', async (t) => {
  const STATE_FILE = fileURLToPath(new URL('../data/state.json', import.meta.url));
  // Root bypasses ordinary chmod-based permission denial, so the immutable filesystem attribute (which
  // even root cannot write through without first clearing it) is the only reliable way to force this
  // write to fail in a sandboxed environment - but it needs the underlying filesystem's support, which
  // isn't guaranteed (e.g. some container/overlay filesystems silently ignore it), so this is verified
  // with a real round-trip probe rather than assumed from the `chattr` command merely existing.
  const probePath = fileURLToPath(new URL('../data/.chattr-probe.tmp', import.meta.url));
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
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await snapshotAndClearDurableClaims();
    await installAccount('generate');
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'deprecated-media-ig': { accessToken: 'at', igUserId: 'ig' } });
    process.env.GH_TOKEN = 'test-gh-token';
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_REF_NAME = 'main';

    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') return generationResponse('generate');
      if (target === 'https://api.github.com/repos/owner/repo') return jsonResponse({ private: false });
      if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') return jsonResponse({ id: 7, assets: [] });
      if (target === 'https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=1') return jsonResponse([]);
      if (target.startsWith('https://api.github.com/repos/owner/repo/contents/data/durable-claims/')) return jsonResponse({ message: 'Not Found' }, 404);
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    // markSlot ultimately writes data/state.json via a temp-file-then-rename; the immutable attribute
    // makes that rename fail with EPERM even for root, unlike a plain chmod (which root bypasses) -
    // this is the only reliable way to force the write itself to fail in this sandboxed environment.
    await writeFile(STATE_FILE, `${JSON.stringify({ slots: {} }, null, 2)}\n`, 'utf8');
    execFileSync('chattr', ['+i', STATE_FILE]);
    try {
      const report = await runAutopilot({ accountFilter: 'deprecated-media-ig', dryRun: false, now: FIRST_POLL });
      assert.equal(report[0].status, 'state-error', `expected a fatal state-error when the terminal skip can't be persisted, got: ${JSON.stringify(report[0])}`);
      assert.match(report[0].error, /Failed to persist terminal skip/);
    } finally {
      execFileSync('chattr', ['-i', STATE_FILE]);
    }
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await restoreDurableClaims();
  }
});

test('an "auto" strategy Reel account may still succeed via a non-video mediaDecision, even past the shutdown date', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await snapshotAndClearDurableClaims();
    await installAccount('auto');
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'deprecated-media-ig': { accessToken: 'at', igUserId: 'ig' } });

    let generateCalls = 0;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') { generateCalls += 1; return generationResponse('none'); }
      if (target.startsWith('https://graph.instagram.com/') || target.startsWith('https://graph.facebook.com/')) {
        throw new Error(`Unexpected publish-path call for a text-only mediaDecision: ${target}`);
      }
      throw new Error(`Unexpected mocked URL: ${target} ${options.method || 'GET'}`);
    };

    const report = await runAutopilot({ accountFilter: 'deprecated-media-ig', dryRun: true, now: FIRST_POLL });
    // Assert the actual successful outcome, not just the absence of one specific failure - a weaker
    // "notEqual" assertion here would also pass if the run failed for some unrelated reason, without
    // actually proving the stated non-video dry-run success path was reached.
    assert.equal(report[0].status, 'dry-run', `expected a successful non-video dry run, got: ${JSON.stringify(report[0])}`);
    // Instagram accounts never actually accept AI's mediaDecision:'none' (see resolveMediaDetailed in
    // src/lib/media.mjs - ensureMediaForPlatform requires Instagram posts to always carry media), so the
    // resolved decision here is 'generate', not 'none'. What this test actually proves is that dry-run
    // reaches a full successful decision (not a provider-deprecated failure) even though the account's
    // strategy is 'auto' - the deprecation guard never fires because dry-run's media path never calls
    // the real Videos API in the first place (see generated()'s dry-run branch).
    assert.equal(report[0].payload.mediaResolution.decision, 'generate');
    assert.equal(generateCalls, 1, 'an auto-strategy account must still be allowed to attempt generation');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await restoreDurableClaims();
  }
});

// Regression coverage for: the terminal-skip persistence above reads slotHandled() at the TOP of the
// per-slot loop, then - much later, after a full paid generatePost() call and a failed media attempt -
// writes 'skipped' unconditionally. Those two points are not atomic: a concurrent runner (another
// process, or in a hypothetical future parallelized loop) could publish the very same slot, or create
// its approval issue, in between. The original markSlot() call would have silently clobbered that real,
// newer outcome with a stale 'skipped' record - not a duplicate-post risk (since 'skipped' is also a
// "handled" status), but real state corruption: a successfully published post's own record would lie
// about what happened. markSlotIfUnhandled() closes this by refusing to downgrade an already-handled
// slot. These tests fail on the pre-fix markSlot()-based code (which always overwrites) and pass on the
// markSlotIfUnhandled()-based fix.

test('markSlotIfUnhandled refuses to downgrade an already-published slot to skipped', async () => {
  const files = await snapshotFiles([...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await markSlot('race-test:2026-09-25:08:00', 'published', { account: 'race-test', result: { id: 'post-1' } });

    const outcome = await markSlotIfUnhandled('race-test:2026-09-25:08:00', 'skipped', { account: 'race-test', reason: 'provider-deprecated' });
    assert.equal(outcome.applied, false, 'a write onto an already-handled slot must not apply');
    assert.equal(outcome.current.status, 'published', 'the reported current state must reflect the real, newer outcome');

    const slot = await getSlot('race-test:2026-09-25:08:00');
    assert.equal(slot.status, 'published', 'the on-disk slot must still show published, not be overwritten to skipped');
    assert.equal(slot.result?.id, 'post-1', 'the original publish detail must be preserved untouched');
  } finally {
    await restoreFiles(files);
  }
});

test('markSlotIfUnhandled refuses to downgrade an already-approval_pending slot to skipped', async () => {
  const files = await snapshotFiles([...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await markSlot('race-test:2026-09-25:08:00', 'approval_pending', { account: 'race-test', issue: 42 });

    const outcome = await markSlotIfUnhandled('race-test:2026-09-25:08:00', 'skipped', { account: 'race-test', reason: 'media-too-large' });
    assert.equal(outcome.applied, false);
    assert.equal(outcome.current.status, 'approval_pending');

    const slot = await getSlot('race-test:2026-09-25:08:00');
    assert.equal(slot.status, 'approval_pending');
    assert.equal(slot.issue, 42);
  } finally {
    await restoreFiles(files);
  }
});

test('markSlotIfUnhandled DOES apply when the slot has not reached a handled status yet', async () => {
  const files = await snapshotFiles([...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    const outcome = await markSlotIfUnhandled('race-test:2026-09-25:08:00', 'skipped', { account: 'race-test', reason: 'provider-deprecated' });
    assert.equal(outcome.applied, true);

    const slot = await getSlot('race-test:2026-09-25:08:00');
    assert.equal(slot.status, 'skipped');
  } finally {
    await restoreFiles(files);
  }
});

test('end-to-end: a slot published by a concurrent writer mid-run is never overwritten to skipped by this run\'s terminal-deprecation failure', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await snapshotAndClearDurableClaims();
    await installAccount('generate');
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'deprecated-media-ig': { accessToken: 'at', igUserId: 'ig' } });
    process.env.GH_TOKEN = 'test-gh-token';
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_REF_NAME = 'main';

    const slotId = 'deprecated-media-ig:2026-09-25:08:00';
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/responses') {
        // Simulate a genuinely concurrent second runner completing a real publish for THIS EXACT slot
        // at the moment this run's own generatePost() call resolves - i.e. strictly after this run's
        // own earlier slotHandled() check already found the slot unhandled, and strictly before this
        // run reaches its own markSlotIfUnhandled() call further down the stack.
        await markSlot(slotId, 'published', { account: 'deprecated-media-ig', result: { id: 'concurrent-publish' } });
        return generationResponse('generate');
      }
      if (target === 'https://api.github.com/repos/owner/repo') return jsonResponse({ private: false });
      if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') return jsonResponse({ id: 7, assets: [] });
      if (target === 'https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=1') return jsonResponse([]);
      if (target.startsWith('https://api.github.com/repos/owner/repo/contents/data/durable-claims/')) return jsonResponse({ message: 'Not Found' }, 404);
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const report = await runAutopilot({ accountFilter: 'deprecated-media-ig', dryRun: false, now: FIRST_POLL });
    assert.equal(report[0].status, 'already-handled', `this run must recognize the slot was concurrently handled, got: ${JSON.stringify(report[0])}`);
    assert.equal(report[0].concurrentStatus, 'published');

    const slot = await getSlot(slotId);
    assert.equal(slot.status, 'published', 'the concurrently-published slot must survive this run\'s own terminal-deprecation failure untouched');
    assert.equal(slot.result?.id, 'concurrent-publish');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await restoreDurableClaims();
  }
});
