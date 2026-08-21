# SNS-AI ChatOps

SNS-AI is operated entirely through manually dispatched GitHub Actions (`workflow_dispatch`). There is no Issue-title, label, comment, or schedule trigger anywhere in `.github/workflows/` — GitHub has nothing listening for any of those events. Every command below is run from the Actions tab (or `gh workflow run`), not by opening or editing an Issue.

See `docs/MANUAL_ONLY_MODE.md` for why, and `docs/MANUAL_SETUP_CHECKLIST.md` for the full first-publish walkthrough. This page is a quick reference for the individual workflows.

Only the repository owner, or a username listed in the `SNS_COMMAND_ADMINS` repository variable, may run any of these workflows — each one has an "Authorize command actor" step that rejects anyone else before it does anything else.

## SNS ChatOps (`chatops.yml`)

Keyless and provider-offline: it never receives `OPENAI_API_KEY`, `SOCIAL_CREDENTIALS_JSON`, or any other provider secret, and never publishes, replies, DMs, or polls a provider.

Inputs:

- `command`: `preflight` or `dry-run`
- `account`: account ID from `config/accounts.json`

`preflight` runs `validate` / `check` / `secret-scan` / `manual-only-audit` / `doctor` and reports the result in the run summary (secrets redacted). `dry-run` runs `src/orchestrate.mjs --account <id> --force --dry-run` and reports what it would have generated.

## SNS Publish social post (`publish.yml`)

The only workflow that can place a real post. Inputs: `account`, `text`, `media_url`, `media_type`, `dry_run` (default `true`), `confirm_live` (default `false`). A real post requires **both** `dry_run: false` **and** `confirm_live: true` — either alone is rejected.

Approval-issue drafts (created by `autopilot.yml`) carry the exact inputs to use in their body, at the top, ahead of the JSON payload.

## SNS Engagement Autopilot (`engagement.yml`)

Discovers replies to the account's own posts, classifies them, and either sends automatically (only if the account is in `config/engagement-policy.json`'s `liveAccounts` and confidence clears the configured threshold) or opens a `[engagement-human] <account> <event-key>` escalation Issue. Inputs: `account` (optional, defaults to all allowlisted accounts) and `dry_run` (default `true`).

## SNS Engagement Resolve (`engagement-resolve.yml`)

The only way to act on an `[engagement-human]` escalation Issue — the Issue body itself names this workflow and the exact inputs to use. Inputs: `account`, `event_key` (the hex key from the Issue title), `action` (`reply` or `ignore`), `text` (required for a live `reply`), `dry_run` (default `true`), `confirm_live` (default `false`). Same two-factor live gate as publishing. Private DM escalations explicitly refuse this path — those are resolved by hand in the SNS app, never through this repository.

## SNS Account Control (`account-control.yml`)

Inputs: `account`, `target` (`approval` / `auto` / `pause` / `disabled`). While Manual-Only is active, transitions to `approval` or `auto` are rejected by the runtime policy regardless of who runs the workflow — those modes can only be entered through a code-reviewed edit to `config/accounts.json`. `pause` and `disabled` remain available as immediate one-way safety actions.

## SNS Engagement Control (`engagement-control.yml`)

Inputs: `account`, `action` (`activate` or `deactivate`). `activate` is rejected the same way while Manual-Only is active; `deactivate` always works.

## SNS Compliance Attestation (`compliance-attestation.yml`)

Records an explicit owner/admin attestation (X automated-profile setup, or AI-reply written approval) in `config/engagement-policy.json`. It never performs the underlying provider action itself — the human must actually complete that setup on the platform first.

## SNS Human Feedback (`feedback.yml`)

Records human feedback for the learning loop when manually dispatched.

## SNS Hub Reconcile / SNS Publish Readback Reconcile (`hub-reconcile.yml`, `publish-reconcile.yml`)

Read provider/Hub state and reconcile it back into repository history. Both are manual-only and write authoritative state to `main`, so both require the same actor authorization as every other write-capable workflow above.
