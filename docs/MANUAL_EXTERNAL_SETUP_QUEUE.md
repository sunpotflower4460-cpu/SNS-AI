# Manual external setup queue

This file records tasks that cannot be completed safely from repository code alone. Keep secrets out of the repository, issues, PR comments and chat.

## Current live-state invariants

- `music-tools-x` live posting remains disabled until the existing social credential/OpenAI preflight sequence is completed.
- Affiliate publishing remains disabled.
- Engagement code/configuration is available for dry-run/preflight, but `config/engagement-policy.json` keeps `liveAccounts: []`, so no automated inbound reply/DM can be sent yet.

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

## X engagement permissions

When reply/DM handling is intentionally started:

1. Re-check X Automation Rules and complete the X developer-app/OAuth consent steps.
2. Authorize OAuth2 with the scopes required by the current policy. With both public replies and DMs enabled this is `tweet.read`, `tweet.write`, `users.read`, `dm.read`, `dm.write`, and `offline.access`.
3. Ensure a refresh token exists for unattended rotation and store the credentials plus `X_OAUTH2_STATE_KEY` in GitHub Actions Secrets.
4. Run Live Preflight for `music-tools-x`. It verifies the engagement scopes/refresh-token readiness even though engagement is not live yet.
5. Run engagement dry-run/read-only ingestion and inspect the privacy-safe result.
6. Complete the controlled provider rehearsal from the normal go-live checklist.
7. Only then add `music-tools-x` to `liveAccounts` in `config/engagement-policy.json`.

After step 7, ordinary inbound handling is autonomous and does not need per-reply approval. Legal/refund/privacy/security/threat/contract/human-request and other sensitive/low-confidence cases are the exceptions that surface for human judgment.

To stop live automated engagement without dismantling the account, remove the account from `liveAccounts`.

Do not add auto-follow, auto-unfollow, cold keyword replies or unsolicited bulk DMs.

## Instagram engagement permissions

When Instagram handling is intentionally started:

1. Use/confirm an Instagram Professional account.
2. Configure the Meta app/login flow and required comment/messaging permissions.
3. Store the access token in GitHub Secrets.
4. Test scheduled comment/conversation/message polling in dry-run before live activation.
5. Add the Instagram account to `liveAccounts` only after the controlled verification succeeds.

The repository currently supports scheduled polling of recent comments and Instagram Conversations/messages, so a webhook endpoint is not required for the existing polling runtime. Webhooks remain an optional future path for lower-latency event-driven ingestion.

## Human-only decisions

Keep a human in the loop for account/app registrations, platform terms acceptance, affiliate applications, payment/tax profile setup, bank/payout details, app review/permission approval, OAuth consent, secret creation/rotation, initial controlled live activation, and any partnership contract that adds obligations beyond a normal affiliate agreement.
