import { loadAccounts } from './lib/config.mjs';
import { readHistory, recentHistory } from './lib/history.mjs';
import { findDueSlots } from './lib/schedule.mjs';
import { slotHandled, markSlot } from './lib/state.mjs';
import { checkRateLimits } from './lib/safety.mjs';
import { generatePost } from './lib/openai.mjs';
import { resolveMediaDetailed, ensureMediaForPlatform } from './lib/media.mjs';
import { createApprovalIssue, findApprovalIssue } from './lib/github.mjs';
import { appendAudit } from './lib/audit.mjs';
import { loadStrategy } from './learning/store.mjs';
import { loadTrendBrief } from './research/trends.mjs';
import { recentHumanFeedback } from './feedback/store.mjs';
import { loadExperimentState } from './experiments/store.mjs';
import { assignmentForSlot } from './experiments/engine.mjs';
import { assertCircuitClosed, recordCircuitFailure, recordCircuitSuccess } from './ops/circuit.mjs';
import { assertAutonomyBrakeClear } from './ops/brake.mjs';
import { publish } from './publish.mjs';

function parseArgs(argv) { const args = {}; for (let index = 0; index < argv.length; index += 1) { const token = argv[index]; if (!token.startsWith('--')) continue; const key = token.slice(2); const next = argv[index + 1]; if (!next || next.startsWith('--')) args[key] = true; else { args[key] = next; index += 1; } } return args; }
function bool(value) { return value === true || String(value).toLowerCase() === 'true'; }

export async function runAutopilot({ now = new Date(), accountFilter, force = false, dryRun = false } = {}) {
  const accounts = await loadAccounts(); const report = [];
  if (accountFilter && !accounts[accountFilter]) throw new Error(`Unknown account "${accountFilter}".`);
  for (const [accountId, account] of Object.entries(accounts)) {
    if (accountFilter && accountFilter !== accountId) continue; if (!account.enabled) continue; if (!['auto', 'approval'].includes(account.mode)) continue;

    let strategy;
    let experimentState;
    let slots;
    try {
      strategy = account.learning?.enabled === false ? null : await loadStrategy(accountId);
      experimentState = account.experiments?.enabled === false ? null : await loadExperimentState(accountId);
      slots = force
        ? [{ slotId: `${accountId}:manual:${now.toISOString().slice(0, 16)}`, accountId, time: 'manual', timeZone: account.schedule?.timezone || 'Asia/Tokyo', localDate: now.toISOString().slice(0, 10) }]
        : findDueSlots(accountId, account, now, strategy);
    } catch (error) {
      // A single misconfigured account (e.g. an invalid schedule.timezone that npm run validate
      // should have caught, but wasn't run) must not abort every other account's run - this loop is
      // meant to isolate failures per account/slot everywhere else, so this preparation step needs the
      // same isolation instead of throwing out of the whole function.
      report.push({ account: accountId, status: 'account-error', error: error.message });
      await appendAudit({ account: accountId, stage: 'autopilot-account-error', error: String(error.message || error).slice(0, 500) }).catch(() => {});
      continue;
    }

    for (const slot of slots) {
      try {
        if (!force && await slotHandled(slot.slotId)) { report.push({ account: accountId, slot: slot.slotId, status: 'already-handled' }); continue; }
      } catch (error) {
        report.push({ account: accountId, slot: slot.slotId, status: 'state-error', error: error.message });
        await appendAudit({ account: accountId, stage: 'autopilot-state-error', slotId: slot.slotId, error: String(error.message || error).slice(0, 500) }).catch(() => {});
        continue;
      }

      if (!dryRun && account.mode === 'approval') {
        try {
          const existingIssue = await findApprovalIssue(accountId, slot.slotId);
          if (existingIssue) {
            await markSlot(slot.slotId, 'approval_pending', { account: accountId, issue: existingIssue.number });
            await appendAudit({ account: accountId, stage: 'approval-state-recovered', slotId: slot.slotId, issue: existingIssue.number }).catch(() => {});
            report.push({ account: accountId, slot: slot.slotId, status: 'approval-pending-recovered', issue: existingIssue.number });
            continue;
          }
        } catch (error) {
          await appendAudit({ account: accountId, stage: 'approval-reconcile-error', slotId: slot.slotId, error: String(error.message || error).slice(0, 500) }).catch(() => {});
          report.push({ account: accountId, slot: slot.slotId, status: 'approval-reconcile-error', error: error.message });
          continue;
        }
      }

      try { await assertAutonomyBrakeClear(accountId, account); }
      catch (error) {
        report.push({ account: accountId, slot: slot.slotId, status: 'safety-brake', reason: error.reason || error.message, openUntil: error.openUntil || null });
        await appendAudit({ account: accountId, stage: 'autopilot-safety-brake', slotId: slot.slotId, reason: error.reason || null, openUntil: error.openUntil || null }).catch(() => {});
        continue;
      }
      try { await assertCircuitClosed(accountId, 'autopilot', account.resilience); }
      catch (error) { report.push({ account: accountId, slot: slot.slotId, status: 'circuit-open', reason: error.message, openUntil: error.openUntil || null }); continue; }

      let rate;
      try {
        const currentHistory = await readHistory();
        rate = checkRateLimits(accountId, account, currentHistory, now);
      } catch (error) {
        // Same isolation concern as the per-account setup step above: a bad schedule.timezone can
        // throw from deep inside checkRateLimits -> postsToday -> localDateKey -> Intl.DateTimeFormat,
        // and must not take down every other account/slot in this run.
        report.push({ account: accountId, slot: slot.slotId, status: 'state-error', error: error.message });
        await appendAudit({ account: accountId, stage: 'autopilot-rate-limit-error', slotId: slot.slotId, error: String(error.message || error).slice(0, 500) }).catch(() => {});
        continue;
      }
      if (!rate.ok) { report.push({ account: accountId, slot: slot.slotId, status: 'rate-limited', reason: rate.reason }); continue; }

      const experimentAssignment = assignmentForSlot(experimentState?.active, slot.slotId);
      try {
        const history = await recentHistory(accountId, Number(account.generation?.historyWindow ?? 30));
        const trends = account.research?.trendIntelligence === true ? await loadTrendBrief(accountId) : null;
        const humanFeedback = await recentHumanFeedback(accountId, Number(account.learning?.humanFeedbackWindow ?? 40));
        await appendAudit({ account: accountId, stage: 'decision-start', slotId: slot.slotId, strategyGeneratedAt: strategy?.generatedAt || null, trendGeneratedAt: trends?.generatedAt || null, humanFeedbackCount: humanFeedback.length, experiment: experimentAssignment });

        const draft = await generatePost(accountId, account, history, { strategy, trends, humanFeedback, experimentAssignment, slotId: slot.slotId, dryRun });
        const media = await resolveMediaDetailed(accountId, account, slot.slotId, draft, { dryRun });
        ensureMediaForPlatform(account, media.url);
        draft.features = { ...(draft.features || {}), mediaDecision: media.decision };
        const experimentApplied = experimentAssignment
          ? (experimentAssignment.dimension === 'mediaDecision'
            ? String(media.decision) === String(experimentAssignment.variant)
            : Boolean(draft.experimentApplied))
          : false;
        const experiment = experimentAssignment ? { ...experimentAssignment, applied: experimentApplied } : null;
        const sources = (draft.sources || []).slice(0, 30);
        const payload = {
          account: accountId, text: draft.text, mediaUrl: media.url || undefined, mediaType: account.media?.type || 'image', dryRun,
          mediaAltText: String(media.altText || '').slice(0, 1000), mediaQa: media.qa || null,
          source: account.mode === 'approval' ? 'approval' : 'auto', slotId: slot.slotId,
          features: draft.features, rationale: draft.rationale, predictedScore: draft.predictedScore, selectionMode: draft.selectionMode, experiment, sources,
          mediaResolution: { decision: media.decision, source: media.source },
          ai: { model: draft.model, promptVersion: draft.promptVersion, attempt: draft.attempt, candidatesConsidered: draft.candidatesConsidered, humanFeedbackCount: humanFeedback.length }
        };
        await appendAudit({
          account: accountId, stage: 'candidate-selected', slotId: slot.slotId, predictedScore: draft.predictedScore, selectionMode: draft.selectionMode,
          features: draft.features, rationale: draft.rationale, mediaResolved: Boolean(media.url), mediaSource: media.source,
          mediaQa: media.qa ? { pass: media.qa.pass, score: media.qa.score, issues: media.qa.issues?.slice(0, 5) || [] } : null,
          experiment, sourceCount: sources.length, dryRun
        });

        // A dry run never calls the publisher and (as of the dry-run budget-isolation fix) never even
        // runs moderation - it proves nothing about whether a real publish would actually succeed. It
        // must not touch the resilience circuit breaker: recordCircuitSuccess() unconditionally resets
        // failures/openUntil/lastError in data/runtime-health.json, which autopilot.yml commits
        // whenever it changes even for dry runs - so a manual preview run could silently erase a
        // legitimate open circuit (real prior failures) that was correctly protecting the account.
        if (dryRun) { report.push({ account: accountId, slot: slot.slotId, status: 'dry-run', payload }); continue; }
        if (account.mode === 'approval') {
          const issue = await createApprovalIssue(accountId, slot.slotId, payload); await markSlot(slot.slotId, 'approval_pending', { account: accountId, issue: issue.number });
          await recordCircuitSuccess(accountId, 'autopilot', account.resilience); report.push({ account: accountId, slot: slot.slotId, status: 'approval-pending', issue: issue.number, predictedScore: draft.predictedScore }); continue;
        }
        const result = await publish(payload); await recordCircuitSuccess(accountId, 'autopilot', account.resilience);
        report.push({ account: accountId, slot: slot.slotId, status: result?.idempotentReplay ? 'already-published' : 'published', result, predictedScore: draft.predictedScore, selectionMode: draft.selectionMode, experiment });
      } catch (error) {
        const nonCircuitCodes = ['BUDGET_EXHAUSTED', 'CIRCUIT_OPEN', 'AUTONOMY_BRAKE', 'MEDIA_QA_FAILED', 'MEDIA_QA_INPUT_TOO_LARGE', 'MEDIA_HOSTING_TOO_LARGE', 'SLOT_ALREADY_CLAIMED', 'PROVIDER_DEPRECATED'];
        if (!nonCircuitCodes.includes(error.code)) await recordCircuitFailure(accountId, 'autopilot', error, account.resilience);
        await appendAudit({
          account: accountId, stage: 'autopilot-error', slotId: slot.slotId, code: error.code || null,
          error: String(error.message || error).slice(0, 500), qa: error.qa ? { score: error.qa.score, issues: error.qa.issues?.slice(0, 5) || [] } : null, dryRun
        }).catch(() => {});
        const status = error.code === 'BUDGET_EXHAUSTED' ? 'budget-exhausted'
          : error.code === 'CIRCUIT_OPEN' ? 'circuit-open'
            : error.code === 'SLOT_ALREADY_CLAIMED' ? 'already-handled'
              : error.code === 'MEDIA_QA_FAILED' || error.code === 'MEDIA_QA_INPUT_TOO_LARGE' || error.code === 'MEDIA_HOSTING_TOO_LARGE' ? 'media-qa-failed'
                : error.code === 'PROVIDER_DEPRECATED' ? 'provider-deprecated'
                  : error.code === 'AUTONOMY_BRAKE' ? 'safety-brake' : 'failed';
        report.push({ account: accountId, slot: slot.slotId, status, error: error.message });
      }
    }
  }
  return report;
}

// Every status here reflects a real bug/unexpected error that isolated a single account/slot rather
// than crashing the whole run (account-error/state-error/approval-reconcile-error come from the
// per-account and per-slot try/catch guards added for exactly that isolation) - a scheduled run must
// not exit 0 and look green while one of these silently skipped an account. Intentional control-flow
// pauses (budget-exhausted, circuit-open, rate-limited, safety-brake, media-qa-failed,
// provider-deprecated, already-handled) are deliberately excluded: those are the system working as
// designed, not a bug to alert on.
const FATAL_STATUSES = new Set(['failed', 'account-error', 'state-error', 'approval-reconcile-error']);
export function hasFatalStatus(report) {
  return (report || []).some((entry) => FATAL_STATUSES.has(entry.status));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2)); const report = await runAutopilot({ accountFilter: args.account || undefined, force: bool(args.force), dryRun: bool(args['dry-run']) || bool(process.env.DRY_RUN) });
  console.log(JSON.stringify(report, null, 2)); if (hasFatalStatus(report)) process.exitCode = 1;
}