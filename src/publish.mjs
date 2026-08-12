import { readFile } from 'node:fs/promises';
import { resolveAccount } from './lib/config.mjs';
import { publishX } from './providers/x.mjs';
import { publishInstagram } from './providers/instagram.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function loadPayload(args) {
  if (args.file) return JSON.parse(await readFile(args.file, 'utf8'));
  if (args.json) return JSON.parse(args.json);
  return {
    account: args.account,
    text: args.text || '',
    mediaUrl: args['media-url'],
    mediaType: args['media-type'] || 'image',
    dryRun: args['dry-run'] === true || args['dry-run'] === 'true'
  };
}

export async function publish(payload) {
  const account = await resolveAccount(payload.account);
  const common = {
    text: payload.text || '',
    mediaUrl: payload.mediaUrl || undefined,
    mediaType: payload.mediaType || 'image',
    credential: account.credential,
    dryRun: Boolean(payload.dryRun)
  };

  if (account.platform === 'x') return publishX(common);
  if (account.platform === 'instagram') {
    return publishInstagram({ ...common, apiVersion: account.apiVersion || 'v23.0' });
  }
  throw new Error(`Unsupported platform: ${account.platform}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const payload = await loadPayload(parseArgs(process.argv.slice(2)));
    const result = await publish(payload);
    console.log(JSON.stringify({ ok: true, account: payload.account, result }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
      status: error.status,
      detail: error.body
    }, null, 2));
    process.exitCode = 1;
  }
}
