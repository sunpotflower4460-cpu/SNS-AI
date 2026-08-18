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

const HANDLED_STATUSES = new Set(['published', 'approval_pending', 'skipped', 'publishing', 'publish_unknown']);

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

// Unlike markSlot (unconditional last-write-wins - fine for genuine completed actions, since a second
// such write only ever happens after the durable-claim CAS already prevented a duplicate real side
// effect), this refuses to overwrite a slot that has ALREADY reached a handled/terminal status. Needed
// for callers marking a slot 'skipped' after a deterministic failure: the caller's own earlier
// slotHandled() check is not atomic with this write, so a concurrent runner could have published the
// slot (or created its approval issue) in between - that newer, real outcome must never be clobbered by
// a stale 'skipped' write. serializeMutation makes the read-check-write atomic relative to any other
// IN-PROCESS caller of markSlot/markSlotIfUnhandled; it does not add cross-process locking beyond what
// every other state.json writer here already relies on (the shared `sns-ai-write` Actions concurrency
// group serializing real scheduled/CI runs).
//
// `handledStatuses` narrows that guard for the one caller that must legitimately supersede a handled
// status: approval expiry. When the approval issue is closed as expired, `approval_pending` is no
// longer true, so it has to be overridable - but `published`/`publishing`/`publish_unknown`/`skipped`
// must still be untouchable, because they describe a real side effect that already happened. The
// override is per-call and explicit; the default set is unchanged for every other caller.
export async function markSlotIfUnhandled(slotId, status, detail = {}, { handledStatuses } = {}) {
  const guarded = handledStatuses ? new Set(handledStatuses) : HANDLED_STATUSES;
  return serializeMutation(async () => {
    const state = await loadState();
    state.slots ||= {};
    const current = state.slots[slotId];
    if (current && guarded.has(current.status)) return { applied: false, current };
    const next = {
      status,
      at: new Date().toISOString(),
      ...detail
    };
    state.slots[slotId] = next;
    await saveState(state);
    return { applied: true, current: next };
  });
}

export async function slotHandled(slotId) {
  const slot = await getSlot(slotId);
  if (slot && HANDLED_STATUSES.has(slot.status)) return true;
  return durableClaimHandled(slotId);
}
