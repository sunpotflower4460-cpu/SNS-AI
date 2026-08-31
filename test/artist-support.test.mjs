import test from 'node:test';
import assert from 'node:assert/strict';
import { assertArtistVoice, classifyArtistClaim, emptyArtistLibrary } from '../src/artist/evidence.mjs';
import { detectManualOverlap, applyOverlapDecision } from '../src/artist/overlap.mjs';
import { applyLearnedMix, chooseLane, maxDirectPromotionShare, resolveArtistMix } from '../src/artist/mix.mjs';

test('confirmed_personal may use lived experience', () => {
  const result = assertArtistVoice({ text: 'このペダル、使ってみて良かった。', evidenceLevel: 'confirmed_personal' });
  assert.equal(result.ok, true);
});

test('taste_match rejects lived-experience claims and allows curiosity', () => {
  assert.equal(classifyArtistClaim('使ってみて良かった', 'taste_match').allowed, false);
  assert.equal(classifyArtistClaim('この仕組みは気になる', 'taste_match').allowed, true);
});

test('external_discovery rejects "最近ハマっている" and allows objective intro', () => {
  assert.equal(classifyArtistClaim('最近ハマっている', 'external_discovery').allowed, false);
  assert.equal(classifyArtistClaim('こういう作品がある', 'external_discovery').allowed, true);
});

test('missing evidence level fails closed', () => {
  assert.throws(() => assertArtistVoice({ text: 'hello', evidenceLevel: null }), { code: 'ARTIST_EVIDENCE_UNKNOWN' });
});

test('artist asset library starts empty and does not invent personal data', () => {
  const library = emptyArtistLibrary();
  assert.deepEqual(library.assets.songs, []);
  assert.deepEqual(library.evidence.confirmed_personal, []);
});

test('manual overlap reframes, replaces, or skips instead of repeating the same song/URL', () => {
  const now = new Date('2026-08-31T12:00:00Z');
  const history = [{
    account: 'artist-x',
    source: 'manual',
    text: '今日はRe:tripを歌いました https://example.com/retrip',
    at: '2026-08-31T10:00:00Z'
  }];
  const urlHit = detectManualOverlap({
    candidateText: 'Re:tripを聴いてください https://example.com/retrip',
    candidateEntity: 'Re:trip',
    history,
    accountId: 'artist-x',
    now
  });
  assert.equal(urlHit.overlapped, true);
  assert.ok(['reframe', 'delay', 'replace', 'skip'].includes(urlHit.action));
  const applied = applyOverlapDecision(urlHit);
  assert.equal(applied.proceed, true);
  assert.equal(applied.needsRewrite, true);
  assert.equal(applied.action, 'replace');

  const clear = detectManualOverlap({
    candidateText: '夜の制作でディレイのフィードバックを観察した',
    history,
    accountId: 'artist-x',
    now
  });
  assert.equal(clear.overlapped, false);
  assert.equal(applyOverlapDecision(clear).proceed, true);
});

test('direct promotion has a hard cap even if learning wants more', () => {
  const account = { artist: { maxDirectPromotionShare: 0.2, mix: { tasteDiscovery: 0.1, musicAndCreation: 0.1, worldview: 0.1, directArtistPromotion: 0.7 } } };
  const mix = applyLearnedMix(resolveArtistMix(account), { directArtistPromotion: 0.9 }, account);
  assert.ok(mix.directArtistPromotion <= maxDirectPromotionShare(account) + 1e-9);
  const lane = chooseLane('artist-x:2026-08-31:12:00', mix, account);
  assert.ok(['tasteDiscovery', 'musicAndCreation', 'worldview', 'directArtistPromotion'].includes(lane.lane));
});
