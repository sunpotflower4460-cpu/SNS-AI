# Chat-first account lifecycle

Account state changes are controlled through owner/admin GitHub Issues so this ChatGPT conversation can act as the operations console without requiring routine JSON edits.

## Commands

Use an exact Issue title:

- `[account-approval] ACCOUNT_ID` — enable the account and enter approval mode.
- `[account-auto] ACCOUNT_ID` — promote an already-controlled approval account to unattended posting.
- `[account-pause] ACCOUNT_ID` — stop publishing immediately while keeping the account configured/enabled.
- `[account-disable] ACCOUNT_ID` — disable the account and force pause mode.

Only the repository owner or users listed in `SNS_COMMAND_ADMINS` may run them.

## Fail-closed gates

`account-approval` and `account-auto` never bypass provider setup. The workflow first applies the change only to its temporary checkout, then runs repository safety checks and account-specific Live Preflight. The config is committed to `main` only if those checks pass.

For X, entering either live publishing mode additionally requires the one-time automated-profile compliance completion to already be recorded in `config/engagement-policy.json`. This does not automate the X-side setup or attest on the user's behalf.

`account-auto` has extra evidence gates. It requires:

1. the account is already `enabled: true` in `mode: approval`;
2. at least one successful published post with a provider post ID exists in durable repository history;
3. Metrics Collector has stored at least one snapshot for one of those published post IDs;
4. there is no open `[health]` incident;
5. Live Preflight still passes at the moment of promotion.

This makes the documented controlled-launch sequence executable as a guarded state transition rather than a manual config edit.

## Safety transitions

`account-pause` and `account-disable` do not require provider credentials, a live preflight, metrics, or prior publish evidence. They are deliberately one-way safety actions and only need the normal repository/config guards. A paused account is also excluded by scheduled engagement gates.

## Human-only boundary

These commands do not create platform apps, accept terms, perform OAuth consent, complete X/Meta reviews, create or rotate secrets, fund API billing, submit affiliate applications, or provide tax/payment/bank details. Those external actions remain human-controlled. Once completed, routine repository-side lifecycle transitions no longer require hand-editing `config/accounts.json`.
