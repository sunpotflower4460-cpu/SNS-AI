import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMediaCandidatesFromHtml, acquireMediaCandidates } from '../src/media/acquire.mjs';
import { huntMedia } from '../src/media/hunter.mjs';

const html = `
<html><head>
<meta property="og:image" content="https://valhalladsp.com/supermassive.png">
<meta name="twitter:image" content="/twitter.png">
</head></html>
`;

test('HTML extract does not mark rights as verified', () => {
  const found = extractMediaCandidatesFromHtml(html, {
    pageUrl: 'https://valhalladsp.com/shop/reverb/valhalla-supermassive/',
    canonicalUrl: 'https://valhalladsp.com/shop/reverb/valhalla-supermassive/',
    entityName: 'Valhalla Supermassive',
    vendor: 'Valhalla DSP'
  });
  assert.ok(found.length >= 1);
  assert.equal(found[0].usageBasis, 'unknown');
  assert.equal(found[0].rightsStatus, 'unverified');
  assert.equal(found[0].acquiredBy, 'canonical-html-extract');
});

test('unconnected fetch adapter does not claim official pages were crawled', async () => {
  const none = await acquireMediaCandidates({});
  assert.equal(none.acquired, false);
  assert.equal(none.reason, 'no-canonical-url');
  const unconnected = await acquireMediaCandidates({ canonicalUrl: 'https://valhalladsp.com/shop/reverb/valhalla-supermassive/' });
  assert.equal(unconnected.acquired, false);
  assert.equal(unconnected.reason, 'fetch-adapter-unconnected');
  assert.match(unconnected.note, /not crawled/);
  const acquired = await acquireMediaCandidates({
    canonicalUrl: 'https://valhalladsp.com/shop/reverb/valhalla-supermassive/',
    entityName: 'Valhalla Supermassive',
    vendor: 'Valhalla DSP',
    fetchHtml: async () => html
  });
  assert.equal(acquired.acquired, true);
  assert.equal(acquired.candidates[0].usageBasis, 'unknown');
});

test('hunter without acquire does not pretend it searched official sites', async () => {
  const result = await huntMedia({
    target: { entityName: 'Valhalla Supermassive', vendor: 'Valhalla DSP' },
    platform: 'x',
    candidates: []
  });
  assert.equal(result.decision, 'none');
  assert.equal(result.acquisition.acquired, false);
});

test('hunter can ingest canonical HTML candidates when a fetch adapter is connected', async () => {
  const result = await huntMedia({
    target: {
      entityName: 'Valhalla Supermassive',
      vendor: 'Valhalla DSP',
      canonicalUrl: 'https://valhalladsp.com/shop/reverb/valhalla-supermassive/'
    },
    platform: 'x',
    candidates: [],
    acquireFromCanonical: true,
    fetchHtml: async () => '<html><head><meta property="og:image" content="https://cdn.example/other.png"></head></html>'
  });
  assert.equal(result.acquisition.reason, 'canonical-html-extract');
  assert.equal(result.acquisition.candidates[0].usageBasis, 'unknown');
});
