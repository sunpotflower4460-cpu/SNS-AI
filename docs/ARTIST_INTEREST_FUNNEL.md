# Artist Interest Funnel

単純な likes 最大化はしません。取得できる metric だけを使い、取れないものは `unknown` です。推定値を actual として扱いません。

```text
Exposure → Engagement → Profile Visit → Follow → Music Discovery → Music Click / Listen → Repeat → Fan
```

`src/artist/funnel-repair.mjs` がボトルネックを推定します。

| 観測 | 推奨 |
|---|---|
| reach 高く profile visit が低い | personality / worldview / identity 入口 |
| profile visit 高く music click が低い | Music Entry |
| music click 高く follow が低い | Taste / series / recurring identity |

直接宣伝を機械的に増やしません。`directArtistPromotion` の hard cap は維持します。confidence が低いときは strategy を大きく変えません。

実装: `src/artist/funnel-repair.mjs`。投稿レーン prior は `tasteDiscovery` / `musicAndCreation` / `worldview` / `directArtistPromotion` のまま、Funnel / Campaign / Anchor / Asset / Performance で動かします。
