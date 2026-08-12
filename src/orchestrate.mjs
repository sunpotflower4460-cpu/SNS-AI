import { loadAccounts } from './lib/config.mjs';
import { readHistory, recentHistory } from './lib/history.mjs';
import { findDueSlots } from './lib/schedule.mjs';
import { slotHandled, markSlot } from './lib/state.mjs';
import { checkRateLimits } from './lib/safety.mjs';
import { generatePost } from './lib/openai.mjs';
import { resolveMedia, ensureMediaForPlatform } from './lib/media.mjs';
import { createApprovalIssue } from './lib/github.mjs';
import { loadStrategy } from './learning/store.mjs';
import { loadTrendBrief } from './research/trends.mjs';
import { recentHumanFeedback } from './feedback/store.mjs';
import { publish } from './publish.mjs';

function parseArgs(argv) { const args = {}; for (let index = 0; index < argv.length; index += 1) { const token = argv[index]; if (!token.startsWith('--')) continue; const key = token.slice(2); const next = argv[index + 1]; if (!next || next.startsWith('--')) args[key] = true; else { args[key] = next; index += 1; } } return args; }
function bool(value) { return value === true || String(value).toLowerCase() === 'true'; }

export async function runAutopilot({ now = new Date(), accountFilter, force = false, dryRun = false } = {}) {
  const accounts = await loadAccounts(); const report = [];
  for (const [accountId, account] of Object.entries(accounts)) {
    if (accountFilter && accountFilter !== accountId) continue; if (!account.enabled) continue; if (!['auto', 'approval'].includes(account.mode)) continue;
    const slots = force ? [{ slotId: `${accountId}:manual:${now.toISOString().slice(0, 16)}`, accountId, time: 'manual', timeZone: account.schedule?.timezone || 'Asia/Tokyo', localDate: now.toISOString().slice(0, 10) }] : findDueSlots(accountId, account, now);
    for (const slot of slots) {
      if (!force && await slotHandled(slot.slotId)) { report.push({ account: accountId, slot: slot.slotId, status: 'already-handled' }); continue; }
      const currentHistory = await readHistory(); const rate = checkRateLimits(accountId, account, currentHistory, now);
      if (!rate.ok) { report.push({ account: accountId, slot: slot.slotId, status: 'rate-limited', reason: rate.reason }); continue; }
      try {
        const history = await recentHistory(accountId, Number(account.generation?.historyWindow ?? 30));
        const strategy = account.learning?.enabled === false ? null : await loadStrategy(accountId);
        const trends = account.research?.trendIntelligence === true ? await loadTrendBrief(accountId) : null;
        const humanFeedback = await recentHumanFeedback(accountId, Number(account.learning?.humanFeedbackWindow ?? 40));
        const draft = await generatePost(accountId, account, history, { strategy, trends, humanFeedback, slotId: slot.slotId });
        const mediaUrl = await resolveMedia(accountId, account, slot.slotId, draft); ensureMediaForPlatform(account, mediaUrl);
        const payload = {
          account: accountId, text: draft.text, mediaUrl: mediaUrl || undefined, mediaType: account.media?.type || 'image', dryRun,
          source: account.mode === 'approval' ? 'approval' : 'auto', slotId: slot.slotId,
          features: draft.features, rationale: draft.rationale, predictedScore: draft.predictedScore, selectionMode: draft.selectionMode,
          ai: { model: draft.model, attempt: draft.attempt, candidatesConsidered: draft.candidatesConsidered, humanFeedbackCount: humanFeedback.length }
        };
        if (dryRun) { report.push({ account: accountId, slot: slot.slotId, status: 'dry-run', payload }); continue; }
        if (account.mode === 'approval') {
          const issue = await createApprovalIssue(accountId, slot.slotId, payload); await markSlot(slot.slotId, 'approval_pending', { account: accountId, issue: issue.number });
          report.push({ account: accountId, slot: slot.slotId, status: 'approval-pending', issue: issue.number, predictedScore: draft.predictedScore }); continue;
        }
        const result = await publish(payload); report.push({ account: accountId, slot: slot.slotId, status: 'published', result, predictedScore: draft.predictedScore, selectionMode: draft.selectionMode });
      } catch (error) { report.push({ account: accountId, slot: slot.slotId, status: 'failed', error: error.message }); }
    }
  }
  return report;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2)); const report = await runAutopilot({ accountFilter: args.account || undefined, force: bool(args.force), dryRun: bool(args['dry-run']) || bool(process.env.DRY_RUN) });
  console.log(JSON.stringify(report, null, 2)); if (report.some((entry) => entry.status === 'failed')) process.exitCode = 1;
}
