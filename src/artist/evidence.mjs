const LEVELS = new Set(['confirmed_personal', 'taste_match', 'external_discovery']);

const PERSONAL_EXPERIENCE = [
  /使ってみて/,
  /使ってみた/,
  /試してみたら/,
  /最近ハマって/,
  /これ最高だった/,
  /愛用して/,
  /所有して/,
  /行ってきた/,
  /聴いた/,
  /聴いてみて/,
  /撮ってきた/,
  /自分で使/,
  /i (used|tried|heard|went|own|love)/i
];

const TASTE_OK = [
  /気になる/,
  /面白い/,
  /こういうものがある/,
  /チェックしてもよさそう/,
  /この仕組み/,
  /好きなら/
];

const OBJECTIVE_OK = [
  /こういう作品がある/,
  /発表された/,
  /公開されている/,
  /入手できる/,
  /公式によると/
];

export function normalizeEvidenceLevel(value) {
  const level = String(value || '').trim();
  return LEVELS.has(level) ? level : null;
}

export function detectPersonalExperience(text) {
  const body = String(text || '');
  return PERSONAL_EXPERIENCE.filter((pattern) => pattern.test(body)).map((pattern) => pattern.toString());
}

export function assertArtistVoice({ text, evidenceLevel }) {
  const level = normalizeEvidenceLevel(evidenceLevel);
  if (!level) {
    const error = new Error('Artist evidence level is missing; fail closed.');
    error.code = 'ARTIST_EVIDENCE_UNKNOWN';
    throw error;
  }
  const personal = detectPersonalExperience(text);
  if (level === 'confirmed_personal') return { ok: true, level, personalAllowed: true };
  if (personal.length) {
    const error = new Error(`Personal-experience language is not allowed at evidence level "${level}".`);
    error.code = 'ARTIST_EVIDENCE_VIOLATION';
    error.level = level;
    error.hits = personal;
    throw error;
  }
  return { ok: true, level, personalAllowed: false };
}

export function classifyArtistClaim(text, evidenceLevel) {
  try {
    return { ...assertArtistVoice({ text, evidenceLevel }), allowed: true };
  } catch (error) {
    if (error.code === 'ARTIST_EVIDENCE_VIOLATION' || error.code === 'ARTIST_EVIDENCE_UNKNOWN') {
      return { allowed: false, ok: false, level: error.level || evidenceLevel || null, code: error.code, hits: error.hits || [] };
    }
    throw error;
  }
}

export function emptyArtistLibrary() {
  return {
    schemaVersion: 1,
    brandId: 'artist',
    evidence: { confirmed_personal: [], taste_match: [], external_discovery: [] },
    assets: {
      songs: [], lyrics: [], albumArtwork: [], musicVideos: [], liveVideos: [], acousticVideos: [],
      photos: [], studioFootage: [], shortClips: [], profilePhotos: [], releaseUrls: [], streamingUrls: [],
      songBackgroundStories: [], productionNotes: [], instruments: [], plugins: [],
      confirmedInterests: [], confirmedRecommendations: []
    }
  };
}

export const __test = { LEVELS, PERSONAL_EXPERIENCE, TASTE_OK, OBJECTIVE_OK };
