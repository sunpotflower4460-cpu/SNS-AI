import test from 'node:test';
import assert from 'node:assert/strict';
import { runKeylessSmoke } from '../src/ops/smoke.mjs';
import { buildReadinessReport } from '../src/ops/doctor.mjs';

test('keyless smoke exercises scoring and strategy ranking', async () => {
  const result = await runKeylessSmoke();
  assert.equal(result.ok, true);
  assert.ok(result.syntheticScore > 50);
  assert.equal(result.winner, 'B');
});

test('readiness doctor never serializes secret values', async () => {
  const beforeOpenAI = process.env.OPENAI_API_KEY;
  const beforeCredentials = process.env.SOCIAL_CREDENTIALS_JSON;
  process.env.OPENAI_API_KEY = 'super-secret-openai-value';
  process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({ demo: { accessToken: 'super-secret-social-value' } });
  try {
    const report = await buildReadinessReport();
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('super-secret-openai-value'), false);
    assert.equal(serialized.includes('super-secret-social-value'), false);
    assert.equal(report.environment.openaiApiKeyPresent, true);
    assert.equal(report.environment.socialCredentialsPresent, true);
  } finally {
    if (beforeOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = beforeOpenAI;
    if (beforeCredentials === undefined) delete process.env.SOCIAL_CREDENTIALS_JSON; else process.env.SOCIAL_CREDENTIALS_JSON = beforeCredentials;
  }
});
