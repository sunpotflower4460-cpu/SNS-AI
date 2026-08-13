import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// This is the single biggest cross-runner safety net in the whole system: every workflow that
// persists mutated data/ state back to the repository (autopilot, publish, feedback, health,
// intelligence, learning, maintenance, metrics, policy, preflight) shares the SAME GitHub Actions
// concurrency group ("sns-ai-write", cancel-in-progress: false), which serializes them repo-wide.
// That is what actually prevents two runners from racing to claim/publish the same slot, corrupt the
// same JSON store, or double-spend the same budget counter in production - the in-code optimistic
// concurrency (durable-claim sha checks, atomic JSON writes, in-process mutation queues) is defense in
// depth on top of it, not a substitute for it.
//
// This test has no opinion about *which* workflows should mutate data/ - it only asserts that ANY
// workflow that does (detected by a `git add data/` / `git commit ... data/` step, the pattern every
// existing "persist state" step uses) also declares the shared concurrency group. A future workflow
// that adds a "persist state" step without copying the concurrency block would silently reintroduce
// the exact cross-runner races this repo has spent multiple hardening passes closing - this test
// fails loudly instead.

const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const REQUIRED_GROUP = 'sns-ai-write';

function persistsRepoState(yaml) {
  return /git\s+add\s+data\/|git\s+commit[^\n]*data\//.test(yaml);
}

function declaresConcurrencyGroup(yaml, group) {
  const match = yaml.match(/^concurrency:\s*\n\s*group:\s*(\S+)/m);
  return Boolean(match) && match[1].replace(/^["']|["']$/g, '') === group;
}

function declaresCancelInProgressFalse(yaml) {
  return /^concurrency:[\s\S]*?cancel-in-progress:\s*false/m.test(yaml);
}

test('every workflow that persists data/ state back to the repo shares the sns-ai-write concurrency group', async () => {
  const files = (await readdir(WORKFLOWS_DIR)).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, 'expected to find workflow files to check');

  const missing = [];
  for (const file of files) {
    const yaml = await readFile(`${WORKFLOWS_DIR}${file}`, 'utf8');
    if (!persistsRepoState(yaml)) continue;
    if (!declaresConcurrencyGroup(yaml, REQUIRED_GROUP)) missing.push({ file, reason: `missing "concurrency: group: ${REQUIRED_GROUP}"` });
    else if (!declaresCancelInProgressFalse(yaml)) missing.push({ file, reason: 'concurrency group present but cancel-in-progress is not false (a cancelled run could leave data/ mid-write)' });
  }

  assert.deepEqual(missing, [], `workflow(s) persist data/ state without the shared concurrency guard:\n${JSON.stringify(missing, null, 2)}`);
});

test('sanity: this test can actually detect a missing concurrency group', () => {
  const withoutGroup = 'name: x\non: push\njobs:\n  a:\n    steps:\n      - run: |\n          git add data/\n          git commit -m "x"\n';
  assert.equal(persistsRepoState(withoutGroup), true);
  assert.equal(declaresConcurrencyGroup(withoutGroup, REQUIRED_GROUP), false);

  const withWrongGroup = `concurrency:\n  group: something-else\n  cancel-in-progress: false\n${withoutGroup}`;
  assert.equal(declaresConcurrencyGroup(withWrongGroup, REQUIRED_GROUP), false);

  const withCancelTrue = `concurrency:\n  group: ${REQUIRED_GROUP}\n  cancel-in-progress: true\n${withoutGroup}`;
  assert.equal(declaresConcurrencyGroup(withCancelTrue, REQUIRED_GROUP), true);
  assert.equal(declaresCancelInProgressFalse(withCancelTrue), false);
});
