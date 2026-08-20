import { xOAuth2FetchJson } from '../../providers/x-oauth2.mjs';
import { assertProviderMutationAllowed, loadRuntimePolicy } from '../../ops/manual-only.mjs';

const X_API = 'https://api.x.com/2';
const DEFAULT_MAX_PAGES = 5;
const ABSOLUTE_MAX_PAGES = 20;

function id(value, label) {
  const text = String(value || '').trim();
  if (!/^\d{1,19}$/.test(text)) throw new Error(`${label} must be a numeric X id.`);
  return text;
}

function message(value, label = 'text') {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function pageLimit(value = DEFAULT_MAX_PAGES) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return DEFAULT_MAX_PAGES;
  return Math.min(number, ABSOLUTE_MAX_PAGES);
}

function paginationTruncated(kind, maxPages) {
  const error = new Error(`X ${kind} pagination exceeded the ${maxPages}-page safety cap; refusing to report the channel healthy while unread interactions remain.`);
  error.code = 'ENGAGEMENT_PAGINATION_TRUNCATED';
  return error;
}

function mergeXPages(pages) {
  const data = pages.flatMap((page) => Array.isArray(page?.data) ? page.data : []);
  const users = new Map();
  for (const page of pages) {
    for (const user of page?.includes?.users || []) {
      const key = String(user?.id || '');
      if (key) users.set(key, user);
    }
  }
  const last = pages.at(-1) || {};
  const meta = { ...(last.meta || {}), result_count: data.length };
  delete meta.next_token;
  delete meta.previous_token;
  const output = { ...last, data, meta };
  if (users.size) output.includes = { ...(last.includes || {}), users: [...users.values()] };
  return output;
}

async function paginateX(fetchPage, { kind = 'engagement', maxPages = DEFAULT_MAX_PAGES } = {}) {
  const limit = pageLimit(maxPages);
  const pages = [];
  let paginationToken = null;
  for (let index = 0; index < limit; index += 1) {
    const page = await fetchPage(paginationToken);
    pages.push(page || {});
    paginationToken = page?.meta?.next_token || null;
    if (!paginationToken) return mergeXPages(pages);
  }
  throw paginationTruncated(kind, limit);
}

async function assertLiveMutationAllowed(source) {
  const runtimePolicy = await loadRuntimePolicy();
  assertProviderMutationAllowed(runtimePolicy, { dryRun: false, source });
}

export function buildXMentionsUrl({ userId, sinceId, paginationToken, maxResults = 20 } = {}) {
  const url = new URL(`${X_API}/users/${id(userId, 'userId')}/mentions`);
  url.searchParams.set('max_results', String(Math.max(5, Math.min(100, Number(maxResults) || 20))));
  url.searchParams.set('tweet.fields', 'author_id,conversation_id,created_at,in_reply_to_user_id,referenced_tweets');
  url.searchParams.set('expansions', 'author_id');
  url.searchParams.set('user.fields', 'id,name,username');
  if (sinceId) url.searchParams.set('since_id', id(sinceId, 'sinceId'));
  if (paginationToken) url.searchParams.set('pagination_token', String(paginationToken));
  return url.toString();
}

export function buildXDmEventsUrl({ paginationToken, maxResults = 50 } = {}) {
  const url = new URL(`${X_API}/dm_events`);
  url.searchParams.set('max_results', String(Math.max(1, Math.min(100, Number(maxResults) || 50))));
  url.searchParams.set('dm_event.fields', 'id,event_type,text,sender_id,dm_conversation_id,created_at,participant_ids');
  url.searchParams.set('expansions', 'sender_id,participant_ids');
  url.searchParams.set('user.fields', 'id,name,username');
  if (paginationToken) url.searchParams.set('pagination_token', String(paginationToken));
  return url.toString();
}

export function buildXReplyPayload({ postId, text }) {
  return { text: message(text), reply: { in_reply_to_tweet_id: id(postId, 'postId') } };
}

export function buildXDmPayload({ text }) {
  return { text: message(text) };
}

export async function listXMentions({ credential, maxPages = DEFAULT_MAX_PAGES, ...params }) {
  return paginateX(
    (paginationToken) => xOAuth2FetchJson(buildXMentionsUrl({ ...params, paginationToken }), { method: 'GET' }, credential),
    { kind: 'mentions', maxPages }
  );
}

export async function listXDirectMessages({ credential, maxPages = DEFAULT_MAX_PAGES, ...params }) {
  return paginateX(
    (paginationToken) => xOAuth2FetchJson(buildXDmEventsUrl({ ...params, paginationToken }), { method: 'GET' }, credential),
    { kind: 'DM events', maxPages }
  );
}

export async function sendXReply({ credential, postId, text, dryRun = true }) {
  const payload = buildXReplyPayload({ postId, text });
  if (dryRun) return { dryRun: true, platform: 'x', action: 'reply', payload };
  await assertLiveMutationAllowed('engagement:x:reply');
  return xOAuth2FetchJson(`${X_API}/tweets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  }, credential);
}

export async function sendXDirectMessage({ credential, participantId, text, dryRun = true }) {
  const participant = id(participantId, 'participantId');
  const payload = buildXDmPayload({ text });
  if (dryRun) return { dryRun: true, platform: 'x', action: 'dm', participantId: participant, payload };
  await assertLiveMutationAllowed('engagement:x:dm');
  return xOAuth2FetchJson(`${X_API}/dm_conversations/with/${encodeURIComponent(participant)}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  }, credential);
}

export const __test = {
  X_API,
  DEFAULT_MAX_PAGES,
  ABSOLUTE_MAX_PAGES,
  id,
  message,
  pageLimit,
  paginationTruncated,
  mergeXPages,
  paginateX
};
