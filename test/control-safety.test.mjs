import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { consumeUsage, usageToday } from '../src/ops/budget.mjs';
import { assertCircuitClosed, circuitStatus, recordCircuitFailure, recordCircuitSuccess } from '../src/ops/circuit.mjs';
import { getSlot, markSlot, slotHandled } from '../src/lib/state.mjs';

const DATA_FILES = [
  fileURLToPath(new URL('../data/usage-state.json', import.meta.url)),
  fileURLToPath(new URL('../data/usage.jsonl', import.meta.url)),
  fileURLToPath(new URL('../data/runtime-health.json', import.meta.url)),
  fileURLToPath(new URL('../data/state.json', import.meta.url))
];

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
    if (bytes === null) await rm(path, { force: true });
    else await writeFile(path, bytes);
  }
}

test('hard budgets, circuit breakers, and slot idempotency fail safe', async () => {
  const saved = await snapshotFiles(DATA_FILES);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });

    const account = {
      schedule: { timezone: 'Asia/Tokyo' },
      budgets: { enabled: true, openaiCallsPerDay: 2 }
    };
    await consumeUsage('safety-account', account, 'openai', { operation: 'first' });
    await consumeUsage('safety-account', account, 'openai', { operation: 'second' });
    assert.equal(await usageToday('safety-account', account, 'openai'), 2);
    await assert.rejects(
      consumeUsage('safety-account', account, 'openai', { operation: 'blocked-third' }),
      (error) => error.code === 'BUDGET_EXHAUSTED' && error.used === 2 && error.limit === 2
    );
    assert.equal(await usageToday('safety-account', account, 'openai'), 2, 'blocked call must not increment usage');

    const circuitConfig = { enabled: true, failureThreshold: 2, cooldownMinutes: 30 };
    const firstFailure = await recordCircuitFailure('safety-account', 'publish', new Error('temporary'), circuitConfig);
    assert.equal(firstFailure.failures, 1);
    assert.equal(firstFailure.openUntil, null);
    assert.equal((await assertCircuitClosed('safety-account', 'publish', circuitConfig)).open, false);

    const secondFailure = await recordCircuitFailure('safety-account', 'publish', new Error('again'), circuitConfig);
    assert.equal(secondFailure.failures, 2);
    assert.ok(Date.parse(secondFailure.openUntil) > Date.now());
    await assert.rejects(
      assertCircuitClosed('safety-account', 'publish', circuitConfig),
      (error) => error.code === 'CIRCUIT_OPEN' && Boolean(error.openUntil)
    );
    await recordCircuitSuccess('safety-account', 'publish', circuitConfig);
    const recovered = await circuitStatus('safety-account', 'publish', circuitConfig);
    assert.equal(recovered.open, false);
    assert.equal(recovered.failures, 0);

    await markSlot('slot-published', 'published', { account: 'safety-account' });
    await markSlot('slot-approval', 'approval_pending', { account: 'safety-account' });
    await markSlot('slot-failed', 'failed', { account: 'safety-account' });
    assert.equal(await slotHandled('slot-published'), true);
    assert.equal(await slotHandled('slot-approval'), true);
    assert.equal(await slotHandled('slot-failed'), false, 'failed slot must remain retryable');
    assert.equal((await getSlot('slot-published')).account, 'safety-account');
  } finally {
    await restoreFiles(saved);
  }
});
