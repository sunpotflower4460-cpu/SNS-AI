import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertAutomatedEngagementAllowed } from '../src/engagement/policy.mjs';
import { eventKey } from '../src/engagement/store.mjs';
import { hardHumanCategory, __test as aiTest } from '../src/engagement/ai.mjs';
import { __test as runTest } from '../src/engagement/run.mjs';

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
  const config = { replyDelayMinutes: [8, 35], dmDelayMinutes: [12, 50] };
  const a = runTest.deterministicDelayMinutes('abc', 'reply', config);
  const b = runTest.deterministicDelayMinutes('abc', 'reply', config);
  assert.equal(a, b);
  assert.ok(a >= 8 && a <= 35);
  const dm = runTest.deterministicDelayMinutes('abc', 'dm', config);
  assert.ok(dm >= 12 && dm <= 50);
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

test('deterministic high-risk categories force human handling before model judgment', () => {
  assert.equal(hardHumanCategory('返金トラブルについて確認したいです'), 'refund_or_payment_dispute');
  assert.equal(hardHumanCategory('契約書を送るのでスポンサー契約したいです'), 'legal');
  assert.equal(hardHumanCategory('普通におすすめを教えてください'), null);
});

test('AI parser accepts strict JSON and extracts fenced JSON fallback', () => {
  assert.deepEqual(aiTest.parseJson('{"action":"ignore"}'), { action: 'ignore' });
  assert.deepEqual(aiTest.parseJson('```json\n{"action":"reply"}\n```'), { action: 'reply' });
  const normalized = aiTest.normalizeResult({ action: 'human', confidence: 5, humanSummary: 'summary', humanQuestion: 'question' });
  assert.equal(normalized.action, 'human');
  assert.equal(normalized.confidence, 1);
  assert.equal(normalized.humanSummary, 'summary');
});

test('X event normalization excludes the account itself and keeps inbound routes ephemeral', () => {
  const events = runTest.xEvents('music-tools-x', '1', {
    data: [
      { id: '10', author_id: '2', text: 'hello', created_at: '2026-08-18T00:00:00Z' },
      { id: '11', author_id: '1', text: 'self', created_at: '2026-08-18T00:00:00Z' }
    ],
    includes: { users: [{ id: '2', username: 'listener' }] }
  }, {
    data: [
      { id: '20', event_type: 'MessageCreate', sender_id: '3', text: 'private', created_at: '2026-08-18T00:00:00Z' },
      { id: '21', event_type: 'MessageCreate', sender_id: '1', text: 'self dm', created_at: '2026-08-18T00:00:00Z' }
    ]
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].public, true);
  assert.equal(events[1].public, false);
  assert.equal(events[1].participantId, '3');
});

test('Instagram media discovery deduplicates recent published provider ids', () => {
  const ids = runTest.instagramMediaIds([
    { account: 'music-tools-x', status: 'published', providerPostId: '1' },
    { account: 'other', status: 'published', providerPostId: '2' },
    { account: 'music-tools-x', status: 'published', providerPostId: '1' },
    { account: 'music-tools-x', status: 'published', providerPostId: '3' }
  ], 'music-tools-x');
  assert.deepEqual(ids, ['3', '1']);
});

test('engagement workflow persists only privacy-safe state files', async () => {
  const workflow = await readFile(`${ROOT}.github/workflows/engagement.yml`, 'utf8');
  assert.match(workflow, /data\/engagement-state\.json/);
  assert.match(workflow, /data\/engagement-audit\.jsonl/);
  assert.doesNotMatch(workflow, /engagement-inbox|dm-body|message-body/i);
});

test('chatops workflow exposes preflight, dry-run and public engagement resolution bridges', async () => {
  const workflow = await readFile(`${ROOT}.github/workflows/chatops.yml`, 'utf8');
  assert.match(workflow, /\[preflight\]/);
  assert.match(workflow, /\[dry-run\]/);
  assert.match(workflow, /engagement-resolve/);
  assert.match(workflow, /--resolve-file engagement-resolve\.json/);
  assert.match(workflow, /orchestrate\.mjs.*--force --dry-run/s);
  assert.match(workflow, /live-preflight\.mjs/);
  assert.match(workflow, /REDACTED_OPENAI_KEY/);
});
