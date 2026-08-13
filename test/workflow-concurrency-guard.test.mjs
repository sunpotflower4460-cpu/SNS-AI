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
  // Flags allowed between "add"/"commit" and the actual pathspec/switch so `git add -- data/` and
  // `git add -A data/` are recognized the same as the plain `git add data/` every current workflow
  // uses - a future workflow that phrases its persist step slightly differently must not slip past
  // this guard undetected. `-\S*` only matches dash-prefixed tokens, so it can never itself consume the
  // literal `data/` pathspec and turn this into an unconditional match.
  const addsDataPath = /git\s+add\s+(?:-\S*\s+)*data\//.test(yaml);
  const commitsDataPath = /git\s+commit\s+[^\n]*?\bdata\//.test(yaml);
  // `git commit -a` (or `-am`/`--all`) stages every already-tracked modified file, which silently
  // includes any tracked data/ changes even with no explicit `data/` pathspec anywhere on the line.
  const commitsAllTracked = /git\s+commit\s+(?:\S+\s+)*(?:-a[m]?\b|--all\b)/.test(yaml);
  return addsDataPath || commitsDataPath || commitsAllTracked;
}

function declaresConcurrencyGroup(yaml, group) {
  const match = yaml.match(/^concurrency:\s*\n\s*group:\s*(\S+)/m);
  return Boolean(match) && match[1].replace(/^["']|["']$/g, '') === group;
}

// Scoped to only the lines that actually belong to the ROOT-level `concurrency:` mapping (the
// consecutive indented lines immediately following it) - not "cancel-in-progress: false" anywhere
// later in the file. Without this scoping, a job-level `concurrency:` block belonging to a completely
// different job (with its own, unrelated cancel-in-progress: false) could make this function wrongly
// report the root guard as safe even when the root mapping itself never sets cancel-in-progress: false
// (or sets it to true).
function rootConcurrencyBlock(yaml) {
  const match = yaml.match(/^concurrency:\r?\n((?:[ \t]+[^\n]*\r?\n?)*)/m);
  return match ? match[1] : '';
}

function declaresCancelInProgressFalse(yaml) {
  return /cancel-in-progress:\s*false/.test(rootConcurrencyBlock(yaml));
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

test('sanity: persistsRepoState recognizes flagged git add/commit variants, not just the plain form', () => {
  assert.equal(persistsRepoState('run: |\n  git add -- data/\n  git commit -m "x"\n'), true);
  assert.equal(persistsRepoState('run: |\n  git add -A data/\n  git commit -m "x"\n'), true);
  assert.equal(persistsRepoState('run: |\n  git add data/report.json\n  git commit -m "x" data/report.json\n'), true);
  assert.equal(persistsRepoState('run: |\n  git add data/report.json\n  git commit -am "x"\n'), true);
  assert.equal(persistsRepoState('run: |\n  git add src/index.mjs\n  git commit -m "unrelated code change"\n'), false);
});

test('sanity: declaresCancelInProgressFalse is not fooled by an unrelated job-level concurrency block', () => {
  // Root-level concurrency omits cancel-in-progress entirely (defaults to true in GitHub Actions), but
  // a DIFFERENT job further down declares its own unrelated concurrency block with cancel-in-progress:
  // false. The root guard must still be reported as unsafe - it is not actually cancel-in-progress:
  // false at the root, regardless of what an unrelated job-level block says.
  const rootOnlyGroupWithUnrelatedJobLevelFalse = [
    'concurrency:',
    `  group: ${REQUIRED_GROUP}`,
    'jobs:',
    '  other-job:',
    '    concurrency:',
    '      group: some-other-job-group',
    '      cancel-in-progress: false'
  ].join('\n');
  assert.equal(declaresConcurrencyGroup(rootOnlyGroupWithUnrelatedJobLevelFalse, REQUIRED_GROUP), true);
  assert.equal(
    declaresCancelInProgressFalse(rootOnlyGroupWithUnrelatedJobLevelFalse), false,
    'an unrelated job-level cancel-in-progress: false must not satisfy the root-level guard'
  );

  const rootDeclaresItToo = `${rootOnlyGroupWithUnrelatedJobLevelFalse.replace('  group: sns-ai-write', '  group: sns-ai-write\n  cancel-in-progress: false')}`;
  assert.equal(declaresCancelInProgressFalse(rootDeclaresItToo), true);
});
