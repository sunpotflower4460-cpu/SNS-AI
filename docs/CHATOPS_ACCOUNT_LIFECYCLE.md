# Account lifecycle control

Account lifecycle changes are made by manually dispatching the **SNS Account Control** GitHub Action (`.github/workflows/account-control.yml`) — not by editing an Issue. There is no Issue-title, label, comment, or schedule trigger for this workflow; it is `workflow_dispatch` only, and nothing in `.github/workflows/` listens for anything else.

## Running it

Dispatch **SNS Account Control** with two inputs:

- `account`: the account ID from `config/accounts.json`
- `target`: `approval`, `auto`, `pause`, or `disabled`

Only the repository owner, or a username listed in the `SNS_COMMAND_ADMINS` repository variable, may run it — an "Authorize command actor" step rejects anyone else before anything changes.

## `approval` and `auto` are blocked while Manual-Only is active

`config/runtime-policy.json`'s `manualOnly: true` makes `src/ops/manual-only.mjs`'s `assertLifecycleTransitionAllowed()` reject any transition to `approval` or `auto`, regardless of who runs the workflow or what evidence exists. This is checked first, before any other gate below. See `docs/MANUAL_ONLY_MODE.md`.

While Manual-Only is active, entering `approval` or `auto` mode for an account requires a code-reviewed edit to `config/accounts.json` directly (a normal PR, reviewed and merged like any other code change) — not this workflow. `pause` and `disabled` are unaffected and remain available as immediate one-way safety actions through the workflow at any time.

If the owner later decides to lift Manual-Only for a specific account's lifecycle transitions, that is itself a reviewed change to `config/runtime-policy.json` — not a routine operational action.

## Fail-closed gates (once Manual-Only allows the transition)

`approval` and `auto` never bypass provider setup. The workflow applies the change only to its temporary checkout, then runs repository safety checks and account-specific Live Preflight (`src/ops/live-preflight.mjs --account <id>`). The config is committed to `main` only if every check passes.

For X, entering either live publishing mode additionally requires the one-time automated-profile compliance completion to already be recorded in `config/engagement-policy.json` (via **SNS Compliance Attestation**). This does not automate the X-side setup or attest on the user's behalf — the human must actually complete it on X first.

`auto` has extra evidence gates (`src/ops/account-control.mjs`'s `autoPromotionEvidence`). It requires:

1. the account is already `enabled: true` in `mode: approval`;
2. at least one successful published post with a provider post ID exists in durable repository history;
3. Metrics Collector has stored at least one snapshot for one of those published post IDs;
4. Live Preflight still passes at the moment of promotion.

This makes the documented controlled-launch sequence executable as a guarded state transition rather than a manual config edit — once Manual-Only itself has been reviewed off for this purpose.

## Safety transitions

`pause` and `disabled` do not require provider credentials, a live preflight, metrics, or prior publish evidence. They are deliberately one-way safety actions and only need the normal repository/config guards. A paused account is also excluded by engagement gates.

## Human-only boundary

This workflow does not create platform apps, accept terms, perform OAuth consent, complete X/Meta reviews, create or rotate secrets, fund API billing, submit affiliate applications, or provide tax/payment/bank details. Those external actions remain human-controlled. Once completed, and once Manual-Only has been reviewed for this purpose, routine repository-side lifecycle transitions no longer require hand-editing `config/accounts.json`.
