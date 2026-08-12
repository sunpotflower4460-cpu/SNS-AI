import { loadAccounts, resolveAccount } from '../lib/config.mjs';
import { readHistory } from '../lib/history.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { assertCircuitClosed, recordCircuitFailure, recordCircuitSuccess } from '../ops/circuit.mjs';
import { evaluateAnomalyBrake } from '../ops/brake.mjs';
import { readMetricSnapshots, snapshotsForPost, appendMetricSnapshot } from './store.mjs';
import { nextDueCheckpoint } from './checkpoints.mjs';
import { collectXMetrics } from './x-metrics.mjs';
import { collectInstagramMetrics } from './instagram-metrics.mjs';

async function evaluateBrakeSafely(accountId, account, snapshots, report) {
  try {
    const brake = await evaluateAnomalyBrake(accountId, account, snapshots);
    if (brake.opened) {
      await appendAudit({ account: accountId, stage: 'anomaly-brake-opened', reason: brake.reason, openUntil: brake.openUntil, evidence: brake.evidence });
      report.push({ account: accountId, status: 'safety-brake-opened', reason: brake.reason, openUntil: brake.openUntil, evidence: brake.evidence });
    }
  } catch (error) {
    await appendAudit({ account: accountId, stage: 'anomaly-brake-error', error: String(error.message || error).slice(0, 500) });
    report.push({ account: accountId, status: 'safety-brake-check-failed', error: error.message });
  }
}

export async function collectMetrics({ accountFilter, now = new Date() } = {}) {
  const accounts = await loadAccounts();
  const history = await readHistory();
  const existing = await readMetricSnapshots();
  const report = [];
  for (const [accountId, account] of Object.entries(accounts)) {
    if (accountFilter && accountFilter !== accountId) continue;
    if (account.analytics?.enabled === false) continue;
    try { await assertCircuitClosed(accountId, 'analytics', account.resilience); }
    catch (error) { report.push({ account: accountId, status: 'circuit-open', error: error.message }); continue; }
    const posts = history.filter((row) => row.account === accountId && row.status === 'published' && row.providerPostId && row.at);
    for (const post of posts) {
      const maxAgeDays = Number(account.analytics?.maxAgeDays ?? (account.platform === 'x' ? 30 : 14));
      if (now.getTime() - new Date(post.at).getTime() > maxAgeDays * 86400000) continue;
      const snapshots = snapshotsForPost(existing, accountId, post.providerPostId);
      const due = nextDueCheckpoint({
        publishedAt: post.at, snapshots,
        checkpoints: account.analytics?.checkpointsMinutes || [60, 360, 1440, 4320, 10080], now
      });
      if (!due) continue;
      try {
        const resolved = await resolveAccount(accountId, { allowDisabled: true });
        let result;
        if (account.platform === 'x') result = await collectXMetrics({ postId: post.providerPostId, credential: resolved.credential });
        else result = await collectInstagramMetrics({
          postId: post.providerPostId, credential: resolved.credential, apiVersion: account.apiVersion || 'v25.0', mediaType: post.mediaType || account.media?.type || 'image'
        });
        const row = await appendMetricSnapshot({
          account: accountId, platform: account.platform, providerPostId: post.providerPostId,
          publishedAt: post.at, checkpointMinutes: due.checkpointMinutes, actualAgeMinutes: due.actualAgeMinutes,
          metrics: result.metrics, warning: result.warning || null, unavailable: result.unavailable || []
        });
        existing.push(row);
        await evaluateBrakeSafely(accountId, account, existing, report);
        await recordCircuitSuccess(accountId, 'analytics', account.resilience);
        await appendAudit({ account: accountId, stage: 'metrics-collected', providerPostId: post.providerPostId, checkpointMinutes: due.checkpointMinutes });
        report.push({ account: accountId, providerPostId: post.providerPostId, status: 'collected', checkpointMinutes: due.checkpointMinutes });
      } catch (error) {
        const circuit = await recordCircuitFailure(accountId, 'analytics', error, account.resilience);
        await appendAudit({ account: accountId, stage: 'metrics-error', providerPostId: post.providerPostId, error: String(error.message || error).slice(0, 500), circuitOpenUntil: circuit?.openUntil || null });
        report.push({ account: accountId, providerPostId: post.providerPostId, status: 'failed', error: error.message });
        if (circuit?.openUntil) {
          report.push({ account: accountId, status: 'circuit-open', openUntil: circuit.openUntil, reason: 'Stopping remaining metrics calls for this account in the current run.' });
          break;
        }
      }
    }
  }
  return report;
}

function arg(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined; }
if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await collectMetrics({ accountFilter: arg('account') });
  console.log(JSON.stringify(report, null, 2));
  if (report.some((row) => row.status === 'failed')) process.exitCode = 1;
}
