# Engagement automation

Verified baseline: 2026-08-20.

**This repository is currently locked to Manual-Only** (see `docs/MANUAL_ONLY_MODE.md`). This document describes the designed capability. The "Activation model" and "Runtime" sections below name the real `workflow_dispatch` Actions to use — there is no Issue-title command system — and `SNS Engagement Scheduled` is wired to the real polling module but stays inert under Manual-Only (`allowScheduledProviderPolling:false`, plus `enabled:false` / `liveAccounts:[]`); see the note in that section.

## Goal

Run useful inbound community handling with minimal operator interruption:

1. Detect genuine inbound interactions.
2. Wait a bounded human-like delay instead of replying instantly.
3. Classify intent, sensitivity, and confidence.
4. Draft a concise account-voice response.
5. Send routine high-confidence responses automatically.
6. Escalate only interactions that genuinely require an owner/human decision.
7. Persist privacy-safe state and outcome metadata for idempotency and later quality tuning.

The target is **exception-based human involvement**, not per-reply approval.

## Activation model

Engagement has two account gates in `config/engagement-policy.json`:

- `allowedAccounts`: accounts whose engagement setup may be checked and dry-run.
- `liveAccounts`: accounts allowed to perform live inbound handling.

There is also a per-account `engagement.approvalRequired` override in `config/accounts.json`.
The repository keeps the global launch posture conservative (`approvalRequired: true`). A successful
controlled activation changes only the selected account to `approvalRequired: false` and adds only that
account to `liveAccounts`. Deactivation removes it from `liveAccounts` and restores the account override
to `true`.

Dispatch **SNS Engagement Control** (`engagement-control.yml`, `workflow_dispatch`) with `account: ACCOUNT_ID` and:

- `action: activate`
- `action: deactivate`

`action: activate` fails closed unless all repository-verifiable gates pass first (and, while Manual-Only is active, is rejected outright regardless of who runs it — see `docs/CHATOPS.md`):

- account is enabled and not paused;
- account is in `allowedAccounts`;
- strict Doctor passes;
- Live Preflight passes, including provider credentials/scopes and durable state;
- X automation compliance passes for X accounts, including the recorded automated-profile disclosure
  acknowledgement and any required prior written X approval for an AI reply bot.

The control workflow then commits `config/accounts.json` and `config/engagement-policy.json` together.
A failed runner therefore cannot persist a one-file half-activation.

`action: deactivate` is the kill switch. It does not dismantle credentials or disable normal posting, and is not blocked by Manual-Only.

## Runtime: manual diagnostics + (designed) cost-aware scheduled operation

Two workflows exist for two different purposes:

### `SNS Engagement Autopilot` (`engagement.yml`)

Manual `workflow_dispatch` for setup, diagnostics, controlled dry-runs, and explicit operator runs. This is the only way to actually run engagement discovery/classification today.

### `SNS Engagement Scheduled` (`engagement-scheduled.yml`)

**Inert under Manual-Only (not a print-only stub):** the workflow is `workflow_dispatch`-only and calls `node src/engagement/scheduled.mjs`. Runtime policy requires `allowScheduledProviderPolling:false` (and `manualOnly:true`) so `runScheduledEngagement()` returns `state:'disabled'` with no provider reads, even if engagement policy were misconfigured. Re-enabling automatic polling is a separate, deliberately reviewed change to both `config/runtime-policy.json` and this workflow's YAML (add `schedule:`; see `docs/GO_LIVE_CHECKLIST.md`).

Designed to run every 30 minutes once re-enabled. A scheduled wake-up would **not** automatically mean a provider read — `src/engagement/scheduled.mjs` first applies a local, zero-network gate:

- the account must be enabled, not paused, and present in `liveAccounts`;
- if public auto-replies are enabled, the account must have one of its own published posts within the
  recent-post window (default: 360 minutes / 6 hours);
- if DM automation is explicitly enabled, polling may run independently of a fresh public post because
  a DM can arrive without a new post;
- malformed scheduled-polling settings fail closed and cause the account to be skipped;
- the existing `maxInboundFetchesPerDay` reservation still happens immediately before **every actual
  provider read**, so the scheduled layer cannot bypass the hard daily read budget.

This design matters especially on X because the current X API is pay-per-use. Public replies normally
cluster after the account posts, so the repository polls that high-value window instead of paying to
check a quiet account around the clock.

Optional per-account tuning is supported under `account.engagement.scheduledPolling`:

```json
{
  "scheduledPolling": {
    "enabled": true,
    "recentPostWindowMinutes": 360
  }
}
```

The runtime accepts only a whole-number recent-post window from 1 minute through 7 days. Invalid values
resolve to zero and block scheduled polling rather than widening it.

## Current automatic response policy

After successful activation, routine eligible public replies can be automatic. The important guardrails
remain in force:

- inbound only;
- public X replies are limited to threads rooted at our own published posts (`replyScope: own-posts`);
- no keyword-search cold replies;
- no proactive follow/unfollow;
- no unsolicited bulk DMs;
- one automated response per inbound interaction;
- deterministic human-like delay: public replies 8–35 minutes, DMs 12–50 minutes;
- confidence threshold before automatic sending;
- daily hard caps: 12 public replies by default;
- DM automation is currently off (`autoDmReply: false`, DM daily cap `0`);
- a hard daily ceiling on inbound provider reads (`maxInboundFetchesPerDay`, currently 48), enforced
  before each provider read;
- every automation limit fails closed: malformed caps/cooldowns/thresholds reduce automation rather
  than removing the limit;
- per-actor reply/DM cooldowns: 30 minutes by default;
- explicit opt-out persists per pseudonymous actor key;
- private DM bodies are never persisted in repository state/audit/Issues;
- private DM content is never used as a web-search query.

The global `approvalRequired: true` remains a conservative fallback for accounts that have **not** gone
through controlled activation. The selected account receives the narrow override only after the activation
workflow proves the current gates.

## Human-required boundary

Routine questions, thanks, reactions, light criticism, and straightforward support may be handled
automatically after activation. Human escalation is reserved for cases such as:

- legal claims or legal commitments;
- medical advice;
- payment/refund or other financial disputes;
- account-security matters;
- private personal data;
- harassment or threats;
- binding partnership/contract terms;
- rights/licensing commitments;
- explicit requests to speak to a human;
- low-confidence cases where an automatic reply should not be trusted.

Those cases create a `[engagement-human] <account> <event-key>` Issue with the `needs-human` label.

Public human-required replies are resolved by dispatching **SNS Engagement Resolve** (`engagement-resolve.yml`) with the account/event_key from the Issue title, `action: reply` (with a non-empty `text` — a live `action: reply` with empty text is rejected) or `action: ignore`, `dry_run: false`, and `confirm_live: true` — not through `chatops.yml`, which is deliberately provider-offline and never touches engagement state. Private human-required DMs deliberately remain manual-send exceptions so private message content and final reply text do not pass through a public GitHub Issue.

## At-most-once delivery guard

A live public reply or DM reply is reserved in `data/engagement-delivery-ledger.json` on `sns-ai-state`
**before** the provider send request is made. The reservation contains only a pseudonymous event key and
operational metadata; it does not contain inbound message text, private participant IDs, or generated
private reply text.

If a provider accepts a reply but the runner fails before ordinary bookkeeping is saved, the durable
reservation prevents a blind duplicate retry. Ambiguous outcomes surface as
`[engagement-delivery-unknown]` and automatic retry stays blocked until the case is intentionally handled.
SNS-AI deliberately prefers at-most-once delivery over duplicate risk.

## X

Implemented paths:

- mentions: `GET /2/users/{id}/mentions`;
- DM events: `GET /2/dm_events`;
- public reply: `POST /2/tweets` with `reply.in_reply_to_tweet_id`;
- one-to-one DM reply: `POST /2/dm_conversations/with/:participant_id/messages`.

For the current public-reply-only launch, OAuth2 must contain the scopes derived by the policy plus an
unattended refresh token. If DM automation is later enabled, `dm.read` and `dm.write` become required as
well.

X's current automation rules allow automated responses where the user has clearly indicated intent to
be contacted, require an easy opt-out, and limit automation to one response per user interaction. They
also state that AI-powered automated reply bots require prior written and explicit approval from X.
SNS-AI therefore treats that approval acknowledgement as a fail-closed go-live gate rather than trying
to infer it from code.

Official references:

- https://help.x.com/en/rules-and-policies/x-automation
- https://docs.x.com/x-api/getting-started/pricing
- https://docs.x.com/x-api/users/get-mentions
- https://docs.x.com/x-api/direct-messages/get-dm-events

## Instagram

Implemented paths include polling comments on recent SNS-AI-published media, public comment replies,
conversation/message reads, and DM replies. Meta's current platform setup uses Webhooks for real-time
comment/message notifications and to avoid unnecessary polling/rate-limit pressure. The polling runtime
in this repository does not remove the external Meta app/webhook setup requirements.

External setup includes:

- Instagram Professional account;
- Meta app/login setup;
- required business permissions for the enabled features;
- webhook endpoint/subscriptions where required by the current Meta setup/app review;
- access token stored in GitHub Secrets;
- controlled read/dry-run verification before activation.

Official Meta reference:

- https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api

## Privacy and state

Engagement state, engagement audit, encrypted X OAuth2 rotation state, delivery ledger, and durable usage
state live on the existing `sns-ai-state` branch rather than normal `main` history. Both manual ChatOps and
scheduled engagement use the same restore/persist helper.

Neither engagement state file stores inbound message text or raw provider user IDs. Private DM content is
not copied to GitHub Issues. Actor opt-out state is keyed by a one-way hash and explicit opt-outs are kept.

## Growth guardrails

Do not automate:

- proactive auto-follow or auto-unfollow;
- keyword-search cold replies to unrelated users;
- unsolicited bulk DMs;
- repetitive replies or mentions;
- duplicate/substantially similar posts across multiple operated accounts;
- engagement bait whose main purpose is manipulating platform metrics;
- pretending an AI-generated response is based on personal product use when no real use is known.
