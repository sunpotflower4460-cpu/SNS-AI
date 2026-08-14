# Engagement automation

Verified baseline: 2026-08-14. This subsystem is intentionally dormant until external API permissions and account identity are configured and live preflight succeeds.

## Goal

Automate useful inbound community handling without turning the account into a spam bot. The preferred order is:

1. Detect an inbound interaction.
2. Classify intent and safety.
3. Draft a concise account-voice response.
4. Require approval initially.
5. Respond only within the originating interaction/conversation.
6. Store outcome and feedback for later quality optimization.

## X

Current X automation rules permit automated replies when the recipient has clearly indicated intent to be contacted, for example by replying to the account, and permit automated DM responses when the user has requested/initiated DM contact. X prohibits unsolicited automated replies/mentions at scale, keyword-search-only cold replies, unsolicited bulk automated DMs, duplicate/substantially similar automated posts across accounts, and automated proactive follow/unfollow.

Technical capability:

- Reply to a post: `POST /2/tweets` with `reply.in_reply_to_tweet_id`.
- Read DMs: X DM lookup endpoints.
- Send a one-to-one DM: `POST /2/dm_conversations/with/:participant_id/messages`.
- OAuth 2.0 DM scopes include `dm.write`, `dm.read`, `tweet.read`, and `users.read`.

Official references:

- https://help.x.com/en/rules-and-policies/x-automation
- https://help.x.com/en/rules-and-policies/x-rules-and-best-practices
- https://docs.x.com/x-api/posts/create-or-edit-post
- https://docs.x.com/x-api/direct-messages/manage/quickstart

### X manual gate

Before enabling reply/DM automation:

1. Extend the X app/user authorization to the scopes required by the chosen functions.
2. Complete OAuth 2.0 PKCE/user authorization and store refresh/access credentials in GitHub Secrets only.
3. Verify the authenticated X user ID and account identity.
4. Run an inbound-read-only preflight first.
5. Start in approval mode; do not begin with fully automatic reply/DM sending.
6. Provide and honor an opt-out path for automated responses.

## Instagram

Instagram professional accounts can expose comments and messaging through the Instagram APIs. Meta recommends Webhooks for comment ingestion to reduce polling/rate-limit pressure. Public comment replies can be posted to the comment's replies endpoint. A professional account may also send a private reply to a person who comments; current documentation allows the private reply within 7 days of the comment (Instagram Live has a narrower live-broadcast condition). Messaging uses the standard messaging window; human-agent extensions are not for automated messages.

Official Meta API collection/reference:

- https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api

### Instagram manual gate

1. Use an Instagram professional account.
2. Configure the Meta app/login flow and required Instagram business permissions.
3. Configure and verify the Webhook endpoint/subscriptions for comments/messages.
4. Store access tokens in GitHub Secrets only.
5. Run read-only comment/message ingestion first.
6. Start response sending in approval mode.

## Safe growth automation

Good candidates for automation:

- choose posting times from measured performance;
- research new plugin/tool topics and avoid saturated/repeated themes;
- generate multiple candidate posts and select by predicted usefulness;
- respond to genuine inbound questions quickly;
- detect FAQ patterns and turn them into future organic posts;
- identify posts receiving unusually strong positive conversation and create follow-up content without duplicating text;
- detect unanswered comments/DMs and queue them for approval;
- measure whether affiliate posts damage later organic engagement;
- learn which content categories attract followers without sacrificing trust;
- surface partnership/review requests for human review;
- maintain source freshness for releases, sales and compatibility claims.

Do not automate for growth:

- proactive auto-follow or auto-unfollow;
- keyword-search cold replies to unrelated users;
- unsolicited bulk DMs;
- repetitive replies or mentions;
- duplicate/substantially similar posts across multiple operated accounts;
- engagement bait whose main purpose is manipulating platform metrics;
- pretending an AI-generated response is based on personal product use when no real use is known.

## Current repository state

`config/engagement-policy.json` is fail-closed (`enabled: false`, auto reply/DM false). `src/engagement/policy.mjs` rejects unsolicited activity, keyword-only cold replies, opted-out users, repeated automated replies to one interaction, and sensitive/human-requested cases.

The next implementation after credentials exist should be read-only inbox/comment ingestion + approval queues, not immediate full-auto sending.
