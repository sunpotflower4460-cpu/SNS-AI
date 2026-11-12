import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, downloadMedia } from '../src/lib/http.mjs';
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from '../src/lib/json-store.mjs';
import { generatePost, openaiRequest, parseJsonText } from '../src/lib/openai.mjs';
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

test('X image publishing falls back to OAuth1 upload and post creation when the OAuth2 refresh is rejected', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('X_OAUTH2_STATE_KEY');
  process.env.X_OAUTH2_STATE_KEY = 'f'.repeat(48);
  await rm(X_STATE_FILE, { force: true });
  const credential = {
    oauth2StateId: `oauth1-fallback-${process.pid}`,
    oauth2ClientId: 'client-id', oauth2RefreshToken: 'refresh-0',
    consumerKey: 'oauth1-key', consumerSecret: 'oauth1-secret',
    accessToken: 'oauth1-user-token', accessTokenSecret: 'oauth1-user-secret'
  };
  const seen = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      seen.push({ target, authorization: options.headers?.Authorization || null });
      if (target === 'https://api.x.com/2/oauth2/token') {
        // The production failure: X rejects the refresh itself with 401
        // unauthorized_client, before any media request can be attempted.
        return jsonResponse({ error: 'unauthorized_client', error_description: 'Missing valid authorization header' }, 401);
      }
      if (target === 'https://media.example/a.png') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (target === 'https://api.x.com/2/media/upload') return jsonResponse({ data: { id: 'media-fallback' } });
      if (target === 'https://api.x.com/2/tweets') return jsonResponse({ data: { id: 'post-fallback', text: 'hello' } });
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const result = await publishX({ text: 'hello', mediaUrl: 'https://media.example/a.png', mediaType: 'image', credential });
    assert.equal(result.postId, 'post-fallback');
    const upload = seen.find((row) => row.target === 'https://api.x.com/2/media/upload');
    const create = seen.find((row) => row.target === 'https://api.x.com/2/tweets');
    assert.ok(upload.authorization?.startsWith('OAuth '), 'media upload must be retried with OAuth1 signing');
    assert.ok(create.authorization?.startsWith('OAuth '), 'post creation must use OAuth1 when the media was uploaded with OAuth1');
    assert.equal(seen.some((row) => row.authorization?.startsWith('Bearer ')), false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await rm(X_STATE_FILE, { force: true });
  }
});

test('X image publishing falls back to OAuth1 when the OAuth2 upload itself is forbidden', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('X_OAUTH2_STATE_KEY');
  process.env.X_OAUTH2_STATE_KEY = 'g'.repeat(48);
  await rm(X_STATE_FILE, { force: true });
  const credential = {
    oauth2StateId: `oauth1-forbidden-${process.pid}`,
    oauth2ClientId: 'client-id', oauth2RefreshToken: 'refresh-0',
    consumerKey: 'oauth1-key', consumerSecret: 'oauth1-secret',
    accessToken: 'oauth1-user-token', accessTokenSecret: 'oauth1-user-secret'
  };
  const uploads = [];
  const seen = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      const authorization = options.headers?.Authorization || null;
      seen.push({ target, authorization });
      if (target === 'https://api.x.com/2/oauth2/token') {
        return jsonResponse({ access_token: 'access-media', refresh_token: 'refresh-media', expires_in: 7200 });
      }
      if (target === 'https://media.example/a.png') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (target === 'https://api.x.com/2/media/upload') {
        uploads.push(authorization);
        if (authorization?.startsWith('Bearer ')) return jsonResponse({ title: 'Forbidden' }, 403);
        return jsonResponse({ data: { id: 'media-403' } });
      }
      if (target === 'https://api.x.com/2/tweets') return jsonResponse({ data: { id: 'post-403', text: 'hello' } });
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    const result = await publishX({ text: 'hello', mediaUrl: 'https://media.example/a.png', mediaType: 'image', credential });
    assert.equal(result.postId, 'post-403');
    assert.equal(uploads.length, 2);
    assert.ok(uploads[0].startsWith('Bearer '), 'the first upload attempt stays on OAuth2');
    assert.ok(uploads[1].startsWith('OAuth '), 'the retry after a 403 is OAuth1-signed');
    const create = seen.find((row) => row.target === 'https://api.x.com/2/tweets');
    assert.ok(create.authorization?.startsWith('OAuth '), 'post creation follows the OAuth1 upload');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await rm(X_STATE_FILE, { force: true });
  }
});

test('X image publishing does not fall back to OAuth1 on non-auth OAuth2 failures', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('X_OAUTH2_STATE_KEY');
  process.env.X_OAUTH2_STATE_KEY = 'h'.repeat(48);
  await rm(X_STATE_FILE, { force: true });
  const credential = {
    oauth2StateId: `oauth1-no-fallback-${process.pid}`,
    oauth2ClientId: 'client-id', oauth2RefreshToken: 'refresh-0',
    consumerKey: 'oauth1-key', consumerSecret: 'oauth1-secret',
    accessToken: 'oauth1-user-token', accessTokenSecret: 'oauth1-user-secret'
  };
  const uploads = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target === 'https://api.x.com/2/oauth2/token') {
        return jsonResponse({ access_token: 'access-media', refresh_token: 'refresh-media', expires_in: 7200 });
      }
      if (target === 'https://media.example/a.png') {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (target === 'https://api.x.com/2/media/upload') {
        uploads.push(options.headers?.Authorization || null);
        return jsonResponse({ title: 'Internal Server Error' }, 500);
      }
      throw new Error(`Unexpected mocked URL: ${target}`);
    };

    await assert.rejects(
      publishX({ text: 'hello', mediaUrl: 'https://media.example/a.png', mediaType: 'image', credential }),
      /HTTP 500/
    );
    assert.equal(uploads.length, 1, 'a 500 from the upload endpoint must not be retried under a different auth scheme');
    assert.ok(uploads[0].startsWith('Bearer '));
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

// --- JSON hardening for lib/openai.mjs (2026-11-11 dry-run failures) ---------------------------
// Two live Autopilot dry runs died at post-generation because a smaller model returned malformed
// JSON: once free-form prose, once a candidates payload truncated mid-array. The tests below pin
// the three defences: parseJsonText truncation salvage, the responseJson 400-fallback order, and
// generatePost spending its existing attempts budget on parse failures instead of aborting.

function candidateFixture(text) {
  return {
    text, mediaPrompt: '', rationale: 'json hardening coverage', spreadPotential: 55, noveltyPotential: 52,
    features: { topic: 'test', angle: 'angle', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed: false }
  };
}

function generationResponse(text) {
  return { output_text: JSON.stringify({ candidates: [candidateFixture(text)] }) };
}

function generationAccount(overrides = {}) {
  return {
    platform: 'x', enabled: true, mode: 'auto', credentialKey: 'json-hardening-x', displayName: 'JSON Hardening X',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 3, candidateCount: 1, maxOutputTokens: 1000 },
    safety: { moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false },
    research: { webSearch: false, trendIntelligence: false },
    resilience: { enabled: true, failureThreshold: 2, cooldownMinutes: 60 },
    budgets: { enabled: false },
    experiments: { enabled: false }, media: { strategy: 'none', type: 'image' },
    ...overrides
  };
}

test('parseJsonText salvages a candidates payload truncated mid-string and mid-array', () => {
  const full = JSON.stringify({ candidates: [candidateFixture('first post text'), candidateFixture('second post text with a much longer body')] });

  // Cut inside the second candidate's text string: only the first, complete candidate survives.
  const midString = parseJsonText(full.slice(0, full.indexOf('much longer')));
  assert.deepEqual(midString.candidates.map((candidate) => candidate.text), ['first post text']);

  // Cut right after a complete scalar inside the second candidate: its completed pairs survive,
  // the pairs that were never fully written are dropped rather than invented.
  const marker = '"spreadPotential":55,';
  const midArray = parseJsonText(full.slice(0, full.indexOf(marker, full.indexOf('second')) + marker.length));
  assert.equal(midArray.candidates.length, 2);
  assert.equal(midArray.candidates[1].text, 'second post text with a much longer body');
  assert.equal(midArray.candidates[1].spreadPotential, 55);
  assert.equal(midArray.candidates[1].noveltyPotential, undefined);

  // Truncation before ANY value completes is not salvageable and must still fail closed.
  assert.throws(() => parseJsonText('{"candidates": [{"text": "cut off mid-str'), /not valid JSON/);
});

test('parseJsonText returns a top-level JSON array intact instead of corrupting it', () => {
  // The old brace-slice fallback assumed an object top level: for a prose-wrapped array it sliced
  // first '{' to last '}' and produced unparseable text. The array must come back as an array.
  assert.deepEqual(
    parseJsonText('Result: [{"topic":"a","score":1},{"topic":"b","score":2}] done'),
    [{ topic: 'a', score: 1 }, { topic: 'b', score: 2 }]
  );
  assert.deepEqual(parseJsonText('[{"a":1}]'), [{ a: 1 }]);
});

test('a 400 on schema + web_search retries without the tool but keeps the strict schema', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY');
  process.env.OPENAI_API_KEY = 'test-openai-key';
  try {
    const bodies = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target !== 'https://api.openai.com/v1/responses') throw new Error(`Unexpected mocked URL: ${target}`);
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) return jsonResponse({ error: { message: 'json_schema is not supported with web_search' } }, 400);
      return jsonResponse(generationResponse('Recovered post text.'));
    };
    const account = generationAccount({ research: { webSearch: true, trendIntelligence: false } });
    const result = await generatePost('json-hardening-x', account, [], { dryRun: true });
    assert.equal(result.text, 'Recovered post text.');
    assert.equal(bodies.length, 2);
    assert.ok(Array.isArray(bodies[0].tools), 'the first request carries the web_search tool');
    assert.equal(bodies[1].tools, undefined, 'the 400 retry drops web_search');
    assert.equal(bodies[1].text?.format?.type, 'json_schema', 'the 400 retry KEEPS the strict schema instead of going free-form');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('generatePost retries after a malformed-JSON response and succeeds on a later attempt', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY');
  process.env.OPENAI_API_KEY = 'test-openai-key';
  try {
    const bodies = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (target !== 'https://api.openai.com/v1/responses') throw new Error(`Unexpected mocked URL: ${target}`);
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) return jsonResponse({ output_text: 'The model answered in prose instead of JSON {{{' });
      return jsonResponse(generationResponse('Second attempt post.'));
    };
    const result = await generatePost('json-hardening-x', generationAccount(), [], { dryRun: true });
    assert.equal(result.text, 'Second attempt post.');
    assert.equal(result.attempt, 2);
    assert.equal(bodies.length, 2);
    // The retry prompt must name the failure, not just re-roll: retryFeedback is part of the user payload.
    assert.match(bodies[1].input[1].content[0].text, /return compact strict JSON only/);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('generatePost rethrows the parse error when every attempt returns malformed JSON', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY');
  process.env.OPENAI_API_KEY = 'test-openai-key';
  try {
    let calls = 0;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target !== 'https://api.openai.com/v1/responses') throw new Error(`Unexpected mocked URL: ${target}`);
      calls += 1;
      return jsonResponse({ output_text: 'not json at all' });
    };
    await assert.rejects(
      generatePost('json-hardening-x', generationAccount(), [], { dryRun: true }),
      /AI response was not valid JSON/
    );
    assert.equal(calls, 3, 'all maxAttempts are spent on parse retries before giving up');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});
