import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assignmentForSlot, ensureExperiment, evaluateExperiment } from '../src/experiments/engine.mjs';
import { loadExperimentState, saveExperimentState } from '../src/experiments/store.mjs';
import { assertAutonomyBrakeClear, brakeStatus, clearBrake, evaluateAnomalyBrake } from '../src/ops/brake.mjs';
import { runAutopilot } from '../src/orchestrate.mjs';

const CONFIG = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const FILES = [
  '../data/experiments/guardrail-test.json',
  '../data/brakes.json',
  '../data/runtime-health.json',
  '../data/history.jsonl',
  '../data/audit.jsonl',
  '../data/state.json'
].map((p) => fileURLToPath(new URL(p, import.meta.url)));

async function snap(path) {
  try { return { exists: true, bytes: await readFile(path) }; }
  catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
}
async function restore(path, saved) {
  if (!saved.exists) return rm(path, { force: true });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, saved.bytes);
}
async function isolated(fn) {
  const tracked = [CONFIG, ...FILES];
  const saved = new Map();
  for (const path of tracked) saved.set(path, await snap(path));
  try {
    for (const path of FILES) await rm(path, { force: true });
    return await fn();
  } finally {
    for (const path of tracked.reverse()) await restore(path, saved.get(path));
  }
}
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}
const pathOf = (rel) => fileURLToPath(new URL(rel, import.meta.url));

function snapshot({ id, impressions, likes = 0, checkpointMinutes = 1440, at }) {
  return {
    collectedAt: at,
    publishedAt: at,
    account: 'guardrail-test',
    platform: 'x',
    providerPostId: id,
    checkpointMinutes,
    metrics: { impressions, likes, reposts: 0, bookmarks: 0, replies: 0, profileClicks: 0, urlClicks: 0 }
  };
}

test('experiment engine creates, reuses, completes, expires, and persists controlled experiments', async () => {
  await isolated(async () => {
    const accountId = 'guardrail-test';
    const base = {
      platform: 'x',
      experiments: { enabled: true, minimumStrategySamples: 2, dimensions: ['hook'], minSamplesPerVariant: 1, maxDays: 14 },
      learning: { matureCheckpointMinutes: 1440 },
      objectives: { weights: {} }
    };

    assert.equal(await ensureExperiment(accountId, { ...base, experiments: { enabled: false } }, { sampleSize: 99 }), null);
    assert.equal(await ensureExperiment(accountId, base, { sampleSize: 1 }), null);
    assert.equal(await ensureExperiment(accountId, { ...base, experiments: { ...base.experiments, dimensions: ['unknown'] } }, { sampleSize: 10 }), null);

    const active = await ensureExperiment(accountId, base, { sampleSize: 2 });
    assert.equal(active.status, 'active');
    assert.equal(active.dimension, 'hook');
    assert.deepEqual(active.variants, ['question', 'statement']);
    assert.equal((await ensureExperiment(accountId, base, { sampleSize: 100 })).id, active.id);

    const assignment = assignmentForSlot(active, 'slot-1');
    assert.equal(assignment.id, active.id);
    assert.equal(active.variants.includes(assignment.variant), true);
    assert.equal(assignmentForSlot(null, 'slot-1'), null);

    const at = new Date().toISOString();
    const history = [
      { account: accountId, providerPostId: 'q1', experiment: { id: active.id, variant: 'question', applied: true } },
      { account: accountId, providerPostId: 's1', experiment: { id: active.id, variant: 'statement', applied: true } },
      { account: accountId, providerPostId: 'ignored', experiment: { id: active.id, variant: 'question', applied: false } }
    ];
    const snapshots = [
      snapshot({ id: 'q1', impressions: 2000, likes: 120, at }),
      snapshot({ id: 's1', impressions: 900, likes: 5, at }),
      snapshot({ id: 'ignored', impressions: 5000, likes: 500, at })
    ];
    const completed = await evaluateExperiment(accountId, base, history, snapshots);
    assert.equal(completed.status, 'completed');
    assert.equal(active.variants.includes(completed.experiment.winner), true);
    assert.equal(completed.stats.question.n, 1);
    assert.equal(completed.stats.statement.n, 1);
    const persistedCompleted = await loadExperimentState(accountId);
    assert.equal(persistedCompleted.active, null);
    assert.equal(persistedCompleted.completed.at(-1).status, 'completed');

    const expired = {
      id: 'expired-exp', status: 'active', dimension: 'hook', variants: ['question', 'statement'],
      startedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), minSamplesPerVariant: 2, maxDays: 1
    };
    await saveExperimentState(accountId, { account: accountId, active: expired, completed: persistedCompleted.completed });
    const expiredResult = await evaluateExperiment(accountId, base, [], []);
    assert.equal(expiredResult.status, 'expired');
    assert.equal(expiredResult.experiment.winner, null);
    assert.equal(expiredResult.experiment.confidence, 0);

    await saveExperimentState(accountId, { account: accountId, active: null, completed: [] });
    assert.deepEqual(await evaluateExperiment(accountId, base, [], []), { status: 'none' });

    const mediaAccount = { ...base, experiments: { ...base.experiments, dimensions: ['mediaDecision'] } };
    const mediaExperiment = await ensureExperiment(accountId, mediaAccount, { sampleSize: 2 });
    assert.deepEqual(mediaExperiment.variants, ['none', 'generate']);
  });
});

test('anomaly brake persists an open state, rejects autonomous publishing, avoids duplicate opens, clears, and auto-closes after cooldown', async () => {
  await isolated(async () => {
    const accountId = 'guardrail-test';
    const account = {
      platform: 'x',
      learning: { matureCheckpointMinutes: 1 },
      objectives: { weights: {} },
      safety: { anomalyBrake: {
        enabled: true,
        matureCheckpointMinutes: 1,
        minBaselinePosts: 0,
        minConfidence: 0,
        minExposure: 0,
        severeScoreThreshold: 100,
        lowScoreThreshold: 100,
        consecutiveLowPosts: 1,
        cooldownHours: 1
      } }
    };
    const at = new Date().toISOString();
    const rows = [snapshot({ id: 'collapse', impressions: 10, likes: 0, checkpointMinutes: 1, at })];

    const opened = await evaluateAnomalyBrake(accountId, account, rows);
    assert.equal(opened.opened, true);
    assert.equal((await brakeStatus(accountId)).open, true);
    await assert.rejects(assertAutonomyBrakeClear(accountId, account), (error) => error.code === 'AUTONOMY_BRAKE');

    const duplicate = await evaluateAnomalyBrake(accountId, account, rows);
    assert.equal(duplicate.opened, false);
    assert.equal(duplicate.alreadyOpen, true);

    const cleared = await clearBrake(accountId, 'test_clear');
    assert.equal(cleared.open, false);
    assert.equal(cleared.closedReason, 'test_clear');
    assert.equal((await assertAutonomyBrakeClear(accountId, account)).open, false);
    assert.deepEqual(await assertAutonomyBrakeClear(accountId, { safety: { anomalyBrake: { enabled: false } } }), { open: false, disabled: true });

    await writeJson(pathOf('../data/brakes.json'), { accounts: {
      [accountId]: { open: true, openedAt: at, openUntil: new Date(Date.now() - 1000).toISOString(), reason: 'old' }
    } });
    const autoClosed = await brakeStatus(accountId);
    assert.equal(autoClosed.open, false);
    assert.equal(autoClosed.closedReason, 'cooldown_elapsed');
  });
});

test('autopilot stops before generation when brake, circuit, or rate-limit guardrails are active', async () => {
  await isolated(async () => {
    const config = JSON.parse(await readFile(CONFIG, 'utf8'));
    config.accounts['example-x'] = {
      ...config.accounts['example-x'], enabled: true, mode: 'auto',
      learning: { enabled: false }, experiments: { enabled: false },
      research: { webSearch: false, trendIntelligence: false },
      media: { strategy: 'none' },
      safety: { maxPostsPerDay: 1, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: true } },
      resilience: { enabled: true, failureThreshold: 3, cooldownMinutes: 60 }
    };
    config.accounts['example-instagram'].enabled = false;
    config.accounts['example-instagram'].mode = 'pause';
    await writeJson(CONFIG, config);

    const now = new Date();
    await writeJson(pathOf('../data/brakes.json'), { accounts: {
      'example-x': { open: true, openUntil: new Date(now.getTime() + 3600_000).toISOString(), reason: 'synthetic-brake' }
    } });
    let report = await runAutopilot({ accountFilter: 'example-x', force: true, now });
    assert.equal(report[0].status, 'safety-brake');
    assert.match(report[0].reason, /synthetic-brake/);

    await rm(pathOf('../data/brakes.json'), { force: true });
    await writeJson(pathOf('../data/runtime-health.json'), { circuits: {
      'example-x:autopilot': { failures: 3, openUntil: new Date(now.getTime() + 3600_000).toISOString(), lastError: 'synthetic-circuit' }
    } });
    report = await runAutopilot({ accountFilter: 'example-x', force: true, now });
    assert.equal(report[0].status, 'circuit-open');

    await rm(pathOf('../data/runtime-health.json'), { force: true });
    await writeJsonl(pathOf('../data/history.jsonl'), [{
      at: now.toISOString(), account: 'example-x', platform: 'x', status: 'published', providerPostId: 'existing', text: 'existing post'
    }]);
    report = await runAutopilot({ accountFilter: 'example-x', force: true, now });
    assert.equal(report[0].status, 'rate-limited');
  });
});
