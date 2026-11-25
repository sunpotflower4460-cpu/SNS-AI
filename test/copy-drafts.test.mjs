import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { briefSlug, parseBrief } from '../src/copy-drafts/brief.mjs';
import { checkVariants, explanatoryRun } from '../src/copy-drafts/quality.mjs';
import { chooseModel, loadCopyDraftConfig, runCopyDrafts } from '../src/copy-drafts/run.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const USAGE_STATE = join(ROOT, 'data/usage-state.json');
const USAGE_FILE = join(ROOT, 'data/usage.jsonl');

const BRIEF = { character: 'ひぐま', scene: 'ひぐまが頭の炎をたいまつとしておじいさんに渡すと、おじいさんは聖火リレーのように走り去り、ひぐまが置いていかれる', media: 'video', platforms: ['instagram', 'threads', 'youtube', 'tiktok', 'x'] };

function variant(n, overrides = {}) {
  return {
    id: n, angle: `狙い${'ABCDE'[n - 1]}${n}`, caption_jp: `炎を渡したひぐま${n}。走り去るおじいさん。`, caption_en: `Higuma hands over the flame ${n}.`,
    youtube_title_jp: `炎を渡したひぐま${n}`, youtube_title_en: `Higuma hands over the flame ${n}`, x_text: `炎を渡したひぐま${n} #ひぐま`,
    hashtags: ['#オリジナルキャラクター', '#ひぐま'], ...overrides
  };
}
const good = () => [variant(1), variant(2), variant(3)];
const stripId = ({ id, ...rest }) => rest;

async function snap(path) { try { return { exists: true, bytes: await readFile(path) }; } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; } }
async function restore(path, saved) { if (!saved.exists) return rm(path, { force: true }); await writeFile(path, saved.bytes); }

async function withSandbox(run) {
  const outDir = await mkdtemp(join(tmpdir(), 'copy-drafts-'));
  const state = await snap(USAGE_STATE); const jsonl = await snap(USAGE_FILE);
  const previousFetch = globalThis.fetch; const previousKey = process.env.OPENAI_API_KEY; const previousDurable = process.env.SNS_DURABLE_BUDGETS;
  process.env.OPENAI_API_KEY = 'test-openai-key'; delete process.env.SNS_DURABLE_BUDGETS;
  try { return await run(outDir); }
  finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    if (previousDurable !== undefined) process.env.SNS_DURABLE_BUDGETS = previousDurable;
    await restore(USAGE_STATE, state); await restore(USAGE_FILE, jsonl);
    await rm(outDir, { recursive: true, force: true });
  }
}

function mockOpenAi(variants, calls = []) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify({
      model: body.model, usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ variants: variants.map(stripId) }) }] }]
    }), { status: 200 });
  };
  return calls;
}

test('parseBrief accepts the documented brief and rejects bad media, platforms and unknown fields', () => {
  assert.deepEqual(parseBrief(JSON.stringify(BRIEF)), { ...BRIEF, notes: '', slug: null });
  assert.throws(() => parseBrief({ ...BRIEF, media: 'gif' }), /media/);
  assert.throws(() => parseBrief({ ...BRIEF, platforms: ['instagram', 'mastodon'] }), /unsupported/);
  assert.throws(() => parseBrief({ ...BRIEF, platforms: [] }), /platforms/);
  assert.throws(() => parseBrief({ ...BRIEF, publish: true }), /unknown field/);
  assert.throws(() => parseBrief({ ...BRIEF, scene: '' }), /scene/);
  assert.throws(() => parseBrief('not json'), /not valid JSON/);
  assert.throws(() => parseBrief({ ...BRIEF, slug: '../evil' }), /slug/);
});

test('briefSlug is path-safe, deterministic and distinguishes different scenes', () => {
  const a = briefSlug(parseBrief(BRIEF));
  assert.equal(a, briefSlug(parseBrief(BRIEF)));
  assert.notEqual(a, briefSlug(parseBrief({ ...BRIEF, scene: '別の場面' })));
  assert.match(a, /^ひぐま-[0-9a-f]{6}$/);
  assert.doesNotMatch(briefSlug(parseBrief({ ...BRIEF, character: '../a/b' })), /[/\\.]/);
});

test('checkVariants accepts clean variants and flags each fixed quality condition', () => {
  const brief = parseBrief(BRIEF);
  assert.deepEqual(checkVariants(good(), brief), []);
  assert.match(checkVariants([variant(1), variant(2)], brief)[0], /at least 3/);
  const has = (variants, pattern) => assert.ok(checkVariants(variants, brief).some((e) => pattern.test(e)), `expected ${pattern}`);
  has([variant(1, { caption_jp: 'ひぐまが炎を渡しました。おじいさんが走るのです。' }), variant(2), variant(3)], /ですます/);
  has([variant(1, { caption_jp: 'ワールドクリエイターとしての、ひぐまの世界。' }), variant(2), variant(3)], /template opener/);
  has([variant(1, { caption_jp: '炎を渡したひぐま。置いていかれるのは誰でしょうか？' }), variant(2, { caption_jp: '走り去るおじいさん。どう思いますか？' }), variant(3)], /question/);
  has([variant(1, { caption_en: 'Sanpotto presents Higuma.' }), variant(2), variant(3)], /forbidden name/);
  has([variant(1, { caption_en: 'ひぐま hands over the flame.' }), variant(2), variant(3)], /Japanese character names/);
  has([variant(1, { x_text: '炎を渡したひぐま https://example.com/x' }), variant(2), variant(3)], /link/);
  has([variant(1, { x_text: 'あ'.repeat(141) }), variant(2), variant(3)], /280/);
  has([variant(1, { caption_jp: 'エンドカードのロゴまで見て。' }), variant(2), variant(3)], /end card/);
  has([variant(1, { angle: 'オチ先行' }), variant(2, { angle: 'オチ先行' }), variant(3)], /angle overlaps/);
  has([variant(1, { hashtags: ['ひぐま'] }), variant(2), variant(3)], /invalid hashtag/);
});

test('only an isolated ですます sentence is allowed; a question closer is allowed in at most one variant', () => {
  assert.equal(explanatoryRun('炎を渡したひぐま。走り去るのです。置いていかれる。'), 1);
  assert.equal(explanatoryRun('走り去ります。置いていかれます。'), 2);
  const brief = parseBrief(BRIEF);
  assert.deepEqual(checkVariants([variant(1, { caption_jp: '炎を渡したひぐま。次はどうなるでしょうか？' }), variant(2), variant(3)], brief), []);
});

test('copy-drafts config only allows gpt-6-luna and gpt-6.1-sol', async () => {
  const config = await loadCopyDraftConfig();
  assert.deepEqual(config.models.allowed, ['gpt-6-luna', 'gpt-6.1-sol']);
  assert.equal(chooseModel(config).model, 'gpt-6-luna');
  assert.equal(chooseModel(config, { hard: true }).model, 'gpt-6.1-sol');
  assert.equal(chooseModel(config, { hard: true, budgetState: 'conservative' }).model, 'gpt-6-luna', 'hard briefs downgrade when the budget governor is conservative');
  assert.throws(() => chooseModel(config, { budgetState: 'stopped' }), /blocked/);
  const bad = { ...config, models: { ...config.models, standard: 'gpt-6-astra' } };
  assert.throws(() => chooseModel(bad), /not allowed/);
  assert.throws(() => chooseModel({ ...config, models: { ...config.models, standard: 'gpt-5.6-luna', allowed: [...config.models.allowed, 'gpt-5.6-luna'] } }), /not allowed/);
});

test('runCopyDrafts makes exactly one Responses call and saves the documented schema', () => withSandbox(async (outDir) => {
  const calls = mockOpenAi(good());
  const now = new Date('2026-11-25T05:00:00Z');
  const out = await runCopyDrafts({ brief: BRIEF, outDir, now, budgetState: 'healthy' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].body.model, 'gpt-6-luna');
  assert.equal(calls[0].body.store, false);
  assert.match(out.file, /2026-11-25-ひぐま-[0-9a-f]{6}\.json$/);
  const saved = JSON.parse(await readFile(out.file, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['meta', 'variants']);
  assert.deepEqual(Object.keys(saved.meta), ['generated_at', 'model', 'prompt_version', 'brief']);
  assert.deepEqual(Object.keys(saved.meta.brief), ['character', 'scene', 'media', 'platforms']);
  assert.deepEqual(saved.variants.map((v) => v.id), [1, 2, 3]);
  assert.deepEqual(Object.keys(saved.variants[0]), ['id', 'angle', 'caption_jp', 'caption_en', 'youtube_title_jp', 'youtube_title_en', 'x_text', 'hashtags']);
  const usage = (await readFile(join(outDir, 'usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].total_tokens, 30);
  // The shared daily counter was charged once for the pseudo account.
  const state = JSON.parse(await readFile(USAGE_STATE, 'utf8'));
  assert.equal(state.accounts['copy-drafts'].counts.openai, 1);
  // Same brief again the same day never overwrites the earlier draft.
  const again = await runCopyDrafts({ brief: BRIEF, outDir, now, budgetState: 'healthy' });
  assert.notEqual(again.file, out.file);
}));

test('hard briefs use gpt-6.1-sol; the daily call cap blocks further generation', () => withSandbox(async (outDir) => {
  const calls = mockOpenAi(good());
  await runCopyDrafts({ brief: BRIEF, outDir, hard: true, budgetState: 'healthy' });
  assert.equal(calls[0].body.model, 'gpt-6.1-sol');
  const config = await loadCopyDraftConfig();
  const capped = { ...config, accountId: 'copy-drafts-cap-test', budgets: { enabled: true, openaiCallsPerDay: 1 } };
  await runCopyDrafts({ brief: BRIEF, outDir, config: capped, budgetState: 'healthy' });
  await assert.rejects(runCopyDrafts({ brief: BRIEF, outDir, config: capped, budgetState: 'healthy' }), (error) => error.code === 'BUDGET_EXHAUSTED');
  assert.equal(calls.length, 2, 'the capped third attempt never reached the API');
}));

test('output that fails the quality checks is not saved', () => withSandbox(async (outDir) => {
  mockOpenAi([variant(1, { caption_en: 'Sanpotto' }), variant(2), variant(3)]);
  await assert.rejects(runCopyDrafts({ brief: BRIEF, outDir, budgetState: 'healthy' }), (error) => error.code === 'COPY_QUALITY_FAILED');
  assert.deepEqual(await readdir(outDir), []);
}));

test('dry-run builds the prompt without any API call or budget use', () => withSandbox(async (outDir) => {
  globalThis.fetch = async () => { throw new Error('dry-run must not call the API'); };
  const out = await runCopyDrafts({ brief: BRIEF, outDir, dryRun: true, budgetState: 'healthy' });
  assert.equal(out.dryRun, true);
  assert.match(out.user, /ひぐま/);
  assert.equal(JSON.parse(await readFile(USAGE_STATE, 'utf8')).accounts['copy-drafts'], undefined);
}));

test('the copy-draft step is generation-only: no publish module, publish host or secret other than OPENAI_API_KEY', async () => {
  const dir = join(ROOT, 'src/copy-drafts');
  const files = [...(await readdir(dir)).map((name) => join(dir, name)), join(ROOT, '.github/workflows/copy-drafts.yml')];
  const forbidden = /publish|api\.twitter\.com|api\.x\.com|graph\.facebook\.com|graph\.instagram\.com|googleapis\.com|open\.tiktokapis|threads\.net|SOCIAL_CREDENTIALS|X_OAUTH2|MEDIA_SERVICE_TOKEN|CONVENIENCE_HUB/i;
  for (const file of files) {
    const text = (await readFile(file, 'utf8')).split('\n').filter((line) => !/^\s*(#|\/\/)/.test(line)).join('\n');
    assert.doesNotMatch(text, forbidden, `${file} must stay generation-only`);
  }
  const workflow = await readFile(join(ROOT, '.github/workflows/copy-drafts.yml'), 'utf8');
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]), ['OPENAI_API_KEY']);
  assert.doesNotMatch(workflow.match(/^on:[\s\S]*?^permissions:/m)[0], /schedule|push:|pull_request|workflow_run/);
});
