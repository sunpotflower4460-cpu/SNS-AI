import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCostReport, __test } from '../src/reports/cost-report.mjs';
const { withinLastDays, sourceTypeCount } = __test;

const CONFIG = fileURLToPath(new URL('../config/accounts.json', import.meta.url));
const PRICING = fileURLToPath(new URL('../config/x-api-pricing.json', import.meta.url));
const FILES = ['../data/trends/example-x.json', '../data/reports/cost.json', '../data/reports/cost.md'].map((p) => fileURLToPath(new URL(p, import.meta.url)));

async function snap(path) { try { return { exists: true, bytes: await readFile(path) }; } catch (e) { if (e.code === 'ENOENT') return { exists: false }; throw e; } }
async function restore(path, saved) { if (!saved.exists) return rm(path, { force: true }); await mkdir(dirname(path), { recursive: true }); await writeFile(path, saved.bytes); }
async function isolated(fn) {
  const tracked = [CONFIG, PRICING, ...FILES]; const saved = new Map();
  for (const path of tracked) saved.set(path, await snap(path));
  try { return await fn(); }
  finally { for (const path of tracked.reverse()) await restore(path, saved.get(path)); }
}

test('withinLastDays and sourceTypeCount helpers', () => {
  const now = Date.now();
  assert.equal(withinLastDays(new Date(now - 1000).toISOString(), now, 30), true);
  assert.equal(withinLastDays(new Date(now - 40 * 86_400_000).toISOString(), now, 30), false);
  assert.equal(withinLastDays(null, now, 30), false);
  const rows = [{ type: 'rss', status: 'ok', count: 5 }, { type: 'github-releases', status: 'ok', count: 2 }, { type: 'rss', status: 'failed' }];
  assert.equal(sourceTypeCount(rows, ['rss', 'atom']), 5);
  assert.equal(sourceTypeCount(rows, ['github-releases']), 2);
});

test('buildCostReport surfaces research fetch counts, AI usage, and X URL/non-URL post split with pricing applied', async () => {
  await isolated(async () => {
    const config = JSON.parse(await readFile(CONFIG, 'utf8'));
    config.accounts['example-x'] = { ...config.accounts['example-x'], enabled: true };
    config.accounts['example-instagram'].enabled = false;
    await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    await writeFile(PRICING, `${JSON.stringify({ schemaVersion: 1, monthlyBaseFeeUsd: 1, costPerUrlPostUsd: 2, costPerNonUrlPostUsd: 0.5, costPerReadOperationUsd: 0.1 }, null, 2)}\n`, 'utf8');

    const trendPath = fileURLToPath(new URL('../data/trends/example-x.json', import.meta.url));
    await mkdir(dirname(trendPath), { recursive: true });
    await writeFile(trendPath, JSON.stringify({
      account: 'example-x', generatedAt: new Date().toISOString(), summary: 's', items: [], sources: [],
      research: { mode: 'direct-fetch', fetchedCount: 10, freshCount: 7, duplicateCount: 3, totalSources: 2, failedSources: 1, sourceResults: [
        { id: 'a', type: 'rss', status: 'ok', count: 6 },
        { id: 'b', type: 'github-releases', status: 'ok', count: 4 }
      ] }
    }), 'utf8');

    const now = new Date();
    const historyPath = fileURLToPath(new URL('../data/history.jsonl', import.meta.url));
    const savedHistory = await snap(historyPath);
    const savedAudit = await snap(fileURLToPath(new URL('../data/audit.jsonl', import.meta.url)));
    try {
      const rows = [
        { account: 'example-x', status: 'published', text: '新製品です https://vendor.example/x', at: now.toISOString() },
        { account: 'example-x', status: 'published', text: 'リンクなし投稿', at: now.toISOString() }
      ];
      await mkdir(dirname(historyPath), { recursive: true });
      await writeFile(historyPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      const auditPath = fileURLToPath(new URL('../data/audit.jsonl', import.meta.url));
      await writeFile(auditPath, [
        JSON.stringify({ account: 'example-x', stage: 'metrics-collected', at: now.toISOString() }),
        JSON.stringify({ account: 'example-x', stage: 'research-source-failed', at: now.toISOString() })
      ].join('\n') + '\n', 'utf8');

      const report = await buildCostReport({ accountFilter: 'example-x', now });
      const row = report.accounts['example-x'];
      assert.equal(row.research.rssFetchCount, 6);
      assert.equal(row.research.githubFetchCount, 4);
      assert.equal(row.research.duplicateDrops, 3);
      assert.equal(row.research.sourceFailuresRecorded, 1);
      assert.equal(row.xApi.urlPosts, 1);
      assert.equal(row.xApi.nonUrlPosts, 1);
      assert.equal(row.xApi.readOperations, 1);
      // 1 (base) + 1*2 (url) + 1*0.5 (non-url) + 1*0.1 (read) = 3.6
      assert.equal(row.xApi.estimatedMonthlyCostUsd, 3.6);
    } finally {
      await restore(historyPath, savedHistory);
      await restore(fileURLToPath(new URL('../data/audit.jsonl', import.meta.url)), savedAudit);
    }
  });
});

test('buildCostReport rejects an unknown account filter', async () => {
  await assert.rejects(buildCostReport({ accountFilter: 'does-not-exist' }), /Unknown account/);
});

test('committed x-api-pricing.json is the 2026-09-02 X Pay-Per-Use operator estimate', async () => {
  const pricing = JSON.parse(await readFile(PRICING, 'utf8'));
  assert.equal(pricing.monthlyBaseFeeUsd, 0);
  assert.equal(pricing.costPerUrlPostUsd, 0.2);
  assert.equal(pricing.costPerNonUrlPostUsd, 0.015);
  assert.equal(pricing.costPerReadOperationUsd, 0.005);
  assert.match(pricing.note, /2026-09-02/);
  assert.match(pricing.note, /Pay-Per-Use/);
  assert.match(pricing.note, /operator-maintained estimate/i);
  assert.match(pricing.note, /GET \/2\/tweets\/\{postId\}/);
  assert.match(pricing.note, /Owned Read/);
  assert.match(pricing.note, /Re-check/i);
});

test('X metrics collector uses GET /2/tweets/{postId} so reads are Posts Read $0.005 not Owned Read $0.001', async () => {
  const src = await readFile(fileURLToPath(new URL('../src/analytics/x-metrics.mjs', import.meta.url)), 'utf8');
  assert.match(src, /api\.x\.com\/2\/tweets\/\$\{encodeURIComponent\(postId\)\}/);
  const pricing = JSON.parse(await readFile(PRICING, 'utf8'));
  assert.equal(pricing.costPerReadOperationUsd, 0.005);
  assert.notEqual(pricing.costPerReadOperationUsd, 0.001);
});

test('buildCostReport applies committed Pay-Per-Use rates including Posts Read $0.005', async () => {
  await isolated(async () => {
    const now = new Date();
    const historyPath = fileURLToPath(new URL('../data/history.jsonl', import.meta.url));
    const auditPath = fileURLToPath(new URL('../data/audit.jsonl', import.meta.url));
    const savedHistory = await snap(historyPath);
    const savedAudit = await snap(auditPath);
    try {
      await mkdir(dirname(historyPath), { recursive: true });
      await writeFile(historyPath, [
        JSON.stringify({ account: 'example-x', status: 'published', text: '新製品です https://vendor.example/x', at: now.toISOString() }),
        JSON.stringify({ account: 'example-x', status: 'published', text: 'リンクなし投稿', at: now.toISOString() })
      ].join('\n') + '\n', 'utf8');
      await writeFile(auditPath, `${JSON.stringify({ account: 'example-x', stage: 'metrics-collected', at: now.toISOString() })}\n`, 'utf8');

      const report = await buildCostReport({ accountFilter: 'example-x', now });
      const row = report.accounts['example-x'];
      assert.equal(report.pricingModel.costPerUrlPostUsd, 0.2);
      assert.equal(report.pricingModel.costPerNonUrlPostUsd, 0.015);
      assert.equal(report.pricingModel.costPerReadOperationUsd, 0.005);
      assert.equal(row.xApi.urlPosts, 1);
      assert.equal(row.xApi.nonUrlPosts, 1);
      assert.equal(row.xApi.readOperations, 1);
      // 0.20 (url) + 0.015 (non-url) + 0.005 (GET /2/tweets Posts Read) = 0.22
      assert.equal(row.xApi.estimatedMonthlyCostUsd, 0.22);
    } finally {
      await restore(historyPath, savedHistory);
      await restore(auditPath, savedAudit);
    }
  });
});
