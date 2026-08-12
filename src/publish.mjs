import { readFile } from 'node:fs/promises';
import { resolveAccount } from './lib/config.mjs';
import { appendHistory } from './lib/history.mjs';
import { markSlot } from './lib/state.mjs';
import { publishX } from './providers/x.mjs';
import { publishInstagram } from './providers/instagram.mjs';

function parseArgs(argv) { const args = {}; for (let i = 0; i < argv.length; i += 1) { const token = argv[i]; if (!token.startsWith('--')) continue; const key = token.slice(2); const next = argv[i + 1]; if (!next || next.startsWith('--')) args[key] = true; else { args[key] = next; i += 1; } } return args; }
async function loadPayload(args) { if (args.file) return JSON.parse(await readFile(args.file, 'utf8')); if (args.json) return JSON.parse(args.json); return { account: args.account, text: args.text || '', mediaUrl: args['media-url'], mediaType: args['media-type'] || 'image', dryRun: args['dry-run'] === true || args['dry-run'] === 'true', source: args.source || 'manual', slotId: args['slot-id'] }; }
function providerPostId(result) { return result?.data?.id || result?.postId || result?.id || result?.mediaId || result?.media_id || result?.creationId || null; }

export async function publish(payload) {
  const account = await resolveAccount(payload.account); const common = { text: payload.text || '', mediaUrl: payload.mediaUrl || undefined, mediaType: payload.mediaType || 'image', credential: account.credential, dryRun: Boolean(payload.dryRun) };
  let result; if (account.platform === 'x') result = await publishX(common); else if (account.platform === 'instagram') result = await publishInstagram({ ...common, apiVersion: account.apiVersion || 'v23.0' }); else throw new Error(`Unsupported platform: ${account.platform}`);
  if (!payload.dryRun) {
    await appendHistory({
      account: payload.account, platform: account.platform, status: 'published', source: payload.source || 'manual', slotId: payload.slotId || null,
      text: payload.text || '', mediaUrl: payload.mediaUrl || null, mediaType: payload.mediaType || null, providerPostId: providerPostId(result), ai: payload.ai || null,
      features: payload.features || null, rationale: payload.rationale || null, predictedScore: payload.predictedScore ?? null, selectionMode: payload.selectionMode || null
    });
    if (payload.slotId) await markSlot(payload.slotId, 'published', { account: payload.account });
  }
  return result;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  try { const payload = await loadPayload(parseArgs(process.argv.slice(2))); const result = await publish(payload); console.log(JSON.stringify({ ok: true, account: payload.account, result }, null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message, status: error.status, detail: error.body }, null, 2)); process.exitCode = 1; }
}
