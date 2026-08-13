import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { beginPublishClaim, __test as claimTest } from '../src/lib/durable-claim.mjs';

function savedEnv(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(saved) {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test('abandoned local durable claim locks owned by a dead process are reclaimed', async () => {
  const env = savedEnv(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY']);
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  claimTest.resetForTests();

  const slotId = 'stale-lock:2026-08-13:10:40';
  const claimPath = claimTest.localPath(slotId);
  const lockPath = claimTest.localLockPath(slotId);
  await rm(claimPath, { force: true });
  await rm(lockPath, { force: true });
  await mkdir(dirname(lockPath), { recursive: true });

  try {
    await writeFile(lockPath, JSON.stringify({
      pid: 2147483647,
      token: 'abandoned-owner',
      createdAt: '2026-01-01T00:00:00.000Z'
    }), 'utf8');

    assert.equal(claimTest.processAlive(2147483647), false);
    const result = await beginPublishClaim(slotId, { account: 'stale-lock' });
    assert.equal(result.claimed, true);

    const stored = JSON.parse(await readFile(claimPath, 'utf8'));
    assert.equal(stored.status, 'publishing');
    await assert.rejects(readFile(lockPath, 'utf8'), (error) => error.code === 'ENOENT');
  } finally {
    claimTest.resetForTests();
    await rm(claimPath, { force: true });
    await rm(lockPath, { force: true });
    restoreEnv(env);
  }
});
