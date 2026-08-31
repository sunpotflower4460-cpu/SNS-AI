import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMasterAsset, deriveVariant, rejectDuplicateFinishedPost, variantsNearDuplicate, platformAdaptVariant, stripPrivateAssetFields } from '../src/artist/assets.mjs';
import { canResurfaceWinner, fatigueScore, shortTermReuseForbidden, winnerResurfaceConfig } from '../src/artist/fatigue.mjs';
import { collectHumanAnchors } from '../src/artist/anchor.mjs';
import { proposeOrbit, orbitRejectsCandidate } from '../src/artist/orbit.mjs';
import { diagnoseFunnel } from '../src/artist/funnel-repair.mjs';
import { planArtistSlot, decideNoPost, applyFunnelMix, filterAssetCandidate } from '../src/artist/plan.mjs';
import { maybeAssetRequest, applyTasteConfirmation, tasteConfirmationAction, hybridEnabled } from '../src/artist/actions.mjs';
import { campaignOrbit } from '../src/artist/campaign.mjs';
import { createClaim, assertClaimsForLevel, attachProvenance, personalWordingAllowed } from '../src/artist/provenance.mjs';
import { assertArtistVoice, classifyArtistClaim } from '../src/artist/evidence.mjs';
import { maxDirectPromotionShare, applyLearnedMix, resolveArtistMix } from '../src/artist/mix.mjs';
import { createManualIngestAdapter, publishedPostSnapshot } from '../src/artist/ingest.mjs';
import { creatorActionRecommendation, artistFunnelSnapshotContract, artistContextEvent, assertNoPrivateStorage, PROPOSED_BRIDGE_CONTRACTS } from '../src/artist/bridge-contracts.mjs';
import { constrainRouteForBudget, resolveRoute } from '../src/ai/router.mjs';
import { assertOverlapSafe, detectManualOverlap, applyOverlapDecision } from '../src/artist/overlap.mjs';

const now = new Date('2026-08-31T12:00:00Z');
const artistAccount = {
  id: 'artist-x',
  platform: 'x',
  contentStrategy: 'artist-support',
  artist: {
    hybridMode: true,
    maxDirectPromotionShare: 0.2,
    aiMaxPostsPerDay: 2,
    mix: { tasteDiscovery: 0.4, musicAndCreation: 0.25, worldview: 0.2, directArtistPromotion: 0.15 },
    manualOverlap: { lookbackHours: 72, similarityThreshold: 0.55 },
    winnerResurface: { minDaysSinceLastUse: 180, requireNewAngle: true, requireDifferentClip: true }
  }
};

function master(index, extra = {}) {
  return createMasterAsset({
    assetId: `m-${index}`,
    mediaType: 'acoustic-performance',
    songId: extra.songId || `song-${index % 10}`,
    orientation: 'portrait',
    lastUsedAt: extra.lastUsedAt || now.toISOString(),
    timesUsed: extra.timesUsed ?? 1,
    remainingAngles: extra.remainingAngles || ['lyric', 'guitar'],
    performanceSummary: extra.performanceSummary || null,
    ...extra
  });
}

test('A: 100 master assets do not reuse the same finished post in the short term', () => {
  const recent = [];
  for (let index = 0; index < 100; index += 1) {
    const asset = master(index, { lastUsedAt: '2026-08-20T12:00:00Z' });
    const variant = deriveVariant(asset, { clipStart: 0, clipEnd: 15, angle: 'vocal', caption: `caption-${index}` });
    recent.push({ ...variant, lastUsedAt: asset.lastUsedAt, lastCaption: variant.caption });
  }
  const reuse = deriveVariant(master(0, { lastUsedAt: '2026-08-20T12:00:00Z' }), { clipStart: 0, clipEnd: 15, angle: 'vocal', caption: 'caption-0' });
  assert.equal(rejectDuplicateFinishedPost({ candidate: reuse, recent, minDays: 21, now }).reject, true);
  assert.equal(shortTermReuseForbidden(master(0, { lastUsedAt: '2026-08-20T12:00:00Z', timesUsed: 1 }), { now, minDays: 21 }), true);
});

test('B: winner asset can resurface after cooldown with a new angle and different clip', () => {
  const asset = master(1, {
    lastUsedAt: '2026-01-01T00:00:00Z',
    clipStart: 0,
    clipEnd: 15,
    lastAngle: 'vocal',
    lastCaption: 'old caption',
    performanceSummary: { winner: true, score: 91 }
  });
  const candidate = deriveVariant(asset, { clipStart: 40, clipEnd: 55, angle: 'guitar', caption: 'new guitar entry' });
  const decision = canResurfaceWinner({ asset, candidate, config: winnerResurfaceConfig(artistAccount), now });
  assert.equal(decision.ok, true);
  assert.equal(canResurfaceWinner({ asset: { ...asset, lastUsedAt: '2026-08-30T00:00:00Z' }, candidate, now }).ok, false);
});

test('C: same master + same clip + same caption is rejected', () => {
  const asset = master(2);
  const first = deriveVariant(asset, { clipStart: 8, clipEnd: 20, angle: 'lyric', caption: '同じサビ' });
  const second = deriveVariant(asset, { clipStart: 8, clipEnd: 20, angle: 'lyric', caption: '同じサビ' });
  assert.equal(variantsNearDuplicate(first, second), true);
  assert.equal(filterAssetCandidate(second, [{ ...first, lastUsedAt: now.toISOString() }], now).reject, true);
});

test('D: same master + different clip + different angle is a valid derived candidate', () => {
  const asset = master(3, { lastUsedAt: '2026-01-01T00:00:00Z', timesUsed: 1 });
  const a = deriveVariant(asset, { clipStart: 0, clipEnd: 8, angle: 'vocal', caption: '歌い出し' });
  const b = deriveVariant(asset, { clipStart: 40, clipEnd: 55, angle: 'guitar', caption: 'ギターの粒' });
  assert.equal(variantsNearDuplicate(a, b), false);
  assert.equal(rejectDuplicateFinishedPost({ candidate: b, recent: [{ ...a, lastUsedAt: '2026-01-01T00:00:00Z' }], now }).reject, false);
});

test('E: Human Anchor Re:trip does not emit the same Re:trip promo', () => {
  const history = [{
    account: 'artist-x', source: 'manual', humanAuthored: true,
    text: '今日はRe:tripを歌いました', entityName: 'Re:trip', at: '2026-08-31T10:00:00Z'
  }];
  const overlap = detectManualOverlap({
    candidateText: 'Re:tripを聴いてください',
    candidateEntity: 'Re:trip',
    history,
    accountId: 'artist-x',
    now
  });
  assert.equal(overlap.overlapped, true);
  assert.throws(() => assertOverlapSafe({ decision: overlap, candidateText: 'Re:tripを聴いてください', entity: 'Re:trip' }), { code: 'ARTIST_OVERLAP' });
  const orbit = proposeOrbit({ anchor: { text: '今日はRe:tripを歌いました', entityName: 'Re:trip' } });
  const hit = orbitRejectsCandidate({
    candidateText: 'Re:tripを聴いてください',
    anchor: { text: '今日はRe:tripを歌いました', entityName: 'Re:trip' },
    entity: 'Re:trip'
  });
  assert.equal(hit.reject, true);
  assert.ok(orbit.candidates.length > 0);
});

test('F: Human Anchor present yields relevant Orbit candidates', () => {
  const orbit = proposeOrbit({ anchor: { text: '今日はRe:tripを歌いました', entityName: 'Re:trip' } });
  assert.equal(orbit.active, true);
  assert.equal(orbit.theme, 'Re:trip');
  assert.ok(orbit.candidates.some((row) => row.angle === 'lyric' || row.angle === 'past-performance'));
  const plan = planArtistSlot({
    account: artistAccount,
    history: [{ account: 'artist-x', source: 'manual', text: '今日はRe:tripを歌いました', entityName: 'Re:trip', at: '2026-08-31T10:00:00Z' }],
    now,
    slotId: 'artist-x:test'
  });
  assert.equal(plan.orbit.active, true);
});

test('G: enough manual activity allows no-post', () => {
  const history = [
    { account: 'artist-x', source: 'manual', text: '朝の制作', at: '2026-08-31T01:00:00Z' },
    { account: 'artist-x', source: 'manual', text: '昼のライブ', at: '2026-08-31T03:00:00Z' }
  ];
  const plan = planArtistSlot({ account: artistAccount, history, now, slotId: 'artist-x:g' });
  assert.equal(plan.decision, 'no-post');
  assert.equal(plan.proceed, false);
  assert.ok(decideNoPost({ anchors: collectHumanAnchors({ history, now }).anchors, account: artistAccount, now }).skip);
});

test('H: confirmed_personal may use personal wording', () => {
  assert.equal(personalWordingAllowed('confirmed_personal'), true);
  assert.equal(assertArtistVoice({ text: 'このペダル、使ってみて良かった。', evidenceLevel: 'confirmed_personal' }).ok, true);
  const claims = [createClaim({ claim: 'used this pedal', claimType: 'lived-experience', evidenceLevel: 'confirmed_personal', evidenceId: 'e1' })];
  assert.equal(assertClaimsForLevel(claims, 'confirmed_personal').ok, true);
});

test('I: taste_match forbids personal experience', () => {
  assert.equal(classifyArtistClaim('使ってみて良かった', 'taste_match').allowed, false);
  assert.throws(
    () => assertClaimsForLevel([createClaim({ claim: 'I used it', claimType: 'lived-experience', evidenceLevel: 'taste_match' })], 'taste_match'),
    { code: 'ARTIST_EVIDENCE_VIOLATION' }
  );
});

test('J: external_discovery is objective only', () => {
  assert.equal(classifyArtistClaim('こういう作品がある', 'external_discovery').allowed, true);
  assert.throws(
    () => assertClaimsForLevel([createClaim({ claim: 'fun', claimType: 'taste', evidenceLevel: 'external_discovery' })], 'external_discovery'),
    { code: 'ARTIST_EVIDENCE_VIOLATION' }
  );
  const draft = attachProvenance({ text: '発表された', evidenceLevel: 'external_discovery' }, [
    createClaim({ claim: 'released', claimType: 'objective-fact', evidenceLevel: 'external_discovery', source: 'press' })
  ]);
  assert.equal(draft.provenance.claims[0].claimType, 'objective-fact');
});

test('K: asset shortage with strong evidence creates a Creator Action request', () => {
  const result = maybeAssetRequest({
    hybridMode: true,
    shortage: true,
    evidence: [{ kind: 'performance', note: 'Aquarium vertical clips over-index on profile visits' }],
    confidence: 0.82,
    requestedAssetType: 'short-video',
    song: 'Aquarium',
    reason: 'Aquarium系が強く、縦型サビが不足'
  });
  assert.equal(result.requested, true);
  assert.equal(result.action.type, 'asset_request');
  assert.ok(result.action.requestId);
  assert.ok(result.action.reason);
});

test('L: shortage with low confidence does not request', () => {
  const result = maybeAssetRequest({
    hybridMode: true,
    shortage: true,
    evidence: [{ kind: 'guess' }],
    confidence: 0.2,
    requestedAssetType: 'short-video',
    reason: 'maybe?'
  });
  assert.equal(result.requested, false);
});

test('M: taste confirmation yes can promote to confirmed', () => {
  const yes = applyTasteConfirmation({ currentLevel: 'taste_match', response: 'yes', evidenceId: 't1' });
  assert.equal(yes.promoted, true);
  assert.equal(yes.nextLevel, 'confirmed_personal');
});

test('N: taste confirmation no does not promote', () => {
  const no = applyTasteConfirmation({ currentLevel: 'taste_match', response: 'no', evidenceId: 't1' });
  assert.equal(no.promoted, false);
  assert.equal(no.avoid, true);
  assert.notEqual(no.nextLevel, 'confirmed_personal');
  const ask = tasteConfirmationAction({ work: 'some record', confidence: 0.7, hybridMode: true, now });
  assert.equal(ask.action.type, 'taste_confirmation');
});

test('O: profile visit bottleneck recommends identity/worldview', () => {
  const repair = diagnoseFunnel({ metrics: { impressions: 800, profileVisits: 4 } });
  assert.equal(repair.currentBottleneck, 'profile-visit');
  assert.equal(repair.recommendedLane, 'worldview');
  assert.equal(repair.recommendedObjective, 'identity-worldview-entry');
  assert.equal(repair.changeStrategy, true);
});

test('P: music click bottleneck recommends music entry', () => {
  const repair = diagnoseFunnel({ metrics: { impressions: 400, profileVisits: 80, musicClicks: 1 } });
  assert.equal(repair.currentBottleneck, 'music-click');
  assert.equal(repair.recommendedLane, 'musicAndCreation');
  assert.equal(repair.doNotIncreaseDirectPromo, true);
});

test('Q: release event generates a campaign orbit', () => {
  const orbit = campaignOrbit({
    event: { type: 'release', entityName: 'Aquarium', at: '2026-08-30T12:00:00Z' },
    now,
    availableAssets: [{ assetId: 'clip-1' }]
  });
  assert.equal(orbit.active, true);
  assert.equal(orbit.elapsedDays, 1);
  assert.equal(orbit.today.angle, 'performance-clip');
  const copied = campaignOrbit({
    event: { type: 'release', entityName: 'Aquarium', at: '2026-08-30T12:00:00Z' },
    now,
    humanPostedToday: true,
    availableAssets: [{ assetId: 'clip-1' }]
  });
  assert.equal(copied.decision, 'defer-to-human-anchor');
});

test('R: direct promo hard cap is maintained under funnel mix', () => {
  const funnel = diagnoseFunnel({ metrics: { impressions: 800, profileVisits: 4 } });
  const mix = applyFunnelMix({ tasteDiscovery: 0.1, musicAndCreation: 0.1, worldview: 0.1, directArtistPromotion: 0.7 }, funnel, artistAccount);
  assert.ok(mix.directArtistPromotion <= maxDirectPromotionShare(artistAccount) + 1e-9);
  const learned = applyLearnedMix(resolveArtistMix(artistAccount), { directArtistPromotion: 0.9 }, artistAccount);
  assert.ok(learned.directArtistPromotion <= 0.2 + 1e-9);
});

test('S: budget critical does not select expensive model options', () => {
  const account = {
    generation: { model: 'gpt-5' },
    ai: { openaiTriageModel: 'gpt-5-mini', groqModel: 'llama-3.1-8b-instant' }
  };
  const high = resolveRoute(account, 'post-generation', { escalateReasons: ['high-value-url-post'] });
  const constrained = constrainRouteForBudget(high, 'critical', account);
  assert.notEqual(constrained.tier, 'high');
  assert.notEqual(constrained.tier, 'critical');
  assert.equal(constrained.tier, 'balanced');
});

test('T: Manual-Only is not unlocked by Artist Support V2', async () => {
  const runtime = JSON.parse(await readFile(new URL('../config/runtime-policy.json', import.meta.url), 'utf8'));
  assert.equal(runtime.manualOnly, true);
  assert.equal(runtime.requireExplicitManualInvocation, true);
  assert.equal(runtime.allowAutomaticAccountActivation, false);
  const accounts = JSON.parse(await readFile(new URL('../config/accounts.json', import.meta.url), 'utf8'));
  for (const [id, account] of Object.entries(accounts.accounts)) {
    assert.notEqual(account.enabled, true, `${id} must stay disabled`);
  }
  assert.equal(accounts.accounts['artist-x'].artist.hybridMode, true);
  assert.equal(accounts.defaults.artist.hybridMode, false);
});

test('unconnected ingest must not claim My-SNS manuals were read', async () => {
  const adapter = createManualIngestAdapter();
  const loaded = await adapter.loadPublishedPosts();
  assert.equal(loaded.connected, false);
  assert.match(loaded.note, /Do not claim/);
  const connected = createManualIngestAdapter({
    connected: true,
    fetchSnapshots: async () => [publishedPostSnapshot({ platform: 'x', text: 'hello', at: now.toISOString() })]
  });
  const ok = await connected.loadPublishedPosts();
  assert.equal(ok.connected, true);
  assert.equal(ok.snapshots[0].humanAuthored, true);
});

test('Bridge contracts never carry private or signed URLs', () => {
  const action = maybeAssetRequest({
    hybridMode: true, shortage: true, evidence: [{ kind: 'gap' }], confidence: 0.7,
    requestedAssetType: 'photo', reason: 'need stills'
  }).action;
  const rec = creatorActionRecommendation(action);
  assert.equal(rec.kind, 'CreatorActionRecommendation');
  assert.ok(PROPOSED_BRIDGE_CONTRACTS.includes('ArtistFunnelSnapshot'));
  assertNoPrivateStorage(rec);
  assertNoPrivateStorage(artistFunnelSnapshotContract(diagnoseFunnel({ metrics: {} })));
  assertNoPrivateStorage(artistContextEvent({ type: 'release', at: now.toISOString(), entityName: 'Aquarium' }));
  assert.throws(
    () => assertNoPrivateStorage({ signedUrl: 'https://bucket/file?X-Amz-Signature=abc' }),
    { code: 'BRIDGE_PRIVATE_URL' }
  );
  const stripped = stripPrivateAssetFields({ assetId: 'a', signedUrl: 'secret', privateStorageUrl: 's3://x' });
  assert.equal(stripped.signedUrl, undefined);
});

test('hybridMode false does not assume creator requests', () => {
  assert.equal(hybridEnabled({ artist: { hybridMode: false } }), false);
  assert.equal(maybeAssetRequest({ hybridMode: false, shortage: true, evidence: [{}], confidence: 0.9 }).requested, false);
  const x = platformAdaptVariant(deriveVariant(master(9, { lastUsedAt: '2026-01-01T00:00:00Z', timesUsed: 0 }), { angle: 'story' }), 'x');
  const ig = platformAdaptVariant(deriveVariant(master(9, { lastUsedAt: '2026-01-01T00:00:00Z', timesUsed: 0 }), { angle: 'story' }), 'instagram');
  assert.notEqual(x.captionMode, ig.captionMode);
  assert.equal(fatigueScore({ timesUsed: 4, lastUsedAt: now.toISOString(), sameClipReuse: 1 }) > 0, true);
  applyOverlapDecision({ overlapped: true, action: 'delay' });
  assert.equal(createClaim({ claim: 'x', claimType: 'objective-fact', evidenceLevel: 'external_discovery' }).source, 'artist-library');
});
