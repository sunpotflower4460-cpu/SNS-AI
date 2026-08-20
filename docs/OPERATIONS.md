# SNS-AI Operations

この文書は**現在の manual-only 運用**の手順です。自動運用の実装はリポジトリ内に残っていますが、現在の`main`相当構成では無人運用を開始しません。

詳細な固定条件は [`MANUAL_ONLY_MODE.md`](MANUAL_ONLY_MODE.md) を正とします。

## 1. 現在の運用ロック

`config/operation-mode.json`:

```json
{
  "schemaVersion": 1,
  "mode": "manual-only",
  "allowAutoPromotion": false,
  "allowUnattendedEngagement": false
}
```

このロック中は:

- `mode: auto`への昇格をruntimeで拒否します。
- unattended engagement activationをruntimeで拒否します。
- 投稿/返信/DM/metrics/learning/trend/policy/maintenance/Hub reconcile/provider read-backの定期cronはありません。
- `SNS-AI CI`と`SNS Failure Watch`だけはGitHub内部の安全確認として自動イベントで動けますが、SNS/OpenAI/provider Secretsを受け取らず、SNSへ投稿・返信・pollしません。

## 2. CIが保証する範囲

PR / main CIで次を確認します。

```bash
npm test
npm run validate
npm run check
npm run smoke
npm run secret-scan
```

加えてCI内でsource coverage、全Workflow YAML parse、Doctor、keyless runtime checksを実行します。

manual-only hardening testsは特に次を固定します。

- 全Workflowファイルを明示allowlist化
- Workflowごとの許可triggerを固定
- active `schedule` / `cron`を禁止
- 未レビューの新規Workflow追加を禁止
- account `enabled:true` / `mode:auto`を禁止
- engagement `liveAccounts`を空に固定
- GitHub-only自動Workflowへのprovider Secret混入を禁止
- manual-only runtime lockの配線を検証

## 3. 実接続に必要なもの

### OpenAI

- `OPENAI_API_KEY`
- OpenAI API billing / credits
- 設定したtext / image / QA modelへのaccess

内部Video APIを使う場合は現行provider lifecycleを別途確認してください。リポジトリ既定では`internalVideoGeneration: false`です。

### X text-only

`SOCIAL_CREDENTIALS_JSON`にOAuth1 user credentialsを登録します。

```json
{
  "my-x": {
    "consumerKey": "...",
    "consumerSecret": "...",
    "accessToken": "...",
    "accessTokenSecret": "..."
  }
}
```

### X media / engagement

必要なOAuth2 scopesとoffline refresh tokenを用意し、media token stateを使う場合は`X_OAUTH2_STATE_KEY`を登録します。実際のscopeは利用機能に応じてLive Preflightで確認してください。

### Instagram

- Professional account
- access token
- `igUserId`
- 利用機能に必要なMeta permissions / app review

## 4. 現在のアカウント状態

manual-only repository stateでは全accountを`enabled:false`に保ちます。

手動のcontrolled launchを始めるときだけ、対象accountを`approval`へ明示的に移します。`auto`はmanual-only lock中は拒否されます。

## 5. 手動Controlled Launch

推奨順序:

1. 外部app / API key / billing / profile complianceを人が完了
2. 対象accountを`approval`へ明示的に有効化
3. Live Preflight / Doctor
4. SNS Autopilotを`force=true / dry_run=true`で手動実行
5. draft / media / safety結果を確認
6. approval flowまたは明示manual publishで1件だけ実投稿
7. provider post IDがhistoryへ保存されたことを確認
8. SNS Metrics Collectorを手動実行
9. Current Reportを確認
10. 必要なlearning / trend / policy / maintenanceを手動実行

manual-only中はここで止めます。`mode:auto`へは上げません。

## 6. 投稿の手動入口

利用可能な入口:

- Actions `Publish social post`
- `[publish]` Issue
- SNS-AIが作ったapproval Issueへ、許可ユーザーが`approved` labelを付与

`workflow_dispatch`のpublishは`dry_run:true`が既定です。

Issue系commandはrepository ownerまたは`SNS_COMMAND_ADMINS`だけが実行できます。

## 7. 手動Autopilot

`SNS Autopilot`は現在`workflow_dispatch`のみです。時刻triggerはありません。

- `force=true / dry_run=true`: 生成・検証プレビュー
- approval accountで`dry_run=false`: approval Issue作成まで

accountがdisabledなら処理対象になりません。

## 8. Engagement

manual-only中に許可するのは:

- engagement dry-run
- 人が判断したpublic interactionのresolve
- private DMは必要に応じSNSアプリから人が送信

`[engagement-activate]` / direct `--activate`はmanual-only lockで拒否されます。`liveAccounts`は空のままです。

## 9. Metrics / Learning / Research / Maintenance

現在はすべて明示manual dispatchです。

- Metrics Collector
- Daily Learning
- Trend Intelligence
- Policy Watch
- Health Report
- Maintenance
- Hub Reconcile
- Publish Readback Reconcile

これらにactive cronはありません。

## 10. Provider publish read-back

ambiguous publishのread-backは手動実行のみです。read-only provider lookupでexact matchを確認し、再投稿はしません。

## 11. 安全停止とidempotency

manual操作でも次のguardは維持します。

- posting frequency guard
- moderation / compliance
- duplicate detection
- Circuit Breaker
- Anomaly Brake
- daily API budget
- durable publish claim
- engagement delivery ledger
- provider outcome ambiguity handling

## 12. 自動運用へ戻す場合

単にcronを戻してはいけません。最低でも次を同じ変更としてレビューします。

1. `config/operation-mode.json`の意図的な変更
2. account controlled publish proof
3. metrics proof
4. no unresolved health incident
5. provider billing / permissions / compliance再確認
6. 必要なWorkflowだけのschedule復活
7. manual-only trigger testsを意図的に更新
8. CI green

この変更を行うまでは、リポジトリ内に自動運用コードが存在していても**無人運用は起動しない**のが正しい状態です。
