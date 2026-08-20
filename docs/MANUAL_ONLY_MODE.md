# Manual-only operating mode

SNS-AI is currently intentionally locked to a **manual-only** operating posture.

The automation code is kept available for future use, but repository configuration and operational workflow triggers are arranged so that no scheduled SNS publishing, provider polling, engagement reply/DM handling, metrics collection, learning, trend research, health maintenance, policy watch, Hub reconciliation, or ambiguous-publish read-back starts by itself.

## Current invariants

- Every account in `config/accounts.json` remains `enabled: false`.
- `config/engagement-policy.json` keeps `liveAccounts: []`.
- `approvalRequired` remains `true` and automatic DM replies remain disabled.
- Operational workflows use `workflow_dispatch` rather than `schedule` / `cron` triggers.
- CI and pull-request validation may still run automatically because they do not publish to SNS accounts or poll provider content.

These invariants are covered by `test/manual-only-posture.test.mjs`; accidentally adding an operational cron or enabling a configured account makes CI fail.

## What can still be run manually

An authorized repository owner/admin may explicitly start a workflow or issue command when desired, including:

- Live Preflight / Doctor and dry runs
- manual candidate generation
- explicit manual publishing / approval flow
- manual metrics collection and learning
- manual trend / policy research
- manual engagement dry-run / handling
- manual provider publish read-back reconciliation
- account pause / disable operations

Existing safety, budget, compliance, duplicate-send and durable-state guards remain in place for manually invoked operations.

The publish read-back reconciler is deliberately read-only against providers: it checks only stale ambiguous durable claims, requires exactly one exact text/caption match inside a narrow time window, and never calls a provider create-post endpoint. In manual-only mode even that read-back runs only when explicitly dispatched.

## Before any future automatic operation

Do not restore schedules merely because the code is present. A future transition to unattended operation should be explicit and should re-run the controlled launch sequence after the required external facts are genuinely complete:

1. OpenAI API key, billing/credits, and configured model access.
2. X / Meta developer app, credentials, required scopes, provider billing and review/permission requirements.
3. For X media or engagement, the required OAuth2 refresh setup and `X_OAUTH2_STATE_KEY`.
4. X automated-account profile transparency acknowledgement, and written approval if automated AI public replies require it.
5. Live Preflight and dry-run success.
6. One controlled approval-mode provider post with a stored provider post ID.
7. A successful metrics snapshot for that controlled post.
8. No unresolved health incident relevant to the launch.
9. Explicit operator decision to enable the target account and restore only the schedules actually wanted.

External platform registration, consent, terms acceptance, billing, secrets, compliance attestations, payout/tax information and first controlled live verification remain human-controlled boundaries. Repository code must not invent or bypass those facts.
