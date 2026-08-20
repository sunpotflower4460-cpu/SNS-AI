import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('routine publish preflight defers engagement OAuth while activation requires it', async () => {
  const chatops = await readFile(`${ROOT}.github/workflows/chatops.yml`, 'utf8');
  const accountControl = await readFile(`${ROOT}.github/workflows/account-control.yml`, 'utf8');
  const engagementControl = await readFile(`${ROOT}.github/workflows/engagement-control.yml`, 'utf8');

  assert.match(chatops, /live-preflight\.mjs --account "\$\{\{ steps\.command\.outputs\.account \}\}"/);
  assert.doesNotMatch(chatops, /live-preflight\.mjs --account "\$\{\{ steps\.command\.outputs\.account \}\}" --engagement/);
  assert.match(accountControl, /live-preflight\.mjs --account/);
  assert.doesNotMatch(accountControl, /live-preflight\.mjs --account[^\n]*--engagement/);
  assert.match(engagementControl, /live-preflight\.mjs --account "\$account" --engagement/);
});
