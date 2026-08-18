import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runEngagement, resolveHumanEngagement } from '../src/engagement/run.mjs';
import { eventKey } from '../src/engagement/store.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONFIG = `${ROOT}config/accounts.json`;
const POLICY = `${ROOT}config/engagement-policy.json`;
const MUTABLE = [
  `${ROOT}data/engagement-state.json`,
  `${ROOT}data/engagement-audit.jsonl`,
  `${ROOT}data/usage.jsonl`,
  `${ROOT}data/usage-state.json`,
  `${ROOT}data/x-oauth2-state.json`,
  `${ROOT}data/history.jsonl`
];

async function readMaybe(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function snapshot(paths) {
  return new Map(await Promise.all(paths.map(async (path) => [path, await readMaybe(path)])));
}

async function restore(snap) {
  for (const [path, content] of snap) {
    if (content == null) await rm(path, { force: true });
    else await writeFile(path, content, 'utf8');
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function openAiDecision(text) {
  if (/ありがとう/.test(text)) {
    return {
      action: 'ignore', confidence: 0.99, category: 'no_response_needed', response: '',
      reason: 'A response is unnecessary.', humanSummary: '', humanQuestion: ''
    };
  }
  return {
    action: 'reply', confidence: 0.97, category: 'routine_question',
    response: 'ありがとうございます。用途に合うか、特徴と向いている人を簡潔に整理します。',
    reason: 'Routine inbound question.', humanSummary: '', humanQuestion: ''
  };
}

function refreshedXSession() {
  return {
    access_token: 'x-access-token-refreshed',
    refresh_token: 'x-refresh-token-rotated',
    expires_in: 7200,
    token_type: 'bearer',
    scope: 'tweet.read tweet.write users.read dm.read dm.write offline.access'
  };
}

async function withFixture(platform, task, { suffix = 'main', webSearch = false, live = true } = {}) {
  const files = [CONFIG, POLICY, ...MUTABLE];
  const snap = await snapshot(files);
  const env = {
    SOCIAL_CREDENTIALS_JSON: process.env.SOCIAL_CREDENTIALS_JSON,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    X_OAUTH2_STATE_KEY: process.env.X_OAUTH2_STATE_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY
  };
  const realFetch = globalThis.fetch;
  const credentialKey = `engagement-e2e-${platform}-${suffix}`;
  try {
    const config = JSON.parse(snap.get(CONFIG));
    const row = config.accounts['music-tools-x'];
    row.enabled = true;
    row.mode = 'auto';
    row.platform = platform;
    row.credentialKey = credentialKey;
    row.research = { ...(row.research || {}), webSearch, trendIntelligence: false };
    row.budgets = { ...(row.budgets || {}), enabled: false };
    row.safety = { ...(row.safety || {}), moderation: true };
    await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const policy = JSON.parse(snap.get(POLICY));
    policy.allowedAccounts = ['music-tools-x'];
    policy.liveAccounts = live ? ['music-tools-x'] : [];
    await writeFile(POLICY, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');

    for (const path of MUTABLE) await rm(path, { force: true });

    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.X_OAUTH2_STATE_KEY = '0123456789abcdef0123456789abcdef';
    process.env.GITHUB_TOKEN = 'test-github-token';
    delete process.env.GH_TOKEN;
    process.env.GITHUB_REPOSITORY = 'sunpotflower4460-cpu/SNS-AI';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify(platform === 'x' ? {
      [credentialKey]: {
        oauth2AccessToken: 'x-access-token',
        oauth2RefreshToken: 'x-refresh-token',
        oauth2ExpiresAt: '2099-01-01T00:00:00.000Z',
        oauth2Scope: 'tweet.read tweet.write users.read dm.read dm.write offline.access',
        oauth2ClientId: 'client-id'
      }
    } : {
      [credentialKey]: { accessToken: 'ig-access-token', igUserId: '1000', apiVersion: 'v25.0' }
    });

    return await task();
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(env)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await restore(snap);
  }
}

test('live engagement stays dormant before explicit activation while dry-run remains available', async () => {
  await withFixture('x', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('live network work must not start before activation'); };

    const liveResult = await runEngagement({ accountFilter: 'music-tools-x' });
    assert.equal(liveResult.state, 'nothing_enabled');
    assert.equal(calls, 0);
  }, { suffix: 'not-live', live: false });
});

test('X engagement runtime auto-replies routine inbound, persists opt-out, escalates exceptions, and supports public human resolution', async () => {
  await withFixture('x', async () => {
    const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const issueBodies = [];
    const sentPosts = [];
    const sentDms = [];
    let issueNumber = 100;

    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      const method = String(options.method || 'GET').toUpperCase();
      if (href === 'https://api.x.com/2/oauth2/token' && method === 'POST') return json(refreshedXSession());
      if (href.startsWith('https://api.x.com/2/users/me')) return json({ data: { id: '1', username: 'owner' } });
      if (href.startsWith('https://api.x.com/2/users/1/mentions')) {
        return json({
          data: [
            { id: '10', author_id: '2', text: 'このプラグインは初心者にも向いていますか？', created_at: old },
            { id: '11', author_id: '3', text: 'ありがとう！', created_at: old },
            { id: '12', author_id: '4', text: '返金トラブルについて正式に対応してください', created_at: old },
            { id: '13', author_id: '7', text: '今後、自動返信は不要です', created_at: old },
            { id: '14', author_id: '7', text: 'その後の別の質問です', created_at: old }
          ],
          includes: { users: [
            { id: '2', username: 'listener' }, { id: '3', username: 'thanks' }, { id: '4', username: 'dispute' }, { id: '7', username: 'optout' }
          ] }
        });
      }
      if (href.startsWith('https://api.x.com/2/dm_events')) {
        return json({ data: [
          { id: '20', event_type: 'MessageCreate', sender_id: '5', text: 'このEQの特徴を簡単に教えて', created_at: old },
          { id: '21', event_type: 'MessageCreate', sender_id: '6', text: 'パスワードと個人情報の件で確認があります', created_at: old }
        ] });
      }
      if (href === 'https://api.openai.com/v1/responses') {
        const request = JSON.parse(String(options.body || '{}'));
        const inbound = JSON.parse(request.input[1].content[0].text).interaction.text;
        return json({ output_text: JSON.stringify(openAiDecision(inbound)) });
      }
      if (href === 'https://api.openai.com/v1/moderations') return json({ results: [{ flagged: false, categories: {} }] });
      if (href === 'https://api.x.com/2/tweets' && method === 'POST') {
        sentPosts.push(JSON.parse(options.body));
        return json({ data: { id: `reply-${sentPosts.length}` } });
      }
      if (/https:\/\/api\.x\.com\/2\/dm_conversations\/with\/5\/messages/.test(href) && method === 'POST') {
        sentDms.push(JSON.parse(options.body));
        return json({ data: { dm_event_id: `dm-${sentDms.length}` } });
      }
      if (/api\.github\.com/.test(href)) {
        if (/\/labels\/needs-human$/.test(href) && method === 'GET') return json({ name: 'needs-human' });
        if (/\/issues\?state=open/.test(href) && method === 'GET') return json([]);
        if (/\/issues$/.test(href) && method === 'POST') {
          const request = JSON.parse(options.body);
          issueBodies.push(JSON.parse(request.body));
          return json({ number: issueNumber++, title: request.title });
        }
        if (/\/issues\/\d+\/comments$/.test(href) && method === 'POST') return json({ id: 1 });
        if (/\/issues\/\d+$/.test(href) && method === 'PATCH') return json({ state: 'closed' });
      }
      throw new Error(`Unexpected request: ${method} ${href}`);
    };

    const result = await runEngagement({ accountFilter: 'music-tools-x' });
    assert.equal(result.state, 'ok');
    assert.equal(result.accounts[0]?.state, 'ok', JSON.stringify(result.accounts[0]));
    const rows = result.accounts[0].events;
    assert.equal(rows.filter((row) => row.status === 'sent').length, 2);
    assert.equal(rows.filter((row) => row.status === 'ignored').length, 1);
    assert.equal(rows.filter((row) => row.status === 'human').length, 2);
    assert.equal(rows.filter((row) => row.status === 'opted_out').length, 2);
    assert.equal(sentPosts.length, 1);
    assert.equal(sentDms.length, 1);
    assert.equal(issueBodies.length, 2);
    const privateIssue = issueBodies.find((body) => body.privateContentOmitted === true);
    assert.ok(privateIssue);
    assert.equal(privateIssue.publicExcerpt, null);
    assert.equal(JSON.stringify(privateIssue).includes('パスワード'), false);
    assert.equal(JSON.stringify(privateIssue).includes('個人情報'), false);

    const stateText = await readFile(`${ROOT}data/engagement-state.json`, 'utf8');
    assert.equal(stateText.includes('自動返信は不要'), false);
    assert.equal(stateText.includes('その後の別の質問'), false);
    assert.equal(stateText.includes('authorId'), false);
    assert.equal(stateText.includes('participantId'), false);

    const publicKey = eventKey('music-tools-x', { platform: 'x', kind: 'reply', id: '12' });
    const resolved = await resolveHumanEngagement({
      accountId: 'music-tools-x', key: publicKey, action: 'reply', text: '内容を確認します。個別の返金判断はここでは確約せず、必要事項を整理して対応します。'
    });
    assert.equal(resolved.status, 'sent');
    assert.equal(sentPosts.length, 2);

    const privateKey = eventKey('music-tools-x', { platform: 'x', kind: 'dm', id: '21' });
    await assert.rejects(() => resolveHumanEngagement({ accountId: 'music-tools-x', key: privateKey, action: 'reply', text: 'test' }), { code: 'PRIVATE_ENGAGEMENT_MANUAL_SEND' });

    const second = await runEngagement({ accountFilter: 'music-tools-x' });
    assert.equal(second.accounts[0]?.state, 'ok', JSON.stringify(second.accounts[0]));
    assert.equal(second.accounts[0].events.every((row) => row.skipped === true), true);
  });
});

test('private X dry-run never exposes inbound DM or generated response text and never invokes web search', async () => {
  await withFixture('x', async () => {
    const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    let sawPrivateRequest = false;
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      const method = String(options.method || 'GET').toUpperCase();
      if (href === 'https://api.x.com/2/oauth2/token' && method === 'POST') return json(refreshedXSession());
      if (href.startsWith('https://api.x.com/2/users/me')) return json({ data: { id: '1', username: 'owner' } });
      if (href.startsWith('https://api.x.com/2/users/1/mentions')) return json({ data: [] });
      if (href.startsWith('https://api.x.com/2/dm_events')) {
        return json({ data: [{ id: '30', event_type: 'MessageCreate', sender_id: '55', text: '秘密のプロジェクトAについて質問があります', created_at: old }] });
      }
      if (href === 'https://api.openai.com/v1/responses') {
        const request = JSON.parse(String(options.body || '{}'));
        const inbound = JSON.parse(request.input[1].content[0].text).interaction;
        assert.equal(inbound.public, false);
        assert.equal(request.tools, undefined);
        sawPrivateRequest = true;
        return json({ output_text: JSON.stringify({
          action: 'reply', confidence: 0.97, category: 'routine_question',
          response: '秘密のプロジェクトAへの特別回答です', reason: 'Contains private details', humanSummary: '', humanQuestion: ''
        }) });
      }
      if (href === 'https://api.openai.com/v1/moderations') return json({ results: [{ flagged: false, categories: {} }] });
      throw new Error(`Unexpected request: ${method} ${href}`);
    };

    const result = await runEngagement({ accountFilter: 'music-tools-x', dryRun: true });
    assert.equal(result.state, 'ok');
    assert.equal(sawPrivateRequest, true);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('秘密のプロジェクトA'), false);
    assert.equal(serialized.includes('特別回答'), false);
    assert.equal(serialized.includes('55'), false);
    assert.equal(result.accounts[0].events[0].decision.privateContentOmitted, true);
  }, { suffix: 'private-dry', webSearch: true, live: false });
});

test('X engagement reports credential readiness instead of silently going green when required scopes are missing', async () => {
  await withFixture('x', async () => {
    const credentials = JSON.parse(process.env.SOCIAL_CREDENTIALS_JSON);
    const key = Object.keys(credentials)[0];
    credentials[key].oauth2RefreshToken = undefined;
    credentials[key].oauth2Scope = 'tweet.read users.read';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify(credentials);

    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      const method = String(options.method || 'GET').toUpperCase();
      if (href.startsWith('https://api.x.com/2/users/me') && method === 'GET') return json({ data: { id: '1', username: 'owner' } });
      throw new Error(`Unexpected request: ${method} ${href}`);
    };

    const result = await runEngagement({ accountFilter: 'music-tools-x' });
    assert.equal(result.state, 'degraded');
    assert.equal(result.accounts[0].state, 'waiting_for_engagement_credentials');
  }, { suffix: 'missing-scope' });
});

test('Instagram engagement runtime polls recent comments and conversations and replies through official interaction routes', async () => {
  await withFixture('instagram', async () => {
    const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    await writeFile(`${ROOT}data/history.jsonl`, `${JSON.stringify({ account: 'music-tools-x', status: 'published', providerPostId: '777', at: old, text: 'post' })}\n`, 'utf8');
    const commentReplies = [];
    const dmReplies = [];

    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(String(url));
      const href = parsed.toString();
      const method = String(options.method || 'GET').toUpperCase();
      if (parsed.origin === 'https://graph.instagram.com' && parsed.pathname === '/v25.0/777/comments' && method === 'GET') {
        return json({ data: [
          { id: '7001', from: { id: '2000', username: 'listener' }, text: '初心者にも向いていますか？', timestamp: old },
          { id: '7002', from: { id: '1000', username: 'owner' }, text: '自分自身の返信', timestamp: old }
        ] });
      }
      if (parsed.origin === 'https://graph.instagram.com' && parsed.pathname === '/v25.0/1000/conversations' && method === 'GET') {
        return json({ data: [{ id: '8001', updated_time: old }] });
      }
      if (parsed.origin === 'https://graph.instagram.com' && parsed.pathname === '/v25.0/8001' && method === 'GET') {
        return json({ messages: { data: [{ id: '9001', created_time: old, from: { id: '3000' }, to: { data: [{ id: '1000' }] }, message: 'このツールの特徴を知りたいです' }] } });
      }
      if (parsed.origin === 'https://graph.instagram.com' && parsed.pathname === '/v25.0/7001/replies' && method === 'POST') {
        commentReplies.push(JSON.parse(options.body));
        return json({ id: '7100' });
      }
      if (parsed.origin === 'https://graph.instagram.com' && parsed.pathname === '/v25.0/1000/messages' && method === 'POST') {
        dmReplies.push(JSON.parse(options.body));
        return json({ message_id: '9100' });
      }
      if (href === 'https://api.openai.com/v1/responses') {
        const request = JSON.parse(String(options.body || '{}'));
        const inbound = JSON.parse(request.input[1].content[0].text).interaction.text;
        return json({ output_text: JSON.stringify(openAiDecision(inbound)) });
      }
      if (href === 'https://api.openai.com/v1/moderations') return json({ results: [{ flagged: false, categories: {} }] });
      throw new Error(`Unexpected request: ${method} ${href}`);
    };

    const result = await runEngagement({ accountFilter: 'music-tools-x' });
    assert.equal(result.state, 'ok');
    assert.equal(result.accounts[0]?.state, 'ok', JSON.stringify(result.accounts[0]));
    assert.equal(result.accounts[0].warnings.length, 0);
    assert.equal(result.accounts[0].events.filter((row) => row.status === 'sent').length, 2);
    assert.equal(result.accounts[0].events.length, 2);
    assert.equal(commentReplies.length, 1);
    assert.equal(dmReplies.length, 1);
    assert.equal(commentReplies[0].message.length > 0, true);
    assert.equal(dmReplies[0].recipient.id, '3000');
  });
});
