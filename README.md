# SNS-AI

GitHub Actions を実行エンジンにした、**複数アカウント対応の X / Instagram 自律運用基盤**です。

アカウントごとに人格・目的・読者・話題・禁止事項・投稿時刻・運転モードを分離し、
**調査 → 複数案生成 → 広がり予測 → メディア判断 → 投稿 → 反応計測 → 学習 → 次回改善 → レポート**まで循環させます。

## できること

- X / Instagram を何アカウントでも `config/accounts.json` で追加
- `auto` / `approval` / `manual` / `pause`
- OpenAI Responses API で投稿候補を複数生成
- 必要なアカウントだけ Web Search / Trend Intelligence
- 過去投稿との近似重複チェック
- OpenAI Moderation / NGフレーズ / 投稿頻度制限
- 5案前後から「広がり予測 + 過去実績」で候補選定
- 約20%を探索枠にして新しい型も継続テスト
- X / Instagram の投稿後メトリクスを時間別に保存
- フォロワー規模ではなく、各アカウント自身の平常値と比較して評価
- テーマ / 角度 / フック / 感情 / 形式 / CTA / メディア / 時刻ごとに成績を学習
- 学習した勝ち筋を次回生成へ自動フィードバック
- 最新状態を `data/reports/latest.json` と `latest.md` に保存
- ChatGPT からリポジトリを読めば「最近何を学んだ？」「何が伸びた？」に回答可能

## 運転モード

- `auto` — 定刻に生成し、そのまま公式 API で投稿
- `approval` — 投稿案を GitHub Issue に作り、`approved` ラベルで投稿
- `manual` — ChatGPT / Actions / `[publish]` Issue から指定投稿
- `pause` — 停止

## フィードバックループ

```text
Trend / Web Research
        ↓
Candidate Generator (複数案)
        ↓
Spread + Learned Strategy Ranking
        ↓
Media Director
        ↓
X / Instagram Publish
        ↓
Metrics: 1h / 6h / 24h / 72h / 7d
        ↓
Relative Performance Scoring
        ↓
Feature Learning
        ↓
Account Strategy
        └────────────→ 次回生成へ
```

### 評価の考え方

単純ないいね数ではなく、`impressions / reach / views` を露出母数として、共有率・保存率・会話率・プロフィール行動・クリックなどを計算します。
さらに同じアカウントの過去投稿を baseline にするため、規模の違うアカウント同士を雑に比較しません。

学習結果は `data/strategies/<account>.json` に保存されます。人格・理念・禁止事項は学習で書き換えず、戦術だけを改善します。

## トレンド調査

アカウントで:

```json
"research": {
  "webSearch": true,
  "trendIntelligence": true,
  "trendRefreshHours": 6
}
```

とすると、Trend Intelligence workflow が Web Search を使い、関連性・新規性・飽和度・リスクを見て候補を保存します。
結果は `data/trends/<account>.json` に残り、投稿生成時にも参照されます。

## メディア判断

`media.strategy = "auto"` では、AI が投稿ごとに次を選びます。

- `none` — 文章だけ
- `library` — 登録済み素材
- `search` — ライセンス管理された外部メディアサービスへ依頼
- `generate` — 外部画像/動画生成サービスへ依頼

SNS-AI 本体は任意画像を無断取得しません。`search` / `generate` は `media.endpoint` に委譲し、公開 HTTPS URL を受け取ります。

```json
"media": {
  "strategy": "auto",
  "type": "image",
  "urls": ["https://.../owned-asset.jpg"],
  "endpoint": "https://your-media-service.example/generate"
}
```

endpoint には `mode: search | generate`、投稿本文、ビジュアル指示、特徴タグ等が渡されます。

## X Analytics

投稿 ID を使って X API v2 から public metrics を取得します。User Context で許可される場合は private metrics も取得します。
private metrics が取得できない場合は public metrics のみへ自動フォールバックします。

主な記録:

- impressions
- likes / reposts / replies / quotes / bookmarks
- URL clicks / profile clicks / engagements（取得可能時）
- video views / playback completion（取得可能時）

## Instagram Analytics

Instagram Professional Account の Media Insights を利用します。
利用可能な指標は投稿形式によって異なるため、各 metric を個別取得し、非対応 metric はスキップします。

主な候補:

- views / reach
- likes / comments / shares / saved
- total interactions
- follows / profile visits（利用可能時）
- Reel watch time / average watch time / skip rate（利用可能時）

### Insights 権限

現在の実装は `graph.instagram.com` を使う Instagram Login 系です。
投稿権限に加え、Insights 用の `instagram_business_manage_insights` が必要です。

## 必要な Secrets

Repository → Settings → Secrets and variables → Actions

### `SOCIAL_CREDENTIALS_JSON`

```json
{
  "brand-a-x": {
    "consumerKey": "...",
    "consumerSecret": "...",
    "accessToken": "...",
    "accessTokenSecret": "..."
  },
  "brand-a-instagram": {
    "accessToken": "...",
    "igUserId": "..."
  }
}
```

### `OPENAI_API_KEY`
AUTO / approval、Trend Intelligence で使用します。

### `MEDIA_SERVICE_TOKEN`（任意）
外部メディア endpoint が Bearer Token を要求する場合に使用します。

### `OPENAI_MODEL` Repository Variable（任意）
未設定時はアカウント設定、さらに未設定なら `gpt-5`。

**認証情報を Issue / README / config に書かないでください。**

## アカウント設定例

```json
{
  "platform": "x",
  "enabled": true,
  "mode": "auto",
  "credentialKey": "music-x",
  "profile": {
    "identity": "音楽アーティスト",
    "goal": "作品と価値観を知ってもらう",
    "audience": "音楽が好きな人",
    "topics": ["制作", "作品", "日々の発見"],
    "style": ["自然体", "具体的"],
    "avoid": ["誇張", "同じ導入の連発"]
  },
  "instructions": "アカウント固有の方針",
  "schedule": {
    "timezone": "Asia/Tokyo",
    "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    "times": ["08:00", "19:00"],
    "windowMinutes": 30
  },
  "generation": {
    "maxChars": 280,
    "candidateCount": 5
  },
  "research": {
    "webSearch": true,
    "trendIntelligence": true
  },
  "learning": {
    "enabled": true,
    "exploreRate": 0.2
  },
  "analytics": {
    "enabled": true
  },
  "media": {
    "strategy": "auto"
  }
}
```

## GitHub Actions

- **SNS Autopilot** — 10分ごと。投稿時刻に該当するアカウントだけ処理
- **SNS Metrics Collector** — 毎時。投稿後 1h / 6h / 24h / 72h / 7d のチェックポイントを取得
- **SNS Trend Intelligence** — 6時間ごと。設定されたアカウントだけトレンド更新
- **SNS Daily Learning** — 毎日。成熟した反応データから戦略更新
- **Publish social post** — 手動投稿 / ChatGPT Issue / approval

全て `concurrency: sns-ai-write` で `data/` への同時書き込みを直列化します。

## 記憶・記録

- `data/history.jsonl` — 投稿本文、投稿ID、生成理由、特徴タグ、予測スコア
- `data/metrics.jsonl` — 投稿後の反応スナップショット
- `data/strategies/<account>.json` — 学習した勝ち筋と弱いパターン
- `data/trends/<account>.json` — 現在のトレンド候補
- `data/reports/latest.json` — ChatGPT から読みやすい現在状態
- `data/reports/latest.md` — 人間向け簡易レポート
- `data/state.json` — 定期投稿の二重実行防止

## ChatGPT から状況を聞く

GitHub 連携がある状態なら、例えば:

- 「SNS-AIの今の状況教えて」
- 「最近このアカウントは何を学んだ？」
- 「一番反応が良かった投稿は？」
- 「今のトレンド候補は？」
- 「なぜ次の投稿でそのフックを選んだ？」
- 「今エラーや承認待ちはある？」

のように聞けば、リポジトリの実記録を読んで回答できます。

## 安全設計

- サンプルは `enabled: false` / `pause`
- 手動 workflow は dry-run がデフォルト
- identity / explicit instructions / safety rules は自動学習で変更しない
- 学習は最低サンプル数と confidence を持つ
- 既存勝ち筋だけに固定しない Explore / Exploit
- X private metrics が取れなくても public metrics へフォールバック
- Instagram の非対応 metric は個別スキップ
- 任意Web画像を勝手に転載しない。素材検索は管理された media endpoint 経由
- APIキーは GitHub Secrets のみ

## セットアップ順

1. X / Meta 側で投稿 + Insights 用認証を取得
2. `SOCIAL_CREDENTIALS_JSON` を設定
3. `OPENAI_API_KEY` を設定
4. Instagramで画像生成も自動化する場合は media endpoint を用意
5. `config/accounts.json` に実アカウントを追加
6. 最初は `manual` または `approval`
7. Autopilot を `force=true / dry_run=true` で確認
8. 実投稿テスト
9. Metrics Collector の取得確認
10. 問題なければ `auto`
