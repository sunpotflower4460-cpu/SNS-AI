import { readFile } from 'node:fs/promises';
import { loadAccounts } from '../lib/config.mjs';
import { recordHumanFeedback } from './store.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

async function loadInput(args) {
  if (args.file) return JSON.parse(await readFile(args.file, 'utf8'));
  if (args.json) return JSON.parse(args.json);
  return {
    account: args.account,
    action: args.action || 'note',
    note: args.note,
    dimension: args.dimension,
    value: args.value,
    source: args.source || 'cli'
  };
}

export async function recordFeedback(input) {
  const accounts = await loadAccounts();
  if (!accounts[input.account]) throw new Error(`Unknown account "${input.account}".`);
  return recordHumanFeedback(input);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const row = await recordFeedback(await loadInput(parseArgs(process.argv.slice(2))));
    console.log(JSON.stringify({ ok: true, feedback: row }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}
