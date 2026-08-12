import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_FILE = fileURLToPath(new URL('../../data/state.json', import.meta.url));

export async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { slots: {} };
  } catch (error) {
    if (error.code === 'ENOENT') return { slots: {} };
    throw error;
  }
}

async function saveState(state) {
  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 120;
  const slots = Object.fromEntries(
    Object.entries(state.slots || {}).filter(([, value]) => {
      const at = Date.parse(value?.at || '');
      return Number.isNaN(at) || at >= cutoff;
    })
  );

  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify({ ...state, slots }, null, 2)}\n`, 'utf8');
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
