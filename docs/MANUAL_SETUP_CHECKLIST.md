# Manual-Only setup checklist

The repository is deliberately **not live** by default. `config/runtime-policy.json` is the single reviewed safety authority. Unattended account activation, automatic engagement, scheduled provider polling, and provider mutation without an explicit manual invocation are blocked. Never paste a secret into an Issue, log, JSON file, or commit.

## 1. X provider setup — human only

- [ ] Sign in to the X Developer Portal with the account owner.
- [ ] Create/select the project and app and accept the current provider terms.
- [ ] Configure the exact callback/redirect URL.
- [ ] For text publishing, configure the minimum required read/write permission and regenerate credentials after permission changes when X requires it.
- [ ] If replies, DMs, inbound reads, or OAuth2 media paths will be used later, configure OAuth 2.0 authorization-code flow/offline access and only the scopes required by those features.
- [ ] Complete provider OAuth consent yourself and obtain the resulting credentials/tokens.

Repository code must not perform these portal, consent, app-review, or token-issuance actions.

## 2. Instagram / Meta provider setup — human only

- [ ] Sign in to Meta for Developers.
- [ ] Create/select the Meta app.
- [ ] Connect the Instagram Professional Account to the intended Facebook Page.
- [ ] Add/configure the current Instagram Graph API product.
- [ ] Configure the exact callback/redirect URL.
- [ ] Request/approve only the permissions required for the intended manual publishing test.
- [ ] Complete provider OAuth consent yourself and obtain the required token/account IDs.

## 3. Prepare credentials locally

- [ ] Copy `.env.example` to `.env` only if local diagnostics need environment variables; `.env` must remain ignored.
- [ ] Build `SOCIAL_CREDENTIALS_JSON` as one JSON object keyed by each account's `credentialKey` from `config/accounts.json`.
- [ ] X text publishing credentials and any X OAuth2 credentials must match the flows actually enabled in the X portal.
- [ ] Instagram credentials must include the access token and real Instagram user/account ID expected by the configured provider path.
- [ ] Obtain `OPENAI_API_KEY` only if AI generation is desired.

## 4. Register GitHub Actions secrets/variables — human only

In **Repository → Settings → Secrets and variables → Actions**, register only values actually used:

- [ ] `SOCIAL_CREDENTIALS_JSON`
- [ ] `OPENAI_API_KEY` when AI generation is desired
- [ ] `X_OAUTH2_STATE_KEY` when X OAuth2 state encryption is used
- [ ] `MEDIA_SERVICE_TOKEN` only when the external media service is used
- [ ] `CONVENIENCE_HUB_GITHUB_TOKEN` and the matching Hub variables only when SNS-HUB integration is used
- [ ] Any other provider credential required by the currently selected account/provider configuration

**Do not create `SNS_MANUAL_INVOCATION` as a GitHub Secret.** It is a non-secret execution-boundary marker supplied only inside explicitly manual workflows/approved test harnesses.

## 5. Enter real public account identifiers

- [ ] Replace example account metadata with the correct platform, `credentialKey`, display name, X user ID or Instagram user ID, callback metadata, media rules, and limits.
- [ ] Until controlled manual testing begins, keep every account `enabled:false` and do not use `mode:auto`.
- [ ] Keep engagement `enabled:false`, `autoReply:false`, `autoDmReply:false`, `approvalRequired:true`, and `liveAccounts: []`.
- [ ] Keep `config/runtime-policy.json` in Manual-Only. Completing provider setup must **not** unlock automatic operation.

## 5b. Multi-brand / Media Hunter / $8 budget — still no activation

- [ ] Plugin Radar X remains `music-tools-x` with `credentialKey: music-tools-x`. Do not rename the credential key.
- [ ] Instagram / Artist / Brand C accounts are disabled scaffolds. Do not invent Brand C's personality.
- [ ] Copy `config/artist.example.json` to a gitignored `config/artist.json` only when real confirmed_personal facts exist. Never commit secrets or private artist data.
- [ ] Fill `config/x-api-pricing.json` with real tier prices before treating cost-report USD as an estimate you can act on. Zero means unpriced, not free.
- [ ] Global cap is `config/budget-policy.json` (`monthlyBudgetUsd: 8` for the current Plugin Radar X-only period). Do not treat unknown AI unit prices as $0 actual spend.
- [ ] Plugin Radar / Artist Instagram keep `internalImageGeneration: false`. Do not turn AI image generation on to "fill" a missing product photo.
- [ ] Keep affiliate disabled until a separate reviewed change.

## 6. Required repository verification order

From a clean checkout, run in this order:

```bash
npm install
npm test
npm run validate
npm run check
npm run manual-only-audit
npm run secret-scan
npm run smoke
npm run doctor
```

Also run the CI coverage gate:

```bash
npm run coverage
```

`doctor` may report provider/account credential-readiness blockers while external setup is incomplete. Missing external credentials must be treated as setup/readiness information, not as permission to weaken code checks.

## 7. Provider preflight — still no account activation

- [ ] Manually run **SNS Live Preflight** for the exact account ID, or run the equivalent local `npm run preflight -- --account <ACCOUNT_ID>` when credentials are available.
- [ ] Resolve every missing scope, callback, account-ID, profile disclosure, media-host, and credential diagnostic in the external provider dashboards.
- [ ] Run `npm run secret-scan` again after local/manual credential work and confirm no credential was committed or printed into repository data.

## 8. Controlled first-publish sequence

Use this order and do not skip directly to live publishing:

1. Complete API/OAuth configuration in X/Meta.
2. Register only the required GitHub Secrets/Variables.
3. Run `npm test`.
4. Run `npm run validate`.
5. Run `npm run check`.
6. Run `npm run manual-only-audit`.
7. Run `npm run secret-scan`.
8. Run `npm run smoke`.
9. Run `npm run doctor`.
10. Run the account-specific preflight.
11. Run **SNS Publish social post** with `dry_run=true` and `confirm_live=false` while the account is still disabled where possible; inspect readiness/output.
12. Through a reviewed/manual configuration change, enable **only** the chosen account in `mode:"approval"`. Manual-Only intentionally rejects automatic promotion to `approval`/`auto` through unattended lifecycle logic.
13. Run the exact Publish dry-run again for that enabled approval account.
14. Only after reviewing that result yourself, explicitly choose `dry_run=false` and `confirm_live=true`.
15. Run **one** first live post and inspect the provider result before doing anything else.

No Issue title, Issue label, schedule, repository dispatch, or other server-side event can initiate the Publish workflow. It is `workflow_dispatch` only.

## 9. Engagement is a separate later procedure

Publishing readiness does not imply engagement readiness.

- [ ] Keep engagement disabled during first-publish testing.
- [ ] **SNS Engagement Autopilot** defaults to `dry_run=true`.
- [ ] Do not enable `autoReply`, `autoDmReply`, or add live accounts merely because publishing works.
- [ ] Manual-Only rejects engagement activation while the lock is active.
- [ ] Human-resolved public engagement may run only through an explicit manual workflow path and still passes the provider-mutation runtime guard.
- [ ] Private/DM behavior remains subject to the stricter privacy/manual-send rules in the engagement runtime.

## 10. Manual control workflows

These operational workflows are explicit manual controls, not automation triggers:

- **SNS Account Control** — safe pause/disable operations; Manual-Only rejects approval/auto promotion.
- **SNS Engagement Control** — deactivation is available; Manual-Only rejects activation.
- **SNS ChatOps** — provider-offline; its only command is `preflight` (a read-only readiness check). Dry-run previews live in SNS Autopilot, and engagement previews live in SNS Engagement Autopilot - see docs/CHATOPS.md.
- **SNS Compliance Attestation** — records an explicit owner/admin attestation only; it does not perform the external provider action.
- **SNS Human Feedback** — records human feedback only when manually dispatched.

## 11. Automatic operation remains a separate future change

Finishing this checklist **does not start automatic SNS operation**. If the owner later explicitly asks to start automation, treat that as a separate reviewed change/PR that can modify the runtime policy and, only after review, reintroduce schedules/account automation/engagement automation as intended. Do not couple Manual Setup completion to automatic activation.

## 12. Final Manual-Only safety verification

- [ ] `npm test`, `npm run validate`, `npm run check`, `npm run coverage`, `npm run manual-only-audit`, `npm run secret-scan`, and `npm run smoke` are green.
- [ ] `npm run doctor` / keyless preflight portions distinguish missing external credentials from code failure.
- [ ] No account uses `mode:auto`; accounts not deliberately under controlled manual testing remain disabled.
- [ ] Engagement remains disabled with `liveAccounts: []`, `autoReply:false`, `autoDmReply:false`, and `approvalRequired:true`.
- [ ] Every operational workflow is explicitly classified and cannot gain an automatic trigger unnoticed.
- [ ] `ci.yml` and `failure-watch.yml` are the only classified automatic GitHub-internal workflows and cannot receive SNS/OpenAI/provider secrets.
- [ ] No operational workflow depends on stale Issue payload fields unavailable to `workflow_dispatch`.
- [ ] Live provider mutation is rejected without the explicit manual invocation boundary; dry-run remains allowed.
- [ ] No real post, reply, DM, follow, unfollow, or provider polling occurs except through an explicitly allowed/manual path.
