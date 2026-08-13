import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAutopilot } from '../src/orchestrate.mjs';
import { collectMetrics } from '../src/analytics/collector.mjs';
import { readMetricSnapshots } from '../src/analytics/store.mjs';
import { runLivePreflight } from '../src/ops/live-preflight.mjs';
import { getSlot } from '../src/lib/state.mjs';

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const MUTABLE_FILES = [
  '../data/audit.jsonl',
  '../data/history.jsonl',
  '../data/metrics.jsonl',
  '../data/usage.jsonl',
  '../data/usage-state.json',
  '../data/runtime-health.json',
  '../data/brakes.json',
  '../data/state.json',
  '../data/x-oauth2-state.json'
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

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

async function snapshot(path) {
  try { return { exists: true, bytes: await readFile(path) }; }
  catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: null };
    throw error;
  }
}

async function restore(path, saved) {
  if (!saved.exists) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, saved.bytes);
}

async function withRepositoryState(fn) {
  const tracked = [CONFIG_FILE, ...MUTABLE_FILES];
  const savedFiles = new Map();
  for (const path of tracked) savedFiles.set(path, await snapshot(path));
  try {
    for (const path of MUTABLE_FILES) await rm(path, { force: true });
    return await fn();
  } finally {
    for (const path of tracked.reverse()) await restore(path, savedFiles.get(path));
  }
}

function generatedCandidate({ text, mediaDecision = 'none' }) {
  return {
    output_text: JSON.stringify({
      candidates: [{
        text,
        mediaPrompt: '',
        rationale: 'Runtime integration coverage.',
        spreadPotential: 60,
        noveltyPotential: 55,
        features: {
          topic: 'testing', angle: 'runtime', hook: 'specific', emotion: 'neutral',
          format: 'short', cta: 'none', mediaDecision, trendUsed: false
        }
      }]
    })
  };
}

test('Instagram top-level autopilot publishes media and collects insights with mocked APIs', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'OPENAI_MODEL', 'SOCIAL_CREDENTIALS_JSON');
  try {
    await withRepositoryState(async () => {
      const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
      config.accounts['example-x'].enabled = false;
      config.accounts['example-x'].mode = 'pause';
      config.accounts['example-instagram'] = {
        ...config.accounts['example-instagram'],
        enabled: true,
        mode: 'auto',
        generation: {
          ...(config.accounts['example-instagram'].generation || {}),
          model: 'gpt-5', candidateCount: 1, maxAttempts: 1, maxOutputTokens: 1200
        },
        learning: { enabled: false, exploreRate: 0 },
        experiments: { enabled: false },
        research: { webSearch: false, trendIntelligence: false },
        analytics: { enabled: true, checkpointsMinutes: [1], maxAgeDays: 14 },
        safety: {
          moderation: false,
          maxPostsPerDay: 6,
          minMinutesBetweenPosts: 0,
          anomalyBrake: { enabled: false }
        },
        media: {
          strategy: 'fixed',
          type: 'image',
          url: 'https://media.example/approved-image.png'
        }
      };
      await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

      process.env.OPENAI_API_KEY = 'test-openai-key';
      process.env.OPENAI_MODEL = 'gpt-5';
      process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
        'example-instagram': {
          accessToken: 'ig-token', igUserId: 'ig-user', containerPollSeconds: 1
        }
      });

      const insightCalls = [];
      globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target === 'https://api.openai.com/v1/responses') {
          return jsonResponse(generatedCandidate({ text: 'Instagram runtime integration post.', mediaDecision: 'library' }));
        }
        if (target === 'https://graph.instagram.com/v25.0/ig-user/media') {
          return jsonResponse({ id: 'container-1' });
        }
        if (target === 'https://graph.instagram.com/v25.0/container-1?fields=status_code,status') {
          return jsonResponse({ status_code: 'FINISHED', status: 'Finished' });
        }
        if (target === 'https://graph.instagram.com/v25.0/ig-user/media_publish') {
          return jsonResponse({ id: 'ig-post-1' });
        }
        if (target.startsWith('https://graph.instagram.com/v25.0/ig-post-1/insights?')) {
          const parsed = new URL(target);
          const metric = parsed.searchParams.get('metric');
          insightCalls.push(metric);
          if (metric === 'profile_visits') return jsonResponse({ error: { message: 'not available' } }, 400);
          const values = {
            views: 1400, reach: 1100, likes: 80, comments: 12, shares: 9,
            saved: 14, total_interactions: 115, follows: 5
          };
          return jsonResponse({ data: [{ name: metric, values: [{ value: values[metric] ?? 0 }] }] });
        }
        throw new Error(`Unexpected mocked URL: ${target} (${options.method || 'GET'})`);
      };

      const published = await runAutopilot({
        accountFilter: 'example-instagram', force: true, dryRun: false,
        now: new Date('2026-08-13T00:00:00.000Z')
      });
      assert.equal(published.length, 1);
      assert.equal(published[0].status, 'published');
      assert.equal(published[0].result.postId, 'ig-post-1');

      const report = await collectMetrics({
        accountFilter: 'example-instagram', now: new Date(Date.now() + 2 * 60_000)
      });
      const collected = report.find((row) => row.status === 'collected');
      assert.equal(collected?.providerPostId, 'ig-post-1');
      assert.equal(collected?.checkpointMinutes, 1);

      const rows = await readMetricSnapshots();
      const metric = rows.find((row) => row.providerPostId === 'ig-post-1');
      assert.equal(metric?.metrics?.views, 1400);
      assert.equal(metric?.metrics?.reach, 1100);
      assert.equal(metric?.metrics?.likes, 80);
      assert.equal(metric?.metrics?.profileVisits, 0);
      assert.equal(metric?.unavailable?.includes('profile_visits'), true);
      assert.equal(insightCalls.length, 9);
    });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});

test('approval mode creates an approval issue and X media preflight validates OAuth2 identity and scopes', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv(
    'OPENAI_API_KEY', 'OPENAI_MODEL', 'SOCIAL_CREDENTIALS_JSON',
    'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY', 'X_OAUTH2_STATE_KEY'
  );
  try {
    await withRepositoryState(async () => {
      const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
      config.accounts['example-instagram'].enabled = false;
      config.accounts['example-instagram'].mode = 'pause';
      config.accounts['example-x'] = {
        ...config.accounts['example-x'],
        enabled: true,
        mode: 'approval',
        generation: {
          ...(config.accounts['example-x'].generation || {}),
          model: 'gpt-5', candidateCount: 1, maxAttempts: 1, maxOutputTokens: 1200
        },
        learning: { enabled: false, exploreRate: 0 },
        experiments: { enabled: false },
        research: { webSearch: false, trendIntelligence: false },
        safety: {
          moderation: false,
          maxPostsPerDay: 6,
          minMinutesBetweenPosts: 0,
          anomalyBrake: { enabled: false }
        },
        media: { strategy: 'none' }
      };
      await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

      process.env.OPENAI_API_KEY = 'test-openai-key';
      process.env.OPENAI_MODEL = 'gpt-5';
      process.env.GITHUB_TOKEN = 'test-gh-token';
      delete process.env.GH_TOKEN;
      process.env.GITHUB_REPOSITORY = 'owner/repo';
      process.env.X_OAUTH2_STATE_KEY = 's'.repeat(48);

      const baseCredential = {
        consumerKey: 'consumer-key', consumerSecret: 'consumer-secret',
        accessToken: 'access-token', accessTokenSecret: 'access-token-secret',
        oauth2StateId: 'preflight-good', oauth2ClientId: 'client-id',
        oauth2RefreshToken: 'refresh-token'
      };
      process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'example-x': baseCredential });

      const githubCalls = [];
      let oauthScope = 'tweet.write users.read media.write offline.access';
      globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target === 'https://api.openai.com/v1/responses') {
          return jsonResponse(generatedCandidate({ text: 'Approval-mode integration post.' }));
        }
        if (target === 'https://api.openai.com/v1/moderations') {
          return jsonResponse({ results: [{ flagged: false, categories: {} }] });
        }
        if (target === 'https://api.openai.com/v1/models/gpt-5') {
          return jsonResponse({ id: 'gpt-5', owned_by: 'openai' });
        }
        if (target.startsWith('https://api.github.com/repos/owner/repo/issues?state=open') && !options.method) {
          githubCalls.push('issue-lookup');
          return jsonResponse([]);
        }
        if (target === 'https://api.github.com/repos/owner/repo/labels/approved') {
          githubCalls.push('label-get');
          return jsonResponse({ message: 'Not Found' }, 404);
        }
        if (target === 'https://api.github.com/repos/owner/repo/labels') {
          githubCalls.push('label-create');
          return jsonResponse({ name: 'approved' }, 201);
        }
        if (target === 'https://api.github.com/repos/owner/repo/issues') {
          githubCalls.push('issue-create');
          return jsonResponse({ number: 77 }, 201);
        }
        if (target === 'https://api.x.com/2/oauth2/token') {
          return jsonResponse({
            access_token: `oauth-access-${oauthScope.includes('media.write') ? 'good' : 'bad'}`,
            refresh_token: 'rotated-refresh', expires_in: 7200,
            scope: oauthScope, token_type: 'bearer'
          });
        }
        if (target === 'https://api.x.com/2/users/me?user.fields=id,name,username') {
          return jsonResponse({ data: { id: 'user-1', username: 'example', name: 'Example' } });
        }
        throw new Error(`Unexpected mocked URL: ${target} (${options.method || 'GET'})`);
      };

      const approval = await runAutopilot({
        accountFilter: 'example-x', force: true, dryRun: false,
        now: new Date('2026-08-13T00:00:00.000Z')
      });
      assert.equal(approval.length, 1);
      assert.equal(approval[0].status, 'approval-pending');
      assert.equal(approval[0].issue, 77);
      assert.deepEqual(githubCalls, ['issue-lookup', 'issue-lookup', 'label-get', 'label-create', 'issue-create']);
      const slot = await getSlot('example-x:manual:2026-08-13T00:00');
      assert.equal(slot?.status, 'approval_pending');

      config.accounts['example-x'].media = {
        strategy: 'fixed', type: 'image', url: 'https://media.example/image.png'
      };
      await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      const preflight = await runLivePreflight({ accountFilter: 'example-x' });
      assert.equal(preflight.ok, true);
      assert.equal(preflight.accounts[0].identity.id, 'user-1');
      assert.equal(preflight.accounts[0].xOAuth2Identity.id, 'user-1');
      assert.match(preflight.accounts[0].xOAuth2Identity.session.scope, /media\.write/);

      oauthScope = 'tweet.write users.read offline.access';
      const badCredential = {
        ...baseCredential,
        oauth2StateId: 'preflight-missing-scope',
        oauth2RefreshToken: 'refresh-token-2'
      };
      process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ 'example-x': badCredential });
      const blocked = await runLivePreflight({ accountFilter: 'example-x' });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.state, 'blocked');
      assert.match(blocked.accounts[0].error || '', /missing required scope.*media\.write/i);
    });
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
  }
});
