# SNS-AI Go-Live Checklist

実アカウントを`mode: auto`へ切り替える前の最終チェックリストです。

**このリポジトリは現在Manual-Onlyロック中です**（[`docs/MANUAL_ONLY_MODE.md`](MANUAL_ONLY_MODE.md)）。`config/runtime-policy.json`の`manualOnly: true`により、`mode: auto`（および`approval`への新規遷移）は`account-control.yml`経由では拒否されます — 到達するにはcode reviewを経た`config/accounts.json`の直接編集が必要です。同様に、投稿・エンゲージメントのscheduled自動実行も現在は存在しません（全workflowが`workflow_dispatch`のみ）。本チェックリストは「§Gの一件の確認済みlive投稿まで」を対象とし、§H（`auto`後の定期poll）はManual-Onlyを別途レビューして解除した後の話です。実務上の完了条件は[`docs/MANUAL_SETUP_CHECKLIST.md`](MANUAL_SETUP_CHECKLIST.md)を参照してください。

アカウント別の具体的な手順書がある場合は、そちらを併読してください（例: [`docs/ACCOUNT_MUSIC_TOOLS_X.md`](ACCOUNT_MUSIC_TOOLS_X.md)）。本チェックリストは全アカウント共通の汎用版です。

セクションC/Dは X、Eは Instagram 用です。Dは X で画像/動画を投稿する場合だけ必要で、text-onlyのXアカウントではスキップできます。

## A. GitHub

- [ ] Repository Actionsが有効
- [ ] `SNS Autopilot` workflowがactive
- [ ] durable idempotency用の **`sns-ai-state`** branchが存在
- [ ] Live Preflightの`durableState.ok`がtrue
- [ ] repositoryがpublic、またはbuilt-in media hostingを使わず外部public CDNを設定
- [ ] `OPENAI_API_KEY` Secret登録
- [ ] `SOCIAL_CREDENTIALS_JSON` Secret登録
- [ ] X image/video利用時は`X_OAUTH2_STATE_KEY` Secret登録（32文字以上）— **media利用時のみ。text-onlyのXアカウントには不要です**
- [ ] optional external media利用時だけ`MEDIA_SERVICE_TOKEN`

`sns-ai-state`は外部SNSへpublishする直前にslot claimを耐久保存する専用branchです。通常の履歴/state pushが投稿後に失敗しても、次runが同じslotを再送しないための最後のidempotency guardとして使います。削除しないでください。

`SNS Autopilot`（投稿用）は`workflow_dispatch`のみで、現在scheduleは付いていません（Manual-Onlyの一部としてcronは意図的に外されています）。投稿scheduleの判定自体（アカウントtimezoneの`times` + `windowMinutes`）はロジックとして残っていますが、手動で都度Actionsから実行するまでは何も起きません。Manual-Onlyを別途レビューして解除した場合にscheduleを再導入する話は§Hを参照してください。返信エンゲージメント用の別workflow `SNS Engagement Autopilot` も同様に`workflow_dispatch`のみです（§Iのとおり）。

## B. OpenAI API

- [ ] OpenAI API project/keyを作成
- [ ] API billing / creditsが有効
- [ ] Live Preflightでconfigured text modelがavailable
- [ ] built-in image利用時は`gpt-image-2`（`defaults.media.imageModel`の既定値。明示設定した場合はその値）がavailable
- [ ] built-in video利用時は`sora-2` / `sora-2-pro`（設定値）がavailable
  - **OpenAIのVideos APIは2026-09-24に終了します。** それ以降`internalVideoGeneration: true`はfail-closedになり、doctorがblockerを出します。現在の既定は`defaults.media.internalVideoGeneration: false`なので、明示的にtrueにしない限り影響はありません。動画を続ける場合は外部`media.endpoint`か`pool`/`fixed`のmedia strategyへ切り替えてください。
- [ ] QA modelがavailable
- [ ] controlled image/video generationを1回成功させる

Preflightの`/v1/models/{model}` checkはmodel visibilityを確認しますが、endpoint固有のbilling/rate-limit/verificationまで完全には証明しません。最初のcontrolled generationを最終proofにします。

model idそのものが存在しない場合もこのcheckで落ちます（`ok: false`）。image modelの既定値を変更した場合は、Preflightがgreenであることを先に確認してから最初の生成を実行してください。

## C. X — text only

- [ ] X developer app
- [ ] OAuth1 API key / secret
- [ ] OAuth1 user access token / secret
- [ ] X API credits / billingが有効
- [ ] Live PreflightでOAuth1 identityが期待するX accountと一致

## D. X — image / video

Cに加えて:

- [ ] OAuth2 Client ID
- [ ] OAuth2 authorization scope: `tweet.write`
- [ ] OAuth2 authorization scope: `users.read`
- [ ] OAuth2 authorization scope: `media.write`
- [ ] OAuth2 authorization scope: `offline.access`
- [ ] `offline.access`で取得したrefresh token
- [ ] confidential clientなら必要に応じてOAuth2 Client Secret
- [ ] Live PreflightでOAuth1 / OAuth2 identityが同一X user
- [ ] Live Preflightでrefresh bootstrap成功
- [ ] `data/x-oauth2-state.json`が暗号化stateとして作成/更新
- [ ] imageを使うならcontrolled image media post成功
- [ ] videoを使うならcontrolled video media post成功

`X_OAUTH2_STATE_KEY`を失うと保存済みrotating token stateを復号できません。その場合はOAuth2を再authorizationして新しいrefresh tokenからbootstrapします。

## E. Instagram

- [ ] Instagram Professional account（BusinessまたはCreator）
- [ ] Instagram Login app/access token
- [ ] `igUserId`
- [ ] `instagram_business_basic`
- [ ] `instagram_business_content_publish`
- [ ] Metricsを使う場合: `instagram_business_manage_insights`
- [ ] Live Preflightで期待するProfessional account identity
- [ ] controlled imageまたはReel post成功
- [ ] Metrics Collectorで1回以上media insights取得成功
- [ ] tokenのprovider-defined expiry/lifecycleを確認し、必要なら`expiresAt`をcredential metadataへ登録

Instagram publishingは`graph.instagram.com/{api_version}`のcontainer flowを使います。Reelはcontainerが`FINISHED`になるまでpollしてからpublishします。

## F. Account config

- [ ] `enabled: true`
- [ ] 最初は`mode: approval`
- [ ] `credentialKey`
- [ ] identity
- [ ] goal
- [ ] audience
- [ ] topics
- [ ] style
- [ ] avoid / prohibited themes
- [ ] account-specific instructions
- [ ] timezone
- [ ] days
- [ ] times
- [ ] `windowMinutes`（通常30分推奨）
- [ ] maxChars
- [ ] media strategy / type
- [ ] disclosure / affiliate / domain rules（必要な場合）
- [ ] API daily hard caps

## G. Controlled launch sequence

- [ ] CI green
- [ ] Doctor `ready`
  - `ready`はenabledなアカウントが1件以上あって初めてtrueになります。全アカウントがdisabledの場合は`state: waiting_for_accounts` / `ready: false`です（何も検証していない状態をreadyと呼ばないための仕様）。
- [ ] Live Preflight `ready`
  - 同様に、enabledなアカウントが無い場合は`ok: false` / `state: nothing_enabled`になります。**先にアカウントを`enabled: true`にしてからPreflightを実行してください。**
- [ ] Live Preflight `durableState.ok === true`
- [ ] Autopilot `force=true / dry_run=true` success
  - dry_runは実際にOpenAIの生成APIを呼びます（draft確認のため意図的な仕様）。moderation・media生成・publish・approval issue作成・state/circuit更新は一切行わず、生成コストは本番の日次予算とは別カウンタで計上されます。
- [ ] generated draftを確認
- [ ] media利用時controlled generation success
- [ ] approval modeで実投稿1件success
  - **投稿を実行する操作は「`SNS Publish social post` Action（`workflow_dispatch`）をapproval Issue記載のaccount/text/mediaで、`dry_run: false`かつ`confirm_live: true`で手動実行する」ことだけです。** Issueへのlabel付与・コメント・closeでは何も起きません（このworkflowに`issues:`トリガーは存在しません）。却下する場合は何もせずIssueをcloseします。
  - Actionを実行できるのはrepository ownerか、Repository Variable `SNS_COMMAND_ADMINS`に記載されたユーザーのみです（`.github/workflows/publish.yml`のActor authorization step）。
  - 実行後に何も起きない場合は、共有concurrency group `sns-ai-write`が混み合っていないか（他のworkflowが同時実行中でないか）を確認してください。
- [ ] `data/history.jsonl`へproviderPostId保存
- [ ] Metrics Collector success
- [ ] `data/metrics.jsonl`へsnapshot保存
- [ ] Current Reportへ反映
- [ ] open Health Issueなし

**ここまで全て通った後だけ`mode: auto`へ変更します。** ただし現在Manual-Onlyがロック中のため、`account-control.yml`経由での`approval`/`auto`遷移は誰が実行しても拒否されます。到達するには`config/runtime-policy.json`と`config/accounts.json`を対象にした別途レビュー済みのPRが必要です（[`docs/MANUAL_ONLY_MODE.md`](MANUAL_ONLY_MODE.md)）。

## H. Auto後（Manual-Only解除後の将来状態）

**この節はManual-Onlyを別途レビューして解除し、scheduleを再導入した場合の話です。現在のリポジトリはこの状態ではありません。** Manual-Only下では`SNS Autopilot`はscheduleを持たず、`workflow_dispatch`で明示実行した分しか動きません。

Manual-Only解除後、Autopilotが定期pollすれば、due slotに対して:

```text
research / history / strategy
  → candidate generation
  → safety / duplicate / compliance
  → candidate selection
  → optional image/video generation
  → media moderation / visual QA
  → durable slot claim on sns-ai-state
  → X / Instagram publish
  → history/state persistence
  → Metrics Collector
  → Daily Learning
  → next post strategy
```

Circuit Breaker、Anomaly Brake、daily budget、Failure Watchは`auto`後も有効です。

## I. 返信エンゲージメント（投稿が安定してから）

**投稿運用が安定するまでは有効化しないでください。** 返信は自分の投稿があって初めて発生します。

現在の出荷時設定（`config/engagement-policy.json`）:

- `approvalRequired: true` — 生成された返信は**必ず`[engagement-human]` Issue経由**。自動送信されません
- `autoDmReply: false` — **DMは対象外**（日次上限も`0`）
- `replyScope: "own-posts"` — **自分の投稿のスレッド内のみ**。無関係なメンションには返信しません
- `maxInboundFetchesPerDay: 48` — 取得回数のハード上限。超えたら停止します
- workflowは**手動実行のみ**（cronはコメントアウト済み）

有効化の順序:

- [ ] X API課金の実単価をダッシュボードで確認（2026年2月以降は従量課金。**取得1回ごとに課金されます**）
- [ ] X OAuth2を設定 — scope `tweet.read` / `tweet.write` / `users.read` / `offline.access`、
      refresh token取得、`X_OAUTH2_STATE_KEY` Secret登録（32文字以上）
  - **text-onlyのままでも返信を使うならOAuth2一式が必要です**（`docs/ACCOUNT_MUSIC_TOOLS_X.md`のtext-only前提とはここで変わります）
- [ ] Instagramのコメント返信を使う場合、`instagram_business_manage_comments`のMeta App Review通過
- [ ] `xAiReplyBotApprovalConfirmedAccounts`にアカウントを追加（X側のAI自動返信に関する承認記録）
- [ ] `xAutomationProfileComplianceConfirmedAccounts`にアカウントを追加
- [ ] `liveAccounts`にアカウントを追加 ← **これを追加するまで一切動きません**
- [ ] **SNS Engagement Autopilot を手動実行**し、生成された`[engagement-human] <account> <event-key>` Issueの内容を確認
  - このIssueへのlabel付与・コメント・closeでは何も起きません。返信または却下は**`SNS Engagement Resolve` Action（`workflow_dispatch`）をIssue記載のaccount/event_keyで、`dry_run: false`かつ`confirm_live: true`で手動実行する**ことだけが実際に効きます（`.github/workflows/engagement-resolve.yml`）。
- [ ] 数件を人の目で確認する

`engagement.yml`のscheduleを再導入する（cronを戻す）ことは、それ自体が`config/runtime-policy.json`を対象にした別途レビュー済みの変更として扱ってください（[`docs/MANUAL_SETUP_CHECKLIST.md`](MANUAL_SETUP_CHECKLIST.md) §11）。この節の完了は「手動実行での有効化」までを指し、自動実行の再開を意味しません。

`liveAccounts`が空の間は、workflowを実行してもアカウントがフィルタで除外され、
外部APIを一切呼ばずに`nothing_enabled`で終了します（課金も発生しません）。
