# Manual external setup queue

This file records tasks that cannot be completed safely from repository code alone. Keep secrets out of the repository, issues, PR comments and chat.

## Current live-state invariants

- `music-tools-x` live posting remains disabled until the existing social credential/OpenAI preflight sequence is completed.
- Affiliate publishing remains disabled.
- Engagement automation remains disabled.

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

- re-check X Automation Rules;
- authorize the X app with the scopes required for the chosen functions;
- DM automation currently needs OAuth 2.0 user authorization with `dm.write`, `dm.read`, `tweet.read`, and `users.read`;
- verify the authenticated user/account ID;
- begin with read-only ingestion, then approval-mode responses;
- retain opt-out handling and one automated response per user interaction.

Do not add auto-follow, auto-unfollow, cold keyword replies or unsolicited bulk DMs.

## Instagram engagement permissions

When Instagram handling is intentionally started:

- use/confirm an Instagram professional account;
- configure the Meta app/login flow and required business permissions;
- configure Webhooks for comments/messages;
- store access tokens in GitHub Secrets;
- test read-only comment/message ingestion first;
- start public/private/DM responses in approval mode.

## Human-only decisions

Keep a human in the loop for account/app registrations, platform terms acceptance, affiliate applications, payment/tax profile setup, bank/payout details, app review/permission approval, OAuth consent, secret creation/rotation, and any partnership contract that adds obligations beyond a normal affiliate agreement.
