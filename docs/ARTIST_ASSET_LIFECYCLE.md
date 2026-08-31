# Artist Asset Lifecycle

投稿完成物ではなく **Master Asset** として扱います。

最低 metadata: `assetId`, `masterAssetId`, `mediaType`, `source`, `ownershipBasis`, `songId?`, `capturedAt?`, `duration?`, `orientation`, `tags`, `availablePlatforms`, `rightsStatus`, `createdByArtist`, `timesUsed`, `lastUsedAt`, `performanceSummary`, `fatigueScore`。

private storage URL や signed URL は Bridge contract に流しません。

## Derived assets

1つの Master から 8秒 / 15秒 / サビ / ギター部分などの variant を切れます。ほぼ同一 variant の大量生成は禁止です。

```text
MasterAsset → Variant → Angle → Platform Adaptation
```

同じ Master を X と Instagram で使ってよいですが、caption のコピペは禁止で、platform-specific variant にします。

## Fatigue と Winner Resurface

同じ完成投稿の短期再投稿は禁止です。過去の優秀素材は永久封印しません。

Winner 条件の例: 過去成績上位、最終使用から十分経過（初期 cooldown 180日、`artist.winnerResurface` で設定）、新しい angle、異なる clip、Audience が変化。

実装: `src/artist/assets.mjs`, `src/artist/fatigue.mjs`。

将来の Preview-first 承認と Approved Clip Pool は [`ARTIST_PREVIEW_APPROVAL_PIPELINE.md`](ARTIST_PREVIEW_APPROVAL_PIPELINE.md)。Master を完成投稿として順番消化しない方針は [`ARTIST_CONTENT_SUPPLY_LOOP.md`](ARTIST_CONTENT_SUPPLY_LOOP.md)。
