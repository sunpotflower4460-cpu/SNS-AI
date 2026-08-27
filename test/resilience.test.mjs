import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, downloadMedia } from '../src/lib/http.mjs';
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from '../src/lib/json-store.mjs';
import { openaiRequest } from '../src/lib/openai.mjs';
import { usageToday } from '../src/ops/budget.mjs';
import { getXOAuth2Session, xOAuth2FetchJson } from '../src/providers/x-oauth2.mjs';
import { publishX } from '../src/providers/x.mjs';
import { publishInstagram } from '../src/providers/instagram.mjs';
import { ensurePublicRelease, uploadReleaseAsset } from '../src/media/release-host.mjs';

const X_STATE_FILE = fileURLToPath(new URL('../data/x-oauth2-state.json', import.meta.url));

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function saveEnv(...names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test('JSON store atomically round-trips JSON and tolerates malformed JSONL rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sns-ai-store-'));
  try {
    const json = join(dir, 'nested', 'state.json');
    assert.deepEqual(await readJson(json, { missing: true }), { missing: true });
    await writeJsonAtomic(json, { count: 2, nested: { ok: true } });
    assert.deepEqual(await readJson(json), { count: 2, nested: { ok: true } });

    const jsonl = join(dir, 'events.jsonl');
    await appendJsonl(jsonl, { id: 1 });
    await appendFile(jsonl, '{broken json}\n', 'utf8');
    await appendJsonl(jsonl, { id: 2 });
    assert.deepEqual(await readJsonl(jsonl), [{ id: 1 }, { id: 2 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchJson retries retryable GET failures but never retries unsafe POST failures', async () => {
  const previousFetch = globalThis.fetch;
  try {
    let getCalls = 0;
    globalThis.fetch = async () => {
      getCalls += 1;
      if (getCalls === 1) return jsonResponse({ error: { message: 'busy' } }, 500, { 'retry-after': '0' });
      return jsonResponse({ ok: true });
    };
    assert.deepEqual(await fetchJson('https://example.test/get', { retries: 1 }), { ok: true });
    assert.equal(getCalls, 2);

    let postCalls = 0;
    globalThis.fetch = async () => {
      postCalls += 1;
      return jsonResponse({ error: { message: 'do not retry' } }, 500, { 'retry-after': '0' });
    };
    await assert.rejects(
      fetchJson('https://example.test/post', { method: 'POST', retries: 3 }),
      (error) => error.status === 500 && /do not retry/.test(error.message)
    );
    assert.equal(postCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('downloadMedia rejects insecure URLs and both declared and streamed oversize payloads', async () => {
  const previousFetch = globalThis.fetch;
  try {
    await assert.rejects(downloadMedia('http://example.test/a.png'), /https:\/\//);

    globalThis.fetch = async () => new Response('abcdef', {
      status: 200,
      headers: { 'content-length': '6', 'content-type': 'image/png' }
    });
    await assert.rejects(downloadMedia('https://example.test/a.png', { maxBytes: 5 }), /download limit/);

    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    });
    await assert.rejects(downloadMedia('https://example.test/a.png', { maxBytes: 5 }), /download limit/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OpenAI request retries a throttled request and preserves API authentication', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY');
  process.env.OPENAI_API_KEY = 'test-openai-key';
  try {
    let calls = 0;
    globalThis.fetch = async (url, options = {}) => {
      calls += 1;
      assert.equal(String(url), 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer test-openai-key');
      if (calls === 1) return jsonResponse({ error: { message: 'slow down' } }, 429, { 'retry-after': '0.001' });
      return jsonResponse({ id: 'response-1' });
    };
    assert.deepEqual(await openaiRequest('/responses', { input: 'ping' }, { retries: 1 }), { id: 'response-1' });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('OpenAI request charges the daily budget once per logical call even when it retries', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY');
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const account = {
    schedule: { timezone: 'UTC' },
    budgets: { enabled: true, openaiCallsPerDay: 2, webSearchCallsPerDay: 2, mediaCallsPerDay: 0, imageGenerationsPerDay: 0, videoGenerationsPerDay: 0 }
  };
  const usageFile = fileURLToPath(new URL('../data/usage-state.json', import.meta.url));
  const before = await readFile(usageFile, 'utf8').catch(() => null);
  try {
    await writeFile(usageFile, JSON.stringify({ schemaVersion: 1, days: {} }, null, 2));
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: { message: 'slow down' } }, 429, { 'retry-after': '0.001' });
      return jsonResponse({ id: 'response-1' });
    };
    await openaiRequest('/responses', { input: 'ping' }, {
      retries: 1,
      accountId: 'budget-once',
      account,
      operation: 'retry-budget'
    });
    assert.equal(calls, 2);
    assert.equal(await usageToday('budget-once', account, 'openai'), 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    if (before == null) await rm(usageFile, { force: true });
    else await writeFile(usageFile, before);
  }
});

test('X OAuth2 bootstrap rotates tokens and persists only encrypted token state', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('X_OAUTH2_STATE_KEY');
  process.env.X_OAUTH2_STATE_KEY = 'x'.repeat(48);
  await rm(X_STATE_FILE, { force: true });
  const credential = {
    oauth2StateId: `bootstrap-${process.pid}`,
    oauth2ClientId: 'client-id',
    oauth2RefreshToken: 'refresh-0',
    consumerKey: 'oauth1-key',
    accessToken: 'oauth1-user-token'
  };
  try {
    let calls = 0;
    globalThis.fetch = async (url, options = {}) => {
      calls += 1;
      assert.equal(String(url), 'https://api.x.com/2/oauth2/token');
      assert.match(String(options.body), /refresh_token=refresh-0/);
      assert.match(String(options.body), /client_id=client-id/);
      return jsonResponse({
        access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 7200,
        scope: 'tweet.write users.read media.write offline.access', token_type: 'bearer'
      });
    };
    const session = await getXOAuth2Session(credential);
    assert.equal(session.accessToken, 'access-1');
    assert.equal(session.refreshToken, 'refresh-1');
    assert.equal(calls, 1);

    const persisted = await readFile(X_STATE_FILE, 'utf8');
    assert.match(persisted, /A256GCM/);
    assert.equal(persisted.includes('access-1'), false);
    assert.equal(persisted.includes('refresh-1'), false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await rm(X_STATE_FILE, { force: true });
  }
});

test('X OAuth2 retries exactly once with a refreshed token after a 401', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('X_OAUTH2_STATE_KEY');
  process.env.X_OAUTH2_STATE_KEY = 'y'.repeat(48);
  await rm(X_STATE_FILE, { force: true });
  const credential = {
    oauth2StateId: `retry-${process.pid}`,
    oauth2ClientId: 'client-id',
    oauth2RefreshToken: 'refresh-0',
    consumerKey: 'oauth1-key',
    accessToken: 'oauth1-user-token'
  };
  try {
    let tokenCalls = 0;
    let targetCalls = 0;
    const targetAuth = [];
    const refreshBodies = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.x.com/2/oauth2/token') {
        tokenCalls += 1;
        refreshBodies.push(String(options.body));
        return jsonResponse(tokenCalls === 1
          ? { access_token: 'access-a', refresh_token: 'refresh-a', expires_in: 7200 }
          : { access_token: 'access-b', refresh_token: 'refresh-b', expires_in: 7200 });
      }
      targetCalls += 1;
      targetAuth.push(options.headers.Authorization);
      if (targetCalls === 1) return jsonResponse({ title: 'Unauthorized' }, 401);
      return jsonResponse({ ok: true });
    };

    assert.deepEqual(await xOAuth2FetchJson('https://api.x.com/2/test', { method: 'GET' }, credential), { ok: true });
    assert.equal(tokenCalls, 2);
    assert.equal(targetCalls, 2);
    assert.deepEqual(targetAuth, ['Bearer access-a', 'Bearer access-b']);
    assert.match(refreshBodies[0], /refresh_token=refresh-0/);
    assert.match(refreshBodies[1], /refresh_token=refresh-a/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await rm(X_STATE_FILE, { force: true });
  }
});

test('X image publishing runs OAuth2 media upload, alt text, and post creation end-to-end with mocked APIs', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('X_OAUTH2_STATE_KEY');
  process.env.X_OAUTH2_STATE_KEY = 'z'.repeat(48);
  await rm(X_STATE_FILE, { force: true });
  const credential = {
    oauth2StateId: `publish-${process.pid}`,
    oauth2ClientId: 'client-id', oauth2RefreshToken: 'refresh-0',
    consumerKey: 'oauth1-key', consumerSecret: 'oauth1-secret',
    accessToken: 'oauth1-user-token', accessTokenSecret: 'oauth1-user-secret'
  };
  const seen = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      seen.push({ target, authorization: options.headers?.Authorization || null, body: options.body });
      if (target === 'https://api.x.com/2/oauth2/token') {
        return jsonResponse({ access_token: 'access-media', refresh_token: 'refresh-media', expires_in: 7200 });
      }
      if (target === 'https://media.example/a.png') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (target === 'https://api.x.com/2/media/upload') return jsonResponse({ data: { id: 'media-1' } });
      if (target === 'https://api.x.com/2/media/metadata') return jsonResponse({ data: { id: 'media-1' } });
      if (target === 'https://api.x.com/2/tweets') return jsonResponse({ data: { id: 'post-1', text: 'hello' } });
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const result = await publishX({
      text: 'hello', mediaUrl: 'https://media.example/a.png', mediaType: 'image', mediaAltText: 'sample image', credential
    });
    assert.equal(result.postId, 'post-1');
    assert.equal(seen.filter((row) => row.target.startsWith('https://api.x.com/2/')).every((row) =>
      row.target.endsWith('/oauth2/token') || row.authorization === 'Bearer access-media'
    ), true);
    assert.equal(seen.some((row) => row.target === 'https://api.x.com/2/media/metadata'), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await rm(X_STATE_FILE, { force: true });
  }
});

test('Instagram publish completes create-status-publish flow with multipart bodies', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      calls.push({ target, options });
      if (target.endsWith('/ig-user/media')) return jsonResponse({ id: 'container-1' });
      if (target.includes('/container-1?fields=status_code,status')) return jsonResponse({ status_code: 'FINISHED' });
      if (target.endsWith('/ig-user/media_publish')) return jsonResponse({ id: 'ig-post-1' });
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    const result = await publishInstagram({
      text: 'caption', mediaUrl: 'https://media.example/a.png', mediaType: 'image',
      credential: { accessToken: 'ig-token', igUserId: 'ig-user' }, apiVersion: 'v25.0'
    });
    assert.equal(result.postId, 'ig-post-1');
    assert.equal(calls.length, 3);
    assert.ok(calls[0].options.body instanceof FormData);
    assert.ok(calls[2].options.body instanceof FormData);
    assert.equal(calls.every((row) => row.options.headers.Authorization === 'Bearer ig-token'), true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub release hosting creates a missing public release and recovers duplicate asset uploads', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME');
  process.env.GH_TOKEN = 'test-gh-token';
  delete process.env.GITHUB_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  process.env.GITHUB_REF_NAME = 'main';
  try {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      calls.push({ target, options });
      if (target === 'https://api.github.com/repos/owner/repo') return jsonResponse({ private: false });
      if (target === 'https://api.github.com/repos/owner/repo/releases/tags/sns-ai-media') return jsonResponse({ message: 'Not Found' }, 404);
      if (target === 'https://api.github.com/repos/owner/repo/releases') return jsonResponse({ id: 7, assets: [] }, 201);
      if (target.startsWith('https://uploads.github.com/repos/owner/repo/releases/7/assets')) return jsonResponse({ message: 'already_exists' }, 422);
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const release = await ensurePublicRelease();
    assert.equal(release.id, 7);
    assert.equal(calls[2].options.method, 'POST');
    const createBody = JSON.parse(calls[2].options.body);
    assert.equal(createBody.tag_name, 'sns-ai-media');

    const cachedRelease = { id: 7, assets: [{ name: 'a.png', browser_download_url: 'https://downloads.example/a.png' }] };
    assert.equal(await uploadReleaseAsset(cachedRelease, 'a.png', Buffer.from('abc'), 'image/png'), 'https://downloads.example/a.png');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});
