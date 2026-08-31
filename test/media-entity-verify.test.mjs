import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMediaEntity, acceptAsProductImage, classifyMediaSourceType } from '../src/media/entity-verify.mjs';
import { huntMedia } from '../src/media/hunter.mjs';
import { renderBrandCard } from '../src/media/brand-card.mjs';

const supermassive = { entityName: 'Valhalla Supermassive', vendor: 'Valhalla DSP', canonicalUrl: 'https://valhalladsp.com/shop/reverb/valhalla-supermassive/' };

test('A: matching official product image is accepted', () => {
  const verification = verifyMediaEntity(supermassive, {
    entityName: 'Valhalla Supermassive',
    vendor: 'Valhalla DSP',
    mediaUrl: 'https://valhalladsp.com/supermassive.png',
    sourceUrl: 'https://valhalladsp.com/shop/reverb/valhalla-supermassive/',
    mediaSourceType: 'official_product_asset',
    usageBasis: 'official_product_asset'
  });
  assert.equal(verification.verificationStatus, 'verified');
  assert.equal(acceptAsProductImage(verification), true);
});

test('B: a different product from the same vendor is rejected', () => {
  const verification = verifyMediaEntity(supermassive, {
    entityName: 'Valhalla VintageVerb',
    vendor: 'Valhalla DSP',
    mediaUrl: 'https://valhalladsp.com/vintageverb.png',
    sourceUrl: 'https://valhalladsp.com/shop/reverb/valhalla-vintageverb/',
    mediaSourceType: 'official_product_asset',
    usageBasis: 'official_product_asset'
  });
  assert.equal(verification.verificationStatus, 'mismatch');
  assert.equal(acceptAsProductImage(verification), false);
});

test('C: AI-generated fictional plugin UI is rejected as a product image', () => {
  const verification = verifyMediaEntity(supermassive, {
    entityName: 'Valhalla Supermassive',
    vendor: 'Valhalla DSP',
    mediaUrl: 'https://cdn.example/ai.png',
    mediaSourceType: 'ai_generated',
    usageBasis: 'unknown',
    aiGenerated: true
  });
  assert.equal(verification.verificationStatus, 'ai_generated');
  assert.equal(acceptAsProductImage(verification), false);
  assert.equal(classifyMediaSourceType({ mediaSourceType: 'openai-image' }), 'ai_generated');
});

test('D: vendor logo only is not a product image', () => {
  const verification = verifyMediaEntity(supermassive, {
    entityName: 'Valhalla DSP',
    vendor: 'Valhalla DSP',
    mediaUrl: 'https://valhalladsp.com/logo.png',
    mediaSourceType: 'vendor_logo',
    usageBasis: 'official_press_asset'
  });
  assert.equal(verification.verificationStatus, 'vendor_visual_only');
  assert.equal(acceptAsProductImage(verification), false);
});

test('E: unknown image entity is rejected', () => {
  const verification = verifyMediaEntity(supermassive, {
    mediaUrl: 'https://cdn.example/mystery.png',
    mediaSourceType: 'unknown',
    usageBasis: 'unknown'
  });
  assert.equal(verification.verificationStatus, 'unknown');
  assert.equal(acceptAsProductImage(verification), false);
});

test('F: Instagram without a verified product image falls back to a brand card', async () => {
  const result = await huntMedia({
    target: supermassive,
    platform: 'instagram',
    candidates: [{
      entityName: 'Valhalla VintageVerb',
      vendor: 'Valhalla DSP',
      mediaUrl: 'https://valhalladsp.com/vintageverb.png',
      mediaSourceType: 'official_product_asset',
      usageBasis: 'official_product_asset'
    }],
    allowBrandCard: true,
    brandCardInput: { badge: 'FREE', productName: 'Valhalla Supermassive', vendor: 'Valhalla DSP', oneLiner: '空間系の実験場', audience: '宅録DTMer' }
  });
  assert.equal(result.decision, 'brand-card');
  assert.equal(result.media.brandCard.ok, true);
  assert.match(result.media.brandCard.svg, /Valhalla Supermassive/);
  assert.equal(result.media.brandCard.inventsProductUi, false);
});

test('G: Instagram skips when a brand card cannot be generated', async () => {
  const result = await huntMedia({
    target: { entityName: '', vendor: '' },
    platform: 'instagram',
    candidates: [],
    allowBrandCard: true,
    brandCardInput: { productName: '', vendor: '' }
  });
  assert.equal(result.decision, 'skip');
});

test('X may publish without media when nothing verifies', async () => {
  const result = await huntMedia({ target: supermassive, platform: 'x', candidates: [] });
  assert.equal(result.decision, 'none');
});

test('brand cards are information cards, not invented plugin UIs', () => {
  const card = renderBrandCard({ badge: 'NEW', productName: 'Valhalla Supermassive', vendor: 'Valhalla DSP', oneLiner: '巨大空間', audience: 'アンビエント好き' });
  assert.equal(card.ok, true);
  assert.doesNotMatch(card.svg, /knob|fader|waveform|plugin ui/i);
  assert.match(card.svg, /Information card/);
});
