// Artist OS coordination mode.
//
//   standalone         - SNS-AI behaves exactly as before (default).
//   artist_os_managed  - Artist OS has designated My-SNS as the canonical inbound-reply executor.
//                        SNS-AI may only produce recommendations/drafts/strategy and must NEVER
//                        execute an external inbound reply (X reply/DM, Instagram comment reply/DM).
//
// Sources (read at CALL time, never at import time):
//   env ARTIST_OS_MODE, and optional `artistOsMode` in config/runtime-policy.json.
// Most restrictive wins: if either source says managed, the result is managed. Any unrecognised
// non-empty value fails closed to managed with modeInvalid:true.

export const MODE_STANDALONE = 'standalone';
export const MODE_MANAGED = 'artist_os_managed';
export const MANAGED_BLOCKED_CODE = 'MANAGED_MODE_INBOUND_REPLY_BLOCKED';

function classify(raw) {
  if (raw === undefined || raw === null) return { managed: false, invalid: false };
  const value = String(raw).trim().toLowerCase();
  if (value === '' || value === MODE_STANDALONE) return { managed: false, invalid: false };
  if (value === MODE_MANAGED) return { managed: true, invalid: false };
  return { managed: true, invalid: true };
}

export function resolveArtistOsMode(env = process.env, policy) {
  const fromEnv = classify(env?.ARTIST_OS_MODE);
  const fromPolicy = classify(policy?.artistOsMode);
  const managed = fromEnv.managed || fromPolicy.managed;
  return {
    mode: managed ? MODE_MANAGED : MODE_STANDALONE,
    modeInvalid: fromEnv.invalid || fromPolicy.invalid
  };
}

export function managedModeBlockedError(operation = 'inbound reply execution') {
  const error = new Error(`Artist OS managed mode blocks ${operation}: My-SNS is the canonical inbound-reply executor. SNS-AI only produces recommendations/drafts.`);
  error.code = MANAGED_BLOCKED_CODE;
  return error;
}

export function assertInboundReplyExecutionAllowed({ env = process.env, policy, dryRun = false, operation } = {}) {
  if (dryRun === true) return;
  if (resolveArtistOsMode(env, policy).mode === MODE_MANAGED) throw managedModeBlockedError(operation);
}
