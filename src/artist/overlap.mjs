import { similarity } from '../lib/duplicate.mjs';

const ACTIONS = new Set(['reframe', 'delay', 'replace', 'skip']);
const DIRECT_PROMO = /聴いてください|聞いてください|配信中|ストリーミングで|listen here|check it out|今すぐ聴/i;

function publishedRecently(entry, now, lookbackHours) {
  const at = Date.parse(entry?.at || '');
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at <= lookbackHours * 3600_000;
}

function urlsIn(text) {
  return [...String(text || '').matchAll(/https?:\/\/\S+/gi)].map((match) => match[0].replace(/[),.;]+$/, ''));
}

function sameUrl(candidateText, historyText) {
  const left = new Set(urlsIn(candidateText).map((url) => url.toLowerCase()));
  if (!left.size) return false;
  const right = urlsIn(historyText).map((url) => url.toLowerCase());
  return right.some((url) => left.has(url));
}

export function isManualHistoryEntry(entry) {
  if (!entry) return false;
  if (entry.humanAuthored === true || entry.sourceKind === 'human') return true;
  return !['sns-ai', 'auto', 'approval'].includes(entry.source);
}

export function detectManualOverlap({
  candidateText,
  candidateEntity = null,
  history = [],
  accountId,
  lookbackHours = 48,
  similarityThreshold = 0.55,
  now = new Date()
} = {}) {
  const recent = (history || []).filter((entry) => {
    if (accountId && entry.account && entry.account !== accountId) return false;
    if (!isManualHistoryEntry(entry)) return false;
    return publishedRecently(entry, now, lookbackHours);
  });

  let best = null;
  for (const entry of recent) {
    const score = similarity(candidateText, entry.text);
    const entityHit = candidateEntity && String(entry.text || '').toLowerCase().includes(String(candidateEntity).toLowerCase());
    const urlHit = sameUrl(candidateText, entry.text);
    const overlapped = score >= similarityThreshold || entityHit || urlHit;
    if (!overlapped) continue;
    let action = 'reframe';
    if (score >= 0.8) action = 'skip';
    else if (entityHit || urlHit) action = DIRECT_PROMO.test(candidateText) ? 'replace' : 'reframe';
    if (!best || score > best.score) {
      best = { score, entry, entityHit: Boolean(entityHit), urlHit, action };
    }
  }
  if (!best) return { overlapped: false, action: null, match: null };
  if (!ACTIONS.has(best.action)) best.action = 'skip';
  return { overlapped: true, action: best.action, match: best };
}

export function isParaphraseOfAnchor(candidateText, anchorText, threshold = 0.55) {
  return similarity(candidateText, anchorText) >= threshold;
}

export function isSameAnnouncementRestatement(candidateText, anchor, entity = null) {
  const anchorText = String(anchor?.text || anchor || '');
  if (isParaphraseOfAnchor(candidateText, anchorText, 0.55)) return true;
  const name = String(entity || '').trim();
  if (!name) return false;
  const candidateHas = String(candidateText || '').toLowerCase().includes(name.toLowerCase());
  const anchorHas = anchorText.toLowerCase().includes(name.toLowerCase());
  return candidateHas && anchorHas && DIRECT_PROMO.test(candidateText);
}

export function applyOverlapDecision(decision, { candidateText = null } = {}) {
  if (!decision?.overlapped) return { proceed: true, action: null, rewrite: null, needsRewrite: false };
  if (decision.action === 'skip' || decision.action === 'delay') {
    return { proceed: false, action: decision.action, rewrite: null, needsRewrite: false };
  }
  const anchor = decision.match?.entry;
  if (candidateText && anchor && isParaphraseOfAnchor(candidateText, anchor.text)) {
    return { proceed: false, action: 'skip', rewrite: null, needsRewrite: false, reason: 'paraphrase-of-human-anchor' };
  }
  if (decision.action === 'reframe') {
    return { proceed: true, action: 'reframe', rewrite: 'orbit-different-entry', needsRewrite: true };
  }
  if (decision.action === 'replace') {
    return { proceed: true, action: 'replace', rewrite: 'different-candidate', needsRewrite: true };
  }
  return { proceed: false, action: 'skip', rewrite: null, needsRewrite: false };
}

export function assertOverlapSafe({ decision, candidateText, entity = null }) {
  const applied = applyOverlapDecision(decision, { candidateText });
  if (!applied.proceed) {
    const error = new Error(`Artist manual overlap: ${applied.action}`);
    error.code = 'ARTIST_OVERLAP';
    error.action = applied.action;
    throw error;
  }
  const anchor = decision?.match?.entry;
  if (decision?.overlapped && candidateText && isSameAnnouncementRestatement(candidateText, anchor, entity)) {
    const error = new Error('Artist overlap rewrite still restates the human announcement.');
    error.code = 'ARTIST_OVERLAP';
    error.action = decision.action === 'replace' ? 'replace' : 'skip';
    throw error;
  }
  return applied;
}

export const __test = { ACTIONS, DIRECT_PROMO, publishedRecently, urlsIn, sameUrl };
