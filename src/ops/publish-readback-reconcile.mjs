import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolveAccount } from '../lib/config.mjs';
import { fetchJson } from '../lib/http.mjs';
import { getDurableClaim, finishPublishClaim } from '../lib/durable-claim.mjs';
import { findStuckClaims } from './stale-claims.mjs';
import { readHistory, appendHistory } from '../lib/history.mjs';
import { getSlot, markSlot } from '../lib/state.mjs';
import { readAudit, appendAudit } from '../lib/audit.mjs';

const STUCK = new Set(['publishing', 'publish_unknown']);
const DEFAULT_MIN_AGE_MINUTES = 10;
const BEFORE_MS = 2 * 60_000;
const AFTER_MS = 30 * 60_000;

const pct = (value) => encodeURIComponent(String(value))
  .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function oauth1Header(method, url, credential) {
  const required = ['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret'];
  for (const key of required) if (!credential?.[key]) throw new Error(`X credential is missing "${key}".`);
  const oauth = {
    oauth_consumer_key: credential.consumerKey,
    oauth_nonce: crypto.randomBytes(18).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credential.accessToken,
    oauth_version: '1.0'
  };
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries(), ...Object.entries(oauth)]
    .map(([k, v]) => [pct(k), pct(v)])
    .sort(([ak, av], [bk, bv]) => ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk));
  const normalized = params.map(([k, v]) => `${k}=${v}`).join('&');
  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const signatureBase = [method.toUpperCase(), pct(baseUrl), pct(normalized)].join('&');
  const signingKey = `${pct(credential.consumerSecret)}&${pct(credential.accessTokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');
  return `OAuth ${Object.entries(oauth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
    .join(', ')}`;
}

function cleanText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function expandXUrls(text, entities = {}) {
  let out = String(text ?? '');
  for (const row of entities?.urls || []) {
    if (!row?.url || !row?.expanded_url) continue;
    out = out.split(String(row.url)).join(String(row.expanded_url));
  }
  return out;
}

function candidateTime(candidate) {
  const value = candidate?.createdAt || candidate?.created_at || candidate?.timestamp;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function claimWindow(claim) {
  const created = Date.parse(claim?.createdAt || '');
  const updated = Date.parse(claim?.updatedAt || claim?.createdAt || '');
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return null;
  return { start: created - BEFORE_MS, end: updated + AFTER_MS };
}

export function strongMatches(claim, candidates = []) {
  const expected = cleanText(claim?.text);
  const window = claimWindow(claim);
  if (!expected || !window) return [];
  return candidates.filter((candidate) => {
    const at = candidateTime(candidate);
    if (at == null || at < window.start || at > window.end) return false;
    const variants = new Set([cleanText(candidate?.text ?? candidate?.caption ?? '')]);
    if (candidate?.entities) variants.add(cleanText(expandXUrls(candidate.text, candidate.entities)));
    return variants.has(expected);
  });
}

async function xCandidates(account, claim, { fetch = fetchJson } = {}) {
  const identityUrl = 'https://api.x.com/2/users/me?user.fields=id,name,username';
  const identity = await fetch(identityUrl, {
    method: 'GET',
    headers: { Authorization: oauth1Header('GET', identityUrl, account.credential) }
  });
  const userId = identity?.data?.id;
  if (!userId) throw new Error('X read-back identity returned no user id.');
  const window = claimWindow(claim);
  if (!window) return [];
  const url = new URL(`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets`);
  url.searchParams.set('max_results', '100');
  url.searchParams.set('tweet.fields', 'created_at,entities');
  url.searchParams.set('start_time', new Date(window.start).toISOString());
  url.searchParams.set('end_time', new Date(window.end).toISOString());
  const target = url.toString();
  const body = await fetch(target, {
    method: 'GET',
    headers: { Authorization: oauth1Header('GET', target, account.credential) }
  });
  return (body?.data || []).map((row) => ({
    id: row.id,
    text: row.text || '',
    createdAt: row.created_at || null,
    entities: row.entities || null
  }));
}

async function instagramCandidates(account, { fetch = fetchJson } = {}) {
  const apiVersion = account.apiVersion || 'v25.0';
  const credential = account.credential || {};
  if (!credential.igUserId || !credential.accessToken) throw new Error('Instagram read-back requires igUserId and accessToken.');
  const url = new URL(`https://graph.instagram.com/${apiVersion}/${encodeURIComponent(credential.igUserId)}/media`);
  url.searchParams.set('fields', 'id,caption,media_type,timestamp,permalink');
  url.searchParams.set('limit', '100');
  const body = await fetch(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${credential.accessToken}` }
  });
  return (body?.data || []).map((row) => ({
    id: row.id,
    caption: row.caption || '',
    createdAt: row.timestamp || null,
    mediaType: row.media_type || null,
    permalink: row.permalink || null
  }));
}

async function providerCandidates(account, claim, deps = {}) {
  if (account.platform === 'x') return xCandidates(account, claim, deps);
  if (account.platform === 'instagram') return instagramCandidates(account, deps);
  return [];
}

async function persistLocalConfirmation(claim, candidate, deps = {}) {
  const providerPostId = String(candidate.id || '');
  if (!providerPostId) throw new Error('Provider read-back candidate has no id.');
  const readHistoryFn = deps.readHistory || readHistory;
  const appendHistoryFn = deps.appendHistory || appendHistory;
  const getSlotFn = deps.getSlot || getSlot;
  const markSlotFn = deps.markSlot || markSlot;
  const readAuditFn = deps.readAudit || readAudit;
  const appendAuditFn = deps.appendAudit || appendAudit;

  const history = await readHistoryFn();
  const existingHistory = history.find((row) => row.slotId === claim.slotId && row.status === 'published');
  if (!existingHistory) {
    await appendHistoryFn({
      at: candidate.createdAt || new Date().toISOString(),
      account: claim.account,
      platform: claim.platform,
      status: 'published',
      slotId: claim.slotId,
      source: claim.source || 'provider-readback',
      text: claim.text || '',
      textHash: claim.textHash,
      providerPostId,
      media: claim.media || null,
      reconciledFromDurableClaim: true
    });
  }
  const slot = await getSlotFn(claim.slotId);
  if (slot?.status !== 'published') {
    await markSlotFn(claim.slotId, 'published', {
      account: claim.account,
      platform: claim.platform,
      providerPostId,
      source: claim.source || 'provider-readback',
      reconciledFromDurableClaim: true
    });
  }
  const audit = await readAuditFn();
  if (!audit.some((row) => row.event === 'publish_provider_readback_confirmed' && row.slotId === claim.slotId)) {
    await appendAuditFn({
      event: 'publish_provider_readback_confirmed',
      account: claim.account,
      platform: claim.platform,
      slotId: claim.slotId,
      providerPostId,
      providerCreatedAt: candidate.createdAt || null
    });
  }
  return { slotId: claim.slotId, providerPostId, providerCreatedAt: candidate.createdAt || null };
}

export async function prepareProviderReadbackReconciliation({
  minAgeMinutes = Number(process.env.PUBLISH_READBACK_MIN_AGE_MINUTES || DEFAULT_MIN_AGE_MINUTES),
  deps = {}
} = {}) {
  const age = Number(minAgeMinutes);
  if (!Number.isFinite(age) || age <= 0) throw new Error('minAgeMinutes must be a positive number.');
  const find = deps.findStuckClaims || findStuckClaims;
  const getClaim = deps.getDurableClaim || getDurableClaim;
  const resolve = deps.resolveAccount || resolveAccount;
  const readProvider = deps.providerCandidates || providerCandidates;
  const persist = deps.persistLocalConfirmation || persistLocalConfirmation;
  const report = await find({ maxAgeHours: age / 60 });
  if (report.skipped) return { skipped: true, reason: report.reason, examined: 0, confirmed: [], unresolved: [] };
  const confirmed = [];
  const unresolved = [];
  for (const summary of report.stuck || []) {
    try {
      const claim = await getClaim(summary.slotId, { fresh: true });
      if (!claim || !STUCK.has(claim.status)) continue;
      if (!claim.account || !claim.platform || !cleanText(claim.text)) {
        unresolved.push({ slotId: summary.slotId, reason: 'insufficient_claim_evidence' });
        continue;
      }
      const account = await resolve(claim.account, { allowDisabled: true });
      if (account.platform !== claim.platform) {
        unresolved.push({ slotId: summary.slotId, reason: 'platform_mismatch' });
        continue;
      }
      const candidates = await readProvider(account, claim);
      const matches = strongMatches(claim, candidates);
      if (matches.length !== 1) {
        unresolved.push({ slotId: summary.slotId, reason: matches.length === 0 ? 'no_unique_provider_match' : 'multiple_provider_matches' });
        continue;
      }
      confirmed.push(await persist(claim, matches[0]));
    } catch (error) {
      unresolved.push({ slotId: summary.slotId, reason: 'readback_error', error: String(error?.message || error).slice(0, 300) });
    }
  }
  return { skipped: false, examined: (report.stuck || []).length, confirmed, unresolved, truncated: Boolean(report.truncated) };
}

export async function finalizeProviderReadbackReconciliation(entries = [], { getClaim = getDurableClaim, finishClaim = finishPublishClaim } = {}) {
  const finalized = [];
  const skipped = [];
  for (const entry of entries || []) {
    const claim = await getClaim(entry.slotId, { fresh: true });
    if (!claim || !STUCK.has(claim.status)) {
      skipped.push({ slotId: entry.slotId, reason: claim?.status || 'missing' });
      continue;
    }
    const next = await finishClaim(entry.slotId, 'published', {
      providerPostId: entry.providerPostId,
      publishedAt: entry.providerCreatedAt || claim.updatedAt || new Date().toISOString(),
      reconciledAt: new Date().toISOString(),
      reconciliation: 'provider-readback-unique-exact-match'
    });
    finalized.push({ slotId: entry.slotId, providerPostId: entry.providerPostId, status: next?.status || 'published' });
  }
  return { finalized, skipped };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--min-age-minutes' && next) { out.minAgeMinutes = Number(next); i += 1; }
    else if (token === '--out' && next) { out.out = next; i += 1; }
    else if (token === '--finalize-file' && next) { out.finalizeFile = next; i += 1; }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.finalizeFile) {
      const entries = JSON.parse(await readFile(args.finalizeFile, 'utf8'));
      const result = await finalizeProviderReadbackReconciliation(entries);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = await prepareProviderReadbackReconciliation({ minAgeMinutes: args.minAgeMinutes });
      if (args.out) await writeFile(args.out, `${JSON.stringify(result.confirmed || [], null, 2)}\n`, 'utf8');
      console.log(JSON.stringify({ ...result, confirmed: (result.confirmed || []).map(({ slotId, providerPostId }) => ({ slotId, providerPostId })) }, null, 2));
      if (result.truncated) process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
    process.exitCode = 1;
  }
}

export const __test = {
  oauth1Header,
  expandXUrls,
  cleanText,
  claimWindow,
  candidateTime,
  parseArgs,
  xCandidates,
  instagramCandidates,
  providerCandidates,
  persistLocalConfirmation
};
