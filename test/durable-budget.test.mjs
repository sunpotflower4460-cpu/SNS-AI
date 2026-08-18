import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localDateKey } from '../src/lib/schedule.mjs';
import { assertUsageBudget, consumeUsage, recordUsage, usageToday, __test } from '../src/ops/budget.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STATE_FILE = `${ROOT}data/usage-state.json`;
const USAGE_FILE = `${ROOT}data/usage.jsonl`;

async function readMaybe(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function withSandbox(task) {
  const files = new Map([[STATE_FILE, await readMaybe(STATE_FILE)], [USAGE_FILE, await readMaybe(USAGE_FILE)]]);
  const savedEnv = {
    SNS_DURABLE_BUDGETS: process.env.SNS_DURABLE_BUDGETS,
    SNS_DURABLE_STATE_BRANCH: process.env.SNS_DURABLE_STATE_BRANCH,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY
  };
  const realFetch = globalThis.fetch;
  try {
    await rm(STATE_FILE, { force: true });
    await rm(USAGE_FILE, { force: true });
    return await task();
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [path, bytes] of files) {
      if (bytes == null) await rm(path, { force: true });
      else await writeFile(path, bytes);
    }
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function enableDurable() {
  process.env.SNS_DURABLE_BUDGETS = 'true';
  process.env.SNS_DURABLE_STATE_BRANCH = 'sns-ai-state';
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
}

function installRemote(initial = null, { raceOnce = null } = {}) {
  let remote = initial;
  let sha = initial ? 'sha-0' : null;
  let puts = 0;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    assert.match(target, /\/repos\/owner\/repo\/contents\/data\/durable-usage-state\.json/);
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'GET') {
      if (!remote) return jsonResponse({ message: 'Not Found' }, 404);
      return jsonResponse({ content: Buffer.from(`${JSON.stringify(remote)}\n`).toString('base64'), sha });
    }
    assert.equal(method, 'PUT');
    puts += 1;
    const body = JSON.parse(options.body);
    assert.equal(body.branch, 'sns-ai-state');
    if (raceOnce && puts === 1) {
      remote = structuredClone(raceOnce);
      sha = 'sha-race';
      return jsonResponse({ message: 'conflict' }, 409);
    }
    if (sha) assert.equal(body.sha, sha);
    else assert.equal('sha' in body, false);
    remote = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
    sha = `sha-${puts}`;
    return jsonResponse({ content: { sha } });
  };
  return { get remote() { return remote; }, get puts() { return puts; } };
}

test('durable budget bootstraps from legacy usage state instead of resetting the cutover day', async () => {
  await withSandbox(async () => {
    enableDurable();
    const account = { schedule: { timezone: 'UTC' }, budgets: { enabled: true, openaiCallsPerDay: 5 } };
    const today = localDateKey(new Date(), 'UTC');
    await writeFile(STATE_FILE, `${JSON.stringify({ schemaVersion: 1, accounts: { acct: { localDate: today, counts: { openai: 1 } } } }, null, 2)}\n`);
    const remote = installRemote(null);

    const before = await usageToday('acct', account, 'openai');
    assert.equal(before, 1);
    const status = await consumeUsage('acct', account, 'openai', { operation: 'cutover' });
    assert.equal(status.used, 1);
    assert.equal(remote.remote.accounts.acct.counts.openai, 2);
    assert.equal(await usageToday('acct', account, 'openai'), 2);
  });
});

test('durable budget CAS retries against a concurrent workflow without losing its increment', async () => {
  await withSandbox(async () => {
    enableDurable();
    const account = { schedule: { timezone: 'UTC' }, budgets: { enabled: true, openaiCallsPerDay: 4 } };
    const today = localDateKey(new Date(), 'UTC');
    const initial = { schemaVersion: 1, accounts: { acct: { localDate: today, counts: { openai: 1 } } } };
    const raced = { schemaVersion: 1, accounts: { acct: { localDate: today, counts: { openai: 2 } } } };
    const remote = installRemote(initial, { raceOnce: raced });

    const status = await consumeUsage('acct', account, 'openai', { operation: 'cas' });
    assert.equal(status.used, 2, 'retry must recompute against the competing writer');
    assert.equal(remote.remote.accounts.acct.counts.openai, 3);
    assert.equal(remote.puts, 2);

    const availability = await assertUsageBudget('acct', account, 'openai');
    assert.equal(availability.used, 3);
    await consumeUsage('acct', account, 'openai', { operation: 'fourth' });
    await assert.rejects(
      consumeUsage('acct', account, 'openai', { operation: 'blocked-fifth' }),
      (error) => error.code === 'BUDGET_EXHAUSTED' && error.used === 4 && error.limit === 4
    );
    assert.equal(await usageToday('acct', account, 'openai'), 4);
  });
});

test('durable recordUsage shares the same counter even when no account budget is enforced', async () => {
  await withSandbox(async () => {
    enableDurable();
    const remote = installRemote(null);
    const row = await recordUsage('_system', { timezone: 'UTC' }, 'openai', { operation: 'policy-watch' });
    assert.equal(row.countToday, 1);
    assert.equal(remote.remote.accounts._system.counts.openai, 1);
  });
});

test('explicit durable mode fails closed when GitHub runtime metadata is unavailable', async () => {
  await withSandbox(async () => {
    process.env.SNS_DURABLE_BUDGETS = 'true';
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    await assert.rejects(usageToday('acct', { timezone: 'UTC' }, 'openai'), /GITHUB_TOKEN|GITHUB_REPOSITORY|Approval mode/i);
  });
});

test('production cost-consuming workflows opt into the shared durable counter', async () => {
  for (const name of ['autopilot.yml', 'engagement.yml', 'chatops.yml', 'intelligence.yml', 'policy.yml']) {
    const text = await readFile(`${ROOT}.github/workflows/${name}`, 'utf8');
    assert.match(text, /SNS_DURABLE_BUDGETS:\s*['"]?true['"]?/);
    assert.match(text, /SNS_DURABLE_STATE_BRANCH:\s*sns-ai-state/);
    assert.match(text, /GITHUB_REPOSITORY:\s*\$\{\{ github\.repository \}\}/);
  }
});

test('durable state helpers stay opt-in and recognize GitHub CAS conflicts', () => {
  const saved = process.env.SNS_DURABLE_BUDGETS;
  try {
    delete process.env.SNS_DURABLE_BUDGETS;
    assert.equal(__test.durableBudgetRequested(), false);
    process.env.SNS_DURABLE_BUDGETS = 'yes';
    assert.equal(__test.durableBudgetRequested(), true);
    assert.equal(__test.remoteConflict({ status: 409 }), true);
    assert.equal(__test.remoteConflict({ status: 422 }), true);
    assert.equal(__test.remoteConflict({ status: 500 }), false);
    assert.equal(__test.DURABLE_PATH, 'data/durable-usage-state.json');
  } finally {
    if (saved == null) delete process.env.SNS_DURABLE_BUDGETS;
    else process.env.SNS_DURABLE_BUDGETS = saved;
  }
});
