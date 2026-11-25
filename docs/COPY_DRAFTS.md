# Copy Drafts（文案生成専用ステップ）

キャラクター系マルチプラットフォーム投稿（Instagram / Threads / YouTube / TikTok / X）向けに、**日英のタイトル・キャプション候補を複数生成して保存するだけ**のステップ。
候補は運用担当（Muse）が読み、選定・微修正して各プラットフォームへ手動で投稿する。

## 守る線

- **投稿・公開 API は一切呼ばない**（X / Instagram / YouTube / TikTok / Threads いずれも）。生成とファイル保存のみ。
- 既存の OpenAI シークレット `OPENAI_API_KEY` のみ使用。新しいシークレット・外部サービスは追加しない。
- トリガーは `workflow_dispatch` のみ（schedule なし）。Manual-Only ロック（`MANUAL_SETUP_CHECKLIST §11`）・publish/autopilot/chatops/Plugin Radar の経路には触れない。
- ブリーフ1件 = OpenAI Responses API 1回。

## 実行

Actions → **SNS Copy Drafts** → Run workflow。

| input | 内容 |
|---|---|
| `brief` | ブリーフ JSON 文字列 |
| `brief_file` | リポジトリ内のブリーフ JSON のパス（`brief` が空のとき使用） |
| `hard` | `true` で `gpt-6.1-sol`。既定は `gpt-6-luna` |

ローカル: `OPENAI_API_KEY=... node src/copy-drafts/run.mjs --brief-file path/to/brief.json [--hard] [--dry-run]`
（`--dry-run` は API を呼ばずプロンプトとモデル選択だけ表示する）

### ブリーフ

```json
{
  "character": "ひぐま",
  "scene": "本編の内容説明（エンドカードの内容は含めない）",
  "media": "video",
  "platforms": ["instagram", "threads", "youtube", "tiktok", "x"],
  "notes": "任意。使いたい言い回し・避けたい表現"
}
```

任意で `slug`（`[a-z0-9-]`、40字以内）を指定するとファイル名に使う。未指定なら `character` + ブリーフ内容の短いハッシュ。

## 出力

`data/copy-drafts/<YYYY-MM-DD>-<slug>.json`（日付は JST。同名があれば `-2`, `-3` …で上書きしない）。
スキーマは `meta`（`generated_at` / `model` / `prompt_version` / `brief`）と `variants[]`（`id` / `angle` / `caption_jp` / `caption_en` / `youtube_title_jp` / `youtube_title_en` / `x_text` / `hashtags`）。3〜5案。

出力は保存前に `src/copy-drafts/quality.mjs` で機械チェックされ、1つでも違反があれば**保存せず**失敗する（ログに生の候補を出す）。

| 品質条件 | 機械チェック |
|---|---|
| 言い切り・体言止め、ですます連鎖なし | 「です／のです／ます」終わりの文が連続したら違反 |
| 定型書き出し禁止（「ワールドクリエイターとしての…の世界。」） | 書き出しパターン検出 |
| 問いかけ締めは最大1案 | 2案以上で違反 |
| Sunpot / Higuma / Mandoragon 表記 | Sanpotto 等の誤表記、英語欄の日本語名を検出 |
| 本編のみ（エンドカード不使用） | エンドカード/ロゴへの言及を検出 |
| X はリンクなし・1投稿に収まる | URL 検出、`xWeightedLength` ≤ 280 |
| angle が重ならない | angle 文字列の一致/包含を検出（意味的な重複はプロンプトで抑制し、最終的には運用担当が確認） |
| 事実にない設定を足さない | 機械検証不可。プロンプトで制約し、運用担当が確認 |

## モデルとコスト

- 既定 `gpt-6-luna`。`hard` 指定時のみ `gpt-6.1-sol`。`gpt-6-astra` と `gpt-5.6` 系は設定段階で拒否（`config/copy-drafts.json` の `models.allowed`）。
- 予算ガードは既存の仕組みに相乗り:
  - 日次カウンタ: 擬似アカウント `copy-drafts` として `consumeUsage`（`src/ops/budget.mjs`）に記録。上限は `config/copy-drafts.json` の `budgets.openaiCallsPerDay`（既定3回/日。品質違反で再実行する余裕を含む）。ワークフローでは `SNS_DURABLE_BUDGETS=true` により `sns-ai-state` ブランチの永続カウンタを使う（他ワークフローと同じ）。
  - 月次ガバナー（`docs/BUDGET_GOVERNOR.md`）: `data/reports/cost.json` の状態が `conservative` 以上なら `hard` は `gpt-6-luna` に降格、`stopped` なら生成しない。
- 使用量の記録: 呼び出し1回ごとに `data/copy-drafts/usage.jsonl` へ `input_tokens / output_tokens / total_tokens / model` を追記し、Actions のサマリにも出す。呼び出し回数は `data/usage.jsonl`（`account: copy-drafts`）/ 永続カウンタにも残る。
- 無料枠（データ共有の complimentary allowance）の残量そのものは API から取得できない。残量は OpenAI ダッシュボードで確認すること。このステップができる保証は「1ブリーフ1回」「日次上限」「トークン数の記録」まで。
