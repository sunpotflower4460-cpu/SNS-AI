import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseFeed, fetchRssSource } from '../src/research/sources/rss.mjs';
import { fetchGithubReleasesSource } from '../src/research/sources/github-releases.mjs';
import { validateResearchSources, sourcesForAccount } from '../src/research/sources/registry.mjs';
import { normalizeCandidate, candidateHash } from '../src/research/sources/normalize.mjs';
import { runDirectFetch } from '../src/research/fetch-pipeline.mjs';
import { loadResearchCache, saveResearchCache, markEvaluated } from '../src/research/cache.mjs';

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Vendor Feed</title>
  <item>
    <title>New Plugin 2.0 Released</title>
    <link>https://vendor.example/plugin-2</link>
    <guid>https://vendor.example/plugin-2</guid>
    <pubDate>Wed, 26 Aug 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[A <b>great</b> new plugin &amp; friends]]></description>
  </item>
  <item>
    <title>Old News</title>
    <link>https://vendor.example/old</link>
    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    <description>Nothing new.</description>
  </item>
</channel></rss>`;

const ATOM_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom Entry</title>
    <link href="https://vendor.example/atom-entry"/>
    <updated>2026-08-27T00:00:00Z</updated>
    <summary>An atom summary</summary>
    <id>urn:uuid:1</id>
  </entry>
</feed>`;

test('parseFeed extracts RSS 2.0 items with decoded/stripped HTML', () => {
  const items = parseFeed(RSS_XML);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'New Plugin 2.0 Released');
  assert.equal(items[0].url, 'https://vendor.example/plugin-2');
  assert.equal(items[0].publishedAt, new Date('Wed, 26 Aug 2026 10:00:00 GMT').toISOString());
  assert.match(items[0].summary, /A great new plugin & friends/);
});

test('parseFeed extracts Atom entries', () => {
  const items = parseFeed(ATOM_XML);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Atom Entry');
  assert.equal(items[0].url, 'https://vendor.example/atom-entry');
  assert.equal(items[0].summary, 'An atom summary');
});

test('fetchRssSource fetches, parses, and normalizes candidates, capped at maxItems', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://feed.example/rss.xml');
      return new Response(RSS_XML, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    };
    const source = { id: 'vendor-feed', type: 'rss', url: 'https://feed.example/rss.xml', vendor: 'Vendor', maxItems: 1, categories: ['news'] };
    const candidates = await fetchRssSource(source);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].sourceId, 'vendor-feed');
    assert.equal(candidates[0].sourceType, 'rss');
    assert.equal(candidates[0].vendor, 'Vendor');
    assert.deepEqual(candidates[0].categories, ['news']);
    assert.equal(candidates[0].url, 'https://vendor.example/plugin-2');
  } finally { globalThis.fetch = previousFetch; }
});

test('fetchRssSource surfaces a clear error on non-2xx responses', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('not found', { status: 404 });
    await assert.rejects(fetchRssSource({ id: 'broken', type: 'rss', url: 'https://feed.example/missing.xml' }), /HTTP 404/);
  } finally { globalThis.fetch = previousFetch; }
});

test('fetchGithubReleasesSource normalizes GitHub releases and skips drafts', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/acme\/plugin\/releases\?per_page=5$/);
      return new Response(JSON.stringify([
        { name: 'v2.0.0', tag_name: 'v2.0.0', html_url: 'https://github.com/acme/plugin/releases/tag/v2.0.0', published_at: '2026-08-20T00:00:00Z', body: 'Changelog', draft: false, prerelease: false },
        { name: 'draft', tag_name: 'v3.0.0-draft', html_url: 'https://github.com/acme/plugin/releases/tag/v3.0.0-draft', draft: true }
      ]), { status: 200 });
    };
    const source = { id: 'acme-releases', owner: 'acme', repo: 'plugin', vendor: 'Acme', product: 'Plugin', maxItems: 5 };
    const candidates = await fetchGithubReleasesSource(source);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].sourceType, 'github-releases');
    assert.equal(candidates[0].metadata.version, 'v2.0.0');
    assert.equal(candidates[0].vendor, 'Acme');
  } finally { globalThis.fetch = previousFetch; }
});

test('fetchGithubReleasesSource requires owner/repo', async () => {
  await assert.rejects(fetchGithubReleasesSource({ id: 'bad' }), /missing owner\/repo/);
});

test('validateResearchSources rejects duplicate ids, bad types, and missing required fields', () => {
  const errors = validateResearchSources({
    acct: [
      { id: 'a', type: 'rss', url: 'https://feed.example/a.xml' },
      { id: 'a', type: 'rss', url: 'https://feed.example/b.xml' },
      { id: 'b', type: 'bogus', url: 'https://feed.example/c.xml' },
      { id: 'c', type: 'github-releases' }
    ]
  });
  assert.ok(errors.some((e) => e.includes('duplicates "a"')));
  assert.ok(errors.some((e) => e.includes('type must be one of')));
  assert.ok(errors.some((e) => e.includes('requires owner and repo')));
});

test('sourcesForAccount filters disabled sources and orders by priority', () => {
  const registry = { acct: [
    { id: 'low', type: 'rss', url: 'https://feed.example/low.xml', priority: 10 },
    { id: 'high', type: 'rss', url: 'https://feed.example/high.xml', priority: 90 },
    { id: 'off', type: 'rss', url: 'https://feed.example/off.xml', priority: 100, enabled: false }
  ] };
  const sources = sourcesForAccount(registry, 'acct');
  assert.deepEqual(sources.map((s) => s.id), ['high', 'low']);
});

test('candidateHash changes when the version/metadata changes but not on unrelated summary edits', () => {
  const base = normalizeCandidate({ sourceId: 's', title: 'T', url: 'https://vendor.example/x', vendor: 'V', product: 'P', summary: 'first summary', metadata: { version: '1.0' } });
  const editedSummary = normalizeCandidate({ ...base, summary: 'second summary, fixed typo' });
  const bumpedVersion = normalizeCandidate({ ...base, metadata: { version: '1.1' } });
  assert.equal(candidateHash(base), candidateHash(editedSummary));
  assert.notEqual(candidateHash(base), candidateHash(bumpedVersion));
});

const CACHE_FILE = fileURLToPath(new URL('../data/research-cache/test-isolation-account.json', import.meta.url));

test('runDirectFetch isolates a failing source from succeeding ones and deduplicates via cache', async () => {
  const previousFetch = globalThis.fetch;
  await rm(CACHE_FILE, { force: true });
  try {
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes('good.xml')) return new Response(RSS_XML, { status: 200 });
      if (href.includes('bad.xml')) return new Response('boom', { status: 500 });
      throw new Error(`unexpected url ${href}`);
    };
    const registry = { 'test-isolation-account': [
      { id: 'good', type: 'rss', url: 'https://feed.example/good.xml' },
      { id: 'bad', type: 'rss', url: 'https://feed.example/bad.xml' }
    ] };
    const first = await runDirectFetch('test-isolation-account', registry);
    assert.equal(first.totalSources, 2);
    assert.equal(first.failedSources, 1);
    assert.equal(first.sourceResults.find((r) => r.id === 'bad').status, 'failed');
    assert.equal(first.sourceResults.find((r) => r.id === 'good').status, 'ok');
    assert.equal(first.freshCount, 2);

    // A fetched-but-not-yet-triaged item stays "fresh" so triage can still see it on the very next poll -
    // the never-re-evaluate guarantee is keyed on AI evaluation (markEvaluated), not on having merely
    // been fetched once (markSeen).
    const secondBeforeTriage = await runDirectFetch('test-isolation-account', registry);
    assert.equal(secondBeforeTriage.freshCount, 2, 'items are not silently dropped before anything has evaluated them');

    // Simulate what triageCandidates() does after scoring: mark every candidate's hash evaluated.
    const cache = await loadResearchCache('test-isolation-account');
    for (const candidate of first.candidates) markEvaluated(cache, candidate._cacheHash, { relevance: 50 });
    await saveResearchCache('test-isolation-account', cache);

    const third = await runDirectFetch('test-isolation-account', registry);
    assert.equal(third.freshCount, 0, 'content already evaluated by AI triage is never re-fetched as fresh again');
    assert.equal(third.duplicateCount, 2);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(CACHE_FILE, { force: true });
  }
});
