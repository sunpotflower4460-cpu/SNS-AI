# Manual external setup queue

This file records tasks that cannot be completed safely from repository code alone. Keep secrets out of the repository, issues, PR comments and chat.

## Current live-state invariants

- `music-tools-x` live posting remains disabled until the existing social credential/OpenAI publish-preflight sequence is completed.
- Affiliate publishing remains disabled.
- Engagement code/configuration is available for dry-run/preflight, but `config/engagement-policy.json` keeps `liveAccounts: []`, so no automated inbound reply/DM can be sent yet.
- X automated-profile transparency is a posting gate. X AI-reply written approval and reply/DM OAuth2 scopes are separate engagement gates and do **not** block text-only publishing before engagement is activated.
- The scheduled engagement workflow can wake every 30 minutes, but it performs zero provider reads while no account is live. After activation it still reads only inside the recent-own-post window unless DM automation is explicitly enabled, and every actual provider read is bounded by `maxInboundFetchesPerDay`.

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
4. Only after steps 1–2 are genuinely complete, ask ChatGPT to record profile compliance. It creates `[compliance-x-profile] ACCOUNT_ID` with the exact attestation line `I_CONFIRM_X_AUTOMATED_PROFILE_SETUP_COMPLETE=true`. The workflow records the account in `xAutomationProfileComplianceConfirmedAccounts`; it does not perform or infer the external X action.
5. Only after step 3 is genuinely approved, ask ChatGPT to record the written approval. It creates `[compliance-x-ai-reply] ACCOUNT_ID` with `I_CONFIRM_X_AI_REPLY_WRITTEN_APPROVAL_RECEIVED=true`. The workflow records the account in `xAiReplyBotApprovalConfirmedAccounts`.

If either external fact stops being true, use `[compliance-revoke-x-profile] ACCOUNT_ID` or `[compliance-revoke-x-ai-reply] ACCOUNT_ID`. Revoking profile compliance immediately pauses posting and removes the engagement live gate. Revoking AI-reply approval removes the engagement live gate and restores approval-required reply behavior without unnecessarily pausing ordinary posting.

`music-tools-x` is already listed in `xAiReplyBotApprovalRequiredAccounts`, so it cannot become automatic for AI public replies just by changing a generic enable flag. The engagement activation workflow reruns the full compliance check and fails closed if either acknowledgement is missing. Ordinary publish preflight checks profile transparency only and does not require AI-reply approval.

The generated X engagement response appends the configured opt-out sentence deterministically. The runtime persists actor opt-outs and stops further automated responses for that actor.

## X engagement permissions

When reply handling is intentionally started:

1. Re-check X Automation Rules and complete the X developer-app/OAuth consent steps.
2. Authorize OAuth2 with the scopes required by the current policy. Public replies need the reply/read/user scopes derived by the repository plus `offline.access`; enabling DMs additionally requires `dm.read` and `dm.write`.
3. Ensure a refresh token exists for unattended rotation and store the credentials plus `X_OAUTH2_STATE_KEY` in GitHub Actions Secrets.
4. Complete the X account transparency and AI-reply approval steps above.
5. Enable the normal SNS account but keep engagement non-live. Repository-side account lifecycle changes can be requested with `[account-approval] ACCOUNT_ID`; the workflow persists them only after its publish safety gates pass. Starting text-only posting does not require engagement OAuth2.
6. Run `[engagement-dry-run] ACCOUNT_ID` when desired. Detailed private interaction content remains suppressed from public GitHub output.
7. When the controlled checks are satisfactory, create `[engagement-activate] ACCOUNT_ID` from ChatGPT/GitHub. The activation workflow automatically runs Doctor, **engagement-specific** Live Preflight (`--engagement`), and full X automation compliance. It therefore proves reply/DM scopes, refresh-token readiness, profile transparency, and any required AI-reply written approval before atomically adding the account to `liveAccounts` and enabling only that account's unattended engagement behavior.

After activation, `SNS Engagement Scheduled` handles eligible inbound public replies automatically in cost-aware polling windows. Legal/refund/privacy/security/threat/contract/human-request and low-confidence cases remain exceptions that surface for human judgment.

To stop live automated engagement without dismantling the account, create `[engagement-deactivate] ACCOUNT_ID`. This removes the live gate and restores the account to approval-required behavior.

Do not add auto-follow, auto-unfollow, cold keyword replies or unsolicited bulk DMs.

## Instagram engagement permissions

When Instagram handling is intentionally started:

1. Use/confirm an Instagram Professional account.
2. Configure the Meta app/login flow and required permissions, including `instagram_business_basic`, comment management when public comment handling is enabled, and message management when DM handling is enabled.
3. Configure and verify the Webhook endpoint/subscriptions required by the current Meta comment/messaging setup. The SNS-AI runtime can poll provider endpoints, but Meta's platform setup still expects Webhooks for supported real-time notifications.
4. Store access tokens in GitHub Secrets.
5. Test comment/conversation/message ingestion in dry-run before live activation.
6. Use `[engagement-activate] ACCOUNT_ID` only after controlled verification succeeds. The same control workflow handles the live gate and account-scoped automatic-reply override.

## Human-only decisions

Keep a human in the loop for account/app registrations, platform terms acceptance, X automated-account profile setup, X AI-reply written approval, affiliate applications, payment/tax profile setup, bank/payout details, app review/permission approval, OAuth consent, secret creation/rotation, initial controlled live-post review, and any partnership contract that adds obligations beyond a normal affiliate agreement.

The repository can verify recorded state and automate transitions only after those external facts are true; it must not pretend to have completed them. Repository-side recording of the two X compliance facts is allowed only after an owner/admin explicitly supplies the required attestation marker through the dedicated ChatOps command.
