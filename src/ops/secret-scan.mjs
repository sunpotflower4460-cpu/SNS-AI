import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROOTS = ['src', 'test', 'config', 'data', '.github', 'docs', 'README.md', 'package.json'];
const SKIP = new Set(['node_modules', '.git']);
const PATTERNS = [
  ['OpenAI-style API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Meta/Instagram access token', /\bEAA[A-Za-z0-9]{20,}\b/g],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['Bearer token literal', /Bearer\s+[A-Za-z0-9._~+\/-]{30,}/g]
];

async function filesAt(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const out = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) out.push(...await filesAt(child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function redact(match) {
  if (match.length <= 10) return '[redacted]';
  return `${match.slice(0, 4)}…${match.slice(-4)}`;
}

export async function scanSecrets() {
  const files = [];
  for (const root of ROOTS) {
    try { files.push(...await filesAt(join(ROOT, root))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const findings = [];
  for (const path of files) {
    let text;
    try { text = await readFile(path, 'utf8'); } catch { continue; }
    for (const [name, pattern] of PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const prefix = text.slice(0, match.index).split('\n');
        findings.push({ file: relative(ROOT, path), line: prefix.length, type: name, sample: redact(match[0]) });
      }
    }
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = await scanSecrets();
  if (findings.length) {
    console.error(JSON.stringify({ ok: false, findings }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, findings: [] }, null, 2));
  }
}
