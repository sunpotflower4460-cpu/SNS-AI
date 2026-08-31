export const CLAIM_TYPES = ['lived-experience', 'taste', 'objective-fact', 'recommendation', 'production-note'];
export const EVIDENCE_LEVELS = ['confirmed_personal', 'taste_match', 'external_discovery'];

export function createClaim({
  claim,
  claimType = 'objective-fact',
  evidenceLevel,
  evidenceId = null,
  source = 'artist-library'
} = {}) {
  if (!EVIDENCE_LEVELS.includes(evidenceLevel)) {
    const error = new Error('claim missing evidenceLevel');
    error.code = 'ARTIST_EVIDENCE_UNKNOWN';
    throw error;
  }
  if (!CLAIM_TYPES.includes(claimType)) {
    const error = new Error(`unknown claimType ${claimType}`);
    error.code = 'ARTIST_CLAIM_TYPE';
    throw error;
  }
  return { claim: String(claim || ''), claimType, evidenceLevel, evidenceId, source };
}

export function personalWordingAllowed(evidenceLevel) {
  return evidenceLevel === 'confirmed_personal';
}

export function assertClaimsForLevel(claims = [], evidenceLevel) {
  const level = evidenceLevel || null;
  if (!EVIDENCE_LEVELS.includes(level)) {
    const error = new Error('Artist evidence level is missing; fail closed.');
    error.code = 'ARTIST_EVIDENCE_UNKNOWN';
    throw error;
  }
  for (const row of claims) {
    if (row.claimType === 'lived-experience' && row.evidenceLevel !== 'confirmed_personal') {
      const error = new Error('Lived-experience claim requires confirmed_personal provenance.');
      error.code = 'ARTIST_EVIDENCE_VIOLATION';
      error.level = row.evidenceLevel;
      throw error;
    }
    if (level === 'external_discovery' && row.claimType !== 'objective-fact') {
      const error = new Error('external_discovery allows objective claims only.');
      error.code = 'ARTIST_EVIDENCE_VIOLATION';
      error.level = level;
      throw error;
    }
    if (level === 'taste_match' && row.claimType === 'lived-experience') {
      const error = new Error('taste_match cannot carry lived-experience provenance.');
      error.code = 'ARTIST_EVIDENCE_VIOLATION';
      error.level = level;
      throw error;
    }
  }
  return { ok: true, level, claims };
}

export function attachProvenance(draft, claims = []) {
  return {
    ...draft,
    claims,
    evidenceLevel: draft?.evidenceLevel || claims[0]?.evidenceLevel || null,
    provenance: {
      claims,
      note: 'Regex voice guard is a second line of defense. Do not infer lived experience only from generated prose.'
    }
  };
}

export const __test = { CLAIM_TYPES, EVIDENCE_LEVELS };
