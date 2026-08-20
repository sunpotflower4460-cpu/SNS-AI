# Chat-first account lifecycle

Account state changes are controlled through owner/admin GitHub Issues so this ChatGPT conversation can act as the operations console without routine JSON edits.

The repository is currently locked by `config/operation-mode.json` to **manual-only**.

## Commands

Use an exact Issue title:

- `[account-approval] ACCOUNT_ID` — enable the account in approval mode. Allowed after the normal safety/provider gates pass.
- `[account-pause] ACCOUNT_ID` — pause the account.
- `[account-disable] ACCOUNT_ID` — disable the account and force pause mode.
- `[account-auto] ACCOUNT_ID` — **currently blocked by the manual-only runtime lock**.

Only the repository owner or users listed in `SNS_COMMAND_ADMINS` may run these commands.

## Manual-only lock

`config/operation-mode.json` currently contains:

```json
{
  "mode": "manual-only",
  "allowAutoPromotion": false
}
```

`src/ops/account-control.mjs` loads this state before a persisted CLI/ChatOps lifecycle change. Therefore `[account-auto]` fails closed even if all historical auto-promotion evidence is otherwise present.

The old evidence checks remain in source for a future reviewed transition out of manual-only mode; they are not sufficient by themselves to bypass the current lock.

## Approval-mode gates

`account-approval` never bypasses provider setup. The workflow applies the change in its temporary checkout, runs repository checks and account-specific Live Preflight, and persists config only if the required gates pass.

For X, entering approval publishing mode additionally requires the required automated-profile compliance record where applicable. Repository code does not perform or invent the X-side profile setup.

## Safety transitions

`account-pause` and `account-disable` are deliberately easier fail-safe transitions. They do not require live provider credentials, metrics, or prior publish evidence.

## Future auto transition

If unattended posting is intentionally introduced later, do not hand-edit only `config/accounts.json`. A reviewed change must first change the operation lock, then preserve the controlled evidence gates: prior approval-mode publish proof, metrics proof, no unresolved health incident, and current preflight/compliance success.

## Human-only boundary

These commands do not create platform apps, accept terms, perform OAuth consent, complete X/Meta reviews, create or rotate secrets, fund API billing, submit affiliate applications, or provide tax/payment/bank details. Those external actions remain human-controlled.
