import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

async function workflowText() {
  return readFile(`${ROOT}.github/workflows/engagement.yml`, 'utf8');
}

test('engagement workflow restores runtime state from sns-ai-state before execution', async () => {
  const workflow = await workflowText();
  assert.match(workflow, /SNS_DURABLE_STATE_BRANCH:\s*sns-ai-state/);
  assert.match(workflow, /Restore durable engagement state/);
  assert.match(workflow, /refs\/remotes\/origin\/\$\{state_branch\}:\$\{path\}/);
  assert.match(workflow, /git show "refs\/remotes\/origin\/\$\{state_branch\}:\$\{path\}" > "\$path"/);
});

test('engagement workflow persists runtime state only to the durable state branch', async () => {
  const workflow = await workflowText();
  assert.match(workflow, /Persist privacy-safe engagement state to durable branch/);
  assert.match(workflow, /git worktree add --detach/);
  assert.match(workflow, /git push origin "HEAD:\$\{state_branch\}"/);
  assert.doesNotMatch(workflow, /git push origin "HEAD:\$\{GITHUB_REF_NAME\}"/);
  assert.doesNotMatch(workflow, /git pull --rebase origin "\$\{GITHUB_REF_NAME\}"/);
});

test('engagement workflow refuses to fall back to main when durable persistence is unavailable', async () => {
  const workflow = await workflowText();
  assert.match(workflow, /refusing to persist runtime state to main/i);
  assert.match(workflow, /data\/engagement-state\.json/);
  assert.match(workflow, /data\/engagement-audit\.jsonl/);
  assert.match(workflow, /data\/x-oauth2-state\.json/);
});
