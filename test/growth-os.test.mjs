import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, tierForTask, modelForOpenAiGeneration } from '../src/ai/router.mjs';
import { xAndInstagramFromBrief, buildCoreContentBrief } from '../src/brands/brief.mjs';
import { assertAdaptedCopy, isCopyPaste } from '../src/content/platform-adapt.mjs';
import { loadBrandsFile, resolveBrandForAccount, validateBrands } from '../src/brands/registry.mjs';
import { assertRelationshipDisclosure } from '../src/disclosure/relationship.mjs';
import { normalizeGrowthMetrics } from '../src/growth/metrics.mjs';
import { exploreAssignment } from '../src/growth/explore.mjs';
import { readFile } from 'node:fs/promises';

test('model router cascades cheap → balanced → high/critical instead of hardcoding one model', () => {
  const account = {
    generation: { model: 'gpt-5' },
    ai: { groqModel: 'llama-3.1-8b-instant', openaiTriageModel: 'gpt-5-mini' }
  };
  assert.equal(tierForTask('research-triage').tier, 'cheap');
  assert.equal(resolveRoute(account, 'research-triage').provider, 'groq');
  const escalated = resolveRoute(account, 'post-generation', { escalateReasons: ['high-value-url-post'] });
  assert.equal(escalated.tier, 'high');
  assert.equal(escalated.cascaded, true);
  const critical = resolveRoute(account, 'weekly-strategy', { escalateReasons: ['weekly-strategy-review'] });
  assert.equal(critical.tier, 'critical');
  const generation = modelForOpenAiGeneration(account, 'post-generation');
  assert.equal(generation.provider, 'openai');
  assert.equal(generation.model, 'gpt-5-mini');
  assert.equal(modelForOpenAiGeneration(account, 'post-generation', { escalateReasons: ['high-value-url-post'] }).model, 'gpt-5');
});

test('one research brief becomes distinct X and Instagram copy specs', () => {
  const core = buildCoreContentBrief({
    brandId: 'plugin-radar',
    topic: 'Valhalla Supermassive の無償アップデート',
    entity: { entityName: 'Valhalla Supermassive', vendor: 'Valhalla DSP' },
    judgment: { whoItIsFor: '空間系を試したい人', whoCanSkip: 'もう持っている人' }
  });
  const split = xAndInstagramFromBrief(core);
  assert.notEqual(split.x.copyBrief.form, split.instagram.copyBrief.form);
  assert.match(split.x.copyBrief.form, /hook/);
  assert.match(split.instagram.copyBrief.form, /save value/);
  assert.equal(isCopyPaste('短いX用フック', '視覚の文脈から入るInstagramキャプション'), false);
  assert.throws(() => assertAdaptedCopy({ platform: 'x', sourceText: 'same', adaptedText: 'same' }), { code: 'PLATFORM_COPY_PASTE' });
});

test('Plugin Radar keeps music-tools-x as the X account id', async () => {
  const brands = await loadBrandsFile();
  const brand = resolveBrandForAccount(brands, 'music-tools-x', { brandId: 'plugin-radar' });
  assert.equal(brand.accounts.x, 'music-tools-x');
  assert.equal(brand.accounts.instagram, 'plugin-radar-instagram');
  assert.equal(brand.handle.x, '@pluginradar_jp');
  const accounts = JSON.parse(await readFile(new URL('../config/accounts.json', import.meta.url), 'utf8'));
  assert.equal(accounts.accounts['music-tools-x'].credentialKey, 'music-tools-x');
  assert.equal(accounts.accounts['music-tools-x'].enabled, false);
  assert.equal(accounts.accounts['plugin-radar-instagram'].enabled, false);
  assert.equal(accounts.accounts['plugin-radar-instagram'].media.internalImageGeneration, false);
  assert.equal(accounts.accounts['artist-x'].enabled, false);
  assert.equal(accounts.accounts['brand-c-x'].contentStrategy, 'scaffold');
  assert.deepEqual(validateBrands(brands, Object.keys(accounts.accounts)), []);
});

test('own_product must be disclosed and is not mixed with affiliate', () => {
  assert.throws(
    () => assertRelationshipDisclosure({ text: '良いプラグインです', relationship: 'own_product' }),
    { code: 'RELATIONSHIP_DISCLOSURE_MISSING' }
  );
  const ok = assertRelationshipDisclosure({ text: '運営者が開発した製品です。空間系の実験用。', relationship: 'own_product' });
  assert.equal(ok.kind, 'own_product');
  assert.throws(
    () => assertRelationshipDisclosure({ text: '広告・アフィリエイトリンクを含みます', relationship: 'affiliate', affiliateEnabled: false }),
    { code: 'AFFILIATE_DISABLED' }
  );
});

test('growth metrics do not invent unavailable platform fields', () => {
  const normalized = normalizeGrowthMetrics({
    platform: 'x',
    metrics: { impressions: 100, likes: 4, reposts: 1 }
  });
  assert.equal(normalized.normalized.impressions, 100);
  assert.equal(normalized.normalized.urlClicks, null);
  assert.ok(normalized.unavailable.includes('urlClicks'));
});

test('explore rate stays configurable around 80/20', () => {
  const exploitish = [...Array(200)].map((_, index) => exploreAssignment(`slot-${index}`, 'plugin-radar', 0.2));
  const exploreShare = exploitish.filter((row) => row.mode === 'explore').length / exploitish.length;
  assert.ok(exploreShare > 0.1 && exploreShare < 0.3);
});

test('Manual-Only locks and affiliate stay in place after the growth-OS change', async () => {
  const runtime = JSON.parse(await readFile(new URL('../config/runtime-policy.json', import.meta.url), 'utf8'));
  assert.equal(runtime.manualOnly, true);
  assert.equal(runtime.requireExplicitManualInvocation, true);
  assert.equal(runtime.allowAutomaticAccountActivation, false);
  assert.equal(runtime.allowAutomaticEngagement, false);
  assert.equal(runtime.allowScheduledProviderPolling, false);
  const accounts = JSON.parse(await readFile(new URL('../config/accounts.json', import.meta.url), 'utf8'));
  for (const [id, account] of Object.entries(accounts.accounts)) {
    assert.notEqual(account.enabled, true, `${id} must stay disabled`);
    assert.notEqual(account.monetization?.affiliate?.enabled, true, `${id} must not enable affiliate`);
  }
});
