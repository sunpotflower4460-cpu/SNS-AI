# SNS-AI Go-Live Checklist

実アカウントを`mode: auto`へ切り替える前の最終チェックリストです。

## A. GitHub

- [ ] Repository Actionsが有効
- [ ] `SNS Autopilot` workflowがactive
- [ ] repositoryがpublic、またはbuilt-in media hostingを使わず外部public CDNを設定
- [ ] `OPENAI_API_KEY` Secret登録
- [ ] `SOCIAL_CREDENTIALS_JSON` Secret登録
- [ ] X image/video利用時は`X_OAUTH2_STATE_KEY` Secret登録（32文字以上）
- [ ] optional external media利用時だけ`MEDIA_SERVICE_TOKEN`

Autopilotは毎時`03,13,23,33,43,53`分にpollします。投稿scheduleはアカウントtimezoneの`times` + `windowMinutes`で判定します。

GitHub Actionsのscheduleはhard real-timeではありません。public repositoryは60日間repository activityがない場合scheduled workflowsが自動無効化され得るため、長期休止後はActions状態を確認してください。

## B. OpenAI API

- [ ] OpenAI API project/keyを作成
- [ ] API billing / creditsが有効
- [ ] Live Preflightでconfigured text modelがavailable
- [ ] built-in image利用時は`gpt-image-1`（または明示設定したsupported model）がavailable
- [ ] built-in video利用時は`sora-2` / `sora-2-pro`（設定値）がavailable
- [ ] QA modelがavailable
- [ ] controlled image/video generationを1回成功させる

Preflightの`/v1/models/{model}` checkはmodel visibilityを確認しますが、endpoint固有のbilling/rate-limit/verificationまで完全には証明しません。最初のcontrolled generationを最終proofにします。

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
- [ ] Live Preflight `ready`
- [ ] Autopilot `force=true / dry_run=true` success
- [ ] generated draftを確認
- [ ] media利用時controlled generation success
- [ ] approval modeで実投稿1件success
- [ ] `data/history.jsonl`へproviderPostId保存
- [ ] Metrics Collector success
- [ ] `data/metrics.jsonl`へsnapshot保存
- [ ] Current Reportへ反映
- [ ] open Health Issueなし

**ここまで全て通った後だけ`mode: auto`へ変更します。**

## H. Auto後

Autopilotが定期pollし、due slotに対して:

```text
research / history / strategy
  → candidate generation
  → safety / duplicate / compliance
  → candidate selection
  → optional image/video generation
  → media moderation / visual QA
  → X / Instagram publish
  → history/state persistence
  → Metrics Collector
  → Daily Learning
  → next post strategy
```

Circuit Breaker、Anomaly Brake、daily budget、Failure Watchは`auto`後も有効です。
