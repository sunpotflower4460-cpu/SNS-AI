# Engagement automation

Verified baseline: 2026-08-18.

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

Engagement has two separate account gates in `config/engagement-policy.json`:

- `allowedAccounts`: accounts whose inbound engagement may be inspected/dry-run and whose engagement credentials are checked by Live Preflight.
- `liveAccounts`: accounts that are explicitly permitted to send live automated inbound replies/DM replies.

An account must also be `enabled: true` and not in `pause` mode.

The production policy intentionally starts with `music-tools-x` in `allowedAccounts` but **not** in `liveAccounts`. This lets setup and dry-run verification happen without accidentally sending a reply.

Recommended one-time launch sequence:

1. Complete provider app/OAuth/secret setup.
2. Run Live Preflight for the account. For X, this verifies the engagement OAuth2 scopes and refresh-token readiness even before engagement is live.
3. Run `engagement-dry-run` / the Engagement workflow with dry-run enabled and inspect the privacy-safe result.
4. Perform the controlled provider rehearsal required by the main go-live checklist.
5. Add the account to `liveAccounts` only after those checks pass.
6. After activation, routine inbound handling is automatic; human involvement is exception-only.

Removing an account from `liveAccounts` is the engagement kill switch. Removing it does not disable normal account research/configuration.

## Current runtime

`SNS Engagement Autopilot` polls every ten minutes at `07,17,27,37,47,57` minutes past the hour.

Current automatic response policy:

- inbound only;
- no keyword-search cold replies;
- no proactive follow/unfollow;
- no unsolicited bulk DMs;
- one automated response per inbound interaction;
- deterministic human-like delay: public replies 8–35 minutes, DMs 12–50 minutes;
- confidence threshold before automatic sending;
- daily hard caps: 12 public replies and 8 DM replies by default;
- per-actor reply/DM cooldowns: 30 minutes by default;
- opt-out persists per pseudonymous actor key, not just for one interaction, and explicit opt-outs are not evicted by routine actor-cache compaction;
- high-risk/human-request categories are surfaced before normal delay/cooldown/daily-cap suppression, but opted-out users still receive no automatic response;
- private DM bodies are never persisted in repository state/audit/Issues;
- private DM content is never used as a web-search query.

If a configured engagement channel becomes unavailable, or its OAuth/permission state is no longer valid, the scheduled run becomes degraded/non-zero instead of silently staying green.

## At-most-once delivery guard

A live public reply or DM reply is reserved in `data/engagement-delivery-ledger.json` on `sns-ai-state` **before** the provider send request is made. The reservation contains only the pseudonymous event key and operational metadata; it does not contain inbound message text, private participant IDs, or generated private reply text.

This closes the normal duplicate-send crash window. If the provider accepts a reply and the runner fails before ordinary engagement bookkeeping is saved, the durable reservation prevents the next run from blindly sending the same interaction again.

SNS-AI deliberately prefers **at-most-once automatic delivery** over automatic retry when provider acceptance is ambiguous. An ambiguous network/provider outcome creates or reuses a `[engagement-delivery-unknown]` Issue with the `needs-human` label and automatic retry remains blocked.

When that Issue appears:

1. Check the corresponding interaction directly on X/Instagram. Public cases may include the public target ID. Private DM body/user/response details are intentionally omitted from GitHub.
2. If a reply already exists, leave it as-is. If no reply exists, decide whether to send/skip it manually rather than asking SNS-AI to guess whether the previous request succeeded.
3. Close the `[engagement-delivery-unknown]` Issue after the interaction has been intentionally handled or skipped.
4. On the next run, SNS-AI marks that delivery as handled and does not auto-retry it.

An explicit provider rejection that proves the send was not accepted (for example a definitive request-level 4xx) is recorded as failed rather than unknown and may be attempted again later. Ambiguous network/5xx-style outcomes are never automatically retried.

## Human-required boundary

Routine questions, thanks, reactions, light criticism, and straightforward support should normally be handled automatically.

Escalation is reserved for cases such as:

- legal claims or legal commitments;
- medical advice;
- payment/refund or other financial disputes;
- account-security matters;
- private personal data;
- harassment or threats;
- binding partnership/contract terms;
- rights/licensing commitments;
- explicit requests to speak to a human;
- low-confidence cases where a reply would otherwise be sent.

Human escalation creates a `[engagement-human]` Issue. Public interactions can include a short public excerpt. For private DMs, provider/user/message details and model free-text reasoning are intentionally omitted because this repository is public.

Public human-required replies can be resolved through the ChatOps bridge. Private human-required DMs deliberately remain manual-send exceptions so private content/final reply text do not pass through public GitHub Issues.

A separate ChatGPT condition-watch can surface only new unresolved human-required Issues directly in chat. This keeps normal operation unattended while preserving a human decision path for exceptions.

## X

Implemented polling/sending paths:

- mentions: `GET /2/users/{id}/mentions`;
- DM events: `GET /2/dm_events`;
- public reply: `POST /2/tweets` with `reply.in_reply_to_tweet_id`;
- one-to-one DM reply: `POST /2/dm_conversations/with/:participant_id/messages`.

For the current policy with both public replies and DM replies enabled, unattended X engagement requires OAuth2 scopes:

- `tweet.read`
- `tweet.write`
- `users.read`
- `dm.read`
- `dm.write`
- `offline.access`

A refresh token is required for long-running unattended operation. Live Preflight verifies these requirements before `liveAccounts` activation. The authenticated OAuth1/OAuth2 identities must also resolve to the same account when both are used.

If credentials/scopes are not ready, Engagement Autopilot reports `waiting_for_engagement_credentials`/degraded instead of sending anything.

Official references:

- https://docs.x.com/x-api/users/get-mentions
- https://docs.x.com/x-api/direct-messages/get-dm-events
- https://docs.x.com/x-api/direct-messages/manage/integrate
- https://help.x.com/en/rules-and-policies/x-automation

## Instagram

Implemented scheduled paths:

- poll comments on recent SNS-AI-published media;
- reply publicly through `/{comment_id}/replies`;
- poll Instagram Conversations and recent conversation messages;
- send inbound DM replies through the official messages route.

The runtime itself uses scheduled polling rather than consuming webhook events. However, Meta's current Conversations/messaging documentation assumes the app has completed the required platform setup, including a webhooks server/subscriptions in the messaging setup flow. Treat webhook setup as an external Meta-app prerequisite when required by the chosen login/app-review configuration; do not infer from the polling implementation that Meta setup can skip it.

External setup for Instagram engagement includes:

- Professional account;
- Meta app/login setup;
- `instagram_business_basic` plus the comment/messaging permissions required by the enabled functions;
- webhook endpoint/subscriptions when required by the current Meta messaging setup/app review;
- access token stored in GitHub Secrets;
- controlled read/dry-run verification before adding an Instagram account to `liveAccounts`.

Official Meta API collection/reference:

- https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api

## Privacy and state

`data/engagement-state.json` stores hashed interaction/actor keys plus operational status. It also keeps a bounded privacy-safe sent log so daily caps remain enforceable even after old event entries are compacted.

`data/engagement-audit.jsonl` stores metadata such as account, platform, interaction kind, category, and result. X OAuth2 rotation state is encrypted before it is written to `data/x-oauth2-state.json`. `data/engagement-delivery-ledger.json` stores only bounded privacy-safe delivery reservations/results; unresolved delivery ambiguity records are retained until intentionally handled.

In GitHub Actions, these four engagement runtime files are restored from and persisted to the existing `sns-ai-state` durable branch rather than `main`. Both the scheduled Engagement workflow and ChatOps engagement commands use the same restore/persist helper, so ChatGPT-triggered engagement does not fork a second state history. Runtime churn therefore does not create normal code-history commits or trigger the repository's `push: main` CI on every engagement state update. Live Preflight verifies the durable-state branch/write path before live activation.

Neither engagement state file stores inbound message text or raw provider user IDs. Private DM content is not copied to GitHub Issues. Actor opt-out state is keyed by a one-way hash rather than a provider ID/username, and explicit opt-outs are retained rather than silently aged out with normal cooldown cache entries.

## Growth guardrails

Do not automate:

- proactive auto-follow or auto-unfollow;
- keyword-search cold replies to unrelated users;
- unsolicited bulk DMs;
- repetitive replies or mentions;
- duplicate/substantially similar posts across multiple operated accounts;
- engagement bait whose main purpose is manipulating platform metrics;
- pretending an AI-generated response is based on personal product use when no real use is known.
