# SNS-AI ChatOps

SNS-AI can be operated from a connected ChatGPT/GitHub client without opening the GitHub Actions UI for routine control tasks.

## Command Issues

Only the repository owner or a username listed in the `SNS_COMMAND_ADMINS` repository variable may execute these commands.

Create an Issue with one of these exact title forms:

- `[preflight] <account-id>`
- `[dry-run] <account-id>`
- `[engagement-dry-run] <account-id>`
- `[engagement-run] <account-id>`

The Issue body may be empty or valid JSON. An explicit body can be:

```json
{
  "account": "music-tools-x"
}
```

`SNS ChatOps` validates configuration before executing a command, persists only repository runtime state, comments success/failure, and closes successful command Issues.

## Intended operating model

The normal lifecycle is:

1. Human performs provider-only setup: developer apps, OAuth consent, billing, secrets, and platform permission approval.
2. ChatGPT changes the selected account to `enabled: true` while keeping initial publication in a controlled mode.
3. ChatGPT opens `[preflight]` and `[dry-run]` command Issues and reads the resulting state/log outcome.
4. One controlled real post proves provider publication and metrics.
5. Publication moves to `auto`.
6. Routine posting, research, metrics, learning, experiments, health checks, and eligible inbound engagement continue without per-post approval.
7. Human approval is reserved for explicit exceptions rather than normal operation.

## Engagement human escalation

Routine inbound interactions are handled by the Engagement Autopilot when policy confidence is high enough. A human Issue is created only when an owner-level or sensitive decision is necessary.

Human escalation Issues use:

`[engagement-human] <account-id> <privacy-safe-event-key>`

Public interactions may include a short public excerpt. Private DM text is never written to the public repository, Issue body, audit log, or state file.

A ChatGPT condition-watch can monitor these Issues and ask the operator in chat only when a new unresolved human decision exists. Event-triggered webhook delivery directly into ChatGPT is not assumed by SNS-AI; the chat monitor is intentionally separate from repository secrets.
