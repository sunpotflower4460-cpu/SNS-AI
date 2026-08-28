import { fetchPublicHttps } from '../../lib/http.mjs';
import { normalizeCandidate } from './normalize.mjs';

function decodeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripCdata(value) {
  return String(value || '').replace(/^\s*<!\[CDATA\[/i, '').replace(/\]\]>\s*$/i, '');
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  if (!match) return '';
  return decodeEntities(stripCdata(match[1])).replace(/<[^>]+>/g, '').trim();
}

function attr(block, name, attrName) {
  const match = block.match(new RegExp(`<${name}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*/?>`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

// A minimal, dependency-free RSS 2.0 / Atom item extractor. This repository has zero npm dependencies
// (see package.json) and RSS/Atom feed structure for the fields this pipeline needs (title, link,
// published date, summary, guid) is simple enough that a full XML parser/DOM would be a heavier
// dependency than the problem warrants.
export function parseFeed(xml) {
  const source = String(xml || '');
  const isAtom = /<feed[\s>]/i.test(source) && !/<rss[\s>]/i.test(source);
  const pattern = isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;
  const blocks = [...source.matchAll(pattern)].map((match) => match[0]);
  return blocks.map((block) => {
    const title = tag(block, 'title');
    const link = isAtom ? (attr(block, 'link', 'href') || tag(block, 'link')) : tag(block, 'link');
    const publishedRaw = tag(block, isAtom ? 'updated' : 'pubDate') || tag(block, 'published') || tag(block, 'dc:date');
    const summary = tag(block, isAtom ? 'summary' : 'description') || tag(block, 'content') || tag(block, 'content:encoded');
    const guid = tag(block, 'guid') || tag(block, 'id');
    let publishedAt = null;
    if (publishedRaw) {
      const parsed = new Date(publishedRaw);
      if (!Number.isNaN(parsed.getTime())) publishedAt = parsed.toISOString();
    }
    return { title, url: link || guid || null, publishedAt, summary, guid: guid || link || null };
  }).filter((item) => item.title || item.url);
}

export async function fetchRssSource(source) {
  if (!source?.url) throw new Error(`RSS source ${source?.id || '(unknown)'} is missing a url.`);
  const response = await fetchPublicHttps(source.url, {}, `research-source:${source.id}`);
  if (!response.ok) throw new Error(`RSS fetch failed for ${source.id}: HTTP ${response.status}`);
  const xml = await response.text();
  const items = parseFeed(xml);
  const fetchedAt = new Date().toISOString();
  return items.slice(0, Number(source.maxItems || 20)).map((item) => normalizeCandidate({
    sourceId: source.id,
    sourceType: source.type || 'rss',
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    fetchedAt,
    vendor: source.vendor || null,
    product: source.product || null,
    summary: item.summary,
    rawText: item.summary,
    categories: source.categories || [],
    metadata: { guid: item.guid || null }
  }));
}

export const __test = { parseFeed, tag, attr, decodeEntities };
