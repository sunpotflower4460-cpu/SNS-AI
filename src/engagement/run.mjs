import { createHash } from 'node:crypto';
import { loadAccounts, resolveAccount } from '../lib/config.mjs';
import { readHistory } from '../lib/history.mjs';
import { githubContext, githubRequest } from '../lib/github.mjs';
import { verifyXOAuth2Credential } from '../providers/x.mjs';
import { classifyAndDraftEngagement } from './ai.mjs';
import { assertAutomatedEngagementAllowed, effectiveEngagementPolicy, loadEngagementPolicy } from './policy.mjs';
import { listXMentions, listXDirectMessages, sendXReply, sendXDirectMessage } from './providers/x.mjs';
import { listInstagramComments, sendInstagramCommentReply } from './providers/instagram.mjs';
import { appendEngagementAudit, countSentSince, eventKey, eventStatus, markEngagementEvent } from './store.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function bool(value) { return value === true || ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase()); }
function terminal(status) { return ['sent', 'ignored', 'human', 'opted_out'].includes(String(status || '')); }
function nowIso() { return new Date().toISOString(); }
function ageMs(value) { const time = new Date(value || 0).getTime(); return Number.isFinite(time) ? Date.now() - time : Infinity; }

function deterministicDelayMinutes(key, kind, policy) {
  const range = kind === 'dm' ? policy.dmDelayMinutes : policy.replyDelayMinutes;
  const [rawMin, rawMax] = Array.isArray(range) ? range : (kind === 'dm' ? [4, 18] : [6, 24]);
  const min = Math.max(0, Number(rawMin) || 0);
  const max = Math.max(min, Number(rawMax) || min);
  const fraction = parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 0xffffffff;
  return min + ((max - min) * fraction);
}

function dueAtFor(event, key, policy) {
  const created = new Date(event.createdAt || Date.now()).getTime();
  const base = Number.isFinite(created) ? created : Date.now();
  return new Date(base + deterministicDelayMinutes(key, event.kind, policy) * 60_000).toISOString();
}

function optedOut(text) {
  return /(返信不要|自動返信.{0,8}(やめ|停止|不要)|bot.{0,8}(stop|off)|do not reply|don't reply|stop messaging)/i.test(String(text || ''));
}

function userMap(includes) {
  return new Map((includes?.users || []).map((user) => [String(user.id), user]));
}

function xEvents(accountId, ownId, mentions, dms) {
  const users = userMap(mentions?.includes);
  const output = [];
  for (const post of mentions?.data || []) {
    if (!post?.id || !post?.author_id || String(post.author_id) === String(ownId)) continue;
    output.push({
      id: String(post.id), platform: 'x', kind: 'reply', inbound: true, public: true,
      text: String(post.text || ''), createdAt: post.created_at || null,
      authorId: String(post.author_id), username: users.get(String(post.author_id))?.username || null,
      postId: String(post.id), accountId
    });
  }
  for (const event of dms?.data || []) {
    if (event?.event_type !== 'MessageCreate' || !event?.id || !event?.sender_id || String(event.sender_id) === String(ownId)) continue;
    output.push({
      id: String(event.id), platform: 'x', kind: 'dm', inbound: true, public: false,
      text: String(event.text || ''), createdAt: event.created_at || null,
      authorId: String(event.sender_id), participantId: String(event.sender_id), accountId
    });
  }
  return output;
}

function instagramMediaIds(history, accountId, limit = 12) {
  const ids = [];
  for (const row of [...history].reverse()) {
    if (row?.account !== accountId || row?.status !== 'published' || !row?.providerPostId) continue;
    const id = String(row.providerPostId);
    if (!ids.includes(id)) ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

async function instagramEvents(accountId, account, history) {
  const output = [];
  for (const mediaId of instagramMediaIds(history, accountId)) {
    const response = await listInstagramComments({ accessToken: account.credential.accessToken, mediaId, apiVersion: account.credential.apiVersion || 'v25.0' });
    for (const comment of response?.data || []) {
      if (!comment?.id || !comment?.text) continue;
      output.push({
        id: String(comment.id), platform: 'instagram', kind: 'reply', inbound: true, public: true,
        text: String(comment.text), createdAt: comment.timestamp || null, commentId: String(comment.id), mediaId,
        username: comment?.from?.username || null, accountId
      });
    }
  }
  return output;
}

async function createHumanIssue({ accountId, event, key, decision, policy }) {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  const title = `[engagement-human] ${accountId} ${key}`;
  const existing = await githubRequest(`/repos/${owner}/${repo}/issues?state=open&per_page=100`);
  const found = (existing || []).find((issue) => issue.title === title && !issue.pull_request);
  if (found) return found;
  const excerptLimit = Math.max(0, Number(policy?.humanEscalation?.publicExcerptMaxChars ?? 800));
  const body = {
    kind: 'sns-ai-engagement-human', schemaVersion: 1, account: accountId, platform: event.platform,
    interactionKind: event.kind, eventKey: key, category: decision.category || 'unknown',
    reason: String(decision.reason || 'Human judgment required.').slice(0, 500),
    publicInteraction: event.public === true,
    publicExcerpt: event.public === true ? String(event.text || '').slice(0, excerptLimit) : null,
    privateContentOmitted: event.public !== true,
    question: event.public === true
      ? 'この公開インタラクションはSNS-AIが自動判断を避けました。どう返すか、または返信しないかを決めてください。'
      : '非公開DMのため本文は公開GitHubへ保存していません。SNS上で該当DMを確認し、対応方針を決めてください。'
  };
  return githubRequest(`/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body: JSON.stringify(body, null, 2), labels: ['needs-human'] })
  });
}

async function sendResponse(account, event, text, dryRun) {
  if (event.platform === 'x' && event.kind === 'reply') return sendXReply({ credential: account.credential, postId: event.postId, text, dryRun });
  if (event.platform === 'x' && event.kind === 'dm') return sendXDirectMessage({ credential: account.credential, participantId: event.participantId, text, dryRun });
  if (event.platform === 'instagram' && event.kind === 'reply') {
    return sendInstagramCommentReply({ accessToken: account.credential.accessToken, commentId: event.commentId, message: text, apiVersion: account.credential.apiVersion || 'v25.0', dryRun });
  }
  throw new Error(`Unsupported engagement send path ${event.platform}/${event.kind}.`);
}

async function collectEvents(accountId, account, history) {
  if (account.platform === 'x') {
    const identity = await verifyXOAuth2Credential(account.credential);
    const [mentions, dms] = await Promise.all([
      listXMentions({ credential: account.credential, userId: identity.id, maxResults: 100 }),
      listXDirectMessages({ credential: account.credential, maxResults: 100 })
    ]);
    return xEvents(accountId, identity.id, mentions, dms);
  }
  if (account.platform === 'instagram') return instagramEvents(accountId, account, history);
  return [];
}

function credentialNotReady(error) {
  return /oauth2|refresh token|access token|scope|credential|authorization|permission/i.test(String(error?.message || ''));
}

async function processEvent(accountId, account, event, globalPolicy, dryRun) {
  const policy = effectiveEngagementPolicy(globalPolicy, account);
  const key = eventKey(accountId, event);
  const prior = await eventStatus(accountId, key);
  if (terminal(prior?.status)) return { status: prior.status, skipped: true };

  event.userOptedOut = optedOut(event.text);
  event.alreadyAutoResponded = prior?.status === 'sent';
  event.keywordDiscoveryOnly = false;
  event.sensitive = false;
  event.asksForHuman = false;

  if (event.userOptedOut) {
    if (!dryRun) await markEngagementEvent(accountId, key, { status: 'opted_out', kind: event.kind, platform: event.platform });
    return { status: dryRun ? 'dry-run-opted-out' : 'opted_out' };
  }

  const allowed = assertAutomatedEngagementAllowed({ account, event, globalPolicy });
  const dueAt = prior?.dueAt || dueAtFor(event, key, policy);
  if (new Date(dueAt).getTime() > Date.now()) {
    if (!dryRun) await markEngagementEvent(accountId, key, { status: 'waiting', dueAt, kind: event.kind, platform: event.platform });
    return { status: dryRun ? 'dry-run-waiting' : 'waiting', dueAt };
  }

  const maxPerDay = event.kind === 'dm' ? Number(policy.maxAutomatedDmRepliesPerDay ?? 12) : Number(policy.maxAutomatedRepliesPerDay ?? 12);
  const sentToday = await countSentSince(accountId, event.kind, new Date(Date.now() - 24 * 60 * 60_000));
  if (Number.isFinite(maxPerDay) && maxPerDay >= 0 && sentToday >= maxPerDay) {
    if (!dryRun) await markEngagementEvent(accountId, key, { status: 'deferred', dueAt, kind: event.kind, platform: event.platform, reason: 'daily-cap' });
    return { status: dryRun ? 'dry-run-deferred' : 'deferred' };
  }

  const decision = await classifyAndDraftEngagement({ accountId, account, event });
  const threshold = Number(policy.minAutoReplyConfidence ?? 0.82);
  if (decision.action === 'human' || (decision.action === 'reply' && decision.confidence < threshold) || allowed.approvalRequired) {
    if (dryRun) return { status: 'dry-run-human', decision };
    const issue = await createHumanIssue({ accountId, event, key, decision, policy });
    await markEngagementEvent(accountId, key, { status: 'human', dueAt, kind: event.kind, platform: event.platform, category: decision.category, issueNumber: issue.number || null });
    await appendEngagementAudit({ account: accountId, eventKey: key, platform: event.platform, kind: event.kind, status: 'human', category: decision.category, public: event.public === true });
    return { status: 'human', issueNumber: issue.number || null };
  }
  if (decision.action === 'ignore') {
    if (dryRun) return { status: 'dry-run-ignore', decision };
    await markEngagementEvent(accountId, key, { status: 'ignored', dueAt, kind: event.kind, platform: event.platform, category: decision.category });
    await appendEngagementAudit({ account: accountId, eventKey: key, platform: event.platform, kind: event.kind, status: 'ignored', category: decision.category, public: event.public === true });
    return { status: 'ignored' };
  }

  const result = await sendResponse(account, event, decision.response, dryRun);
  if (dryRun) return { status: 'dry-run-reply', decision, result };
  await markEngagementEvent(accountId, key, { status: 'sent', dueAt, sentAt: nowIso(), kind: event.kind, platform: event.platform, category: decision.category });
  await appendEngagementAudit({ account: accountId, eventKey: key, platform: event.platform, kind: event.kind, status: 'sent', category: decision.category, public: event.public === true });
  return { status: 'sent' };
}

export async function runEngagement({ accountFilter = null, dryRun = false } = {}) {
  const globalPolicy = await loadEngagementPolicy();
  if (globalPolicy.enabled !== true) return { state: 'disabled', accounts: [] };
  const accounts = await loadAccounts();
  const history = await readHistory();
  const allowedAccounts = Array.isArray(globalPolicy.allowedAccounts) ? new Set(globalPolicy.allowedAccounts.map(String)) : null;
  const ids = Object.entries(accounts)
    .filter(([id, account]) => account.enabled === true && account.mode !== 'pause' && (!accountFilter || id === accountFilter) && (!allowedAccounts || allowedAccounts.has(id)))
    .map(([id]) => id);
  const report = [];

  for (const accountId of ids) {
    try {
      const account = await resolveAccount(accountId);
      const events = await collectEvents(accountId, account, history);
      const rows = [];
      for (const event of events.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))) {
        if (!event.text || ageMs(event.createdAt) > 30 * 24 * 60 * 60_000) continue;
        try { rows.push({ eventKey: eventKey(accountId, event), ...(await processEvent(accountId, account, event, globalPolicy, dryRun)) }); }
        catch (error) {
          rows.push({ eventKey: eventKey(accountId, event), status: 'error', error: String(error?.message || error).slice(0, 300) });
          if (!dryRun) await appendEngagementAudit({ account: accountId, eventKey: eventKey(accountId, event), platform: event.platform, kind: event.kind, status: 'error', code: error?.code || null });
        }
      }
      report.push({ account: accountId, state: 'ok', events: rows });
    } catch (error) {
      if (credentialNotReady(error)) {
        report.push({ account: accountId, state: 'waiting_for_engagement_credentials', message: 'Engagement OAuth credentials/scopes are not ready yet.' });
        continue;
      }
      report.push({ account: accountId, state: 'error', message: String(error?.message || error).slice(0, 300) });
    }
  }
  return { state: ids.length ? 'ok' : 'nothing_enabled', accounts: report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const result = await runEngagement({ accountFilter: args.account || null, dryRun: bool(args['dry-run']) });
  console.log(JSON.stringify(result, null, 2));
  if (result.accounts?.some((row) => row.state === 'error')) process.exitCode = 1;
}

export const __test = { deterministicDelayMinutes, dueAtFor, optedOut, terminal, instagramMediaIds, xEvents, credentialNotReady };
