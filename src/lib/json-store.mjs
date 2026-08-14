import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function readJsonl(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function readJsonlStrict(path, label = path) {
  try {
    const lines = (await readFile(path, 'utf8')).split('\n');
    const rows = [];
    for (const [index, line] of lines.entries()) {
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        const error = new Error(`${label} is malformed at line ${index + 1}; refusing to continue with incomplete safety data.`);
        error.code = 'JSONL_CORRUPT';
        error.line = index + 1;
        throw error;
      }
    }
    return rows;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}
