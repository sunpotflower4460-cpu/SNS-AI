import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './json-store.mjs';

const STATE_FILE = fileURLToPath(new URL('../../data/state.json', import.meta.url));

export async function loadState() {
  const parsed = await readJson(STATE_FILE, { slots: {} });
  return parsed && typeof parsed === 'object' ? parsed : { slots: {} };
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
  const state = await loadState();
  state.slots ||= {};
  state.slots[slotId] = {
    status,
    at: new Date().toISOString(),
    ...detail
  };
  await saveState(state);
  return state.slots[slotId];
}

export async function slotHandled(slotId) {
  const slot = await getSlot(slotId);
  return Boolean(slot && ['published', 'approval_pending', 'skipped'].includes(slot.status));
}
