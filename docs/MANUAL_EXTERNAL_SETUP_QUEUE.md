# Manual external setup queue

This file records tasks that cannot be completed safely from repository code alone. Keep secrets out of the repository, issues, PR comments and chat.

**This repository is currently locked to Manual-Only** (see `docs/MANUAL_ONLY_MODE.md`). Every repository-side action below is a manually dispatched GitHub Action (`workflow_dispatch`) — there is no Issue-title command system. "Ask ChatGPT to record X" below means: dispatch the named Action with the listed inputs from the Actions tab (or `gh workflow run`), not open or comment on an Issue.

## Current live-state invariants

- `music-tools-x` live posting remains disabled until the existing social credential/OpenAI publish-preflight sequence is completed.
- Affiliate publishing remains disabled.
- Engagement code/configuration is available for dry-run/preflight, but `config/engagement-policy.json` keeps `liveAccounts: []`, so no automated inbound reply/DM can be sent yet.
- X automated-profile transparency is a posting gate. X AI-reply written approval and reply/DM OAuth2 scopes are separate engagement gates and do **not** block text-only publishing before engagement is activated.
- `SNS Engagement Scheduled` (`engagement-scheduled.yml`) is wired to the real polling logic in `src/engagement/scheduled.mjs`, but is inert under Manual-Only: `allowScheduledProviderPolling:false` in `config/runtime-policy.json` (verified by `manual-only-audit`) and `enabled:false`/`liveAccounts:[]` in `config/engagement-policy.json` together cause `runScheduledEngagement()` to return `state:'disabled'` without performing any provider reads. Manual `workflow_dispatch` can be used to confirm inertness. To enable scheduled engagement, set `allowScheduledProviderPolling:true` in `config/runtime-policy.json` and add a `schedule` trigger to the workflow as a separate reviewed change. Until then, **SNS Engagement Autopilot** dispatched manually is the only way to run engagement discovery and classification.

## Affiliate applications

When monetization is intentionally started, re-check current terms first, then apply in this rough order:

1. Native Instruments / iZotope / Plugin Alliance affiliate programs.
2. Plugin Boutique / Loopmasters / Loopcloud.
3. Output.
4. PluginFox.
5. Best Service.
6. Waves.
7. Kilohearts, sonible, Mastering The Mix, Audio Plugin Deals, Loot Audio as additional coverage.

After each approval, capture only the identifiers/templates needed by `config/affiliate-programs.json`; credentials/tokens belong in GitHub Actions Secrets. Impact connections need `IMPACT_ACCOUNT_SID` and `IMPACT_AUTH_TOKEN` plus the approved ProgramId and media property. Do not enable a registry program until its terms and permitted social placements have been reverified.

## X account transparency and AI-reply approval

These are one-time external X-side actions. Repository code cannot truthfully perform or verify the X UI/approval actions itself, so the relevant safety gate requires an explicit acknowledgement after they are complete.

For each X account that will be automated:

1. Enable the X **Automated** profile label and link the bot/automated account to its human-managed account.
2. Make the profile bio clearly disclose that the account is automated and identify who operates/manages it.
3. If the account will use AI-generated automated public replies, obtain X's prior written and explicit approval for that AI reply bot/use case through the current X developer/support route.
4. Only after steps 1–2 are genuinely complete, dispatch **SNS Compliance Attestation** (`compliance-attestation.yml`) with `account: ACCOUNT_ID`, `kind: x-profile`, `action: confirm`, `confirmation: I_CONFIRM_X_AUTOMATED_PROFILE_SETUP_COMPLETE=true`. The workflow records the account in `xAutomationProfileComplianceConfirmedAccounts`; it does not perform or infer the external X action.
5. Only after step 3 is genuinely approved, dispatch the same workflow with `kind: x-ai-reply`, `action: confirm`, `confirmation: I_CONFIRM_X_AI_REPLY_WRITTEN_APPROVAL_RECEIVED=true`. The workflow records the account in `xAiReplyBotApprovalConfirmedAccounts`.

If either external fact stops being true, dispatch **SNS Compliance Attestation** again with `action: revoke` and the matching `kind` (`x-profile` or `x-ai-reply`; no `confirmation` needed for a revoke). Revoking profile compliance immediately pauses posting and removes the engagement live gate. Revoking AI-reply approval removes the engagement live gate and restores approval-required reply behavior without unnecessarily pausing ordinary posting.

`music-tools-x` is already listed in `xAiReplyBotApprovalRequiredAccounts`, so it cannot become automatic for AI public replies just by changing a generic enable flag. The engagement activation workflow reruns the full compliance check and fails closed if either acknowledgement is missing. Ordinary publish preflight checks profile transparency only and does not require AI-reply approval.

The generated X engagement response appends the configured opt-out sentence deterministically. The runtime persists actor opt-outs and stops further automated responses for that actor.

## X engagement permissions

When reply handling is intentionally started:

1. Re-check X Automation Rules and complete the X developer-app/OAuth consent steps.
2. Authorize OAuth2 with the scopes required by the current policy. Public replies need the reply/read/user scopes derived by the repository plus `offline.access`; enabling DMs additionally requires `dm.read` and `dm.write`.
3. Ensure a refresh token exists for unattended rotation and store the credentials plus `X_OAUTH2_STATE_KEY` in GitHub Actions Secrets.
4. Complete the X account transparency and AI-reply approval steps above.
5. Enable the normal SNS account but keep engagement non-live. Repository-side account lifecycle changes are made by dispatching **SNS Account Control** (`account-control.yml`) with `account: ACCOUNT_ID`, `target: approval`; the workflow persists them only after its publish safety gates pass. Note: while Manual-Only is active, `target: approval` is itself rejected by the runtime policy regardless of who runs the workflow — reaching `approval` mode currently requires a code-reviewed edit to `config/accounts.json` instead (see `docs/CHATOPS_ACCOUNT_LIFECYCLE.md`). Starting text-only posting does not require engagement OAuth2.
6. Dispatch **SNS Engagement Autopilot** (`engagement.yml`) with `account: ACCOUNT_ID`, `dry_run: true` when desired. Detailed private interaction content remains suppressed from public GitHub output.
7. When the controlled checks are satisfactory, dispatch **SNS Engagement Control** (`engagement-control.yml`) with `account: ACCOUNT_ID`, `action: activate`. The activation workflow automatically runs Doctor, **engagement-specific** Live Preflight (`--engagement`), and full X automation compliance. It therefore proves reply/DM scopes, refresh-token readiness, profile transparency, and any required AI-reply written approval before atomically adding the account to `liveAccounts` and enabling only that account's unattended engagement behavior. As with account lifecycle changes, `action: activate` is itself rejected while Manual-Only is active.

Once Manual-Only is separately reviewed and lifted for scheduled polling, `SNS Engagement Scheduled` is designed to handle eligible inbound public replies automatically in cost-aware polling windows; today it remains `workflow_dispatch`-only and fail-closed via `allowScheduledProviderPolling:false` (see the current-state note above). Legal/refund/privacy/security/threat/contract/human-request and low-confidence cases remain exceptions that surface for human judgment — resolved via **SNS Engagement Resolve** (`engagement-resolve.yml`), never by commenting on or labeling the escalation Issue.

To stop live automated engagement without dismantling the account, dispatch **SNS Engagement Control** with `action: deactivate`. This removes the live gate and restores the account to approval-required behavior, and — unlike `activate` — is not blocked by Manual-Only.

Do not add auto-follow, auto-unfollow, cold keyword replies or unsolicited bulk DMs.

## Instagram engagement permissions

When Instagram handling is intentionally started:

1. Use/confirm an Instagram Professional account.
2. Configure the Meta app/login flow and required permissions, including `instagram_business_basic`, comment management when public comment handling is enabled, and message management when DM handling is enabled.
3. Configure and verify the Webhook endpoint/subscriptions required by the current Meta comment/messaging setup. The SNS-AI runtime can poll provider endpoints, but Meta's platform setup still expects Webhooks for supported real-time notifications.
4. Store access tokens in GitHub Secrets.
5. Test comment/conversation/message ingestion in dry-run before live activation.
6. Dispatch **SNS Engagement Control** with `action: activate` only after controlled verification succeeds. The same control workflow handles the live gate and account-scoped automatic-reply override (and, like the X path above, is itself rejected while Manual-Only is active).

## Human-only decisions

Keep a human in the loop for account/app registrations, platform terms acceptance, X automated-account profile setup, X AI-reply written approval, affiliate applications, payment/tax profile setup, bank/payout details, app review/permission approval, OAuth consent, secret creation/rotation, initial controlled live-post review, and any partnership contract that adds obligations beyond a normal affiliate agreement.

The repository can verify recorded state and automate transitions only after those external facts are true; it must not pretend to have completed them. Repository-side recording of the two X compliance facts is allowed only after an owner/admin explicitly supplies the required attestation marker through the dedicated ChatOps command.
