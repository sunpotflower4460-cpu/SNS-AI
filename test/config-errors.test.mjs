import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCredentials, resolveAccount } from '../src/lib/config.mjs';

function saveEnv(name) {
  return process.env[name];
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('credential parsing fails closed for missing and malformed secrets', () => {
  const previous = saveEnv('SOCIAL_CREDENTIALS_JSON');
  try {
    delete process.env.SOCIAL_CREDENTIALS_JSON;
    assert.throws(() => loadCredentials(), /Missing SOCIAL_CREDENTIALS_JSON/);

    process.env.SOCIAL_CREDENTIALS_JSON = '{not-json';
    assert.throws(() => loadCredentials(), /not valid JSON/);

    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ demo: { token: 'value' } });
    assert.deepEqual(loadCredentials(), { demo: { token: 'value' } });
  } finally {
    restoreEnv('SOCIAL_CREDENTIALS_JSON', previous);
  }
});

test('account resolution rejects missing, unknown, disabled, and missing-credential accounts', async () => {
  const previous = saveEnv('SOCIAL_CREDENTIALS_JSON');
  try {
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({});
    await assert.rejects(resolveAccount(), /Missing account ID/);
    await assert.rejects(resolveAccount('does-not-exist', { allowDisabled: true }), /Unknown account/);
    await assert.rejects(resolveAccount('example-x'), /disabled/);
    await assert.rejects(resolveAccount('example-x', { allowDisabled: true }), /No credentials found/);
  } finally {
    restoreEnv('SOCIAL_CREDENTIALS_JSON', previous);
  }
});
