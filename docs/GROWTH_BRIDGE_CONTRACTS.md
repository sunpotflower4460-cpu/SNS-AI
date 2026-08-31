# SNS-Growth-Bridge 契約提案（SNS-AI 側メモ）

このファイルは **提案** です。SNS-Growth-Bridge リポジトリへの実装はこの PR では行いません。

Bridge は現状どおり:

- OAuth を持たない
- publish しない
- asset storage を持たない
- UI を持たない

将来の canonical contract 候補:

| kind | 方向 | 目的 |
|---|---|---|
| CreatorActionRecommendation | SNS-AI → Bridge | 人間へのお願い |
| CreatorActionResponse | Bridge → SNS-AI | Yes/No/Neutral など |
| ArtistAssetNeedSignal | SNS-AI → Bridge | 素材不足 |
| ArtistContextEvent | Bridge → SNS-AI | ライブ・リリース・手動活動 |
| ArtistFunnelSnapshot | SNS-AI → Bridge | 取得済み metric のみ |
| PublishedPostSnapshot | Bridge → SNS-AI | 公開済み投稿（human-authored flag） |
| CreatorCapabilitySnapshot | My-SNS → Bridge | 何が簡単に撮れるか |
| ArtistAssetMetadataSnapshot | My-SNS → Bridge | Master/Approved の公開メタのみ（本体・signed URL なし） |
| PreviewApprovalEvent | My-SNS → Bridge | GO / 修正 / NG |
| EditingCorrectionEvent | My-SNS → Bridge | Preview への自然言語修正（中身が変わったときだけ） |
| TasteConfirmationEvent | My-SNS → Bridge | LIKE / NEUTRAL / NO 等。AI 単独では confirmed にしない |

Bridge 既存方針（`docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`, `docs/CREATOR_SUPPORT_LOOP.md`）と揃える: 契約は immutable advice。mutable Creator Task 状態は My-SNS。Creator preference と Audience performance は混ぜない。欠測を confidence にしない。

上記の Bridge 実装はこのリポジトリの計画メモに過ぎない。**SNS-Growth-Bridge への実装は別 PR。**

private / signed storage URL は載せません。scoring と transport semantics は Bridge 側の責務です。

実装スケッチ: `src/artist/bridge-contracts.mjs`（SNS-AI 内の shape のみ）。
