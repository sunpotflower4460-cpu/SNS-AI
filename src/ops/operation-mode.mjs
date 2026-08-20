import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson } from '../lib/json-store.mjs';

export const OPERATION_MODE_FILE = fileURLToPath(new URL('../../config/operation-mode.json', import.meta.url));
const SUPPORTED_SCHEMA_VERSION = 1;
const UNATTENDED_MODE = 'unattended';

export async function loadOperationMode({ read = readJson, file = OPERATION_MODE_FILE } = {}) {
  const config = await read(file, {});
  return {
    schemaVersion: Number(config?.schemaVersion || 0),
    mode: String(config?.mode || 'manual-only').trim().toLowerCase(),
    allowAutoPromotion: config?.allowAutoPromotion === true,
    allowUnattendedEngagement: config?.allowUnattendedEngagement === true
  };
}

export function manualOnly(mode = {}) {
  return mode?.schemaVersion !== SUPPORTED_SCHEMA_VERSION || String(mode?.mode || '').toLowerCase() !== UNATTENDED_MODE;
}

function explicitUnattendedPermission(mode = {}, permissionKey) {
  return mode?.schemaVersion === SUPPORTED_SCHEMA_VERSION
    && String(mode?.mode || '').toLowerCase() === UNATTENDED_MODE
    && mode?.[permissionKey] === true;
}

export function assertAccountLifecycleAllowed(target, mode = {}) {
  if (String(target) === 'auto' && !explicitUnattendedPermission(mode, 'allowAutoPromotion')) {
    const error = new Error('Operation-mode lock blocks promotion to account mode "auto". Unattended posting requires schemaVersion 1, mode "unattended", and allowAutoPromotion=true in one reviewed change.');
    error.code = 'MANUAL_ONLY_AUTO_PROMOTION_BLOCKED';
    throw error;
  }
  return true;
}

export function assertEngagementActivationAllowed(active, mode = {}) {
  if (active === true && !explicitUnattendedPermission(mode, 'allowUnattendedEngagement')) {
    const error = new Error('Operation-mode lock blocks unattended engagement activation. It requires schemaVersion 1, mode "unattended", and allowUnattendedEngagement=true in one reviewed change. Dry-run and human-resolved engagement remain available.');
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
    console.log(JSON.stringify({ ok: true, ...mode, manualOnly: manualOnly(mode) }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code || null, error: String(error.message || error) }, null, 2));
    process.exitCode = 1;
  }
}

export const __test = { parseArgs, explicitUnattendedPermission, SUPPORTED_SCHEMA_VERSION, UNATTENDED_MODE };
