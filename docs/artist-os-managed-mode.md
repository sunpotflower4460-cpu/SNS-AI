# Artist OS managed mode

In **managed mode**, Artist OS has designated My-SNS as the canonical executor of inbound replies
(Instagram comment replies and DMs). SNS-AI then only produces recommendations, drafts and strategy;
it never executes an external inbound reply.

## Selecting the mode

- Environment variable `ARTIST_OS_MODE` (read at call time, not import time):
  - unset, empty or `standalone`: standalone (default, behavior unchanged).
  - `artist_os_managed`: managed.
  - any other non-empty value: treated as managed with `modeInvalid: true` (fail closed).
- Optional `artistOsMode` in `config/runtime-policy.json` (`"standalone"` or `"artist_os_managed"`;
  other values fail validation). If either source says managed, the result is managed (most restrictive wins).

## What is blocked

Live (non dry-run) calls only; dry-run and draft generation keep working as the recommendation path.

- `sendResponseWithDeliveryGuard` (src/engagement/run.mjs) refuses before any delivery-ledger claim
  is created. The event is reported as `managed-blocked` and is not marked sent/unknown/handled; no
  ambiguity issue is opened and the run does not crash.
- `sendXReply`, `sendXDirectMessage`, `sendInstagramCommentReply`, `sendInstagramDm` (and
  `sendInstagramPrivateReply`) throw `MANAGED_MODE_INBOUND_REPLY_BLOCKED` before any network call,
  even when called directly.

## Reading capabilities

`npm run service:capabilities` prints a JSON snapshot (Artist OS service-health contract v1) without
HTTP: `contractVersion`, `service`, `version`, `status`, `degradedReason?`, `capabilities`, `checkedAt`,
`runtimeMode`, `modeInvalid`, `ownership.{inboundReplyExecution,recommendation}`.

- Managed: `inboundReplyExecution` is `false`; no `reply.*.execute` capability is listed.
- Invalid mode value: `status: "degraded"` with a reason.
- Standalone: `inboundReplyExecution` is `true` only when the engagement policy has `enabled: true`
  and a non-empty `liveAccounts` (a live send is reachable); otherwise `false`.
- No secrets or credentials are included.

## Standalone

Unchanged. Existing Manual-Only and engagement policy gates still apply.
