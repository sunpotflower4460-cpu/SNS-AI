import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');

async function sourceModules(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceModules(path));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path);
  }
  return files;
}

test('every source module can be imported in a keyless runtime', async () => {
  const files = (await sourceModules(SRC)).sort();
  assert.ok(files.length > 20, `Expected a substantial source tree; found ${files.length} modules.`);
  const failures = [];
  for (const [index, path] of files.entries()) {
    try {
      await import(`${pathToFileURL(path).href}?import_all=${index}`);
    } catch (error) {
      failures.push(`${path}: ${error?.stack || error}`);
    }
  }
  assert.deepEqual(failures, []);
});
