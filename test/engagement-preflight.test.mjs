import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runLivePreflight } from '../src/ops/live-preflight.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONFIG = `${ROOT}config/accounts.json`;
const POLICY = `${ROOT}config/engagement-policy.json`;
const OAUTH_STATE = `${ROOT}data/x-oauth2-state.json`;

async function readMaybe(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function snapshot(paths) {
  return new Map(await Promise.all(paths.map(async (path) => [path, await readMaybe(path)])));
}

async function restore(saved) {
  for (const [path, content] of saved) {
    if (content == null) await rm(path, { force: true });
    else await writeFile(path, content, 'utf8');
  }
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

async function withPreflightFixture(task, {
  scopes = 'tweet.read tweet.write users.read dm.read dm.write offline.access',
  stateId = 'engagement-preflight-full'
} = {}) {
  const savedFiles = await snapshot([CONFIG, POLICY, OAUTH_STATE]);
  const savedEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    SOCIAL_CREDENTIALS_JSON: process.env.SOCIAL_CREDENTIALS_JSON,
    X_OAUTH2_STATE_KEY: process.env.X_OAUTH2_STATE_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    SNS_REQUIRE_DURABLE_STATE: process.env.SNS_REQUIRE_DURABLE_STATE
  };
  const realFetch = globalThis.fetch;
  try {
    const config = JSON.parse(savedFiles.get(CONFIG));
    const row = config.accounts['music-tools-x'];
    row.enabled = false;
    row.mode = 'approval';
    row.media = { ...(row.media || {}), strategy: 'none' };
    row.research = { ...(row.research || {}), webSearch: true, trendIntelligence: false };
    await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const policy = JSON.parse(savedFiles.get(POLICY));
    policy.enabled = true;
    policy.allowedAccounts = ['music-tools-x'];
    policy.liveAccounts = [];
    policy.autoReply = true;
    policy.autoDmReply = true;
    await writeFile(POLICY, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');

    await rm(OAUTH_STATE, { force: true });
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.X_OAUTH2_STATE_KEY = '0123456789abcdef0123456789abcdef';
    process.env.GITHUB_TOKEN = 'test-github-token';
    delete process.env.GH_TOKEN;
    process.env.GITHUB_REPOSITORY = 'sunpotflower4460-cpu/SNS-AI';
    delete process.env.SNS_REQUIRE_DURABLE_STATE;
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'music-tools-x': {
        consumerKey: 'consumer-key',
        consumerSecret: 'consumer-secret',
        accessToken: 'oauth1-access-token',
        accessTokenSecret: 'oauth1-access-secret',
        oauth2AccessToken: 'oauth2-access-token',
        oauth2RefreshToken: 'oauth2-refresh-token',
        oauth2ExpiresAt: '2099-01-01T00:00:00.000Z',
        oauth2Scope: scopes,
        oauth2ClientId: 'client-id',
        oauth2StateId: stateId
      }
    });

    return await task();
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await restore(savedFiles);
  }
}

function installFetchMock({ tokenScopes }) {
  let postAttempted = false;
  let oauth2Attempted = false;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    if (target === 'https://api.openai.com/v1/moderations') {
      return response({ results: [{ flagged: false, categories: {} }] });
    }
    if (target === 'https://api.openai.com/v1/models/gpt-5') {
      return response({ id: 'gpt-5', owned_by: 'openai' });
    }
    if (target === 'https://api.x.com/2/oauth2/token' && method === 'POST') {
      oauth2Attempted = true;
      return response({
        access_token: 'refreshed-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 7200,
        token_type: 'bearer',
        scope: tokenScopes
      });
    }
    if (target === 'https://api.x.com/2/users/me?user.fields=id,name,username') {
      const authorization = String(options.headers?.Authorization || '');
      assert.match(authorization, /^(OAuth |Bearer )/);
      return response({ data: { id: 'owner-1', username: 'plugin_radar', name: 'Plugin Radar' } });
    }
    if (target === 'https://api.github.com/repos/sunpotflower4460-cpu/SNS-AI') {
      return response({ has_issues: true, private: false });
    }
    if (target === 'https://api.github.com/repos/sunpotflower4460-cpu/SNS-AI/labels/approved') {
      return response({ name: 'approved' });
    }
    if (target === 'https://api.x.com/2/tweets' && method === 'POST') {
      postAttempted = true;
      return response({ data: { id: 'should-not-post' } });
    }
    throw new Error(`Unexpected mocked URL: ${method} ${target}`);
  };
  return { wasPostAttempted: () => postAttempted, wasOauth2Attempted: () => oauth2Attempted };
}

test('publish-only Live Preflight does not require dormant engagement OAuth2', async () => {
  await withPreflightFixture(async () => {
    const scopes = 'tweet.read tweet.write users.read dm.read offline.access';
    const calls = installFetchMock({ tokenScopes: scopes });
    const report = await runLivePreflight({ accountFilter: 'music-tools-x' });

    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.mode, 'publish');
    assert.equal(report.accounts[0].engagement.configured, true);
    assert.equal(report.accounts[0].engagement.checked, false);
    assert.equal(report.accounts[0].engagement.credentialReady, null);
    assert.deepEqual(report.accounts[0].engagement.requiredScopes, []);
    assert.equal(calls.wasOauth2Attempted(), false);
    assert.equal(calls.wasPostAttempted(), false);
  }, {
    scopes: 'tweet.read tweet.write users.read dm.read offline.access',
    stateId: 'publish-preflight-no-engagement-oauth'
  });
});

test('engagement Live Preflight proves X engagement scopes before liveAccounts activation without sending anything', async () => {
  await withPreflightFixture(async () => {
    const scopes = 'tweet.read tweet.write users.read dm.read dm.write offline.access';
    const calls = installFetchMock({ tokenScopes: scopes });
    const report = await runLivePreflight({ accountFilter: 'music-tools-x', includeEngagement: true });

    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.state, 'ready');
    assert.equal(report.mode, 'publish+engagement');
    assert.equal(report.accounts[0].engagement.configured, true);
    assert.equal(report.accounts[0].engagement.checked, true);
    assert.equal(report.accounts[0].engagement.live, false);
    assert.equal(report.accounts[0].engagement.credentialReady, true);
    assert.deepEqual(new Set(report.accounts[0].engagement.requiredScopes), new Set([
      'tweet.read', 'tweet.write', 'users.read', 'dm.read', 'dm.write', 'offline.access'
    ]));
    assert.equal(calls.wasOauth2Attempted(), true);
    assert.equal(calls.wasPostAttempted(), false);
  }, { stateId: 'engagement-preflight-full' });
});

test('engagement Live Preflight blocks activation when X engagement OAuth is missing a required DM scope', async () => {
  await withPreflightFixture(async () => {
    const scopes = 'tweet.read tweet.write users.read dm.read offline.access';
    installFetchMock({ tokenScopes: scopes });
    const report = await runLivePreflight({ accountFilter: 'music-tools-x', includeEngagement: true });

    assert.equal(report.ok, false);
    assert.equal(report.state, 'blocked');
    assert.equal(report.accounts[0].ok, false);
    assert.match(report.accounts[0].error, /dm\.write/i);
  }, {
    scopes: 'tweet.read tweet.write users.read dm.read offline.access',
    stateId: 'engagement-preflight-missing-dm-write'
  });
});
