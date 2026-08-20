# SNS-AI Controlled Launch Checklist — manual-only

現在のリポジトリは`config/operation-mode.json`で**manual-only**に固定されています。このチェックリストは「自動運用を始めるため」ではなく、**人が明示操作した時だけ安全に実SNSへ接続できる状態を作るため**のものです。

自動運用へ移行する手順は本チェックリストの最後に分離しています。

## A. Repository safety state

- [ ] CI green
- [ ] `config/operation-mode.json`が`mode: manual-only`
- [ ] `allowAutoPromotion: false`
- [ ] `allowUnattendedEngagement: false`
- [ ] 全accountが通常保管状態では`enabled: false`
- [ ] `mode: auto`のaccountがない
- [ ] `config/engagement-policy.json`の`liveAccounts`が空
- [ ] active `schedule` / `cron`が運用Workflowにない
- [ ] open `[health]` Issueがない、または内容を確認済み

## B. GitHub / durable state

- [ ] Repository Actionsが有効
- [ ] `sns-ai-state` branchが存在
- [ ] Repository SecretsをIssue/README/logへ貼っていない
- [ ] built-in public media hostingを使う場合はrepository visibility要件を満たしている

## C. OpenAI

- [ ] `OPENAI_API_KEY`
- [ ] API billing / credits
- [ ] configured text model available
- [ ] image generationを使う場合はconfigured image model available
- [ ] QA model available
- [ ] controlled generation test

内部Video generationを使う場合は現行OpenAI/provider lifecycleを必ず再確認してください。既定では`internalVideoGeneration: false`です。

## D. X text-only

- [ ] X developer app
- [ ] OAuth1 API key / secret
- [ ] OAuth1 user access token / secret
- [ ] X API billing / credits
- [ ] Live Preflightでidentity一致
- [ ] X automated-profile transparency requirementを実アカウント側で完了

## E. X media

Dに加えて:

- [ ] OAuth2 Client ID
- [ ] required user scopes
- [ ] offline refresh token
- [ ] `X_OAUTH2_STATE_KEY`
- [ ] Live PreflightでOAuth1/OAuth2 identity一致
- [ ] refresh bootstrap成功
- [ ] controlled media post test

## F. Instagram

- [ ] Professional account
- [ ] Meta app / login setup
- [ ] access token
- [ ] `igUserId`
- [ ] content publishing permissions
- [ ] insightsを使う場合は必要permission
- [ ] app reviewが必要な機能はreview通過
- [ ] Live Preflight identity一致
- [ ] controlled image/Reel post test

## G. Manual controlled launch sequence

通常保管時はaccountをdisabledのままにします。実接続テストを開始する時だけ対象accountを`approval`へ明示的に移します。

- [ ] `[account-approval] ACCOUNT_ID`または同等の明示操作
- [ ] Doctor
- [ ] Live Preflight
- [ ] Autopilot `force=true / dry_run=true`
- [ ] generated draft確認
- [ ] mediaを使う場合はcontrolled generation確認
- [ ] approval/manual pathで実投稿1件
- [ ] provider post IDがhistoryへ保存
- [ ] Metrics Collectorを手動実行
- [ ] metrics snapshot確認
- [ ] Current Report確認
- [ ] 必要ならTrend / Learning / Policy / Maintenanceを手動実行

**manual-only中はここで止めます。`mode:auto`へ上げません。**

## H. Manual publish semantics

実投稿は次の明示操作だけで開始します。

- Actions `Publish social post`
- authorized `[publish]` Issue
- SNS-AIが作成したapproval Issueへauthorized userが`approved` labelを付与

Workflow dispatchは`dry_run:true`が既定です。

Issueへのコメントや単なるcloseはapproval publishを開始しません。

## I. Engagement

現在はunattended engagementを有効化しません。

- [ ] `liveAccounts`は空
- [ ] `approvalRequired: true`
- [ ] `autoDmReply: false`
- [ ] 必要な時だけ`[engagement-dry-run] ACCOUNT_ID`
- [ ] public human-required interactionは人がreply/ignoreを決める
- [ ] private DMはSNSアプリで人が確認・送信

`[engagement-activate]` / direct `--activate`はmanual-only runtime lockで拒否されます。

## J. Read-back / recovery

Publish outcomeが曖昧な場合だけ`SNS Publish Readback Reconcile`を手動実行できます。

- provider stateをread-onlyで確認
- exact matchが1件だけの場合のみdurable stateをrepair
- provider create-post endpointは呼ばない
- blind repostはしない

## K. Manual-onlyで自動に残るもの

SNS運用ではなくGitHub内部の安全機構だけです。

- `SNS-AI CI`: push / PR / manual dispatch
- `SNS Failure Watch`:対象Workflow完了後にGitHub health Issueを整理

この2つにはSNS/OpenAI/provider Secretsを渡さず、SNS投稿・返信・provider pollingを行いません。

## L. 将来自動運用へ切り替える場合

現状のmanual-only lockを迂回してはいけません。別のreviewed changeとして最低限:

- [ ] operatorが自動運用を明示決定
- [ ] external provider setup/billing/complianceを再確認
- [ ] controlled publish proofあり
- [ ] metrics proofあり
- [ ] health incidentなし
- [ ] `config/operation-mode.json`を意図的に変更
- [ ] 対象accountだけをauto許可
- [ ] unattended engagementが必要なら別途明示許可
- [ ] 必要なWorkflowだけscheduleを復活
- [ ] manual-only regression testsを意図的に更新
- [ ] CI green

これらを同時にレビューしない限り、**自動運用コードが存在していても起動させない**のが正しい状態です。
