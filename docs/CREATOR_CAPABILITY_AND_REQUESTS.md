# Creator Capability と Creator Requests

Status: **計画**。SNS-AI は recommendation を生成する側。Creator UI・宿題の永続タスク状態は My-SNS。現行の hybridMode Action Queue は [`CREATOR_ACTION_QUEUE.md`](CREATOR_ACTION_QUEUE.md)。

関連: [`ARTIST_SUPPORT_ROADMAP.md`](ARTIST_SUPPORT_ROADMAP.md)、[`ARTIST_TREND_SCOUT.md`](ARTIST_TREND_SCOUT.md)。

---

## Capability Profile

本人が「何なら簡単に作れるか」を登録できる構造。目的は、**現実的でない制作要求を出さない**こと。

例:

| key | 初期イメージ |
|---|---|
| acoustic_vertical | easy |
| acoustic_horizontal | easy |
| guitar_only | easy |
| studio_desk | easy |
| outdoor_performance | medium |
| full_music_video | hard |
| live_capture | event_dependent |
| voice_only | easy |
| photo | easy |

追加 metadata の例: `effort`, `timeRequired`, `availableFrequency`, `preferred`, `avoid`, `equipmentNeeded`。

未登録は unknown。unknown を easy 扱いしない。

---

## Creator Request Engine

次を見て「次に用意すると価値が高いか」を判断する:

Audience Performance、Funnel bottleneck、Current Asset Pool、Artist Capability、Trend、Campaign、Human workload（Request budget）。

例:

- 「Aquarium の縦型弾き語りを 1 本」
- 「制作机の短い動画を 1 本」
- 「ライブ時にこの曲だけ縦で撮影」

無根拠な大量リクエストは禁止。confidence 不足では出さない（現行 V2 と同じ）。

---

## Request budget

AI が人間へ大量の宿題を出さない。Growth のために負担を無限増加させない。

例（運用ポリシー。この PR では config を増やして有効化しない）:

| 期間 | high priority 上限 |
|---|---|
| 通常週 | ≤ 2 |
| リリース週 | ≤ 4 |

低優先度は「余裕があれば」。dismiss / 無理 が続いたテーマは再スパムしない。

---

## AI Question Loop

最初から 100 項目を回答させない。必要な情報を少量ずつ聞く。

例:

| 質問 | 回答 |
|---|---|
| この作品は実際に好きですか？ | LIKE / NEUTRAL / NO |
| このプラグインは使ったことがありますか？ | USED / KNOW_ONLY / NO |
| こういう動画なら作れますか？ | EASY / POSSIBLE / HARD / NO |

回答でのみ Knowledge Base を育てる。LIKE だけが `confirmed_personal` へ昇格可能。AI の「たぶん好きそう」は `taste_match` のまま。

既存 3 段（`confirmed_personal` / `taste_match` / `external_discovery`）は維持。regex は第二防衛線。

Taste 資産の保存候補: 音楽、アーティスト、曲、映画、本、場所、楽器、プラグイン、音響、クリエイター、制作方法、考え方、美術、写真、その他の本人関心。

---

## My-SNS Creator Tasks（将来 UI）

SNS-AI には作らない。My-SNS 側の案:

```text
今週あると嬉しい素材

HIGH
  Aquarium サビ弾き語り縦 ×1
  理由: 近距離本人演奏の profile visit が強い + Aquarium 素材不足

MEDIUM
  制作机写真 ×2

LOW
  屋外写真
```

人間の回答: **作る / 後で / 無理 / 不要**。

Bridge は immutable recommendation だけを運ぶ。mutable な task 状態（open / done / dismissed）は My-SNS。これは Bridge `docs/CREATOR_SUPPORT_LOOP.md` と同じ境界。
