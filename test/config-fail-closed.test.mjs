import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadCredentials, resolveAccount } from '../src/lib/config.mjs';

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));

function saveEnv(...names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(saved) {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test('account and credential resolution fails closed on incomplete or invalid configuration', async () => {
  const env = saveEnv('SOCIAL_CREDENTIALS_JSON');
  const originalConfig = await readFile(CONFIG_FILE, 'utf8');
  try {
    await assert.rejects(resolveAccount(), /Missing account ID/);
    await assert.rejects(resolveAccount('missing-account'), /Unknown account/);
    await assert.rejects(resolveAccount('example-x'), /disabled/);

    delete process.env.SOCIAL_CREDENTIALS_JSON;
    assert.throws(() => loadCredentials(), /Missing SOCIAL_CREDENTIALS_JSON/);

    process.env.SOCIAL_CREDENTIALS_JSON = '{broken json';
    assert.throws(() => loadCredentials(), /not valid JSON/);

    process.env.SOCIAL_CREDENTIALS_JSON = '{}';
    await assert.rejects(
      resolveAccount('example-x', { allowDisabled: true }),
      /No credentials found/
    );

    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({
      'example-x': {
        consumerKey: 'consumer-key',
        consumerSecret: 'consumer-secret',
        accessToken: 'access-token',
        accessTokenSecret: 'access-token-secret'
      }
    });
    const resolved = await resolveAccount('example-x', { allowDisabled: true });
    assert.equal(resolved.platform, 'x');
    assert.equal(resolved.credential.consumerKey, 'consumer-key');

    const config = JSON.parse(originalConfig);
    config.accounts['example-x'].platform = 'unsupported-platform';
    await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await assert.rejects(
      resolveAccount('example-x', { allowDisabled: true }),
      /Unsupported platform/
    );
  } finally {
    await writeFile(CONFIG_FILE, originalConfig, 'utf8');
    restoreEnv(env);
  }
});
