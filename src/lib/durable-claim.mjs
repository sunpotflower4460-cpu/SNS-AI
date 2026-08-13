import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubContext, githubRequest } from './github.mjs';
import { readJson, writeJsonAtomic } from './json-store.mjs';

const LOCAL_DIR = fileURLToPath(new URL('../../data/durable-claims/', import.meta.url));
const STATE_BRANCH = process.env.SNS_DURABLE_STATE_BRANCH || 'sns-ai-state';
const memory = new Map();
const shaMemory = new Map();
const HANDLED_STATUSES = new Set(['publishing', 'publish_unknown', 'published']);

function keyFor(slotId) {
  return createHash('sha256').update(String(slotId || '')).digest('hex').slice(0, 40);
}

function relativePath(slotId) {
  return `data/durable-claims/${keyFor(slotId)}.json`;
}

function localPath(slotId) {
  return join(LOCAL_DIR, `${keyFor(slotId)}.json`);
}

function hasGithubRuntime() {
  return Boolean((process.env.GITHUB_TOKEN || process.env.GH_TOKEN) && process.env.GITHUB_REPOSITORY);
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
    if (error.status === 404) return null;
    throw error;
  }
}

async function writeRemote(slotId, claim) {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  let sha = shaMemory.get(slotId) || null;
  if (!sha) {
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

async function readLocal(slotId) {
  const claim = await readJson(localPath(slotId), null);
  if (claim) memory.set(slotId, claim);
  return claim;
}

async function writeLocal(slotId, claim) {
  const path = localPath(slotId);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomic(path, claim);
  memory.set(slotId, claim);
  return claim;
}

export async function getDurableClaim(slotId, { fresh = false } = {}) {
  if (!slotId) return null;
  if (!fresh && memory.has(slotId)) return memory.get(slotId);
  return hasGithubRuntime() ? readRemote(slotId) : readLocal(slotId);
}

export async function writeDurableClaim(slotId, status, detail = {}) {
  if (!slotId) return null;
  const previous = await getDurableClaim(slotId, { fresh: hasGithubRuntime() });
  const now = new Date().toISOString();
  const claim = {
    ...(previous || {}),
    slotId,
    status,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    ...detail
  };
  return hasGithubRuntime() ? writeRemote(slotId, claim) : writeLocal(slotId, claim);
}

export async function beginPublishClaim(slotId, detail = {}) {
  if (!slotId) return { claimed: false, untracked: true, claim: null };
  const existing = await getDurableClaim(slotId, { fresh: hasGithubRuntime() });
  if (existing?.status === 'published') {
    return { claimed: false, replay: true, claim: existing };
  }
  if (['publishing', 'publish_unknown'].includes(existing?.status)) {
    const error = new Error(`Durable slot claim prevents duplicate publishing for ${slotId}; current status is ${existing.status}.`);
    error.code = 'SLOT_ALREADY_CLAIMED';
    error.claim = existing;
    throw error;
  }
  const claim = await writeDurableClaim(slotId, 'publishing', detail);
  return { claimed: true, replay: false, claim };
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

export const __test = { keyFor, relativePath, localPath, hasGithubRuntime, handledStatuses: HANDLED_STATUSES, resetForTests };
