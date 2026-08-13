import { fileURLToPath } from 'node:url';
import { durableClaimHandled } from './durable-claim.mjs';
import { readJson, writeJsonAtomic } from './json-store.mjs';

const STATE_FILE = fileURLToPath(new URL('../../data/state.json', import.meta.url));
let mutationQueue = Promise.resolve();

function serializeMutation(task) {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function loadState() {
  const parsed = await readJson(STATE_FILE, { slots: {} });
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { slots: {} };
}

async function saveState(state) {
  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 120;
  const slots = Object.fromEntries(
    Object.entries(state.slots || {}).filter(([, value]) => {
      const at = Date.parse(value?.at || '');
      return Number.isNaN(at) || at >= cutoff;
    })
  );

  await writeJsonAtomic(STATE_FILE, { ...state, slots });
}

export async function getSlot(slotId) {
  const state = await loadState();
  return state.slots?.[slotId] || null;
}

export async function markSlot(slotId, status, detail = {}) {
  return serializeMutation(async () => {
    const state = await loadState();
    state.slots ||= {};
    const next = {
      status,
      at: new Date().toISOString(),
      ...detail
    };
    state.slots[slotId] = next;
    await saveState(state);
    return next;
  });
}

export async function slotHandled(slotId) {
  const slot = await getSlot(slotId);
  if (slot && ['published', 'approval_pending', 'skipped', 'publishing', 'publish_unknown'].includes(slot.status)) return true;
  return durableClaimHandled(slotId);
}
