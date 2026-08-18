import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadAccounts, resolveAccount } from '../lib/config.mjs';
import { readHistory } from '../lib/history.mjs';
import { githubContext, githubRequest } from '../lib/github.mjs';
import { validateDraftText } from '../lib/safety.mjs';
import { moderateText } from '../lib/openai.mjs';
import { verifyXOAuth2Credential } from '../providers/x.mjs';
import { classifyAndDraftEngagement, hardHumanCategory } from './ai.mjs';
import { assertAutomatedEngagementAllowed, effectiveEngagementPolicy, loadEngagementPolicy } from './policy.mjs';
import {
  allowedEngagementAccount,
  assertXEngagementCredential,
  engagementCredentialError,
  liveEngagementAccount,
  requiredXEngagementScopes
} from './readiness.mjs';
import { listXMentions, listXDirectMessages, sendXReply, sendXDirectMessage } from './providers/x.mjs';
import {
  listInstagramComments,
  listInstagramConversations,
  listInstagramConversationMessages,
  sendInstagramCommentReply,
  sendInstagramDm
} from './providers/instagram.mjs';
import {
  actorKey,
  actorStatus,
  appendEngagementAudit,
  countSentSince,
  eventKey,
  eventStatus,
  markActorOptOut,
  markEngagementEvent,
  markEngagementSent
} from './store.mjs';

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

function engagementAuthFailure(error) {
  const status = Number(error?.status);
  if (status === 401 || status === 403) return true;
  return /oauth|access token|refresh token|scope|permission|not authorized|authorization/i.test(String(error?.message || ''));
}

async function instagramEvents(accountId, account, history, policy) {
  const output = [];
  const warnings = [];
  const unavailableChannels = [];
  const accessToken = account.credential.accessToken;
  const apiVersion = account.credential.apiVersion || account.apiVersion || 'v25.0';
  const ownId = String(account.credential.igUserId || '');

  if (policy.autoReply === true) {
    for (const mediaId of instagramMediaIds(history, accountId)) {
      try {
        const response = await listInstagramComments({ accessToken, mediaId, apiVersion });
        for (const comment of response?.data || []) {
          const authorId = String(comment?.from?.id || '');
          if (!comment?.id || !comment?.text || (authorId && authorId === ownId)) continue;
          output.push({
            id: String(comment.id), platform: 'instagram', kind: 'reply', inbound: true, public: true,
            text: String(comment.text), createdAt: comment.timestamp || null, commentId: String(comment.id), mediaId,
            authorId: authorId || null, username: comment?.from?.username || null, accountId
          });
        }
      } catch (error) {
        if (engagementAuthFailure(error)) throw engagementCredentialError('Instagram comment engagement authorization/permission is not ready.');
        warnings.push(`Instagram comments temporarily unavailable: ${String(error?.message || error).slice(0, 180)}`);
        unavailableChannels.push('comments');
        break;
      }
    }
  }

  if (policy.autoDmReply === true) {
    try {
      const conversations = await listInstagramConversations({ accessToken, igUserId: ownId, apiVersion });
      for (const conversation of (conversations?.data || []).slice(0, 25)) {
        if (!conversation?.id) continue;
        const detail = await listInstagramConversationMessages({ accessToken, conversationId: conversation.id, apiVersion });
        for (const message of detail?.messages?.data || []) {
          const senderId = String(message?.from?.id || '');
          const body = String(message?.message || '').trim();
          if (!message?.id || !senderId || senderId === ownId || !body || message?.is_unsupported === true) continue;
          output.push({
            id: String(message.id), platform: 'instagram', kind: 'dm', inbound: true, public: false,
            text: body, createdAt: message.created_time || null, authorId: senderId, participantId: senderId,
            conversationId: String(conversation.id), accountId
          });
        }
      }
    } catch (error) {
      if (engagementAuthFailure(error)) throw engagementCredentialError('Instagram DM engagement authorization/permission is not ready.');
      warnings.push(`Instagram DMs temporarily unavailable: ${String(error?.message || error).slice(0, 180)}`);
      unavailableChannels.push('dms');
    }
  }

  return { events: output, warnings, unavailableChannels };
}

async function ensureNeedsHumanLabel() {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  try { return await githubRequest(`/repos/${owner}/${repo}/labels/needs-human`); }
  catch (error) { if (error.status !== 404) throw error; }
  return githubRequest(`/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    body: JSON.stringify({ name: 'needs-human', description: 'SNS-AI requires a human decision', color: 'B60205' })
  });
}

async function createHumanIssue({ accountId, event, key, decision, policy }) {
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  const prefix = String(policy?.humanEscalation?.issuePrefix || '[engagement-human]');
  const title = `${prefix} ${accountId} ${key}`;
  const existing = await githubRequest(`/repos/${owner}/${repo}/issues?state=open&per_page=100`);
  const found = (existing || []).find((issue) => issue.title === title && !issue.pull_request);
  if (found) return found;
  await ensureNeedsHumanLabel();
  const excerptLimit = Math.max(0, Number(policy?.humanEscalation?.publicExcerptMaxChars ?? 800));
  const isPublic = event.public === true;
  const category = String(decision.category || 'unknown').slice(0, 100);
  const body = {
    kind: 'sns-ai-engagement-human',
    schemaVersion: 2,
    account: accountId,
    platform: event.platform,
    interactionKind: event.kind,
    eventKey: key,
    category,
    reason: isPublic
      ? String(decision.reason || 'Human judgment required.').slice(0, 500)
      : `A private ${event.kind} requires human judgment in category "${category}". Free-text model reasoning is intentionally omitted.`,
    summary: isPublic
      ? String(decision.humanSummary || 'SNS-AIが自動返信を避けました。').slice(0, 600)
      : `非公開DMで「${category}」カテゴリの人間判断が必要です。本文・送信者情報・AIの自由記述要約はGitHubへ保存していません。`,
    question: isPublic
      ? String(decision.humanQuestion || 'どのように対応しますか？').slice(0, 500)
      : 'SNSアプリで該当DMを確認し、返信するか・返信しないかを判断してください。',
    publicInteraction: isPublic,
    publicExcerpt: isPublic ? String(event.text || '').slice(0, excerptLimit) : null,
    privateContentOmitted: !isPublic,
    resolution: isPublic
      ? 'ChatGPT can submit a public reply through [engagement-resolve].'
      : 'Private DM content and reply text must not be copied into this public repository. Use the chat decision to draft the response, then send it manually in the SNS app if a human response is required.'
  };
  return githubRequest(`/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body: JSON.stringify(body, null, 2), labels: ['needs-human'] })
  });
}

async function closeHumanIssue(issueNumber, message) {
  if (!issueNumber) return;
  const { repository } = githubContext();
  const [owner, repo] = repository.split('/');
  await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST', body: JSON.stringify({ body: message })
  }).catch(() => {});
  await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' })
  }).catch(() => {});
}

async function sendResponse(account, event, text, dryRun) {
  if (event.platform === 'x' && event.kind === 'reply') return sendXReply({ credential: account.credential, postId: event.postId, text, dryRun });
  if (event.platform === 'x' && event.kind === 'dm') return sendXDirectMessage({ credential: account.credential, participantId: event.participantId, text, dryRun });
  if (event.platform === 'instagram' && event.kind === 'reply') {
    return sendInstagramCommentReply({ accessToken: account.credential.accessToken, commentId: event.commentId, message: text, apiVersion: account.credential.apiVersion || account.apiVersion || 'v25.0', dryRun });
  }
  if (event.platform === 'instagram' && event.kind === 'dm') {
    return sendInstagramDm({ accessToken: account.credential.accessToken, igUserId: account.credential.igUserId, recipientId: event.participantId, message: text, apiVersion: account.credential.apiVersion || account.apiVersion || 'v25.0', dryRun });
  }
  throw new Error(`Unsupported engagement send path ${event.platform}/${event.kind}.`);
}

async function collectEvents(accountId, account, history, globalPolicy) {
  const policy = effectiveEngagementPolicy(globalPolicy, account);
  if (account.platform === 'x') {
    const identity = await verifyXOAuth2Credential(account.credential);
    assertXEngagementCredential(identity, policy);
    const warnings = [];
    const unavailableChannels = [];
    let mentions = { data: [] };
    let dms = { data: [] };
    if (policy.autoReply === true) {
      try { mentions = await listXMentions({ credential: account.credential, userId: identity.id, maxResults: 100 }); }
      catch (error) {
        if (engagementAuthFailure(error)) throw engagementCredentialError('X mention engagement authorization/permission is not ready.');
        warnings.push(`X mentions temporarily unavailable: ${String(error?.message || error).slice(0, 180)}`);
        unavailableChannels.push('mentions');
      }
    }
    if (policy.autoDmReply === true) {
      try { dms = await listXDirectMessages({ credential: account.credential, maxResults: 100 }); }
      catch (error) {
        if (engagementAuthFailure(error)) throw engagementCredentialError('X DM engagement authorization/permission is not ready.');
        warnings.push(`X DMs temporarily unavailable: ${String(error?.message || error).slice(0, 180)}`);
        unavailableChannels.push('dms');
      }
    }
    return { events: xEvents(accountId, identity.id, mentions, dms), warnings, unavailableChannels };
  }
  if (account.platform === 'instagram') return instagramEvents(accountId, account, history, policy);
  return { events: [], warnings: [], unavailableChannels: [] };
}

function credentialNotReady(error) {
  if (error?.code === 'ENGAGEMENT_CREDENTIALS_NOT_READY') return true;
  const status = Number(error?.status);
  if (status === 401 || status === 403) return true;
  return /oauth2|refresh token|access token|scope|credential|authorization|permission/i.test(String(error?.message || ''));
}

function privateSafeDecision(event, decision) {
  if (event.public === true) return decision;
  return {
    action: decision.action,
    confidence: decision.confidence,
    category: decision.category,
    privateContentOmitted: true
  };
}

function safeEventError(error, event) {
  if (event.public === true) return String(error?.message || error).slice(0, 300);
  return `Private ${event.kind} processing failed (${String(error?.code || 'ENGAGEMENT_ERROR').slice(0, 80)}); private provider/user/message details omitted.`;
}

function deterministicHumanDecision(category, { optedOut: actorOptedOut = false } = {}) {
  return {
    action: 'human',
    confidence: 1,
    category,
    response: '',
    reason: 'A deterministic high-risk engagement guard requires human judgment before normal automation limits are applied.',
    humanSummary: actorOptedOut
      ? '自動返信を停止している相手から、人間判断が必要な重要カテゴリの連絡を検出しました。自動返信は行いません。'
      : '高リスクまたは所有者判断が必要な問い合わせを検出しました。',
    humanQuestion: actorOptedOut
      ? '自動返信は行わず、この連絡を確認した上で人間として対応するか判断してください。'
      : 'この問い合わせへの対応方針を指定してください。'
  };
}

async function processEvent(accountId, account, event, globalPolicy, dryRun) {
  const policy = effectiveEngagementPolicy(globalPolicy, account);
  const key = eventKey(accountId, event);
  const aKey = actorKey(accountId, event);
  const prior = await eventStatus(accountId, key);
  if (terminal(prior?.status)) return { status: prior.status, skipped: true };

  const actor = await actorStatus(accountId, aKey);
  const explicitOptOut = optedOut(event.text);
  const hardCategory = hardHumanCategory(event.text);
  event.userOptedOut = explicitOptOut;
  event.alreadyAutoResponded = prior?.status === 'sent';
  event.keywordDiscoveryOnly = false;
  event.sensitive = false;
  event.asksForHuman = false;

  if (explicitOptOut && !dryRun) await markActorOptOut(accountId, aKey);

  // High-risk or explicit-human interactions must not be hidden by an earlier opt-out, actor cooldown,
  // human-like delay, or daily auto-reply cap. We surface them immediately for owner judgment, while an
  // opted-out actor still receives no automated response unless the owner later explicitly chooses one.
  if (hardCategory) {
    const actorOptedOut = actor?.optedOut === true || explicitOptOut;
    const decision = deterministicHumanDecision(hardCategory, { optedOut: actorOptedOut });
    if (dryRun) return { status: 'dry-run-human', decision: privateSafeDecision(event, decision) };
    const issue = await createHumanIssue({ accountId, event, key, decision, policy });
    await markEngagementEvent(accountId, key, {
      status: 'human', kind: event.kind, platform: event.platform, actorKey: aKey, category: hardCategory,
      issueNumber: issue.number || null, public: event.public === true, actorOptedOut
    });
    await appendEngagementAudit({ account: accountId, eventKey: key, platform: event.platform, kind: event.kind, status: 'human', category: hardCategory, public: event.public === true, actorOptedOut });
    return { status: 'human', issueNumber: issue.number || null };
  }

  if (actor?.optedOut === true || explicitOptOut) {
    if (!dryRun) await markEngagementEvent(accountId, key, {
      status: 'opted_out', kind: event.kind, platform: event.platform, actorKey: aKey,
      reason: explicitOptOut ? 'explicit-opt-out' : 'actor-opt-out'
    });
    return { status: dryRun ? 'dry-run-opted-out' : 'opted_out', persistent: Boolean(aKey) };
  }

  const allowed = assertAutomatedEngagementAllowed({ account, event, globalPolicy });
  let dueAt = prior?.dueAt || dueAtFor(event, key, policy);
  if (new Date(dueAt).getTime() > Date.now()) {
    if (!dryRun) await markEngagementEvent(accountId, key, { status: 'waiting', dueAt, kind: event.kind, platform: event.platform, actorKey: aKey });
    return { status: dryRun ? 'dry-run-waiting' : 'waiting', dueAt };
  }

  const cooldownMinutes = Number(event.kind === 'dm' ? policy.dmCooldownMinutes ?? 30 : policy.replyCooldownMinutes ?? 30);
  const lastSent = actor?.lastSentAt?.[event.kind] ? new Date(actor.lastSentAt[event.kind]).getTime() : NaN;
  if (Number.isFinite(cooldownMinutes) && cooldownMinutes > 0 && Number.isFinite(lastSent)) {
    const cooldownDue = lastSent + cooldownMinutes * 60_000;
    if (cooldownDue > Date.now()) {
      dueAt = new Date(Math.max(new Date(dueAt).getTime() || 0, cooldownDue)).toISOString();
      if (!dryRun) await markEngagementEvent(accountId, key, { status: 'deferred', dueAt, kind: event.kind, platform: event.platform, actorKey: aKey, reason: 'actor-cooldown' });
      return { status: dryRun ? 'dry-run-deferred' : 'deferred', dueAt, reason: 'actor-cooldown' };
    }
  }

  const maxPerDay = event.kind === 'dm' ? Number(policy.maxAutomatedDmRepliesPerDay ?? 12) : Number(policy.maxAutomatedRepliesPerDay ?? 12);
  const sentToday = await countSentSince(accountId, event.kind, new Date(Date.now() - 24 * 60 * 60_000));
  if (Number.isFinite(maxPerDay) && maxPerDay >= 0 && sentToday >= maxPerDay) {
    if (!dryRun) await markEngagementEvent(accountId, key, { status: 'deferred', dueAt, kind: event.kind, platform: event.platform, actorKey: aKey, reason: 'daily-cap' });
    return { status: dryRun ? 'dry-run-deferred' : 'deferred', reason: 'daily-cap' };
  }

  const decision = await classifyAndDraftEngagement({ accountId, account, event, policy });
  const threshold = Number(policy.minAutoReplyConfidence ?? 0.82);
  const humanCategory = new Set((policy.humanRequiredCategories || []).map((value) => String(value).toLowerCase())).has(String(decision.category || '').toLowerCase());
  if (decision.action === 'human' || humanCategory || (decision.action === 'reply' && decision.confidence < threshold) || allowed.approvalRequired) {
    if (dryRun) return { status: 'dry-run-human', decision: privateSafeDecision(event, decision) };
    const issue = await createHumanIssue({ accountId, event, key, decision, policy });
    await markEngagementEvent(accountId, key, { status: 'human', dueAt, kind: event.kind, platform: event.platform, actorKey: aKey, category: decision.category, issueNumber: issue.number || null, public: event.public === true });
    await appendEngagementAudit({ account: accountId, eventKey: key, platform: event.platform, kind: event.kind, status: 'human', category: decision.category, public: event.public === true });
    return { status: 'human', issueNumber: issue.number || null };
  }
  if (decision.action === 'ignore') {
    if (dryRun) return { status: 'dry-run-ignore', decision: privateSafeDecision(event, decision) };
    await markEngagementEvent(accountId, key, { status: 'ignored', dueAt, kind: event.kind, platform: event.platform, actorKey: aKey, category: decision.category });
    await appendEngagementAudit({ account: accountId, eventKey: key, platform: event.platform, kind: event.kind, status: 'ignored', category: decision.category, public: event.public === true });
    return { status: 'ignored' };
  }

  const result = await sendResponse(account, event, decision.response, dryRun);
  if (dryRun) return { status: 'dry-run-reply', decision: privateSafeDecision(event, decision), result: event.public === true ? result : { dryRun: true, privateContentOmitted: true } };
  await markEngagementSent(accountId, key, aKey, { dueAt, sentAt: nowIso(), kind: event.kind, platform: event.platform, actorKey: aKey, category: decision.category });
  await appendEngagementAudit({ account: accountId, eventKey: key, platform: event.platform, kind: event.kind, status: 'sent', category: decision.category, public: event.public === true });
  return { status: 'sent' };
}

export async function resolveHumanEngagement({ accountId, key, action = 'reply', text = '', dryRun = false } = {}) {
  if (!accountId || !key) throw new Error('Human engagement resolution requires accountId and eventKey.');
  if (!['reply', 'ignore'].includes(action)) throw new Error('Human engagement resolution action must be reply or ignore.');
  const prior = await eventStatus(accountId, key);
  if (!prior || prior.status !== 'human') throw new Error('Engagement event is not awaiting a human decision.');
  if (prior.public !== true) {
    const error = new Error('Private DM resolutions are intentionally not sent through public GitHub ChatOps. Draft the response in chat, then send it manually in the SNS app.');
    error.code = 'PRIVATE_ENGAGEMENT_MANUAL_SEND';
    throw error;
  }

  const account = await resolveAccount(accountId);
  const history = await readHistory();
  const globalPolicy = await loadEngagementPolicy();
  const collected = await collectEvents(accountId, account, history, globalPolicy);
  const event = collected.events.find((candidate) => eventKey(accountId, candidate) === key);
  if (!event) throw new Error('The original public interaction could not be found again; it may be too old or deleted.');

  if (action === 'ignore') {
    if (!dryRun) {
      await markEngagementEvent(accountId, key, { status: 'ignored', kind: event.kind, platform: event.platform, actorKey: actorKey(accountId, event), category: prior.category || 'human-ignore', resolvedAt: nowIso() });
      await closeHumanIssue(prior.issueNumber, '✅ Human decision recorded: no reply.');
    }
    return { status: dryRun ? 'dry-run-ignore' : 'ignored', eventKey: key };
  }

  const responseText = validateDraftText(account, String(text || '').trim());
  await moderateText(responseText, account, accountId);
  const result = await sendResponse(account, event, responseText, dryRun);
  if (!dryRun) {
    await markEngagementSent(accountId, key, actorKey(accountId, event), { sentAt: nowIso(), kind: event.kind, platform: event.platform, category: prior.category || 'human-resolved', resolvedAt: nowIso() });
    await appendEngagementAudit({ account: accountId, eventKey: key, platform: event.platform, kind: event.kind, status: 'sent-human-resolved', public: true });
    await closeHumanIssue(prior.issueNumber, '✅ Human-approved public reply sent by SNS-AI.');
  }
  return { status: dryRun ? 'dry-run-reply' : 'sent', eventKey: key, result };
}

export async function runEngagement({ accountFilter = null, dryRun = false } = {}) {
  const globalPolicy = await loadEngagementPolicy();
  if (globalPolicy.enabled !== true) return { state: 'disabled', accounts: [] };
  const accounts = await loadAccounts();
  const history = await readHistory();
  const ids = Object.entries(accounts)
    .filter(([id, account]) => {
      if (account.enabled !== true || account.mode === 'pause' || (accountFilter && id !== accountFilter)) return false;
      if (!allowedEngagementAccount(globalPolicy, id)) return false;
      return dryRun || liveEngagementAccount(globalPolicy, id);
    })
    .map(([id]) => id);
  const report = [];

  for (const accountId of ids) {
    try {
      const account = await resolveAccount(accountId);
      const collected = await collectEvents(accountId, account, history, globalPolicy);
      const rows = [];
      for (const event of collected.events.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))) {
        if (!event.text || ageMs(event.createdAt) > 30 * 24 * 60 * 60_000) continue;
        try { rows.push({ eventKey: eventKey(accountId, event), ...(await processEvent(accountId, account, event, globalPolicy, dryRun)) }); }
        catch (error) {
          rows.push({ eventKey: eventKey(accountId, event), status: 'error', error: safeEventError(error, event) });
          if (!dryRun) await appendEngagementAudit({ account: accountId, eventKey: eventKey(accountId, event), platform: event.platform, kind: event.kind, status: 'error', code: error?.code || null, public: event.public === true });
        }
      }
      const degraded = collected.unavailableChannels?.length > 0 || rows.some((row) => row.status === 'error');
      report.push({ account: accountId, state: degraded ? 'degraded' : 'ok', warnings: collected.warnings, unavailableChannels: collected.unavailableChannels || [], events: rows });
    } catch (error) {
      if (credentialNotReady(error)) {
        report.push({ account: accountId, state: 'waiting_for_engagement_credentials', message: 'Engagement OAuth credentials/scopes are not ready yet.' });
        continue;
      }
      report.push({ account: accountId, state: 'error', message: String(error?.message || error).slice(0, 300) });
    }
  }
  const unhealthy = report.some((row) => ['error', 'degraded', 'waiting_for_engagement_credentials'].includes(row.state));
  return { state: unhealthy ? 'degraded' : (ids.length ? 'ok' : 'nothing_enabled'), accounts: report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args['resolve-file']) {
    const payload = JSON.parse(await readFile(String(args['resolve-file']), 'utf8'));
    result = await resolveHumanEngagement({
      accountId: payload.account,
      key: payload.eventKey,
      action: payload.action || 'reply',
      text: payload.text || '',
      dryRun: bool(payload.dryRun)
    });
  } else {
    result = await runEngagement({ accountFilter: args.account || null, dryRun: bool(args['dry-run']) });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.state === 'degraded' || result.accounts?.some((row) => ['error', 'degraded', 'waiting_for_engagement_credentials'].includes(row.state))) process.exitCode = 1;
}

export const __test = {
  deterministicDelayMinutes,
  dueAtFor,
  optedOut,
  terminal,
  instagramMediaIds,
  xEvents,
  credentialNotReady,
  engagementAuthFailure,
  xRequiredScopes: requiredXEngagementScopes,
  assertXEngagementCredential,
  privateSafeDecision,
  safeEventError,
  deterministicHumanDecision
};
