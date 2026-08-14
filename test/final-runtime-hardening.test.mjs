import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateDraftText, xWeightedLength } from '../src/lib/safety.mjs';
import { validateStrictConfig } from '../src/validate-strict-config.mjs';
import { downloadMedia, __test as httpTest } from '../src/lib/http.mjs';
import { readHistory, textHash } from '../src/lib/history.mjs';
import { loadAccounts, resolveAccount } from '../src/lib/config.mjs';
import { publish } from '../src/publish.mjs';
import { writeDurableClaim, __test as durableTest } from '../src/lib/durable-claim.mjs';

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const HISTORY_FILE = fileURLToPath(new URL('../data/history.jsonl', import.meta.url));
const DURABLE_DIR = fileURLToPath(new URL('../data/durable-claims/', import.meta.url));
const DATA_FILES = [
  HISTORY_FILE,
  fileURLToPath(new URL('../data/audit.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/state.json', import.meta.url)),
  fileURLToPath(new URL('../data/runtime-health.json', import.meta.url))
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

function xAccount({ enabled = true, mode = 'manual', safety = {} } = {}) {
  return {
    platform: 'x', enabled, mode, credentialKey: 'hardening-x', displayName: 'Hardening X',
    schedule: { timezone: 'Asia/Tokyo', times: ['08:00'], days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
    generation: { maxChars: 280 },
    safety: { maxPostsPerDay: 10, minMinutesBetweenPosts: 0, ...safety },
    resilience: { enabled: false }, budgets: { enabled: false },
    media: { strategy: 'none', type: 'image' }
  };
}

async function withRepoFixture(account, run) {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  durableTest.resetForTests();
  await rm(DURABLE_DIR, { recursive: true, force: true });
  for (const path of DATA_FILES) await rm(path, { force: true });
  try {
    const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    config.accounts['hardening-x'] = account;
    await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'hardening-x': { consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' }
    });
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    durableTest.resetForTests();
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
}

test('X safety recognizes bare domains as transformed links and applies domain/link guards', () => {
  assert.equal(xWeightedLength('example.com'), 23);
  const linkLimited = { platform: 'x', generation: {}, safety: { maxLinks: 0 } };
  assert.throws(() => validateDraftText(linkLimited, 'See example.com'), /1 links/);

  const blocked = { platform: 'x', generation: {}, safety: { blockedDomains: ['example.com'] } };
  assert.throws(() => validateDraftText(blocked, 'See shop.example.com/item'), /blocked domain/);
});

test('X hashtag guard handles punctuation boundaries and full-width hash signs', () => {
  const account = { platform: 'x', generation: {}, safety: { maxHashtags: 1 } };
  assert.throws(() => validateDraftText(account, '本文。#AI と ＃副業'), /2 hashtags/);
});

test('X validation rejects characters rejected by twitter-text validity rules', () => {
  const account = { platform: 'x', generation: {}, safety: {} };
  assert.throws(() => validateDraftText(account, `hello\uFEFFworld`), /does not accept/);
});

test('strict config rejects non-boolean runtime toggles, unknown media strategies, and insecure media URLs', () => {
  const errors = validateStrictConfig({
    defaults: {},
    accounts: {
      demo: {
        platform: 'x', enabled: true, mode: 'manual',
        analytics: { enabled: 'false' },
        media: { strategy: 'typo', endpoint: 'http://127.0.0.1/media', qa: { enabled: 'true' } }
      }
    }
  });
  assert.equal(errors.some((value) => value.includes('analytics.enabled must be a boolean')), true);
  assert.equal(errors.some((value) => value.includes('media.qa.enabled must be a boolean')), true);
  assert.equal(errors.some((value) => value.includes('unsupported media.strategy')), true);
  assert.equal(errors.some((value) => value.includes('media.endpoint must be a valid HTTPS URL')), true);
});

test('media downloader rejects local/private targets and validates every redirect hop', async () => {
  assert.throws(() => httpTest.publicHttpsUrl('https://127.0.0.1/a.png'), /public network destination/);
  assert.throws(() => httpTest.publicHttpsUrl('https://localhost/a.png'), /public network destination/);
  assert.throws(() => httpTest.publicHttpsUrl('http://example.com/a.png'), /https:\/\//);

  const previousFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal' } });
    };
    await assert.rejects(downloadMedia('https://public.example/media.png'), /https:\/\//);
    assert.equal(calls, 1, 'unsafe redirect target must be rejected before a second request is sent');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('history corruption fails closed instead of silently dropping a published row', async () => {
  const saved = await snapshotFiles([HISTORY_FILE]);
  try {
    await writeFile(HISTORY_FILE, '{"account":"x","status":"published"}\n{broken}\n', 'utf8');
    await assert.rejects(readHistory(), (error) => error.code === 'HISTORY_CORRUPT' && /line 2/.test(error.message));
  } finally {
    await restoreFiles(saved);
  }
});

test('runtime treats enabled string values as disabled even if strict validation is bypassed', async () => {
  await withRepoFixture(xAccount({ enabled: 'false' }), async () => {
    const accounts = await loadAccounts();
    assert.equal(accounts['hardening-x'].enabled, false);
    await assert.rejects(resolveAccount('hardening-x'), /disabled/);
  });
});

test('pause mode is a hard live-publish stop', async () => {
  await withRepoFixture(xAccount({ mode: 'pause' }), async () => {
    globalThis.fetch = async () => { throw new Error('provider must not be called while paused'); };
    await assert.rejects(
      publish({ account: 'hardening-x', text: 'must not publish', source: 'manual' }),
      /is paused/
    );
  });
});

test('manual publish path re-checks maxPostsPerDay at the final provider boundary', async () => {
  await withRepoFixture(xAccount({ mode: 'manual', safety: { maxPostsPerDay: 1, minMinutesBetweenPosts: 0 } }), async () => {
    await writeFile(HISTORY_FILE, `${JSON.stringify({
      at: new Date().toISOString(), account: 'hardening-x', platform: 'x', status: 'published', text: 'already posted'
    })}\n`, 'utf8');
    globalThis.fetch = async () => { throw new Error('provider must not be called when rate limited'); };
    await assert.rejects(
      publish({ account: 'hardening-x', text: 'second post', source: 'manual' }),
      /posting frequency guard: daily limit reached/
    );
  });
});

test('published durable replay repairs missing main history without invoking the provider', async () => {
  await withRepoFixture(xAccount({ mode: 'pause' }), async () => {
    const slotId = 'hardening-x:2026-08-14:08:00';
    const publishedAt = new Date().toISOString();
    await writeDurableClaim(slotId, 'published', {
      account: 'hardening-x', platform: 'x', source: 'auto', text: 'canonical published text',
      textHash: textHash('canonical published text'), providerPostId: 'post-123', publishedAt, mediaType: 'image'
    });
    globalThis.fetch = async () => { throw new Error('provider must not be called for published replay'); };

    const result = await publish({
      account: 'hardening-x', text: 'canonical published text', source: 'auto', slotId
    });
    assert.equal(result.idempotentReplay, true);
    assert.equal(result.bookkeepingRecovered, true);
    assert.equal(result.postId, 'post-123');

    const history = await readHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].slotId, slotId);
    assert.equal(history[0].providerPostId, 'post-123');
    assert.equal(history[0].text, 'canonical published text');
    assert.equal(history[0].recoveredFromDurableClaim, true);
  });
});
