import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { metricVector } from '../src/analytics/scorer.mjs';
import { ensureExperiment } from '../src/experiments/engine.mjs';
import { loadExperimentState, saveExperimentState } from '../src/experiments/store.mjs';
import { moderateText, openaiRequest } from '../src/lib/openai.mjs';
import { checkRateLimits, validateDraftText } from '../src/lib/safety.mjs';
import { loadState, markSlot } from '../src/lib/state.mjs';
import { generateAndHostImageDetailed } from '../src/media/openai-image.mjs';
import { cleanupGeneratedAssets } from '../src/media/release-host.mjs';
import { consumeUsage, usageToday } from '../src/ops/budget.mjs';
import { scanSecrets } from '../src/ops/secret-scan.mjs';
import { validateConfig } from '../src/validate-config.mjs';

const STATE_FILE = fileURLToPath(new URL('../data/state.json', import.meta.url));
const USAGE_STATE = fileURLToPath(new URL('../data/usage-state.json', import.meta.url));
const USAGE_LOG = fileURLToPath(new URL('../data/usage.jsonl', import.meta.url));
const EXPERIMENT_FILE = fileURLToPath(new URL('../data/experiments/reconcile-regression.json', import.meta.url));
const SECRET_FILE = fileURLToPath(new URL('../data/secret-scan-regression.txt', import.meta.url));

async function snapshot(paths) {
  const saved = new Map();
  for (const path of paths) {
    try { saved.set(path, await readFile(path)); }
    catch (error) { if (error.code === 'ENOENT') saved.set(path, null); else throw error; }
  }
  return saved;
}

async function restore(saved) {
  for (const [path, bytes] of saved) {
    if (bytes === null) await rm(path, { force: true });
    else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
  }
}

function saveEnv(...names) { return Object.fromEntries(names.map((name) => [name, process.env[name]])); }
function restoreEnv(saved) {
  for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value;
}
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('a zero Reel skip rate is treated as perfect watch quality rather than missing data', () => {
  const vector = metricVector({ metrics: { reach: 100, reelSkipRate: 0 } });
  assert.equal(vector.watchQuality, 1);
});

test('manual media-only validation still enforces disclosure rules and malformed history timestamps fail closed', () => {
  assert.throws(
    () => validateDraftText({ platform: 'instagram', safety: { requiredAnyPhrases: ['PR'] } }, '', { requireNonEmpty: false }),
    /required disclosure\/phrase/
  );
  assert.equal(validateDraftText({ platform: 'instagram', safety: {} }, '', { requireNonEmpty: false }), '');

  const rate = checkRateLimits('acct', { schedule: { timezone: 'UTC' }, safety: { maxPostsPerDay: 10, minMinutesBetweenPosts: 15 } }, [
    { account: 'acct', status: 'published', at: 'not-a-date' }
  ], new Date('2026-08-13T01:00:00Z'));
  assert.equal(rate.ok, false);
  assert.match(rate.reason, /unparseable/);
});

test('config validation honors inherited autonomous mode and permits an explicit zero budget kill switch', () => {
  const errors = validateConfig({
    defaults: { mode: 'auto', budgets: { openaiCallsPerDay: 0 } },
    accounts: { acct: { platform: 'x', enabled: true, schedule: { times: [] } } }
  });
  assert.ok(errors.some((error) => error.includes('autonomous mode requires schedule.times')));
  assert.ok(!errors.some((error) => error.includes('budgets.openaiCallsPerDay')));

  const negative = validateConfig({
    defaults: { mode: 'pause' },
    accounts: { acct: { platform: 'x', enabled: false, budgets: { openaiCallsPerDay: -1 } } }
  });
  assert.ok(negative.some((error) => error.includes('budgets.openaiCallsPerDay')));
});

test('config validation rejects an account id that collides with the reserved dry-run-preview budget namespace', () => {
  const errors = validateConfig({
    defaults: { mode: 'pause' },
    accounts: { 'brand::dry-run-preview': { platform: 'x', enabled: false } }
  });
  assert.ok(
    errors.some((error) => error.startsWith('brand::dry-run-preview:') && error.includes('reserved')),
    `expected a reserved-suffix error, got: ${JSON.stringify(errors)}`
  );
});

test('openaiRequest refuses to bill an account whose id collides with the reserved dry-run-preview namespace', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { throw new Error(`No request should have been made: ${url}`); };
  try {
    await assert.rejects(
      openaiRequest('/responses', {}, { accountId: 'brand::dry-run-preview', account: {}, operation: 'test' }),
      /reserved "::dry-run-preview" suffix/
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('rate-limit knobs fall back to their safe defaults instead of failing open on NaN, and stay fail-closed on a negative daily cap', () => {
  const account = { schedule: { timezone: 'UTC' } };
  const history = [{ account: 'acct', status: 'published', at: new Date('2026-08-13T00:58:00Z').toISOString() }];
  const now = new Date('2026-08-13T01:00:00Z');

  // NaN maxPostsPerDay must not silently disable the daily cap ("n >= NaN" is always false).
  const nanCap = checkRateLimits('acct', { ...account, safety: { maxPostsPerDay: NaN, minMinutesBetweenPosts: 0 } },
    Array.from({ length: 999 }, () => ({ account: 'acct', status: 'published', at: now.toISOString() })), now);
  assert.equal(nanCap.ok, false, 'a garbage maxPostsPerDay must fall back to the default cap, not become unlimited');

  // NaN minMinutesBetweenPosts must not silently disable the cooldown ("elapsed < NaN" is always false).
  const nanCooldown = checkRateLimits('acct', { ...account, safety: { maxPostsPerDay: 999, minMinutesBetweenPosts: NaN } }, history, now);
  assert.equal(nanCooldown.ok, false, 'a garbage minMinutesBetweenPosts must fall back to the default cooldown, not become zero');

  // Negative minMinutesBetweenPosts must not silently disable the cooldown ("elapsed < -5" is always false).
  const negativeCooldown = checkRateLimits('acct', { ...account, safety: { maxPostsPerDay: 999, minMinutesBetweenPosts: -5 } }, history, now);
  assert.equal(negativeCooldown.ok, false, 'a negative minMinutesBetweenPosts must fall back to the default cooldown, not disable it');

  // A negative maxPostsPerDay already fails closed on its own ("0 posts so far >= -5" is always true) -
  // confirm the NaN-guard above did not accidentally weaken that into "use the default cap instead".
  const negativeCap = checkRateLimits('acct', { ...account, safety: { maxPostsPerDay: -5, minMinutesBetweenPosts: 0 } }, [], now);
  assert.equal(negativeCap.ok, false, 'a negative maxPostsPerDay must still block every post, not fall back to the default cap');

  // Number(null) is 0, not NaN, so an explicit null (an account-level override explicitly unsetting an
  // inherited default, which validate-config's `value != null` checks already treat as "no opinion")
  // must not silently become "block every post" / "no cooldown at all" - it must fall back to the
  // default just like `undefined` does.
  const nullCap = checkRateLimits('acct', { ...account, safety: { maxPostsPerDay: null, minMinutesBetweenPosts: 0 } },
    Array.from({ length: 5 }, () => ({ account: 'acct', status: 'published', at: now.toISOString() })), now);
  assert.equal(nullCap.ok, true, 'an explicit null maxPostsPerDay must fall back to the default cap (10), not become 0 and block every post');

  const nullCooldown = checkRateLimits('acct', { ...account, safety: { maxPostsPerDay: 999, minMinutesBetweenPosts: null } }, history, now);
  assert.equal(nullCooldown.ok, false, 'an explicit null minMinutesBetweenPosts must fall back to the default cooldown (15m), not become 0 and disable it');
});

test('concurrent slot writes preserve every independently handled slot', async () => {
  const saved = await snapshot([STATE_FILE]);
  try {
    await rm(STATE_FILE, { force: true });
    await Promise.all(Array.from({ length: 25 }, (_, index) => markSlot(`parallel-${index}`, 'published', { account: 'acct' })));
    const state = await loadState();
    for (let index = 0; index < 25; index += 1) assert.equal(state.slots[`parallel-${index}`]?.status, 'published');
  } finally {
    await restore(saved);
  }
});

test('concurrent budget consumption cannot lose increments or overshoot the configured cap', async () => {
  const saved = await snapshot([USAGE_STATE, USAGE_LOG]);
  try {
    await rm(USAGE_STATE, { force: true });
    await rm(USAGE_LOG, { force: true });
    const account = { schedule: { timezone: 'UTC' }, budgets: { enabled: true, openaiCallsPerDay: 5 } };
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => consumeUsage('budget-race', account, 'openai', { index })));
    assert.equal(results.filter((row) => row.status === 'fulfilled').length, 5);
    const rejected = results.filter((row) => row.status === 'rejected');
    assert.equal(rejected.length, 5);
    assert.ok(rejected.every((row) => row.reason?.code === 'BUDGET_EXHAUSTED'));
    assert.equal(await usageToday('budget-race', account, 'openai'), 5);
  } finally {
    await restore(saved);
  }
});

test('experiment rotation uses monotonic completion count beyond the truncated 50-entry history', async () => {
  const saved = await snapshot([EXPERIMENT_FILE]);
  try {
    await rm(EXPERIMENT_FILE, { force: true });
    await saveExperimentState('reconcile-regression', {
      active: null,
      completed: Array.from({ length: 60 }, (_, index) => ({ id: `done-${index}`, status: 'completed' })),
      completedCount: 60
    });
    const stored = await loadExperimentState('reconcile-regression');
    assert.equal(stored.completed.length, 50);
    assert.equal(stored.completedCount, 60);
    const active = await ensureExperiment('reconcile-regression', {
      platform: 'x', experiments: { dimensions: ['hook', 'format', 'cta'], minimumStrategySamples: 0, minSamplesPerVariant: 1, maxDays: 1 }
    }, { sampleSize: 1 });
    assert.equal(active.dimension, 'hook');
  } finally {
    await restore(saved);
  }
});

test('moderation fails closed when the provider returns no usable result', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY');
  const saved = await snapshot([USAGE_STATE, USAGE_LOG]);
  process.env.OPENAI_API_KEY = 'unit-test-key';
  try {
    await rm(USAGE_STATE, { force: true });
    await rm(USAGE_LOG, { force: true });
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://api.openai.com/v1/moderations');
      return jsonResponse({ results: [] });
    };
    await assert.rejects(
      moderateText('safe looking text', { schedule: { timezone: 'UTC' }, safety: {}, budgets: { enabled: false } }, 'moderation-empty'),
      /Moderation returned no result/
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restore(saved);
  }
});

test('image cache identity changes when generation model settings change', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'OPENAI_API_KEY');
  const saved = await snapshot([USAGE_STATE, USAGE_LOG]);
  process.env.GH_TOKEN = 'unit-gh';
  delete process.env.GITHUB_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  process.env.OPENAI_API_KEY = 'unit-openai';
  try {
    await rm(USAGE_STATE, { force: true });
    await rm(USAGE_LOG, { force: true });
    const uploadedNames = [];
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target === 'https://api.github.com/repos/owner/repo') return jsonResponse({ private: false });
      if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') return jsonResponse({ id: 7, assets: [] });
      if (target === 'https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=1') return jsonResponse([]);
      if (target === 'https://api.openai.com/v1/images/generations') return jsonResponse({ data: [{ b64_json: Buffer.from('image').toString('base64') }] });
      if (target.startsWith('https://uploads.github.com/repos/owner/repo/releases/7/assets?name=')) {
        uploadedNames.push(new URL(target).searchParams.get('name'));
        return jsonResponse({ browser_download_url: `https://download.example/${uploadedNames.length}.png` }, 201);
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    const base = { budgets: { enabled: false }, media: { imageModel: 'gpt-image-1', imageQuality: 'medium', qa: { enabled: false, maxRegenerations: 0 } } };
    await generateAndHostImageDetailed('cache-settings', { ...base, media: { ...base.media, imageSize: '1024x1024' } }, 'same-slot', { mediaPrompt: 'same prompt' });
    await generateAndHostImageDetailed('cache-settings', { ...base, media: { ...base.media, imageSize: '1536x1024' } }, 'same-slot', { mediaPrompt: 'same prompt' });
    assert.equal(uploadedNames.length, 2);
    assert.notEqual(uploadedNames[0], uploadedNames[1]);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restore(saved);
  }
});

test('generated-media cleanup does not count an already-missing 404 asset as deleted', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY');
  process.env.GH_TOKEN = 'unit-gh';
  delete process.env.GITHUB_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  try {
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') return jsonResponse({ id: 7, assets: [] });
      if (target === 'https://api.github.com/repos/owner/repo/releases/7/assets?per_page=100&page=1') return jsonResponse([{ id: 99, created_at: '2020-01-01T00:00:00Z' }]);
      if (target === 'https://api.github.com/repos/owner/repo/releases/assets/99' && options.method === 'DELETE') return new Response(null, { status: 404 });
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    assert.deepEqual(await cleanupGeneratedAssets({ retentionDays: 90 }), { skipped: false, scanned: 1, deleted: 0 });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('secret scan detects fine-grained GitHub tokens in tracked data paths', async () => {
  await mkdir(dirname(SECRET_FILE), { recursive: true });
  const token = ['github', 'pat', 'A'.repeat(25)].join('_');
  try {
    await writeFile(SECRET_FILE, `${token}\n`, 'utf8');
    const findings = await scanSecrets();
    assert.ok(findings.some((finding) => finding.file.endsWith('data/secret-scan-regression.txt') && finding.type === 'GitHub fine-grained token'));
  } finally {
    await rm(SECRET_FILE, { force: true });
  }
});
