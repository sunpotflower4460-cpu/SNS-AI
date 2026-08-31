# My-SNS 連携提案（SNS-AI 側メモ）

このファイルは **提案** です。My-SNS リポジトリへの実装はこの PR では行いません。SNS-AI は My-SNS DB に直接書き込みません。

My-SNS が Source of Truth のまま担うもの:

- Asset Library / Creator uploads
- Seed / Brand Profile
- Human Approval / Publish Queue / manual posts
- Creator Tasks UI
- OAuth

SNS-AI が担うもの: recommendation 生成、Funnel 診断、Orbit / no-post、Asset fatigue。

将来の Creator Tasks / Preview 例:

- 「Aquarium の縦型サビ動画があと2本あると良い」（理由と evidence 付き）
- 「この作品は実際に好きですか？ Yes / No」
- Preview A/B/C を動画として見て GO / 修正 / NG（秒数入力なし）
- 作る / 後で / 無理 / 不要

詳細計画: [`CREATOR_CAPABILITY_AND_REQUESTS.md`](CREATOR_CAPABILITY_AND_REQUESTS.md)、[`ARTIST_PREVIEW_APPROVAL_PIPELINE.md`](ARTIST_PREVIEW_APPROVAL_PIPELINE.md)。My-SNS 本体への UI / DB 変更はこの PR では行わない。

未接続の ingest adapter があるとき、SNS-AI は「手動投稿を読めた」と捏造しません。
