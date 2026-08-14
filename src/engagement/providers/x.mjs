import { xOAuth2FetchJson } from '../../providers/x-oauth2.mjs';

const X_API = 'https://api.x.com/2';

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

export async function listXMentions({ credential, ...params }) {
  return xOAuth2FetchJson(buildXMentionsUrl(params), { method: 'GET' }, credential);
}

export async function listXDirectMessages({ credential, ...params }) {
  return xOAuth2FetchJson(buildXDmEventsUrl(params), { method: 'GET' }, credential);
}

export async function sendXReply({ credential, postId, text, dryRun = true }) {
  const payload = buildXReplyPayload({ postId, text });
  if (dryRun) return { dryRun: true, platform: 'x', action: 'reply', payload };
  return xOAuth2FetchJson(`${X_API}/tweets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  }, credential);
}

export async function sendXDirectMessage({ credential, participantId, text, dryRun = true }) {
  const participant = id(participantId, 'participantId');
  const payload = buildXDmPayload({ text });
  if (dryRun) return { dryRun: true, platform: 'x', action: 'dm', participantId: participant, payload };
  return xOAuth2FetchJson(`${X_API}/dm_conversations/with/${encodeURIComponent(participant)}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  }, credential);
}

export const __test = { X_API, id, message };
