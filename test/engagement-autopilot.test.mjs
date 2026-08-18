import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertAutomatedEngagementAllowed } from '../src/engagement/policy.mjs';
import { eventKey } from '../src/engagement/store.mjs';
import { __test as runTest } from '../src/engagement/run.mjs';
import { __test as aiTest } from '../src/engagement/ai.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const account = { id: 'music-tools-x', platform: 'x' };
const policy = {
  enabled: true,
  allowedAccounts: ['music-tools-x'],
  inboundOnly: true,
  autoReply: true,
  autoDmReply: true,
  approvalRequired: false,
  oneAutomatedResponsePerInteraction: true
};

test('allowlisted inbound replies can run without routine approval', () => {
  const result = assertAutomatedEngagementAllowed({
    account,
    globalPolicy: policy,
    event: { kind: 'reply', inbound: true }
  });
  assert.equal(result.allowed, true);
  assert.equal(result.approvalRequired, false);
});

test('cold engagement and non-allowlisted accounts remain fail-closed', () => {
  assert.throws(() => assertAutomatedEngagementAllowed({ account, globalPolicy: policy, event: { kind: 'reply', inbound: false } }), /unsolicited/i);
  assert.throws(() => assertAutomatedEngagementAllowed({ account: { id: 'other', platform: 'x' }, globalPolicy: policy, event: { kind: 'reply', inbound: true } }), /allowlisted/i);
});

test('deterministic delay stays human-like and stable for an interaction', () => {
  const config = { replyDelayMinutes: [6, 24], dmDelayMinutes: [4, 18] };
  const a = runTest.deterministicDelayMinutes('abc', 'reply', config);
  const b = runTest.deterministicDelayMinutes('abc', 'reply', config);
  assert.equal(a, b);
  assert.ok(a >= 6 && a <= 24);
  const dm = runTest.deterministicDelayMinutes('abc', 'dm', config);
  assert.ok(dm >= 4 && dm <= 18);
});

test('privacy-safe event keys do not embed provider ids or message text', () => {
  const key = eventKey('music-tools-x', { platform: 'x', kind: 'dm', id: '123456789', text: 'private message' });
  assert.match(key, /^[a-f0-9]{32}$/);
  assert.equal(key.includes('123456789'), false);
  assert.equal(key.includes('private'), false);
});

test('opt-out phrases are detected before generation', () => {
  assert.equal(runTest.optedOut('自動返信は不要です'), true);
  assert.equal(runTest.optedOut("don't reply again"), true);
  assert.equal(runTest.optedOut('ありがとう！'), false);
});

test('AI parser accepts strict JSON and extracts fenced JSON fallback', () => {
  assert.deepEqual(aiTest.parseJson('{"action":"ignore"}'), { action: 'ignore' });
  assert.deepEqual(aiTest.parseJson('```json\n{"action":"reply"}\n```'), { action: 'reply' });
});

test('engagement workflow persists only privacy-safe state files', async () => {
  const workflow = await readFile(`${ROOT}.github/workflows/engagement.yml`, 'utf8');
  assert.match(workflow, /data\/engagement-state\.json/);
  assert.match(workflow, /data\/engagement-audit\.jsonl/);
  assert.doesNotMatch(workflow, /engagement-inbox|dm-body|message-body/i);
});

test('chatops workflow exposes preflight and dry-run bridges', async () => {
  const workflow = await readFile(`${ROOT}.github/workflows/chatops.yml`, 'utf8');
  assert.match(workflow, /\[preflight\]/);
  assert.match(workflow, /\[dry-run\]/);
  assert.match(workflow, /orchestrate\.mjs.*--force --dry-run/s);
  assert.match(workflow, /live-preflight\.mjs/);
});
