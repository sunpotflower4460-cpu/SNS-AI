import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReadinessReport, writeReadinessReport } from '../src/ops/doctor.mjs';
import { runMaintenance } from '../src/ops/maintenance.mjs';
import { generateReport } from '../src/reports/generate.mjs';
import { generateWeeklyReport } from '../src/reports/weekly.mjs';
import { recordFeedback } from '../src/feedback/record.mjs';
import { recentHumanFeedback } from '../src/feedback/store.mjs';

const CONFIG = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const FILES = [
  '../data/history.jsonl', '../data/metrics.jsonl', '../data/usage.jsonl', '../data/audit.jsonl',
  '../data/human-feedback.jsonl', '../data/runtime-health.json', '../data/brakes.json',
  '../data/archive/monthly-summary.json', '../data/quarantine/invalid-jsonl.jsonl',
  '../data/reports/readiness.json', '../data/reports/readiness.md',
  '../data/reports/latest.json', '../data/reports/latest.md',
  '../data/reports/weekly/latest.json', '../data/reports/weekly/latest.md',
  '../data/trends/example-x.json', '../data/learning/example-x.json', '../data/experiments/example-x.json',
  '../data/policies/x.json', '../data/policies/instagram.json'
].map((p) => fileURLToPath(new URL(p, import.meta.url)));

function saveEnv(...names) { return Object.fromEntries(names.map((n) => [n, process.env[n]])); }
function restoreEnv(saved) { for (const [n, v] of Object.entries(saved)) v === undefined ? delete process.env[n] : process.env[n] = v; }
async function snap(path) { try { return { exists: true, bytes: await readFile(path) }; } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; } }
async function restore(path, saved) { if (!saved.exists) return rm(path, { force: true }); await mkdir(dirname(path), { recursive: true }); await writeFile(path, saved.bytes); }
async function isolated(fn) {
  const tracked = [CONFIG, ...FILES]; const saved = new Map();
  for (const path of tracked) saved.set(path, await snap(path));
  try { for (const path of FILES) await rm(path, { force: true }); return await fn(); }
  finally { for (const path of tracked.reverse()) await restore(path, saved.get(path)); }
}
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function writeJsonl(path, rows) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n')}\n`, 'utf8'); }

const pathOf = (rel) => fileURLToPath(new URL(rel, import.meta.url));

test('readiness doctor blocks missing secrets, becomes ready with complete credentials, and writes stable secret-free reports', async () => {
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON', 'X_OAUTH2_STATE_KEY', 'MEDIA_SERVICE_TOKEN');
  try {
    await isolated(async () => {
      const config = JSON.parse(await readFile(CONFIG, 'utf8'));
      config.accounts['example-x'] = {
        ...config.accounts['example-x'], enabled: true, mode: 'auto',
        media: { strategy: 'fixed', type: 'image', url: 'https://media.example/x.png' }
      };
      config.accounts['example-instagram'].enabled = false;
      config.accounts['example-instagram'].mode = 'pause';
      await writeJson(CONFIG, config);

      delete process.env.OPENAI_API_KEY; delete process.env.SOCIAL_CREDENTIALS_JSON; delete process.env.X_OAUTH2_STATE_KEY;
      const blocked = await buildReadinessReport({ accountFilter: 'example-x' });
      assert.equal(blocked.ready, false);
      assert.equal(blocked.state, 'blocked');
      assert.equal(blocked.accounts[0].blockers.some((x) => x.includes('OPENAI_API_KEY')), true);
      assert.equal(blocked.accounts[0].blockers.some((x) => x.includes('SOCIAL_CREDENTIALS_JSON')), true);
      assert.equal(blocked.accounts[0].blockers.some((x) => x.includes('X_OAUTH2_STATE_KEY')), true);

      process.env.OPENAI_API_KEY = 'super-secret-openai-value';
      process.env.X_OAUTH2_STATE_KEY = 'k'.repeat(48);
      process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
        'example-x': {
          consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessTokenSecret: 'as',
          oauth2ClientId: 'client', oauth2RefreshToken: 'refresh',
          expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString()
        }
      });
      const ready = await buildReadinessReport({ accountFilter: 'example-x' });
      assert.equal(ready.ready, true);
      assert.equal(ready.state, 'ready');
      assert.equal(ready.accounts[0].warnings.some((x) => x.includes('expires in about')), true);
      assert.equal(await writeReadinessReport(await buildReadinessReport()), true);
      assert.equal(await writeReadinessReport(await buildReadinessReport()), false);
      const reportText = `${await readFile(pathOf('../data/reports/readiness.json'), 'utf8')}\n${await readFile(pathOf('../data/reports/readiness.md'), 'utf8')}`;
      assert.equal(reportText.includes('super-secret-openai-value'), false);
      await assert.rejects(buildReadinessReport({ accountFilter: 'missing-account' }), /Unknown account/);
    });
  } finally { restoreEnv(env); }
});

test('maintenance compacts duplicates, archives expired rows, and quarantines malformed JSONL', async () => {
  const env = saveEnv('GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY');
  delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN; delete process.env.GITHUB_REPOSITORY;
  try {
    await isolated(async () => {
      const history = pathOf('../data/history.jsonl');
      const old = { at: '2020-01-01T00:00:00.000Z', account: 'example-x', status: 'published', providerPostId: 'old-1' };
      const recent = { at: new Date().toISOString(), account: 'example-x', status: 'published', providerPostId: 'new-1' };
      await writeJsonl(history, [old, old, '{broken-json', recent]);
      await writeJsonl(pathOf('../data/metrics.jsonl'), [{ collectedAt: new Date().toISOString(), account: 'example-x', providerPostId: 'new-1' }]);
      await writeJsonl(pathOf('../data/usage.jsonl'), [{ at: new Date().toISOString(), account: 'example-x', kind: 'openai' }]);
      await writeJsonl(pathOf('../data/audit.jsonl'), [{ at: new Date().toISOString(), account: 'example-x', stage: 'test' }]);

      const result = await runMaintenance();
      const row = result.results.find((x) => x.type === 'history');
      assert.equal(row.before, 4);
      assert.equal(row.after, 1);
      assert.equal(row.removed, 1);
      assert.equal(row.invalid, 1);
      assert.equal(row.duplicates, 1);
      assert.equal(result.quarantined, 1);
      assert.equal(result.generatedMedia.skipped, true);

      const quarantine = await readFile(pathOf('../data/quarantine/invalid-jsonl.jsonl'), 'utf8');
      assert.match(quarantine, /broken-json/);
      const archive = JSON.parse(await readFile(pathOf('../data/archive/monthly-summary.json'), 'utf8'));
      assert.equal(Object.values(archive.buckets).some((x) => x.type === 'history' && x.count === 1), true);
    });
  } finally { restoreEnv(env); }
});

test('stale approval maintenance closes only expired approval issues', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY');
  process.env.GH_TOKEN = 'gh-test-token'; delete process.env.GITHUB_TOKEN; process.env.GITHUB_REPOSITORY = 'owner/repo';
  try {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url); calls.push({ target, method: options.method || 'GET' });
      if (target.includes('/issues?state=open')) return new Response(JSON.stringify([
        { number: 5, title: '[approval] example-x old', created_at: '2020-01-01T00:00:00.000Z' },
        { number: 6, title: '[approval] example-x fresh', created_at: new Date().toISOString() },
        { number: 7, title: '[approval] pr-shaped', created_at: '2020-01-01T00:00:00.000Z', pull_request: {} },
        { number: 8, title: 'ordinary issue', created_at: '2020-01-01T00:00:00.000Z' }
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
      if (target.endsWith('/issues/5/comments')) return new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { 'content-type': 'application/json' } });
      if (target.endsWith('/issues/5')) return new Response(JSON.stringify({ number: 5, state: 'closed' }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`Unexpected mocked URL: ${target}`);
    };
    const { expireStaleApprovals } = await import(`../src/ops/stale-approvals.mjs?active=${Date.now()}`);
    const result = await expireStaleApprovals({ maxAgeDays: 7 });
    assert.deepEqual(result.closed, [5]);
    assert.equal(calls.some((x) => x.target.endsWith('/issues/5/comments') && x.method === 'POST'), true);
    assert.equal(calls.some((x) => x.target.endsWith('/issues/5') && x.method === 'PATCH'), true);
  } finally { globalThis.fetch = previousFetch; restoreEnv(env); }
});

test('human feedback and current/weekly reports consume synthetic operational history without leaking state', async () => {
  await isolated(async () => {
    await assert.rejects(recordFeedback({ account: 'missing', action: 'note', note: 'x' }), /Unknown account/);
    const feedback = await recordFeedback({ account: 'example-x', action: 'prefer', note: 'Prefer concrete examples.', dimension: 'hook', value: 'specific', source: 'test' });
    assert.equal(feedback.action, 'prefer');
    assert.equal((await recentHumanFeedback('example-x', 10))[0].note, 'Prefer concrete examples.');

    const now = new Date();
    const currentAt = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const previousAt = new Date(now.getTime() - 9 * 86_400_000).toISOString();
    await writeJsonl(pathOf('../data/history.jsonl'), [
      { at: previousAt, account: 'example-x', platform: 'x', status: 'published', providerPostId: 'p-old', text: 'previous post', features: { hook: 'question' } },
      { at: currentAt, account: 'example-x', platform: 'x', status: 'published', providerPostId: 'p-new', text: 'current post', features: { hook: 'specific' }, mediaQa: { pass: true, score: 91, issues: [] } }
    ]);
    await writeJsonl(pathOf('../data/metrics.jsonl'), [
      { collectedAt: previousAt, account: 'example-x', platform: 'x', providerPostId: 'p-old', checkpointMinutes: 1440, metrics: { impressions: 800, reposts: 5, bookmarks: 3, replies: 2, profileClicks: 4, urlClicks: 3 } },
      { collectedAt: currentAt, account: 'example-x', platform: 'x', providerPostId: 'p-new', checkpointMinutes: 1440, metrics: { impressions: 1800, reposts: 20, bookmarks: 14, replies: 7, profileClicks: 18, urlClicks: 16 } }
    ]);
    await writeJsonl(pathOf('../data/audit.jsonl'), [{ at: currentAt, account: 'example-x', stage: 'autopilot-error', error: 'synthetic error' }]);
    await writeJson(pathOf('../data/learning/example-x.json'), { generatedAt: currentAt, sampleSize: 12, confidence: 0.8, preferred: [{ dimension: 'hook', value: 'specific', lift: 8 }], avoid: [] });
    await writeJson(pathOf('../data/trends/example-x.json'), { generatedAt: currentAt, summary: 'trend summary', items: [{ topic: 'AI tools', opportunityScore: 78 }], sources: [{ url: 'https://example.test/source' }] });
    await writeJson(pathOf('../data/experiments/example-x.json'), { active: { dimension: 'hook', variants: ['specific', 'question'] }, completed: [{ completedAt: currentAt, dimension: 'cta' }] });
    await writeJson(pathOf('../data/policies/x.json'), { checkedAt: currentAt, requiresHumanReview: true, changedFromPrevious: true, sources: [{ url: 'https://docs.x.com/' }] });

    const current = await generateReport();
    assert.equal(current.accounts['example-x'].postCount, 2);
    assert.equal(current.accounts['example-x'].recentErrors.length, 1);
    assert.equal(current.accounts['example-x'].recentMediaQa[0].score, 91);
    assert.equal(current.accounts['example-x'].humanFeedback[0].note, 'Prefer concrete examples.');

    const weekly = await generateWeeklyReport({ now });
    assert.equal(weekly.accounts['example-x'].current.postCount, 1);
    assert.equal(weekly.accounts['example-x'].previous.postCount, 1);
    assert.equal(weekly.accounts['example-x'].changes.errorCount, 1);
    assert.equal(weekly.accounts['example-x'].current.best.providerPostId, 'p-new');
    assert.equal(weekly.accounts['example-x'].recentlyCompletedExperiments.length, 1);
    assert.match(await readFile(pathOf('../data/reports/latest.md'), 'utf8'), /Policy review requested/);
    assert.match(await readFile(pathOf('../data/reports/weekly/latest.md'), 'utf8'), /Weekly Review/);
  });
});
