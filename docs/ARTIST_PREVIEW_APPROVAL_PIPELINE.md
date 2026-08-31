# Artist Preview-first 編集パイプライン

Status: **計画**。動画編集エンジン・My-SNS Preview UI・無確認の本番投稿は、この文書では実装しない。

関連: [`ARTIST_CONTENT_SUPPLY_LOOP.md`](ARTIST_CONTENT_SUPPLY_LOOP.md)、[`ARTIST_SUPPORT_ROADMAP.md`](ARTIST_SUPPORT_ROADMAP.md)。

---

## なぜ Preview-first か

歌・音楽素材では、歌詞途中・フレーズ途中・コード解決前・ブレス直前の切断、不自然な映像カット、字幕誤認識、不適切なクロップが起き得る。

したがって初期段階の本番経路は:

```text
AI editing 提案
  → Human preview approval
  → Approved Pool
  → Automatic publishing（timing / slot 判断のみ）
```

「AI 編集直後に無確認で本番投稿」は、十分な品質証明（Roadmap Phase K）が得られるまで行わない。

---

## 人間に秒数を指定させない

「0:42〜1:01 を使いますか？」のようなタイムコード判断を **基本 UX にしない**。人間は秒数把握が負担になる。

正しい将来フロー:

```text
Master 動画
  → AI が候補箇所を解析
  → AI が実際にトリミング
  → 字幕・クロップ・必要なら軽い編集
  → 完成形に近い Preview をレンダリング
  → 人間が動画そのものを見る
  → GO / 修正 / NG
```

フレーム番号・秒数・技術パラメータの入力を要求しない。修正は自然言語中心。

例:

- 「もう少し前から始めて」
- 「最後を少し残して」
- 「字幕なし」 / 「歌詞だけにして」
- 「エフェクト弱く」
- 「顔をもっと大きく」
- 「この案は使わない」

---

## Preview 案の出し方

一度に大量生成しない。意味のある差がある 3 案程度。

例:

| 案 | 入口 |
|---|---|
| Preview A | サビ中心 |
| Preview B | 歌い出し中心 |
| Preview C | ギター / 雰囲気中心 |

ほぼ同一 variant の量産は禁止（現行 Derived Asset ルールと同じ）。

UI（My-SNS、将来）: **GO / 修正 / NG**。SNS-AI に Creator UI は作らない。

---

## 編集結果も学習対象

Preview への人間修正は **Creator Preference** として残す。Audience Performance とは混ぜない。

例:

- 毎回「字幕を減らす」→ 次回から字幕量を減らす傾向
- 毎回「曲の余韻を残す」→ 終了を長めに取る傾向
- 毎回「エフェクトいらない」→ 過度な効果を避ける

Bridge の `HumanCorrectionEvent` 規則を尊重する: 単純承認（中身が同じ）は preference 証拠にしない。実際に変わった Preview だけを学習する。

---

## Approved Clip Pool

Preview 承認済み素材。

想定 metadata（契約は Bridge 別 PR）:

`approvedAssetId`, `masterAssetId`, `approvedAt`, `approvedByHuman`, `songId`, `format`, `angle`, `platforms`, `captionConstraints`, `subtitlePreference`, `effectPreference`, `reusePolicy`, `cooldown`, `performanceHistory`

本人確認済みなので、SNS-AI は **投稿タイミング** の判断を自動化できる。中身の再編集を無確認で変えてはいけない。

Fatigue / Winner Resurface は「同じ Master」だけでは重複にしない。同じ完成投稿（同 clip + 同 caption 等）の短期再利用は禁止。良い素材の永久封印もしない。詳細は [`ARTIST_ASSET_LIFECYCLE.md`](ARTIST_ASSET_LIFECYCLE.md)。
