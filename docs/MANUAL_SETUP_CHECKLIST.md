# Manual-Only setup checklist

The repository is deliberately **not live**. `config/runtime-policy.json` is the reviewed safety authority; accounts are disabled and engagement is off. Complete the steps below without changing that posture. Never paste a secret into an Issue, log, JSON file, or commit.

## 1. Create the provider applications (human-only)

- [ ] Sign in to the X Developer Portal with the account owner. Create/select a project and app, accept the current terms, and enable OAuth 1.0a read/write access for text-only publishing.
- [ ] If X media, replies, DMs, or inbound reads will later be used, configure OAuth 2.0 authorization-code flow with offline access and the minimum required scopes. Record the client ID, client secret, callback URL, and the tokens returned by the owner-authorized flow.
- [ ] Sign in to Meta for Developers. Create/select an app, connect the Instagram professional account to its Facebook Page, add the Instagram Graph API product, and have an administrator approve the minimum publishing/engagement permissions required for the intended manual test.
- [ ] Add the callback URL shown by each provider to that provider's dashboard exactly (scheme, host, path, and trailing slash all matter).

These portal actions, terms, app review, OAuth consent, and token issuance cannot be completed by repository code.

## 2. Prepare credentials locally

- [ ] Copy `.env.example` to `.env` (the latter is ignored) only if local diagnostics need environment variables.
- [ ] Build `SOCIAL_CREDENTIALS_JSON` as one JSON object keyed by each account's `credentialKey` from `config/accounts.json`. X text publishing requires `consumerKey`, `consumerSecret`, `accessToken`, and `accessTokenSecret`; X OAuth2 features require the corresponding OAuth2 access/refresh/client fields. Instagram requires `accessToken` and `igUserId`.
- [ ] Obtain an OpenAI API key only if generation is desired. Provider-only dry runs and repository validation must remain usable without it.

## 3. Register GitHub secrets and variables

In **Repository → Settings → Secrets and variables → Actions**, add only values actually used:

- [ ] Secret `SOCIAL_CREDENTIALS_JSON` for SNS credentials.
- [ ] Secret `OPENAI_API_KEY` for AI generation.
- [ ] Secret `X_OAUTH2_STATE_KEY` for OAuth state encryption when OAuth2 is used.
- [ ] Secret `MEDIA_SERVICE_TOKEN` only for an external media service.
- [ ] Secret `CONVENIENCE_HUB_GITHUB_TOKEN` and variables `CONVENIENCE_HUB_REPOSITORY`, `CONVENIENCE_HUB_PUBLIC_URL`, `CONVENIENCE_HUB_BRANCH` only for SNS-HUB integration.
- [ ] Do **not** create `SNS_MANUAL_INVOCATION` as a secret; the approved manual workflow supplies its non-secret boundary marker.

## 4. Enter public account identifiers

- [ ] Replace example account configuration with the correct platform, `credentialKey`, display name, X user ID or Instagram user ID, callback metadata, media rules, and limits.
- [ ] Keep every `enabled` value `false`, every mode paused/approval-safe, `liveAccounts: []`, engagement disabled, and `manualOnly: true` during setup.

## 5. Run keyless repository checks

From a clean checkout with no secrets exported:

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

`doctor` may report live-readiness blockers while keys/accounts are absent; that is expected setup information, not permission to weaken the checks.

## 6. Run dry runs

- [ ] In GitHub Actions, select **Publish social post → Run workflow**, choose the account, leave `dry_run=true`, and inspect the result.
- [ ] Run **SNS Autopilot** with `dry_run=true` if generation is configured.
- [ ] Run **SNS Engagement Autopilot** with `dry_run=true`; it must not send replies/DMs or persist terminal actions.
- [ ] Re-run `npm run manual-only-audit` after every configuration edit.

## 7. Preflight provider readiness

- [ ] Manually run **SNS Live Preflight** for one account.
- [ ] Resolve every missing-scope, callback, account-ID, profile-disclosure, media-host, and credential diagnostic in the provider dashboards.
- [ ] Confirm no secret appears in Actions logs and run `npm run secret-scan` again.

## 8. First manual publishing test (only when intentionally ready)

Manual-Only does not activate accounts. Enabling a real account requires a reviewed change to `config/accounts.json`; automatic/Issue-command activation remains blocked. After that reviewed change and successful preflight:

- [ ] Open **Publish social post** in Actions yourself.
- [ ] First run the exact payload with `dry_run=true`.
- [ ] Verify account, text, media, disclosure, and limits.
- [ ] Change only `dry_run` to `false`, acknowledge that this will create one real provider post, and click **Run workflow** once.
- [ ] Verify the provider result before retrying any ambiguous failure; durable reconciliation exists specifically to prevent duplicates.

## 9. First manual engagement test

The shipped posture has engagement disabled, `autoReply:false`, `autoDmReply:false`, approval required, and no live accounts. Keep it that way until a separately reviewed policy change is desired.

- [ ] Use dry-run first and confirm inbound scope and redaction.
- [ ] If manual engagement is later approved, change configuration through review—never with `[engagement-activate]`—and manually dispatch one workflow run.
- [ ] Review every proposed response. DMs and sensitive categories must remain human-controlled.

## 10. Final safety verification

- [ ] `npm run manual-only-audit` is green.
- [ ] Accounts not being tested are disabled.
- [ ] No operational workflow has `schedule`, `push`, `pull_request`, `workflow_run`, `repository_dispatch`, `workflow_call`, or Issue triggers.
- [ ] No real post, reply, DM, follow, or like occurs except the single explicitly dispatched test you reviewed.
