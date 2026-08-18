# Manual external setup queue

This file records tasks that cannot be completed safely from repository code alone. Keep secrets out of the repository, issues, PR comments and ordinary chat.

## Current live-state invariants

- `music-tools-x` live posting remains disabled until the existing social credential/OpenAI preflight sequence is completed.
- Affiliate publishing remains disabled.
- Engagement code/configuration is available for dry-run/preflight, but `config/engagement-policy.json` keeps `liveAccounts: []`, so no automated inbound reply/DM can be sent yet.
- X automation compliance flags stay false until the corresponding external X setup/approval has actually been completed. Never flip them merely to make Preflight green.

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

## X engagement permissions and one-time compliance gates

When X reply/DM handling is intentionally started, complete these external steps once before enabling live engagement:

1. Re-check the current X Automation Rules at setup time.
2. Enable X's Automated account label for the automated account and keep it connected to the human-managed account that operates it. Only after this is actually visible/complete may `xAutomatedAccountLabelConfirmed` be changed to `true`.
3. Before operating AI-generated **public automated replies**, request and receive X's prior written and explicit approval for the AI reply bot/use case. Only after the approval is actually received may `xAiReplyBotApprovalConfirmed` be changed to `true`.
4. Keep the configured clear opt-out notice enabled. SNS-AI appends it deterministically to eligible automated X replies/DM replies and permanently honors the supported opt-out phrase for that actor.
5. Complete the X developer-app/OAuth consent flow for the same real account.
6. Authorize OAuth2 with the scopes required by the current policy. With public replies and DMs both enabled this is `tweet.read`, `tweet.write`, `users.read`, `dm.read`, `dm.write`, and `offline.access`.
7. Ensure a refresh token exists for unattended rotation and store the credentials plus `X_OAUTH2_STATE_KEY` in GitHub Actions Secrets.
8. Run Live Preflight for `music-tools-x`. Preflight must remain blocked while a required label/approval confirmation is false, even if OAuth itself is valid.
9. Run engagement dry-run/read-only ingestion. Detailed private-DM-derived output is intentionally suppressed from public Actions/ChatOps surfaces.
10. Complete the controlled provider rehearsal from the normal go-live checklist.
11. Only then add `music-tools-x` to `liveAccounts` in `config/engagement-policy.json`.

The prior-X-approval gate applies to AI-powered **public automated replies**. It is not a per-message approval system and does not turn ordinary inbound DMs into manual approvals. Once the one-time external gates are complete and the account is live, ordinary eligible inbound handling is autonomous. Legal/refund/privacy/security/threat/contract/human-request and other sensitive or low-confidence cases remain the exception path that surfaces for human judgment.

To stop live automated engagement without dismantling the account, remove the account from `liveAccounts`.

Do not add auto-follow, auto-unfollow, cold keyword replies or unsolicited bulk DMs.

## Instagram engagement permissions

When Instagram handling is intentionally started:

1. Use/confirm an Instagram Professional account.
2. Configure the Meta app/login flow and required permissions, including `instagram_business_basic`, comment management when public comment handling is enabled, and message management when DM handling is enabled.
3. Complete the webhook endpoint/subscription setup required by the current Meta messaging/app-review flow. The SNS-AI runtime currently polls Conversations/messages on a schedule rather than consuming webhook payloads, but that does not imply Meta's external app setup can skip webhook prerequisites.
4. Store the access token in GitHub Secrets.
5. Test scheduled comment/conversation/message polling in dry-run before live activation.
6. Add the Instagram account to `liveAccounts` only after the controlled verification succeeds.

## Human-only decisions

Keep a human in the loop for account/app registrations, platform terms acceptance, X's Automated account label/human-account connection, X's one-time AI reply-bot approval, affiliate applications, payment/tax profile setup, bank/payout details, app review/permission approval, OAuth consent, secret creation/rotation, initial controlled live activation, and any partnership contract that adds obligations beyond a normal affiliate agreement.
