# Budget Governor

3ブランド × X / Instagram の **全体** で月次ターゲット **20 USD** を管理します。

## 状態

| 使用率 | state | 動作 |
|---|---|---|
| < 70% | healthy | 通常 |
| ≥ 70% | warning | 通常。警告のみ |
| ≥ 85% | conservative | 高コスト処理を抑制 |
| ≥ 95% | critical | 必須でない有料処理を停止 |
| ≥ 100% | stopped | 新規の有料処理を停止 |

## 料金の種類

`actual` / `estimated` / `unknown` を混ぜません。

- **actual**: 課金 API から取れた実額。現状 X/OpenAI/Groq の billing API は未配線なので、通常は 0 件です。
- **estimated**: `config/x-api-pricing.json` などオペレーター保守の見積。値が 0 なら「無料」ではなく **未設定** として扱います。
- **unknown**: 単価不明。金額を捏造しません。

## 削る順番

1. AI画像生成
2. 重複 Web Search
3. 低価値 triage
4. Terra → cheaper model
5. URL 投稿
6. 投稿候補数
7. 投稿頻度

## 生成前 preflight

有料 AI generation は次の順です。**生成後に budget を見て止めることはしません。**

1. budget preflight（`data/reports/cost.json` の accountedUsd。actual billing API は未配線）
2. estimated reservation（課金ホールドではない。単価 0 は無料ではなく unknown）
3. model selection（cheap / balanced / high / critical。critical/conservative では high/critical を選ばない）
4. generation

100% `stopped` では新規の有料 AI generation（dry-run の Responses 呼び出しを含む）を呼びません。95% `critical` では image / video / web-search / high / critical / url を API 前に止めます。cheap/balanced の本文生成は残します。safety / moderation / entity verification は止めません。

実装: `src/budget/preflight.mjs`, `src/budget/reservation.mjs`。


## 再配分

ブランドへ均等固定しません。直近パフォーマンスで翌週シェアを動かせますが、`minExplorationShare` と `maxBrandShare` で一ブランド独占を防ぎます。

設定: `config/budget-policy.json`。レポート: `npm run cost-report`。
