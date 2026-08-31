import { assertArtistVoice } from '../artist/evidence.mjs';
import { detectManualOverlap, assertOverlapSafe } from '../artist/overlap.mjs';
import { chooseLane } from '../artist/mix.mjs';
import { decideUrlInvestment } from '../budget/url-intelligence.mjs';
import { operationAllowed } from '../budget/governor.mjs';
import { resolveRoute } from '../ai/router.mjs';
import { assertRelationshipDisclosure } from '../disclosure/relationship.mjs';
import { assertConfirmedFacts } from '../research/source-quality.mjs';
import { exploreAssignment } from '../growth/explore.mjs';
import { objectivesForPostType } from '../growth/objectives.mjs';
import { applyLinkPolicy, stripUrls } from '../content/link-gate.mjs';
import { orbitRejectsCandidate } from '../artist/orbit.mjs';
import { assertClaimsForLevel } from '../artist/provenance.mjs';

export async function evaluateEditorialGuards({
  accountId,
  account,
  brand,
  draft,
  history = [],
  slotId,
  budgetState = 'healthy',
  mediaCandidates = [],
  now = new Date(),
  route: providedRoute = null,
  artistPlan = null
} = {}) {
  const strategy = account.contentStrategy || brand?.strategy || null;
  const audit = {
    selectedModelTier: null,
    selectedProvider: null,
    selectedModel: null,
    escalationReason: null,
    estimatedCost: null,
    budgetRemaining: null,
    mediaSource: null,
    mediaEntityVerification: null,
    contentStrategy: strategy,
    artistEvidenceLevel: draft?.evidenceLevel || null,
    urlDecision: null,
    experimentMode: null,
    artistWhy: artistPlan?.why || null
  };

  const governor = operationAllowed({ operation: 'post-generation', state: budgetState, costType: 'estimated' });
  if (!governor.allowed) {
    const error = new Error(governor.reason);
    error.code = 'BUDGET_GOVERNOR_BLOCKED';
    throw error;
  }

  const escalateReasons = [];
  if (draft?.features?.linkRequired && draft?.features?.linkPurpose === 'highValueDiscovery') escalateReasons.push('high-value-url-post');
  if (Number(draft?.predictedScore || 0) >= 85 && draft?.selectionMode === 'explore') escalateReasons.push('experimental-high-potential');
  const route = providedRoute || draft?.route || resolveRoute(account, 'post-generation', { escalateReasons });
  audit.selectedModelTier = route.tier;
  audit.selectedProvider = route.provider || null;
  audit.selectedModel = route.model || null;
  audit.escalationReason = route.escalationReason || route.reasons?.[0] || null;

  const explore = exploreAssignment(slotId, strategy, account.learning?.exploreRate ?? 0.2);
  audit.experimentMode = explore.mode;

  if (draft?.relationship || strategy === 'plugin-radar') {
    assertRelationshipDisclosure({
      text: draft?.text,
      relationship: draft?.relationship || 'independent',
      affiliateEnabled: account?.monetization?.affiliate?.enabled === true
    });
  }
  if (draft?.facts) assertConfirmedFacts(draft.text, draft.facts);

  if (strategy === 'artist-support') {
    if (draft?.claims) assertClaimsForLevel(draft.claims, draft?.evidenceLevel || artistPlan?.funnel?.evidenceLevel);
    const voice = assertArtistVoice({ text: draft?.text, evidenceLevel: draft?.evidenceLevel || 'external_discovery' });
    audit.artistEvidenceLevel = voice.level;
    const overlap = detectManualOverlap({
      candidateText: draft?.text,
      candidateEntity: draft?.entityName,
      history,
      accountId,
      lookbackHours: Number(account.artist?.manualOverlap?.lookbackHours ?? 48),
      similarityThreshold: Number(account.artist?.manualOverlap?.similarityThreshold ?? 0.55),
      now
    });
    assertOverlapSafe({ decision: overlap, candidateText: draft?.text, entity: draft?.entityName });
    const orbitHit = orbitRejectsCandidate({
      candidateText: draft?.text,
      anchor: overlap.match?.entry || artistPlan?.anchors?.anchors?.[0],
      entity: draft?.entityName
    });
    if (orbitHit.reject) {
      const error = new Error(`Artist orbit rejected candidate: ${orbitHit.reason}`);
      error.code = 'ARTIST_OVERLAP';
      error.action = overlap.action || 'skip';
      throw error;
    }
    audit.contentStrategy = `${strategy}:${chooseLane(slotId, account.artist?.mix, account).lane}`;
    audit.overlapAction = overlap.action || null;
  }

  const urlDecision = decideUrlInvestment({
    accountId,
    account,
    history,
    draft,
    brandUrlBudget: brand?.urlBudget || null,
    predictedScore: draft?.predictedScore,
    now
  });
  audit.urlDecision = urlDecision.action;
  let nextDraft = draft;
  if (urlDecision.action === 'convert-to-no-link' && nextDraft?.text) {
    nextDraft = { ...nextDraft, text: stripUrls(nextDraft.text), features: { ...(nextDraft.features || {}), linkRequired: false } };
  }
  if (urlDecision.action === 'defer') {
    const error = new Error('URL post deferred because the link is load-bearing and the URL budget rejected it.');
    error.code = 'URL_BUDGET_DEFER';
    throw error;
  }
  if (urlDecision.action === 'publish-url' && budgetState === 'conservative') {
    const expensive = operationAllowed({ operation: 'url-post', state: budgetState });
    if (!expensive.allowed) {
      if (urlMeaningSafeToStrip(nextDraft?.text)) {
        nextDraft = { ...nextDraft, text: stripUrls(nextDraft.text), features: { ...(nextDraft.features || {}), linkRequired: false } };
        audit.urlDecision = 'convert-to-no-link';
      } else {
        const error = new Error('URL post blocked by budget governor.');
        error.code = 'BUDGET_GOVERNOR_BLOCKED';
        throw error;
      }
    }
  }

  let media = null;

  const linked = applyLinkPolicy({ accountId, account, draft: nextDraft, history, now });
  return {
    draft: linked.draft,
    media,
    audit: {
      ...audit,
      objectives: objectivesForPostType(nextDraft?.features?.format || 'discovery', strategy)
    },
    urlDecision,
    explore,
    route
  };
}

function urlMeaningSafeToStrip(text) {
  return !/(詳しくはこちら|リンクから|listen here|公式はこちら)/i.test(String(text || ''));
}

export const __test = { urlMeaningSafeToStrip };
