// Deterministic checks for the quality conditions that can be verified mechanically. "No invented
// settings" cannot be checked here; it is enforced by the prompt and by the operator's review.
import { xWeightedLength } from '../lib/safety.mjs';

const TEXT_FIELDS = ['caption_jp', 'caption_en', 'youtube_title_jp', 'youtube_title_en', 'x_text'];
const EXPLANATORY_ENDING = /(?:のです|です|でした|ます|ました|でしょう|ません)$/;
const TRAILING_NOISE = /[\s。．.!！?？…~〜ー♪☆★♡❤️🔥✨\p{Extended_Pictographic}」』）)\]】"'”’]+$/u;
const QUESTION_CLOSE = /(?:[?？]|でしょうか|ませんか|ですか|ますか|だろうか)[\s。!！”"」』）)]*$/u;
const TEMPLATE_OPENERS = [/^\s*ワールドクリエイター/, /^\s*.{0,24}としての[、,]?\s*.{0,24}の世界[。.]/];
const END_CARD = /エンドカード|エンディングカード|ロゴ画面|end[\s-]?card|logo\s?screen/i;
const URL_LIKE = /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|jp|net|org|io|co|be|tv)\b/i;
const BAD_NAMES = [/Sanpotto/i, /Sunpotto/i, /Mandora[\s-]?gon/i, /Mandorgon/i];

export function splitSentences(value) {
  return String(value || '').split(/(?<=[。！？!?])|\n+/u).map((part) => part.trim()).filter(Boolean);
}

export function explanatoryRun(value) {
  let longest = 0; let run = 0;
  for (const sentence of splitSentences(value)) {
    const core = sentence.replace(TRAILING_NOISE, '');
    if (EXPLANATORY_ENDING.test(core)) { run += 1; longest = Math.max(longest, run); } else run = 0;
  }
  return longest;
}

export function checkVariants(variants, brief, { minVariants = 3 } = {}) {
  const errors = [];
  if (!Array.isArray(variants) || variants.length < minVariants) {
    return [`variants must contain at least ${minVariants} entries (got ${Array.isArray(variants) ? variants.length : 'none'}).`];
  }
  const sceneAndNotes = `${brief.scene}\n${brief.notes || ''}`;
  const seenAngles = new Map();
  const seenCaptions = new Set();
  let questionClosers = 0;

  variants.forEach((variant, index) => {
    const tag = `variant ${variant?.id ?? index + 1}`;
    for (const field of ['angle', ...TEXT_FIELDS]) {
      if (typeof variant?.[field] !== 'string' || !variant[field].trim()) errors.push(`${tag}: ${field} is empty.`);
    }
    if (!Array.isArray(variant?.hashtags) || !variant.hashtags.length) errors.push(`${tag}: hashtags must be a non-empty array.`);
    else {
      for (const tagValue of variant.hashtags) if (typeof tagValue !== 'string' || !/^#[^\s#]+$/u.test(tagValue)) errors.push(`${tag}: invalid hashtag ${JSON.stringify(tagValue)}.`);
      if (new Set(variant.hashtags).size !== variant.hashtags.length) errors.push(`${tag}: duplicate hashtags.`);
    }
    if (typeof variant?.caption_jp !== 'string') return;

    const angleKey = String(variant.angle || '').replace(/[\s、。・\-]/g, '').toLowerCase();
    if (angleKey) {
      for (const [other, otherId] of seenAngles) {
        if (other === angleKey || other.includes(angleKey) || angleKey.includes(other)) errors.push(`${tag}: angle overlaps with variant ${otherId}.`);
      }
      seenAngles.set(angleKey, variant.id ?? index + 1);
    }
    const captionKey = variant.caption_jp.replace(/\s/g, '');
    if (seenCaptions.has(captionKey)) errors.push(`${tag}: caption_jp duplicates another variant.`);
    seenCaptions.add(captionKey);

    if (explanatoryRun(variant.caption_jp) >= 2) errors.push(`${tag}: caption_jp chains ですます-style sentences (use 言い切り/体言止め).`);
    for (const opener of TEMPLATE_OPENERS) {
      if (opener.test(variant.caption_jp) || opener.test(variant.youtube_title_jp || '')) errors.push(`${tag}: uses a fixed template opener.`);
    }
    if (QUESTION_CLOSE.test(variant.caption_jp.trim()) || /\?\s*$/.test(String(variant.caption_en || '').trim())) questionClosers += 1;

    for (const field of TEXT_FIELDS) {
      const value = variant[field];
      if (typeof value !== 'string') continue;
      if (END_CARD.test(value) && !END_CARD.test(sceneAndNotes)) errors.push(`${tag}: ${field} mentions the end card/logo.`);
      for (const bad of BAD_NAMES) if (bad.test(value)) errors.push(`${tag}: ${field} uses a forbidden name spelling (${bad}).`);
    }
    for (const field of ['caption_en', 'youtube_title_en']) {
      if (/ひぐま|さんぽっと|マンドラごん/.test(variant[field] || '')) errors.push(`${tag}: ${field} contains Japanese character names; use Higuma / Sunpot / Mandoragon.`);
    }
    if (typeof variant.x_text === 'string') {
      if (URL_LIKE.test(variant.x_text)) errors.push(`${tag}: x_text contains a link.`);
      if (xWeightedLength(variant.x_text) > 280) errors.push(`${tag}: x_text exceeds 280 weighted characters (${xWeightedLength(variant.x_text)}).`);
    }
    for (const field of ['youtube_title_jp', 'youtube_title_en']) {
      if ([...String(variant[field] || '')].length > 100) errors.push(`${tag}: ${field} exceeds 100 characters.`);
    }
  });
  if (questionClosers > 1) errors.push(`${questionClosers} variants close with a question to the reader (max 1).`);
  return errors;
}
