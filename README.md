# SNS-AI

GitHub Actionsを実行エンジンにした、**複数アカウント対応のX / Instagram自律運用基盤**です。

アカウントごとに人格・目的・読者・禁止事項を分離し、
**情報収集 → 複数案生成 → 選定 → 画像/動画生成 → 公開前QA → 投稿 → 反応計測 → 安全監視 → 学習 → A/B実験 → 改善 → 報告 → 保守**まで循環させます。

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
- OpenAI Video APIによる短尺Reel動画生成
- 生成画像 / Reel thumbnailのModeration + 視覚QA
- QA不合格時の限定修正・自動再生成
- QA合格素材だけをGitHub Releaseへ公開hosting
- QAからalt textを生成し、X画像へmedia metadataとして登録
- X / Instagram公式API投稿
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

- `auto` — 定刻に生成し、検証を通過した内容を公式APIで投稿
- `approval` — 投稿案をGitHub Issueへ作り、承認後に投稿
- `manual` — Actions / `[publish]` Issue / ChatGPT経由の明示投稿
- `pause` — 停止

Issue経由の`[publish]` / `[feedback]`は、リポジトリ所有者またはRepository Variable `SNS_COMMAND_ADMINS` に登録したユーザーだけが実行できます。

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

### Reel

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

標準的な短尺Reel生成は外部video serviceを必須としません。外部`media.endpoint`は独自生成・素材検索・private repository用CDNなどの任意拡張です。

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

生成画像は画像本体、Reelは生成jobのthumbnailを確認します。主な検査対象は次です。

- 破損・壊れた描画
- 明確な人体/物体崩れ
- 意図しない文字化け
- 不要なwatermark / logo
- 重大なcrop / composition不良
- 投稿意図との明確な不一致
- Moderation上の問題

主観的な好みだけではrejectしません。NG素材はReleaseへ公開せず、QAが示した問題だけを修正して設定回数内で再生成します。

## X alt text

生成静止画のQA時に客観的なalt textを作成し、Xでは画像upload後にmedia metadataへ登録してから投稿します。Instagramについては、公開APIで確実に扱える値だけを送る方針のため、生成alt textは履歴・監査用に保持します。

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

AIは`adaptiveCandidateTimes`の外へ勝手に投稿時刻を移動しません。候補がなければ固定scheduleのままです。

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

金額ではなくAPI呼び出し回数で上限を掛けるため、料金改定があっても安全装置として機能します。

## 必要なSecrets

Repository → Settings → Secrets and variables → Actions

### `SOCIAL_CREDENTIALS_JSON`

```json
{
  "brand-a-x": {
    "consumerKey": "...",
    "consumerSecret": "...",
    "accessToken": "...",
    "accessTokenSecret": "...",
    "expiresAt": "2027-01-01T00:00:00Z"
  },
  "brand-a-instagram": {
    "accessToken": "...",
    "igUserId": "...",
    "expiresAt": "2027-01-01T00:00:00Z"
  }
}
```

`expiresAt`は任意ですが、入れるとDoctorが期限切れ/期限接近を警告します。

### `OPENAI_API_KEY`

投稿生成、Web Search、Trend Intelligence、Moderation、media QA、内蔵画像/動画生成で使用します。

### `MEDIA_SERVICE_TOKEN`（任意）

外部`media.endpoint`がBearer Tokenを要求する場合のみ使います。

## 任意のRepository Variables

- `OPENAI_MODEL` — 投稿生成モデルの上書き
- `SNS_COMMAND_ADMINS` — Issue/手動workflowの追加操作許可ユーザー、カンマ区切り
- `APPROVAL_MAX_AGE_DAYS` — approval Issueの自動失効日数

## GitHub Actions

- **SNS Autopilot** — 10分ごと
- **SNS Metrics Collector** — 毎時
- **SNS Trend Intelligence** — 6時間ごと
- **SNS Daily Learning** — 毎日
- **Publish social post** — manual / Issue / approval
- **SNS Human Feedback** — 明示フィードバック保存
- **SNS Health Report** — readiness / operating report
- **SNS Live Preflight** — 実投稿・有料media生成をせず認証と外部前提を確認
- **SNS Failure Watch** — Workflow障害Issue
- **SNS Maintenance** — retention / archive / stale approval / generated media cleanup
- **SNS Policy Watch** — X / Instagram公式情報の定期確認
- **SNS-AI CI** — test / config / syntax / smoke / secret scan / workflow YAML

状態を書き換えるworkflowは`concurrency: sns-ai-write`で直列化します。

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
- `data/reports/latest.json` / `.md` — Current Report
- `data/reports/readiness.json` / `.md` — 起動準備状態

## セットアップ

1. X / Meta側で必要な投稿・Insights権限を取得
2. GitHub Secretsへ`SOCIAL_CREDENTIALS_JSON`と`OPENAI_API_KEY`を登録
3. `config/accounts.json`へ実アカウントを追加
4. 最初は`pause`または`approval`
5. **SNS Live Preflight**で認証・public hosting前提を確認
6. **SNS Autopilot**を`force=true / dry_run=true`で確認
7. 最初の実投稿を確認
8. 問題なければ`auto`

詳細な運用手順は`docs/OPERATIONS.md`、AIが変更してよい範囲/いけない範囲は`docs/AUTONOMY.md`を参照してください。

## 外部境界

リポジトリ側で安全に自動化できる標準処理は可能な限り内蔵しています。残る主な外部境界は次です。

- X / Meta / OpenAIのAPIキー・OAuth token発行
- developer app審査・権限承認
- 実アカウントのidentity / goal / audience /禁止事項という最上位方針
- 法律・契約・規約解釈が曖昧なケースの最終判断
- private repositoryで公開media URLが必要な場合の外部CDN
- API提供者側のmodel access・障害・料金・サービス停止

SNS-AIは外部境界そのものを勝手に回避せず、Doctor / Preflight / Policy Watch / Health Issueで状態を見える化します。
