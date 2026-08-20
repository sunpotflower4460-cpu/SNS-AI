import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson } from '../lib/json-store.mjs';

export const OPERATION_MODE_FILE = fileURLToPath(new URL('../../config/operation-mode.json', import.meta.url));

export async function loadOperationMode({ read = readJson, file = OPERATION_MODE_FILE } = {}) {
  const config = await read(file, {});
  return {
    schemaVersion: Number(config?.schemaVersion || 0),
    mode: String(config?.mode || 'manual-only'),
    allowAutoPromotion: config?.allowAutoPromotion === true,
    allowUnattendedEngagement: config?.allowUnattendedEngagement === true
  };
}

export function manualOnly(mode = {}) {
  return String(mode?.mode || '').toLowerCase() === 'manual-only';
}

export function assertAccountLifecycleAllowed(target, mode = {}) {
  if (manualOnly(mode) && String(target) === 'auto' && mode.allowAutoPromotion !== true) {
    const error = new Error('Manual-only operation lock blocks promotion to account mode "auto". Keep the account in approval/pause/disabled mode until the repository operation mode is intentionally changed.');
    error.code = 'MANUAL_ONLY_AUTO_PROMOTION_BLOCKED';
    throw error;
  }
  return true;
}

export function assertEngagementActivationAllowed(active, mode = {}) {
  if (manualOnly(mode) && active === true && mode.allowUnattendedEngagement !== true) {
    const error = new Error('Manual-only operation lock blocks unattended engagement activation. Dry-run and human-resolved engagement remain available.');
    error.code = 'MANUAL_ONLY_ENGAGEMENT_ACTIVATION_BLOCKED';
    throw error;
  }
  return true;
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; index += 1; }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const mode = await loadOperationMode();
    if (args['account-target']) assertAccountLifecycleAllowed(String(args['account-target']), mode);
    if (args['engagement-activate']) assertEngagementActivationAllowed(true, mode);
    console.log(JSON.stringify({ ok: true, ...mode }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || null, error: String(error.message || error) }, null, 2));
    process.exitCode = 1;
  }
}

export const __test = { parseArgs };
