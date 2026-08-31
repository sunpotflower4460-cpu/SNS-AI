# Artist Content Supply Loop

Status: **計画**。現行 V2 は recommendation / metadata の純ロジックまで。本番の upload・Preview・publish は My-SNS。

関連: [`ARTIST_SUPPORT_ROADMAP.md`](ARTIST_SUPPORT_ROADMAP.md)、[`ARTIST_PREVIEW_APPROVAL_PIPELINE.md`](ARTIST_PREVIEW_APPROVAL_PIPELINE.md)、[`ARTIST_ASSET_LIFECYCLE.md`](ARTIST_ASSET_LIFECYCLE.md)。

---

## ループ

```text
本物の Master Asset（本人が撮った／作った）
  → AI が箇所解析・トリム・軽い編集の Preview 候補
  → 人間が完成形に近い動画/画像を見る（GO / 修正 / NG）
  → Approved Clip Pool
  → SNS-AI が slot で POST / DEFER / REPLACE / NO POST
  → 公開 → 取れた metric だけ学習
  → Funnel / Fatigue / Trend / Capability を更新
  → 必要なら Creator Request（宿題は予算内）
  → 本人が撮る／答える
  → Master が増える
```

AI 生成の架空本人素材より、弾き語り・ライブ・MV・制作風景・写真・ジャケット・リハーサル・楽器・スタジオ・本人撮影の日常を中心にする。

最初に Master が 100 本あると有効だが、**「100 本を 1 回ずつ順番に流す」だけにはしない**。Master は完成投稿ではなく素材資産。同じ Master でも angle / clip / platform variant が違えば別入口になり得る。同じ完成投稿の短期再利用は禁止。

---

## 四層の素材

| 層 | 意味 | 自動投稿 |
|---|---|---|
| **Master Asset** | 元動画・元写真・元音源 | 原則しない |
| **Preview Candidate** | AI が編集した候補 | しない |
| **Approved Asset** | 本人が完成プレビューを見て GO | 明示許可があれば timing 判断可 |
| **Published Variant** | 実際に出た platform-specific version | 履歴。再利用判定の単位 |

SNS-AI が自由に自動投稿してよいのは、原則 **Approved Asset**、または本人が自動利用を明示許可した素材に限る。

private / signed storage URL は Bridge contract に載せない（現行 [`ARTIST_ASSET_LIFECYCLE.md`](ARTIST_ASSET_LIFECYCLE.md) と同じ）。

---

## 推奨 content types

計画上の主要カテゴリ（固定比率ではない）:

| type | 役割 |
|---|---|
| Rediscovery | 過去の弾き語り・ライブ・初期曲・未活用写真 |
| Entry Point | 同じ曲の vocal / lyric / guitar / story など入口実験 |
| Taste Bridge | 本人紹介以外 → 「この人の選ぶもの」→ 本人発見 |
| Craft | 制作・演奏・技術 |
| Human Echo | Anchor の周囲。言い直しではない |
| Campaign Orbit | リリース/ライブ/MV の周辺。告知コピー禁止 |
| Funnel Repair | 詰まっている段だけを補う |
| Trend Fit | Artist に合う trend だけ |
| Winner Resurface | cooldown 後の別 clip / 別 angle |
| No Post | slot を空ける判断 |

Taste 投稿の価値は Like だけでなく **Artist への遷移** で見る。アーティスト軸から無関係な雑多アカウントにはしない。

---

## Slot ≠ must post

「1 日 2 投稿」は maximum の **投稿判断 slot** であり、absolute minimum ではない。

各 slot で見るもの: Human activity、campaign、funnel、asset、fatigue、trend、budget、quality。

結果: **POST / DEFER / REPLACE / NO POST**。

投稿数を満たすための低品質投稿は禁止。低品質・権利不明・未確認体験は、slot が空いても出さない。

---

## Campaign Orbit

本人の新曲発表・ライブ・MV が中心。AI はその周辺（performance → lyrics → production → taste → alternate）を、反応と素材に応じて変える。同じ告知の毎日コピーは禁止。詳細は [`HUMAN_ANCHOR_AI_ORBIT.md`](HUMAN_ANCHOR_AI_ORBIT.md)。
