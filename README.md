# SNS-AI

GitHub Actions を実行エンジンにした、**複数アカウント対応の X / Instagram 自律運用基盤**です。

アカウントごとに人格・目的・読者・禁止事項を分離し、
**情報収集 → 複数案生成 → 広がり予測 → 画像判断/生成 → 投稿 → 反応計測 → 学習 → A/B実験 → 改善 → 報告 → 障害復旧/保守**まで循環させます。

## 自動化されている範囲

- X / Instagram の複数アカウント管理
- `auto` / `approval` / `manual` / `pause`
- OpenAI Responses API による複数投稿候補生成
- アカウントごとの Web Search / Trend Intelligence
- Web検索の参照URL・タイトルを投稿/トレンド履歴へ保存
- 過去投稿との近似重複チェック
- 文字数、NGフレーズ、必須表記、リンク/ドメイン、ハッシュタグ、投稿頻度のガード
- 投稿候補を「広がり予測 + 過去実績」でランキング
- Explore / Exploit で勝ち筋に固定され過ぎない探索
- X / Instagram 投稿後メトリクスの定期保存
- 各アカウント自身の平常値と比較した相対評価
- topic / angle / hook / emotion / format / CTA / media / time の学習
- 学習結果の次回生成への自動フィードバック
- 人間フィードバックを自動学習より上位の長期記憶として保持
- 通常投稿枠を使った自動A/B実験と勝者判定
- 人間が許可した候補時刻の範囲内だけで投稿時間を自動最適化
- AIによる `none / library / search / generate` のメディア判断
- OpenAI Image API による静止画の内蔵生成
- 公開GitHub Release assetへ生成画像を保存し、Instagram/Xへ公開URLとして渡す
- 外部 media endpoint / CDN / 動画生成サービスへの差し替え
- API障害時のCircuit Breaker（自動休止→冷却後自動復帰）
- OpenAI / Web Search / 外部Media / Image Generation の日次利用上限
- 投稿・判断・障害の監査ログ
- Readiness Doctor / Live Preflight / CI / Secret Scan
- Workflow障害のIssue化と復旧時の自動Close
- 古い承認Issueの自動失効
- JSONL重複除去・破損行隔離・古い生データの月次集計化
- 古い生成画像Release assetの自動削除
- ChatGPTから読みやすいCurrent Reportの継続更新

## 運転モード

- `auto` — 定刻に生成し、そのまま公式APIで投稿
- `approval` — 投稿案をGitHub Issueへ作り、`approved` ラベル後に投稿
- `manual` — Actions / `[publish]` Issue / ChatGPT経由の明示投稿
- `pause` — 停止

Issue経由の `[publish]` / `[feedback]` は、リポジトリ所有者またはRepository Variable `SNS_COMMAND_ADMINS` に登録したGitHubユーザーだけ実行できます。

## フィードバックループ

```text
Trend / Web Research
        ↓
Candidate Generator
        ↓
Spread + Learned Strategy Ranking
        ↓
Controlled Experiment / Explore
        ↓
Media Director
        ↓
X / Instagram Publish
        ↓
Metrics: 1h / 6h / 24h / 72h / 7d
        ↓
Relative Performance Scoring
        ↓
Feature Learning + A/B Evaluation
        ↓
Account Strategy
        └──────────────→ 次回生成
```

人格・理念・明示的な運用指示・人間フィードバックは、数字からの自動学習より上位です。AIが自動で変更するのは戦術レイヤーだけです。

## 自動A/B実験

十分な投稿データが集まると、通常の投稿枠を使って次のような要素を交互に試します。

- `hook`
- `format`
- `cta`
- `mediaDecision`

投稿数を実験のためだけに増やしません。各variantに最低サンプル数が集まるまで結論を出さず、結果は `data/experiments/<account>.json` に保存します。

## 投稿時間の自動改善

投稿時間を自動最適化したい場合は、**人間が許可した候補時刻だけ**を指定します。

```json
"schedule": {
  "times": ["08:00", "20:00"],
  "adaptiveCandidateTimes": ["08:00", "12:00", "18:00", "20:00"]
}
```

学習confidenceが十分になった後も、この候補外の時刻へAIが勝手に移動することはありません。`adaptiveCandidateTimes` がなければ固定スケジュールのままです。

## トレンド調査と出典

```json
"research": {
  "webSearch": true,
  "trendIntelligence": true,
  "trendRefreshHours": 6
}
```

Trend Intelligenceは関連性・新規性・飽和度・リスクで候補を評価します。Web Searchを使った場合、取得できたURL citationを `data/trends/<account>.json` や投稿履歴へ保存するため、後から「何を根拠にした？」を追跡できます。

## メディア

`media.strategy = "auto"` では、AIが投稿ごとに選びます。

- `none` — テキストのみ
- `library` — 登録済み素材
- `search` — 管理された外部media endpointで検索
- `generate` — 新規生成

### 内蔵画像生成

静止画なら外部media serviceを用意しなくても、OpenAI Image APIを利用できます。

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

流れ:

```text
投稿案
 ↓
AIが generate を選択
 ↓
OpenAI Image API
 ↓
GitHub Release: sns-ai-media
 ↓
公開HTTPS URL
 ↓
X / Instagram
```

生成画像はGit履歴へ入れずRelease assetに保存します。週次Maintenanceが古いassetを自動削除します。

**内蔵GitHub hostingは公開リポジトリ向けです。** リポジトリをPrivateにする場合は `media.endpoint` でS3 / Cloudinary等の公開メディア置き場を接続してください。Reel/動画は外部media endpointまたは登録済み動画URLが必要です。

## 外部media endpoint

```json
"media": {
  "strategy": "auto",
  "type": "image",
  "endpoint": "https://your-service.example/generate"
}
```

SNS-AIは `mode: search | generate`、投稿本文、media prompt、feature等をPOSTし、endpointから `{ "url": "https://..." }` を受け取ります。

## 安全・規約向け設定

アカウントごとに次を設定できます。

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

このチェックはAI生成だけでなく、manual / Issue経由の投稿にも適用されます。

## 障害時の自動復旧

`resilience` は投稿・Autopilot・Analytics・Researchを別々に監視します。

```json
"resilience": {
  "enabled": true,
  "failureThreshold": 3,
  "cooldownMinutes": 60
}
```

連続失敗が閾値に達するとCircuitを開き、一定時間その経路を自動休止します。冷却後は次の定期runから自動再試行します。Workflow自体の失敗は `[health] ... failure` Issueへ集約し、後続run成功時に自動Closeします。

## 利用量上限

```json
"budgets": {
  "enabled": true,
  "openaiCallsPerDay": 300,
  "webSearchCallsPerDay": 60,
  "mediaCallsPerDay": 60,
  "imageGenerationsPerDay": 10
}
```

モデル料金が変わっても機能するよう、金額ではなくAPI呼び出し回数でhard capを掛けます。現在の使用数は `data/reports/latest.json` / `.md` に表示されます。

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

`expiresAt` は任意ですが、入れるとDoctorが期限切れ/14日以内を自動検知します。

### `OPENAI_API_KEY`

AUTO / approval / Web Search / Trend Intelligence / 内蔵画像生成で使用します。

### `MEDIA_SERVICE_TOKEN`（任意）

外部 `media.endpoint` がBearer Tokenを要求する場合のみ。

## 任意のRepository Variables

- `OPENAI_MODEL` — 投稿生成モデルの上書き
- `SNS_COMMAND_ADMINS` — Issue/手動workflowの追加操作許可GitHubユーザー。カンマ区切り
- `APPROVAL_MAX_AGE_DAYS` — approval Issueの自動失効日数。未設定時7日

## GitHub Actions

- **SNS Autopilot** — 10分ごと
- **SNS Metrics Collector** — 毎時
- **SNS Trend Intelligence** — 6時間ごと
- **SNS Daily Learning** — 毎日、戦略更新 + A/B評価/次実験開始
- **Publish social post** — manual / ChatGPT Issue / approval
- **SNS Human Feedback** — 人間の修正を長期記憶化
- **SNS Health Report** — Readinessレポート
- **SNS Live Preflight** — 投稿せず認証/外部前提を確認
- **SNS Failure Watch** — Workflow障害Issueの作成/復旧Close
- **SNS Maintenance** — 週次のデータ圧縮・古いapproval/生成画像整理
- **SNS-AI CI** — test / config / 全source構文 / smoke / secret scan / 全workflow YAML検証

状態を書き換えるworkflowは `concurrency: sns-ai-write` で直列化します。

## 記憶・記録

- `data/history.jsonl` — 投稿、生成理由、feature、予測、experiment、参照source
- `data/metrics.jsonl` — 投稿後メトリクス
- `data/strategies/<account>.json` — 学習済み戦略
- `data/experiments/<account>.json` — A/B実験
- `data/trends/<account>.json` — トレンド + 参照source
- `data/human-feedback.jsonl` — 人間フィードバック
- `data/usage.jsonl` — API利用量
- `data/audit.jsonl` — 判断/実行/障害の監査ログ
- `data/runtime-health.json` — Circuit状態
- `data/archive/monthly-summary.json` — 古い生データの集計
- `data/quarantine/invalid-jsonl.jsonl` — 破損データ隔離
- `data/reports/latest.json` / `.md` — 現在状態
- `data/reports/readiness.json` / `.md` — 起動準備状態

## ChatGPTから聞けること

GitHub連携がある状態なら、例えば次をリポジトリの実記録から確認できます。

- 「今の運用状況は？」
- 「最近何を学習した？」
- 「一番伸びた投稿は？」
- 「今のトレンド候補と出典は？」
- 「なぜこの投稿を選んだ？」
- 「A/B実験は何を試してる？」
- 「API利用量は？」
- 「Circuitが開いてる処理は？」
- 「最近どんなエラーが出た？」

## 人間フィードバック

`[feedback]` IssueまたはSNS Human Feedback workflowから、`prefer / avoid / correct / pin / note` を保存できます。これは数字からの自動学習より上位で次回生成に反映されます。

## データ保守

週次Maintenanceでは、設定した保存期間を超えた `history / metrics / usage / audit` の生データを月次summaryへ圧縮します。重複行は除去、壊れたJSONLはquarantineへ隔離します。人間フィードバックは自動削除対象にしていません。

## セットアップ順

1. X / Metaで投稿 + Insights用認証を取得
2. `SOCIAL_CREDENTIALS_JSON` を設定
3. `OPENAI_API_KEY` を設定
4. `config/accounts.json` に実アカウントと運用方針を追加
5. 静止画は内蔵画像生成または `media.endpoint` を選択
6. 最初は `manual` または `approval`
7. **SNS Live Preflight** を実行（投稿なし）
8. Autopilot `force=true / dry_run=true`
9. 1件の実投稿テスト
10. Metrics Collectorの取得確認
11. 問題なければ `auto`

詳細な運用手順は `docs/OPERATIONS.md` を参照してください。
