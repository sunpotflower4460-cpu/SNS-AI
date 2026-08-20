# Engagement handling — current manual-only posture

Verified baseline: 2026-08-20.

The repository contains a full inbound engagement automation engine, but **unattended engagement is currently locked off**.

The current source of truth is `config/operation-mode.json`:

```json
{
  "mode": "manual-only",
  "allowUnattendedEngagement": false
}
```

## What is active now

- `config/engagement-policy.json` keeps `liveAccounts: []`.
- global `approvalRequired` remains `true`.
- `autoDmReply` remains `false` and the DM daily automation cap remains `0`.
- `SNS Engagement Autopilot` is `workflow_dispatch` only.
- `SNS Engagement Scheduled` is `workflow_dispatch` only despite its historical name.
- there is no active engagement cron.
- `[engagement-activate] ACCOUNT_ID` and direct `--activate` are rejected by the manual-only runtime lock.

Therefore no X/Instagram reply, DM, mention polling, comment polling, or conversation polling begins by itself.

## What can be used manually

### Dry-run

Use the ChatOps command or manual workflow to collect/classify/draft without sending:

```text
[engagement-dry-run] ACCOUNT_ID
```

Dry-run may perform provider reads when the account credentials/setup allow it, but it is started only by an explicit owner/admin action.

### Human-resolved public interaction

A public interaction that has already been surfaced for human review may be intentionally resolved through the existing `engagement-resolve` path. The operator chooses reply vs ignore and supplies the final public reply text when replying.

### Private DM

Private human-required DM content should remain in the SNS app. Do not copy private message bodies into a public GitHub Issue. Human-required private replies are sent manually in the SNS app.

## Safety rules retained even for manual runs

- inbound only;
- X public replies are scoped to threads rooted at our own published posts;
- no keyword-search cold replies;
- no proactive follow/unfollow;
- no unsolicited bulk DMs;
- one automated delivery reservation per inbound interaction;
- daily provider-read caps;
- cooldowns and confidence thresholds;
- explicit opt-out persistence;
- private DM bodies are not persisted to repository state/audit/Issues;
- private DM content is not used as a web-search query;
- ambiguous provider delivery blocks blind retry.

## Delivery idempotency

The engagement delivery ledger is written before a provider send. If the provider result is ambiguous, SNS-AI prefers at-most-once behavior and blocks automatic retry until the case is intentionally handled.

## X setup when manually testing engagement

Depending on the enabled channels, the OAuth2 session needs the policy-derived scopes, typically including:

- `tweet.read`
- `users.read`
- `offline.access`
- `tweet.write` for public replies
- `dm.read` / `dm.write` only if DM automation is intentionally introduced in a future mode

The repository also keeps fail-closed checks for X automated-profile transparency and any required prior written approval for AI-powered automated public replies.

## Instagram setup when manually testing engagement

Use an Instagram Professional account, Meta app/login setup, and the permissions/app review required for the specific comment/message features being tested. Provider setup remains a human-controlled external boundary.

## Future unattended engagement

The implementation for cost-aware scheduled polling remains in source for future use, including recent-own-post windows and hard provider-read caps. It is **dormant code**, not current behavior.

To re-enable unattended engagement in the future, do not merely add a cron or `liveAccounts` entry. A reviewed change must:

1. intentionally change `config/operation-mode.json` to allow unattended engagement;
2. verify provider permissions/billing/compliance again;
3. prove the account in controlled approval/manual operation first;
4. enable only the intended account;
5. restore only the specific schedule wanted;
6. intentionally update the manual-only trigger tests;
7. pass CI.

Until that happens, the expected state is **manual dry-run / human resolution only, no unattended provider polling or replies**.
