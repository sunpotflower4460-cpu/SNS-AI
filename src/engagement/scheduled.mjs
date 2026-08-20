import { loadAccounts } from '../lib/config.mjs';
import { readHistory } from '../lib/history.mjs';
import { effectiveEngagementPolicy, loadEngagementPolicy } from './policy.mjs';
import { liveEngagementAccount } from './readiness.mjs';
import { runEngagement } from './run.mjs';

const DEFAULT_RECENT_POST_WINDOW_MINUTES = 360;
const MAX_RECENT_POST_WINDOW_MINUTES = 7 * 24 * 60;

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function safeRecentPostWindowMinutes(value, fallback = DEFAULT_RECENT_POST_WINDOW_MINUTES) {
  if (value == null) return fallback;
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 1
    && value <= MAX_RECENT_POST_WINDOW_MINUTES
    ? value
    : 0;
}

function pollingPolicy(globalPolicy = {}, account = {}) {
  const globalPolling = plainObject(globalPolicy.scheduledPolling) ? globalPolicy.scheduledPolling : {};
  const localPolling = plainObject(account?.engagement?.scheduledPolling) ? account.engagement.scheduledPolling : {};
  return { ...globalPolling, ...localPolling };
}

export function mostRecentOwnPublish(history = [], accountId) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index];
    if (row?.account !== accountId || row?.status !== 'published') continue;
    const time = new Date(row.at || 0).getTime();
    if (Number.isFinite(time)) return time;
  }
  return null;
}

export function scheduledAccountDecision({ accountId, account, history = [], globalPolicy = {}, now = new Date() }) {
  if (!account || account.enabled !== true || account.mode === 'pause') return { due: false, reason: 'account-disabled' };
  if (!liveEngagementAccount(globalPolicy, accountId)) return { due: false, reason: 'not-live' };

  const effective = effectiveEngagementPolicy(globalPolicy, account);
  const polling = pollingPolicy(globalPolicy, account);
  if (polling.enabled === false) return { due: false, reason: 'scheduled-polling-disabled' };
  if (polling.enabled != null && typeof polling.enabled !== 'boolean') return { due: false, reason: 'invalid-polling-config' };

  // DMs can arrive independently of a fresh public post. Enabling autoDmReply is already a deliberate,
  // permission-heavy opt-in, so the scheduled runner may poll while it is enabled. The existing
  // maxInboundFetchesPerDay guard still reserves budget before every individual provider read.
  if (effective.autoDmReply === true) return { due: true, reason: 'dm-enabled' };
  if (effective.autoReply !== true) return { due: false, reason: 'no-live-channel' };

  // Public replies cluster after our own posts. Restricting unattended reads to a recent-post window
  // avoids paying X to poll a quiet account around the clock. An invalid window fails closed to zero.
  const windowMinutes = safeRecentPostWindowMinutes(polling.recentPostWindowMinutes);
  if (windowMinutes <= 0) return { due: false, reason: 'invalid-polling-config' };
  const lastPublish = mostRecentOwnPublish(history, accountId);
  if (!Number.isFinite(lastPublish)) return { due: false, reason: 'no-own-publish' };
  const ageMs = now.getTime() - lastPublish;
  if (!Number.isFinite(ageMs) || ageMs < 0) return { due: false, reason: 'invalid-publish-time' };
  if (ageMs > windowMinutes * 60_000) return { due: false, reason: 'outside-recent-post-window' };
  return { due: true, reason: 'recent-own-post', lastPublishAt: new Date(lastPublish).toISOString(), windowMinutes };
}

export async function runScheduledEngagement({ now = new Date() } = {}) {
  const [globalPolicy, accounts, history] = await Promise.all([
    loadEngagementPolicy(),
    loadAccounts(),
    readHistory()
  ]);

  if (globalPolicy.enabled !== true) return { state: 'disabled', accounts: [], skipped: [] };
  const due = [];
  const skipped = [];
  for (const [accountId, account] of Object.entries(accounts)) {
    const decision = scheduledAccountDecision({ accountId, account, history, globalPolicy, now });
    if (decision.due) due.push({ accountId, decision });
    else if (liveEngagementAccount(globalPolicy, accountId)) skipped.push({ account: accountId, ...decision });
  }

  if (!due.length) {
    return { state: skipped.length ? 'nothing_due' : 'nothing_enabled', accounts: [], skipped };
  }

  const reports = [];
  for (const item of due) {
    const result = await runEngagement({ accountFilter: item.accountId, dryRun: false });
    reports.push({ account: item.accountId, gate: item.decision, result });
  }
  const unhealthy = reports.some(({ result }) => result.state === 'degraded'
    || result.accounts?.some((row) => ['error', 'degraded', 'waiting_for_engagement_credentials'].includes(row.state)));
  return { state: unhealthy ? 'degraded' : 'ok', accounts: reports, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runScheduledEngagement();
  console.log(JSON.stringify(result, null, 2));
  if (result.state === 'degraded') process.exitCode = 1;
}

export const __test = { plainObject, pollingPolicy, DEFAULT_RECENT_POST_WINDOW_MINUTES, MAX_RECENT_POST_WINDOW_MINUTES };
