# SNS-AI

GitHub Actions を実行エンジンにした、**複数アカウント対応の X / Instagram 自動運用基盤**です。

アカウントごとに人格・目的・読者・話題・禁止事項・投稿時刻・運転モードを分離し、定期実行時に AI が投稿を生成 → 重複/安全/頻度を検査 → 自動投稿または承認待ちまで進めます。

## 現在できること

### 複数アカウント
`config/accounts.json` の `accounts` に追加するだけで X / Instagram を増やせます。コードに特定アカウント名はハードコードしません。

### 4つの運転モード

- `auto` — 定刻に AI が生成し、そのまま公式 API で投稿
- `approval` — 定刻に AI が生成し GitHub Issue を作成。`approved` ラベルを付けると投稿
- `manual` — 自動生成しない。ChatGPT / Actions / `[publish]` Issue から指定投稿
- `pause` — 停止

### AI 運用

- OpenAI Responses API による投稿生成
- アカウントごとのプロンプト/運用方針
- 必要なアカウントだけ Web Search を使う設定
- 過去投稿を見た重複防止
- 近似投稿なら自動再生成
- OpenAI Moderation による安全チェック
- 文字数制限
- NGフレーズ
- 1日あたり投稿上限
- 最小投稿間隔
- 投稿履歴
- スケジュールスロットの二重実行防止
- 失敗時は同じスロットを次回実行で再試行可能

### X

- テキスト投稿
- 画像付き投稿
- X API v2 `POST /2/tweets`
- X Media Upload API
- OAuth 1.0a User Context

### Instagram

- 画像投稿
- Reel 投稿
- Professional Account の Instagram Publishing API
- コンテナ作成 → 処理待ち → `media_publish`

Instagram は投稿メディアが必要なので、アカウントごとに以下を選べます。

- `fixed` — 固定の公開 HTTPS URL
- `pool` — 複数 URL を自動ローテーション
- `external` — 外部で管理した URL
- `endpoint` — 画像/動画生成サービスへ POST し、返ってきた URL をそのまま投稿

`endpoint` を使えば、後から画像生成AI・動画生成AI・CDNなどを差し替えても SNS-AI 本体は変更不要です。

---

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

AUTO / approval モードで AI が投稿内容を作るために使用します。

### `MEDIA_SERVICE_TOKEN`（任意）

`media.strategy = "endpoint"` で外部メディア生成サービスが Bearer Token を要求する場合だけ設定します。

### Repository Variable `OPENAI_MODEL`（任意）

未設定時は `config/accounts.json` のモデル、さらに未設定なら `gpt-5` を使います。

**鍵を Issue、README、config ファイルへ書かないでください。**

---

## アカウントを増やす

例:

```json
{
  "accounts": {
    "music-x": {
      "platform": "x",
      "enabled": true,
      "mode": "auto",
      "credentialKey": "music-x",
      "displayName": "Music X",
      "profile": {
        "identity": "音楽アーティスト",
        "goal": "作品と価値観を知ってもらう",
        "audience": "音楽が好きな人",
        "topics": ["制作", "作品", "日々の発見"],
        "style": ["自然体", "具体的"],
        "avoid": ["誇張", "同じ導入の連発"]
      },
      "instructions": "ここにこのアカウント専用の運用指示を書く",
      "schedule": {
        "timezone": "Asia/Tokyo",
        "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        "times": ["08:00", "19:00"],
        "windowMinutes": 30
      },
      "generation": {
        "maxChars": 280
      },
      "research": {
        "webSearch": false
      },
      "media": {
        "strategy": "none"
      }
    }
  }
}
```

別のアカウントは別 ID で追加します。同じ X / Instagram プロバイダを再利用します。

---

## 定期自動運転

`.github/workflows/autopilot.yml` が10分ごとに起動し、各アカウントのタイムゾーンと `schedule.times` を見て「今投稿すべきアカウント」だけ処理します。

GitHub Actions の cron は多少遅れる場合があるため、各時刻は `windowMinutes` の範囲内で一度だけ処理します。`data/state.json` にスロット状態を保存するため、同じ定刻投稿を二重送信しません。

### 強制テスト

Actions → **SNS Autopilot** → Run workflow

最初は:

- `dry_run = true`
- 必要なら `account = 対象ID`
- `force = true`

で、実投稿せず生成結果を確認できます。

---

## 承認モード

アカウントを:

```json
"mode": "approval"
```

にすると、定刻に投稿案を作り、次の Issue を自動作成します。

```text
[approval] account-id account-id:2026-08-12:18:00
```

Issue 本文は投稿 payload の JSON です。

`approved` ラベルを付けると **Publish social post** workflow が動き、投稿成功後に Issue を閉じます。

このため ChatGPT からも、「この承認案を投稿して」という指示で GitHub の `approved` ラベルを付ける運用にできます。

---

## ChatGPT から即時投稿

Issue title:

```text
[publish] account-id
```

Issue body:

```json
{
  "account": "account-id",
  "text": "投稿本文",
  "dryRun": false,
  "source": "chatgpt"
}
```

画像付き:

```json
{
  "account": "account-id",
  "text": "投稿本文",
  "mediaUrl": "https://example.com/image.jpg",
  "mediaType": "image",
  "dryRun": false,
  "source": "chatgpt"
}
```

---

## Instagram の完全自動化について

X はテキストのみでも完全自動運転できます。

Instagram は画像または動画が必要なので、SNS-AI ではメディア生成をSNS本体と分離しています。

一番柔軟なのは:

```json
"media": {
  "strategy": "endpoint",
  "type": "image",
  "endpoint": "https://your-media-service.example/generate"
}
```

です。

SNS-AI が次を POST します。

```json
{
  "account": "account-id",
  "platform": "instagram",
  "slotId": "...",
  "mediaType": "image",
  "prompt": "AIが考えたビジュアル指示",
  "text": "投稿キャプション"
}
```

外部サービスは:

```json
{
  "url": "https://public.example/generated/image.png"
}
```

を返せば、そのまま Instagram へ公開します。

これにより OpenAI Image Generation、動画生成AI、自前ストレージ、Cloudinary/S3 等を後から自由に接続できます。

---

## 記憶

### `data/history.jsonl`

実際に公開した投稿を記録します。AI はここから直近投稿を読み、似た内容を避けます。

### `data/state.json`

定期実行のスロットを管理し、二重投稿を防ぎます。

---

## 安全設計

- サンプルアカウントは初期状態で `enabled: false`
- `pause` がデフォルト
- 手動 workflow は `dry_run: true` がデフォルト
- 認証情報は Secrets のみ
- アカウントごとに投稿数制限
- アカウントごとに NG フレーズ
- AI出力を Moderation
- 近似投稿は再生成
- AUTO / approval / manual / pause をアカウント単位で切替
- GitHub workflow の同時書き込みを concurrency で直列化

---

## セットアップ順

1. X / Meta 側で API 認証を取得
2. `SOCIAL_CREDENTIALS_JSON` を設定
3. `OPENAI_API_KEY` を設定
4. `config/accounts.json` に実アカウントを追加
5. まず `mode: "manual"` または `approval`
6. Actions の dry-run
7. 実投稿テスト
8. 問題なければ `mode: "auto"`

運用方針はアカウントごとに変えられます。「このアカウントは毎日こう運用」「こっちは週3回」「これは承認制」のような指示を ChatGPT 側から config に反映できます。
