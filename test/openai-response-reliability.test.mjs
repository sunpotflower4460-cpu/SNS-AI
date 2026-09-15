import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { generatePost, __test as openaiTest } from '../src/lib/openai.mjs';
import { runAutopilot } from '../src/orchestrate.mjs';
import { getSlot } from '../src/lib/state.mjs';
import { circuitStatus } from '../src/ops/circuit.mjs';
import { readAudit } from '../src/lib/audit.mjs';

const { assertResponseComplete, unsupportedStructuredOutputError, responseUsageMetadata, recoverableResponseFeedback } = openaiTest;

const CONFIG_FILE = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const RUNTIME_POLICY_FILE = fileURLToPath(new URL('../config/runtime-policy.json', import.meta.url));
const DURABLE_DIR = fileURLToPath(new URL('../data/durable-claims/', import.meta.url));
const DATA_FILES = [
  'history.jsonl', 'metrics.jsonl', 'audit.jsonl', 'state.json', 'runtime-health.json',
  'brakes.json', 'usage-state.json', 'usage.jsonl'
].map((name) => fileURLToPath(new URL(`../data/${name}`, import.meta.url)));

function saveEnv(...names) { return Object.fromEntries(names.map((n) => [n, process.env[n]])); }
function restoreEnv(saved) { for (const [n, v] of Object.entries(saved)) v === undefined ? delete process.env[n] : process.env[n] = v; }
async function snapshotFiles(paths) {
  const saved = new Map();
  for (const path of paths) { try { saved.set(path, await readFile(path)); } catch (e) { if (e.code === 'ENOENT') saved.set(path, null); else throw e; } }
  return saved;
}
async function restoreFiles(saved) { for (const [path, bytes] of saved) { if (bytes === null) await rm(path, { force: true }); else await writeFile(path, bytes); } }

// -----------------------------------------------------------------------------------------------
// A/B/C: assertResponseComplete - the Responses API's own `status` field, checked BEFORE any
// JSON.parse. Reproduces (and fixes) the real SNS Autopilot #336 failure: a cut-off/failed response was
// previously fed straight into JSON.parse and surfaced only as an opaque "Expected ',' or ']'..." error.
// -----------------------------------------------------------------------------------------------
test('A: assertResponseComplete is a no-op for status "completed" and for any missing/unrecognized status (full backward compatibility with every pre-existing mocked response)', () => {
  assert.doesNotThrow(() => assertResponseComplete({ status: 'completed' }, {}));
  assert.doesNotThrow(() => assertResponseComplete({}, {}));
  assert.doesNotThrow(() => assertResponseComplete(undefined, {}));
});

test('B: assertResponseComplete throws typed OPENAI_RESPONSE_INCOMPLETE for status "incomplete", capturing safe usage/reason metadata and no raw model text', () => {
  const response = {
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    usage: { output_tokens: 3000, output_tokens_details: { reasoning_tokens: 2400 } },
    output_text: '{"candidates": [ this would have been fed straight into JSON.parse before'
  };
  assert.throws(() => assertResponseComplete(response, { max_output_tokens: 3000 }), (error) => {
    assert.equal(error.code, 'OPENAI_RESPONSE_INCOMPLETE');
    assert.equal(error.responseStatus, 'incomplete');
    assert.equal(error.incompleteReason, 'max_output_tokens');
    assert.equal(error.requestedMaxOutputTokens, 3000);
    assert.equal(error.outputTokens, 3000);
    assert.equal(error.reasoningTokens, 2400);
    assert.equal(error.text, undefined, 'no raw model output is ever attached to the error');
    assert.doesNotMatch(String(error.message), /this would have been fed/);
    return true;
  });
});

test('B2: assertResponseComplete records whatever incomplete_details.reason the API actually reports, without hardcoding "max_output_tokens" as the only possible cause', () => {
  assert.throws(() => assertResponseComplete({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, {}), (error) => {
    assert.equal(error.incompleteReason, 'content_filter');
    return true;
  });
  assert.throws(() => assertResponseComplete({ status: 'incomplete' }, {}), (error) => {
    assert.equal(error.incompleteReason, null, 'a missing reason must be recorded as null, never guessed');
    return true;
  });
});

test('C: assertResponseComplete throws typed OPENAI_RESPONSE_FAILED for status "failed"', () => {
  assert.throws(() => assertResponseComplete({ status: 'failed', error: { code: 'server_error', message: 'The model failed to generate output.' } }, {}), (error) => {
    assert.equal(error.code, 'OPENAI_RESPONSE_FAILED');
    assert.equal(error.responseStatus, 'failed');
    assert.equal(error.providerErrorCode, 'server_error');
    return true;
  });
});

test('responseUsageMetadata extracts output/reasoning token counts and tolerates missing usage (never throws, never fabricates a number)', () => {
  assert.deepEqual(responseUsageMetadata({ usage: { output_tokens: 500, output_tokens_details: { reasoning_tokens: 120 } } }), { outputTokens: 500, reasoningTokens: 120 });
  assert.deepEqual(responseUsageMetadata({}), { outputTokens: null, reasoningTokens: null });
  assert.deepEqual(responseUsageMetadata(undefined), { outputTokens: null, reasoningTokens: null });
});

// -----------------------------------------------------------------------------------------------
// F: the generic-400 fallback trigger is a narrow allowlist, not "any 400".
// -----------------------------------------------------------------------------------------------
test('F: unsupportedStructuredOutputError only matches errors that specifically name the structured-output request shape as the problem', () => {
  assert.equal(unsupportedStructuredOutputError({ status: 400, body: { error: { param: 'text.format', message: 'x' } } }), true);
  assert.equal(unsupportedStructuredOutputError({ status: 400, body: { error: { param: 'response_format', message: 'x' } } }), true);
  assert.equal(unsupportedStructuredOutputError({ status: 400, body: { error: { message: 'This model does not support response_format of type json_schema.' } } }), true);
  assert.equal(unsupportedStructuredOutputError({ status: 400, body: { error: { message: 'Invalid value for model: not-a-real-model' } } }), false);
  assert.equal(unsupportedStructuredOutputError({ status: 400, body: { error: { message: 'content_policy_violation' } } }), false);
  assert.equal(unsupportedStructuredOutputError({ status: 400, body: { error: {} } }), false);
});

test('recoverableResponseFeedback gives distinct, schema-focused guidance for each recoverable code and never implies maxOutputTokens was changed', () => {
  const incompleteError = Object.assign(new Error('x'), { code: 'OPENAI_RESPONSE_INCOMPLETE' });
  const malformedError = Object.assign(new Error('x'), { code: 'OPENAI_STRUCTURED_OUTPUT_INVALID' });
  const incompleteFeedback = recoverableResponseFeedback(incompleteError);
  const malformedFeedback = recoverableResponseFeedback(malformedError);
  assert.notEqual(incompleteFeedback, malformedFeedback);
  for (const feedback of [incompleteFeedback, malformedFeedback]) {
    assert.match(feedback, /valid|complete|JSON/i);
    assert.doesNotMatch(feedback, /max_output_tokens|token limit|increased|budget/i);
  }
});

// -----------------------------------------------------------------------------------------------
// generatePost()-level integration: end-to-end through responseJson()/requestAndParse(), covering
// D (malformed-but-completed), H/I (bounded retry for the two recoverable codes, never exceeding
// maxAttempts), C2 (a "failed" status is never treated as recoverable), and E/F/G (the generic-400
// fallback, narrowed and Plugin-Radar-exempt).
// -----------------------------------------------------------------------------------------------
function pluginRadarAccount(overrides = {}) {
  return {
    platform: 'x', contentStrategy: 'plugin-radar',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    safety: { moderation: false, maxLinks: 1, maxHashtags: 2 },
    generation: { model: 'gpt-5.6-luna', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 3, candidateCount: 1, maxOutputTokens: 1000 },
    learning: { enabled: false, exploreRate: 0 },
    research: { webSearch: false },
    budgets: { enabled: false },
    ...overrides
  };
}

function genericAccount(overrides = {}) {
  return {
    platform: 'x',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    safety: { moderation: false, maxLinks: 1, maxHashtags: 2 },
    generation: { model: 'gpt-5.6-luna', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 3, candidateCount: 1, maxOutputTokens: 1000 },
    learning: { enabled: false, exploreRate: 0 },
    research: { webSearch: false },
    budgets: { enabled: false },
    ...overrides
  };
}

function candidateBody(text, { spreadPotential = 60, noveltyPotential = 60, trendUsed = false, trendEvidenceIndex = null } = {}) {
  return JSON.stringify({ candidates: [{
    text, mediaPrompt: '', rationale: 'response reliability coverage', spreadPotential, noveltyPotential,
    features: { topic: 'test', angle: 'gate', hook: 'statement', emotion: 'neutral', format: 'short', cta: 'none', mediaDecision: 'none', trendUsed, trendEvidenceIndex }
  }] });
}
function completedResponse(text, opts) { return { status: 200, body: { status: 'completed', output_text: candidateBody(text, opts) } }; }
function incompleteResponse(reason = 'max_output_tokens') {
  return { status: 200, body: { status: 'incomplete', incomplete_details: { reason }, usage: { output_tokens: 3000, output_tokens_details: { reasoning_tokens: 2600 } } } };
}
function failedResponse(message = 'The model failed to generate a response.', code = 'server_error') {
  return { status: 200, body: { status: 'failed', error: { message, code } } };
}
function malformedCompletedResponse() { return { status: 200, body: { status: 'completed', output_text: '{"candidates": [ this is not valid JSON' } }; }
function http400(message, param) { return { status: 400, body: { error: { message, param } } }; }

async function withMockedResponses(sequence, fn) {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  let calls = 0;
  const requestBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === 'https://api.openai.com/v1/responses') {
      const entry = sequence[Math.min(calls, sequence.length - 1)];
      calls += 1;
      if (options.body) requestBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify(entry.body), { status: entry.status, headers: { 'content-type': 'application/json' } });
    }
    if (target === 'https://api.openai.com/v1/moderations') {
      return new Response(JSON.stringify({ results: [{ flagged: false, categories: {} }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected mocked URL: ${target}`);
  };
  try { return await fn(() => calls, requestBodies); }
  finally { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey; }
}

test('A2: a normal status:"completed" response still generates successfully end-to-end (baseline, unchanged by this fix)', async () => {
  const account = pluginRadarAccount();
  await withMockedResponses([completedResponse('All good.')], async (calls) => {
    const result = await generatePost('music-tools-x', account, [], {});
    assert.equal(result.text, 'All good.');
    assert.equal(calls(), 1);
  });
});

test('D: a completed-but-malformed response is never fed raw into a caller-visible SyntaxError - it is classified as OPENAI_STRUCTURED_OUTPUT_INVALID with no raw model text attached', async () => {
  const account = pluginRadarAccount({ generation: { ...pluginRadarAccount().generation, maxAttempts: 1 } });
  await withMockedResponses([malformedCompletedResponse()], async (calls) => {
    await assert.rejects(generatePost('music-tools-x', account, [], {}), (error) => {
      assert.equal(error.code, 'OPENAI_STRUCTURED_OUTPUT_INVALID');
      assert.equal(error.responseStatus, 'completed');
      assert.equal(error.structuredMode, 'json_schema');
      assert.equal(error.message, 'OpenAI structured output was not valid JSON.');
      assert.ok(!(error instanceof SyntaxError), 'must never let a raw SyntaxError propagate');
      return true;
    });
    assert.equal(calls(), 1);
  });
});

test('H: OPENAI_RESPONSE_INCOMPLETE (max_output_tokens) on the first attempt gets exactly one bounded retry inside the existing maxAttempts budget, and a valid second attempt is returned', async () => {
  const account = pluginRadarAccount({ generation: { ...pluginRadarAccount().generation, maxAttempts: 3 } });
  await withMockedResponses([incompleteResponse('max_output_tokens'), completedResponse('Recovered after truncation.')], async (calls) => {
    const result = await generatePost('music-tools-x', account, [], {});
    assert.equal(result.text, 'Recovered after truncation.');
    assert.equal(calls(), 2, 'exactly one bounded retry, not more');
  });
});

test('I: OPENAI_RESPONSE_INCOMPLETE on the final available attempt propagates immediately and never exceeds maxAttempts worth of API calls', async () => {
  const account = pluginRadarAccount({ generation: { ...pluginRadarAccount().generation, maxAttempts: 2 } });
  await withMockedResponses([incompleteResponse('max_output_tokens'), incompleteResponse('max_output_tokens')], async (calls) => {
    await assert.rejects(generatePost('music-tools-x', account, [], {}), (error) => {
      assert.equal(error.code, 'OPENAI_RESPONSE_INCOMPLETE');
      assert.equal(error.incompleteReason, 'max_output_tokens');
      return true;
    });
    assert.equal(calls(), 2, 'bounded by maxAttempts (2), never a new unbounded retry loop');
  });
});

test('D2: OPENAI_STRUCTURED_OUTPUT_INVALID also gets exactly one bounded retry, sharing the same maxAttempts budget as the incomplete-response retry', async () => {
  const account = pluginRadarAccount({ generation: { ...pluginRadarAccount().generation, maxAttempts: 3 } });
  await withMockedResponses([malformedCompletedResponse(), completedResponse('Valid on retry.')], async (calls) => {
    const result = await generatePost('music-tools-x', account, [], {});
    assert.equal(result.text, 'Valid on retry.');
    assert.equal(calls(), 2);
  });
});

test('mixed recoverable errors (incomplete, then malformed) still never exceed the shared maxAttempts budget', async () => {
  const account = pluginRadarAccount({ generation: { ...pluginRadarAccount().generation, maxAttempts: 2 } });
  await withMockedResponses([incompleteResponse('max_output_tokens'), malformedCompletedResponse()], async (calls) => {
    await assert.rejects(generatePost('music-tools-x', account, [], {}), (error) => {
      assert.equal(error.code, 'OPENAI_STRUCTURED_OUTPUT_INVALID');
      return true;
    });
    assert.equal(calls(), 2);
  });
});

test('C2: OPENAI_RESPONSE_FAILED is never treated as recoverable, even with attempts remaining - it is a provider outage signal, not a fixable output problem', async () => {
  const account = pluginRadarAccount({ generation: { ...pluginRadarAccount().generation, maxAttempts: 3 } });
  await withMockedResponses([failedResponse(), completedResponse('Should never be requested.')], async (calls) => {
    await assert.rejects(generatePost('music-tools-x', account, [], {}), (error) => {
      assert.equal(error.code, 'OPENAI_RESPONSE_FAILED');
      return true;
    });
    assert.equal(calls(), 1, 'a "failed" status must not consume a bounded retry meant for recoverable output errors');
  });
});

test('E: a generic 400 unrelated to structured-output support is never treated as a schema-drop trigger', async () => {
  const account = genericAccount();
  await withMockedResponses([http400('Invalid value for model: not-a-real-model', 'model')], async (calls) => {
    await assert.rejects(generatePost('some-account', account, [], {}), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
    assert.equal(calls(), 1, 'no unconditional schema-drop-and-retry for an unrelated 400');
  });
});

test('F/G: a 400 that specifically names the structured-output request shape as unsupported falls back to json_object mode (never fully unstructured text) for a non-Plugin-Radar account', async () => {
  const account = genericAccount();
  await withMockedResponses([
    http400('This model does not support response_format of type json_schema.', 'text.format'),
    completedResponse('Fallback succeeded.')
  ], async (calls, bodies) => {
    const result = await generatePost('some-account', account, [], {});
    assert.equal(result.text, 'Fallback succeeded.');
    assert.equal(calls(), 2);
    assert.equal(bodies[1].text.format.type, 'json_object', 'fallback must keep JSON validity via json_object mode, never drop schema entirely to free text');
  });
});

test('Plugin Radar always fails closed on a 400, even one that would otherwise qualify for the json_object fallback - the evidence-binding schema enforcement it depends on must never be silently bypassed', async () => {
  const account = pluginRadarAccount({ generation: { ...pluginRadarAccount().generation, maxAttempts: 1 } });
  await withMockedResponses([http400('This model does not support response_format of type json_schema.', 'text.format')], async (calls) => {
    await assert.rejects(generatePost('music-tools-x', account, [], {}), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
    assert.equal(calls(), 1, 'must never fall back to an unstructured/json_object retry for Plugin Radar');
  });
});

// -----------------------------------------------------------------------------------------------
// L: dry-run isolation, and circuit accounting for genuine response-reliability failures. Unlike
// CONTENT_QUALITY_BELOW_THRESHOLD (an intentional editorial decision - see plugin-radar-quality-gate.
// test.mjs), these codes represent a real provider-reliability problem, so they DO count toward the
// resilience circuit on a live run, exactly like any other pre-existing unclassified failure.
// -----------------------------------------------------------------------------------------------
function baseReliabilityAccount(overrides = {}) {
  return {
    platform: 'x', enabled: true, mode: 'auto', credentialKey: 'reliability-x', displayName: 'Reliability X',
    contentStrategy: 'plugin-radar',
    profile: { identity: 'test', goal: 'test', audience: 'test', topics: ['test'], style: ['clear'], avoid: [] },
    instructions: 'Generate one test post.',
    schedule: { timezone: 'Asia/Tokyo', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], times: ['08:00'], windowMinutes: 30 },
    generation: { model: 'gpt-5.6-luna', maxChars: 280, historyWindow: 5, duplicateThreshold: 0.72, maxAttempts: 1, candidateCount: 1, maxOutputTokens: 1000 },
    safety: { moderation: false, maxPostsPerDay: 10, minMinutesBetweenPosts: 0, anomalyBrake: { enabled: false } },
    analytics: { enabled: false }, learning: { enabled: false, exploreRate: 0, humanFeedbackWindow: 5 },
    research: { webSearch: false, trendIntelligence: false },
    resilience: { enabled: true, failureThreshold: 5, cooldownMinutes: 60 },
    budgets: { enabled: false }, experiments: { enabled: false }, media: { strategy: 'none', type: 'image' },
    ...overrides
  };
}
async function installReliabilityAccount(accountId, overrides) {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  config.accounts[accountId] = baseReliabilityAccount({ credentialKey: accountId, displayName: accountId, ...overrides });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
function alwaysIncompleteFetch() {
  return async (url) => {
    const target = String(url);
    if (target === 'https://api.openai.com/v1/responses') {
      return new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 3000, output_tokens_details: { reasoning_tokens: 2800 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/data\/durable-claims\//.test(target)) {
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected mocked URL: ${target}`);
  };
}

test('L: a dry-run failure from a genuine response-reliability error never touches live slot state or the resilience circuit', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installReliabilityAccount('reliability-dry-run', { mode: 'auto' });
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({});
    globalThis.fetch = alwaysIncompleteFetch();

    const now = new Date('2026-08-13T00:00:00+09:00');
    const report = await runAutopilot({ accountFilter: 'reliability-dry-run', force: true, dryRun: true, now });
    assert.equal(report[0].status, 'failed');
    assert.equal(report[0].error, 'OpenAI response was incomplete (max_output_tokens).');

    const status = await circuitStatus('reliability-dry-run', 'autopilot', { enabled: true, failureThreshold: 5, cooldownMinutes: 60 });
    assert.equal(status.open, false);
    assert.equal(Number(status.failures || 0), 0, 'a dry-run preview failure must never increment the live autopilot circuit');

    const slotId = `reliability-dry-run:manual:${now.toISOString().slice(0, 16)}`;
    assert.equal(await getSlot(slotId), null, 'dry-run must never persist any slot state');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});

test('circuit accounting: a live, exhausted-retries response-reliability failure DOES count toward the resilience circuit, and the audit trail carries typed diagnostics without raw model output', async () => {
  const previousFetch = globalThis.fetch;
  const env = saveEnv('OPENAI_API_KEY', 'SOCIAL_CREDENTIALS_JSON');
  const files = await snapshotFiles([CONFIG_FILE, ...DATA_FILES]);
  try {
    for (const path of DATA_FILES) await rm(path, { force: true });
    await rm(DURABLE_DIR, { recursive: true, force: true });
    await installReliabilityAccount('reliability-circuit', { mode: 'auto' });
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.SOCIAL_CREDENTIALS_JSON = JSON.stringify({});
    globalThis.fetch = alwaysIncompleteFetch();

    const now = new Date('2026-08-13T00:00:00+09:00');
    const report = await runAutopilot({ accountFilter: 'reliability-circuit', force: true, dryRun: false, now });
    assert.equal(report[0].status, 'failed');

    const status = await circuitStatus('reliability-circuit', 'autopilot', { enabled: true, failureThreshold: 5, cooldownMinutes: 60 });
    assert.equal(Number(status.failures || 0), 1, 'unlike an intentional quality-no-post, a genuine response-reliability failure must count toward the resilience circuit');

    const audit = await readAudit();
    const row = audit.find((entry) => entry.account === 'reliability-circuit' && entry.stage === 'autopilot-error');
    assert.ok(row, 'a generic autopilot-error audit row must be recorded');
    assert.equal(row.code, 'OPENAI_RESPONSE_INCOMPLETE');
    assert.equal(row.responseStatus, 'incomplete');
    assert.equal(row.incompleteReason, 'max_output_tokens');
    assert.equal(row.dryRun, false);
    assert.ok(!('outputText' in row) && !('rawText' in row) && !('text' in row), 'no raw model output text may ever be written to the audit trail');
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv(env);
    await restoreFiles(files);
    await rm(DURABLE_DIR, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------------------------
// M/N/O: safety invariants - Manual-Only posture, music-tools-x's own posture, and every other
// account's disabled state are all untouched by this fix.
// -----------------------------------------------------------------------------------------------
test('M/N/O: Manual-Only posture, music-tools-x posture, and every other account remain untouched', async () => {
  const runtimePolicy = JSON.parse(await readFile(RUNTIME_POLICY_FILE, 'utf8'));
  assert.equal(runtimePolicy.manualOnly, true);
  assert.equal(runtimePolicy.requireExplicitManualInvocation, true);
  assert.equal(runtimePolicy.allowAutomaticAccountActivation, false);
  assert.equal(runtimePolicy.allowAutomaticEngagement, false);
  assert.equal(runtimePolicy.allowScheduledProviderPolling, false);

  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  const musicToolsX = config.accounts['music-tools-x'];
  assert.equal(musicToolsX.enabled, true);
  assert.equal(musicToolsX.mode, 'approval');
  const others = Object.entries(config.accounts).filter(([id]) => id !== 'music-tools-x');
  assert.equal(others.length, 7, 'expected exactly 7 other accounts');
  for (const [id, account] of others) {
    assert.equal(account.enabled, false, `${id} must stay disabled`);
    assert.equal(account.mode, 'pause', `${id} must stay paused`);
  }
});
