import { similarity } from '../lib/duplicate.mjs';

const ACTIONS = new Set(['reframe', 'delay', 'replace', 'skip']);

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
    if (entry.source === 'sns-ai' || entry.source === 'auto' || entry.source === 'approval') return false;
    return publishedRecently(entry, now, lookbackHours);
  });

  let best = null;
  for (const entry of recent) {
    const score = similarity(candidateText, entry.text);
    const entityHit = candidateEntity && String(entry.text || '').toLowerCase().includes(String(candidateEntity).toLowerCase());
    const urlHit = sameUrl(candidateText, entry.text);
    const overlapped = score >= similarityThreshold || entityHit || urlHit;
    if (!overlapped) continue;
    if (!best || score > best.score) {
      best = {
        score,
        entry,
        entityHit: Boolean(entityHit),
        urlHit,
        action: entityHit || urlHit ? 'replace' : (score >= 0.8 ? 'skip' : 'reframe')
      };
    }
  }
  if (!best) return { overlapped: false, action: null, match: null };
  if (!ACTIONS.has(best.action)) best.action = 'skip';
  return { overlapped: true, action: best.action, match: best };
}

export function applyOverlapDecision(decision) {
  if (!decision?.overlapped) return { proceed: true, action: null };
  if (decision.action === 'skip' || decision.action === 'delay') return { proceed: false, action: decision.action };
  return { proceed: false, action: decision.action, needsRewrite: decision.action === 'reframe' || decision.action === 'replace' };
}

export const __test = { ACTIONS, publishedRecently, urlsIn, sameUrl };
