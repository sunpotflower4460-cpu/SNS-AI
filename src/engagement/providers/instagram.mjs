import { fetchJson } from '../../lib/http.mjs';

const DEFAULT_MAX_PAGES = 5;
const ABSOLUTE_MAX_PAGES = 20;

function apiBase(apiVersion = 'v25.0') {
  const version = String(apiVersion || '').trim();
  if (!/^v\d+\.\d+$/.test(version)) throw new Error('Instagram apiVersion must look like v25.0.');
  return `https://graph.instagram.com/${version}`;
}

function auth(accessToken, json = false) {
  const token = String(accessToken || '').trim();
  if (!token) throw new Error('Instagram accessToken is required.');
  return json
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${token}` };
}

function id(value, label) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a numeric Instagram id.`);
  return text;
}

function text(value) {
  const output = String(value || '').trim();
  if (!output) throw new Error('Instagram response text is required.');
  return output;
}

function pageLimit(value = DEFAULT_MAX_PAGES) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return DEFAULT_MAX_PAGES;
  return Math.min(number, ABSOLUTE_MAX_PAGES);
}

function paginationTruncated(kind, maxPages) {
  const error = new Error(`Instagram ${kind} pagination exceeded the ${maxPages}-page safety cap; refusing to report the channel healthy while unread interactions remain.`);
  error.code = 'ENGAGEMENT_PAGINATION_TRUNCATED';
  return error;
}

function safePagingUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('Instagram pagination returned an invalid next-page URL.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'graph.instagram.com' || url.username || url.password) {
    throw new Error('Instagram pagination attempted to leave the trusted Graph API origin.');
  }
  if (!/^\/v\d+\.\d+\//.test(url.pathname)) throw new Error('Instagram pagination URL is missing a versioned Graph API path.');
  // Some Graph responses historically included tokens in paging links. Never carry those forward in
  // a URL where they can surface in network errors or logs; this runtime authenticates via header only.
  url.searchParams.delete('access_token');
  return url.toString();
}

function mergeGraphEdgePages(pages) {
  const data = pages.flatMap((page) => Array.isArray(page?.data) ? page.data : []);
  const last = pages.at(-1) || {};
  const paging = last.paging ? structuredClone(last.paging) : undefined;
  if (paging) delete paging.next;
  return { ...last, data, ...(paging ? { paging } : {}) };
}

async function paginateGraphEdge(firstPage, { accessToken, kind = 'edge', maxPages = DEFAULT_MAX_PAGES } = {}) {
  const limit = pageLimit(maxPages);
  const pages = [firstPage || {}];
  let next = firstPage?.paging?.next || null;
  while (next && pages.length < limit) {
    const page = await fetchJson(safePagingUrl(next), { method: 'GET', headers: auth(accessToken) });
    pages.push(page || {});
    next = page?.paging?.next || null;
  }
  if (next) throw paginationTruncated(kind, limit);
  return mergeGraphEdgePages(pages);
}

export function buildInstagramCommentsUrl({ mediaId, apiVersion = 'v25.0', after } = {}) {
  const url = new URL(`${apiBase(apiVersion)}/${id(mediaId, 'mediaId')}/comments`);
  url.searchParams.set('fields', 'id,from,text,timestamp,parent_id');
  if (after) url.searchParams.set('after', String(after));
  return url.toString();
}

export function buildInstagramConversationsUrl({ igUserId, apiVersion = 'v25.0', after } = {}) {
  const url = new URL(`${apiBase(apiVersion)}/${id(igUserId, 'igUserId')}/conversations`);
  url.searchParams.set('platform', 'instagram');
  url.searchParams.set('fields', 'id,updated_time');
  url.searchParams.set('limit', '25');
  if (after) url.searchParams.set('after', String(after));
  return url.toString();
}

export function buildInstagramConversationMessagesUrl({ conversationId, apiVersion = 'v25.0' } = {}) {
  const url = new URL(`${apiBase(apiVersion)}/${id(conversationId, 'conversationId')}`);
  url.searchParams.set('fields', 'messages.limit(25){id,created_time,from,to,message,is_unsupported}');
  return url.toString();
}

export function buildInstagramCommentReplyPayload({ message }) {
  return { message: text(message) };
}

export function buildInstagramPrivateReplyPayload({ commentId, message }) {
  return { recipient: { comment_id: id(commentId, 'commentId') }, message: { text: text(message) } };
}

export function buildInstagramDmPayload({ recipientId, message }) {
  return { recipient: { id: id(recipientId, 'recipientId') }, message: { text: text(message) } };
}

export async function listInstagramComments({ accessToken, maxPages = DEFAULT_MAX_PAGES, ...params }) {
  const first = await fetchJson(buildInstagramCommentsUrl(params), { method: 'GET', headers: auth(accessToken) });
  return paginateGraphEdge(first, { accessToken, kind: 'comments', maxPages });
}

export async function listInstagramConversations({ accessToken, maxPages = DEFAULT_MAX_PAGES, ...params }) {
  const first = await fetchJson(buildInstagramConversationsUrl(params), { method: 'GET', headers: auth(accessToken) });
  return paginateGraphEdge(first, { accessToken, kind: 'conversations', maxPages });
}

export async function listInstagramConversationMessages({ accessToken, maxPages = DEFAULT_MAX_PAGES, ...params }) {
  const detail = await fetchJson(buildInstagramConversationMessagesUrl(params), { method: 'GET', headers: auth(accessToken) });
  if (!detail?.messages) return detail;
  const messages = await paginateGraphEdge(detail.messages, { accessToken, kind: 'conversation messages', maxPages });
  return { ...detail, messages };
}

export async function sendInstagramCommentReply({ accessToken, commentId, message, apiVersion = 'v25.0', dryRun = true }) {
  const payload = buildInstagramCommentReplyPayload({ message });
  const url = `${apiBase(apiVersion)}/${id(commentId, 'commentId')}/replies`;
  if (dryRun) return { dryRun: true, platform: 'instagram', action: 'comment-reply', url, payload };
  return fetchJson(url, { method: 'POST', headers: auth(accessToken, true), body: JSON.stringify(payload), retries: 0 });
}

export async function sendInstagramPrivateReply({ accessToken, igUserId, commentId, message, apiVersion = 'v25.0', dryRun = true }) {
  const payload = buildInstagramPrivateReplyPayload({ commentId, message });
  const url = `${apiBase(apiVersion)}/${id(igUserId, 'igUserId')}/messages`;
  if (dryRun) return { dryRun: true, platform: 'instagram', action: 'private-reply', url, payload };
  return fetchJson(url, { method: 'POST', headers: auth(accessToken, true), body: JSON.stringify(payload), retries: 0 });
}

export async function sendInstagramDm({ accessToken, igUserId, recipientId, message, apiVersion = 'v25.0', dryRun = true }) {
  const payload = buildInstagramDmPayload({ recipientId, message });
  const url = `${apiBase(apiVersion)}/${id(igUserId, 'igUserId')}/messages`;
  if (dryRun) return { dryRun: true, platform: 'instagram', action: 'dm', url, payload };
  return fetchJson(url, { method: 'POST', headers: auth(accessToken, true), body: JSON.stringify(payload), retries: 0 });
}

export const __test = {
  DEFAULT_MAX_PAGES,
  ABSOLUTE_MAX_PAGES,
  apiBase,
  auth,
  id,
  text,
  pageLimit,
  paginationTruncated,
  safePagingUrl,
  mergeGraphEdgePages,
  paginateGraphEdge,
  buildInstagramConversationsUrl,
  buildInstagramConversationMessagesUrl
};
