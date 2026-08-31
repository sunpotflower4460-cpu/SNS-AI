import { isSameAnnouncementRestatement, isParaphraseOfAnchor } from './overlap.mjs';

export const ORBIT_ANGLES = [
  'vocal',
  'lyric',
  'guitar',
  'songwriting',
  'production',
  'atmosphere',
  'story',
  'beginner-entry',
  'artist-personality',
  'music-discovery',
  'taste-connection',
  'live-energy',
  'quiet-performance',
  'technical',
  'past-performance',
  'alternate-arrangement',
  'related-song'
];

const FORBIDDEN_COPY = 'AI must not restate or lightly paraphrase the human post.';

export function extractTheme(anchor = {}) {
  return String(anchor.entityName || '').trim() || null;
}

export function proposeOrbit({ anchor = null, library = null, assets = [] } = {}) {
  if (!anchor) {
    return {
      active: false,
      theme: null,
      candidates: [],
      forbidden: ['fabricate a human moment'],
      why: 'No Human Anchor in window; Orbit is idle.'
    };
  }
  const theme = extractTheme(anchor);
  const assetAngles = (assets || []).flatMap((asset) => asset.remainingAngles || []).filter((angle) => ORBIT_ANGLES.includes(angle));
  const candidates = [
    { angle: 'past-performance', why: '同じ曲でも別時期・別テイクの入口' },
    { angle: 'lyric', why: '告知の繰り返しではなく歌詞の別部分' },
    { angle: 'taste-connection', why: '曲そのものではなく関連Tasteへ' },
    { angle: 'production', why: '制作背景・演奏面' },
    { angle: 'alternate-arrangement', why: '別アレンジ' },
    { angle: 'related-song', why: '関連する別曲' },
    { angle: 'guitar', why: '演奏の切り口' },
    { angle: 'quiet-performance', why: 'ライブ告知のコピーではない静かな演奏入口' }
  ].filter((row) => !theme || row.angle !== 'direct-copy');

  const unique = [];
  const seen = new Set();
  for (const row of [...candidates, ...assetAngles.map((angle) => ({ angle, why: 'remaining unused angle on a master asset' }))]) {
    if (seen.has(row.angle)) continue;
    seen.add(row.angle);
    unique.push(row);
  }

  return {
    active: true,
    theme,
    anchorText: String(anchor.text || '').slice(0, 280),
    candidates: unique.slice(0, 8),
    forbidden: [
      FORBIDDEN_COPY,
      theme ? `direct promo restating ${theme}` : 'direct promo restating the human announcement',
      `copy: ${String(anchor.text || '').slice(0, 120)}`
    ],
    libraryAvailable: Boolean(library),
    why: theme
      ? `Human Anchor は「${theme}」。AI Orbit は同じ告知の言い直しではなく別の入口を使う。`
      : 'Human Anchor あり。同一投稿の言い直しは禁止。別入口・別素材・別topicへ。'
  };
}

export function orbitRejectsCandidate({ candidateText, anchor, entity = null }) {
  if (!anchor || !candidateText) return { reject: false, reason: null };
  if (isParaphraseOfAnchor(candidateText, anchor.text || anchor)) {
    return { reject: true, reason: 'paraphrase-of-human-anchor' };
  }
  if (isSameAnnouncementRestatement(candidateText, anchor, entity || extractTheme(anchor))) {
    return { reject: true, reason: 'same-entity-promo' };
  }
  return { reject: false, reason: null };
}

export const __test = { FORBIDDEN_COPY };
