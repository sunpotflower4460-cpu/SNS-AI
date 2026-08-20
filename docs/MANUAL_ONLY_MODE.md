# Manual-only operating mode

SNS-AI is currently intentionally locked to a **manual-only** operating posture.

The automation implementation is preserved for future use, but the live repository is arranged so that no scheduled SNS publishing, provider polling, unattended engagement reply/DM handling, metrics collection, learning, trend research, health maintenance, policy watch, Hub reconciliation, or ambiguous-publish read-back starts by itself.

## Source-of-truth lock

`config/operation-mode.json` is the explicit operational lock. The current required values are:

```json
{
  "schemaVersion": 1,
  "mode": "manual-only",
  "allowAutoPromotion": false,
  "allowUnattendedEngagement": false
}
```

This is not documentation-only. `src/ops/operation-mode.mjs` is wired into persisted account lifecycle and engagement activation commands:

- promotion to account `mode: auto` is rejected while the lock is active;
- unattended engagement activation is rejected while the lock is active;
- approval, pause and disable lifecycle changes remain available;
- manual dry-runs, explicit approval/manual publishing, manual analytics/research, and human-resolved engagement remain available.

Changing only an account JSON field or only a workflow is therefore insufficient to silently restore unattended operation.

## Current invariants

- Every account in `config/accounts.json` remains `enabled: false` until an operator deliberately starts a controlled approval-mode launch.
- No configured account may remain in `mode: auto` while manual-only is locked.
- `config/engagement-policy.json` keeps `liveAccounts: []`.
- `approvalRequired` remains `true` and automatic DM replies remain disabled.
- SNS/provider operational workflows use `workflow_dispatch` or an explicitly authorized owner/admin Issue command rather than `schedule` / `cron` triggers.
- CI may run on push / pull request and Failure Watch may run after workflow completion. Those two GitHub-only safety workflows have no SNS/OpenAI/provider secrets and cannot publish or poll social providers.
- A new workflow file is not silently accepted: the manual-only hardening test requires every workflow and its allowed trigger set to be explicitly classified.

These invariants are covered by both `test/manual-only-posture.test.mjs` and `test/manual-only-hardening.test.mjs`. CI fails if an operational schedule is restored, an unexpected workflow trigger appears, a new unreviewed workflow is added, an account becomes auto/enabled in the locked repository state, unattended engagement becomes live, or GitHub-only automatic safety workflows gain provider secrets.

## What can still be run manually

An authorized repository owner/admin may explicitly start a workflow or Issue command when desired, including:

- Live Preflight / Doctor and dry runs;
- manual candidate generation;
- controlled `approval` lifecycle enablement;
- explicit manual publishing / approval flow;
- manual metrics collection and learning;
- manual trend / policy research;
- manual engagement dry-run and human-resolved handling;
- manual provider publish read-back reconciliation;
- account pause / disable operations.

Existing safety, budget, compliance, duplicate-send and durable-state guards remain in place for manually invoked operations.

The publish read-back reconciler is deliberately read-only against providers: it checks only stale ambiguous durable claims, requires exactly one exact text/caption match inside a narrow time window, and never calls a provider create-post endpoint. In manual-only mode even that read-back runs only when explicitly dispatched.

## Commands deliberately blocked while locked

- `[account-auto] ACCOUNT_ID` / direct `--target auto`
- unattended engagement activation (`[engagement-activate]` / direct `--activate`)

These are blocked by runtime code, not merely by operator convention.

## Before any future automatic operation

Do not restore schedules merely because the automation code is present. A future transition to unattended operation must be an explicit, reviewed change that updates the operation lock and re-runs the controlled launch sequence after the required external facts are genuinely complete:

1. OpenAI API key, billing/credits, and configured model access.
2. X / Meta developer app, credentials, required scopes, provider billing and review/permission requirements.
3. For X media or engagement, the required OAuth2 refresh setup and `X_OAUTH2_STATE_KEY`.
4. X automated-account profile transparency acknowledgement, and written approval if automated AI public replies require it.
5. Live Preflight and dry-run success.
6. One controlled approval-mode provider post with a stored provider post ID.
7. A successful metrics snapshot for that controlled post.
8. No unresolved health incident relevant to the launch.
9. Explicit operator decision and code review to change `config/operation-mode.json`.
10. Restore only the specific schedules actually wanted, with CI updated intentionally rather than bypassed.

External platform registration, consent, terms acceptance, billing, secrets, compliance attestations, payout/tax information and first controlled live verification remain human-controlled boundaries. Repository code must not invent or bypass those facts.
