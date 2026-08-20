# Manual external setup queue

This file records tasks that cannot be completed safely from repository code alone. Keep secrets out of the repository, Issues, PR comments and chat.

## Current live-state invariants

- Repository operation mode is `manual-only`.
- All configured SNS accounts remain disabled until a deliberate controlled approval-mode launch.
- Affiliate publishing remains disabled.
- Engagement dry-run code is available, but `liveAccounts: []` and unattended engagement activation is blocked by the runtime operation lock.
- No SNS/provider operational workflow has an active schedule/cron.
- `SNS Engagement Scheduled` is historical naming only; it is currently `workflow_dispatch` only.
- `SNS Autopilot`, Metrics, Learning, Trend, Health, Maintenance, Policy, Hub reconcile and publish read-back are all manual dispatch only.

## External setup that remains human-only

Repository code must not invent or bypass any of these facts:

- platform app/developer registrations;
- OAuth consent;
- provider terms acceptance;
- billing/credits;
- X/Meta review or permission approvals;
- X automated-account profile setup;
- X written approval for AI-powered automated public replies where required;
- affiliate applications;
- payout/tax/bank information;
- secret creation/rotation;
- initial controlled live-post review;
- partnership/licensing contracts.

## X account transparency

For each X account that will be used:

1. Complete the required automated-profile transparency setup in X.
2. Make the account bio/identity disclosure appropriate for the current X rules.
3. Only after the external setup is genuinely complete, record repository-side compliance through the dedicated owner/admin attestation flow.

The repository records the acknowledgement; it does not perform or infer the external X UI action.

## X publishing credentials

### Text-only

Prepare OAuth1 user credentials in `SOCIAL_CREDENTIALS_JSON` and confirm X API billing/credits.

### Media

When image/video upload is used, prepare the required OAuth2 user scopes, offline refresh token, and `X_OAUTH2_STATE_KEY` where the current implementation requires encrypted rotating token state.

Run Live Preflight before any controlled real post.

## Instagram publishing credentials

- Instagram Professional account;
- Meta app/login flow;
- access token;
- `igUserId`;
- content publishing permissions/app review as required;
- insights permission only if metrics are used.

Run controlled dry-run/preflight before any real post.

## Controlled posting sequence

When external setup is complete:

1. request `[account-approval] ACCOUNT_ID`;
2. run Doctor / Live Preflight;
3. run Autopilot `force=true / dry_run=true` manually;
4. inspect the generated draft/media/safety output;
5. perform one approval/manual real post;
6. verify provider post ID persistence;
7. run Metrics Collector manually;
8. verify the snapshot/report;
9. pause/disable again if the account should return to storage state.

`[account-auto]` remains blocked while the repository operation mode is manual-only.

## Engagement setup for manual testing

Public reply/DM automation is not activated in the current mode.

When engagement testing is desired:

1. complete the relevant X/Meta OAuth and permission setup;
2. complete any required X automated-profile / AI-reply approval facts;
3. keep `liveAccounts` empty;
4. run `[engagement-dry-run] ACCOUNT_ID` manually;
5. inspect only privacy-safe output;
6. handle human-required public interactions through explicit human resolution;
7. handle private DMs in the SNS app.

`[engagement-activate]` is intentionally blocked by the manual-only runtime lock. Re-enabling unattended engagement requires a separate reviewed operation-mode change; it is not part of this setup queue.

## Affiliate applications

When monetization is intentionally started, re-check current provider terms before applying or enabling any registry entry. Store only identifiers/templates in repository config; credentials/tokens belong in Actions Secrets.

Do not enable affiliate publishing merely because a program is approved. Keep the repository monetization gate disabled until the specific account/content policy is intentionally reviewed.
