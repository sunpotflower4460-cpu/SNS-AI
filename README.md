# SNS-AI

GitHub Actionsを実行エンジンにした、**複数アカウント対応のX / Instagram自律運用基盤**です。

アカウントごとに人格・目的・読者・禁止事項を分離し、
**情報収集 → 複数案生成 → 選定 → 画像/動画生成 → 公開前QA → 投稿 → 反応計測 → 安全監視 → 学習 → A/B実験 → 改善 → 報告 → 保守**まで循環させます。

**現在このリポジトリはManual-Onlyでロックされています**（[`docs/MANUAL_ONLY_MODE.md`](docs/MANUAL_ONLY_MODE.md)）。以下の自動化はコードとして実装済みですが、`config/runtime-policy.json`の`manualOnly: true`により、SNSを操作するoperator workflow（投稿・エンゲージメント・アカウント制御など）のscheduleは全て外され、`mode: auto`への遷移も拒否されます。これらのoperator workflowは現時点では**全て`workflow_dispatch`による手動実行のみ**です（`ci.yml`と`failure-watch.yml`はGitHub内部の自動workflowで、この対象外の例外として引き続き自動実行されます — 詳細は「GitHub Actions」節）。自動実行を再開するのは別途レビュー済みの変更として扱ってください（[`docs/MANUAL_SETUP_CHECKLIST.md`](docs/MANUAL_SETUP_CHECKLIST.md) §11）。

## 主な自動化

- X / Instagramの複数アカウント管理
- `auto` / `approval` / `manual` / `pause`
- OpenAI Responses APIによる複数投稿候補生成
- アカウント別Web Search / Trend Intelligence
- Web参照URL・タイトル・判断理由の保存
- 過去投稿との近似重複チェック
- 文字数、NG表現、必須表記、リンク/ドメイン、ハッシュタグ、投稿頻度のガード
- spread予測 + 過去実績 + Explore/Exploitによる候補選定
- 人間フィードバックを数字学習より上位の長期記憶として保持
- 通常投稿枠を使うA/B実験と勝者判定
- 人間が許可した候補時刻内だけで投稿時間を自動最適化
- AIによる `none / library / search / generate` のメディア判断
- OpenAI Image APIによる静止画生成
- OpenAI Video APIによる短尺Reel/動画生成
- 生成画像 / Reel spritesheet（fallback: thumbnail）のModeration + 視覚QA
- QA不合格時の限定修正・自動再生成
- QA合格素材だけをGitHub Releaseへ公開hosting
- QAからalt textを生成し、X画像へmedia metadataとして登録
- X / Instagram公式API投稿
- X画像はv2 media upload、X動画はv2 chunked media upload
- X OAuth2 access tokenの自動refresh + AES-256-GCM暗号化state保存
- 投稿後1h / 6h / 24h / 72h / 7dメトリクス収集
- アカウント自身のbaselineと比較した相対評価
- 極端な成熟反応異常を検知する一時AUTOブレーキ
- ブレーキcooldown後の自動再開
- rolling windowでの戦術学習
- Circuit BreakerによるAPI障害の自動休止 / 復帰
- OpenAI / Web Search / 外部media / image / videoの日次hard cap
- Current Report / Weekly Report
- Readiness Doctor / Live Preflight / Secret Scan / CI
- Workflow障害Issue作成・復旧時Close
- stale approvalの自動失効
- JSONL dedupe / retention / archive / quarantine
- 古い生成media Release assetの自動削除
- X / Instagram公式policyの定期監視

## 運転モード

- `auto` — 定刻に生成し、検証を通過した内容を公式APIで投稿（Manual-Only中は`account-control.yml`経由での遷移が拒否されます）
- `approval` — 投稿案をGitHub Issueへ作り、**SNS Publish social post**を手動実行して承認後に投稿
- `manual` — `SNS Publish social post`（`workflow_dispatch`）による明示投稿
- `pause` — 停止

投稿・feedback記録の実行（`SNS Publish social post` / `SNS Human Feedback`）は、リポジトリ所有者またはRepository Variable `SNS_COMMAND_ADMINS` に登録したユーザーだけが実行できます（各workflowのActor authorization step）。Issue title/label/commentをトリガーとするworkflowは存在しません。

## 自律ループ

```text
Trend / Web Research
        ↓
Candidate Generator
        ↓
Safety / Duplicate / Compliance
        ↓
Spread + Learned Strategy Ranking
        ↓
Controlled Experiment / Explore
        ↓
Media Director
        ↓
Image / Reel Generation
        ↓
Moderation + Visual QA
   NG ──┴──→ bounded regeneration
        ↓ OK
Public Release Hosting
        ↓
X / Instagram Publish
        ↓
Metrics Collection
        ↓
Relative Performance + Anomaly Brake
        ↓
Feature Learning + A/B Evaluation
        ↓
Account Strategy
        └──────────────→ 次回生成
```

人格・理念・明示的な指示・人間フィードバック・法令/規約hard ruleは、数字による最適化より常に上位です。

## メディア生成

### 静止画

```json
"media": {
  "strategy": "auto",
  "type": "image",
  "internalImageGeneration": true,
  "imageModel": "gpt-image-2",
  "imageSize": "1024x1024",
  "imageQuality": "medium"
}
```

### Reel / 動画

```json
"media": {
  "strategy": "generate",
  "type": "reel",
  "internalVideoGeneration": true,
  "videoModel": "sora-2",
  "videoSize": "720x1280",
  "videoSeconds": 8
}
```

Sora createはOpenAI Video APIのmultipart form contractで送信します。標準的な短尺動画生成は外部video serviceを必須としません。外部`media.endpoint`は独自生成・素材検索・private repository用CDNなどの任意拡張です。

Instagramでは生成した公開MP4 URLをReel containerへ渡します。Xでは動画をv2 chunked upload（initialize → append → finalize → status）してからPostへ`media_id`を添付します。

### 公開前メディアQA

```json
"media": {
  "qa": {
    "enabled": true,
    "model": "gpt-5",
    "detail": "high",
    "minScore": 75,
    "maxRegenerations": 1,
    "maxInputBytes": 15728640
  }
}
```

生成画像は画像本体、Reelは生成jobのspritesheetを優先して確認し、取得できなければthumbnailへfallbackします。

主な検査対象:

- 破損・壊れた描画
- 明確な人体/物体崩れ
- 意図しない文字化け
- 不要なwatermark / logo
- 重大なcrop / composition不良
- 投稿意図との明確な不一致
- Moderation上の問題

主観的な好みだけではrejectしません。NG素材はReleaseへ公開せず、QAが示した問題だけを修正して設定回数内で再生成します。

## X media OAuth2

Xの**画像・動画media uploadはOAuth2 user context**を使います。OAuth2 authorizationには少なくとも次を含めます。

- `tweet.write`
- `users.read`
- `media.write`
- `offline.access`

`offline.access`で得たrefresh tokenとClient IDを`SOCIAL_CREDENTIALS_JSON`へ登録します。初回Live Preflightでrefresh flowを通し、以後のaccess/refresh tokenは`X_OAUTH2_STATE_KEY`でAES-256-GCM暗号化して`data/x-oauth2-state.json`へ保存します。access tokenが期限接近または401になった場合は自動refreshし、更新stateを通常のworkflow state commitで引き継ぎます。

Xのテキストのみの投稿・現在のX metrics経路はOAuth1 credentialsを継続利用できます。Live PreflightはOAuth1とOAuth2が同じXユーザーを指しているかも確認します。

## X alt text

生成静止画のQA時に客観的なalt textを作成し、Xでは画像upload後にmedia metadataへ登録してから投稿します。動画QAの説明文は履歴/監査用に保持します。

## 反応異常ブレーキ

通常の「少し伸びなかった投稿」では止まりません。十分なbaseline・confidence・露出を持つ成熟投稿だけを対象に、極端な性能崩壊や低スコアと異常なconversation spikeが重なった場合に、新しい自動生成/投稿を一時停止します。

```json
"safety": {
  "anomalyBrake": {
    "enabled": true,
    "matureCheckpointMinutes": 1440,
    "minBaselinePosts": 5,
    "minConfidence": 0.55,
    "minExposure": 500,
    "severeScoreThreshold": 12,
    "lowScoreThreshold": 25,
    "consecutiveLowPosts": 2,
    "conversationSpikeMultiplier": 5,
    "minimumConversationRate": 0.02,
    "cooldownHours": 12
  }
}
```

ブレーキは過去投稿を削除しません。cooldown後は自動で閉じ、次のslotから再開可能になります。

## 投稿時間の自動改善

```json
"schedule": {
  "times": ["08:00", "20:00"],
  "adaptiveCandidateTimes": ["08:00", "12:00", "18:00", "20:00"]
}
```

AIは`adaptiveCandidateTimes`の外へ勝手に投稿時刻を移動しません。候補がなければ固定scheduleのままです。GitHub Actions scheduleはhard real-time schedulerではないため、投稿時刻は`windowMinutes`内で拾う設計です。

## トレンド調査と出典

```json
"research": {
  "webSearch": true,
  "trendIntelligence": true,
  "trendRefreshHours": 6
}
```

検索を使った投稿・Trend Briefには取得できたURL citationを保存し、後から「何を根拠にしたか」を追跡できます。

## 安全・規約設定

```json
"safety": {
  "blockedPhrases": ["使わない表現"],
  "requiredPhrases": ["必ず含める表記"],
  "requiredAnyPhrases": ["PR", "広告"],
  "maxHashtags": 5,
  "maxLinks": 1,
  "allowedDomains": ["example.jp"],
  "blockedDomains": ["example.invalid"],
  "maxPostsPerDay": 4,
  "minMinutesBetweenPosts": 60
}
```

manual / Issue経由の投稿にも同じhard guardを適用します。

## API障害の自動復旧

```json
"resilience": {
  "enabled": true,
  "failureThreshold": 3,
  "cooldownMinutes": 60
}
```

Autopilot / Publish / Analytics / Researchを別々のCircuitとして監視します。連続失敗時に一時休止し、cooldown後に自動再試行します。

## 利用量hard cap

```json
"budgets": {
  "enabled": true,
  "openaiCallsPerDay": 300,
  "webSearchCallsPerDay": 60,
  "mediaCallsPerDay": 60,
  "imageGenerationsPerDay": 10,
  "videoGenerationsPerDay": 4
}
```

金額ではなくAPI呼び出し回数で上限を掛けます。X API / OpenAI API側のcredits・billing・provider側rate limitは別途有効である必要があります。

## 実接続に必要なSecrets

Repository → Settings → Secrets and variables → Actions

### `SOCIAL_CREDENTIALS_JSON`

```json
{
  "brand-a-x": {
    "consumerKey": "...",
    "consumerSecret": "...",
    "accessToken": "... OAuth1 ...",
    "accessTokenSecret": "... OAuth1 ...",
    "oauth2ClientId": "...",
    "oauth2RefreshToken": "... offline.access ...",
    "oauth2AccessToken": "... optional current token ...",
    "oauth2Scope": "tweet.write users.read media.write offline.access"
  },
  "brand-a-instagram": {
    "accessToken": "...",
    "igUserId": "...",
    "expiresAt": "2027-01-01T00:00:00Z"
  }
}
```

Xでmediaを使わないテキスト-only accountならOAuth2項目は不要です。Xで画像または動画を使う場合はOAuth2 Client ID + offline refresh tokenが必要です。

InstagramはProfessional（Business / Creator）アカウントを使い、Instagram Login構成なら少なくとも`instagram_business_basic`と`instagram_business_content_publish`を付与します。Metricsを使う場合は対象Insightsを読める権限も必要です。既定Graph API versionは`v25.0`です。

### `X_OAUTH2_STATE_KEY`（X mediaを使う場合）

32文字以上のランダムな秘密値です。更新されたX OAuth2 tokenをリポジトリへ**暗号化stateとしてのみ**保存するために使います。Secret値そのものはGitへ書きません。

### `OPENAI_API_KEY`

投稿生成、Web Search、Trend Intelligence、Moderation、media QA、内蔵画像/動画生成で使用します。ChatGPT契約とは別のOpenAI API billing/creditsが必要です。

### `MEDIA_SERVICE_TOKEN`（任意）

外部`media.endpoint`がBearer Tokenを要求する場合のみ使います。

## 任意のRepository Variables

- `OPENAI_MODEL` — 投稿生成モデルの上書き。**ただし`config/accounts.json`の`defaults.generation.model`が設定されている間は効きません**（defaultsが全アカウントにmergeされ、`account.generation.model`が常に優先されるため）。モデルを変えるならconfig側を編集してください。
- `SNS_COMMAND_ADMINS` — 手動workflowの追加操作許可ユーザー、カンマ区切り。各操作系workflowのActor authorization stepが`github.actor`をこのリストとrepository ownerに照合し、一致しなければ実行を拒否します（approval Issueの`approved` labelは現在operatorの目印用に残るだけの表示専用ラベルで、どのworkflowもlabelでは判定しません）。**repositoryをOrganization配下へ移す場合は必須です** — `publish.yml`は`github.actor`を`github.repository_owner`と比較するため、org配下では個人アカウントが一致することはありません。
- `APPROVAL_MAX_AGE_DAYS` — approval Issueの自動失効日数（既定7）

環境変数（workflowで設定、Repository Variableではありません）:

- `SNS_REQUIRE_DURABLE_STATE` — `true`のとき`sns-ai-state` branchによる耐久claimを必須にします。Live Preflightのworkflowは`true`固定です。
- `SNS_DURABLE_STATE_BRANCH` — 耐久claim用branch名の上書き（既定`sns-ai-state`）
- `STUCK_CLAIM_MAX_AGE_HOURS` — `npm run stale-claims`が「詰まったclaim」と判定するまでの時間（既定3時間）

## Live Preflightで確認するもの

- Secretの存在・JSON shape
- X OAuth1 identity
- X media利用時のOAuth2 refresh bootstrap
- X OAuth1 / OAuth2が同じユーザーか
- OAuth2 scope情報が取得できる場合の必須scope
- Instagram対象Professional accountの読取
- OpenAI Moderation API認証
- 設定されたOpenAI text / image / video / QA modelの`/v1/models/{model}` availability
- 内蔵media hosting時のGitHub repository public状態と`sns-ai-media` releaseの可読性（asset uploadの権限は実投稿まで未証明のまま報告されます）
- X access tokenのwrite権限（`x-access-level` responseヘッダが返る場合）
- Instagramの`account_type`とcontent publishing権限（`content_publishing_limit`の読み取り）
- approval modeのアカウントがある場合、Issuesが有効か / `approved` labelが読めるか

PreflightはSNS投稿や画像/動画generationを行いません。したがって、**モデルが見えること**までは無料/低副作用で確認できますが、Image / Video endpointの最終利用可否とbilling/rate limitを含む完全な証明は最初のcontrolled generationで行います。

## GitHub Actions

Manual-Only下ではSNSを操作するoperator workflowは**全てworkflow_dispatch（手動実行）のみ**で、scheduleは付いていません（`ci.yml`と`failure-watch.yml`はGitHub内部の自動workflowとして例外的に自動実行されます — 下記参照）。`.github/workflows/`にIssue title / label / commentをトリガーとするworkflowは存在しません。

- **SNS Autopilot** — 投稿candidate生成・approval issue作成（`force` / `dry_run`指定可）
- **SNS Publish social post** — 実投稿。`dry_run: false`かつ`confirm_live: true`の両方を指定した場合のみ実publish
- **SNS Engagement Autopilot** — 自分の投稿への返信を検知・分類・下書き。approval Issue経由が基本
- **SNS Engagement Resolve** — `[engagement-human]` Issueへの返信/却下を実際に実行する唯一の手段
- **SNS Metrics Collector** — 投稿後メトリクス取得
- **SNS Trend Intelligence** — Trend Brief更新
- **SNS Daily Learning** — 戦略更新
- **SNS Account Control** — アカウントlifecycle変更（`approval`/`auto`はManual-Only中は拒否）
- **SNS Engagement Control** — engagement activate/deactivate（`activate`はManual-Only中は拒否）
- **SNS Compliance Attestation** — X automated-profile / AI-reply承認の記録
- **SNS ChatOps** — provider-offlineなkeyless preflight（生成previewは`OPENAI_API_KEY`が必要なため対象外。previewは**SNS Autopilot**の`dry_run: true`を使用）
- **SNS Hub Reconcile** / **SNS Publish Readback Reconcile** — Hub/provider状態の照合
- **SNS Human Feedback** — 明示フィードバック保存
- **SNS Health Report** — readiness / operating report
- **SNS Live Preflight** — 実投稿・有料media生成をせず認証と外部前提を確認
- **SNS Maintenance** — retention / archive / stale approval / generated media cleanup
- **SNS Policy Watch** — X / Instagram公式情報の確認
- **SNS-AI CI** — test / config / syntax / smoke / secret scan / workflow YAML / operational runtime（push / pull_requestで自動実行される数少ない例外）
- **SNS Failure Watch** — Workflow障害Issue（`workflow_run`完了で自動実行されるもう一つの例外）

状態を書き換えるworkflowは`concurrency: sns-ai-write`で直列化します。すべての操作系workflowは`SNS_COMMAND_ADMINS`またはrepository ownerのみ実行できます（各workflowのActor authorization step）。

## 主な記録

- `data/history.jsonl` — 投稿、理由、feature、AI情報、media QA、alt text、source
- `data/metrics.jsonl` — 投稿後メトリクス
- `data/strategies/<account>.json` — 学習済み戦略
- `data/experiments/<account>.json` — A/B実験
- `data/trends/<account>.json` — Trend Brief + source
- `data/human-feedback.jsonl` — 人間フィードバック
- `data/usage.jsonl` / `data/usage-state.json` — API利用量
- `data/audit.jsonl` — 判断・実行・障害監査
- `data/runtime-health.json` — Circuit状態
- `data/brakes.json` — 反応異常ブレーキ状態
- `data/x-oauth2-state.json` — 暗号化されたX OAuth2 rotating token state
- `data/reports/latest.json` / `.md` — Current Report
- `data/reports/readiness.json` / `.md` — 起動準備状態

## 推奨セットアップ順

1. X / Meta / OpenAI側で必要なapp・権限・billingを準備
2. `SOCIAL_CREDENTIALS_JSON` / `OPENAI_API_KEY`をGitHub Secretsへ登録
3. X media利用時は`X_OAUTH2_STATE_KEY`も登録
4. `config/accounts.json`へ実アカウントを追加し、まず`enabled: true / mode: approval`
5. **SNS Live Preflight**を実行
6. **SNS Autopilot**を`force=true / dry_run=true`で実行
7. 内蔵mediaを使う場合は最初のcontrolled image/video generation + 1件のapproval投稿を確認（**SNS Publish social post**を`dry_run: false` / `confirm_live: true`で手動実行。approval Issueへのlabel付与では何も起きません）
8. **SNS Metrics Collector**で投稿後データ取得を確認
9. ここまでがManual-Only下で完了できる範囲です。`mode: auto`への遷移は`account-control.yml`経由では現在拒否されるため、到達するには`config/runtime-policy.json`を対象にした別途レビュー済みの変更が必要です（[`docs/MANUAL_ONLY_MODE.md`](docs/MANUAL_ONLY_MODE.md)）
10. Manual-Onlyを別途レビューして解除しscheduleを再導入した場合のみ、以後は自動pollingが設定slotを拾い、自動投稿→計測→学習を継続します

詳細な運用手順は`docs/OPERATIONS.md`、AIが変更してよい範囲/いけない範囲は`docs/AUTONOMY.md`を参照してください。

## 外部境界

リポジトリ側で安全に自動化できる標準処理は可能な限り内蔵しています。残る主な外部境界は次です。

- X / Meta / OpenAIのapp・API key・最初のOAuth authorization
- X API credits / OpenAI API billing・credits
- developer app審査・権限承認
- 実アカウントのidentity / goal / audience /禁止事項という最上位方針
- 法律・契約・規約解釈が曖昧なケースの最終判断
- private repositoryで公開media URLが必要な場合の外部CDN
- provider側のmodel access・rate limit・障害・料金変更・サービス停止

SNS-AIは外部境界そのものを勝手に回避せず、Doctor / Preflight / Policy Watch / Health Issueで状態を見える化します。
