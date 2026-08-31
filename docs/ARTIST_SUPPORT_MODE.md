# Artist Support Mode

本人の曲を毎日宣伝する bot ではありません。導線は次です。

```text
Taste → Personality / worldview → Profile visit → Interest in artist → Music discovery → Follow / fan
```

`contentStrategy: artist-support` のアカウント（`artist-x`, `artist-instagram`）が対象です。どちらも default **disabled** の scaffold で、実在の私的情報は入れていません。

## 投稿レーン（初期比率）

| lane | 初期 |
|---|---|
| tasteDiscovery | 0.40 |
| musicAndCreation | 0.25 |
| worldview | 0.20 |
| directArtistPromotion | 0.15 |

学習で比率は動かせますが、直接宣伝は `maxDirectPromotionShare`（初期 0.20）を超えません。

## Personal evidence

| レベル | 意味 | 書いてよいこと |
|---|---|---|
| confirmed_personal | 本人が好き/使った/聴いた等を登録済み | 個人的感想 |
| taste_match | 嗜好とは合うが未確認 | 「面白い」「気になる」まで。体験したようには書かない |
| external_discovery | Research で見つけただけ | 客観紹介のみ |

未確認の「使ってみた」「最近ハマっている」は fail closed です。

## Asset Library

`config/artist.example.json` が schema です。実データは gitignored の `config/artist.json` / `data/artist-assets/` に置きます。リポジトリへ秘密・個人情報を入れません。

## 手動投稿との共存

候補作成前に直近の本人投稿を見ます。同じ曲・同じURL・同じ告知なら `reframe` / `delay` / `replace` / `skip` し、短時間の機械的連投をしません。
