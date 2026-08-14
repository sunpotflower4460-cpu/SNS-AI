import { fetchJson } from '../../lib/http.mjs';

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

export function buildInstagramCommentsUrl({ mediaId, apiVersion = 'v25.0', after } = {}) {
  const url = new URL(`${apiBase(apiVersion)}/${id(mediaId, 'mediaId')}/comments`);
  url.searchParams.set('fields', 'id,from,text,timestamp,parent_id');
  if (after) url.searchParams.set('after', String(after));
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

export async function listInstagramComments({ accessToken, ...params }) {
  return fetchJson(buildInstagramCommentsUrl(params), { method: 'GET', headers: auth(accessToken) });
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

export const __test = { apiBase, auth, id, text };
