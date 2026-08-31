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

private / signed storage URL は載せません。scoring と transport semantics は Bridge 側の責務です。

実装スケッチ: `src/artist/bridge-contracts.mjs`（SNS-AI 内の shape のみ）。
