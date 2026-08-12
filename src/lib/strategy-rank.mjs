const DIMS = ['topic', 'angle', 'hook', 'emotion', 'format', 'cta', 'mediaDecision'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function learnedCandidateScore(candidate, strategy) {
  if (!strategy?.featureStats) return 50;
  const values = [];
  for (const dim of DIMS) {
    const value = candidate.features?.[dim] ?? candidate[dim];
    const stat = value ? strategy.featureStats?.[dim]?.[String(value)] : null;
    if (stat && Number(stat.n) > 0) values.push(Number(stat.averageScore || 50) * Number(stat.confidence ?? 1));
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 50;
}

export function rankCandidates(candidates, strategy, { explore = false } = {}) {
  return (candidates || []).map((candidate) => {
    const ai = clamp(Number(candidate.spreadPotential ?? 50), 0, 100);
    const novelty = clamp(Number(candidate.noveltyPotential ?? 50), 0, 100);
    const learned = learnedCandidateScore(candidate, strategy);
    const score = explore ? ai * 0.45 + novelty * 0.35 + learned * 0.20 : ai * 0.55 + learned * 0.40 + novelty * 0.05;
    return { ...candidate, predictedScore: Math.round(score * 10) / 10 };
  }).sort((a, b) => b.predictedScore - a.predictedScore);
}

export function shouldExplore(slotId, rate = 0.2) {
  let hash = 2166136261;
  for (const char of String(slotId || '')) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) % 10000 < Math.round(clamp(Number(rate), 0, 1) * 10000);
}
