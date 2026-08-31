# Artist Support 将来計画（Roadmap）

Status: **計画文書**。実装仕様ではない。大規模実装・runtime 変更・他リポジトリへの書き込みは、この文書だけでは開始しない。

目的は、別セッション・別 Agent が Artist Support を **本人になりきる Bot** と誤解せず、同じ原則で継続できるようにすること。

現行の実装メモ（V2 純ロジック）は [`ARTIST_SUPPORT_V2.md`](ARTIST_SUPPORT_V2.md)。運用中の scaffold は [`ARTIST_SUPPORT_MODE.md`](ARTIST_SUPPORT_MODE.md)。

関連リポジトリ（この PR では変更しない）:

- [My-SNS](https://github.com/sunpotflower4460-cpu/My-SNS) — Creator Cockpit / Seed / Approval / OAuth / Publish SoT
- [SNS-Growth-Bridge](https://github.com/sunpotflower4460-cpu/SNS-Growth-Bridge) — canonical contracts / scoring / transport。UI・OAuth・asset storage・publish を持たない

---

## 最上位思想

Artist Support の目的は **AI がアーティスト本人になりきることではない**。

目的は、

> 本人にしか作れない本物の素材・経験・好み・活動  
> ＋  
> AI による調査・編集・再発見・投稿判断・分析・実験

を組み合わせ、**アーティスト本人に興味を持つ入口を増やす**こと。

### 優先順位

```text
Truthfulness
> Human identity
> Rights
> Quality
> Growth
> Posting volume
```

投稿数を埋めるために本人性や品質を犠牲にしない。Bridge 側の学習優先順位（Safety → 明示指示 → Brand Profile → 人間修正 → Audience performance）とも矛盾させない。Performance 学習と Creator Preference 学習は **別 signal** として保持する。

SNS-AI の Manual-Only（`config/runtime-policy.json`）はこの計画のどの Phase でも、明示的な別レビューなしに解除しない。

---

## Operating model: Discover / Deepen / Support / Repair

| 役割 | 意味 | AI がやってよいこと | やってはいけないこと |
|---|---|---|---|
| **Discover** | まだ知らない人へ入口を作る | Taste、世界観、演奏の切り口、再発見 | 未確認の「好き」「行った」 |
| **Deepen** | 「この人をもう少し知りたい」 | 人物・制作・系列・繰り返し identity | 本人日記の捏造 |
| **Support** | 手動投稿・新曲・ライブを補完 | Anchor 周囲の Orbit | 本人投稿の言い直し・競合 |
| **Repair** | Funnel の弱い段を補う | 取得できた metric からの提案 | 取れない metric の捏造 |

AI は本人の日記・感情・体験を勝手に作る役割を持たない。

---

## いまあるもの / まだ計画のもの

| 領域 | いま（SNS-AI V2 純ロジック） | 将来（この Roadmap） |
|---|---|---|
| Human Anchor / AI Orbit | 履歴ベースの plan / overlap | Bridge ingest、Preview 済み素材との接続 |
| Funnel Repair | 取得 metric のみ・confidence 不足なら振らない | My-SNS 実 metric との Bridge 正規化 |
| Master / Derived Asset | metadata と重複判定 | Preview-first 編集 → Approved Pool |
| Creator Action | hybridMode 時の recommendation shape | Capability・Request budget・My-SNS Tasks UI |
| Taste confirmation | yes/no/neutral event | 少量質問ループ、Knowledge Base |
| Campaign / no-post | 純ロジック | slot 判断と Approved Pool の接続 |
| Trend Scout | なし | Artist 専用 scout（本番 crawler は別 Phase） |
| 動画編集エンジン | なし | Preview レンダリングは My-SNS。自律投稿は品質証明後 |

詳細:

- [Content Supply Loop](ARTIST_CONTENT_SUPPLY_LOOP.md)
- [Preview-first 承認パイプライン](ARTIST_PREVIEW_APPROVAL_PIPELINE.md)
- [Trend Scout](ARTIST_TREND_SCOUT.md)
- [Creator Capability と Requests](CREATOR_CAPABILITY_AND_REQUESTS.md)
- [Human Anchor / Orbit](HUMAN_ANCHOR_AI_ORBIT.md)
- [Funnel](ARTIST_INTEREST_FUNNEL.md)
- [Asset lifecycle](ARTIST_ASSET_LIFECYCLE.md)
- [Creator Action Queue](CREATOR_ACTION_QUEUE.md)

---

## システム責務

### My-SNS = Creator Cockpit

担当: Asset upload、Master Asset storage、Preview UI（GO / 修正 / NG）、Creator Tasks、Human answers、Brand Profile、Seed、OAuth、Publish source of truth。

My-SNS の中心は SNS アカウントではなく **Seed**。AI は提案者であり勝手な代理人ではない（My-SNS `docs/concept.md`）。

SNS-AI は My-SNS DB に直接書き込まない。

### SNS-AI = Autonomous Artist Growth Operator

担当: Trend Scout、Funnel 診断、Asset 選択、Creator Request 生成、候補生成、編集提案、投稿判断、Performance 分析、Asset fatigue、Winner resurface、Campaign Orbit。

担当しない: Creator UI、OAuth、asset 本体の SoT、本人体験の捏造。

### SNS-Growth-Bridge = Shared Growth Intelligence Contract Layer

担当: canonical contracts、scoring、Creator preference と Audience performance の分離、Strategy snapshots、Creator Action recommendation の輸送意味。

持たない: UI、OAuth、asset 本体、publish。既存方針は Bridge `docs/ARCHITECTURE.md` / `docs/CONTRACTS.md` / `docs/CREATOR_SUPPORT_LOOP.md` と一致させる。

将来契約候補（Bridge への実装は **別 repo / 別 PR**）: [`GROWTH_BRIDGE_CONTRACTS.md`](GROWTH_BRIDGE_CONTRACTS.md)。

---

## Future phases

順序は依存関係の目安。投稿量や「自動化できそう」で飛ばさない。

| Phase | 内容 | 備考 |
|---|---|---|
| A | Artist Knowledge / Capability | 何が簡単に撮れるか。非現実な宿題を出さない |
| B | Creator Requests | evidence + confidence + request budget |
| C | Master Asset + Preview Approval | 秒数入力を人間に要求しない |
| D | Approved Asset Pool | 自動利用は原則ここから |
| E | Asset Fatigue / Winner Resurface | V2 純ロジックの本番接続 |
| F | Human Anchor / AI Orbit | 本人活動の寿命を伸ばす |
| G | Artist Funnel Repair | 取得 metric のみ |
| H | Artist Trend Scout | 「流行っている = やる」ではない |
| I | Trend-driven Creator Requests | 曲だけでなく format 要求 |
| J | Cross-repo integration | My-SNS / Bridge はそれぞれの PR |
| K | Editing 自律度の引き上げ | **品質証拠が十分得られた場合のみ** |

Phase K より前に「AI 編集直後の無確認本番投稿」は行わない。

---

## Non-goals（この文書では実装しない）

- 動画編集エンジン本体
- My-SNS Preview UI
- Trend crawler 本番 runtime
- 新しい OAuth
- live posting
- schedule / cron 復活
- Growth-Bridge 本番 contract 実装
- My-SNS database migration
- `runtime-policy` 変更、`enabled=true`、engagement 有効化、secrets 追加、billing 設定変更

今回の成果物は **将来計画の保存** である。
