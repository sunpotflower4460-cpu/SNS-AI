// Brief ("ブリーフ") parsing and validation for the copy-draft step. Pure functions only.
import { createHash } from 'node:crypto';

export const MEDIA_TYPES = ['video', 'image'];
export const PLATFORMS = ['instagram', 'threads', 'youtube', 'tiktok', 'x'];
const LIMITS = { character: 40, scene: 1200, notes: 800 };

function text(value, field, { required }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`Brief field "${field}" is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`Brief field "${field}" must be a string.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`Brief field "${field}" must not be empty.`);
  if (trimmed.length > LIMITS[field]) throw new Error(`Brief field "${field}" is too long (max ${LIMITS[field]} chars).`);
  return trimmed;
}

export function parseBrief(input) {
  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw new Error('Brief is not valid JSON.'); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Brief must be a JSON object.');
  const known = new Set(['character', 'scene', 'media', 'platforms', 'notes', 'slug']);
  const extra = Object.keys(raw).filter((key) => !known.has(key));
  if (extra.length) throw new Error(`Brief has unknown field(s): ${extra.join(', ')}.`);

  const character = text(raw.character, 'character', { required: true });
  const scene = text(raw.scene, 'scene', { required: true });
  const notes = text(raw.notes, 'notes', { required: false });
  if (!MEDIA_TYPES.includes(raw.media)) throw new Error(`Brief field "media" must be one of: ${MEDIA_TYPES.join(' | ')}.`);
  if (!Array.isArray(raw.platforms) || !raw.platforms.length) throw new Error('Brief field "platforms" must be a non-empty array.');
  const platforms = [...new Set(raw.platforms.map((value) => String(value).trim().toLowerCase()))];
  const unknown = platforms.filter((value) => !PLATFORMS.includes(value));
  if (unknown.length) throw new Error(`Brief field "platforms" has unsupported value(s): ${unknown.join(', ')}.`);
  let slug = null;
  if (raw.slug !== undefined && raw.slug !== null && raw.slug !== '') {
    if (typeof raw.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(raw.slug)) throw new Error('Brief field "slug" must match /^[a-z0-9][a-z0-9-]{0,39}$/.');
    slug = raw.slug;
  }
  return { character, scene, media: raw.media, platforms, notes, slug };
}

// Deterministic file slug: explicit brief.slug, else the character name (letters/digits only, so it is
// always path-safe) plus a short content hash so two different briefs on the same day never collide.
export function briefSlug(brief) {
  const hash = createHash('sha256').update(JSON.stringify([brief.character, brief.scene, brief.media, brief.platforms])).digest('hex').slice(0, 6);
  if (brief.slug) return `${brief.slug}-${hash}`;
  const base = brief.character.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'brief';
  return `${base}-${hash}`;
}
