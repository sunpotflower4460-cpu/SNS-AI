# Multi-brand operation

将来の運用単位は 3 ブランド × X / Instagram = 最大 6 アカウントです。いまはすべて disabled です。

| Brand | X | Instagram | 状態 |
|---|---|---|---|
| Plugin Radar | `music-tools-x` (`@pluginradar_jp`) | `plugin-radar-instagram` | 人格は既存 Plugin Radar。IG は未接続 scaffold |
| Artist | `artist-x` | `artist-instagram` | artist-support scaffold。実認証不要 |
| Brand C | `brand-c-x` | `brand-c-instagram` | 中身を捏造しない空テンプレート |

## Research の共有

同一ブランドは **Research → Core Content Brief → X版 / Instagram版** です。X と Instagram で調査を二重実行しません。キャッシュキーは `sharedResearchId` です。

Plugin Radar の既存 source registry（KVR / Bedroom Producers Blog / Rekkerd / GitHub Releases）は `music-tools-x` キーのまま残し、Instagram 側は brand lookup でそれを再利用します。

価格・発売日・セール期限・対応環境などの facts は可能な限り `sourceRole: primary` へ戻します。未確認なら投稿に断定しません。

## 関係性の開示

`independent` / `affiliate` / `sponsored` / `provided` / `own_product`。
`own_product` は運営者開発であることを投稿内で明示し、独立レビューを装いません。affiliate と混同しません。affiliate 自体は現状 disabled のままです。

## 成長指標

いいね最大化だけを目的にしません。投稿タイプごとに objective を持ち、X/Instagram の取得できた metric だけを正規化します。取れない値は作りません。

Explore/Exploit 初期値は exploit 80% / explore 20%（`learning.exploreRate: 0.2`）。dimension はブランドで分けられます。
