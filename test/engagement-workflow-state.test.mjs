import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

async function workflowText() {
  return readFile(`${ROOT}.github/workflows/engagement.yml`, 'utf8');
}

async function chatopsText() {
  return readFile(`${ROOT}.github/workflows/chatops.yml`, 'utf8');
}

async function stateScriptText() {
  return readFile(`${ROOT}scripts/engagement-durable-state.sh`, 'utf8');
}

test('engagement workflow restores runtime state from sns-ai-state before execution', async () => {
  const workflow = await workflowText();
  const script = await stateScriptText();
  assert.match(workflow, /SNS_DURABLE_STATE_BRANCH:\s*sns-ai-state/);
  assert.match(workflow, /Restore durable engagement state/);
  assert.match(workflow, /engagement-durable-state\.sh restore/);
  assert.match(script, /refs\/remotes\/origin\/\$\{state_branch\}:\$\{path\}/);
  assert.match(script, /git show "refs\/remotes\/origin\/\$\{state_branch\}:\$\{path\}" > "\$path"/);
});

test('engagement workflow persists runtime state only to the durable state branch', async () => {
  const workflow = await workflowText();
  const script = await stateScriptText();
  assert.match(workflow, /Persist privacy-safe engagement state to durable branch/);
  assert.match(workflow, /engagement-durable-state\.sh persist/);
  assert.match(script, /git worktree add --detach/);
  assert.match(script, /git push origin "HEAD:\$\{state_branch\}"/);
  assert.doesNotMatch(script, /GITHUB_REF_NAME/);
});

test('engagement durable sync refuses to fall back to main and includes the delivery ledger', async () => {
  const script = await stateScriptText();
  assert.match(script, /refusing to persist runtime state to main/i);
  assert.match(script, /data\/engagement-state\.json/);
  assert.match(script, /data\/engagement-audit\.jsonl/);
  assert.match(script, /data\/x-oauth2-state\.json/);
  assert.match(script, /data\/engagement-delivery-ledger\.json/);
});

test('ChatOps engagement commands use the same durable state boundary', async () => {
  const workflow = await chatopsText();
  assert.match(workflow, /SNS_DURABLE_STATE_BRANCH:\s*sns-ai-state/);
  assert.match(workflow, /engagement-durable-state\.sh restore/);
  assert.match(workflow, /engagement-durable-state\.sh persist/);
  const persistIndex = workflow.indexOf('Persist durable engagement and OAuth state');
  const removeIndex = workflow.indexOf('Remove durable state workspace copies before main persistence');
  const mainPersistIndex = workflow.indexOf('Persist remaining safe runtime state');
  assert.ok(persistIndex >= 0 && removeIndex > persistIndex && mainPersistIndex > removeIndex);
  assert.match(workflow.slice(removeIndex, mainPersistIndex), /data\/engagement-delivery-ledger\.json/);
});
