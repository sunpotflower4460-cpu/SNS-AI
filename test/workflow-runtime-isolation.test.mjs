import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const WORKFLOWS = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

const TEST_ONLY_WORKFLOWS = new Set(['ci.yml']);

async function runtimeWorkflowSources() {
  const names = (await readdir(WORKFLOWS)).filter((name) => /\.ya?ml$/i.test(name) && !TEST_ONLY_WORKFLOWS.has(name));
  return Promise.all(names.map(async (name) => [name, await readFile(join(WORKFLOWS, name), 'utf8')]));
}

test('full unit/E2E suites never execute inside live runtime workflows', async () => {
  for (const [name, source] of await runtimeWorkflowSources()) {
    assert.doesNotMatch(source, /\bnpm\s+test\b/, `${name} must delegate full tests to ci.yml`);
    assert.doesNotMatch(source, /\bnpm\s+run\s+smoke\b/, `${name} must not run state-mutating smoke tests in production runtime`);
  }
});

test('Autopilot and Publish persistence only follows an attempted runtime action', async () => {
  const autopilot = await readFile(join(WORKFLOWS, 'autopilot.yml'), 'utf8');
  const publish = await readFile(join(WORKFLOWS, 'publish.yml'), 'utf8');

  assert.match(autopilot, /id:\s*autopilot_run/);
  assert.match(autopilot, /steps\.autopilot_run\.outcome\s*!=\s*'skipped'/);
  assert.match(publish, /id:\s*publish_run/);
  assert.match(publish, /steps\.publish_run\.outcome\s*!=\s*'skipped'/);
});
