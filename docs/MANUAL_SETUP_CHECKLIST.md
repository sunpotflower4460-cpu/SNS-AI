# Manual-Only setup checklist

The repository is deliberately **not live** by default. `config/runtime-policy.json` is the reviewed safety authority; unattended account activation, unattended engagement, scheduled provider polling, and non-manual provider mutation are blocked. Never paste a secret into an Issue, log, JSON file, or commit.

## 1. Create the provider applications (human-only)

- [ ] Sign in to the X Developer Portal with the account owner. Create/select a project and app, accept the current terms, and enable OAuth 1.0a read/write access for text-only publishing.
- [ ] If X media, replies, DMs, or inbound reads will later be used, configure OAuth 2.0 authorization-code flow with offline access and the minimum required scopes. Record the client ID, client secret, callback URL, and the tokens returned by the owner-authorized flow.
- [ ] Sign in to Meta for Developers. Create/select an app, connect the Instagram professional account to its Facebook Page, add the Instagram Graph API product, and have an administrator approve the minimum publishing/engagement permissions required for the intended manual test.
- [ ] Add the callback URL shown by each provider to that provider's dashboard exactly (scheme, host, path, and trailing slash all matter).

These portal actions, terms, app review, OAuth consent, and token issuance cannot be completed by repository code.

## 2. Prepare credentials locally

- [ ] Copy `.env.example` to `.env` (the latter is ignored) only if local diagnostics need environment variables.
- [ ] Build `SOCIAL_CREDENTIALS_JSON` as one JSON object keyed by each account's `credentialKey` from `config/accounts.json`. X text publishing requires `consumerKey`, `consumerSecret`, `accessToken`, and `accessTokenSecret`; X OAuth2 features require the corresponding OAuth2 access/refresh/client fields. Instagram requires `accessToken` and `igUserId`.
- [ ] Obtain an OpenAI API key only if generation is desired.

## 3. Register GitHub secrets and variables

In **Repository → Settings → Secrets and variables → Actions**, add only values actually used:

- [ ] Secret `SOCIAL_CREDENTIALS_JSON` for SNS credentials.
- [ ] Secret `OPENAI_API_KEY` for AI generation.
- [ ] Secret `X_OAUTH2_STATE_KEY` for OAuth state encryption when OAuth2 is used.
- [ ] Secret `MEDIA_SERVICE_TOKEN` only for an external media service.
- [ ] Secret `CONVENIENCE_HUB_GITHUB_TOKEN` and variables `CONVENIENCE_HUB_REPOSITORY`, `CONVENIENCE_HUB_PUBLIC_URL`, `CONVENIENCE_HUB_BRANCH` only for SNS-HUB integration.
- [ ] Do **not** create `SNS_MANUAL_INVOCATION` as a secret; approved manual workflows supply this non-secret boundary marker themselves.

## 4. Enter public account identifiers

- [ ] Replace example account configuration with the correct platform, `credentialKey`, display name, X user ID or Instagram user ID, callback metadata, media rules, and limits.
- [ ] During setup, keep every account `enabled:false`, never use `mode:auto`, keep `liveAccounts: []`, keep engagement disabled, and keep `manualOnly:true`.

## 5. Run keyless repository checks

From a clean checkout with no provider secrets exported:

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

## 6. Preflight provider readiness

- [ ] Manually run **SNS Live Preflight** and pass the account ID explicitly. The preflight supports checking a disabled account without activating it.
- [ ] Resolve every missing-scope, callback, account-ID, profile-disclosure, media-host, and credential diagnostic in the provider dashboards.
- [ ] Confirm no secret appears in Actions logs and run `npm run secret-scan` again.

## 7. Prepare one account for a controlled manual post

Manual-Only intentionally blocks the **SNS Account Control** workflow from moving an account into `approval` or `auto`. To prepare a real account, make a reviewed configuration change instead:

- [ ] Change only the test account to `enabled:true` and `mode:"approval"` in `config/accounts.json`.
- [ ] Keep every other account disabled and keep `mode:auto` unused everywhere.
- [ ] Run `npm run manual-only-audit`; an enabled account in `approval` mode is allowed, while `auto` is rejected.
- [ ] Record required X compliance attestations through the manually dispatched **SNS Compliance Attestation** workflow only after the external requirement is genuinely complete.

## 8. Dry-run the exact manual payload

- [ ] Open **Publish social post → Run workflow** yourself.
- [ ] Select the prepared account and enter the exact text/media payload.
- [ ] Leave `dry_run=true` and `confirm_live=false`.
- [ ] Inspect the result and correct any provider/configuration problem before a real post.
- [ ] **SNS Autopilot** and **SNS Engagement Autopilot** also default to dry-run; unattended schedules do not exist in Manual-Only.

## 9. First manual publishing test

Only after the exact dry run succeeds:

- [ ] Open **Publish social post** again yourself.
- [ ] Use the same account/text/media payload.
- [ ] Set `dry_run=false` **and** `confirm_live=true`. Both are required for one real provider post.
- [ ] Click **Run workflow** once.
- [ ] Verify the provider result before retrying any ambiguous failure; durable reconciliation exists specifically to prevent duplicates.

No Issue title, Issue label, schedule, repository dispatch, or other server-side event can initiate this publish path.

## 10. Manual engagement only

The shipped posture has engagement disabled, `autoReply:false`, `autoDmReply:false`, approval required, and no live accounts.

- [ ] **SNS Engagement Autopilot** defaults to `dry_run=true`.
- [ ] Do not enable engagement merely to test publishing.
- [ ] If engagement is later intentionally redesigned, change its policy through review. Manual-Only currently rejects engagement activation while the lock is active.
- [ ] Human-resolved engagement actions may be run only through an explicitly dispatched manual workflow and must remain subject to the runtime provider-mutation guard.

## 11. Manual control workflows

The following workflows are `workflow_dispatch` only and use explicit form inputs rather than stale Issue payloads:

- **SNS Account Control** — safe pause/disable now; approval/auto remain fail-closed under Manual-Only.
- **SNS Engagement Control** — deactivation is available; activation remains fail-closed under Manual-Only.
- **SNS ChatOps** — explicit preflight/dry-run/manual engagement commands.
- **SNS Compliance Attestation** — records only an explicit owner/admin attestation; it does not perform the external provider action.
- **SNS Human Feedback** — records feedback only when manually dispatched.

## 12. Final safety verification

- [ ] `npm run manual-only-audit` is green.
- [ ] No account uses `mode:auto`; accounts not actively under controlled manual testing are disabled.
- [ ] Engagement remains disabled with `liveAccounts: []`, `autoReply:false`, and `autoDmReply:false`.
- [ ] Every operational workflow has only `workflow_dispatch`; CI and Failure Watch are the only classified automatic infrastructure workflows and receive no SNS/provider secrets.
- [ ] No operational workflow depends on `github.event.issue` or another event payload unavailable to `workflow_dispatch`.
- [ ] No real post, reply, DM, follow, or like occurs except after an explicit manual workflow dispatch that passes the runtime guard.
