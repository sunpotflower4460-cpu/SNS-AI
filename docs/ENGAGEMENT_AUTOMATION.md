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

## Current runtime

`SNS Engagement Autopilot` polls every ten minutes at `07,17,27,37,47,57` minutes past the hour.

The global policy is allowlisted to `music-tools-x`. It becomes operational only when the account itself is enabled and the required provider credentials/scopes exist.

Current automatic response policy:

- inbound only;
- no keyword-search cold replies;
- no proactive follow/unfollow;
- no unsolicited bulk DMs;
- one automated response per inbound interaction;
- deterministic human-like delay: replies roughly 6–24 minutes, DMs roughly 4–18 minutes;
- confidence threshold before automatic sending;
- daily hard caps for replies and DM replies;
- opt-out phrases are honored before generation;
- private DM bodies are never persisted in repository state/audit/Issues.

## Human-required boundary

Routine questions, thanks, reactions, light criticism, and straightforward support should normally be handled automatically.

Escalation is reserved for cases such as:

- legal claims or legal commitments;
- medical advice;
- payment/refund disputes;
- account-security matters;
- private personal data;
- harassment or threats;
- binding partnership/contract terms;
- rights/licensing commitments;
- explicit requests to speak to a human;
- low-confidence cases where a reply would otherwise be sent.

Human escalation creates a `[engagement-human]` Issue. Public interactions can include a short public excerpt. Private-message content is intentionally omitted because this repository is public.

A separate ChatGPT condition-watch can surface only new unresolved human-required Issues directly in chat. This keeps normal operation unattended while preserving a human decision path for exceptions.

## X

Implemented polling/sending paths:

- mentions: `GET /2/users/{id}/mentions`;
- DM events: `GET /2/dm_events`;
- public reply: `POST /2/tweets` with `reply.in_reply_to_tweet_id`;
- one-to-one DM reply: `POST /2/dm_conversations/with/:participant_id/messages`.

External setup still required before X engagement can become live:

- OAuth 2.0 user authorization;
- scopes required for the chosen read/write functions, including DM scopes when DM handling is enabled;
- refresh/access token bootstrap;
- authenticated account identity verification.

If those credentials are not ready, the Engagement Autopilot remains in a waiting state instead of sending anything.

Official references:

- https://docs.x.com/x-api/users/get-mentions
- https://docs.x.com/x-api/direct-messages/get-dm-events
- https://docs.x.com/x-api/direct-messages/manage/integrate
- https://help.x.com/en/rules-and-policies/x-automation

## Instagram

Implemented scheduled path:

- read comments on recent SNS-AI-published media;
- reply publicly through `/{comment_id}/replies`.

The provider adapter also supports private replies and DMs, but inbound Instagram messaging is designed around Meta Webhooks. A GitHub Actions repository is not itself a public webhook receiver, so full Instagram DM/comment-event ingestion still requires an externally reachable webhook endpoint or equivalent bridge.

External setup for Instagram engagement therefore includes:

- Professional account;
- `instagram_business_manage_comments` for comment management when using Instagram Login;
- `instagram_business_manage_messages` for messaging when enabled;
- Meta app/login setup;
- Webhook endpoint/subscriptions for event-driven comment/message ingestion if full DM handling is desired.

Official Meta API collection/reference:

- https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api

## Privacy and state

`data/engagement-state.json` stores only hashed interaction keys and operational status. `data/engagement-audit.jsonl` stores metadata such as account, platform, kind, category, and result.

Neither file stores inbound message text or provider user IDs. Private DM content is not copied to GitHub Issues.

## Growth guardrails

Do not automate:

- proactive auto-follow or auto-unfollow;
- keyword-search cold replies to unrelated users;
- unsolicited bulk DMs;
- repetitive replies or mentions;
- duplicate/substantially similar posts across multiple operated accounts;
- engagement bait whose main purpose is manipulating platform metrics;
- pretending an AI-generated response is based on personal product use when no real use is known.
