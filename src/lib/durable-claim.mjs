import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubContext, githubRequest } from './github.mjs';
import { readJson, writeJsonAtomic } from './json-store.mjs';

const LOCAL_DIR = fileURLToPath(new URL('../../data/durable-claims/', import.meta.url));
const STATE_BRANCH = process.env.SNS_DURABLE_STATE_BRANCH || 'sns-ai-state';
const memory = new Map();
const shaMemory = new Map();
const HANDLED_STATUSES = new Set(['publishing', 'publish_unknown', 'published']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UNKNOWN_LOCK_STALE_MS = 30_000;

function keyFor(slotId) {
  return createHash('sha256').update(String(slotId || '')).digest('hex').slice(0, 40);
}

function relativePath(slotId) {
  return `data/durable-claims/${keyFor(slotId)}.json`;
}

function localPath(slotId) {
  return join(LOCAL_DIR, `${keyFor(slotId)}.json`);
}

function localLockPath(slotId) {
  return `${localPath(slotId)}.lock`;
}

function hasGithubRuntime() {
  return Boolean((process.env.GITHUB_TOKEN || process.env.GH_TOKEN) && process.env.GITHUB_REPOSITORY);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    if (error.code === 'ESRCH') return false;
    return true;
  }
}

async function readLockOwner(lockPath) {
  try {
    const raw = await readFile(lockPath, 'utf8');
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

async function reclaimStaleLocalLock(lockPath) {
  let info;
  try {
    info = await stat(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }

  const owner = await readLockOwner(lockPath);
  const ownerPid = Number(owner?.pid);
  const knownDeadOwner = Number.isInteger(ownerPid) && ownerPid > 0 && !processAlive(ownerPid);
  const unknownAndOld = (!Number.isInteger(ownerPid) || ownerPid <= 0) && Date.now() - info.mtimeMs >= UNKNOWN_LOCK_STALE_MS;
  if (!knownDeadOwner && !unknownAndOld) return false;

  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }
}

async function releaseOwnedLocalLock(lockPath, token) {
  const current = await readLockOwner(lockPath);
  if (!current || current.token !== token) return;
  await unlink(lockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

async function withLocalLock(slotId, task) {
  const lockPath = localLockPath(slotId);
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomBytes(16).toString('hex');
  let handle = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), 'utf8');
      break;
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        handle = null;
      }
      if (error.code !== 'EEXIST') throw error;
      if (await reclaimStaleLocalLock(lockPath)) continue;
      if (attempt === 99) throw new Error(`Timed out acquiring local durable claim lock for ${slotId}.`);
      await sleep(50);
    }
  }
  try {
    return await task();
  } finally {
    await handle?.close().catch(() => {});
    await releaseOwnedLocalLock(lockPath, token);
  }
}

async function readRemote(slotId) {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  const path = relativePath(slotId);
  try {
    const row = await githubRequest(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(STATE_BRANCH)}`);
    const decoded = Buffer.from(String(row.content || '').replace(/\n/g, ''), 'base64').toString('utf8');
    const claim = JSON.parse(decoded);
    shaMemory.set(slotId, row.sha);
    memory.set(slotId, claim);
    return claim;
  } catch (error) {
    if (error.status === 404) {
      shaMemory.delete(slotId);
      memory.delete(slotId);
      return null;
    }
    throw error;
  }
}

async function writeRemote(slotId, claim, { refreshShaIfMissing = true } = {}) {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  let sha = shaMemory.get(slotId) || null;
  if (!sha && refreshShaIfMissing) {
    await readRemote(slotId);
    sha = shaMemory.get(slotId) || null;
  }
  const body = {
    message: `chore: persist durable SNS slot claim ${keyFor(slotId).slice(0, 12)}`,
    content: Buffer.from(`${JSON.stringify(claim, null, 2)}\n`, 'utf8').toString('base64'),
    branch: STATE_BRANCH
  };
  if (sha) body.sha = sha;
  const result = await githubRequest(`/repos/${owner}/${repo}/contents/${relativePath(slotId)}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
  if (result?.content?.sha) shaMemory.set(slotId, result.content.sha);
  memory.set(slotId, claim);
  return claim;
}

function remoteWriteConflict(error) {
  return [409, 422].includes(Number(error?.status));
}

async function reconcileBeginConflict(slotId, originalError, detail = {}) {
  if (!remoteWriteConflict(originalError)) throw originalError;
  const raced = await readRemote(slotId);
  if (!raced) throw originalError;
  const check = assertClaimCanBegin(slotId, raced);
  if (check.replay) return { claimed: false, replay: true, claim: raced };
  // Remote still begin-able (e.g. prior `failed`, or SHA drifted from a metadata write). Retry the
  // begin with the fresh SHA instead of surfacing a opaque 409/422 to the publisher.
  const claim = await writeRemote(slotId, nextClaim(slotId, 'publishing', raced, detail), { refreshShaIfMissing: false });
  return { claimed: true, replay: false, claim };
}

async function readLocal(slotId) {
  const claim = await readJson(localPath(slotId), null);
  if (claim) memory.set(slotId, claim);
  else memory.delete(slotId);
  return claim;
}

async function writeLocal(slotId, claim) {
  const path = localPath(slotId);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomic(path, claim);
  memory.set(slotId, claim);
  return claim;
}

function nextClaim(slotId, status, previous, detail = {}) {
  const now = new Date().toISOString();
  return {
    ...(previous || {}),
    slotId,
    status,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    ...detail
  };
}

function assertClaimStatusTransition(previous, nextStatus) {
  if (!previous?.status || previous.status === nextStatus) return;
  // `published` is terminal for provider side-effects. Hub backlink markers may rewrite the same
  // published claim with extra fields, but never regress it to publishing/unknown/failed.
  if (previous.status === 'published') {
    const error = new Error(`Durable claim refuses regressing published status to ${nextStatus}.`);
    error.code = 'CLAIM_STATUS_REGRESSION';
    error.claim = previous;
    throw error;
  }
}

function assertClaimCanBegin(slotId, existing) {
  if (existing?.status === 'published') return { replay: true, claim: existing };
  if (['publishing', 'publish_unknown'].includes(existing?.status)) {
    const error = new Error(`Durable slot claim prevents duplicate publishing for ${slotId}; current status is ${existing.status}.`);
    error.code = 'SLOT_ALREADY_CLAIMED';
    error.claim = existing;
    throw error;
  }
  return { replay: false, claim: existing };
}

export async function getDurableClaim(slotId, { fresh = false } = {}) {
  if (!slotId) return null;
  if (hasGithubRuntime()) {
    if (!fresh && memory.has(slotId)) return memory.get(slotId);
    return readRemote(slotId);
  }
  return readLocal(slotId);
}

export async function writeDurableClaim(slotId, status, detail = {}) {
  if (!slotId) return null;
  if (hasGithubRuntime()) {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const previous = await getDurableClaim(slotId, { fresh: true });
      assertClaimStatusTransition(previous, status);
      try {
        return await writeRemote(slotId, nextClaim(slotId, status, previous, detail));
      } catch (error) {
        lastError = error;
        if (remoteWriteConflict(error) && attempt < 4) {
          shaMemory.delete(slotId);
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error(`Could not persist durable claim for ${slotId}.`);
  }
  return withLocalLock(slotId, async () => {
    const previous = await readLocal(slotId);
    assertClaimStatusTransition(previous, status);
    return writeLocal(slotId, nextClaim(slotId, status, previous, detail));
  });
}

export async function beginPublishClaim(slotId, detail = {}) {
  if (!slotId) return { claimed: false, untracked: true, claim: null };
  if (hasGithubRuntime()) {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await getDurableClaim(slotId, { fresh: true });
      const check = assertClaimCanBegin(slotId, existing);
      if (check.replay) return { claimed: false, replay: true, claim: existing };
      try {
        const claim = await writeRemote(slotId, nextClaim(slotId, 'publishing', existing, detail), { refreshShaIfMissing: false });
        return { claimed: true, replay: false, claim };
      } catch (error) {
        lastError = error;
        if (remoteWriteConflict(error) && attempt < 4) {
          try {
            return await reconcileBeginConflict(slotId, error, detail);
          } catch (reconcileError) {
            if (reconcileError?.code === 'SLOT_ALREADY_CLAIMED') throw reconcileError;
            if (remoteWriteConflict(reconcileError)) {
              shaMemory.delete(slotId);
              continue;
            }
            throw reconcileError;
          }
        }
        throw error;
      }
    }
    throw lastError || new Error(`Could not begin durable claim for ${slotId}.`);
  }
  return withLocalLock(slotId, async () => {
    const existing = await readLocal(slotId);
    const check = assertClaimCanBegin(slotId, existing);
    if (check.replay) return { claimed: false, replay: true, claim: existing };
    const claim = await writeLocal(slotId, nextClaim(slotId, 'publishing', existing, detail));
    return { claimed: true, replay: false, claim };
  });
}

export async function finishPublishClaim(slotId, status, detail = {}) {
  if (!slotId) return null;
  return writeDurableClaim(slotId, status, detail);
}

export async function durableClaimHandled(slotId) {
  const claim = await getDurableClaim(slotId);
  return Boolean(claim && HANDLED_STATUSES.has(claim.status));
}

function resetForTests() {
  memory.clear();
  shaMemory.clear();
}

export const __test = {
  keyFor,
  relativePath,
  localPath,
  localLockPath,
  hasGithubRuntime,
  handledStatuses: HANDLED_STATUSES,
  resetForTests,
  processAlive,
  readLockOwner,
  reclaimStaleLocalLock,
  remoteWriteConflict,
  assertClaimStatusTransition
};
