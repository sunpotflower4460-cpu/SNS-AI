# Artist Trend Scout（計画）

Status: **計画**。本番の trend crawler runtime はこの文書では実装しない。既存の Plugin Radar research pipeline を Artist に流用して「流行っている = やる」にしてはいけない。

関連: [`ARTIST_SUPPORT_ROADMAP.md`](ARTIST_SUPPORT_ROADMAP.md)、[`CREATOR_CAPABILITY_AND_REQUESTS.md`](CREATOR_CAPABILITY_AND_REQUESTS.md)。

---

## 目的

定期的に、Artist アカウントで **使えそうな** 動きを探す。ただし流行そのものに Artist を合わせない。**Artist に合う Trend を選ぶ**。

探索対象の例（取得できないものは unknown。捏造しない）:

- X / Instagram / TikTok / YouTube Shorts
- Spotify 周辺
- 音楽ニュース
- 検索トレンド
- カバー傾向
- 投稿 format 傾向

「毎日クローリングする」は運用方針であり、この PR で schedule を復活させない。Manual-Only のまま、将来 Phase で設計する。

---

## Trend × Artist Fit

候補は概念的に次で評価する。数値を捏造せず、欠けは unknown。断定しない。

```text
Trend Strength
× Artist Fit
× Voice / Style Fit
× Audience Fit
× Competition / Saturation
× Production Cost
× Current Asset Availability
× Creator Capability
```

例（提案の言い方）:

> この曲を今アコギでやると伸びる **可能性** がある。上昇トレンド、Artist Fit は高そう、アコギ版は未飽和、既存本人素材とも相性が良さそう。

やってはいけない言い方: 「必ず伸びる」「本人も好きなはず」。

---

## Safety（見送り条件）

トレンドが強くても見送る:

- Artist identity と合わない
- 本人が嫌い（confirmed または明示的 avoid）
- 制作負担が高すぎる（Capability が hard / no）
- Rights 上の問題
- 過度な流行追随になる
- Audience との乖離が大きい
- 未確認の本人体験が必要になる

---

## Song / Cover Request

Scout から Creator Request を出してよい（Request budget 内、evidence 必須）。

例:

```text
HIGH
曲: XXXX
形式: アコギ弾き語り
推奨: サビ中心 / 20–30 秒程度（秒数は Preview 側が決める。人間へのタイムコード質問にしない）
理由: 上昇トレンド + Artist Fit + アコギ版未飽和 + 既存素材との相性
本人: やる / 保留 / やらない
```

「やらない」は confirmed avoid 候補であり、勝手に再提案を増やさない。

---

## Format Trend

トレンドは曲だけではない。AI は「この曲をやれ」だけでなく **「既存曲をこの形式で撮ってほしい」** と要求できる。

例: スマホ一発録り、fixed-camera acoustic、close-up vocal、大きな歌詞テキスト、rehearsal clip、before/after production、stripped arrangement、old-song rediscovery、特定のフレーミングや尺。

Capability が easy な形式を優先する。full MV を毎週要求しない。
